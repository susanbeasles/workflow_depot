import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJson,canonical,digest,sha256,validateApplication,validateWorkerArtifactV2,validateMigrationsLedger,validateAuthorizationPolicy,validateChecksums,
 renderSha256Sums,validateReleaseManifest,validatePromotionRequest,validateReleaseMarker,validateReleaseContext,topologicalOrder,isTimestamp,ContractError} from '../src/shared/release-contract.mjs';
import {inspectArtifact} from '../src/shared/contract.mjs';
import {application,context,SOURCE_COMMIT} from './release-fixtures.mjs';

const clone=v=>structuredClone(v);
const hex64=c=>c.repeat(64);
const denied=(fn,pattern,name)=>assert.throws(fn,e=>e instanceof ContractError&&(!pattern||pattern.test(e.message)),name);
const deniedAsync=(fn,pattern,name)=>assert.rejects(fn,e=>e instanceof ContractError&&(!pattern||pattern.test(e.message)),name);

test('strict JSON parsing rejects duplicate keys, prototype keys, BOM, trailing data and deep nesting',()=>{
 assert.deepEqual(parseJson('{"a":[1,"x\\u0041",true,null],"b":{"c":-1.5e2}}'),{a:[1,'xA',true,null],b:{c:-150}});
 denied(()=>parseJson('{"a":1,"a":2}'),/duplicate key/);
 denied(()=>parseJson('{"x":{"k":1,"k":1}}'),/duplicate key/);
 denied(()=>parseJson('{"__proto__":{"polluted":true}}'),/forbidden key/);
 denied(()=>parseJson(new Uint8Array([0xef,0xbb,0xbf,0x7b,0x7d])),/byte order mark/);
 denied(()=>parseJson('{} x'),/malformed/);
 denied(()=>parseJson('{"a":"\u0001"}'),/malformed/);
 denied(()=>parseJson('['.repeat(70)+']'.repeat(70)),/too deep/);
 denied(()=>parseJson(new Uint8Array([0x22,0xff,0x22])),/UTF-8/);
 denied(()=>parseJson('{"a":1}',{maxBytes:3}),/size/);
 assert.equal(({}).polluted,undefined);
});

test('canonical JSON and digests are reused from the v1 contract module',async()=>{
 assert.equal(canonical({b:1,a:[true,'x']}),'{"a":[true,"x"],"b":1}');
 assert.equal(await digest({b:1,a:2}),await sha256(new TextEncoder().encode('{"a":2,"b":1}')));
 assert.ok(isTimestamp('2026-10-15T00:00:00Z'));
 assert.ok(!isTimestamp('2026-02-30T00:00:00Z'));
 assert.ok(!isTimestamp('2026-10-15T00:00:00.000Z'));
});

test('application-deployment/v1 accepts the contract shape and rejects hostile variants',()=>{
 const app=application();
 assert.equal(validateApplication(app),app);
 const prosrus=JSON.parse(readFileSync(new URL('../docs/contracts.md',import.meta.url),'utf8').match(/```json\n(\{\n  "schema": "application-deployment\/v1"[\s\S]*?)\n```/)[1]);
 validateApplication(prosrus);
 const cases={
  'unknown key':a=>{a.extra=true;},
  'unknown target key':a=>{a.targets[0].script='rm -rf /';},
  'unknown adapter':a=>{a.targets[0].adapter='shell-exec/v1';},
  'cyclic DAG':a=>{a.targets[0].dependsOn=['demoapp-worker'];},
  'self dependency':a=>{a.targets[0].dependsOn=['demoapp-d1-migrations'];},
  'missing dependency':a=>{a.targets[1].dependsOn=['ghost'];},
  'traversal path':a=>{a.targets[1].build.assetsDir='../outside';},
  'absolute path':a=>{a.targets[1].build.wranglerConfig='/etc/wrangler.jsonc';},
  'dot segment':a=>{a.targets[1].build.entry='./src/worker.ts';},
  'shell build command':a=>{a.targets[1].build.buildCommand='build && curl x';},
  'bad target id':a=>{a.targets[0].id='Bad_Id';},
  'duplicate adapter':a=>{a.targets.push({...clone(a.targets[1]),id:'second-worker',dependsOn:[]});},
  'bad environment ref':a=>{a.environments.staging.allowedRefs=['main'];},
  'approvals out of range':a=>{a.environments.production.requiredApprovals=99;},
  'repository id not integer':a=>{a.repositoryId='4242';},
  'unsupported recovery':a=>{a.targets[0].recoveryPolicy='rollback';},
 };
 for(const [name,mutate] of Object.entries(cases)){const a=clone(app);mutate(a);denied(()=>validateApplication(a),undefined,name);}
});

