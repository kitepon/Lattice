import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import LatticeSensor from '../src/index';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import { ToolHandler } from '../src/mcp/tools';
import { QueryPool } from '../src/mcp/query-pool';
import { Worker } from 'worker_threads';
import { __setFsWatchForTests } from '../src/sync/watcher';

describe('a degraded index annotates answers from changed files instead of refusing (#1959, u03 E13)', () => {
  let root: string;
  let cg: LatticeSensor;
  let handler: ToolHandler;
  let pool: QueryPool | undefined;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-sensor-stale-refusal-'));
    fs.mkdirSync(path.join(root, 'folder with spaces'), { recursive: true });
    fs.writeFileSync(path.join(root, 'folder with spaces/目录 🦀.ts'), 'export function unicodeSymbol() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'alpha.ts'), 'export function alphaOnly() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'beta.ts'), 'export function betaOnly() { return 2; }\n');
    fs.writeFileSync(
      path.join(root, 'gamma.ts'),
      "import { alphaOnly } from './alpha';\nexport function gammaUses() { return alphaOnly(); }\n"
    );
    cg = LatticeSensor.initSync(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);

    __setFsWatchForTests(() => {
      const err = new Error('too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    });
    expect(cg.watch()).toBe(false);
    expect(cg.isWatcherDegraded()).toBe(true);
    __setFsWatchForTests(null);
  });

  afterEach(async () => {
    await pool?.destroy();
    pool = undefined;
    await handler.closeAll();
    __setFsWatchForTests(null);
    try { cg.unwatch(); } catch { /* ignore */ }
    try { cg.close(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves the answer annotated with the changed file, and keeps unaffected source unannotated', async () => {
    const alphaPath = path.join(root, 'alpha.ts');
    const primed = await handler.execute('lattice_sensor_explore', { query: 'alphaOnly' });
    expect(primed.content[0].text).toContain('export function alphaOnly');
    const before = fs.statSync(alphaPath);
    fs.writeFileSync(alphaPath, 'export function alphaOnly() { return 9; }\n');
    // Identical size and indexed mtime: the last-mile guard must hash bytes,
    // not trust metadata or a prior two-second drift-cache verdict.
    fs.utimesSync(alphaPath, before.atime, before.mtime);

    const session = new ExploreSessionState();
    const annotated = await handler.execute('lattice_sensor_explore', { query: 'alphaOnly' }, session);
    expect(annotated.isError).toBeFalsy();
    expect(annotated.content[0].text).toContain('served this answer from a degraded index');
    expect(annotated.content[0].text).toContain('- alpha.ts');
    expect(annotated.content[0].text).toContain('alphaOnly');
    expect((annotated.structuredContent!.freshness as { stale: string[] }).stale).toEqual(['alpha.ts']);
    // Annotated source is not recorded as shown to the session.
    expect(session.view().projects).toEqual([]);

    const unaffected = await handler.execute('lattice_sensor_explore', { query: 'betaOnly' }, session);
    expect(unaffected.content[0].text).toContain('export function betaOnly');
    expect(unaffected.content[0].text).toContain('auto-sync is DISABLED');

    // Let the ordinary sync see a definite metadata change, then ensure the
    // same session receives the source it was not shown before.
    fs.utimesSync(alphaPath, before.atime, new Date(before.mtimeMs + 2000));
    await cg.sync();
    const refreshed = await handler.execute('lattice_sensor_explore', { query: 'alphaOnly' }, session);
    expect(refreshed.content[0].text).toContain('export function alphaOnly');
    expect(refreshed.content[0].text).toContain('return 9');
    expect(refreshed.content[0].text).not.toContain('served this answer from a degraded index');
  });

  it('annotates a graph answer that names a changed file, and leaves one that does not unannotated', async () => {
    const callers = await handler.execute('lattice_sensor_callers', { symbol: 'alphaOnly' });
    expect(callers.content[0].text).toContain('gammaUses');

    fs.writeFileSync(
      path.join(root, 'gamma.ts'),
      "import { alphaOnly } from './alpha';\nexport function gammaUses() { return 0; }\n"
    );

    const annotated = await handler.execute('lattice_sensor_callers', { symbol: 'alphaOnly' });
    expect(annotated.isError).toBeFalsy();
    expect(annotated.content[0].text).toContain('served this answer from a degraded index');
    expect(annotated.content[0].text).toContain('- gamma.ts');
    expect(annotated.content[0].text).toContain('gammaUses');

    const search = await handler.execute('lattice_sensor_search', { query: 'gammaUses' });
    expect(search.content[0].text).toContain('served this answer from a degraded index');

    const unaffected = await handler.execute('lattice_sensor_search', { query: 'betaOnly' });
    expect(unaffected.content[0].text).toContain('beta.ts');
    expect(unaffected.content[0].text).not.toContain('served this answer from a degraded index');
  });
  it.each([false, true])('preserves spaces and Unicode through provenance (pooled=%s)', async pooled => {
    if (pooled) {
      pool = new QueryPool({ root, size: 1, createWorker: () => new Worker(
        path.resolve(__dirname, '../dist/mcp/query-worker.js'), { workerData: { root } },
      ) });
      handler.setQueryPool(pool);
      await vi.waitFor(() => expect(pool!.ready).toBe(true), { timeout: 15000 });
    }
    const relative = 'folder with spaces/目录 🦀.ts';
    const initial = await handler.execute('lattice_sensor_search', { query: 'unicodeSymbol' });
    expect(initial.content[0].text).toContain(relative);
    expect(initial).not.toHaveProperty('_cgAnswerFiles');
    const before = fs.statSync(path.join(root, relative));
    fs.writeFileSync(path.join(root, relative), 'export function unicodeSymbol() { return 9; }\n');
    fs.utimesSync(path.join(root, relative), before.atime, before.mtime);
    const result = await handler.execute('lattice_sensor_search', { query: 'unicodeSymbol' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('served this answer from a degraded index');
    expect(result.content[0].text).toContain(relative);
    expect(result.structuredContent).toMatchObject({ freshness: { stale: [relative], unchecked: [] } });
    expect(result).not.toHaveProperty('_cgAnswerFiles');
  });

  it.each(['lattice_sensor_search', 'lattice_sensor_explore', 'lattice_sensor_callers', 'lattice_sensor_callees', 'lattice_sensor_impact'])(
    'annotates deleted contributing files in %s', async tool => {
      fs.unlinkSync(path.join(root, 'alpha.ts'));
      const result = await handler.execute(tool, { query: 'alphaOnly', symbol: 'alphaOnly' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('served this answer from a degraded index');
      expect(result.content[0].text).toContain('alpha.ts');
      expect(result).not.toHaveProperty('_cgExploreEmission');
    },
  );

  it('annotates rather than silently validating only the first 200 contributing files', async () => {
    for (let i = 0; i < 201; i++) {
      fs.writeFileSync(path.join(root, `caller${i}.ts`),
        `import { alphaOnly } from './alpha'; export function caller${i}() { return alphaOnly(); }\n`);
    }
    await cg.indexAll();
    const raw = await handler.executeReadTool('lattice_sensor_impact', { symbol: 'alphaOnly' });
    expect(raw._cgAnswerFiles!.length).toBeGreaterThan(200);
    const result = await handler.execute('lattice_sensor_impact', { symbol: 'alphaOnly' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('validation budget');
    expect((result.structuredContent!.freshness as { unchecked: string[] }).unchecked.length).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('**Impact');
  });

});
