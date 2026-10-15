import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {observation} from '../sec002-av-fixture/validate.mjs';
export const CASES=['handoff','timeout','collector-kill'];
export const FIELDS=['Mode','Phase','Failure','Pid','Active','ActiveBeforeControl','Status','ReadyCount','ElapsedMs','StdoutBytes','StderrBytes','StdoutEof','StderrEof','StdoutPattern','StderrPattern','ExpectedTimeout','CollectorOnlyKilled','FallbackJobKill','CleanupComplete','Forced','TimedOut'];
const fixedFailure=['identity','fixed_plan','stdio_overflow','pipe_inheritance','pipe_read','collector_kill','tree_not_ready','timeout_kill','exit_code','process_wait','controlled_cleanup_deadline','mode_budget','cleanup_read','job_create','job_limits','pipe_create','stdio_create','attribute_size','attribute_init','attribute_handles','atomic_job_attribute_unavailable','launch_denied_or_failed','atomic_job_membership','resume_failed'];
const assert=(v,code)=>{if(!v)throw Error(code);};
export function native(v){
 assert(v&&Object.keys(v).length===FIELDS.length&&Object.keys(v).every(k=>FIELDS.includes(k)),'native_schema');
 assert(CASES.includes(v.Mode)&&['baseline','wrapped'].includes(v.Phase)&&!(v.Phase==='baseline'&&v.Mode!=='handoff'),'native_plan');
 assert(v.Failure===null||fixedFailure.includes(v.Failure),'native_failure');
 for(const k of ['Pid','Active','ActiveBeforeControl','ReadyCount','ElapsedMs','StdoutBytes','StderrBytes'])assert(Number.isSafeInteger(v[k])&&v[k]>=0&&v[k]<=0xffffffff,'native_number');
 assert(v.Pid>0&&v.ReadyCount<=3&&v.ElapsedMs<=30000&&v.StdoutBytes<=2097152&&v.StderrBytes<=2097152,'native_bound');
 assert(v.Status===null||Number.isInteger(v.Status)&&v.Status>=0&&v.Status<=0xffffffff,'native_status');
 for(const k of FIELDS.slice(11))assert(typeof v[k]==='boolean','native_bool');return v;
}
export function receipt(v,mode,role){
 const k=['schema','mode','role','pid','parentPid','argumentsVerified','cwdVerified','heapDifferenceVerified','environmentReferenceCaptured','environmentCompared','environmentEqual','execArgvEmpty'];
 assert(v&&Object.keys(v).length===k.length&&Object.keys(v).every(x=>k.includes(x)),'receipt_schema');assert(v.schema==='sec002-node-receipt-v1'&&v.mode===mode&&v.role===role,'receipt_plan');
 for(const f of ['pid','parentPid'])assert(Number.isInteger(v[f])&&v[f]>0&&v[f]<=0xffffffff,'receipt_pid');
 for(const f of k.slice(5))assert(typeof v[f]==='boolean','receipt_bool');return v;
}
export function classify(n,receipts,collector){
 native(n);assert(Array.isArray(receipts)&&receipts.length===3,'receipt_count');receipts.forEach((r,i)=>receipt(r,n.Mode,['root','child','grand'][i]));
 const pids=receipts.map(r=>r.pid);let passed=new Set(pids).size===3&&receipts[1].parentPid===pids[0]&&receipts[2].parentPid===pids[1]&&n.ReadyCount===3&&n.Active===0&&n.CleanupComplete&&n.StdoutEof&&n.StderrEof&&!n.FallbackJobKill&&n.Failure===null;
 passed&&=receipts.every(r=>r.argumentsVerified&&r.cwdVerified&&r.heapDifferenceVerified&&r.execArgvEmpty);
 if(n.Mode==='handoff'){
  passed&&=n.Status===0&&!n.Forced&&!n.TimedOut&&!n.ExpectedTimeout&&!n.CollectorOnlyKilled&&n.StdoutBytes===1048576&&n.StderrBytes===1048576&&n.StdoutPattern&&n.StderrPattern&&receipts.every(r=>n.Phase==='baseline'?r.environmentReferenceCaptured&&!r.environmentCompared&&!r.environmentEqual:!r.environmentReferenceCaptured&&r.environmentCompared&&r.environmentEqual);
  if(n.Phase==='wrapped'){assert(collector,'collector_missing');observation(Buffer.from(JSON.stringify(collector)+'\n'));passed&&=collector.state==='finished'&&collector.outerExited&&collector.outerExitCode===0&&collector.collectorCoverageComplete&&!collector.faultObserved&&!collector.cleanupForced&&!collector.drainTimedOut&&collector.remainingActiveProcesses===0&&collector.rootPid===pids[0];}
  else passed&&=collector===null&&n.Pid===pids[0];
 }else{
  passed&&=n.Phase==='wrapped'&&n.StdoutBytes===0&&n.StderrBytes===0&&n.ActiveBeforeControl===4&&receipts.every(r=>!r.environmentReferenceCaptured&&!r.environmentCompared&&!r.environmentEqual)&&collector===null;
  if(n.Mode==='timeout')passed&&=n.Status===125&&n.ExpectedTimeout&&n.Forced&&n.TimedOut&&!n.CollectorOnlyKilled;
  else passed&&=n.Status===126&&n.CollectorOnlyKilled&&!n.Forced&&!n.TimedOut&&!n.ExpectedTimeout;
 }
 return {schema:'sec002-node-case-v1',mode:n.Mode,phase:n.Phase,passed:!!passed,native:n,receipts,collector,collectorFinalExpected:n.Mode==='handoff'&&n.Phase==='wrapped',argvCwdEnvironmentCompared:n.Mode==='handoff'&&n.Phase==='wrapped',stackImplemented:false,productExecuted:false};
}
function read(p,cap){assert(fs.statSync(p).size<=cap,'capacity');return JSON.parse(fs.readFileSync(p,'utf8'));}
if(process.argv[1]===import.meta.filename){try{
 const [cwd,nativePath,output]=process.argv.slice(2),n=native(read(nativePath,8192));
 const receipts=[],missingReceipts=[],inputErrors=[];
 for(const role of ['root','child','grand']){try{receipts.push(receipt(read(path.join(cwd,role+'.'+n.Phase+'.receipt.json'),2048),n.Mode,role));}catch{missingReceipts.push(role);}}
 let collector=null,collectorMissing=false;
 if(n.Mode==='handoff'&&n.Phase==='wrapped'){try{collector=observation(Buffer.from(JSON.stringify(read(path.join(cwd,'capture.json'),65536))+'\n'));}catch{collectorMissing=true;}}
 if(missingReceipts.length)inputErrors.push('receipt_missing_or_invalid');if(collectorMissing)inputErrors.push('collector_missing_or_invalid');
 let v;
 if(inputErrors.length){v={schema:'sec002-node-case-v1',mode:n.Mode,phase:n.Phase,passed:false,native:n,receipts,collector,collectorFinalExpected:n.Mode==='handoff'&&n.Phase==='wrapped',argvCwdEnvironmentCompared:false,stackImplemented:false,productExecuted:false};}
 else v=classify(n,receipts,collector);
 v.complete=inputErrors.length===0&&n.Active!==0xffffffff;v.missingReceipts=missingReceipts;v.inputErrors=inputErrors;
 fs.writeFileSync(output,JSON.stringify(v)+'\n',{flag:'wx'});if(!v.passed)process.exitCode=1;
}catch{process.stderr.write('fixed_node_fixture_validation_failed\n');process.exitCode=1;}}
