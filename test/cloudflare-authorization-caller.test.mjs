import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical,digest} from '../src/shared/contract.mjs';
import {createDeploymentAuthority} from '../src/deployment-authority.mjs';
const path=new URL('../scripts/request-cloudflare-authorization.mjs',import.meta.url);
const caller=existsSync(path)?await import(path):{};
const hash=x=>createHash('sha256').update(x).digest('hex');
const token='synthetic.oidc.token';
function fixture(){
 const operation={schema:'workflow-depot-cloudflare-deploy/v1',operationID:'1'.repeat(64),nonce:'2'.repeat(64),policyDigest:'3'.repeat(64),artifactDigest:'4'.repeat(64),metadataDigest:'5'.repeat(64),accountID:'6'.repeat(32),scriptName:'fixture-worker',zoneID:'7'.repeat(32),hostname:'app.example.com',expectedDeploymentID:'11111111-1111-4111-8111-111111111111',source:{repository:'susanbeasles/fixture',repositoryID:3,commitSHA:'a'.repeat(40),signerKeyID:'8'.repeat(64),signingReceiptDigest:'9'.repeat(64),ciRunID:9,ciRunAttempt:1},execution:{runID:42,runAttempt:2},expiresAt:1500};
 const env={GITHUB_REPOSITORY:'susanbeasles/workflow_depot',GITHUB_REPOSITORY_ID:'1405415683',GITHUB_REPOSITORY_OWNER_ID:'215839550',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'b'.repeat(40),GITHUB_WORKFLOW_REF:'susanbeasles/workflow_depot/.github/workflows/authorize-cloudflare.yml@refs/heads/main',GITHUB_WORKFLOW_SHA:'b'.repeat(40),GITHUB_RUN_ID:'51',GITHUB_RUN_ATTEMPT:'1',ACTIONS_ID_TOKEN_REQUEST_URL:'https://run.actions.githubusercontent.com/idtoken?api-version=2.0',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'SYNTHETIC-REQUEST-BEARER'};
 const raw=canonical(operation),calls=[];
 const fetcher=async(url,options)=>{calls.push({url:String(url),options});return Response.json(String(url).startsWith('https://run.actions.')?{value:token}:{operationID:operation.operationID,state:'authorized'});};
 return {operation,raw,operationDigest:hash(raw),env,calls,fetcher,clock:()=>1000,config:{...caller.CONFIG,enabled:true}};
}
test('bounded authorization caller is implemented',()=>assert.equal(typeof caller.authorize,'function'));
test('authorizer sends exact operation, separate execution run, and current authorizer identity',async()=>{
 const f=fixture();const receipt=await caller.authorize(f);
 assert.deepEqual(receipt,{operationID:f.operation.operationID,state:'authorized'});
 assert.equal(f.calls.length,2);assert.equal(new URL(f.calls[0].url).searchParams.get('audience'),'workflow-depot-deployment-authorizer:'+f.operation.operationID);
 assert.equal(f.calls[1].url,'https://pipeline.vespoli.me/v1/deployments/authorize');
 assert.deepEqual(JSON.parse(f.calls[1].options.body),{operation:f.operation,oidcToken:token,authorizerRunID:51,authorizerRunAttempt:1});
 for(const call of f.calls){assert.equal(call.options.redirect,'error');assert.ok(call.options.signal instanceof AbortSignal);}
 assert.ok(!JSON.stringify(receipt).includes(token));
});
for(const [key,value] of [['GITHUB_REPOSITORY_ID','9'],['GITHUB_REPOSITORY_OWNER_ID','9'],['GITHUB_EVENT_NAME','pull_request'],['GITHUB_REF','refs/heads/evil'],['GITHUB_WORKFLOW_SHA','c'.repeat(40)],['GITHUB_RUN_ATTEMPT','0']])test('rejects untrusted context '+key+' before OIDC',async()=>{const f=fixture();f.env[key]=value;await assert.rejects(caller.authorize(f));assert.equal(f.calls.length,0);});
test('disabled constants, mismatched digest, duplicate fields, and expired operations fail before OIDC',async()=>{
 for(const alter of [f=>f.config.enabled=false,f=>f.operationDigest='0'.repeat(64),f=>{f.raw=f.raw.replace('"schema":','"operationID":"'+f.operation.operationID+'","schema":');f.operationDigest=hash(f.raw);},f=>{f.operation.expiresAt=999;f.raw=canonical(f.operation);f.operationDigest=hash(f.raw);}]){const f=fixture();alter(f);await assert.rejects(caller.authorize(f));assert.equal(f.calls.length,0);}
});
test('untrusted OIDC host cannot receive request bearer',async()=>{const f=fixture();f.env.ACTIONS_ID_TOKEN_REQUEST_URL='https://attacker.example/id';await assert.rejects(caller.authorize(f));assert.equal(f.calls.length,0);});
test('lost authorization response is not retried and secret error bodies are suppressed',async()=>{
 const f=fixture();f.fetcher=async(url,options)=>{f.calls.push(String(url));if(f.calls.length===1)return Response.json({value:token});throw Error('SYNTHETIC-PRIVATE');};
 await assert.rejects(caller.authorize(f),/^Error: Cloudflare authorization request unavailable$/);assert.equal(f.calls.length,2);
});
test('oversized or changed responses never become authorization receipts',async()=>{
 for(const value of [{value:'x'.repeat(40000)},{operationID:'0'.repeat(64),state:'authorized'},{operationID:'1'.repeat(64),state:'authorized',token:'SYNTHETIC'}]){const f=fixture();let n=0;f.fetcher=async()=>Response.json(++n===1&& !Object.hasOwn(value,'value')?{value:token}:value);await assert.rejects(caller.authorize(f));}
});
test('dispatch uses same-commit reusable job and only trusted repository checkout',()=>{
 const outer=readFileSync(new URL('../.github/workflows/authorize-cloudflare.yml',import.meta.url),'utf8'),inner=readFileSync(new URL('../.github/workflows/cloudflare-authorizer.yml',import.meta.url),'utf8');
 assert.match(outer,/uses: \.\/\.github\/workflows\/cloudflare-authorizer\.yml/);assert.match(inner,/ref: \$\{\{ github\.sha \}\}/);assert.match(inner,/persist-credentials: false/);assert.match(inner,/node-version: '24'/);assert.doesNotMatch(outer+inner,/secrets:|CLOUDFLARE_API_TOKEN|pull_request_target|npm install/);
 assert.match(inner,/if: github\.repository == 'susanbeasles\/workflow_depot'.*github\.workflow_ref == 'susanbeasles\/workflow_depot\/\.github\/workflows\/authorize-cloudflare\.yml@refs\/heads\/main'/);
});
test('real retained authority checks exact target, policy digest and evidence before accepting caller',async()=>{
 for(const change of [null,op=>op.hostname='unapproved.example.com',op=>op.policyDigest='0'.repeat(64),op=>op.source.commitSHA='f'.repeat(40)]){
  const f=fixture(),records=new Map(),trust={repository:'susanbeasles/workflow_depot',repositoryID:1405415683,ownerID:215839550,actorIDs:[215839550],eventNames:['workflow_dispatch'],ref:'refs/heads/main',workflowRef:f.env.GITHUB_WORKFLOW_REF,workflowSHA:f.env.GITHUB_SHA,jobWorkflowRef:'susanbeasles/workflow_depot/.github/workflows/cloudflare-authorizer.yml@refs/heads/main',jobWorkflowSHA:f.env.GITHUB_SHA,audiencePrefix:'workflow-depot-deployment-authorizer'};
  const policy={schema:'workflow-depot-cloudflare-policy/v1',revision:1,enabled:true,authorizer:trust,executor:{...trust,repository:'susanbeasles/delivery_control',repositoryID:1405415291,workflowRef:'susanbeasles/delivery_control/.github/workflows/execute-cloudflare.yml@refs/heads/main',jobWorkflowRef:'susanbeasles/delivery_control/.github/workflows/cloudflare-executor.yml@refs/heads/main',audiencePrefix:'delivery-control-cloudflare-deployer'},targets:[{accountID:f.operation.accountID,scriptName:f.operation.scriptName,zoneID:f.operation.zoneID,hostname:f.operation.hostname,metadataDigest:f.operation.metadataDigest,sourceRepository:f.operation.source.repository,sourceRepositoryID:f.operation.source.repositoryID}],maxArtifactBytes:5242880,verification:{signerKeyIDs:[f.operation.source.signerKeyID],ciWorkflowRef:'susanbeasles/fixture/.github/workflows/ci.yml@refs/heads/main',ciWorkflowSHA:'c'.repeat(40),requiredJobs:['test']}};
  f.operation.policyDigest=await digest(policy);const expected=structuredClone(f.operation);
  const storage={get:async key=>records.get(key),put:async(key,value)=>records.set(key,value),transaction:async fn=>fn(storage)};
  const authority=createDeploymentAuthority({storage,policy:()=>policy,now:f.clock,jwks:async()=>({keys:[]}),verifyIdentity:async(value,t,binding)=>{
   if(value===token){assert.equal(t.repository,'susanbeasles/workflow_depot');assert.equal(binding.runID,51);return {jti:'synthetic-authorizer-jti',expiresAt:1600,runID:'51',runAttempt:'1'};}
   assert.equal(t.repository,'susanbeasles/delivery_control');assert.equal(binding.runID,42);assert.equal(binding.runAttempt,2);assert.ok(['synthetic.polling.token','synthetic.execution.token'].includes(value));return {jti:value==='synthetic.polling.token'?'synthetic-status-jti':'synthetic-consume-jti',expiresAt:1600,runID:'42',runAttempt:'2'};
  },evidence:{verify:async op=>({verified:op.source.commitSHA===expected.source.commitSHA,operationID:op.operationID,artifactDigest:expected.artifactDigest,sourceSHA:expected.source.commitSHA})}});
  if(change)change(f.operation);f.raw=canonical(f.operation);f.operationDigest=hash(f.raw);
  f.fetcher=async(url,options)=>String(url).startsWith('https://run.actions.')?Response.json({value:token}):Response.json(await authority.authorize(JSON.parse(options.body)));
  if(change){await assert.rejects(caller.authorize(f));assert.equal(records.size,0);}else{
   assert.equal((await caller.authorize(f)).state,'authorized');assert.deepEqual(records.get('op:'+f.operation.operationID).operation,f.operation);
   assert.deepEqual(await authority.status({operationID:f.operation.operationID,oidcToken:'synthetic.polling.token',runID:42,runAttempt:2}),{operationID:f.operation.operationID,state:'authorized'});
   await assert.rejects(authority.status({operationID:f.operation.operationID,oidcToken:'synthetic.polling.token',runID:42,runAttempt:3}));
   const grant=await authority.consume({operationID:f.operation.operationID,oidcToken:'synthetic.execution.token'});assert.deepEqual(grant.operation.execution,{runID:42,runAttempt:2});
   assert.ok(records.has('jti:'+hash('synthetic-consume-jti')));assert.ok(!records.has('jti:'+hash('synthetic-status-jti')));
   await assert.rejects(authority.consume({operationID:f.operation.operationID,oidcToken:'synthetic.execution.token'}));
  }
 }
});
test('operation expiry during OIDC retrieval blocks authorization POST',async()=>{const f=fixture();let now=1000;f.clock=()=>now;f.fetcher=async url=>{f.calls.push(String(url));now=1600;return Response.json({value:token});};await assert.rejects(caller.authorize(f));assert.equal(f.calls.length,1);});
