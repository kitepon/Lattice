import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = '3300d770b31e06a1b701e547c10d4899429e4024';
const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
if (execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==source) throw new Error('source mismatch');
if (execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim()) throw new Error('tracked source dirty');
if (process.env.LATTICE_SENSOR_PARSE_WORKERS) throw new Error('ambient parser override present');
fs.mkdirSync(output,{recursive:true});
const preload = fileURLToPath(new URL('./sec002-preload.cjs',import.meta.url)).split(path.sep).join('/');
const cli = path.join(root,'sensor/node_modules/vitest/vitest.mjs');
const results=[];
for (let repeat=1;repeat<=3;repeat++) for (const arm of ['default','one']) {
  const directory=path.join(output,`${repeat}-${arm}`);
  fs.mkdirSync(directory,{recursive:true});
  const env={...process.env,LATTICE_DIAGNOSTIC_EVENTS:directory};
  // Identical observer, inherited by CLI re-exec and worker threads.
  env.NODE_OPTIONS=[env.NODE_OPTIONS,`--require="${preload}"`].filter(Boolean).join(' ');
  if (arm==='one') env.LATTICE_SENSOR_PARSE_WORKERS='1';
  else delete env.LATTICE_SENSOR_PARSE_WORKERS;
  const report=path.join(directory,'vitest.json');
  const log=fs.openSync(path.join(directory,'test.log'),'w');
  const result=spawnSync(process.execPath,[cli,'run','--maxWorkers=4','--minWorkers=1',
    '__tests__/index-command.test.ts','--reporter=json',`--outputFile=${report}`],
    {cwd:path.join(root,'sensor'),env,stdio:['ignore',log,log],timeout:180000,windowsHide:true});
  fs.closeSync(log);
  let counts=null;
  try {
    const parsed=JSON.parse(fs.readFileSync(report,'utf8'));
    counts={total:parsed.numTotalTests,passed:parsed.numPassedTests,failed:parsed.numFailedTests,
      pending:parsed.numPendingTests,testResults:parsed.testResults.length};
  } catch { /* Recorded as incomplete below, never passed. */ }
  const events=fs.readdirSync(directory).filter(name=>name.endsWith('.jsonl'))
    .flatMap(name=>fs.readFileSync(path.join(directory,name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
  const observations={runtime:events.filter(e=>e.event==='runtime').length,
    sensorCli:events.filter(e=>e.event==='runtime' && e.entryKind==='sensor-cli' && e.isMainThread).length,
    native:events.filter(e=>e.event==='kernel-selection' && e.selection==='native').length,
    wasm:events.filter(e=>e.event==='kernel-selection' && e.selection==='wasm').length};
  const observed=observations.runtime>0 && observations.sensorCli>0 && observations.native+observations.wasm>0;
  const complete=observed && counts?.total===6 && counts.pending===0 && counts.testResults===1
    && counts.passed+counts.failed===6;
  const entry={repeat,arm,status:result.status,signal:result.signal,
    spawnErrorCode:result.error?.code??null,counts,observations,complete,diagnosticOnly:true};
  results.push(entry);
  console.log(JSON.stringify(entry));
}
const summary={source,diagnosticOnly:true,acceptanceFull:false,results};
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
if (execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim()) throw new Error('tracked source changed');
process.exitCode=results.every(r=>r.complete && r.status===0 && r.counts.failed===0)?0:1;
