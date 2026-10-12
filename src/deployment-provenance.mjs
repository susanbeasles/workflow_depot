import {digest,sha256,inspectArtifact,validatePolicy} from './shared/contract.mjs';
import {verifyOIDC,githubJWKS} from './shared/oidc.mjs';
import {validateCandidateReviewPolicy} from './candidate-admission-client.mjs';

const LIMIT=6*1024*1024,HEX=/^[a-f0-9]{64}$/;
const requireThat=(value,code)=>{if(!value)throw Error(code);};
function exact(value,keys){requireThat(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),'invalid-artifact-request');}
function snapshot(value,max=LIMIT){const text=JSON.stringify(value);requireThat(typeof text==='string'&&new TextEncoder().encode(text).length<=max,'artifact-request-too-large');return JSON.parse(text);}
function positive(value){return Number.isSafeInteger(value)&&value>0;}


function validateSource(s){
 exact(s,['repository','repositoryID','commitSHA','sourceRef','runID','runAttempt']);
 requireThat(typeof s.repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repository)&&[s.repositoryID,s.runID,s.runAttempt].every(positive)&&typeof s.commitSHA==='string'&&/^[a-f0-9]{40}$/.test(s.commitSHA),'invalid-artifact-source');
 const shadow=typeof s.sourceRef==='string'&&s.sourceRef.match(/^refs\/heads\/promotion\/([1-9][0-9]*)\/shadow$/);requireThat(shadow&&positive(Number(shadow[1])),'invalid-candidate-ref');return shadow;
}
async function currentPolicy(policy,options){const p=snapshot(policy(),65536);validatePolicy(p,options);requireThat(p.enabled&&/^[^/]+\/workflow_depot$/.test(p.authorizer.repository),'staging-disabled');return p;}
function validIdentity(identity,s,now){requireThat(typeof identity?.jti==='string'&&/^[\x21-\x7e]{8,200}$/.test(identity.jti)&&positive(identity.expiresAt)&&identity.expiresAt>now()&&identity.runID===String(s.runID)&&identity.runAttempt===String(s.runAttempt),'invalid-builder-identity');}
async function readCandidateEvidence(s,p,github,candidates){
 const shadow=validateSource(s);
    const [repo,tip,main,commit,candidate]=await Promise.all([github.read(s.repository,''),github.read(s.repository,'/git/ref/'+s.sourceRef.slice(5)),github.read(s.repository,'/git/ref/heads/main'),github.read(s.repository,'/git/commits/'+s.commitSHA),candidates.lookupCandidate({repositoryID:s.repositoryID,commitSHA:s.commitSHA,shadowRef:s.sourceRef})]);
    exact(candidate,['schema','verified','repository','repositoryID','commitSHA','treeSHA','sourceRef','sourceSHA','expectedMainParent','shadowRef','sourcePR','sequence','signerKeyID','unsignedCommitDigest','artifactIntentDigest','policyDigest','sourceHistoryDigest']);
    requireThat(candidate.schema==='repoctl-source-candidate/v1'&&candidate.verified===true&&candidate.repository===s.repository&&candidate.repositoryID===s.repositoryID&&candidate.commitSHA===s.commitSHA&&candidate.shadowRef===s.sourceRef&&candidate.sequence===Number(shadow[1])&&p.verification.signerKeyIDs.includes(candidate.signerKeyID),'candidate-evidence-denied');
    requireThat([candidate.sourceSHA,candidate.expectedMainParent,candidate.treeSHA].every(v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v))&&[candidate.unsignedCommitDigest,candidate.artifactIntentDigest,candidate.policyDigest,candidate.sourceHistoryDigest].every(v=>typeof v==='string'&&HEX.test(v)),'candidate-evidence-denied');
    exact(candidate.sourcePR,['number','repositoryID','headSHA']);requireThat(positive(candidate.sourcePR.number)&&candidate.sourcePR.repositoryID===s.repositoryID&&candidate.sourcePR.headSHA===candidate.sourceSHA,'candidate-evidence-denied');
    requireThat(repo.id===s.repositoryID&&repo.full_name===s.repository&&repo.owner?.id===p.authorizer.ownerID&&!repo.archived&&!repo.fork&&repo.default_branch==='main'&&tip.object?.sha===s.commitSHA&&main.object?.sha===candidate.expectedMainParent&&commit.sha===s.commitSHA&&commit.parents?.length===1&&commit.parents[0].sha===candidate.expectedMainParent&&commit.tree?.sha===candidate.treeSHA&&commit.verification?.verified===true&&commit.verification.reason==='valid','source-evidence-denied');
    return snapshot(candidate,16384);
}

