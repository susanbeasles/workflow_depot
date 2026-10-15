import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {artifactPathFor,parseJson,validateWorkerArtifactV2,validateApplication,ContractError} from '../src/shared/release-contract.mjs';
import {wranglerToMetadata} from '../ci/release/build-worker-bundle.mjs';
import {bundleMigrations,parseTargetList} from '../ci/release/bundle-migrations.mjs';
import {verifyRelease} from '../ci/release/verify-release.mjs';
import {parseJsonc} from '../ci/release/jsonc.mjs';
import {readZip} from '../ci/release/zip.mjs';
import {makeApp,buildRelease,application,applicationWithReplicator,REPLICATOR_WRANGLER,write} from './release-fixtures.mjs';

const hex=b=>createHash('sha256').update(b).digest('hex');
const artifactOf=path=>parseJson(readZip(new Uint8Array(readFileSync(path))).find(e=>e.name==='artifact.json').data,{maxBytes:16*1024*1024});
const SIGNATURE=JSON.stringify({mediaType:'application/vnd.dev.sigstore.bundle.v0.3+json'});

test('every target is bundled at targets/<target-id>.zip with a validated id',()=>{
 assert.equal(artifactPathFor('prosrus-worker'),'targets/prosrus-worker.zip');
 for(const id of ['../x','a/b','A','x.zip','',`${'a'.repeat(65)}`])assert.throws(()=>artifactPathFor(id),ContractError,id);
 assert.deepEqual(parseTargetList('["a","b-c"]'),['a','b-c']);
 assert.deepEqual(parseTargetList('[]'),[]);
 for(const bad of ['["a","a"]','["../a"]','{"a":1}','[1]','not json'])assert.throws(()=>parseTargetList(bad),Error,bad);
});

const replicatorConfig=()=>parseJsonc(new TextEncoder().encode(REPLICATOR_WRANGLER));
const ROUTELESS={entry:'src/replicator/worker.ts',assetsDir:undefined,healthContract:'worker-version/v1'};

test('routeless replicator config: crons are declared only, bindings stay claims',()=>{
 const {metadata,bindings,assetConfig}=wranglerToMetadata(replicatorConfig(),ROUTELESS);
 assert.deepEqual(metadata.declared,{crons:['*/5 * * * *','23 3 * * *','53 3 1 * *'],queueConsumers:[]});
 assert.deepEqual(bindings.map(b=>`${b.name}:${b.type}`).sort(),['BACKUP:r2_bucket','DB:d1','ORIGINALS:r2_bucket','OWNER_ID:plain_text']);
 assert.equal(assetConfig,null);
 const quiet=replicatorConfig();quiet.triggers.crons=[];
 assert.ok(!Object.hasOwn(wranglerToMetadata(quiet,ROUTELESS).metadata,'declared'));
});

test('queue producers become queue bindings and consumers are declared only',()=>{
 const config=replicatorConfig();
 config.queues={producers:[{binding:'JOBS',queue:'demo-staging'}],consumers:[{queue:'demo-staging',max_batch_size:10,max_retries:5,dead_letter_queue:'demo-staging-dlq'},{queue:'demo-wakeups'}]};
 const {metadata,bindings}=wranglerToMetadata(config,ROUTELESS);
 assert.deepEqual(bindings.find(b=>b.name==='JOBS'),{name:'JOBS',type:'queue',queue_name:'demo-staging'});
 assert.deepEqual(metadata.declared.queueConsumers,[{queue:'demo-staging',maxBatchSize:10,maxRetries:5,deadLetterQueue:'demo-staging-dlq'},{queue:'demo-wakeups'}]);
});

