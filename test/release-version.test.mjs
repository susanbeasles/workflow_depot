import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nextVersion,classifyCommit,latestTag,parseTag} from '../ci/release/next-version.mjs';
import {computeVersion} from '../ci/release/compute-version.mjs';

const c=(subject,body='')=>({subject,body});

test('conventional commits map to semver bumps',()=>{
 assert.equal(classifyCommit(c('feat: add export')),'minor');
 assert.equal(classifyCommit(c('feat(api): add export')),'minor');
 assert.equal(classifyCommit(c('FIX: casing is ignored for types')),'patch');
 assert.equal(classifyCommit(c('perf(db): faster query')),'patch');
 assert.equal(classifyCommit(c('feat!: drop v1 API')),'major');
 assert.equal(classifyCommit(c('refactor(core)!: rename')),'major');
 assert.equal(classifyCommit(c('fix: patch','details\n\nBREAKING CHANGE: config renamed')),'major');
 assert.equal(classifyCommit(c('fix: patch','BREAKING-CHANGE: also accepted')),'major');
 assert.equal(classifyCommit(c('fix: patch','mentions breaking change: in prose only')),'patch');
 for(const subject of ['chore: deps','docs: readme','ci: pin','Merge pull request #5 from x/y','feat:missing space','feat add','featx: nope','revert: feat: x'])assert.equal(classifyCommit(c(subject)),null,subject);
});

test('next version takes the highest bump since the last tag',()=>{
 assert.deepEqual(nextVersion('v1.2.3',[c('fix: a'),c('feat: b'),c('chore: c')]),{released:true,version:'v1.3.0',bump:'minor'});
 assert.deepEqual(nextVersion('v1.2.3',[c('fix: a')]),{released:true,version:'v1.2.4',bump:'patch'});
 assert.deepEqual(nextVersion('v1.2.3',[c('feat: a'),c('fix!: b')]),{released:true,version:'v2.0.0',bump:'major'});
 assert.deepEqual(nextVersion(null,[c('feat: first')]),{released:true,version:'v0.1.0',bump:'minor'});
 assert.deepEqual(nextVersion(null,[c('fix: first')]),{released:true,version:'v0.0.1',bump:'patch'});
 assert.deepEqual(nextVersion('v1.2.3',[c('chore: a'),c('docs: b')]),{released:false,version:null,bump:null});
 assert.deepEqual(nextVersion('v1.2.3',[]),{released:false,version:null,bump:null});
 assert.throws(()=>nextVersion('v1.2',[c('fix: a')]),/Last tag/);
 assert.throws(()=>nextVersion('v1.2.3',[{subject:1}]),/strings/);
});

test('latest tag ignores non-semver and prerelease tags',()=>{
 assert.equal(latestTag(['v1.2.3','v1.10.0','v1.9.9','v2.0.0-rc.1','release-3','v01.0.0','v1.10.0x']),'v1.10.0');
 assert.equal(latestTag(['nightly']),null);
 assert.deepEqual(parseTag('v0.0.0'),[0,0,0]);
 assert.equal(parseTag('v1.2.3-rc.1'),null);
});

function repo(){
 const dir=mkdtempSync(join(tmpdir(),'release-git-'));
 const env={PATH:process.env.PATH,HOME:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(dir,'.gitconfig-empty'),GIT_AUTHOR_NAME:'Release Test',GIT_AUTHOR_EMAIL:'release-test@example.invalid',GIT_COMMITTER_NAME:'Release Test',GIT_COMMITTER_EMAIL:'release-test@example.invalid'};
 writeFileSync(env.GIT_CONFIG_GLOBAL,'');
 const git=(...args)=>{const r=spawnSync('git',['-C',join(dir,'w'),...args],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 spawnSync('git',['init','-q','-b','main',join(dir,'w')],{env});
 let n=0;
 const commit=(subject,body='')=>{writeFileSync(join(dir,'w',`f${n++}`),subject);git('add','-A');git('commit','-q','-m',subject,...(body?['-m',body]:[]));return git('rev-parse','HEAD');};
 return {path:join(dir,'w'),git,commit,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('compute-version reads git history for main pushes and verifies tag pushes',()=>{
 const r=repo();
 try{
  r.commit('chore: init');
  let sha=r.commit('feat: first feature');
  assert.deepEqual(computeVersion({repo:r.path,sha,ref:'refs/heads/main',event:'push'}),{schema:'release-version/v1',released:true,releaseTag:'v0.1.0',mode:'main',lastTag:null,bump:'minor'});
  r.git('tag','v0.1.0',sha);
  assert.equal(computeVersion({repo:r.path,sha,ref:'refs/heads/main',event:'push'}).released,false);
  sha=r.commit('docs: words');
  assert.equal(computeVersion({repo:r.path,sha,ref:'refs/heads/main',event:'push'}).released,false);
  r.commit('fix: bug');
  sha=r.commit('refactor: internals','BREAKING CHANGE: removes the old flag');
  const result=computeVersion({repo:r.path,sha,ref:'refs/heads/main',event:'push'});
  assert.equal(result.releaseTag,'v1.0.0');assert.equal(result.lastTag,'v0.1.0');
  r.git('tag','-a','v1.0.0','-m','v1.0.0',sha);
  assert.deepEqual(computeVersion({repo:r.path,sha,ref:'refs/tags/v1.0.0',event:'push'}).releaseTag,'v1.0.0');
  const next=r.commit('fix: later');
  assert.throws(()=>computeVersion({repo:r.path,sha:next,ref:'refs/tags/v1.0.0',event:'push'}),/does not point at the source commit/);
  r.git('tag','v1.0.1',r.commit('chore: unrelated'));
  const fixSha=r.git('rev-parse','HEAD~1');
  assert.throws(()=>computeVersion({repo:r.path,sha:fixSha,ref:'refs/heads/main',event:'push'}),/already exists/);
  assert.throws(()=>computeVersion({repo:r.path,sha,ref:'refs/heads/feature',event:'push'}),/refs\/heads\/main/);
  assert.throws(()=>computeVersion({repo:r.path,sha,ref:'refs/heads/main',event:'workflow_dispatch'}),/push/);
  assert.throws(()=>computeVersion({repo:r.path,sha,ref:'refs/tags/v1.0.0-rc.1',event:'push'}),/vMAJOR/);
  assert.throws(()=>computeVersion({repo:r.path,sha:'f'.repeat(40),ref:'refs/heads/main',event:'push'}),/not present/);
 }finally{r.cleanup();}
});
