import {createHmac,timingSafeEqual} from 'node:crypto';
const check=ok=>{if(!ok)throw Error('Integration event denied');};
export async function handleIntegrationEvent({eventName,payload},{repository,repositoryID,source,reconciler}){
 check(payload?.repository?.id===repositoryID&&payload.repository.full_name===repository);
 const reconcile=async pull=>{check(Number.isSafeInteger(pull?.number)&&pull.number>0);if(pull.head?.repo?.id!==repositoryID||typeof pull.head.ref!=='string'||pull.head.ref.startsWith('int/'))return;await reconciler.reconcileIntegration({repositoryID,sourcePRNumber:pull.number});};
 if(eventName==='pull_request'&&['opened','reopened','synchronize','edited','closed','ready_for_review'].includes(payload.action)){
  // Re-fetching in reconciliation decides current base/state; even retarget and
  // close events are wakeups, never authority to delete a ref from event fields.
  await reconcile(payload.pull_request);return;
 }
 if(eventName==='push'&&payload.ref==='refs/heads/main'&&payload.deleted!==true){
  const seen=new Set();for(let page=1;page<=100;page++){
   const pulls=await source.listOpen({repositoryID,page,perPage:100});check(Array.isArray(pulls)&&pulls.length<=100);
   for(const p of pulls){check(!seen.has(p.number));seen.add(p.number);if(p.base?.ref==='main')await reconcile(p);}
   if(pulls.length<100)return;
  }throw Error('Open integration source list exceeds bound');
 }
}
export function createIntegrationWebhook(options){
 check(typeof options.secret==='string'&&options.secret.length>=16&&options.secret.length<=8192&&Number.isSafeInteger(options.repositoryID)&&options.repositoryID>0&&typeof options.source?.listOpen==='function'&&typeof options.reconciler?.reconcileIntegration==='function');
 return async request=>{
  if(request.method!=='POST')return new Response('Method not allowed',{status:405});
  try{
   const reader=request.body?.getReader();check(reader);let size=0;const chunks=[];
   try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;check(size<=1024*1024);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const bytes=Buffer.concat(chunks),header=request.headers.get('x-hub-signature-256');check(/^sha256=[a-f0-9]{64}$/.test(header??''));
   check(timingSafeEqual(createHmac('sha256',options.secret).update(bytes).digest(),Buffer.from(header.slice(7),'hex')));
   const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   await handleIntegrationEvent({eventName:request.headers.get('x-github-event'),payload},options);
   return Response.json({accepted:true},{status:202});
  }catch{return Response.json({error:'integration_event_denied_or_reconciliation_required'},{status:403});}
 };
}
