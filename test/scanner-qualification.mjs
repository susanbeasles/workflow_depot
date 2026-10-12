// Explicit local qualification command, not a conditional "pass" in the suite:
// node --test test/scanner-qualification.mjs
// Uses only generated synthetic files; never scans this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inventoryWorkspace,runScanner} from '../src/scan-adapters.mjs';
const depot=fileURLToPath(new URL('..',import.meta.url));
const toolRoot=process.env.SCANNER_QUALIFICATION_ROOT??'/tmp/workflow-depot-scanners';
const lock=JSON.parse(await readFile(new URL('../scanning/tool-lock.json',import.meta.url)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

for(const id of ['gitleaks','semgrep']) test(`real pinned ${id} accepts clean and rejects synthetic hidden findings despite source ignores`,async()=>{
  const root=await mkdtemp('/tmp/scanner-owned-fixture-');
  try{
    const executable=id==='gitleaks'?toolRoot+'/gitleaks/gitleaks':toolRoot+'/semgrep/bin/semgrep';
    const executableDigest=digest(await readFile(executable));
    assert.equal(executableDigest,lock[id].executableDigest);
    const spec={...lock[id],id,executable,rulesPath:depot+'/scanning/'+(id==='gitleaks'?'gitleaks.toml':'semgrep.yml'),...(id==='semgrep'?{runtimeRoot:toolRoot+'/semgrep/lib/python3.12/site-packages',interpreterPath:toolRoot+'/semgrep/bin/python'}:{})};
    await writeFile(root+'/.hidden.js','export const safe = 1;\n');
    const good=await runScanner(spec,{root,inventory:await inventoryWorkspace(root)});
    assert.equal(good.status,'passed');assert.deepEqual(good.coveredPaths,['.hidden.js']);
    await writeFile(root+'/.hidden.js',id==='gitleaks'?'const github_token = "ghp_'+'aB3cD4eF5gH6iJ7kL8mN9pQ0rS1tU2vW3xY4'+'"; // gitleaks:allow\n':'eval(input); // nosemgrep\n');
    await writeFile(root+'/.semgrepignore','*\n');await writeFile(root+'/.gitignore','*\n');
    const inventory=await inventoryWorkspace(root);
    // Preserve the full inventory digest. Only this trusted fixture specifies
    // these exact rule-language exclusions; applications cannot inject them.
    const exemptions=['.semgrepignore','.gitignore'].map(path=>({path,reason:'Non-JavaScript fixture metadata'}));
    await assert.rejects(runScanner(spec,{root,inventory,exemptions}),/SCANNER_FAILED/);
  }finally{await rm(root,{recursive:true,force:true});}
});
