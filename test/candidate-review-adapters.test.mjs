import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGitHubSourceReader,createReviewerIdentity,createOpenAIReviewer} from '../src/candidate-review-adapters.mjs';
import {canonical,hash} from '../src/candidate-review.mjs';
const sha=c=>c.repeat(40),hex=c=>c.repeat(64);
const source={repository:'susanbeasles/app',repositoryID:1,ownerID:215839550,commitSHA:sha('a'),sourceRef:'refs/heads/promotion/1/shadow',runID:3,runAttempt:1};
const candidate={treeSHA:sha('b'),expectedMainParent:sha('d'),policyDigest:hex('e')};
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
test('source reader uses only fixed-origin GETs and exact raw commit Contents; verifies blob bytes',async()=>{
 const calls=[],content='export const value = 1;\n',blob=createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
 const fetcher=async(url,options)=>{calls.push({url,options});if(url.includes('/git/commits/'))return response({sha:url.split('/').at(-1),tree:{sha:sha('b')},parents:[{sha:sha('d')}]});if(url.includes('/git/trees/'))return response({sha:sha('b'),truncated:false,tree:[{path:'src/app.js',type:'blob',mode:'100644',sha:blob,size:Buffer.byteLength(content)}]});return new Response(content);};
 const code=await createGitHubSourceReader({fetcher,token:'synthetic-read-token'}).read({source,candidate});assert.equal(code.files[0].content,content);assert.equal(calls.length,6);assert.ok(calls.every(c=>c.url.startsWith('https://api.github.com/repos/susanbeasles/app/')&&c.options.method==='GET'&&c.options.redirect==='error'));assert.equal(calls[2].url,'https://api.github.com/repos/susanbeasles/app/contents/src/app.js?ref='+sha('a'));assert.equal(calls[2].options.headers.accept,'application/vnd.github.raw+json');
});
test('truncated trees, symlinks, invalid UTF-8 and changed blob bytes fail closed',async()=>{
 for(const kind of ['truncated','symlink','bytes','utf8']){const fetcher=async url=>{if(url.includes('/git/commits/'))return response({sha:sha('a'),tree:{sha:sha('b')},parents:[{sha:sha('d')}]});if(url.includes('/git/trees/'))return response({sha:sha('b'),truncated:kind==='truncated',tree:[{path:'x',type:'blob',mode:kind==='symlink'?'120000':'100644',sha:sha('e'),size:2}]});return new Response(kind==='utf8'?new Uint8Array([255,255]):'xx');};await assert.rejects(createGitHubSourceReader({fetcher}).read({source,candidate}));}
});
test('provider requires explicit repository and policy scoped upload authorization before credential lookup',async()=>{
 let calls=0;const provider=createOpenAIReviewer({config:{model:'synthetic-model',uploadAuthorized:false},credential:async()=>{calls++;return 'synthetic';},fetcher:async()=>{calls++;throw Error('unexpected');}});
 assert.deepEqual(await provider.review({source,candidate}),{state:'unavailable'});assert.equal(calls,0);
});
test('provider sends fixed no-tools/no-store structured request and parses only completed output',async()=>{
 const input={source,candidate},requests=[];
 const provider=createOpenAIReviewer({config:{model:'synthetic-model',uploadAuthorized:true,repositoryID:1,policyDigest:hex('e')},credential:async()=>'synthetic',fetcher:async(url,options)=>{requests.push({url,options});return response({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({verdict:'approved',findings:[]})}]}]});}});
 assert.deepEqual(await provider.review(input),{verdict:'approved',findings:[],inputDigest:hash(canonical(input))});assert.equal(requests[0].url,'https://api.openai.com/v1/responses');const body=JSON.parse(requests[0].options.body);assert.equal(body.store,false);assert.deepEqual(body.tools,[]);assert.equal(body.text.format.type,'json_schema');assert.equal(body.text.format.strict,true);assert.equal(body.model,'synthetic-model');assert.equal(requests[0].options.redirect,'error');
});
test('provider refusal, incomplete output, extra authority fields and vendor errors never approve or reflect secrets',async()=>{
 for(const data of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'synthetic private text'}]}]},{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"verdict":"approved","findings":[],"command":"do evil"}'}]}]},null]){
  const provider=createOpenAIReviewer({config:{model:'synthetic-model',uploadAuthorized:true,repositoryID:1,policyDigest:hex('e')},credential:async()=>'synthetic-private',fetcher:async()=>data?response(data):new Response('synthetic private secret',{status:400})});await assert.rejects(provider.review({source,candidate}),error=>error.message==='REVIEW_PROVIDER_UNAVAILABLE');
 }
});
test('reviewer identity checks actual app, source installation, bot actor and exact-S independent check',async()=>{
 const policy={reviewPolicy:{reviewerAppID:11,reviewerInstallationID:12,reviewerActorID:13,checkName:'Independent review',privilegedAppIDs:[20],privilegedActorIDs:[21]}};
 let calls=0;const fetcher=async url=>{calls++;if(url.endsWith('/app'))return response({id:11,slug:'independent-review'});if(url.endsWith('/installation'))return response({id:12,app_id:11,account:{id:source.ownerID}});if(url.includes('/users/'))return response({id:13,type:'Bot',login:'independent-review[bot]'});return response({total_count:1,check_runs:[{name:'Independent review',head_sha:source.commitSHA,status:'in_progress',app:{id:11}}]});};
 assert.deepEqual(await createReviewerIdentity({getAppJWT:async()=>'synthetic',fetcher}).verify({source,candidate,policy}),{verified:true,commitSHA:source.commitSHA,appID:11,installationID:12,actorID:13});assert.equal(calls,4);
 policy.reviewPolicy.reviewerInstallationID=99;await assert.rejects(createReviewerIdentity({getAppJWT:async()=>'synthetic',fetcher}).verify({source,candidate,policy}));
});
