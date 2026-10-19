import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync,rmSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {join} from 'node:path';
import {canonicalBytes} from '../src/shared/release-contract.mjs';
import {verifyRelease} from '../ci/release/verify-release.mjs';
import {createZip,readZip,crc32} from '../ci/release/zip.mjs';
import {writeChecksums} from '../ci/release/checksum-bundles.mjs';
import {assembleRelease} from '../ci/release/assemble-release.mjs';
import {releaseManifest} from '../ci/release/write-release-manifest.mjs';
import {buildWorkerBundle} from '../ci/release/build-worker-bundle.mjs';
import {bundleMigrations} from '../ci/release/bundle-migrations.mjs';
import {authorizationPolicy} from '../ci/release/write-authorization-policy.mjs';
import {makeApp,buildRelease,application,context,write,DEPOT,CREATED_AT,SOURCE_DATE_EPOCH} from './release-fixtures.mjs';

const hex=b=>createHash('sha256').update(b).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const SIGNATURE=JSON.stringify({mediaType:'application/vnd.dev.sigstore.bundle.v0.3+json',verificationMaterial:{},messageSignature:{}});

// Recompute every derived file after tampering with a bundle, as an attacker
// controlling the build directory would, so only deeper checks can catch it.
function reseal(out,{app=application(),ctx=context()}={}){
 for(const name of ['checksums.json','SHA256SUMS','release.zip','release.meta.json'])rmSync(join(out,name),{force:true});
 writeChecksums(out);assembleRelease(out);
 write(out,'release.meta.json',canonicalBytes(releaseManifest({releaseDir:out,application:app,context:ctx,depotRepository:DEPOT.repository,depotSha:DEPOT.sha,createdAt:CREATED_AT})));
}
function rezip(path,mutate){
 const entries=readZip(new Uint8Array(readFileSync(path)));
 writeFileSync(path,createZip(mutate(entries)));
}
async function withRelease(fn){
 const f=makeApp();
 try{await buildRelease(f);await fn(f);}finally{f.cleanup();}
}

test('a freshly built release verifies, including against the application manifest',async()=>{
 await withRelease(async f=>{
  const result=await verifyRelease(f.out,{application:application()});
  assert.equal(result.releaseTag,'v1.2.3');
  assert.equal(result.manifestSha256,hex(readFileSync(join(f.out,'release.meta.json'))));
  assert.equal(result.builderWorkflow,`${DEPOT.repository}/.github/workflows/release.yml@${DEPOT.sha}`);
  assert.deepEqual(result.targets.map(t=>t.id),['demoapp-d1-migrations','demoapp-worker']);
  const manifest=json(join(f.out,'release.meta.json'));
  assert.deepEqual(readZip(new Uint8Array(readFileSync(join(f.out,'release.zip')))).map(e=>e.name),['authorization-policy.json','checksums.json','sbom.cdx.json','sbom.spdx.json','targets/demoapp-d1-migrations.zip','targets/demoapp-worker.zip']);
  assert.equal(manifest.artifact.sha256,hex(readFileSync(join(f.out,'release.zip'))));
  const policy=json(join(f.out,'authorization-policy.json'));
  assert.equal(policy.signer.identity,`https://github.com/${manifest.builder.workflow}`);
  assert.equal(policy.expiresAt,'2027-10-15T12:00:00Z');
  assert.deepEqual(policy.environments.production,{allowedRefs:['refs/tags/v*'],requiredApprovals:1,targets:['demoapp-d1-migrations','demoapp-worker']});
 });
});

test('release.zip is reproducible from identical inputs',async()=>{
 const f=makeApp();
 try{
  await buildRelease(f);await buildRelease(f,{out:join(f.root,'second')});
  assert.ok(readFileSync(join(f.out,'release.zip')).equals(readFileSync(join(f.root,'second/release.zip'))));
 }finally{f.cleanup();}
});

