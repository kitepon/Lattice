import fs from 'node:fs';import path from 'node:path';
const fail=code=>{throw Error(code);};
const keys=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&Object.keys(v).every(x=>k.includes(x));
const uint=v=>Number.isInteger(v)&&v>=0&&v<=0xffffffff;const pid=v=>uint(v)&&v>0;const hex=v=>typeof v==='string'&&/^0x[0-9a-f]{1,16}$/.test(v);
const summaryKeys=['schema','state','caseId','callOrder','rootPid','outerExited','outerExitCode','debugHeapDisableRequested','collectorCoverageComplete','faultObserved','faultMetadataComplete','stackComplete','stackAvailable','cleanupForced','drainTimedOut','remainingActiveProcesses','fault'];
export function observation(bytes){
 if(bytes.length<2||bytes.length>65536)fail('observation_size');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const v=JSON.parse(text);
 if(text!==JSON.stringify(v)+'\n'||!keys(v,summaryKeys))fail('observation_canonical_schema');
 if(v.schema!=='sec002-av-capture-v1-metadata-only'||!['finished','incomplete','unavailable','launch_pending','fault_pending_exit'].includes(v.state)||!((v.caseId==='cli-idempotent'&&v.callOrder===2)||(v.caseId==='cli-recovery'&&v.callOrder===3))||!uint(v.rootPid)||(v.state==='finished'&&!pid(v.rootPid))||!uint(v.outerExitCode)||!uint(v.remainingActiveProcesses))fail('observation_fields');
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

export const TARGETS=[['cli-idempotent',2],['cli-recovery',3]];
export function callReceipt(v,caseId,order,phase){
 let fields=['schema','caseId','callOrder','phase','pid','parentPid'];if(phase==='leave')fields.push('status','signaled','spawnErrorCode','failureKind');
 if(!keys(v,fields)||v.schema!=='sec002-av-call-v1'||v.caseId!==caseId||v.callOrder!==order||v.phase!==phase||!pid(v.pid)||!pid(v.parentPid))fail('receipt_schema');
 if(phase==='leave'&&(!(v.status===null||uint(v.status))||typeof v.signaled!=='boolean'||!(v.spawnErrorCode===null||['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOMEM','EAGAIN','other'].includes(v.spawnErrorCode))||!(v.failureKind===null||['config','identity','helper','config_unreadable'].includes(v.failureKind))))fail('receipt_detail');return v;
}
export function classifyCapture(enter,leave,capture){
 const reached=!!enter,returned=!!leave,childObserved=!!capture?.outerExited;
 const sourceGuardFailure=!!leave&&['config','identity','config_unreadable'].includes(leave.failureKind);
 const consistent=!!leave&&!!capture&&leave.status!==null&&capture.outerExited&&leave.status===capture.outerExitCode;
 const cleanup=!!capture&&!capture.cleanupForced&&!capture.drainTimedOut&&capture.remainingActiveProcesses===0;
 const coverage=!!capture&&capture.state==='finished'&&capture.collectorCoverageComplete;
 const complete=reached&&returned&&enter.pid===leave.pid&&consistent&&coverage&&cleanup&&!leave.signaled&&!leave.spawnErrorCode&&!sourceGuardFailure;
 let classification='unobserved';
 if(sourceGuardFailure)classification='observer_unavailable';
 else if(capture?.faultObserved)classification=capture.fault.targetNode?'node_second_chance_av':'other_descendant_second_chance_av';
 else if(complete&&leave.status===3221225477)classification='c000_exit_without_captured_second_chance';
 else if(complete)classification='observed_cli_exit';
 else if(reached)classification='partial_or_unavailable';
 return {reached,returned,childObserved,consistent,cleanup,coverage,complete,sourceGuardFailure,classification,faultMetadataComplete:capture?.faultMetadataComplete??false,stackImplemented:false,rootPid:capture?.rootPid??null,exitStatus:leave?.status??null};
}
function read(file,cap,parse){if(fs.statSync(file).size>cap)fail('capacity');return parse(fs.readFileSync(file));}
export function summarizeCaptures(output){
 const privateDir=path.join(output,'capture-private'),publish=path.join(output,'publish');fs.mkdirSync(publish,{recursive:true});
 let writeFailed=false;try{writeFailed=fs.readFileSync(path.join(output,'test.log'),'utf8').includes('[sec002-av-capture-write-failed]');}catch{/* absence handled by driver */}
 const rows=TARGETS.map(([caseId,order])=>{
  const stem=caseId+'-'+order;let enter=null,leave=null,capture=null;const missing=[],invalid=[];
  for(const phase of ['enter','leave']){const file=path.join(privateDir,stem+'.'+phase+'.json');try{const v=read(file,2048,b=>callReceipt(JSON.parse(b.toString('utf8')),caseId,order,phase));if(phase==='enter')enter=v;else leave=v;}catch{(fs.existsSync(file)?invalid:missing).push(phase);}}
  const file=path.join(privateDir,stem+'.capture.json');try{capture=read(file,65536,observation);if(capture.caseId!==caseId||capture.callOrder!==order)fail('capture_target');}catch{capture=null;(fs.existsSync(file)?invalid:missing).push('capture');}
  const verdict=classifyCapture(enter,leave,capture);if(missing.length||invalid.length||writeFailed)verdict.complete=false;
  const row={schema:'sec002-av-target-v1',caseId,callOrder:order,enter,leave,capture,verdict,missing,invalid,writeFailed};
  fs.writeFileSync(path.join(publish,stem+'.json'),JSON.stringify(row)+'\n');return row;
 });
 return {schema:'sec002-av-capture-summary-v1',targets:rows.map(r=>({caseId:r.caseId,callOrder:r.callOrder,...r.verdict,missing:r.missing,invalid:r.invalid})),writeFailed,complete:rows.every(r=>r.verdict.complete)&&!writeFailed,unobserved:rows.filter(r=>!r.verdict.childObserved).length,stackImplemented:false};
}
