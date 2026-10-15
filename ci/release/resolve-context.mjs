// Binds the release to the caller's GitHub context. A reusable workflow sees the
// caller's github.* context, so these values identify the application repository.
import {RELEASE_TAG,SCHEMAS,validateReleaseContext} from '../../src/shared/release-contract.mjs';
import {parseArgs,isMain,runCli,writeCanonical,writeGithubOutput} from './io.mjs';

export function resolveContext(env,releaseTag){
 if(env.GITHUB_EVENT_NAME!=='push')throw Error('Releases run only on push events');
 if(!RELEASE_TAG.test(releaseTag||''))throw Error('Release tag must be vMAJOR.MINOR.PATCH');
 const ref=env.GITHUB_REF||'';
 if(ref.startsWith('refs/tags/')){if(ref!==`refs/tags/${releaseTag}`)throw Error('Release tag does not match the pushed tag');}
 else if(ref!=='refs/heads/main')throw Error('Releases run only for refs/heads/main or vMAJOR.MINOR.PATCH tags');
 const repositoryId=/^[1-9]\d{0,15}$/.test(env.GITHUB_REPOSITORY_ID||'')?Number(env.GITHUB_REPOSITORY_ID):NaN;
 return validateReleaseContext({schema:SCHEMAS.context,repository:env.GITHUB_REPOSITORY,repositoryId,sourceCommit:env.GITHUB_SHA,ref,releaseTag,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT});
}

export async function main(argv,env){
 const args=parseArgs(argv,{'release-tag':{required:true},out:{required:true},'github-output':{}});
 const context=resolveContext(env,args['release-tag']);
 writeCanonical(args.out,context);
 writeGithubOutput(args['github-output'],{release_tag:context.releaseTag,source_commit:context.sourceCommit});
 process.stdout.write(`release context ${context.repository}@${context.sourceCommit} ${context.releaseTag}\n`);
}
if(isMain(import.meta.url))runCli(main);
