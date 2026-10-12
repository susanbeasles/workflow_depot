import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';

const workflow = await readFile(new URL('../.github/workflows/orchestration.yml', import.meta.url), 'utf8').catch(()=>'');
function script(name) {
  const scripts=[...workflow.matchAll(/^([ ]*)node --input-type=module <<'JS'\n([\s\S]*?)^\1JS$/gm)].map(m=>m[2]);
  const result=scripts.find(s=>s.includes('// contract: '+name+'\n'));
  assert.ok(result, 'actual workflow inline contract exists: '+name);
  return result.replace(/await import\('([^']+)'\)/g, 'modules["$1"]');
}
async function run(name, overrides={}, files={}, calls=[]) {
  const outputs=[];
  const env={SOURCE_EVENT:'push',SOURCE_REF:'refs/heads/int/feature',SOURCE_SHA:'a'.repeat(40),CANDIDATE_SHA:'a'.repeat(40),SOURCE_REPOSITORY:'susanbeasles/app',SOURCE_OWNER_ID:'215839550',PACKAGE_MANAGER:'npm',SETUP_SCRIPT:'setup:ci',ENVIRONMENT_PATHS:'["node_modules"]',UNIT_SHARDS:'2',INTEGRATION_SHARDS:'1',E2E_SHARDS:'2',GITHUB_OUTPUT:'synthetic-output',CHECK:'unit',SHARD:'1',SHARDS:'2',...overrides};
  const modules={'node:path':{resolve,sep},'node:crypto':{createHash},'node:fs':{realpathSync:p=>files['realpath:'+p]??p,lstatSync:p=>({isDirectory:()=>files['directory:'+p]!==false}),appendFileSync:(p,s)=>outputs.push(s),readFileSync:p=>files[p]??JSON.stringify({scripts:{'setup:ci':'setup','test:ci':'test',lint:'lint',tsc:'tsc',build:'build'}})},'node:child_process':{execFileSync:(command,args,options)=>{calls.push({command,args,options});return '';}}};
  await vm.runInNewContext(`(async()=>{${script(name)}\n})()`,{process:{env},modules,console:{log(){}}},{timeout:1000});
  return {calls,outputs};
}

