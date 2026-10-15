// Loads deployment/application.json from the application checkout, validates it and
// binds it to the release context (repository name and numeric id must match).
import {ADAPTERS,LIMITS,validateApplication,validateReleaseContext} from '../../src/shared/release-contract.mjs';
import {parseArgs,isMain,runCli,writeCanonical,writeGithubOutput,resolveInside,readJsonFile} from './io.mjs';

export function readApplication(appRoot,manifestPath,context){
 const application=validateApplication(readJsonFile(resolveInside(appRoot,manifestPath,'application manifest'),256*1024,'application manifest'));
 if(context){
  validateReleaseContext(context);
  if(application.repository!==context.repository||application.repositoryId!==context.repositoryId)throw Error('Application manifest repository does not match the calling repository');
 }
 return application;
}
export const loadApplication=path=>validateApplication(readJsonFile(path,LIMITS.jsonBytes,'application'));
export const loadContext=path=>validateReleaseContext(readJsonFile(path,LIMITS.jsonBytes,'release context'));
export const targetOf=(application,id,adapter)=>{
 const target=application.targets.find(t=>t.id===id);
 if(!target||target.adapter!==adapter)throw Error(`No ${adapter} target named ${JSON.stringify(id)}`);
 return target;
};

export async function main(argv){
 const args=parseArgs(argv,{'app-root':{required:true},manifest:{default:'deployment/application.json'},context:{required:true},out:{required:true},'github-output':{}});
 const application=readApplication(args['app-root'],args.manifest,loadContext(args.context));
 writeCanonical(args.out,application);
 const idOf=adapter=>application.targets.find(t=>t.adapter===adapter)?.id||'';
 writeGithubOutput(args['github-output'],{application:application.application,worker_target:idOf(ADAPTERS.worker),migrations_target:idOf(ADAPTERS.d1)});
 process.stdout.write(`application ${application.application}: ${application.targets.map(t=>t.id).join(', ')}\n`);
}
if(isMain(import.meta.url))runCli(main);
