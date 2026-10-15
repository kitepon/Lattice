// Dedicated, pinned fixture. No arbitrary script/target or public context values.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const TAIL=['','space value','q"uote','slash\\','space end\\','two\\\\"q','雪の白 こんにちは'];
export const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function environmentDigest(env){return digest(Object.keys(env).filter(k=>k.toUpperCase()!=='_NO_DEBUG_HEAP').sort().map(k=>[k,env[k]]));}
export function compareReceipt(expected,actual){return ['argv','cwd','env','execArgv','node'].every(k=>expected[k]===actual[k]);}
export function makeReceipt(argv,cwd,env,execArgv,node){return {argv:digest(argv),cwd:digest(cwd),env:environmentDigest(env),execArgv:digest(execArgv),node:digest(node)};}
const self=fileURLToPath(import.meta.url);
function main(){
 const [mode,role,...tail]=process.argv.slice(2),roles=['root','child','grand'];
 if(!['handoff','timeout','collector-kill'].includes(mode)||!roles.includes(role)||JSON.stringify(tail)!==JSON.stringify(TAIL))throw Error('fixed_arguments');
 const cwd=process.cwd(),config=JSON.parse(fs.readFileSync(path.join(cwd,'context.json'),'utf8'));
 if(config.mode!==mode||!['baseline','wrapped'].includes(config.phase)||config.cwd!==cwd||config.node!==process.execPath||config.version!==process.version||config.arch!==process.arch||config.platform!==process.platform||process.execArgv.length!==0)throw Error('fixed_context');
 const heapKey=Object.keys(process.env).find(k=>k.toUpperCase()==='_NO_DEBUG_HEAP');
 if(config.phase==='baseline'?heapKey!==undefined:!heapKey||process.env[heapKey]!=='1')throw Error('heap_difference');
 const actual=makeReceipt(process.argv,cwd,process.env,process.execArgv,process.execPath);
 const expectedPath=path.join(cwd,role+'.baseline-private.json');
 if(config.phase==='baseline')fs.writeFileSync(expectedPath,JSON.stringify(actual),{flag:'wx'});
 else if(mode==='handoff'&&!compareReceipt(JSON.parse(fs.readFileSync(expectedPath,'utf8')),actual))throw Error('inheritance_mismatch');
 // Public-safe booleans only; no hashes of env, argv or cwd leave quarantine.
 const receipt={schema:'sec002-node-receipt-v1',mode,role,pid:process.pid,parentPid:process.ppid,argumentsVerified:true,cwdVerified:true,heapDifferenceVerified:true,environmentReferenceCaptured:mode==='handoff'&&config.phase==='baseline',environmentCompared:mode==='handoff'&&config.phase==='wrapped',environmentEqual:mode==='handoff'&&config.phase==='wrapped',execArgvEmpty:true};
 fs.writeFileSync(path.join(cwd,role+'.'+config.phase+'.receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx'});
 if(mode==='handoff'){
  const amount=role==='grand'?524288:262144;
  fs.writeSync(1,Buffer.alloc(amount,0x53));fs.writeSync(2,Buffer.alloc(amount,0x45));
 }
 if(role!=='grand'){
  const child=spawn(process.execPath,[self,mode,roles[roles.indexOf(role)+1],...TAIL],{cwd,stdio:['ignore','inherit','inherit'],windowsHide:true});
  child.on('error',()=>{process.exitCode=93;});
  // No exit wait: inherited pipes and own job must keep descendant coverage observable.
  child.unref();
  if(mode==='handoff'){const waiting=setInterval(()=>{if(fs.existsSync(path.join(cwd,roles[roles.indexOf(role)+1]+'.'+config.phase+'.receipt.json')))clearInterval(waiting);},5);}
 }
 if(mode==='handoff'){
  if(role==='grand')setTimeout(()=>{},250);
 }else setInterval(()=>{},1000);
}
if(process.argv[1]&&path.resolve(process.argv[1])===self){try{main();}catch{process.exitCode=91;}}
