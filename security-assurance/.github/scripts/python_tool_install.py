#!/usr/bin/env python3
"""Install registry Python tools only from reviewed hash locks and an offline wheelhouse.

Locks are committed source policy. The CLI fetches only hash-locked public PyPI
wheels into a fresh directory when no controlled wheelhouse was supplied. Each invocation uses a fresh isolated venv, never restored binaries
or the candidate's pip configuration/cache. Prints the new tool bin directory.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import venv
from urllib.parse import urlsplit
import yaml

REQUIREMENT = re.compile(r'([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)(?:[ \t]+--hash=sha256:[a-f0-9]{64})+')
canonical_name = lambda name: re.sub(r'[-_.]+', '-', name).lower()

def reviewed_requirements(policy, tools):
    versions = yaml.safe_load((policy / 'tool-registry.yml').read_text())['python_tools']
    requirements = {}
    for tool in tools:
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', tool) or tool not in versions:
            raise ValueError('unknown registry Python tool')
        lock = policy / 'python-locks' / (tool + '.txt')
        if lock.is_symlink() or not lock.is_file() or lock.stat().st_size > 512 * 1024:
            raise ValueError('reviewed transitive hash lock unavailable: ' + tool)
        own_version = None
        lines = lock.read_text(encoding='utf-8').replace('\\\n', '').splitlines()
        if len(lines) > 2000:
            raise ValueError('hash lock exceeds requirement limit')
        for raw in lines:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            match = REQUIREMENT.fullmatch(line)
            if not match:
                raise ValueError('hash lock requires exact pins and sha256 hashes only')
            name, version = match.groups()
            normalized = canonical_name(name)
            prior = requirements.get(normalized)
            if prior and prior != line:
                raise ValueError('conflicting reviewed transitive requirements')
            requirements[normalized] = line
            if normalized == canonical_name(tool):
                own_version = version
        if own_version != str(versions[tool]):
            raise ValueError('hash lock tool version differs from registry: ' + tool)
    if not requirements:
        raise ValueError('empty reviewed hash lock')
    return '\n'.join(requirements[name] for name in sorted(requirements)) + '\n'

def install(policy, tools, runner_temp, *, run=subprocess.run, make_venv=None, provision=False):
    policy, runner_temp = Path(policy).resolve(strict=True), Path(runner_temp).resolve(strict=True)
    requirements = reviewed_requirements(policy, tools)
    wheelhouse = runner_temp / 'depot-python-wheelhouse'
    supplied = wheelhouse.exists() or wheelhouse.is_symlink()
    if supplied and (wheelhouse.is_symlink() or not wheelhouse.is_dir() or not any(wheelhouse.glob('*.whl'))):
        raise ValueError('reviewed offline wheelhouse unavailable')
    if not supplied and not provision:
        raise ValueError('reviewed offline wheelhouse unavailable')
    if supplied and any(path.is_symlink() or not path.is_file() or path.suffix != '.whl' for path in wheelhouse.iterdir()):
        raise ValueError('wheelhouse must contain regular wheel files only')
    destination = Path(tempfile.mkdtemp(prefix='depot-python-tools-', dir=runner_temp))
    venv_path = destination / 'venv'
    (make_venv or (lambda path: venv.EnvBuilder(with_pip=True, system_site_packages=False).create(path)))(venv_path)
    lock = destination / 'requirements.txt'
    lock.write_text(requirements, encoding='utf-8')
    safe_env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'TMPDIR') if k in os.environ}
    if not supplied:
        wheelhouse = destination / 'wheels'
        wheelhouse.mkdir()
        download_env = dict(safe_env, NETRC='/dev/null', PIP_CONFIG_FILE='/dev/null')
        # Reuse the platform's configured transport/trust store without importing
        # package index overrides, user configuration, keyring or credentials.
        for key in ('HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy','NO_PROXY','no_proxy','SSL_CERT_FILE','REQUESTS_CA_BUNDLE'):
            if key in os.environ:
                if 'proxy' in key.lower() and key.lower() != 'no_proxy':
                    parsed = urlsplit(os.environ[key])
                    if parsed.username or parsed.password:
                        raise ValueError('credential-bearing package proxy unsupported')
                download_env[key] = os.environ[key]
        if 'SSL_CERT_FILE' in download_env:
            download_env['PIP_CERT'] = download_env['SSL_CERT_FILE']
        run([str(venv_path / 'bin/python'), '-I', '-m', 'pip', '--isolated',
             '--disable-pip-version-check', '--no-input', '--keyring-provider', 'disabled',
             'download', '--index-url', 'https://pypi.org/simple', '--retries', '0',
             '--require-hashes', '--only-binary=:all:', '--no-deps', '--no-cache-dir',
             '--dest', str(wheelhouse), '-r', str(lock)], check=True,
            stdout=sys.stderr, stderr=sys.stderr, env=download_env, cwd=destination)
        if not any(wheelhouse.glob('*.whl')):
            raise ValueError('hash-locked wheel download produced no artifacts')
    python = venv_path / 'bin/python'
    # --isolated ignores caller pip config/env; --no-index and wheel-only inputs
    # prohibit fetching or executing an sdist build. Every transitive dependency
    # is installed only from the complete reviewed lock. --no-deps prevents even
    # direct-URL metadata dependencies from fetching; pip check fails incomplete
    # or incompatible transitive closure before a tool can be invoked.
    command = [str(python), '-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
               '--no-input', '--no-index', '--find-links', str(wheelhouse), '--only-binary=:all:',
               '--require-hashes', '--no-deps', '--ignore-installed', '--no-cache-dir', '-r', str(lock)]
    run(command, check=True, stdout=sys.stderr, stderr=sys.stderr, env=safe_env, cwd=destination)
    run([str(python), '-I', '-m', 'pip', '--isolated', 'check'], check=True,
        stdout=sys.stderr, stderr=sys.stderr, env=safe_env, cwd=destination)
    return str(venv_path / 'bin')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', required=True)
    parser.add_argument('--tools', nargs='+', required=True)
    args = parser.parse_args()
    try:
        print(install(Path(args.registry).parent, args.tools, os.environ['RUNNER_TEMP'], provision=True))
    except Exception as error:
        print('Python tool qualification unavailable: ' + str(error), file=sys.stderr)
        return 1
    return 0
if __name__ == '__main__':
    raise SystemExit(main())
