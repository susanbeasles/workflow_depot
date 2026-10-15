import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,symlinkSync,rmSync,mkdirSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {stripJsonc,parseJsonc} from '../ci/release/jsonc.mjs';
import {buildWorkerBundle,wranglerToMetadata,planTarget} from '../ci/release/build-worker-bundle.mjs';
import {bundleMigrations,countStatements,parseMigrationHeader} from '../ci/release/bundle-migrations.mjs';
import {readApplication} from '../ci/release/read-application.mjs';
import {resolveContext} from '../ci/release/resolve-context.mjs';
import {unpackTargets} from '../ci/release/unpack-targets.mjs';
import {readZip} from '../ci/release/zip.mjs';
import {parseJson} from '../src/shared/release-contract.mjs';
import {makeApp,application,context,write,WRANGLER,SOURCE_COMMIT} from './release-fixtures.mjs';

const worker=(f,overrides={})=>buildWorkerBundle({appRoot:f.app,application:application(),targetId:'demoapp-worker',wranglerOutdir:f.wranglerOut,outDir:f.out,releaseTag:'v1.2.3',sourceCommit:SOURCE_COMMIT,...overrides});
const artifactOf=path=>parseJson(readZip(new Uint8Array(readFileSync(path))).find(e=>e.name==='artifact.json').data,{maxBytes:16*1024*1024});

test('JSONC stripping respects strings, removes comments and trailing commas',()=>{
 assert.deepEqual(parseJsonc(new TextEncoder().encode('{"url":"https://a.invalid//x/*y*/", // c\n "b":[1,2,],/* z */}')),{url:'https://a.invalid//x/*y*/',b:[1,2]});
 assert.equal(stripJsonc('{"a":"\\"//"}'),'{"a":"\\"//"}');
 assert.throws(()=>stripJsonc('{"a":1 /* open'),/unterminated block comment/);
 assert.throws(()=>stripJsonc('{"a":"open'),/unterminated string/);
 assert.throws(()=>parseJsonc(new TextEncoder().encode('{"a":1,"a":2}')),/duplicate key/);
});

test('worker bundle content: bindings, marker, assets and write-once output',async()=>{
 const f=makeApp();
 try{
  await worker(f);
  const entries=readZip(new Uint8Array(readFileSync(join(f.out,'targets/worker.zip'))));
  assert.deepEqual(entries.map(e=>e.name),['artifact.json','assets/.well-known/security.txt','assets/assets/app-abc123.js','assets/index.html']);
  const a=artifactOf(join(f.out,'targets/worker.zip'));
  const byName=Object.fromEntries(a.metadata.bindings.map(b=>[b.name,b]));
  assert.deepEqual(byName.DB,{name:'DB',type:'d1',database_id:'00000000-0000-0000-0000-000000000000'});
  assert.deepEqual(byName.COORDINATOR,{name:'COORDINATOR',type:'durable_object_namespace',class_name:'Coordinator'});
  assert.deepEqual(byName.JOBS,{name:'JOBS',type:'queue',queue_name:'demo-staging'});
  assert.deepEqual(byName.CONTROL_AUTHORITY,{name:'CONTROL_AUTHORITY',type:'service',service:'control-plane',entrypoint:'DemoAuthority'});
  assert.deepEqual(byName.ASSETS,{name:'ASSETS',type:'assets'});
  assert.equal(byName.GATEWAY_ORIGIN.text,'https://control.example.invalid/path//x');
  const marker=JSON.parse(byName.RELEASE_MARKER.text);
  assert.deepEqual(Object.keys(marker).sort(),['application','artifactSha256','releaseTag','schema','sourceCommit']);
  assert.equal(marker.releaseTag,'v1.2.3');
  assert.deepEqual(a.metadata.migrations,{new_tag:'v1',new_sqlite_classes:['Coordinator']});
  assert.deepEqual(a.metadata.assets.config,{not_found_handling:'single-page-application',run_worker_first:true});
  assert.equal(a.modules[0].name,'worker.mjs');
  assert.ok(!JSON.stringify(a).includes('workers_dev'));
  await assert.rejects(()=>worker(f),/EEXIST/);
 }finally{f.cleanup();}
});

