/**
 * perf-store: per-process memo for values derived from retained plan-version files (Store internal).
 *
 * A retained version directory is immutable history, but every Store read used to re-read and strictly re-validate
 * all of them (206 versions on a production plan: one `todo add` spent ~40 s re-digesting the same bytes). The memo
 * keys by absolute file paths and serves a value only while each file's identity (dev, ino, size, mtime, ctime) is
 * unchanged, so a replaced or newly published file is read again. A failing computation is not memoized.
 * Callers keep their own readdir, so new versions appear. Values stay small (digests, migrations), never whole plans.
 */
import { lstat } from 'node:fs/promises';

const memo = new Map();

async function fileIdentity(absolute) {
  try {
    const state = await lstat(absolute, { bigint: true });
    return `${state.dev}:${state.ino}:${state.size}:${state.mtimeNs}:${state.ctimeNs}`;
  } catch (error) {
    return error?.code === 'ENOENT' ? '-' : `!${error?.code}`;
  }
}

export async function memoByFileIdentity(files, compute) {
  const key = files.join('\0');
  const identity = (await Promise.all(files.map(fileIdentity))).join('|');
  const hit = memo.get(key);
  if (hit !== undefined && hit.identity === identity) return hit.value;
  const value = await compute();
  memo.set(key, { identity, value });
  return value;
}
