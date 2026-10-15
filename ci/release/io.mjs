// Shared CLI and filesystem helpers for ci/release scripts. Fail closed: symlinks,
// special files, paths escaping a root and pre-existing outputs are all errors.
import {lstatSync,readdirSync,readFileSync,writeFileSync,mkdirSync,realpathSync,appendFileSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isRelativePath,parseJson,canonicalBytes} from '../../src/shared/release-contract.mjs';

export function parseArgs(argv,spec){
 const out={};
 for(let i=0;i<argv.length;i+=2){
  const flag=argv[i],value=argv[i+1];
  if(typeof flag!=='string'||!flag.startsWith('--')||!Object.hasOwn(spec,flag.slice(2)))throw Error(`Unknown argument ${JSON.stringify(flag)}`);
  if(value===undefined)throw Error(`Missing value for ${flag}`);
  const name=flag.slice(2),rule=spec[name];
  if(rule.pattern&&!rule.pattern.test(value))throw Error(`Invalid value for ${flag}`);
  if(rule.multiple)(out[name]??=[]).push(value);
  else if(Object.hasOwn(out,name))throw Error(`Duplicate argument ${flag}`);
  else out[name]=value;
 }
 for(const [name,rule] of Object.entries(spec)){
  if(Object.hasOwn(out,name))continue;
  if(rule.required)throw Error(`Missing required argument --${name}`);
  if(Object.hasOwn(rule,'default'))out[name]=rule.default;
 }
 return out;
}

export const isMain=url=>Boolean(process.argv[1])&&url===pathToFileURL(resolve(process.argv[1])).href;
export async function runCli(main){
 try{await main(process.argv.slice(2),process.env);}
 catch(error){process.stderr.write(`error: ${error?.message||'release step failed'}\n`);process.exitCode=1;}
}

export function writeOnce(path,bytes){
 mkdirSync(dirname(path),{recursive:true});
 writeFileSync(path,bytes,{flag:'wx',mode:0o644});
}
export const writeCanonical=(path,value)=>writeOnce(path,canonicalBytes(value));

export function realDirectory(path,label='directory'){
 const stat=lstatSync(path);
 if(stat.isSymbolicLink()||!stat.isDirectory())throw Error(`${label} must be a real directory`);
 return realpathSync(path);
}
// Resolves a normalized relative path under root, refusing symlinks on every component.
export function resolveInside(root,relative,label='path'){
 if(!isRelativePath(relative))throw Error(`${label} must be a normalized relative path`);
 const base=realDirectory(root,'root');
 let current=base;
 for(const segment of relative.split('/')){
  current=join(current,segment);
  if(lstatSync(current).isSymbolicLink())throw Error(`${label} must not traverse symlinks`);
 }
 if(!(realpathSync(current)+sep).startsWith(base+sep))throw Error(`${label} escapes its root`);
 return current;
}
export function readRegularFile(path,maxBytes,label='file'){
 const stat=lstatSync(path);
 if(stat.isSymbolicLink()||!stat.isFile())throw Error(`${label} must be a regular file`);
 if(stat.size>maxBytes)throw Error(`${label} exceeds ${maxBytes} bytes`);
 const bytes=readFileSync(path);
 if(bytes.length!==stat.size)throw Error(`${label} changed while reading`);
 return new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.length);
}
export const readJsonFile=(path,maxBytes,label)=>parseJson(readRegularFile(path,maxBytes,label),{maxBytes,label});

// Sorted, POSIX-relative inventory of regular files; links and special files are errors.
export function walkFiles(root,{maxFiles,maxFileBytes,maxTotalBytes,label='tree'}){
 const base=realDirectory(root,label),files=[];let total=0;
 (function walk(dir,prefix){
  for(const name of readdirSync(dir).sort()){
   const full=join(dir,name),stat=lstatSync(full),rel=prefix?`${prefix}/${name}`:name;
   if(stat.isSymbolicLink())throw Error(`${label} contains a symlink: ${rel}`);
   if(stat.isDirectory()){walk(full,rel);continue;}
   if(!stat.isFile())throw Error(`${label} contains a special file: ${rel}`);
   if(stat.size>maxFileBytes)throw Error(`${label} file exceeds ${maxFileBytes} bytes: ${rel}`);
   total+=stat.size;
   if(files.length>=maxFiles)throw Error(`${label} exceeds ${maxFiles} files`);
   if(total>maxTotalBytes)throw Error(`${label} exceeds ${maxTotalBytes} total bytes`);
   files.push({path:rel,abs:full,size:stat.size});
  }
 })(base,'');
 return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

// Values are validated by callers; newline checks keep GITHUB_OUTPUT unambiguous.
export function writeGithubOutput(file,values){
 if(!file)return;
 const lines=Object.entries(values).map(([key,value])=>{
  const text=String(value);
  if(!/^[a-z][a-z0-9_]*$/.test(key)||/[\r\n]/.test(text))throw Error('Unsafe step output');
  return `${key}=${text}\n`;
 });
 appendFileSync(file,lines.join(''));
}
