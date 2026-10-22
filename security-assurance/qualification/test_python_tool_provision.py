"""Provisioning command contract; all public downloads and venv creation mocked."""
import importlib.util,pathlib,subprocess,tempfile,unittest
from unittest.mock import patch
S=pathlib.Path(__file__).resolve().parents[1]/'.github/scripts/python_tool_install.py';spec=importlib.util.spec_from_file_location('provision',S);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Provision(unittest.TestCase):
 def fixture(self,root):
  policy=root/'policy';(policy/'python-locks').mkdir(parents=True);(policy/'tool-registry.yml').write_text('python_tools:\n  hypothesis: "6.169.0"\n');(policy/'python-locks/hypothesis.txt').write_text('hypothesis==6.169.0 --hash=sha256:'+'a'*64+'\n');return policy
 def test_public_provision_is_hash_only_and_installs_offline(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);policy=self.fixture(root);calls=[]
   def run(command,**kw):
    calls.append((command,kw))
    if 'download' in command:
     dest=pathlib.Path(command[command.index('--dest')+1]);dest.mkdir(exist_ok=True);(dest/'synthetic.whl').write_bytes(b'fixture only; pip mocked')
   result=m.install(policy,['hypothesis'],root,provision=True,run=run,make_venv=lambda p:None)
   download,kw=calls[0];self.assertIn('download',download)
   for flag in ['--require-hashes','--only-binary=:all:','--no-deps','--no-cache-dir','--keyring-provider']:self.assertIn(flag,download)
   self.assertEqual(download[download.index('--index-url')+1],'https://pypi.org/simple');self.assertEqual(kw['env']['NETRC'],'/dev/null');self.assertNotIn('PIP_EXTRA_INDEX_URL',kw['env']);self.assertNotIn('GITHUB_TOKEN',kw['env'])
   self.assertIn('--no-index',calls[1][0]);self.assertEqual(calls[2][0][-1],'check');self.assertTrue(result.endswith('/bin'))
 def test_failed_hash_download_prevents_install(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);policy=self.fixture(root);calls=[]
   def run(command,**kw):calls.append(command);raise subprocess.CalledProcessError(1,command)
   with self.assertRaises(subprocess.CalledProcessError):m.install(policy,['hypothesis'],root,provision=True,run=run,make_venv=lambda p:None)
   self.assertEqual(len(calls),1);self.assertIn('download',calls[0]);self.assertNotIn('install',calls[0])
if __name__=='__main__':unittest.main()
