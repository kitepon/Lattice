// Diagnostic-only preload. It writes fixture call boundaries; it is not shipped
// as a runtime workaround. Each worker uses its own flushed trace file.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { threadId, parentPort, workerData } = require('node:worker_threads');
const directory = process.env.LATTICE_AV_TRACE_DIR;
if (directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${process.pid}-${threadId}.jsonl`);
  let sequence = 0;
  const seen = new WeakMap();
  function record(event, details = {}) {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), monoNs: process.hrtime.bigint().toString(), pid: process.pid,
      threadId, sequence: ++sequence, event, ...details }) + '\n');
  }
  const heapProbe = process.env.LATTICE_AV_HEAP_PROBE ? require(process.env.LATTICE_AV_HEAP_PROBE) : null;
  if (heapProbe && threadId === 0 && process.env.LATTICE_AV_DUMP_HELPER) {
    if (heapProbe.configure(process.env.LATTICE_AV_DUMP_HELPER, directory) !== true) throw new Error('Dump helper prearm failed');
    record('dump-helper-prearmed');
  }
  let heapPhase = 0;
  let wasmWindowUsed = false;
  function checkHeap(label) {
    if (!heapProbe) return;
    const phase = ++heapPhase;
    record('heap-check-enter', { phase, label });
    const valid = heapProbe.check(phase);
    record('heap-check-return', { phase, label, valid });
    if (valid !== true) throw new Error('Native heap check did not return true');
  }
  if (heapProbe) globalThis.__latticeAvCheckHeap = checkHeap;
  function wrap(object, name, label) {
    if (!object || typeof object[name] !== 'function') return;
    const names = seen.get(object) || new Set();
    if (names.has(name)) return;
    names.add(name); seen.set(object, names);
    const original = object[name];
    try {
      object[name] = function (...args) {
        const call = sequence + 1;
        record('enter', { call, label, ...(label === 'Worker.terminate' ? {
          targetThreadId: this.threadId, stack: new Error().stack } : {}) });
        try {
          checkHeap(`${label}.before`);
          const window = label === 'WebAssembly.instantiate' && workerData?.heapWindowGate && !wasmWindowUsed;
          if (window) {
            wasmWindowUsed = true;
            record('wasm-window-wait');
            const gate = new Int32Array(workerData.heapWindowGate);
            if (Atomics.wait(gate, 0, 0, 15000) === 'timed-out') throw new Error('WASM window gate exceeded 15s');
            record('wasm-window-released');
          }
          const result = Reflect.apply(original, this, args);
          if (window) {
            record('wasm-window-native-request-return', { asynchronous: Boolean(result?.then) });
            parentPort.postMessage({ type: 'diagnostic-wasm-window-pending', asynchronous: Boolean(result?.then) });
          }
          if (label === 'Worker.terminate') checkHeap(`${label}.request-return`);
          if (result && typeof result.then === 'function') {
            return result.then(value => { if (window) record('wasm-window-fulfilled'); checkHeap(`${label}.after`); record('return', { call, label,
              ...(label === 'Worker.terminate' ? { exitCode: value } : {}) }); return value; },
              error => { if (window) record('wasm-window-rejected'); record('throw', { call, label, message: String(error) }); throw error; });
          }
          checkHeap(`${label}.after`);
          record('return', { call, label, ...(label === 'module.enableCompileCache' ? {
            cacheStatus: result?.status, cacheDirectory: result?.directory || null,
            cacheMessage: result?.message || null } : {}) });
          return result;
        } catch (error) {
          record('throw', { call, label, message: String(error) });
          throw error;
        }
      };
    } catch (error) { record('instrumentation-unavailable', { label, message: String(error) }); }
  }
  record('boot', { argv: process.argv, execArgv: process.execArgv,
    node: process.versions.node, v8: process.versions.v8, platform: process.platform,
    arch: process.arch, relaunched: process.env.LATTICE_SENSOR_WASM_RELAUNCHED || null,
    compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE || null });
  checkHeap('preload.boot');
  // Observe the product's own call; do not enable the cache from the probe.
  wrap(Module, 'enableCompileCache', 'module.enableCompileCache');
  for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming']) {
    wrap(WebAssembly, name, `WebAssembly.${name}`);
  }
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const result = Reflect.apply(originalLoad, this, [request, parent, isMain]);
    if (request === 'node:sqlite') {
      record('module', { request });
      for (const name of ['prepare', 'exec', 'close']) wrap(result.DatabaseSync?.prototype, name, `DatabaseSync.${name}`);
      for (const name of ['run', 'get', 'all', 'iterate']) wrap(result.StatementSync?.prototype, name, `StatementSync.${name}`);
    }
    if (request === 'web-tree-sitter') {
      record('module', { request });
      for (const name of ['parse', 'delete', 'setLanguage']) wrap(result.Parser?.prototype, name, `Parser.${name}`);
      wrap(result.Language, 'load', 'Language.load');
      wrap(result.Tree?.prototype, 'delete', 'Tree.delete');
    }
    if (request === 'worker_threads' || request === 'node:worker_threads') {
      wrap(result.Worker?.prototype, 'terminate', 'Worker.terminate');
    }
    return result;
  };
  process.on('exit', code => record('exit', { code }));
}
