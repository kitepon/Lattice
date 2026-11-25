import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { registerManagedDaemonFixture } from './helpers/managed-daemon-fixture.mjs';

const repo = process.cwd();
const until = async (read, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw Error('thin proxy fixture timed out');
};

// A seat session is one lattice-mcp proxy to the shared daemon. It must stay a thin
// pipe: no engine/tool-handler modules (~50 MB) and no second `node -e` watchdog
// process (~45 MB). Windows keeps a watchdog for the connect window only (#943).
test('実wrapperの中継はengineを読まず、見張りのnodeを足さない', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-mcp-thin-'));
  const tracked = []; registerManagedDaemonFixture(t, root, { tracked });
  const { LatticeSensor } = createRequire(import.meta.url)('../sensor/dist/index.js');
  (await LatticeSensor.init(root)).close();
  const log = path.join(root, 'proxy-modules.json');
  const spawnLog = path.join(root, 'daemon-spawns');
  const recorder = path.join(repo, 'sensor/__tests__/fixtures/record-detached-spawns.cjs');
  const child = spawn(process.execPath, ['--require', recorder, path.join(repo, 'bin/lattice-mcp.mjs'), '--path', root], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: root, USERPROFILE: root, XDG_STATE_HOME: path.join(root, 'state'),
      CG_TEST_SPAWN_LOG: spawnLog, CG_TEST_PROXY_LOG: log, LATTICE_SENSOR_MCP_LOG_ATTACH: '1',
      LATTICE_SENSOR_NO_DAEMON: '0', LATTICE_SENSOR_DAEMON_IDLE_TIMEOUT_MS: '15000' },
  });
  tracked.push(child.pid);
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const frame = id => out.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(f => f.id === id);

  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'thin', version: '1' } } });
  send({ id: 2, method: 'tools/list' });
  await until(() => frame(1) && frame(2));
  assert.equal(frame(2).result.tools.length, 8);
  // A forwarded tool call proves the pipe reaches the daemon, not an in-process engine.
  send({ id: 3, method: 'tools/call', params: { name: 'lattice_sensor_status', arguments: {} } });
  const status = await until(() => frame(3));
  assert.match(status.result.content[0].text, /mode: daemon/, err);
  assert.match(err, /Attached to shared daemon/);

  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null }, err);
  const { modules, spawned } = JSON.parse(await readFile(log, 'utf8'));
  const heavy = modules.filter(file => /\/sensor\/dist\/(mcp\/(engine|session|tools|daemon|transport)|db\/index|index)\.js$/.test(file));
  assert.deepEqual(heavy, [], 'the proxy loaded modules only the daemon or the fallback engine need');
  const watchdogs = spawned.filter(s => s.args.includes('-e'));
  if (process.platform !== 'win32') assert.deepEqual(watchdogs, [], 'a pure pipe spawns no watchdog process');
});
