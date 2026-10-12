import {WorkerEntrypoint} from 'cloudflare:workers';
import {deploymentEvidence,githubEvidenceReader} from './deployment-evidence.mjs';
import {validatePolicy,validateOperation} from './shared/contract.mjs';

// Public traffic never gets an evidence assertion. Only source-owned service
// bindings to this named entrypoint can request current independent evidence.
export default {fetch(){return new Response('Not found',{status:404});}};
export class DeploymentEvidence extends WorkerEntrypoint {
 async verify(operation){
  try{
   if(this.env.EVIDENCE_ENABLED!=='true'||typeof this.env.DEPLOYMENT_POLICY_JSON!=='string'||this.env.DEPLOYMENT_POLICY_JSON.length>65536)throw Error();
   const policy=validatePolicy(JSON.parse(this.env.DEPLOYMENT_POLICY_JSON));
   await validateOperation(operation,policy,Math.floor(Date.now()/1000));
   return await deploymentEvidence({policy,github:githubEvidenceReader({token:this.env.GITHUB_READ_TOKEN}),signingReceipts:this.env.SIGNING_RECEIPTS,provenance:this.env.BUILD_PROVENANCE}).verify(operation);
  }catch{throw Error('Deployment evidence denied');}
 }
}
