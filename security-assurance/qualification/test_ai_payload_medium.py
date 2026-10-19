"""Synthetic payload scrubbing tests; no scanners, credentials or network services."""
import contextlib,importlib.util,io,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('ai_payload',ROOT/'.github/scripts/ai_review_call.py');M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)
class Payload(unittest.TestCase):
 def invoke(self,message,scanner_rc=0):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);(p/'diff').write_text('ordinary change');(p/'results').mkdir();(p/'results/control.json').write_text(json.dumps({'control_id':'X','status':'FAIL','findings':{'items':[{'severity':'high','message':message}]}}))
   argv=['review','--diff',str(p/'diff'),'--results',str(p/'results'),'--out',str(p/'out'),'--model','fixture','--endpoint','https://api.anthropic.com/v1/messages','--receipt',str(p/'receipt'),'--approval','fixture-only']
   seen=[];requests=[]
   def scanner(cmd,**kw):
    seen.append(kw['input']);return subprocess.CompletedProcess(cmd,2 if b'ONLY_IN_EVIDENCE_FIXTURE' in kw['input'] else scanner_rc)
   class Reply(io.BytesIO):pass
   def request(req):requests.append(req);return Reply(b'{"content":[{"type":"text","text":"{\\"findings\\":[]}"}]}')
   with patch.object(sys,'argv',argv),patch.object(M.subprocess,'run',side_effect=scanner),patch.object(M,'send_request',side_effect=request),patch.dict(os.environ,{'ANTHROPIC_API_KEY':'synthetic-test-only'},clear=True),contextlib.redirect_stdout(io.StringIO()):
    try:M.main();rc=0
    except SystemExit as e:rc=e.code
   return rc,seen,requests,json.loads((p/'receipt').read_text())
 def test_secret_only_in_scanner_evidence_blocks_before_any_request(self):
  rc,seen,sent,receipt=self.invoke('ONLY_IN_EVIDENCE_FIXTURE');self.assertNotEqual(rc,0);self.assertFalse(sent);self.assertTrue(any(b'ONLY_IN_EVIDENCE_FIXTURE' in b for b in seen));self.assertEqual(receipt['status'],'blocked')
 def test_the_exact_serialized_transmitted_body_was_scrubbed(self):
  rc,seen,sent,receipt=self.invoke('ordinary finding');self.assertEqual(rc,0);self.assertEqual(len(sent),1);self.assertIn(sent[0].data,seen);self.assertEqual(receipt['payload_bytes'],len(sent[0].data))
 def test_scrubber_failure_blocks_even_with_clean_diff(self):
  rc,seen,sent,receipt=self.invoke('ordinary finding',1);self.assertNotEqual(rc,0);self.assertFalse(sent);self.assertEqual(receipt['status'],'blocked')
 def test_phi_only_in_evidence_blocks(self):
  rc,seen,sent,receipt=self.invoke('MRN: SYNTHETIC123');self.assertNotEqual(rc,0);self.assertFalse(sent)
if __name__=='__main__':unittest.main()