test('worker-version/v1 targets must be unreachable by URL',()=>{
 const cases={
  'workers_dev omitted':c=>{delete c.workers_dev;},
  'workers_dev true':c=>{c.workers_dev=true;},
  'preview urls on':c=>{c.preview_urls=true;},
  'assets declared':c=>{c.assets={directory:'./dist'};},
 };
 for(const [name,mutate] of Object.entries(cases)){const c=replicatorConfig();mutate(c);assert.throws(()=>wranglerToMetadata(c,ROUTELESS),/worker-version\/v1 targets must set workers_dev false/,name);}
 const routed=replicatorConfig();delete routed.workers_dev;
 assert.ok(wranglerToMetadata(routed,{...ROUTELESS,healthContract:'http-release-marker/v1'}));
});

test('declared triggers are strictly validated and bounded',async()=>{
 const base={schema:'workflow-depot-worker-artifact/v2',metadata:{main_module:'worker.mjs',compatibility_date:'2026-10-08',compatibility_flags:[],bindings:[],
  declared:{crons:['*/5 * * * *'],queueConsumers:[{queue:'demo-staging',maxBatchSize:10,maxRetries:5,deadLetterQueue:'demo-staging-dlq'}]}},modules:[{name:'worker.mjs',type:'esm',content:'x'}]};
 await validateWorkerArtifactV2(structuredClone(base));
 const cases={
  'unknown declared key':d=>{d.routes=['x'];},
  'missing crons':d=>{delete d.crons;},
  'too many crons':d=>{d.crons=Array.from({length:11},(_,i)=>`${i} * * * *`);},
  'malformed cron':d=>{d.crons=['every five minutes'];},
  'cron with shell characters':d=>{d.crons=['* * * * *; rm -rf /'];},
  'duplicate cron':d=>{d.crons=['* * * * *','* * * * *'];},
  'unknown consumer key':d=>{d.queueConsumers[0].maxConcurrency=5;},
  'bad queue name':d=>{d.queueConsumers[0].queue='Bad Queue';},
  'batch size out of range':d=>{d.queueConsumers[0].maxBatchSize=1000;},
  'retries out of range':d=>{d.queueConsumers[0].maxRetries=-1;},
  'dead letter equals queue':d=>{d.queueConsumers[0].deadLetterQueue='demo-staging';},
  'duplicate consumer queue':d=>{d.queueConsumers.push({queue:'demo-staging'});},
  'empty declaration':d=>{d.crons=[];d.queueConsumers=[];},
 };
 for(const [name,mutate] of Object.entries(cases)){
  const a=structuredClone(base);mutate(a.metadata.declared);
  await assert.rejects(()=>validateWorkerArtifactV2(a),ContractError,name);
 }
});

test('multiple D1 targets each get their own bundle',()=>{
 const f=makeApp();
 try{
  const app=application();
  app.targets.push({id:'demoapp-d1-audit',adapter:'cloudflare-d1-migrate/v1',build:{migrationsDir:'migrations',binding:'AUDIT'},dependsOn:[],recoveryPolicy:'forward-only'});
  validateApplication(app);
  bundleMigrations({appRoot:f.app,application:app,targetId:'demoapp-d1-migrations',outDir:f.out});
  bundleMigrations({appRoot:f.app,application:app,targetId:'demoapp-d1-audit',outDir:f.out});
  assert.deepEqual(readdirSync(join(f.out,'targets')).sort(),['demoapp-d1-audit.zip','demoapp-d1-migrations.zip']);
  const ledger=parseJson(readZip(new Uint8Array(readFileSync(join(f.out,'targets/demoapp-d1-audit.zip')))).find(e=>e.name==='ledger.json').data);
  assert.equal(ledger.binding,'AUDIT');
 }finally{f.cleanup();}
});

