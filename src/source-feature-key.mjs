// PROPOSAL ONLY: integrate inside independently accepted producer policy, never as a grant issuer.
import {createHash} from 'node:crypto';
const need=(ok)=>{if(!ok)throw Error('central-signer-authority-unavailable');};
function canonical(v){if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);if(Number.isSafeInteger(v))return String(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';need(v&&Object.getPrototypeOf(v)===Object.prototype);return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
const hash=v=>createHash('sha256').update(v).digest('hex');
export async function resolveCurrentSigningKey({acceptedAuthority,signingKeys,repositoryID,repository}){
 need(acceptedAuthority?.schema==='signing-control-key-authority/v1'&&acceptedAuthority.service==='signing-control'&&acceptedAuthority.entrypoint==='SigningKeys'&&acceptedAuthority.githubAccountID===215839550);
 // signingKeys is the operator-installed private binding, not a caller-selected object or URL.
 need(Number.isSafeInteger(repositoryID)&&repositoryID>0&&/^susanbeasles\/[A-Za-z0-9_.-]+$/.test(repository));
 const config=await signingKeys.configuration({repositoryID}),active=await signingKeys.active({});
 need(config?.service?.schema==='signing-control-service/v1'&&config.service.repositoryID===repositoryID&&config.service.repository===repository);
 const runtime=config.runtime;
 need(runtime?.schema==='signing-control-generated-key/v1'&&Number.isSafeInteger(runtime.version)&&runtime.version>0&&active?.state==='active'&&active.version===runtime.version&&active.keyID===runtime.keyID&&active.publicKey===runtime.publicKey&&Number.isSafeInteger(active.githubKeyID)&&active.githubKeyID>0);
 need(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(runtime.publicKey));const blob=Buffer.from(runtime.publicKey.split(' ')[1],'base64');
 need(blob.length===51&&blob.readUInt32BE(0)===11&&blob.subarray(4,15).toString()==='ssh-ed25519'&&blob.readUInt32BE(15)===32&&blob.toString('base64')===runtime.publicKey.split(' ')[1]);
 const keyID='SHA256:'+createHash('sha256').update(blob).digest('base64').replace(/=+$/,'');
 need(runtime.keyID===keyID&&config.service.signer?.keyID===keyID&&config.configDigest===hash(canonical({service:config.service,runtime})));
 return {signerKeyID:keyID,signerVersion:runtime.version,signerConfigDigest:config.configDigest,signerAuthorityDigest:hash(canonical(acceptedAuthority))};
}
export function assertGrantSigningKey({request,grant,current}){
 need(request?.signerKeyID===current?.signerKeyID&&grant?.signerKeyID===current.signerKeyID&&grant.requestDigest===hash(canonical(request)));
 // Existing producer identity, one-use grant, nonce, parent/ref, expiry, policy digest and revoke checks remain mandatory.
}
