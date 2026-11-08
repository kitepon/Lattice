/**
 * u03 E15: a damaged default index is derived data, so the serving engine moves
 * it aside, rebuilds it from the source tree, and says so on stderr instead of
 * failing closed until someone clears it by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LatticeSensor } from '../src';
import type { MCPEngine } from '../src/mcp/engine';
import { isIndexCorruption, moveIndexAside } from '../src/mcp/index-repair';
import { getWriterPidPath } from '../src/mcp/writer-lock';

// The shipped build: the engine lazy-loads the CommonJS chain, which vitest cannot resolve from src.
const { MCPEngine: BuiltMCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');

describe('index self-repair (u03 E15)', () => {
  let root: string;
  let holder: ChildProcess | null = null;
  let engine: MCPEngine | null = null;
  let stderr: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  const dbFile = () => path.join(root, '.lattice', 'sensor', 'sensor.db');
  const sensorDir = () => path.dirname(dbFile());
  const asides = () => fs.readdirSync(sensorDir()).filter((f) => /^sensor\.db\.broken-.*Z$/.test(f));

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e15-')));
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function repairedMarker(): number { return 1; }\n');
    const cg = await LatticeSensor.init(root, { index: true });
    cg.close();
    // Keep the SQLite header, destroy the schema page: opening fails as "malformed".
    const fd = fs.openSync(dbFile(), 'r+');
    fs.writeSync(fd, Buffer.alloc(3000, 0xa5), 0, 3000, 100);
    fs.closeSync(fd);
    stderr = [];
    spy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write);
  });

  afterEach(async () => {
    try { holder?.kill('SIGKILL'); } catch { /* gone */ }
    holder = null;
    await engine?.stop();
    engine = null;
    spy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function liveHolder(): number {
    holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (!holder.pid) throw new Error('Failed to spawn lock holder');
    return holder.pid;
  }

  it('recognizes SQLite damage and nothing else', () => {
    expect(isIndexCorruption(new Error('database disk image is malformed'))).toBe(true);
    expect(isIndexCorruption(new Error('file is not a database'))).toBe(true);
    expect(isIndexCorruption(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(true);
    expect(isIndexCorruption(new Error('database is locked'))).toBe(false);
    expect(isIndexCorruption(new Error('schema version 99 is newer'))).toBe(false);
  });

  it('moves the database and its sidecars aside without deleting them', () => {
    fs.writeFileSync(`${dbFile()}-wal`, 'wal');
    const target = moveIndexAside(dbFile(), new Date('2026-11-08T00:00:00.000Z'));
    expect(target).toBe(`${dbFile()}.broken-2026-11-08T00-00-00-000Z`);
    expect(fs.existsSync(dbFile())).toBe(false);
    expect(fs.readFileSync(`${target}-wal`, 'utf8')).toBe('wal');
    expect(moveIndexAside(dbFile())).toBeNull();
  });

  it('keeps only the newest 3 damaged copies, with their sidecars', () => {
    const stamps = [1, 2, 3, 4, 5].map((d) => new Date(Date.UTC(2026, 10, d)));
    for (const at of stamps) {
      fs.writeFileSync(dbFile(), 'db');
      fs.writeFileSync(`${dbFile()}-wal`, 'wal');
      moveIndexAside(dbFile(), at);
    }
    const kept = fs.readdirSync(sensorDir()).filter((f) => f.startsWith('sensor.db.broken-')).sort();
    expect(kept).toEqual(['03', '04', '05'].flatMap((d) => [`sensor.db.broken-2026-11-${d}T00-00-00-000Z`, `sensor.db.broken-2026-11-${d}T00-00-00-000Z-wal`]).sort());
  });

  it('rebuilds a damaged default index on the next request and keeps the damaged files', async () => {
    engine = new BuiltMCPEngine({ watch: false });
    await engine.ensureInitialized(root);
    expect(engine.hasDefaultLatticeSensor()).toBe(false);

    const res = await engine.getToolHandler().execute('lattice_sensor_search', { query: 'repairedMarker' });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/repairedMarker/);
    expect(engine.hasDefaultLatticeSensor()).toBe(true);
    expect(asides()).toHaveLength(1);
    const lines = stderr.join('').split('\n').filter((l) => /moved it to .*sensor\.db\.broken-/.test(l));
    expect(lines).toHaveLength(1);
    expect(fs.existsSync(path.join(sensorDir(), 'rebuild.pid'))).toBe(false);
  });

  it('answers a rebuild already in progress as retryable guidance, and repairs once it ends', async () => {
    engine = new BuiltMCPEngine({ watch: false });
    await engine.ensureInitialized(root);
    const rebuildPid = path.join(sensorDir(), 'rebuild.pid');
    fs.writeFileSync(rebuildPid, JSON.stringify({ pid: liveHolder(), mode: 'rebuild', startedAt: Date.now() }) + '\n');

    const waiting = await engine.getToolHandler().execute('lattice_sensor_search', { query: 'repairedMarker' });
    expect(waiting.isError).toBeUndefined();
    expect(waiting.content[0]!.text).toMatch(/rebuild is in progress/);
    expect(asides()).toHaveLength(0);

    fs.rmSync(rebuildPid);
    const done = await engine.getToolHandler().execute('lattice_sensor_search', { query: 'repairedMarker' });
    expect(done.content[0]!.text).toMatch(/repairedMarker/);
    expect(asides()).toHaveLength(1);
  });

  it('leaves a typed, retryable error while another process owns the writer slot', async () => {
    engine = new BuiltMCPEngine({ watch: false });
    await engine.ensureInitialized(root);
    const writerPid = getWriterPidPath(root);
    fs.writeFileSync(writerPid, JSON.stringify({ pid: liveHolder(), mode: 'daemon', startedAt: Date.now() }) + '\n');

    const refused = await engine.getToolHandler().execute('lattice_sensor_search', { query: 'repairedMarker' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/another process owns it; it will be retried/);
    expect(asides()).toHaveLength(0);
    expect(fs.existsSync(path.join(sensorDir(), 'rebuild.pid'))).toBe(false);

    fs.rmSync(writerPid);
    const retried = await engine.getToolHandler().execute('lattice_sensor_search', { query: 'repairedMarker' });
    expect(retried.content[0]!.text).toMatch(/repairedMarker/);
  });

  it('does not repair from a read-only engine', async () => {
    engine = new BuiltMCPEngine({ watch: false, readOnly: true });
    await engine.ensureInitialized(root);
    const res = await engine.getToolHandler().execute('lattice_sensor_search', { query: 'repairedMarker' });
    expect(res.content[0]!.text).not.toMatch(/repairedMarker\(/);
    expect(asides()).toHaveLength(0);
  });
});
