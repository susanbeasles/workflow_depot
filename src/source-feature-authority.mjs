import {canonical,digest,sha256} from './shared/contract.mjs';
import {validateTrust,verifyOIDC,githubJWKS} from './shared/oidc.mjs';

const encoder=new TextEncoder(),HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const REF=/^refs\/heads\/(?:feat|fix|feature)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const KEY=/^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/;
const deny=()=>{throw Error('Source feature authorization denied');};
const need=value=>{if(!value)deny();};
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join()===keys.slice().sort().join();
const positive=value=>Number.isSafeInteger(value)&&value>0;
const snapshot=(value,limit=32768)=>{const raw=canonical(value);need(encoder.encode(raw).length<=limit);return JSON.parse(raw);};
const identity=value=>typeof value==='string'&&value.length<=300&&/^[^<>\r\n\x00-\x1f\x7f]+ <[^<>\s]+>$/.test(value);

export function validateFeaturePolicy(value){
 const p=snapshot(value,65536);
 need(exact(p,['schema','revision','enabled','repository','repositoryID','ownerID','signerKeyID','featureRefs','identities','producer'])&&p.schema==='workflow-depot-source-feature-policy/v1'&&positive(p.revision)&&typeof p.enabled==='boolean');
 need(typeof p.repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository)&&positive(p.repositoryID)&&positive(p.ownerID)&&matches(KEY,p.signerKeyID));
 need(Array.isArray(p.featureRefs)&&p.featureRefs.length>0&&p.featureRefs.length<=100);
 const refs=new Set();for(const rule of p.featureRefs){need(exact(rule,['ref','parentRef','mode'])&&matches(REF,rule.ref)&&rule.ref.length<=240&&!refs.has(rule.ref)&&['create','append'].includes(rule.mode));refs.add(rule.ref);need(rule.parentRef==='refs/heads/main'||matches(REF,rule.parentRef));need(rule.mode!=='append'||rule.parentRef===rule.ref);}
 need(exact(p.identities,['authors','committers']));for(const values of Object.values(p.identities))need(Array.isArray(values)&&values.length>0&&values.length<=100&&values.every(identity)&&new Set(values).size===values.length);
 if(p.producer?.type==='retained-intents'){
  need(exact(p.producer,['type','id','intentDigests','expiresAt'])&&matches(ID,p.producer.id)&&positive(p.producer.expiresAt)&&Array.isArray(p.producer.intentDigests)&&p.producer.intentDigests.length>0&&p.producer.intentDigests.length<=100&&p.producer.intentDigests.every(v=>matches(HASH,v))&&new Set(p.producer.intentDigests).size===p.producer.intentDigests.length);
 }else{
  need(exact(p.producer,['type','trust'])&&p.producer.type==='github-oidc');validateTrust(p.producer.trust);need(p.producer.trust.audiencePrefix==='workflow-depot-feature'&&p.producer.trust.eventNames.length===1&&p.producer.trust.eventNames[0]==='workflow_dispatch');
 }
 return p;
}

export async function featureIntentDigest(request){const {nonce,expiresAt,...intent}=request;return digest(intent);}
export async function validateFeatureRequest(value,policy,now){
 const r=snapshot(value);
 need(exact(r,['schema','repositoryID','repository','baseSHA','treeSHA','featureRef','message','author','committer','nonce','expiresAt','unsignedCommit','objectDigest','signerKeyID'])&&r.schema==='signing-control-feature-request/v1');
 need(r.repositoryID===policy.repositoryID&&r.repository===policy.repository&&r.signerKeyID===policy.signerKeyID&&matches(SHA,r.baseSHA)&&matches(SHA,r.treeSHA)&&matches(HASH,r.nonce)&&matches(HASH,r.objectDigest));
 need(policy.featureRefs.some(rule=>rule.ref===r.featureRef)&&positive(r.expiresAt)&&r.expiresAt>now&&r.expiresAt<=now+300);
 for(const [field,allowed]of [['author','authors'],['committer','committers']]){
  const match=typeof r[field]==='string'&&r[field].match(/^(.+ <[^<>\s]+>) ([0-9]{1,12}) ([+-])([0-9]{2})([0-9]{2})$/);
  need(match&&identity(match[1])&&policy.identities[allowed].includes(match[1])&&Number(match[2])>0&&Number(match[2])<=now+300&&Number(match[4])<=23&&Number(match[5])<=59);
 }
 need(typeof r.message==='string'&&encoder.encode(r.message).length>0&&encoder.encode(r.message).length<=8000&&!r.message.includes('\0')&&r.message.endsWith('\n'));
 const bytes=`tree ${r.treeSHA}\nparent ${r.baseSHA}\nauthor ${r.author}\ncommitter ${r.committer}\n\n${r.message}`;
 need(r.unsignedCommit===bytes&&await sha256(encoder.encode(bytes))===r.objectDigest);return r;
}

