"""Synthetic lockfile projection regressions; never install candidate dependencies."""
import importlib.util
from pathlib import Path
import json
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_projection', ROOT/'.github/scripts/audit_projection.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RegistryBoundary(unittest.TestCase):
    def test_registry_tarball_and_safe_workspace(self):
        module.validate_npm_lock({'packages': {'node_modules/a': {'resolved': 'https://registry.npmjs.org/a/-/a-1.0.0.tgz'}, 'node_modules/b': {'resolved': 'packages/b', 'link': True}}})

    def test_unapproved_sources_rejected(self):
        for source in ['https://attacker.example/a.tgz', 'http://registry.npmjs.org/a.tgz', 'https://registry.npmjs.org.attacker.example/a.tgz', 'https://user:secret@registry.npmjs.org/a.tgz', 'https://registry.npmjs.org:443/a.tgz', 'git+https://github.com/a/b', 'file:../../outside', '//registry.npmjs.org/a.tgz']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.validate_npm_lock({'dependencies': {'a': {'resolved': source}}})

    def test_escaping_workspace_rejected(self):
        for source in ['../outside', '/tmp/outside', 'packages/../../outside', 'C:/outside']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.validate_npm_lock({'resolved': source, 'link': True})

    def test_projection_rejects_before_package_manager_execution(self):
        for name in ['package-lock.json', 'npm-shrinkwrap.json']:
            with tempfile.TemporaryDirectory() as temp:
                source = Path(temp)/'source'
                source.mkdir()
                (source/name).write_text(json.dumps({'packages': {'a': {'resolved': 'https://attacker.example/a.tgz'}}}))
                with self.assertRaises(ValueError):
                    module.project(source, Path(temp)/'projection')

if __name__ == '__main__':
    unittest.main()
