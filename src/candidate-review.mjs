import {integrationRef,isIntegrationRef} from './candidate-admission-client.mjs';
import {createHash} from 'node:crypto';
import {canonical} from './shared/contract.mjs';
export {canonical};
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=/^[a-f0-9]{40}$/,hex=/^[a-f0-9]{64}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
const requireValue=(value,code='REVIEW_INPUT_UNVERIFIED')=>{if(!value)throw Error(code);};
const strings=v=>Array.isArray(v)&&v.length<=1000&&v.every(s=>typeof s==='string'&&s.length>0&&s.length<=500)&&new Set(v).size===v.length;
const pathOK=s=>typeof s==='string'&&s.length<=500&&!/[\x00-\x1f\x7f\\]/.test(s)&&!s.split('/').some(x=>!x||x==='.'||x==='..');

// Exact bytes from ProsRUs at the independently located revision. This is the
// actual Engineering rules document, not a renamed or invented style guide.
export const engineeringGuide=Object.freeze({repository:'susanbeasles/ProsRUs',revision:'6c0a71c43934dc6428449a4b96b2b88a7ba47fac',path:'docs/code-style-guide.md',digest:'e672eabc9538121bfd73edc9b685e9c7ce2dd3f1be1cccc31f984f0d9e9dd29d',text:`# Engineering rules

Model domain concepts and invariants before framework plumbing. Give values and operations precise names. Keep modules cohesive, functions focused, effects explicit and deterministic transformations independently testable. Prefer existing conventions over cosmetic churn.

- Supply changing values, clocks and capabilities at visible boundaries.
- Validate untrusted configuration, protocol input and stored records. Types do not replace runtime checks.
- Preserve strict object shapes, unknown-field denial, scalar encoding and historical serialized bytes.
- Keep absence distinct from an invented default. Invalid authority/configuration fails closed.
- Reuse a capability when meaning, permissions and failure behavior agree; do not copy workflows or build speculative frameworks.
- Bound bytes, rows, depth, queries and external effects before materialization or mutation.
- Use actual failing assertions before changing behavior, then the smallest implementation and affected regression checks.
- Make atomicity, retry identity and ambiguous outcomes explicit. Never retry an uncertain external action blindly.
- Regenerate maintained projections/types/identities through their actual generators.
- Preserve original custody and exact before/after evidence for reversible changes.
- Keep private inputs, internal evidence, dependencies and caches outside source composition.
- Report observed tests and remaining acceptance honestly. Preserve licenses and public attribution.
`});

