"""Execute actual cache action shell with synthetic roots and a fake YARA command."""
import json, os, pathlib, re, shutil, subprocess, tempfile, unittest
import yaml
ROOT=pathlib.Path(__file__).resolve().parents[1]
class CacheYaraFailures(unittest.TestCase):
 def run_action(self,exit_code=0,stderr='',stdout='',normalize_fail=False,empty_specs=False,oversize=False):
  with tempfile.TemporaryDirectory() as temp:
   base=pathlib.Path(temp);action=base/'actions/cache-content';action.mkdir(parents=True);scripts=base/'scripts';scripts.mkdir();bins=base/'bin';bins.mkdir();source=base/'synthetic-cache';source.mkdir();(source/'data').write_text('synthetic')
   if oversize:
    with open(source/'large', 'wb') as stream:stream.truncate(104857601)
   for name in ['cache_inspect.py','count_blocking.py','normalize.py']:shutil.copyfile(ROOT/'.github/scripts'/name,scripts/name)
   if normalize_fail:(scripts/'normalize.py').write_text('raise SystemExit(1)\n')
   (scripts/'result.py').write_text('import json,os,sys\njson.dump(sys.argv[1:],open(os.environ["STATUS_LOG"],"w"))\n')
   (bins/'yr').write_text('#!/usr/bin/env python3\nimport os,sys\nassert "--skip-larger=104857600" in sys.argv\nsys.stdout.write(os.environ["YARA_STDOUT"])\nsys.stderr.write(os.environ["YARA_STDERR"])\nraise SystemExit(int(os.environ["YARA_EXIT"]))\n');(bins/'yr').chmod(0o755)
   action_doc=yaml.safe_load((ROOT/'.github/actions/cache-content/action.yml').read_text());step=action_doc['runs']['steps'][-1];self.assertEqual(step['if'],'always()')
   values={'github.action_path':str(action),'steps.yr.outputs.version':'synthetic'}
   shell=re.sub(r'\$\{\{\s*([^}]+?)\s*\}\}',lambda m:values[m[1].strip()],step['run'])
   log=base/'status.json';env={**os.environ,'PATH':str(bins)+':'+os.environ['PATH'],'HOME':str(base),'RESULTS_DIR':str(base/'results'),'STATUS_LOG':str(log),'CACHE_SPECS':'' if empty_specs else str(source)+':generic','RULES_PATH':str(base/'rules'),'YARA_EXIT':str(exit_code),'YARA_STDERR':stderr,'YARA_STDOUT':stdout}
   done=subprocess.run(['bash','-c',shell],env=env,cwd=base,text=True,capture_output=True);self.assertEqual(done.returncode,0,done.stderr);args=json.loads(log.read_text());return args[args.index('--status')+1]
 def test_yara_failures_timeouts_and_diagnostics_are_tool_failure(self):
  for kwargs in [{'exit_code':2},{'exit_code':124},{'stderr':'warning: skipped file\n'},{'stdout':'warning: skipped file\n'},{'normalize_fail':True},{'empty_specs':True},{'oversize':True}]:
   with self.subTest(kwargs=kwargs):self.assertEqual(self.run_action(**kwargs),'TOOL_FAILURE')
 def test_actual_normalizer_preserves_clean_and_matching_results(self):
  self.assertEqual(self.run_action(),'PASS');self.assertEqual(self.run_action(stdout='mal_synthetic /synthetic/file\n'),'FAIL')
if __name__=='__main__':unittest.main()
