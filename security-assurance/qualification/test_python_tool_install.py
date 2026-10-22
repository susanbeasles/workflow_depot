"""Offline installer contract tests: synthetic locks/cache and mocked pip only."""
import importlib.util, pathlib, subprocess, tempfile, unittest
SCRIPTS=pathlib.Path(__file__).resolve().parents[1]/'.github/scripts'
spec=importlib.util.spec_from_file_location('python_tool_install',SCRIPTS/'python_tool_install.py');installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
class PythonToolInstall(unittest.TestCase):
 def fixture(self,root):
  policy=root/'policy';policy.mkdir();(policy/'tool-registry.yml').write_text('python_tools:\n  semgrep: "1.180.0"\n');(policy/'python-locks').mkdir();return policy
 def test_missing_locks_or_wheels_do_not_invoke_venv_or_pip(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);policy=self.fixture(root);calls=[]
   with self.assertRaisesRegex(ValueError,'hash lock unavailable'):installer.install(policy,['semgrep'],root,run=lambda *a,**k:calls.append(a),make_venv=lambda *a:calls.append(a))
   (policy/'python-locks/semgrep.txt').write_text('semgrep==1.180.0 --hash=sha256:'+'a'*64+'\n')
   with self.assertRaisesRegex(ValueError,'wheelhouse unavailable'):installer.install(policy,['semgrep'],root,run=lambda *a,**k:calls.append(a),make_venv=lambda *a:calls.append(a))
   self.assertEqual(calls,[])
 def test_hashlock_exact_pins_and_registry_versions_required(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);policy=self.fixture(root);lock=policy/'python-locks/semgrep.txt'
   for text in ['semgrep==1.180.0\n','--index-url https://untrusted.invalid\n','semgrep @ https://untrusted.invalid/tool.whl\n','semgrep==1.0.0 --hash=sha256:'+'a'*64+'\n']:
    with self.subTest(text=text):lock.write_text(text);self.assertRaises(ValueError,installer.reviewed_requirements,policy,['semgrep'])
 def test_fresh_venv_hash_only_no_network_and_transitive_check(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);policy=self.fixture(root);(policy/'python-locks/semgrep.txt').write_text('semgrep==1.180.0 --hash=sha256:'+'a'*64+'\ndependency==2.0 --hash=sha256:'+'b'*64+'\n');wheelhouse=root/'depot-python-wheelhouse';wheelhouse.mkdir();(wheelhouse/'synthetic.whl').write_bytes(b'synthetic fixture; pip mocked')
   calls=[];venvs=[]
   binpath=installer.install(policy,['semgrep'],root,run=lambda *a,**k:calls.append((a,k)),make_venv=lambda path:venvs.append(path))
   self.assertEqual(len(venvs),1);self.assertEqual(binpath,str(venvs[0]/'bin'));command=calls[0][0][0]
   for flag in ['--isolated','--no-index','--require-hashes','--no-deps','--ignore-installed','--only-binary=:all:','--no-cache-dir']:self.assertIn(flag,command)
   self.assertEqual(calls[1][0][0][-1],'check');self.assertNotIn('PYTHONPATH',calls[0][1]['env']);self.assertNotIn('PIP_INDEX_URL',calls[0][1]['env'])
   def fail_check(command,**kwargs):
    if command[-1]=='check':raise subprocess.CalledProcessError(1,command)
   with self.assertRaises(subprocess.CalledProcessError):installer.install(policy,['semgrep'],root,run=fail_check,make_venv=lambda path:None)
 def test_no_direct_pip_install_remains_in_actions_or_imported_workflows(self):
  root=SCRIPTS.parent
  for directory in [root/'actions',root/'workflows']:
   self.assertTrue(directory.is_dir())
   for path in directory.rglob('*.yml'):
    self.assertNotRegex(path.read_text(),r'(?m)^\s*(?:- run:\s*)?pip(?:3)?\s+install\s')
if __name__=='__main__':unittest.main()
