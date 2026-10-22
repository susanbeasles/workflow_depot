"""Synthetic deterministic elapsed-budget tests; no scans, keys or network."""
import hashlib,importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).parent

def load(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
v=load('verify-build');r=load('release-materials')
class Elapsed(unittest.TestCase):
 def fixture(self,p):
  root=p/'root';(root/'payload').mkdir(parents=True);(root/'payload/one').write_bytes(b'code')
  env=dict(GITHUB_REPOSITORY='o/r',GITHUB_SHA='a'*40,GITHUB_REF='refs/heads/main',GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='1')
  doc=dict(schema=1,repository='o/r',sourceSha=env['GITHUB_SHA'],sourceRef=env['GITHUB_REF'],runId='1',runAttempt='1',files=[dict(path='one',bytes=4,sha256=hashlib.sha256(b'code').hexdigest())]);(root/'build-manifest.json').write_text(json.dumps(doc));sbom=p/'sbom';sbom.mkdir();(sbom/'sbom.cdx.json').write_text('{"bomFormat":"CycloneDX"}');(sbom/'sbom.spdx.json').write_text('{"spdxVersion":"SPDX-2.3"}');return root,sbom,env
 def test_verifier_time_budget(self):
  with tempfile.TemporaryDirectory() as t:
   root,sbom,env=self.fixture(pathlib.Path(t))
   with patch('time.monotonic',side_effect=range(0,10000,121)),self.assertRaisesRegex(ValueError,'time budget'):v.verify(root,env)
 def test_packager_time_budget_before_payload_reads(self):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t);root,sbom,env=self.fixture(p)
   with patch.object(r.v,'verify',return_value=json.loads((root/'build-manifest.json').read_text())),patch('time.monotonic',side_effect=range(0,10000,121)),self.assertRaisesRegex(ValueError,'time budget'):r.package(root,sbom,p/'out',env)
if __name__=='__main__':unittest.main()
