import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,readdir,lstat,realpath,readlink,mkdtemp,rm} from 'node:fs/promises';
import {resolve,relative,dirname,sep,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';

const hex=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const canonical=value=>JSON.stringify(value,(_,v)=>v&&Object.getPrototypeOf(v)===Object.prototype?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const deny=code=>{throw Error(code);};
const inside=(root,path)=>path.startsWith(root+sep);
const safePath=path=>typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!/[\u0000-\u001f\u007f]/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..');

// No caller shell, inherited credentials, or unbounded scanner logs.
export async function runBounded(executable,args,{cwd,timeoutMs=30000,maxBytes=4*1024*1024,home}={}) {
  if(!isAbsolute(executable)||!Array.isArray(args)||args.some(x=>typeof x!=='string')||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024) deny('SCANNER_CONFIGURATION');
  return new Promise((resolvePromise,reject)=>{
    let child,bytes=0,stdout=[],stderr=[],problem;
    const stop=code=>{problem??=code;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
    try{child=spawn(executable,args,{cwd,shell:false,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:dirname(executable)+':/usr/bin:/bin',HOME:home??'/nonexistent',TMPDIR:home??tmpdir(),LANG:'C.UTF-8',PYTHONSAFEPATH:'1',PYTHONDONTWRITEBYTECODE:'1',SEMGREP_SEND_METRICS:'off',SEMGREP_ENABLE_VERSION_CHECK:'0'}});}catch{return reject(Error('SCANNER_UNAVAILABLE'));}
    const timer=setTimeout(()=>stop('SCANNER_TIMEOUT'),timeoutMs);
    for(const [stream,target] of [[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes)stop('SCANNER_OUTPUT_LIMIT');else target.push(chunk);});
    child.on('error',()=>{problem??='SCANNER_UNAVAILABLE';});
    child.on('close',code=>{clearTimeout(timer);if(problem||!Number.isInteger(code))reject(Error(problem??'SCANNER_FAILED'));else resolvePromise({code,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')});});
  });
}

// Includes hidden files, caches and binary artifacts. No ignore-file parsing.
export async function inventoryWorkspace(directory,{maxFiles=100000,maxBytes=1024*1024*1024}={}) {
  const root=await realpath(directory),entries=[];let bytes=0;
  async function walk(folder){
    for(const name of (await readdir(folder)).sort()){
      const full=resolve(folder,name),path=relative(root,full).split(sep).join('/');
      if(!safePath(path))deny('INVENTORY_PATH');
      const before=await lstat(full);
      if(before.isDirectory()){await walk(full);continue;}
      if(entries.length>=maxFiles)deny('INVENTORY_LIMIT');
      if(before.isSymbolicLink()){
        let target;try{target=await realpath(full);}catch{deny('INVENTORY_SYMLINK');}
        if(!inside(root,target)||(await lstat(target)).isDirectory())deny('INVENTORY_SYMLINK');
        const link=await readlink(full);entries.push({path,type:'symlink',target:link,sha256:hash(link)});continue;
      }
      if(!before.isFile())deny('INVENTORY_FILE_TYPE');
      bytes+=before.size;if(bytes>maxBytes)deny('INVENTORY_LIMIT');
      const content=await readFile(full),after=await lstat(full);
      if(content.length!==before.size||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)deny('INVENTORY_CHANGED');
      entries.push({path,type:'file',size:content.length,sha256:hash(content)});
    }
  }
  await walk(root);entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return {schema:'workflow-depot-inventory/v1',complete:true,entries,digest:hash(canonical(entries))};
}

export async function verifyNpmDependencies(directory,policy) {
  const root=await realpath(directory);
  if(!policy||!hex.test(policy.lockfileDigest??'')||!Array.isArray(policy.dependencies))deny('DEPENDENCY_POLICY');
  const bytes=await readFile(resolve(root,'package-lock.json'));if(hash(bytes)!==policy.lockfileDigest)deny('DEPENDENCY_LOCKFILE');
  const lock=JSON.parse(bytes);if(lock.lockfileVersion!==3||!lock.packages||typeof lock.packages!=='object')deny('DEPENDENCY_FORMAT_UNSUPPORTED');
  const paths=Object.keys(lock.packages).filter(path=>path!=='').sort();
  if(canonical(paths)!==canonical(policy.dependencies.map(d=>d.path).sort())||new Set(paths).size!==policy.dependencies.length)deny('DEPENDENCY_INVENTORY');
  for(const expected of policy.dependencies){
    if(!safePath(expected.path)||!expected.path.startsWith('node_modules/')||!safePath(expected.archivePath)||!hex.test(expected.treeDigest??''))deny('DEPENDENCY_POLICY');
    const actual=lock.packages[expected.path];
    if(actual.link||actual.version!==expected.version||actual.integrity!==expected.integrity||!/^https:\/\/registry\.npmjs\.org\//.test(actual.resolved??''))deny('DEPENDENCY_VERSION');
    const installed=await realpath(resolve(root,expected.path)),archive=await realpath(resolve(root,expected.archivePath));
    if(!inside(root,installed)||!inside(root,archive))deny('DEPENDENCY_PATH');
    const manifest=JSON.parse(await readFile(resolve(installed,'package.json'),'utf8'));
    if(manifest.version!==expected.version)deny('DEPENDENCY_VERSION');
    if(!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expected.integrity)||'sha512-'+createHash('sha512').update(await readFile(archive)).digest('base64')!==expected.integrity)deny('DEPENDENCY_ARCHIVE');
    if((await inventoryWorkspace(installed)).digest!==expected.treeDigest)deny('DEPENDENCY_TREE');
  }
  // Reject unlisted installed packages, including nested dependency roots.
  const inventory=await inventoryWorkspace(root);
  const installed=inventory.entries.filter(e=>e.path.startsWith('node_modules/')&&/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package.json$/.test(e.path)).map(e=>e.path.slice(0,-'/package.json'.length)).sort();
  if(canonical(installed)!==canonical(paths))deny('DEPENDENCY_INVENTORY');
  return {dependencies:paths.length,lockfileDigest:policy.lockfileDigest,evidenceDigest:hash(canonical(policy))};
}

export function requireAllCategories(required,tools) {
  if(!Array.isArray(required)||!required.length||required.some(category=>!tools.some(tool=>tool.category===category&&tool.status==='passed')))deny('SCANNER_UNAVAILABLE');
}

export async function runScanner(spec,{root,inventory,execute=runBounded,exemptions=[]}={}) {
  if(!['semgrep','gitleaks'].includes(spec?.id))deny('SCANNER_UNAVAILABLE');
  if(!isAbsolute(spec.executable??'')||!isAbsolute(spec.rulesPath??'')||!hex.test(spec.executableDigest??'')||!hex.test(spec.rulesetDigest??''))deny('SCANNER_PIN');
  try{if(hash(await readFile(spec.executable))!==spec.executableDigest||hash(await readFile(spec.rulesPath))!==spec.rulesetDigest)deny('SCANNER_PIN');}catch{deny('SCANNER_PIN');}
  if(spec.id==='semgrep'){
    if(!hex.test(spec.runtimeDigest??'')||!hex.test(spec.interpreterDigest??'')||!isAbsolute(spec.runtimeRoot??'')||!isAbsolute(spec.interpreterPath??''))deny('SCANNER_RUNTIME_PIN');
    if(hash(await readFile(spec.interpreterPath))!==spec.interpreterDigest||(await inventoryWorkspace(spec.runtimeRoot)).digest!==spec.runtimeDigest)deny('SCANNER_RUNTIME_PIN');
  }
  if(!Array.isArray(inventory?.entries)||!hex.test(inventory.digest??'')||hash(canonical(inventory.entries))!==inventory.digest)deny('SCANNER_INVENTORY');
  if((await inventoryWorkspace(root)).digest!==inventory.digest)deny('SCANNER_INVENTORY_CHANGED');
  if(!Array.isArray(exemptions)||exemptions.some(e=>!safePath(e.path)||typeof e.reason!=='string'||!e.reason.length||!inventory.entries.some(x=>x.path===e.path)))deny('SCANNER_EXEMPTION');
  const selected=inventory.entries.filter(e=>!exemptions.some(x=>x.path===e.path));
  const paths=selected.map(e=>e.path);
  if(!paths.length||paths.some(path=>!safePath(path)))deny('SCANNER_INVENTORY');
  for(const entry of selected){
    if(entry.type!=='file'||/\.(?:zip|gz|tgz|tar|jar|7z|bz2|xz|zst|whl)$/i.test(entry.path))deny('SCANNER_FORMAT_UNSUPPORTED');
    const bytes=await readFile(resolve(root,entry.path));
    if(bytes.includes(0))deny('SCANNER_FORMAT_UNSUPPORTED');
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{deny('SCANNER_FORMAT_UNSUPPORTED');}
  }
  const home=await mkdtemp(resolve(tmpdir(),'trusted-scanner-'));
  try{
    const timeoutMs=spec.timeoutMs??120000,deadline=Date.now()+timeoutMs;
    const options={cwd:root,home,timeoutMs,maxBytes:8*1024*1024};
    const version=await execute(spec.executable,[spec.id==='gitleaks'?'version':'--version'],options);
    if(version.code!==0||version.stdout.trim()!==spec.version)deny('SCANNER_VERSION');
    let report,coveredPaths;
    if(spec.id==='semgrep'){
      const result=await execute(spec.executable,['scan','--config',spec.rulesPath,'--json','--error','--strict','--metrics=off','--disable-version-check','--disable-nosem','--no-git-ignore','--x-ignore-semgrepignore-files','--no-exclude-binary-files','--max-target-bytes','0','--timeout','10','--timeout-threshold','1','--jobs','1',...paths.map(path=>resolve(root,path))],options);
      try{report=JSON.parse(result.stdout);}catch{deny('SCANNER_REPORT');}
      if(result.code!==0||report.version!==spec.version||!Array.isArray(report.results)||report.results.length||!Array.isArray(report.errors)||report.errors.length)deny('SCANNER_FAILED');
      coveredPaths=report.paths?.scanned?.map(path=>isAbsolute(path)?relative(root,path).split(sep).join('/'):path).sort();
      if(!coveredPaths||canonical(coveredPaths)!==canonical([...paths].sort()))deny('SCANNER_COVERAGE');
    }else{
      // Explicit file targets avoid application ignore/config discovery. JSON
      // and logs are redacted by the tool; raw findings never leave this adapter.
      const results=[];
      for(const path of paths){
        options.timeoutMs=deadline-Date.now();if(options.timeoutMs<=0)deny('SCANNER_TIMEOUT');
        const result=await execute(spec.executable,['dir',resolve(root,path),'--config',spec.rulesPath,'--no-banner','--redact=100','--report-format','json','--report-path','-','--gitleaks-ignore-path','/dev/null','--ignore-gitleaks-allow','--max-archive-depth','5','--max-target-megabytes','0','--timeout','60','--log-level','error'],options);
        let items;try{items=JSON.parse(result.stdout);}catch{deny('SCANNER_REPORT');}
        if(result.code!==0||!Array.isArray(items)||items.length)deny('SCANNER_FAILED');
        results.push({path,findings:0});
      }
      report=results;coveredPaths=[...paths].sort();
    }
    if((await inventoryWorkspace(root)).digest!==inventory.digest)deny('SCANNER_INVENTORY_CHANGED');
    return {id:spec.id,category:spec.id==='semgrep'?'sast':'secrets',version:spec.version,rulesetDigest:spec.rulesetDigest,status:'passed',inventoryDigest:inventory.digest,coveredPaths,databaseUpdatedAt:null,completedAt:Math.floor(Date.now()/1000),evidenceDigest:hash(canonical(report))};
  }finally{await rm(home,{recursive:true,force:true});}
}
