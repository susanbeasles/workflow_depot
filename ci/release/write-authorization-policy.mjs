// Writes authorization-policy.json (authorization-policy/v1) from the validated
// application manifest and the depot workflow identity that will sign the release.
// The expiry derives from the source commit time so release.zip stays reproducible.
import {join} from 'node:path';
import {SCHEMAS,GITHUB_ISSUER,formatTimestamp,releaseWorkflowRef,signerIdentity,validateAuthorizationPolicy} from '../../src/shared/release-contract.mjs';
import {loadApplication,loadContext} from './read-application.mjs';
import {parseArgs,isMain,runCli,writeCanonical} from './io.mjs';

export function authorizationPolicy({application,context,depotRepository,depotSha,sourceDateEpoch,validityDays=365}){
 if(!Number.isSafeInteger(sourceDateEpoch)||sourceDateEpoch<=0)throw Error('source date epoch must be a positive integer');
 if(!Number.isSafeInteger(validityDays)||validityDays<1||validityDays>400)throw Error('validity must be 1..400 days');
 if(application.repository!==context.repository||application.repositoryId!==context.repositoryId)throw Error('Application manifest repository does not match the release context');
 const targets=application.targets.map(t=>t.id);
 return validateAuthorizationPolicy({
  schema:SCHEMAS.policy,policyVersion:1,application:application.application,repository:application.repository,repositoryId:application.repositoryId,
  releasePrefix:`${application.application}/`,sourceCommit:context.sourceCommit,releaseTag:context.releaseTag,
  signer:{issuer:GITHUB_ISSUER,identity:signerIdentity(releaseWorkflowRef(depotRepository,depotSha))},
  environments:Object.fromEntries(Object.entries(application.environments).map(([name,env])=>[name,{allowedRefs:env.allowedRefs,requiredApprovals:env.requiredApprovals,targets}])),
  expiresAt:formatTimestamp((sourceDateEpoch+validityDays*86400)*1000),
 });
}

export async function main(argv){
 const args=parseArgs(argv,{application:{required:true},context:{required:true},'depot-repository':{required:true},'depot-sha':{required:true},'source-date-epoch':{required:true,pattern:/^[1-9]\d{0,11}$/},'validity-days':{default:'365',pattern:/^[1-9]\d{0,2}$/},'out-dir':{required:true}});
 const policy=authorizationPolicy({application:loadApplication(args.application),context:loadContext(args.context),depotRepository:args['depot-repository'],depotSha:args['depot-sha'],sourceDateEpoch:Number(args['source-date-epoch']),validityDays:Number(args['validity-days'])});
 writeCanonical(join(args['out-dir'],'authorization-policy.json'),policy);
 process.stdout.write(`authorization-policy.json signer=${policy.signer.identity} expiresAt=${policy.expiresAt}\n`);
}
if(isMain(import.meta.url))runCli(main);
