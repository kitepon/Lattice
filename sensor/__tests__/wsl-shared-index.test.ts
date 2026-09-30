/**
 * Windows + WSL sharing one index on a Windows drive (issue #995).
 *
 * When Windows-native LatticeSensor and WSL LatticeSensor both open the same
 * `.lattice/sensor/sensor.db` under `/mnt/<drive>/`, SQLite's locking and `-shm`
 * shared memory don't hold across the 9p/DrvFs bridge and WSL fails with a bare
 * "disk I/O error". These tests pin both halves of the fix:
 *
 *  - a fresh WSL index there gets its own `.lattice/sensor-wsl`, while an index
 *    already in `.lattice/sensor` stays where it is (no silent re-index), and
 *  - such an error is rewritten into the `LATTICE_SENSOR_DIR=.lattice/sensor-wsl`
 *    instruction — only on WSL, only under `/mnt/<drive>`, only for the
 *    default-named index — which MCP answers SUCCESS-shaped (never `isError`,
 *    see AGENTS.md "Errors teach abandonment").
 *
 * WSL detection is injected, the way the watch-policy tests inject it, so the
 * decision runs on any host. The end-to-end cases raise a REAL node:sqlite I/O
 * error by planting a FIFO where SQLite expects the `-shm` file: its lock
 * calls fail exactly like a cross-OS lock does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import LatticeSensor from '../src/index';
import { DatabaseConnection } from '../src/db';
import { WslSharedIndexError, isSqliteIoError, toWslSharedIndexError } from '../src/db/wsl-shared-index';
import { latticeSensorRelativeDirFor, findNearestLatticeSensorRoot, getLatticeSensorDir, isInitialized } from '../src/directory';
import { __setWslWindowsDriveForTests, isWslWindowsDrive } from '../src/sync/watch-policy';
import { ToolHandler } from '../src/mcp/tools';

// Engine default-project opens use its lazy CommonJS loader, so the engine
// cases drive the built modules (and set the built module's override).
const { MCPEngine: BuiltMCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');
const builtWatchPolicy = require('../dist/sync/watch-policy') as typeof import('../src/sync/watch-policy');

/** Every path counts as a Windows drive seen from WSL. */
const onWslDrive = (): boolean => true;

const SHARED_DB = '/mnt/c/src/app/.lattice/sensor/sensor.db';

/** A node:sqlite-shaped I/O error (SQLITE_IOERR_LOCK). */
function ioError(): Error {
  return Object.assign(new Error('disk I/O error'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 3850,
    errstr: 'disk I/O error',
  });
}

function sharedIndexError(): WslSharedIndexError {
  return toWslSharedIndexError(ioError(), SHARED_DB, { isWsl: true })!;
}

describe('isSqliteIoError', () => {
  it('matches the whole SQLITE_IOERR family by its extended code', () => {
    for (const errcode of [10, 522, 3850, 4618, 5130]) {
      expect(isSqliteIoError(Object.assign(new Error('x'), { errcode }))).toBe(true);
    }
  });

  it('does not match other SQLite failures', () => {
    // BUSY, CORRUPT, CANTOPEN, UNIQUE constraint
    for (const errcode of [5, 11, 14, 2067]) {
      expect(isSqliteIoError(Object.assign(new Error('disk I/O error'), { errcode }))).toBe(false);
    }
  });

  it('falls back to the message when no code survived', () => {
    expect(isSqliteIoError(new Error('disk I/O error'))).toBe(true);
    expect(isSqliteIoError(new Error('database is locked'))).toBe(false);
    expect(isSqliteIoError('disk I/O error')).toBe(false);
    expect(isSqliteIoError(null)).toBe(false);
  });
});