// Read-only admission shares the independent candidate verification used by
// staging. It never reserves a deployment, writes an artifact, or grants a lease.
export function createCandidateAdmission({policy,github,candidates,verifyIdentity=verifyOIDC,jwks=githubJWKS,now=()=>Math.floor(Date.now()/1000)}={}){
 requireThat(typeof policy==='function'&&typeof github?.read==='function'&&typeof candidates?.lookupCandidate==='function','evidence-required');
 async function verify(request){
  try{
   const input=snapshot(request,32768);exact(input,['source','oidcToken']);const s=input.source;validateSource(s);
   requireThat(typeof input.oidcToken==='string'&&input.oidcToken.length>0&&input.oidcToken.length<=16384,'invalid-candidate-request');
   const p=await currentPolicy(policy,{requireDeploymentTarget:false}),policyDigest=await digest(p);
   const base=p.authorizer.repository+'/.github/workflows/',sha=p.verification.ciWorkflowSHA;
   requireThat(p.verification.ciWorkflowRef===base+'orchestration.yml@'+sha,'unapproved-admission-workflow');
   const trust={...p.authorizer,audiencePrefix:'workflow-depot-candidate',repository:s.repository,repositoryID:s.repositoryID,ref:s.sourceRef,workflowRef:s.repository+'/.github/workflows/build.yml@'+s.sourceRef,workflowSHA:s.commitSHA,jobWorkflowRef:p.verification.ciWorkflowRef,jobWorkflowSHA:sha,eventNames:['push']};
   const binding={operationID:await digest(s),runID:s.runID,runAttempt:s.runAttempt},keys=await jwks();let identity;
   // Both choices are source-owned, exact immutable reusable workflows. JWT
   // claims never select a key URL, trust policy, workflow, or caller identity.
   for(const jobWorkflowRef of [trust.jobWorkflowRef,base+'review-candidate.yml@'+sha]){
    try{identity=await verifyIdentity(input.oidcToken,{...trust,jobWorkflowRef},binding,keys,now());break;}catch{}
   }
   validIdentity(identity,s,now);
   const candidate=await readCandidateEvidence(s,p,github,candidates),candidateDigest=await digest(candidate);
   const readReviewPolicy=async()=>{
    if(typeof candidates.lookupReviewPolicy!=='function')return null;
    const metadata=snapshot(await candidates.lookupReviewPolicy({repositoryID:s.repositoryID,commitSHA:s.commitSHA,shadowRef:s.sourceRef}),256*1024);
    return validateCandidateReviewPolicy(metadata,s,candidate,{ownerID:p.authorizer.ownerID,jobWorkflowRef:p.verification.ciWorkflowRef,jobWorkflowSHA:p.verification.ciWorkflowSHA});
   };
   const reviewPolicy=await readReviewPolicy();
   requireThat(await digest(await readCandidateEvidence(s,p,github,candidates))===candidateDigest,'candidate-changed');
   requireThat(await digest(await readReviewPolicy())===await digest(reviewPolicy),'review-policy-changed');
   requireThat(await digest(await currentPolicy(policy,{requireDeploymentTarget:false}))===policyDigest,'candidate-policy-changed');validIdentity(identity,s,now);
   return {verified:true,source:snapshot(s,2048),candidateDigest,candidate,reviewPolicy};
  }catch{throw Error('Candidate admission denied');}
 }
 return Object.freeze({verify});
}

