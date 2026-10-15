// Minimal deterministic ZIP writer and strict reader (no ZIP64, no extra fields,
// no comments, no data descriptors, no external attributes). The reader accepts
// only the canonical layout this writer emits, which rules out overlapping or
// ambiguous entries, symlink/permission flags and local/central disagreement.
import {deflateRawSync,inflateRawSync} from 'node:zlib';

const CRC_TABLE=new Uint32Array(256).map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes){
 let c=0xffffffff;
 for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&0xff]^(c>>>8);
 return (c^0xffffffff)>>>0;
}

export const ZIP_DEFAULTS=Object.freeze({maxEntries:20001,maxEntryBytes:256*1024*1024,maxTotalBytes:1024*1024*1024,maxRatio:100});
const DOS_DATE=(1<<5)|1; // 1980-01-01, the earliest DOS date; time 00:00:00
const METHOD={store:0,deflate:8};
const MAX32=0xffffffff;

export function validateEntryName(name){
 if(typeof name!=='string'||name.length<1||name.length>1024)throw Error('ZIP entry name length out of bounds');
 if(!/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(name))throw Error(`ZIP entry name not allowed: ${JSON.stringify(name)}`);
 if(name.split('/').some(s=>s==='.'||s==='..'))throw Error(`ZIP entry name traverses: ${JSON.stringify(name)}`);
 return name;
}
function uniqueNames(names){
 const exact=new Set(),folded=new Set();
 for(const name of names){
  if(exact.has(name))throw Error(`Duplicate ZIP entry: ${name}`);
  if(folded.has(name.toLowerCase()))throw Error(`Case-insensitive duplicate ZIP entry: ${name}`);
  exact.add(name);folded.add(name.toLowerCase());
 }
}

export function createZip(entries,{method='store'}={}){
 if(!Object.hasOwn(METHOD,method))throw Error('Unsupported ZIP method');
 if(!Array.isArray(entries)||entries.length<1||entries.length>=0xffff)throw Error('ZIP entry count out of bounds');
 const sorted=entries.map(e=>({name:validateEntryName(e.name),data:e.data instanceof Uint8Array?e.data:(()=>{throw Error('ZIP entry data must be bytes');})()}))
  .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 uniqueNames(sorted.map(e=>e.name));
 const locals=[],centrals=[];let offset=0;
 for(const {name,data} of sorted){
  const nameBytes=Buffer.from(name,'ascii');
  let body=data,code=METHOD.store;
  if(method==='deflate'){const packed=deflateRawSync(data,{level:9});if(packed.length<data.length){body=packed;code=METHOD.deflate;}}
  if(data.length>=MAX32||body.length>=MAX32)throw Error('ZIP entry too large (ZIP64 unsupported)');
  const crc=crc32(data),version=code===METHOD.deflate?20:10;
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(version,4);local.writeUInt16LE(0,6);local.writeUInt16LE(code,8);
  local.writeUInt16LE(0,10);local.writeUInt16LE(DOS_DATE,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);
  local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);local.writeUInt16LE(0,28);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(version,6);central.writeUInt16LE(0,8);
  central.writeUInt16LE(code,10);central.writeUInt16LE(0,12);central.writeUInt16LE(DOS_DATE,14);central.writeUInt32LE(crc,16);
  central.writeUInt32LE(body.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);
  // extra=0, comment=0, disk=0, internal attrs=0, external attrs=0
  central.writeUInt32LE(offset,42);
  locals.push(local,nameBytes,body);centrals.push(central,nameBytes);
  offset+=30+nameBytes.length+body.length;
  if(offset>=MAX32)throw Error('ZIP archive too large (ZIP64 unsupported)');
 }
 const cd=Buffer.concat(centrals),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(sorted.length,8);end.writeUInt16LE(sorted.length,10);
 end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
 const out=Buffer.concat([...locals,cd,end]);
 return new Uint8Array(out.buffer,out.byteOffset,out.length);
}

