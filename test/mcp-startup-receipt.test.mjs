import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { registerManagedDaemonFixture } from './helpers/managed-daemon-fixture.mjs';
import { MCP_RECEIPT_SLOTS, MCP_RECEIPT_BYTES } from '../src/mcp-startup-receipt.mjs';
import { ensureSafeDir, ensureSafeFile } from '../src/runtime-errors.mjs';
const repo = process.cwd();
const url = p => pathToFileURL(path.join(repo, p)).href;
async function until(read, accepts, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (accepts(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  throw Error('receipt fixture timed out');
}
async function fixture(t, mode, { prepare, writeFailure = false, recordingFailure = false, identityDelay = false, home, wrapper = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-mcp-receipt-'));
  const tracked = []; registerManagedDaemonFixture(t, root, { tracked });
  home ??= root;
  const receipts = path.join(home, '.lattice', 'mcp-startup');
  if (prepare) await prepare(root, receipts);
  let module = url('src/mcp-startup-receipt.mjs');
  if (recordingFailure || identityDelay) {
    let source = await readFile('src/mcp-startup-receipt.mjs', 'utf8');
    for (const file of ['runtime-errors.mjs', 'dashboard-process-control.mjs', 'windows-owner-only.mjs']) source = source.replace(`'./${file}'`, JSON.stringify(url(`src/${file}`)));
    assert.equal(source.split('writeFileSync(fd, bytes)').length, 2);
    if (recordingFailure) source = source.replace('writeFileSync(fd, bytes)', '(() => { writeFileSync(path.join(workerData.home, "attempted"), "attempted"); throw Object.assign(new Error("secret-EIO"), {code:"EIO"}); })()');
    if (identityDelay) source = source.replace('const identity = await observeDashboardProcess', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); const identity = await observeDashboardProcess');
    const copy = path.join(root, 'fault-receipt.mjs'); await writeFile(copy, source); module = pathToFileURL(copy).href;
  }
  const script = path.join(root, 'client-fixture.mjs');
  await writeFile(script, `
    import { createRequire } from 'node:module';
    import { createMcpStartupReceipt } from ${JSON.stringify(module)};
    const require = createRequire(import.meta.url);
    const version = require(${JSON.stringify(path.join(repo, 'sensor/dist/mcp/version.js'))}).LatticeSensorPackageVersion;
    const receipt = createMcpStartupReceipt('0.79.4');
    ${writeFailure ? `const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (bytes, callback) => original(bytes, () => callback?.(new Error('secret-write-error')));` : ''}
    if (${JSON.stringify(mode)} === 'direct') {
      const { MCPServer } = require(${JSON.stringify(path.join(repo, 'sensor/dist/index.js'))});
      await new MCPServer(undefined, receipt).start();
    } else {
      const { runLocalHandshakeProxy } = require(${JSON.stringify(path.join(repo, 'sensor/dist/mcp/proxy.js'))});
      receipt.setMode('proxy', version);
      await runLocalHandshakeProxy({ root: process.cwd(), startupReceipt: receipt,
        getDaemonSocket: () => new Promise(() => {}), makeEngine: () => { throw Error('no tool calls expected'); } });
    }
  `);
  const child = spawn(process.execPath, wrapper ? [path.join(repo, 'bin/lattice-mcp.mjs'), '--path', root] : [script], { cwd: root, env: { ...process.env,
    HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(root, 'state'),
    LATTICE_CONFIG_DIR: path.join(root, 'config'), LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'dashboard'),
    LATTICE_SENSOR_NO_DAEMON: wrapper && mode === 'proxy' ? '0' : '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  tracked.push(child.pid); let output = '', stderr = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  async function records() {
    let names; try { names = await readdir(receipts); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return []; throw e; }
    const rows = [];
    for (const name of names.filter(n => n.startsWith('slot-'))) {
      try { rows.push(JSON.parse(await readFile(path.join(receipts, name, 'receipt.json'), 'utf8'))); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return rows;
  }
  return { root, home, receipts, child, records, closed, stderr: () => stderr,
    request: async (id, method) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
      return until(async () => output.split('\n').filter(Boolean).map(x => JSON.parse(x)), x => x.some(f => f.id === id));
    },
    initialize: async () => {
      const begin = performance.now();
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {
        clientInfo: { name: 'secret-client', version: 'secret-version' }, capabilities: {},
      } }) + '\n');
      const frames = await until(async () => output.split('\n').filter(Boolean).map(x => JSON.parse(x)), x => x.some(f => f.id === 7));
      assert.ok(performance.now() - begin < 2000, 'receipt I/O must not block initialize');
      const frame = frames.find(f => f.id === 7); assert.equal(frame.jsonrpc, '2.0'); assert.ok(frame.result.serverInfo.version);
      return frame;
    } };
}
for (const mode of ['direct', 'proxy']) {
  test(`${mode}: initializeと実write完了、版/identityを私有receiptで対応づける`, { timeout: 30000 }, async t => {
    const f = await fixture(t, mode); const frame = await f.initialize();
    const [record] = await until(f.records, rs => rs[0]?.events.at(-1)?.phase === 'initialize_response_written');
    assert.equal(record.pid, f.child.pid); assert.ok(record.birth); assert.equal(record.wrapper_version, '0.79.4');
    assert.equal(record.sensor_version, frame.result.serverInfo.version); assert.equal(record.mode, mode);
    assert.match(record.run_id, /^[a-f0-9-]{36}$/u);
    assert.deepEqual(record.events.map(e => e.phase), ['started', 'initialize_received', 'initialize_response_written']);
    assert.doesNotMatch(JSON.stringify(record), /secret-|clientInfo|rootUri|argv|stack|exit|signal/u);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < MCP_RECEIPT_BYTES);
    ensureSafeDir(f.receipts); ensureSafeDir(path.join(f.receipts, 'slot-0'));
    ensureSafeFile(path.join(f.receipts, 'slot-0', 'receipt.json'));
    const frames = await f.request(8, 'tools/list');
    assert.deepEqual(frames.filter(x => 'id' in x).map(x => x.id), [7, 8]);
    assert.ok(frames.find(x => x.id === 8).result.tools.length > 0);
    await f.initialize(); // Repeated initialize cannot grow the observation queue or receipt.
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(await f.records(), [record]);
    f.child.stdin.end(); assert.deepEqual(await f.closed, { code: 0, signal: null });
  });
  test(`${mode}: 未受信とwrite callback失敗は応答完了を補わない`, { timeout: 30000 }, async t => {
    const f = await fixture(t, mode, { writeFailure: true });
    const [before] = await until(f.records, rs => rs.length === 1);
    assert.deepEqual(before.events.map(e => e.phase), ['started']);
    await f.initialize(); await until(f.records, rs => rs[0]?.events.some(e => e.phase === 'initialize_received'));
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await f.records())[0].events.some(e => e.phase === 'initialize_response_written'), false);
    f.child.stdin.end(); await f.closed;
  });
}
for (const kind of ['full', 'unsafe', 'EIO']) {
  test(`${kind}でもinitializeは応答し、記録成功を捏造しない`, { timeout: 30000 }, async t => {
    const f = await fixture(t, 'proxy', { recordingFailure: kind === 'EIO', prepare: async (_root, dir) => {
      await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
      if (kind === 'unsafe') { await writeFile(dir, 'secret-existing-file'); return; }
      if (kind === 'full') { ensureSafeDir(dir); for (let i = 0; i < MCP_RECEIPT_SLOTS; i++) await mkdir(path.join(dir, `slot-${i}`), { mode: 0o700 }); }
    } });
    await f.initialize(); await new Promise(r => setTimeout(r, 500));
    if (kind === 'EIO') await until(() => readdir(f.root), names => names.includes('attempted'));
    assert.deepEqual(await f.records(), []);
    if (kind === 'full') assert.equal((await readdir(f.receipts)).length, MCP_RECEIPT_SLOTS);
    if (kind === 'unsafe') assert.equal(await readFile(f.receipts, 'utf8'), 'secret-existing-file');
    f.child.stdin.end(); assert.deepEqual(await f.closed, { code: 0, signal: null });
  });
}

