import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import {
  mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import packageJson from '../package.json' with { type: 'json' };
import { isAuditPendingPhaseStatus } from './todo-audit-pending.mjs';
import { observeStartIdentityEpochMs } from './runtime-os-observation.mjs';

/**
 * The version of the code in THIS process. A daemon loads its modules once at
 * startup and keeps serving them, so installing a new package does not change
 * what the running daemon serves. The daemon reports the version it started
 * with; anything else is code that has already been replaced on disk.
 */
export const TODO_DASHBOARD_CODE_VERSION = packageJson.version;

const REGISTRY_SCHEMA = 'lattice.todo_dashboard_registry.v1';
const DAEMON_SCHEMA = 'lattice.todo_dashboard_daemon.v1';
const DEFAULT_PORT = 0;
// 登録簿の鮮度窓＝dashboard配信寿命。heartbeatの露出判定へ流用しない（ADR 0165）。
export const TODO_DASHBOARD_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCK_ATTEMPTS = 240;
const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 30_000;

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function runtimeDir(env) {
  const configured = env.LATTICE_DASHBOARD_RUNTIME_DIR;
  return typeof configured === 'string' && path.isAbsolute(configured)
    ? configured : path.join(homedir(), '.lattice', 'dashboard');
}

function paths(env) {
  const root = runtimeDir(env);
  return {
    root,
    registry: path.join(root, 'projects.json'),
    descriptor: path.join(root, 'daemon.json'),
    daemons: path.join(root, 'daemons'),
    lock: path.join(root, 'registry.lock'),
    startupLock: path.join(root, 'daemon-start.lock'),
  };
}

function validEntry(entry) {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).sort().join(',') === 'display_name,last_seen_at,project_id,repo_root,session_id'
    && identifier(entry.project_id) && identifier(entry.session_id)
    && typeof entry.display_name === 'string' && entry.display_name.length > 0
    && typeof entry.repo_root === 'string' && path.isAbsolute(entry.repo_root)
    && Number.isFinite(Date.parse(entry.last_seen_at));
}

/** active taskが無くても、監査の判断待ち・棄却後なら公開工程から消してはいけない。 */
export function todoDashboardMemberNeedsVisibility(member) {
  return Array.isArray(member?.phases)
    && member.phases.some(({ status }) => isAuditPendingPhaseStatus(status));
}

function validateRegistry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== REGISTRY_SCHEMA || !Array.isArray(value.projects)
    || !value.projects.every(validEntry)) {
    const error = new Error('dashboard registry schema invalid');
    error.code = 'DASHBOARD_REGISTRY_INVALID';
    throw error;
  }
  const ids = new Set();
  for (const entry of value.projects) {
    if (ids.has(entry.project_id)) {
      const error = new Error(`dashboard project duplicate: ${entry.project_id}`);
      error.code = 'DASHBOARD_REGISTRY_INVALID';
      throw error;
    }
    ids.add(entry.project_id);
  }
  return value;
}

