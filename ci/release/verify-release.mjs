// Independent re-verification of a release directory. Recomputes every digest from
// bytes, checks zip hygiene of release.zip and every bundle, and cross-checks
// release.meta.json <-> checksums.json <-> SHA256SUMS <-> authorization-policy.json
// <-> bundle contents. Nothing inside a bundle is executed. Exits non-zero on any mismatch.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {ADAPTERS,LIMITS,RELEASE_MARKER_BINDING,parseJson,isCanonicalBytes,signerIdentity,canonical,
 validateReleaseManifest,validateAuthorizationPolicy,validateWorkerArtifactV2,validateMigrationsLedger,validateReleaseMarker} from '../../src/shared/release-contract.mjs';
import {readZip} from './zip.mjs';
import {loadChecksums} from './assemble-release.mjs';
import {countStatements,parseMigrationHeader} from './bundle-migrations.mjs';
import {loadApplication} from './read-application.mjs';
import {parseArgs,isMain,runCli,writeGithubOutput,readRegularFile,walkFiles} from './io.mjs';

const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(condition,message)=>{if(!condition)throw Error(message);};
const equalBytes=(a,b)=>a.length===b.length&&Buffer.compare(Buffer.from(a.buffer,a.byteOffset,a.length),Buffer.from(b.buffer,b.byteOffset,b.length))===0;
const ZIP_RATIO=100;

export const BASE_FILES=['release.meta.json','release.zip','checksums.json','SHA256SUMS','authorization-policy.json'];
export const SIGNED_FILES=['release.zip.sigstore.json','release.meta.json.sigstore.json','release.zip.intoto.jsonl'];

function strictDocument(bytes,validate,label,maxBytes=LIMITS.jsonBytes){
 const value=validate(parseJson(bytes,{maxBytes,label}));
 check(isCanonicalBytes(bytes,value),`${label} is not canonical JSON`);
 return value;
}

export async function verifyWorkerBundle(bytes,manifest){
 const entries=readZip(bytes,{maxEntries:LIMITS.assetFiles+1,maxEntryBytes:Math.max(LIMITS.artifactJsonBytes,LIMITS.assetFileBytes),maxTotalBytes:LIMITS.bundleBytes,maxRatio:ZIP_RATIO});
 const byName=new Map(entries.map(e=>[e.name,e.data]));
 check(byName.has('artifact.json'),'worker bundle has no artifact.json');
 check(entries.every(e=>e.name==='artifact.json'||e.name.startsWith('assets/')),'worker bundle contains entries outside artifact.json and assets/');
 const artifactBytes=byName.get('artifact.json');
 const artifact=await validateWorkerArtifactV2(parseJson(artifactBytes,{maxBytes:LIMITS.artifactJsonBytes,label:'artifact.json'}));
 check(isCanonicalBytes(artifactBytes,artifact),'artifact.json is not canonical JSON');
 const listed=artifact.metadata.assets?.manifest??[];
 check(listed.length===entries.length-1,'worker bundle asset entries do not match the asset manifest');
 for(const asset of listed){
  const data=byName.get(`assets/${asset.path}`);
  check(data&&data.length===asset.sizeBytes&&hex(data)===asset.sha256,`asset digest mismatch: ${asset.path}`);
 }
 const binding=artifact.metadata.bindings.find(b=>b.name===RELEASE_MARKER_BINDING);
 check(binding,`worker artifact lacks the ${RELEASE_MARKER_BINDING} binding required by http-release-marker/v1`);
 const marker=validateReleaseMarker(parseJson(binding.text,{label:RELEASE_MARKER_BINDING}));
 check(marker.application===manifest.application&&marker.releaseTag===manifest.releaseTag&&marker.sourceCommit===manifest.sourceCommit,'release marker does not match the release manifest');
 return {assets:listed.length,moduleSha256:marker.artifactSha256};
}

