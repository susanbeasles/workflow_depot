// Packages each cloudflare-d1-migrate/v1 target as targets/<target-id>.zip:
//   ledger.json      migrations-ledger/v1
//   NNNN_name.sql    exact bytes from the repository (never executed here)
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {ADAPTERS,LIMITS,SCHEMAS,TARGET_ID,artifactPathFor,parseJson,canonicalBytes,validateMigrationsLedger} from '../../src/shared/release-contract.mjs';
import {createZip} from './zip.mjs';
import {loadApplication,targetOf} from './read-application.mjs';
import {parseArgs,isMain,runCli,writeOnce,resolveInside,readRegularFile,walkFiles} from './io.mjs';

const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const FILE=/^(\d{4})(?:_[A-Za-z0-9_-]{1,64})?\.sql$/;

// Leading comment block directives: `-- compatibility: additive|expand|contract`
// and, for contract migrations, `-- requires: NNNN` (the expand it follows).
export function parseMigrationHeader(sql){
 let compatibility=null,requires=null;
 for(const line of sql.split(/\r?\n/)){
  const text=line.trim();
  if(text==='')continue;
  if(!text.startsWith('--'))break;
  const m=/^--\s*(compatibility|requires)\s*:\s*(.*?)\s*$/i.exec(text);
  if(!m)continue;
  if(m[1].toLowerCase()==='compatibility'){
   if(compatibility!==null)throw Error('Duplicate compatibility directive');
   if(!['additive','expand','contract'].includes(m[2]))throw Error(`Unknown compatibility ${JSON.stringify(m[2])}`);
   compatibility=m[2];
  }else{
   if(requires!==null)throw Error('Duplicate requires directive');
   if(!/^\d{4}$/.test(m[2]))throw Error('requires must name a four-digit migration version');
   requires=m[2];
  }
 }
 compatibility??='additive';
 if(compatibility==='contract'&&requires===null)throw Error('contract migrations must declare -- requires: <version>');
 if(compatibility!=='contract'&&requires!==null)throw Error('-- requires is only valid for contract migrations');
 return {compatibility,requires};
}

// Informational statement count. Comments and quoted text are skipped; CREATE
// TRIGGER bodies (BEGIN ... END, with nested CASE ... END) count as one statement.
export function countStatements(sql){
 let count=0,i=0,content=false,words=[],trigger=false,depth=0;
 const end=()=>{if(content)count++;content=false;words=[];trigger=false;depth=0;};
 while(i<sql.length){
  const c=sql[i],next=sql[i+1];
  if(/\s/.test(c)){i++;continue;}
  if(c==='-'&&next==='-'){while(i<sql.length&&sql[i]!=='\n')i++;continue;}
  if(c==='/'&&next==='*'){const close=sql.indexOf('*/',i+2);if(close<0)throw Error('Unterminated block comment');i=close+2;continue;}
  content=true;
  if(c==="'"||c==='"'||c==='`'||c==='['){
   const quote=c==='['?']':c;let j=i+1;
   for(;;){
    if(j>=sql.length)throw Error('Unterminated quoted text');
    if(sql[j]===quote){if(quote!==']'&&sql[j+1]===quote){j+=2;continue;}break;}
    j++;
   }
   i=j+1;continue;
  }
  if(/[A-Za-z_]/.test(c)){
   let j=i+1;while(j<sql.length&&/[A-Za-z0-9_$]/.test(sql[j]))j++;
   const word=sql.slice(i,j).toUpperCase();i=j;
   if(words.length<6){words.push(word);if(words[0]==='CREATE'&&word==='TRIGGER')trigger=true;}
   if(trigger&&(word==='BEGIN'||word==='CASE'))depth++;
   else if(trigger&&word==='END'&&depth>0)depth--;
   continue;
  }
  if(c===';'){i++;if(trigger&&depth>0)continue;end();continue;}
  i++;
 }
 end();
 return count;
}

export function buildLedger(dir,{binding}){
 const files=walkFiles(dir,{maxFiles:LIMITS.migrationFiles,maxFileBytes:LIMITS.migrationFileBytes,maxTotalBytes:LIMITS.migrationFiles*LIMITS.migrationFileBytes,label:'migrations directory'});
 if(!files.length)throw Error('migrations directory is empty');
 const entries=[],migrations=[];
 for(const file of files){
  const m=FILE.exec(file.path);
  if(!m)throw Error(`Unexpected file in migrations directory: ${file.path}`);
  const data=readRegularFile(file.abs,LIMITS.migrationFileBytes,'migration');
  let sql;
  try{sql=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw Error(`${file.path} is not valid UTF-8`);}
  if(sql.includes('\0'))throw Error(`${file.path} contains NUL bytes`);
  const {compatibility,requires}=parseMigrationHeader(sql);
  const statements=countStatements(sql);
  if(statements<1)throw Error(`${file.path} contains no SQL statements`);
  migrations.push({version:m[1],file:file.path,sha256:hex(data),sizeBytes:data.length,statements,compatibility,recoveryPolicy:'forward-only',...(requires?{requires}:{})});
  entries.push({name:file.path,data});
 }
 return {ledger:validateMigrationsLedger({schema:SCHEMAS.ledger,binding,migrations}),entries};
}

export function bundleMigrations({appRoot,application,targetId,outDir}){
 const target=targetOf(application,targetId,ADAPTERS.d1);
 const {ledger,entries}=buildLedger(resolveInside(appRoot,target.build.migrationsDir,'migrations directory'),{binding:target.build.binding});
 const zip=createZip([{name:'ledger.json',data:canonicalBytes(ledger)},...entries]);
 if(zip.length>LIMITS.bundleBytes)throw Error('Migrations bundle exceeds size limit');
 const artifactPath=artifactPathFor(target.id);
 writeOnce(join(outDir,artifactPath),zip);
 return {target:target.id,artifactPath,sha256:hex(zip),sizeBytes:zip.length,migrations:ledger.migrations.length};
}

// --targets takes the JSON array emitted by read-application-manifest (may be empty).
export function parseTargetList(value){
 const ids=parseJson(value,{maxBytes:4096,label:'targets'});
 if(!Array.isArray(ids)||ids.length>LIMITS.targets||!ids.every(id=>typeof id==='string'&&TARGET_ID.test(id))||new Set(ids).size!==ids.length)throw Error('targets must be a JSON array of unique target ids');
 return ids;
}
export async function main(argv){
 const args=parseArgs(argv,{'app-root':{required:true},application:{required:true},targets:{required:true},'out-dir':{required:true}});
 const application=loadApplication(args.application);
 for(const targetId of parseTargetList(args.targets)){
  const result=bundleMigrations({appRoot:args['app-root'],application,targetId,outDir:args['out-dir']});
  process.stdout.write(`${result.artifactPath} sha256=${result.sha256} migrations=${result.migrations}\n`);
 }
}
if(isMain(import.meta.url))runCli(main);