async function readJson(ref, missing) {
  let bytes;
  try { bytes = await readFile(ref, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return missing;
    throw error;
  }
  try { return JSON.parse(bytes); } catch {
    const error = new Error(`invalid JSON: ${ref}`);
    error.code = 'DASHBOARD_REGISTRY_INVALID';
    throw error;
  }
}

async function atomicJson(ref, value) {
  const temporary = `${ref}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, ref);
}

async function withLock(lockRef, action) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(lockRef, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      try { return await action(); } finally {
        await handle.close();
        await rm(lockRef, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(await readFile(lockRef, 'utf8'));
        let alive = Number.isSafeInteger(lock.pid) && lock.pid > 0;
        if (alive) {
          try { process.kill(lock.pid, 0); } catch { alive = false; }
        }
        if (!alive || Date.now() - Date.parse(lock.created_at) > LOCK_STALE_MS) {
          await rm(lockRef, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  const error = new Error('dashboard registry lock timeout');
  error.code = 'DASHBOARD_REGISTRY_BUSY';
  throw error;
}

export async function readActiveTodoDashboardProjects({ env = process.env, now = Date.now() } = {}) {
  const ref = paths(env).registry;
  const document = validateRegistry(await readJson(ref, { schema: REGISTRY_SCHEMA, projects: [] }));
  return document.projects.filter((entry) => now - Date.parse(entry.last_seen_at) <= TODO_DASHBOARD_STALE_MS)
    .sort((left, right) => left.display_name.localeCompare(right.display_name, 'ja')
      || left.project_id.localeCompare(right.project_id, 'en'));
}

export async function readVisibleTodoDashboardProjects({
  env = process.env, now = Date.now(), projectHasActiveRun,
} = {}) {
  if (typeof projectHasActiveRun !== 'function') throw new TypeError('projectHasActiveRun required');
  const ref = paths(env).registry;
  const document = validateRegistry(await readJson(ref, { schema: REGISTRY_SCHEMA, projects: [] }));
  const visible = [];
  for (const entry of document.projects) {
    if (now - Date.parse(entry.last_seen_at) <= TODO_DASHBOARD_STALE_MS
      || await projectHasActiveRun(entry)) visible.push(entry);
  }
  return visible.sort((left, right) => left.display_name.localeCompare(right.display_name, 'ja')
    || left.project_id.localeCompare(right.project_id, 'en'));
}

/**
 * この端末がいま実際に配信しているproject id。登録簿を自分で数え直さず、配信している
 * dashboard daemon自身へ問い、loopback healthをdescriptorと突き合わせてから答える。
 * daemonが居ない・応答しない・descriptorと食い違う時はnull——「配信していない」であって
 * 「0件を配信している」ではない。
 *
 * 公開面へ在ると名乗る集合は、実際に配信している集合と同じでなければならない。別々に
 * 数えると必ずずれる（2026-08-11に実測）。daemonはactive runを持つprojectを配信し続ける
 * のに、hub heartbeatは登録簿の2時間staleだけを見て0件と判断し、送信ごと省いた。中身は
 * 配信できるのに、公開面からは端末ごとofflineになる——障害と見分けがつかない消え方をする。
 */
export async function readServedTodoDashboardProjectIds({
  env = process.env, fetchImpl = fetch, timeoutMs = 2_000,
} = {}) {
  let descriptor;
  try { descriptor = await readJson(paths(env).descriptor, null); } catch { return null; }
  if (!validDaemonDescriptor(descriptor)) return null;
  let body;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${descriptor.port}/__lattice/health`,
      { signal: AbortSignal.timeout(timeoutMs) });
    body = response.status === 200 ? await response.json() : null;
  } catch { return null; }
  if (body?.schema !== 'lattice.todo_dashboard_health.v1' || body.pid !== descriptor.pid
    || body.port !== descriptor.port || !Array.isArray(body.project_ids)) return null;
  return body.project_ids.filter(identifier).sort((left, right) => left.localeCompare(right, 'en'));
}

/**
 * 見るのはrepo_root directoryの存在だけ。`.lattice`の有無で判定すると、storeを持たない
 * 生きたrepoまで登録簿から消える。ENOENT／ENOTDIR以外のerrorは「消えた証拠」ではないので
 * 生存扱いのまま残す——判定できない相手を消す方が損害が大きい。
 */
async function repoRootPresent(ref) {
  try { return (await stat(ref)).isDirectory(); } catch (error) {
    return !['ENOENT', 'ENOTDIR'].includes(error?.code);
  }
}

