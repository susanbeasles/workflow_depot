#!/usr/bin/env node
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,inventoryWorkspace,verifyNpmDependencies,runScanner,runBounded,requireAllCategories} from '../src/scan-adapters.mjs';
import {validateScanReport,mandatoryCategories} from '../src/scan-report.mjs';

const depot=fileURLToPath(new URL('..',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const deny=()=>{throw Error('SCANNER_UNAVAILABLE');};

export async function scanCandidate({root,source,candidate,environmentDigest,policy,toolLock}) {
  // Commissioned policy is read from the pinned depot checkout, not app code.
  if(policy.qualified!==true||policy.candidatePolicyDigest!==candidate.policyDigest||!Array.isArray(policy.requiredCategories)||mandatoryCategories.some(c=>!policy.requiredCategories.includes(c))||!Array.isArray(policy.requiredTools)||!Array.isArray(policy.exemptions)||!/^[a-f0-9]{64}$/.test(environmentDigest))deny();
  const inventory=await inventoryWorkspace(root),paths=inventory.entries.map(e=>e.path);
  const languages=[...new Set(paths.filter(p=>!p.startsWith('.git/')).map(p=>/\.(?:js|mjs|cjs)$/.test(p)?'javascript':/\.(?:ts|tsx)$/.test(p)?'typescript':null).filter(Boolean))];
  if(!languages.length||languages.some(language=>!policy.supportedLanguages.includes(language)))deny();
  // No guessed framework or language exemptions: all per-tool exclusions must
  // be exact paths with reasons in the independently approved scanner policy.
  const metadata={digest:inventory.digest,complete:true,paths,languages,frameworks:[],manifests:paths.filter(p=>/(?:^|\/)(?:package.json|package-lock.json|yarn.lock)$/.test(p))};
  if(paths.some(p=>p==='yarn.lock')||!paths.includes('package-lock.json'))deny();
  const dependencies=await verifyNpmDependencies(root,policy.dependencyIntegrity);
  const tools=[];
  for(const required of policy.requiredTools){
    if(['inventory','dependency-integrity'].includes(required.id)){
      if(required.category!==required.id||required.version!=='1'||required.rulesetDigest!==hash(await readFile(resolve(depot,'src/scan-adapters.mjs')))||required.databaseMaxAgeSeconds!==0)deny();
      tools.push({...required,status:'passed',coveredPaths:paths,databaseUpdatedAt:null,completedAt:Math.floor(Date.now()/1000),evidenceDigest:required.id==='inventory'?inventory.digest:dependencies.evidenceDigest});delete tools.at(-1).databaseMaxAgeSeconds;
      continue;
    }
    if(!['semgrep','gitleaks'].includes(required.id))deny();
    const id=required.id,pin=toolLock[id];
    if(required.version!==pin.version||required.rulesetDigest!==pin.rulesetDigest||required.databaseMaxAgeSeconds!==0)deny();
    const base=toolLock.installRoot;
    const spec={...pin,id,executable:id==='gitleaks'?resolve(base,'gitleaks'):resolve(base,'semgrep/bin/semgrep'),rulesPath:resolve(depot,'scanning',id==='gitleaks'?'gitleaks.toml':'semgrep.yml'),...(id==='semgrep'?{runtimeRoot:resolve(base,'semgrep/lib/python3.12/site-packages'),interpreterPath:resolve(base,'semgrep/bin/python')}:{})};
    const exemptions=policy.exemptions.filter(x=>x.toolID===id).map(({path,reason})=>({path,reason}));
    tools.push(await runScanner(spec,{root,inventory,exemptions}));
  }
  requireAllCategories(policy.requiredCategories,tools);
  if((await inventoryWorkspace(root)).digest!==inventory.digest)throw Error('SCANNER_INVENTORY_CHANGED');
  const receipt={schema:'repoctl-source-scans/v1',repositoryID:source.repositoryID,commitSHA:source.commitSHA,treeSHA:candidate.treeSHA,policyDigest:candidate.policyDigest,inventoryDigest:inventory.digest,tools:tools.map(tool=>({...tool,commitSHA:source.commitSHA,inventoryDigest:inventory.digest}))};
  const report={schema:'workflow-depot-scan-report/v1',repositoryID:source.repositoryID,commitSHA:source.commitSHA,treeSHA:candidate.treeSHA,runID:source.runID,runAttempt:source.runAttempt,environmentDigest,policyDigest:candidate.policyDigest,inventory:metadata,fileInventory:inventory.entries,receipt};
  validateScanReport(report,{source,candidate,policy,now:Math.floor(Date.now()/1000)});
  return report;
}

async function main(){
  const e=process.env;
  const source={repositoryID:Number(e.SOURCE_REPOSITORY_ID),commitSHA:e.CANDIDATE_SHA,runID:Number(e.SOURCE_RUN_ID),runAttempt:Number(e.SOURCE_RUN_ATTEMPT)};
  const candidate={treeSHA:e.CANDIDATE_TREE_SHA,policyDigest:e.CANDIDATE_POLICY_DIGEST};
  if(![source.repositoryID,source.runID,source.runAttempt].every(x=>Number.isSafeInteger(x)&&x>0)||!/^refs\/heads\/promotion\/[1-9][0-9]*\/shadow$/.test(e.SOURCE_REF??'')||!(/^[a-f0-9]{40}$/.test(source.commitSHA)&&/^[a-f0-9]{40}$/.test(candidate.treeSHA)&&/^[a-f0-9]{64}$/.test(candidate.policyDigest)))deny();
  const root=resolve(e.APP_SOURCE_DIRECTORY??''),head=await runBounded('/usr/bin/git',['-C',root,'rev-parse','HEAD'],{timeoutMs:10000}),tree=await runBounded('/usr/bin/git',['-C',root,'rev-parse','HEAD^{tree}'],{timeoutMs:10000});
  if(head.code!==0||tree.code!==0||head.stdout.trim()!==source.commitSHA||tree.stdout.trim()!==candidate.treeSHA)deny();
  const policy=JSON.parse(await readFile(resolve(depot,'scanning/policy.json'))),toolLock=JSON.parse(await readFile(resolve(depot,'scanning/tool-lock.json')));
  const report=await scanCandidate({root,source,candidate,environmentDigest:e.ENVIRONMENT_DIGEST,policy,toolLock});
  const bytes=canonical(report)+'\n';if(Buffer.byteLength(bytes)>32*1024*1024)deny();
  const path=resolve(e.RUNNER_TEMP,'scan-report.json');
  await writeFile(path,bytes,{flag:'wx',mode:0o600});
  await appendFile(e.GITHUB_OUTPUT,'scan_report_digest='+hash(bytes)+'\n');
  console.log('All required scanner evidence verified');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('SCANNER_UNAVAILABLE_OR_FAILED: required evidence is incomplete');process.exitCode=1;});
