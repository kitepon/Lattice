// Derived, cross-process memory of "these exact bytes passed this exact validator" (dfd-store-display-read.md, s5).
// Never canonical: a missing, unreadable, oversized or mismatching file is a cache miss and the caller validates in full,
// as it did before. A key is sha256 of the bytes (plus mode/ref), the file is bound to a fingerprint of the validator code,
// so changed bytes or changed code never hit. Reads still hash every byte; only the per-event validation is skipped.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renamePublishedFile } from './fs-publish.mjs';
import packageJson from '../package.json' with { type: 'json' };

export const TODO_RECEIPTS_SCHEMA = 'lattice.todo_verified_receipts.v1';
export const TODO_RECEIPTS_REF = '.lattice/generated/store-verified/receipts.json';
const MAX_KEYS = 1024;
const MAX_FILE_BYTES = 1_048_576;
// The modules whose code decides acceptance; changing any of them changes the fingerprint and drops every receipt.
const VALIDATOR_MODULES = ['todo-contracts.mjs', 'todo-revision.mjs', 'todo-store.mjs'];

let fingerprint;
function validatorFingerprint() {
  if (fingerprint !== undefined) return fingerprint;
  try {
    const hash = createHash('sha256').update(packageJson.version);
    for (const name of VALIDATOR_MODULES) hash.update('\0').update(readFileSync(new URL(`./${name}`, import.meta.url)));
    fingerprint = hash.digest('hex');
  } catch { fingerprint = null; }
  return fingerprint;
}

const keysDigest = (keys) => createHash('sha256').update(keys.join('\n')).digest('hex');

/** Insertion-ordered set of accepted keys, bounded to the most recently used MAX_KEYS. */
export class AcceptedKeys {
  #keys = new Map();
  #loaded = new Set();
  #dirty = false;

  has(key) {
    if (!this.#keys.has(key)) return false;
    this.#keys.delete(key); this.#keys.set(key, true); // recency only; a hit alone never rewrites the file
    return true;
  }

  add(key) {
    if (this.#keys.has(key)) return;
    this.#keys.set(key, true);
    this.#dirty = true;
    if (this.#keys.size > MAX_KEYS) this.#keys.delete(this.#keys.keys().next().value);
  }

  /** Merge the receipts stored for this repository once per process; any problem leaves the set as it is. */
  async attach(repoRoot) {
    const code = validatorFingerprint();
    if (code === null || this.#loaded.has(repoRoot)) return;
    this.#loaded.add(repoRoot);
    try {
      const absolute = path.join(await realpath(repoRoot), TODO_RECEIPTS_REF);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_FILE_BYTES) return;
      const file = JSON.parse(await readFile(absolute, 'utf8'));
      if (file?.schema !== TODO_RECEIPTS_SCHEMA || file.fingerprint !== code || !Array.isArray(file.keys)
        || file.keys.length > MAX_KEYS || !file.keys.every((key) => typeof key === 'string' && key.length <= 512)
        || file.keys_digest !== keysDigest(file.keys)) return;
      const own = new Map(this.#keys);
      this.#keys = new Map(file.keys.map((key) => [key, true]));
      for (const key of own.keys()) { this.#keys.delete(key); this.#keys.set(key, true); }
    } catch { /* a cache miss */ }
  }

  /** Publish the keys accepted since the last publication; a failure leaves the cache as it was. */
  async persist(repoRoot) {
    const code = validatorFingerprint();
    if (code === null || !this.#dirty) return;
    this.#dirty = false;
    let temporary = null;
    try {
      const root = await realpath(repoRoot);
      let directory = root;
      for (const segment of path.posix.dirname(TODO_RECEIPTS_REF).split('/')) {
        directory = path.join(directory, segment);
        if (segment !== '.lattice') await mkdir(directory).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
        const stats = await lstat(directory);
        if (stats.isSymbolicLink() || !stats.isDirectory() || await realpath(directory) !== directory) return;
      }
      // The user's repository must stay clean: `*` ignores the receipts and this file itself, whatever the repository's own ignore rules.
      await writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
      const keys = [...this.#keys.keys()];
      const body = Buffer.from(JSON.stringify({ schema: TODO_RECEIPTS_SCHEMA, fingerprint: code, keys,
        keys_digest: keysDigest(keys) }), 'utf8');
      temporary = path.join(directory, `.receipts.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(body); } finally { await handle.close(); }
      await renamePublishedFile(temporary, path.join(root, TODO_RECEIPTS_REF)); // no fsync: losing it is a cache miss
      temporary = null;
    } catch { /* derived data: the next read validates and tries again */ } finally {
      if (temporary !== null) await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
