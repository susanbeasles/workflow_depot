// OFF-REPO PROPOSAL. Adds key-generation binding to an independently installed producer
// policy. Does not authenticate producers, enroll authority, or replace the base policy.
// resolveKey must call resolveCurrentSigningKey using operator-installed enrollment/binding.
import {createHash} from 'node:crypto';
const need=ok=>{if(!ok)throw Error('source-feature-policy-denied');};
function canonical(v){if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);if(Number.isSafeInteger(v))return String(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';need(v&&Object.getPrototypeOf(v)===Object.prototype);return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex'),HASH=/^[a-f0-9]{64}$/;
const equal=(a,b)=>canonical(a)===canonical(b);
export function createRotatingSourceFeaturePolicy({storage,producerPolicy,resolveKey,clock=()=>Math.floor(Date.now()/1000)}={}){
 need(typeof storage?.get==='function'&&typeof storage?.transaction==='function'&&typeof resolveKey==='function'&&['current','authorizeFeatureCommit','consumeFeatureCommit','checkFeatureCommit'].every(k=>typeof producerPolicy?.[k]==='function'));
 async function current({repositoryID}){
  need(Number.isSafeInteger(repositoryID)&&repositoryID>0);
  const base=await producerPolicy.current({repositoryID});
  need(base?.authority==='workflow_depot'&&base.repositoryID===repositoryID&&/^susanbeasles\/[A-Za-z0-9_.-]+$/.test(base.repository)&&HASH.test(base.policyDigest));
  const key=await resolveKey({repositoryID,repository:base.repository});
  need(/^SHA256:[A-Za-z0-9+/]{43}$/.test(key?.signerKeyID)&&Number.isSafeInteger(key.signerVersion)&&key.signerVersion>0&&HASH.test(key.signerConfigDigest)&&HASH.test(key.signerAuthorityDigest));
  return {authority:'workflow_depot',repositoryID,repository:base.repository,signerKeyID:key.signerKeyID,policyDigest:digest({schema:'source-feature-key-policy/v1',basePolicyDigest:base.policyDigest,...key}),basePolicyDigest:base.policyDigest};
 }
 async function context(request){
  need(request&&HASH.test(request.nonce)&&Number.isSafeInteger(request.expiresAt)&&request.expiresAt>clock()&&request.expiresAt<=clock()+300);
  const accepted=await current({repositoryID:request.repositoryID});need(accepted.repository===request.repository&&accepted.signerKeyID===request.signerKeyID);
  return accepted;
 }
 function validGrant(request,grant,accepted){
  need(grant&&equal(Object.keys(grant).sort(),['authorized','requestDigest','policyDigest','signerKeyID','producerID','producerEvidenceDigest','grantID','expiresAt'].sort())&&grant.authorized===true&&grant.requestDigest===digest(request)&&grant.policyDigest===accepted.basePolicyDigest&&grant.signerKeyID===request.signerKeyID&&HASH.test(grant.grantID)&&HASH.test(grant.producerEvidenceDigest)&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(grant.producerID)&&Number.isSafeInteger(grant.expiresAt)&&grant.expiresAt>clock()&&grant.expiresAt<=request.expiresAt);
 }
 const recordKey=request=>`source-key-grant:${request.repositoryID}:${request.nonce}`;
 async function retained(request,accepted,grantID){
  const record=await storage.get(recordKey(request));need(record&&['issued','consumed'].includes(record.state)&&equal(record.request,request)&&equal(record.accepted,accepted)&&(!grantID||record.baseGrant.grantID===grantID));return record;
 }
 async function checked(request,record){
  const grant=await producerPolicy.checkFeatureCommit({request:structuredClone(request),grantID:record.baseGrant.grantID});validGrant(request,grant,record.accepted);need(equal(grant,record.baseGrant)&&equal(await context(request),record.accepted));return structuredClone(record.boundGrant);
 }
 return Object.freeze({
  async current(input){const {basePolicyDigest,...publicMetadata}=await current(input);return publicMetadata;},
  async authorizeFeatureCommit(input){
   const request=structuredClone(input),accepted=await context(request),key=recordKey(request);
   // Reserve before the external effect. An interrupted/ambiguous attempt remains
   // denied; retrying it requires an independently designed recovery protocol.
   const reserved=await storage.transaction(async tx=>{
    const prior=await tx.get(key);
    if(prior){need(equal(prior.request,request)&&equal(prior.accepted,accepted));return false;}
    await tx.put(key,{request,accepted,state:'authorization-attempted'});return true;
   });
   if(!reserved)return checked(request,await retained(request,accepted));
   const grant=await producerPolicy.authorizeFeatureCommit(structuredClone(request));validGrant(request,grant,accepted);need(equal(await context(request),accepted));
   const record={request,accepted,baseGrant:structuredClone(grant),boundGrant:{...grant,policyDigest:accepted.policyDigest},state:'issued'};
   await storage.transaction(async tx=>{const prior=await tx.get(key);need(prior?.state==='authorization-attempted'&&equal(prior.request,request)&&equal(prior.accepted,accepted));await tx.put(key,record);});
   return checked(request,await retained(request,accepted));
  },
  async consumeFeatureCommit({request:input,grantID}){
   need(HASH.test(grantID));  // the issued grant ID is required, never optional
   const request=structuredClone(input),accepted=await context(request),record=await retained(request,accepted,grantID);await checked(request,record);
   await storage.transaction(async tx=>{const stored=await tx.get(recordKey(request));need(stored?.state==='issued'&&equal(stored,record));await tx.put(recordKey(request),{...stored,state:'consumption-attempted'});});
   // Persist before external effect. Lost response is uncertain and never automatically retried.
   const grant=await producerPolicy.consumeFeatureCommit({request:structuredClone(request),grantID});validGrant(request,grant,accepted);need(equal(grant,record.baseGrant)&&equal(await context(request),accepted));
   await storage.transaction(async tx=>{const stored=await tx.get(recordKey(request));need(stored?.state==='consumption-attempted'&&equal(stored.request,request)&&equal(stored.accepted,accepted));await tx.put(recordKey(request),{...stored,state:'consumed'});});
   return structuredClone(record.boundGrant);
  },
  async checkFeatureCommit({request:input,grantID}){need(HASH.test(grantID));const request=structuredClone(input),accepted=await context(request),record=await retained(request,accepted,grantID);return checked(request,record);}
 });
}
