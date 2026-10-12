import {createIntegrationLifecycle} from './integration-lifecycle.mjs';
const check=ok=>{if(!ok)throw Error('Integration runtime unavailable');};
export function createIntegrationRuntime({storage,source,actions,repositoryID,configurationDigest,clock=()=>Math.floor(Date.now()/1000),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 check(Number.isSafeInteger(repositoryID)&&repositoryID>0&&/^[a-f0-9]{64}$/.test(configurationDigest)&&typeof actions?.execute==='function'&&typeof actions?.status==='function');
 async function operation(action,input,id){
  check(input.repositoryID===repositoryID);const key='integration-job:'+id;let job=await storage.get(key);
  if(!job){job={version:1,id,action,input,configDigest:configurationDigest,deadline:clock()+300};await storage.put(key,job);}
  check(job.action===action&&JSON.stringify(job.input)===JSON.stringify(input)&&job.configDigest===configurationDigest);
  let status;try{status=await actions.status({id,repositoryID});}catch{
   check(job.deadline>clock());status=await actions.execute(job);
  }
  while(['launching','running','finishing'].includes(status.state)&&clock()<job.deadline){await sleep(100);status=await actions.status({id,repositoryID});}
  check(status.state==='completed');return status.result;
 }
 const signing={prepare:({input,operationID})=>operation('prepare',input,operationID),publish:({operationID,...input})=>operation('publishShadow',input,operationID),retire:({operationID,...input})=>operation('retireShadow',input,operationID)};
 return createIntegrationLifecycle({storage,source,signing});
}
