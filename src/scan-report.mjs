import {createHash} from 'node:crypto';
const canonical=value=>JSON.stringify(value,(_,v)=>v&&Object.getPrototypeOf(v)===Object.prototype?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const hex=/^[a-f0-9]{64}$/,sha=/^[a-f0-9]{40}$/;
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
const strings=v=>Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<=1000)&&new Set(v).size===v.length;
const same=(a,b)=>canonical(a.slice().sort())===canonical(b.slice().sort());
const require=value=>{if(!value)throw Error('SCAN_REPORT_DENIED');};
export const mandatoryCategories=Object.freeze(['dependency-integrity','inventory','vulnerability','sast','dast','pentest','malware','quality']);

// A report is data, never authority. The caller supplies independently retained
// source/candidate coordinates and scanner policy from its authenticated proof.
export function validateScanReport(report,{source,candidate,policy,now}) {
  try{
    require(exact(report,['schema','repositoryID','commitSHA','treeSHA','runID','runAttempt','environmentDigest','policyDigest','inventory','fileInventory','receipt']));
    require(report.schema==='workflow-depot-scan-report/v1'&&Number.isSafeInteger(now)&&now>0);
    for(const key of ['repositoryID','runID','runAttempt'])require(Number.isSafeInteger(report[key])&&report[key]>0&&report[key]===source[key]);
    require(sha.test(report.commitSHA)&&report.commitSHA===source.commitSHA&&sha.test(report.treeSHA)&&report.treeSHA===candidate.treeSHA&&hex.test(report.policyDigest)&&report.policyDigest===candidate.policyDigest&&hex.test(report.environmentDigest));
    const inventory=report.inventory,receipt=report.receipt;
    require(exact(inventory,['digest','complete','paths','languages','frameworks','manifests'])&&inventory.complete===true&&hex.test(inventory.digest)&&['paths','languages','frameworks','manifests'].every(k=>strings(inventory[k]))&&inventory.manifests.every(p=>inventory.paths.includes(p)));
    require(Array.isArray(report.fileInventory)&&report.fileInventory.length===inventory.paths.length&&same(report.fileInventory.map(x=>x.path),inventory.paths));
    for(const entry of report.fileInventory){
      require(typeof entry.path==='string'&&!entry.path.startsWith('/')&&!/[\u0000-\u001f\u007f]/.test(entry.path)&&!entry.path.split('/').some(x=>['','.','..'].includes(x))&&hex.test(entry.sha256));
      if(entry.type==='file')require(exact(entry,['path','type','size','sha256'])&&Number.isSafeInteger(entry.size)&&entry.size>=0);
      else require(entry.type==='symlink'&&exact(entry,['path','type','target','sha256'])&&typeof entry.target==='string'&&entry.target.length>0&&entry.target.length<=4096);
    }
    require(hash(report.fileInventory)===inventory.digest);
    require(exact(receipt,['schema','repositoryID','commitSHA','treeSHA','policyDigest','inventoryDigest','tools'])&&receipt.schema==='repoctl-source-scans/v1'&&receipt.inventoryDigest===inventory.digest);
    for(const key of ['repositoryID','commitSHA','treeSHA','policyDigest'])require(receipt[key]===report[key]);
    require(policy&&strings(policy.supportedLanguages)&&strings(policy.supportedFrameworks)&&inventory.languages.every(x=>policy.supportedLanguages.includes(x))&&inventory.frameworks.every(x=>policy.supportedFrameworks.includes(x))&&strings(policy.requiredCategories)&&mandatoryCategories.every(x=>policy.requiredCategories.includes(x))&&Array.isArray(policy.requiredTools)&&policy.requiredTools.length>0&&Array.isArray(policy.exemptions)&&hex.test(policy.sonarqubeStandardRulesetDigest??''));
    require(policy.requiredTools.some(t=>t.id==='sonarqube'&&t.category==='quality'&&t.rulesetDigest===policy.sonarqubeStandardRulesetDigest));
    const ids=new Set(),categories=new Set();
    for(const tool of policy.requiredTools){
      require(exact(tool,['id','category','version','rulesetDigest','databaseMaxAgeSeconds'])&&strings([tool.id])&&strings([tool.category])&&strings([tool.version])&&hex.test(tool.rulesetDigest)&&Number.isSafeInteger(tool.databaseMaxAgeSeconds)&&tool.databaseMaxAgeSeconds>=0&&!ids.has(tool.id));
      ids.add(tool.id);categories.add(tool.category);
    }
    require(policy.requiredCategories.every(c=>categories.has(c))&&Array.isArray(receipt.tools)&&receipt.tools.length===ids.size&&new Set(receipt.tools.map(t=>t.id)).size===ids.size);
    for(const tool of receipt.tools){
      const expected=policy.requiredTools.find(t=>t.id===tool.id);
      require(expected&&exact(tool,['id','category','version','rulesetDigest','status','commitSHA','inventoryDigest','coveredPaths','databaseUpdatedAt','completedAt','evidenceDigest'])&&tool.category===expected.category&&tool.version===expected.version&&tool.rulesetDigest===expected.rulesetDigest&&tool.status==='passed'&&tool.commitSHA===report.commitSHA&&tool.inventoryDigest===inventory.digest&&hex.test(tool.evidenceDigest)&&strings(tool.coveredPaths)&&Number.isSafeInteger(tool.completedAt)&&tool.completedAt<=now&&tool.completedAt>=now-3600);
      if(expected.databaseMaxAgeSeconds>0)require(Number.isSafeInteger(tool.databaseUpdatedAt)&&tool.databaseUpdatedAt<=now&&tool.databaseUpdatedAt>=now-expected.databaseMaxAgeSeconds);
      else require(tool.databaseUpdatedAt===null);
      const exemptions=policy.exemptions.filter(e=>e.toolID===tool.id);
      for(const e of exemptions)require(exact(e,['toolID','path','reason'])&&inventory.paths.includes(e.path)&&typeof e.reason==='string'&&e.reason.length>0);
      require(same(tool.coveredPaths,inventory.paths.filter(p=>!exemptions.some(e=>e.path===p))));
    }
    require(policy.exemptions.every(e=>ids.has(e.toolID)));
    return receipt;
  }catch{throw Error('SCAN_REPORT_DENIED');}
}
