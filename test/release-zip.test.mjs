import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {createZip,readZip,crc32,validateEntryName} from '../ci/release/zip.mjs';

const bytes=s=>new TextEncoder().encode(s);
// Hand-rolled ZIP encoder for hostile inputs the production writer refuses to emit.
function rawZip(entries,{comment=Buffer.alloc(0),trailing=Buffer.alloc(0)}={}){
 const locals=[],centrals=[];let offset=0;
 for(const e of entries){
  const name=Buffer.from(e.name,'latin1'),data=Buffer.from(e.data??''),body=e.method===8?deflateRawSync(data):data;
  const crc=e.crc??crc32(data),csize=e.csize??body.length,usize=e.usize??data.length,extra=e.extra??Buffer.alloc(0);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(e.flags??0,6);local.writeUInt16LE(e.method??0,8);
  local.writeUInt16LE(0,10);local.writeUInt16LE(33,12);local.writeUInt32LE(e.localCrc??crc,14);local.writeUInt32LE(csize,18);
  local.writeUInt32LE(usize,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(e.made??20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(e.flags??0,8);
  central.writeUInt16LE(e.method??0,10);central.writeUInt16LE(0,12);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);
  central.writeUInt32LE(csize,20);central.writeUInt32LE(usize,24);central.writeUInt16LE(name.length,28);central.writeUInt16LE(extra.length,30);
  central.writeUInt32LE(e.external??0,38);central.writeUInt32LE(e.offset??offset,42);
  locals.push(local,name,extra,body);centrals.push(central,name,extra);offset+=30+name.length+extra.length+body.length;
 }
 const cd=Buffer.concat(centrals),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(comment.length,20);
 return new Uint8Array(Buffer.concat([...locals,cd,end,comment,trailing]));
}

test('crc32 matches the standard check value',()=>{
 assert.equal(crc32(bytes('123456789')),0xcbf43926);
 assert.equal(crc32(new Uint8Array()),0);
});

test('writer output round-trips, is sorted and byte-identical across runs',()=>{
 const entries=[{name:'b/two.txt',data:bytes('two')},{name:'a.txt',data:bytes('a'.repeat(1000))},{name:'empty',data:new Uint8Array()}];
 for(const method of ['store','deflate']){
  const first=createZip(entries,{method}),second=createZip([...entries].reverse(),{method});
  assert.deepEqual(first,second);
  const read=readZip(first);
  assert.deepEqual(read.map(e=>e.name),['a.txt','b/two.txt','empty']);
  assert.equal(new TextDecoder().decode(read[1].data),'two');
  assert.equal(read[0].data.length,1000);
 }
 assert.ok(createZip(entries,{method:'deflate'}).length<createZip(entries).length);
 assert.deepEqual(readZip(rawZip([{name:'ok.txt',data:'hello'}])).map(e=>e.name),['ok.txt']);
});

test('writer refuses traversal, absolute, duplicate and non-byte entries',()=>{
 for(const name of ['../x','/abs','a/../b','./a','a//b','a/','C:\\x','sp ace','a\\b',''])assert.throws(()=>createZip([{name,data:bytes('x')}]),/not allowed|traverses|length/,name);
 assert.throws(()=>createZip([{name:'a',data:bytes('1')},{name:'a',data:bytes('2')}]),/Duplicate/);
 assert.throws(()=>createZip([{name:'A.txt',data:bytes('1')},{name:'a.txt',data:bytes('2')}]),/Case-insensitive/);
 assert.throws(()=>createZip([{name:'a',data:'string'}]),/bytes/);
 assert.throws(()=>createZip([]),/count/);
 assert.equal(validateEntryName('assets/.well-known/x.txt'),'assets/.well-known/x.txt');
});

test('reader rejects hostile archives',()=>{
 const hostile={
  'traversal entry':[/traverses/,rawZip([{name:'../../etc/passwd',data:'x'}])],
  'nested traversal':[/traverses/,rawZip([{name:'assets/../../x',data:'x'}])],
  'absolute path':[/not allowed/,rawZip([{name:'/etc/passwd',data:'x'}])],
  'backslash path':[/not allowed/,rawZip([{name:'..\\x',data:'x'}])],
  'symlink attributes':[/external attributes/,rawZip([{name:'link',data:'/etc/passwd',made:0x0314,external:(0o120777<<16)>>>0}])],
  'unix permission attributes':[/external attributes/,rawZip([{name:'file',data:'x',made:0x0314,external:(0o100644<<16)>>>0}])],
  'directory attribute':[/external attributes/,rawZip([{name:'dir',data:'',external:0x10}])],
  'duplicate names':[/Duplicate ZIP entry/,rawZip([{name:'a.txt',data:'1'},{name:'a.txt',data:'2'}])],
  'case-insensitive duplicate':[/Case\-insensitive duplicate/,rawZip([{name:'A.txt',data:'1'},{name:'a.txt',data:'2'}])],
  'encrypted flag':[/encryption/,rawZip([{name:'a',data:'x',flags:1}])],
  'data descriptor flag':[/data descriptors/,rawZip([{name:'a',data:'x',flags:8}])],
  'extra field':[/extra fields/,rawZip([{name:'a',data:'x',extra:Buffer.from([1,0,0,0])}])],
  'archive comment':[/comment\/trailing/,rawZip([{name:'a',data:'x'}],{comment:Buffer.from('hi')})],
  'trailing garbage':[/comment\/trailing/,rawZip([{name:'a',data:'x'}],{trailing:Buffer.from('junk')})],
  'crc mismatch':[/CRC mismatch/,rawZip([{name:'a',data:'x',crc:1,localCrc:1}])],
  'local/central disagreement':[/disagrees with central/,rawZip([{name:'a',data:'x',localCrc:7}])],
  'overlapping offsets':[/overlap/,rawZip([{name:'a',data:'x'},{name:'b',data:'y',offset:0}])],
  'zip64 marker':[/ZIP64/,rawZip([{name:'a',data:'x',usize:0xffffffff}])],
  'stored size mismatch':[/Stored ZIP entry sizes/,rawZip([{name:'a',data:'xy',usize:1}])],
  'unsupported method':[/unsupported compression/,rawZip([{name:'a',data:'x',method:12}])],
  'non-ascii name':[/printable ASCII/,rawZip([{name:'caf\xe9',data:'x'}])],
 };
 for(const [name,[reason,archive]] of Object.entries(hostile))assert.throws(()=>readZip(archive),reason,name);
 assert.throws(()=>readZip(new Uint8Array(10)),/Not a ZIP/);
});

test('reader enforces decompression-bomb ratio, entry count and size limits before inflating',()=>{
 const zeros=new Uint8Array(10*1024*1024);
 const bomb=rawZip([{name:'bomb.bin',data:zeros,method:8}]);
 assert.ok(bomb.length<20000);
 assert.throws(()=>readZip(bomb),/ratio exceeds 100x/);
 const lying=rawZip([{name:'a',data:new Uint8Array(1000).fill(65),method:8,usize:10}]);
 assert.throws(()=>readZip(lying),/inflate|CRC/);
 const many=createZip(Array.from({length:30},(_,i)=>({name:`f${i}`,data:bytes('x')})));
 assert.throws(()=>readZip(many,{maxEntries:29}),/more than 29 entries/);
 assert.equal(readZip(many,{maxEntries:30}).length,30);
 const big=createZip([{name:'big',data:new Uint8Array(2048)}]);
 assert.throws(()=>readZip(big,{maxEntryBytes:1024}),/exceeds 1024 bytes/);
 assert.throws(()=>readZip(createZip([{name:'a',data:new Uint8Array(600)},{name:'b',data:new Uint8Array(600)}]),{maxTotalBytes:1000}),/expands beyond/);
});
