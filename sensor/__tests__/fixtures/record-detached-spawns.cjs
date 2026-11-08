/**
 * Preloaded with `--require` into the `serve --mcp` launchers a test starts, so
 * the test learns the original identity of every detached candidate they spawn
 * (#1773). Racing launchers may each spawn one; the losers exit on their own
 * once they see the winner's lock, but on a loaded machine one can still be
 * starting when the test tears down. Written synchronously at spawn time, so
 * the pid is on disk before the launcher can be stopped. Candidates inherit
 * the preload through `process.execArgv`; they spawn nothing detached.
 */
const childProcess = require('child_process');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { observeDashboardProcess } = require('../../../src/dashboard-process-control.mjs');

function recordCandidate(child, log, observe = observeDashboardProcess) {
  const token = randomUUID();
  const append = (event) => fs.appendFileSync(log, `${JSON.stringify({ token, pid: child.pid, ...event })}\n`);
  child.once('exit', (code, signal) => append({ kind: 'child-exit', code, signal }));
  append({ kind: 'spawn' });
  // The parent alone samples birth; the candidate starts without a new wait.
  Promise.resolve(observe(child.pid)).then((identity) => {
    setImmediate(() => {
      // Unix libuv reaps a batch before dispatching all of its exit callbacks.
      if (child.exitCode !== null || child.signalCode !== null) return;
      append(identity?.birth
        ? { kind: 'identity', birth: identity.birth }
        : { kind: 'capture-unavailable', reason: identity?.observation ?? 'birth-unavailable' });
    });
  }, (error) => {
    setImmediate(() => {
      if (child.exitCode === null && child.signalCode === null) {
        append({ kind: 'capture-unavailable', reason: error.code ?? 'observation-error' });
      }
    });
  });
}

module.exports = { recordCandidate };

const log = process.env.CG_TEST_SPAWN_LOG;
if (log) {
  const spawn = childProcess.spawn;
  childProcess.spawn = function recordDetached(...args) {
    const child = spawn.apply(this, args);
    const options = args.find((arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg));
    if (options && options.detached && child.pid) recordCandidate(child, log);
    return child;
  };
}
