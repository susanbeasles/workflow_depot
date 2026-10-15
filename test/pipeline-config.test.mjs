import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContractError} from '../src/shared/release-contract.mjs';
import {validatePipelineConfig,configOutputs,assertWired,loadPipelineConfig,main,COVERAGE_THRESHOLDS,MAX_CONFIG_BYTES,SCHEMA} from '../ci/pipeline-config.mjs';

const EXAMPLES=new URL('../pipeline/examples/',import.meta.url);
const example=name=>JSON.parse(readFileSync(new URL(`${name}/pipeline.json`,EXAMPLES),'utf8'));
const clone=v=>structuredClone(v);
const denied=(value,pattern,name)=>assert.throws(()=>validatePipelineConfig(value),e=>e instanceof ContractError&&pattern.test(e.message),name);
const npm=()=>example('prosrus');
const terraform=()=>example('infra');
const scratch=()=>mkdtempSync(join(tmpdir(),'pipeline-config-'));

test('the three documented examples validate',()=>{
 for(const name of ['prosrus','personal-control','infra']){
  const config=example(name);
  assert.equal(validatePipelineConfig(config),config,name);
  assert.equal(config.schema,SCHEMA);
 }
});

test('docs/contracts.md shows the same examples byte for byte',()=>{
 const doc=readFileSync(new URL('../docs/contracts.md',import.meta.url),'utf8');
 for(const name of ['prosrus','personal-control','infra']){
  const text=readFileSync(new URL(`${name}/pipeline.json`,EXAMPLES),'utf8').trimEnd();
  assert.ok(doc.includes(`\`\`\`json\n${text}\n\`\`\``),`docs/contracts.md is missing the ${name} example`);
 }
});

test('unknown keys are rejected at every level',()=>{
 const top=npm();top.extra=1;denied(top,/unknown key extra/);
 for(const field of ['runtime','scripts','coverage','build','targets']){const c=npm();c[field].extra=1;denied(c,/unknown key extra/,field);}
 const image=npm();image.image={dockerfile:'Dockerfile',context:'.',platform:'linux/amd64'};denied(image,/unknown key platform/);
 const tf=terraform();tf.terraform.extra=1;denied(tf,/unknown key extra/);
 const tfTargets=terraform();tfTargets.targets.deploy=[];denied(tfTargets,/unknown key deploy/);
});

test('schema, ecosystem and profile are closed sets; required keys are required',()=>{
 denied({...npm(),schema:'workflow-depot-pipeline/v2'},/schema/);
 denied({...npm(),ecosystem:'pip'},/ecosystem/);
 denied({...npm(),policyProfile:'lenient'},/policyProfile/);
 for(const key of ['schema','ecosystem','policyProfile','workingDirectory','runtime','scripts','coverage','build','image','targets']){
  const c=npm();delete c[key];denied(c,new RegExp(key==='schema'?'schema':key==='ecosystem'?'ecosystem':`missing key ${key}`),key);
 }
 const tf=terraform();delete tf.terraform;denied(tf,/missing key terraform/);
 denied(null,/expected an object/);
 denied([],/expected an object/);
});

test('ecosystems cannot borrow each other\'s keys',()=>{
 const tf=terraform();tf.scripts=npm().scripts;denied(tf,/unknown key scripts/);
 const n=npm();n.terraform=terraform().terraform;denied(n,/unknown key terraform/);
 const runtime=npm();runtime.runtime={opentofu:'1.10.6'};denied(runtime,/unknown key opentofu|missing key node/);
 const tfImage=terraform();tfImage.image={dockerfile:'Dockerfile',context:'.'};denied(tfImage,/build no image/);
});

test('paths are normalized, relative and never climb out',()=>{
 for(const bad of ['../dist','dist/../..','/dist','./dist','dist/','dist//x','dist\\x','.','..','dist/./x','',' dist','d'.repeat(201)]){
  const c=npm();c.build.outputDirectory=bad;denied(c,/build\.outputDirectory/,JSON.stringify(bad));
 }
 for(const bad of ['..','../app','/app','./app','app/']){const c=npm();c.workingDirectory=bad;denied(c,/workingDirectory/,bad);}
 const ok=npm();ok.workingDirectory='apps/web';validatePipelineConfig(ok);
 const summary=npm();summary.coverage.summary='coverage/lcov.info';denied(summary,/json-summary/);
 const manifest=npm();manifest.targets.applicationManifest='../deployment/application.json';denied(manifest,/applicationManifest/);
 const stack=terraform();stack.targets.stacks=['environments/../../etc'];denied(stack,/targets\.stacks/);
 const image=npm();image.image={dockerfile:'../Dockerfile',context:'.'};denied(image,/image\.dockerfile/);
});

test('commands are npm script names, never shell strings',()=>{
 for(const bad of ['lint && curl x','lint;rm','$(id)','Lint','-lint','lint test','',42,'x'.repeat(65)]){
  const c=npm();c.scripts.lint=bad;denied(c,/scripts\.lint/,String(bad));
 }
 for(const bad of [['esbuild;id'],['ESBUILD'],['a','a'],Array.from({length:17},(_,i)=>`p${i}`),'esbuild']){
  const c=npm();c.rebuild=bad;denied(c,/rebuild/,JSON.stringify(bad));
 }
 const scoped=npm();scoped.rebuild=['@cloudflare/workerd-linux-64','esbuild'];validatePipelineConfig(scoped);
});