describe('toWslSharedIndexError', () => {
  it('rewrites an I/O error on the default index of a WSL /mnt/<drive> project', () => {
    const original = ioError();
    const err = toWslSharedIndexError(original, SHARED_DB, { isWsl: true });
    expect(err).toBeInstanceOf(WslSharedIndexError);
    expect(err!.name).toBe('WslSharedIndexError');
    expect(err!.message).toContain('disk I/O error on the LatticeSensor index at /mnt/c/src/app/.lattice/sensor\n');
    expect(err!.message).toContain("Windows and WSL can't share one index on a Windows drive");
    expect(err!.message).toContain('LATTICE_SENSOR_DIR=.lattice/sensor-wsl');
    expect(err!.message).toContain('lattice sensor init');
    // The original stays reachable, and its SQLite codes still read the same.
    expect(err!.cause).toBe(original);
    expect(err!.errcode).toBe(3850);
    expect(err!.code).toBe('ERR_SQLITE_ERROR');
  });

  it('is idempotent', () => {
    const err = sharedIndexError();
    expect(toWslSharedIndexError(err, SHARED_DB, { isWsl: true })).toBe(err);
  });

  it('leaves the error alone off WSL', () => {
    expect(toWslSharedIndexError(ioError(), SHARED_DB, { isWsl: false })).toBeNull();
  });

  it('leaves the error alone on a native WSL path', () => {
    expect(toWslSharedIndexError(ioError(), '/home/me/app/.lattice/sensor/sensor.db', { isWsl: true })).toBeNull();
  });

  it('does not treat /mnt/wsl (a Linux mount) as a Windows drive', () => {
    expect(toWslSharedIndexError(ioError(), '/mnt/wsl/app/.lattice/sensor/sensor.db', { isWsl: true })).toBeNull();
  });

  it('leaves the error alone when WSL already has its own index directory', () => {
    // The advice would be wrong: LATTICE_SENSOR_DIR is already split.
    expect(toWslSharedIndexError(ioError(), '/mnt/c/src/app/.lattice/sensor-wsl/sensor.db', { isWsl: true })).toBeNull();
  });

  it('leaves other SQLite errors alone', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
    expect(toWslSharedIndexError(busy, SHARED_DB, { isWsl: true })).toBeNull();
  });

  // Real detection: WSL is a Linux kernel, so on any other host the rewrite
  // can never fire, whatever the path looks like.
  it.runIf(process.platform !== 'linux')('never fires off Linux with real detection', () => {
    expect(toWslSharedIndexError(ioError(), SHARED_DB)).toBeNull();
  });

});

async function makeProject(dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sample.ts'), 'export function parseToken() { return 1; }\n');
  (await LatticeSensor.init(dir, { index: true })).close();
}