test('tampering anywhere in the release is detected',async()=>{
 const cases={
  'tampered bundle byte':[/checksum mismatch: targets\/demoapp-worker.zip/,f=>{const p=join(f.out,'targets/demoapp-worker.zip'),b=readFileSync(p);b[40]^=1;writeFileSync(p,b);}],
  'tampered manifest target digest':[/digest mismatch for targets\/demoapp-worker.zip/,f=>{const m=json(join(f.out,'release.meta.json'));m.targets[1].sha256='0'.repeat(64);writeFileSync(join(f.out,'release.meta.json'),canonicalBytes(m));}],
  'manifest/checksums mismatch':[/checksums digest mismatch/,f=>{const m=json(join(f.out,'release.meta.json'));m.checksums.sha256='0'.repeat(64);writeFileSync(join(f.out,'release.meta.json'),canonicalBytes(m));}],
  'tampered release.zip digest':[/release.zip digest/,f=>{const m=json(join(f.out,'release.meta.json'));m.artifact.sha256='1'.repeat(64);writeFileSync(join(f.out,'release.meta.json'),canonicalBytes(m));}],
  'policy digest mismatch':[/authorization policy digest mismatch/,f=>{const m=json(join(f.out,'release.meta.json'));m.authorizationPolicy.sha256='2'.repeat(64);writeFileSync(join(f.out,'release.meta.json'),canonicalBytes(m));}],
  'SHA256SUMS edited':[/SHA256SUMS does not match/,f=>writeFileSync(join(f.out,'SHA256SUMS'),readFileSync(join(f.out,'SHA256SUMS'),'utf8').replace(/^./,'f'))],
  'checksums.json lies':[/checksum mismatch: authorization-policy.json/,f=>{
   const c=json(join(f.out,'checksums.json'));c.files['authorization-policy.json'].sha256='3'.repeat(64);
   writeFileSync(join(f.out,'checksums.json'),canonicalBytes(c));
   writeFileSync(join(f.out,'SHA256SUMS'),Object.keys(c.files).sort().map(p=>`${c.files[p].sha256}  ${p}\n`).join(''));}],
  'non-canonical manifest':[/not canonical/,f=>writeFileSync(join(f.out,'release.meta.json'),JSON.stringify(json(join(f.out,'release.meta.json')),null,2))],
  'duplicate key in manifest':[/duplicate key/,f=>writeFileSync(join(f.out,'release.meta.json'),readFileSync(join(f.out,'release.meta.json'),'utf8').replace('{"application":"demoapp",','{"application":"demoapp","application":"other",'))],
  'stray file':[/inventory mismatch \(unexpected: payload.sh/,f=>write(f.out,'payload.sh','echo hi')],
  'missing SBOM':[/missing: sbom.spdx.json/,f=>unlinkSync(join(f.out,'sbom.spdx.json'))],
  'symlink in release dir':[/symlink/,f=>{unlinkSync(join(f.out,'sbom.cdx.json'));symlinkSync('/etc/hostname',join(f.out,'sbom.cdx.json'));}],
  'release.zip differs from published files':[/release.zip entry differs from the published file: authorization-policy.json/,f=>{
   const p=json(join(f.out,'authorization-policy.json'));p.expiresAt='2027-01-01T00:00:00Z';writeFileSync(join(f.out,'authorization-policy.json'),canonicalBytes(p));
   rmSync(join(f.out,'checksums.json'));rmSync(join(f.out,'SHA256SUMS'));const zip=readFileSync(join(f.out,'release.zip'));rmSync(join(f.out,'release.zip'));rmSync(join(f.out,'release.meta.json'));
   writeChecksums(f.out);writeFileSync(join(f.out,'release.zip'),zip);
   const raw=readZip(new Uint8Array(zip)).map(e=>e.name==='checksums.json'?{name:e.name,data:new Uint8Array(readFileSync(join(f.out,'checksums.json')))}:e);
   writeFileSync(join(f.out,'release.zip'),createZip(raw));
   write(f.out,'release.meta.json',canonicalBytes(releaseManifest({releaseDir:f.out,application:application(),context:context(),depotRepository:DEPOT.repository,depotSha:DEPOT.sha,createdAt:CREATED_AT})));}],
  'unlisted asset smuggled into worker bundle':[/asset entries do not match/,f=>{rezip(join(f.out,'targets/demoapp-worker.zip'),e=>[...e,{name:'assets/evil.js',data:new TextEncoder().encode('steal()')}]);reseal(f.out);}],
  'asset bytes swapped':[/asset digest mismatch: index.html/,f=>{rezip(join(f.out,'targets/demoapp-worker.zip'),e=>e.map(x=>x.name==='assets/index.html'?{name:x.name,data:new TextEncoder().encode('<script>evil()</script>')}:x));reseal(f.out);}],
  'migration edited without ledger':[/migration digest mismatch: 0002_expand.sql/,f=>{rezip(join(f.out,'targets/demoapp-d1-migrations.zip'),e=>e.map(x=>x.name==='0002_expand.sql'?{name:x.name,data:new TextEncoder().encode('DROP TABLE records;')}:x));reseal(f.out);}],
  'ledger statement count forged':[/ledger entry disagrees/,f=>{rezip(join(f.out,'targets/demoapp-d1-migrations.zip'),e=>e.map(x=>{if(x.name!=='ledger.json')return x;const l=JSON.parse(new TextDecoder().decode(x.data));l.migrations[0].statements=9;return {name:x.name,data:canonicalBytes(l)};}));reseal(f.out);}],
  'worker artifact schema forged':[/wrong schema/,f=>{rezip(join(f.out,'targets/demoapp-worker.zip'),e=>e.map(x=>{if(x.name!=='artifact.json')return x;const a=JSON.parse(new TextDecoder().decode(x.data));a.schema='workflow-depot-worker-artifact/v9';return {name:x.name,data:canonicalBytes(a)};}));reseal(f.out);}],
  'policy health contract forged':[/authorization policy targets do not match/,f=>{
   const p=json(join(f.out,'authorization-policy.json'));p.targets['demoapp-worker'].healthContract='worker-version/v1';
   writeFileSync(join(f.out,'authorization-policy.json'),canonicalBytes(p));reseal(f.out);}],
  'policy drops a target':[/authorization policy targets do not match/,f=>{
   const p=json(join(f.out,'authorization-policy.json'));delete p.targets['demoapp-d1-migrations'];for(const e of Object.values(p.environments))e.targets=e.targets.filter(t=>t!=='demoapp-d1-migrations');
   writeFileSync(join(f.out,'authorization-policy.json'),canonicalBytes(p));reseal(f.out);}],
  'decompression bomb inside bundle':[/ratio exceeds 100x/,f=>{writeFileSync(join(f.out,'targets/demoapp-worker.zip'),bombZip());reseal(f.out);}],
 };
 for(const [name,[reason,mutate]] of Object.entries(cases)){
  const f=makeApp();
  try{await buildRelease(f);mutate(f);await assert.rejects(()=>verifyRelease(f.out),reason,name);}
  finally{f.cleanup();}
 }
});

function bombZip(){
 const data=Buffer.alloc(8*1024*1024),body=deflateRawSync(data),name=Buffer.from('artifact.json');
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);
 local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt16LE(33,14);
 central.writeUInt32LE(crc32(data),16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
 const cd=Buffer.concat([central,name]),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(30+name.length+body.length,16);
 return Buffer.concat([local,name,body,cd,end]);
}

test('cross-document identity checks: policy, signer, release marker and application',async()=>{
 const build=async(f,{policyCtx=context(),depotSha=DEPOT.sha,workerTag='v1.2.3'}={})=>{
  const app=application(),ctx=context();
  await buildWorkerBundle({appRoot:f.app,application:app,targetId:'demoapp-worker',wranglerOutdir:f.wranglerOut,outDir:f.out,releaseTag:workerTag,sourceCommit:ctx.sourceCommit});
  bundleMigrations({appRoot:f.app,application:app,targetId:'demoapp-d1-migrations',outDir:f.out});
  write(f.out,'authorization-policy.json',canonicalBytes(authorizationPolicy({application:app,context:policyCtx,depotRepository:DEPOT.repository,depotSha,clock:()=>Date.parse(CREATED_AT)})));
  reseal(f.out);
 };
 const cases={
  'policy for another tag':[/authorization policy releaseTag does not match/,{policyCtx:context({releaseTag:'v9.9.9'})}],
  'policy for another commit':[/authorization policy sourceCommit does not match/,{policyCtx:context({sourceCommit:'f'.repeat(40)})}],
  'policy signed by another workflow revision':[/signer does not match the release builder/,{depotSha:'c'.repeat(40)}],
  'release marker from another tag':[/release marker does not match/,{workerTag:'v9.9.9'}],
 };
 for(const [name,[reason,options]] of Object.entries(cases)){
  const f=makeApp();
  try{await build(f,options);await assert.rejects(()=>verifyRelease(f.out),reason,name);}finally{f.cleanup();}
 }
 await withRelease(async f=>{
  const app=application();app.targets[1].dependsOn=[];
  await assert.rejects(()=>verifyRelease(f.out,{application:app}),/targets do not match the application manifest/);
  const other=application();other.targets[0].build.binding='OTHER_DB';
  await assert.rejects(()=>verifyRelease(f.out,{application:other}),/ledger binding does not match/);
 });
});

test('signed stage requires structurally valid Sigstore bundles',async()=>{
 await withRelease(async f=>{
  await assert.rejects(()=>verifyRelease(f.out,{stage:'signed'}),/missing: release.zip.sigstore.json, release.meta.json.sigstore.json\)/);
  write(f.out,'release.zip.sigstore.json',SIGNATURE);
  write(f.out,'release.meta.json.sigstore.json',SIGNATURE);
  await assert.rejects(()=>verifyRelease(f.out),/unexpected: release.meta.json.sigstore.json/);
  assert.equal((await verifyRelease(f.out,{stage:'signed'})).releaseTag,'v1.2.3');
  writeFileSync(join(f.out,'release.zip.sigstore.json'),'{"not":"a bundle"}');
  await assert.rejects(()=>verifyRelease(f.out,{stage:'signed'}),/not a Sigstore bundle/);
  writeFileSync(join(f.out,'release.zip.sigstore.json'),'');
  await assert.rejects(()=>verifyRelease(f.out,{stage:'signed'}),/empty/);
  await assert.rejects(()=>verifyRelease(f.out,{stage:'published'}),/stage must be/);
 });
});

