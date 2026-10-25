import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 'lattice.dashboard_lifecycle.v1';
export const LIFECYCLE_MAX_RUNS = 64;
export const LIFECYCLE_MAX_BYTES = 16 * 1024;
const PHASES = new Set(['spawn', 'import', 'registry', 'store', 'listen', 'ready',
  'periodic_sync', 'empty_shutdown', 'shutdown_request', 'sync_failed', 'store_read_failed',
  'cleanup_failed', 'close_failed', 'close', 'closed']);
const RUN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const WINDOWS_REPLACE_WAIT_MS = 500;
const REPLACE_MAX_ATTEMPTS = 32;

export function lifecycleError(code) {
  return Object.assign(new Error(code), { code,
    detail: { reason: code.toLowerCase(), next_action: 'lattice todo dashboard ensure --json' } });
}

function directory(root) { return path.join(root, 'lifecycle'); }
function terminationTime(run) {
  return run.exit_observed_at ?? run.observer_loss_observed_at ?? run.started_at;
}
function reference(root, id) {
  if (!RUN_ID.test(id)) throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID');
  return path.join(directory(root), `${id}.json`);
}

async function checkOwned(ref, type) {
  const info = await lstat(ref);
  if (info.isSymbolicLink() || (type === 'directory' ? !info.isDirectory() : !info.isFile())
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw lifecycleError('DASHBOARD_LIFECYCLE_UNSAFE_PATH');
  }
  return info;
}