describe('the data directory on a Windows drive under WSL', () => {
  let root: string;
  const prevDir = process.env.LATTICE_SENSOR_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-sensor-wsl-dir-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function parseToken() { return 1; }\n');
    delete process.env.LATTICE_SENSOR_DIR;
  });

  afterEach(() => {
    __setWslWindowsDriveForTests(null);
    if (prevDir === undefined) delete process.env.LATTICE_SENSOR_DIR;
    else process.env.LATTICE_SENSOR_DIR = prevDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives a fresh project its own .lattice/sensor-wsl', async () => {
    __setWslWindowsDriveForTests(onWslDrive);
    expect(latticeSensorRelativeDirFor(root)).toBe('.lattice/sensor-wsl');
    const cg = await LatticeSensor.init(root, { index: true });
    cg.close();
    expect(fs.existsSync(path.join(root, '.lattice/sensor-wsl', 'sensor.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.lattice/sensor'))).toBe(false);
    // It keeps itself out of git like .lattice/sensor does.
    expect(fs.readFileSync(path.join(root, '.lattice/sensor-wsl', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
    expect(findNearestLatticeSensorRoot(path.join(root, 'src'))).toBe(root);
  });

  it('keeps an index already built in .lattice/sensor, without a re-index', async () => {
    const built = await LatticeSensor.init(root, { index: true });
    const nodes = built.getStats().nodeCount;
    built.close();
    __setWslWindowsDriveForTests(onWslDrive);
    expect(getLatticeSensorDir(root)).toBe(path.join(root, '.lattice/sensor'));
    expect(isInitialized(root)).toBe(true);
    const reopened = LatticeSensor.openSync(root);
    expect(reopened.getStats().nodeCount).toBe(nodes);
    reopened.close();
    expect(fs.existsSync(path.join(root, '.lattice/sensor-wsl'))).toBe(false);
  });

  it('stays on .lattice/sensor-wsl after Windows builds a .lattice/sensor beside it', async () => {
    __setWslWindowsDriveForTests(onWslDrive);
    (await LatticeSensor.init(root, { index: true })).close();
    // Windows-native LatticeSensor indexes the same tree afterwards.
    __setWslWindowsDriveForTests(() => false);
    (await LatticeSensor.init(root, { index: true })).close();
    expect(fs.existsSync(path.join(root, '.lattice/sensor', 'sensor.db'))).toBe(true);
    __setWslWindowsDriveForTests(onWslDrive);
    expect(latticeSensorRelativeDirFor(root)).toBe('.lattice/sensor-wsl');
  });

  it('does not count a .lattice/sensor with no database as an index', () => {
    __setWslWindowsDriveForTests(onWslDrive);
    fs.mkdirSync(path.join(root, '.lattice/sensor'), { recursive: true });
    expect(latticeSensorRelativeDirFor(root)).toBe('.lattice/sensor-wsl');
  });

  it('lets LATTICE_SENSOR_DIR decide', () => {
    __setWslWindowsDriveForTests(onWslDrive);
    process.env.LATTICE_SENSOR_DIR = '.lattice/sensor-custom';
    expect(latticeSensorRelativeDirFor(root)).toBe('.lattice/sensor-custom');
    process.env.LATTICE_SENSOR_DIR = '.lattice/sensor';
    expect(latticeSensorRelativeDirFor(root)).toBe('.lattice/sensor');
  });

  it('keeps .lattice/sensor off a Windows drive', () => {
    __setWslWindowsDriveForTests(() => false);
    expect(latticeSensorRelativeDirFor(root)).toBe('.lattice/sensor');
  });

  // Real detection: only a Linux kernel can be WSL.
  it.runIf(process.platform !== 'linux')('keeps .lattice/sensor off Linux with real detection', () => {
    expect(isWslWindowsDrive('/mnt/c/src/app')).toBe(false);
    expect(latticeSensorRelativeDirFor(root)).toBe('.lattice/sensor');
  });
});

/** Replace the index's `-shm` with a FIFO: SQLite's first read then fails with a real SQLITE_IOERR. */
function breakSharedMemory(dbPath: string): void {
  fs.rmSync(`${dbPath}-shm`, { force: true });
  execFileSync('mkfifo', [`${dbPath}-shm`]);
}

// mkfifo is POSIX-only.
describe.runIf(process.platform !== 'win32')('a real SQLite I/O error on open', () => {
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-sensor-wsl-shared-'));
    await makeProject(root);
    dbPath = path.join(root, '.lattice/sensor', 'sensor.db');
    breakSharedMemory(dbPath);
  });

  afterEach(() => {
    __setWslWindowsDriveForTests(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('surfaces as the actionable message on WSL + /mnt/<drive>', () => {
    __setWslWindowsDriveForTests(onWslDrive);
    let thrown: unknown;
    try {
      DatabaseConnection.open(dbPath).close();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WslSharedIndexError);
    // Pins node:sqlite's error shape: the extended code sits on `errcode`.
    const cause = (thrown as WslSharedIndexError).cause as { errcode?: number; message?: string };
    expect(cause.errcode! & 0xff).toBe(10);
    expect(cause.message).toBe('disk I/O error');
    expect((thrown as Error).message).toContain('LATTICE_SENSOR_DIR=.lattice/sensor-wsl');
  });

  it('stays the raw SQLite error everywhere else', () => {
    __setWslWindowsDriveForTests(() => false);
    let thrown: unknown;
    try {
      DatabaseConnection.open(dbPath).close();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(WslSharedIndexError);
    expect((thrown as Error).message).toBe('disk I/O error');
  });

  describe('through the MCP engine', () => {
    let engine: import('../src/mcp/engine').MCPEngine | undefined;

    beforeEach(() => {
      builtWatchPolicy.__setWslWindowsDriveForTests(onWslDrive);
    });

    afterEach(async () => {
      builtWatchPolicy.__setWslWindowsDriveForTests(null);
      await engine?.stop();
      engine = undefined;
    });

    const expectGuidance = (result: { isError?: boolean; content: Array<{ text: string }> }) => {
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain('LATTICE_SENSOR_DIR=.lattice/sensor-wsl');
      expect(result.content[0]!.text).toContain('If you are an AI agent');
      expect(result.content[0]!.text).not.toContain('No LatticeSensor project is loaded');
    };

    it('answers a default-project call with the fix, not "no project loaded"', async () => {
      engine = new BuiltMCPEngine({ watch: false });
      await engine.ensureInitialized(root);
      expectGuidance(await engine.getToolHandler().execute('lattice_sensor_explore', { query: 'parseToken' }));
    });

    it('keeps the fix on the per-call retry path', async () => {
      engine = new BuiltMCPEngine({ watch: false });
      engine.retryInitializeSync(root);
      expectGuidance(await engine.getToolHandler().execute('lattice_sensor_search', { query: 'parseToken' }));
    });

    it('answers an explicit projectPath with the fix', async () => {
      engine = new BuiltMCPEngine({ watch: false });
      expectGuidance(await engine.getToolHandler().execute('lattice_sensor_search', { query: 'parseToken', projectPath: root }));
    });

    it('serves normally once the index opens again', async () => {
      engine = new BuiltMCPEngine({ watch: false });
      engine.retryInitializeSync(root);
      fs.rmSync(`${dbPath}-shm`, { force: true });
      engine.retryInitializeSync(root);
      const result = await engine.getToolHandler().execute('lattice_sensor_search', { query: 'parseToken' });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain('parseToken');
    });
  });
});

describe('ToolHandler answers the shared-index error success-shaped', () => {
  let root: string;
  let cg: LatticeSensor;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-sensor-wsl-tools-'));
    await makeProject(root);
    cg = LatticeSensor.openSync(root);
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('when a query fails mid-session', async () => {
    cg.searchNodes = () => { throw sharedIndexError(); };
    const result = await new ToolHandler(cg).execute('lattice_sensor_search', { query: 'parseToken' });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('LATTICE_SENSOR_DIR=.lattice/sensor-wsl');
  });

  it('on the worker dispatch path', async () => {
    cg.searchNodes = () => { throw sharedIndexError(); };
    const result = await new ToolHandler(cg).executeReadTool('lattice_sensor_search', { query: 'parseToken' });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('LATTICE_SENSOR_DIR=.lattice/sensor-wsl');
  });

  it('keeps a genuine malfunction an error', async () => {
    cg.searchNodes = () => { throw new Error('disk I/O error'); };
    const result = await new ToolHandler(cg).execute('lattice_sensor_search', { query: 'parseToken' });
    expect(result.isError).toBe(true);
  });

  it('forgets a recorded open failure once a default project loads', async () => {
    const handler = new ToolHandler(null);
    handler.setDefaultOpenFailure(sharedIndexError());
    expect((await handler.execute('lattice_sensor_search', { query: 'parseToken' })).content[0]!.text)
      .toContain('LATTICE_SENSOR_DIR=.lattice/sensor-wsl');
    handler.setDefaultLatticeSensor(cg);
    const result = await handler.execute('lattice_sensor_search', { query: 'parseToken' });
    expect(result.content[0]!.text).not.toContain('LATTICE_SENSOR_DIR');
    expect(result.content[0]!.text).toContain('parseToken');
  });
});
