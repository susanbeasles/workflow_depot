import test from 'node:test';
import assert from 'node:assert/strict';
import {signRequest,signingKey,canonicalUri,canonicalQuery,canonicalHeaders,sha256Hex,amzDateOf} from '../ci/release/sigv4.mjs';

// AWS SigV4 test suite vector "get-vanilla"
// (https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html and the
// aws-sig-v4-test-suite). The canonical request and string-to-sign are key-independent
// and asserted verbatim below. The suite's example secret is deliberately NOT embedded
// in this repository (CI secret scanning runs on every change); the full-signature
// checks use a clearly fake key whose expected values were computed independently
// with Python's hmac/hashlib, not with this implementation.
const AWS_GET_VANILLA={
 canonicalRequest:'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 stringToSign:'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
};
const FAKE={accessKeyId:'NOTAREALKEYID0000000',secretAccessKey:'not-a-secret-not-a-secret'};

test('AWS get-vanilla canonical request and string-to-sign match the published vector',()=>{
 const signed=signRequest({method:'GET',url:'https://example.amazonaws.com/',headers:{},payloadHash:sha256Hex(''),...FAKE,region:'us-east-1',service:'service',amzDate:'20150830T123600Z'});
 assert.equal(signed.canonicalRequest,AWS_GET_VANILLA.canonicalRequest);
 assert.equal(signed.stringToSign,AWS_GET_VANILLA.stringToSign);
 assert.equal(sha256Hex(signed.canonicalRequest),AWS_GET_VANILLA.stringToSign.split('\n')[3]);
});

test('signing key derivation and full R2 PUT signature match independent computation',()=>{
 assert.equal(signingKey(FAKE.secretAccessKey,'20261015','auto','s3').toString('hex'),'6a16c6ea43d3e20edcc4b5a4602660d83b947486300cdf25fa5b8d978678d029');
 const payloadHash=sha256Hex('{}');
 assert.equal(payloadHash,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
 const signed=signRequest({method:'PUT',url:'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/releases-r2/demoapp/v1.2.3/release.meta.json',
  headers:{'Content-Type':'application/json','if-none-match':'*','x-amz-content-sha256':payloadHash},payloadHash,...FAKE,region:'auto',service:'s3',amzDate:'20261015T120000Z'});
 assert.equal(sha256Hex(signed.canonicalRequest),'df5595109c508b3bcb1e58c271688522fc9d1b10394cac1180f9d82ac3679a3f');
 assert.equal(signed.signature,'21a9a5fc43b711516ea441045481883c2b1cb7fc289818b985aa04d9560e07e5');
 assert.equal(signed.headers.authorization,`AWS4-HMAC-SHA256 Credential=${FAKE.accessKeyId}/20261015/auto/s3/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=${signed.signature}`);
 assert.equal(signed.headers['if-none-match'],'*');
 assert.ok(!JSON.stringify(signed).includes(FAKE.secretAccessKey));
});

test('canonicalization helpers follow SigV4 encoding rules',()=>{
 assert.equal(canonicalUri('/bucket/a%20b/c~d'),'/bucket/a%20b/c~d');
 assert.equal(canonicalUri('/bucket/it\'s(1)*'),'/bucket/it%27s%281%29%2A');
 assert.equal(canonicalUri('/'),'/');
 assert.throws(()=>canonicalUri('/bad%zz'),/percent-encoding/);
 assert.equal(canonicalQuery(new URLSearchParams('prefix=x/y&list-type=2')),'list-type=2&prefix=x%2Fy');
 assert.deepEqual(canonicalHeaders({'X-Amz-Date':'20261015T120000Z',Host:'  example.invalid  ','X-Spaces':'a   b'}),{text:'host:example.invalid\nx-amz-date:20261015T120000Z\nx-spaces:a b\n',signed:'host;x-amz-date;x-spaces'});
 assert.throws(()=>canonicalHeaders({a:'1',A:'2'}),/Duplicate/);
 assert.equal(amzDateOf(new Date('2026-10-15T12:00:00.123Z')),'20261015T120000Z');
 assert.throws(()=>signRequest({method:'GET',url:'https://example.invalid/',headers:{},payloadHash:'x',...FAKE,region:'auto',service:'s3',amzDate:'20261015T120000Z'}),/payloadHash/);
 assert.throws(()=>signRequest({method:'GET',url:'https://example.invalid/',headers:{},payloadHash:sha256Hex(''),accessKeyId:'',secretAccessKey:'',region:'auto',service:'s3',amzDate:'20261015T120000Z'}),/credentials/);
});
