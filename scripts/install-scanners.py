#!/usr/bin/env python3
"""Install exactly the source-pinned tools in a caller-selected empty temp dir.

Only official public software downloads. No application path or input is read.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import venv

BASE = pathlib.Path(__file__).resolve().parents[1]

def install(destination):
    destination = pathlib.Path(destination).resolve()
    if destination.exists():
        raise RuntimeError('SCANNER_INSTALL_DIRECTORY_NOT_EMPTY')
    if sys.version_info[:2] != (3, 12) or sys.platform != 'linux':
        raise RuntimeError('SCANNER_PLATFORM_UNAVAILABLE')
    lock = json.loads((BASE / 'scanning/tool-lock.json').read_text())
    destination.mkdir(mode=0o700, parents=True)
    archive = destination / 'gitleaks.tar.gz'
    # Fixed origin/version from the reviewed source lock, never app input.
    spec = lock['gitleaks']
    expected_url = f"https://github.com/gitleaks/gitleaks/releases/download/v{spec['version']}/gitleaks_{spec['version']}_linux_x64.tar.gz"
    if spec['url'] != expected_url:
        raise RuntimeError('SCANNER_INSTALL_ORIGIN')
    with urllib.request.urlopen(expected_url, timeout=60) as response:
        data = response.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != spec['archiveDigest']:
        raise RuntimeError('SCANNER_INSTALL_DIGEST')
    archive.write_bytes(data)
    with tarfile.open(archive) as bundle:
        member = bundle.getmember('gitleaks')
        if not member.isfile():
            raise RuntimeError('SCANNER_INSTALL_MEMBER')
        binary = bundle.extractfile(member).read()
    if hashlib.sha256(binary).hexdigest() != spec['executableDigest']:
        raise RuntimeError('SCANNER_INSTALL_DIGEST')
    (destination / 'gitleaks').write_bytes(binary)
    (destination / 'gitleaks').chmod(0o500)
    requirements = BASE / 'scanning/semgrep-requirements.txt'
    if hashlib.sha256(requirements.read_bytes()).hexdigest() != lock['semgrep']['requirementsDigest']:
        raise RuntimeError('SCANNER_INSTALL_DIGEST')
    runtime = destination / 'semgrep'
    venv.EnvBuilder(with_pip=True).create(runtime)
    command = [str(runtime / 'bin/python'), '-m', 'pip', '--isolated']
    environment = {'PATH': '/usr/bin:/bin', 'HOME': str(destination), 'TMPDIR': str(destination), 'PYTHONDONTWRITEBYTECODE': '1'}
    wheels = destination / 'wheels'
    subprocess.run(command + ['download', '--no-cache-dir', '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '--require-hashes', '--dest', str(wheels), '-r', str(requirements)], check=True, timeout=600, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(command + ['install', '--no-compile', '--no-index', '--find-links', str(wheels), '--require-hashes', '-r', str(requirements)], check=True, timeout=300, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for path in (runtime / 'lib/python3.12/site-packages').rglob('__pycache__'):
        shutil.rmtree(path)
    print('Pinned scanner tools installed; application scans have not run')

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('SCANNER_INSTALL_ARGUMENTS')
        install(sys.argv[1])
    except Exception:
        print('SCANNER_INSTALL_UNAVAILABLE', file=sys.stderr)
        sys.exit(1)
