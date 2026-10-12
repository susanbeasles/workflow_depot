import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPriorJobs} from '../src/prior-job-evidence.mjs';
import {sha256} from '../src/shared/contract.mjs';
import {githubEvidenceReader} from '../src/deployment-evidence.mjs';

async function fixture(){
 const now=1800000000,source={repository:'susanbeasles/fixture',repositoryID:7,ownerID:215839550,commitSHA:'a'.repeat(40),sourceRef:'refs/heads/int/feature',runID:81,runAttempt:1};
 const workflow='name: Trusted thin caller\n',candidate={schema:'repoctl-source-candidate/v1',verified:true,repository:source.repository,repositoryID:7,commitSHA:source.commitSHA,shadowRef:source.sourceRef,sourceRef:'refs/heads/feature',sourceSHA:'b'.repeat(40),expectedMainParent:'c'.repeat(40),treeSHA:'d'.repeat(40),sourcePR:{number:9,repositoryID:7,headSHA:'b'.repeat(40)},policyDigest:'e'.repeat(64)};
 const trusted={policyDigest:candidate.policyDigest,workflowID:33,workflowPath:'.github/workflows/build.yml',workflowDigest:await sha256(new TextEncoder().encode(workflow)),jobWorkflowRef:'susanbeasles/workflow_depot/.github/workflows/orchestration.yml@'+'f'.repeat(40),jobWorkflowSHA:'f'.repeat(40),actorIDs:[215839550],requiredJobNames:['candidate / source-admission','candidate / unit 1/1','candidate / full-scans'],scanJobName:'candidate / full-scans',maxAgeSeconds:3600};
 const run={id:81,run_attempt:1,repository:{id:7,full_name:source.repository},head_sha:source.commitSHA,head_branch:'int/feature',event:'push',status:'in_progress',conclusion:null,workflow_id:33,path:trusted.workflowPath,actor:{id:215839550},triggering_actor:{id:215839550},referenced_workflows:[{path:trusted.jobWorkflowRef,sha:trusted.jobWorkflowSHA}]};
 const jobs=trusted.requiredJobNames.map((name,i)=>({id:i+1,name,run_id:81,head_sha:source.commitSHA,status:'completed',conclusion:'success',started_at:new Date((now-50)*1000).toISOString(),completed_at:new Date((now-5)*1000).toISOString()}));
 jobs.push({id:4,name:'candidate / reviewer / review',run_id:81,head_sha:source.commitSHA,status:'in_progress',conclusion:null});
 const paths={'':{id:7,full_name:source.repository,owner:{id:source.ownerID},fork:false,archived:false,default_branch:'main'},'/actions/runs/81':run,'/actions/runs/81/attempts/1/jobs?per_page=100&page=1':{total_count:jobs.length,jobs}};
 const hooks={};const github={async read(repository,path){assert.equal(repository,source.repository);await hooks.read?.(path);assert.ok(Object.hasOwn(paths,path),path);return structuredClone(paths[path]);},async readWorkflow(repository,sha){assert.equal(repository,source.repository);assert.equal(sha,source.commitSHA);return hooks.workflow??workflow;}};
 return {source,candidate,trusted,paths,jobs,run,hooks,verify:()=>verifyPriorJobs({github,source,candidate,trusted,now:()=>now})};
}
test('pre-review evidence accepts completed exact jobs while its workflow is still running',async()=>{
 const f=await fixture(),proof=await f.verify();assert.equal(proof.verified,true);assert.equal(proof.commitSHA,f.source.commitSHA);assert.equal(proof.sourcePRNumber,9);assert.match(proof.evidenceDigest,/^[a-f0-9]{64}$/);assert.match(proof.scanJobDigest,/^[a-f0-9]{64}$/);assert.ok(proof.expiresAt>1800000000);assert.equal(Object.hasOwn(proof,'scanReceiptDigest'),false);
});
test('missing, duplicate, skipped, stale and mismatched matrix evidence deny',async()=>{
 for(const change of [f=>f.jobs[0].conclusion='skipped',f=>f.jobs[0].head_sha='0'.repeat(40),f=>f.jobs[0].run_id=80,f=>f.jobs[0].id=f.jobs[1].id,f=>f.jobs[0].name=f.jobs[1].name,f=>f.jobs[0].completed_at='bad',f=>f.jobs[0].completed_at=new Date(1700000000*1000).toISOString(),f=>f.trusted.requiredJobNames.push('missing'),f=>f.paths['/actions/runs/81/attempts/1/jobs?per_page=100&page=1'].total_count=99]){const f=await fixture();change(f);await assert.rejects(f.verify(),/Prior jobs not verified/);}
});
test('an app cannot spoof accepted workflow bytes, actor, reusable identity, or candidate proof',async()=>{
 for(const change of [f=>f.hooks.workflow='untrusted caller with forged sibling names',f=>f.run.actor.id=1,f=>f.run.triggering_actor.id=1,f=>f.run.workflow_id=34,f=>f.run.path='other.yml',f=>f.run.referenced_workflows[0].sha='0'.repeat(40),f=>f.candidate.treeSHA='bad',f=>f.candidate.policyDigest='0'.repeat(64),f=>f.candidate.verified=false,f=>f.source.ownerID=1,f=>f.run.event='pull_request',f=>f.run.head_branch='main']){const f=await fixture();change(f);await assert.rejects(f.verify());}
});
test('a run attempt changing during evidence reads invalidates the entire proof',async()=>{
 const f=await fixture();let reads=0;f.hooks.read=path=>{if(path==='/actions/runs/81'&&++reads===2)f.run.run_attempt=2;};await assert.rejects(f.verify());
});
test('raw workflow reader pins GitHub origin, exact commit, media type, bounds and redirects',async()=>{
 const calls=[],reader=githubEvidenceReader({token:'synthetic-read-token',fetcher:async(url,options)=>{calls.push({url,options});return new Response('name: test\n');}});
 assert.equal(await reader.readWorkflow('susanbeasles/fixture','a'.repeat(40)),'name: test\n');
 assert.equal(calls[0].url,'https://api.github.com/repos/susanbeasles/fixture/contents/.github/workflows/build.yml?ref='+'a'.repeat(40));
 assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Accept,'application/vnd.github.raw+json');
 await assert.rejects(reader.readWorkflow('susanbeasles/fixture','main'));assert.equal(calls.length,1);
 const huge=githubEvidenceReader({fetcher:async()=>new Response('x'.repeat(32769))});await assert.rejects(huge.readWorkflow('susanbeasles/fixture','a'.repeat(40)));
});