export function verifyMigrationsBundle(bytes,appTarget){
 const entries=readZip(bytes,{maxEntries:LIMITS.migrationFiles+1,maxEntryBytes:LIMITS.migrationFileBytes,maxTotalBytes:LIMITS.bundleBytes,maxRatio:ZIP_RATIO});
 const byName=new Map(entries.map(e=>[e.name,e.data]));
 check(byName.has('ledger.json'),'migrations bundle has no ledger.json');
 const ledger=strictDocument(byName.get('ledger.json'),validateMigrationsLedger,'ledger.json');
 check(entries.length===ledger.migrations.length+1,'migrations bundle entries do not match the ledger');
 for(const m of ledger.migrations){
  const data=byName.get(m.file);
  check(data&&data.length===m.sizeBytes&&hex(data)===m.sha256,`migration digest mismatch: ${m.file}`);
  const sql=new TextDecoder('utf-8',{fatal:true}).decode(data),header=parseMigrationHeader(sql);
  check(countStatements(sql)===m.statements&&header.compatibility===m.compatibility&&(header.requires??undefined)===m.requires,`migration ledger entry disagrees with file: ${m.file}`);
 }
 if(appTarget)check(ledger.binding===appTarget.build.binding,'ledger binding does not match the application target');
 return {migrations:ledger.migrations.length};
}

