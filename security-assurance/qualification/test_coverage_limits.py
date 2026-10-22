#!/usr/bin/env python3
"""Boundary regressions: incomplete scanner coverage must block promotion."""
import importlib.util
import io
import json
import os
import textwrap
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.github/scripts'
spec = importlib.util.spec_from_file_location('assets', SCRIPTS / 'asset_scan.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class CoverageLimits(unittest.TestCase):
    def scan(self, script, root, *extra):
        with tempfile.TemporaryDirectory() as out:
            result = Path(out) / 'findings.json'
            subprocess.run([sys.executable, str(SCRIPTS / script),
                            '--repo' if script == 'supply_chain.py' else '--root',
                            str(root), '--out', str(result), *extra], check=True,
                           capture_output=True)
            return json.loads(result.read_text())['items']

    def assert_blocked(self, items):
        self.assertTrue(any(i['severity'] in ('high', 'critical') for i in items), items)

    def test_zip_entry_overflow(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            for n in range(5001):
                archive.writestr(str(n), b'clean')
        findings = assets.Findings()
        assets.scan_zip('many.zip', data.getvalue(), findings)
        self.assert_blocked(findings.items)

    def test_oversized_non_xml_asset(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'large.gif').write_bytes(b'GIF89a' + b' ' * 100)
            self.assert_blocked(self.scan('asset_scan.py', root, '--max-bytes', '100'))

    def test_asset_file_cap_and_exact_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'first.svg').write_text('<svg/>')
            self.assertEqual([], self.scan('asset_scan.py', root, '--max-files', '1'))
            (Path(root) / 'second.svg').write_text('<svg/>')
            self.assert_blocked(self.scan('asset_scan.py', root, '--max-files', '1'))

    def test_oversized_shell(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'large.sh').write_text('# padding\n' * 200001)
            self.assert_blocked(self.scan('shell_audit.py', root))

    def test_project_cap_and_exact_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            for n in range(200):
                project = Path(root) / str(n)
                project.mkdir()
                (project / 'package.json').write_text('{}')
            self.assertEqual([], self.scan('supply_chain.py', root))
            project = Path(root) / 'extra'
            project.mkdir()
            (project / 'package.json').write_text('{}')
            self.assert_blocked(self.scan('supply_chain.py', root))


class MalwareCoverage(unittest.TestCase):
    def run_action(self, *, oversize=False, warning=False, clam_limit=False):
        action_path = ROOT / '.github/actions/malware-scan'
        source = (action_path / 'action.yml').read_text().split('      run: |\n', 1)[1]
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            candidate = directory / 'candidate'
            candidate.mkdir()
            rules = directory / 'rules'
            rules.mkdir()
            (rules / 'test.yar').write_text('rule clean { condition: false }')
            with (candidate / 'payload.bin').open('wb') as f:
                f.truncate(104857601 if oversize else 16)
            binaries = directory / 'bin'
            binaries.mkdir()
            stubs = {
                'clamscan': '#!/bin/sh\necho fixture-version\n',
                'sigtool': '#!/bin/sh\necho fixture-version\n',
                'timeout': '#!/bin/sh\nif [ "$WARN" = yes ]; then echo "WARNING: file skipped" >&2; fi\nif [ "$LIMIT" = yes ] && [ "$2" = clamscan ]; then\n case " $* " in *" --alert-exceeds-max=yes "*) echo "fixture: Heuristics.Limits.Exceeded FOUND"; exit 1;; esac\nfi\nexit 0\n',
            }
            for name, body in stubs.items():
                path = binaries / name
                path.write_text(body)
                path.chmod(0o700)
            replacements = {
                '${{ github.action_path }}': str(action_path),
                '${{ inputs.source_path }}': str(candidate),
                '${{ inputs.rules_path }}': str(rules),
                '${{ inputs.allow_freshclam }}': 'false',
                '${{ steps.yr.outputs.version }}': 'fixture',
                '${{ steps.yr.outputs.digest }}': 'fixture',
            }
            for key, value in replacements.items():
                source = source.replace(key, value)
            env = {**os.environ, 'PATH': str(binaries) + ':' + os.environ['PATH'],
                   'RESULTS_DIR': str(directory / 'results'),
                   'SOURCE_PATH': str(candidate), 'RULES_PATH': str(rules),
                   'WARN': 'yes' if warning else 'no', 'LIMIT': 'yes' if clam_limit else 'no'}
            subprocess.run(['bash', '-c', textwrap.dedent(source)], env=env,
                           check=True, capture_output=True)
            return [json.loads((directory / 'results' / (control + '.json')).read_text())['status']
                    for control in ('MAL-CLAMAV', 'MAL-YARAX')]

    def test_clean_control(self):
        self.assertEqual(['PASS', 'PASS'], self.run_action())

    def test_oversized_file_blocks_both_controls(self):
        self.assertTrue(all(s != 'PASS' for s in self.run_action(oversize=True)))

    def test_scanner_warning_blocks_both_controls(self):
        self.assertTrue(all(s != 'PASS' for s in self.run_action(warning=True)))

    def test_clam_internal_archive_limit_blocks(self):
        self.assertNotEqual('PASS', self.run_action(clam_limit=True)[0])


if __name__ == '__main__':
    unittest.main()