test('runtimes are exact versions',()=>{
 for(const bad of ['24','24.x','v24.10.0','24.10','18.20.0','24.10.0-rc.1',24]){const c=npm();c.runtime.node=bad;denied(c,/runtime\.node/,String(bad));}
 for(const bad of ['1.10','latest','~1.10.6']){const c=terraform();c.runtime.opentofu=bad;denied(c,/runtime\.opentofu/,bad);}
});

test('targets: deploy requires a release, ids are bounded and unique',()=>{
 const noRelease=npm();noRelease.targets={applicationManifest:null,deploy:['prosrus-worker']};denied(noRelease,/require targets\.applicationManifest/);
 const releaseOnly=npm();releaseOnly.targets={applicationManifest:null,deploy:[]};validatePipelineConfig(releaseOnly);
 for(const bad of [['Bad_Target'],['a','a'],Array.from({length:33},(_,i)=>`t${i}`)]){
  const c=npm();c.targets.deploy=bad;denied(c,/targets\.deploy/,JSON.stringify(bad));
 }
 const stacks=terraform();stacks.targets.stacks=[];denied(stacks,/targets\.stacks/);
 const apply=terraform();apply.terraform.apply='terraform.destroy';denied(apply,/terraform\.apply/);
 const plan=terraform();plan.terraform.plan='root.apply';denied(plan,/terraform\.plan/);
 const root=terraform();root.terraform.apply='root.apply';validatePipelineConfig(root);
});

test('outputs: flat strings, profile threshold, release and deploy derived from targets',()=>{
 const out=configOutputs(validatePipelineConfig(example('personal-control')));
 for(const [key,value] of Object.entries(out))assert.equal(typeof value,'string',key);
 assert.equal(out.coverage_min,String(COVERAGE_THRESHOLDS['ci-baseline']));
 assert.equal(out.rebuild,'esbuild workerd');
 assert.equal(out.release,'true');
 assert.equal(out.deploy_targets,'["personal-control"]');
 assert.equal(out.image,'false');
 const strict=npm();strict.policyProfile='strict';assert.equal(configOutputs(strict).coverage_min,'90');
 const tf=configOutputs(terraform());
 assert.equal(tf.ecosystem,'terraform');assert.equal(tf.release,'false');assert.equal(tf.deploy_targets,'[]');
 assert.equal(tf.terraform_apply,'terraform.apply');assert.equal(tf.node_version,'');
 assert.equal(JSON.parse(tf.stacks).length,5);
});

test('an image recipe validates but fails closed until the image stage exists',()=>{
 const c=npm();c.image={dockerfile:'Dockerfile',context:'.'};
 validatePipelineConfig(c);
 assert.throws(()=>assertWired(c),/no image build and attest action/);
 assert.equal(assertWired(npm()).image,null);
});

test('loading: duplicate keys, oversize, symlinks and missing files are refused',()=>{
 const root=scratch();
 const text=readFileSync(new URL('prosrus/pipeline.json',EXAMPLES),'utf8');
 writeFileSync(join(root,'pipeline.json'),text);
 assert.equal(loadPipelineConfig(root).ecosystem,'npm');
 writeFileSync(join(root,'dup.json'),text.replace('"ecosystem": "npm",','"ecosystem": "npm", "ecosystem": "terraform",'));
 assert.throws(()=>loadPipelineConfig(root,'dup.json'),/duplicate key/);
 writeFileSync(join(root,'big.json'),' '.repeat(MAX_CONFIG_BYTES+1));
 assert.throws(()=>loadPipelineConfig(root,'big.json'),/exceeds/);
 symlinkSync(join(root,'pipeline.json'),join(root,'link.json'));
 assert.throws(()=>loadPipelineConfig(root,'link.json'),/symlink/);
 assert.throws(()=>loadPipelineConfig(root,'../pipeline.json'),/normalized relative path/);
 assert.throws(()=>loadPipelineConfig(root,'absent.json'),/ENOENT/);
});

test('CLI writes validated outputs to the given GITHUB_OUTPUT file only',async()=>{
 const root=scratch();
 writeFileSync(join(root,'pipeline.json'),readFileSync(new URL('infra/pipeline.json',EXAMPLES),'utf8'));
 mkdirSync(join(root,'out'));
 const output=join(root,'out','github-output');
 await main(['--app-root',root,'--github-output',output]);
 const lines=readFileSync(output,'utf8').trimEnd().split('\n');
 assert.ok(lines.includes('ecosystem=terraform'));
 assert.ok(lines.includes('terraform_plan=terraform.plan'));
 assert.ok(lines.every(l=>/^[a-z][a-z0-9_]*=[^\r\n]*$/.test(l)));
 await assert.rejects(main(['--app-root',root,'--config','pipeline.json','--unknown','x']),/Unknown argument/);
});
