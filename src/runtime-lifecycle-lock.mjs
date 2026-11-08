import { randomUUID } from 'node:crypto';
import { fsyncDirectory as syncDirectory } from './fs-dir-sync.mjs';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

import { canonicalizeArtifact } from './artifact-contracts.mjs';
import { selfDigest } from './runtime-contracts.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCK_NAME = '.lifecycle.lock';
// Pre-u03 binaries wrote after O_EXCL create; their write finishes well inside this window.
const UNIDENTIFIED_GRACE_MS = 10_000;
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

export class RuntimeLifecycleLockError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'RuntimeLifecycleLockError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) { throw new RuntimeLifecycleLockError(code, detail); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
function digest(value) { return typeof value === 'string' && SHA256.test(value); }
function identifier(value) { return typeof value === 'string' && ID.test(value); }
function timestamp(value) {
  return typeof value === 'string' && TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validProcessStartIdentity(value) {
  return exact(value, ['schema', 'platform', 'pid', 'started_identity', 'identity_digest'])
    && value.schema === 'lattice.process_start_identity.v1'
    && typeof value.platform === 'string' && value.platform.length > 0
    && Number.isSafeInteger(value.pid) && value.pid >= 1
    && typeof value.started_identity === 'string' && value.started_identity.length > 0
    && digest(value.identity_digest)
    && selfDigest(value, 'identity_digest') === value.identity_digest;
}

export function validateRuntimeLifecycleLockArtifact(value) {
  return exact(value, [
    'schema', 'owner_pid', 'owner_process_start_identity', 'session_nonce_digest',
    'operation', 'request_id', 'acquired_at', 'lock_digest',
  ])
    && value.schema === 'lattice.runtime_lifecycle_lock.v1'
    && Number.isSafeInteger(value.owner_pid) && value.owner_pid >= 1
    && validProcessStartIdentity(value.owner_process_start_identity)
    && value.owner_process_start_identity.pid === value.owner_pid
    && digest(value.session_nonce_digest)
    && identifier(value.operation)
    && identifier(value.request_id)
    && timestamp(value.acquired_at)
    && digest(value.lock_digest)
    && selfDigest(value, 'lock_digest') === value.lock_digest;
}

function validateOptions({ lockPath, runDir, sessionNonceDigest, operation, requestId,
  timeoutMs, retryIntervalMs, processStartIdentity, observeProcessStartIdentity, now }) {
  const resolved = lockPath ?? (typeof runDir === 'string' ? path.join(runDir, LOCK_NAME) : null);
  if (typeof resolved !== 'string' || !path.isAbsolute(resolved)
    || !digest(sessionNonceDigest) || !identifier(operation) || !identifier(requestId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0
    || !Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1
    || (processStartIdentity !== null && !validProcessStartIdentity(processStartIdentity))
    || (observeProcessStartIdentity !== null && typeof observeProcessStartIdentity !== 'function')
    || typeof now !== 'function') fail('RUN_LOCK_INVALID', 'lifecycle lock入力不正');
  return resolved;
}

async function defaultObserver(pid) {
  const { observeManagedProcessStartIdentity } = await import('./runtime-managed-supervisor.mjs');
  return observeManagedProcessStartIdentity(pid);
}

class UnidentifiedLock extends Error {
  constructor(info) { super('unidentified lifecycle lock'); this.info = info; }
}

// nlink 2 is the publisher's window between link() and unlinking its temporary.
async function readLockArtifact(lockPath) {
  const info = await lstat(lockPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail('RUN_LOCK_INVALID', 'lifecycle lockがregular fileでない');
  }
  const bytes = await readFile(lockPath);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new UnidentifiedLock(info); }
  if (validateRuntimeLifecycleLockArtifact(value)
    && bytes.toString('utf8') === `${canonicalizeArtifact(value)}\n`) return { value, info };
  // Another schema may be a newer binary's live owner: identified but unsupported, never aged out.
  if (plain(value) && value.schema !== 'lattice.runtime_lifecycle_lock.v1') {
    fail('RUN_LOCK_INVALID', `未対応のlifecycle lock schema: ${String(value.schema)}`);
  }
  throw new UnidentifiedLock(info);
}

/** Empty/torn/invalid bytes name no owner; only their age can show the writer is gone. */
export async function recoverUnidentifiedLock(lockPath, info) {
  if (Date.now() - info.mtimeMs < UNIDENTIFIED_GRACE_MS) return false;
  await removeJudgedEntry(lockPath, info);
  return true;
}

/**
 * Unlink exactly the entry judged by `info` ({dev,ino,size,mtimeMs}); never a newer one.
 * Returns 'removed', 'absent' or 'replaced' (another entry took the path: put back untouched).
 */
export async function removeJudgedEntry(lockPath, info) {
  const quarantine = path.join(path.dirname(lockPath),
    `.${path.basename(lockPath)}.${process.pid}.${randomUUID()}.stale`);
  try { await rename(lockPath, quarantine); }
  catch (error) { if (error?.code === 'ENOENT') return 'absent'; throw error; }
  const moved = await lstat(quarantine);
  if (moved.dev !== info.dev || moved.ino !== info.ino || moved.size !== info.size
    || moved.mtimeMs !== info.mtimeMs) {
    // Not the entry we judged (release + fresh acquire raced stat→rename): put it back untouched.
    try { await link(quarantine, lockPath); }
    catch (error) {
      if (error?.code === 'EEXIST') fail('RUN_LOCK_INVALID', `回収競合artifactを保全した: ${quarantine}`);
      throw error;
    }
    await unlink(quarantine);
    return 'replaced';
  }
  await unlink(quarantine);
  await syncDirectory(path.dirname(lockPath));
  return 'removed';
}

async function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function ownerIsLive(artifact, observer) {
  let observed;
  try { observed = await observer(artifact.owner_pid); }
  catch {
    // observer障害とprocess不在を混同しない。PIDが存在する限りlockを回収しない。
    return pidExists(artifact.owner_pid);
  }
  if (observed === null || observed === undefined) return pidExists(artifact.owner_pid);
  if (!validProcessStartIdentity(observed) || observed.pid !== artifact.owner_pid) {
    fail('RUN_LOCK_INVALID', 'owner process observation不正');
  }
  return observed.identity_digest === artifact.owner_process_start_identity.identity_digest;
}


async function recoverStaleLock(lockPath, expectedDigest) {
  const quarantine = path.join(path.dirname(lockPath),
    `.${path.basename(lockPath)}.${process.pid}.${randomUUID()}.stale`);
  let removeQuarantine = true;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    const moved = await readLockArtifact(quarantine).catch((error) => {
      // Anything but the judged owner (torn, other schema) goes back untouched.
      if (error instanceof UnidentifiedLock || error instanceof RuntimeLifecycleLockError) {
        return { value: { lock_digest: null } };
      }
      throw error;
    });
    if (moved.value.lock_digest !== expectedDigest) {
      // stale判定後に別ownerが取得したfileをrenameしてしまった場合は破棄しない。
      try { await rename(quarantine, lockPath); }
      catch (error) {
        if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
          removeQuarantine = false;
          fail('RUN_LOCK_INVALID', `回収競合artifactを保全した: ${quarantine}`);
        }
        throw error;
      }
      fail('RUN_BUSY', 'lifecycle lock ownerが回収中に変更された');
    }
    await unlink(quarantine);
    await syncDirectory(path.dirname(lockPath));
  } finally {
    if (removeQuarantine) await rm(quarantine, { force: true }).catch(() => {});
  }
}

