// pipeline.json (`workflow-depot-pipeline/v1`): the per-repository input to .github/workflows/pipeline.yml.
// Strict: unknown keys are rejected, every value is bounded, paths are normalized repository-relative paths
// with no `.` or `..` segment. Commands are npm script names, never shell strings. Contract: docs/contracts.md
// section 12; stage map: docs/pipeline.md.
//
//   node ci/pipeline-config.mjs --app-root <checkout> [--config pipeline.json] [--github-output "$GITHUB_OUTPUT"]
import {ContractError,isRelativePath,NPM_SCRIPT,TARGET_ID} from '../src/shared/release-contract.mjs';
import {parseArgs,isMain,runCli,resolveInside,readJsonFile,writeGithubOutput} from './release/io.mjs';

export const SCHEMA='workflow-depot-pipeline/v1';
export const MAX_CONFIG_BYTES=64*1024;
export const ECOSYSTEMS=Object.freeze(['npm','terraform']);
// Stage 1 pass criterion: total line coverage at or above the profile threshold. Profile names are the
// security-assurance profiles (security-assurance/policy/release-policy.yml), so one name selects both.
export const COVERAGE_THRESHOLDS=Object.freeze({'ci-baseline':80,strict:90});
// Stage 4 and 7 replacements for infra and infra-root (CONTROL-PLANE-SPEC 5.6): runner job types.
export const TERRAFORM_PLAN=Object.freeze(['terraform.plan']);
export const TERRAFORM_APPLY=Object.freeze(['terraform.apply','root.apply']);

const NODE_VERSION=/^(2[0-9]|[3-9][0-9])\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;
const TOFU_VERSION=/^(0|[1-9][0-9]?)\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;
const NPM_PACKAGE=/^(?:@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9][a-z0-9._~-]{0,100}$/;
const LIMITS=Object.freeze({path:200,rebuild:16,deploy:32,stacks:32});