test('published layout verifies the GitHub Release asset set without loose bundles',async()=>{
 await withRelease(async f=>{
  for(const name of ['release.zip.sigstore.json','release.meta.json.sigstore.json'])write(f.out,name,SIGNATURE);
   const assets=join(f.root,'assets');
  for(const name of ['release.zip','release.zip.sigstore.json','release.meta.json','release.meta.json.sigstore.json','sbom.cdx.json','sbom.spdx.json','checksums.json','SHA256SUMS','authorization-policy.json'])
   write(assets,name,readFileSync(join(f.out,name)));
  const result=await verifyRelease(assets,{stage:'signed',layout:'published',application:application()});
  assert.deepEqual(result.targets.map(t=>t.id),['demoapp-d1-migrations','demoapp-worker']);
  await assert.rejects(()=>verifyRelease(assets,{stage:'unsigned',layout:'published'}),/layout must be/);
  await assert.rejects(()=>verifyRelease(assets,{stage:'signed'}),/missing: targets\/demoapp-d1-migrations.zip, targets\/demoapp-worker.zip/);
  write(assets,'targets/demoapp-worker.zip',readFileSync(join(f.out,'targets/demoapp-worker.zip')));
  await assert.rejects(()=>verifyRelease(assets,{stage:'signed',layout:'published'}),/unexpected: targets\/demoapp-worker.zip/);
  rmSync(join(assets,'targets'),{recursive:true});
  const zip=readFileSync(join(assets,'release.zip'));zip[zip.length-30]^=1;writeFileSync(join(assets,'release.zip'),zip);
  await assert.rejects(()=>verifyRelease(assets,{stage:'signed',layout:'published'}),/release.zip digest does not match/);
 });
});

