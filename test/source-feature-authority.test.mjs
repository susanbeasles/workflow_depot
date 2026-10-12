import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,sha256,canonical} from '../src/shared/contract.mjs';
const module=await import('../src/source-feature-authority.mjs').catch(()=>({}));
const hash=c=>c.repeat(64),sha=c=>c.repeat(40),keyID='SHA256:'+'A'.repeat(43);
function storage(){const rows=new Map();let tail=Promise.resolve();return {rows,get:async key=>structuredClone(rows.get(key)),transaction(fn){const p=tail.then(async()=>{const next=new Map(rows);const value=await fn({get:async k=>structuredClone(next.get(k)),put:async(k,v)=>next.set(k,structuredClone(v))});rows.clear();for(const row of next)rows.set(...row);return value;});tail=p.catch(()=>{});return p;}};}
async function request(){const value={schema:'signing-control-feature-request/v1',repositoryID:7,repository:'susanbeasles/source',baseSHA:sha('a'),treeSHA:sha('b'),featureRef:'refs/heads/feat/example',message:'Exact feature intent\n',author:'Fixture <fixture@example.invalid> 1000 +0000',committer:'Fixture <fixture@example.invalid> 1000 +0000',nonce:hash('c'),expiresAt:1100,signerKeyID:keyID};value.unsignedCommit=`tree ${value.treeSHA}\nparent ${value.baseSHA}\nauthor ${value.author}\ncommitter ${value.committer}\n\n${value.message}`;value.objectDigest=await sha256(new TextEncoder().encode(value.unsignedCommit));return value;}
async function intentDigest(r){const {nonce,expiresAt,...intent}=r;return digest(intent);}
async function fixture(){
 assert.equal(typeof module.createSourceFeatureAuthority,'function','feature authority must exist');
 let now=1000;const r=await request(),db=storage();
 const policy={schema:'workflow-depot-source-feature-policy/v1',revision:1,enabled:true,repository:r.repository,repositoryID:7,ownerID:8,signerKeyID:keyID,featureRefs:[{ref:r.featureRef,parentRef:'refs/heads/main',mode:'create'}],identities:{authors:['Fixture <fixture@example.invalid>'],committers:['Fixture <fixture@example.invalid>']},producer:{type:'retained-intents',id:'configured-source-producer',intentDigests:[await intentDigest(r)],expiresAt:1200}};
 let parent=r.baseSHA,target=null,reads=0,afterRead=()=>{};
 const github={async repository(){reads++;await afterRead();return {id:7,full_name:r.repository,owner:{id:8},archived:false,fork:false,default_branch:'main'};},async ref(_repository,ref){reads++;await afterRead();return ref==='refs/heads/main'?parent:target;},async commit(){reads++;await afterRead();return {sha:r.baseSHA};}};
 const api=module.createSourceFeatureAuthority({storage:db,policy:()=>policy,github,now:()=>now});
 return {api,r,policy,db,github,reads:()=>reads,setTime:v=>now=v,setParent:v=>parent=v,setTarget:v=>target=v,onRead:f=>afterRead=f};
}
test('private retained exact intent produces one automatic grant without content-safety claims',async()=>{
 const f=await fixture(),grant=await f.api.admitRetainedFeature({request:f.r});
 assert.deepEqual(Object.keys(grant).sort(),['authorized','requestDigest','policyDigest','signerKeyID','producerID','producerEvidenceDigest','grantID','expiresAt'].sort());
 assert.equal(grant.authorized,true);assert.equal(grant.requestDigest,await digest(f.r));assert.equal(grant.policyDigest,await digest(f.policy));assert.equal(grant.signerKeyID,keyID);assert.equal(grant.producerID,f.policy.producer.id);assert.equal(grant.expiresAt,1100);
 assert.deepEqual(await f.api.authorizeFeatureCommit(f.r),grant);
 assert.deepEqual(await f.api.current({repositoryID:7}),{authority:'workflow_depot',repositoryID:7,repository:f.r.repository,signerKeyID:keyID,policyDigest:await digest(f.policy)});
 assert.deepEqual(await f.api.consumeFeatureCommit({request:f.r,grantID:grant.grantID}),grant);
 assert.deepEqual(await f.api.checkFeatureCommit({request:f.r,grantID:grant.grantID}),grant);
 assert.equal(JSON.stringify([...f.db.rows.values()]).includes('closureDigest'),false);
});
test('retained admission is unavailable on public producer route and disabled policy denies before reads',async()=>{
 const f=await fixture();await assert.rejects(f.api.admitFeature({request:f.r,producerEvidence:{approved:true}}));assert.equal(f.reads(),0);
 f.policy.enabled=false;await assert.rejects(f.api.admitRetainedFeature({request:f.r}));assert.equal(f.reads(),0);assert.equal(f.db.rows.size,0);
});
test('unlisted or noncanonical payload, wrong repo/ref/key/identities and authority extras deny',async()=>{
 for(const change of [r=>r.message='Changed\n',r=>r.unsignedCommit+='extra',r=>r.objectDigest=hash('d'),r=>r.repositoryID=8,r=>r.featureRef='refs/heads/main',r=>r.signerKeyID='SHA256:'+'B'.repeat(43),r=>r.author='Other <other@example.invalid> 1000 +0000',r=>r.approved=true,r=>r.treeSHA=sha('d')]){
  const f=await fixture();change(f.r);await assert.rejects(f.api.admitRetainedFeature({request:f.r}));assert.equal(f.db.rows.size,0);
 }
});
test('current authoritative parent, target ref, repository owner and parent existence must match',async()=>{
 for(const change of [f=>f.setParent(sha('d')),f=>f.setTarget(sha('d')),f=>f.github.repository=async()=>({id:7,full_name:f.r.repository,owner:{id:99},archived:false,fork:false,default_branch:'main'}),f=>f.github.commit=async()=>({sha:sha('d')})]){const f=await fixture();change(f);await assert.rejects(f.api.admitRetainedFeature({request:f.r}));assert.equal(f.db.rows.size,0);}
});
test('fresh nonce or expiry cannot reuse the same retained intent',async()=>{
 const f=await fixture();await f.api.admitRetainedFeature({request:f.r});f.r={...f.r,nonce:hash('d'),expiresAt:1090};await assert.rejects(f.api.admitRetainedFeature({request:f.r}));
});
test('concurrent admission and consumption each allow exactly one transition',async()=>{
 const f=await fixture();const admitted=await Promise.allSettled([1,2].map(()=>f.api.admitRetainedFeature({request:f.r})));assert.equal(admitted.filter(x=>x.status==='fulfilled').length,1);const grant=admitted.find(x=>x.status==='fulfilled').value;
 const results=await Promise.allSettled([1,2].map(()=>f.api.consumeFeatureCommit({request:f.r,grantID:grant.grantID})));assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(f.api.authorizeFeatureCommit(f.r));await assert.rejects(f.api.consumeFeatureCommit({request:f.r,grantID:grant.grantID}));
});
test('changed request or grant cannot consume, and pre-consumption check is denied',async()=>{
 const f=await fixture(),g=await f.api.admitRetainedFeature({request:f.r});await assert.rejects(f.api.checkFeatureCommit({request:f.r,grantID:g.grantID}));
 await assert.rejects(f.api.consumeFeatureCommit({request:{...f.r,nonce:hash('e')},grantID:g.grantID}));await assert.rejects(f.api.consumeFeatureCommit({request:f.r,grantID:hash('d')}));assert.deepEqual(await f.api.consumeFeatureCommit({request:f.r,grantID:g.grantID}),g);
});
test('policy revocation, parent drift and expiration block after admission and after consumption',async()=>{
 for(const mutate of [f=>f.policy.enabled=false,f=>f.policy.revision++,f=>f.setParent(sha('e')),f=>f.setTarget(sha('e')),f=>f.setTime(1100)]){
  for(const consumed of [false,true]){const f=await fixture(),g=await f.api.admitRetainedFeature({request:f.r});if(consumed)await f.api.consumeFeatureCommit({request:f.r,grantID:g.grantID});mutate(f);await assert.rejects(consumed?f.api.checkFeatureCommit({request:f.r,grantID:g.grantID}):f.api.consumeFeatureCommit({request:f.r,grantID:g.grantID}));}
 }
});
test('expiry and policy mutation during authoritative reads never return a usable grant',async()=>{
 for(const effect of [f=>f.setTime(1100),f=>f.policy.revision++]){const f=await fixture();f.onRead(()=>effect(f));await assert.rejects(f.api.admitRetainedFeature({request:f.r}));assert.equal(f.db.rows.size,0);}
});
test('response-loss consumption stays spent and retained lookup never extends lifetime',async()=>{
 const f=await fixture(),g=await f.api.admitRetainedFeature({request:f.r});f.setTime(1050);assert.equal((await f.api.authorizeFeatureCommit(f.r)).expiresAt,1100);await f.api.consumeFeatureCommit({request:f.r,grantID:g.grantID});await assert.rejects(f.api.consumeFeatureCommit({request:f.r,grantID:g.grantID}));
});
test('private authorization can automatically materialize a frozen intent, never after it is spent',async()=>{
 const f=await fixture(),g=await f.api.authorizeFeatureCommit(f.r);assert.equal(g.authorized,true);assert.deepEqual(await f.api.authorizeFeatureCommit(f.r),g);await f.api.consumeFeatureCommit({request:f.r,grantID:g.grantID});await assert.rejects(f.api.authorizeFeatureCommit(f.r));
});
test('production producer adapter reuses real GitHub OIDC request audience and exact workflow identity',async()=>{
 assert.equal(typeof module.createFeatureOIDCProducer,'function');
 const trust={audiencePrefix:'workflow-depot-feature',repository:'susanbeasles/workflow_depot',repositoryID:9,ownerID:8,ref:'refs/heads/main',workflowRef:'susanbeasles/workflow_depot/.github/workflows/producer.yml@refs/heads/main',workflowSHA:sha('d'),jobWorkflowRef:'susanbeasles/workflow_depot/.github/workflows/producer-job.yml@'+sha('e'),jobWorkflowSHA:sha('e'),eventNames:['workflow_dispatch'],actorIDs:[8]};
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey);jwk.kid='synthetic';
 const claims={iss:'https://token.actions.githubusercontent.com',aud:'workflow-depot-feature:'+hash('a'),iat:990,nbf:990,exp:1100,jti:'fixture-jti-123',repository:trust.repository,repository_id:'9',repository_owner_id:'8',ref:trust.ref,workflow_ref:trust.workflowRef,workflow_sha:trust.workflowSHA,job_workflow_ref:trust.jobWorkflowRef,job_workflow_sha:trust.jobWorkflowSHA,runner_environment:'github-hosted',run_id:'12',run_attempt:'1',event_name:'workflow_dispatch',actor_id:'8'};
 async function token(value){const part=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),input=part({alg:'RS256',kid:'synthetic'})+'.'+part(value);return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(input))).toString('base64url');}
 const verifier=module.createFeatureOIDCProducer({trust,jwks:async()=>({keys:[jwk]}),now:()=>1000});
 const evidence={oidcToken:await token(claims),runID:12,runAttempt:1};const proof=await verifier.verify({requestDigest:hash('a'),evidence});assert.equal(proof.verified,true);assert.equal(proof.requestDigest,hash('a'));assert.equal(proof.authenticationID,claims.jti);assert.equal(proof.expiresAt,1100);assert.equal(JSON.stringify(proof).includes(evidence.oidcToken),false);
 for(const change of [c=>c.aud='workflow-depot-feature:'+hash('b'),c=>c.runner_environment='self-hosted',c=>c.actor_id='99',c=>c.job_workflow_sha=sha('f'),c=>c.exp=999]){const altered={...claims};change(altered);await assert.rejects(verifier.verify({requestDigest:hash('a'),evidence:{...evidence,oidcToken:await token(altered)}}));}
});
