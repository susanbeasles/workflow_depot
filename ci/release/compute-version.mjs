// Decides whether this push releases, and which tag it gets, from git history.
// main push: next version from Conventional Commits since the last vX.Y.Z tag.
// tag push:  the pushed vX.Y.Z tag, which must point at the exact commit.
import {spawnSync} from 'node:child_process';
import {RELEASE_TAG,SHA40} from '../../src/shared/release-contract.mjs';
import {latestTag,nextVersion} from './next-version.mjs';
import {parseArgs,isMain,runCli,writeCanonical,writeGithubOutput,realDirectory} from './io.mjs';

export function git(repo,args,{allowFailure=false}={}){
 const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8',shell:false,maxBuffer:64*1024*1024,env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:process.env.HOME||'/nonexistent',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});
 if(result.error)throw Error('git could not be started');
 if(result.status!==0){if(allowFailure)return null;throw Error(`git ${args[0]} failed`);}
 return result.stdout;
}
const commitOf=(repo,ref)=>{const out=git(repo,['rev-parse','--verify','--quiet','--end-of-options',`${ref}^{commit}`],{allowFailure:true});return out===null?null:out.trim();};

export function readCommits(repo,range){
 const raw=git(repo,['log','--format=%H%x1f%B%x1e','--end-of-options',range]);
 return raw.split('\x1e').map(r=>r.replace(/^\n/,'')).filter(Boolean).map(record=>{
  const [hash,message='']=record.split('\x1f');
  if(!SHA40.test(hash))throw Error('Unexpected git log output');
  const [subject='',...rest]=message.replace(/\n+$/,'').split('\n');
  return {hash,subject,body:rest.join('\n')};
 });
}

export function computeVersion({repo,sha,ref,event}){
 if(event!=='push')throw Error('Releases run only on push events');
 if(!SHA40.test(sha))throw Error('Invalid source commit');
 realDirectory(repo,'repository');
 if(commitOf(repo,sha)!==sha)throw Error('Source commit is not present in the checkout');
 if(ref.startsWith('refs/tags/')){
  const tag=ref.slice(10);
  if(!RELEASE_TAG.test(tag))throw Error('Tag refs must be vMAJOR.MINOR.PATCH');
  if(commitOf(repo,`refs/tags/${tag}`)!==sha)throw Error('Tag does not point at the source commit');
  return {schema:'release-version/v1',released:true,releaseTag:tag,mode:'tag',lastTag:null,bump:null};
 }
 if(ref!=='refs/heads/main')throw Error('Releases run only for refs/heads/main or vMAJOR.MINOR.PATCH tags');
 const tags=git(repo,['tag','--list','--merged',sha]).split('\n').filter(Boolean);
 const last=latestTag(tags);
 const result=nextVersion(last,readCommits(repo,last?`${last}..${sha}`:sha));
 if(result.released&&commitOf(repo,`refs/tags/${result.version}`)!==null)throw Error(`Tag ${result.version} already exists; releases are write-once`);
 return {schema:'release-version/v1',released:result.released,releaseTag:result.version,mode:'main',lastTag:last,bump:result.bump};
}

export async function main(argv,env){
 const args=parseArgs(argv,{repo:{required:true},out:{required:true},'github-output':{}});
 const result=computeVersion({repo:args.repo,sha:env.GITHUB_SHA||'',ref:env.GITHUB_REF||'',event:env.GITHUB_EVENT_NAME||''});
 writeCanonical(args.out,result);
 writeGithubOutput(args['github-output'],{released:String(result.released),release_tag:result.releaseTag||'',mode:result.mode});
 process.stdout.write(result.released?`release ${result.releaseTag} (${result.mode}${result.bump?`, ${result.bump}`:''})\n`:'no releasable commits since last tag; released=false\n');
}
if(isMain(import.meta.url))runCli(main);
