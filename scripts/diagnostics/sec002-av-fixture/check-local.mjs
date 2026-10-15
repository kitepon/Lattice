// Portable data/schema/negative checks only. No Windows API, C# compilation or EXE execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {extractZip,pe,observation,verdict,safeName,MODES} from './validate.mjs';
let checks=0;
const check=fn=>{fn();checks++;};
const bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
const base={schema:'sec002-av-capture-v1-metadata-only',state:'finished',caseId:'cli-idempotent',callOrder:2,rootPid:100,outerExited:true,outerExitCode:0,debugHeapDisableRequested:true,collectorCoverageComplete:true,faultObserved:false,faultMetadataComplete:false,stackComplete:false,stackAvailable:false,cleanupForced:false,drainTimedOut:false,remainingActiveProcesses:0,fault:null};
const native={Pid:99,Status:0,Stdout:[...Buffer.from('fixture stdout\r\n')],Stderr:[...Buffer.from('fixture stderr\r\n')],CleanupComplete:true,Forced:false,TimedOut:false,StdoutEof:true,StderrEof:true,Active:0,Failure:null,ElapsedMs:50};
check(()=>assert.equal(observation(bytes(base)).schema,base.schema));check(()=>assert.equal(verdict('normal',base,native).passed,true));
for(const name of ['../capture.exe','/capture.exe','C:capture.exe','a/b','a\\b','CON','nul.txt','capture.exe:stream','Capture.exe','capture..exe','a\0b','a'.repeat(65)])check(()=>assert.equal(safeName(name),false));
for(const field of ['schema','state','caseId','callOrder','rootPid','outerExitCode','stackAvailable','debugHeapDisableRequested'])check(()=>assert.throws(()=>observation(bytes({...base,[field]:'SECRET_SENTINEL_NEVER_EMIT'}))));
check(()=>assert.throws(()=>observation(bytes({...base,secret:'SECRET_SENTINEL_NEVER_EMIT'}))));
check(()=>assert.throws(()=>observation(Buffer.from(JSON.stringify(base)))));
check(()=>assert.throws(()=>observation(Buffer.from(JSON.stringify(base).replace('"rootPid":100','"rootPid":2,"rootPid":100')+'\n'))));
check(()=>assert.throws(()=>observation(Buffer.alloc(65537))));
for(const field of ['collectorCoverageComplete','outerExited'])check(()=>assert.equal(verdict('normal',{...base,[field]:false},native).passed,false));
for(const field of ['cleanupForced','drainTimedOut'])check(()=>assert.equal(verdict('normal',{...base,[field]:true},native).passed,false));
for(const [field,value]of Object.entries({Status:1,CleanupComplete:false,Forced:true,TimedOut:true,StdoutEof:false,StderrEof:false,Active:1,Failure:'job_assign',Stdout:[83,69,67,82,69,84]}))check(()=>assert.equal(verdict('normal',base,{...native,[field]:value}).passed,false));
check(()=>assert.equal(verdict('exit-av',{...base,outerExitCode:3221225477},{...native,Status:3221225477,Stdout:[],Stderr:[]}).passed,true));
check(()=>assert.equal(verdict('read',{...base,outerExitCode:3221225477},{...native,Status:3221225477,Stdout:[],Stderr:[]}).passed,false));
check(()=>assert.equal(MODES.length,11));check(()=>assert.equal(new Set(MODES).size,11));
const archive=process.argv[2];if(archive){
 const manifest=JSON.parse(fs.readFileSync(path.join(import.meta.dirname,'artifact-files.json'))),zip=fs.readFileSync(archive);let entries;
 check(()=>{entries=extractZip(zip,manifest);assert.equal(entries.size,16);});
 for(const name of ['capture.exe','fault-fixture.exe'])check(()=>assert.equal(pe(entries.get(name)).machine,'AMD64'));
 check(()=>assert.throws(()=>extractZip(Buffer.concat([zip,Buffer.from([0])]),manifest)));
 check(()=>{const corrupt=Buffer.from(zip);corrupt[50]^=1;assert.throws(()=>extractZip(corrupt,manifest));});
 check(()=>assert.throws(()=>extractZip(zip,manifest.slice(1))));
 check(()=>assert.throws(()=>pe(Buffer.alloc(512))));
 check(()=>{const b=Buffer.from(entries.get('capture.exe'));b.writeUInt16LE(0x14c,b.readUInt32LE(60)+4);assert.throws(()=>pe(b));});
}
const nativeSource=fs.readFileSync(path.join(import.meta.dirname,'NativeController.cs'),'utf8');
check(()=>assert(!/OpenProcess\(|OpenThread\(|DebugActiveProcess\(|EnumProcesses\(/.test(nativeSource)));
check(()=>assert(nativeSource.includes('0x00080004')&&nativeSource.includes('new IntPtr(0x2000d)')&&nativeSource.indexOf('IsProcessInJob(pi.process,job.H,out member)')<nativeSource.indexOf('ResumeThread(pi.thread)')));
check(()=>assert(nativeSource.includes('l.basic.flags=0x2000')&&nativeSource.includes('PeekNamedPipe')&&nativeSource.includes('FileShare.Read')));
console.log(JSON.stringify({kind:'portable-data-negative-and-source-contract',checks,passed:checks,windowsExecuted:false,csharpCompiled:false},null,2));
