import importlib.util,pathlib,tempfile,json,hashlib,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('verify',pathlib.Path(__file__).with_name('verify-build.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class BuildVerification(unittest.TestCase):
 def test_identity_and_bytes_fail_closed(self):
  with tempfile.TemporaryDirectory() as td:
   p=pathlib.Path(td);(p/'payload').mkdir();(p/'payload/app.js').write_bytes(b'code')
   env=dict(GITHUB_REPOSITORY='o/r',GITHUB_SHA='a'*40,GITHUB_REF='refs/heads/int/x',GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='2')
   doc=dict(schema=1,repository='o/r',sourceSha='a'*40,sourceRef='refs/heads/int/x',runId='1',runAttempt='2',files=[dict(path='app.js',bytes=4,sha256=hashlib.sha256(b'code').hexdigest())]);(p/'build-manifest.json').write_text(json.dumps(doc))
   m.verify(p,env)
   with self.assertRaises(ValueError):m.verify(p,{**env,'GITHUB_SHA':'b'*40})
   (p/'payload/app.js').write_bytes(b'evil')
   with self.assertRaises(ValueError):m.verify(p,env)
   (p/'payload/app.js').write_bytes(b'code');(p/'payload/extra').write_bytes(b'extra')
   with self.assertRaises(ValueError):m.verify(p,env)
 def test_aggregate_preflight_rejects_before_payload_reads(self):
  for limits in [dict(MAX_FILES=1),dict(MAX_TOTAL_BYTES=7),dict(MAX_FILE_BYTES=3),dict(MAX_ENTRIES=1),dict(MAX_MANIFEST_BYTES=1)]:
   with self.subTest(limits=limits),tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td);(root/'payload').mkdir()
    files=[]
    for name in ['a','b']:
     (root/'payload'/name).write_bytes(b'code');files.append(dict(path=name,bytes=4,sha256=hashlib.sha256(b'code').hexdigest()))
    env=dict(GITHUB_REPOSITORY='o/r',GITHUB_SHA='a'*40,GITHUB_REF='refs/heads/int/x',GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='2')
    (root/'build-manifest.json').write_text(json.dumps(dict(schema=1,repository='o/r',sourceSha='a'*40,sourceRef='refs/heads/int/x',runId='1',runAttempt='2',files=files)))
    original=pathlib.Path.open
    def bounded_open(path,*args,**kwargs):
     if path.parent.name=='payload':self.fail('payload opened before budget rejection')
     return original(path,*args,**kwargs)
    with patch.multiple(m,**limits),patch.object(pathlib.Path,'open',bounded_open),patch.object(m.os,'open',side_effect=AssertionError('payload opened before budget rejection')),self.assertRaises(ValueError):m.verify(root,env)
if __name__=='__main__':unittest.main()
