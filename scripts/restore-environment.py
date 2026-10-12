#!/usr/bin/env python3
"""Bounded data-only overlay for the untrusted app environment archive.

Never calls tar or applies archive ownership/permissions/hooks. Validate all
members and destination ancestors before overlay; write via no-follow dirfds.
"""
import argparse
import gzip
import hashlib
import io
import os
import pathlib
import posixpath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import uuid

def deny():
    raise ValueError('ENVIRONMENT_RESTORE_DENIED')

def parts(name):
    if not isinstance(name, str) or len(name) > 4096 or name.startswith('/') or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        deny()
    result = name.rstrip('/').split('/')
    if any(p in ('', '.', '..', '.git') for p in result):
        deny()
    return result

class BoundedReader:
    def __init__(self, stream, limit):
        self.stream, self.remaining = stream, limit

    def read(self, amount=-1):
        if amount < 0 or amount > self.remaining:
            deny()
        data = self.stream.read(amount)
        self.remaining -= len(data)
        return data

def parent_fd(root_fd, components, create=False):
    current = os.dup(root_fd)
    try:
        for part in components:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    os.close(current)
                    return None
                os.mkdir(part, mode=0o755, dir_fd=current)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise

def check_destination(root_fd, path, kind):
    components = parts(path)
    fd = parent_fd(root_fd, components[:-1])
    if fd is None:
        return
    try:
        try:
            existing = os.stat(components[-1], dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if kind == 'directory':
            if not stat.S_ISDIR(existing.st_mode):
                deny()
        elif not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
            deny()
    finally:
        os.close(fd)

def restore(archive, destination, expected, max_files=50000, max_bytes=256 * 1024 * 1024):
    if not re.fullmatch('[a-f0-9]{64}', expected) or not 1 <= max_files <= 100000 or not 1 <= max_bytes <= 1024 * 1024 * 1024:
        deny()
    # Open the exact archive inode without following a substituted symlink.
    archive_fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
    root_fd = None
    try:
        archive_stat = os.fstat(archive_fd)
        if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_size > 256 * 1024 * 1024:
            deny()
        with os.fdopen(os.dup(archive_fd), 'rb') as stream:
            observed = hashlib.file_digest(stream, 'sha256').hexdigest()
        if observed != expected:
            deny()
        os.lseek(archive_fd, 0, os.SEEK_SET)
        root_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        records = {}
        with tempfile.TemporaryDirectory(prefix='depot-env-staging-') as temporary:
            staging = pathlib.Path(temporary)
            with os.fdopen(os.dup(archive_fd), 'rb') as compressed, gzip.GzipFile(fileobj=compressed) as expanded:
                bounded = BoundedReader(expanded, max_bytes + max_files * 2048 + 16 * 1024 * 1024)
                with tarfile.open(fileobj=bounded, mode='r|') as bundle:
                    total = 0
                    for member in bundle:
                        path = '/'.join(parts(member.name))
                        if path in records or len(records) >= max_files or member.sparse:
                            deny()
                        if member.isdir():
                            if member.size != 0:
                                deny()
                            records[path] = ('directory', None, 0)
                        elif member.isfile():
                            total += member.size
                            if member.size < 0 or total > max_bytes:
                                deny()
                            target = staging.joinpath(*parts(path))
                            target.parent.mkdir(parents=True, exist_ok=True)
                            with bundle.extractfile(member) as source, target.open('xb') as output:
                                remaining = member.size
                                while remaining:
                                    data = source.read(min(65536, remaining))
                                    if not data:
                                        deny()
                                    output.write(data)
                                    remaining -= len(data)
                            records[path] = ('file', None, 0o755 if member.mode & 0o111 else 0o644)
                        elif member.issym():
                            if member.size != 0 or member.linkname.startswith('/') or '\\' in member.linkname:
                                deny()
                            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), member.linkname))
                            parts(target)
                            records[path] = ('symlink', (member.linkname, target), 0)
                        else:
                            # Hardlinks, devices, FIFOs and unknown types are not
                            # an application dependency environment contract.
                            deny()
            # Validate link graph and all existing destination paths before the
            # first overlay write. Links are materialized only after file copies.
            for path, (kind, target, _) in records.items():
                if kind == 'symlink' and (target[1] not in records or records[target[1]][0] != 'file'):
                    deny()
                components = parts(path)
                for index in range(1, len(components)):
                    ancestor = '/'.join(components[:index])
                    if ancestor in records and records[ancestor][0] != 'directory':
                        deny()
                    check_destination(root_fd, ancestor, 'directory')
                check_destination(root_fd, path, kind)
            # Detect archive mutation between hashing and staging.
            os.lseek(archive_fd, 0, os.SEEK_SET)
            with os.fdopen(os.dup(archive_fd), 'rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                    deny()
            for kind_to_write in ('directory', 'file', 'symlink'):
                for path, (kind, target, mode) in records.items():
                    if kind != kind_to_write:
                        continue
                    check_destination(root_fd, path, kind)
                    components = parts(path)
                    fd = parent_fd(root_fd, components[:-1], create=True)
                    leaf = components[-1]
                    temporary_leaf = '.depot-restore-' + uuid.uuid4().hex
                    try:
                        if kind == 'directory':
                            try:
                                os.mkdir(leaf, mode=0o755, dir_fd=fd)
                            except FileExistsError:
                                check_destination(root_fd, path, kind)
                        elif kind == 'file':
                            output_fd = os.open(temporary_leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
                            with os.fdopen(output_fd, 'wb') as output, staging.joinpath(*components).open('rb') as source:
                                shutil.copyfileobj(source, output, 65536)
                            os.rename(temporary_leaf, leaf, src_dir_fd=fd, dst_dir_fd=fd)
                        else:
                            os.symlink(target[0], temporary_leaf, dir_fd=fd)
                            os.rename(temporary_leaf, leaf, src_dir_fd=fd, dst_dir_fd=fd)
                    finally:
                        try:
                            os.unlink(temporary_leaf, dir_fd=fd)
                        except FileNotFoundError:
                            pass
                        os.close(fd)
    finally:
        os.close(archive_fd)
        if root_fd is not None:
            os.close(root_fd)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('destination')
    parser.add_argument('digest')
    parser.add_argument('--max-files', type=int, default=50000)
    parser.add_argument('--max-bytes', type=int, default=256 * 1024 * 1024)
    try:
        arguments = parser.parse_args()
        restore(arguments.archive, arguments.destination, arguments.digest, arguments.max_files, arguments.max_bytes)
    except Exception:
        print('ENVIRONMENT_RESTORE_DENIED', file=sys.stderr)
        sys.exit(1)
