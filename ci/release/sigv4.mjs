// AWS Signature Version 4 (header form) for S3-compatible R2 requests, using only
// node:crypto. Paths are encoded once (S3 semantics); no query parameters are used
// by the publisher, but canonical query encoding follows the spec for completeness.
import {createHash,createHmac} from 'node:crypto';

export const sha256Hex=data=>createHash('sha256').update(data).digest('hex');
const hmac=(key,data)=>createHmac('sha256',key).update(data,'utf8').digest();
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());

export function signingKey(secretAccessKey,date,region,service){
 return hmac(hmac(hmac(hmac('AWS4'+secretAccessKey,date),region),service),'aws4_request');
}
export const canonicalUri=path=>path.split('/').map(segment=>encode(decodeURIComponentStrict(segment))).join('/')||'/';
function decodeURIComponentStrict(segment){try{return decodeURIComponent(segment);}catch{throw Error('Invalid percent-encoding in request path');}}
export function canonicalQuery(searchParams){
 return [...searchParams].map(([k,v])=>[encode(k),encode(v)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0).map(([k,v])=>`${k}=${v}`).join('&');
}
export function canonicalHeaders(headers){
 const entries=Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v).trim().replace(/\s+/g,' ')]);
 if(new Set(entries.map(e=>e[0])).size!==entries.length)throw Error('Duplicate header');
 entries.sort((a,b)=>a[0]<b[0]?-1:1);
 return {text:entries.map(([k,v])=>`${k}:${v}\n`).join(''),signed:entries.map(e=>e[0]).join(';')};
}

export function signRequest({method,url,headers,payloadHash,accessKeyId,secretAccessKey,region,service,amzDate}){
 if(!/^\d{8}T\d{6}Z$/.test(amzDate||''))throw Error('amzDate must be YYYYMMDDTHHMMSSZ');
 if(!/^[a-f0-9]{64}$/.test(payloadHash||''))throw Error('payloadHash must be a sha256 hex digest');
 if(typeof accessKeyId!=='string'||!accessKeyId||typeof secretAccessKey!=='string'||!secretAccessKey)throw Error('Missing signing credentials');
 const target=new URL(url);
 const all={...headers,host:target.host,'x-amz-date':amzDate};
 const {text,signed}=canonicalHeaders(all);
 const canonicalRequest=[method,canonicalUri(target.pathname),canonicalQuery(target.searchParams),text,signed,payloadHash].join('\n');
 const date=amzDate.slice(0,8),scope=`${date}/${region}/${service}/aws4_request`;
 const stringToSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256Hex(canonicalRequest)].join('\n');
 const signature=createHmac('sha256',signingKey(secretAccessKey,date,region,service)).update(stringToSign,'utf8').digest('hex');
 return {
  headers:{...Object.fromEntries(Object.entries(all).map(([k,v])=>[k.toLowerCase(),String(v)])),authorization:`AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`},
  canonicalRequest,stringToSign,signature,
 };
}
export const amzDateOf=date=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
