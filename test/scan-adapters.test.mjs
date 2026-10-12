import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const api=await import('../src/scan-adapters.mjs').catch(()=>({}));
import {scanCandidate} from '../scripts/full-scans.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixture=async fn=>{const root=await mkdtemp(join(tmpdir(),'scanner-fixture-'));try{return await fn(root);}finally{await rm(root,{recursive:true,force:true});}};

test('scanner adapter exports executable and inventory contracts',()=>{
  for(const name of ['runBounded','inventoryWorkspace','verifyNpmDependencies','runScanner','requireAllCategories']) assert.equal(typeof api[name],'function');
});
test('bounded subprocess denies missing tools, output overflow and timeouts without leaking output',async()=>{
  assert.equal(typeof api.runBounded,'function');
  const result=await api.runBounded(process.execPath,['-e','process.stdout.write("safe")'],{timeoutMs:1000,maxBytes:100});
  assert.equal(result.stdout,'safe');assert.equal(result.code,0);
  for(const [exe,args,options] of [['/missing-tool',[],{}],[process.execPath,['-e','process.stdout.write("private".repeat(10000))'],{maxBytes:50}],[process.execPath,['-e','setTimeout(()=>{},10000)'],{timeoutMs:30}]]) {
    await assert.rejects(api.runBounded(exe,args,options),error=>/SCANNER_(UNAVAILABLE|OUTPUT_LIMIT|TIMEOUT)/.test(error.message)&&!error.message.includes('private'));
  }
});
test('inventory includes hidden/cache/binary artifacts and rejects symlink escapes and truncation',async()=>fixture(async root=>{
  assert.equal(typeof api.inventoryWorkspace,'function');
  await mkdir(join(root,'.cache'));await writeFile(join(root,'.cache','input.bin'),Buffer.from([0,1,2]));await writeFile(join(root,'source.js'),'const x=1;');
  const inventory=await api.inventoryWorkspace(root);
  assert.deepEqual(inventory.entries.map(x=>x.path),['.cache/input.bin','source.js']);assert.match(inventory.digest,/^[a-f0-9]{64}$/);
  await writeFile(join(root,'.cache','input.bin'),Buffer.from([0,1,3]));assert.notEqual((await api.inventoryWorkspace(root)).digest,inventory.digest);
  await assert.rejects(api.inventoryWorkspace(root,{maxFiles:1}),/INVENTORY_LIMIT/);
  await symlink('/outside',join(root,'escape'));await assert.rejects(api.inventoryWorkspace(root),/INVENTORY_SYMLINK/);
}));
test('npm integrity checks lockfile version, cache archive integrity and every installed file hash',async()=>fixture(async root=>{
  assert.equal(typeof api.verifyNpmDependencies,'function');
  await mkdir(join(root,'node_modules','example'),{recursive:true});await mkdir(join(root,'.cache'));
  const archive=Buffer.from('synthetic package archive bytes');const integrity='sha512-'+createHash('sha512').update(archive).digest('base64');
  await writeFile(join(root,'.cache','example.tgz'),archive);await writeFile(join(root,'node_modules','example','package.json'),JSON.stringify({name:'example',version:'1.0.0'}));
  await writeFile(join(root,'node_modules','example','index.js'),'export default 1;');
  const lock=JSON.stringify({lockfileVersion:3,packages:{'':{name:'synthetic'},'node_modules/example':{version:'1.0.0',integrity,resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz'}}});
  await writeFile(join(root,'package-lock.json'),lock);
  const tree=await api.inventoryWorkspace(join(root,'node_modules','example'));
  const policy={lockfileDigest:hash(lock),dependencies:[{path:'node_modules/example',version:'1.0.0',integrity,archivePath:'.cache/example.tgz',treeDigest:tree.digest}]};
  const good=await api.verifyNpmDependencies(root,policy);assert.equal(good.dependencies,1);
  await writeFile(join(root,'node_modules','example','index.js'),'tampered');await assert.rejects(api.verifyNpmDependencies(root,policy),/DEPENDENCY_TREE/);
  await writeFile(join(root,'node_modules','example','index.js'),'export default 1;');await writeFile(join(root,'.cache','example.tgz'),'changed');await assert.rejects(api.verifyNpmDependencies(root,policy),/DEPENDENCY_ARCHIVE/);
}));
test('unknown required scanners and missing categories never become a successful full report',()=>{
  assert.equal(typeof api.requireAllCategories,'function');
  assert.throws(()=>api.requireAllCategories(['sast','sonarqube'],[{category:'sast',status:'passed'}]),/SCANNER_UNAVAILABLE/);
  assert.throws(()=>api.requireAllCategories(['sast'],[{category:'sast',status:'failed'}]),/SCANNER_UNAVAILABLE/);
});
test('unqualified full-scan policy denies before reading application files or creating reports',async()=>{
  await assert.rejects(scanCandidate({root:'/not-an-application',source:{},candidate:{policyDigest:'a'.repeat(64)},environmentDigest:'b'.repeat(64),policy:{qualified:false},toolLock:{}}),/SCANNER_UNAVAILABLE/);
});
test('recognized adapters pin bytes/version/rules and reject findings/errors/coverage gaps',async()=>fixture(async root=>{
  assert.equal(typeof api.runScanner,'function');
  const source=join(root,'source');await mkdir(source);await writeFile(join(source,'app.js'),'safe();');
  const executable=join(root,'trusted-tool'),rules=join(root,'trusted-rules');await writeFile(executable,'synthetic');await writeFile(rules,'trusted');
  const inventory={entries:[{path:'app.js',type:'file',sha256:hash('safe();'),size:7}]};inventory.digest=hash(api.canonical(inventory.entries));
  const runtimeRoot=join(root,'runtime');await mkdir(runtimeRoot);await writeFile(join(runtimeRoot,'core'),'synthetic engine');
  const spec={id:'semgrep',version:'1.180.0',executable,executableDigest:hash('synthetic'),rulesPath:rules,rulesetDigest:hash('trusted'),runtimeRoot,runtimeDigest:(await api.inventoryWorkspace(runtimeRoot)).digest,interpreterPath:executable,interpreterDigest:hash('synthetic')};
  const calls=[];const clean=async(exe,args,options)=>{calls.push({exe,args,options});return args.includes('--version')?{code:0,stdout:'1.180.0\n',stderr:''}:{code:0,stdout:JSON.stringify({version:'1.180.0',results:[],errors:[],paths:{scanned:['app.js']}}),stderr:''};};
  const result=await api.runScanner(spec,{root:source,inventory,execute:clean});assert.equal(result.status,'passed');assert.deepEqual(result.coveredPaths,['app.js']);
  assert.ok(calls[1].args.includes('--metrics=off'));assert.ok(calls[1].args.includes('--disable-nosem'));assert.ok(calls[1].args.includes('--x-ignore-semgrepignore-files'));assert.ok(!calls[1].args.includes('auto'));
  for(const report of [{results:[{extra:{lines:'private'}}],errors:[],paths:{scanned:['app.js']}},{results:[],errors:[{message:'private'}],paths:{scanned:['app.js']}},{results:[],errors:[],paths:{scanned:[]}}]) {
    await assert.rejects(api.runScanner(spec,{root:source,inventory,execute:async(exe,args)=>args.includes('--version')?{code:0,stdout:'1.180.0'}:{code:0,stdout:JSON.stringify({version:'1.180.0',...report})}}),e=>/SCANNER_/.test(e.message)&&!e.message.includes('private'));
  }
  await assert.rejects(api.runScanner({...spec,executableDigest:'b'.repeat(64)},{root:source,inventory,execute:clean}),/SCANNER_PIN/);
  await assert.rejects(api.runScanner({...spec,id:'unknown'},{root:source,inventory,execute:clean}),/SCANNER_UNAVAILABLE/);
  await writeFile(join(runtimeRoot,'core'),'replaced');await assert.rejects(api.runScanner(spec,{root:source,inventory,execute:clean}),/SCANNER_RUNTIME_PIN/);
}));
test('filtered stale inventories, changed bytes and unsupported binary formats cannot claim scanned coverage',async()=>fixture(async root=>{
  assert.equal(typeof api.runScanner,'function');const source=join(root,'source');await mkdir(source);await writeFile(join(source,'app.js'),'safe');await writeFile(join(source,'artifact.bin'),Buffer.from([0,1]));
  const inventory=await api.inventoryWorkspace(source);
  const executable=join(root,'gitleaks'),rules=join(root,'rules');await writeFile(executable,'trusted');await writeFile(rules,'trusted');
  const spec={id:'gitleaks',version:'8.30.1',executable,executableDigest:hash('trusted'),rulesPath:rules,rulesetDigest:hash('trusted')};
  let calls=0;const execute=async()=>{calls++;return {code:0,stdout:'[]'};};
  await assert.rejects(api.runScanner(spec,{root:source,inventory:{...inventory,entries:inventory.entries.slice(1)},execute}),/SCANNER_INVENTORY/);
  await assert.rejects(api.runScanner(spec,{root:source,inventory,execute}),/SCANNER_FORMAT_UNSUPPORTED/);
  assert.equal(calls,0);
  await writeFile(join(source,'app.js'),'changed');await assert.rejects(api.runScanner(spec,{root:source,inventory,execute,exemptions:[{path:'artifact.bin',reason:'Synthetic text-only qualification'}]}),/SCANNER_INVENTORY_CHANGED/);assert.equal(calls,0);
}));
