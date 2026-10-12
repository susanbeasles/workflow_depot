// Commission only through reviewed workflow_depot source, never an app input,
// repository variable, environment override, or token-selected destination.
export const CANDIDATE_ADMISSION_ORIGIN = '';

// Shared transport validation: this is accepted policy metadata, never a token,
// provider configuration, executable input, or a runtime self-referential pin.
export function validateCandidateReviewPolicy(value,source,candidate,expected={}){
 if(value===null)return null;
 const require=value=>{if(!value)throw Error('Invalid candidate review policy');};
 const exact=(value,keys)=>require(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','));
 const positive=v=>Number.isSafeInteger(v)&&v>0,hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
 const text=(v,max=1000)=>typeof v==='string'&&v.length>0&&v.length<=max;
 const strings=(xs,max=100,maxLength=300)=>Array.isArray(xs)&&xs.length<=max&&xs.every(v=>text(v,maxLength))&&new Set(xs).size===xs.length;
 const ids=xs=>Array.isArray(xs)&&xs.length<=100&&xs.every(positive)&&new Set(xs).size===xs.length;
 require(new TextEncoder().encode(JSON.stringify(value)).length<=256*1024);
 exact(value,['repositoryID','commitSHA','policyDigest','policy']);
 require(value.repositoryID===source.repositoryID&&value.commitSHA===source.commitSHA&&hex(value.policyDigest)&&value.policyDigest===candidate.policyDigest);
 const p=value.policy;
 exact(p,['repository','repositoryID','ownerID','policyDigest','reviewPolicy','scanPolicy','priorJobs','applicablePolicy','maxAgeSeconds']);
 require(p.repository===source.repository&&p.repositoryID===source.repositoryID&&positive(p.ownerID)&&p.policyDigest===value.policyDigest&&positive(p.maxAgeSeconds)&&p.maxAgeSeconds<=86400&&(!expected.ownerID||p.ownerID===expected.ownerID));
 const j=p.priorJobs;
 exact(j,['workflowID','workflowPath','workflowDigest','jobWorkflowRef','jobWorkflowSHA','actorIDs','requiredJobNames','scanJobName','maxAgeSeconds','policyDigest']);
 require(positive(j.workflowID)&&j.workflowPath==='.github/workflows/build.yml'&&hex(j.workflowDigest)&&sha(j.jobWorkflowSHA)&&j.jobWorkflowRef===source.repository.split('/')[0]+'/workflow_depot/.github/workflows/orchestration.yml@'+j.jobWorkflowSHA&&ids(j.actorIDs)&&j.actorIDs.length>0&&strings(j.requiredJobNames)&&j.requiredJobNames.length>0&&j.requiredJobNames.includes(j.scanJobName)&&positive(j.maxAgeSeconds)&&j.maxAgeSeconds<=86400&&j.policyDigest===value.policyDigest);
 require((!expected.jobWorkflowRef||j.jobWorkflowRef===expected.jobWorkflowRef)&&(!expected.jobWorkflowSHA||j.jobWorkflowSHA===expected.jobWorkflowSHA));
 const r=p.reviewPolicy;
 exact(r,['styleGuideDigest','styleGuideRevision','styleGuidePath','reviewerAppID','reviewerInstallationID','reviewerActorID','privilegedAppIDs','privilegedActorIDs','allowBotApproval','requiresHumanReview',...(Object.hasOwn(r??{},'checkName')?['checkName']:[])]);
 require(hex(r.styleGuideDigest)&&sha(r.styleGuideRevision)&&text(r.styleGuidePath,500)&&[r.reviewerAppID,r.reviewerInstallationID,r.reviewerActorID].every(positive)&&ids(r.privilegedAppIDs)&&ids(r.privilegedActorIDs)&&typeof r.allowBotApproval==='boolean'&&typeof r.requiresHumanReview==='boolean'&&(!Object.hasOwn(r,'checkName')||text(r.checkName,300)));
 const a=p.applicablePolicy;
 exact(a,['languages','frameworks','dependencyPolicyDigest','documents','rules']);require(strings(a.languages)&&strings(a.frameworks)&&hex(a.dependencyPolicyDigest)&&strings(a.rules)&&Array.isArray(a.documents)&&a.documents.length<=100);
 for(const d of a.documents){exact(d,['kind','name','revision','digest','text']);require(['language','framework','dependencies'].includes(d.kind)&&text(d.name,300)&&sha(d.revision)&&hex(d.digest)&&text(d.text,16384));}
 const scan=p.scanPolicy;
 exact(scan,['supportedLanguages','supportedFrameworks','requiredCategories','requiredTools','exemptions','sonarqubeStandardRulesetDigest']);
 require(strings(scan.supportedLanguages)&&strings(scan.supportedFrameworks)&&strings(scan.requiredCategories)&&Array.isArray(scan.requiredTools)&&scan.requiredTools.length<=100&&Array.isArray(scan.exemptions)&&scan.exemptions.length<=1000&&hex(scan.sonarqubeStandardRulesetDigest));
 for(const t of scan.requiredTools){exact(t,['id','category','version','rulesetDigest','databaseMaxAgeSeconds']);require(text(t.id)&&text(t.category)&&text(t.version)&&hex(t.rulesetDigest)&&Number.isSafeInteger(t.databaseMaxAgeSeconds)&&t.databaseMaxAgeSeconds>=0);}
 for(const e of scan.exemptions){exact(e,['toolID','path','reason']);require(text(e.toolID)&&text(e.path)&&text(e.reason));}
 return value;
}

