"""Offline regressions for candidate/trusted scanner separation."""
import importlib.util
import json
from pathlib import Path
import tempfile
import shutil
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / '.github/scripts'


class ProjectionTests(unittest.TestCase):
    def module(self):
        path = SCRIPTS / 'audit_projection.py'
        self.assertTrue(path.exists(), 'audit commands need a trusted manifest-only projection')
        spec = importlib.util.spec_from_file_location('audit_projection', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_executable_config_and_scripts_are_not_projected(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / 'src', Path(tmp) / 'out'
            src.mkdir()
            (src / 'package.json').write_text(json.dumps({'name': 'safe', 'version': '1.0.0', 'scripts': {'prepare': 'touch HOST'}, 'packageManager': 'yarn@file:evil.cjs', 'pnpm': {'pnpmfile': 'evil.cjs'}, 'dependencies': {'foo': '^1.0.0'}}))
            for name in ('.yarnrc', '.yarnrc.yml', '.npmrc', '.pnpmfile.cjs', 'evil.cjs'):
                (src / name).write_text('yarnPath: ./evil.cjs')
            (src / 'yarn.lock').write_text('# yarn lockfile v1\n')
            mod.project(src, out)
            self.assertEqual(set(p.name for p in out.iterdir()), {'package.json', 'yarn.lock'})
            package = json.loads((out / 'package.json').read_text())
            self.assertNotIn('scripts', package)
            self.assertNotIn('packageManager', package)
            self.assertNotIn('pnpm', package)
            self.assertEqual(package['dependencies'], {'foo': '^1.0.0'})

    def test_manifest_symlink_cannot_read_host_file(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / 'src', Path(tmp) / 'out'
            src.mkdir()
            host = Path(tmp) / 'host.json'
            host.write_text('{}')
            (src / 'package.json').symlink_to(host)
            with self.assertRaises(ValueError):
                mod.project(src, out)

    def test_workspace_manifests_preserved_without_workspace_scripts(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / 'src', Path(tmp) / 'out'
            (src / 'packages/a').mkdir(parents=True)
            (src / 'package.json').write_text('{"name":"root","workspaces":["packages/*"]}')
            (src / 'packages/a/package.json').write_text('{"name":"a","version":"1.0.0","scripts":{"install":"false"}}')
            mod.project(src, out)
            self.assertEqual(json.loads((out / 'packages/a/package.json').read_text()), {'name': 'a', 'version': '1.0.0'})

    def test_real_offline_npm_cannot_run_candidate_prepare_script(self):
        mod = self.module()
        npm, node = shutil.which('npm'), shutil.which('node')
        if not npm or not node:
            self.skipTest('npm/node unavailable')
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            src, out, tc = tmp / 'src', tmp / 'out', tmp / 'tc'
            src.mkdir()
            marker = tmp / 'executed'
            package = {'name': 'projection-fixture', 'version': '1.0.0', 'scripts': {'prepare': 'touch ' + str(marker)}}
            (src / 'package.json').write_text(json.dumps(package))
            (src / 'package-lock.json').write_text(json.dumps({'name': package['name'], 'version': '1.0.0', 'lockfileVersion': 3, 'requires': True, 'packages': {'': {'name': package['name'], 'version': '1.0.0'}}}))
            (src / '.npmrc').write_text('ignore-scripts=false\n')
            mod.project(src, out)
            (tc / 'node_modules').mkdir(parents=True)
            (tc / 'node').symlink_to(node)
            (tc / 'node_modules/npm').symlink_to(Path(npm).resolve().parents[1])
            result = subprocess.run([sys.executable, str(SCRIPTS / 'audit_projection.py'), 'exec', '--root', str(out), '--toolchain', str(tc), '--', 'npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists())

    def test_environment_does_not_forward_commands_or_loader_injection(self):
        mod = self.module()
        env = mod.audit_environment(Path('/tmp/home'), Path('/tmp/cache'), '/usr/bin')
        self.assertNotIn('GITHUB_ENV', env)
        self.assertNotIn('NODE_OPTIONS', env)
        self.assertEqual(env['YARN_IGNORE_PATH'], '1')
        self.assertEqual(env['npm_config_ignore_scripts'], 'true')


class DatabaseTests(unittest.TestCase):
    def module(self):
        path = SCRIPTS / 'codeql_isolated.py'
        self.assertTrue(path.exists(), 'CodeQL needs an isolated database transport')
        spec = importlib.util.spec_from_file_location('codeql_isolated', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_all_detected_languages_have_canonical_database_names(self):
        mod = self.module()
        for alias, canonical in {'javascript-typescript': 'javascript', 'java-kotlin': 'java', 'c-cpp': 'cpp', 'actions': 'actions'}.items():
            self.assertEqual(mod.canonical_language(alias), canonical)

    def test_database_transport_rejects_symlink_and_unfinalized_database(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / 'db', Path(tmp) / 'out'
            src.mkdir()
            (src / 'codeql-database.yml').write_text('inProgress: true\n')
            with self.assertRaises(ValueError):
                mod.copy_database(src, out, 'cpp')
            (src / 'codeql-database.yml').write_text('primaryLanguage: cpp\n')
            (src / 'db-cpp').mkdir()
            (src / 'db-cpp/evil').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                mod.copy_database(src, out, 'cpp')

    def test_database_transport_does_not_copy_query_config_or_executables(self):
        mod = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / 'db', Path(tmp) / 'out'
            (src / 'db-cpp').mkdir(parents=True)
            (src / 'codeql-database.yml').write_text('primaryLanguage: cpp\n')
            (src / 'db-cpp/data').write_bytes(b'data')
            (src / 'codeql-config.yml').write_text('queries: [./evil.ql]')
            (src / 'evil.ql').write_text('untrusted query')
            mod.copy_database(src, out, 'cpp')
            self.assertEqual(set(p.name for p in out.iterdir()), {'db-cpp', 'codeql-database.yml'})
            self.assertFalse((out / 'db-cpp/data').stat().st_mode & 0o111)


class AuditOutputTests(unittest.TestCase):
    def normalize(self, records, mode, rc):
        path = SCRIPTS / 'yarn_audit_result.py'
        self.assertTrue(path.exists(), 'Yarn errors must not normalize to zero findings')
        spec = importlib.util.spec_from_file_location('yarn_audit_result', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.normalize('\n'.join(json.dumps(x) for x in records), mode, rc)

    def test_classic_and_berry_error_record_never_pass(self):
        for mode in ['classic', 'berry']:
            result = self.normalize([{'type': 'error', 'data': 'configuration failure'}], mode, 1)
            self.assertTrue(result['parse_error'])
            self.assertTrue(self.normalize([], mode, 1)['parse_error'])

    def test_classic_valid_advisory_bitmask_and_clean_summary(self):
        records = [{'type': 'auditAdvisory', 'data': {'advisory': {'severity': 'high', 'module_name': 'fixture', 'title': 'fixture'}}}, {'type': 'auditSummary', 'data': {'vulnerabilities': {'high': 1}}}]
        result = self.normalize(records, 'classic', 8)
        self.assertIsNone(result['parse_error'])
        self.assertEqual(result['items'][0]['severity'], 'high')
        self.assertIsNone(self.normalize([{'type': 'auditSummary', 'data': {'vulnerabilities': {'high': 0}}}], 'classic', 0)['parse_error'])

    def test_berry_clean_and_valid_advisory(self):
        self.assertIsNone(self.normalize([{'type': 'info', 'name': 0, 'data': 'No audit suggestions'}], 'berry', 0)['parse_error'])
        result = self.normalize([{'value': 'GHSA-fixture', 'children': {'Severity': 'high', 'Issue': 'fixture'}}], 'berry', 1)
        self.assertIsNone(result['parse_error'])
        self.assertEqual(result['items'][0]['severity'], 'high')


class PnpmOutputTests(unittest.TestCase):
    def normalize(self, payload, rc):
        path = SCRIPTS / 'pnpm_audit_result.py'
        self.assertTrue(path.exists(), 'pnpm needs a fail-closed response parser')
        spec = importlib.util.spec_from_file_location('pnpm_audit_result', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.normalize(payload, rc)

    def test_error_empty_and_malformed_responses_block(self):
        for payload in ['', '{', '{}', 'null', '[]', '{"error":{"message":"network failed"}}', '{"advisories":[]}', '{"advisories":{},"error":"network failed"}']:
            for rc in [0, 1]:
                with self.subTest(payload=payload, rc=rc):
                    self.assertTrue(self.normalize(payload, rc)['parse_error'])
        self.assertTrue(self.normalize('{"advisories":{}}', 1)['parse_error'])

    def test_valid_empty_advisories_pass_only_on_success(self):
        result = self.normalize('{"advisories":{}}', 0)
        self.assertEqual(result, {'items': [], 'parse_error': None})
        self.assertTrue(self.normalize('{"advisories":{}}', 2)['parse_error'])

    def test_valid_low_and_high_advisories_preserve_exit_one(self):
        for severity in ['low', 'high']:
            payload = json.dumps({'advisories': {'123': {'severity': severity, 'module_name': 'fixture', 'title': 'fixture advisory'}}})
            result = self.normalize(payload, 1)
            self.assertIsNone(result['parse_error'])
            self.assertEqual(result['items'][0]['severity'], severity)
            self.assertTrue(self.normalize(payload, 2)['parse_error'])
        self.assertTrue(self.normalize('{"advisories":{"123":{}}}', 1)['parse_error'])


class WorkflowTests(unittest.TestCase):
    def test_extraction_cannot_upload_results_or_write_security_events(self):
        import yaml
        workflow = yaml.safe_load((SCRIPTS.parents[1] / '.github/workflows/security-assurance.yml').read_text())
        jobs = workflow['jobs']
        self.assertIn('codeql-extract', jobs)
        extract = jobs['codeql-extract']
        self.assertNotIn('security-events', extract['permissions'])
        uploads = [s for s in extract['steps'] if 'actions/upload-artifact@' in s.get('uses', '')]
        self.assertEqual(len(uploads), 1)
        self.assertIn('codeql-database', uploads[0]['with']['name'])
        self.assertIn('codeql-extract', jobs['codeql']['needs'])
        self.assertNotIn('build_command:', str(jobs['codeql']))


if __name__ == '__main__':
    unittest.main()
