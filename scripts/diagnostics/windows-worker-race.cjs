// Diagnostic reduction for the upstream worker/concurrent-marking hypothesis.
// It loads the real sensor graph in each owned worker, then compares teardown
// while loading with a cooperative full-GC-before-exit control.
const { Worker, parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const variant = process.argv[2] || 'early';
const rounds = Number(process.argv[3] || 5);
const trace = process.env.LATTICE_AV_TRACE_DIR;
function log(event, more = {}) {
  if (trace) fs.appendFileSync(path.join(trace, `race-${process.pid}.jsonl`), JSON.stringify({
    at: new Date().toISOString(), pid: process.pid, event, ...more }) + '\n');
}
if (workerData?.poolWorker) {
  // Same real parse worker, with diagnostic-only natural shutdown on its
  // existing shutdown protocol. No runtime flag or parser behavior changes.
  require('../../sensor/dist/extraction/parse-worker.js');
  parentPort.on('message', message => {
    if (message.type === 'shutdown') parentPort.close();
  });
} else if (workerData?.raceWorker) {
  require(path.resolve(__dirname, '../../sensor/dist/index.js'));
  const garbage = [];
  for (let i = 0; i < 40; i++) garbage.push(Array.from({ length: 4096 }, (_, n) => ({ n, i })));
  parentPort.postMessage({ type: 'loaded' });
  const interval = setInterval(() => {
    garbage.push(Array.from({ length: 4096 }, (_, n) => ({ n, value: String(n) })));
    if (garbage.length > 50) garbage.shift();
  }, 1);
  parentPort.on('message', message => {
    if (message === 'close') {
      clearInterval(interval);
      if (variant === 'settled') {
        // Exposed once at process startup, inherited by workers. Toggling V8's
        // process-global flag from concurrent workers races with other loads.
        if (typeof global.gc !== 'function') throw new Error('GC control was not enabled at startup');
        global.gc();
      }
      if (variant === 'natural' || variant === 'serial') parentPort.close();
      else process.exit(0);
    }
  });
} else {
  (async () => {
    if (variant.startsWith('pool')) {
      const { ParseWorkerPool } = require('../../sensor/dist/extraction/parse-pool.js');
      const garbage = [];
      const pressure = setInterval(() => {
        garbage.push(Array.from({ length: 8192 }, (_, n) => ({ n, value: String(n) })));
        if (garbage.length > 30) garbage.shift();
      }, 1);
      try {
        for (let round = 0; round < rounds; round++) {
          const pool = new ParseWorkerPool({ languages: ['typescript'], size: 4,
            createWorker: () => {
              const worker = variant === 'pool-natural'
                ? new Worker(__filename, { workerData: { poolWorker: true } })
                : new Worker(path.resolve(__dirname, '../../sensor/dist/extraction/parse-worker.js'));
              let readyResolve;
              const ready = new Promise(resolve => { readyResolve = resolve; });
              const gone = new Promise(resolve => worker.once('exit', code => {
                log('pool-worker-exit', { code, targetThreadId: worker.threadId });
                readyResolve(); resolve(code);
              }));
              worker.on('message', message => { if (message.type === 'grammars-loaded') readyResolve(); });
              worker.on('error', () => readyResolve());
              return {
                postMessage: worker.postMessage.bind(worker),
                on: worker.on.bind(worker),
                async terminate() {
                  if (variant === 'pool') return worker.terminate();
                  let timer;
                  try {
                    await Promise.race([ready, new Promise((_, reject) => {
                      timer = setTimeout(() => reject(new Error('pool startup exceeded 15s')), 15000);
                    })]);
                  } finally { clearTimeout(timer); }
                  log('pool-worker-ready-stop', { variant, targetThreadId: worker.threadId });
                  if (variant === 'pool-ready') return worker.terminate();
                  worker.postMessage({ type: 'shutdown' });
                  try {
                    return await Promise.race([gone, new Promise((_, reject) => {
                      timer = setTimeout(() => reject(new Error('pool natural exit exceeded 15s')), 15000);
                    })]);
                  } finally { clearTimeout(timer); }
                }
              };
            } });
          pool.prewarm();
          try {
            const result = await pool.requestParse({ filePath: 'owned.ts',
              content: 'export function hello() { return 42; }', language: 'typescript' });
            log('pool-parsed', { round, nodes: result.nodes.length });
          } finally {
            log('pool-destroy-enter', { round });
            await pool.destroy();
            log('pool-destroy-return', { round });
          }
        }
      } finally { clearInterval(pressure); }
      log('completed', { rounds, variant });
      return;
    }
    for (let round = 0; round < rounds; round++) {
      const runWorker = lane => new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { argv: [variant], workerData: { raceWorker: true } });
        log('created', { round, lane, targetThreadId: worker.threadId });
        const timeout = setTimeout(() => { worker.terminate().then(resolve, reject); }, 15000);
        worker.once('error', error => { clearTimeout(timeout); reject(error); });
        worker.once('exit', code => { clearTimeout(timeout); log('gone', { round, lane, code }); resolve(); });
        if (variant === 'early') {
          worker.once('online', () => {
            setTimeout(() => { log('terminate-loading', { round, lane, targetThreadId: worker.threadId }); void worker.terminate(); }, [20, 50, 100, 200][lane]);
          });
        } else {
          worker.once('message', () => {
            log('loaded-close', { round, lane, targetThreadId: worker.threadId });
            worker.postMessage('close');
          });
        }
      });
      if (variant === 'serial') {
        for (let lane = 0; lane < 4; lane++) await runWorker(lane);
      } else await Promise.all(Array.from({ length: 4 }, (_, lane) => runWorker(lane)));
    }
    log('completed', { rounds, variant });
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
