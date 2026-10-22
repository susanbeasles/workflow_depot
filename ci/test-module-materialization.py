#!/usr/bin/env python3
"""Keep trusted central depot modules usable before executing local actions."""
import importlib.util
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'security-assurance/.github/workflows/security-assurance.yml'
NAME = 'Materialize intact security-assurance module'
COMMAND = 'cp -a -- .security-depot/security-assurance/. .security-depot/'
SPEC = importlib.util.spec_from_file_location('adapter', ROOT / 'ci/adapt_security.py')
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


class Materialization(unittest.TestCase):
    def check_workflow(self, source):
        jobs = yaml.safe_load(source)['jobs']
        checked = 0
        for name, job in jobs.items():
            steps = job.get('steps', [])
            copies = [i for i, s in enumerate(steps) if s.get('name') == NAME]
            for i, step in enumerate(steps):
                if step.get('with', {}).get('path') == '.security-depot':
                    with self.subTest(job=name):
                        checked += 1
                        self.assertEqual(copies, [i + 1])
                        self.assertEqual(steps[i + 1]['run'], COMMAND)
                if step.get('uses', '').startswith('./.security-depot/'):
                    with self.subTest(job=name, action=step['uses']):
                        self.assertTrue(any(copy < i for copy in copies))
        self.assertGreaterEqual(checked, 9)

    def test_module_materializes_before_local_actions(self):
        self.check_workflow(MODULE.read_text())

    def test_adapter_keeps_exactly_one_copy_per_checkout(self):
        source = MODULE.read_text()
        lines = source.splitlines(True)
        # Feed an already-materialized module to catch duplicate adapter insertion.
        for i in range(len(lines) - 1, -1, -1):
            if 'with: { repository:' in lines[i] and 'path: .security-depot' in lines[i]:
                if i + 1 >= len(lines) or lines[i + 1].strip() != '- name: ' + NAME:
                    lines.insert(i + 1, '      - name: ' + NAME + '\n        run: ' + COMMAND + '\n')
        self.check_workflow(ADAPTER.adapt(''.join(lines)))

    def test_generated_workflow_matches_adapter(self):
        self.assertEqual((ROOT / '.github/workflows/security-assurance.yml').read_text(),
                         ADAPTER.adapt(MODULE.read_text()))


if __name__ == '__main__':
    unittest.main()