export async function registerTodoDashboardActivity({
  repoRoot, projectId, displayName = projectId, sessionId, env = process.env,
  now = new Date(), adopt = false,
}) {
  if (!path.isAbsolute(repoRoot) || !identifier(projectId) || !identifier(sessionId)
    || typeof displayName !== 'string' || displayName.length === 0 || displayName !== displayName.trim()
    || !(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof adopt !== 'boolean') {
    throw new TypeError('dashboard activity is invalid');
  }
  const canonicalRoot = await realpath(repoRoot);
  const refs = paths(env);
  await mkdir(refs.root, { recursive: true, mode: 0o700 });
  const pruned = [];
  await withLock(refs.lock, async () => {
    const current = validateRegistry(await readJson(refs.registry, { schema: REGISTRY_SCHEMA, projects: [] }));
    const existing = current.projects.find((entry) => entry.project_id === projectId);
    if (existing !== undefined && existing.repo_root !== canonicalRoot && !adopt) {
      const error = new Error('project id is already owned by another canonical root');
      error.code = 'PROJECT_ROOT_CONFLICT';
      // 公開・CLI errorへlocal absolute pathを運ばない。project_idだけで人と機械が
      // 衝突対象を特定でき、registry bytesはこの分岐より後で一切変更しない。
      error.detail = {
        project_id: projectId,
        next_action: 'lattice todo dashboard adopt --json',
      };
      throw error;
    }
    // 死んだ登録を落とす機会はここしかない。登録は全sessionが必ず通る一点であり、
    // 掃除を「人がコマンドを叩いた時」に置くと、誰も叩かないので永久に積み上がる。
    const projects = [];
    for (const entry of current.projects) {
      if (entry.project_id === projectId) continue;
      if (await repoRootPresent(entry.repo_root)) projects.push(entry);
      else pruned.push(entry.project_id);
    }
    projects.push({ project_id: projectId, display_name: displayName, repo_root: canonicalRoot,
      session_id: sessionId, last_seen_at: now.toISOString() });
    projects.sort((left, right) => left.project_id.localeCompare(right.project_id, 'en'));
    pruned.sort((left, right) => left.localeCompare(right, 'en'));
    await atomicJson(refs.registry, { schema: REGISTRY_SCHEMA, projects });
  });
  return { projectId, displayName, repoRoot: canonicalRoot, sessionId, adopted: adopt, pruned };
}

/**
 * 登録簿から1件を明示的に外す唯一の入口。対象repoが既に消えていても叩けるよう、
 * storeもdaemonも経由しない。該当が無いのは暗黙の成功にしない——「消したつもり」で
 * 別のproject_idが残り続ける状態を、成功の応答で隠すことになる。
 */
export async function removeTodoDashboardProject({ projectId, env = process.env }) {
  if (!identifier(projectId)) throw new TypeError('dashboard project id is invalid');
  const refs = paths(env);
  await mkdir(refs.root, { recursive: true, mode: 0o700 });
  await withLock(refs.lock, async () => {
    const current = validateRegistry(await readJson(refs.registry, { schema: REGISTRY_SCHEMA, projects: [] }));
    const projects = current.projects.filter((entry) => entry.project_id !== projectId);
    if (projects.length === current.projects.length) {
      const error = new Error('dashboard project is not registered');
      error.code = 'PROJECT_NOT_REGISTERED';
      // 公開・CLI errorへlocal absolute pathを運ばない。project_idだけで対象を特定できる。
      error.detail = { project_id: projectId };
      throw error;
    }
    await atomicJson(refs.registry, { schema: REGISTRY_SCHEMA, projects });
  });
  return { projectId, removed: true };
}

/** 配信元rootを移す唯一の明示入口。通常activity登録はこのflagを立てない。 */
export async function adoptTodoDashboardActivity(options) {
  return registerTodoDashboardActivity({ ...options, adopt: true });
}

function validDaemonDescriptor(descriptor) {
  return descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor)
    && Object.keys(descriptor).sort().join(',') === 'pid,port,schema,started_at'
    && descriptor.schema === DAEMON_SCHEMA
    && Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0
    && Number.isSafeInteger(descriptor.port) && descriptor.port > 0 && descriptor.port <= 65_535
    && typeof descriptor.started_at === 'string' && Number.isFinite(Date.parse(descriptor.started_at));
}

