import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('repository validation runs only on fixed integration push and pins exact candidate checkout',async()=>{
 const text=await readFile(new URL('../.github/workflows/build.yml',import.meta.url),'utf8').catch(()=> '');
 assert.match(text,/branches: \['int\/\*\*'\]/);assert.doesNotMatch(text,/pull_request:|workflow_dispatch:|branches: \[main\]/);
 assert.match(text,/validate-workflow_depot.yml@[a-f0-9]{40}/);assert.doesNotMatch(text,/runs-on:|steps:|run:/);
 const reusable=await readFile(new URL('../.github/workflows/validate-workflow_depot.yml',import.meta.url),'utf8');
 assert.match(reusable,/needs: \[admission\]/);assert.match(reusable,/ref: \$\{\{ github.sha \}\}/);assert.match(reusable,/admit-integration.yml@[a-f0-9]{40}/);
});
