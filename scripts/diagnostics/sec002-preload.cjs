'use strict';
// Identical observation in both arms. Never serialize arbitrary argv or env.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { isMainThread, threadId } = require('node:worker_threads');
const directory = process.env.LATTICE_DIAGNOSTIC_EVENTS;
if (!directory) throw new Error('diagnostic event directory missing');
const flags = ['--liftoff-only', '--disable-warning=ExperimentalWarning'];
function emit(event) {
  fs.appendFileSync(path.join(directory, `${process.pid}-${threadId}.jsonl`), JSON.stringify(event) + '\n');
}
emit({event:'runtime', pid:process.pid, threadId, isMainThread,
  node:process.versions.node, arch:process.arch, platform:process.platform,
  parentPid:process.ppid, entryKind:/lattice-sensor\.js$/.test(process.argv[1]??'')?'sensor-cli':
    /parse-worker\.js$/.test(process.argv[1]??'')?'parse-worker':'other',
  execArgv:flags.filter(flag=>process.execArgv.includes(flag)),
  otherExecArgvCount:process.execArgv.filter(flag=>!flags.includes(flag)).length,
  wasmRelaunchedPresent:!!process.env.LATTICE_SENSOR_WASM_RELAUNCHED,
  noRelaunchPresent:!!process.env.LATTICE_SENSOR_NO_RELAUNCH,
  kernelDisabled:process.env.LATTICE_SENSOR_KERNEL==='0',
  explicitKernelPathPresent:!!process.env.LATTICE_SENSOR_KERNEL_PATH,
  parserPool:process.env.LATTICE_SENSOR_PARSE_WORKERS==='1'?'one':'default'});
const originalLoad = Module._load;
let observed = false;
Module._load = function(request, parent, isMain) {
  const result = originalLoad.apply(this, arguments);
  if (!observed && parent && /[/\\]extraction[/\\]kernel[/\\](?:index|loader)\.js$/.test(parent.filename)
      && result && typeof result.kernelSupports === 'function') {
    observed = true;
    const supports = result.kernelSupports;
    result.kernelSupports = function(language) {
      const supported = supports.apply(this, arguments);
      if (language === 'typescript') emit({event:'kernel-selection', pid:process.pid, threadId,
        language:'typescript', nativeSupported:!!supported,
        selection:supported?'native':'wasm'});
      return supported;
    };
  }
  return result;
};
