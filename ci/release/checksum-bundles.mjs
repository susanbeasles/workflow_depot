// Computes checksums.json (release-checksums/v1) and the equivalent SHA256SUMS over
// every bundle, the authorization policy and any SBOMs. Stray files are rejected.
import {createHash} from 'node:crypto';
import {readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {LIMITS,SCHEMAS,CHECKSUM_PATH,validateChecksums,renderSha256Sums} from '../../src/shared/release-contract.mjs';
import {parseArgs,isMain,runCli,writeCanonical,writeOnce,readRegularFile,realDirectory} from './io.mjs';

const OPTIONAL=['sbom.cdx.json','sbom.spdx.json'];
// `skip` names top-level files written after checksumming (checksums.json, SHA256SUMS).
export function checksummedPaths(releaseDir,{skip=[]}={}){
 realDirectory(releaseDir,'release directory');
 const paths=[];
 for(const name of readdirSync(releaseDir).sort()){
  if(skip.includes(name))continue;
  const stat=lstatSync(join(releaseDir,name));
  if(name==='targets'&&!stat.isSymbolicLink()&&stat.isDirectory()){
   for(const bundle of readdirSync(join(releaseDir,name)).sort())paths.push(`targets/${bundle}`);
   continue;
  }
  if(name!=='authorization-policy.json'&&!OPTIONAL.includes(name))throw Error(`Unexpected entry in release directory before checksumming: ${name}`);
  paths.push(name);
 }
 for(const path of paths)if(!CHECKSUM_PATH.test(path))throw Error(`Unexpected release file: ${path}`);
 return paths;
}

export function computeChecksums(releaseDir){
 const files={};
 for(const path of checksummedPaths(releaseDir)){
  const data=readRegularFile(join(releaseDir,path),LIMITS.releaseBytes,path);
  files[path]={sha256:createHash('sha256').update(data).digest('hex'),sizeBytes:data.length};
 }
 return validateChecksums({schema:SCHEMAS.checksums,algorithm:'sha256',files});
}

export function writeChecksums(releaseDir){
 const checksums=computeChecksums(releaseDir);
 writeCanonical(join(releaseDir,'checksums.json'),checksums);
 writeOnce(join(releaseDir,'SHA256SUMS'),new TextEncoder().encode(renderSha256Sums(checksums)));
 return checksums;
}

export async function main(argv){
 const args=parseArgs(argv,{'release-dir':{required:true}});
 const checksums=writeChecksums(args['release-dir']);
 process.stdout.write(renderSha256Sums(checksums));
}
if(isMain(import.meta.url))runCli(main);
