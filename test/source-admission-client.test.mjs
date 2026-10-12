import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {digest} from '../src/shared/contract.mjs';

const path=new URL('../src/candidate-admission-client.mjs',import.meta.url);
const source={repository:'susanbeasles/source',repositoryID:2,commitSHA:'f'.repeat(40),sourceRef:'refs/heads/int/feature',runID:50,runAttempt:1};
const env={ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/synthetic/idtoken?api-version=2.0',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-request-token'};
async function client(configured=true){let code=await readFile(path,'utf8');if(configured)code=code.replace("CANDIDATE_ADMISSION_ORIGIN = ''","CANDIDATE_ADMISSION_ORIGIN = 'https://build.vespoli.me'");return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}
async function proof(){const candidate={schema:'repoctl-source-candidate/v1',verified:true,repository:source.repository,repositoryID:source.repositoryID,commitSHA:source.commitSHA,shadowRef:source.sourceRef,treeSHA:'c'.repeat(40),sourceRef:'refs/heads/feature',sourceSHA:'a'.repeat(40),expectedMainParent:'b'.repeat(40),sourcePR:{number:3,repositoryID:source.repositoryID,headSHA:'a'.repeat(40)},sequence:1,signerKeyID:'d'.repeat(64),unsignedCommitDigest:'1'.repeat(64),artifactIntentDigest:'2'.repeat(64),policyDigest:'3'.repeat(64),sourceHistoryDigest:'4'.repeat(64)};return {verified:true,source,candidateDigest:await digest(candidate),candidate,reviewPolicy:null};}
function reviewPolicy(){
 const h='3'.repeat(64),sha='e'.repeat(40);
 return {repositoryID:source.repositoryID,commitSHA:source.commitSHA,policyDigest:h,policy:{repository:source.repository,repositoryID:source.repositoryID,ownerID:215839550,policyDigest:h,maxAgeSeconds:300,reviewPolicy:{styleGuideDigest:h,styleGuideRevision:sha,styleGuidePath:'docs/rules.md',reviewerAppID:10,reviewerInstallationID:11,reviewerActorID:12,privilegedAppIDs:[20],privilegedActorIDs:[21],allowBotApproval:true,requiresHumanReview:false},scanPolicy:{supportedLanguages:['javascript'],supportedFrameworks:[],requiredCategories:['inventory'],requiredTools:[{id:'inventory',category:'inventory',version:'synthetic',rulesetDigest:h,databaseMaxAgeSeconds:0}],exemptions:[],sonarqubeStandardRulesetDigest:h},priorJobs:{workflowID:1,workflowPath:'.github/workflows/build.yml',workflowDigest:h,jobWorkflowRef:'susanbeasles/workflow_depot/.github/workflows/orchestration.yml@'+sha,jobWorkflowSHA:sha,actorIDs:[215839550],requiredJobNames:['ci/scans'],scanJobName:'ci/scans',maxAgeSeconds:300,policyDigest:h},applicablePolicy:{languages:['javascript'],frameworks:[],dependencyPolicyDigest:h,documents:[{kind:'dependencies',name:'dependencies',revision:sha,digest:h,text:'Synthetic accepted dependency rules.'}],rules:['no-merge-conflicts']}}};
}
test('source-owned origin is unconfigured by default and cannot be supplied by application input',async()=>{
 const {verifySourceCandidate}=await client(false);let calls=0;
 await assert.rejects(verifySourceCandidate(source,{env:{...env,CANDIDATE_ADMISSION_ORIGIN:'https://attacker.example'},fetcher:async()=>{calls++;}}),/not commissioned/);assert.equal(calls,0);
});
test('client requests exact coordinate audience and sends only bounded candidate proof request',async()=>{
 const {verifySourceCandidate}=await client(),calls=[],expected=await proof();
 const result=await verifySourceCandidate(source,{env,fetcher:async(url,options)=>{calls.push({url:String(url),options});return Response.json(calls.length===1?{value:'synthetic-oidc-token'}:expected);}});
 assert.deepEqual(result,expected);assert.equal(calls.length,2);assert.equal(new URL(calls[0].url).searchParams.get('audience'),'workflow-depot-candidate:'+await digest(source));assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-request-token');
 assert.equal(calls[1].url,'https://build.vespoli.me/v1/candidates/verify');assert.deepEqual(JSON.parse(calls[1].options.body),{source,oidcToken:'synthetic-oidc-token'});assert.equal(calls[1].options.headers.Authorization,undefined);assert.equal(calls[1].options.redirect,'error');assert.ok(calls.every(c=>c.options.signal instanceof AbortSignal));
});
test('client rejects untrusted token URLs, malformed source, foreign proofs and private errors without leaking bodies',async()=>{
 const {verifySourceCandidate}=await client();let calls=0;
 for(const coordinates of [{...source,sourceRef:'refs/heads/main'},{...source,runID:'50'},{...source,sourceRef:'refs/heads/promotion/01/shadow'},{...source,extra:true}])await assert.rejects(verifySourceCandidate(coordinates,{env,fetcher:async()=>{calls++;}}));
 for(const url of ['http://pipelines.actions.githubusercontent.com/idtoken','https://pipelines.actions.githubusercontent.com.attacker.example/idtoken','https://user:secret@pipelines.actions.githubusercontent.com/idtoken'])await assert.rejects(verifySourceCandidate(source,{env:{...env,ACTIONS_ID_TOKEN_REQUEST_URL:url},fetcher:async()=>{calls++;}}));assert.equal(calls,0);
 for(const change of [r=>({...r,extra:true}),r=>({...r,candidateDigest:'0'.repeat(64)}),r=>({...r,source:{...source,runAttempt:2}}),r=>({...r,candidate:{...r.candidate,commitSHA:'0'.repeat(40)}}),r=>({...r,candidate:{...r.candidate,extra:'private-secret'}})]){
  calls=0;await assert.rejects(verifySourceCandidate(source,{env,fetcher:async()=>Response.json(++calls===1?{value:'synthetic-token'}:change(await proof()))}),/^Error: Candidate admission failed$/);
 }
 for(const bad of [()=>new Response('private-secret-provider-body',{status:403}),()=>new Response(' '.repeat(512*1024+1)),()=>{throw Error('private-secret-transport');}]){
  calls=0;await assert.rejects(verifySourceCandidate(source,{env,fetcher:async()=>++calls===1?Response.json({value:'synthetic-token'}):bad()}),/^Error: Candidate admission failed$/);
 }
});
test('nullable accepted review policy is strictly bound to this source and proof without runtime self-pins',async()=>{
 const {verifySourceCandidate}=await client();
 async function request(value){let calls=0;return verifySourceCandidate(source,{env,fetcher:async()=>Response.json(++calls===1?{value:'synthetic-token'}:{...await proof(),reviewPolicy:value})});}
 assert.deepEqual((await request(reviewPolicy())).reviewPolicy,reviewPolicy());assert.equal((await request(null)).reviewPolicy,null);
 for(const mutate of [v=>v.repositoryID++,v=>v.commitSHA='0'.repeat(40),v=>v.policyDigest='0'.repeat(64),v=>v.policy.repository='other/source',v=>v.policy.policyDigest='0'.repeat(64),v=>v.policy.runtime={revision:'e'.repeat(40)},v=>v.policy.provider={credential:'forbidden'},v=>v.policy.priorJobs.jobWorkflowRef=v.policy.priorJobs.jobWorkflowRef.replace('workflow_depot','attacker'),v=>v.policy.priorJobs.jobWorkflowSHA='0'.repeat(40),v=>v.policy.priorJobs.policyDigest='0'.repeat(64),v=>v.policy.priorJobs.requiredJobNames=['different'],v=>v.policy.priorJobs.actorIDs=[0],v=>v.policy.maxAgeSeconds=86401,v=>v.policy.applicablePolicy.documents[0].text='x'.repeat(256*1024)]){
  const value=reviewPolicy();mutate(value);await assert.rejects(request(value),/^Error: Candidate admission failed$/);
 }
});
test('actual source-admission job embeds exactly the reviewed shared client and invokes no application code',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/orchestration.yml',import.meta.url),'utf8'),module=await readFile(path,'utf8');
 const block=workflow.match(/^  source-admission:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n)/m)?.[0];assert.ok(block);assert.match(block,/id-token: write/);assert.doesNotMatch(block,/checkout@|setup-node@|secrets\.|vars\.|inputs\.(?!candidate_sha)|npm |yarn /);
 const script=block.match(/node --input-type=module <<'JS'\n([\s\S]*?)          JS/)[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
 const embedded=module.replace(/^export /gm,'').trim();assert.ok(script.includes(embedded),'inline implementation matches the reusable client byte-for-byte');
 const configured=script.replace("CANDIDATE_ADMISSION_ORIGIN = ''","CANDIDATE_ADMISSION_ORIGIN = 'https://build.vespoli.me'").replace("await import('node:fs')","modules.fs");
 const outputs=[],expected=await proof();let calls=0;
 await vm.runInNewContext(`(async()=>{${configured}\n})()`,{process:{env:{...env,SOURCE_EVENT:'push',SOURCE_OWNER_ID:'215839550',SOURCE_REPOSITORY:source.repository,SOURCE_REPOSITORY_ID:'2',SOURCE_SHA:source.commitSHA,CANDIDATE_SHA:source.commitSHA,SOURCE_REF:source.sourceRef,SOURCE_RUN_ID:'50',SOURCE_RUN_ATTEMPT:'1',GITHUB_OUTPUT:'synthetic'}},modules:{fs:{appendFileSync:(path,value)=>outputs.push(value)}},crypto,TextEncoder,TextDecoder,URL,AbortSignal,fetch:async()=>Response.json(++calls===1?{value:'synthetic-token'}:expected),console:{log(){}}});
 assert.deepEqual(outputs,['candidate_digest='+expected.candidateDigest+'\npolicy_digest='+expected.candidate.policyDigest+'\ntree_sha='+expected.candidate.treeSHA+'\n']);assert.equal(calls,2);
 assert.match(block,/policy_digest: \$\{\{ steps.admission.outputs.policy_digest \}\}/);assert.match(block,/tree_sha: \$\{\{ steps.admission.outputs.tree_sha \}\}/);
});
test('caller delegates OIDC only to trusted reusable jobs and application jobs explicitly remove it',async()=>{
 const caller=await readFile(new URL('../templates/app-ci.yml',import.meta.url),'utf8'),workflow=await readFile(new URL('../.github/workflows/orchestration.yml',import.meta.url),'utf8');
 assert.match(caller,/candidate:\n    permissions:\n      contents: read\n      actions: read\n      checks: read\n      id-token: write\n    uses: susanbeasles\/workflow_depot\/\.github\/workflows\/orchestration.yml@REVIEWED_DEPOT_SHA/);
 for(const job of ['setup','checks']){
  const block=workflow.match(new RegExp('^  '+job+':\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n)','m'))?.[0];assert.ok(block);assert.match(block,/permissions:\n      contents: read\n/);assert.doesNotMatch(block,/id-token:/);
 }
});
