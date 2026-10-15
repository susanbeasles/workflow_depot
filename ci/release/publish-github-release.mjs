// Write-once GitHub Release publication (the deployer's primary source).
// Order: refuse if the release (or, for main pushes, the tag) already exists ->
// create a DRAFT release targeting the exact commit -> upload every asset -> recheck
// the tag -> publish -> confirm the tag points at the commit. Drafts are invisible
// to GET /releases/tags/{tag}, so consumers never observe a partial asset set.
// Uses fetch (https only, redirects are errors) so the token never appears in argv.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {LIMITS,REPOSITORY,RELEASE_TAG,SHA40,parseJson,validateReleaseManifest} from '../../src/shared/release-contract.mjs';
import {parseArgs,isMain,runCli,readRegularFile,writeGithubOutput} from './io.mjs';

const API='https://api.github.com',UPLOADS='https://uploads.github.com';
export const RELEASE_ASSETS=['release.zip','release.zip.sigstore.json','release.meta.json','release.meta.json.sigstore.json',
 'sbom.cdx.json','sbom.spdx.json','checksums.json','SHA256SUMS','authorization-policy.json'];
const contentTypeOf=name=>name.endsWith('.zip')?'application/zip':name.endsWith('.json')?'application/json':name.endsWith('.jsonl')?'application/jsonl':'text/plain';
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');

export function githubClient({token,fetch:fetcher=globalThis.fetch,timeoutMs=120000}){
 if(typeof token!=='string'||token.length<20||/\s/.test(token))throw Error('GITHUB_TOKEN missing from the environment');
 return async function call(method,url,{body,contentType='application/json',expect}){
  const response=await fetcher(url,{method,body,redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{
   authorization:`Bearer ${token}`,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'workflow-depot-release',
   ...(body===undefined?{}:{'content-type':contentType})}});
  if(!expect.includes(response.status)){await response.body?.cancel?.();throw Error(`GitHub ${method} ${new URL(url).pathname} returned HTTP ${response.status}`);}
  const text=await response.text();
  if(text.length>LIMITS.jsonBytes)throw Error('GitHub response too large');
  return {status:response.status,json:text?JSON.parse(text):null};
 };
}

// Resolves refs/tags/<tag> to a commit (dereferencing annotated tags), or null.
export async function tagCommit(call,repository,tag){
 const ref=await call('GET',`${API}/repos/${repository}/git/ref/tags/${tag}`,{expect:[200,404]});
 if(ref.status===404)return null;
 if(ref.json?.ref!==`refs/tags/${tag}`)throw Error('Unexpected tag reference response');
 let object=ref.json.object;
 for(let depth=0;depth<5&&object?.type==='tag';depth++){
  if(!SHA40.test(object.sha||''))throw Error('Unexpected tag object');
  object=(await call('GET',`${API}/repos/${repository}/git/tags/${object.sha}`,{expect:[200]})).json?.object;
 }
 if(object?.type!=='commit'||!SHA40.test(object.sha||''))throw Error('Tag does not resolve to a commit');
 return object.sha;
}

export async function publishGithubRelease({repository,releaseTag,sha,mode,releaseDir,token,fetch,log=()=>{}}){
 if(!REPOSITORY.test(repository||'')||!RELEASE_TAG.test(releaseTag||'')||!SHA40.test(sha||''))throw Error('Invalid repository, tag or commit');
 if(mode!=='main'&&mode!=='tag')throw Error('mode must be main or tag');
 const assets=RELEASE_ASSETS.map(name=>({name,data:readRegularFile(join(releaseDir,name),LIMITS.releaseBytes,name)}));
 const manifestBytes=assets.find(a=>a.name==='release.meta.json').data;
 const manifest=validateReleaseManifest(parseJson(manifestBytes,{label:'release.meta.json'}));
 if(manifest.repository!==repository||manifest.releaseTag!==releaseTag||manifest.sourceCommit!==sha)throw Error('release.meta.json does not describe this repository, tag and commit');
 const call=githubClient({token,fetch});
 const expectTag=async when=>{
  const current=await tagCommit(call,repository,releaseTag);
  if(mode==='main'&&current!==null)throw Error(`Tag ${releaseTag} already exists (${when}); releases are write-once`);
  if(mode==='tag'&&current!==sha)throw Error(`Tag ${releaseTag} does not point at ${sha} (${when})`);
 };
 const existing=await call('GET',`${API}/repos/${repository}/releases/tags/${releaseTag}`,{expect:[200,404]});
 if(existing.status===200)throw Error(`A release for ${releaseTag} already exists; releases are write-once`);
 await expectTag('before draft');
 const draft=await call('POST',`${API}/repos/${repository}/releases`,{expect:[201],body:JSON.stringify({tag_name:releaseTag,target_commitish:sha,name:releaseTag,
  body:`Release ${releaseTag} of ${repository} at ${sha}.\n\nrelease.meta.json sha256: ${hex(manifestBytes)}`,draft:true,prerelease:false,generate_release_notes:false})});
 const id=draft.json?.id;
 if(!Number.isSafeInteger(id)||id<=0)throw Error('GitHub did not return a release id');
 try{
  for(const {name,data} of assets){
   const uploaded=await call('POST',`${UPLOADS}/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`,{expect:[201],body:data,contentType:contentTypeOf(name)});
   if(uploaded.json?.name!==name||uploaded.json?.size!==data.length)throw Error(`Uploaded asset ${name} was renamed or truncated`);
   if(uploaded.json.digest!==undefined&&uploaded.json.digest!==null&&uploaded.json.digest!==`sha256:${hex(data)}`)throw Error(`Uploaded asset ${name} digest mismatch`);
   log(`uploaded ${name} (${data.length} bytes)`);
  }
  await expectTag('before publish');
  const published=await call('PATCH',`${API}/repos/${repository}/releases/${id}`,{expect:[200],body:JSON.stringify({draft:false})});
  if(published.json?.draft!==false||published.json?.tag_name!==releaseTag)throw Error('Release did not publish as expected');
 }catch(error){throw Error(`${error.message} (draft release ${id} left for operator review)`);}
 const final=await tagCommit(call,repository,releaseTag);
 if(final!==sha)throw Error(`Published tag ${releaseTag} does not point at ${sha}; investigate release ${id} immediately`);
 return {id,url:`https://github.com/${repository}/releases/tag/${releaseTag}`};
}

export const modeOf=ref=>ref==='refs/heads/main'?'main':typeof ref==='string'&&ref.startsWith('refs/tags/')?'tag':null;
export async function main(argv,env){
 const args=parseArgs(argv,{'release-dir':{required:true},'release-tag':{required:true},'github-output':{}});
 const mode=modeOf(env.GITHUB_REF);
 if(!mode||(mode==='tag'&&env.GITHUB_REF!==`refs/tags/${args['release-tag']}`))throw Error('Publication runs only for main pushes or the matching tag push');
 const result=await publishGithubRelease({repository:env.GITHUB_REPOSITORY,releaseTag:args['release-tag'],sha:env.GITHUB_SHA,mode,releaseDir:args['release-dir'],token:env.GITHUB_TOKEN,log:line=>process.stdout.write(line+'\n')});
 writeGithubOutput(args['github-output'],{release_id:String(result.id),release_url:result.url});
 process.stdout.write(`published ${result.url}\n`);
}
if(isMain(import.meta.url))runCli(main);