async function daemonAttestation(descriptor, { timeoutMs = 2_000 } = {}) {
  if (!validDaemonDescriptor(descriptor)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/__lattice/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return null;
    const body = await response.json();
    if (body?.schema !== 'lattice.todo_dashboard_health.v1' || body.pid !== descriptor.pid
      || !Array.isArray(body.project_ids)) return null;
    const keys = Object.keys(body).sort().join(',');
    // 'legacy' means "alive, but serving code we have already replaced" — the
    // caller starts a replacement and stops it. A daemon that predates the
    // version field, or one still running an older package, is exactly that.
    if (keys === 'pid,port,project_ids,schema,version' && body.port === descriptor.port) {
      return body.version === TODO_DASHBOARD_CODE_VERSION ? 'current' : 'legacy';
    }
    if (keys === 'pid,port,project_ids,schema' && body.port === descriptor.port) return 'legacy';
    if (keys === 'pid,project_ids,schema') return 'legacy';
    return null;
  } catch { return null; }
}

async function daemonHealthy(descriptor) {
  return await daemonAttestation(descriptor) === 'current';
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * descriptorはdaemonが起動してから書かれるため、同じdaemonならOSが観測したbirthは
 * descriptorのstarted_atより後にならない。後ならpidは別processへ再利用済みである。
 * macOS/Linuxのlstartは秒精度だが、丸められたbirthが同じdaemonのdescriptor時刻を後回る
 * ことはない。比較はstrict greaterだけにし、同じ秒のPID再利用は確定不能として拒否する。
 * OS adapterがbirthを時刻として解釈できない時は不明のままにし、health遅延中daemonを
 * 重複起動しない従来の拒否へ戻す。
 */
async function descriptorPidWasReused(descriptor, { observeProcessStartEpochMs }) {
  try {
    const observedAt = await observeProcessStartEpochMs(descriptor.pid);
    const recordedAt = Date.parse(descriptor.started_at);
    return Number.isFinite(observedAt) && Number.isFinite(recordedAt) && observedAt > recordedAt;
  } catch {
    return false;
  }
}

function daemonRecordRef(refs, pid) {
  return path.join(refs.daemons, `${pid}.json`);
}

/**
 * daemonごとの記録。descriptorは1枚しか無いので、そこから落ちたdaemonは二度と誰にも
 * 観測されず、生きたまま不死になる（2026-08-03に2重起動を実測）。descriptorの所有者は
 * 起動側のままにして、pidごとの記録だけをdaemon自身に書かせる——記録があれば、
 * descriptorを失っても後続の起動が見つけられる。
 */
async function readDaemonRecords(refs) {
  let names;
  try { names = await readdir(refs.daemons); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    if (!/^[1-9][0-9]{0,9}\.json$/u.test(name)) continue;
    const ref = path.join(refs.daemons, name);
    let record = null;
    try { record = JSON.parse(await readFile(ref, 'utf8')); } catch { record = null; }
    // 壊れた記録、file名のpidと中身が食い違う記録は、誰の生死も語れないので捨てる。
    // 記録はatomicJsonで置かれるので、読み手が書きかけを見ることはない。
    if (!validDaemonDescriptor(record) || `${record.pid}.json` !== name) {
      await rm(ref, { force: true });
      continue;
    }
    records.push(record);
  }
  return records;
}

/**
 * 死んだpidの記録を落とす。全daemonが必ず通る起動時に呼ぶので、登録簿は
 * 「生きているdaemon＋前回の起動以降に死んだ分」までしか育たない。
 * keepはhealth応答で生存を確認済みのdaemon——process.kill(0)より強い証拠を
 * 既に持っているので、その記録は生死判定に掛けない。
 */
async function sweepDaemonRecords(refs, { isProcessAlive, keep = null }) {
  const live = [];
  for (const record of await readDaemonRecords(refs)) {
    if (record.pid === keep || await isProcessAlive(record.pid)) live.push(record);
    else await rm(daemonRecordRef(refs, record.pid), { force: true });
  }
  return live;
}

async function awaitDaemonStopped(descriptor, { isProcessAlive, deadline }) {
  for (;;) {
    const alive = await isProcessAlive(descriptor.pid);
    const stillServing = await daemonAttestation(descriptor) !== null;
    if (!alive && !stillServing) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 相手が既に死んでいるのは停止の成功であって失敗ではない。 */
function signalIfPresent(signalProcess, pid, signal) {
  try { signalProcess(pid, signal); } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function requestDaemonShutdown(descriptor) {
  try {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/__lattice/shutdown`, {
      method: 'POST', signal: AbortSignal.timeout(500),
    });
    return response.status === 202;
  } catch {
    return false;
  }
}

async function stopAttestedLegacyDaemon(descriptor, {
  signalProcess = process.kill, isProcessAlive = processIsAlive, timeoutMs = 3_000,
} = {}) {
  const attestation = await daemonAttestation(descriptor);
  if (attestation !== 'legacy') {
    if (!await isProcessAlive(descriptor.pid) && attestation === null) return;
    const error = new Error('legacy dashboard daemon attestation was lost before signal');
    error.code = 'DASHBOARD_LEGACY_ATTESTATION_LOST';
    throw error;
  }
  if (!await requestDaemonShutdown(descriptor)) signalProcess(descriptor.pid, 'SIGTERM');
  if (await awaitDaemonStopped(descriptor, { isProcessAlive, deadline: Date.now() + timeoutMs })) return;
  const error = new Error('legacy dashboard daemon did not stop');
  error.code = 'DASHBOARD_LEGACY_STOP_FAILED';
  throw error;
}

/**
 * descriptorの外に居るdaemonを止める。signalを送るのは、いま再認証を通った相手だけ——
 * 応答しないpidへ送れば、pid再利用で無関係のprocessを殺しうる。認証できない生存pidは
 * 記録を残したまま見送り、次の起動が判定し直す。
 * 認証を通った相手はLattice自身のdaemonなので、SIGTERMで死ななければSIGKILLへ上げる。
 * 置換前のlegacy停止と1つの関数へ畳まない——あちらは認証を失ったこと自体がerror
 * （版を入れ替える確証が要る）で、こちらは見送ってよい。契約が違う。
 */
async function stopStrayDaemon(descriptor, {
  signalProcess = process.kill, isProcessAlive = processIsAlive, timeoutMs = 3_000,
} = {}) {
  if (await daemonAttestation(descriptor) === null) return false;
  if (!await requestDaemonShutdown(descriptor)) signalIfPresent(signalProcess, descriptor.pid, 'SIGTERM');
  const half = Math.ceil(timeoutMs / 2);
  if (await awaitDaemonStopped(descriptor, { isProcessAlive, deadline: Date.now() + half })) return true;
  signalIfPresent(signalProcess, descriptor.pid, 'SIGKILL');
  if (await awaitDaemonStopped(descriptor, {
    isProcessAlive, deadline: Date.now() + (timeoutMs - half),
  })) return true;
  const error = new Error('stray dashboard daemon did not stop');
  error.code = 'DASHBOARD_ORPHAN_STOP_FAILED';
  throw error;
}

/**
 * descriptorが指すdaemon以外を掃除する。呼ぶのはdescriptorの整合が確立した後だけ——
 * 失敗経路で呼べば、可用性を守るrollback契約より先に生きたdaemonを消してしまう。
 */
async function reapStrayDaemons(refs, keepPid, { signalProcess, isProcessAlive, timeoutMs }) {
  for (const record of await sweepDaemonRecords(refs, { isProcessAlive, keep: keepPid })) {
    if (record.pid === keepPid) continue;
    if (await stopStrayDaemon(record, { signalProcess, isProcessAlive, timeoutMs })) {
      await rm(daemonRecordRef(refs, record.pid), { force: true });
    }
  }
}

/** descriptorを失った時、登録簿の生存daemonから配信を続けている1つを選ぶ。 */
async function adoptableDaemon(records, { attestationTimeoutMs }) {
  let legacy = null;
  for (const record of records) {
    const attestation = await daemonAttestation(record, { timeoutMs: attestationTimeoutMs });
    if (attestation === 'current') return { record, attestation };
    if (attestation === 'legacy' && legacy === null) legacy = { record, attestation };
  }
  return legacy;
}

async function stopSpawnedReplacement(child, descriptor, {
  isProcessAlive = processIsAlive, timeoutMs = 3_000,
} = {}) {
  const stopped = async () => {
    const exited = child.exitCode !== null || child.signalCode !== null
      || !await isProcessAlive(child.pid);
    return exited && await daemonAttestation(descriptor) === null;
  };
  if (!await requestDaemonShutdown(descriptor)) child.kill('SIGTERM');
  let deadline = Date.now() + Math.ceil(timeoutMs / 2);
  while (Date.now() < deadline) {
    if (await stopped()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  deadline = Date.now() + Math.floor(timeoutMs / 2);
  while (Date.now() < deadline) {
    if (await stopped()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const error = new Error('replacement dashboard daemon rollback did not stop');
  error.code = 'DASHBOARD_REPLACEMENT_ROLLBACK_FAILED';
  throw error;
}

function currentDaemonRecord(port) {
  return { schema: DAEMON_SCHEMA, pid: process.pid, port,
    started_at: new Date().toISOString() };
}

export async function writeTodoDashboardDaemonRecord({ port, env = process.env }) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new TypeError('daemon port invalid');
  const refs = paths(env);
  await mkdir(refs.daemons, { recursive: true, mode: 0o700 });
  const record = currentDaemonRecord(port);
  await atomicJson(daemonRecordRef(refs, process.pid), record);
  return record;
}

export async function writeTodoDashboardDaemonDescriptor({ port, env = process.env }) {
  const refs = paths(env);
  // 直接descriptorを公開する呼出面でも、孤児を再発見できるdaemon固有記録を先に置く。
  const record = await writeTodoDashboardDaemonRecord({ port, env });
  await atomicJson(refs.descriptor, record);
}

/** 自分の記録だけを消す。descriptorは起動側が所有するので、死ぬ側からは触らない。 */
export async function forgetTodoDashboardDaemonRecord({ env = process.env } = {}) {
  await rm(daemonRecordRef(paths(env), process.pid), { force: true });
}

export async function ensureTodoDashboardDaemon({ env = process.env, spawnDaemon = spawn,
  signalProcess = process.kill, isProcessAlive = processIsAlive, startupTimeoutMs = 120_000,
  legacyStopTimeoutMs = 3_000, replacementIsProcessAlive = processIsAlive,
  attestationTimeoutMs = 2_000, strayStopTimeoutMs = 3_000,
  observeProcessStartEpochMs = observeStartIdentityEpochMs } = {}) {
  const refs = paths(env);
  await mkdir(refs.root, { recursive: true, mode: 0o700 });
  // 掃除と孤児の始末の機会はここしかない。daemonの起動は全daemonが必ず通る一点であり、
  // 誰かがコマンドを叩くのを待つ形にすると、記録は誰にも掃除されず積み上がる。
  const reap = (keepPid) => reapStrayDaemons(refs, keepPid,
    { signalProcess, isProcessAlive, timeoutMs: strayStopTimeoutMs });
  return withLock(refs.startupLock, async () => {
    const existing = await readJson(refs.descriptor, null);
    const existingAttestation = await daemonAttestation(existing, { timeoutMs: attestationTimeoutMs });
    if (existingAttestation === 'current') {
      await reap(existing.pid);
      return existing;
    }
    if (validDaemonDescriptor(existing) && existingAttestation === null
      && await isProcessAlive(existing.pid)
      && !await descriptorPidWasReused(existing, { observeProcessStartEpochMs })) {
      const error = new Error('dashboard daemon is alive but temporarily unresponsive');
      error.code = 'DASHBOARD_DAEMON_UNRESPONSIVE';
      throw error;
    }
    let legacy = existingAttestation === 'legacy' ? existing : null;
    if (legacy === null) {
      // descriptorの指す先が居ない。登録簿に配信中のdaemonが残っているなら、2本目を
      // 建てずに引き取る——descriptorだけが失われた場合の直接の修理である。
      const adopted = await adoptableDaemon(
        (await sweepDaemonRecords(refs, { isProcessAlive })).filter(({ pid }) => pid !== existing?.pid),
        { attestationTimeoutMs },
      );
      if (adopted !== null) {
        // 引き取った相手は生きて応答しているので、descriptorの不変条件を満たす。
        await atomicJson(refs.descriptor, adopted.record);
        if (adopted.attestation === 'current') {
          await reap(adopted.record.pid);
          return adopted.record;
        }
        legacy = adopted.record;
      }
    }
    const portText = env.LATTICE_DASHBOARD_PORT;
    const configuredPort = typeof portText === 'string' && /^(?:0|[1-9][0-9]{0,4})$/u.test(portText)
      && Number(portText) <= 65_535 ? Number(portText) : DEFAULT_PORT;
    const port = legacy === null ? configuredPort : 0;
    if (legacy === null) await rm(refs.descriptor, { force: true });
    const child = spawnDaemon(process.execPath, [path.resolve(import.meta.dirname, '../bin/lattice-dashboard.mjs')], {
      detached: true,
      stdio: 'ignore',
      env: { ...env, LATTICE_DASHBOARD_RUNTIME_DIR: refs.root, LATTICE_DASHBOARD_PORT: String(port) },
    });
    child.unref();
    // 起動待ちの終わりを固定秒数で決めない。それは機械の速さの見積りになり、遅い側
    // へ外すとpublish済みのcodeを載せたdaemonへ入れ替われず、公開面が古いまま取り
    // 残される。daemonはdescriptorを書く前に登録済み全projectのstoreを読むので、
    // 起動時間はproject数とstore規模に比例する（実測: 8 projectで約51秒）。
    // 待つのはspawnした子が生きている間だけとし、死んだら即座に諦める。
    // startupTimeoutMsは無反応な子に対するbackstopであって起動時間の上限ではない。
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const descriptor = typeof child.pid === 'number'
        ? await readJson(daemonRecordRef(refs, child.pid), null) : null;
      const healthy = await daemonHealthy(descriptor);
      if (!healthy && typeof child.pid === 'number'
        && !await replacementIsProcessAlive(child.pid)) break;
      if (healthy && descriptor.pid !== legacy?.pid) {
        if (legacy !== null) {
          try {
            await stopAttestedLegacyDaemon(legacy, {
              signalProcess, isProcessAlive, timeoutMs: legacyStopTimeoutMs,
            });
          } catch (error) {
            await stopSpawnedReplacement(child, descriptor, { isProcessAlive: replacementIsProcessAlive });
            throw error;
          }
        }
        await atomicJson(refs.descriptor, descriptor);
        await reap(descriptor.pid);
        return descriptor;
      }
    }
    child.kill?.('SIGTERM');
    if (legacy === null) await rm(refs.descriptor, { force: true });
    const error = new Error('dashboard daemon did not become ready');
    error.code = 'DASHBOARD_DAEMON_UNAVAILABLE';
    throw error;
  });
}

export async function ensureTodoDashboardActivity(options) {
  const registered = await registerTodoDashboardActivity(options);
  const daemon = await ensureTodoDashboardDaemon({ env: options.env });
  const deadline = Date.now() + 2_500;
  let visible = false;
  while (!visible && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/__lattice/health`, {
        signal: AbortSignal.timeout(500),
      });
      const health = response.status === 200 ? await response.json() : null;
      visible = health?.schema === 'lattice.todo_dashboard_health.v1'
        && health.port === daemon.port
        && health.project_ids?.includes(registered.projectId);
    } catch { visible = false; }
    if (!visible) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!visible) {
    const error = new Error('registered project did not become visible');
    error.code = 'DASHBOARD_PROJECT_UNAVAILABLE';
    throw error;
  }
  return { ...registered, host: '127.0.0.1', port: daemon.port,
    url: `http://127.0.0.1:${daemon.port}/projects/${encodeURIComponent(registered.projectId)}/` };
}
