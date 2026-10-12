import {open,readdir,appendFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCandidateReview,canonical,validateReviewSource} from './candidate-review.mjs';
import {createGitHubSourceReader,createReviewerIdentity,createOpenAIReviewer} from './candidate-review-adapters.mjs';
import {verifySourceCandidate} from './candidate-admission-client.mjs';
import {verifyPriorJobs} from './prior-job-evidence.mjs';
import {githubEvidenceReader} from './deployment-evidence.mjs';
import {reviewPolicies,reviewCredentials} from './candidate-review-config.mjs';

export async function readScanReport(directory){
 if(!directory||!directory.startsWith('/'))throw Error('REVIEW_REPORT_FILE');
 const names=await readdir(directory);if(names.length!==1||names[0]!=='scan-report.json')throw Error('REVIEW_REPORT_FILE');
 const file=await open(resolve(directory,'scan-report.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await file.stat();if(!before.isFile()||before.size<1||before.size>32*1024*1024)throw Error('REVIEW_REPORT_FILE');const bytes=await file.readFile(),after=await file.stat();if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('REVIEW_REPORT_FILE');return bytes;}finally{await file.close();}
}
export async function runCandidateReviewer({env=process.env,policies=reviewPolicies,credentials=reviewCredentials,fetcher=fetch,readReport=readScanReport,verifyCandidate=verifySourceCandidate,clock=()=>Math.floor(Date.now()/1000)}={}){
 const integer=value=>{if(!/^[1-9][0-9]*$/.test(value??'')||!Number.isSafeInteger(Number(value)))throw Error('REVIEW_COORDINATES');return Number(value);};
 const source=validateReviewSource({repository:env.GITHUB_REPOSITORY,repositoryID:integer(env.GITHUB_REPOSITORY_ID),ownerID:integer(env.GITHUB_REPOSITORY_OWNER_ID),commitSHA:env.CANDIDATE_SHA,sourceRef:env.GITHUB_REF,runID:integer(env.GITHUB_RUN_ID),runAttempt:integer(env.GITHUB_RUN_ATTEMPT)});
 if(env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_SHA!==source.commitSHA||!/^[a-f0-9]{40}$/.test(env.REVIEWED_DEPOT_SHA??''))throw Error('REVIEW_RUNTIME_UNAVAILABLE');
 const installed=policies[source.repositoryID];if(!installed)return {state:'unavailable',reason:'source-owned-review-policy-unavailable'};
 if(Object.keys(installed).sort().join()!=='provider,repository'||installed.repository!==source.repository)throw Error('REVIEW_RUNTIME_UNAVAILABLE');
 const lookup=()=>verifyCandidate({repository:source.repository,repositoryID:source.repositoryID,commitSHA:source.commitSHA,sourceRef:source.sourceRef,runID:source.runID,runAttempt:source.runAttempt},{fetcher,env});
 const admitted=await lookup(),retained=admitted?.reviewPolicy;
 if(retained===null||retained===undefined)return {state:'unavailable',reason:'accepted-candidate-review-policy-unavailable'};
 if(Object.keys(retained).sort().join()!=='commitSHA,policy,policyDigest,repositoryID'||retained.repositoryID!==source.repositoryID||retained.commitSHA!==source.commitSHA||retained.policyDigest!==admitted.candidate?.policyDigest)throw Error('REVIEW_POLICY_UNAVAILABLE');
 const accepted=retained.policy;
 if(!accepted||Object.keys(accepted).sort().join()!=='applicablePolicy,maxAgeSeconds,ownerID,policyDigest,priorJobs,repository,repositoryID,reviewPolicy,scanPolicy'||accepted.repository!==source.repository||accepted.repositoryID!==source.repositoryID||accepted.ownerID!==source.ownerID||accepted.policyDigest!==retained.policyDigest)throw Error('REVIEW_POLICY_UNAVAILABLE');
 // Runtime A never embeds its own SHA or the future caller/workflow B hashes.
 // Those pins are retained private policy, accepted after both commits exist.
 const trusted={...structuredClone(accepted),runtime:{repository:'susanbeasles/workflow_depot',revision:env.REVIEWED_DEPOT_SHA}};
 // The scanner validator is pure. Importing it never starts an installed tool.
 const {validateScanReport}=await import('./scan-report.mjs');
 const github=githubEvidenceReader({fetcher,token:env.GITHUB_TOKEN});
 const candidates={verify:async()=>{const proof=await lookup();if(canonical(proof.reviewPolicy)!==canonical(retained))throw Error('REVIEW_POLICY_CHANGED');return proof;}};
 const review=createCandidateReview({policy:{current:async()=>trusted},candidates,
  priorEvidence:{verify:({source,candidate,policy})=>verifyPriorJobs({github,source,candidate,trusted:policy.priorJobs,now:clock})},
  scans:{verify:async({report,source,candidate,policy,now})=>({verified:true,receipt:validateScanReport(report,{source,candidate,policy:policy.scanPolicy,now})})},
  sourceReader:createGitHubSourceReader({fetcher,token:env.GITHUB_TOKEN}),
  identity:createReviewerIdentity({fetcher,token:env.GITHUB_TOKEN,getAppJWT:credentials.getReviewerAppJWT}),
  provider:createOpenAIReviewer({config:installed.provider,credential:credentials.getProviderCredential,fetcher}),clock});
 return review.review({source,scanReportBytes:await readReport(resolve(env.RUNNER_TEMP??'/nonexistent','scan-evidence')),scanReportDigest:env.SCAN_REPORT_DIGEST});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const result=await runCandidateReviewer();if(result.state!=='approved'){console.error('Candidate review unavailable or rejected');process.exitCode=1;}else{const receipt=canonical(result.receipt);if(Buffer.byteLength(receipt)>256*1024)throw Error('REVIEW_RECEIPT_LIMIT');if(!process.env.GITHUB_OUTPUT)throw Error('REVIEW_OUTPUT_UNAVAILABLE');await appendFile(process.env.GITHUB_OUTPUT,'receipt_digest='+result.receiptDigest+'\nreceipt='+receipt+'\n');console.log('Candidate review evidence verified');}}
 catch{console.error('Candidate review evidence unavailable or denied');process.exitCode=1;}
}
