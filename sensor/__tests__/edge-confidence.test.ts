/**
 * edges.confidence / edges.resolved_by Column Tests (ADR 0048, Lattice
 * sensor correctness fix a)
 *
 * Resolution confidence (0.3-0.95) and the resolvedBy strategy name
 * previously lived ONLY in edges.metadata JSON — invisible to any SQL-level
 * filtering/corroboration. Migration v9 adds first-class `confidence` and
 * `resolved_by` columns and backfills both from existing metadata.
 *
 * Covers:
 *   1. Migration v9 on an upgraded (pre-v9) database: columns added + backfilled.
 *   2. A brand-new database (schema.sql directly) already has both columns.
 *   3. Migration idempotency (re-running doesn't error or corrupt data).
 *   4. insertEdge / insertEdges persist edge.confidence/edge.resolvedBy into the columns.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { Node } from '../src/types';

function makeNode(id: string, name = id): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

/**
 * Recreate a pre-v9 `edges` table shape (no `confidence`/`resolved_by`
 * columns) on a database that was otherwise built at the current schema,
 * then roll the recorded version back to 8 so `runMigrations` re-applies v9.
 */
function downgradeToV8Shape(raw: ReturnType<DatabaseConnection['getDb']>): void {
  raw.exec(`
    ALTER TABLE edges RENAME TO edges_v8_shape;
    CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata TEXT,
        line INTEGER,
        col INTEGER,
        provenance TEXT DEFAULT NULL,
        FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
    );
    INSERT INTO edges (id, source, target, kind, metadata, line, col, provenance)
      SELECT id, source, target, kind, metadata, line, col, provenance FROM edges_v8_shape;
    DROP TABLE edges_v8_shape;
  `);
  raw.prepare('DELETE FROM schema_versions WHERE version >= 9').run();
}

