import { spawn } from 'node:child_process';
import { fsyncDirectory as fsyncDir } from './fs-dir-sync.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access, lstat, link, mkdir, open, readFile, readdir, realpath, rename, stat, unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPaths } from './setup-hosts.mjs';

const INFO = 'INFO: このrepoにはLattice sensor index（.lattice/sensor/）があります。コード構造の調査はsensor入口（MCP: lattice_sensor_explore 等／CLI: lattice sensor）を優先できます。';
const HOSTS = new Set(['claude', 'codex', 'cursor']);
const HOST_USAGE = 'usage: lattice hooks <install|status|uninstall|emit> --host <claude|codex|cursor>';
const MAX_STDIN_BYTES = 64 * 1024;
const SHOWN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_MAX_AGE_MS = 60 * 60 * 1000;
const RECEIPT_LOCK_MAX_AGE_MS = 30 * 1000;
const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/lattice.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const unique = () => `${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}`;
const ownUid = () => typeof process.getuid === 'function' ? process.getuid() : null;

function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function failure(stdout, code, message, exit = 1, detail) {
  const value = { schema: 'lattice.hooks_error.v1', code, message };
  if (detail !== undefined) value.detail = detail;
  writeJson(stdout, value);
  return exit;
}

function configPath(env, host) {
  return hostPaths(host, env).hooks;
}

function eventName(host) {
  return host === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit';
}

function isFlatHost(host) {
  return host === 'cursor';
}

function isCommandHandler(item, host) {
  if (item === null || typeof item !== 'object' || typeof item.command !== 'string') return false;
  return isFlatHost(host) || item.type === 'command';
}

function stateBase(env) {
  if (path.isAbsolute(env.XDG_STATE_HOME ?? '')) return path.resolve(env.XDG_STATE_HOME);
  return path.join(env.HOME ?? os.homedir(), '.local', 'state');
}

function words(command) {
  const out = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && quote !== "'") {
      const next = command[index + 1];
      if (next === undefined) return null;
      const escapesNext = quote !== '"' || ['$', '`', '"', '\\', '\n'].includes(next);
      if (!escapesNext) {
        word += '\\';
        started = true;
        continue;
      }
      index += 1;
      if (next !== '\n') {
        word += next;
        started = true;
      }
      continue;
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? null : char;
      started = true;
      continue;
    }
    if (/\s/u.test(char) && !quote) {
      if (started) out.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(word);
  return out;
}

function shell(argv) {
  return argv.map((item) => `'${item.replaceAll("'", "'\\''")}'`).join(' ');
}

function sameArgv(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function commandIs(command, identities) {
  const parsed = words(command);
  return parsed !== null && identities.some((identity) => sameArgv(identity, parsed));
}

function emitCandidate(command, host) {
  const parsed = words(command);
  if (parsed === null) return false;
  return parsed.some((part, index) => part === 'hooks' && parsed[index + 1] === 'emit'
    && parsed[index + 2] === '--host' && parsed[index + 3] === host);
}


function validateDirectory(info, label) {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw Object.assign(new Error(`${label} is not a real directory`), { code: 'STATE_UNSAFE' });
  }
  const uid = ownUid();
  if ((uid !== null && info.uid !== uid) || (info.mode & 0o022) !== 0) {
    throw Object.assign(new Error(`${label} has unsafe ownership or mode`), { code: 'STATE_UNSAFE' });
  }
}

