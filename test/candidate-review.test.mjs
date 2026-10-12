import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCandidateReview,engineeringGuide,canonical,hash} from '../src/candidate-review.mjs';

const sha=c=>c.repeat(40),hex=c=>c.repeat(64);
function fixture(){
 const source={repository:'susanbeasles/app',repositoryID:1,ownerID:215839550,commitSHA:sha('a'),sourceRef:'refs/heads/promotion/1/shadow',runID:3,runAttempt:1};
 const candidate={schema:'repoctl-source-candidate/v1',verified:true,repository:source.repository,repositoryID:1,commitSHA:source.commitSHA,treeSHA:sha('b'),sourceSHA:sha('c'),expectedMainParent:sha('d'),shadowRef:source.sourceRef,sourcePR:{number:2,repositoryID:1,headSHA:sha('c')},policyDigest:hex('e')};
 const reviewPolicy={styleGuideDigest:engineeringGuide.digest,styleGuideRevision:engineeringGuide.revision,styleGuidePath:engineeringGuide.path,reviewerAppID:11,reviewerInstallationID:12,reviewerActorID:13,privilegedAppIDs:[21],privilegedActorIDs:[22],allowBotApproval:true,requiresHumanReview:false};
 const documents=[{kind:'language',name:'javascript',revision:sha('f'),text:'Synthetic JavaScript policy; runtime checks required.'},{kind:'dependencies',name:'dependencies',revision:sha('f'),text:'Synthetic dependencies policy; pin exact hashes.'}].map(d=>({...d,digest:hash(d.text)}));
 const policy={repository:source.repository,repositoryID:1,ownerID:source.ownerID,policyDigest:hex('e'),reviewPolicy,runtime:{repository:'susanbeasles/workflow_depot',revision:sha('f')},applicablePolicy:{languages:['javascript'],frameworks:[],dependencyPolicyDigest:documents[1].digest,documents,rules:['no-merge-conflicts','no-control-characters']},maxAgeSeconds:300};
 const receipt={schema:'repoctl-source-scans/v1',repositoryID:1,commitSHA:sha('a'),treeSHA:sha('b'),policyDigest:hex('e'),inventoryDigest:hex('2'),tools:[]};
 const report=Buffer.from(canonical({receipt,fileInventory:[{path:'src/app.js',type:'file',size:Buffer.byteLength('export const value = 1;\n'),sha256:hash('export const value = 1;\n')}]}));
 let current=1000;const calls=[];
 const prior={verified:true,repositoryID:1,commitSHA:sha('a'),treeSHA:sha('b'),sourceSHA:sha('c'),baseSHA:sha('d'),sourcePRNumber:2,policyDigest:hex('e'),evidenceDigest:hex('4'),ciReceiptDigest:hex('5'),scanJobDigest:hex('6'),expiresAt:1200};
 const adapters={
  policy:{current:async()=>policy}, candidates:{verify:async()=>{calls.push('candidate');return {verified:true,candidate,candidateDigest:hash(canonical(candidate))};}},
  priorEvidence:{verify:async()=>{calls.push('prior');return prior;}}, scans:{verify:async()=>{calls.push('scans');return {verified:true,receipt};}},
  sourceReader:{read:async()=>{calls.push('source');return {commitSHA:sha('a'),baseSHA:sha('d'),treeSHA:sha('b'),files:[{path:'src/app.js',content:'export const value = 1;\n'}],baseline:[{path:'src/app.js',content:'export const value = 0;\n'}]};}},
  identity:{verify:async()=>{calls.push('identity');return {verified:true,commitSHA:sha('a'),appID:11,installationID:12,actorID:13};}},
  provider:{review:async input=>{calls.push('provider');return {verdict:'approved',findings:[],inputDigest:hash(canonical(input))};}},clock:()=>current
 };
 return {source,candidate,policy,receipt,prior,report,calls,adapters,setClock:v=>{current=v;},run:()=>createCandidateReview(adapters).review({source,scanReportBytes:report,scanReportDigest:hash(report)})};
}
test('exact candidate review follows verified gates and emits compatible independent receipt',async()=>{
 const f=fixture(),out=await f.run();assert.equal(out.state,'approved');assert.equal(out.receipt.schema,'repoctl-source-review/v1');assert.equal(out.receipt.commitSHA,f.source.commitSHA);assert.equal(out.receipt.humanReviewVerified,false);assert.equal(out.scanReceiptDigest,hash(canonical(f.receipt)));assert.equal(out.receiptDigest,hash(canonical(out.receipt)));assert.deepEqual(f.calls,['candidate','prior','scans','source','identity','provider','candidate']);
 assert.deepEqual(out.receipt.methods,['deterministic-style','security-tests','evidence-review']);
});
test('missing provider is explicit unavailable after deterministic evidence, never approved',async()=>{const f=fixture();delete f.adapters.provider;const out=await f.run();assert.equal(out.state,'unavailable');assert.equal(out.reason,'independent-review-provider-unavailable');assert.equal(out.receipt,undefined);});
test('invalid or stale automated evidence prevents source read and provider invocation',async()=>{
 for(const change of [f=>f.prior.commitSHA=sha('9'),f=>f.prior.expiresAt=999,f=>f.adapters.scans.verify=async()=>({verified:false}),f=>f.policy.reviewPolicy.styleGuideDigest=hex('8'),f=>f.policy.reviewPolicy.privilegedAppIDs.push(11)]){const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.calls.includes('provider'),false);assert.equal(f.calls.includes('source'),false);}
});
test('report tamper and duplicate JSON fail before scanner evidence verification',async()=>{const f=fixture();await assert.rejects(createCandidateReview(f.adapters).review({source:f.source,scanReportBytes:f.report,scanReportDigest:hex('7')}));const bytes=Buffer.from('{"receipt":{},"receipt":{}}');await assert.rejects(createCandidateReview(f.adapters).review({source:f.source,scanReportBytes:bytes,scanReportDigest:hash(bytes)}));assert.equal(f.calls.includes('scans'),false);});
test('deterministic finding blocks provider and is grounded in exact candidate line',async()=>{const f=fixture();f.adapters.sourceReader.read=async()=>({commitSHA:sha('a'),baseSHA:sha('d'),treeSHA:sha('b'),files:[{path:'src/app.js',content:'<<<<<<< HEAD\n'}],baseline:[]});const out=await f.run();assert.equal(out.state,'rejected');assert.equal(out.findings[0].path,'src/app.js');assert.equal(f.calls.includes('provider'),false);});
test('provider findings must cite exact lines and all medium findings block',async()=>{for(const quote of ['invented','export const value = 1;']){const f=fixture();f.adapters.provider.review=async input=>({verdict:'approved',findings:[{severity:'medium',summary:'Unsafe input',path:'src/app.js',line:1,quote}],inputDigest:hash(canonical(input))});if(quote==='invented')await assert.rejects(f.run());else assert.equal((await f.run()).state,'rejected');}});
test('source drift and expiry during asynchronous provider cannot emit receipt',async()=>{for(const expire of [true,false]){const f=fixture();f.adapters.provider.review=async input=>{if(expire)f.setClock(1300);else f.adapters.candidates.verify=async()=>({verified:true,candidate:{...f.candidate,expectedMainParent:sha('9')},candidateDigest:hex('0')});return {verdict:'approved',findings:[],inputDigest:hash(canonical(input))};};await assert.rejects(f.run());}});
test('independent identity and complete bounded source are mandatory',async()=>{for(const change of [f=>f.adapters.identity.verify=async()=>({verified:true,commitSHA:sha('a'),appID:21,installationID:12,actorID:13}),f=>f.adapters.sourceReader.read=async()=>({commitSHA:sha('a'),baseSHA:sha('d'),treeSHA:sha('b'),files:[{path:'../escape',content:'x'}],baseline:[]})]){const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.calls.includes('provider'),false);}});
test('engineering guide bytes have the independently located revision hash',()=>{assert.equal(createHash('sha256').update(engineeringGuide.text).digest('hex'),'e672eabc9538121bfd73edc9b685e9c7ce2dd3f1be1cccc31f984f0d9e9dd29d');assert.equal(engineeringGuide.path,'docs/code-style-guide.md');});
test('applicable policy includes exact versioned language/dependency text, and source matches scanned bytes',async()=>{
 for(const change of [f=>f.policy.applicablePolicy.documents[0].text='changed',f=>f.policy.applicablePolicy.documents.pop(),f=>f.adapters.sourceReader.read=async()=>({commitSHA:sha('a'),baseSHA:sha('d'),treeSHA:sha('b'),files:[{path:'src/app.js',content:'changed code\n'}],baseline:[]})]){const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.calls.includes('provider'),false);}
});