// Reuses existing GitHub OIDC authentication. The token authenticates a pinned
// producer's exact intent; it makes no claim to have inspected the tree contents.
export function createFeatureOIDCProducer({trust,jwks=githubJWKS,now=()=>Math.floor(Date.now()/1000)}={}){
 const t=snapshot(trust);validateTrust(t);need(t.audiencePrefix==='workflow-depot-feature');
 return {async verify({requestDigest,evidence}){
  need(matches(HASH,requestDigest)&&exact(evidence,['oidcToken','runID','runAttempt'])&&positive(evidence.runID)&&positive(evidence.runAttempt));
  const identity=await verifyOIDC(evidence.oidcToken,t,{operationID:requestDigest,runID:evidence.runID,runAttempt:evidence.runAttempt},await jwks(),now());
  const producerID=`github-actions:${t.repositoryID}:${t.jobWorkflowSHA}`;
  const observation={producerID,requestDigest,trustDigest:await digest(t),authenticationID:identity.jti,runID:evidence.runID,runAttempt:evidence.runAttempt,expiresAt:identity.expiresAt};
  need(identity.expiresAt>now());return {verified:true,producerID,requestDigest,authenticationID:identity.jti,expiresAt:identity.expiresAt,producerEvidenceDigest:await digest(observation)};
 }};
}