/** Resolve the deepest existing ancestor before creating one component at a time. */
async function secureStateDirectory(env, components = [], { create = true } = {}) {
  const requestedBase = stateBase(env);
  let ancestor = requestedBase;
  const missing = [];
  while (true) {
    try {
      const info = await lstat(ancestor);
      validateDirectory(info, ancestor);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (ancestor === path.parse(ancestor).root) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  if (!create && missing.length > 0) return null;
  const pinnedAncestor = await realpath(ancestor);
  validateDirectory(await lstat(pinnedAncestor), pinnedAncestor);
  let cursor = pinnedAncestor;
  for (const component of missing) {
    cursor = path.join(cursor, component);
    try {
      await mkdir(cursor, { mode: 0o700 });
      await fsyncDir(path.dirname(cursor));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    validateDirectory(await lstat(cursor), cursor);
  }
  for (const component of components) {
    cursor = path.join(cursor, component);
    try {
      validateDirectory(await lstat(cursor), cursor);
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!create) return null;
    }
    try {
      await mkdir(cursor, { mode: 0o700 });
      await fsyncDir(path.dirname(cursor));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    validateDirectory(await lstat(cursor), cursor);
  }
  return cursor;
}

function receiptFile(directory, host) {
  return path.join(directory, 'installs', `${host}.json`);
}

function validateRegularOwnerMode(info, mode, code) {
  const uid = ownUid();
  if (!info.isFile() || (uid !== null && info.uid !== uid) || (info.mode & 0o777) !== mode) {
    throw Object.assign(new Error('unsafe owned file'), { code });
  }
}

async function readOwnedFile(target, { absent = null, code = 'UNSAFE_FILE' } = {}) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return absent;
    throw Object.assign(error, { code });
  }
  try {
    validateRegularOwnerMode(await handle.stat(), 0o600, code);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseReceipt(bytes) {
  if (bytes === null) return { schema: 'lattice.hooks_install_receipt.v1', entries: [] };
  let value;
  try { value = JSON.parse(bytes); } catch {
    throw Object.assign(new Error('receipt is not JSON'), { code: 'INSTALL_RECEIPT_UNSAFE' });
  }
  if (value?.schema !== 'lattice.hooks_install_receipt.v1' || !Array.isArray(value.entries)
    || value.entries.some((entry) => !Array.isArray(entry?.argv)
      || !entry.argv.every((part) => typeof part === 'string')
      || !['pending', 'committed'].includes(entry.status))) {
    throw Object.assign(new Error('receipt shape is invalid'), { code: 'INSTALL_RECEIPT_UNSAFE' });
  }
  return value;
}

async function receiptLocation(env, host, create) {
  const hooksDirectory = await secureStateDirectory(env, ['lattice', 'hooks'], { create });
  if (hooksDirectory === null) return null;
  const installs = path.join(hooksDirectory, 'installs');
  if (create) {
    try { await mkdir(installs, { mode: 0o700 }); await fsyncDir(hooksDirectory); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    validateDirectory(await lstat(installs), installs);
  } else {
    try { validateDirectory(await lstat(installs), installs); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  return receiptFile(hooksDirectory, host);
}

async function readReceipt(env, host) {
  const target = await receiptLocation(env, host, false);
  if (target === null) return { target: null, value: parseReceipt(null) };
  return {
    target,
    value: parseReceipt(await readOwnedFile(target, {
      absent: null, code: 'INSTALL_RECEIPT_UNSAFE',
    })),
  };
}

async function writeReceiptUnlocked(target, value) {
  const directory = path.dirname(target);
  const existing = await readOwnedFile(target, { absent: null, code: 'INSTALL_RECEIPT_UNSAFE' });
  if (existing !== null) parseReceipt(existing);
  const tmp = `${target}.tmp-lattice-hooks-${unique()}`;
  let handle;
  try {
    handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle?.close();
    handle = null;
    const beforeRename = await readOwnedFile(target, {
      absent: null, code: 'INSTALL_RECEIPT_UNSAFE',
    });
    if ((existing === null) !== (beforeRename === null)
      || (existing !== null && !existing.equals(beforeRename))) {
      throw Object.assign(new Error('receipt changed concurrently'), { code: 'INSTALL_RECEIPT_BUSY' });
    }
    await rename(tmp, target);
    await fsyncDir(directory);
    parseReceipt(await readOwnedFile(target, { code: 'INSTALL_RECEIPT_UNSAFE' }));
  } finally {
    await handle?.close().catch(() => {});
    await removeArtifact(tmp).catch(() => {});
  }
}

async function withReceiptLock(env, host, operation) {
  const target = await receiptLocation(env, host, true);
  const lockPath = `${target}.lock`;
  let lock;
  let acquired = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    let created = false;
    try {
      lock = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW, 0o600);
      created = true;
      await lock.chmod(0o600);
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
      await lock.sync();
      await lock.close();
      lock = null;
      await fsyncDir(path.dirname(lockPath));
      acquired = true;
      break;
    } catch (error) {
      await lock?.close().catch(() => {});
      lock = null;
      if (created) await removeArtifact(lockPath).catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await lstat(lockPath)).mtimeMs > RECEIPT_LOCK_MAX_AGE_MS) {
          await unlink(lockPath);
          await fsyncDir(path.dirname(lockPath));
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) {
    throw Object.assign(new Error('receipt lock unavailable'), { code: 'INSTALL_RECEIPT_BUSY' });
  }
  try {
    const bytes = await readOwnedFile(target, { absent: null, code: 'INSTALL_RECEIPT_UNSAFE' });
    return await operation(parseReceipt(bytes), target);
  } finally {
    await unlink(lockPath).catch(() => {});
    await fsyncDir(path.dirname(lockPath)).catch(() => {});
  }
}

function allHandlers(value, host) {
  const list = value?.hooks?.[eventName(host)];
  if (!Array.isArray(list)) return [];
  if (isFlatHost(host)) return list;
  return list.flatMap((wrapper) => Array.isArray(wrapper?.hooks) ? wrapper.hooks : []);
}

function configContains(value, argv, host) {
  return allHandlers(value, host).some((item) => isCommandHandler(item, host)
    && commandIs(item.command, [argv]));
}

async function recoverReceipt(env, host, configTarget, testHooks) {
  const current = await readReceipt(env, host);
  if (current.target === null || !current.value.entries.some((entry) => entry.status === 'pending')) {
    return current.value;
  }
  return withReceiptLock(env, host, async (receipt, target) => {
    await testHooks.afterReceiptLock?.({ configTarget });
    const config = await readConfig(configTarget);
    const entries = receipt.entries.flatMap((entry) => {
      if (entry.status !== 'pending') return [entry];
      return configContains(config.value, entry.argv, host) ? [{ ...entry, status: 'committed' }] : [];
    });
    const recovered = { ...receipt, entries };
    await writeReceiptUnlocked(target, recovered);
    return recovered;
  });
}

async function appendPending(env, host, argv) {
  const operationId = unique();
  await withReceiptLock(env, host, async (receipt, target) => {
    const entries = [...receipt.entries];
    entries.push({ argv, status: 'pending', operation_id: operationId, recorded_at: new Date().toISOString() });
    await writeReceiptUnlocked(target, { ...receipt, entries });
  });
  return operationId;
}

async function commitPending(env, host, operationId, argv) {
  await withReceiptLock(env, host, async (receipt, target) => {
    let found = false;
    const entries = receipt.entries.map((entry) => {
      if (entry.operation_id !== operationId) return entry;
      found = true;
      return { ...entry, status: 'committed' };
    });
    if (!found) entries.push({
      argv, status: 'committed', operation_id: operationId, recorded_at: new Date().toISOString(),
    });
    await writeReceiptUnlocked(target, { ...receipt, entries });
  });
}

async function readConfig(target) {
  let info;
  try { info = await lstat(target); } catch (error) {
    if (error?.code === 'ENOENT') {
      return { existed: false, mode: 0o600, bytes: Buffer.alloc(0), value: {} };
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw Object.assign(new Error('config is symlink'), { code: 'SYMLINK' });
  if (!info.isFile()) throw Object.assign(new Error('config is not regular'), { code: 'CONFIG_INVALID' });
  const bytes = await readFile(target);
  let value;
  try { value = JSON.parse(bytes); } catch {
    throw Object.assign(new Error('config is not JSON'), { code: 'CONFIG_INVALID' });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('config root is not an object'), { code: 'CONFIG_INVALID' });
  }
  if (value.hooks !== undefined && (value.hooks === null || typeof value.hooks !== 'object'
    || Array.isArray(value.hooks))) {
    throw Object.assign(new Error('hooks is not an object'), { code: 'CONFIG_INVALID' });
  }
  for (const name of ['UserPromptSubmit', 'beforeSubmitPrompt']) {
    if (value.hooks?.[name] !== undefined && !Array.isArray(value.hooks[name])) {
      throw Object.assign(new Error(`${name} is not an array`), { code: 'CONFIG_INVALID' });
    }
  }
  return { existed: true, mode: info.mode & 0o777, bytes, value };
}

function hooksList(value, host) {
  const name = eventName(host);
  if (value.hooks === undefined) value.hooks = {};
  if (value.hooks[name] === undefined) value.hooks[name] = [];
  return value.hooks[name];
}

function stripIdentity(value, identities, host) {
  let removed = 0;
  const name = eventName(host);
  const list = hooksList(value, host);
  if (isFlatHost(host)) {
    value.hooks[name] = list.filter((item) => {
      const owned = isCommandHandler(item, host) && commandIs(item.command, identities);
      if (owned) removed += 1;
      return !owned;
    });
    return removed;
  }
  value.hooks[name] = list.flatMap((wrapper) => {
    if (!wrapper || !Array.isArray(wrapper.hooks)) return [wrapper];
    const handlers = wrapper.hooks.filter((item) => {
      const owned = isCommandHandler(item, host) && commandIs(item.command, identities);
      if (owned) removed += 1;
      return !owned;
    });
    return handlers.length > 0 ? [{ ...wrapper, hooks: handlers }] : [];
  });
  return removed;
}

function hostHandler(host, command) {
  if (host === 'claude') return { type: 'command', command, timeout: 5 };
  if (host === 'cursor') return { command, timeout: 5 };
  return { type: 'command', command, timeout: 5, async: false, statusMessage: null };
}

export async function resolveStableNodePath(execPath, {
  platform = process.platform,
  accessImpl = access,
  realpathImpl = realpath,
} = {}) {
  await accessImpl(execPath, fsConstants.X_OK);
  if (platform !== 'darwin') return execPath;
  const match = execPath.match(/^\/(opt\/homebrew|usr\/local)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/u);
  if (match === null) return execPath;
  const prefix = `/${match[1]}`;
  const candidates = [path.join(prefix, 'bin/node'), path.join(prefix, 'opt', match[2], 'bin/node')];
  const resolvedExec = await realpathImpl(execPath);
  for (const candidate of candidates) {
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      if (await realpathImpl(candidate) === resolvedExec) return candidate;
    } catch {
      // A candidate is usable only when it exists and resolves to this running Node binary.
    }
  }
  return execPath;
}

async function resolveCanonical(host, source, platform) {
  const sourcePaths = [source.execPath, source.binPath];
  if (sourcePaths.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry)
    || /[\0\r\n]/u.test(entry))) {
    throw Object.assign(new Error('install source is not absolute'), { code: 'INSTALL_SOURCE_UNRESOLVED' });
  }
  try {
    const executable = await resolveStableNodePath(source.execPath, { platform });
    const script = await realpath(source.binPath);
    if (/[\0\r\n]/u.test(script)) throw new Error('resolved install source has unsafe characters');
    await access(script, fsConstants.R_OK | fsConstants.X_OK);
    return [executable, script, 'hooks', 'emit', '--host', host];
  } catch (error) {
    throw Object.assign(error, { code: 'INSTALL_SOURCE_UNRESOLVED' });
  }
}

async function createBackup(target, prestate) {
  if (!prestate.existed) return null;
  const ref = `${target}.bak-lattice-hooks-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${unique()}`;
  let handle;
  try {
    handle = await open(ref, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(prestate.bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsyncDir(path.dirname(target));
    return ref;
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeArtifact(ref).catch(() => {});
    throw error;
  }
}

async function removeArtifact(target) {
  if (target === null) return;
  try { await unlink(target); await fsyncDir(path.dirname(target)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function pruneGenerations(target) {
  const directory = path.dirname(target);
  const basename = path.basename(target);
  for (const marker of ['bak-lattice-hooks-', 'pre-lattice-hooks-']) {
    const prefix = `${basename}.${marker}`;
    const entries = [];
    for (const name of await readdir(directory)) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(directory, name);
      try { entries.push({ full, mtimeMs: (await lstat(full)).mtimeMs }); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs || right.full.localeCompare(left.full));
    for (const entry of entries.slice(5)) await removeArtifact(entry.full);
  }
}

async function writeTmp(target, bytes, mode, tag = 'tmp') {
  const tmp = `${target}.${tag}-lattice-hooks-${unique()}`;
  let handle;
  try {
    handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, mode);
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    return tmp;
  } catch (error) {
    await handle?.close().catch(() => {});
    await removeArtifact(tmp).catch(() => {});
    throw error;
  }
}

async function restoreExisting(target, displaced, mode, testHooks) {
  await testHooks.beforeRestore?.({ target, displaced });
  const bytes = await readFile(displaced);
  const tmp = await writeTmp(target, bytes, mode, 'restore');
  try {
    await rename(tmp, target);
    await fsyncDir(path.dirname(target));
    if (!(await readFile(target)).equals(bytes)) throw new Error('restore read-back mismatch');
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function rollbackAbsent(target, tmp) {
  const targetInfo = await lstat(target);
  const tmpInfo = await lstat(tmp);
  if (targetInfo.dev !== tmpInfo.dev || targetInfo.ino !== tmpInfo.ino) {
    throw new Error('created target was replaced before rollback');
  }
  await unlink(target);
  await fsyncDir(path.dirname(target));
  try { await lstat(target); throw new Error('absent rollback read-back failed'); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function commitConfig(target, prestate, value, testHooks) {
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  JSON.parse(serialized);
  const tmp = await writeTmp(target, serialized, prestate.existed ? prestate.mode : 0o600);
  let displaced = null;
  let committed = false;
  let complete = false;
  try {
    if (prestate.existed) {
      await testHooks.beforePreimageVerify?.({ target, prestate });
      const current = await readConfig(target);
      if (!current.existed || !current.bytes.equals(prestate.bytes)) {
        throw Object.assign(new Error('preimage changed'), { code: 'PREIMAGE_CHANGED' });
      }
      displaced = `${target}.pre-lattice-hooks-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${unique()}`;
      await link(target, displaced);
      await fsyncDir(path.dirname(target));
      await testHooks.afterDisplacedLink?.({ target, displaced });
      const before = await lstat(target);
      const saved = await lstat(displaced);
      if (!before.isFile() || before.dev !== saved.dev || before.ino !== saved.ino) {
        throw Object.assign(new Error('target inode changed'), { code: 'PREIMAGE_CHANGED' });
      }
      await rename(tmp, target);
      committed = true;
      await fsyncDir(path.dirname(target));
    } else {
      try { await link(tmp, target); } catch (error) {
        if (error?.code === 'EEXIST') {
          throw Object.assign(error, { code: 'PREIMAGE_CHANGED' });
        }
        throw error;
      }
      committed = true;
      await fsyncDir(path.dirname(target));
    }
    await testHooks.beforeConfigReadBack?.({ target, serialized, displaced });
    if (!(await readFile(target)).equals(serialized)) throw new Error('config read-back mismatch');
    complete = true;
    return displaced;
  } catch (error) {
    if (committed) {
      try {
        if (prestate.existed) await restoreExisting(target, displaced, prestate.mode, testHooks);
        else await rollbackAbsent(target, tmp);
      } catch (restoreError) {
        throw Object.assign(new Error(`restore failed: ${restoreError.message}`), {
          code: 'RESTORE_FAILED', cause: error, commitOccurred: true, displacedPath: displaced,
        });
      }
      Object.assign(error, { commitOccurred: true, displacedPath: displaced });
    }
    throw error;
  } finally {
    await removeArtifact(tmp).catch(() => {});
    if (!complete && !committed) await removeArtifact(displaced).catch(() => {});
  }
}

function committedIdentities(receipt) {
  return receipt.entries.filter((entry) => entry.status === 'committed').map((entry) => entry.argv);
}

function exactHandler(item, expected) {
  return JSON.stringify(item) === JSON.stringify(expected);
}

async function hostDirectory(env, host) {
  const directory = path.dirname(configPath(env, host));
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a directory');
    return directory;
  } catch {
    return null;
  }
}

async function mutate(host, env, stdout, uninstall, source, platform, testHooks) {
  if (await hostDirectory(env, host) === null) {
    return failure(stdout, 'HOST_NOT_PRESENT', 'host home directory is not present');
  }
  let current;
  try { current = await resolveCanonical(host, source, platform); } catch {
    return failure(stdout, 'INSTALL_SOURCE_UNRESOLVED', 'install source cannot be resolved');
  }
  const target = configPath(env, host);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let prestate;
    try { prestate = await readConfig(target); } catch (error) {
      return failure(stdout, error?.code === 'SYMLINK' ? 'CONFIG_SYMLINK_UNSUPPORTED'
        : 'CONFIG_UNREADABLE', 'configuration cannot be read');
    }
    let receipt;
    try { receipt = await recoverReceipt(env, host, target, testHooks); } catch {
      return failure(stdout, 'INSTALL_RECEIPT_UNSAFE', 'install receipt cannot be safely read');
    }
    const identities = [current, ...committedIdentities(receipt)];
    const next = structuredClone(prestate.value);
    if (host === 'cursor' && next.version === undefined) next.version = 1;
    const removed = stripIdentity(next, identities, host);
    if (!uninstall) {
      const entry = hostHandler(host, shell(current));
      if (isFlatHost(host)) hooksList(next, host).push(entry);
      else hooksList(next, host).push({ hooks: [entry] });
    }

    const currentHandlers = allHandlers(prestate.value, host).filter((item) => (
      isCommandHandler(item, host) && commandIs(item.command, identities)
    ));
    const alreadyWired = !uninstall && currentHandlers.length === 1
      && commandIs(currentHandlers[0].command, [current])
      && exactHandler(currentHandlers[0], hostHandler(host, shell(current)));
    if ((uninstall && removed === 0) || alreadyWired) {
      writeJson(stdout, uninstall
        ? { schema: 'lattice.hooks_uninstall_result.v1', host, removed_count: 0 }
        : { schema: 'lattice.hooks_install_result.v1', host, state: 'already_wired' });
      return 0;
    }

    let pendingId = null;
    let backup = null;
    let configCommitted = false;
    try {
      if (!uninstall) pendingId = await appendPending(env, host, current);
      backup = await createBackup(target, prestate);
      await commitConfig(target, prestate, next, testHooks);
      configCommitted = true;
      if (!uninstall) await commitPending(env, host, pendingId, current);
      let warning;
      try {
        await testHooks.beforePrune?.({ target });
        await pruneGenerations(target);
      } catch (error) {
        warning = { code: 'GENERATION_PRUNE_FAILED', message: error?.message ?? 'generation prune failed' };
      }
      const result = uninstall
        ? { schema: 'lattice.hooks_uninstall_result.v1', host, removed_count: removed }
        : { schema: 'lattice.hooks_install_result.v1', host, state: 'wired' };
      if (warning !== undefined) result.warning = warning;
      writeJson(stdout, result);
      return 0;
    } catch (error) {
      if (!configCommitted && !error?.commitOccurred) await removeArtifact(backup).catch(() => {});
      if (!configCommitted && error?.code === 'PREIMAGE_CHANGED' && attempt === 0) continue;
      const code = error?.code === 'RESTORE_FAILED' ? 'RESTORE_FAILED'
        : ['INSTALL_RECEIPT_UNSAFE', 'INSTALL_RECEIPT_BUSY'].includes(error?.code)
          ? 'INSTALL_RECEIPT_UNSAFE'
          : 'CONFIG_WRITE_FAILED';
      const detail = code === 'RESTORE_FAILED' ? {
        backup_path: backup,
        displaced_path: error.displacedPath,
      } : undefined;
      return failure(stdout, code, 'configuration cannot be safely written', 1, detail);
    }
  }
  return failure(stdout, 'CONFIG_WRITE_FAILED', 'configuration changed concurrently');
}

function statusResult(host, target, canonicalCommand, state, matches, executableOk,
  foreignCandidateCount) {
  return {
    schema: 'lattice.hooks_status_result.v1',
    host,
    config_path: target,
    state,
    canonical_command: canonicalCommand,
    matched_handler_count: matches,
    foreign_candidate_count: foreignCandidateCount,
    executable_ok: executableOk,
    next_action: state === 'wired' ? null : `lattice hooks install --host ${host}`,
  };
}

async function status(host, env, stdout, source, platform, testHooks) {
  const target = configPath(env, host);
  let argv;
  try { argv = await resolveCanonical(host, source, platform); } catch {
    writeJson(stdout, statusResult(host, target, null, 'unreadable', 0, false, 0));
    return 1;
  }
  if (platform === 'win32' || await hostDirectory(env, host) === null) {
    writeJson(stdout, statusResult(host, target, shell(argv), 'unreadable', 0, false, 0));
    return 1;
  }
  let config;
  try { config = await readConfig(target); } catch {
    writeJson(stdout, statusResult(host, target, shell(argv), 'unreadable', 0, false, 0));
    return 1;
  }
  let receipt;
  try { receipt = await recoverReceipt(env, host, target, testHooks); } catch {
    writeJson(stdout, statusResult(host, target, shell(argv), 'unreadable', 0, false, 0));
    return 1;
  }
  try { config = await readConfig(target); } catch {
    writeJson(stdout, statusResult(host, target, shell(argv), 'unreadable', 0, false, 0));
    return 1;
  }
  const identities = [argv, ...committedIdentities(receipt)];
  let matches = 0;
  let canonicalMatches = 0;
  let foreign = 0;
  let canonicalShape = false;
  for (const item of allHandlers(config.value, host)) {
    if (!isCommandHandler(item, host)) continue;
    if (commandIs(item.command, identities)) {
      matches += 1;
      if (commandIs(item.command, [argv])) {
        canonicalMatches += 1;
        canonicalShape = exactHandler(item, hostHandler(host, shell(argv)));
      }
    } else if (emitCandidate(item.command, host)) foreign += 1;
  }
  const executableOk = await Promise.all(argv.slice(0, 2).map(async (entry) => {
    try { await access(entry, fsConstants.X_OK); return (await stat(entry)).isFile(); } catch { return false; }
  })).then((values) => values.every(Boolean));
  let state = 'drift';
  if (matches === 0 && foreign === 0) state = 'not_wired';
  else if (matches === 1 && canonicalMatches === 1 && canonicalShape && executableOk && foreign === 0) {
    state = 'wired';
  }
  writeJson(stdout, statusResult(host, target, shell(argv), state, matches, executableOk, foreign));
  return 0;
}

async function appendError(state, message) {
  const target = path.join(state, 'errors.log');
  try {
    const created = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT
      | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await created.chmod(0o600); await created.sync(); } finally { await created.close(); }
    await fsyncDir(state);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT
    | fsConstants.O_NOFOLLOW, 0o600);
  try {
    validateRegularOwnerMode(await handle.stat(), 0o600, 'ERROR_LOG_UNSAFE');
    await handle.writeFile(`${new Date().toISOString()} ${message}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

async function recordOrDiagnose(state, stdout, message, diagnostic) {
  try { await appendError(state, message); } catch { stdout.write(`Lattice hooks: ${diagnostic}\n`); }
}

async function diagnose(state, stdout, message, diagnostic) {
  try { await appendError(state, message); } catch {}
  stdout.write(`Lattice hooks: ${diagnostic}\n`);
}

function sessionIdFromEvent(event) {
  for (const key of ['session_id', 'conversation_id']) {
    if (typeof event?.[key] === 'string' && event[key].length > 0) return event[key];
  }
  return null;
}

function cwdFromEvent(event) {
  if (typeof event?.cwd === 'string' && path.isAbsolute(event.cwd)) return event.cwd;
  const root = event?.workspace_roots?.[0];
  if (typeof root === 'string' && path.isAbsolute(root)) return root;
  return null;
}

async function readHookInput(stdin) {
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length <= MAX_STDIN_BYTES) chunks.push(bytes);
    else tooLarge = true;
  }
  if (tooLarge) throw new Error('hook stdin exceeds 64KiB');
  let event;
  try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new Error('hook stdin is not strict JSON');
  }
  const sessionId = sessionIdFromEvent(event);
  const cwdValue = cwdFromEvent(event);
  if (sessionId === null || cwdValue === null) {
    throw new Error('hook stdin requires session_id and absolute cwd');
  }
  try {
    const cwd = await realpath(cwdValue);
    if (!(await lstat(cwd)).isDirectory()) throw new Error('cwd is not a directory');
    return { ...event, session_id: sessionId, cwd };
  } catch {
    throw new Error('hook cwd is unavailable');
  }
}

async function gitRoot(cwd, spawnImpl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnImpl('git', ['--no-optional-locks', '-C', cwd, 'rev-parse', '--show-toplevel'], {
        shell: false, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      resolve({ kind: 'error', error });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'error', error: new Error('git root lookup timed out') });
    }, timeoutMs);
    child.once('error', (error) => finish({ kind: 'error', error }));
    child.stdout.on('error', (error) => finish({ kind: 'error', error }));
    child.stdout.on('data', (data) => {
      out += data;
      if (Buffer.byteLength(out) > MAX_STDIN_BYTES) {
        child.kill('SIGKILL');
        finish({ kind: 'error', error: new Error('git output too large') });
      }
    });
    child.once('close', (code, signal) => {
      if (code !== 0) {
        finish(signal === null ? { kind: 'not_git' }
          : { kind: 'error', error: new Error(`git terminated by ${signal}`) });
        return;
      }
      const root = out.trim();
      finish(path.isAbsolute(root) ? { kind: 'root', root }
        : { kind: 'error', error: new Error('git returned a non-absolute root') });
    });
  });
}

const ownNotificationPattern = /^[a-f0-9]{64}\.[a-f0-9]{64}\.(?:shown|claim)$/u;

async function gcNotifications(state) {
  const now = Date.now();
  for (const name of await readdir(state)) {
    if (!ownNotificationPattern.test(name)) continue;
    const target = path.join(state, name);
    let info;
    try { info = await lstat(target); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const maximum = name.endsWith('.claim') ? CLAIM_MAX_AGE_MS : SHOWN_MAX_AGE_MS;
    if (now - info.mtimeMs > maximum) await removeArtifact(target);
  }
}

async function freshShown(shown) {
  try { return Date.now() - (await lstat(shown)).mtimeMs <= SHOWN_MAX_AGE_MS; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function acquireClaim(claim) {
  let handle;
  let created = false;
  try {
    handle = await open(claim, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsyncDir(path.dirname(claim));
    return true;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await removeArtifact(claim).catch(() => {});
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function outputLine(host) {
  if (host === 'claude') return `${INFO}\n`;
  if (host === 'cursor') return `${JSON.stringify({ additional_context: INFO })}\n`;
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: INFO },
  })}\n`;
}

async function writeOutput(stdout, line) {
  await new Promise((resolve, reject) => {
    try { stdout.write(line, (error) => error ? reject(error) : resolve()); } catch (error) { reject(error); }
  });
}

async function emit(host, env, stdin, stdout, spawnImpl, gitTimeoutMs, testHooks) {
  if (env.LATTICE_HOOKS === 'off') return 0;
  let state;
  try { state = await secureStateDirectory(env, ['lattice', 'hooks']); } catch {
    stdout.write('Lattice hooks: state directory unavailable\n');
    return 0;
  }
  let event;
  try { event = await readHookInput(stdin); } catch (error) {
    await recordOrDiagnose(state, stdout, error.message, 'cannot record invalid stdin');
    return 0;
  }
  const git = await gitRoot(event.cwd, spawnImpl, gitTimeoutMs);
  if (git.kind === 'not_git') return 0;
  if (git.kind === 'error') {
    await diagnose(state, stdout, git.error.message, 'git root lookup failed');
    return 0;
  }
  const sensor = path.join(git.root, '.lattice', 'sensor');
  try {
    if (!(await lstat(sensor)).isDirectory()) return 0;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 0;
    await diagnose(state, stdout, `sensor lookup failed: ${error.message}`, 'sensor index unavailable');
    return 0;
  }
  try { await gcNotifications(state); } catch (error) {
    await diagnose(state, stdout, `notification gc failed: ${error.message}`, 'notification state unavailable');
    return 0;
  }
  const key = `${hash(event.session_id)}.${hash(git.root)}`;
  const shown = path.join(state, `${key}.shown`);
  const claim = path.join(state, `${key}.claim`);
  try {
    if (await freshShown(shown)) return 0;
  } catch (error) {
    await diagnose(state, stdout, `shown precheck failed: ${error.message}`, 'notification state unavailable');
    return 0;
  }
  try {
    if (!await acquireClaim(claim)) return 0;
  } catch (error) {
    await diagnose(state, stdout, `claim failed: ${error.message}`, 'notification claim unavailable');
    return 0;
  }
  try {
    if (await freshShown(shown)) {
      await removeArtifact(claim);
      return 0;
    }
  } catch (error) {
    await removeArtifact(claim).catch(() => {});
    await diagnose(state, stdout, `shown recheck failed: ${error.message}`, 'notification state unavailable');
    return 0;
  }
  try {
    await writeOutput(stdout, outputLine(host));
  } catch (error) {
    await removeArtifact(claim).catch(() => {});
    await recordOrDiagnose(state, stdout, `notification output failed: ${error.message}`,
      'notification output failed');
    return 0;
  }
  try {
    await testHooks.beforeShownRename?.({ claim, shown });
    await rename(claim, shown);
    await fsyncDir(state);
  } catch (error) {
    await recordOrDiagnose(state, stdout, `claim promotion failed: ${error.message}`,
      'notification record failed');
    try {
      const handle = await open(shown, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      await fsyncDir(state);
    } catch (fallbackError) {
      await recordOrDiagnose(state, stdout, `shown fallback failed: ${fallbackError.message}`,
        'notification record failed');
    }
    await removeArtifact(claim).catch(() => {});
  }
  return 0;
}

export async function runHooksCli({
  argv,
  stdout,
  stdin = process.stdin,
  env = process.env,
  platform = process.platform,
  source = { execPath: process.execPath, binPath },
  spawnImpl = spawn,
  gitTimeoutMs = 2000,
  testHooks = {},
}) {
  if (argv.length !== 3 || !['install', 'status', 'uninstall', 'emit'].includes(argv[0])
    || argv[1] !== '--host' || !HOSTS.has(argv[2])) {
    return failure(stdout, 'USAGE', HOST_USAGE, 2);
  }
  const [command, , host] = argv;
  if (platform === 'win32') {
    return failure(stdout, 'HOST_PLATFORM_UNSUPPORTED', 'native Windows hooks are unsupported');
  }
  if (command === 'install') return mutate(host, env, stdout, false, source, platform, testHooks);
  if (command === 'uninstall') return mutate(host, env, stdout, true, source, platform, testHooks);
  if (command === 'status') return status(host, env, stdout, source, platform, testHooks);
  return emit(host, env, stdin, stdout, spawnImpl, gitTimeoutMs, testHooks);
}
