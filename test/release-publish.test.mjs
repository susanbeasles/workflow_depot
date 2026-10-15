import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {publishGithubRelease,RELEASE_ASSETS,modeOf} from '../ci/release/publish-github-release.mjs';
import {publishObjects,OBJECT_ORDER,credentialsFrom} from '../ci/release/publish-objects.mjs';
import {makeApp,buildRelease,write,SOURCE_COMMIT} from './release-fixtures.mjs';

const TOKEN='test-token-test-token';
const SIGNATURE=JSON.stringify({mediaType:'application/vnd.dev.sigstore.bundle.v0.3+json'});
const REPO='example-owner/demo-app';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status});
const hex=b=>createHash('sha256').update(b).digest('hex');

async function signedRelease(){
 const f=makeApp();
 await buildRelease(f);
 for(const name of ['release.zip.sigstore.json','release.meta.json.sigstore.json'])write(f.out,name,SIGNATURE);
 return f;
}
// Scripted GitHub API: answers by method+path, records every call.
function github({releaseExists=false,tagBefore=null,tagAfter=SOURCE_COMMIT,annotated=false,uploadRename=null}={}){
 const calls=[];let published=false;
 const fetch=async(url,init)=>{
  const u=new URL(url),key=`${init.method} ${u.host}${u.pathname}`;calls.push({key,url,init});
  assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,`Bearer ${TOKEN}`);
  if(key===`GET api.github.com/repos/${REPO}/releases/tags/v1.2.3`)return releaseExists?json({id:1}):json({message:'Not Found'},404);
  if(key===`GET api.github.com/repos/${REPO}/git/ref/tags/v1.2.3`){
   const sha=published?tagAfter:tagBefore;
   if(!sha)return json({message:'Not Found'},404);
   return json({ref:'refs/tags/v1.2.3',object:annotated?{type:'tag',sha:'a'.repeat(40)}:{type:'commit',sha}});
  }
  if(key===`GET api.github.com/repos/${REPO}/git/tags/${'a'.repeat(40)}`)return json({object:{type:'commit',sha:published?tagAfter:tagBefore}});
  if(key===`POST api.github.com/repos/${REPO}/releases`)return json({id:77,draft:true},201);
  if(key===`POST uploads.github.com/repos/${REPO}/releases/77/assets`){
   const name=u.searchParams.get('name');
   return json({name:uploadRename===name?`${name}.1`:name,size:init.body.length,digest:`sha256:${hex(init.body)}`},201);
  }
  if(key===`PATCH api.github.com/repos/${REPO}/releases/77`){published=true;return json({id:77,draft:false,tag_name:'v1.2.3'});}
  return json({message:'unexpected'},500);
 };
 return {calls,fetch};
}
const publish=(f,mode,gh)=>publishGithubRelease({repository:REPO,releaseTag:'v1.2.3',sha:SOURCE_COMMIT,mode,releaseDir:f.out,token:TOKEN,fetch:gh.fetch});

test('GitHub publication: draft, upload every asset, publish, confirm tag',async()=>{
 const f=await signedRelease();
 try{
  const gh=github();
  assert.deepEqual(await publish(f,'main',gh),{id:77,url:`https://github.com/${REPO}/releases/tag/v1.2.3`});
  const keys=gh.calls.map(c=>c.key);
  assert.equal(keys[0],`GET api.github.com/repos/${REPO}/releases/tags/v1.2.3`);
  assert.equal(keys[2],`POST api.github.com/repos/${REPO}/releases`);
  const draft=JSON.parse(gh.calls[2].init.body);
  assert.equal(draft.draft,true);assert.equal(draft.target_commitish,SOURCE_COMMIT);assert.equal(draft.tag_name,'v1.2.3');
  const uploads=gh.calls.filter(c=>c.key.startsWith('POST uploads.github.com')).map(c=>new URL(c.url).searchParams.get('name'));
  assert.deepEqual(uploads,RELEASE_ASSETS);
  assert.equal(RELEASE_ASSETS.length,9);
  assert.ok(keys.indexOf(`PATCH api.github.com/repos/${REPO}/releases/77`)>keys.lastIndexOf(`POST uploads.github.com/repos/${REPO}/releases/77/assets`));
  assert.equal(keys.at(-1),`GET api.github.com/repos/${REPO}/git/ref/tags/v1.2.3`);
 }finally{f.cleanup();}
});

