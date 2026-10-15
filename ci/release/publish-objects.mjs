// Optional write-once publication to R2 through its S3-compatible API. Every PUT
// carries `If-None-Match: *`, so an existing key is never overwritten (HTTP 412).
// release.meta.json is uploaded last: it is the commit point that makes the other
// objects reachable. Credentials come only from the environment and are never logged.
import {join} from 'node:path';
import {LIMITS,BUCKET,parseJson,validateReleaseManifest} from '../../src/shared/release-contract.mjs';
import {sha256Hex,signRequest,amzDateOf} from './sigv4.mjs';
import {parseArgs,isMain,runCli,readRegularFile} from './io.mjs';

export const OBJECT_ORDER=['release.zip','release.zip.sigstore.json','release.zip.intoto.jsonl','sbom.cdx.json','sbom.spdx.json',
 'checksums.json','SHA256SUMS','authorization-policy.json','release.meta.json.sigstore.json','release.meta.json'];
const CONTENT_TYPES={zip:'application/zip',json:'application/json',jsonl:'application/jsonl'};
const contentTypeOf=name=>CONTENT_TYPES[name.split('.').at(-1)]||'text/plain; charset=utf-8';

export function credentialsFrom(env){
 const accessKeyId=env.R2_ACCESS_KEY_ID||'',secretAccessKey=env.R2_SECRET_ACCESS_KEY||'';
 if(!/^[A-Za-z0-9]{16,128}$/.test(accessKeyId)||!/^[A-Za-z0-9+/=_-]{16,256}$/.test(secretAccessKey))throw Error('R2 credentials missing or malformed in the environment');
 return {accessKeyId,secretAccessKey};
}

export async function publishObjects({releaseDir,accountId,bucket,credentials,fetch:fetcher=globalThis.fetch,now=()=>new Date(),timeoutMs=600000,log=()=>{}}){
 if(!/^[a-f0-9]{32}$/.test(accountId||''))throw Error('R2 account id must be 32 lowercase hex characters');
 if(!BUCKET.test(bucket||''))throw Error('Invalid R2 bucket name');
 const manifest=validateReleaseManifest(parseJson(readRegularFile(join(releaseDir,'release.meta.json'),LIMITS.jsonBytes,'release.meta.json'),{label:'release.meta.json'}));
 const prefix=`${manifest.application}/${manifest.releaseTag}/`;
 const objects=OBJECT_ORDER.map(name=>({name,data:readRegularFile(join(releaseDir,name),LIMITS.releaseBytes,name)}));
 if(sha256Hex(objects[0].data)!==manifest.artifact.sha256)throw Error('release.zip does not match release.meta.json');
 const published=[];
 for(const {name,data} of objects){
  const url=`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${prefix}${name}`;
  const payloadHash=sha256Hex(data);
  const signed=signRequest({method:'PUT',url,headers:{'content-type':contentTypeOf(name),'if-none-match':'*','x-amz-content-sha256':payloadHash},payloadHash,...credentials,region:'auto',service:'s3',amzDate:amzDateOf(now())});
  delete signed.headers.host;
  const response=await fetcher(url,{method:'PUT',headers:signed.headers,body:data,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  await response.body?.cancel?.();
  if(response.status===412)throw Error(`${prefix}${name} already exists; release objects are write-once`);
  if(response.status!==200)throw Error(`R2 PUT ${prefix}${name} failed with HTTP ${response.status}`);
  published.push(`${prefix}${name}`);log(`published r2://${bucket}/${prefix}${name}`);
 }
 return published;
}

export async function main(argv,env){
 const args=parseArgs(argv,{'release-dir':{required:true},'account-id':{required:true},bucket:{required:true}});
 await publishObjects({releaseDir:args['release-dir'],accountId:args['account-id'],bucket:args.bucket,credentials:credentialsFrom(env),log:line=>process.stdout.write(line+'\n')});
}
if(isMain(import.meta.url))runCli(main);