// Staging proves a pinned build identity produced these bytes. It grants no
// deployment authority, and accepts no provider credential or upload destination.
export function createDeploymentProvenance({storage,artifacts,policy,github,candidates,verifyIdentity=verifyOIDC,jwks=githubJWKS,now=()=>Math.floor(Date.now()/1000)}={}){
 requireThat(typeof storage?.transaction==='function'&&typeof storage?.get==='function','atomic-storage-required');
 requireThat(typeof artifacts?.put==='function'&&typeof artifacts?.get==='function','artifact-store-required');
 requireThat(typeof policy==='function'&&typeof github?.read==='function'&&typeof candidates?.lookupCandidate==='function','evidence-required');
 async function current(){return currentPolicy(policy);}
 async function unchanged(expected){const p=await current();requireThat(await digest(p)===expected,'staging-policy-changed');return p;}
 async function stage(request){
  let reserved=false,key,record;
  try{
   const input=snapshot(request);exact(input,['artifact','source','oidcToken']);exact(input.source,['repository','repositoryID','commitSHA','sourceRef','runID','runAttempt']);
   const s=input.source;requireThat(typeof input.artifact==='string'&&typeof input.oidcToken==='string'&&input.oidcToken.length>0&&input.oidcToken.length<=16384,'invalid-artifact-request');
   validateSource(s);
   const p=await current(),policyDigest=await digest(p),bytes=new TextEncoder().encode(input.artifact);
   const {artifactDigest,metadataDigest}=await inspectArtifact(bytes,p.maxArtifactBytes);
   requireThat(p.targets.some(t=>t.sourceRepository===s.repository&&t.sourceRepositoryID===s.repositoryID&&t.metadataDigest===metadataDigest),'unapproved-artifact-target');
   requireThat(p.verification.ciWorkflowRef.startsWith(p.authorizer.repository+'/.github/workflows/'),'unapproved-build-workflow');
   const trust={...p.authorizer,audiencePrefix:'workflow-depot-build',repository:s.repository,repositoryID:s.repositoryID,ref:s.sourceRef,workflowRef:s.repository+'/.github/workflows/build.yml@'+s.sourceRef,workflowSHA:s.commitSHA,jobWorkflowRef:p.verification.ciWorkflowRef,jobWorkflowSHA:p.verification.ciWorkflowSHA,eventNames:['push']};
   const identity=await verifyIdentity(input.oidcToken,trust,{operationID:artifactDigest,runID:s.runID,runAttempt:s.runAttempt},await jwks(),now());
   requireThat(typeof identity?.jti==='string'&&/^[\x21-\x7e]{8,200}$/.test(identity.jti)&&positive(identity.expiresAt)&&identity.expiresAt>now()&&identity.runID===String(s.runID)&&identity.runAttempt===String(s.runAttempt),'invalid-builder-identity');
   const candidateEvidence=async()=>digest(await readCandidateEvidence(s,p,github,candidates));
   const candidateDigest=await candidateEvidence();
   const proof={schema:'workflow-depot-build-provenance/v1',repository:s.repository,repositoryID:s.repositoryID,sourceSHA:s.commitSHA,sourceRef:s.sourceRef,artifactDigest,metadataDigest,runID:s.runID,runAttempt:s.runAttempt,workflowRef:p.verification.ciWorkflowRef,workflowSHA:p.verification.ciWorkflowSHA};
   key='build:'+artifactDigest;const replay='build-jti:'+await sha256(new TextEncoder().encode(identity.jti));
   record={state:'staging',proof,policyDigest,identityExpiresAt:identity.expiresAt};
   await storage.transaction(async tx=>{
    await unchanged(policyDigest);requireThat(identity.expiresAt>now(),'builder-identity-expired');
    requireThat(!await tx.get(key),'artifact-already-retained');requireThat(!await tx.get(replay),'builder-identity-replayed');
    requireThat(identity.expiresAt>now(),'builder-identity-expired');await tx.put(key,record);await tx.put(replay,artifactDigest);
   });reserved=true;
   const objectKey='artifacts/sha256/'+artifactDigest+'.json';
   const created=await artifacts.put(objectKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
   if(!created){
    const existing=await artifacts.get(objectKey);requireThat(existing&&existing.size===bytes.length&&existing.size<=p.maxArtifactBytes,'artifact-store-collision');
    const prior=new Uint8Array(await existing.arrayBuffer());requireThat(prior.length===bytes.length&&await sha256(prior)===artifactDigest&&prior.every((value,index)=>value===bytes[index]),'artifact-store-collision');
   }
   requireThat(await candidateEvidence()===candidateDigest,'candidate-changed-during-staging');
   await storage.transaction(async tx=>{
    await unchanged(policyDigest);requireThat(identity.expiresAt>now(),'builder-identity-expired');
    const retained=await tx.get(key);requireThat(retained?.state==='staging'&&await digest(retained.proof)===await digest(proof),'artifact-registry-collision');
    requireThat(identity.expiresAt>now(),'builder-identity-expired');await tx.put(key,{...record,state:'ready',retainedAt:now()});
   });
   return {artifactDigest,metadataDigest,state:'retained'};
  }catch{
   if(reserved){try{await storage.transaction(async tx=>{const retained=await tx.get(key);if(retained?.state==='staging')await tx.put(key,{...record,state:'uncertain'});});}catch{/* A retained staging state also fails closed. */}}
   throw Error('Artifact staging denied');
  }
 }
 async function lookup(input){
  try{
   input=snapshot(input,1024);exact(input,['artifactDigest']);requireThat(typeof input.artifactDigest==='string'&&HEX.test(input.artifactDigest),'invalid-artifact-digest');
   const record=await storage.get('build:'+input.artifactDigest);requireThat(record?.state==='ready','artifact-not-qualified');await unchanged(record.policyDigest);return structuredClone(record.proof);
  }catch{throw Error('Artifact provenance unavailable');}
 }
 return Object.freeze({stage,lookup});
}