export function validateReviewSource(s){
 requireValue(exact(s,['repository','repositoryID','ownerID','commitSHA','sourceRef','runID','runAttempt'])&&/^susanbeasles\/[A-Za-z0-9_.-]+$/.test(s.repository)&&[s.repositoryID,s.ownerID,s.runID,s.runAttempt].every(positive)&&s.ownerID===215839550&&sha.test(s.commitSHA));
 requireValue(isIntegrationRef(s.sourceRef));return s;
}
function validatePolicy(p,s){
 requireValue(p&&p.repository===s.repository&&p.repositoryID===s.repositoryID&&p.ownerID===s.ownerID&&hex.test(p.policyDigest)&&positive(p.maxAgeSeconds)&&p.maxAgeSeconds<=3600,'REVIEW_POLICY_UNAVAILABLE');
 const r=p.reviewPolicy,a=p.applicablePolicy;
 requireValue(r&&r.styleGuideDigest===engineeringGuide.digest&&r.styleGuideRevision===engineeringGuide.revision&&r.styleGuidePath===engineeringGuide.path&&hash(engineeringGuide.text)===engineeringGuide.digest,'REVIEW_STYLE_UNAVAILABLE');
 requireValue([r.reviewerAppID,r.reviewerInstallationID,r.reviewerActorID].every(positive)&&Array.isArray(r.privilegedAppIDs)&&Array.isArray(r.privilegedActorIDs)&&r.privilegedAppIDs.every(positive)&&r.privilegedActorIDs.every(positive)&&!r.privilegedAppIDs.includes(r.reviewerAppID)&&!r.privilegedActorIDs.includes(r.reviewerActorID)&&r.allowBotApproval===true&&r.requiresHumanReview===false,'REVIEW_IDENTITY_UNAVAILABLE');
 requireValue(p.runtime?.repository==='susanbeasles/workflow_depot'&&sha.test(p.runtime.revision),'REVIEW_RUNTIME_UNAVAILABLE');
 requireValue(exact(a,['languages','frameworks','dependencyPolicyDigest','documents','rules'])&&strings(a.languages)&&a.languages.length>0&&strings(a.frameworks)&&hex.test(a.dependencyPolicyDigest)&&strings(a.rules)&&a.rules.includes('no-merge-conflicts')&&a.rules.every(r=>['no-merge-conflicts','no-control-characters'].includes(r)),'REVIEW_STACK_UNAVAILABLE');
 requireValue(Array.isArray(a.documents)&&a.documents.length===a.languages.length+a.frameworks.length+1&&a.documents.length<=100,'REVIEW_STACK_UNAVAILABLE');
 const expected=[...a.languages.map(name=>['language',name]),...a.frameworks.map(name=>['framework',name]),['dependencies','dependencies']];
 for(const [kind,name] of expected){const docs=a.documents.filter(d=>d.kind===kind&&d.name===name);requireValue(docs.length===1,'REVIEW_STACK_UNAVAILABLE');const d=docs[0];requireValue(exact(d,['kind','name','revision','digest','text'])&&sha.test(d.revision)&&hex.test(d.digest)&&typeof d.text==='string'&&Buffer.byteLength(d.text)>0&&Buffer.byteLength(d.text)<=16384&&hash(d.text)===d.digest&&(kind!=='dependencies'||d.digest===a.dependencyPolicyDigest),'REVIEW_STACK_UNAVAILABLE');}
}
function sourceFiles(files){
 requireValue(Array.isArray(files)&&files.length<=2000);let bytes=0;const paths=new Set();
 for(const f of files){requireValue(exact(f,['path','content'])&&pathOK(f.path)&&!paths.has(f.path)&&typeof f.content==='string'&&!f.content.includes('\0'));paths.add(f.path);bytes+=Buffer.byteLength(f.content);requireValue(bytes<=4*1024*1024&&Buffer.byteLength(f.content)<=512*1024);}
 return files;
}
function validateFinding(f,files){
 requireValue(exact(f,['severity','summary','path','line','quote'])&&['info','low','medium','high','critical'].includes(f.severity)&&typeof f.summary==='string'&&f.summary.length>0&&f.summary.length<=2000&&positive(f.line)&&typeof f.quote==='string'&&f.quote.length>0&&f.quote.length<=4000,'REVIEW_FINDING_UNGROUNDED');
 const content=files.find(x=>x.path===f.path)?.content;requireValue(typeof content==='string'&&content.split('\n')[f.line-1]===f.quote,'REVIEW_FINDING_UNGROUNDED');return f;
}
function deterministic(files,rules){
 const findings=[];
 for(const f of files)for(const [index,line] of f.content.split('\n').entries()){
  if(rules.includes('no-merge-conflicts')&&/^(<<<<<<< |=======\s*$|>>>>>>> )/.test(line))findings.push({severity:'high',summary:'Unresolved merge conflict marker',path:f.path,line:index+1,quote:line});
  if(rules.includes('no-control-characters')&&/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line))findings.push({severity:'medium',summary:'Unexpected control character in source',path:f.path,line:index+1,quote:line});
  requireValue(findings.length<=100,'REVIEW_FINDING_LIMIT');
 }
 return findings;
}
export function createCandidateReview({policy,candidates,priorEvidence,scans,sourceReader,identity,provider,clock=()=>Math.floor(Date.now()/1000)}){
 for(const [capability,method] of [[policy,'current'],[candidates,'verify'],[priorEvidence,'verify'],[scans,'verify'],[sourceReader,'read'],[identity,'verify']])requireValue(typeof capability?.[method]==='function','REVIEW_ADAPTER_UNAVAILABLE');
 return {async review(request){
  requireValue(exact(request,['source','scanReportBytes','scanReportDigest']));const s=structuredClone(validateReviewSource(request.source));
  const p=structuredClone(await policy.current(s));validatePolicy(p,s);
  const bytes=request.scanReportBytes;requireValue(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=32*1024*1024&&hex.test(request.scanReportDigest)&&hash(bytes)===request.scanReportDigest,'REVIEW_REPORT_DIGEST');
  let report;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);report=JSON.parse(text);requireValue(text===canonical(report)||text===canonical(report)+'\n');}catch{throw Error('REVIEW_REPORT_ENCODING');}
  async function candidateProof(){const proof=await candidates.verify(s);requireValue(proof?.verified===true&&proof.candidateDigest===hash(canonical(proof.candidate)));const c=structuredClone(proof.candidate);requireValue(c.schema==='repoctl-source-candidate/v1'&&c.verified===true&&c.repository===s.repository&&c.repositoryID===s.repositoryID&&c.commitSHA===s.commitSHA&&c.shadowRef===s.sourceRef&&integrationRef(c.sourceRef)===s.sourceRef&&[c.treeSHA,c.sourceSHA,c.expectedMainParent].every(x=>sha.test(x))&&c.sourcePR?.repositoryID===s.repositoryID&&c.sourcePR.headSHA===c.sourceSHA&&positive(c.sourcePR.number)&&c.policyDigest===p.policyDigest);return c;}
  const candidate=await candidateProof();
  const expected={repositoryID:s.repositoryID,commitSHA:s.commitSHA,treeSHA:candidate.treeSHA,sourceSHA:candidate.sourceSHA,baseSHA:candidate.expectedMainParent,sourcePRNumber:candidate.sourcePR.number,policyDigest:candidate.policyDigest};
  const prior=await priorEvidence.verify({source:s,candidate,policy:p});requireValue(prior?.verified===true&&Object.entries(expected).every(([k,v])=>prior[k]===v)&&[prior.evidenceDigest,prior.ciReceiptDigest,prior.scanJobDigest].every(v=>hex.test(v))&&positive(prior.expiresAt)&&prior.expiresAt>clock(),'REVIEW_AUTOMATED_GATES_UNVERIFIED');
  const scanned=await scans.verify({report,source:s,candidate,policy:p,prior,now:clock()});requireValue(scanned?.verified===true&&scanned.receipt?.schema==='repoctl-source-scans/v1'&&['repositoryID','commitSHA','treeSHA','policyDigest'].every(k=>scanned.receipt[k]===expected[k]),'REVIEW_SCANS_UNVERIFIED');
  const code=structuredClone(await sourceReader.read({source:s,candidate,policy:p}));requireValue(exact(code,['commitSHA','baseSHA','treeSHA','files','baseline'])&&code.commitSHA===s.commitSHA&&code.baseSHA===candidate.expectedMainParent&&code.treeSHA===candidate.treeSHA);sourceFiles(code.files);sourceFiles(code.baseline);
  const findings=deterministic(code.files,p.applicablePolicy.rules);if(findings.length)return {state:'rejected',reason:'deterministic-review-findings',findings};
  requireValue(Array.isArray(report.fileInventory)&&code.files.every(f=>{const entries=report.fileInventory.filter(e=>e.path===f.path);return entries.length===1&&entries[0].type==='file'&&entries[0].size===Buffer.byteLength(f.content)&&entries[0].sha256===hash(f.content);}),'REVIEW_SOURCE_SCAN_MISMATCH');
  const identityProof=await identity.verify({source:s,candidate,policy:p});const r=p.reviewPolicy;requireValue(identityProof?.verified===true&&identityProof.commitSHA===s.commitSHA&&identityProof.appID===r.reviewerAppID&&identityProof.installationID===r.reviewerInstallationID&&identityProof.actorID===r.reviewerActorID,'REVIEW_IDENTITY_UNAVAILABLE');
  if(typeof provider?.review!=='function')return {state:'unavailable',reason:'independent-review-provider-unavailable'};
  requireValue(prior.expiresAt>clock(),'REVIEW_EXPIRED');
  const input={schema:'workflow-depot-review-input/v1',source:s,candidate,styleGuide:engineeringGuide,applicablePolicy:p.applicablePolicy,runtime:p.runtime,automatedEvidence:{...prior,scanReceiptDigest:hash(canonical(scanned.receipt)),scanReceipt:scanned.receipt},code,diff:code.files.filter(f=>code.baseline.find(b=>b.path===f.path)?.content!==f.content).map(f=>({path:f.path,before:code.baseline.find(b=>b.path===f.path)?.content??null,after:f.content})).concat(code.baseline.filter(b=>!code.files.some(f=>f.path===b.path)).map(b=>({path:b.path,before:b.content,after:null})))};
  const result=await provider.review(structuredClone(input));if(result?.state==='unavailable')return {state:'unavailable',reason:'independent-review-provider-unavailable'};
  requireValue(exact(result,['verdict','findings','inputDigest'])&&['approved','rejected','inconclusive'].includes(result.verdict)&&result.inputDigest===hash(canonical(input))&&Array.isArray(result.findings)&&result.findings.length<=100,'REVIEW_PROVIDER_UNVERIFIED');
  for(const finding of result.findings)validateFinding(finding,code.files);
  if(result.verdict!=='approved'||result.findings.some(f=>!['info','low'].includes(f.severity)))return {state:'rejected',reason:'independent-review-not-approved',findings:result.findings};
  requireValue(prior.expiresAt>clock()&&canonical(await candidateProof())===canonical(candidate)&&canonical(await policy.current(s))===canonical(p),'REVIEW_GENERATION_CHANGED');
  const receipt={schema:'repoctl-source-review/v1',...expected,styleGuideDigest:r.styleGuideDigest,styleGuideRevision:r.styleGuideRevision,styleGuidePath:r.styleGuidePath,reviewerAppID:r.reviewerAppID,reviewerInstallationID:r.reviewerInstallationID,reviewerActorID:r.reviewerActorID,methods:['deterministic-style','security-tests','evidence-review'],verdict:'approved',findings:result.findings.map(f=>({severity:f.severity,summary:f.summary,evidence:canonical({path:f.path,line:f.line,quote:f.quote})})),humanReviewVerified:false,expiresAt:Math.min(prior.expiresAt,clock()+p.maxAgeSeconds)};
  requireValue(receipt.expiresAt>clock(),'REVIEW_EXPIRED');
  return {state:'approved',receipt,receiptDigest:hash(canonical(receipt)),ciReceiptDigest:prior.ciReceiptDigest,scanReceiptDigest:hash(canonical(scanned.receipt)),inputDigest:hash(canonical(input))};
 }};
}