export async function prepareLifecycleDirectory(root) {
  // The runtime root is already private and owned by the dashboard registry.
  await checkOwned(root, 'directory');
  await mkdir(directory(root), { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await checkOwned(directory(root), 'directory');
  // Interrupted atomic writes contain no body data either, but must not grow forever.
  const pending = /^(?:[a-f0-9-]{36}\.json|ensure\.json)\.([1-9][0-9]*)\.[a-f0-9-]{36}\.tmp$/u;
  for (const name of await readdir(directory(root))) {
    const match = pending.exec(name);
    if (!match) continue;
    let alive = true;
    try { process.kill(Number(match[1]), 0); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      alive = false;
    }
    if (!alive) {
      const ref = path.join(directory(root), name);
      await checkOwned(ref, 'file');
      await rm(ref);
    }
  }
}

export async function readLifecycleRuns(root) {
  try { await checkOwned(directory(root), 'directory'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const name of (await readdir(directory(root))).sort()) {
    if (!name.endsWith('.json') || !RUN_ID.test(name.slice(0, -5))) continue;
    const ref = path.join(directory(root), name);
    const info = await checkOwned(ref, 'file');
    if (info.size > LIFECYCLE_MAX_BYTES) throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID');
    const handle = await open(ref, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let value;
    try { value = JSON.parse(await handle.readFile('utf8')); }
    catch { throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID'); }
    finally { await handle.close(); }
    if (value?.schema !== SCHEMA || value.run_id !== name.slice(0, -5)
      || !['active', 'closed', 'supervisor_lost'].includes(value.state)) {
      throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID');
    }
    runs.push(value);
  }
  return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** Publish only after a real atomic replacement; Windows delete-sharing can be transient. */
async function publishLifecycleJson(ref, bytes) {
  const parent = path.dirname(ref);
  await checkOwned(parent, 'directory');
  // At most 64 live writers can race this check, so even orphaned temporary files
  // have a finite bound. Refuse another write rather than discard an active run.
  if ((await readdir(parent)).length >= 256) throw lifecycleError('DASHBOARD_LIFECYCLE_CAPACITY');
  if (Buffer.byteLength(bytes) > LIFECYCLE_MAX_BYTES) throw lifecycleError('DASHBOARD_LIFECYCLE_CAPACITY');
  try { await checkOwned(ref, 'file'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${ref}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  // Failed private temporaries stay bounded for dead-writer cleanup. Never delete
  // the old receipt to make replacement succeed, or let cleanup mask its error.
  const deadline = performance.now() + WINDOWS_REPLACE_WAIT_MS;
  let attempts = 0;
  for (;;) {
    await checkOwned(parent, 'directory');
    await checkOwned(temporary, 'file');
    try { await checkOwned(ref, 'file'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    attempts++;
    try {
      await rename(temporary, ref);
      return;
    } catch (error) {
      const busy = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!busy) throw error;
      if (performance.now() >= deadline || attempts >= REPLACE_MAX_ATTEMPTS) {
        const failure = lifecycleError('DASHBOARD_LIFECYCLE_PUBLISH_FAILED');
        failure.cause = error;
        failure.detail = { ...failure.detail, operation: 'atomic_replace',
          fs_code: error.code, attempts, temporary_retained: true };
        throw failure;
      }
      await new Promise((resolve) => setTimeout(resolve,
        Math.min(10 * 2 ** Math.min(attempts - 1, 3), 50, Math.max(1, deadline - performance.now()))));
    }
  }
}

export async function writeLifecycleRun(root, run) {
  await publishLifecycleJson(reference(root, run.run_id), `${JSON.stringify(run)}\n`);
}

/** Call under the existing dashboard startup lock, before spawning anything. */
export async function createLifecycleRun(root, version) {
  await prepareLifecycleDirectory(root);
  const runs = await readLifecycleRuns(root);
  while (runs.length >= LIFECYCLE_MAX_RUNS) {
    const oldest = runs.filter((run) => run.state !== 'active'
      && !run.child_at_reconciliation?.startsWith('present'))
      .sort((a, b) => terminationTime(a).localeCompare(terminationTime(b)))[0];
    if (!oldest) throw lifecycleError('DASHBOARD_LIFECYCLE_CAPACITY');
    const index = runs.findIndex((run) => run.run_id === oldest.run_id);
    const [old] = runs.splice(index, 1);
    await rm(reference(root, old.run_id));
  }
  const run = { schema: SCHEMA, run_id: randomUUID(), version, platform: process.platform,
    state: 'active', started_at: new Date().toISOString(), supervisor: null, child: null,
    phase: 'spawn', ready_at: null, exit_observed_at: null,
    observed_exit: { status: 'unknown' }, termination_request: null,
    stderr: { bytes: 0, hashed_bytes: 0, sha256: null, truncated: false }, events: [] };
  await writeLifecycleRun(root, run);
  return run;
}

export function recordLifecyclePhase(run, phase) {
  if (!PHASES.has(phase) || phase === run.phase) return false;
  run.phase = phase;
  if (['empty_shutdown', 'shutdown_request', 'sync_failed', 'cleanup_failed', 'close_failed'].includes(phase)) {
    run.exit_stage = phase;
  }
  const at = new Date().toISOString();
  if (phase === 'ready' && run.ready_at === null) run.ready_at = at;
  if (['store_read_failed', 'sync_failed', 'cleanup_failed', 'close_failed'].includes(phase)) {
    run.last_failure_observed = { at, phase };
  }
  run.events.push({ at, phase });
  if (run.events.length > 64) run.events.shift();
  return true;
}

/** No fabricated exit time/value when the observer itself disappeared. */
export async function reconcileLifecycleRuns(root, observeIdentity) {
  const runs = await readLifecycleRuns(root);
  for (const run of runs) {
    if (run.state === 'closed') continue;
    const supervisor = run.supervisor === null ? null : await observeIdentity(run.supervisor.pid);
    if (run.state === 'active' && supervisor !== null && supervisor.birth !== null
      && supervisor.birth === run.supervisor.birth) continue;
    // Unknown birth cannot establish observer loss. Do not overwrite its receipt.
    if (run.state === 'active' && supervisor !== null
      && (supervisor.birth === null || run.supervisor.birth === null)) continue;
    const previousState = run.state;
    const previousPresence = run.child_at_reconciliation;
    run.state = 'supervisor_lost';
    run.observer_loss_observed_at ??= new Date().toISOString();
    const child = run.child === null ? null : await observeIdentity(run.child.pid);
    run.child_at_reconciliation = run.child === null ? 'not_observed' : child === null ? 'absent'
      : child.birth !== null && child.birth === run.child.birth ? 'present_identity_matched'
        : child.birth !== null && run.child.birth !== null ? 'absent_identity_reused'
          : 'present_identity_unconfirmed';
    run.observed_exit = { status: 'unknown', reason: 'supervisor_lost' };
    if (previousState !== run.state || previousPresence !== run.child_at_reconciliation) {
      run.child_presence_observed_at = new Date().toISOString();
      await writeLifecycleRun(root, run);
    }
  }
  return runs;
}

/** One bounded decision receipt, serialized by the registry's existing startup lock. */
export async function recordDashboardEnsureDecision(root, decision, childPid) {
  if (!['reuse_current', 'adopt_current', 'replace_legacy', 'start_missing',
    'pid_reused', 'alive_unresponsive'].includes(decision)) throw new TypeError('invalid dashboard decision');
  await prepareLifecycleDirectory(root);
  const matching = (await readLifecycleRuns(root)).filter((run) => run.child?.pid === childPid
    && (run.state === 'active' || run.child_at_reconciliation?.startsWith('present'))).at(-1);
  const supervision = childPid === null ? 'not_started' : matching?.state === 'active' ? 'supervised'
    : matching?.state === 'supervisor_lost' ? 'supervisor_lost' : 'legacy_unsupervised';
  const ref = path.join(directory(root), 'ensure.json');
  await publishLifecycleJson(ref, `${JSON.stringify({ schema: 'lattice.dashboard_ensure.v1',
    observed_at: new Date().toISOString(), decision, child_pid: childPid,
    supervision, run_id: matching?.run_id ?? null })}\n`);
}

export async function readDashboardLifecycleStatus(root) {
  const runs = await readLifecycleRuns(root);
  const terminal = runs.filter((run) => run.state !== 'active').sort((a, b) =>
    terminationTime(a).localeCompare(terminationTime(b)));
  let ensure = null;
  try {
    const ref = path.join(directory(root), 'ensure.json');
    const info = await checkOwned(ref, 'file');
    if (info.size > LIFECYCLE_MAX_BYTES) throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID');
    try { ensure = JSON.parse(await readFile(ref, 'utf8')); }
    catch { throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID'); }
    if (ensure.schema !== 'lattice.dashboard_ensure.v1') throw lifecycleError('DASHBOARD_LIFECYCLE_INVALID');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { schema: 'lattice.dashboard_lifecycle_status.v1',
    last_ensure: ensure, active: runs.filter((run) => run.state === 'active'),
    last_termination: terminal.at(-1) ?? null };
}