for (const mode of ['direct', 'proxy']) test(`実wrapperはpackage版と実${mode}経路を渡す`, { timeout: 30000 }, async t => {
  const f = await fixture(t, mode, { wrapper: true, prepare: async root => {
    if (mode === 'proxy') {
      const { LatticeSensor } = createRequire(import.meta.url)('../sensor/dist/index.js');
      const sensor = await LatticeSensor.init(root); sensor.close();
    }
  } });
  await f.initialize();
  const [record] = await until(f.records, rs => rs[0]?.events.at(-1)?.phase === 'initialize_response_written');
  const pkg = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  assert.equal(record.wrapper_version, pkg.version); assert.equal(record.mode, mode);
  f.child.stdin.end(); assert.deepEqual(await f.closed, { code: 0, signal: null });
});

test('64 slot境界の並行起動は既存63件を保持し、予約とpublishを上限内に保つ', { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'lattice-mcp-capacity-'));
  registerManagedDaemonFixture(t, home);
  const dir = path.join(home, '.lattice', 'mcp-startup');
  ensureSafeDir(dir);
  for (let i = 0; i < MCP_RECEIPT_SLOTS - 1; i++) {
    const slot = path.join(dir, `slot-${i}`); await mkdir(slot, { mode: 0o700 });
    await writeFile(path.join(slot, 'receipt.json'), `old-${i}`, { mode: 0o600 });
  }
  const children = await Promise.all(['direct', 'proxy'].map(mode => fixture(t, mode, { home })));
  await Promise.all(children.map(f => f.initialize()));
  const newest = path.join(dir, `slot-${MCP_RECEIPT_SLOTS - 1}`);
  const final = await until(async () => {
    try { return JSON.parse(await readFile(path.join(newest, 'receipt.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }, r => r?.events.at(-1)?.phase === 'initialize_response_written');
  assert.ok(children.some(f => f.child.pid === final.pid));
  assert.equal((await readdir(dir)).filter(n => n.startsWith('slot-')).length, MCP_RECEIPT_SLOTS);
  for (let i = 0; i < MCP_RECEIPT_SLOTS - 1; i++) assert.equal(await readFile(path.join(dir, `slot-${i}`, 'receipt.json'), 'utf8'), `old-${i}`);
  assert.deepEqual(await readdir(newest), ['receipt.json']);
  assert.ok((await readFile(path.join(newest, 'receipt.json'))).length <= MCP_RECEIPT_BYTES);
  for (const f of children) { f.child.stdin.end(); assert.deepEqual(await f.closed, { code: 0, signal: null }); }
});

test('symlink/junction先へ記録せず応答は継続する', { timeout: 30000 }, async t => {
  let outside;
  const f = await fixture(t, 'proxy', { prepare: async (root, dir) => {
    outside = path.join(root, 'outside'); await mkdir(outside);
    await mkdir(path.dirname(dir), { mode: 0o700 });
    await symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  await f.initialize(); await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(await readdir(outside), []);
  f.child.stdin.end(); assert.deepEqual(await f.closed, { code: 0, signal: null });
});

test('initialize前の途中終了から成功段階を作らない', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'direct');
  await until(f.records, rs => rs.length === 1);
  f.child.kill(); await f.closed;
  const [record] = await f.records();
  assert.deepEqual(record.events.map(e => e.phase), ['started']);
});

test('workerの同期identity処理が止まってもinitializeと終了は待たない', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'proxy', { identityDelay: true });
  await f.initialize();
  f.child.stdin.end();
  const begin = performance.now();
  assert.deepEqual(await f.closed, { code: 0, signal: null });
  assert.ok(performance.now() - begin < 2000, 'unref worker must not hold shutdown');
});

test('既存の広い権限を持つ非空storeは書き換えず記録を省く', { timeout: 30000 }, async t => {
  const f = await fixture(t, 'proxy', { prepare: async (_root, dir) => {
    ensureSafeDir(dir); await writeFile(path.join(dir, 'existing'), 'keep');
    if (process.platform === 'win32') {
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [dir, '/grant', '*S-1-1-0:(OI)(CI)F'], { encoding: 'utf8' });
      assert.equal(result.status, 0);
    } else await chmod(dir, 0o750);
  } });
  await f.initialize(); await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(await f.records(), []); assert.equal(await readFile(path.join(f.receipts, 'existing'), 'utf8'), 'keep');
  f.child.stdin.end(); assert.deepEqual(await f.closed, { code: 0, signal: null });
});
