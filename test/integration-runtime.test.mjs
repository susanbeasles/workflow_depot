import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../src/integration-runtime.mjs').catch(()=>({}));
test('runtime resumes completed durable jobs without executing them twice',async()=>{
 assert.equal(typeof api.createIntegrationRuntime,'function');const map=new Map(),jobs=new Map(),storage={get:async k=>structuredClone(map.get(k)),put:async(k,v)=>map.set(k,structuredClone(v))};let count=0;
 const actions={execute:async job=>{count++;const result=job.action==='prepare'?{sequence:1,shadowRef:'refs/heads/int/feature/ticket'}:{sequence:1};const status={state:'completed',result};jobs.set(job.id,status);return status;},status:async({id,repositoryID})=>{assert.equal(repositoryID,7);if(!jobs.has(id))throw Error('absent');return jobs.get(id);}};
 const source={current:async()=>({repositoryID:7,sourcePRNumber:9,headRepositoryID:7,headRef:'refs/heads/feature/ticket',headSHA:'a'.repeat(40),baseRef:'refs/heads/main',baseSHA:'b'.repeat(40),state:'open',prepareInput:{repositoryID:7,sourcePR:{number:9,repositoryID:7,headSHA:'a'.repeat(40)}}})};
 const options={storage,source,actions,repositoryID:7,configurationDigest:'c'.repeat(64),clock:()=>1000};
 await api.createIntegrationRuntime(options).reconcileIntegration({repositoryID:7,sourcePRNumber:9});
 await api.createIntegrationRuntime(options).reconcileIntegration({repositoryID:7,sourcePRNumber:9});assert.equal(count,2);
});
