// Pure semantic-version computation from Conventional Commits since the last tag.
import {RELEASE_TAG} from '../../src/shared/release-contract.mjs';

export function parseTag(tag){
 const m=typeof tag==='string'&&RELEASE_TAG.exec(tag);
 return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null;
}
const compare=(a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2];

// Highest strict vMAJOR.MINOR.PATCH tag; anything else (rc, v01.2.3, foo) is ignored.
export function latestTag(tags){
 let best=null;
 for(const tag of tags){const v=parseTag(tag);if(v&&(!best||compare(v,best.v)>0))best={tag,v};}
 return best?best.tag:null;
}

const HEADER=/^(?<type>[A-Za-z]+)(?:\([^()\r\n]{1,64}\))?(?<bang>!)?: \S/;
const RANK={patch:1,minor:2,major:3};
export function classifyCommit({subject,body=''}){
 if(typeof subject!=='string'||typeof body!=='string')throw Error('Commit subject and body must be strings');
 const header=HEADER.exec(subject);
 if(!header)return null;
 if(header.groups.bang||/^BREAKING[ -]CHANGE: /m.test(body))return 'major';
 const type=header.groups.type.toLowerCase();
 if(type==='feat')return 'minor';
 if(type==='fix'||type==='perf')return 'patch';
 return null;
}

// Without a previous tag the base is v0.0.0, so the first feat yields v0.1.0.
export function nextVersion(lastTag,commits){
 if(lastTag!==null&&!parseTag(lastTag))throw Error('Last tag must be vMAJOR.MINOR.PATCH or null');
 if(!Array.isArray(commits))throw Error('Commits must be an array');
 let bump=null;
 for(const commit of commits){const kind=classifyCommit(commit);if(kind&&(!bump||RANK[kind]>RANK[bump]))bump=kind;}
 if(!bump)return {released:false,version:null,bump:null};
 const [major,minor,patch]=lastTag?parseTag(lastTag):[0,0,0];
 const next=bump==='major'?[major+1,0,0]:bump==='minor'?[major,minor+1,0]:[major,minor,patch+1];
 const version=`v${next.join('.')}`;
 if(!parseTag(version))throw Error('Computed version is out of bounds');
 return {released:true,version,bump};
}
