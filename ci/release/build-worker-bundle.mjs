// Packages one cloudflare-worker/v1 target as targets/worker.zip:
//   artifact.json   workflow-depot-worker-artifact/v2 (module inline, asset digests only)
//   assets/<path>   static asset bytes
// The module comes from `wrangler deploy --dry-run --outdir`, which the composite
// action runs; bindings come from the wrangler config and are claims the deployer
// re-resolves against the Terraform registry. Nothing here executes app code.
import {createHash} from 'node:crypto';
import {readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {ADAPTERS,ARTIFACT_PATHS,LIMITS,SCHEMAS,RELEASE_TAG,SHA40,RELEASE_MARKER_BINDING,canonical,canonicalBytes,isRelativePath,isAssetPath,validateWorkerArtifactV2} from '../../src/shared/release-contract.mjs';
import {createZip} from './zip.mjs';
import {parseJsonc} from './jsonc.mjs';
import {loadApplication,targetOf} from './read-application.mjs';
import {parseArgs,isMain,runCli,writeOnce,writeGithubOutput,resolveInside,readRegularFile,walkFiles,realDirectory} from './io.mjs';

const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function only(value,required,optional,label){
 if(!object(value))throw Error(`${label}: expected an object`);
 for(const key of required)if(!Object.hasOwn(value,key))throw Error(`${label}: missing ${key}`);
 for(const key of Object.keys(value))if(!required.includes(key)&&!optional.includes(key))throw Error(`${label}: unsupported key ${key}`);
 return value;
}
const list=(value,label)=>{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100)throw Error(`${label}: expected a list`);
 return value;
};
const string=(value,label)=>{if(typeof value!=='string')throw Error(`${label}: expected a string`);return value;};
export function normalizeConfigPath(value,label){
 const path=string(value,label).replace(/^\.\//,'').replace(/\/+$/,'');
 if(!isRelativePath(path))throw Error(`${label}: must be a normalized path inside the application`);
 return path;
}

// Keys consumed by wrangler at bundle time, or owned by Terraform/the deployer
// (ingress, observability, schedules); they never reach the artifact.
const CONVERTED=['name','main','compatibility_date','compatibility_flags','vars','kv_namespaces','d1_databases','r2_buckets','durable_objects','services','queues','assets','migrations'];
const IGNORED=['$schema','observability','workers_dev','preview_urls','triggers','minify','keep_names','upload_source_maps','tsconfig','define','alias'];

export function wranglerToMetadata(config,{entry,assetsDir}){
 only(config,['main','compatibility_date'],[...CONVERTED,...IGNORED],'wrangler config');
 if(Object.hasOwn(config,'name'))string(config.name,'wrangler name');
 if(normalizeConfigPath(config.main,'wrangler main')!==entry)throw Error('wrangler main does not match the application target entry');
 if(Object.hasOwn(config,'triggers')){
  only(config.triggers,[],['crons'],'wrangler triggers');
  if(list(config.triggers.crons,'wrangler triggers.crons').length)throw Error('Cron triggers are registry-owned and not part of the artifact');
 }
 const bindings=[];
 if(Object.hasOwn(config,'vars')){
  if(!object(config.vars))throw Error('wrangler vars: expected an object');
  for(const [name,text] of Object.entries(config.vars))bindings.push({name,type:'plain_text',text:string(text,`wrangler vars.${name} (JSON vars are unsupported)`)});
 }
 for(const kv of list(config.kv_namespaces,'kv_namespaces')){only(kv,['binding','id'],['preview_id','remote'],'kv_namespaces entry');bindings.push({name:kv.binding,type:'kv_namespace',namespace_id:kv.id});}
 for(const db of list(config.d1_databases,'d1_databases')){only(db,['binding','database_id'],['database_name','migrations_dir','migrations_table','preview_database_id','remote'],'d1_databases entry');bindings.push({name:db.binding,type:'d1',database_id:db.database_id});}
 for(const r2 of list(config.r2_buckets,'r2_buckets')){only(r2,['binding','bucket_name'],['preview_bucket_name','remote'],'r2_buckets entry');bindings.push({name:r2.binding,type:'r2_bucket',bucket_name:r2.bucket_name});}
 if(Object.hasOwn(config,'durable_objects')){
  only(config.durable_objects,[],['bindings'],'durable_objects');
  for(const d of list(config.durable_objects.bindings,'durable_objects.bindings')){only(d,['name','class_name'],[],'durable object binding (cross-script bindings are unsupported)');bindings.push({name:d.name,type:'durable_object_namespace',class_name:d.class_name});}
 }
 for(const s of list(config.services,'services')){only(s,['binding','service'],['entrypoint','remote'],'services entry');bindings.push({name:s.binding,type:'service',service:s.service,...(Object.hasOwn(s,'entrypoint')?{entrypoint:s.entrypoint}:{})});}
 if(Object.hasOwn(config,'queues')){
  only(config.queues,[],['producers','consumers'],'queues');
  if(list(config.queues.consumers,'queues.consumers').length)throw Error('Queue consumers are registry-owned and not part of the artifact');
  for(const q of list(config.queues.producers,'queues.producers')){only(q,['binding','queue'],['remote'],'queue producer');bindings.push({name:q.binding,type:'queue',queue_name:q.queue});}
 }
 const metadata={main_module:'worker.mjs',compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags??[]};
 if(Object.hasOwn(config,'migrations')){
  const steps=list(config.migrations,'migrations');
  if(steps.length!==1)throw Error('Exactly one Durable Object migration step is supported by worker-artifact/v2');
  const {tag,...classes}=only(steps[0],['tag'],['new_classes','new_sqlite_classes','deleted_classes','renamed_classes'],'migrations entry');
  metadata.migrations={new_tag:tag,...classes};
 }
 let assetConfig=null;
 if(Object.hasOwn(config,'assets')){
  const a=only(config.assets,['directory'],['binding','not_found_handling','html_handling','run_worker_first'],'wrangler assets');
  if(normalizeConfigPath(a.directory,'wrangler assets.directory')!==assetsDir)throw Error('wrangler assets.directory does not match the application target assetsDir');
  if(Object.hasOwn(a,'binding'))bindings.push({name:a.binding,type:'assets'});
  assetConfig=Object.fromEntries(['not_found_handling','html_handling','run_worker_first'].filter(k=>Object.hasOwn(a,k)).map(k=>[k,a[k]]));
 }else if(assetsDir!==undefined)throw Error('Application target declares assetsDir but the wrangler config has no assets');
 return {metadata,bindings,assetConfig};
}

const TYPES={html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',map:'application/json',
 webmanifest:'application/manifest+json',txt:'text/plain',xml:'application/xml',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',
 gif:'image/gif',webp:'image/webp',avif:'image/avif',ico:'image/x-icon',wasm:'application/wasm',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',
 otf:'font/otf',pdf:'application/pdf',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav'};
export const contentType=path=>TYPES[(/\.([a-z0-9]+)$/i.exec(path)?.[1]||'').toLowerCase()]||'application/octet-stream';
// Files Cloudflare/wrangler interpret as configuration rather than serve.
const SPECIAL_ASSETS=new Set(['.assetsignore','_headers','_redirects','_worker.js','_routes.json']);

export function collectAssets(dir){
 const files=walkFiles(dir,{maxFiles:LIMITS.assetFiles,maxFileBytes:LIMITS.assetFileBytes,maxTotalBytes:LIMITS.assetTotalBytes,label:'assets directory'});
 return files.map(file=>{
  if(SPECIAL_ASSETS.has(file.path.split('/')[0]))throw Error(`Unsupported asset configuration file: ${file.path}`);
  if(!isAssetPath(file.path))throw Error(`Asset path not allowed: ${JSON.stringify(file.path)}`);
  const data=readRegularFile(file.abs,LIMITS.assetFileBytes,'asset');
  return {path:file.path,data,entry:{path:file.path,sha256:hex(data),sizeBytes:data.length,contentType:contentType(file.path)}};
 });
}

// wrangler writes the bundled entry plus optional source maps and a README.md.
export function readBundledModule(outdir,mainModule){
 realDirectory(outdir,'wrangler output');
 const candidates=[];
 for(const name of readdirSync(outdir).sort()){
  const stat=lstatSync(join(outdir,name));
  if(stat.isSymbolicLink()||!stat.isFile())throw Error(`wrangler output contains a non-regular entry: ${name}`);
  if(name.endsWith('.map')||name==='README.md')continue;
  if(!/^[A-Za-z0-9._-]+\.m?js$/.test(name))throw Error(`wrangler output contains an unsupported additional module: ${name}`);
  candidates.push(name);
 }
 const chosen=mainModule??(candidates.length===1?candidates[0]:null);
 if(!chosen||!candidates.includes(chosen)||candidates.length!==1)throw Error('wrangler output must contain exactly one JavaScript module');
 const bytes=readRegularFile(join(outdir,chosen),LIMITS.moduleBytes,'bundled module');
 try{return {bytes,content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};}
 catch{throw Error('bundled module is not valid UTF-8');}
}

export function planTarget({appRoot,application,targetId}){
 const target=targetOf(application,targetId,ADAPTERS.worker);
 const configPath=target.build.wranglerConfig;
 if(!/\.jsonc?$/.test(configPath))throw Error('Only wrangler.json/wrangler.jsonc configs are supported');
 const config=parseJsonc(readRegularFile(resolveInside(appRoot,configPath,'wrangler config'),LIMITS.jsonBytes,'wrangler config'),{maxBytes:LIMITS.jsonBytes,label:'wrangler config'});
 const converted=wranglerToMetadata(config,{entry:target.build.entry,assetsDir:target.build.assetsDir});
 return {target,config,converted};
}

export async function buildWorkerBundle({appRoot,application,targetId,wranglerOutdir,outDir,releaseTag,sourceCommit,mainModule}){
 if(!RELEASE_TAG.test(releaseTag||'')||!SHA40.test(sourceCommit||''))throw Error('Release marker requires a vMAJOR.MINOR.PATCH tag and a 40-hex commit');
 const {target,converted}=planTarget({appRoot,application,targetId});
 const module=readBundledModule(wranglerOutdir,mainModule);
 const assets=target.build.assetsDir?collectAssets(resolveInside(appRoot,target.build.assetsDir,'assets directory')):[];
 const bindings=[...converted.bindings];
 if(bindings.some(b=>b.name===RELEASE_MARKER_BINDING))throw Error(`${RELEASE_MARKER_BINDING} is reserved for the release marker`);
 const marker={schema:SCHEMAS.marker,application:application.application,releaseTag,sourceCommit,artifactSha256:hex(module.bytes)};
 bindings.push({name:RELEASE_MARKER_BINDING,type:'plain_text',text:canonical(marker)});
 bindings.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 const metadata={...converted.metadata,bindings};
 if(converted.assetConfig)metadata.assets={config:converted.assetConfig,manifest:assets.map(a=>a.entry)};
 const artifact=await validateWorkerArtifactV2({schema:SCHEMAS.workerV2,metadata,modules:[{name:'worker.mjs',type:'esm',content:module.content}]});
 const zip=createZip([{name:'artifact.json',data:canonicalBytes(artifact)},...assets.map(a=>({name:`assets/${a.path}`,data:a.data}))]);
 if(zip.length>LIMITS.bundleBytes)throw Error('Worker bundle exceeds size limit');
 const artifactPath=ARTIFACT_PATHS[ADAPTERS.worker];
 writeOnce(join(outDir,artifactPath),zip);
 return {target:target.id,artifactPath,sha256:hex(zip),sizeBytes:zip.length,moduleSha256:marker.artifactSha256};
}

const COMMON={'app-root':{required:true},application:{required:true},target:{required:true,pattern:/^[a-z0-9-]{1,64}$/},'github-output':{}};
export async function main(argv){
 const [command,...rest]=argv;
 if(command==='plan'){
  const args=parseArgs(rest,COMMON);
  const {target}=planTarget({appRoot:args['app-root'],application:loadApplication(args.application),targetId:args.target});
  writeGithubOutput(args['github-output'],{wrangler_config:target.build.wranglerConfig,build_command:target.build.buildCommand||''});
  process.stdout.write(`worker target ${target.id}: config ${target.build.wranglerConfig}\n`);
  return;
 }
 if(command!=='bundle')throw Error('Usage: build-worker-bundle.mjs plan|bundle --flag value ...');
 const args=parseArgs(rest,{...COMMON,'wrangler-outdir':{required:true},'out-dir':{required:true},'release-tag':{required:true},'source-commit':{required:true},'main-module':{}});
 const result=await buildWorkerBundle({appRoot:args['app-root'],application:loadApplication(args.application),targetId:args.target,wranglerOutdir:args['wrangler-outdir'],outDir:args['out-dir'],releaseTag:args['release-tag'],sourceCommit:args['source-commit'],mainModule:args['main-module']});
 writeGithubOutput(args['github-output'],{artifact_path:result.artifactPath,sha256:result.sha256});
 process.stdout.write(`${result.artifactPath} sha256=${result.sha256} size=${result.sizeBytes}\n`);
}
if(isMain(import.meta.url))runCli(main);
