import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm,readFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {runCandidateReviewer,readScanReport} from '../src/candidate-review-cli.mjs';
import {canonical,hash,engineeringGuide} from '../src/candidate-review.mjs';
import {mandatoryCategories} from '../src/scan-report.mjs';
const sha=c=>c.repeat(40),hex=c=>c.repeat(64);
function fixture(){
 const source={repository:'susanbeasles/app',repositoryID:1,ownerID:215839550,commitSHA:sha('a'),sourceRef:'refs/heads/int/feature',runID:3,runAttempt:1};
 const candidate={schema:'repoctl-source-candidate/v1',verified:true,repository:source.repository,repositoryID:1,commitSHA:sha('a'),treeSHA:sha('b'),sourceSHA:sha('c'),expectedMainParent:sha('d'),shadowRef:source.sourceRef,sourceRef:'refs/heads/feature',sourcePR:{number:2,repositoryID:1,headSHA:sha('c')},policyDigest:hex('e')};
 const docs=[{kind:'language',name:'javascript',revision:sha('f'),text:'Synthetic JavaScript policy.'},{kind:'dependencies',name:'dependencies',revision:sha('f'),text:'Synthetic dependency policy.'}].map(d=>({...d,digest:hash(d.text)}));
 const workflow='synthetic trusted thin caller';
 const tools=mandatoryCategories.map((category,i)=>({id:category==='quality'?'sonarqube':'fixture-'+i,category,version:'synthetic-1',rulesetDigest:hex('7'),databaseMaxAgeSeconds:0}));
 const policy={repository:source.repository,repositoryID:1,ownerID:source.ownerID,policyDigest:hex('e'),runtime:{repository:'susanbeasles/workflow_depot',revision:sha('f')},maxAgeSeconds:300,reviewPolicy:{styleGuideDigest:engineeringGuide.digest,styleGuideRevision:engineeringGuide.revision,styleGuidePath:engineeringGuide.path,reviewerAppID:11,reviewerInstallationID:12,reviewerActorID:13,checkName:'Independent review',privilegedAppIDs:[21],privilegedActorIDs:[22],allowBotApproval:true,requiresHumanReview:false},applicablePolicy:{languages:['javascript'],frameworks:[],dependencyPolicyDigest:docs[1].digest,documents:docs,rules:['no-merge-conflicts']},priorJobs:{workflowID:99,workflowPath:'.github/workflows/build.yml',workflowDigest:hash(workflow),jobWorkflowRef:'susanbeasles/workflow_depot/.github/workflows/orchestration.yml@'+sha('f'),jobWorkflowSHA:sha('f'),actorIDs:[22],requiredJobNames:['ci/checks','ci/full-scans'],scanJobName:'ci/full-scans',maxAgeSeconds:300,policyDigest:hex('e')},scanPolicy:{supportedLanguages:['javascript'],supportedFrameworks:[],requiredCategories:[...mandatoryCategories],requiredTools:tools,exemptions:[],sonarqubeStandardRulesetDigest:hex('7')},provider:{model:'synthetic-model',uploadAuthorized:true,repositoryID:1,policyDigest:hex('e')}};
 const content='export const value = 1;\n',blob=createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
 const fileInventory=[{path:'src/app.js',type:'file',size:Buffer.byteLength(content),sha256:hash(content)}],inventoryDigest=hash(canonical(fileInventory));
 const receipt={schema:'repoctl-source-scans/v1',repositoryID:1,commitSHA:sha('a'),treeSHA:sha('b'),policyDigest:hex('e'),inventoryDigest,tools:tools.map(t=>({id:t.id,category:t.category,version:t.version,rulesetDigest:t.rulesetDigest,status:'passed',commitSHA:sha('a'),inventoryDigest,coveredPaths:['src/app.js'],databaseUpdatedAt:null,completedAt:950,evidenceDigest:hex('8')}))};
 const report={schema:'workflow-depot-scan-report/v1',repositoryID:1,commitSHA:sha('a'),treeSHA:sha('b'),runID:3,runAttempt:1,environmentDigest:hex('9'),policyDigest:hex('e'),inventory:{digest:inventoryDigest,complete:true,paths:['src/app.js'],languages:['javascript'],frameworks:[],manifests:[]},fileInventory,receipt};
 const run={id:3,run_attempt:1,repository:{id:1,full_name:source.repository},head_sha:sha('a'),head_branch:source.sourceRef.slice(11),event:'push',workflow_id:99,path:'.github/workflows/build.yml',actor:{id:22},triggering_actor:{id:22},status:'in_progress',conclusion:null,referenced_workflows:[{path:policy.priorJobs.jobWorkflowRef,sha:sha('f')}]};
 const jobs=['ci/checks','ci/full-scans'].map((name,i)=>({id:100+i,name,run_id:3,head_sha:sha('a'),status:'completed',conclusion:'success',started_at:new Date(900000).toISOString(),completed_at:new Date(950000).toISOString()}));
 const env={GITHUB_REPOSITORY:source.repository,GITHUB_REPOSITORY_ID:'1',GITHUB_REPOSITORY_OWNER_ID:String(source.ownerID),CANDIDATE_SHA:sha('a'),GITHUB_REF:source.sourceRef,GITHUB_RUN_ID:'3',GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'push',GITHUB_SHA:sha('a'),REVIEWED_DEPOT_SHA:sha('9'),RUNNER_TEMP:'/synthetic',SCAN_REPORT_DIGEST:hash(canonical(report)),GITHUB_TOKEN:'synthetic-read-token'};
 const calls=[],response=value=>new Response(JSON.stringify(value));
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  if(url==='https://api.openai.com/v1/responses')return response({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"verdict":"approved","findings":[]}'}]}]});
  if(url==='https://api.github.com/app')return response({id:11,slug:'independent-review'});
  if(url.endsWith('/installation'))return response({id:12,app_id:11,account:{id:source.ownerID}});
  if(url.includes('/users/'))return response({id:13,type:'Bot',login:'independent-review[bot]'});
  if(url.includes('/check-runs?'))return response({total_count:1,check_runs:[{name:'Independent review',head_sha:sha('a'),status:'in_progress',app:{id:11}}]});
  if(url.includes('/contents/.github/workflows/build.yml?'))return new Response(workflow);
  if(url.endsWith('/actions/runs/3'))return response(run);
  if(url.includes('/jobs?'))return response({total_count:2,jobs});
  if(url.includes('/git/commits/'))return response({sha:url.split('/').at(-1),tree:{sha:sha('b')},parents:[{sha:sha('d')}]});
  if(url.includes('/git/trees/'))return response({sha:sha('b'),truncated:false,tree:[{path:'src/app.js',type:'blob',mode:'100644',sha:blob,size:Buffer.byteLength(content)}]});
  if(url.includes('/contents/src/app.js?'))return new Response(content);
  if(url==='https://api.github.com/repos/'+source.repository)return response({id:1,full_name:source.repository,owner:{id:source.ownerID},fork:false,archived:false,default_branch:'main'});
  throw Error('Unexpected synthetic HTTP request');
 };
 const options={env,policies:{1:{repository:source.repository,provider:policy.provider}},credentials:{getReviewerAppJWT:async()=>'synthetic-short-lived',getProviderCredential:async()=>'synthetic-provider'},fetcher,clock:()=>1000,readReport:async()=>Buffer.from(canonical(report)),verifyCandidate:async()=>{const {runtime,provider,...accepted}=policy;return {verified:true,candidate,candidateDigest:hash(canonical(candidate)),reviewPolicy:{repositoryID:1,commitSHA:source.commitSHA,policyDigest:candidate.policyDigest,policy:accepted}};}};
 return {options,report,policy,jobs,calls};
}
test('CLI composes actual prior-job, full scanner, raw source, identity and provider adapters with synthetic HTTP',async()=>{const f=fixture(),out=await runCandidateReviewer(f.options);assert.equal(out.state,'approved');assert.equal(out.receipt.commitSHA,sha('a'));assert.equal(f.calls.filter(c=>c.url==='https://api.openai.com/v1/responses').length,1);assert.equal(out.scanReceiptDigest,hash(canonical(f.report.receipt)));});
test('CLI cannot approve missing gates, report coverage, identity or provider authorization',async()=>{
 for(const change of [f=>f.jobs[0].conclusion='failure',f=>f.report.receipt.tools.pop(),f=>f.policy.reviewPolicy.reviewerInstallationID=99,f=>f.policy.provider.uploadAuthorized=false]){const f=fixture();change(f);f.options.env.SCAN_REPORT_DIGEST=hash(canonical(f.report));try{const out=await runCandidateReviewer(f.options);assert.equal(out.state,'unavailable');}catch(error){assert.notEqual(error.code,'ERR_ASSERTION');}assert.equal(f.calls.some(c=>c.url==='https://api.openai.com/v1/responses'),false);}
});
test('uncommissioned CLI fails closed without reading report, credentials or calling APIs',async()=>{const f=fixture();f.options.policies={};f.options.readReport=async()=>assert.fail('no report read');assert.deepEqual(await runCandidateReviewer(f.options),{state:'unavailable',reason:'source-owned-review-policy-unavailable'});assert.equal(f.calls.length,0);});
test('missing or mismatched private policy never reaches automated gates or provider',async()=>{for(const retained of [null,{repositoryID:99,commitSHA:sha('a'),policyDigest:hex('e'),policy:{}}]){const f=fixture(),lookup=f.options.verifyCandidate;f.options.verifyCandidate=async()=>({...await lookup(),reviewPolicy:retained});if(retained===null)assert.equal((await runCandidateReviewer(f.options)).state,'unavailable');else await assert.rejects(runCandidateReviewer(f.options));assert.equal(f.calls.length,0);}});
test('scanner data reader rejects symlinks, extra files and oversized files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-data-'));
 try{await writeFile(join(dir,'scan-report.json'),'{}');assert.equal((await readScanReport(dir)).toString(),'{}');await writeFile(join(dir,'extra'),'x');await assert.rejects(readScanReport(dir));await rm(join(dir,'extra'));const file=await open(join(dir,'scan-report.json'),'w');await file.truncate(32*1024*1024+1);await file.close();await assert.rejects(readScanReport(dir));await rm(join(dir,'scan-report.json'));await symlink('/nonexistent',join(dir,'scan-report.json'));await assert.rejects(readScanReport(dir));}finally{await rm(dir,{recursive:true,force:true});}
});
test('actual workflow validates before checkout and only downloads scanner report data',async()=>{
 const yaml=await readFile(new URL('../.github/workflows/review-candidate.yml',import.meta.url),'utf8');const script=/node --input-type=module <<'JS'\n([\s\S]*?)\n          JS/.exec(yaml)[1];
 const env={REVIEWED_DEPOT_SHA:sha('f'),CANDIDATE_SHA:sha('a'),GITHUB_SHA:sha('a'),GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/int/feature',SCAN_REPORT_DIGEST:hex('e'),SCAN_ARTIFACT_ID:'1'};
 vm.runInNewContext(script,{process:{env}},{timeout:1000});for(const bad of [{REVIEWED_DEPOT_SHA:'REVIEWED_DEPOT_SHA'},{CANDIDATE_SHA:'main'},{SCAN_ARTIFACT_ID:'1,2'},{GITHUB_REF:'refs/heads/main'}])assert.throws(()=>vm.runInNewContext(script,{process:{env:{...env,...bad}}},{timeout:1000}));
 assert.equal((yaml.match(/uses: actions\/checkout@/g)??[]).length,1);assert.match(yaml,/repository: susanbeasles\/workflow_depot/);assert.doesNotMatch(yaml,/npm |yarn |environment_paths|ci-env-|secrets: inherit/);
});
