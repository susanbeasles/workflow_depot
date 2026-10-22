import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {inventory,manifest} from '../ci/build-manifest.mjs';
test('build manifest binds exact candidate and hashes artifact bytes including private maps',()=>{const p=mkdtempSync(join(tmpdir(),'build-'));try{
 assert.throws(()=>inventory(p),/empty/);writeFileSync(join(p,'app.js'),'code');writeFileSync(join(p,'app.js.map'),'private source');
 const env={GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/int/x',GITHUB_SHA:'b'.repeat(40),GITHUB_REPOSITORY:'o/r',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'2'};
 const a=manifest(p,env);assert.equal(a.files.length,2);assert.equal(a.sourceSha,env.GITHUB_SHA);writeFileSync(join(p,'app.js'),'changed');assert.notEqual(manifest(p,env).files[0].sha256,a.files[0].sha256);
 symlinkSync('/etc/passwd',join(p,'escape'));assert.throws(()=>inventory(p),/links/);
 }finally{rmSync(p,{recursive:true,force:true});}});

test('inventory rejects aggregate budgets during metadata preflight',()=>{const p=mkdtempSync(join(tmpdir(),'budget-'));try{writeFileSync(join(p,'a'),'1234');writeFileSync(join(p,'b'),'5678');for(const limits of [{maxFiles:1},{maxEntries:1},{maxFileBytes:3},{maxTotalBytes:7}])assert.throws(()=>inventory(p,limits),/budget/);}finally{rmSync(p,{recursive:true,force:true});}});
