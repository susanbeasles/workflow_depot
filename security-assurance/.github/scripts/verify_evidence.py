#!/usr/bin/env python3
"""Authorize only the final gate and dependencies contained in the verified archive.

No archive members are extracted. Loose metadata, when present, must match the
archive exactly; it is never an authority for promotion.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_MEMBER_BYTES = 128 * 1024 * 1024
MAX_MEMBERS = 10000


def member_path(name):
    if not isinstance(name, str) or '\\' in name or '\x00' in name:
        raise ValueError('invalid archive path')
    while name.startswith('./'):
        name = name[2:]
    if not name or name.startswith('/') or '..' in name.split('/'):
        raise ValueError('unsafe archive path')
    return str(PurePosixPath(name))


def read_archive(path):
    # Bound decompression including tar padding and extension records, not just
    # declared file sizes. Reading a gzip bomb cannot allocate without a limit.
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError('compressed archive exceeds size limit')
    with gzip.open(path, 'rb') as stream:
        data = stream.read(MAX_ARCHIVE_BYTES + 1)
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError('expanded archive exceeds size limit')
    files = {}
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for count, item in enumerate(archive, 1):
            if count > MAX_MEMBERS:
                raise ValueError('archive has too many members')
            name = member_path(item.name)
            if name in seen:
                raise ValueError('duplicate archive member')
            seen.add(name)
            if item.isdir():
                continue
            if not item.isfile() or item.issparse():
                raise ValueError('archive links and special members are forbidden')
            if item.size < 0 or item.size > MAX_MEMBER_BYTES:
                raise ValueError('archive member exceeds size limit')
            with archive.extractfile(item) as stream:
                files[name] = stream.read(item.size + 1)
            if len(files[name]) != item.size:
                raise ValueError('truncated archive member')
    return files


def dependency(files, name):
    name = member_path(name)
    # gate.py records its relative results directory prefix; older emitters
    # record the same prefix on evidence paths. Never accept absolute paths or
    # basename-only fallback, which could select a different signed file.
    if name.startswith('security-results/'):
        name = name[len('security-results/'):]
    if name not in files:
        raise ValueError('signed dependency missing: ' + name)
    return files[name]


def verify_contents(files, directory, expected_sha, expected_repo):
    paths = ('gate-all/gate-decision.json', 'gate-all/evidence-manifest.json')
    if (directory / 'gate-all').is_symlink():
        raise ValueError('loose metadata directory is a symlink')
    for name in paths:
        if name not in files:
            raise ValueError('final signed metadata missing: ' + name)
        for loose in (directory / name, directory / Path(name).name):
            if loose.exists() or loose.is_symlink():
                if loose.is_symlink() or loose.stat().st_size != len(files[name]) or loose.read_bytes() != files[name]:
                    raise ValueError('loose metadata differs from signed archive')
    gate = json.loads(files[paths[0]])
    manifest = json.loads(files[paths[1]])
    if gate.get('decision') != 'PASS' or gate.get('stage') != 'all':
        raise ValueError('final gate did not pass all stages')
    candidate = gate['candidate']
    if expected_sha and candidate.get('sha') != expected_sha:
        raise ValueError('gate decision bound to a different sha')
    if expected_repo and candidate.get('repository') != expected_repo:
        raise ValueError('gate decision bound to a different repository')
    if manifest.get('candidate') != candidate or manifest.get('policy_revision') != gate.get('policy_revision'):
        raise ValueError('manifest binding differs from gate')
    if not isinstance(manifest.get('entries'), list) or not manifest['entries']:
        raise ValueError('signed result manifest is empty')
    for entry in manifest['entries']:
        if hashlib.sha256(dependency(files, entry['result_file'])).hexdigest() != entry['sha256']:
            raise ValueError('signed result digest mismatch')
        for evidence in entry.get('evidence', []):
            if evidence.get('missing'):
                continue
            if hashlib.sha256(dependency(files, evidence['path'])).hexdigest() != evidence['sha256']:
                raise ValueError('signed evidence digest mismatch')
    return candidate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', required=True)
    parser.add_argument('--sha', default='')
    parser.add_argument('--repo', default='')
    parser.add_argument('--cosign-identity-regexp', default='')
    parser.add_argument('--cosign-bin', default='cosign')
    parser.add_argument('--require-signature', action='store_true')
    args = parser.parse_args()
    directory = Path(args.dir)
    bundle = directory / 'evidence-bundle.tar.gz'
    signature = directory / 'evidence-bundle.sigstore.json'
    try:
        if args.cosign_identity_regexp:
            result = subprocess.run([args.cosign_bin, 'verify-blob', '--bundle', str(signature), '--certificate-identity-regexp', args.cosign_identity_regexp, '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', str(bundle)], capture_output=True, text=True)
            if result.returncode:
                raise ValueError('cosign verify-blob failed')
        elif args.require_signature:
            raise ValueError('signature verification required but no identity supplied')
        candidate = verify_contents(read_archive(bundle), directory, args.sha, args.repo)
    except (ValueError, KeyError, TypeError, AttributeError, OSError, EOFError, tarfile.TarError) as error:
        print('VERIFY-FAIL: ' + str(error))
        sys.exit(1)
    print(f"VERIFY-OK: {args.dir} bound to {candidate.get('repository')}@{candidate.get('sha', '')[:12]}")
    sys.exit(0)


if __name__ == '__main__':
    main()