test('two workers and one D1 target: end-to-end release verifies and is byte-stable',async()=>{
 const f=makeApp();
 try{
  const app=applicationWithReplicator();
  const first=await buildRelease(f,{app});
  const second=await buildRelease(f,{app,out:join(f.root,'second')});
  const files=['targets/demoapp-worker.zip','targets/demoapp-replicator.zip','targets/demoapp-d1-migrations.zip','authorization-policy.json','checksums.json','SHA256SUMS','release.zip','release.meta.json'];
  for(const file of files)assert.ok(readFileSync(join(f.out,file)).equals(readFileSync(join(f.root,'second',file))),`${file} differs between builds`);
  assert.equal(first.release.sha256,second.release.sha256);

  const result=await verifyRelease(f.out,{application:app});
  assert.deepEqual(result.targets.map(t=>t.id),['demoapp-d1-migrations','demoapp-worker','demoapp-replicator']);
  const manifest=JSON.parse(readFileSync(join(f.out,'release.meta.json'),'utf8'));
  assert.deepEqual(manifest.targets.map(t=>[t.id,t.artifactPath]),[['demoapp-d1-migrations','targets/demoapp-d1-migrations.zip'],['demoapp-worker','targets/demoapp-worker.zip'],['demoapp-replicator','targets/demoapp-replicator.zip']]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(f.out,'checksums.json'),'utf8')).files).filter(p=>p.startsWith('targets/')),['targets/demoapp-d1-migrations.zip','targets/demoapp-replicator.zip','targets/demoapp-worker.zip']);
  const policy=JSON.parse(readFileSync(join(f.out,'authorization-policy.json'),'utf8'));
  assert.deepEqual(policy.environments.staging.targets,['demoapp-d1-migrations','demoapp-worker','demoapp-replicator']);

  const product=artifactOf(join(f.out,'targets/demoapp-worker.zip')),replicator=artifactOf(join(f.out,'targets/demoapp-replicator.zip'));
  const markerOf=a=>JSON.parse(a.metadata.bindings.find(b=>b.name==='RELEASE_MARKER').text);
  assert.equal(markerOf(product).artifactSha256,hex(product.modules[0].content));
  assert.equal(markerOf(replicator).artifactSha256,hex(replicator.modules[0].content));
  assert.notEqual(markerOf(product).artifactSha256,markerOf(replicator).artifactSha256);
  assert.ok(!Object.hasOwn(product.metadata,'declared'));
  assert.deepEqual(replicator.metadata.declared,{crons:['*/5 * * * *','23 3 * * *','53 3 1 * *'],queueConsumers:[]});
  assert.deepEqual(manifest.targets.map(t=>t.healthContract??t.recoveryPolicy),['forward-only','http-release-marker/v1','worker-version/v1']);
  assert.deepEqual(policy.targets,{'demoapp-d1-migrations':{adapter:'cloudflare-d1-migrate/v1',recoveryPolicy:'forward-only'},'demoapp-worker':{adapter:'cloudflare-worker/v1',healthContract:'http-release-marker/v1'},'demoapp-replicator':{adapter:'cloudflare-worker/v1',healthContract:'worker-version/v1'}});
  assert.ok(!Object.hasOwn(replicator.metadata,'assets'));
  assert.deepEqual(replicator.metadata.bindings.map(b=>b.name),['BACKUP','DB','ORIGINALS','OWNER_ID','RELEASE_MARKER']);
  assert.ok(product.metadata.bindings.every(b=>b.name!=='BACKUP'),'only the replicator binds the backup bucket');

  await assert.rejects(()=>verifyRelease(f.out,{application:application()}),/targets do not match the application manifest/);
  for(const name of ['release.zip.sigstore.json','release.meta.json.sigstore.json'])write(f.out,name,SIGNATURE);
  write(f.out,'release.zip.intoto.jsonl',SIGNATURE+'\n');
  const published=join(f.root,'published');
  for(const name of ['release.zip','release.zip.sigstore.json','release.meta.json','release.meta.json.sigstore.json','release.zip.intoto.jsonl','sbom.cdx.json','sbom.spdx.json','checksums.json','SHA256SUMS','authorization-policy.json'])
   write(published,name,readFileSync(join(f.out,name)));
  assert.equal((await verifyRelease(published,{stage:'signed',layout:'published',application:app})).targets.length,3);
 }finally{f.cleanup();}
});
