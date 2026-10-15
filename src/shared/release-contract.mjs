// Release-phase contracts (docs/contracts.md). Pure validators: no I/O, no clock.
// Canonical JSON and digests come from the worker-artifact/v1 module so both
// contract generations hash identically; the v1 validator is reused, not copied.
import {canonical,sha256,digest,inspectArtifact} from './contract.mjs';

export {canonical,sha256,digest};

export class ContractError extends Error {}
const deny=message=>{throw new ContractError(message);};
const req=(condition,message)=>{if(!condition)deny(message);};

const encoder=new TextEncoder();
export const MiB=1024*1024;
export const LIMITS=Object.freeze({
 moduleBytes:5*MiB,assetFiles:20000,assetFileBytes:25*MiB,assetTotalBytes:100*MiB,
 migrationFiles:1000,migrationFileBytes:5*MiB,bundleBytes:256*MiB,releaseBytes:1024*MiB,
 targets:32,environments:8,jsonBytes:MiB,artifactJsonBytes:16*MiB,
});
export const SCHEMAS=Object.freeze({
 workerV2:'workflow-depot-worker-artifact/v2',ledger:'migrations-ledger/v1',policy:'authorization-policy/v1',
 checksums:'release-checksums/v1',manifest:'release-manifest/v2',application:'application-deployment/v1',
 promotion:'promotion-request/v1',marker:'release-marker/v1',context:'release-context/v1',
});
export const ADAPTERS=Object.freeze({worker:'cloudflare-worker/v1',d1:'cloudflare-d1-migrate/v1'});
// One bundle per adapter keeps the contract's fixed bundle names (targets/worker.zip, targets/migrations.zip).
export const ARTIFACT_PATHS=Object.freeze({[ADAPTERS.worker]:'targets/worker.zip',[ADAPTERS.d1]:'targets/migrations.zip'});
export const GITHUB_ISSUER='https://token.actions.githubusercontent.com';

export const HEX64=/^[a-f0-9]{64}$/;
export const SHA40=/^[a-f0-9]{40}$/;
export const UUID_V7=/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const REPOSITORY=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const TARGET_ID=/^[a-z0-9-]{1,64}$/;
export const APPLICATION_ID=/^[a-z0-9-]{1,64}$/;
export const ENVIRONMENT=/^[a-z][a-z0-9-]{0,31}$/;
export const RELEASE_TAG=/^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export const IDENTIFIER=/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
export const NPM_SCRIPT=/^[a-z0-9][a-z0-9:._-]{0,63}$/;
export const WORKFLOW_REF=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml@[a-f0-9]{40}$/;
export const BUCKET=/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const RUN_NUMBER=/^[1-9]\d{0,19}$/;
const QUEUE_NAME=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MIGRATION_TAG=/^[A-Za-z0-9_.-]{1,64}$/;
const MIGRATION_FILE=/^(\d{4})(?:_[A-Za-z0-9_-]{1,64})?\.sql$/;
const CONTENT_TYPE=/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:; ?charset=[a-z0-9_-]{1,32})?$/;
const REF_PATTERN=/^refs\/(?:heads|tags)\/(?:[A-Za-z0-9._\/-]{1,200}\*?|\*)$/;

const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const safeInt=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const positive=v=>safeInt(v,1,Number.MAX_SAFE_INTEGER);
function keys(value,required,optional,label){
 req(object(value),`${label}: expected an object`);
 for(const key of required)req(Object.hasOwn(value,key),`${label}: missing key ${key}`);
 for(const key of Object.keys(value))req(required.includes(key)||optional.includes(key),`${label}: unknown key ${key}`);
}
function uniqueStrings(value,pattern,{min=0,max},label){
 req(Array.isArray(value)&&value.length>=min&&value.length<=max,`${label}: expected ${min}..${max} entries`);
 for(const item of value)req(matches(pattern,item),`${label}: invalid entry`);
 req(new Set(value).size===value.length,`${label}: duplicate entry`);
 return value;
}
export function isTimestamp(value){
 if(!matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,value))return false;
 const parsed=new Date(value);
 return Number.isFinite(parsed.valueOf())&&parsed.toISOString().replace('.000Z','Z')===value;
}
export function formatTimestamp(epochMillis){
 req(Number.isSafeInteger(epochMillis)&&epochMillis>=0,'Invalid timestamp');
 return new Date(Math.floor(epochMillis/1000)*1000).toISOString().replace('.000Z','Z');
}
// Normalized repository-relative path: no absolute, empty, '.' or '..' segments.
export function isRelativePath(value,{max=256}={}){
 return typeof value==='string'&&value.length<=max&&/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value)&&value.split('/').every(s=>s!=='.'&&s!=='..');
}
export function isAssetPath(value){
 return typeof value==='string'&&value.length<=1024&&/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(value)&&value.split('/').every(s=>s!=='.'&&s!=='..');
}
export function releaseWorkflowRef(depotRepository,depotSha){
 req(matches(REPOSITORY,depotRepository)&&matches(SHA40,depotSha),'Invalid depot identity');
 return `${depotRepository}/.github/workflows/release.yml@${depotSha}`;
}
export const signerIdentity=workflowRef=>`https://github.com/${workflowRef}`;

