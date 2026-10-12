import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {createDeploymentProvenance,createCandidateAdmission} from './deployment-provenance.mjs';
import {githubEvidenceReader} from './deployment-evidence.mjs';

const MAX_REQUEST=6*1024*1024;
class RequestError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function json(value,status=200,max=65536){const body=JSON.stringify(value);if(new TextEncoder().encode(body).length>max)return json({error:'response-too-large'},500);return new Response(body,{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
function policy(env){if(typeof env.DEPLOYMENT_POLICY_JSON!=='string'||env.DEPLOYMENT_POLICY_JSON.length>65536)throw new RequestError(503,'staging-unavailable');return JSON.parse(env.DEPLOYMENT_POLICY_JSON);}
function ready(env,mode='stage'){if(env.ENABLED!=='true'||typeof env.SOURCE_CANDIDATES?.lookupCandidate!=='function'||policy(env).enabled!==true||(mode!=='verify'&&(!env.BUILD_PROVENANCE_STATE||!env.DEPLOYMENT_ARTIFACTS)))throw new RequestError(503,'staging-unavailable');}
function failure(error){return error instanceof RequestError?json({error:error.code},error.status):json({error:'artifact-request-denied'},403);}
async function readJSON(request,max){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw new RequestError(415,'json-required');
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))throw new RequestError(413,'request-too-large');
 const reader=request.body?.getReader();if(!reader)throw new RequestError(400,'invalid-request');const chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw new RequestError(413,'request-too-large');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new RequestError(400,'invalid-request');}
}
function route(request,mode){const url=new URL(request.url),path=mode==='stage'?'/v1/artifacts':mode==='verify'?'/v1/candidates/verify':'/v1/artifacts/lookup';if(url.pathname!==path||url.search)throw new RequestError(404,'not-found');if(request.method!=='POST')throw new RequestError(405,'method-not-allowed');}
async function forward(request,env,mode){
 try{
  route(request,mode);ready(env);const input=await readJSON(request,mode==='stage'?MAX_REQUEST:1024);
  const stub=env.BUILD_PROVENANCE_STATE.get(env.BUILD_PROVENANCE_STATE.idFromName('build-provenance-v1'));
  return await stub.fetch(new Request('https://build-provenance.internal'+(mode==='stage'?'/v1/artifacts':'/v1/artifacts/lookup'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
 }catch(error){return failure(error);}
}

export default {async fetch(request,env){
 if(new URL(request.url).pathname!=='/v1/candidates/verify')return forward(request,env,'stage');
 try{
  route(request,'verify');ready(env,'verify');const input=await readJSON(request,32768);
  const candidates={lookupCandidate:input=>env.SOURCE_CANDIDATES.lookupCandidate(input)};
  if(typeof env.SOURCE_CANDIDATES.lookupReviewPolicy==='function')candidates.lookupReviewPolicy=input=>env.SOURCE_CANDIDATES.lookupReviewPolicy(input);
  const admission=createCandidateAdmission({policy:()=>policy(env),github:githubEvidenceReader({token:env.GITHUB_READ_TOKEN}),candidates});
  return json(await admission.verify(input),200,512*1024);
 }catch(error){return failure(error);}
}};

// This evidence capability is bound privately to the deployment evidence Worker.
// It does not expose stored bytes, bearer tokens, or a deployment approval API.
export class BuildProvenance extends WorkerEntrypoint {
 fetch(request){return forward(request,this.env,'lookup');}
 async lookup(input){
  try{
   const body=JSON.stringify(input);if(new TextEncoder().encode(body).length>1024)throw Error();
   const response=await forward(new Request('https://build-provenance.internal/v1/artifacts/lookup',{method:'POST',headers:{'content-type':'application/json'},body}),this.env,'lookup');
   if(!response.ok)throw Error();return await response.json();
  }catch{throw Error('Artifact provenance unavailable');}
 }
}

export class BuildProvenanceState extends DurableObject {
 async fetch(request){
  try{
   const mode=new URL(request.url).pathname==='/v1/artifacts'?'stage':'lookup';route(request,mode);ready(this.env);
   const input=await readJSON(request,mode==='stage'?MAX_REQUEST:1024);
   const provenance=createDeploymentProvenance({storage:this.ctx.storage,artifacts:this.env.DEPLOYMENT_ARTIFACTS,policy:()=>policy(this.env),github:githubEvidenceReader({token:this.env.GITHUB_READ_TOKEN}),candidates:{lookupCandidate:input=>this.env.SOURCE_CANDIDATES.lookupCandidate(input)}});
   return json(await provenance[mode](input));
  }catch(error){return failure(error);}
 }
}
