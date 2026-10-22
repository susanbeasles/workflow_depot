// Writes authorization-policy.json (authorization-policy/v1) from the validated
// application manifest and the depot workflow identity that will sign the release.
// Expiry derives only from the trusted release runner clock; commit time is never authority.
import {join} from 'node:path';
import {ADAPTERS,SCHEMAS,GITHUB_ISSUER,formatTimestamp,releaseWorkflowRef,signerIdentity,validateAuthorizationPolicy} from '../../src/shared/release-contract.mjs';
import {loadApplication,loadContext} from './read-application.mjs';
import {parseArgs,isMain,runCli,writeCanonical,writeGithubOutput} from './io.mjs';

export function authorizationPolicy({application,context,depotRepository,depotSha,sourceDateEpoch,validityDays=365,clock=Date.now}){
 if(sourceDateEpoch!==undefined)throw Error('source date epoch cannot authorize policy validity');
 const createdAt=formatTimestamp(clock());
 if(!Number.isSafeInteger(validityDays)||validityDays<1||validityDays>400)throw Error('validity must be 1..400 days');
 if(application.repository!==context.repository||application.repositoryId!==context.repositoryId)throw Error('Application manifest repository does not match the release context');
 const targets=application.targets.map(t=>t.id);
 return validateAuthorizationPolicy({
  schema:SCHEMAS.policy,policyVersion:1,application:application.application,repository:application.repository,repositoryId:application.repositoryId,
  releasePrefix:`${application.application}/`,sourceCommit:context.sourceCommit,releaseTag:context.releaseTag,
  signer:{issuer:GITHUB_ISSUER,identity:signerIdentity(releaseWorkflowRef(depotRepository,depotSha))},
  targets:Object.fromEntries(application.targets.map(t=>[t.id,t.adapter===ADAPTERS.worker?{adapter:t.adapter,healthContract:t.healthContract}:{adapter:t.adapter,recoveryPolicy:t.recoveryPolicy}])),
  environments:Object.fromEntries(Object.entries(application.environments).map(([name,env])=>[name,{allowedRefs:env.allowedRefs,requiredApprovals:env.requiredApprovals,targets}])),
  expiresAt:formatTimestamp(Date.parse(createdAt)+validityDays*86400000),
 },{createdAt,now:Date.parse(createdAt)});
}

export async function main(argv){
 const args=parseArgs(argv,{application:{required:true},context:{required:true},'depot-repository':{required:true},'depot-sha':{required:true},'github-output':{},'validity-days':{default:'365',pattern:/^[1-9]\d{0,2}$/},'out-dir':{required:true}});
 const createdAt=formatTimestamp(Date.now());
 const policy=authorizationPolicy({application:loadApplication(args.application),context:loadContext(args.context),depotRepository:args['depot-repository'],depotSha:args['depot-sha'],clock:()=>Date.parse(createdAt),validityDays:Number(args['validity-days'])});
 writeGithubOutput(args['github-output'],{created_at:createdAt});
 writeCanonical(join(args['out-dir'],'authorization-policy.json'),policy);
 process.stdout.write(`authorization-policy.json signer=${policy.signer.identity} expiresAt=${policy.expiresAt}\n`);
}
if(isMain(import.meta.url))runCli(main);
