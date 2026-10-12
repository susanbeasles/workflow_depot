import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('depot owns reconciliation and calls the standalone signer through scoped RPC',async()=>{
 const runtime=await readFile(new URL('../src/integration-runtime.mjs',import.meta.url),'utf8');
 assert.match(runtime,/actions.status\(\{id,repositoryID\}\)/);
 const worker=await readFile(new URL('../src/integration-coordinator-worker.mjs',import.meta.url),'utf8');
 assert.match(worker,/env.SIGNING_CONTROL/);assert.doesNotMatch(worker,/OP_SERVICE_ACCOUNT_TOKEN|ctx.container/);
});
test('validation caller delegates runner jobs to the depot',async()=>{
 const caller=await readFile(new URL('../.github/workflows/build.yml',import.meta.url),'utf8');
 assert.match(caller,/validate-workflow_depot.yml@[a-f0-9]{40}/);assert.doesNotMatch(caller,/runs-on:|steps:|run:/);
});
test('coordinator rejects wrong repository and exposes only private reconciliation',async()=>{
 let source=await readFile(new URL('../src/integration-coordinator-worker.mjs',import.meta.url),'utf8');
 source=source.replace("import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';","class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} class WorkerEntrypoint extends DurableObject {}");
 source=source.replace("import {createIntegrationRuntime} from './integration-runtime.mjs';","const createIntegrationRuntime=options=>({options});");
 const {IntegrationActions,IntegrationRepository,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const env={ENABLED:'true',INTEGRATION_REPOSITORY_ID:'7',SIGNING_CONFIGURATION_DIGEST:'a'.repeat(64),SIGNING_CONTROL:{execute(){},status(){}},INTEGRATION_SOURCE:{current(){}},INTEGRATION_STATE:{idFromName:name=>({toString:()=>name}),getByName:name=>({reconcileIntegration:async input=>({name,input})})}};
 const entry=new IntegrationActions({},env);assert.equal((await entry.reconcileIntegration({repositoryID:7,sourcePRNumber:9})).name,'7');
 await assert.rejects(entry.reconcileIntegration({repositoryID:8,sourcePRNumber:9}));
 await assert.rejects(new IntegrationActions({}, {...env,ENABLED:'false'}).reconcileIntegration({repositoryID:7,sourcePRNumber:9}));
 const actor=new IntegrationRepository({id:{toString:()=> '7'}},env);assert.equal(actor.getRuntime(7).options.actions,env.SIGNING_CONTROL);assert.throws(()=>actor.getRuntime(8));
 assert.equal(worker.fetch().status,404);assert.equal(entry.fetch().status,404);
});
