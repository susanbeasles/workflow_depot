// Re-verifies every checksummed file, then writes release.zip containing the
// bundles, authorization-policy.json, checksums.json and SBOMs (stored, sorted,
// fixed timestamps, so identical inputs give identical bytes).
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {LIMITS,isCanonicalBytes,parseJson,renderSha256Sums,validateChecksums} from '../../src/shared/release-contract.mjs';
import {createZip} from './zip.mjs';
import {checksummedPaths} from './checksum-bundles.mjs';
import {parseArgs,isMain,runCli,writeOnce,writeGithubOutput,readRegularFile} from './io.mjs';

const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const sameSet=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));

export function loadChecksums(releaseDir){
 const bytes=readRegularFile(join(releaseDir,'checksums.json'),LIMITS.jsonBytes,'checksums.json');
 const checksums=validateChecksums(parseJson(bytes,{label:'checksums.json'}));
 if(!isCanonicalBytes(bytes,checksums))throw Error('checksums.json is not canonical JSON');
 const sums=new TextDecoder('utf-8',{fatal:true}).decode(readRegularFile(join(releaseDir,'SHA256SUMS'),LIMITS.jsonBytes,'SHA256SUMS'));
 if(sums!==renderSha256Sums(checksums))throw Error('SHA256SUMS does not match checksums.json');
 return {checksums,bytes};
}

export function assembleRelease(releaseDir){
 const {checksums,bytes}=loadChecksums(releaseDir);
 const listed=Object.keys(checksums.files);
 const present=checksummedPaths(releaseDir,{skip:['checksums.json','SHA256SUMS']});
 if(!sameSet(present,listed))throw Error('Release directory does not match checksums.json');
 const entries=[{name:'checksums.json',data:bytes}];
 for(const path of listed){
  const data=readRegularFile(join(releaseDir,path),LIMITS.releaseBytes,path);
  if(hex(data)!==checksums.files[path].sha256||data.length!==checksums.files[path].sizeBytes)throw Error(`Checksum mismatch before packaging: ${path}`);
  entries.push({name:path,data});
 }
 const zip=createZip(entries);
 if(zip.length>LIMITS.releaseBytes)throw Error('release.zip exceeds size limit');
 writeOnce(join(releaseDir,'release.zip'),zip);
 return {sha256:hex(zip),sizeBytes:zip.length};
}

export async function main(argv){
 const args=parseArgs(argv,{'release-dir':{required:true},'github-output':{}});
 const result=assembleRelease(args['release-dir']);
 writeGithubOutput(args['github-output'],{sha256:result.sha256,size_bytes:String(result.sizeBytes)});
 process.stdout.write(`release.zip sha256=${result.sha256} size=${result.sizeBytes}\n`);
}
if(isMain(import.meta.url))runCli(main);
