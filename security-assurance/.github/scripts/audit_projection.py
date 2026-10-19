#!/usr/bin/env python3
"""Run registry audits against data-only manifests, never candidate PM configuration.

The projection is not a general code sandbox. Only depot-installed package manager
entrypoints are invoked; lifecycle scripts, Corepack selection, Yarn plugins and
project/home configuration are excluded. Advisory network access remains enabled.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess

NAMES = {'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'pnpm-workspace.yaml'}
OMIT_DIRS = {'.git', 'node_modules', '.yarn', '.pnpm', '.venv', 'target', '.build'}
PACKAGE_FIELDS = {'name', 'version', 'private', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'workspaces', 'engines', 'os', 'cpu', 'resolutions', 'overrides', 'bundledDependencies', 'bundleDependencies'}


def project(source, destination):
    source, destination = Path(source).resolve(), Path(destination).absolute()
    if destination == source or source in destination.parents:
        raise ValueError('audit projection must be outside candidate checkout')
    destination.mkdir(parents=True, exist_ok=False)
    total = count = 0
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = [d for d in dirs if d not in OMIT_DIRS and not (Path(directory) / d).is_symlink()]
        for name in files:
            if name not in NAMES:
                continue
            path = Path(directory) / name
            meta = path.lstat()
            if not stat.S_ISREG(meta.st_mode):
                raise ValueError('audit manifests must be regular files')
            count += 1
            total += meta.st_size
            if meta.st_size > 64 * 1024 * 1024 or total > 256 * 1024 * 1024 or count > 10000:
                raise ValueError('audit manifest budget exceeded')
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            data = path.read_bytes()
            if name == 'package.json':
                package = json.loads(data)
                if not isinstance(package, dict):
                    raise ValueError('package.json must be an object')
                data = json.dumps({key: val for key, val in package.items() if key in PACKAGE_FIELDS}).encode()
            elif name == 'pnpm-workspace.yaml':
                # Workspace membership is data; pnpm settings/hooks/catalog protocol
                # selection are not allowed to change the depot toolchain.
                import yaml
                workspace = yaml.safe_load(data)
                data = yaml.safe_dump({'packages': workspace.get('packages', []), 'catalog': workspace.get('catalog', {}), 'catalogs': workspace.get('catalogs', {})}).encode()
            target.write_bytes(data)


def audit_environment(home, cache, executable_path):
    return {'PATH': executable_path, 'HOME': str(home), 'TMPDIR': str(home), 'LANG': 'C.UTF-8', 'CI': '1',
            'npm_config_ignore_scripts': 'true', 'npm_config_userconfig': str(home / 'user.npmrc'), 'npm_config_globalconfig': str(home / 'global.npmrc'),
            'npm_config_cache': str(cache), 'npm_config_registry': 'https://registry.npmjs.org',
            'npm_config_update_notifier': 'false', 'COREPACK_ENABLE_PROJECT_SPEC': '0',
            'YARN_IGNORE_PATH': '1', 'YARN_ENABLE_SCRIPTS': 'false', 'YARN_RC_FILENAME': '.depot-audit-yarnrc.yml',
            'YARN_NPM_REGISTRY_SERVER': 'https://registry.npmjs.org', 'YARN_ENABLE_TELEMETRY': '0'}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='mode', required=True)
    projection = sub.add_parser('project')
    projection.add_argument('--source', required=True)
    projection.add_argument('--destination', required=True)
    execute = sub.add_parser('exec')
    execute.add_argument('--root', required=True)
    execute.add_argument('--toolchain', required=True)
    execute.add_argument('command', nargs=argparse.REMAINDER)
    args = ap.parse_args()
    if args.mode == 'project':
        project(args.source, args.destination)
        return
    root, toolchain = Path(args.root).resolve(), Path(args.toolchain).resolve()
    command = args.command
    if command and command[0] == '--':
        command = command[1:]
    if not command or command[0] not in {'npm', 'pnpm', 'yarn-classic', 'yarn-berry'}:
        raise ValueError('expected a depot-installed audit package manager')
    entrypoints = {'npm': 'npm/bin/npm-cli.js', 'pnpm': 'pnpm/bin/pnpm.cjs',
                   'yarn-classic': 'yarn/bin/yarn.js', 'yarn-berry': '@yarnpkg/cli-dist/bin/yarn.js'}
    home = root.parent / 'audit-home'
    cache = root.parent / 'audit-cache'
    home.mkdir(exist_ok=True)
    cache.mkdir(exist_ok=True)
    for name in ('user.npmrc', 'global.npmrc'):
        (home / name).write_text('')
    node = (toolchain / 'node').resolve(strict=True)
    env = audit_environment(home, cache, f'{node.parent}:/usr/bin:/bin')
    result = subprocess.run([str(node), str(toolchain / 'node_modules' / entrypoints[command[0]]), *command[1:]], cwd=root, env=env, timeout=900)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
