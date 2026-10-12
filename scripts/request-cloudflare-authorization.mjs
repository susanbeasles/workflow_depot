import {pathToFileURL} from 'node:url';
import {canonical,digest} from '../src/shared/contract.mjs';
import {HEX,SHA,context,exact,identityRequest,identity,post,requireValue} from './cloudflare-caller-http.mjs';

// Source-owned commissioning switch. No workflow input can change destinations,
// trust identities or this switch. The service retains the independent policy.
export const CONFIG=Object.freeze({enabled:false,repository:'susanbeasles/workflow_depot',repositoryID:1405415683,workflow:'authorize-cloudflare.yml'});
const origin='https://pipeline.vespoli.me',audience='workflow-depot-deployment-authorizer';
export async function authorize({raw,operationDigest,env=process.env,config=CONFIG,fetcher=fetch,clock=()=>Math.floor(Date.now()/1000)}){
 try{
  const who=context(env,config);
  requireValue(typeof raw==='string'&&Buffer.byteLength(raw)<=32768&&HEX.test(operationDigest??''));
  const operation=JSON.parse(raw);requireValue(canonical(operation)===raw&&await digest(operation)===operationDigest);
  // These checks bind the reviewable request, not authority. The retained depot
  // service validates the full operation/target schema and independent evidence.
  requireValue(operation.schema==='workflow-depot-cloudflare-deploy/v1'&&['operationID','nonce','policyDigest','artifactDigest','metadataDigest'].every(k=>HEX.test(operation[k]??'')));
  requireValue(SHA.test(operation.source?.commitSHA??'')&&HEX.test(operation.source?.signingReceiptDigest??'')&&exact(operation.execution,['runID','runAttempt'])&&Object.values(operation.execution).every(n=>Number.isSafeInteger(n)&&n>0));
  const live=()=>requireValue(Number.isSafeInteger(operation.expiresAt)&&operation.expiresAt>clock()&&operation.expiresAt<=clock()+600);live();
  const oidcToken=await identity(fetcher,identityRequest(env,audience+':'+operation.operationID));live();
  const result=await post(fetcher,origin+'/v1/deployments/authorize',{operation,oidcToken,authorizerRunID:who.runID,authorizerRunAttempt:who.runAttempt});
  requireValue(exact(result,['operationID','state'])&&result.operationID===operation.operationID&&result.state==='authorized');return result;
 }catch{throw Error('Cloudflare authorization request unavailable');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await authorize({raw:process.env.CLOUDFLARE_OPERATION,operationDigest:process.env.CLOUDFLARE_OPERATION_DIGEST})));}
 catch{console.error('Cloudflare authorization request unavailable; reconcile authority before retrying.');process.exitCode=1;}
}
