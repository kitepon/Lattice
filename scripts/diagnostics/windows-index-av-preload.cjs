// Diagnostic-only preload. It writes fixture call boundaries; it is not shipped
// as a runtime workaround. Each worker uses its own flushed trace file.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { threadId } = require('node:worker_threads');
const directory = process.env.LATTICE_AV_TRACE_DIR;
if (directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${process.pid}-${threadId}.jsonl`);
  let sequence = 0;
  const seen = new WeakMap();
  function record(event, details = {}) {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
      threadId, sequence: ++sequence, event, ...details }) + '\n');
  }
  function wrap(object, name, label) {
    if (!object || typeof object[name] !== 'function') return;
    const names = seen.get(object) || new Set();
    if (names.has(name)) return;
    names.add(name); seen.set(object, names);
    const original = object[name];
    try {
      object[name] = function (...args) {
        const call = sequence + 1;
        record('enter', { call, label });
        try {
          const result = Reflect.apply(original, this, args);
          if (result && typeof result.then === 'function') {
            return result.then(value => { record('return', { call, label }); return value; },
              error => { record('throw', { call, label, message: String(error) }); throw error; });
          }
          record('return', { call, label });
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
    arch: process.arch, relaunched: process.env.LATTICE_SENSOR_WASM_RELAUNCHED || null });
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
