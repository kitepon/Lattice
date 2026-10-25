// This module deliberately has no dashboard, bridge or sensor dependency.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createLifecycleRun, lifecycleError, readLifecycleRuns, recordLifecyclePhase,
  writeLifecycleRun } from './dashboard-lifecycle-journal.mjs';
import { observeDashboardProcess, observedDashboardExit,
  terminateOwnedWindowsDashboard } from './dashboard-process-control.mjs';

function notify(message) {
  if (process.connected) process.send(message, () => {});
}

/** The sole owner of one child: spawn, wait, forward stop, persist receipts. */
export async function superviseDashboard({ executable = process.execPath, args, env,
  root, runId, graceMs = 3_000 }) {
  const run = (await readLifecycleRuns(root)).find((value) => value.run_id === runId);
  if (!run || run.state !== 'active') throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID');
  run.supervisor = await observeDashboardProcess(process.pid);
  await writeLifecycleRun(root, run);
  // libuv assigns non-detached Windows children to its parent's kill-on-close Job.
  // The observer-loss contract keeps this child serving after supervisor death.
  const child = spawn(executable, args, { env, windowsHide: true, detached: process.platform === 'win32',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.once('spawn', () => { run.child_spawn_observed_at = new Date().toISOString(); });
  recordLifecyclePhase(run, 'import');
  const digest = createHash('sha256');
  let writeQueue = Promise.resolve();
  let persistenceFailure = null;
  let stopTimer = null;
  let controlPending = Promise.resolve();
  let finished = false;
  const persist = () => {
    writeQueue = writeQueue.then(() => writeLifecycleRun(root, run));
    writeQueue.catch((error) => {
      if (persistenceFailure) return;
      persistenceFailure = error;
      notify({ type: 'supervisor_error', code: 'DASHBOARD_LIFECYCLE_WRITE_FAILED' });
      requestStop('receipt_failure');
    });
    return writeQueue;
  };
  const requestStop = (reason, force = false) => {
    if (finished || (run.termination_request !== null && !force)) return;
    if (run.termination_request === null) {
      run.termination_request = { at: new Date().toISOString(), reason, mechanism: 'ipc_shutdown',
        child: run.child, os_request: null };
      recordLifecyclePhase(run, 'shutdown_request');
      if (!persistenceFailure) persist();
      if (child.connected) child.send({ type: 'dashboard_shutdown' }, () => {});
    }
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      if (finished) return;
      controlPending = (async () => {
        if (process.platform === 'win32') {
          const result = await terminateOwnedWindowsDashboard(run.child);
          run.termination_request.os_request = { mechanism: 'TerminateProcess',
            requested_exit_code: result.requested_exit_code,
            api_succeeded: result.termination_requested,
            actual_exit_code: result.actual_exit_code, source: result.source };
        } else {
          run.termination_request.os_request = { mechanism: 'child_signal', signal: 'SIGKILL',
            api_succeeded: child.kill('SIGKILL') };
        }
        if (!persistenceFailure) await persist();
      })();
      controlPending.catch((error) => {
        notify({ type: 'supervisor_error', code: error.code ?? 'DASHBOARD_CHILD_CONTROL_FAILED' });
        // Cannot authenticate/control the child: leave it available, with unknown exit.
        process.exitCode = 1;
      });
    }, force ? 0 : graceMs);
  };
  const term = () => requestStop('supervisor_SIGTERM');
  const interrupt = () => requestStop('supervisor_SIGINT');
  const parentMessage = (message) => {
    if (message?.type === 'dashboard_supervisor_stop') requestStop('owner_stop', message.force === true);
  };
  process.on('SIGTERM', term);
  process.on('SIGINT', interrupt);
  process.on('message', parentMessage);
  // A parent IPC disconnect is expected when ensure exits. The child remains serving.
  process.channel?.unref();
  child.stderr.on('data', (bytes) => {
    run.stderr.bytes = Math.min(Number.MAX_SAFE_INTEGER, run.stderr.bytes + bytes.length);
    const remaining = 65_536 - run.stderr.hashed_bytes;
    if (remaining > 0) {
      const part = bytes.subarray(0, remaining);
      digest.update(part); run.stderr.hashed_bytes += part.length;
    }
    run.stderr.truncated = run.stderr.bytes > run.stderr.hashed_bytes;
  });
  child.on('message', (message) => {
    if (message?.type === 'dashboard_phase' && recordLifecyclePhase(run, message.phase)) persist();
  });
  let spawnFailure = false;
  child.once('error', () => { spawnFailure = true; });
  const ended = new Promise((resolve) => child.once('close', (code, signal) =>
    resolve({ code, signal, observedAt: new Date().toISOString() })));
  if (Number.isSafeInteger(child.pid)) {
    run.child = await observeDashboardProcess(child.pid) ?? { pid: child.pid, birth: null };
    await persist();
    notify({ type: 'dashboard_child_started', pid: child.pid, run_id: runId });
  }
  const exit = await ended;
  finished = true;
  clearTimeout(stopTimer);
  try { await controlPending; } catch { /* Typed control failure was delivered above; exit is independently observed. */ }
  run.stderr.sha256 = digest.digest('hex');
  run.exit_observed_at = exit.observedAt;
  run.state = 'closed';
  run.observed_exit = spawnFailure ? { status: 'unknown', reason: 'spawn_failed' }
    : observedDashboardExit(exit.code, exit.signal);
  if (process.platform === 'win32' && run.termination_request?.os_request?.api_succeeded) {
    run.observed_exit.origin = 'owned_terminate_request';
  }
  // phase is the last child/control stage, not an invented successful close.
  try {
    if (persistenceFailure) throw persistenceFailure;
    await persist();
    notify({ type: 'dashboard_child_exited', pid: child.pid, code: exit.code, signal: exit.signal });
  } finally {
    process.off('SIGTERM', term); process.off('SIGINT', interrupt);
    process.off('message', parentMessage);
    if (process.connected) process.disconnect();
  }
  process.exitCode = run.observed_exit.status !== 'observed' ? 1
    : process.platform === 'win32' ? run.observed_exit.uint32
      : run.observed_exit.code ?? 1;
  return run;
}

