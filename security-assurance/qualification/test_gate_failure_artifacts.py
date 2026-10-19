"""Gate failure diagnostic artifacts remain available without publishing raw evidence."""
import hashlib,json,pathlib,subprocess,sys,tempfile,unittest,yaml
ROOT=pathlib.Path(__file__).resolve().parents[1];SCRIPT=ROOT/'.github/scripts/gate_diagnostics.py'
class Diagnostics(unittest.TestCase):
 def test_failed_gate_preserves_bounded_sanitized_metadata(self):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t);results=p/'results';results.mkdir();gate=results/'gate-0';out=p/'diagnostics'
   failed=subprocess.run([sys.executable,str(ROOT/'.github/scripts/gate.py'),'--policy',str(ROOT/'policy/release-policy.yml'),'--results',str(results),'--stage','0','--out',str(gate),'--repo','fixture/repo','--sha','a'*40],capture_output=True)
   self.assertEqual(failed.returncode,1)
   original={name:(gate/name).read_bytes() for name in ['gate-decision.json','evidence-manifest.json']}
   doc=json.loads(original['gate-decision.json']);doc['controls'][0]['detail']='SECRET_FIXTURE_ONLY'*10000;doc['controls'][0]['tool']='MRN: ABCD1234';doc['unknown_results']=['SECRET_FIXTURE_ONLY'];(gate/'gate-decision.json').write_text(json.dumps(doc))
   manifest=json.loads(original['evidence-manifest.json']);manifest['entries']=[{'control':doc['controls'][0]['control'],'result_file':'SECRET_FIXTURE_ONLY','sha256':'b'*64,'evidence':['MRN: ABCD1234']}];(gate/'evidence-manifest.json').write_text(json.dumps(manifest))
   before={n:(gate/n).read_bytes() for n in original}
   subprocess.run([sys.executable,str(SCRIPT),'--gate',str(gate),'--out',str(out),'--policy',str(ROOT/'policy/release-policy.yml')],check=True)
   decision=json.loads((out/'gate-decision.json').read_text());self.assertEqual(decision['decision'],'FAIL');self.assertTrue(decision['diagnostic_only']);self.assertEqual(decision['original_sha256'],hashlib.sha256(before['gate-decision.json']).hexdigest())
   for path in out.iterdir():
    data=path.read_bytes();self.assertLessEqual(len(data),32768);self.assertNotIn(b'SECRET_FIXTURE_ONLY',data);self.assertNotIn(b'MRN:',data)
   self.assertEqual(before,{n:(gate/n).read_bytes() for n in original})
 def test_missing_gate_outputs_have_explicit_unavailable_artifacts(self):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t);out=p/'out';subprocess.run([sys.executable,str(SCRIPT),'--gate',str(p/'absent'),'--out',str(out),'--policy',str(ROOT/'policy/release-policy.yml')],check=True)
   d=json.loads((out/'gate-decision.json').read_text());self.assertIsNone(d['decision']);self.assertFalse(d['available']);self.assertIn('unavailable',(out/'summary.md').read_text())
 def test_workflow_collects_and_uploads_after_gate_failure(self):
  workflow=yaml.safe_load((ROOT/'.github/workflows/security-assurance.yml').read_text());steps=workflow['jobs']['gate-stage0']['steps'];gate=next(i for i,s in enumerate(steps) if s.get('id')=='g');diag=next((i,s) for i,s in enumerate(steps) if 'gate_diagnostics.py' in s.get('run',''));upload=next((i,s) for i,s in enumerate(steps) if s.get('with',{}).get('name')=='gate-stage0')
  self.assertLess(gate,diag[0]);self.assertLess(diag[0],upload[0]);self.assertEqual(diag[1]['if'],'always()');self.assertEqual(upload[1]['if'],'always()');self.assertEqual(upload[1]['with']['path'],'security-results/gate-0-diagnostics');self.assertEqual(upload[1]['with']['retention-days'],7);self.assertEqual(upload[1]['with']['if-no-files-found'],'error')
if __name__=='__main__':unittest.main()
