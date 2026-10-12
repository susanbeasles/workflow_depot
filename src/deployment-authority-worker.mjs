import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {createDeploymentAuthority} from './deployment-authority.mjs';

const LIMIT=65536;
const publicActions=['authorize','revoke','status'],privateActions=['consume','check','complete'];
class RequestError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function json(value,status=200){const body=JSON.stringify(value);if(new TextEncoder().encode(body).length>LIMIT)return json({error:'response-too-large'},500);return new Response(body,{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
function policy(env){if(typeof env.DEPLOYMENT_POLICY_JSON!=='string'||env.DEPLOYMENT_POLICY_JSON.length>LIMIT)throw new RequestError(503,'authority-unavailable');return JSON.parse(env.DEPLOYMENT_POLICY_JSON);}
function ready(env){
 if(env.ENABLED!=='true'||!env.DEPLOYMENT_STATE||typeof env.DEPLOYMENT_EVIDENCE?.verify!=='function')throw new RequestError(503,'authority-unavailable');
 if(policy(env).enabled!==true)throw new RequestError(503,'authority-unavailable');
}
async function readJSON(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw new RequestError(415,'json-required');
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>LIMIT))throw new RequestError(413,'request-too-large');
 const reader=request.body?.getReader();if(!reader)throw new RequestError(400,'invalid-request');
 const chunks=[];let length=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>LIMIT){await reader.cancel();throw new RequestError(413,'request-too-large');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new RequestError(400,'invalid-request');}
}
function action(request,allowed){
 const url=new URL(request.url),name=url.pathname.replace(/^\/v1\/deployments\//,'');
 if(url.search||url.pathname!=='/v1/deployments/'+name||!allowed.includes(name))throw new RequestError(404,'not-found');
 if(request.method!=='POST')throw new RequestError(405,'method-not-allowed');return name;
}
function failure(error){return error instanceof RequestError?json({error:error.code},error.status):json({error:'deployment-authority-denied'},403);}
async function forward(request,env,allowed){
 try{
  const name=action(request,allowed);ready(env);const body=await readJSON(request);
  const stub=env.DEPLOYMENT_STATE.get(env.DEPLOYMENT_STATE.idFromName('deployment-authority-v1'));
  return await stub.fetch(new Request('https://deployment-state.internal/v1/deployments/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 }catch(error){return failure(error);}
}

// Only authorizer OIDC can create or revoke authority through public HTTP.
export default {fetch(request,env){return forward(request,env,publicActions);}};

// IaC grants this entrypoint only to delivery_control. No public route forwards it.
export class DeploymentAuthority extends WorkerEntrypoint {
 fetch(request){return forward(request,this.env,privateActions);}
}

export class DeploymentAuthorityState extends DurableObject {
 async fetch(request){
  try{
   const name=action(request,[...publicActions,...privateActions]);ready(this.env);const input=await readJSON(request);
   const authority=createDeploymentAuthority({storage:this.ctx.storage,policy:()=>policy(this.env),evidence:{verify:operation=>this.env.DEPLOYMENT_EVIDENCE.verify(operation)}});
   return json(await authority[name](input));
  }catch(error){return failure(error);}
 }
}