const deny=message=>{throw new ContractError(message);};
const req=(condition,message)=>{if(!condition)deny(message);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function keys(value,required,optional,label){
 req(object(value),`${label}: expected an object`);
 for(const key of required)req(Object.hasOwn(value,key),`${label}: missing key ${key}`);
 for(const key of Object.keys(value))req(required.includes(key)||optional.includes(key),`${label}: unknown key ${key}`);
}
const oneOf=(value,allowed,label)=>req(typeof value==='string'&&allowed.includes(value),`${label}: expected one of ${allowed.join(', ')}`);
const path=(value,label)=>req(isRelativePath(value,{max:LIMITS.path}),`${label}: expected a normalized relative path without . or .. segments`);
const directory=(value,label)=>{if(value!=='.')path(value,label);};
function list(value,pattern,{min=0,max},label){
 req(Array.isArray(value)&&value.length>=min&&value.length<=max,`${label}: expected ${min}..${max} entries`);
 for(const item of value)req(typeof item==='string'&&pattern(item),`${label}: invalid entry`);
 req(new Set(value).size===value.length,`${label}: duplicate entry`);
}

function validateImage(image){
 if(image===null)return;
 keys(image,['dockerfile','context'],[],'image');
 path(image.dockerfile,'image.dockerfile');
 directory(image.context,'image.context');
}

function validateNpm(c){
 keys(c.runtime,['node'],[],'runtime');
 req(typeof c.runtime.node==='string'&&NODE_VERSION.test(c.runtime.node),'runtime.node: expected an exact MAJOR.MINOR.PATCH Node.js version, 20 or later');
 keys(c.scripts,['lint','typecheck','test','build'],[],'scripts');
 for(const name of ['lint','typecheck','test','build'])req(typeof c.scripts[name]==='string'&&NPM_SCRIPT.test(c.scripts[name]),`scripts.${name}: expected an npm script name`);
 if(Object.hasOwn(c,'rebuild'))list(c.rebuild,v=>NPM_PACKAGE.test(v),{max:LIMITS.rebuild},'rebuild');
 keys(c.coverage,['summary'],[],'coverage');
 path(c.coverage.summary,'coverage.summary');
 req(c.coverage.summary.endsWith('.json'),'coverage.summary: expected an Istanbul json-summary file (.json)');
 keys(c.build,['outputDirectory'],[],'build');
 path(c.build.outputDirectory,'build.outputDirectory');
 keys(c.targets,['applicationManifest','deploy'],['application','environment'],'targets');
 if(c.targets.applicationManifest!==null){
  path(c.targets.applicationManifest,'targets.applicationManifest');
  req(c.targets.applicationManifest.endsWith('.json'),'targets.applicationManifest: expected a .json file');
 }
 list(c.targets.deploy,v=>TARGET_ID.test(v),{max:LIMITS.deploy},'targets.deploy');
 req(c.targets.deploy.length===0||c.targets.applicationManifest!==null,'targets.deploy: deploy targets require targets.applicationManifest (stage 7 runs only after a stage 6 release)');
 if(c.targets.deploy.length>0){
  req(typeof c.targets.application==='string'&&/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(c.targets.application),'targets.application: deploy targets require an explicit application identity');
  req(typeof c.targets.environment==='string'&&/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(c.targets.environment),'targets.environment: deploy targets require an explicit environment identity');
 }else{
  req(!Object.hasOwn(c.targets,'application')&&!Object.hasOwn(c.targets,'environment'),'targets: application and environment require deploy targets');
 }
}

function validateTerraform(c){
 keys(c.runtime,['opentofu'],[],'runtime');
 req(typeof c.runtime.opentofu==='string'&&TOFU_VERSION.test(c.runtime.opentofu),'runtime.opentofu: expected an exact MAJOR.MINOR.PATCH OpenTofu version');
 keys(c.terraform,['plan','apply'],[],'terraform');
 oneOf(c.terraform.plan,TERRAFORM_PLAN,'terraform.plan');
 oneOf(c.terraform.apply,TERRAFORM_APPLY,'terraform.apply');
 keys(c.targets,['stacks'],[],'targets');
 list(c.targets.stacks,v=>isRelativePath(v,{max:LIMITS.path}),{min:1,max:LIMITS.stacks},'targets.stacks');
 req(c.image===null,'image: terraform repositories build no image');
}

/** Validates a parsed pipeline.json and returns it unchanged. Throws ContractError on the first violation. */
export function validatePipelineConfig(c){
 req(object(c),'pipeline.json: expected an object');
 req(c.schema===SCHEMA,`schema: expected ${SCHEMA}`);
 oneOf(c.ecosystem,ECOSYSTEMS,'ecosystem');
 const common=['schema','ecosystem','policyProfile','workingDirectory','runtime','image','targets'];
 if(c.ecosystem==='npm')keys(c,[...common,'scripts','coverage','build'],['rebuild'],'pipeline.json');
 else keys(c,[...common,'terraform'],[],'pipeline.json');
 oneOf(c.policyProfile,Object.keys(COVERAGE_THRESHOLDS),'policyProfile');
 directory(c.workingDirectory,'workingDirectory');
 validateImage(c.image);
 if(c.ecosystem==='npm')validateNpm(c);else validateTerraform(c);
 return c;
}

/** Flat string outputs for the pipeline's config job. Every value is already validated: no newlines, no shell metacharacters. */
export function configOutputs(c){
 const npm=c.ecosystem==='npm';
 return {
  ecosystem:c.ecosystem,
  policy_profile:c.policyProfile,
  working_directory:c.workingDirectory,
  node_version:npm?c.runtime.node:'',
  opentofu_version:npm?'':c.runtime.opentofu,
  script_lint:npm?c.scripts.lint:'',
  script_typecheck:npm?c.scripts.typecheck:'',
  script_test:npm?c.scripts.test:'',
  script_build:npm?c.scripts.build:'',
  rebuild:npm?(c.rebuild??[]).join(' '):'',
  coverage_summary:npm?c.coverage.summary:'',
  coverage_min:npm?String(COVERAGE_THRESHOLDS[c.policyProfile]):'',
  output_directory:npm?c.build.outputDirectory:'',
  image:String(c.image!==null),
  release:String(npm&&c.targets.applicationManifest!==null),
  application_manifest:npm&&c.targets.applicationManifest!==null?c.targets.applicationManifest:'',
  deploy_targets:JSON.stringify(npm?c.targets.deploy:[]),
  deploy_application:npm?(c.targets.application??''):'',
  deploy_environment:npm?(c.targets.environment??''):'',
  terraform_plan:npm?'':c.terraform.plan,
  terraform_apply:npm?'':c.terraform.apply,
  stacks:JSON.stringify(npm?[]:c.targets.stacks),
 };
}

/** Parts of the contract that validate but have no stage behind them yet. Fails closed instead of skipping. */
export function assertWired(c){
 if(c.image!==null)deny('image: an image recipe is declared, but workflow_depot has no image build and attest action yet (CONTROL-PLANE-SPEC Phase 3); remove it until that action exists');
 return c;
}

export function loadPipelineConfig(appRoot,configPath='pipeline.json'){
 return validatePipelineConfig(readJsonFile(resolveInside(appRoot,configPath,'pipeline config'),MAX_CONFIG_BYTES,'pipeline.json'));
}

export async function main(argv){
 const args=parseArgs(argv,{'app-root':{required:true},config:{default:'pipeline.json'},'github-output':{}});
 const config=assertWired(loadPipelineConfig(args['app-root'],args.config));
 const outputs=configOutputs(config);
 writeGithubOutput(args['github-output'],outputs);
 process.stdout.write(`${SCHEMA}: ${config.ecosystem}, profile ${config.policyProfile}, release ${outputs.release}, deploy ${outputs.deploy_targets}\n`);
}
if(isMain(import.meta.url))runCli(main);