test('future commit timestamp cannot extend authorization in generator or full verifier',async()=>{
 assert.throws(()=>authorizationPolicy({application:application(),context:context(),depotRepository:DEPOT.repository,depotSha:DEPOT.sha,sourceDateEpoch:4102444800,clock:()=>Date.parse(CREATED_AT)}),/source date epoch/);
 await withRelease(async f=>{
  const policy=json(join(f.out,'authorization-policy.json'));
  policy.expiresAt=new Date((4102444800+365*86400)*1000).toISOString().replace('.000Z','Z');
  write(f.out,'authorization-policy.json',canonicalBytes(policy));reseal(f.out);
  await assert.rejects(verifyRelease(f.out),/expiry must be positive and at most 400 days/);
 });
});
test('trusted release clock preserves default365 and maximum400 days',()=>{
 const base={application:application(),context:context(),depotRepository:DEPOT.repository,depotSha:DEPOT.sha,clock:()=>Date.parse(CREATED_AT)};
 for(const days of [365,400])assert.equal(Date.parse(authorizationPolicy({...base,validityDays:days}).expiresAt)-Date.parse(CREATED_AT),days*86400000);
 assert.throws(()=>authorizationPolicy({...base,validityDays:401}),/1..400/);
});

test('full verifier rejects substituting a future signed manifest creation time',async()=>{
 await withRelease(async f=>{
  const policy=json(join(f.out,'authorization-policy.json'));
  policy.expiresAt='2101-01-01T00:00:00Z';
  write(f.out,'authorization-policy.json',canonicalBytes(policy));reseal(f.out);
  const manifest=json(join(f.out,'release.meta.json'));manifest.createdAt='2100-01-01T00:00:00Z';
  writeFileSync(join(f.out,'release.meta.json'),canonicalBytes(manifest));
  await assert.rejects(verifyRelease(f.out),/future release creation time/);
 });
});
