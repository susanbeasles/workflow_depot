import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,link,rm,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),helper=fileURLToPath(new URL('../scripts/restore-environment.py',import.meta.url));
async function scenario(entries,{prepare=async()=>{},extra=[],wrongDigest=false}={}){
  const root=await mkdtemp(join(tmpdir(),'safe-restore-fixture-'));
  const destination=join(root,'app-source');await mkdir(destination);await mkdir(join(root,'trusted-scanners'));await writeFile(join(root,'trusted-scanners','sentinel'),'trusted');await prepare(root,destination);
  try{
    const created=await exec('python3',['-c',`import io,json,tarfile,hashlib,sys
entries=json.loads(sys.argv[1]);path=sys.argv[2]
with tarfile.open(path,'w:gz') as archive:
 for entry in entries:
  item=tarfile.TarInfo(entry['path']);kind=entry.get('type','file')
  if kind=='file':
   data=entry.get('content','data').encode();item.size=len(data);archive.addfile(item,io.BytesIO(data))
  else:
   item.type={'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'directory':tarfile.DIRTYPE}[kind];item.linkname=entry.get('target','');archive.addfile(item)
print(hashlib.sha256(open(path,'rb').read()).hexdigest())`,JSON.stringify(entries),join(root,'environment.tar.gz')]);
    let code=0,stderr='';try{await exec('python3',[helper,join(root,'environment.tar.gz'),destination,wrongDigest?'0'.repeat(64):created.stdout.trim(),...extra],{timeout:5000});}catch(error){code=error.code;stderr=error.stderr;}
    assert.equal(await readFile(join(root,'trusted-scanners','sentinel'),'utf8'),'trusted');
    return {code,stderr,root,destination,cleanup:()=>rm(root,{recursive:true,force:true})};
  }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
test('data-only restore accepts ordinary files and contained cache executable symlinks',async()=>{
  const result=await scenario([{path:'node_modules/example/index.js',content:'safe'},{path:'node_modules/.bin/example',type:'symlink',target:'../example/index.js'}]);
  try{assert.equal(result.code,0,result.stderr);assert.equal(await readFile(join(result.destination,'node_modules/example/index.js'),'utf8'),'safe');assert.equal(await readlink(join(result.destination,'node_modules/.bin/example')),'../example/index.js');}finally{await result.cleanup();}
});
test('pre-existing destination symlink cannot escape into trusted scanner checkout',async()=>{
  const result=await scenario([{path:'escape/sentinel',content:'tampered'}],{prepare:async(root,destination)=>symlink('../trusted-scanners',join(destination,'escape'))});
  try{assert.notEqual(result.code,0);assert.match(result.stderr,/ENVIRONMENT_RESTORE_DENIED/);}finally{await result.cleanup();}
});
test('malicious link/traversal/Git metadata/duplicate entries are rejected before overlay',async()=>{
  for(const malicious of [
    {path:'../trusted-scanners/sentinel'},{path:'/absolute'},{path:'.git/config'},
    {path:'cache/link',type:'symlink',target:'../../trusted-scanners/sentinel'},
    {path:'cache/link',type:'hardlink',target:'../trusted-scanners/sentinel'},
    {path:'safe.txt'},
  ]){
    const result=await scenario([{path:'safe.txt',content:'candidate'},malicious]);
    try{assert.notEqual(result.code,0);assert.match(result.stderr,/ENVIRONMENT_RESTORE_DENIED/);await assert.rejects(readFile(join(result.destination,'safe.txt')));}finally{await result.cleanup();}
  }
});
test('restore enforces member and expanded byte limits',async()=>{
  for(const extra of [['--max-files','1'],['--max-bytes','1']]){
    const result=await scenario([{path:'a',content:'aa'},{path:'b',content:'bb'}],{extra});
    try{assert.notEqual(result.code,0);assert.match(result.stderr,/ENVIRONMENT_RESTORE_DENIED/);await assert.rejects(readFile(join(result.destination,'a')));}finally{await result.cleanup();}
  }
});
test('wrong digest and existing hardlink aliases cannot change trusted bytes',async()=>{
  for(const options of [{wrongDigest:true},{prepare:async(root,destination)=>link(join(root,'trusted-scanners','sentinel'),join(destination,'target'))}]){
    const result=await scenario([{path:'target',content:'tampered'}],options);
    try{assert.notEqual(result.code,0);assert.match(result.stderr,/ENVIRONMENT_RESTORE_DENIED/);}finally{await result.cleanup();}
  }
});