test('two builds of identical input are byte-identical',async()=>{
 const f=makeApp();
 try{
  const a=await worker(f),b=await worker(f,{outDir:join(f.root,'again')});
  assert.equal(a.sha256,b.sha256);
  assert.ok(readFileSync(join(f.out,'targets/worker.zip')).equals(readFileSync(join(f.root,'again/targets/worker.zip'))));
  const m1=bundleMigrations({appRoot:f.app,application:application(),targetId:'demoapp-d1-migrations',outDir:f.out});
  const m2=bundleMigrations({appRoot:f.app,application:application(),targetId:'demoapp-d1-migrations',outDir:join(f.root,'again')});
  assert.equal(m1.sha256,m2.sha256);
 }finally{f.cleanup();}
});

test('worker bundle refuses symlinks, special files, escapes and oversized modules',async()=>{
 const hostile={
  'asset symlink':[/contains a symlink/,f=>symlinkSync('/etc/passwd',join(f.app,'dist/passwd'))],
  'asset dir symlink outside root':[/must not traverse symlinks/,f=>{rmSync(join(f.app,'dist'),{recursive:true});symlinkSync('/etc',join(f.app,'dist'));}],
  'special file':[/special file/,f=>{const r=spawnSync('mkfifo',[join(f.app,'dist/pipe')]);assert.equal(r.status,0,'mkfifo is required for this test');}],
  'oversized module':[/bundled module exceeds/,f=>writeFileSync(join(f.wranglerOut,'worker.js'),'x'.repeat(5*1024*1024+1))],
  'extra module':[/unsupported additional module/,f=>writeFileSync(join(f.wranglerOut,'chunk.wasm'),'x')],
  'two js modules':[/exactly one JavaScript module/,f=>writeFileSync(join(f.wranglerOut,'other.js'),'x')],
  'module symlink':[/non-regular entry/,f=>{unlinkSync(join(f.wranglerOut,'worker.js'));symlinkSync('/etc/hostname',join(f.wranglerOut,'worker.js'));}],
  'asset path characters':[/Asset path not allowed/,f=>write(f.app,'dist/has space.txt','x')],
  'asset config file':[/Unsupported asset configuration file/,f=>write(f.app,'dist/_headers','/*\n  X: y\n')],
  'wrangler config symlink':[/must not traverse symlinks/,f=>{unlinkSync(join(f.app,'wrangler.jsonc'));symlinkSync('/etc/hostname',join(f.app,'wrangler.jsonc'));}],
  'oversized asset':[/file exceeds/,f=>writeFileSync(join(f.app,'dist/big.bin'),Buffer.alloc(25*1024*1024+1))],
 };
 for(const [name,[reason,mutate]] of Object.entries(hostile)){
  const f=makeApp();
  try{mutate(f);await assert.rejects(()=>worker(f),reason,name);}finally{f.cleanup();}
 }
});