// JSON.parse silently keeps the last duplicate key; contracts require rejecting them.
export function parseJson(input,{maxBytes=LIMITS.jsonBytes,label='JSON'}={}){
 const bytes=typeof input==='string'?encoder.encode(input):input instanceof Uint8Array?input:deny(`${label}: expected bytes`);
 req(bytes.length>0&&bytes.length<=maxBytes,`${label}: size outside bounds`);
 req(!(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf),`${label}: byte order mark not allowed`);
 let text;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{deny(`${label}: invalid UTF-8`);}
 let i=0;
 const fail=()=>deny(`${label}: malformed JSON at offset ${i}`);
 const space=()=>{while(i<text.length&&(text[i]===' '||text[i]==='\t'||text[i]==='\n'||text[i]==='\r'))i++;};
 const plain=/[^"\\\u0000-\u001f]*/y,number=/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
 const escapes={'"':'"','\\':'\\','/':'/',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'};
 function string(){
  i++;let out='';
  for(;;){
   plain.lastIndex=i;const run=plain.exec(text);out+=run[0];i+=run[0].length;
   if(i>=text.length)fail();
   const c=text[i++];
   if(c==='"')return out;
   if(c!=='\\')fail();
   const e=text[i++];
   if(e==='u'){const h=text.slice(i,i+4);if(!/^[0-9a-fA-F]{4}$/.test(h))fail();out+=String.fromCharCode(parseInt(h,16));i+=4;}
   else if(Object.hasOwn(escapes,e))out+=escapes[e];else fail();
  }
 }
 function value(depth){
  if(depth>64)deny(`${label}: nesting too deep`);
  space();const c=text[i];
  if(c==='{'){
   i++;const out={};space();if(text[i]==='}'){i++;return out;}
   for(;;){
    space();if(text[i]!=='"')fail();
    const key=string();
    if(key==='__proto__')deny(`${label}: forbidden key`);
    if(Object.hasOwn(out,key))deny(`${label}: duplicate key ${JSON.stringify(key)}`);
    space();if(text[i++]!==':')fail();
    out[key]=value(depth+1);space();
    const d=text[i++];if(d==='}')return out;if(d!==',')fail();
   }
  }
  if(c==='['){
   i++;const out=[];space();if(text[i]===']'){i++;return out;}
   for(;;){out.push(value(depth+1));space();const d=text[i++];if(d===']')return out;if(d!==',')fail();}
  }
  if(c==='"')return string();
  for(const [word,result] of [['true',true],['false',false],['null',null]])if(text.startsWith(word,i)){i+=word.length;return result;}
  number.lastIndex=i;const n=number.exec(text);if(!n)fail();i+=n[0].length;return Number(n[0]);
 }
 const result=value(0);space();if(i!==text.length)fail();
 return result;
}
export const canonicalBytes=value=>encoder.encode(canonical(value));
export function isCanonicalBytes(bytes,value){
 const expected=canonicalBytes(value);
 return bytes.length===expected.length&&bytes.every((b,k)=>b===expected[k]);
}

// Kahn's algorithm; returns ids in a dependency-respecting order or rejects cycles.
export function topologicalOrder(targets){
 const pending=new Map(targets.map(t=>[t.id,new Set(t.dependsOn)])),order=[];
 while(pending.size){
  const ready=[...pending].filter(([,deps])=>[...deps].every(d=>!pending.has(d))).map(([id])=>id);
  req(ready.length>0,'dependsOn graph contains a cycle');
  for(const id of ready){pending.delete(id);order.push(id);}
 }
 return order;
}
function dependencies(targets,label){
 const ids=new Set();
 for(const t of targets){req(!ids.has(t.id),`${label}: duplicate target id`);ids.add(t.id);}
 for(const t of targets){
  uniqueStrings(t.dependsOn,TARGET_ID,{max:LIMITS.targets},`${label}: dependsOn`);
  for(const d of t.dependsOn)req(d!==t.id&&ids.has(d),`${label}: dependsOn references unknown or self target`);
 }
 topologicalOrder(targets);
}
function environmentSet(value,label,withTargets){
 req(object(value),`${label}: expected an object`);
 const names=Object.keys(value);
 req(names.length>=1&&names.length<=LIMITS.environments,`${label}: expected 1..${LIMITS.environments} environments`);
 for(const name of names){
  req(ENVIRONMENT.test(name),`${label}: invalid environment name`);
  const env=value[name];
  keys(env,withTargets?['allowedRefs','requiredApprovals','targets']:['allowedRefs','requiredApprovals'],[],`${label}.${name}`);
  uniqueStrings(env.allowedRefs,REF_PATTERN,{min:1,max:16},`${label}.${name}.allowedRefs`);
  req(env.allowedRefs.every(r=>!r.includes('..')&&!r.includes('//')),`${label}.${name}.allowedRefs: invalid ref`);
  req(safeInt(env.requiredApprovals,0,10),`${label}.${name}.requiredApprovals: expected 0..10`);
  if(withTargets)uniqueStrings(env.targets,TARGET_ID,{min:1,max:LIMITS.targets},`${label}.${name}.targets`);
 }
}

export function validateApplication(a){
 const label=SCHEMAS.application;
 keys(a,['schema','application','repository','repositoryId','targets','environments'],[],label);
 req(a.schema===SCHEMAS.application,`${label}: wrong schema`);
 req(matches(APPLICATION_ID,a.application)&&matches(REPOSITORY,a.repository)&&positive(a.repositoryId),`${label}: invalid identity`);
 req(Array.isArray(a.targets)&&a.targets.length>=1&&a.targets.length<=LIMITS.targets,`${label}: expected 1..${LIMITS.targets} targets`);
 const perAdapter=new Map();
 for(const t of a.targets){
  req(object(t)&&Object.values(ADAPTERS).includes(t.adapter),`${label}: unknown adapter`);
  req(matches(TARGET_ID,t.id),`${label}: invalid target id`);
  perAdapter.set(t.adapter,(perAdapter.get(t.adapter)||0)+1);
  if(t.adapter===ADAPTERS.worker){
   keys(t,['id','adapter','build','dependsOn','healthContract'],[],`${label}: target ${t.id}`);
   keys(t.build,['wranglerConfig','entry'],['assetsDir','buildCommand'],`${label}: target ${t.id} build`);
   req(['wranglerConfig','entry','assetsDir'].every(k=>!Object.hasOwn(t.build,k)||isRelativePath(t.build[k])),`${label}: target ${t.id} build path must be normalized and relative`);
   req(!Object.hasOwn(t.build,'buildCommand')||matches(NPM_SCRIPT,t.build.buildCommand),`${label}: buildCommand must name an npm script`);
   req(t.healthContract==='http-release-marker/v1',`${label}: unsupported healthContract`);
  }else{
   keys(t,['id','adapter','build','dependsOn','recoveryPolicy'],[],`${label}: target ${t.id}`);
   keys(t.build,['migrationsDir','binding'],[],`${label}: target ${t.id} build`);
   req(isRelativePath(t.build.migrationsDir),`${label}: target ${t.id} build path must be normalized and relative`);
   req(matches(IDENTIFIER,t.build.binding),`${label}: invalid binding name`);
   req(t.recoveryPolicy==='forward-only',`${label}: unsupported recoveryPolicy`);
  }
 }
 req([...perAdapter.values()].every(n=>n===1),`${label}: at most one target per adapter is supported`);
 dependencies(a.targets,label);
 environmentSet(a.environments,`${label}.environments`,false);
 return a;
}

const ASSET_CONFIG={not_found_handling:['none','404-page','single-page-application'],html_handling:['auto-trailing-slash','force-trailing-slash','drop-trailing-slash','none']};
function assetsMetadata(assets,label){
 keys(assets,['config','manifest'],[],label);
 keys(assets.config,[],['not_found_handling','html_handling','run_worker_first'],`${label}.config`);
 for(const [key,allowed] of Object.entries(ASSET_CONFIG))req(!Object.hasOwn(assets.config,key)||allowed.includes(assets.config[key]),`${label}.config: invalid ${key}`);
 const first=assets.config.run_worker_first;
 if(first!==undefined&&typeof first!=='boolean')uniqueStrings(first,/^!?\/[A-Za-z0-9._~\/*-]{0,255}$/,{min:1,max:100},`${label}.config.run_worker_first`);
 const manifest=assets.manifest;
 req(Array.isArray(manifest)&&manifest.length<=LIMITS.assetFiles,`${label}: too many assets`);
 let total=0,previous=null;const folded=new Set();
 for(const entry of manifest){
  keys(entry,['path','sha256','sizeBytes','contentType'],[],`${label}.manifest entry`);
  req(isAssetPath(entry.path),`${label}: invalid asset path`);
  req(previous===null||previous<entry.path,`${label}: manifest must be sorted and unique`);
  req(!folded.has(entry.path.toLowerCase()),`${label}: case-insensitive duplicate asset path`);
  previous=entry.path;folded.add(entry.path.toLowerCase());
  req(matches(HEX64,entry.sha256)&&safeInt(entry.sizeBytes,0,LIMITS.assetFileBytes)&&matches(CONTENT_TYPE,entry.contentType),`${label}: invalid asset entry`);
  total+=entry.sizeBytes;
 }
 req(total<=LIMITS.assetTotalBytes,`${label}: assets exceed total size limit`);
}
function doMigrations(m,label){
 keys(m,['new_tag'],['new_classes','new_sqlite_classes','deleted_classes','renamed_classes'],label);
 req(matches(MIGRATION_TAG,m.new_tag),`${label}: invalid new_tag`);
 let steps=0;
 for(const key of ['new_classes','new_sqlite_classes','deleted_classes'])if(Object.hasOwn(m,key)){uniqueStrings(m[key],IDENTIFIER,{min:1,max:100},`${label}.${key}`);steps++;}
 if(Object.hasOwn(m,'renamed_classes')){
  req(Array.isArray(m.renamed_classes)&&m.renamed_classes.length>=1&&m.renamed_classes.length<=100,`${label}.renamed_classes: invalid`);
  for(const r of m.renamed_classes){keys(r,['from','to'],[],`${label}.renamed_classes`);req(matches(IDENTIFIER,r.from)&&matches(IDENTIFIER,r.to),`${label}.renamed_classes: invalid class`);}
  steps++;
 }
 req(steps>0,`${label}: empty migration`);
}

export const RELEASE_MARKER_BINDING='RELEASE_MARKER';
export function validateReleaseMarker(m,{runtime=false}={}){
 const label=SCHEMAS.marker;
 keys(m,['schema','application','releaseTag','sourceCommit','artifactSha256',...(runtime?['startedAt']:[])],[],label);
 req(m.schema===SCHEMAS.marker&&matches(APPLICATION_ID,m.application)&&matches(RELEASE_TAG,m.releaseTag)&&matches(SHA40,m.sourceCommit)&&matches(HEX64,m.artifactSha256),`${label}: invalid field`);
 if(runtime)req(isTimestamp(m.startedAt),`${label}: invalid startedAt`);
 return m;
}

// Async only because the v1 validator (reused for v1 binding types) hashes.
export async function validateWorkerArtifactV2(a){
 const label=SCHEMAS.workerV2;
 keys(a,['schema','metadata','modules'],[],label);
 req(a.schema===SCHEMAS.workerV2,`${label}: wrong schema`);
 const m=a.metadata;
 keys(m,['main_module','compatibility_date','compatibility_flags','bindings'],['migrations','assets'],`${label}.metadata`);
 req(m.main_module==='worker.mjs',`${label}: main_module must be worker.mjs`);
 req(Array.isArray(m.bindings)&&m.bindings.length<=100,`${label}: too many bindings`);
 const names=new Set(),v1=[];let assetBindings=0;
 for(const b of m.bindings){
  req(object(b)&&matches(IDENTIFIER,b.name),`${label}: invalid binding name`);
  req(!names.has(b.name),`${label}: duplicate binding name`);names.add(b.name);
  if(b.type==='assets'){keys(b,['name','type'],[],`${label}: assets binding`);assetBindings++;}
  else if(b.type==='queue'){keys(b,['name','type','queue_name'],[],`${label}: queue binding`);req(matches(QUEUE_NAME,b.queue_name),`${label}: invalid queue_name`);}
  else if(b.type==='durable_object_namespace'&&Object.hasOwn(b,'class_name')){keys(b,['name','type','class_name'],[],`${label}: durable object binding`);req(matches(IDENTIFIER,b.class_name),`${label}: invalid class_name`);}
  else v1.push(b);
 }
 req(assetBindings<=1,`${label}: at most one assets binding`);
 req(!assetBindings||Object.hasOwn(m,'assets'),`${label}: assets binding requires assets metadata`);
 const probe={schema:'workflow-depot-worker-artifact/v1',metadata:{main_module:'worker.mjs',compatibility_date:m.compatibility_date,compatibility_flags:m.compatibility_flags,bindings:v1},modules:[{name:'worker.mjs',type:'esm',content:'export default {};'}]};
 try{await inspectArtifact(encoder.encode(canonical(probe)),LIMITS.moduleBytes);}
 catch{deny(`${label}: compatibility fields or v1 binding rejected by worker-artifact/v1 rules`);}
 if(Object.hasOwn(m,'migrations'))doMigrations(m.migrations,`${label}.metadata.migrations`);
 if(Object.hasOwn(m,'assets'))assetsMetadata(m.assets,`${label}.metadata.assets`);
 req(Array.isArray(a.modules)&&a.modules.length===1,`${label}: exactly one module`);
 const mod=a.modules[0];
 keys(mod,['name','type','content'],[],`${label}: module`);
 req(mod.name==='worker.mjs'&&mod.type==='esm'&&typeof mod.content==='string'&&mod.content.length>0,`${label}: invalid module`);
 const moduleBytes=encoder.encode(mod.content);
 req(moduleBytes.length<=LIMITS.moduleBytes,`${label}: module exceeds ${LIMITS.moduleBytes} bytes`);
 const marker=m.bindings.find(b=>b.name===RELEASE_MARKER_BINDING);
 if(marker){
  req(marker.type==='plain_text',`${label}: ${RELEASE_MARKER_BINDING} must be plain_text`);
  const value=validateReleaseMarker(parseJson(marker.text,{label:RELEASE_MARKER_BINDING}));
  req(marker.text===canonical(value),`${label}: ${RELEASE_MARKER_BINDING} must be canonical JSON`);
  req(value.artifactSha256===await sha256(moduleBytes),`${label}: ${RELEASE_MARKER_BINDING} artifactSha256 does not match module`);
 }
 return a;
}

export function validateMigrationsLedger(l){
 const label=SCHEMAS.ledger;
 keys(l,['schema','binding','migrations'],[],label);
 req(l.schema===SCHEMAS.ledger&&matches(IDENTIFIER,l.binding),`${label}: invalid header`);
 req(Array.isArray(l.migrations)&&l.migrations.length>=1&&l.migrations.length<=LIMITS.migrationFiles,`${label}: expected 1..${LIMITS.migrationFiles} migrations`);
 const seen=new Map();let previous='';
 for(const m of l.migrations){
  const contract=m?.compatibility==='contract';
  keys(m,['version','file','sha256','sizeBytes','statements','compatibility','recoveryPolicy',...(contract?['requires']:[])],[],`${label}: migration`);
  const file=matches(MIGRATION_FILE,m.file)&&MIGRATION_FILE.exec(m.file);
  req(matches(/^\d{4}$/,m.version)&&file&&file[1]===m.version,`${label}: invalid version or file`);
  req(m.version>previous,`${label}: versions must be strictly increasing`);previous=m.version;
  req(matches(HEX64,m.sha256)&&safeInt(m.sizeBytes,1,LIMITS.migrationFileBytes)&&safeInt(m.statements,1,100000),`${label}: invalid digest, size or statements`);
  req(['additive','expand','contract'].includes(m.compatibility)&&m.recoveryPolicy==='forward-only',`${label}: invalid compatibility or recoveryPolicy`);
  if(contract)req(seen.get(m.requires)==='expand',`${label}: contract migration must require an earlier expand migration`);
  seen.set(m.version,m.compatibility);
 }
 return l;
}

export function validateAuthorizationPolicy(p){
 const label=SCHEMAS.policy;
 keys(p,['schema','policyVersion','application','repository','repositoryId','releasePrefix','sourceCommit','releaseTag','signer','environments','expiresAt'],[],label);
 req(p.schema===SCHEMAS.policy&&p.policyVersion===1,`${label}: wrong schema or policyVersion`);
 req(matches(APPLICATION_ID,p.application)&&matches(REPOSITORY,p.repository)&&positive(p.repositoryId),`${label}: invalid identity`);
 req(p.releasePrefix===`${p.application}/`,`${label}: releasePrefix must be <application>/`);
 req(matches(SHA40,p.sourceCommit)&&matches(RELEASE_TAG,p.releaseTag)&&isTimestamp(p.expiresAt),`${label}: invalid release binding`);
 keys(p.signer,['issuer','identity'],[],`${label}.signer`);
 req(p.signer.issuer===GITHUB_ISSUER,`${label}: signer issuer must be GitHub Actions OIDC`);
 req(typeof p.signer.identity==='string'&&p.signer.identity.startsWith('https://github.com/')&&WORKFLOW_REF.test(p.signer.identity.slice(19)),`${label}: signer identity must be a SHA-pinned workflow`);
 environmentSet(p.environments,`${label}.environments`,true);
 return p;
}

export const CHECKSUM_PATH=/^(?:targets\/[a-z0-9-]{1,64}\.zip|authorization-policy\.json|sbom\.cdx\.json|sbom\.spdx\.json)$/;
export function validateChecksums(c){
 const label=SCHEMAS.checksums;
 keys(c,['schema','algorithm','files'],[],label);
 req(c.schema===SCHEMAS.checksums&&c.algorithm==='sha256',`${label}: wrong schema or algorithm`);
 req(object(c.files),`${label}: files must be an object`);
 const paths=Object.keys(c.files);
 req(paths.length>=2&&paths.length<=LIMITS.targets+3,`${label}: unexpected file count`);
 for(const path of paths){
  req(CHECKSUM_PATH.test(path),`${label}: unexpected path ${path}`);
  keys(c.files[path],['sha256','sizeBytes'],[],`${label}: ${path}`);
  req(matches(HEX64,c.files[path].sha256)&&safeInt(c.files[path].sizeBytes,1,LIMITS.releaseBytes),`${label}: invalid entry for ${path}`);
 }
 req(paths.includes('authorization-policy.json')&&paths.some(p=>p.startsWith('targets/')),`${label}: policy and at least one target are required`);
 return c;
}
export function renderSha256Sums(c){
 return Object.keys(c.files).sort().map(path=>`${c.files[path].sha256}  ${path}\n`).join('');
}

export function validateReleaseManifest(m){
 const label=SCHEMAS.manifest;
 keys(m,['schema','application','repository','repositoryId','releaseTag','sourceCommit','createdAt','builder','artifact','targets','authorizationPolicy','checksums'],[],label);
 req(m.schema===SCHEMAS.manifest,`${label}: wrong schema`);
 req(matches(APPLICATION_ID,m.application)&&matches(REPOSITORY,m.repository)&&positive(m.repositoryId),`${label}: invalid identity`);
 req(matches(RELEASE_TAG,m.releaseTag),`${label}: releaseTag must be vMAJOR.MINOR.PATCH`);
 req(matches(SHA40,m.sourceCommit)&&isTimestamp(m.createdAt),`${label}: invalid sourceCommit or createdAt`);
 keys(m.builder,['workflow','runId','runAttempt'],[],`${label}.builder`);
 req(matches(WORKFLOW_REF,m.builder.workflow)&&matches(RUN_NUMBER,m.builder.runId)&&matches(RUN_NUMBER,m.builder.runAttempt),`${label}: invalid builder`);
 keys(m.artifact,['path','sha256','sizeBytes','mediaType'],[],`${label}.artifact`);
 req(m.artifact.path==='release.zip'&&m.artifact.mediaType==='application/zip'&&matches(HEX64,m.artifact.sha256)&&safeInt(m.artifact.sizeBytes,1,LIMITS.releaseBytes),`${label}: invalid artifact`);
 req(Array.isArray(m.targets)&&m.targets.length>=1&&m.targets.length<=LIMITS.targets,`${label}: invalid targets`);
 for(const t of m.targets){
  req(object(t)&&Object.values(ADAPTERS).includes(t.adapter),`${label}: unknown adapter`);
  const extra=t.adapter===ADAPTERS.worker?'healthContract':'recoveryPolicy';
  keys(t,['id','adapter','artifactPath','sha256','sizeBytes','dependsOn',extra],[],`${label}: target`);
  req(matches(TARGET_ID,t.id)&&t.artifactPath===ARTIFACT_PATHS[t.adapter]&&matches(HEX64,t.sha256)&&safeInt(t.sizeBytes,1,LIMITS.bundleBytes),`${label}: invalid target ${t.id}`);
  req(t.adapter===ADAPTERS.worker?t.healthContract==='http-release-marker/v1':t.recoveryPolicy==='forward-only',`${label}: invalid ${extra}`);
 }
 req(new Set(m.targets.map(t=>t.artifactPath)).size===m.targets.length,`${label}: duplicate artifactPath`);
 dependencies(m.targets,label);
 keys(m.authorizationPolicy,['path','sha256'],[],`${label}.authorizationPolicy`);
 req(m.authorizationPolicy.path==='authorization-policy.json'&&matches(HEX64,m.authorizationPolicy.sha256),`${label}: invalid authorizationPolicy`);
 keys(m.checksums,['path','sha256'],[],`${label}.checksums`);
 req(m.checksums.path==='checksums.json'&&matches(HEX64,m.checksums.sha256),`${label}: invalid checksums`);
 return m;
}

export function releaseManifestUri(bucket,application,releaseTag){
 req(matches(BUCKET,bucket)&&matches(APPLICATION_ID,application)&&matches(RELEASE_TAG,releaseTag),'Invalid release object location');
 return `r2://${bucket}/${application}/${releaseTag}/release.meta.json`;
}
export function validatePromotionRequest(r){
 const label=SCHEMAS.promotion;
 keys(r,['schema','requestId','application','environment','repository','releaseTag','releaseManifestUri','releaseManifestSha256','expectedCurrentGeneration','githubDeploymentId','requestedAt'],[],label);
 req(r.schema===SCHEMAS.promotion&&matches(UUID_V7,r.requestId),`${label}: invalid schema or requestId`);
 req(matches(APPLICATION_ID,r.application)&&matches(ENVIRONMENT,r.environment)&&matches(REPOSITORY,r.repository)&&matches(RELEASE_TAG,r.releaseTag),`${label}: invalid identity`);
 const uri=typeof r.releaseManifestUri==='string'&&/^r2:\/\/([a-z0-9-]{3,63})\/([a-z0-9-]{1,64})\/([^/]+)\/release\.meta\.json$/.exec(r.releaseManifestUri);
 req(uri&&matches(BUCKET,uri[1])&&uri[2]===r.application&&uri[3]===r.releaseTag,`${label}: releaseManifestUri must address <bucket>/<application>/<releaseTag>/release.meta.json`);
 req(matches(HEX64,r.releaseManifestSha256),`${label}: invalid releaseManifestSha256`);
 req(safeInt(r.expectedCurrentGeneration,0,Number.MAX_SAFE_INTEGER)&&positive(r.githubDeploymentId)&&isTimestamp(r.requestedAt),`${label}: invalid generation, deployment or timestamp`);
 return r;
}

// Internal hand-off between release steps; not a published contract.
export function validateReleaseContext(c){
 const label=SCHEMAS.context;
 keys(c,['schema','repository','repositoryId','sourceCommit','ref','releaseTag','runId','runAttempt'],[],label);
 req(c.schema===SCHEMAS.context&&matches(REPOSITORY,c.repository)&&positive(c.repositoryId)&&matches(SHA40,c.sourceCommit),`${label}: invalid identity`);
 req(matches(RELEASE_TAG,c.releaseTag)&&(c.ref==='refs/heads/main'||c.ref===`refs/tags/${c.releaseTag}`),`${label}: invalid ref or releaseTag`);
 req(matches(RUN_NUMBER,c.runId)&&matches(RUN_NUMBER,c.runAttempt),`${label}: invalid run identity`);
 return c;
}
