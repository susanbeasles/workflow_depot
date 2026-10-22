// Builds a promotion-request/v1 and POSTs it once to the admission Worker with a
// GitHub Actions OIDC bearer token. Admission URL and audience come from workflow
// inputs must match reviewed immutable depot-source enrollment before token issuance.
// Enrollment is empty until actual owner-approved endpoint identities are commissioned.
// Only the HTTP status and requestId are printed; the token never leaves this process.
import {requirePromotionEnrollment,promotionEnrollments} from '../trusted-admission.mjs';
import {randomBytes,createHash} from 'node:crypto';
import {LIMITS,SCHEMAS,BUCKET,ENVIRONMENT,parseJson,isCanonicalBytes,canonical,formatTimestamp,releaseManifestUri,validateReleaseManifest,validatePromotionRequest} from '../../src/shared/release-contract.mjs';
import {parseArgs,isMain,runCli,readRegularFile,writeOnce} from './io.mjs';

export function uuidv7(nowMillis=Date.now(),random=randomBytes(10)){
 if(!Number.isSafeInteger(nowMillis)||nowMillis<0||nowMillis>=2**48||random.length!==10)throw Error('Invalid UUIDv7 input');
 const bytes=new Uint8Array(16);
 for(let i=0;i<6;i++)bytes[i]=Math.floor(nowMillis/2**(8*(5-i)))&0xff;
 bytes.set(random,6);
 bytes[6]=0x70|(bytes[6]&0x0f);bytes[8]=0x80|(bytes[8]&0x3f);
 const h=Buffer.from(bytes).toString('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function validateHttpsUrl(value,label){
 let url;
 try{url=new URL(value);}catch{throw Error(`${label} is not a valid URL`);}
 if(url.protocol!=='https:')throw Error(`${label} must use https`);
 if(url.username||url.password||url.hash||!url.hostname||value.length>2048)throw Error(`${label} must not carry credentials or fragments`);
 return url;
}

export function buildPromotionRequest({manifest,manifestSha256,environment,bucket,expectedCurrentGeneration,githubDeploymentId,requestedAt,requestId}){
 validateReleaseManifest(manifest);
 if(!ENVIRONMENT.test(environment||''))throw Error('Invalid environment');
 if(!BUCKET.test(bucket||''))throw Error('Invalid release bucket');
 return validatePromotionRequest({schema:SCHEMAS.promotion,requestId,application:manifest.application,environment,repository:manifest.repository,releaseTag:manifest.releaseTag,
  releaseManifestUri:releaseManifestUri(bucket,manifest.application,manifest.releaseTag),releaseManifestSha256:manifestSha256,expectedCurrentGeneration,githubDeploymentId,requestedAt});
}

export async function requestOidcToken({env,audience,fetch:fetcher=globalThis.fetch,timeoutMs=15000,target,enrollments=promotionEnrollments}){
 requirePromotionEnrollment({...target,audience},enrollments);
 if(!/^[A-Za-z0-9_.:\/-]{1,256}$/.test(audience||''))throw Error('Invalid OIDC audience');
 if(!env.ACTIONS_ID_TOKEN_REQUEST_URL||!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw Error('OIDC is unavailable; the calling job needs permissions: id-token: write');
 const url=validateHttpsUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL,'OIDC request URL');
 if(!url.hostname.endsWith('.actions.githubusercontent.com')||url.port)throw Error('Untrusted Actions OIDC runtime host');
 url.searchParams.set('audience',audience);
 const response=await fetcher(url.href,{headers:{authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 if(response.status!==200)throw Error(`OIDC token request failed with HTTP ${response.status}`);
 const text=await response.text();
 if(text.length>32768)throw Error('OIDC token response too large');
 const token=JSON.parse(text)?.value;
 if(typeof token!=='string'||token.length>20000||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw Error('OIDC token response malformed');
 return token;
}

// Exactly one POST. A failed or ambiguous submission is reported, never retried:
// admission deduplicates by requestId, and a new attempt must be a new decision.
export async function submitPromotion({url,token,request,fetch:fetcher=globalThis.fetch,timeoutMs=30000,audience,enrollments=promotionEnrollments}){
 const target=validateHttpsUrl(url,'admission URL');
 validatePromotionRequest(request);
 requirePromotionEnrollment({url,audience,repository:request.repository,application:request.application,environment:request.environment},enrollments);
 const response=await fetcher(target.href,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},body:canonical(request),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 await response.body?.cancel?.();
 return {status:response.status,ok:response.status>=200&&response.status<300};
}

export async function main(argv,env){
 const args=parseArgs(argv,{'admission-url':{required:true},audience:{required:true},manifest:{required:true},environment:{required:true},bucket:{required:true},'expected-generation':{required:true,pattern:/^(?:0|[1-9]\d{0,15})$/},'github-deployment-id':{required:true,pattern:/^[1-9]\d{0,15}$/},out:{}});
 validateHttpsUrl(args['admission-url'],'admission URL');
 const bytes=readRegularFile(args.manifest,LIMITS.jsonBytes,'release.meta.json');
 const manifest=validateReleaseManifest(parseJson(bytes,{label:'release.meta.json'}));
 if(!isCanonicalBytes(bytes,manifest))throw Error('release.meta.json is not canonical JSON');
 const request=buildPromotionRequest({manifest,manifestSha256:createHash('sha256').update(bytes).digest('hex'),environment:args.environment,bucket:args.bucket,
  expectedCurrentGeneration:Number(args['expected-generation']),githubDeploymentId:Number(args['github-deployment-id']),requestedAt:formatTimestamp(Date.now()),requestId:uuidv7()});
 if(args.out)writeOnce(args.out,new TextEncoder().encode(canonical(request)));
 const target={url:args['admission-url'],repository:manifest.repository,application:manifest.application,environment:args.environment};
 requirePromotionEnrollment({...target,audience:args.audience});
 const token=await requestOidcToken({env,audience:args.audience,target});
 const result=await submitPromotion({url:args['admission-url'],audience:args.audience,token,request});
 process.stdout.write(`status=${result.status} requestId=${request.requestId}\n`);
 if(!result.ok)throw Error(`admission rejected or failed (HTTP ${result.status}); not retried`);
}
if(isMain(import.meta.url))runCli(main);
