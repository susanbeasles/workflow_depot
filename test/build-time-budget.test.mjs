import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inventory} from '../ci/build-manifest.mjs';
test('producer rejects elapsed resource budget while preserving byte inventory',()=>{
 const root=mkdtempSync(join(tmpdir(),'build-time-budget-'));
 try {writeFileSync(join(root,'one'),'1234');let tick=0;
  assert.throws(()=>inventory(root,{maxMilliseconds:1,clock:()=>tick+=2}),/time budget/);
  assert.equal(inventory(root).length,1);
 } finally {rmSync(root,{recursive:true,force:true});}
});
