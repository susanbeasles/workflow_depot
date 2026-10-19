// OFF-REPO PROPOSAL: pure conversion before release attestation, never deployment authority.
// Private Worker subset only. Infrastructure remains registry-owned; no asset/migration support.
import {createHash} from 'node:crypto';
import {canonicalBytes,parseJson,validateReleaseManifest,validateWorkerArtifactV2,validateChecksums,validateAuthorizationPolicy,RELEASE_MARKER_BINDING} from '../../src/shared/release-contract.mjs';
import {createZip,readZip} from './zip.mjs';
const hex=b=>createHash('sha256').update(b).digest('hex');
const need=(ok,message)=>{if(!ok)throw Error(message);};
const MAX=256*1024*1024;
export async function exportPrivateRelease({manifest,archive}){
 manifest=validateReleaseManifest(structuredClone(manifest));
 // Reviewed deployer v1 subset is narrower than depot v2; reject before producing bytes.
 need(/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(manifest.application)&&manifest.targets.every(t=>/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(t.id)),'identity outside deployer subset');
 need(archive instanceof Uint8Array&&archive.length<=MAX&&archive.length===manifest.artifact.sizeBytes&&hex(archive)===manifest.artifact.sha256,'source archive mismatch or too large');
 need(manifest.targets.every(t=>t.adapter==='cloudflare-worker/v1'&&t.healthContract==='worker-version/v1'),'only private Worker targets supported');
 const source=readZip(archive,{maxTotalBytes:MAX,maxEntryBytes:MAX}),byName=new Map(source.map(e=>[e.name,e.data]));
 for(const ref of [manifest.authorizationPolicy,manifest.checksums])need(byName.has(ref.path)&&hex(byName.get(ref.path))===ref.sha256,'source evidence mismatch');
 const policy=validateAuthorizationPolicy(parseJson(byName.get('authorization-policy.json')),{createdAt:manifest.createdAt});
 for(const field of ['application','repository','repositoryId','sourceCommit','releaseTag'])need(policy[field]===manifest[field],'policy identity mismatch');
 need(policy.signer.identity==='https://github.com/'+manifest.builder.workflow,'policy builder mismatch');
 need(Object.keys(policy.targets).length===manifest.targets.length&&manifest.targets.every(t=>policy.targets[t.id]?.adapter===t.adapter&&policy.targets[t.id].healthContract===t.healthContract),'policy target mismatch');
 const checksums=validateChecksums(parseJson(byName.get('checksums.json')));
 need(byName.size===Object.keys(checksums.files).length+1,'unlisted source archive entry');
 for(const [path,ref] of Object.entries(checksums.files))need(byName.has(path)&&byName.get(path).length===ref.sizeBytes&&hex(byName.get(path))===ref.sha256,'source checksum mismatch');
 const entries=source.map(e=>({name:'provenance/'+e.name,data:e.data}));
 entries.push({name:'provenance/depot-release.meta.json',data:canonicalBytes(manifest)});
 const targets=[];
 for(const target of manifest.targets){
  const packed=byName.get(target.artifactPath);
  need(packed?.length===target.sizeBytes&&hex(packed)===target.sha256,'target digest mismatch');
  const nested=readZip(packed,{maxEntries:1,maxEntryBytes:16*1024*1024,maxTotalBytes:16*1024*1024});
  need(nested.length===1&&nested[0].name==='artifact.json','private target must contain artifact.json only');
  const artifact=await validateWorkerArtifactV2(parseJson(nested[0].data,{maxBytes:16*1024*1024})),metadata=artifact.metadata;
  need(!Object.hasOwn(metadata,'migrations')&&!Object.hasOwn(metadata,'assets')&&!Object.hasOwn(metadata,'declared'),'infrastructure claims require separate reviewed provisioning');
  need(metadata.compatibility_flags.length<=32&&new Set(metadata.compatibility_flags).size===metadata.compatibility_flags.length&&metadata.compatibility_flags.every(f=>/^[a-z0-9_]{1,64}$/.test(f)),'compatibility flags outside deployer subset');
  need(metadata.bindings.every(b=>/^[A-Z][A-Z0-9_]{0,63}$/.test(b.name)),'binding outside deployer subset');
  need(!metadata.bindings.some(b=>b.name.startsWith('DEPLOY_')),'reserved deployer binding');
  // The depot-generated HTTP release marker is unused by this private-health subset.
  // Validate its release identity before removing it; all other bindings remain registry claims.
  const marker=metadata.bindings.find(b=>b.name===RELEASE_MARKER_BINDING);
  if(marker){const value=parseJson(marker.text);need(value.application===manifest.application&&value.releaseTag===manifest.releaseTag&&value.sourceCommit===manifest.sourceCommit,'release marker identity mismatch');}
  const modules=artifact.modules.map(m=>{const data=new TextEncoder().encode(m.content),path=`targets/${target.id}/modules/${m.name}`;entries.push({name:path,data});return {name:m.name,path,type:m.type,sha256:hex(data)};});
  const converted={schema:'worker-artifact/v1',mainModule:metadata.main_module,compatibilityDate:metadata.compatibility_date,compatibilityFlags:metadata.compatibility_flags,modules,bindings:metadata.bindings.filter(b=>b.name!==RELEASE_MARKER_BINDING).map(b=>b.name).sort()};
  need(converted.bindings.length<=64,'too many deployer bindings');
  const data=canonicalBytes(converted),artifactPath=`targets/${target.id}/worker-artifact.json`;entries.push({name:artifactPath,data});
  targets.push({id:target.id,adapter:target.adapter,artifactPath,sha256:hex(data),dependsOn:target.dependsOn,healthContract:{kind:'worker-version/v1'}});
 }
 const output=createZip(entries);need(output.length<=MAX,'converted archive too large');
 const result={schema:manifest.schema,application:manifest.application,repository:manifest.repository,repositoryId:manifest.repositoryId,releaseTag:manifest.releaseTag,sourceCommit:manifest.sourceCommit,createdAt:new Date(manifest.createdAt).toISOString(),artifact:{path:'release.zip',sha256:hex(output),sizeBytes:output.length,mediaType:'application/zip'},targets};
 // The existing depot attestation cannot be reused: the protected release workflow must attest
 // BOTH these final bytes and canonicalBytes(result) together using its accepted builder identity.
 return {archive:output,manifest:result,manifestBytes:canonicalBytes(result),attestationSubjects:['release.zip','release.manifest.json']};
}
