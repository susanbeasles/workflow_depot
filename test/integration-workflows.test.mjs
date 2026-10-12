import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('repository validation runs only on fixed integration push and pins exact candidate checkout',async()=>{
 const text=await readFile(new URL('../.github/workflows/build.yml',import.meta.url),'utf8').catch(()=> '');
 assert.match(text,/branches: \['int\/\*\*'\]/);assert.doesNotMatch(text,/pull_request:|workflow_dispatch:|branches: \[main\]/);
 assert.match(text,/needs: \[admission\]/);assert.match(text,/ref: \$\{\{ github.sha \}\}/);assert.match(text,/admit-integration.yml@[a-f0-9]{40}/);
});
