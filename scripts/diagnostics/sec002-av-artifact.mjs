import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
export const ZIP_SHA='f9f73e84517e980a1a7cc436592f857bb765cb3b4344578bcba07875eccff205';
export const MODES=['normal','exit1','exit-av','read','write','execute','handled','thread','breakpoint','child','child-delay'];
export const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export const safeName=name=>typeof name==='string'&&/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)&&!name.includes('..')&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const fail=code=>{throw new Error(code);};
const keys=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&Object.keys(v).every(x=>k.includes(x));
const uint=v=>Number.isInteger(v)&&v>=0&&v<=0xffffffff;
const pid=v=>uint(v)&&v>0;
const hex=v=>typeof v==='string'&&/^0x[0-9a-f]{1,16}$/.test(v);
export function pe(b){
 const u16=o=>o>=0&&o+2<=b.length?b.readUInt16LE(o):fail('pe_bounds');
 const u32=o=>o>=0&&o+4<=b.length?b.readUInt32LE(o):fail('pe_bounds');
 if(u16(0)!==0x5a4d)fail('pe_dos');const p=u32(60),o=p+24,n=u16(p+6),size=u16(p+20);
 if(u32(p)!==0x4550||u16(p+4)!==0x8664||u16(o)!==0x20b||size<240||u16(o+68)!==3||n<1||n>96)fail('pe_arch');
 const sections=Array.from({length:n},(_,i)=>{const s=o+size+40*i;return {rva:u32(s+12),rawSize:u32(s+16),raw:u32(s+20)};});
 const off=(rva,len)=>{for(const s of sections){const d=rva-s.rva;if(d>=0&&d+len<=s.rawSize&&s.raw+d+len<=b.length)return s.raw+d;}return fail('pe_rva');};
 const rva=u32(o+120),bytes=u32(o+124);if(!rva||bytes<20||bytes>65536)fail('pe_imports');const imports=[];let end=false;
 for(let i=0;i<Math.min(bytes/20,256);i++){const a=off(rva+20*i,20),name=u32(a+12);if(!name){end=true;break;}let str='';for(let j=0;j<128;j++){const c=b[off(name+j,1)];if(c===0)break;str+=String.fromCharCode(c);}if(str.toLowerCase()!=='kernel32.dll')fail('pe_import');imports.push(str.toLowerCase());}
 if(!end||imports.length!==1)fail('pe_imports');return {machine:'AMD64',format:'PE32+',imports};
}
export function extractZip(bytes,manifest){
 if(bytes.length!==526617||hash(bytes)!==ZIP_SHA)fail('archive_identity');
 let e=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){e=i;break;}
 if(e<0||e+22+bytes.readUInt16LE(e+20)!==bytes.length||bytes.readUInt16LE(e+4)||bytes.readUInt16LE(e+6))fail('zip_end');
 const count=bytes.readUInt16LE(e+10),central=bytes.readUInt32LE(e+16),centralBytes=bytes.readUInt32LE(e+12);
 if(count!==16||bytes.readUInt16LE(e+8)!==count||central+centralBytes!==e)fail('zip_directory');
 const expected=new Map(manifest.map(r=>[r.path,r]));if(expected.size!==16)fail('manifest_count');const entries=new Map();let at=central;
 for(let i=0;i<count;i++){
  if(at+46>e||bytes.readUInt32LE(at)!==0x02014b50)fail('zip_header');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),packed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24),nl=bytes.readUInt16LE(at+28),xl=bytes.readUInt16LE(at+30),cl=bytes.readUInt16LE(at+32),external=bytes.readUInt32LE(at+38),local=bytes.readUInt32LE(at+42);
  if(at+46+nl+xl+cl>e||(flags&1)||![0,8].includes(method)||((external>>>16)&0xf000)===0xa000)fail('zip_features');
  const name=bytes.subarray(at+46,at+46+nl).toString('utf8');if(!safeName(name)||!expected.has(name)||entries.has(name))fail('zip_path');
  const row=expected.get(name);if(size!==row.bytes||size>1100000||packed>bytes.length)fail('zip_size');
  if(local+30>central||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)fail('zip_local');
  const lnl=bytes.readUInt16LE(local+26),lxl=bytes.readUInt16LE(local+28),start=local+30+lnl+lxl;
  if(bytes.subarray(local+30,local+30+lnl).toString('utf8')!==name||start+packed>central)fail('zip_local_path');
  const data=method===0?Buffer.from(bytes.subarray(start,start+packed)):inflateRawSync(bytes.subarray(start,start+packed),{maxOutputLength:size});
  if(data.length!==size||hash(data)!==row.sha256)fail('zip_file_identity');entries.set(name,data);at+=46+nl+xl+cl;
 }
 if(at!==e||entries.size!==16)fail('zip_inventory');for(const name of ['capture.exe','fault-fixture.exe'])pe(entries.get(name));return entries;
}
export function prepareArtifact(output){
 const manifest=JSON.parse(fs.readFileSync(new URL('./sec002-av-artifact-files.json',import.meta.url),'utf8'));
 const entries=extractZip(fs.readFileSync(path.join(output,'incoming/archive.zip')),manifest),directory=path.join(output,'incoming/verified');
 fs.mkdirSync(directory,{recursive:false});for(const [name,data]of entries)fs.writeFileSync(path.join(directory,name),data,{flag:'wx'});
 return {zipSha256:ZIP_SHA,files:entries.size,captureSha256:manifest.find(r=>r.path==='capture.exe').sha256};
}
