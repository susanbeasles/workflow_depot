"""Run the actual action-policy control against synthetic allowed/Docker workflow fixtures."""
import pathlib,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class Docker(unittest.TestCase):
 def test_container_actions_fail_actual_policy_control(self):
  for ref,passes in [('actions/checkout@'+'a'*40,True),('docker://alpine:latest',False),('docker://ghcr.io/susanbeasles/image@sha256:'+'a'*64,False)]:
   with self.subTest(ref=ref),tempfile.TemporaryDirectory() as t:
    p=pathlib.Path(t);(p/'test').mkdir();(p/'.github/workflows').mkdir(parents=True);(p/'pipeline').mkdir();(p/'pipeline/pipeline.yml').write_text('name: fixture\n');(p/'.github/workflows/fixture.yml').write_text('steps:\n - uses: '+ref+'\n');(p/'test/actions-policy.test.mjs').write_bytes((ROOT/'test/actions-policy.test.mjs').read_bytes());r=subprocess.run(['node','--test','test/actions-policy.test.mjs'],cwd=p,capture_output=True,text=True);self.assertEqual(r.returncode==0,passes,r.stdout+r.stderr)
if __name__=='__main__':unittest.main()
