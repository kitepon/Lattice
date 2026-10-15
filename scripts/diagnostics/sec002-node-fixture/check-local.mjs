// Linux local JS/data tests only. No C#/Win32 compile, capture EXE or CI execution.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {TAIL,environmentDigest,makeReceipt,compareReceipt} from './fixture.mjs';import {native,receipt,classify} from './validate.mjs';
let checks=0;const check=fn=>{fn();checks++;};
check(()=>assert.equal(environmentDigest({A:'x'}),environmentDigest({A:'x',_NO_DEBUG_HEAP:'1'})));
check(()=>assert.notEqual(environmentDigest({A:'x'}),environmentDigest({A:'x',SECRET_SENTINEL:'private'})));
const expected=makeReceipt(['','space','雪'],'/fixed',{A:'x'},[],'node');
check(()=>assert(compareReceipt(expected,{...expected})));
for(const k of ['argv','cwd','env','execArgv','node'])check(()=>assert(!compareReceipt(expected,{...expected,[k]:'different'})));
const n={Mode:'handoff',Phase:'baseline',Failure:null,Pid:100,Active:0,ActiveBeforeControl:0,Status:0,ReadyCount:3,ElapsedMs:500,StdoutBytes:1048576,StderrBytes:1048576,StdoutEof:true,StderrEof:true,StdoutPattern:true,StderrPattern:true,ExpectedTimeout:false,CollectorOnlyKilled:false,FallbackJobKill:false,CleanupComplete:true,Forced:false,TimedOut:false};
const receipts=['root','child','grand'].map((role,i)=>({schema:'sec002-node-receipt-v1',mode:'handoff',role,pid:100+i,parentPid:i?99+i:99,argumentsVerified:true,cwdVerified:true,heapDifferenceVerified:true,environmentReferenceCaptured:true,environmentCompared:false,environmentEqual:false,execArgvEmpty:true}));
check(()=>assert(classify(n,receipts,null).passed));
for(const [k,v]of Object.entries({Active:1,Status:1,ReadyCount:2,StdoutBytes:10,StderrBytes:10,StdoutEof:false,StderrEof:false,StdoutPattern:false,StderrPattern:false,FallbackJobKill:true,CleanupComplete:false,Failure:'mode_budget',Forced:true,TimedOut:true}))check(()=>assert(!classify({...n,[k]:v},receipts,null).passed));
for(const k of ['argumentsVerified','cwdVerified','heapDifferenceVerified','execArgvEmpty'])check(()=>assert(!classify(n,receipts.map((r,i)=>i? r:{...r,[k]:false}),null).passed));
check(()=>assert.throws(()=>native({...n,secret:'SECRET_SENTINEL'})));
check(()=>assert.throws(()=>native({...n,Failure:'SECRET_SENTINEL'})));
check(()=>assert.throws(()=>native({...n,StdoutBytes:3000000})));
check(()=>assert.throws(()=>receipt({...receipts[0],rawEnv:'SECRET_SENTINEL'},'handoff','root')));
for(const mode of ['timeout','collector-kill']){
 const q={...n,Mode:mode,Phase:'wrapped',Status:mode==='timeout'?125:126,ActiveBeforeControl:4,StdoutBytes:0,StderrBytes:0,ExpectedTimeout:mode==='timeout',CollectorOnlyKilled:mode==='collector-kill',Forced:mode==='timeout',TimedOut:mode==='timeout'};
 const rs=receipts.map(r=>({...r,mode,environmentReferenceCaptured:false}));
 check(()=>assert(classify(q,rs,null).passed));check(()=>assert(!classify({...q,FallbackJobKill:true},rs,null).passed));check(()=>assert(!classify({...q,ActiveBeforeControl:3},rs,null).passed));
}
const source=fs.readFileSync(path.join(import.meta.dirname,'NodeController.cs'),'utf8');
check(()=>assert(!/OpenProcess\(|OpenThread\(|EnumProcesses\(|DebugActiveProcess\(/.test(source)));
check(()=>assert(source.includes('N.TerminateProcess(process.H,126)')&&source.includes('r.ActiveBeforeControl=active')&&source.includes('clock.ElapsedMilliseconds-controlAt>=3000')));
if(process.argv.includes('--real-linux')){
 const dir=fs.mkdtempSync(path.join(path.resolve(import.meta.dirname,'../../..'),'sec002-local-js-'));
 try{
  const script=path.join(import.meta.dirname,'fixture.mjs');const env={...process.env};delete env._NO_DEBUG_HEAP;
  const config=phase=>({mode:'handoff',phase,cwd:dir,node:process.execPath,version:process.version,arch:process.arch,platform:process.platform});
  for(const phase of ['baseline','wrapped']){
   fs.writeFileSync(path.join(dir,'context.json'),JSON.stringify(config(phase)));
   const r=spawnSync(process.execPath,[script,'handoff','root',...TAIL],{cwd:dir,env:phase==='baseline'?env:{...env,_NO_DEBUG_HEAP:'1'},maxBuffer:5000000,timeout:10000});
   check(()=>assert.equal(r.status,0));check(()=>assert.equal(r.signal,null));
   for(const [stream,value]of [['stdout',0x53],['stderr',0x45]])check(()=>{assert.equal(r[stream].length,1048576);assert(r[stream].every(v=>v===value));});
   for(const role of ['root','child','grand'])check(()=>{const v=JSON.parse(fs.readFileSync(path.join(dir,role+'.'+phase+'.receipt.json')));receipt(v,'handoff',role);assert.equal(v.environmentCompared,phase==='wrapped');assert.equal(v.environmentEqual,phase==='wrapped');});
  }
  for(const role of ['root','child','grand'])fs.unlinkSync(path.join(dir,role+'.wrapped.receipt.json'));
  const bad=spawnSync(process.execPath,[script,'handoff','root',...TAIL],{cwd:dir,env:{...env,_NO_DEBUG_HEAP:'1',SEC002_SECRET_SENTINEL:'never-publish'},maxBuffer:5000000,timeout:10000});
  check(()=>assert.equal(bad.status,91));check(()=>assert.equal(bad.stdout.length,0));check(()=>assert.equal(bad.stderr.length,0));
  const args=spawnSync(process.execPath,[script,'handoff','root',...TAIL.slice(0,-1),'wrong Unicode'],{cwd:dir,env:{...env,_NO_DEBUG_HEAP:'1'},maxBuffer:5000000,timeout:10000});
  check(()=>assert.equal(args.status,91));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({kind:'portable-schema-negative-and-local-JS',checks,passed:checks,localNodeVersion:process.version,localPlatform:process.platform,realLinuxJS:process.argv.includes('--real-linux'),windowsExecuted:false,csharpCompiled:false,captureExecuted:false},null,2));