test('topological order respects dependencies and rejects cycles',()=>{
 assert.deepEqual(topologicalOrder([{id:'b',dependsOn:['a']},{id:'a',dependsOn:[]},{id:'c',dependsOn:['a','b']}]),['a','b','c']);
 denied(()=>topologicalOrder([{id:'a',dependsOn:['c']},{id:'b',dependsOn:['a']},{id:'c',dependsOn:['b']}]),/cycle/);
});

async function artifact(){
 const content='export default {fetch(){return new Response("ok")}};';
 const marker={schema:'release-marker/v1',application:'demoapp',releaseTag:'v1.2.3',sourceCommit:SOURCE_COMMIT,artifactSha256:await sha256(new TextEncoder().encode(content))};
 return {schema:'workflow-depot-worker-artifact/v2',metadata:{main_module:'worker.mjs',compatibility_date:'2026-10-08',compatibility_flags:['nodejs_compat'],
  bindings:[{name:'ASSETS',type:'assets'},{name:'COORDINATOR',type:'durable_object_namespace',class_name:'Coordinator'},{name:'DB',type:'d1',database_id:'00000000-0000-0000-0000-000000000000'},
   {name:'JOBS',type:'queue',queue_name:'demo-staging'},{name:'RELEASE_MARKER',type:'plain_text',text:canonical(marker)},{name:'SECRET',type:'inherit'}],
  migrations:{new_tag:'v1',new_sqlite_classes:['Coordinator']},
  assets:{config:{not_found_handling:'single-page-application',run_worker_first:true},manifest:[{path:'assets/a.js',sha256:hex64('a'),sizeBytes:1,contentType:'text/javascript'},{path:'index.html',sha256:hex64('b'),sizeBytes:2,contentType:'text/html'}]}},
  modules:[{name:'worker.mjs',type:'esm',content}]};
}

test('worker-artifact/v2 is a strict superset of v1 bindings and enforces limits',async()=>{
 const a=await artifact();
 assert.equal(await validateWorkerArtifactV2(a),a);
 const v1=JSON.parse(JSON.stringify({schema:'workflow-depot-worker-artifact/v1',metadata:{main_module:'worker.mjs',compatibility_date:'2026-10-08',compatibility_flags:[],bindings:[{name:'DB',type:'d1',database_id:'00000000-0000-0000-0000-000000000000'}]},modules:[{name:'worker.mjs',type:'esm',content:'x'}]}));
 await inspectArtifact(new TextEncoder().encode(JSON.stringify(v1)),1024);
 const cases={
  'oversized module':x=>{x.modules[0].content='x'.repeat(5*1024*1024+1);},
  'unknown binding type':x=>{x.metadata.bindings.push({name:'HOOK',type:'webhook',url:'https://example.invalid'});},
  'v1 rule: bad d1 id':x=>{x.metadata.bindings[2].database_id='not-a-uuid';},
  'v1 rule: bad compatibility date':x=>{x.metadata.compatibility_date='2026-02-30';},
  'duplicate binding':x=>{x.metadata.bindings.push({name:'DB',type:'inherit'});},
  'unknown metadata key':x=>{x.metadata.routes=['example.invalid/*'];},
  'unknown artifact key':x=>{x.signature='forged';},
  'bad queue name':x=>{x.metadata.bindings[3].queue_name='Bad Queue';},
  'two modules':x=>{x.modules.push({name:'extra.mjs',type:'esm',content:'x'});},
  'main module renamed':x=>{x.metadata.main_module='index.js';},
  'asset traversal':x=>{x.metadata.assets.manifest[0].path='../etc/passwd';},
  'asset absolute':x=>{x.metadata.assets.manifest[0].path='/etc/passwd';},
  'asset unsorted':x=>{x.metadata.assets.manifest.reverse();},
  'asset too large':x=>{x.metadata.assets.manifest[0].sizeBytes=25*1024*1024+1;},
  'asset bad config':x=>{x.metadata.assets.config.not_found_handling='redirect-anywhere';},
  'empty DO migration':x=>{x.metadata.migrations={new_tag:'v1'};},
  'marker digest mismatch':x=>{x.modules[0].content+=' ';},
  'marker not canonical':x=>{const b=x.metadata.bindings[4];b.text=JSON.stringify(JSON.parse(b.text),null,1);},
  'assets binding without metadata':x=>{delete x.metadata.assets;},
 };
 for(const [name,mutate] of Object.entries(cases)){const x=clone(a);mutate(x);await deniedAsync(()=>validateWorkerArtifactV2(x),undefined,name);}
 const many=clone(a);many.metadata.assets.manifest=Array.from({length:20001},(_,i)=>({path:`f${String(i).padStart(6,'0')}`,sha256:hex64('c'),sizeBytes:0,contentType:'text/plain'}));
 await deniedAsync(()=>validateWorkerArtifactV2(many),/too many assets/);
});

