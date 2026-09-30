/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Current schema version
 */
// Lattice numbered its own migrations 9–12 before the 2026-09-30 upstream sync;
// upstream independently numbered 9–11. Lattice databases in the field are at 12,
// so upstream's three are carried as 13–15 (same idea as EXTRACTION_VERSION: the
// merged number must be above both, never a pick).
export const CURRENT_SCHEMA_VERSION = 15;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description:
      'Drop redundant idx_edges_source / idx_edges_target (covered by source_kind / target_kind composites)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_source;
        DROP INDEX IF EXISTS idx_edges_target;
      `);
    },
  },
  {
    version: 5,
    description:
      'Add nodes.return_type — normalized return/result type for receiver-type inference (C++ singletons/factories, #645)',
    up: (db) => {
      db.exec(`
        ALTER TABLE nodes ADD COLUMN return_type TEXT;
      `);
    },
  },
  {
    version: 6,
    description:
      'Dedup duplicate edge rows and add a UNIQUE identity index so INSERT OR IGNORE actually dedups (#1034)',
    up: (db) => {
      // `insertEdge` has always used `INSERT OR IGNORE`, but the edges table had
      // no UNIQUE constraint, so nothing conflicted and byte-identical rows
      // accumulated whenever two passes emitted the same edge. Collapse each
      // identity group to its lowest id, then add the constraint that makes
      // `OR IGNORE` keep its promise. IFNULL folds nullable line/col so
      // coordinate-less edges dedup too (SQLite treats each NULL as distinct) —
      // and it MUST match the GROUP BY exactly, or the index creation would
      // fail on a pair the DELETE left behind. Idempotent: the index is
      // `IF NOT EXISTS` and the DELETE is a no-op once the table is unique.
      db.exec(`
        DELETE FROM edges
        WHERE id NOT IN (
          SELECT MIN(id) FROM edges
          GROUP BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
          ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
      `);
    },
  },
  {
    version: 7,
    description:
      'Add name_segment_vocab — prose-word → symbol-name lookup for the prompt hook’s graph-derived gate',
    up: (db) => {
      // DDL only — instant on any size database (the row-churn hazards of #1067
      // don't apply). The table starts EMPTY on migrated databases; `sync`
      // detects that over a populated graph and backfills batched+yielding
      // (LatticeSensor.rebuildNameSegmentVocab), and any full index rebuilds it
      // from scratch. Keep the definition in lockstep with schema.sql.
      db.exec(`
        CREATE TABLE IF NOT EXISTS name_segment_vocab (
          segment TEXT NOT NULL,
          name TEXT NOT NULL,
          PRIMARY KEY (segment, name)
        ) WITHOUT ROWID;
      `);
    },
  },
  {
    version: 8,
    description:
      'Track attempted-but-unresolvable refs as status=failed so sync can retry them when a changed file adds a matching symbol (#1240)',
    up: (db) => {
      // DDL only — instant on any size database. No backfill needed: rows are
      // only ever queried by name_tail once they carry status='failed', and
      // both fields are written together by markReferencesFailed. Legacy rows
      // (all 'pending' after this migration) are orphans from interrupted runs
      // that the #1187 sweep grinds down on the next sync, marking survivors
      // failed with their tails as it goes. The tail index is partial: on a
      // healthy index the pending set is empty and the failed set is the only
      // population worth indexing. Keep the definitions in lockstep with
      // schema.sql. ALTER TABLE has no IF NOT EXISTS, so guard each column for
      // idempotency — a database created from current schema.sql already has
      // both (matters when migrations are re-run from an older recorded
      // version, as the v6 regression test does).
      const cols = db.prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{ name: string }>;
      const hasColumn = (name: string) => cols.some((c) => c.name === name);
      if (!hasColumn('status')) {
        db.exec("ALTER TABLE unresolved_refs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
      }
      if (!hasColumn('name_tail')) {
        db.exec("ALTER TABLE unresolved_refs ADD COLUMN name_tail TEXT NOT NULL DEFAULT ''");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_unresolved_status ON unresolved_refs(status);
        CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail ON unresolved_refs(name_tail) WHERE status = 'failed';
      `);
    },
  },
  {
    version: 12,
    description:
      'files.extraction_version — EXTRACTION_VERSION of the engine that wrote each row (DEFAULT 0 = pre-stamp). Sync re-extracts rows whose stamp is BELOW the running engine, so extractor upgrades heal incrementally instead of relying on a manual full re-index that the status hint merely recommends. Rows stamped above the running engine are left untouched: rewriting them would downgrade the index',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'extraction_version')) {
        db.exec('ALTER TABLE files ADD COLUMN extraction_version INTEGER NOT NULL DEFAULT 0');
      }
    },
  },
  {
    version: 11,
    description:
      'nodes.extent_start_line — first line including preceding decorators/attributes, so extent-based extraction does not orphan Python @decorators / Rust #[attributes] (startLine stays the declaration: it participates in node identity)',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'extent_start_line')) {
        db.exec('ALTER TABLE nodes ADD COLUMN extent_start_line INTEGER');
      }
    },
  },
  {
    version: 10,
    description:
      'Carry import binding shape (default/named/namespace + source-side name) on unresolved refs so resolved import edges can expose it — rewrite tooling reproduces the binding without re-parsing import text',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{ name: string }>;
      const hasColumn = (name: string) => cols.some((c) => c.name === name);
      if (!hasColumn('binding_form')) {
        db.exec('ALTER TABLE unresolved_refs ADD COLUMN binding_form TEXT');
      }
      if (!hasColumn('imported_name')) {
        db.exec('ALTER TABLE unresolved_refs ADD COLUMN imported_name TEXT');
      }
    },
  },
  {
    version: 9,
    description:
      'Persist resolution confidence and resolvedBy as their own edges columns (ADR 0048) — previously they only lived in edges.metadata JSON, invisible to index-level filtering/corroboration',
    up: (db) => {
      // ALTER TABLE has no IF NOT EXISTS, so guard for idempotency — a database
      // created from current schema.sql already has the columns (matters when
      // migrations are re-run from an older recorded version, same pattern as
      // v8 above). Keep the definitions in lockstep with schema.sql.
      const cols = db.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>;
      const hasColumn = (name: string) => cols.some((c) => c.name === name);
      if (!hasColumn('confidence')) {
        db.exec('ALTER TABLE edges ADD COLUMN confidence REAL');
      }
      if (!hasColumn('resolved_by')) {
        db.exec('ALTER TABLE edges ADD COLUMN resolved_by TEXT');
      }
      // Backfill from the JSON metadata every resolved edge already carries —
      // only new/re-resolved edges will populate the columns directly going
      // forward, so existing rows would otherwise read NULL forever.
      db.exec(`
        UPDATE edges SET confidence = json_extract(metadata, '$.confidence')
        WHERE metadata IS NOT NULL AND confidence IS NULL
      `);
      db.exec(`
        UPDATE edges SET resolved_by = json_extract(metadata, '$.resolvedBy')
        WHERE metadata IS NOT NULL AND resolved_by IS NULL
      `);
    },
  },
  {
    version: 13,
    description:
      'Add files.generated — index-time content-header generated-file detection for ranking (#1500)',
    up: (db) => {
      // DDL only — instant on any size database, and NO backfill: the flag is
      // derived from file CONTENT, which this migration has no access to (the
      // files table stores a hash, not the bytes). Migrated rows therefore stay
      // 0 until the next full index re-extracts them, and every reader unions
      // the flag with the path-only check, so an un-backfilled database keeps
      // exactly the pre-#1500 behavior instead of regressing. `sync` heals it
      // file-by-file as files change. This is why the CHANGELOG entry says a
      // re-index is required to pick up the new detection.
      //
      // ALTER TABLE has no IF NOT EXISTS, so guard for idempotency — a database
      // created from current schema.sql already has the column (matters when
      // migrations are re-run from an older recorded version, as the v6
      // regression test does). Keep in lockstep with schema.sql.
      const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'generated')) {
        db.exec('ALTER TABLE files ADD COLUMN generated INTEGER NOT NULL DEFAULT 0');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_files_generated ON files(path) WHERE generated = 1'
      );
    },
  },
  {
    version: 14,
    description: 'Track synthesis inputs and stabilize synthesis traversal for incremental refresh (#1988)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_nodes_kind;
        CREATE INDEX idx_nodes_kind ON nodes(kind, file_path, start_line, id);
        CREATE TABLE IF NOT EXISTS synthesis_inputs (
          file_path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_edges_synthesis_site ON edges(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.registeredAt') END)
          WHERE CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.synthesizedBy') END IS NOT NULL;
        UPDATE edges SET metadata = json_set(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.synthesizedBy', 'go-method-contains')
          WHERE kind = 'contains' AND provenance IS NULL AND EXISTS (
            SELECT 1 FROM nodes s JOIN nodes t ON t.id = edges.target
            WHERE s.id = edges.source AND s.language = 'go' AND t.language = 'go'
              AND s.kind IN ('struct', 'class', 'interface', 'enum', 'type_alias') AND t.kind = 'method'
              AND s.file_path != t.file_path
          );
        INSERT OR REPLACE INTO project_metadata(key, value, updated_at)
          VALUES ('synthesis_pending', '1', 0);
      `);
    },
  },
  {
    version: 15,
    description: 'Guard synthesis metadata lookups against malformed JSON',
    up: (db) => {
      // Existing v14 (upstream v10) indexes keep their old expression under IF NOT EXISTS.
      // Rebuild transactionally; the guarded v10 definition also lets older
      // databases containing malformed metadata reach this migration safely.
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_synthesis_site;
        CREATE INDEX idx_edges_synthesis_site
          ON edges(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.registeredAt') END)
          WHERE CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.synthesizedBy') END IS NOT NULL;
      `);
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  // OR REPLACE: re-running from an older recorded version (a migration history
  // restored from backup, or a partially-reverted history) re-applies every
  // migration above the gap. Migrations themselves are idempotent by contract;
  // the RECORD write must be too, or the first version above the gap that is
  // still recorded blows up on the UNIQUE constraint — first reachable once a
  // v(N+1) exists above a reverted v(N), so it stayed latent until v10.
  db.prepare(
    'INSERT OR REPLACE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Check if the database needs migration
 */
export function needsMigration(db: SqliteDatabase): boolean {
  const current = getCurrentVersion(db);
  return current < CURRENT_SCHEMA_VERSION;
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}

/**
 * Get migration history from database
 */
export function getMigrationHistory(
  db: SqliteDatabase
): Array<{ version: number; appliedAt: number; description: string | null }> {
  const rows = db
    .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version')
    .all() as Array<{ version: number; applied_at: number; description: string | null }>;

  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    description: row.description,
  }));
}