export function createSourceFeatureAuthority({storage,policy,github,jwks=githubJWKS,now=()=>Math.floor(Date.now()/1000)}={}){
 need(typeof storage?.get==='function'&&typeof storage?.transaction==='function'&&typeof policy==='function'&&['repository','ref','commit'].every(method=>typeof github?.[method]==='function'));
 function currentPolicy(){const p=validateFeaturePolicy(policy());need(p.enabled);return p;}
 function unchanged(p){need(canonical(currentPolicy())===canonical(p));}
 async function source(r,p){
  const rule=p.featureRefs.find(rule=>rule.ref===r.featureRef);
  const [repository,parent,target,commit]=await Promise.all([github.repository(r.repository),github.ref(r.repository,rule.parentRef),github.ref(r.repository,rule.ref),github.commit(r.repository,r.baseSHA)]);
  need(repository?.id===p.repositoryID&&repository.full_name===p.repository&&repository.owner?.id===p.ownerID&&repository.archived===false&&repository.fork===false&&repository.default_branch==='main');
  need(commit?.sha===r.baseSHA&&parent===r.baseSHA&&target===(rule.mode==='create'?null:r.baseSHA));
  const [freshParent,freshTarget]=await Promise.all([github.ref(r.repository,rule.parentRef),github.ref(r.repository,rule.ref)]);
  need(freshParent===parent&&freshTarget===target);unchanged(p);need(r.expiresAt>now());
 }
 const recordKey=(p,requestDigest)=>`source-feature:grant:${p.repositoryID}:${requestDigest}`;
 async function admit(input,retained){
  need(exact(input,retained?['request']:['request','producerEvidence']));const p=currentPolicy();need((p.producer.type==='retained-intents')===retained);
  const r=await validateFeatureRequest(input.request,p,now()),requestDigest=await digest(r),intentDigest=await featureIntentDigest(r),policyDigest=await digest(p);
  let producer;
  if(retained){
   need(p.producer.expiresAt>now()&&p.producer.intentDigests.includes(intentDigest));
   const evidence={kind:'operator-retained-intent',producerID:p.producer.id,intentDigest,policyDigest};
   producer={producerID:p.producer.id,producerEvidenceDigest:await digest(evidence),expiresAt:p.producer.expiresAt,authenticationID:'retained:'+intentDigest};
  }else producer=await createFeatureOIDCProducer({trust:p.producer.trust,jwks,now}).verify({requestDigest,evidence:input.producerEvidence});
  await source(r,p);
  const expiresAt=Math.min(r.expiresAt,producer.expiresAt,now()+300);need(expiresAt>now());
  const grantID=await digest({schema:'workflow-depot-feature-grant/v1',requestDigest,intentDigest,policyDigest,producerID:producer.producerID,producerEvidenceDigest:producer.producerEvidenceDigest});
  const grant={authorized:true,requestDigest,policyDigest,signerKeyID:p.signerKeyID,producerID:producer.producerID,producerEvidenceDigest:producer.producerEvidenceDigest,grantID,expiresAt};
  const replay=await digest({producerID:producer.producerID,authenticationID:producer.authenticationID});
  await storage.transaction(async tx=>{
   unchanged(p);need(expiresAt>now());
   const keys=[recordKey(p,requestDigest),`source-feature:nonce:${p.repositoryID}:${r.nonce}`,`source-feature:intent:${p.repositoryID}:${intentDigest}`,`source-feature:authentication:${replay}`];
   for(const key of keys)need(!await tx.get(key));
   const count=await tx.get('source-feature:count')??0;need(Number.isSafeInteger(count)&&count>=0&&count<8192);
   for(const key of keys.slice(1))await tx.put(key,{requestDigest,grantID});
   await tx.put(keys[0],{request:r,grant,state:'authorized'});await tx.put('source-feature:count',count+1);
  });unchanged(p);need(expiresAt>now());return snapshot(grant);
 }
 async function retained(request,grantID,state){
  const p=currentPolicy(),r=await validateFeatureRequest(request,p,now()),requestDigest=await digest(r);
  const key=recordKey(p,requestDigest),record=await storage.get(key);
  need(record&&record.state===state&&canonical(record.request)===canonical(r)&&record.grant.requestDigest===requestDigest&&record.grant.policyDigest===await digest(p)&&record.grant.expiresAt>now());
  if(grantID!==undefined)need(matches(HASH,grantID)&&record.grant.grantID===grantID);
  await source(r,p);need(record.grant.expiresAt>now());return {p,r,key,record};
 }
 return Object.freeze({
  async current(input){need(exact(input,['repositoryID']));const p=currentPolicy();need(input.repositoryID===p.repositoryID);return {authority:'workflow_depot',repositoryID:p.repositoryID,repository:p.repository,signerKeyID:p.signerKeyID,policyDigest:await digest(p)};},
  admitFeature:input=>admit(snapshot(input),false),
  admitRetainedFeature:input=>admit(snapshot(input),true),
  async authorizeFeatureCommit(request){
   const p=currentPolicy(),r=await validateFeatureRequest(request,p,now()),key=recordKey(p,await digest(r));
   if(p.producer.type==='retained-intents'&&!await storage.get(key))return admit({request:r},true);
   const {record}=await retained(r,undefined,'authorized');return snapshot(record.grant);
  },
  async consumeFeatureCommit(input){
   need(exact(input,['request','grantID']));const {p,key,record}=await retained(input.request,input.grantID,'authorized');
   await storage.transaction(async tx=>{unchanged(p);const value=await tx.get(key);need(value?.state==='authorized'&&canonical(value)===canonical(record)&&record.grant.expiresAt>now());await tx.put(key,{...value,state:'consumed'});});
   unchanged(p);need(record.grant.expiresAt>now());return snapshot(record.grant);
  },
  async checkFeatureCommit(input){need(exact(input,['request','grantID']));const {p,key,record}=await retained(input.request,input.grantID,'consumed');need(canonical(await storage.get(key))===canonical(record));unchanged(p);need(record.grant.expiresAt>now());return snapshot(record.grant);}
 });
}
