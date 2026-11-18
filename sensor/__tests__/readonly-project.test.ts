/**
 * A project folder that cannot be written (read-only mount, Aiterm fork write-ban) is served read-only: no MCP start failure,
 * no daemon, reads answer. u03 sweep E4 contract; the writer lock answers `taken` with the errno that refused the write.
 * POSIX only: the folder is made unwritable with chmod, which root and Windows ignore.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LatticeSensor } from '../src';
import { projectWritable, tryAcquireWriterLock } from '../src/mcp/writer-lock';
import { terminateChild } from './child-process';

const BIN = path.resolve(__dirname, '../dist/bin/lattice-sensor.js');
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

function request(child: ChildProcessWithoutNullStreams, msg: { id: number; method: string; params?: unknown }): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for response id=${msg.id}`)), 20_000);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        try {
          const parsed = JSON.parse(line) as Record<string, any>;
          if (parsed.id === msg.id) { clearTimeout(timer); child.stdout.off('data', onData); resolve(parsed); return; }
        } catch { /* noise */ }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

describe.skipIf(!canChmod)('a project folder that cannot be written is served read-only', () => {
  let root: string;
  let sensorDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-readonly-')));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function readonlyProbe() { return 1; }\n');
    const cg = await LatticeSensor.init(root);
    await cg.indexAll();
    cg.close();
    sensorDir = path.join(root, '.lattice/sensor');
  });

  afterEach(async () => {
    if (child) { await terminateChild(child); child = null; }
    fs.chmodSync(sensorDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('the writer lock answers taken with the errno; a writable folder is unchanged', () => {
    expect(projectWritable(root)).toBe(true);
    const acquired = tryAcquireWriterLock(root, 'direct');
    expect(acquired.kind).toBe('acquired');
    fs.rmSync(path.join(sensorDir, 'writer.pid'));

    fs.chmodSync(sensorDir, 0o555);
    expect(projectWritable(root)).toBe(false);
    const refused = tryAcquireWriterLock(root, 'direct');
    expect(refused).toMatchObject({ kind: 'taken', existing: null, unwritable: expect.stringMatching(/^(EACCES|EPERM|EROFS)$/) });
  });

  /** A real `serve --mcp` on the project (command prefix = how the folder is made unwritable); the read tool must answer. */
  async function serveAndRead(prefix: string[] = []): Promise<void> {
    let stderr = '';
    const [command, ...args] = [...prefix, process.execPath, BIN, 'serve', '--mcp'];
    child = spawn(command!, args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LATTICE_SENSOR_WASM_RELAUNCHED: '1', LATTICE_SENSOR_NO_RELAUNCH: '1' },
    }) as ChildProcessWithoutNullStreams;
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    const init = await request(child, {
      id: 0, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' }, rootUri: `file://${root}` },
    });
    expect(init.error).toBeUndefined();

    const res = await request(child, {
      id: 1, method: 'tools/call',
      params: { name: 'lattice_sensor_search', arguments: { query: 'readonlyProbe', projectPath: root } },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.isError, JSON.stringify(res.result) + stderr).not.toBe(true);
    expect(JSON.stringify(res.result), stderr).toContain('readonlyProbe');

    expect(stderr).toMatch(/this session is read-only/);
    expect(stderr).not.toMatch(/MCP_SERVER_FAILED|Failed to open|Proxy path failed|Tool execution failed/);
    expect(fs.readdirSync(sensorDir).filter((f) => /^(daemon|writer)\.pid/.test(f))).toEqual([]);
  }

  it('serve --mcp initializes, answers a read tool and starts no daemon and no writer', async () => {
    fs.chmodSync(sensorDir, 0o555);
    await serveAndRead();
  }, 40_000);

  /**
   * A BellTeam fork has no default index: cwd is outside the project and the index is reached through `projectPath` only.
   * The explicit project must be opened read-only too (the engine itself is not readOnly), answering status and explore
   * without creating a file.
   */
  async function serveExplicit(prefix: string[] = []): Promise<void> {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-readonly-cwd-')));
    let stderr = '';
    const [command, ...args] = [...prefix, process.execPath, BIN, 'serve', '--mcp'];
    child = spawn(command!, args, {
      cwd: elsewhere,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LATTICE_SENSOR_WASM_RELAUNCHED: '1', LATTICE_SENSOR_NO_RELAUNCH: '1' },
    }) as ChildProcessWithoutNullStreams;
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    try {
      const before = fs.readdirSync(sensorDir).sort();
      const init = await request(child, {
        id: 0, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
      });
      expect(init.error).toBeUndefined();
      let id = 1;
      for (const [name, args2] of [
        ['lattice_sensor_status', {}],
        ['lattice_sensor_explore', { query: 'readonlyProbe' }],
      ] as const) {
        const res = await request(child, { id: id++, method: 'tools/call', params: { name, arguments: { ...args2, projectPath: root } } });
        expect(res.error).toBeUndefined();
        expect(res.result.isError, `${name}: ${JSON.stringify(res.result)}${stderr}`).not.toBe(true);
        expect(JSON.stringify(res.result)).not.toMatch(/readonly database|SQLITE_/i);
      }
      expect(fs.readdirSync(sensorDir).sort()).toEqual(before);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }

  it('an explicit projectPath on a write-banned index answers status and explore and creates no file', async () => {
    for (const f of fs.readdirSync(sensorDir)) { if (f.startsWith('sensor.db')) fs.chmodSync(path.join(sensorDir, f), 0o444); }
    fs.chmodSync(sensorDir, 0o555);
    await serveExplicit();
  }, 40_000);

  it.skipIf(process.platform !== 'darwin')('an explicit projectPath under sandbox-exec deny file-write* (macOS write-ban)', async () => {
    await serveExplicit(['/usr/bin/sandbox-exec', '-p', `(version 1)(allow default)(deny file-write* (subpath "${root}"))`]);
  }, 40_000);

  // The real Aiterm fork write-ban (aiterm-mcp src/write-ban.ts): SQLite answers SQLITE_CANTOPEN there, not READONLY.
  // The deny matches the real path only (a path under mktemp's /var does not match), hence realpathSync in beforeEach.
  it.skipIf(process.platform !== 'darwin')('under sandbox-exec deny file-write* on the project (macOS write-ban)', async () => {
    await serveAndRead(['/usr/bin/sandbox-exec', '-p', `(version 1)(allow default)(deny file-write* (subpath "${root}"))`]);
  }, 40_000);
});