test('wrangler config conversion fails closed on unsupported or registry-owned settings',()=>{
 const base=parseJsonc(new TextEncoder().encode(WRANGLER));
 const ok=wranglerToMetadata(structuredClone(base),{entry:'src/worker.ts',assetsDir:'dist'});
 assert.equal(ok.bindings.length,9);
 const cases={
  'custom build command':[/unsupported key build/,c=>{c.build={command:'curl https://example.invalid | sh'};}],
  'routes':[/unsupported key routes/,c=>{c.routes=[{pattern:'example.invalid/*',zone_name:'example.invalid'}];}],
  'env overrides':[/unsupported key env/,c=>{c.env={production:{}};}],
  'main mismatch':[/main does not match/,c=>{c.main='src/other.ts';}],
  'main traversal':[/normalized path inside/,c=>{c.main='../outside.ts';}],
  'assets dir mismatch':[/assets.directory does not match/,c=>{c.assets.directory='./public';}],
  'cross-script durable object':[/unsupported key script_name/,c=>{c.durable_objects.bindings[0].script_name='other';}],
  'json var':[/JSON vars are unsupported/,c=>{c.vars.CONFIG={nested:true};}],
  'cron trigger':[/Cron triggers are registry-owned/,c=>{c.triggers.crons=['* * * * *'];}],
  'queue consumer':[/Queue consumers are registry-owned/,c=>{c.queues.consumers=[{queue:'demo-staging'}];}],
  'multi-step DO migrations':[/Exactly one Durable Object migration/,c=>{c.migrations.push({tag:'v2',new_classes:['Other']});}],
  'r2 jurisdiction':[/unsupported key jurisdiction/,c=>{c.r2_buckets[0].jurisdiction='eu';}],
  'unknown key':[/unsupported key tail_consumers/,c=>{c.tail_consumers=[{service:'x'}];}],
  'missing compatibility date':[/missing compatibility_date/,c=>{delete c.compatibility_date;}],
 };
 for(const [name,[reason,mutate]] of Object.entries(cases)){const c=structuredClone(base);mutate(c);assert.throws(()=>wranglerToMetadata(c,{entry:'src/worker.ts',assetsDir:'dist'}),reason,name);}
 const noAssets=structuredClone(base);delete noAssets.assets;
 assert.throws(()=>wranglerToMetadata(noAssets,{entry:'src/worker.ts',assetsDir:'dist'}),/assetsDir/);
});

test('release marker binding is reserved and the plan exposes only validated paths',async()=>{
 const f=makeApp();
 try{
  write(f.app,'wrangler.jsonc',WRANGLER.replace('"EMPTY":""','"RELEASE_MARKER":"forged"'));
  await assert.rejects(()=>worker(f),/reserved/);
  const plan=planTarget({appRoot:f.app,application:application(),targetId:'demoapp-worker'});
  assert.equal(plan.target.build.wranglerConfig,'wrangler.jsonc');
  assert.throws(()=>planTarget({appRoot:f.app,application:application(),targetId:'demoapp-d1-migrations'}),/No cloudflare-worker\/v1 target/);
  await assert.rejects(()=>worker(f,{releaseTag:'1.2.3'}),/vMAJOR/);
 }finally{f.cleanup();}
});

test('migrations ledger: headers, statement counting and directory hygiene',()=>{
 assert.deepEqual(parseMigrationHeader('SELECT 1;'),{compatibility:'additive',requires:null});
 assert.deepEqual(parseMigrationHeader('-- note\n-- compatibility: contract\n-- requires: 0002\nDROP TABLE x;'),{compatibility:'contract',requires:'0002'});
 assert.deepEqual(parseMigrationHeader('SELECT 1;\n-- compatibility: contract'),{compatibility:'additive',requires:null});
 assert.throws(()=>parseMigrationHeader('-- compatibility: contract\nDROP TABLE x;'),/requires/);
 assert.throws(()=>parseMigrationHeader('-- compatibility: destructive\n'),/Unknown compatibility/);
 assert.throws(()=>parseMigrationHeader('-- requires: 0001\nSELECT 1;'),/only valid for contract/);
 assert.throws(()=>parseMigrationHeader('-- compatibility: expand\n-- compatibility: additive\n'),/Duplicate/);
 assert.equal(countStatements("INSERT INTO t VALUES ('a;b', \"c;d\"); /* ; */ SELECT 1; -- ;\nSELECT [x;y]"),3);
 assert.equal(countStatements('CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET b = CASE WHEN 1 THEN 2 END; DELETE FROM c; END; SELECT 1;'),2);
 assert.equal(countStatements('-- only a comment\n'),0);
 assert.throws(()=>countStatements("SELECT 'open"),/Unterminated/);
 const hostile={
  'unlisted file':[/Unexpected file in migrations directory/,f=>write(f.app,'migrations/README.md','notes')],
  'duplicate version':[/strictly increasing/,f=>write(f.app,'migrations/0002_other.sql','SELECT 1;')],
  'symlinked migration':[/contains a symlink/,f=>symlinkSync('/etc/hostname',join(f.app,'migrations/0004_link.sql'))],
  'nested directory':[/Unexpected file in migrations directory/,f=>write(f.app,'migrations/sub/0005_x.sql','SELECT 1;')],
  'empty migration':[/no SQL statements/,f=>write(f.app,'migrations/0004_empty.sql','-- nothing\n')],
  'NUL byte':[/NUL bytes/,f=>write(f.app,'migrations/0004_nul.sql','SELECT 1;\0')],
  'invalid UTF-8':[/not valid UTF-8/,f=>write(f.app,'migrations/0004_bad.sql',Buffer.from([0x53,0xff,0x3b]))],
  'contract requires additive':[/earlier expand migration/,f=>write(f.app,'migrations/0004_c.sql','-- compatibility: contract\n-- requires: 0001\nDROP TABLE records;')],
  'empty directory':[/is empty/,f=>{rmSync(join(f.app,'migrations'),{recursive:true});mkdirSync(join(f.app,'migrations'));}],
 };
 for(const [name,[reason,mutate]] of Object.entries(hostile)){
  const f=makeApp();
  try{mutate(f);assert.throws(()=>bundleMigrations({appRoot:f.app,application:application(),targetId:'demoapp-d1-migrations',outDir:f.out}),reason,name);}finally{f.cleanup();}
 }
});