test('migrations-ledger/v1 enforces ordering, digests and expand/contract pairing',()=>{
 const entry=(version,extra={})=>({version,file:`${version}_x.sql`,sha256:hex64('d'),sizeBytes:10,statements:1,compatibility:'additive',recoveryPolicy:'forward-only',...extra});
 const ledger={schema:'migrations-ledger/v1',binding:'DB',migrations:[entry('0001'),entry('0002',{compatibility:'expand'}),entry('0003',{compatibility:'contract',requires:'0002'})]};
 validateMigrationsLedger(ledger);
 const cases={
  'not increasing':l=>{l.migrations[1].version='0001';l.migrations[1].file='0001_y.sql';},
  'file/version mismatch':l=>{l.migrations[0].file='0009_x.sql';},
  'contract without requires':l=>{delete l.migrations[2].requires;},
  'requires non-expand':l=>{l.migrations[2].requires='0001';},
  'requires on additive':l=>{l.migrations[0].requires='0002';},
  'unknown compatibility':l=>{l.migrations[0].compatibility='destructive';},
  'traversal file':l=>{l.migrations[0].file='../0001_x.sql';},
  'empty':l=>{l.migrations=[];},
  'unknown key':l=>{l.migrations[0].run='sh';},
 };
 for(const [name,mutate] of Object.entries(cases)){const l=clone(ledger);mutate(l);denied(()=>validateMigrationsLedger(l),undefined,name);}
});

function policy(){
 return {schema:'authorization-policy/v1',policyVersion:1,application:'demoapp',repository:'example-owner/demo-app',repositoryId:4242,releasePrefix:'demoapp/',
  sourceCommit:SOURCE_COMMIT,releaseTag:'v1.2.3',signer:{issuer:'https://token.actions.githubusercontent.com',identity:`https://github.com/example-owner/workflow_depot/.github/workflows/release.yml@${'e'.repeat(40)}`},
  environments:{staging:{allowedRefs:['refs/heads/main'],requiredApprovals:0,targets:['demoapp-worker']}},expiresAt:'2027-10-15T00:00:00Z'};
}
test('authorization-policy/v1 binds a SHA-pinned signer and the release prefix',()=>{
 validateAuthorizationPolicy(policy());
 const cases={
  'branch-pinned signer':p=>{p.signer.identity='https://github.com/example-owner/workflow_depot/.github/workflows/release.yml@refs/heads/main';},
  'foreign issuer':p=>{p.signer.issuer='https://issuer.example.invalid';},
  'foreign prefix':p=>{p.releasePrefix='other/';},
  'bad semver':p=>{p.releaseTag='v1.2';},
  'policy version':p=>{p.policyVersion=2;},
  'unknown key':p=>{p.allowAll=true;},
 };
 for(const [name,mutate] of Object.entries(cases)){const p=policy();mutate(p);denied(()=>validateAuthorizationPolicy(p),undefined,name);}
});

test('release-checksums/v1 covers bundles and policy and renders SHA256SUMS',()=>{
 const c={schema:'release-checksums/v1',algorithm:'sha256',files:{'targets/worker.zip':{sha256:hex64('1'),sizeBytes:5},'authorization-policy.json':{sha256:hex64('2'),sizeBytes:6}}};
 validateChecksums(c);
 assert.equal(renderSha256Sums(c),`${hex64('2')}  authorization-policy.json\n${hex64('1')}  targets/worker.zip\n`);
 for(const mutate of [c=>{c.files['../escape.zip']={sha256:hex64('3'),sizeBytes:1};},c=>{delete c.files['authorization-policy.json'];},c=>{c.algorithm='md5';},c=>{c.files['targets/worker.zip'].sizeBytes=0;}]){
  const x=clone(c);mutate(x);denied(()=>validateChecksums(x));
 }
});

