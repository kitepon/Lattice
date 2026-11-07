import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fsyncDirectory } from './fs-dir-sync.mjs';
import { syncPublishedFile } from './fs-publish.mjs';
import { observeStartIdentityRaw, observeProcessHostIdentityRaw } from './runtime-os-observation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const CLAIM = /^([0-9a-f]{64})-([1-9][0-9]*)-([0-9a-f]{64})-([0-9a-f]{16})$/u;
let ownStart;
let ownHost;

export class StoreLockError extends Error {
  constructor(reason, lockPath, detail = {}) {
    super(reason);
    this.name = 'StoreLockError';
    this.reason = reason;
    this.detail = {
      lock_path: lockPath,
      next_action: reason === 'lock_owner_unidentified'
        ? `Confirm no writer is running, then manually remove the unidentified lock: ${lockPath}`
        : `Retry after the owner releases ${lockPath}; if it cannot, confirm no writer on the recorded host before manually clearing the abandoned lock.`,
      ...detail,
    };
  }
}

function identified(owner) {
  return owner !== null && typeof owner === 'object'
    && Object.keys(owner).sort().join(',') === 'host,pid,process_start'
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.host === 'string' && owner.host.length > 0 && owner.host.length <= 255
    && owner.process_start !== null && typeof owner.process_start === 'object'
    && Object.keys(owner.process_start).sort().join(',') === 'identity,platform'
    && typeof owner.process_start.platform === 'string' && owner.process_start.platform.length > 0
    && typeof owner.process_start.identity === 'string'
    && owner.process_start.identity.length > 0 && owner.process_start.identity.length <= 1024;
}

async function processIsDead(pid, startDigest) {
  try {
    const observed = await observeStartIdentityRaw(pid);
    if (observed) return hash(`${process.platform}:${observed}`) !== startDigest;
  } catch {
    // A failed observation cannot turn an existing PID into a dead owner.
  }
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function readOwner(lockPath) {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) {
      throw new StoreLockError('lock_owner_unidentified', lockPath);
    }
    let owner;
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (!(error instanceof SyntaxError)) throw error;
      throw new StoreLockError('lock_owner_unidentified', lockPath);
    }
    if (!identified(owner)) throw new StoreLockError('lock_owner_unidentified', lockPath);
    return owner;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ownerIsDead(owner, host) {
  return owner.host === host && owner.process_start.platform === process.platform
    && processIsDead(owner.pid,
      hash(`${owner.process_start.platform}:${owner.process_start.identity}`));
}

async function removeDeadTemporaries(lockPath, hostDigest) {
  const prefix = `${path.basename(lockPath)}.`;
  for (const name of await readdir(path.dirname(lockPath))) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const parsed = name.slice(prefix.length, -4).match(CLAIM);
    if (parsed && parsed[1] === hostDigest && Number.isSafeInteger(Number(parsed[2]))
      && await processIsDead(Number(parsed[2]), parsed[3])) {
      const temporary = path.join(path.dirname(lockPath), name);
      const info = await lstat(temporary).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
        return null;
      });
      if (info?.isFile() && !info.isSymbolicLink()) await rm(temporary, { force: true });
    }
  }
}

