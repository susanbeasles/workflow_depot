// Extracts targets/*.zip into a fresh directory (for SBOM generation) using the
// strict ZIP reader; entry names are validated, so extraction cannot escape `out`.
import {mkdirSync,readdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {LIMITS} from '../../src/shared/release-contract.mjs';
import {readZip} from './zip.mjs';
import {parseArgs,isMain,runCli,writeOnce,readRegularFile,realDirectory} from './io.mjs';

export function unpackTargets(releaseDir,out){
 const targets=join(realDirectory(releaseDir,'release directory'),'targets');
 realDirectory(targets,'targets directory');
 mkdirSync(out);
 const root=resolve(out);let files=0;
 for(const name of readdirSync(targets).sort()){
  const m=/^([a-z0-9-]{1,64})\.zip$/.exec(name);
  if(!m)throw Error(`Unexpected bundle name: ${name}`);
  const entries=readZip(readRegularFile(join(targets,name),LIMITS.bundleBytes,name),{maxEntries:LIMITS.assetFiles+1,maxEntryBytes:Math.max(LIMITS.artifactJsonBytes,LIMITS.assetFileBytes),maxTotalBytes:LIMITS.bundleBytes});
  for(const entry of entries){
   const path=resolve(root,m[1],entry.name);
   if(!path.startsWith(root+sep))throw Error('Bundle entry escapes the output directory');
   writeOnce(path,entry.data);files++;
  }
 }
 return files;
}

export async function main(argv){
 const args=parseArgs(argv,{'release-dir':{required:true},out:{required:true}});
 process.stdout.write(`unpacked ${unpackTargets(args['release-dir'],args.out)} files\n`);
}
if(isMain(import.meta.url))runCli(main);