describe('migration v9: edges.confidence / edges.resolved_by columns (ADR 0048)', () => {
  it('adds both columns and backfills them from metadata on an upgraded database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mig9-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B'), makeNode('C')]);

    downgradeToV8Shape(raw);

    // Columns are genuinely gone.
    const colsBefore = raw.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>;
    expect(colsBefore.some((c) => c.name === 'confidence')).toBe(false);
    expect(colsBefore.some((c) => c.name === 'resolved_by')).toBe(false);

    // Insert rows the way pre-v9 code did: confidence/resolvedBy only in metadata JSON.
    raw
      .prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('A', 'B', 'calls', JSON.stringify({ confidence: 0.5, resolvedBy: 'exact-match' }), 10, 2, null);
    // A row with no metadata at all must stay NULL, not error.
    raw
      .prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('A', 'C', 'contains', null, null, null, null);

    runMigrations(raw, 8);

    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);

    const colsAfter = raw.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>;
    expect(colsAfter.some((c) => c.name === 'confidence')).toBe(true);
    expect(colsAfter.some((c) => c.name === 'resolved_by')).toBe(true);

    const rows = raw
      .prepare('SELECT source, target, confidence, resolved_by FROM edges ORDER BY target')
      .all() as Array<{ source: string; target: string; confidence: number | null; resolved_by: string | null }>;
    const ab = rows.find((r) => r.target === 'B')!;
    const ac = rows.find((r) => r.target === 'C')!;
    expect(ab.confidence).toBeCloseTo(0.5);
    expect(ab.resolved_by).toBe('exact-match');
    expect(ac.confidence).toBeNull();
    expect(ac.resolved_by).toBeNull();

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent — re-running does not error or clobber already-backfilled values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mig9-idem-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B')]);

    downgradeToV8Shape(raw);
    raw
      .prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('A', 'B', 'calls', JSON.stringify({ confidence: 0.9, resolvedBy: 'import' }), null, null, null);

    runMigrations(raw, 8);
    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);

    // Re-running from the now-current version is the real-world idempotency
    // case (every `DatabaseConnection.open` does this on every startup):
    // migration v9 is filtered out (version > fromVersion) and it must not
    // throw or touch the already-backfilled data.
    expect(() => runMigrations(raw, getCurrentVersion(raw))).not.toThrow();
    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);

    // The migration's own idempotency guards (PRAGMA table_info column
    // check, `confidence IS NULL`/`resolved_by IS NULL` backfill predicates)
    // are what protect a re-application from an older recorded version, e.g.
    // a migration history table restored from backup. Simulate that
    // directly: the columns and backfilled data are already there, only the
    // version record reverts.
    raw.prepare('DELETE FROM schema_versions WHERE version = 9').run();
    expect(() => runMigrations(raw, 8)).not.toThrow();
    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);

    const row = raw
      .prepare('SELECT confidence, resolved_by FROM edges WHERE target = ?')
      .get('B') as { confidence: number; resolved_by: string };
    expect(row.confidence).toBeCloseTo(0.9);
    expect(row.resolved_by).toBe('import');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a brand-new database (schema.sql) already has both columns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mig9-fresh-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();

    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    const cols = raw.prepare('PRAGMA table_info(edges)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'confidence')).toBe(true);
    expect(cols.some((c) => c.name === 'resolved_by')).toBe(true);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('edges.confidence persistence via insertEdge/insertEdges', () => {
  it('insertEdge writes edge.confidence into the column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-conf-single-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B')]);

    q.insertEdge({
      source: 'A',
      target: 'B',
      kind: 'calls',
      confidence: 0.7,
      metadata: { confidence: 0.7, resolvedBy: 'exact-match' },
    });

    const row = raw.prepare('SELECT confidence FROM edges WHERE target = ?').get('B') as { confidence: number };
    expect(row.confidence).toBeCloseTo(0.7);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('insertEdges falls back to metadata.confidence when edge.confidence is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-conf-batch-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B'), makeNode('C')]);

    q.insertEdges([
      { source: 'A', target: 'B', kind: 'calls', metadata: { confidence: 0.42, resolvedBy: 'fuzzy' } },
      { source: 'A', target: 'C', kind: 'contains' }, // no confidence anywhere
    ]);

    const rows = raw
      .prepare('SELECT target, confidence FROM edges ORDER BY target')
      .all() as Array<{ target: string; confidence: number | null }>;
    expect(rows.find((r) => r.target === 'B')!.confidence).toBeCloseTo(0.42);
    expect(rows.find((r) => r.target === 'C')!.confidence).toBeNull();

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an explicit edge.confidence field takes precedence over metadata.confidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-conf-precedence-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B')]);

    q.insertEdge({
      source: 'A',
      target: 'B',
      kind: 'calls',
      confidence: 0.95,
      metadata: { confidence: 0.5 },
    });

    const row = raw.prepare('SELECT confidence FROM edges WHERE target = ?').get('B') as { confidence: number };
    expect(row.confidence).toBeCloseTo(0.95);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('edges.resolved_by persistence via insertEdge/insertEdges', () => {
  it('insertEdge writes edge.resolvedBy into the column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rb-single-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B')]);

    q.insertEdge({
      source: 'A',
      target: 'B',
      kind: 'calls',
      resolvedBy: 'import',
      metadata: { confidence: 0.9, resolvedBy: 'import' },
    });

    const row = raw.prepare('SELECT resolved_by FROM edges WHERE target = ?').get('B') as { resolved_by: string };
    expect(row.resolved_by).toBe('import');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('insertEdges falls back to metadata.resolvedBy when edge.resolvedBy is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rb-batch-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B'), makeNode('C')]);

    q.insertEdges([
      { source: 'A', target: 'B', kind: 'calls', metadata: { confidence: 0.42, resolvedBy: 'fuzzy' } },
      { source: 'A', target: 'C', kind: 'contains' }, // no resolvedBy anywhere
    ]);

    const rows = raw
      .prepare('SELECT target, resolved_by FROM edges ORDER BY target')
      .all() as Array<{ target: string; resolved_by: string | null }>;
    expect(rows.find((r) => r.target === 'B')!.resolved_by).toBe('fuzzy');
    expect(rows.find((r) => r.target === 'C')!.resolved_by).toBeNull();

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an explicit edge.resolvedBy field takes precedence over metadata.resolvedBy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rb-precedence-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);
    q.insertNodes([makeNode('A'), makeNode('B')]);

    q.insertEdge({
      source: 'A',
      target: 'B',
      kind: 'calls',
      resolvedBy: 'qualified-name',
      metadata: { resolvedBy: 'fuzzy' },
    });

    const row = raw.prepare('SELECT resolved_by FROM edges WHERE target = ?').get('B') as { resolved_by: string };
    expect(row.resolved_by).toBe('qualified-name');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('file-level corroboration filter: getDependentFilePaths / getDependencyFilePaths (ADR 0048)', () => {
  function makeFileNode(filePath: string): Node {
    return {
      id: `file:${filePath}`,
      kind: 'file',
      name: filePath,
      qualifiedName: filePath,
      filePath,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
  }

  it('excludes a file pair connected only by an uncorroborated resolvedBy value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-corrob-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);

    q.insertNodes([makeFileNode('a.ts'), makeFileNode('b.ts'), makeFileNode('c.ts'), makeFileNode('d.ts')]);
    q.insertNode({ ...makeNode('fnA', 'fnA'), filePath: 'a.ts' });
    q.insertNode({ ...makeNode('fnB', 'fnB'), filePath: 'b.ts' });
    q.insertNode({ ...makeNode('fnC', 'fnC'), filePath: 'c.ts' });
    q.insertNode({ ...makeNode('fnD', 'fnD'), filePath: 'd.ts' });

    // a.ts -> b.ts via an uncorroborated strategy (exact-match).
    q.insertEdges([{ source: 'fnA', target: 'fnB', kind: 'calls', line: 1, resolvedBy: 'exact-match' }]);
    // c.ts -> d.ts via a corroborated strategy (import).
    q.insertEdges([{ source: 'fnC', target: 'fnD', kind: 'calls', line: 1, resolvedBy: 'import' }]);

    expect(q.getDependentFilePaths('b.ts')).not.toContain('a.ts');
    expect(q.getDependencyFilePaths('a.ts')).not.toContain('b.ts');

    expect(q.getDependentFilePaths('d.ts')).toContain('c.ts');
    expect(q.getDependencyFilePaths('c.ts')).toContain('d.ts');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a NULL resolved_by (no strategy on record) is treated as corroborated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-corrob-null-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);

    q.insertNodes([makeFileNode('a.ts'), makeFileNode('b.ts')]);
    q.insertNode({ ...makeNode('fnA', 'fnA'), filePath: 'a.ts' });
    q.insertNode({ ...makeNode('fnB', 'fnB'), filePath: 'b.ts' });

    // No resolvedBy at all (e.g. an extraction-time synthesized edge).
    q.insertEdges([{ source: 'fnA', target: 'fnB', kind: 'calls', line: 1 }]);

    expect(q.getDependentFilePaths('b.ts')).toContain('a.ts');
    expect(q.getDependencyFilePaths('a.ts')).toContain('b.ts');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('all four uncorroborated resolvedBy values are excluded individually', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-corrob-all4-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);

    const uncorroborated = ['exact-match', 'fuzzy', 'instance-method', 'function-ref'];
    const nodes: Node[] = [];
    for (let i = 0; i < uncorroborated.length; i++) {
      nodes.push(makeFileNode(`src${i}.ts`), makeFileNode(`tgt${i}.ts`));
      nodes.push({ ...makeNode(`srcFn${i}`, `srcFn${i}`), filePath: `src${i}.ts` });
      nodes.push({ ...makeNode(`tgtFn${i}`, `tgtFn${i}`), filePath: `tgt${i}.ts` });
    }
    q.insertNodes(nodes);
    for (let i = 0; i < uncorroborated.length; i++) {
      q.insertEdges([
        { source: `srcFn${i}`, target: `tgtFn${i}`, kind: 'calls', line: 1, resolvedBy: uncorroborated[i] },
      ]);
    }

    for (let i = 0; i < uncorroborated.length; i++) {
      expect(
        q.getDependentFilePaths(`tgt${i}.ts`),
        `resolvedBy=${uncorroborated[i]} must be excluded`
      ).not.toContain(`src${i}.ts`);
    }

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('(i) a kind=imports edge is corroborated regardless of resolved_by (the edge kind itself is the import evidence)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-corrob-imports-kind-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);

    q.insertNodes([makeFileNode('a.py'), makeFileNode('b.py')]);
    q.insertNode({ ...makeNode('fnA', 'fnA'), filePath: 'a.py', language: 'python' });
    q.insertNode({ ...makeNode('fnB', 'fnB'), filePath: 'b.py', language: 'python' });

    // Mirrors the real Python import-linking edge shape observed in
    // production: kind='imports', but resolved_by is 'exact-match' as an
    // internal implementation detail of how the target was located — the
    // edge KIND already proves an import statement exists in the source.
    q.insertEdges([{ source: 'fnA', target: 'fnB', kind: 'imports', line: 1, resolvedBy: 'exact-match' }]);

    expect(q.getDependentFilePaths('b.py')).toContain('a.py');
    expect(q.getDependencyFilePaths('a.py')).toContain('b.py');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('(ii) an ambient-visibility language (go/java/c#/swift/...) is exempt from the uncorroborated-resolvedBy filter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-corrob-ambient-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);

    q.insertNodes([makeFileNode('types.go'), makeFileNode('use.go')]);
    q.insertNode({ ...makeNode('typesFn', 'Wrapped'), filePath: 'types.go', language: 'go' });
    q.insertNode({ ...makeNode('useFn', 'run'), filePath: 'use.go', language: 'go' });

    // Go has no import statement for same-package cross-file references —
    // ambient package-level visibility means resolved_by='exact-match' is
    // the ONLY way such a reference is ever resolved, never 'import'.
    q.insertEdges([{ source: 'useFn', target: 'typesFn', kind: 'calls', line: 1, resolvedBy: 'exact-match' }]);

    expect(q.getDependentFilePaths('types.go')).toContain('use.go');
    expect(q.getDependencyFilePaths('use.go')).toContain('types.go');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('(iii) a js file pair connected only by an exact-match calls edge is still excluded (regression guard)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-corrob-js-excl-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const raw = db.getDb();
    const q = new QueryBuilder(raw);

    q.insertNodes([makeFileNode('caller.js'), makeFileNode('other.js')]);
    q.insertNode({ ...makeNode('runFn', 'run'), filePath: 'caller.js', language: 'javascript' });
    q.insertNode({ ...makeNode('rejectFn', 'reject'), filePath: 'other.js', language: 'javascript' });

    q.insertEdges([{ source: 'runFn', target: 'rejectFn', kind: 'calls', line: 1, resolvedBy: 'exact-match' }]);

    expect(q.getDependentFilePaths('other.js')).not.toContain('caller.js');
    expect(q.getDependencyFilePaths('caller.js')).not.toContain('other.js');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