async function recoveryClaim(claimsPath, owner, lockPath) {
  const hostDigest = hash(owner.host);
  const name = `${hostDigest}-${owner.pid}-${hash(`${owner.process_start.platform}:${owner.process_start.identity}`)}-${randomBytes(8).toString('hex')}`;
  const claimPath = path.join(claimsPath, name);
  // A releasing claimant may remove the empty parent between these mkdir calls.
  for (;;) {
    await mkdir(claimsPath, { recursive: true, mode: 0o700 });
    const parent = await lstat(claimsPath);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new StoreLockError('store_locked', lockPath);
    try { await mkdir(claimPath, { mode: 0o700 }); break; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  try {
    await removeDeadClaims(claimsPath, hostDigest, lockPath);
    // All claimants publish before inspection; only a sole claimant may recover.
    // Timestamp ordering could let a delayed earlier publisher enter twice.
    const candidates = await readdir(claimsPath);
    if (candidates.length === 1 && candidates[0] === name) return claimPath;
    throw new StoreLockError('store_locked', lockPath, {
      recovery_claims_path: claimsPath,
      next_action: `Retry after recovery claimants exit; for foreign or unidentified claims, confirm no writer on their recorded host before clearing only abandoned entries in ${claimsPath}`,
    });
  } catch (error) {
    await rmdir(claimPath);
    throw error;
  }
}

async function removeDeadClaims(claimsPath, hostDigest, lockPath) {
  const state = await lstat(claimsPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  if (state === null) return;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new StoreLockError('store_locked', lockPath, { recovery_claims_path: claimsPath });
  }
  for (const entry of await readdir(claimsPath, { withFileTypes: true })) {
    const parsed = entry.name.match(CLAIM);
    if (entry.isDirectory() && parsed && parsed[1] === hostDigest
      && Number.isSafeInteger(Number(parsed[2]))
      && await processIsDead(Number(parsed[2]), parsed[3])) {
      try { await rmdir(path.join(claimsPath, entry.name)); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; }
    }
  }
}

async function removeClaim(claimPath, claimsPath) {
  await rmdir(claimPath);
  try { await rmdir(claimsPath); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; }
}

/** Complete ownership is linked atomically; recovery never removes a live owner. */
export async function withStoreLock({ lockPath, recoveryClaimsPath = `${lockPath}.recovery`,
  onRecoveryClaim = null, createParent = true, releasePath = () => lockPath }, callback) {
  if (createParent) await mkdir(path.dirname(lockPath), { recursive: true });
  ownStart ??= observeStartIdentityRaw(process.pid).catch((error) => { ownStart = undefined; throw error; });
  ownHost ??= observeProcessHostIdentityRaw().then((value) => {
    if (!value) throw new Error('process host domain unavailable');
    return `${process.platform}:${hash(value)}`;
  }).catch((error) => { ownHost = undefined; throw error; });
  let identity;
  let host;
  try { [identity, host] = await Promise.all([ownStart, ownHost]); }
  catch {
    throw new StoreLockError('store_locked', lockPath, {
      cause: 'lock_identity_unavailable',
      next_action: `Restore platform host-domain and process-start observation, then retry ${lockPath}`,
    });
  }
  const owner = { pid: process.pid,
    process_start: { platform: process.platform, identity }, host };
  if (!identified(owner)) throw new StoreLockError('store_locked', lockPath, {
    cause: 'lock_identity_unavailable',
    next_action: `Restore platform host-domain and process-start observation, then retry ${lockPath}`,
  });
  const ownerBytes = `${JSON.stringify(owner)}\n`;
  const temporary = `${lockPath}.${hash(host)}-${owner.pid}-${hash(`${owner.process_start.platform}:${owner.process_start.identity}`)}-${randomBytes(8).toString('hex')}.tmp`;
  let claimPath = null;
  let acquired = false;
  let fileIdentity = null;
  let callbackEntered = false;
  try {
    await removeDeadTemporaries(lockPath, hash(host));
    for (const claimsPath of new Set([recoveryClaimsPath, `${lockPath}.recovery`])) {
      await removeDeadClaims(claimsPath, hash(host), lockPath);
      try { await rmdir(claimsPath); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; }
    }
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(ownerBytes); await syncPublishedFile(handle, lockPath);
      fileIdentity = await handle.stat();
    }
    finally { await handle.close(); }
    for (;;) {
      try { await link(temporary, lockPath); acquired = true; break; }
      catch (error) {
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(error?.code)) {
          throw new StoreLockError('store_locked', lockPath, {
            cause: 'lock_publication_unavailable',
            next_action: `Use a filesystem permitting atomic hard-link publication for ${lockPath}, then retry`,
          });
        }
        if (error?.code !== 'EEXIST') throw error;
      }
      const existing = await readOwner(lockPath);
      if (existing === null) continue;
      if (!await ownerIsDead(existing, host)) throw new StoreLockError('store_locked', lockPath);
      if (claimPath === null) {
        claimPath = await recoveryClaim(recoveryClaimsPath, owner, lockPath);
        if (onRecoveryClaim) await onRecoveryClaim();
      }
      const fresh = await readOwner(lockPath);
      if (fresh !== null) {
        if (!await ownerIsDead(fresh, host)) throw new StoreLockError('store_locked', lockPath);
        await rm(lockPath);
      }
    }
    await rm(temporary);
    await fsyncDirectory(path.dirname(lockPath));
    callbackEntered = true;
    return await callback();
  } catch (error) {
    if (!callbackEntered && error?.code === 'ENOENT') {
      throw new StoreLockError('store_locked', lockPath, {
        cause: 'lock_parent_missing',
        next_action: `Retry after initialization or recovery finishes publishing ${path.dirname(lockPath)}`,
      });
    }
    throw error;
  } finally {
    try {
      const currentLockPath = await releasePath();
      const currentIdentity = currentLockPath === null ? null : await lstat(currentLockPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (acquired && currentIdentity?.isFile() && !currentIdentity.isSymbolicLink()
        && currentIdentity.dev === fileIdentity.dev && currentIdentity.ino === fileIdentity.ino
        && await readFile(currentLockPath, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }) === ownerBytes) {
        await rm(currentLockPath);
        await fsyncDirectory(path.dirname(currentLockPath));
      }
    } finally {
      await rm(temporary, { force: true });
      if (claimPath !== null) await removeClaim(claimPath, recoveryClaimsPath);
    }
  }
}
