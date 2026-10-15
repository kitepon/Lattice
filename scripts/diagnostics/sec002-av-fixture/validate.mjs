import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
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
const summaryKeys=['schema','state','caseId','callOrder','rootPid','outerExited','outerExitCode','debugHeapDisableRequested','collectorCoverageComplete','faultObserved','faultMetadataComplete','stackComplete','stackAvailable','cleanupForced','drainTimedOut','remainingActiveProcesses','fault'];
export function observation(bytes){
 if(bytes.length<2||bytes.length>65536)fail('observation_size');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const v=JSON.parse(text);
 if(text!==JSON.stringify(v)+'\n'||!keys(v,summaryKeys))fail('observation_canonical_schema');
 if(v.schema!=='sec002-av-capture-v1-metadata-only'||!['finished','incomplete','unavailable','launch_pending','fault_pending_exit'].includes(v.state)||v.caseId!=='cli-idempotent'||v.callOrder!==2||!pid(v.rootPid)||!uint(v.outerExitCode)||!uint(v.remainingActiveProcesses))fail('observation_fields');
 for(const k of ['outerExited','debugHeapDisableRequested','collectorCoverageComplete','faultObserved','faultMetadataComplete','stackComplete','stackAvailable','cleanupForced','drainTimedOut'])if(typeof v[k]!=='boolean')fail('observation_boolean');
 if(!v.debugHeapDisableRequested||v.stackComplete||v.stackAvailable)fail('observation_stack_or_heap');
 if(!v.faultObserved){if(v.fault!==null||v.faultMetadataComplete)fail('fault_absent');return v;}
 const f=v.fault;let k=['utcFileTime100ns','pid','threadId','targetNode','exceptionCode','exceptionFlags','secondChance','ip','access','accessAddressAvailable','ipRegion','module','contextRead','stackComplete','stackStop','frames'];
 if(f?.accessAddressAvailable)k.push('accessAddress');
 if(!keys(f,k)||!/^\d{15,20}$/.test(f.utcFileTime100ns)||!pid(f.pid)||!pid(f.threadId)||typeof f.targetNode!=='boolean'||f.exceptionCode!==3221225477||!uint(f.exceptionFlags)||f.secondChance!==true||!hex(f.ip)||!['read','write','execute','unknown'].includes(f.access)||typeof f.accessAddressAvailable!=='boolean'||(f.accessAddressAvailable&&!hex(f.accessAddress))||!['unknown','anonymous-private','mapped-image','mapped-nonimage','uncommitted'].includes(f.ipRegion)||typeof f.contextRead!=='boolean'||f.stackComplete!==false||f.stackStop!=='not_implemented'||!Array.isArray(f.frames)||f.frames.length)fail('fault_schema');
 const m=f.module;if(m?.imageClass==='unknown-region'){if(!keys(m,['imageClass']))fail('module_unknown');}
 else{let mk=['imageClass','nameHash','peValid','timestamp','imageSize','rva','codeViewPresent'];if(m?.codeViewPresent)mk.push('codeViewGuidBytes','codeViewAge');if(!keys(m,mk)||!['node','ntdll','native-addon','other-image'].includes(m.imageClass)||!hex(m.nameHash)||typeof m.peValid!=='boolean'||!uint(m.timestamp)||!uint(m.imageSize)||!hex(m.rva)||typeof m.codeViewPresent!=='boolean'||(m.codeViewPresent&&(!/^[0-9a-f]{32}$/.test(m.codeViewGuidBytes)||!uint(m.codeViewAge))))fail('module_schema');}
 return v;
}
export function verdict(mode,v,native){
 if(!MODES.includes(mode))fail('mode_unknown');
 const av=['read','write','execute','thread','child'].includes(mode),status=mode==='exit1'?1:mode==='breakpoint'?2147483651:av||mode==='exit-av'?3221225477:0;
 const expectedOut=mode==='normal'?Buffer.from('fixture stdout\r\n'):Buffer.alloc(0),expectedErr=mode==='normal'?Buffer.from('fixture stderr\r\n'):Buffer.alloc(0);
 const out=Buffer.from(native.Stdout),err=Buffer.from(native.Stderr);
 let passed=pid(native.Pid)&&v.rootPid!==native.Pid&&v.state==='finished'&&v.outerExited&&v.outerExitCode===status&&native.Status===status&&v.collectorCoverageComplete&&!v.cleanupForced&&!v.drainTimedOut&&v.remainingActiveProcesses===0&&native.CleanupComplete&&!native.Forced&&!native.TimedOut&&native.StdoutEof&&native.StderrEof&&native.Active===0&&!native.Failure&&out.equals(expectedOut)&&err.equals(expectedErr)&&v.faultObserved===av;
 if(av){const f=v.fault;passed&&=f?.targetNode===true&&f.contextRead===true&&f.accessAddressAvailable===true;
  if(['read','thread','child'].includes(mode))passed&&=f.access==='read';if(mode==='write')passed&&=f.access==='write';if(mode==='execute')passed&&=f.access==='execute'&&f.ipRegion==='anonymous-private'&&f.module.imageClass==='unknown-region';
  else passed&&=v.faultMetadataComplete&&f.ipRegion==='mapped-image'&&f.module.imageClass==='node';
  if(mode==='child')passed&&=f.pid!==v.rootPid;else passed&&=f.pid===v.rootPid;
 }
 if(mode==='child-delay')passed&&=native.ElapsedMs>=250;
 return {mode,passed:!!passed,status:native.Status,stdoutBytes:out.length,stdoutSha256:hash(out),stderrBytes:err.length,stderrSha256:hash(err),stdoutMatched:out.equals(expectedOut),stderrMatched:err.equals(expectedErr),cleanupComplete:native.CleanupComplete,forced:native.Forced,timedOut:native.TimedOut,elapsedMs:native.ElapsedMs,helperFixtureImageLabelOnly:true};
}
if(process.argv[1]===import.meta.filename){
 const [command,input,output,mode,nativePath]=process.argv.slice(2);
 try{
  if(command==='source'){
   if(!/^[0-9a-f]{40}$/.test(output)||execFileSync('git',['-C',input,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==output||execFileSync('git',['-C',input,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())fail('source_identity');
   const base=path.join(input,'scripts/diagnostics/sec002-av-build');const mbytes=fs.readFileSync(path.join(base,'source-manifest.json'));if(hash(mbytes)!=='28b7766841e3c8ddae60008432508a2780aee0e4b22042de9bf062e5b80ef813')fail('source_manifest');
   for(const row of JSON.parse(mbytes).files){const b=fs.readFileSync(path.join(base,'snapshot',row.path));if(b.length!==row.bytes||hash(b)!==row.sha256)fail('source_snapshot');}
  }else if(command==='extract'){
   const manifest=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'artifact-files.json')));const entries=extractZip(fs.readFileSync(input),manifest);fs.mkdirSync(output,{recursive:false});for(const [name,data]of entries)fs.writeFileSync(path.join(output,name),data,{flag:'wx'});
  }else if(command==='judge'){
   if(fs.statSync(input).size>65536||fs.statSync(nativePath).size>1048576)fail('input_capacity');const v=observation(fs.readFileSync(input)),n=JSON.parse(fs.readFileSync(nativePath)),r=verdict(mode,v,n);fs.writeFileSync(output,JSON.stringify({observation:v,result:r})+'\n',{flag:'wx'});if(!r.passed)process.exitCode=1;
  }else fail('command_unknown');
 }catch{process.stderr.write('fixed_fixture_validation_failed\n');process.exitCode=1;}
}