export async function verifySourceCandidate(source,{fetcher=fetch,env=process.env}={}){
 if(!CANDIDATE_ADMISSION_ORIGIN)throw Error('Candidate admission origin is not commissioned');
 try{
  const require=value=>{if(!value)throw Error();};
  const exact=(value,keys)=>require(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','));
  const positive=value=>Number.isSafeInteger(value)&&value>0;
  const canonical=value=>JSON.stringify(value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])));
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)))),v=>v.toString(16).padStart(2,'0')).join('');
  exact(source,['repository','repositoryID','commitSHA','sourceRef','runID','runAttempt']);
  require(typeof source.repository==='string'&&source.repository.length<=201&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)&&[source.repositoryID,source.runID,source.runAttempt].every(positive)&&typeof source.commitSHA==='string'&&/^[a-f0-9]{40}$/.test(source.commitSHA));
  const shadow=typeof source.sourceRef==='string'&&source.sourceRef.match(/^refs\/heads\/promotion\/([1-9][0-9]*)\/shadow$/);require(shadow&&positive(Number(shadow[1])));
  source=JSON.parse(canonical(source));
  const origin=new URL(CANDIDATE_ADMISSION_ORIGIN);
  require(origin.protocol==='https:'&&origin.origin===CANDIDATE_ADMISSION_ORIGIN&&!origin.username&&!origin.password&&!origin.port&&/(?:^|\.)(?:vespoli\.me|anthonyvespoli\.com)$/.test(origin.hostname));
  const tokenURL=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  require(tokenURL.protocol==='https:'&&!tokenURL.username&&!tokenURL.password&&!tokenURL.port&&!tokenURL.hash&&tokenURL.hostname.endsWith('.actions.githubusercontent.com')&&typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN==='string'&&env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length>0&&env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length<=16384);
  tokenURL.searchParams.set('audience','workflow-depot-candidate:'+await hash(source));
  async function read(response,max){
   require(response.ok);const reader=response.body?.getReader();require(reader);const chunks=[];let length=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw Error();}chunks.push(value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  const token=await read(await fetcher(tokenURL.href,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}}),32768);
  require(typeof token.value==='string'&&token.value.length>0&&token.value.length<=16384);
  const result=await read(await fetcher(origin.origin+'/v1/candidates/verify',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json'},body:JSON.stringify({source,oidcToken:token.value})}),512*1024);
  exact(result,['verified','source','candidateDigest','candidate','reviewPolicy']);
  require(result.verified===true&&canonical(result.source)===canonical(source)&&typeof result.candidateDigest==='string'&&/^[a-f0-9]{64}$/.test(result.candidateDigest));
  const c=result.candidate;
  exact(c,['schema','verified','repository','repositoryID','commitSHA','treeSHA','sourceRef','sourceSHA','expectedMainParent','shadowRef','sourcePR','sequence','signerKeyID','unsignedCommitDigest','artifactIntentDigest','policyDigest','sourceHistoryDigest']);
  require(c.schema==='repoctl-source-candidate/v1'&&c.verified===true&&c.repository===source.repository&&c.repositoryID===source.repositoryID&&c.commitSHA===source.commitSHA&&c.shadowRef===source.sourceRef&&c.sequence===Number(shadow[1])&&await hash(c)===result.candidateDigest);
  validateCandidateReviewPolicy(result.reviewPolicy,source,c);
  return result;
 }catch{throw Error('Candidate admission failed');}
}