const TEMPORARY = /^(\d+)\.[0-9a-f-]{36}\.tmp$/u;

async function removeDeadTemporaries(lockPath) {
  const prefix = `${path.basename(lockPath)}.`;
  let names;
  try { names = await readdir(path.dirname(lockPath)); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const pid = name.startsWith(prefix) ? Number(name.slice(prefix.length).match(TEMPORARY)?.[1]) : NaN;
    if (Number.isSafeInteger(pid) && pid !== process.pid && !await pidExists(pid)) {
      await rm(path.join(path.dirname(lockPath), name), { force: true });
    }
  }
}

/** Pre-u03 publication, kept for filesystems without hard links; L2 recovers its crash window. */
async function createLockInPlace(lockPath, artifact) {
  let handle;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(Buffer.from(`${canonicalizeArtifact(artifact)}\n`, 'utf8'));
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    handle = null;
    await unlink(lockPath).catch(() => {});
    throw error;
  } finally {
    if (handle) await handle.close();
  }
  await syncDirectory(path.dirname(lockPath));
  return true;
}

/** The shared path only ever receives complete bytes: write a private temporary, then link it. */
async function createLock(lockPath, artifact, publishLink = link) {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(Buffer.from(`${canonicalizeArtifact(artifact)}\n`, 'utf8'));
      await handle.sync();
    } finally { await handle.close(); }
    try { await publishLink(temporary, lockPath); }
    catch (error) {
      if (error?.code === 'EEXIST') return false;
      if (NO_HARD_LINK.has(error?.code)) return createLockInPlace(lockPath, artifact);
      throw error;
    }
    await unlink(temporary);
    await syncDirectory(path.dirname(lockPath));
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * run lifecycle mutationをdurable owner artifactで直列化する。
 * timeoutMs=0はlive競合を即時RUN_BUSYにする。
 */
