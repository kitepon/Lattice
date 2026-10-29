/**
 * A content-addressed cache in front of `readTodoStoreStable`, for long-running
 * processes (the dashboard daemon) that re-render on every request/poll and would
 * otherwise re-validate the whole merged store every time.
 *
 * An earlier version keyed the cache on a stat()-derived fingerprint (dev/ino/size/
 * mtimeMs/ctimeMs). On filesystems with coarse mtime granularity (observed on
 * WSL/DrvFs), two different manifest contents written close together can land on the
 * same fingerprint, so the cache would serve a stale store as current — and since the
 * mismatch never surfaces as an error, nothing invalidates it until the process
 * restarts. Hashing the manifest's actual bytes costs one small file read and removes
 * that failure mode entirely.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { readTodoStoreStable } from './todo-store.mjs';

const MANIFEST_REF = '.lattice/todo/manifest.json';
const READ_FAILURE = Symbol('store read failure');

/** Finite diagnostics only; keep the original exception and its errno intact. */
export function todoStoreReadFailurePhase(error) {
  if (error?.[READ_FAILURE]) return error[READ_FAILURE];
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'store_access_denied';
  if (error?.code === 'EIO') return 'store_io_failed';
  if (error?.code === 'STORE_INCONSISTENT' && error.detail?.ref === MANIFEST_REF
    && ['schema_invalid', 'artifact_truncated_or_trailing_bytes', 'non_canonical_or_duplicate_key',
      'size_limit_exceeded', 'artifact_eol_converted'].includes(error.detail.reason)) {
    return 'store_manifest_invalid';
  }
  return 'store_read_failed';
}

async function manifestContentDigest(repoRoot) {
  try {
    return createHash('sha256').update(await readFile(path.join(repoRoot, MANIFEST_REF))).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        if ((await stat(repoRoot)).isDirectory()) error[READ_FAILURE] = 'store_manifest_missing';
      } catch (rootError) {
        if (rootError.code === 'ENOENT') error[READ_FAILURE] = 'store_root_missing';
      }
    }
    throw error;
  }
}

/**
 * @param {object} [options]
 * @param {(options: object) => Promise<object>} [options.readStable] injection point for tests
 */
export function createTodoStoreCache({ readStable = readTodoStoreStable } = {}) {
  const cache = new Map();
  return {
    async read(repoRoot) {
      const digest = await manifestContentDigest(repoRoot);
      const cached = cache.get(repoRoot);
      if (cached?.digest === digest) return cached.store;
      // Read before caching: a failure here (including the store's own inconsistency
      // detection) must not populate the cache, so the very next call re-reads instead
      // of serving a poisoned entry.
      let store;
      try { store = await readStable({ repoRoot }); }
      catch (error) {
        const ref = error?.detail?.ref;
        const absolute = typeof ref === 'string' ? path.resolve(repoRoot, ref) : null;
        if (error?.code === 'STORE_INCONSISTENT' && error.detail?.reason === 'artifact_missing'
          && ref !== MANIFEST_REF && absolute?.startsWith(`${path.resolve(repoRoot, '.lattice/todo')}${path.sep}`)) {
          // The store's legacy artifact_missing also covers lstat I/O errors.
          try { await stat(absolute); }
          catch (artifactError) {
            if (artifactError.code === 'ENOENT') {
              let currentDigest;
              try { currentDigest = await manifestContentDigest(repoRoot); } catch { /* concurrent removal stays unknown */ }
              if (currentDigest === digest) error[READ_FAILURE] = 'store_artifact_missing';
            } else error[READ_FAILURE] = todoStoreReadFailurePhase(artifactError);
          }
        }
        throw error;
      }
      cache.set(repoRoot, { digest, store });
      return store;
    },
  };
}
