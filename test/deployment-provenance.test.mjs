import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDeploymentProvenance,createCandidateAdmission} from '../src/deployment-provenance.mjs';
import {digest,sha256,validatePolicy} from '../src/shared/contract.mjs';
import {verifyOIDC} from '../src/shared/oidc.mjs';

function storage(){const values=new Map();let tail=Promise.resolve();return {get:async k=>structuredClone(values.get(k)),transaction(fn){const result=tail.then(async()=>{const next=new Map(values),value=await fn({get:async k=>structuredClone(next.get(k)),put:async(k,v)=>next.set(k,structuredClone(v))});values.clear();for(const entry of next)values.set(...entry);return value;});tail=result.catch(()=>{});return result;}};}
function trust(repository){return {audiencePrefix:'deployment',repository,repositoryID:1,ownerID:215839550,ref:'refs/heads/main',workflowRef:repository+'/.github/workflows/deploy.yml@refs/heads/main',workflowSHA:'a'.repeat(40),jobWorkflowRef:repository+'/.github/workflows/deploy.yml@'+'a'.repeat(40),jobWorkflowSHA:'a'.repeat(40),eventNames:['workflow_dispatch'],actorIDs:[215839550]};}
async function fixture(overrides={}){
 const artifact=JSON.stringify({schema:'workflow-depot-worker-artifact/v1',metadata:{main_module:'worker.mjs',compatibility_date:'2026-10-12',compatibility_flags:[],bindings:[]},modules:[{name:'worker.mjs',type:'esm',content:'export default {fetch(){return new Response("test")}}'}]});
 const metadataDigest=await digest(JSON.parse(artifact).metadata),artifactDigest=await sha256(new TextEncoder().encode(artifact));
 const policy={schema:'workflow-depot-cloudflare-policy/v1',revision:1,enabled:true,authorizer:trust('susanbeasles/workflow_depot'),executor:trust('susanbeasles/delivery_control'),targets:[{accountID:'a'.repeat(32),scriptName:'existing-worker',zoneID:'b'.repeat(32),hostname:'app.vespoli.me',metadataDigest,sourceRepository:'susanbeasles/source',sourceRepositoryID:2}],maxArtifactBytes:5242880,verification:{signerKeyIDs:['d'.repeat(64)],ciWorkflowRef:'susanbeasles/workflow_depot/.github/workflows/build-cloudflare.yml@'+'e'.repeat(40),ciWorkflowSHA:'e'.repeat(40),requiredJobs:['build']}};
 const input={artifact,source:{repository:'susanbeasles/source',repositoryID:2,commitSHA:'f'.repeat(40),sourceRef:'refs/heads/promotion/1/shadow',runID:50,runAttempt:1},oidcToken:'synthetic-builder-token'};
 const blobs=new Map(),calls=[];let now=1000,putEffect=async()=>{},githubEffect=value=>value;
 const artifacts={async put(key,bytes,options){calls.push({key,options});await putEffect();if(blobs.has(key))return null;blobs.set(key,bytes.slice());return {etag:'synthetic'};},async get(key){const value=blobs.get(key);return value?{size:value.length,arrayBuffer:async()=>value.slice().buffer}:null;}};
 const github={async read(repository,path){assert.equal(repository,input.source.repository);return githubEffect(path===''?{id:2,full_name:repository,archived:false,fork:false,default_branch:'main',owner:{id:215839550}}:path==='/git/ref/heads/main'?{object:{sha:'b'.repeat(40)}}:path.startsWith('/git/ref/heads/promotion/')?{object:{sha:input.source.commitSHA}}:{sha:input.source.commitSHA,parents:[{sha:'b'.repeat(40)}],tree:{sha:'c'.repeat(40)},verification:{verified:true,reason:'valid'}});}};
 const candidates={async lookupCandidate(){return {schema:'repoctl-source-candidate/v1',verified:true,repository:input.source.repository,repositoryID:2,commitSHA:input.source.commitSHA,treeSHA:'c'.repeat(40),sourceRef:'refs/heads/feature',sourceSHA:'a'.repeat(40),expectedMainParent:'b'.repeat(40),shadowRef:input.source.sourceRef,sourcePR:{number:3,repositoryID:2,headSHA:'a'.repeat(40)},sequence:1,signerKeyID:policy.verification.signerKeyIDs[0],unsignedCommitDigest:'1'.repeat(64),artifactIntentDigest:'2'.repeat(64),policyDigest:'3'.repeat(64),sourceHistoryDigest:'4'.repeat(64)};}};
 const identities=[];
 const dependencies={storage:storage(),artifacts,policy:()=>policy,github,candidates,now:()=>now,jwks:async()=>({keys:[]}),verifyIdentity:async(token,t,binding)=>{identities.push({token,trust:t,binding});if(token==='wrong')throw Error('private-body');return {jti:token,expiresAt:1090,runID:String(binding.runID),runAttempt:String(binding.runAttempt),workflowSHA:t.jobWorkflowSHA};},...overrides};
 const provenance=createDeploymentProvenance(dependencies);
 return {provenance,dependencies,input,policy,artifactDigest,metadataDigest,blobs,calls,identities,candidates,setTime:v=>{now=v;},setPut:f=>{putEffect=f;},setGithub:f=>{githubEffect=f;}};
}
test('artifact staging binds exact bytes, source identity and pinned build workflow',async()=>{
 const f=await fixture();assert.deepEqual(await f.provenance.stage(f.input),{artifactDigest:f.artifactDigest,metadataDigest:f.metadataDigest,state:'retained'});
 assert.deepEqual(f.calls[0].options.onlyIf,{etagDoesNotMatch:'*'});
 assert.equal(new TextDecoder().decode(f.blobs.get('artifacts/sha256/'+f.artifactDigest+'.json')),f.input.artifact);
 assert.deepEqual(await f.provenance.lookup({artifactDigest:f.artifactDigest}),{schema:'workflow-depot-build-provenance/v1',repository:f.input.source.repository,repositoryID:2,sourceSHA:f.input.source.commitSHA,sourceRef:f.input.source.sourceRef,artifactDigest:f.artifactDigest,metadataDigest:f.metadataDigest,runID:50,runAttempt:1,workflowRef:f.policy.verification.ciWorkflowRef,workflowSHA:f.policy.verification.ciWorkflowSHA});
 const identity=f.identities[0];assert.equal(identity.trust.audiencePrefix,'workflow-depot-build');assert.equal(identity.trust.workflowSHA,f.input.source.commitSHA);assert.equal(identity.trust.workflowRef,'susanbeasles/source/.github/workflows/build.yml@refs/heads/promotion/1/shadow');assert.equal(identity.binding.operationID,f.artifactDigest);
});
test('unqualified source, unsigned commit and foreign metadata fail before artifact writes',async()=>{
 for(const change of [f=>{f.input.source.repositoryID=3;},f=>{f.input.oidcToken='wrong';},f=>{f.setGithub(value=>({...value,verification:{verified:false}}));},f=>{f.input.artifact=f.input.artifact.replace('2026-10-12','2026-10-11');},f=>{f.policy.verification.ciWorkflowRef='susanbeasles/source/.github/workflows/build.yml@refs/heads/promotion/1/shadow';}]){
  const f=await fixture();change(f);await assert.rejects(f.provenance.stage(f.input));assert.equal(f.calls.length,0);
 }
});
test('concurrent staging reserves one immutable provenance record',async()=>{
 const f=await fixture();const outcomes=await Promise.allSettled([f.provenance.stage(f.input),f.provenance.stage(f.input)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.length,1);
 f.input.source.runID=51;await assert.rejects(f.provenance.stage(f.input));assert.equal((await f.provenance.lookup({artifactDigest:f.artifactDigest})).runID,50);
});
test('post-reservation failure is uncertain and cannot replay or qualify',async()=>{
 const f=await fixture();f.setPut(async()=>{throw Error('sensitive R2 body');});await assert.rejects(f.provenance.stage(f.input));
 await assert.rejects(f.provenance.lookup({artifactDigest:f.artifactDigest}));await assert.rejects(f.provenance.stage(f.input));assert.equal(f.calls.length,1);
});
test('expiry and policy drift during object write cannot qualify staged bytes',async()=>{
 for(const change of [f=>f.setTime(1090),f=>{f.policy.revision++;},f=>{f.policy.enabled=false;}]){
  const f=await fixture();f.setPut(async()=>change(f));await assert.rejects(f.provenance.stage(f.input));await assert.rejects(f.provenance.lookup({artifactDigest:f.artifactDigest}));
 }
});
test('conditional creation verifies existing bytes and never overwrites a collision',async()=>{
 for(const matching of [true,false]){
  const f=await fixture(),existing=new TextEncoder().encode(matching?f.input.artifact:'wrong bytes');f.blobs.set('artifacts/sha256/'+f.artifactDigest+'.json',existing);
  if(matching)await f.provenance.stage(f.input);else await assert.rejects(f.provenance.stage(f.input));
  assert.deepEqual(f.blobs.get('artifacts/sha256/'+f.artifactDigest+'.json'),existing);
 }
});
test('real builder OIDC requires the pinned reusable workflow and exact artifact audience',async()=>{
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='synthetic-builder';
 const f=await fixture({verifyIdentity:verifyOIDC,jwks:async()=>({keys:[jwk]})});
 async function signed(extra={}){const s=f.input.source,p=f.policy;const claims={iss:'https://token.actions.githubusercontent.com',aud:'workflow-depot-build:'+f.artifactDigest,exp:1090,nbf:990,iat:990,repository:s.repository,repository_id:String(s.repositoryID),repository_owner_id:'215839550',ref:s.sourceRef,workflow_ref:s.repository+'/.github/workflows/build.yml@'+s.sourceRef,workflow_sha:s.commitSHA,job_workflow_ref:p.verification.ciWorkflowRef,job_workflow_sha:p.verification.ciWorkflowSHA,runner_environment:'github-hosted',run_id:'50',run_attempt:'1',actor_id:'215839550',event_name:'push',jti:'synthetic-builder-identity',...extra};const body=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');return body+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(body))).toString('base64url');}
 for(const extra of [{aud:'workflow-depot-build:'+'0'.repeat(64)},{job_workflow_sha:'0'.repeat(40)},{event_name:'pull_request'},{runner_environment:'self-hosted'}]){f.input.oidcToken=await signed(extra);await assert.rejects(f.provenance.stage(f.input));assert.equal(f.calls.length,0);}
 f.input.oidcToken=await signed();assert.equal((await f.provenance.stage(f.input)).state,'retained');
});
async function worker(){
 let source=await readFile(new URL('../src/deployment-provenance-worker.mjs',import.meta.url),'utf8');
 source=source.replace("import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';",'class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}; class DurableObject extends WorkerEntrypoint {}');
 for(const file of ['deployment-provenance','deployment-evidence'])source=source.replace("'./"+file+".mjs'",JSON.stringify(new URL('../src/'+file+'.mjs',import.meta.url).href));
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
test('staging public surface excludes lookup and deployment approval and remains disabled by default',async()=>{
 const w=await worker();for(const path of ['/v1/artifacts/lookup','/v1/deployments/authorize']){
  const response=await w.default.fetch(new Request('https://build.vespoli.me'+path,{method:'POST',body:'{}'}),{});assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'no-store');
 }
 const response=await w.default.fetch(new Request('https://build.vespoli.me/v1/artifacts',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{ENABLED:'false'});assert.equal(response.status,503);
 const config=JSON.parse(await readFile(new URL('../deployment/wrangler.provenance.jsonc',import.meta.url),'utf8'));
 assert.equal(config.vars.ENABLED,'false');assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.routes,[]);
});
test('staging rejects oversized bodies before storage and sanitizes private failures',async()=>{
 const w=await worker(),f=await fixture();let calls=0;
 const env={ENABLED:'true',DEPLOYMENT_POLICY_JSON:JSON.stringify(f.policy),DEPLOYMENT_ARTIFACTS:{},SOURCE_CANDIDATES:{lookupCandidate(){}},BUILD_PROVENANCE_STATE:{idFromName:name=>name,get:()=>({fetch:async()=>{calls++;throw Error('private-secret-body');}})}};
 const send=body=>w.default.fetch(new Request('https://build.vespoli.me/v1/artifacts',{method:'POST',headers:{'content-type':'application/json'},body}),env);
 const oversized=await send(' '.repeat(6*1024*1024+1));assert.equal(oversized.status,413);assert.equal(calls,0);
 const denied=await send('{}');assert.equal(denied.status,403);assert.doesNotMatch(await denied.text(),/private-secret-body/);assert.equal(calls,1);
});
test('staging accepts only numbered pre-main shadow refs with independent candidate proof',async()=>{
 for(const sourceRef of ['refs/heads/main','refs/heads/feature','refs/heads/promotion/0/shadow','refs/heads/promotion/01/shadow','refs/heads/promotion/9007199254740992/shadow']){
  const f=await fixture();f.input.source.sourceRef=sourceRef;await assert.rejects(f.provenance.stage(f.input));assert.equal(f.calls.length,0);
 }
 for(const field of ['repositoryID','commitSHA','expectedMainParent','treeSHA','signerKeyID','shadowRef']){
  const f=await fixture(),read=f.candidates.lookupCandidate;f.candidates.lookupCandidate=async()=>({...await read(),[field]:field==='repositoryID'?999:'invalid'});await assert.rejects(f.provenance.stage(f.input));assert.equal(f.calls.length,0);
 }
 await assert.rejects(fixture({candidates:undefined}),/evidence-required/);
});
test('candidate or main movement during object storage cannot produce ready provenance',async()=>{
 for(const mutate of [f=>{const read=f.candidates.lookupCandidate;f.candidates.lookupCandidate=async()=>({...await read(),sourceHistoryDigest:'9'.repeat(64)});},f=>{f.setGithub(v=>v.object?.sha==='b'.repeat(40)?{object:{sha:f.input.source.commitSHA}}:v);}]){
  const f=await fixture();f.setPut(async()=>mutate(f));await assert.rejects(f.provenance.stage(f.input));await assert.rejects(f.provenance.lookup({artifactDigest:f.artifactDigest}));assert.equal(f.calls.length,1);
 }
});
test('read-only candidate admission binds canonical coordinates and returns independent proof without storage writes',async()=>{
 const module=await import('../src/deployment-provenance.mjs');assert.equal(typeof module.createCandidateAdmission,'function');
 const f=await fixture();f.policy.verification.ciWorkflowRef=f.policy.verification.ciWorkflowRef.replace('build-cloudflare.yml','orchestration.yml');
 const admission=module.createCandidateAdmission({...f.dependencies,storage:{transaction(){throw Error('read admission must not write');}},artifacts:{put(){throw Error('read admission must not upload');}}});
 const source=structuredClone(f.input.source),result=await admission.verify({source,oidcToken:'synthetic-admission-token'});
 assert.deepEqual(result.source,source);assert.equal(result.verified,true);assert.equal(result.candidateDigest,await digest(result.candidate));assert.equal(result.candidate.commitSHA,source.commitSHA);
 assert.equal(f.identities[0].binding.operationID,await digest(source));assert.equal(f.identities[0].trust.audiencePrefix,'workflow-depot-candidate');assert.equal(f.calls.length,0);
 for(const mutation of [p=>{p.verification.ciWorkflowRef=p.verification.ciWorkflowRef.replace('@'+'e'.repeat(40),'@refs/heads/main');},p=>{p.verification.ciWorkflowRef=p.verification.ciWorkflowRef.replace('orchestration.yml','unapproved.yml');}]){
  const other=await fixture();other.policy.verification.ciWorkflowRef=other.policy.verification.ciWorkflowRef.replace('build-cloudflare.yml','orchestration.yml');mutation(other.policy);await assert.rejects(module.createCandidateAdmission(other.dependencies).verify({source:other.input.source,oidcToken:'synthetic'}));
 }
});
async function admissionFixture(){
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='synthetic-admission';
 const f=await fixture({verifyIdentity:verifyOIDC,jwks:async()=>({keys:[jwk]})});
 f.policy.verification.ciWorkflowRef=f.policy.verification.ciWorkflowRef.replace('build-cloudflare.yml','orchestration.yml');
 f.sign=async(extra={},time=1000)=>{
  const s=f.input.source,p=f.policy,claims={iss:'https://token.actions.githubusercontent.com',aud:'workflow-depot-candidate:'+await digest(s),exp:time+90,nbf:time-10,iat:time-10,repository:s.repository,repository_id:String(s.repositoryID),repository_owner_id:'215839550',ref:s.sourceRef,workflow_ref:s.repository+'/.github/workflows/build.yml@'+s.sourceRef,workflow_sha:s.commitSHA,job_workflow_ref:p.verification.ciWorkflowRef,job_workflow_sha:p.verification.ciWorkflowSHA,runner_environment:'github-hosted',run_id:'50',run_attempt:'1',actor_id:'215839550',event_name:'push',jti:'synthetic-admission-identity',...extra};
  const body=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(body))).toString('base64url');
 };
 f.jwk=jwk;f.admission=createCandidateAdmission(f.dependencies);return f;
}
test('real RSA admission accepts only the two pinned shared jobs and exact source/run/audience identity',async()=>{
 const f=await admissionFixture(),source=f.input.source;
 for(const jobWorkflowRef of [f.policy.verification.ciWorkflowRef,f.policy.verification.ciWorkflowRef.replace('orchestration.yml','review-candidate.yml')]){
  const oidcToken=await f.sign({job_workflow_ref:jobWorkflowRef});assert.equal((await f.admission.verify({source,oidcToken})).verified,true);
 }
 for(const extra of [{aud:'workflow-depot-build:'+'0'.repeat(64)},{repository:'other/source'},{repository_id:'3'},{repository_owner_id:'1'},{workflow_sha:'0'.repeat(40)},{ref:'refs/heads/main'},{workflow_ref:'susanbeasles/source/.github/workflows/other.yml@'+source.sourceRef},{job_workflow_ref:f.policy.verification.ciWorkflowRef.replace('orchestration.yml','attacker.yml')},{job_workflow_sha:'0'.repeat(40)},{runner_environment:'self-hosted'},{event_name:'pull_request'},{run_id:'51'},{run_attempt:'2'},{actor_id:'1'},{exp:1000}]){
  await assert.rejects(f.admission.verify({source,oidcToken:await f.sign(extra)}),/^Error: Candidate admission denied$/);
 }
 for(const extra of [{source:{...source,runAttempt:2}},{source:{...source,sourceRef:'refs/heads/main'}},{artifact:'unwanted'},{workflowRef:f.policy.verification.ciWorkflowRef}])await assert.rejects(f.admission.verify({source,oidcToken:await f.sign(),...extra}));
 assert.equal(f.calls.length,0);
});
test('candidate admission rejects proof, policy, source movement and expiry while reading',async()=>{
 for(const mutation of [f=>{f.policy.revision++;},f=>{f.policy.enabled=false;},f=>f.setTime(1090),f=>f.setGithub(v=>v.object?.sha==='b'.repeat(40)?{object:{sha:'0'.repeat(40)}}:v),f=>{const read=f.candidates.lookupCandidate;f.candidates.lookupCandidate=async()=>({...await read(),sourceHistoryDigest:'9'.repeat(64)});}]){
  const f=await fixture();f.policy.verification.ciWorkflowRef=f.policy.verification.ciWorkflowRef.replace('build-cloudflare.yml','orchestration.yml');
  const read=f.candidates.lookupCandidate;let reads=0;f.candidates.lookupCandidate=async()=>{const value=await read();if(++reads===1)mutation(f);return value;};
  await assert.rejects(createCandidateAdmission(f.dependencies).verify({source:f.input.source,oidcToken:'synthetic-admission'}));assert.equal(f.calls.length,0);
 }
 const f=await fixture();f.policy.verification.ciWorkflowRef=f.policy.verification.ciWorkflowRef.replace('build-cloudflare.yml','orchestration.yml');
 const read=f.candidates.lookupCandidate;f.candidates.lookupCandidate=async()=>({...await read(),signerKeyID:'0'.repeat(64)});
 await assert.rejects(createCandidateAdmission(f.dependencies).verify({source:f.input.source,oidcToken:'synthetic-admission'}));
});
test('nondeploying repositories use authoritative candidate enrollment without a Cloudflare target',async()=>{
 for(const emptyTargets of [false,true]){
  const f=await admissionFixture();f.input.source.repository='susanbeasles/library';if(emptyTargets)f.policy.targets=[];
  const input={source:f.input.source,oidcToken:await f.sign()};
  assert.equal((await f.admission.verify(input)).candidate.repository,'susanbeasles/library');
  if(emptyTargets)assert.throws(()=>validatePolicy(f.policy));
  await assert.rejects(f.provenance.stage({...f.input,oidcToken:'synthetic-builder-token'}));assert.equal(f.calls.length,0);
  f.candidates.lookupCandidate=async()=>{throw Error('source repository is not independently enrolled');};
  await assert.rejects(f.admission.verify(input),/^Error: Candidate admission denied$/);
 }
});
async function acceptedReviewMetadata(f){
 const c=await f.candidates.lookupCandidate(),s=f.input.source,h=c.policyDigest,sha=f.policy.verification.ciWorkflowSHA;
 return {repositoryID:s.repositoryID,commitSHA:s.commitSHA,policyDigest:h,policy:{repository:s.repository,repositoryID:s.repositoryID,ownerID:215839550,policyDigest:h,maxAgeSeconds:300,reviewPolicy:{styleGuideDigest:h,styleGuideRevision:sha,styleGuidePath:'docs/rules.md',reviewerAppID:10,reviewerInstallationID:11,reviewerActorID:12,privilegedAppIDs:[20],privilegedActorIDs:[21],allowBotApproval:true,requiresHumanReview:false},scanPolicy:{supportedLanguages:['javascript'],supportedFrameworks:[],requiredCategories:['inventory'],requiredTools:[{id:'inventory',category:'inventory',version:'synthetic',rulesetDigest:h,databaseMaxAgeSeconds:0}],exemptions:[],sonarqubeStandardRulesetDigest:h},priorJobs:{workflowID:1,workflowPath:'.github/workflows/build.yml',workflowDigest:h,jobWorkflowRef:f.policy.verification.ciWorkflowRef,jobWorkflowSHA:sha,actorIDs:[215839550],requiredJobNames:['ci/scans'],scanJobName:'ci/scans',maxAgeSeconds:300,policyDigest:h},applicablePolicy:{languages:['javascript'],frameworks:[],dependencyPolicyDigest:h,documents:[{kind:'dependencies',name:'dependencies',revision:sha,digest:h,text:'Synthetic accepted dependency rules.'}],rules:['no-merge-conflicts']}}};
}
test('accepted review metadata is optional, immutable and bound to the same proof and pinned workflow',async()=>{
 const f=await fixture();f.policy.verification.ciWorkflowRef=f.policy.verification.ciWorkflowRef.replace('build-cloudflare.yml','orchestration.yml');
 const admission=createCandidateAdmission(f.dependencies),input={source:f.input.source,oidcToken:'synthetic-admission'},expected=await acceptedReviewMetadata(f);
 assert.equal((await admission.verify(input)).reviewPolicy,null);
 f.candidates.lookupReviewPolicy=async()=>null;assert.equal((await admission.verify(input)).reviewPolicy,null);
 const coordinates=[];f.candidates.lookupReviewPolicy=async value=>{coordinates.push(value);return structuredClone(expected);};
 assert.deepEqual((await admission.verify(input)).reviewPolicy,expected);assert.equal(coordinates.length,2);assert.deepEqual(coordinates[0],{repositoryID:2,commitSHA:f.input.source.commitSHA,shadowRef:f.input.source.sourceRef});
 for(const mutate of [v=>v.commitSHA='0'.repeat(40),v=>v.policyDigest='0'.repeat(64),v=>v.policy.ownerID=1,v=>{v.policy.priorJobs.jobWorkflowSHA='0'.repeat(40);v.policy.priorJobs.jobWorkflowRef=v.policy.priorJobs.jobWorkflowRef.replace('e'.repeat(40),'0'.repeat(40));},v=>v.policy.runtime={revision:'e'.repeat(40)},v=>v.policy.provider={credential:'forbidden'}]){
  const changed=structuredClone(expected);mutate(changed);f.candidates.lookupReviewPolicy=async()=>changed;await assert.rejects(admission.verify(input),/^Error: Candidate admission denied$/);
 }
 f.candidates.lookupReviewPolicy=async()=>{throw Error('private accepted policy mismatch');};await assert.rejects(admission.verify(input),/^Error: Candidate admission denied$/);
 let reads=0;f.candidates.lookupReviewPolicy=async()=>++reads===1?structuredClone(expected):null;await assert.rejects(admission.verify(input));
 f.candidates.lookupReviewPolicy=async()=>{f.setTime(1090);return structuredClone(expected);};await assert.rejects(admission.verify(input));assert.equal(f.calls.length,0);
});
test('public candidate route uses real OIDC and private proof binding without DO/R2 access',async()=>{
 const f=await admissionFixture(),w=await worker(),time=Math.floor(Date.now()/1000),prior=globalThis.fetch;
 const env={ENABLED:'true',DEPLOYMENT_POLICY_JSON:JSON.stringify(f.policy),SOURCE_CANDIDATES:f.candidates};let calls=0;
 globalThis.fetch=async url=>{
  calls++;if(String(url)==='https://token.actions.githubusercontent.com/.well-known/jwks')return Response.json({keys:[f.jwk]});
  const base='https://api.github.com/repos/'+f.input.source.repository;assert.ok(String(url).startsWith(base));return Response.json(await f.dependencies.github.read(f.input.source.repository,String(url).slice(base.length)));
 };
 try{
  const send=(body,configured=env)=>w.default.fetch(new Request('https://build.vespoli.me/v1/candidates/verify',{method:'POST',headers:{'content-type':'application/json'},body}),configured);
  const response=await send(JSON.stringify({source:f.input.source,oidcToken:await f.sign({},time)}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).candidate.commitSHA,f.input.source.commitSHA);assert.ok(calls>=9);
  // Exercise the actual reusable client through this same Worker/binding path;
  // only GitHub transport and signing keys are synthetic fixtures.
  const clientSource=(await readFile(new URL('../src/candidate-admission-client.mjs',import.meta.url),'utf8')).replace("CANDIDATE_ADMISSION_ORIGIN = ''","CANDIDATE_ADMISSION_ORIGIN = 'https://build.vespoli.me'");
  const {verifySourceCandidate}=await import('data:text/javascript;base64,'+Buffer.from(clientSource).toString('base64'));
  const admitted=await verifySourceCandidate(f.input.source,{env:{ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/synthetic',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-request-token'},fetcher:async(url,options)=>{
   if(new URL(url).hostname==='pipelines.actions.githubusercontent.com'){
    assert.equal(new URL(url).searchParams.get('audience'),'workflow-depot-candidate:'+await digest(f.input.source));return Response.json({value:await f.sign({},time)});
   }
   assert.equal(url,'https://build.vespoli.me/v1/candidates/verify');return w.default.fetch(new Request(url,options),env);
  }});
  assert.equal(admitted.candidateDigest,await digest(await f.candidates.lookupCandidate()));
  const accepted=await acceptedReviewMetadata(f);f.candidates.lookupReviewPolicy=async()=>structuredClone(accepted);
  const withPolicy=await send(JSON.stringify({source:f.input.source,oidcToken:await f.sign({},time)}));assert.equal(withPolicy.status,200);assert.deepEqual((await withPolicy.json()).reviewPolicy,accepted);
  const before=calls;assert.equal((await send(' '.repeat(32769))).status,413);assert.equal(calls,before);
  assert.equal((await send('{}',{...env,SOURCE_CANDIDATES:undefined})).status,503);
  assert.equal((await send('{}',{...env,ENABLED:'false'})).status,503);
  const denied=await send(JSON.stringify({source:f.input.source,oidcToken:'private-secret-token'}));assert.equal(denied.status,403);assert.doesNotMatch(await denied.text(),/private-secret/);
 }finally{globalThis.fetch=prior;}
});
