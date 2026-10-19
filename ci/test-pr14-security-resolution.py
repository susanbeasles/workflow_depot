"""Offline regressions for preserving trust boundaries across PR14 reconciliation."""
from pathlib import Path
import json, os, re, shutil, subprocess, sys, tempfile, unittest
import yaml
ROOT=Path(__file__).resolve().parents[1]
PIN='24c54180a607b1449ed407dd24f251e4e9147c8d'
class Reconciliation(unittest.TestCase):
 def action(self):return yaml.safe_load((ROOT/'security-assurance/.github/actions/sast-codeql/action.yml').read_text())
 def test_local_evidence_and_phase_reporting(self):
  steps=self.action()['runs']['steps'];normalizer=steps[-1]
  self.assertEqual(normalizer['if'],"always() && inputs.phase == 'analyze'")
  self.assertFalse(any('upload-sarif@' in s.get('uses','') for s in steps))
  self.assertNotIn('steps.pre',yaml.safe_dump(self.action()))
  live=yaml.safe_load((ROOT/'.github/workflows/security-assurance.yml').read_text())
  self.assertNotIn('security-events',live['jobs']['codeql']['permissions'])
  self.assertNotIn('codeql_waive_languages',live['on' if 'on' in live else True]['workflow_call']['inputs'])
  self.assertEqual(live['env']['ACCEPTED_REPO'],'${{ github.workspace }}/src')
  self.assertEqual(live['env']['ACCEPTED_REF'],'refs/remotes/origin/${{ github.event.repository.default_branch }}')
 def test_codeql_failures_report_without_sarif_upload(self):
  normalizer=self.action()['runs']['steps'][-1]['run']
  for setup,analyze,language,expected in [('failure','skipped','javascript-typescript','POLICY_UNAVAILABLE'),('success','failure','javascript-typescript','TOOL_FAILURE'),('success','success','javascript-typescript','FAIL'),('success','success','swift','POLICY_UNAVAILABLE')]:
   with self.subTest(setup=setup,analyze=analyze),tempfile.TemporaryDirectory() as temp:
    root=Path(temp);action=root/'actions/sast-codeql';action.mkdir(parents=True);scripts=root/'scripts';scripts.mkdir()
    (scripts/'result.py').write_text('import sys,json,os\njson.dump(sys.argv[1:],open(os.environ["STATUS_LOG"],"w"))\n')
    shutil.copyfile(ROOT/'security-assurance/.github/scripts/count_blocking.py',scripts/'count_blocking.py')
    out=root/'runner/codeql-sarif';out.mkdir(parents=True)
    (out/'results.sarif').write_text(json.dumps({'runs':[{'tool':{'driver':{'semanticVersion':'test','rules':[{'id':'r','properties':{'security-severity':'8.5'}}]}},'results':[{'ruleId':'r','message':{'text':'synthetic'}}]}]}))
    values={'github.action_path':str(action),'inputs.language':language,'inputs.codeql_action_sha':PIN,'steps.setup.outcome':setup,'steps.analyze.outcome':analyze,'runner.temp':str(root/'runner')}
    source=re.sub(r'\$\{\{\s*([^}]+?)\s*\}\}',lambda m:values[m[1].strip()],normalizer)
    log=root/'status.json';env={'PATH':os.environ['PATH'],'RUNNER_TEMP':str(root/'runner'),'RESULTS_DIR':str(root/'results'),'STATUS_LOG':str(log)}
    done=subprocess.run(['bash','-c',source],capture_output=True,text=True,env=env);self.assertEqual(done.returncode,0,done.stderr)
    args=json.loads(log.read_text());self.assertEqual(args[args.index('--status')+1],expected)
 def test_swift_coverage_remains_present_but_unqualified(self):
  import importlib.util
  path=ROOT/'security-assurance/.github/scripts/codeql_isolated.py'
  spec=importlib.util.spec_from_file_location('qualified_codeql',path);helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
  self.assertIn('swift',helper.LANGUAGES)
  self.assertEqual(helper.canonical_language('swift'),'swift')
  with self.assertRaisesRegex(ValueError,'Swift CodeQL remains unqualified'):helper.require_qualified_language('swift')
 def test_staged_and_installed_pipeline_preserve_isolation(self):
  staged=(ROOT/'pipeline/pipeline.yml').read_bytes();self.assertEqual(staged,(ROOT/'.github/workflows/pipeline.yml').read_bytes())
  pipeline=yaml.safe_load(staged);candidate=pipeline['jobs']['build-candidate'];authority=pipeline['jobs']['build']
  self.assertEqual(candidate['permissions'],{'contents':'read'})
  self.assertEqual(authority['permissions'],{'contents':'read','id-token':'write','attestations':'write'})
  self.assertFalse(any('checkout@' in s.get('uses','') or 'setup-node@' in s.get('uses','') for s in authority['steps']))
  self.assertTrue(any('attest-build-provenance@' in s.get('uses','') for s in authority['steps']))
if __name__=='__main__':unittest.main()