test('GitHub publication is write-once and verifies the tag target',async()=>{
 const f=await signedRelease();
 try{
  let gh=github({releaseExists:true});
  await assert.rejects(()=>publish(f,'main',gh),/already exists; releases are write-once/);
  assert.ok(!gh.calls.some(c=>c.init.method==='POST'));
  gh=github({tagBefore:'f'.repeat(40)});
  await assert.rejects(()=>publish(f,'main',gh),/Tag v1.2.3 already exists/);
  assert.ok(!gh.calls.some(c=>c.init.method==='POST'));
  gh=github({tagBefore:'f'.repeat(40),tagAfter:'f'.repeat(40)});
  await assert.rejects(()=>publish(f,'tag',gh),/does not point at/);
  gh=github({tagBefore:SOURCE_COMMIT,annotated:true});
  assert.equal((await publish(f,'tag',gh)).id,77);
  gh=github({tagAfter:'e'.repeat(40)});
  await assert.rejects(()=>publish(f,'main',gh),/does not point at .*investigate/);
  gh=github({uploadRename:'checksums.json'});
  await assert.rejects(()=>publish(f,'main',gh),/renamed or truncated \(draft release 77 left for operator review\)/);
  assert.ok(!gh.calls.some(c=>c.init.method==='PATCH'));
  await assert.rejects(()=>publishGithubRelease({repository:REPO,releaseTag:'v1.2.4',sha:SOURCE_COMMIT,mode:'main',releaseDir:f.out,token:TOKEN,fetch:github().fetch}),/does not describe/);
  await assert.rejects(()=>publishGithubRelease({repository:REPO,releaseTag:'v1.2.3',sha:SOURCE_COMMIT,mode:'main',releaseDir:f.out,token:'',fetch:github().fetch}),/GITHUB_TOKEN/);
  assert.equal(modeOf('refs/heads/main'),'main');assert.equal(modeOf('refs/tags/v1.2.3'),'tag');assert.equal(modeOf('refs/heads/dev'),null);
 }finally{f.cleanup();}
});

test('R2 publication signs every PUT with If-None-Match and uploads the manifest last',async()=>{
 const f=await signedRelease();
 try{
  const calls=[];
  const fetch=async(url,init)=>{calls.push({url,init});return new Response('',{status:200});};
  const credentials={accessKeyId:'NOTAREALKEYID0000000',secretAccessKey:'not-a-secret-not-a-secret'};
  const keys=await publishObjects({releaseDir:f.out,accountId:'0123456789abcdef0123456789abcdef',bucket:'releases-r2',credentials,fetch,now:()=>new Date('2026-10-15T12:00:00Z')});
  assert.deepEqual(keys,OBJECT_ORDER.map(n=>`demoapp/v1.2.3/${n}`));
  assert.equal(calls.at(-1).url,'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/releases-r2/demoapp/v1.2.3/release.meta.json');
  for(const {url,init} of calls){
   assert.ok(url.startsWith('https://'));
   assert.equal(init.method,'PUT');assert.equal(init.redirect,'error');
   assert.equal(init.headers['if-none-match'],'*');
   assert.equal(init.headers['x-amz-content-sha256'],hex(init.body));
   assert.match(init.headers.authorization,/^AWS4-HMAC-SHA256 Credential=NOTAREALKEYID0000000\/20261015\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
   assert.ok(!JSON.stringify(init.headers).includes(credentials.secretAccessKey));
  }
  assert.deepEqual(Buffer.from(calls[0].init.body),readFileSync(join(f.out,'release.zip')));
 }finally{f.cleanup();}
});

test('R2 publication stops on existing objects and validates inputs',async()=>{
 const f=await signedRelease();
 try{
  const credentials={accessKeyId:'NOTAREALKEYID0000000',secretAccessKey:'not-a-secret-not-a-secret'};
  const calls=[];
  const fetch=async url=>{calls.push(url);return new Response('',{status:calls.length===2?412:200});};
  await assert.rejects(()=>publishObjects({releaseDir:f.out,accountId:'0123456789abcdef0123456789abcdef',bucket:'releases-r2',credentials,fetch}),/already exists; release objects are write-once/);
  assert.equal(calls.length,2);
  assert.ok(!calls.some(u=>u.endsWith('/release.meta.json')));
  await assert.rejects(()=>publishObjects({releaseDir:f.out,accountId:'not-hex',bucket:'releases-r2',credentials,fetch}),/account id/);
  await assert.rejects(()=>publishObjects({releaseDir:f.out,accountId:'0123456789abcdef0123456789abcdef',bucket:'Bad_Bucket',credentials,fetch}),/bucket/);
  assert.throws(()=>credentialsFrom({}),/credentials missing/);
  assert.deepEqual(credentialsFrom({R2_ACCESS_KEY_ID:credentials.accessKeyId,R2_SECRET_ACCESS_KEY:credentials.secretAccessKey}),credentials);
 }finally{f.cleanup();}
});
