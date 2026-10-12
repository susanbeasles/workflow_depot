import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../src/integration-source.mjs').catch(()=>({}));
test('source adapter binds live PR/main and trusted intent without running source code',async()=>{
 assert.equal(typeof api.createIntegrationSource,'function');const calls=[];
 const source=api.createIntegrationSource({repository:'owner/project',repositoryID:7,credential:async()=>({repositoryID:7,token:'SYNTHETIC',expiresAt:1200}),clock:()=>1000,policy:{integrationIntent:async x=>({author:'Owner <owner@example.invalid> 1000 +0000',committer:'Signer <signer@example.invalid> 1000 +0000',message:'Integration\n',artifactIntentDigest:'d'.repeat(64)})},fetcher:async url=>{calls.push(url);return Response.json(url.endsWith('/git/ref/heads/main')?{ref:'refs/heads/main',object:{sha:'b'.repeat(40),type:'commit'}}:{number:9,state:'open',head:{ref:'feature/ticket',sha:'a'.repeat(40),repo:{id:7,full_name:'owner/project'}},base:{ref:'main',repo:{id:7,full_name:'owner/project'}}});}});
 const result=await source.current({repositoryID:7,sourcePRNumber:9});assert.equal(result.headRef,'refs/heads/feature/ticket');assert.equal(result.baseSHA,'b'.repeat(40));assert.equal(result.prepareInput.sourcePR.headSHA,result.headSHA);assert.equal(result.prepareInput.expiresAt,1300);assert(calls.every(x=>x.startsWith('https://api.github.com/repos/owner/project/')));
});
