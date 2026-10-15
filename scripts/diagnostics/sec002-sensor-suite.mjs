import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source='3300d770b31e06a1b701e547c10d4899429e4024';
const root=path.resolve(process.argv[2]);
const output=path.resolve(process.argv[3]);
const assertSource=()=>{
  if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==source) throw Error('source mismatch');
  if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim()) throw Error('tracked source dirty');
};
assertSource();
if(process.version!=='v24.20.0'||process.arch!=='x64'||process.platform!=='win32') throw Error('runtime differs from six-case diagnostic');
if(process.env.LATTICE_SENSOR_PARSE_WORKERS) throw Error('ambient parser override present');
const preload=fileURLToPath(new URL('./sec002-preload.cjs',import.meta.url)).split(path.sep).join('/');
const cli=path.join(root,'sensor/node_modules/vitest/vitest.mjs');
fs.mkdirSync(output,{recursive:true});
const results=[];
const inventories=[];
let progress={stage:'initializing'};
function save(){
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({source,diagnosticOnly:true,
    acceptanceFull:false,progress,inventoryEqual:inventories.length===2 && JSON.stringify(inventories[0])===JSON.stringify(inventories[1]),results},null,2)+'\n');
}
save();
for(const arm of ['default','one']) {
  progress={arm,stage:'build'};save();
  const directory=path.join(output,arm);
  fs.mkdirSync(directory,{recursive:true});
  const env={...process.env,LATTICE_DIAGNOSTIC_EVENTS:directory};
  env.NODE_OPTIONS=[env.NODE_OPTIONS,`--require="${preload}"`].filter(Boolean).join(' ');
  if(arm==='one') env.LATTICE_SENSOR_PARSE_WORKERS='1';
  else delete env.LATTICE_SENSOR_PARSE_WORKERS;
  // Clean build in BOTH arms removes the globalSetup stamp in BOTH arms.
  // Each unchanged globalSetup therefore performs the same additional build.
  const buildLog=fs.openSync(path.join(directory,'build.log'),'w');
  const build=spawnSync('npm --prefix sensor run build',{cwd:root,env,shell:true,
    stdio:['ignore',buildLog,buildLog],windowsHide:true});
  fs.closeSync(buildLog);
  if(build.status!==0){results.push({arm,stage:'build',status:build.status,signal:build.signal,
    spawnErrorCode:build.error?.code??null,complete:false});save();continue;}
  progress={arm,stage:'sensor-suite'};save();
  const report=path.join(directory,'vitest.json');
  const log=fs.openSync(path.join(directory,'test.log'),'w');
  // No 180s harness timeout: original product timeout settings are unchanged.
  // The unchanged diagnostic workflow's 25-minute job budget bounds both arms.
  const result=spawnSync(process.execPath,[cli,'run','--maxWorkers=4','--minWorkers=1',
    '--reporter=json',`--outputFile=${report}`],{cwd:path.join(root,'sensor'),env,
    stdio:['ignore',log,log],windowsHide:true});
  fs.closeSync(log);
  let counts=null;
  let inventory=[];
  try {
    const parsed=JSON.parse(fs.readFileSync(report,'utf8'));
    counts={total:parsed.numTotalTests,passed:parsed.numPassedTests,failed:parsed.numFailedTests,
      pending:parsed.numPendingTests,todo:parsed.numTodoTests,testFiles:parsed.testResults.length};
    inventory=parsed.testResults.flatMap(file=>file.assertionResults.map(test=>
      [path.relative(root,file.name).split(path.sep).join('/'),test.fullName])).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }catch{/* Missing or partial reports remain incomplete. */}
  inventories.push(inventory);
  fs.writeFileSync(path.join(directory,'inventory.json'),JSON.stringify(inventory)+'\n');
  let parseErrors=0;
  const events=fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl')).flatMap(name=>
    fs.readFileSync(path.join(directory,name),'utf8').split('\n').filter(Boolean).flatMap(line=>{
      try{return [JSON.parse(line)];}catch{parseErrors++;return [];}
    }));
  const observations={runtime:events.filter(e=>e.event==='runtime').length,
    sensorCli:events.filter(e=>e.event==='runtime'&&e.entryKind==='sensor-cli'&&e.isMainThread).length,
    native:events.filter(e=>e.event==='kernel-selection'&&e.selection==='native').length,
    wasm:events.filter(e=>e.event==='kernel-selection'&&e.selection==='wasm').length,parseErrors};
  const observed=observations.runtime>0&&observations.sensorCli>0&&observations.native+observations.wasm>0&&parseErrors===0;
  const complete=observed&&counts?.total===5142&&counts.testFiles===320&&inventory.length===counts.total;
  results.push({arm,status:result.status,signal:result.signal,spawnErrorCode:result.error?.code??null,
    counts,observations,complete,diagnosticOnly:true});
  console.log(JSON.stringify(results.at(-1)));
  assertSource();save();
}
progress={stage:'finished'};
const inventoryEqual=inventories.length===2&&JSON.stringify(inventories[0])===JSON.stringify(inventories[1]);
const skipEqual=results.length===2&&results[0].counts?.pending===results[1].counts?.pending
  &&results[0].counts?.todo===results[1].counts?.todo;
save();
process.exitCode=inventoryEqual&&skipEqual&&results.length===2&&results.every(r=>r.complete&&r.status===0&&r.counts.failed===0)?0:1;
