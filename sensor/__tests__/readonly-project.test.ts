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

  it('serve --mcp initializes, answers a read tool and starts no daemon and no writer', async () => {
    fs.chmodSync(sensorDir, 0o555);
    let stderr = '';
    child = spawn(process.execPath, [BIN, 'serve', '--mcp'], {
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
    expect(JSON.stringify(res.result)).toContain('readonlyProbe');

    expect(stderr).toMatch(/this session is read-only/);
    expect(stderr).not.toMatch(/MCP_SERVER_FAILED|Failed to open|Proxy path failed|Tool execution failed/);
    expect(fs.readdirSync(sensorDir).filter((f) => /^(daemon|writer)\.pid/.test(f))).toEqual([]);
  }, 40_000);
});