function manifest(){
 return {schema:'release-manifest/v2',application:'demoapp',repository:'example-owner/demo-app',repositoryId:4242,releaseTag:'v1.0.0',sourceCommit:SOURCE_COMMIT,createdAt:'2026-10-15T00:00:00Z',
  builder:{workflow:`example-owner/workflow_depot/.github/workflows/release.yml@${'e'.repeat(40)}`,runId:'7',runAttempt:'1'},
  artifact:{path:'release.zip',sha256:hex64('a'),sizeBytes:10,mediaType:'application/zip'},
  targets:[{id:'demoapp-d1-migrations',adapter:'cloudflare-d1-migrate/v1',artifactPath:'targets/migrations.zip',sha256:hex64('b'),sizeBytes:1,dependsOn:[],recoveryPolicy:'forward-only'},
   {id:'demoapp-worker',adapter:'cloudflare-worker/v1',artifactPath:'targets/worker.zip',sha256:hex64('c'),sizeBytes:1,dependsOn:['demoapp-d1-migrations'],healthContract:'http-release-marker/v1'}],
  authorizationPolicy:{path:'authorization-policy.json',sha256:hex64('d')},checksums:{path:'checksums.json',sha256:hex64('e')}};
}
test('release-manifest/v2 rejects bad semver, unknown keys, cycles and redirected artifact paths',()=>{
 validateReleaseManifest(manifest());
 const cases={
  'bad semver':m=>{m.releaseTag='1.0.0';},
  'prerelease tag':m=>{m.releaseTag='v1.0.0-rc.1';},
  'leading zero':m=>{m.releaseTag='v01.0.0';},
  'unknown key':m=>{m.deployTo='https://example.invalid';},
  'unknown target key':m=>{m.targets[0].accountId='x';},
  'cycle':m=>{m.targets[0].dependsOn=['demoapp-worker'];},
  'artifact path redirect':m=>{m.targets[1].artifactPath='targets/../worker.zip';},
  'wrong adapter path':m=>{m.targets[1].artifactPath='targets/migrations.zip';},
  'branch builder':m=>{m.builder.workflow='example-owner/workflow_depot/.github/workflows/release.yml@main';},
  'unknown adapter':m=>{m.targets[0].adapter='ssh-deploy/v1';},
  'short sha':m=>{m.sourceCommit='abc123';},
 };
 for(const [name,mutate] of Object.entries(cases)){const m=manifest();mutate(m);denied(()=>validateReleaseManifest(m),undefined,name);}
});

test('promotion-request/v1 requires UUIDv7 and an r2 URI bound to application and tag',()=>{
 const r={schema:'promotion-request/v1',requestId:'01920000-0000-7000-8000-000000000000',application:'demoapp',environment:'staging',repository:'example-owner/demo-app',releaseTag:'v1.0.0',
  releaseManifestUri:'r2://releases-r2/demoapp/v1.0.0/release.meta.json',releaseManifestSha256:hex64('a'),expectedCurrentGeneration:0,githubDeploymentId:123,requestedAt:'2026-10-15T00:00:00Z'};
 validatePromotionRequest(r);
 for(const mutate of [x=>{x.requestId='01920000-0000-4000-8000-000000000000';},x=>{x.releaseManifestUri='r2://releases-r2/other/v1.0.0/release.meta.json';},
  x=>{x.releaseManifestUri='https://example.invalid/release.meta.json';},x=>{x.expectedCurrentGeneration=-1;},x=>{x.githubDeploymentId=0;},x=>{x.extra=1;}]){
  const x=clone(r);mutate(x);denied(()=>validatePromotionRequest(x));
 }
});

test('release-marker/v1 and release-context/v1 shapes',()=>{
 const m={schema:'release-marker/v1',application:'demoapp',releaseTag:'v1.0.0',sourceCommit:SOURCE_COMMIT,artifactSha256:hex64('f')};
 validateReleaseMarker(m);
 validateReleaseMarker({...m,startedAt:'2026-10-15T00:00:00Z'},{runtime:true});
 denied(()=>validateReleaseMarker({...m,startedAt:'2026-10-15T00:00:00Z'}));
 denied(()=>validateReleaseMarker(m,{runtime:true}));
 validateReleaseContext(context());
 validateReleaseContext(context({ref:'refs/tags/v1.2.3'}));
 denied(()=>validateReleaseContext(context({ref:'refs/tags/v9.9.9'})));
 denied(()=>validateReleaseContext(context({ref:'refs/heads/feature'})));
});
