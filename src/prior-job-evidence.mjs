import {canonical,digest,sha256} from './shared/contract.mjs';

const hash=/^[a-f0-9]{64}$/,sha=/^[a-f0-9]{40}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const requireValue=value=>{if(!value)throw Error('Prior jobs not verified');};
const uniqueNames=xs=>Array.isArray(xs)&&xs.length>0&&xs.length<=100&&xs.every(x=>typeof x==='string'&&x.length>0&&x.length<=300)&&new Set(xs).size===xs.length;

// The accepted caller-workflow byte digest is essential: referenced_workflows
// plus matching job names alone would let an app add lookalike sibling jobs.
// Policy comes from the installed depot configuration, never an app report.
export async function verifyPriorJobs({github,source,candidate,trusted,now=()=>Math.floor(Date.now()/1000)}){
 try{
  const s=structuredClone(source),c=structuredClone(candidate),p=structuredClone(trusted);
  requireValue(typeof github?.read==='function'&&typeof github?.readWorkflow==='function'&&typeof now==='function');
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repository)&&[s.repositoryID,s.ownerID,s.runID,s.runAttempt].every(positive)&&sha.test(s.commitSHA));
  const match=/^refs\/heads\/promotion\/([1-9][0-9]*)\/shadow$/.exec(s.sourceRef);requireValue(match&&positive(Number(match[1])));
  requireValue(c.schema==='repoctl-source-candidate/v1'&&c.verified===true&&c.repository===s.repository&&c.repositoryID===s.repositoryID&&c.commitSHA===s.commitSHA&&c.shadowRef===s.sourceRef&&[c.sourceSHA,c.expectedMainParent,c.treeSHA].every(x=>sha.test(x))&&positive(c.sourcePR?.number)&&c.sourcePR.repositoryID===s.repositoryID&&c.sourcePR.headSHA===c.sourceSHA&&hash.test(c.policyDigest)&&c.policyDigest===p.policyDigest);
  requireValue(positive(p.workflowID)&&p.workflowPath==='.github/workflows/build.yml'&&hash.test(p.workflowDigest)&&sha.test(p.jobWorkflowSHA)&&p.jobWorkflowRef===s.repository.split('/')[0]+'/workflow_depot/.github/workflows/orchestration.yml@'+p.jobWorkflowSHA&&Array.isArray(p.actorIDs)&&p.actorIDs.length>0&&p.actorIDs.every(positive)&&uniqueNames(p.requiredJobNames)&&p.requiredJobNames.includes(p.scanJobName)&&positive(p.maxAgeSeconds)&&p.maxAgeSeconds<=86400);
  const read=path=>github.read(s.repository,path);
  const checkRun=run=>{
   requireValue(run.id===s.runID&&run.run_attempt===s.runAttempt&&run.repository?.id===s.repositoryID&&run.repository.full_name===s.repository&&run.head_sha===s.commitSHA&&run.head_branch===s.sourceRef.slice('refs/heads/'.length)&&run.event==='push'&&run.workflow_id===p.workflowID&&run.path===p.workflowPath&&p.actorIDs.includes(run.actor?.id)&&p.actorIDs.includes(run.triggering_actor?.id));
   requireValue((run.status==='in_progress'&&run.conclusion===null)||(run.status==='completed'&&run.conclusion==='success'));
   requireValue(Array.isArray(run.referenced_workflows)&&run.referenced_workflows.some(w=>w.path===p.jobWorkflowRef&&w.sha===p.jobWorkflowSHA));
   return {id:run.id,attempt:run.run_attempt,repositoryID:run.repository.id,headSHA:run.head_sha,headBranch:run.head_branch,workflowID:run.workflow_id,path:run.path,actorID:run.actor.id,triggeringActorID:run.triggering_actor.id};
  };
  const [repo,run,workflow]=await Promise.all([read(''),read('/actions/runs/'+s.runID),github.readWorkflow(s.repository,s.commitSHA)]);
  requireValue(repo.id===s.repositoryID&&repo.full_name===s.repository&&repo.owner?.id===s.ownerID&&repo.fork===false&&repo.archived===false&&repo.default_branch==='main');
  const runIdentity=checkRun(run);
  requireValue(typeof workflow==='string'&&new TextEncoder().encode(workflow).length<=32768&&await sha256(new TextEncoder().encode(workflow))===p.workflowDigest);
  const jobs=[];let total;
  for(let page=1;page<=10;page++){
   const result=await read(`/actions/runs/${s.runID}/attempts/${s.runAttempt}/jobs?per_page=100&page=${page}`);
   requireValue(Array.isArray(result.jobs)&&result.jobs.length<=100&&Number.isSafeInteger(result.total_count)&&result.total_count>=1&&result.total_count<=1000);
   if(total===undefined)total=result.total_count;requireValue(total===result.total_count);jobs.push(...result.jobs);requireValue(jobs.length<=total);
   if(jobs.length===total)break;requireValue(result.jobs.length===100&&page<10);
  }
  requireValue(new Set(jobs.map(j=>j.id)).size===jobs.length&&jobs.every(j=>positive(j.id)&&typeof j.name==='string'));
  const observed=[],timestamp=now();requireValue(positive(timestamp));
  for(const name of p.requiredJobNames){
   const matches=jobs.filter(j=>j.name===name);requireValue(matches.length===1);const j=matches[0];
   const started=Date.parse(j.started_at)/1000,completed=Date.parse(j.completed_at)/1000;
   requireValue(j.run_id===s.runID&&j.head_sha===s.commitSHA&&j.status==='completed'&&j.conclusion==='success'&&Number.isFinite(started)&&Number.isFinite(completed)&&completed>=started&&completed<=timestamp&&completed>timestamp-p.maxAgeSeconds);
   observed.push({id:j.id,name:j.name,startedAt:started,completedAt:completed});
  }
  observed.sort((a,b)=>a.name.localeCompare(b.name));
  requireValue(canonical(checkRun(await read('/actions/runs/'+s.runID)))===canonical(runIdentity));
  const expiresAt=Math.floor(Math.min(...observed.map(j=>j.completedAt+p.maxAgeSeconds)));requireValue(expiresAt>now());
  const ci={schema:'workflow-depot-prior-jobs/v1',source:s,workflowID:p.workflowID,workflowDigest:p.workflowDigest,jobWorkflowRef:p.jobWorkflowRef,jobWorkflowSHA:p.jobWorkflowSHA,jobs:observed};
  const proof={verified:true,repositoryID:s.repositoryID,commitSHA:s.commitSHA,treeSHA:c.treeSHA,sourceSHA:c.sourceSHA,baseSHA:c.expectedMainParent,sourcePRNumber:c.sourcePR.number,policyDigest:c.policyDigest,ciReceiptDigest:await digest(ci),scanJobDigest:await digest(observed.find(j=>j.name===p.scanJobName)),expiresAt};
  return {...proof,evidenceDigest:await digest(proof)};
 }catch{throw Error('Prior jobs not verified');}
}