// Structural check only; cryptographic verification is cosign's job (attest-release
// verifies immediately after signing; consumers verify with docs/release-pipeline.md).
const isBundle=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&(typeof v.mediaType==='string'?v.mediaType.startsWith('application/vnd.dev.sigstore.bundle'):typeof v.base64Signature==='string');
function documentsOf(text){
 try{return text.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));}
 catch{return [JSON.parse(text)];}
}
function verifySignatureFiles(releaseDir){
 for(const name of SIGNED_FILES){
  const data=readRegularFile(join(releaseDir,name),4*1024*1024,name);
  check(data.length>0,`${name} is empty`);
  let documents;
  try{documents=documentsOf(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw Error(`${name} is not JSON`);}
  check(documents.length>=1&&documents.every(isBundle),`${name} is not a Sigstore bundle`);
 }
}

function verifySbom(path,data){
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
 if(path==='sbom.cdx.json')check(value?.bomFormat==='CycloneDX','sbom.cdx.json is not a CycloneDX document');
 if(path==='sbom.spdx.json')check(typeof value?.spdxVersion==='string'&&value.spdxVersion.startsWith('SPDX-'),'sbom.spdx.json is not an SPDX document');
}

function verifyAgainstApplication(manifest,application){
 check(manifest.application===application.application&&manifest.repository===application.repository&&manifest.repositoryId===application.repositoryId,'release manifest identity does not match the application manifest');
 const shape=t=>canonical({id:t.id,adapter:t.adapter,dependsOn:t.dependsOn,extra:t.healthContract??t.recoveryPolicy});
 check(canonical(manifest.targets.map(shape))===canonical(application.targets.map(shape)),'release manifest targets do not match the application manifest');
}

// layout=build: the CI release directory (bundles also present as targets/*.zip).
// layout=published: the GitHub Release asset set, where bundles exist only inside release.zip.
export async function verifyRelease(releaseDir,{stage='unsigned',layout='build',application=null}={}){
 check(stage==='unsigned'||stage==='signed','stage must be unsigned or signed');
 check(layout==='build'||(layout==='published'&&stage==='signed'),'layout must be build, or published with stage signed');
 const present=walkFiles(releaseDir,{maxFiles:64,maxFileBytes:LIMITS.releaseBytes,maxTotalBytes:4*LIMITS.releaseBytes,label:'release directory'}).map(f=>f.path);
 const manifestBytes=readRegularFile(join(releaseDir,'release.meta.json'),LIMITS.jsonBytes,'release.meta.json');
 const manifest=strictDocument(manifestBytes,validateReleaseManifest,'release.meta.json');
 const {checksums,bytes:checksumBytes}=loadChecksums(releaseDir);
 const listed=Object.keys(checksums.files);
 const insideOnly=path=>layout==='published'&&path.startsWith('targets/');
 const expected=[...BASE_FILES,...listed.filter(p=>!insideOnly(p)),...(stage==='signed'?SIGNED_FILES:[])];
 const unexpected=present.filter(p=>!expected.includes(p)),missing=expected.filter(p=>!present.includes(p));
 check(!unexpected.length&&!missing.length,`release directory inventory mismatch (unexpected: ${unexpected.join(', ')||'none'}; missing: ${missing.join(', ')||'none'})`);

 const releaseBytes=readRegularFile(join(releaseDir,'release.zip'),LIMITS.releaseBytes,'release.zip');
 check(releaseBytes.length===manifest.artifact.sizeBytes&&hex(releaseBytes)===manifest.artifact.sha256,'release.zip digest does not match release.meta.json');
 const inner=readZip(releaseBytes,{maxEntries:64,maxEntryBytes:LIMITS.releaseBytes,maxTotalBytes:LIMITS.releaseBytes,maxRatio:ZIP_RATIO});
 const zipped=new Map(inner.map(e=>[e.name,e.data]));
 check(inner.length===listed.length+1&&zipped.has('checksums.json')&&listed.every(p=>zipped.has(p)),'release.zip entries do not match checksums.json');

 const loose=new Map();
 for(const path of listed){
  const data=insideOnly(path)?zipped.get(path):readRegularFile(join(releaseDir,path),LIMITS.releaseBytes,path);
  check(data.length===checksums.files[path].sizeBytes&&hex(data)===checksums.files[path].sha256,`checksum mismatch: ${path}`);
  loose.set(path,data);
 }
 for(const [name,data] of zipped){
  const reference=name==='checksums.json'?checksumBytes:loose.get(name);
  check(equalBytes(reference,data),`release.zip entry differs from the published file: ${name}`);
 }
 check(manifest.checksums.sha256===hex(checksumBytes),'release.meta.json checksums digest mismatch');
 const policyBytes=loose.get('authorization-policy.json');
 check(manifest.authorizationPolicy.sha256===hex(policyBytes),'release.meta.json authorization policy digest mismatch');
 const bundlePaths=listed.filter(p=>p.startsWith('targets/'));
 check(bundlePaths.length===manifest.targets.length&&manifest.targets.every(t=>bundlePaths.includes(t.artifactPath)),'checksums.json bundles do not match release.meta.json targets');
 for(const t of manifest.targets)check(t.sha256===checksums.files[t.artifactPath].sha256&&t.sizeBytes===checksums.files[t.artifactPath].sizeBytes,`release.meta.json digest mismatch for ${t.artifactPath}`);

 const policy=strictDocument(policyBytes,validateAuthorizationPolicy,'authorization-policy.json');
 for(const key of ['application','repository','repositoryId','sourceCommit','releaseTag'])check(policy[key]===manifest[key],`authorization policy ${key} does not match release.meta.json`);
 check(policy.signer.identity===signerIdentity(manifest.builder.workflow),'authorization policy signer does not match the release builder workflow');
 const contractOf=t=>canonical(t.adapter===ADAPTERS.worker?{adapter:t.adapter,healthContract:t.healthContract}:{adapter:t.adapter,recoveryPolicy:t.recoveryPolicy});
 check(Object.keys(policy.targets).length===manifest.targets.length&&manifest.targets.every(t=>Object.hasOwn(policy.targets,t.id)&&canonical(policy.targets[t.id])===contractOf(t)),'authorization policy targets do not match release.meta.json targets');

 const summary=[];
 for(const t of manifest.targets){
  const appTarget=application?.targets.find(a=>a.id===t.id);
  if(t.adapter===ADAPTERS.worker)summary.push({id:t.id,...await verifyWorkerBundle(loose.get(t.artifactPath),manifest)});
  else summary.push({id:t.id,...verifyMigrationsBundle(loose.get(t.artifactPath),appTarget)});
 }
 for(const path of listed.filter(p=>p.startsWith('sbom.')))verifySbom(path,loose.get(path));
 if(stage==='signed')verifySignatureFiles(releaseDir);
 if(application)verifyAgainstApplication(manifest,application);
 return {application:manifest.application,releaseTag:manifest.releaseTag,sourceCommit:manifest.sourceCommit,builderWorkflow:manifest.builder.workflow,manifestSha256:hex(manifestBytes),targets:summary};
}

export async function main(argv){
 const args=parseArgs(argv,{'release-dir':{required:true},stage:{default:'unsigned',pattern:/^(?:unsigned|signed)$/},layout:{default:'build',pattern:/^(?:build|published)$/},application:{},'github-output':{}});
 const result=await verifyRelease(args['release-dir'],{stage:args.stage,layout:args.layout,application:args.application?loadApplication(args.application):null});
 writeGithubOutput(args['github-output'],{application:result.application,release_tag:result.releaseTag,source_commit:result.sourceCommit,builder_workflow:result.builderWorkflow,manifest_sha256:result.manifestSha256});
 process.stdout.write(`verified ${result.application} ${result.releaseTag} (${args.stage}) manifest sha256=${result.manifestSha256}\n`);
}
if(isMain(import.meta.url))runCli(main);
