"""Offline execution tests for composite-action input/shell boundaries."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


class InputBoundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.marker = self.root / 'host-executed'
        self.log = self.root / 'args.jsonl'
        scripts = self.root / 'scripts'
        scripts.mkdir()
        recorder = ('import json,os,sys\n'
                    'with open(os.environ["ARG_LOG"], "a") as f: '
                    'f.write(json.dumps(sys.argv)+"\\n")\n')
        for name in ('result.py', 'gate.py'):
            (scripts / name).write_text(recorder)
        (scripts / 'sandbox_exec.sh').write_text(
            '#!/usr/bin/env python3\n' + recorder)
        (scripts / 'sandbox_exec.sh').chmod(0o755)
        self.action_path = self.root / 'actions' / 'fake'
        self.action_path.mkdir(parents=True)
        self.results = self.root / 'results'
        self.results.mkdir()

    def run_step(self, action, overrides, step_id=None):
        self.marker.unlink(missing_ok=True)
        definition = yaml.safe_load((ROOT / '.github/actions' / action / 'action.yml').read_text())
        inputs = {k: str(v.get('default', '')) for k, v in definition['inputs'].items()}
        inputs.update(source_path=str(self.root), out_path=str(self.root / 'out'),
                      results_dir=str(self.results), command='echo ok')
        inputs.update(overrides)
        steps = [s for s in definition['runs']['steps'] if 'run' in s]
        step = next(s for s in steps if s.get('id') == step_id) if step_id else steps[-1]
        def render(s):
            return re.sub(r'\$\{\{\s*(inputs\.\w+|github.action_path)\s*\}\}',
                          lambda m: str(self.action_path) if m[1] == 'github.action_path'
                          else inputs[m[1].split('.')[1]], str(s))
        env = {**os.environ, 'ARG_LOG': str(self.log), 'RESULTS_DIR': str(self.results),
               'RUNNER_TEMP': str(self.root), 'GITHUB_OUTPUT': str(self.root / 'output')}
        env.update({k: render(v) for k, v in step.get('env', {}).items()})
        result = subprocess.run(['bash', '-c', render(step['run'])], env=env,
                                cwd=self.root, capture_output=True, text=True)
        return result

    def test_ai_disabled_model_is_not_host_code(self):
        result = self.run_step('ai-review', {'model': f'$(touch {self.marker})'})
        self.assertFalse(self.marker.exists(), result.stderr)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_profile_and_stage_injections_are_rejected(self):
        for field in ('profile', 'stage'):
            with self.subTest(field=field):
                result = self.run_step('gate-evaluate', {field: f'$(touch {self.marker})'})
                self.assertFalse(self.marker.exists(), result.stderr)
                self.assertNotEqual(result.returncode, 0)

    def test_ai_validation_is_secret_free_and_rejects_bad_limits(self):
        definition = yaml.safe_load((ROOT / '.github/actions/ai-review/action.yml').read_text())
        step = next((s for s in definition['runs']['steps'] if s.get('id') == 'validate'), None)
        self.assertIsNotNone(step)
        self.assertNotIn('ANTHROPIC_API_KEY', step.get('env', {}))
        for field, value in (('max_tokens', '0'), ('max_diff_bytes', '-1'),
                             ('enabled', 'yes'), ('endpoint', 'https://attacker.invalid')):
            with self.subTest(field=field):
                result = self.run_step('ai-review', {'enabled': 'true', field: value}, 'validate')
                self.assertNotEqual(result.returncode, 0)
        result = self.run_step('ai-review', {'enabled': 'true'}, 'validate')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_no_inputs_are_rendered_as_shell_source(self):
        for action in ('ai-review', 'gate-evaluate', 'sandbox-exec'):
            definition = yaml.safe_load((ROOT / '.github/actions' / action / 'action.yml').read_text())
            for step in definition['runs']['steps']:
                self.assertNotRegex(step.get('run', ''), r'\$\{\{.*inputs\.')

    def test_gate_valid_inputs_reach_gate_unchanged(self):
        result = self.run_step('gate-evaluate', {'profile': 'strict', 'stage': '0,2'})
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.log.read_text().splitlines()[-1])
        self.assertEqual(args[args.index('--stage') + 1], '0,2')
        self.assertTrue(args[-1].endswith('gate-0-2'))

    def test_sandbox_command_is_only_passed_as_data(self):
        payload = f"'; touch {self.marker}; #"
        result = self.run_step('sandbox-exec', {'command': payload})
        self.assertFalse(self.marker.exists(), result.stderr)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.log.read_text().splitlines()[-1])
        self.assertEqual(args[-3:], ['/bin/sh', '-c', payload])

    def test_sandbox_paths_and_multiline_mounts_are_literal(self):
        payload = f'$(touch {self.marker})'
        result = self.run_step('sandbox-exec', {
            'source_path': payload, 'out_path': str(self.root / 'safe output'),
            'ro_mounts': '/one:/one\n/two:/two'})
        self.assertFalse(self.marker.exists(), result.stderr)
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.log.read_text().splitlines()[-1])
        self.assertEqual(args[args.index('--src') + 1], payload)
        self.assertIn('/one:/one', args)
        self.assertIn('/two:/two', args)

    def test_sandbox_limits_reject_code_and_zero(self):
        for field in ('timeout_s', 'mem_mb'):
            for value in (f'$(touch {self.marker})', '0', '-1', '99999999999999'):
                with self.subTest(field=field, value=value):
                    result = self.run_step('sandbox-exec', {field: value})
                    self.assertFalse(self.marker.exists(), result.stderr)
                    self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