/** ChildProcess-compatible seam used by the existing registry readiness/rollback. */
export async function spawnSupervisedDashboard(executable, args, options) {
  const root = options.env.LATTICE_DASHBOARD_RUNTIME_DIR;
  const run = await createLifecycleRun(root, options.version);
  const supervisor = spawn(executable,
    [path.resolve(import.meta.dirname, '../bin/lattice-dashboard-supervisor.mjs'), root], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...options.env, LATTICE_DASHBOARD_LIFECYCLE_RUN: run.run_id },
    });
  // The daemon command is fixed by the product entry, never accepted from env/IPC.
  const facade = { pid: null, exitCode: null, signalCode: null, lifecycleRunId: run.run_id,
    unref() { supervisor.unref(); supervisor.channel?.unref(); },
    kill(signal = 'SIGTERM') {
      if (supervisor.connected) supervisor.send({ type: 'dashboard_supervisor_stop',
        force: signal === 'SIGKILL' }, () => {});
      return supervisor.connected;
    },
  };
  supervisor.once('exit', (code, signal) => {
    facade.supervisorExit = { code, signal };
    if (facade.exitCode === null && facade.signalCode === null) {
      facade.observationError = lifecycleError('DASHBOARD_SUPERVISOR_LOST');
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      facade.kill(); reject(lifecycleError('DASHBOARD_SUPERVISOR_START_TIMEOUT'));
    }, 15_000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    supervisor.once('error', fail);
    supervisor.once('exit', () => fail(lifecycleError('DASHBOARD_SUPERVISOR_UNAVAILABLE')));
    supervisor.on('message', (message) => {
      if (message?.type === 'dashboard_child_exited' && message.pid === facade.pid) {
        facade.exitCode = message.code; facade.signalCode = message.signal;
      }
      if (message?.type === 'supervisor_error') {
        facade.observationError = lifecycleError(message.code);
        fail(facade.observationError);
      }
      if (message?.type === 'dashboard_child_started' && message.run_id === run.run_id
        && Number.isSafeInteger(message.pid) && message.pid > 0) {
        clearTimeout(timer); facade.pid = message.pid; resolve();
      }
    });
  });
  return facade;
}
