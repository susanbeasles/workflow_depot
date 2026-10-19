#!/usr/bin/env python3
"""Isolate CodeQL extraction and analysis; transfer a bounded finalized DB as data."""
import argparse
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

import yaml

LANGUAGES = {'actions', 'cpp', 'csharp', 'go', 'java', 'javascript', 'python', 'ruby', 'rust', 'swift'}
ALIASES = {'javascript-typescript': 'javascript', 'java-kotlin': 'java', 'c-cpp': 'cpp'}

def canonical_language(language):
    language = ALIASES.get(language, language)
    if language not in LANGUAGES:
        raise ValueError('unsupported CodeQL language')
    return language


def require_qualified_language(language):
    # Keep Swift in detection/control coverage, but do not claim this Linux boundary is qualified.
    if canonical_language(language) == 'swift':
        raise ValueError('Swift CodeQL remains unqualified in the permitted runner boundary')


MAX_DATABASE_BYTES = 4 * 1024 * 1024 * 1024
MAX_DATABASE_FILES = 100000


def copy_database(source, destination, language):
    if language not in LANGUAGES:
        raise ValueError('unsupported CodeQL language')
    source, destination = Path(source), Path(destination)
    metadata = source / 'codeql-database.yml'
    if metadata.is_symlink() or not metadata.is_file() or metadata.stat().st_size > 1024 * 1024:
        raise ValueError('missing/invalid database metadata')
    data = yaml.safe_load(metadata.read_text())
    if not isinstance(data, dict) or 'inProgress' in data or data.get('primaryLanguage') != language:
        raise ValueError('only finalized databases may reach analysis')
    dataset = source / f'db-{language}'
    if dataset.is_symlink() or not dataset.is_dir():
        raise ValueError('missing database dataset')
    # Never transport query packs, code-scanning config, action state, or scripts.
    roots = [metadata, dataset]
    for name in ('src.zip', 'baseline-info.json'):
        if (source / name).exists() or (source / name).is_symlink():
            roots.append(source / name)
    files, total = [], 0
    for root in roots:
        if root.is_symlink():
            raise ValueError('database links forbidden')
        candidates = [root] if root.is_file() else list(root.rglob('*'))
        for path in candidates:
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                continue
            if not stat.S_ISREG(mode):
                raise ValueError('database special files/links forbidden')
            total += path.stat().st_size
            files.append(path)
            if total > MAX_DATABASE_BYTES or len(files) > MAX_DATABASE_FILES:
                raise ValueError('database transport budget exceeded')
    destination.mkdir(parents=True, exist_ok=False)
    for path in files:
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target, follow_symlinks=False)
        target.chmod(0o600)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('phase', choices=['extract', 'analyze'])
    ap.add_argument('--codeql', required=True)
    ap.add_argument('--language', choices=sorted(LANGUAGES | ALIASES.keys()), required=True)
    ap.add_argument('--source', required=True)
    ap.add_argument('--database', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--requires-build', choices=['true', 'false'], default='false')
    args = ap.parse_args()
    args.language = canonical_language(args.language)
    require_qualified_language(args.language)
    command = os.environ.get('CODEQL_BUILD_COMMAND', '')
    if args.phase == 'extract' and args.requires_build == 'true' and not command:
        raise ValueError('compiled-language extraction needs an operator-approved build command')
    codeql = Path(args.codeql).resolve(strict=True)
    sandbox = Path(__file__).with_name('sandbox_exec.sh')
    # Only the CodeQL distribution, source data and a disposable output tree enter.
    with tempfile.TemporaryDirectory(prefix='codeql-isolated-', dir=os.environ.get('RUNNER_TEMP')) as temp:
        temp = Path(temp)
        work = temp / 'work'
        work.mkdir()
        if args.phase == 'extract':
            cli = ['/codeql/codeql', 'database', 'create', '/out/database', f'--language={args.language}', '--source-root=/out/source', '--threads=2', '--ram=3072']
            if args.requires_build == 'true':
                cli.append('--command=' + command)
            else:
                cli.append('--build-mode=none')
            inner = ['/bin/sh', '-c', 'cp -a /work /out/source && exec "$@"', 'sh', *cli]
        else:
            empty_source = temp / 'empty-source'
            empty_source.mkdir()
            args.source = str(empty_source)
            copy_database(args.database, work / 'database', args.language)
            # Explicit trusted suite ignores any query/config material in the DB.
            suite = f'codeql/{args.language}-queries:codeql-suites/{args.language}-security-extended.qls'
            inner = ['/codeql/codeql', 'database', 'analyze', '/out/database', suite, '--format=sarif-latest', '--output=/out/results.sarif', '--threads=2', '--ram=3072']
        # Stream stdout to a host-owned log, never into Actions command parsing
        # or an unbounded in-memory capture. Sandbox rlimits bound file writes.
        log = Path(args.output)
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.with_suffix('.log').open('wb') as output_log:
            result = subprocess.run(['bash', str(sandbox), '--src', str(Path(args.source).resolve()), '--out', str(work), '--ro', f'{codeql.parent}:/codeql', '--timeout', '3000', '--mem-mb', '6144', '--', *inner], stdout=output_log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f'CodeQL {args.phase} failed in sandbox (exit {result.returncode}); see log artifact')
        if args.phase == 'extract':
            copy_database(work / 'database', args.database, args.language)
        else:
            sarif = work / 'results.sarif'
            if sarif.is_symlink() or not sarif.is_file() or sarif.stat().st_size > 64 * 1024 * 1024:
                raise ValueError('missing/oversized SARIF')
            shutil.copyfile(sarif, log)


if __name__ == '__main__':
    main()
