import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {exportPrivateRelease} from '../ci/release/export-private-deployer.mjs';
import {createZip,readZip} from '../ci/release/zip.mjs';
import {canonicalBytes,parseJson} from '../src/shared/release-contract.mjs';
const hex=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const artifact={schema:'workflow-depot-worker-artifact/v2',metadata:{main_module:'worker.mjs',compatibility_date:'2026-10-08',compatibility_flags:['nodejs_compat'],bindings:[{name:'ENABLED',type:'plain_text',text:'false'},{name:'KEY',type:'inherit'}]},modules:[{name:'worker.mjs',type:'esm',content:'export default {};'}]};
 const bundle=createZip([{name:'artifact.json',data:canonicalBytes(artifact)}]);
 const policy=canonicalBytes({schema:'authorization-policy/v1',policyVersion:1,application:'signing-control',repository:'susanbeasles/signer',repositoryId:42,releasePrefix:'signing-control/',sourceCommit:'a'.repeat(40),releaseTag:'v1.0.0',signer:{issuer:'https://token.actions.githubusercontent.com',identity:'https://github.com/susanbeasles/workflow_depot/.github/workflows/release.yml@'+'b'.repeat(40)},targets:{signer:{adapter:'cloudflare-worker/v1',healthContract:'worker-version/v1'}},environments:{production:{allowedRefs:['refs/heads/main'],requiredApprovals:1,targets:['signer']}},expiresAt:'2026-10-20T00:00:00Z'}),checksums=canonicalBytes({schema:'release-checksums/v1',algorithm:'sha256',files:{'targets/signer.zip':{sha256:hex(bundle),sizeBytes:bundle.length},'authorization-policy.json':{sha256:hex(policy),sizeBytes:policy.length}}});
 const archive=createZip([{name:'targets/signer.zip',data:bundle},{name:'authorization-policy.json',data:policy},{name:'checksums.json',data:checksums}]);
 const manifest={schema:'release-manifest/v2',application:'signing-control',repository:'susanbeasles/signer',repositoryId:42,releaseTag:'v1.0.0',sourceCommit:'a'.repeat(40),createdAt:'2026-10-19T00:00:00Z',builder:{workflow:'susanbeasles/workflow_depot/.github/workflows/release.yml@'+'b'.repeat(40),runId:'1',runAttempt:'1'},artifact:{path:'release.zip',sha256:hex(archive),sizeBytes:archive.length,mediaType:'application/zip'},targets:[{id:'signer',adapter:'cloudflare-worker/v1',artifactPath:'targets/signer.zip',sha256:hex(bundle),sizeBytes:bundle.length,dependsOn:[],healthContract:'worker-version/v1'}],authorizationPolicy:{path:'authorization-policy.json',sha256:hex(policy)},checksums:{path:'checksums.json',sha256:hex(checksums)}};
 return {manifest,archive,artifact};
}
test('export produces deterministic private-subset documents and referenced modules',async()=>{
 const input=fixture(),a=await exportPrivateRelease(input),b=await exportPrivateRelease(input);
 assert.deepEqual(a.archive,b.archive);const entries=new Map(readZip(a.archive).map(e=>[e.name,e.data]));
 assert.deepEqual(parseJson(a.manifestBytes),a.manifest);
 assert.deepEqual(Object.keys(a.manifest).sort(),['schema','application','repository','repositoryId','releaseTag','sourceCommit','createdAt','artifact','targets'].sort());
 for(const field of ['schema','application','repository','repositoryId','releaseTag','sourceCommit'])assert.equal(a.manifest[field],input.manifest[field]);
 assert.deepEqual(a.manifest.artifact,{path:'release.zip',sha256:hex(a.archive),sizeBytes:a.archive.length,mediaType:'application/zip'});
 const target=a.manifest.targets[0],bytes=entries.get(target.artifactPath),artifact=parseJson(bytes);
 assert.equal(hex(bytes),target.sha256);assert.equal(hex(a.archive),a.manifest.artifact.sha256);
 assert.deepEqual(artifact,{schema:'worker-artifact/v1',mainModule:'worker.mjs',compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],modules:[{name:'worker.mjs',path:'targets/signer/modules/worker.mjs',type:'esm',sha256:hex(new TextEncoder().encode('export default {};'))}],bindings:['ENABLED','KEY']});
 assert.deepEqual(artifact.bindings,['ENABLED','KEY']);assert.equal(hex(entries.get(artifact.modules[0].path)),artifact.modules[0].sha256);
 assert.equal(a.manifest.targets[0].healthContract.kind,'worker-version/v1');assert.equal(entries.has('provenance/depot-release.meta.json'),true);
 assert.deepEqual(a.attestationSubjects,['release.zip','release.manifest.json']);
});
test('export refuses tamper, unsupported adapters and public health before conversion',async()=>{
 const input=fixture();await assert.rejects(exportPrivateRelease({...input,archive:new Uint8Array(input.archive.length)}));
 input.manifest.targets[0].healthContract='http-release-marker/v1';await assert.rejects(exportPrivateRelease(input),/private/);
 input.manifest.targets[0].adapter='cloudflare-d1-migrate/v1';delete input.manifest.targets[0].healthContract;input.manifest.targets[0].recoveryPolicy='forward-only';await assert.rejects(exportPrivateRelease(input),/private/);
});
test('export refuses infrastructure claims rather than silently dropping them',async()=>{
 const input=fixture();input.artifact.metadata.migrations={new_tag:'v1',new_sqlite_classes:['Key']};
 const bundle=createZip([{name:'artifact.json',data:canonicalBytes(input.artifact)}]);
 const entries=readZip(input.archive).map(e=>e.name==='targets/signer.zip'?{name:e.name,data:bundle}:e);
 const checksums=JSON.parse(new TextDecoder().decode(entries.find(e=>e.name==='checksums.json').data));checksums.files['targets/signer.zip']={sha256:hex(bundle),sizeBytes:bundle.length};entries.find(e=>e.name==='checksums.json').data=canonicalBytes(checksums);input.manifest.checksums.sha256=hex(canonicalBytes(checksums));input.archive=createZip(entries);Object.assign(input.manifest.artifact,{sha256:hex(input.archive),sizeBytes:input.archive.length});Object.assign(input.manifest.targets[0],{sha256:hex(bundle),sizeBytes:bundle.length});
 await assert.rejects(exportPrivateRelease(input),/infrastructure/);
});

test('export denies source-valid identities outside the accepted deployer subset',async()=>{const a=fixture();a.manifest.application='x';await assert.rejects(exportPrivateRelease(a),/deployer subset/);const b=fixture();b.manifest.targets[0].id='1';b.manifest.targets[0].artifactPath='targets/1.zip';await assert.rejects(exportPrivateRelease(b),/deployer subset/);});
