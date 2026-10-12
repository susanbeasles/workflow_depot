import {integrationRef} from './candidate-admission-client.mjs';
const need=ok=>{if(!ok)throw Error('Integration source unavailable');};
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
export function createIntegrationSource({repository,repositoryID,credential,policy,fetcher=fetch,clock=()=>Math.floor(Date.now()/1000)}){
 need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)&&Number.isSafeInteger(repositoryID)&&repositoryID>0&&typeof credential==='function'&&typeof policy?.integrationIntent==='function');
 async function read(path){
  const grant=await credential({repositoryID,repository});need(grant?.repositoryID===repositoryID&&typeof grant.token==='string'&&grant.token.length>0&&grant.token.length<=8192&&!/[\s\0]/.test(grant.token)&&grant.expiresAt>clock());
  const response=await fetcher('https://api.github.com/repos/'+repository+path,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+grant.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'}});
  need(response.ok);const reader=response.body?.getReader();need(reader);const chunks=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;need(bytes<=1024*1024);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 }
 return Object.freeze({
  async listOpen({repositoryID:id,page,perPage}){need(id===repositoryID&&Number.isSafeInteger(page)&&page>=1&&page<=100&&perPage===100);const values=await read(`/pulls?state=open&base=main&per_page=100&page=${page}`);need(Array.isArray(values)&&values.length<=100);return values;},
  async current({repositoryID:id,sourcePRNumber}){
   need(id===repositoryID&&Number.isSafeInteger(sourcePRNumber)&&sourcePRNumber>0);
   const p=await read('/pulls/'+sourcePRNumber),main=await read('/git/ref/heads/main');
   need(p.number===sourcePRNumber&&p.head?.repo?.id===repositoryID&&p.head.repo.full_name===repository&&p.base?.repo?.id===repositoryID&&p.base.repo.full_name===repository&&sha(p.head.sha)&&main.ref==='refs/heads/main'&&main.object?.type==='commit'&&sha(main.object.sha)&&['open','closed'].includes(p.state));
   const headRef='refs/heads/'+p.head.ref;integrationRef(headRef);
   const result={repositoryID,sourcePRNumber,headRepositoryID:repositoryID,headRef,headSHA:p.head.sha,baseRef:'refs/heads/'+p.base.ref,baseSHA:main.object.sha,state:p.state};
   if(p.state==='open'&&p.base.ref==='main'){
    const intent=await policy.integrationIntent({...result,repository});need(intent&&Object.keys(intent).sort().join()==='artifactIntentDigest,author,committer,message'&&typeof intent.message==='string'&&/^[a-f0-9]{64}$/.test(intent.artifactIntentDigest));
    result.prepareInput={repositoryID,sourcePR:{number:sourcePRNumber,repositoryID,headSHA:p.head.sha},...intent,message:intent.message.trimEnd()+`\n\nSource-PR: ${sourcePRNumber}\nSource-Commit: ${p.head.sha}\nMain-Parent: ${main.object.sha}\n`,expiresAt:clock()+300};
   }
   return result;
  }
 });
}