test('validates exact shadow source coordinates and constructs all required matrix shards',async()=>{
  const {outputs}=await run('validate');
  const matrix=JSON.parse(outputs.find(s=>s.startsWith('matrix=')).slice(7));
  assert.deepEqual(matrix.include.map(x=>x.check),['lint','tsc','build','unit','unit','integration','e2e','e2e']);
  assert.equal(matrix.include.at(-1).shard,2);
});
test('restores only bytes matching the setup job digest, without reading an app-controlled manifest',async()=>{
  const bytes=Buffer.from('synthetic archive bytes, no archive is created');
  const digest=createHash('sha256').update(bytes).digest('hex');
  const {calls}=await run('restore',{RUNNER_TEMP:'/synthetic',ENVIRONMENT_DIGEST:digest},{'/synthetic/ci-environment/environment.tar.gz':bytes});
  assert.deepEqual(Array.from(calls[0].args),['-xzf','/synthetic/ci-environment/environment.tar.gz','--no-same-owner','--no-same-permissions']);
  for(const value of [undefined,'',digest.slice(1),'f'.repeat(64)]) {
    const observed=[];
    await assert.rejects(run('restore',{RUNNER_TEMP:'/synthetic',ENVIRONMENT_DIGEST:value},{'/synthetic/ci-environment/environment.tar.gz':bytes},observed),/digest mismatch/);
    assert.equal(observed.length,0);
  }
  const observed=[];
  await assert.rejects(run('restore',{RUNNER_TEMP:'/synthetic',ENVIRONMENT_DIGEST:digest},{'/synthetic/ci-environment/environment.tar.gz':Buffer.from('changed')},observed),/digest mismatch/);
  assert.equal(observed.length,0);
});
test('archive reads only declared repo-owned directories and records actual bytes digest',async()=>{
  const bytes=Buffer.from('synthetic bytes');
  const {calls,outputs}=await run('archive',{GITHUB_WORKSPACE:'/repo',RUNNER_TEMP:'/synthetic'},{'/synthetic/environment.tar.gz':bytes});
  assert.equal(calls[0].command,'tar');assert.deepEqual(Array.from(calls[0].args),['-czf','/synthetic/environment.tar.gz','--','node_modules']);
  assert.equal(calls[0].options.cwd,'/repo');assert.equal(calls[0].options.shell,false);
  assert.equal(outputs[0],'digest='+createHash('sha256').update(bytes).digest('hex')+'\n');
  for(const files of [{'realpath:/repo/node_modules':'/outside/private'},{'directory:/repo/node_modules':false}]) {
    const observed=[];await assert.rejects(run('archive',{GITHUB_WORKSPACE:'/repo',RUNNER_TEMP:'/synthetic'},files,observed));assert.equal(observed.length,0);
  }
});
test('shadow sequence is a positive canonical safe integer matching source authority',async()=>{
  for(const sequence of ['abc','0','01','-1','9007199254740992']) await assert.rejects(run('validate',{SOURCE_REF:`refs/heads/promotion/${sequence}/shadow`}));
  await run('validate',{SOURCE_REF:'refs/heads/int/feature'});
});
test('all checks reuse the exact Node version selected by setup',()=>{
  assert.match(workflow,/node_version: \$\{\{ steps.node.outputs.node-version \}\}/);
  assert.match(workflow,/node-version: \$\{\{ needs.setup.outputs.node_version \}\}/);
});
test('rejects other refs/events/SHA, unsafe environment paths and unsupported package managers',async()=>{
  for(const bad of [{SOURCE_EVENT:'pull_request'},{SOURCE_REF:'refs/heads/main'},{SOURCE_REF:'refs/tags/int/feature'},{CANDIDATE_SHA:'b'.repeat(40)},{CANDIDATE_SHA:'main'},{SOURCE_OWNER_ID:'1'},{SOURCE_REPOSITORY:'other/app'},{PACKAGE_MANAGER:'pnpm'},{ENVIRONMENT_PATHS:'["../private"]'},{ENVIRONMENT_PATHS:'["."]'},{ENVIRONMENT_PATHS:'[".git"]'},{ENVIRONMENT_PATHS:'["/tmp"]'},{UNIT_SHARDS:'0'},{E2E_SHARDS:'17'}]) await assert.rejects(run('validate',bad));
});
test('npm and yarn use their actual argument forwarding syntax for every test suite',async()=>{
  for(const manager of ['npm','yarn']) for(const check of ['unit','integration','e2e']) {
    const {calls}=await run('payload',{PACKAGE_MANAGER:manager,CHECK:check});
    assert.equal(calls.length,1);assert.equal(calls[0].command,manager);
    assert.deepEqual(Array.from(calls[0].args),['run','test:ci',...(manager==='npm'?['--']:[]),'--suite',check,'--shard-index','1','--shard-count','2']);
    assert.equal(calls[0].options.shell,false);
  }
});
test('lint, tsc and build require app scripts and get no test shard flags',async()=>{
  for(const check of ['lint','tsc','build']) {
    const {calls}=await run('payload',{CHECK:check,SHARD:'1',SHARDS:'1'});
    assert.deepEqual(Array.from(calls[0].args),['run',check]);
  }
  await assert.rejects(run('payload',{}, {'package.json':'{"scripts":{}}'}));
  for(const bad of [{CHECK:'bash'},{SHARD:'0'},{SHARD:'3'},{SHARD:'1;echo bad'},{PACKAGE_MANAGER:'npm --prefix evil'}]) await assert.rejects(run('payload',bad));
});
test('setup executes only the declared app script without a shell',async()=>{
  for(const manager of ['npm','yarn']) {
    const {calls}=await run('setup',{PACKAGE_MANAGER:manager});
    assert.deepEqual(Array.from(calls[0].args),['run','setup:ci']);assert.equal(calls[0].command,manager);assert.equal(calls[0].options.shell,false);
  }
  await assert.rejects(run('setup',{SETUP_SCRIPT:'build;curl bad'}));
});
test('every missing or skipped required stage prevents the final result',async()=>{
  const stages={validate:{result:'success'},'source-admission':{result:'success'},setup:{result:'success'},checks:{result:'success'},'full-scans':{result:'success'},reviewer:{result:'success'}};
  await run('required',{STAGES:JSON.stringify(stages)});
  for(const name of Object.keys(stages)) for(const result of ['failure','skipped','cancelled']) await assert.rejects(run('required',{STAGES:JSON.stringify({...stages,[name]:{result}})}));
  delete stages.reviewer;await assert.rejects(run('required',{STAGES:JSON.stringify(stages)}));
});
test('native sequencing keeps reviewer separate and missing trusted components fail closed',async()=>{
  assert.match(workflow,/fail-fast: false/);assert.doesNotMatch(workflow,/continue-on-error: true|pull_request_target|secrets: inherit|contents: write/);
  assert.match(workflow,/needs: \[validate, source-admission, setup, checks, full-scans\]/);
  assert.match(workflow,/uses: \.\/\.github\/workflows\/review-candidate.yml/);
  assert.match(workflow,/ci-env-\$\{\{ github.repository_id \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ inputs.candidate_sha \}\}/);
  assert.match(workflow,/Candidate admission origin is not commissioned/);assert.match(workflow,/Trusted scanner depot revision is not commissioned/);
  const reviewer=await readFile(new URL('../.github/workflows/review-candidate.yml',import.meta.url),'utf8');
  assert.doesNotMatch(reviewer,/npm |yarn |environment_paths|ci-env-|secrets: inherit/);
  assert.match(reviewer,/repository: susanbeasles\/workflow_depot/);
  assert.match(reviewer,/ref: \$\{\{ env.REVIEWED_DEPOT_SHA \}\}/);
  assert.match(reviewer,/artifact-ids: \$\{\{ inputs.scan_artifact_id \}\}/);
  assert.match(reviewer,/run: node trusted-reviewer\/src\/candidate-review-cli.mjs/);
  const caller=await readFile(new URL('../templates/app-ci.yml',import.meta.url),'utf8');
  assert.match(caller,/@REVIEWED_DEPOT_SHA/);assert.match(caller,/candidate_sha: \$\{\{ github.sha \}\}/);
});
test('full scans run pinned depot adapters with verified app bytes and publish only success evidence',()=>{
  const block=workflow.slice(workflow.indexOf('\n  full-scans:'),workflow.indexOf('\n  reviewer:'));
  assert.match(block,/repository: susanbeasles\/workflow_depot/);
  assert.match(block,/ref: \$\{\{ env.REVIEWED_DEPOT_SHA \}\}/);
  assert.match(block,/run: node trusted-scanners\/scripts\/full-scans.mjs/);
  assert.match(block,/ENVIRONMENT_DIGEST: \$\{\{ needs.setup.outputs.environment_digest \}\}/);
  assert.match(block,/scan_report_digest: \$\{\{ steps.scan.outputs.scan_report_digest \}\}/);
  assert.match(block,/scan_artifact_id: \$\{\{ steps.report.outputs.artifact-id \}\}/);
  assert.match(block,/overwrite: false/);assert.doesNotMatch(block,/id-token: write|secrets[.:]|npm run|yarn run|if:.*always/);
  assert.match(block,/\/usr\/bin\/python3 trusted-scanners\/scripts\/restore-environment.py/);assert.doesNotMatch(block,/execFileSync\('tar'|tar -x/);
});
