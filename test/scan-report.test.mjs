import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../src/scan-adapters.mjs';
const api=await import('../src/scan-report.mjs').catch(()=>({}));
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function fixture(){
  const categories=['dependency-integrity','inventory','vulnerability','sast','dast','pentest','malware','quality'];
  const fileInventory=[{path:'.cache/source.js',type:'file',size:1,sha256:'a'.repeat(64)}];
  const source={repositoryID:1,commitSHA:'b'.repeat(40),runID:2,runAttempt:1},candidate={treeSHA:'c'.repeat(40),policyDigest:'d'.repeat(64)};
  const policy={supportedLanguages:['javascript'],supportedFrameworks:[],requiredCategories:categories,sonarqubeStandardRulesetDigest:'e'.repeat(64),exemptions:[],requiredTools:categories.map(category=>({id:category==='quality'?'sonarqube':category,category,version:'synthetic-only',rulesetDigest:'e'.repeat(64),databaseMaxAgeSeconds:0}))};
  const inventory={digest:hash(fileInventory),complete:true,paths:['.cache/source.js'],languages:['javascript'],frameworks:[],manifests:[]};
  const tools=policy.requiredTools.map(t=>({id:t.id,category:t.category,version:t.version,rulesetDigest:t.rulesetDigest,status:'passed',commitSHA:source.commitSHA,inventoryDigest:inventory.digest,coveredPaths:inventory.paths,databaseUpdatedAt:null,completedAt:1000,evidenceDigest:'f'.repeat(64)}));
  const receipt={schema:'repoctl-source-scans/v1',repositoryID:source.repositoryID,commitSHA:source.commitSHA,treeSHA:candidate.treeSHA,policyDigest:candidate.policyDigest,inventoryDigest:inventory.digest,tools};
  return {report:{schema:'workflow-depot-scan-report/v1',...source,...candidate,environmentDigest:'0'.repeat(64),inventory,fileInventory,receipt},expected:{source,candidate,policy,now:1000}};
}
test('scan report validator accepts fully bound synthetic evidence',()=>{
  assert.equal(typeof api.validateScanReport,'function');const f=fixture();assert.deepEqual(api.validateScanReport(f.report,f.expected),f.report.receipt);
});
test('scan report rejects missing categories, coverage, stale tools and mismatched source/artifacts',()=>{
  assert.equal(typeof api.validateScanReport,'function');
  for(const mutate of [f=>{f.report.commitSHA='a'.repeat(40);},f=>{f.report.runAttempt++;},f=>{f.report.fileInventory[0].sha256='1'.repeat(64);},f=>{f.report.receipt.tools.pop();},f=>{f.report.receipt.tools[0].coveredPaths=[];},f=>{f.report.receipt.tools[0].completedAt=-3000;},f=>{f.report.receipt.tools[0].status='unavailable';},f=>{f.expected.policy.requiredCategories=['sast'];},f=>{f.expected.policy.sonarqubeStandardRulesetDigest='1'.repeat(64);}]) {
    const f=fixture();mutate(f);assert.throws(()=>api.validateScanReport(f.report,f.expected),/SCAN_REPORT/);
  }
});
