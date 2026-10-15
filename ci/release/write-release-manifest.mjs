// Writes release.meta.json (release-manifest/v2) beside release.zip. The file is
// canonical JSON, so sha256(file bytes) equals the canonical manifest digest.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {ADAPTERS,LIMITS,artifactPathFor,SCHEMAS,isTimestamp,formatTimestamp,releaseWorkflowRef,canonicalBytes,validateReleaseManifest} from '../../src/shared/release-contract.mjs';
import {loadChecksums} from './assemble-release.mjs';
import {loadApplication,loadContext} from './read-application.mjs';
import {parseArgs,isMain,runCli,writeOnce,writeGithubOutput,readRegularFile} from './io.mjs';

const hex=bytes=>createHash('sha256').update(bytes).digest('hex');

export function releaseManifest({releaseDir,application,context,depotRepository,depotSha,createdAt}){
 if(!isTimestamp(createdAt))throw Error('createdAt must be YYYY-MM-DDTHH:MM:SSZ');
 if(application.repository!==context.repository||application.repositoryId!==context.repositoryId)throw Error('Application manifest repository does not match the release context');
 const {checksums,bytes:checksumBytes}=loadChecksums(releaseDir);
 const release=readRegularFile(join(releaseDir,'release.zip'),LIMITS.releaseBytes,'release.zip');
 const policy=readRegularFile(join(releaseDir,'authorization-policy.json'),LIMITS.jsonBytes,'authorization-policy.json');
 if(hex(policy)!==checksums.files['authorization-policy.json'].sha256)throw Error('authorization-policy.json does not match checksums.json');
 const targets=application.targets.map(t=>{
  const artifactPath=artifactPathFor(t.id),entry=checksums.files[artifactPath];
  if(!entry)throw Error(`checksums.json has no entry for ${artifactPath}`);
  const data=readRegularFile(join(releaseDir,artifactPath),LIMITS.bundleBytes,artifactPath);
  if(hex(data)!==entry.sha256||data.length!==entry.sizeBytes)throw Error(`${artifactPath} does not match checksums.json`);
  return {id:t.id,adapter:t.adapter,artifactPath,sha256:entry.sha256,sizeBytes:entry.sizeBytes,dependsOn:t.dependsOn,
   ...(t.adapter===ADAPTERS.worker?{healthContract:t.healthContract}:{recoveryPolicy:t.recoveryPolicy})};
 });
 const bundles=Object.keys(checksums.files).filter(p=>p.startsWith('targets/'));
 if(bundles.length!==targets.length)throw Error('checksums.json lists bundles that are not application targets');
 return validateReleaseManifest({
  schema:SCHEMAS.manifest,application:application.application,repository:application.repository,repositoryId:application.repositoryId,
  releaseTag:context.releaseTag,sourceCommit:context.sourceCommit,createdAt,
  builder:{workflow:releaseWorkflowRef(depotRepository,depotSha),runId:context.runId,runAttempt:context.runAttempt},
  artifact:{path:'release.zip',sha256:hex(release),sizeBytes:release.length,mediaType:'application/zip'},
  targets,
  authorizationPolicy:{path:'authorization-policy.json',sha256:hex(policy)},
  checksums:{path:'checksums.json',sha256:hex(checksumBytes)},
 });
}

export async function main(argv){
 const args=parseArgs(argv,{'release-dir':{required:true},application:{required:true},context:{required:true},'depot-repository':{required:true},'depot-sha':{required:true},'created-at':{},'github-output':{}});
 const manifest=releaseManifest({releaseDir:args['release-dir'],application:loadApplication(args.application),context:loadContext(args.context),depotRepository:args['depot-repository'],depotSha:args['depot-sha'],createdAt:args['created-at']??formatTimestamp(Date.now())});
 const bytes=canonicalBytes(manifest);
 writeOnce(join(args['release-dir'],'release.meta.json'),bytes);
 const manifestSha256=hex(bytes);
 writeGithubOutput(args['github-output'],{manifest_sha256:manifestSha256,builder_workflow:manifest.builder.workflow});
 process.stdout.write(`release.meta.json sha256=${manifestSha256} builder=${manifest.builder.workflow}\n`);
}
if(isMain(import.meta.url))runCli(main);
