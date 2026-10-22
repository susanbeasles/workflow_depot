"""Offline regressions for Medium/High controls already repaired in the preserved candidate."""
import importlib.util,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import yaml
ROOT=Path(__file__).resolve().parents[1]
class Authority(unittest.TestCase):
 def test_required_codeql_build_failure_cannot_produce_pass(self):
  script=ROOT/'.github/scripts/codeql_isolated.py';spec=importlib.util.spec_from_file_location('required_build',script);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  with tempfile.TemporaryDirectory() as temp:
   p=Path(temp);cli=p/'codeql';cli.write_text('synthetic executable placeholder')
   args=['codeql-isolated','extract','--codeql',str(cli),'--language','cpp','--source',str(p),'--database',str(p/'database'),'--output',str(p/'out.sarif'),'--requires-build','true']
   with patch.object(sys,'argv',args),patch.dict(os.environ,{'CODEQL_BUILD_COMMAND':'synthetic-required-build','RUNNER_TEMP':temp}),patch.object(module.subprocess,'run',return_value=subprocess.CompletedProcess([],1)):
    with self.assertRaisesRegex(RuntimeError,'CodeQL extract failed'):module.main()
   self.assertFalse((p/'database').exists());self.assertFalse((p/'out.sarif').exists())
 def test_pull_request_qualification_has_no_privileged_execution_path(self):
  workflow=yaml.safe_load((ROOT/'.github/workflows/scanner-qualification.yml').read_text());job=workflow['jobs']['dogfood'];condition=job['if']
  self.assertIn("github.ref == 'refs/heads/main'",condition);self.assertIn("github.event_name == 'push'",condition);self.assertIn("github.event_name == 'schedule'",condition);self.assertNotIn("pull_request",condition)
  self.assertEqual(workflow['jobs']['unit']['permissions'],{'contents':'read'});self.assertEqual(job['with']['depot_ref'],'${{ github.sha }}')
if __name__=='__main__':unittest.main()
