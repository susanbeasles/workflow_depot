import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {createIntegrationRuntime} from './integration-runtime.mjs';
const denied=()=>{throw Error('integration-coordinator-unavailable');};
async function guarded(fn){try{return await fn();}catch{denied();}}
function configuration(env,repositoryID){
 if(env.ENABLED!=='true'||!Number.isSafeInteger(repositoryID)||repositoryID<1||Number(env.INTEGRATION_REPOSITORY_ID)!==repositoryID||!/^[a-f0-9]{64}$/.test(env.SIGNING_CONFIGURATION_DIGEST??''))denied();
 return {digest:env.SIGNING_CONFIGURATION_DIGEST};
}
export default {fetch(){return new Response('Not found',{status:404});}};
export class IntegrationRepository extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.draining=null;this.runtime=null;}
 getRuntime(repositoryID){
  const config=configuration(this.env,repositoryID);
  if(!this.env.INTEGRATION_STATE||this.env.INTEGRATION_STATE.idFromName(String(repositoryID)).toString()!==this.ctx.id.toString()||typeof this.env.INTEGRATION_SOURCE?.current!=='function')denied();
  if(!this.runtime)this.runtime=createIntegrationRuntime({storage:this.ctx.storage,source:this.env.INTEGRATION_SOURCE,actions:this.env.SIGNING_CONTROL,repositoryID,configurationDigest:config.digest});
  return this.runtime;
 }
 async reconcileIntegration(input){
  if(!input||Object.keys(input).sort().join()!=='repositoryID,sourcePRNumber'||!Number.isSafeInteger(input.sourcePRNumber)||input.sourcePRNumber<1)denied();this.getRuntime(input.repositoryID);
  await this.ctx.storage.put('wake:'+input.sourcePRNumber,{input,wakeupID:crypto.randomUUID()});await this.ctx.storage.setAlarm(Date.now()+1000);this.ctx.waitUntil(this.drain());return {accepted:true};
 }
 drain(){
  if(this.draining)return this.draining;
  this.draining=(async()=>{
   const queue=await this.ctx.storage.list({prefix:'wake:',limit:100});
   for(const [key,wake]of queue){
    try{const result=await this.getRuntime(wake.input.repositoryID).reconcileIntegration(wake.input);
     if(result.state!=='stale')await this.ctx.storage.transaction(async tx=>{if((await tx.get(key))?.wakeupID===wake.wakeupID)await tx.delete(key);});
    }catch{await this.ctx.storage.put('status:'+wake.input.sourcePRNumber,{state:'blocked',reason:'reconciliation_required'});}
   }
   if((await this.ctx.storage.list({prefix:'wake:',limit:1})).size)await this.ctx.storage.setAlarm(Date.now()+30000);
  })().finally(()=>{this.draining=null;});return this.draining;
 }
 alarm(){return this.drain();}
}
export class IntegrationActions extends WorkerEntrypoint {
 reconcileIntegration(input){return guarded(()=>{configuration(this.env,input?.repositoryID);if(!this.env.INTEGRATION_STATE)denied();return this.env.INTEGRATION_STATE.getByName(String(input.repositoryID)).reconcileIntegration(input);});}
 fetch(){return new Response('Not found',{status:404});}
}