export async function acquireRuntimeLifecycleLock({
  runDir = null,
  lockPath = null,
  sessionNonceDigest,
  operation,
  requestId,
  timeoutMs = 0,
  retryIntervalMs = 10,
  processStartIdentity = null,
  observeProcessStartIdentity = null,
  now = () => new Date(),
  publishLink = link, // test seam: filesystems without hard links
} = {}) {
  const resolvedLockPath = validateOptions({ lockPath, runDir, sessionNonceDigest, operation,
    requestId, timeoutMs, retryIntervalMs, processStartIdentity, observeProcessStartIdentity, now });
  const observer = observeProcessStartIdentity ?? defaultObserver;
  const ownerIdentity = processStartIdentity ?? await observer(process.pid);
  if (!validProcessStartIdentity(ownerIdentity) || ownerIdentity.pid !== process.pid) {
    fail('RUN_LOCK_INVALID', 'acquirer process start identity不正');
  }
  const acquiredAt = now();
  if (!(acquiredAt instanceof Date) || Number.isNaN(acquiredAt.valueOf())) {
    fail('RUN_LOCK_INVALID', 'acquired_at生成値不正');
  }
  const artifact = {
    schema: 'lattice.runtime_lifecycle_lock.v1',
    owner_pid: process.pid,
    owner_process_start_identity: structuredClone(ownerIdentity),
    session_nonce_digest: sessionNonceDigest,
    operation,
    request_id: requestId,
    acquired_at: acquiredAt.toISOString(),
    lock_digest: '',
  };
  artifact.lock_digest = selfDigest(artifact, 'lock_digest');
  const deadline = Date.now() + timeoutMs;
  await removeDeadTemporaries(resolvedLockPath);

  while (true) {
    if (await createLock(resolvedLockPath, artifact, publishLink)) {
      let released = false;
      return {
        artifact: structuredClone(artifact),
        lockPath: resolvedLockPath,
        async release() {
          if (released) return;
          await releaseRuntimeLifecycleLock({
            lockPath: resolvedLockPath, ownerDigest: artifact.lock_digest,
          });
          released = true;
        },
      };
    }

    let existing;
    try { existing = await readLockArtifact(resolvedLockPath); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (!(error instanceof UnidentifiedLock)) throw error;
      if (await recoverUnidentifiedLock(resolvedLockPath, error.info)) continue;
      if (Date.now() >= deadline) fail('RUN_BUSY', 'lifecycle lock取得処理が進行中');
      await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())));
      continue;
    }
    if (!await ownerIsLive(existing.value, observer)) {
      await recoverStaleLock(resolvedLockPath, existing.value.lock_digest);
      continue;
    }
    if (Date.now() >= deadline) {
      fail('RUN_BUSY', timeoutMs === 0
        ? `run lifecycle操作が既に進行中: ${existing.value.operation}/${existing.value.request_id}`
        : `run lifecycle lock timeout: ${existing.value.operation}/${existing.value.request_id}`);
    }
    await sleep(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

/** lock artifactのowner digestが一致する呼出しだけがreleaseできる。 */
export async function releaseRuntimeLifecycleLock({ lockPath, ownerDigest } = {}) {
  if (typeof lockPath !== 'string' || !path.isAbsolute(lockPath) || !digest(ownerDigest)) {
    fail('RUN_LOCK_INVALID', 'lifecycle lock release入力不正');
  }
  let existing;
  try { existing = await readLockArtifact(lockPath); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('RUN_LOCK_OWNER_MISMATCH', 'release対象lockなし');
    if (error instanceof UnidentifiedLock) fail('RUN_LOCK_OWNER_MISMATCH', 'lifecycle lock owner digest不一致');
    throw error;
  }
  if (existing.value.lock_digest !== ownerDigest) {
    fail('RUN_LOCK_OWNER_MISMATCH', 'lifecycle lock owner digest不一致');
  }
  const current = await lstat(lockPath);
  if (current.dev !== existing.info.dev || current.ino !== existing.info.ino) {
    fail('RUN_LOCK_OWNER_MISMATCH', 'lifecycle lockがrelease前に差し替わった');
  }
  await unlink(lockPath);
  await syncDirectory(path.dirname(lockPath));
}