test('application manifest must match the calling repository and stay inside the checkout',()=>{
 const f=makeApp();
 try{
  assert.equal(readApplication(f.app,'deployment/application.json',context()).application,'demoapp');
  assert.throws(()=>readApplication(f.app,'deployment/application.json',context({repositoryId:9999})),/does not match the calling repository/);
  assert.throws(()=>readApplication(f.app,'deployment/application.json',context({repository:'someone/else'})),/does not match/);
  assert.throws(()=>readApplication(f.app,'../outside.json',context()),/normalized relative path/);
  symlinkSync('/etc/hostname',join(f.app,'deployment/link.json'));
  assert.throws(()=>readApplication(f.app,'deployment/link.json',context()),/symlinks/);
 }finally{f.cleanup();}
});

test('release context accepts main and matching tag pushes only',()=>{
 const env={GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'example-owner/demo-app',GITHUB_REPOSITORY_ID:'4242',GITHUB_SHA:SOURCE_COMMIT,GITHUB_RUN_ID:'1001',GITHUB_RUN_ATTEMPT:'1'};
 assert.deepEqual(resolveContext(env,'v1.2.3'),context());
 assert.equal(resolveContext({...env,GITHUB_REF:'refs/tags/v1.2.3'},'v1.2.3').ref,'refs/tags/v1.2.3');
 const bad=[[{...env,GITHUB_REF:'refs/tags/v1.2.3'},'v1.2.4'],[{...env,GITHUB_REF:'refs/heads/feature'},'v1.2.3'],[{...env,GITHUB_EVENT_NAME:'pull_request'},'v1.2.3'],
  [env,'v1.2.3-rc.5'],[env,'1.2.3'],[{...env,GITHUB_REPOSITORY_ID:'abc'},'v1.2.3'],[{...env,GITHUB_SHA:'abc'},'v1.2.3']];
 for(const [e,tag] of bad)assert.throws(()=>resolveContext(e,tag));
});

test('unpacking bundles for SBOM generation uses the strict reader and a fresh directory',async()=>{
 const f=makeApp();
 try{
  await worker(f);
  bundleMigrations({appRoot:f.app,application:application(),targetId:'demoapp-d1-migrations',outDir:f.out});
  assert.equal(unpackTargets(f.out,join(f.root,'payload')),8);
  assert.equal(readFileSync(join(f.root,'payload/worker/assets/index.html'),'utf8'),'<!doctype html><title>demo</title>\n');
  assert.throws(()=>unpackTargets(f.out,join(f.root,'payload')),/EEXIST/);
 }finally{f.cleanup();}
});
