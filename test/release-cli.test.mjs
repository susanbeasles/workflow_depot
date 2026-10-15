import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs,writeGithubOutput} from '../ci/release/io.mjs';
import {makeApp} from './release-fixtures.mjs';

const scripts=fileURLToPath(new URL('../ci/release/',import.meta.url));
const DEPOT_SHA='89abcdef0123456789abcdef0123456789abcdef';

test('argument parser and step outputs fail closed',()=>{
 assert.deepEqual(parseArgs(['--a','1','--m','x','--m','y'],{a:{required:true},m:{multiple:true},d:{default:'z'}}),{a:'1',m:['x','y'],d:'z'});
 assert.throws(()=>parseArgs(['--a','1','--a','2'],{a:{}}),/Duplicate/);
 assert.throws(()=>parseArgs(['--b','1'],{a:{}}),/Unknown argument/);
 assert.throws(()=>parseArgs(['--a'],{a:{}}),/Missing value/);
 assert.throws(()=>parseArgs([],{a:{required:true}}),/Missing required/);
 assert.throws(()=>parseArgs(['--a','bad value'],{a:{pattern:/^\w+$/}}),/Invalid value/);
 const f=makeApp();
 try{
  const out=join(f.root,'out.txt');writeFileSync(out,'');
  writeGithubOutput(out,{manifest_sha256:'a'.repeat(64),released:'true'});
  assert.equal(readFileSync(out,'utf8'),`manifest_sha256=${'a'.repeat(64)}\nreleased=true\n`);
  assert.throws(()=>writeGithubOutput(out,{x:'a\nevil=1'}),/Unsafe/);
  assert.throws(()=>writeGithubOutput(out,{'X-Y':'1'}),/Unsafe/);
 }finally{f.cleanup();}
});

test('release scripts run end to end as CLIs with argv arrays and GITHUB_OUTPUT',()=>{
 const f=makeApp();
 try{
  const gitEnv={PATH:process.env.PATH,HOME:f.root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(f.root,'gitconfig'),GIT_AUTHOR_NAME:'Release Test',GIT_AUTHOR_EMAIL:'release-test@example.invalid',GIT_COMMITTER_NAME:'Release Test',GIT_COMMITTER_EMAIL:'release-test@example.invalid'};
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL,'');
  for(const args of [['init','-q','-b','main'],['add','-A'],['commit','-q','-m','feat: first release']])assert.equal(spawnSync('git',['-C',f.app,...args],{env:gitEnv}).status,0);
  const sha=spawnSync('git',['-C',f.app,'rev-parse','HEAD'],{env:gitEnv,encoding:'utf8'}).stdout.trim();
  const output=join(f.root,'github-output');writeFileSync(output,'');
  const env={PATH:process.env.PATH,HOME:f.root,GITHUB_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:'example-owner/demo-app',GITHUB_REPOSITORY_ID:'4242',GITHUB_RUN_ID:'555',GITHUB_RUN_ATTEMPT:'1'};
  const run=(script,...args)=>{
   const r=spawnSync(process.execPath,[join(scripts,script),...args],{env,encoding:'utf8',shell:false});
   assert.equal(r.status,0,`${script}: ${r.stderr}`);
   return r.stdout;
  };
  const state=join(f.root,'cli-state'),out=join(f.root,'cli-out'),application=join(state,'application.json'),context=join(state,'context.json');
  run('compute-version.mjs','--repo',f.app,'--out',join(state,'version.json'),'--github-output',output);
  run('resolve-context.mjs','--release-tag','v0.1.0','--out',context,'--github-output',output);
  run('read-application.mjs','--app-root',f.app,'--context',context,'--out',application,'--github-output',output);
  run('build-worker-bundle.mjs','plan','--app-root',f.app,'--application',application,'--target','demoapp-worker','--github-output',output);
  run('build-worker-bundle.mjs','bundle','--app-root',f.app,'--application',application,'--target','demoapp-worker','--wrangler-outdir',f.wranglerOut,'--out-dir',out,'--release-tag','v0.1.0','--source-commit',sha,'--github-output',output);
  run('bundle-migrations.mjs','--app-root',f.app,'--application',application,'--target','demoapp-d1-migrations','--out-dir',out,'--github-output',output);
  run('write-authorization-policy.mjs','--application',application,'--context',context,'--depot-repository','example-owner/workflow_depot','--depot-sha',DEPOT_SHA,'--source-date-epoch','1791000000','--out-dir',out);
  run('unpack-targets.mjs','--release-dir',out,'--out',join(f.root,'payload'));
  writeFileSync(join(out,'sbom.cdx.json'),'{"bomFormat":"CycloneDX"}');writeFileSync(join(out,'sbom.spdx.json'),'{"spdxVersion":"SPDX-2.3"}');
  run('checksum-bundles.mjs','--release-dir',out);
  run('assemble-release.mjs','--release-dir',out,'--github-output',output);
  run('write-release-manifest.mjs','--release-dir',out,'--application',application,'--context',context,'--depot-repository','example-owner/workflow_depot','--depot-sha',DEPOT_SHA,'--created-at','2026-10-15T00:00:00Z','--github-output',output);
  assert.match(run('verify-release.mjs','--release-dir',out,'--application',application,'--github-output',output),/^verified demoapp v0\.1\.0 \(unsigned\)/);
  const outputs=Object.fromEntries(readFileSync(output,'utf8').trim().split('\n').map(line=>line.split(/=(.*)/s).slice(0,2)));
  assert.equal(outputs.released,'true');assert.equal(outputs.release_tag,'v0.1.0');assert.equal(outputs.worker_target,'demoapp-worker');
  assert.equal(outputs.builder_workflow,`example-owner/workflow_depot/.github/workflows/release.yml@${DEPOT_SHA}`);
  assert.equal(outputs.manifest_sha256,spawnSync('sha256sum',[join(out,'release.meta.json')],{encoding:'utf8'}).stdout.slice(0,64));
  const failed=spawnSync(process.execPath,[join(scripts,'verify-release.mjs'),'--release-dir',out,'--stage','signed'],{env,encoding:'utf8'});
  assert.equal(failed.status,1);assert.match(failed.stderr,/^error: release directory inventory mismatch/);
  const injected=spawnSync(process.execPath,[join(scripts,'resolve-context.mjs'),'--release-tag','v1.0.0;id','--out',join(f.root,'x.json')],{env,encoding:'utf8'});
  assert.equal(injected.status,1);
 }finally{f.cleanup();}
});