export function readZip(input,limits={}){
 const {maxEntries,maxEntryBytes,maxTotalBytes,maxRatio}={...ZIP_DEFAULTS,...limits};
 if(!(input instanceof Uint8Array)||input.length<22)throw Error('Not a ZIP archive');
 const view=new DataView(input.buffer,input.byteOffset,input.length);
 const u16=o=>view.getUint16(o,true),u32=o=>view.getUint32(o,true);
 const eocd=input.length-22;
 if(u32(eocd)!==0x06054b50)throw Error('ZIP end record missing or archive has a comment/trailing data');
 if(u16(eocd+4)!==0||u16(eocd+6)!==0||u16(eocd+20)!==0)throw Error('Multi-disk or commented ZIP not allowed');
 const count=u16(eocd+10),cdSize=u32(eocd+12),cdOffset=u32(eocd+16);
 if(u16(eocd+8)!==count||count<1||count===0xffff||cdSize===MAX32||cdOffset===MAX32)throw Error('Invalid ZIP entry count (ZIP64 unsupported)');
 if(count>maxEntries)throw Error(`ZIP has more than ${maxEntries} entries`);
 if(cdOffset+cdSize!==eocd)throw Error('ZIP central directory is not contiguous with the end record');
 const entries=[],names=[];let pos=cdOffset,expectedLocal=0,total=0,compressedTotal=0;
 for(let n=0;n<count;n++){
  if(pos+46>eocd||u32(pos)!==0x02014b50)throw Error('Malformed ZIP central directory');
  const made=u16(pos+4),needed=u16(pos+6),flags=u16(pos+8),method=u16(pos+10),time=u16(pos+12),date=u16(pos+14);
  const crc=u32(pos+16),csize=u32(pos+20),usize=u32(pos+24),nameLen=u16(pos+28),extraLen=u16(pos+30),commentLen=u16(pos+32);
  const disk=u16(pos+34),internal=u16(pos+36),external=u32(pos+38),localOffset=u32(pos+42);
  if(flags&~0x0800)throw Error('ZIP entry uses encryption, data descriptors or unsupported flags');
  if(method!==0&&method!==8)throw Error('ZIP entry uses an unsupported compression method');
  if(extraLen||commentLen||disk||internal)throw Error('ZIP entry has extra fields, comments or disk spanning');
  if(external!==0||(made>>8)>3)throw Error('ZIP entry carries external attributes (symlink/permission flags not allowed)');
  if(needed>20||csize===MAX32||usize===MAX32)throw Error('ZIP64 or unsupported ZIP version');
  const nameBytes=input.subarray(pos+46,pos+46+nameLen);
  if(pos+46+nameLen>eocd||!nameBytes.every(b=>b>0x20&&b<0x7f))throw Error('ZIP entry name is not printable ASCII');
  const name=validateEntryName(Buffer.from(nameBytes).toString('ascii'));
  pos+=46+nameLen;
  if(localOffset!==expectedLocal)throw Error('ZIP entries overlap or leave gaps');
  if(localOffset+30+nameLen>cdOffset||u32(localOffset)!==0x04034b50)throw Error('Malformed ZIP local header');
  const same=[[4,needed],[6,flags],[8,method],[10,time],[12,date]].every(([o,v])=>u16(localOffset+o)===v)&&u32(localOffset+14)===crc&&u32(localOffset+18)===csize&&u32(localOffset+22)===usize&&u16(localOffset+26)===nameLen&&u16(localOffset+28)===0;
  if(!same||!input.subarray(localOffset+30,localOffset+30+nameLen).every((b,k)=>b===nameBytes[k]))throw Error('ZIP local header disagrees with central directory');
  const start=localOffset+30+nameLen;
  expectedLocal=start+csize;
  if(expectedLocal>cdOffset)throw Error('ZIP entry data overruns the central directory');
  if(usize>maxEntryBytes)throw Error(`ZIP entry exceeds ${maxEntryBytes} bytes: ${name}`);
  total+=usize;compressedTotal+=csize;
  if(total>maxTotalBytes)throw Error(`ZIP expands beyond ${maxTotalBytes} bytes`);
  if(method===0&&csize!==usize)throw Error('Stored ZIP entry sizes disagree');
  if(method===8&&(csize===0||usize/csize>maxRatio))throw Error(`ZIP entry compression ratio exceeds ${maxRatio}x: ${name}`);
  entries.push({name,method,crc,usize,start,csize});names.push(name);
 }
 if(pos!==eocd||expectedLocal!==cdOffset)throw Error('ZIP layout has unaccounted bytes');
 if(compressedTotal>0&&total/compressedTotal>maxRatio)throw Error(`ZIP compression ratio exceeds ${maxRatio}x`);
 uniqueNames(names);
 return entries.map(({name,method,crc,usize,start,csize})=>{
  const raw=input.subarray(start,start+csize);
  let data=raw;
  if(method===8){
   try{data=new Uint8Array(inflateRawSync(raw,{maxOutputLength:Math.max(usize,1)}));}
   catch{throw Error(`ZIP entry failed to inflate within its declared size: ${name}`);}
  }
  if(data.length!==usize||crc32(data)!==crc)throw Error(`ZIP entry size or CRC mismatch: ${name}`);
  return {name,data};
 });
}
