/**
 * u03 E15: the index is derived data (rebuilt from the source tree), so a
 * damaged database is repaired, not refused. The damaged files are moved
 * aside, never deleted, so they stay available for diagnosis.
 */
import * as fs from 'fs';
import * as path from 'path';

const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;
/** Kept damaged copies per index directory; older ones are deleted when a new one is moved aside. */
export const KEEP_BROKEN_COPIES = 3;

/** SQLite's own wording for a damaged or non-database file (SQLITE_CORRUPT / SQLITE_NOTADB). */
export function isIndexCorruption(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' && /^SQLITE_(CORRUPT|NOTADB)/.test(e.code)) return true;
  return typeof e?.message === 'string' && /malformed|not a database|SQLITE_(CORRUPT|NOTADB)/i.test(e.message);
}

/** Rename the database and its WAL sidecars to `<name>.broken-<UTC stamp>` and keep only the newest {@link KEEP_BROKEN_COPIES}. Returns the new main path, or null if there was no database. */
export function moveIndexAside(dbPath: string, now: Date = new Date()): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = `${dbPath}.broken-${stamp}`;
  fs.renameSync(dbPath, target);
  for (const suffix of SIDECAR_SUFFIXES) {
    try { fs.renameSync(dbPath + suffix, target + suffix); } catch { /* sidecar absent or held: SQLite recreates it */ }
  }
  pruneBrokenCopies(dbPath);
  return target;
}

function pruneBrokenCopies(dbPath: string): void {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.broken-`;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  // The UTC stamp sorts chronologically; sidecars (-wal/-shm) follow their main file.
  const mains = names.filter((n) => n.startsWith(prefix) && n.endsWith('Z')).sort().reverse();
  for (const old of mains.slice(KEEP_BROKEN_COPIES)) {
    for (const suffix of ['', ...SIDECAR_SUFFIXES]) {
      try { fs.rmSync(path.join(dir, old + suffix), { force: true }); } catch { /* best-effort: retried at the next move */ }
    }
  }
}
