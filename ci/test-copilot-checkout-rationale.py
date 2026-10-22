"""Checkout obtains the default-branch object graph using the checkout action's own auth."""
import pathlib,unittest,yaml
ROOT=pathlib.Path(__file__).resolve().parents[1]
class Checkout(unittest.TestCase):
 def test_all_candidate_checkouts_obtain_default_branch_refs(self):
  for file in ['security-assurance/.github/workflows/security-assurance.yml','.github/workflows/security-assurance.yml']:
   workflow=yaml.safe_load((ROOT/file).read_text());found=0
   for job in workflow['jobs'].values():
    for step in job.get('steps',[]):
     if step.get('with',{}).get('path')=='src':
      found+=1;self.assertEqual(step['with']['fetch-depth'],0,file);self.assertFalse(step['with']['persist-credentials'])
   self.assertGreater(found,0)
if __name__=='__main__':unittest.main()
