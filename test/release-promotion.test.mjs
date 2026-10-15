import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {uuidv7,validateHttpsUrl,buildPromotionRequest,requestOidcToken,submitPromotion} from '../ci/release/submit-promotion-request.mjs';
import {validatePromotionRequest,UUID_V7} from '../src/shared/release-contract.mjs';
import {makeApp,buildRelease} from './release-fixtures.mjs';

const TOKEN='aaaaaaaa.bbbbbbbb.cccccccc';
function recorder(responses){
 const calls=[];
 const fetch=async(url,init={})=>{calls.push({url,init});const next=responses.shift();if(next instanceof Error)throw next;return next;};
 return {calls,fetch};
}

test('UUIDv7 embeds the timestamp, version and variant',()=>{
 const id=uuidv7(0x0192_0000_0000,new Uint8Array(10).fill(0xff));
 assert.equal(id,'01920000-0000-7fff-bfff-ffffffffffff');
 assert.match(uuidv7(),UUID_V7);
 assert.ok(uuidv7(1000)<uuidv7(2000));
 assert.throws(()=>uuidv7(-1),/Invalid/);
});

test('admission URLs must be https without credentials or fragments',()=>{
 assert.equal(validateHttpsUrl('https://admission.example.invalid/v1/promotions','admission URL').hostname,'admission.example.invalid');
 for(const url of ['http://admission.example.invalid/v1','https://user:pass@admission.example.invalid/','https://admission.example.invalid/#frag','ftp://x.invalid/','not a url','file:///etc/passwd','javascript:alert(1)'])
  assert.throws(()=>validateHttpsUrl(url,'admission URL'),/admission URL/,url);
});

test('promotion request is derived from a verified manifest and validates',async()=>{
 const f=makeApp();
 try{
  await buildRelease(f);
  const manifest=JSON.parse(readFileSync(join(f.out,'release.meta.json'),'utf8'));
  const request=buildPromotionRequest({manifest,manifestSha256:'a'.repeat(64),environment:'staging',bucket:'releases-r2',expectedCurrentGeneration:17,githubDeploymentId:123,requestedAt:'2026-10-15T00:00:00Z',requestId:uuidv7()});
  validatePromotionRequest(request);
  assert.equal(request.releaseManifestUri,'r2://releases-r2/demoapp/v1.2.3/release.meta.json');
  assert.equal(request.repository,'example-owner/demo-app');
  assert.throws(()=>buildPromotionRequest({manifest,manifestSha256:'a'.repeat(64),environment:'Prod!',bucket:'releases-r2',expectedCurrentGeneration:1,githubDeploymentId:1,requestedAt:'2026-10-15T00:00:00Z',requestId:uuidv7()}),/environment/);
  assert.throws(()=>buildPromotionRequest({manifest:{...manifest,releaseTag:'v1'},manifestSha256:'a'.repeat(64),environment:'staging',bucket:'releases-r2',expectedCurrentGeneration:1,githubDeploymentId:1,requestedAt:'2026-10-15T00:00:00Z',requestId:uuidv7()}));
 }finally{f.cleanup();}
});

const request=()=>({schema:'promotion-request/v1',requestId:uuidv7(),application:'demoapp',environment:'staging',repository:'example-owner/demo-app',releaseTag:'v1.2.3',
 releaseManifestUri:'r2://releases-r2/demoapp/v1.2.3/release.meta.json',releaseManifestSha256:'b'.repeat(64),expectedCurrentGeneration:0,githubDeploymentId:5,requestedAt:'2026-10-15T00:00:00Z'});

test('submission POSTs once with bearer token, canonical body and redirects disabled',async()=>{
 const r=request(),{calls,fetch}=recorder([new Response('{"accepted":true}',{status:202})]);
 assert.deepEqual(await submitPromotion({url:'https://admission.example.invalid/v1/promotions',token:TOKEN,request:r,fetch}),{status:202,ok:true});
 assert.equal(calls.length,1);
 const [{url,init}]=calls;
 assert.equal(url,'https://admission.example.invalid/v1/promotions');
 assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
 assert.equal(init.headers.authorization,`Bearer ${TOKEN}`);
 assert.equal(init.headers['content-type'],'application/json');
 assert.ok(init.signal instanceof AbortSignal);
 assert.deepEqual(JSON.parse(init.body),r);
 assert.equal(init.body,JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a<b?-1:1))));
});

test('submission does not retry and reports failures, timeouts and redirects',async()=>{
 const rejected=recorder([new Response('denied',{status:409}),new Response('ok',{status:202})]);
 assert.deepEqual(await submitPromotion({url:'https://admission.example.invalid/',token:TOKEN,request:request(),fetch:rejected.fetch}),{status:409,ok:false});
 assert.equal(rejected.calls.length,1);
 const down=recorder([new TypeError('fetch failed: redirect mode is set to error'),new Response('ok',{status:202})]);
 await assert.rejects(()=>submitPromotion({url:'https://admission.example.invalid/',token:TOKEN,request:request(),fetch:down.fetch}),/redirect/);
 assert.equal(down.calls.length,1);
 const none=recorder([]);
 await assert.rejects(()=>submitPromotion({url:'http://admission.example.invalid/',token:TOKEN,request:request(),fetch:none.fetch}),/must use https/);
 await assert.rejects(()=>submitPromotion({url:'https://admission.example.invalid/',token:TOKEN,request:{...request(),requestId:'not-a-uuid'},fetch:none.fetch}),/requestId/);
 assert.equal(none.calls.length,0);
});

test('OIDC token is requested from the Actions runtime with the configured audience',async()=>{
 const env={ACTIONS_ID_TOKEN_REQUEST_URL:'https://runtime.example.invalid/idtoken?api-version=2.0',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'request-request-request'};
 const ok=recorder([new Response(JSON.stringify({value:TOKEN}),{status:200})]);
 assert.equal(await requestOidcToken({env,audience:'admission.example.invalid',fetch:ok.fetch}),TOKEN);
 const url=new URL(ok.calls[0].url);
 assert.equal(url.searchParams.get('audience'),'admission.example.invalid');
 assert.equal(url.searchParams.get('api-version'),'2.0');
 assert.equal(ok.calls[0].init.headers.authorization,'Bearer request-request-request');
 assert.equal(ok.calls[0].init.redirect,'error');
 await assert.rejects(()=>requestOidcToken({env:{},audience:'a',fetch:ok.fetch}),/id-token: write/);
 await assert.rejects(()=>requestOidcToken({env:{...env,ACTIONS_ID_TOKEN_REQUEST_URL:'http://runtime.example.invalid/'},audience:'a',fetch:ok.fetch}),/https/);
 await assert.rejects(()=>requestOidcToken({env,audience:'bad audience',fetch:ok.fetch}),/audience/);
 const malformed=recorder([new Response(JSON.stringify({value:'not a jwt'}),{status:200})]);
 await assert.rejects(()=>requestOidcToken({env,audience:'a',fetch:malformed.fetch}),/malformed/);
 const denied=recorder([new Response('no',{status:403})]);
 await assert.rejects(()=>requestOidcToken({env,audience:'a',fetch:denied.fetch}),/HTTP 403/);
});
