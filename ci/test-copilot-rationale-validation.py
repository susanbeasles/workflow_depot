"""Malformed rationale metadata fails closed without suppressing any severity."""
import datetime,hashlib,json,os,pathlib,subprocess,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1];SCRIPT=ROOT/'security-assurance/.github/scripts/count_blocking.py'
class Validation(unittest.TestCase):
 def test_rejects_nonstring_reason_and_nonhex_digest(self):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t);repo=p/'repo';repo.mkdir()
   def git(*a):subprocess.run(['git','-C',str(repo),'-c','user.name=fixture','-c','user.email=fixture@example.invalid',*a],capture_output=True,check=True)
   git('init','-q','-b','main');(repo/'file').write_text('fixture');(repo/'.security').mkdir();entry={'rule':'R','path':'file','sha256':hashlib.sha256(b'fixture').hexdigest(),'reason':'fixture rationale','expires':(datetime.date.today()+datetime.timedelta(days=1)).isoformat()}
   for bad in [{'reason':None},{'reason':123},{'reason':{}},{'sha256':'g'*64},{'sha256':['a']*64}]:
    with self.subTest(bad=bad):
     (repo/'.security/accepted-findings.yml').write_text(json.dumps({'version':1,'accepted':[{**entry,**bad}]}));git('add','.');git('commit','-qm','fixture');git('update-ref','refs/remotes/origin/main','HEAD')
     f=p/'findings.json';f.write_text(json.dumps({'items':[{'rule':'R','path':'file','severity':'high'}]}));r=subprocess.run([sys.executable,str(SCRIPT),str(f)],env={**os.environ,'ACCEPTED_REPO':str(repo),'ACCEPTED_REF':'refs/remotes/origin/main'},capture_output=True,text=True);self.assertEqual(r.stdout.strip(),'ERR')
if __name__=='__main__':unittest.main()
