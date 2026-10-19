import {lstatSync,opendirSync,openSync,readSync,closeSync,constants,writeFileSync,realpathSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {candidate} from './project-profile.mjs';
export function inventory(root,{maxFiles=4096,maxEntries=8192,maxFileBytes=64*1024*1024,maxTotalBytes=256*1024*1024,maxMilliseconds=120000,clock=()=>performance.now()}={}) {
 if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory())throw Error('Build root must be a real directory');
 const started=clock(),checkTime=()=>{if(clock()-started>maxMilliseconds)throw Error('Build time budget exceeded');};
 const base=realpathSync(root),files=[],pending=[base];let count=0,total=0;
 while(pending.length){const directory=opendirSync(pending.pop());try{let entry;while((entry=directory.readSync())){
  checkTime();if(++count>maxEntries)throw Error('Build entry budget exceeded');
  const full=join(directory.path,entry.name),stat=lstatSync(full);
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw Error('Build output cannot contain links or special files');
  if(stat.isDirectory()){pending.push(full);continue;}
  total+=stat.size;
  if(files.length>=maxFiles||stat.size>maxFileBytes||total>maxTotalBytes)throw Error('Build byte or file budget exceeded');
  files.push({path:relative(base,full).split('\\').join('/'),bytes:stat.size,full});
 }}finally{directory.closeSync();}}
 if(!files.length)throw Error('Build output is empty');
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const buffer=Buffer.alloc(1024*1024);
 return files.map(({full,...file})=>{checkTime();const fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');let bytes=0;try{let n;while((n=readSync(fd,buffer,0,Math.min(buffer.length,file.bytes-bytes+1),null))){checkTime();bytes+=n;if(bytes>file.bytes)throw Error('Build file grew');hash.update(buffer.subarray(0,n));}}finally{closeSync(fd);}if(bytes!==file.bytes)throw Error('Build file changed');return {...file,sha256:hash.digest('hex')};});
}
export function manifest(root,env){candidate(env);if(!/^\d+$/.test(env.GITHUB_RUN_ID||'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT||''))throw Error('Missing run identity');return {schema:1,repository:env.GITHUB_REPOSITORY,sourceSha:env.GITHUB_SHA,sourceRef:env.GITHUB_REF,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,files:inventory(root)};}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)writeFileSync(process.argv[3],JSON.stringify(manifest(process.argv[2],process.env),null,2)+'\n');
