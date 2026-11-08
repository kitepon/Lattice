import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fsyncDirectory } from './fs-dir-sync.mjs';
import { syncPublishedFile } from './fs-publish.mjs';
import { observeStartIdentityRaw, observeProcessHostIdentityRaw } from './runtime-os-observation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const CLAIM = /^([0-9a-f]{64})-([1-9][0-9]*)-([0-9a-f]{64})-([0-9a-f]{16})$/u;
// u03 N1/N2: an owner that cannot be proven dead (foreign host, legacy, weak) is abandoned once
// its heartbeat mtime is older than LOCK_STALE_MS; every holder touches its lock and claim.
export const LOCK_STALE_MS = 10 * 60_000;
export const LOCK_HEARTBEAT_MS = 30_000;
// Weak identity when own observation is unavailable: never PID-recovered, only heartbeat-stale.
const WEAK = 'unobserved';
const NO_HARD_LINK = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'];
let ownStart;
let ownHost;

export class StoreLockError extends Error {
  constructor(reason, lockPath, detail = {}) {
    super(reason);
    this.name = 'StoreLockError';
    this.reason = reason;
    this.detail = {
      lock_path: lockPath,
      next_action: `Retry after the owner releases ${lockPath}; an owner that stops refreshing it is recovered automatically after ${LOCK_STALE_MS / 60_000} minutes.`,
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
  // Existence first: a PID freed after a failed observation may be reused before a later check.
  try { process.kill(pid, 0); }
  catch (error) { if (error?.code === 'ESRCH') return true; }
  try {
    const observed = await observeStartIdentityRaw(pid);
    if (observed) return hash(`${process.platform}:${observed}`) !== startDigest;
  } catch {
    // A failed observation cannot turn an existing PID into a dead owner.
  }
  return false;
}

/** Returns null (absent) or {owner (null when unidentified), stale, info: the judged lstat}. */
async function readOwner(lockPath) {
  try {
    const info = await lstat(lockPath);
    const stale = info.mtimeMs < Date.now() - LOCK_STALE_MS;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) return { owner: null, stale, info };
    let owner;
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (!(error instanceof SyntaxError)) throw error;
      return { owner: null, stale, info };
    }
    return { owner: identified(owner) ? owner : null, stale, info };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** A local identified owner is judged by PID + start only; any other owner by heartbeat staleness. */
async function abandoned({ owner, stale }, host) {
  if (owner !== null && host !== WEAK && owner.host === host
    && owner.process_start.platform === process.platform) {
    return processIsDead(owner.pid,
      hash(`${owner.process_start.platform}:${owner.process_start.identity}`));
  }
  return stale;
}

/**
 * Remove only the entry that was judged abandoned. A stale owner may still be alive and
 * release, letting a new owner link in between judgement and removal; that one goes back.
 */
async function removeJudged(lockPath, judged) {
  const quarantine = `${lockPath}.${randomBytes(8).toString('hex')}.stale`;
  try { await rename(lockPath, quarantine); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const moved = await lstat(quarantine);
  if (moved.dev === judged.dev && moved.ino === judged.ino && moved.size === judged.size
    && moved.mtimeMs === judged.mtimeMs) {
    await rm(quarantine);
    return;
  }
  try { await link(quarantine, lockPath); }
  catch (error) {
    if (error?.code !== 'EEXIST' && !NO_HARD_LINK.includes(error?.code)) throw error;
    // Both owners stay on disk; the displaced one fails its held-check (lock_lost).
    throw new StoreLockError('store_locked', lockPath, {
      cause: 'lock_recovery_raced', quarantine_path: quarantine,
      next_action: `Retry; ${quarantine} keeps the owner displaced by a racing recovery and is removed by hand only after that owner exits.`,
    });
  }
  await rm(quarantine);
}

function busy(state, lockPath) {
  return new StoreLockError(state.owner === null ? 'lock_owner_unidentified' : 'store_locked', lockPath);
}

async function isStale(entryPath) {
  const info = await lstat(entryPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  return info !== null && info.mtimeMs < Date.now() - LOCK_STALE_MS;
}

async function removeDeadTemporaries(lockPath, hostDigest) {
  const prefix = `${path.basename(lockPath)}.`;
  for (const name of await readdir(path.dirname(lockPath))) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const parsed = name.slice(prefix.length, -4).match(CLAIM);
    const temporary = path.join(path.dirname(lockPath), name);
    const local = parsed && parsed[1] === hostDigest && Number.isSafeInteger(Number(parsed[2]));
    if (local ? await processIsDead(Number(parsed[2]), parsed[3]) : await isStale(temporary)) {
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
    await removeDeadClaims(claimsPath, owner.host === WEAK ? null : hostDigest, lockPath);
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
    const local = parsed && parsed[1] === hostDigest && Number.isSafeInteger(Number(parsed[2]));
    if (entry.isDirectory() && (local ? await processIsDead(Number(parsed[2]), parsed[3])
      : await isStale(path.join(claimsPath, entry.name)))) {
      try { await rmdir(path.join(claimsPath, entry.name)); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; }
    }
  }
}

async function removeClaim(claimPath, claimsPath) {
  try { await rmdir(claimPath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
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
  catch { identity = WEAK; host = WEAK; }
  let owner = { pid: process.pid,
    process_start: { platform: process.platform, identity }, host };
  if (!identified(owner)) {
    host = WEAK;
    owner = { pid: process.pid, process_start: { platform: process.platform, identity: WEAK }, host };
  }
  const ownerBytes = `${JSON.stringify(owner)}\n`;
  const temporary = `${lockPath}.${hash(host)}-${owner.pid}-${hash(`${owner.process_start.platform}:${owner.process_start.identity}`)}-${randomBytes(8).toString('hex')}.tmp`;
  let claimPath = null;
  let acquired = false;
  let fileIdentity = null;
  let callbackEntered = false;
  let heartbeat = null;
  let lost = false;
  const stillOwned = async (current) => {
    if (current === null || !acquired) return false;
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    return info !== null && info.isFile() && !info.isSymbolicLink()
      && info.dev === fileIdentity.dev && info.ino === fileIdentity.ino
      && await readFile(current, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }) === ownerBytes;
  };
  try {
    // A weak writer cannot prove anyone dead by PID; it only clears stale entries.
    const hostDigest = host === WEAK ? null : hash(host);
    await removeDeadTemporaries(lockPath, hostDigest);
    for (const claimsPath of new Set([recoveryClaimsPath, `${lockPath}.recovery`])) {
      await removeDeadClaims(claimsPath, hostDigest, lockPath);
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
        if (NO_HARD_LINK.includes(error?.code)) {
          // u03: without hard links publish in place; a torn record reads as unidentified and goes stale.
          let direct = null;
          try { direct = await open(lockPath, 'wx', 0o600); }
          catch (openError) { if (openError?.code !== 'EEXIST') throw openError; }
          if (direct !== null) {
            try {
              await direct.writeFile(ownerBytes); await syncPublishedFile(direct, lockPath);
              fileIdentity = await direct.stat();
            } finally { await direct.close(); }
            acquired = true;
            break;
          }
        } else if (error?.code !== 'EEXIST') throw error;
      }
      const existing = await readOwner(lockPath);
      if (existing === null) continue;
      if (!await abandoned(existing, host)) throw busy(existing, lockPath);
      if (claimPath === null) {
        claimPath = await recoveryClaim(recoveryClaimsPath, owner, lockPath);
        if (onRecoveryClaim) await onRecoveryClaim();
      }
      const fresh = await readOwner(lockPath);
      if (fresh !== null) {
        if (!await abandoned(fresh, host)) throw busy(fresh, lockPath);
        await removeJudged(lockPath, fresh.info);
      }
    }
    await rm(temporary);
    await fsyncDirectory(path.dirname(lockPath));
    // Touch only our own entry: a resumed old holder must not keep a replacement lock fresh.
    heartbeat = setInterval(() => {
      Promise.resolve(releasePath()).then(async (current) => {
        if (current === null) return;
        if (!await stillOwned(current)) { lost = true; clearInterval(heartbeat); return; }
        const now = new Date();
        await Promise.all([utimes(current, now, now),
          claimPath === null ? null : utimes(claimPath, now, now)]);
      }).catch(() => {});
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    callbackEntered = true;
    // Callers check right before publishing; the check-to-rename gap is a named residual.
    return await callback(async () => {
      if (!lost && await stillOwned(await releasePath())) return;
      lost = true;
      throw new StoreLockError('store_locked', lockPath, {
        cause: 'lock_lost',
        next_action: `Retry; ${lockPath} was recovered by another writer while this one held it, and nothing was published after the check.`,
      });
    });
  } catch (error) {
    if (!callbackEntered && error?.code === 'ENOENT') {
      throw new StoreLockError('store_locked', lockPath, {
        cause: 'lock_parent_missing',
        next_action: `Retry after initialization or recovery finishes publishing ${path.dirname(lockPath)}`,
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    try {
      const currentLockPath = await releasePath();
      if (await stillOwned(currentLockPath)) {
        await rm(currentLockPath);
        await fsyncDirectory(path.dirname(currentLockPath));
      }
    } finally {
      await rm(temporary, { force: true });
      if (claimPath !== null) await removeClaim(claimPath, recoveryClaimsPath);
    }
  }
}
