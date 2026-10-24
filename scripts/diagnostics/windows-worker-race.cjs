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
if (workerData?.raceWorker) {
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
    if (variant === 'pool') {
      const checkHeap = label => globalThis.__latticeAvCheckHeap?.(label);
      checkHeap('pool.before-load');
      const { ParseWorkerPool } = require('../../sensor/dist/extraction/parse-pool.js');
      checkHeap('pool.after-load');
      const garbage = [];
      const pressure = setInterval(() => {
        garbage.push(Array.from({ length: 8192 }, (_, n) => ({ n, value: String(n) })));
        if (garbage.length > 30) garbage.shift();
      }, 1);
      try {
        for (let round = 0; round < rounds; round++) {
          const pool = new ParseWorkerPool({ languages: ['typescript'], size: 4,
            workerScriptPath: path.resolve(__dirname, '../../sensor/dist/extraction/parse-worker.js') });
          checkHeap(`pool.${round}.before-prewarm`);
          pool.prewarm();
          checkHeap(`pool.${round}.after-prewarm`);
          try {
            const result = await pool.requestParse({ filePath: 'owned.ts',
              content: 'export function hello() { return 42; }', language: 'typescript' });
            log('pool-parsed', { round, nodes: result.nodes.length });
            checkHeap(`pool.${round}.after-parse`);
          } finally {
            log('pool-destroy-enter', { round });
            checkHeap(`pool.${round}.before-destroy`);
            await pool.destroy();
            checkHeap(`pool.${round}.after-destroy`);
            log('pool-destroy-return', { round });
          }
        }
      } finally { clearInterval(pressure); }
      log('completed', { rounds, variant });
      checkHeap('pool.completed');
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
