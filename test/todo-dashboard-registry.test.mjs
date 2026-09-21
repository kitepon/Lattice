import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTodoCli } from '../src/todo-cli.mjs';
import {
  adoptTodoDashboardActivity,
  ensureTodoDashboardDaemon,
  ensureTodoDashboardActivity,
  readActiveTodoDashboardProjects,
  readServedTodoDashboardProjectIds,
  readVisibleTodoDashboardProjects,
  registerTodoDashboardActivity,
  removeTodoDashboardProject,
  todoDashboardMemberNeedsVisibility,
  TODO_DASHBOARD_CODE_VERSION,
  TODO_DASHBOARD_STALE_MS,
} from '../src/todo-dashboard-registry.mjs';

test('公開配信の鮮度窓は1週間', () => {
  assert.equal(TODO_DASHBOARD_STALE_MS, 7 * 24 * 60 * 60 * 1_000);
});

test('監査判断待ちと棄却済みPhaseはactive taskが無くてもdashboardへ残す', () => {
  for (const status of ['gate_ready', 'reviewing', 'rejected']) {
    assert.equal(todoDashboardMemberNeedsVisibility({ phases: [{ phase_id: 'audit', status }] }), true);
  }
  for (const status of ['accepted', 'closed_unaudited']) {
    assert.equal(todoDashboardMemberNeedsVisibility({ phases: [{ phase_id: 'audit', status }] }), false);
  }
  assert.equal(todoDashboardMemberNeedsVisibility({}), false);
});

async function healthServer(body) {
  const server = createServer((request, response) => {
    if (request.url !== '/__lattice/health') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify(typeof body === 'function' ? body() : body)}\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

async function writeDaemonDescriptor(runtime, descriptor) {
  await writeFile(path.join(runtime, 'daemon.json'), `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
}

function daemonDescriptor(pid, port) {
  return { schema: 'lattice.todo_dashboard_daemon.v1', pid, port,
    started_at: new Date().toISOString() };
}

/**
 * 登録簿へ記録を直接置く。本番でdaemonが観測不能になるのは記録を書いた「後」——
 * descriptorから外された時や起動側が途中で死んだ時——なので、ensureを通さずに作る。
 */
async function plantDaemonRecord(runtime, record) {
  await mkdir(path.join(runtime, 'daemons'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(runtime, 'daemons', `${record.pid}.json`),
    `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function daemonRecordNames(runtime) {
  try { return (await readdir(path.join(runtime, 'daemons'))).sort(); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** 現行版を名乗るhealth。'current' attestationはportの一致も見るので後から埋める。 */
async function currentHealthServer(pid) {
  const body = { schema: 'lattice.todo_dashboard_health.v1', pid, port: 0,
    project_ids: ['lattice'], version: TODO_DASHBOARD_CODE_VERSION };
  const served = await healthServer(() => body);
  body.port = served.port;
  return served;
}

test('dashboard --helpはdaemonやregistryを作らず終了する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-help-'));
  const runtime = path.join(root, 'runtime');
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.resolve('bin/lattice-dashboard.mjs'), '--help'], {
    cwd: process.cwd(),
    env: { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Usage: lattice-dashboard\n');
  await assert.rejects(stat(runtime), (error) => error.code === 'ENOENT');
});

test('session activity registryはprojectをupsertし期限切れentryを一覧から除外する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-registry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'runtime') };
  const current = new Date('2026-07-21T10:00:00.000Z');
  await registerTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
    displayName: '古い名前', sessionId: 'session-a', env,
    now: new Date(current.getTime() - TODO_DASHBOARD_STALE_MS - 1) });
  assert.deepEqual(await readActiveTodoDashboardProjects({ env, now: current.getTime() }), []);
  await registerTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
    displayName: 'Lattice', sessionId: 'session-b', env, now: current });
  const active = await readActiveTodoDashboardProjects({ env, now: current.getTime() });
  assert.equal(active.length, 1);
  assert.equal(active[0].display_name, 'Lattice');
  assert.equal(active[0].session_id, 'session-b');
});

test('配信中idはdaemon自身のhealthから読み、登録簿のstaleでは落ちない', async (context) => {
  // 名乗る集合と配信する集合を別々に数えると必ずずれる。登録簿が全件stale——つまり
  // readActiveTodoDashboardProjectsが0件——でも、daemonが配信していれば名乗る。
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-served-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  const served = await currentHealthServer(4_242);
  context.after(() => new Promise((resolve) => served.server.close(resolve)));
  await writeDaemonDescriptor(runtime, daemonDescriptor(4_242, served.port));
  await registerTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
    displayName: 'Lattice', sessionId: 'session-a', env,
    now: new Date(Date.now() - TODO_DASHBOARD_STALE_MS - 1) });

  assert.deepEqual(await readActiveTodoDashboardProjects({ env }), []);
  assert.deepEqual(await readServedTodoDashboardProjectIds({ env }), ['lattice']);
});

test('配信中idはdaemonが観測できなければnullを返し、0件と区別する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-served-absent-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: runtime };

  assert.equal(await readServedTodoDashboardProjectIds({ env }), null, 'descriptorが無い');

  const served = await currentHealthServer(4_243);
  context.after(() => new Promise((resolve) => served.server.close(resolve)));
  await writeDaemonDescriptor(runtime, daemonDescriptor(9_999, served.port));
  assert.equal(await readServedTodoDashboardProjectIds({ env }), null,
    'healthのpidがdescriptorと食い違う相手を配信元として採らない');
});

test('同一project_idを別canonical rootから登録しても既存registryを置換しない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-root-conflict-'));
  const canonical = path.join(root, 'canonical');
  const scratch = path.join(root, 'scratch');
  await Promise.all([mkdir(canonical), mkdir(scratch)]);
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'runtime') };
  await registerTodoDashboardActivity({ repoRoot: canonical, projectId: 'bingo',
    displayName: 'Bingo', sessionId: 'canonical-session', env,
    now: new Date('2026-08-01T00:00:00.000Z') });
  const registryRef = path.join(root, 'runtime', 'projects.json');
  const before = await readFile(registryRef);

  await assert.rejects(registerTodoDashboardActivity({ repoRoot: scratch, projectId: 'bingo',
    displayName: 'Bingo scratch', sessionId: 'scratch-session', env,
    now: new Date('2026-08-01T00:01:00.000Z') }), (error) => {
    assert.equal(error.code, 'PROJECT_ROOT_CONFLICT');
    assert.deepEqual(error.detail, {
      project_id: 'bingo', next_action: 'lattice todo dashboard adopt --json',
    });
    assert.equal(error.message.includes(canonical), false);
    assert.equal(error.message.includes(scratch), false);
    return true;
  });
  assert.deepEqual(await readFile(registryRef), before);
  const [entry] = await readActiveTodoDashboardProjects({
    env, now: Date.parse('2026-08-01T00:01:00.000Z'),
  });
  assert.equal(entry.repo_root, await realpath(canonical));
  assert.equal(entry.session_id, 'canonical-session');

  const adopted = await adoptTodoDashboardActivity({ repoRoot: scratch, projectId: 'bingo',
    displayName: 'Bingo', sessionId: 'adopt-session', env,
    now: new Date('2026-08-01T00:02:00.000Z') });
  assert.equal(adopted.adopted, true);
  const [moved] = await readActiveTodoDashboardProjects({
    env, now: Date.parse('2026-08-01T00:02:00.000Z'),
  });
  assert.equal(moved.repo_root, await realpath(scratch));
  assert.equal(moved.session_id, 'adopt-session');
});

test('期限切れactivityでもstoreにactive runがあれば一覧へ残す', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-active-run-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'runtime') };
  const current = new Date('2026-07-21T10:00:00.000Z');
  await registerTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'aishell',
    displayName: 'AIShell', sessionId: 'session-old', env,
    now: new Date(current.getTime() - TODO_DASHBOARD_STALE_MS - 1) });
  await registerTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
    displayName: 'Lattice', sessionId: 'session-current', env, now: current });
  assert.deepEqual((await readActiveTodoDashboardProjects({ env, now: current.getTime() }))
    .map(({ project_id: projectId }) => projectId), ['lattice']);
  const checked = [];
  const visible = await readVisibleTodoDashboardProjects({ env, now: current.getTime(),
    projectHasActiveRun: async ({ project_id: projectId }) => {
      checked.push(projectId);
      return projectId === 'aishell';
    },
  });
  assert.deepEqual(visible.map(({ project_id: projectId }) => projectId), ['aishell', 'lattice']);
  assert.deepEqual(checked, ['aishell']);
});

test('通常session activityだけでdashboard daemonを起動し同じdaemonを再利用する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-daemon-'));
  const runtime = path.join(root, 'runtime');
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
    LATTICE_DASHBOARD_PORT: '0', LATTICE_DASHBOARD_AUTOSTART: '1' };
  let daemonPid = null;
  context.after(async () => {
    if (daemonPid !== null) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  const [first, concurrent] = await Promise.all([
    ensureTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
      displayName: 'Lattice', sessionId: 'session-a', env }),
    ensureTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
      displayName: 'Lattice', sessionId: 'session-a', env }),
  ]);
  const descriptor = JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(runtime, 'daemon.json'))).mode & 0o777, 0o600);
  }
  daemonPid = descriptor.pid;
  assert.ok(first.port > 0);
  assert.equal(concurrent.port, first.port);
  const index = await fetch(`http://127.0.0.1:${first.port}/projects/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Lattice/u);
  const second = await ensureTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
    displayName: 'Lattice', sessionId: 'session-a', env });
  const reused = JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8'));
  assert.equal(second.port, first.port);
  assert.equal(reused.pid, daemonPid);
  if (process.platform === 'win32') {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/__lattice/shutdown`, { method: 'POST' });
    assert.equal(response.status, 202);
  } else {
    process.kill(daemonPid, 'SIGTERM');
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const restarted = await ensureTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
    displayName: 'Lattice', sessionId: 'session-a', env });
  const replacement = JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8'));
  assert.notEqual(replacement.pid, daemonPid);
  assert.ok(restarted.port > 0);
  daemonPid = replacement.pid;
});

test('legacy health daemonは新daemon成功後だけPID一致を根拠に停止して置換する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-legacy-upgrade-'));
  const runtime = path.join(root, 'runtime');
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const legacyPid = 987_654;
  const legacy = await healthServer({ schema: 'lattice.todo_dashboard_health.v1', pid: legacyPid,
    project_ids: ['lattice'] });
  await writeDaemonDescriptor(runtime, { schema: 'lattice.todo_dashboard_daemon.v1', pid: legacyPid,
    port: legacy.port, started_at: new Date().toISOString() });
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime, LATTICE_DASHBOARD_PORT: '61234' };
  let replacement = null;
  let signaled = false;
  context.after(async () => {
    if (replacement !== null) try { process.kill(replacement.pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => legacy.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  replacement = await ensureTodoDashboardDaemon({ env,
    signalProcess(pid, signal) {
      const published = JSON.parse(readFileSync(path.join(runtime, 'daemon.json'), 'utf8'));
      assert.equal(published.pid, legacyPid, 'legacy停止までは共有descriptorを置換しない');
      assert.equal(pid, legacyPid); assert.equal(signal, 'SIGTERM'); signaled = true; legacy.server.close();
    },
    isProcessAlive: () => !signaled,
  });
  assert.equal(signaled, true);
  assert.notEqual(replacement.pid, legacyPid);
  assert.notEqual(replacement.port, legacy.port);
});

test('古い版を配信し続けているdaemonは新版へ置換される', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-version-drift-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const stalePid = 987_655;
  // 応答形は現行と同じで、名乗る版数だけが古い。install済みのコードとの差が
  // 「配信中のプロセスだけ取り残されている」ことの唯一の手掛かりになる。
  const staleBody = { schema: 'lattice.todo_dashboard_health.v1', pid: stalePid, port: 0,
    project_ids: ['lattice'], version: '0.0.1-old' };
  const stale = await healthServer(() => staleBody);
  staleBody.port = stale.port;
  await writeDaemonDescriptor(runtime, { schema: 'lattice.todo_dashboard_daemon.v1', pid: stalePid,
    port: stale.port, started_at: new Date().toISOString() });
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  let replacement = null;
  let signaled = false;
  context.after(async () => {
    if (replacement !== null) try { process.kill(replacement.pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => stale.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  replacement = await ensureTodoDashboardDaemon({ env,
    signalProcess(pid, signal) {
      assert.equal(pid, stalePid); assert.equal(signal, 'SIGTERM'); signaled = true; stale.server.close();
    },
    isProcessAlive: () => !signaled,
  });
  assert.equal(signaled, true, '古い版のdaemonは停止させる');
  assert.notEqual(replacement.pid, stalePid);

  const health = await (await fetch(`http://127.0.0.1:${replacement.port}/__lattice/health`)).json();
  assert.equal(health.version, TODO_DASHBOARD_CODE_VERSION, '新daemonは自分の版数を名乗る');
});

test('PID不一致healthの無関係serviceにはsignalせず新daemonへ置換する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-unrelated-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const unrelated = await healthServer({ schema: 'lattice.todo_dashboard_health.v1', pid: 222_222,
    project_ids: [] });
  await writeDaemonDescriptor(runtime, { schema: 'lattice.todo_dashboard_daemon.v1', pid: 111_111,
    port: unrelated.port, started_at: new Date().toISOString() });
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime, LATTICE_DASHBOARD_PORT: '0' };
  let replacement = null;
  context.after(async () => {
    if (replacement !== null) try { process.kill(replacement.pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => unrelated.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  replacement = await ensureTodoDashboardDaemon({ env,
    signalProcess() { throw new Error('unrelated PID must not be signaled'); },
  });
  assert.notEqual(replacement.pid, 111_111);
  assert.equal((await fetch(`http://127.0.0.1:${unrelated.port}/__lattice/health`)).status, 200);
});

test('生存中dashboardの一時的health timeoutは新daemonで孤児化せずtyped拒否する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-busy-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const daemonPid = 777_777;
  const observedStartedAt = Date.parse('Mon Jan 01 2024 00:00:00');
  let busyPort = null;
  const busy = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`${JSON.stringify({ schema: 'lattice.todo_dashboard_health.v1',
        pid: daemonPid, port: busyPort, project_ids: ['lattice'] })}\n`);
    }, 100);
  });
  await new Promise((resolve, reject) => {
    busy.once('error', reject);
    busy.listen(0, '127.0.0.1', resolve);
  });
  busyPort = busy.address().port;
  await writeDaemonDescriptor(runtime, { schema: 'lattice.todo_dashboard_daemon.v1',
    pid: daemonPid, port: busyPort, started_at: new Date(observedStartedAt + 999).toISOString() });
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  let spawnCount = 0;
  context.after(async () => {
    await new Promise((resolve) => busy.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(ensureTodoDashboardDaemon({ env, attestationTimeoutMs: 20,
    isProcessAlive: () => true,
    observeProcessStartEpochMs: async () => observedStartedAt,
    spawnDaemon() { spawnCount += 1; throw new Error('must not spawn'); },
  }), (error) => error.code === 'DASHBOARD_DAEMON_UNRESPONSIVE');
  assert.equal(spawnCount, 0);
});

test('health不能でPIDが別processに再利用されたdescriptorはsignalせずspawnで復旧する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-pid-reuse-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const reusedPid = 777_778;
  const replacementPid = 777_779;
  await writeDaemonDescriptor(runtime, { schema: 'lattice.todo_dashboard_daemon.v1', pid: reusedPid,
    port: 49_267, started_at: '2026-01-01T00:00:00.000Z' });
  const replacement = await currentHealthServer(replacementPid);
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  const signals = [];
  let spawnCount = 0;
  context.after(async () => {
    await new Promise((resolve) => replacement.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const result = await ensureTodoDashboardDaemon({ env, startupTimeoutMs: 1_000,
    isProcessAlive: (pid) => pid === reusedPid || pid === replacementPid,
    replacementIsProcessAlive: (pid) => pid === replacementPid,
    observeProcessStartEpochMs: async (pid) => {
      assert.equal(pid, reusedPid);
      return Date.parse('Sun Sep 21 12:00:00 2026');
    },
    signalProcess(pid, signal) { signals.push([pid, signal]); },
    spawnDaemon() {
      spawnCount += 1;
      setTimeout(() => plantDaemonRecord(runtime, daemonDescriptor(replacementPid, replacement.port)), 25);
      return { pid: replacementPid, unref() {}, kill() {} };
    },
  });
  assert.equal(spawnCount, 1);
  assert.equal(result.pid, replacementPid);
  assert.deepEqual(signals, [], '再利用された無関係PIDへsignalしない');
  assert.equal(JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8')).pid, replacementPid);
});

test('新daemon起動中にlegacy再attestationを失ったPIDへはsignalしない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-attestation-race-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const legacyPid = 555_555;
  let legacyBody = { schema: 'lattice.todo_dashboard_health.v1', pid: legacyPid,
    project_ids: ['lattice'] };
  const legacy = await healthServer(() => legacyBody);
  await writeDaemonDescriptor(runtime, { schema: 'lattice.todo_dashboard_daemon.v1', pid: legacyPid,
    port: legacy.port, started_at: new Date().toISOString() });
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime, LATTICE_DASHBOARD_PORT: '0' };
  context.after(async () => {
    const descriptor = JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8'));
    if (descriptor.pid !== legacyPid) try { process.kill(descriptor.pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => legacy.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(ensureTodoDashboardDaemon({ env,
    spawnDaemon(...args) {
      legacyBody = { ...legacyBody, pid: legacyPid + 1 };
      return spawn(...args);
    },
    signalProcess() { throw new Error('lost attestation PID must not be signaled'); },
    isProcessAlive: () => true,
  }), (error) => error.code === 'DASHBOARD_LEGACY_ATTESTATION_LOST');
});

test('死んだreplacementは猶予の満了を待たず諦め、生きている遅い子は待ち切る',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-liveness-'));
    const runtime = path.join(root, 'runtime');
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const legacyPid = 555_555;
    const body = { schema: 'lattice.todo_dashboard_health.v1', pid: legacyPid, port: 0,
      project_ids: ['lattice'] };
    const served = await healthServer(() => body);
    body.port = served.port;
    const descriptor = { schema: 'lattice.todo_dashboard_daemon.v1', pid: legacyPid,
      port: served.port, started_at: new Date().toISOString() };
    await writeDaemonDescriptor(runtime, descriptor);
    const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime, LATTICE_DASHBOARD_PORT: '0' };
    context.after(async () => {
      await new Promise((resolve) => served.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });

    // 死んだ子を待ち続けない。猶予10秒でも、死を見た時点で諦める。
    const startedAt = Date.now();
    await assert.rejects(ensureTodoDashboardDaemon({ env, startupTimeoutMs: 10_000,
      spawnDaemon: () => ({ pid: 777_777, unref() {}, kill() {} }),
      replacementIsProcessAlive: () => false,
      signalProcess() { throw new Error('legacy must remain available'); },
    }), (error) => error.code === 'DASHBOARD_DAEMON_UNAVAILABLE');
    assert.ok(Date.now() - startedAt < 3_000, '死んだreplacementを猶予いっぱい待っている');
    assert.deepEqual(JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8')), descriptor);

    // 生きている子は、pollを何周も跨ぐ遅さでも待って受け取る。
    await rm(path.join(runtime, 'daemon.json'), { force: true });
    let descriptorWritten = false;
    setTimeout(() => {
      body.pid = 888_888;
      body.version = TODO_DASHBOARD_CODE_VERSION;
      descriptorWritten = true;
      plantDaemonRecord(runtime, { schema: 'lattice.todo_dashboard_daemon.v1', pid: 888_888,
        port: served.port, started_at: new Date().toISOString() });
    }, 700);
    const slow = await ensureTodoDashboardDaemon({ env, startupTimeoutMs: 10_000,
      spawnDaemon: () => ({ pid: 888_888, unref() {}, kill() {} }),
      replacementIsProcessAlive: () => true,
      signalProcess() { throw new Error('legacyは無いのでsignalしない'); },
    });
    assert.equal(descriptorWritten, true);
    assert.equal(slow.pid, 888_888);
  });

test('新daemon起動失敗時はattested legacyを停止せずdescriptorと可用性を維持する',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-upgrade-rollback-'));
    const runtime = path.join(root, 'runtime');
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const legacyPid = 333_333;
    const legacy = await healthServer({ schema: 'lattice.todo_dashboard_health.v1', pid: legacyPid,
      project_ids: ['lattice'] });
    const descriptor = { schema: 'lattice.todo_dashboard_daemon.v1', pid: legacyPid,
      port: legacy.port, started_at: new Date().toISOString() };
    await writeDaemonDescriptor(runtime, descriptor);
    const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime, LATTICE_DASHBOARD_PORT: '0' };
    let fakeKilled = false;
    context.after(async () => {
      await new Promise((resolve) => legacy.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(ensureTodoDashboardDaemon({ env, startupTimeoutMs: 120,
      spawnDaemon: () => ({ pid: 444_444, unref() {}, kill() { fakeKilled = true; } }),
      signalProcess() { throw new Error('legacy must remain available'); },
    }), (error) => error.code === 'DASHBOARD_DAEMON_UNAVAILABLE');
    assert.equal(fakeKilled, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8')), descriptor);
    assert.equal((await fetch(`http://127.0.0.1:${legacy.port}/__lattice/health`)).status, 200);
  });

test('旧daemon停止失敗時はreplacementを停止確認してlegacy descriptorへrollbackする',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-stop-rollback-'));
    const runtime = path.join(root, 'runtime');
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const legacyPid = 666_666;
    const legacy = await healthServer({ schema: 'lattice.todo_dashboard_health.v1', pid: legacyPid,
      project_ids: ['lattice'] });
    const descriptor = { schema: 'lattice.todo_dashboard_daemon.v1', pid: legacyPid,
      port: legacy.port, started_at: new Date().toISOString() };
    await writeDaemonDescriptor(runtime, descriptor);
    const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime, LATTICE_DASHBOARD_PORT: '0' };
    let replacementChild = null;
    context.after(async () => {
      if (replacementChild?.exitCode === null && replacementChild?.signalCode === null) {
        replacementChild.kill('SIGKILL');
      }
      await new Promise((resolve) => legacy.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(ensureTodoDashboardDaemon({ env, legacyStopTimeoutMs: 120,
      spawnDaemon(...args) { replacementChild = spawn(...args); return replacementChild; },
      signalProcess() {},
      isProcessAlive: () => true,
    }), (error) => error.code === 'DASHBOARD_LEGACY_STOP_FAILED');
    if (replacementChild.exitCode === null && replacementChild.signalCode === null) {
      await once(replacementChild, 'close');
    }
    assert.ok(replacementChild.exitCode !== null || replacementChild.signalCode !== null);
    assert.deepEqual(JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8')), descriptor);
    assert.equal((await fetch(`http://127.0.0.1:${legacy.port}/__lattice/health`)).status, 200);
  });

test('descriptorから外れた生存daemonを登録簿から見つけて停止する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-stray-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const currentPid = 987_701;
  const strayPid = 987_702;
  const current = await currentHealthServer(currentPid);
  // 置換の途中で起動側が死ぬと、旧daemonは生きたままdescriptorから外れる。descriptor
  // しか見ない引き継ぎでは、この時点で二度と観測できなくなる（2026-08-03の実機再現）。
  const stray = await healthServer({ schema: 'lattice.todo_dashboard_health.v1',
    pid: strayPid, project_ids: ['lattice'] });
  await writeDaemonDescriptor(runtime, daemonDescriptor(currentPid, current.port));
  await plantDaemonRecord(runtime, daemonDescriptor(currentPid, current.port));
  await plantDaemonRecord(runtime, daemonDescriptor(strayPid, stray.port));
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  let signaled = false;
  context.after(async () => {
    await new Promise((resolve) => current.server.close(resolve));
    await new Promise((resolve) => stray.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const served = await ensureTodoDashboardDaemon({ env,
    spawnDaemon() { throw new Error('配信中のdaemonが居るのにspawnしてはいけない'); },
    signalProcess(pid, signal) {
      assert.equal(pid, strayPid);
      assert.equal(signal, 'SIGTERM');
      signaled = true;
      stray.server.close();
    },
    isProcessAlive: (pid) => (pid === strayPid ? !signaled : true),
  });
  assert.equal(served.pid, currentPid, '配信中のdaemonはそのまま使う');
  assert.equal(signaled, true, '孤児を停止する');
  assert.deepEqual(await daemonRecordNames(runtime), [`${currentPid}.json`]);
});

test('descriptorだけが失われた時は2本目を建てず生存daemonを引き取る', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-adopt-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const daemonPid = 987_703;
  const served = await currentHealthServer(daemonPid);
  await plantDaemonRecord(runtime, daemonDescriptor(daemonPid, served.port));
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  let spawned = 0;
  context.after(async () => {
    await new Promise((resolve) => served.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const adopted = await ensureTodoDashboardDaemon({ env,
    spawnDaemon() { spawned += 1; throw new Error('引き取れる相手が居るのにspawnしてはいけない'); },
    signalProcess() { throw new Error('引き取る相手へsignalしてはいけない'); },
    isProcessAlive: () => true,
  });
  assert.equal(spawned, 0);
  assert.equal(adopted.pid, daemonPid);
  assert.equal(adopted.port, served.port);
  assert.equal(JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8')).pid, daemonPid,
    'descriptorを引き取った相手で書き直す');
  assert.deepEqual(await daemonRecordNames(runtime), [`${daemonPid}.json`]);
});

test('認証できない生存pidへはsignalせず記録を残して次の起動へ送る', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-stray-unrelated-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const servedPid = 987_705;
  const strayPid = 987_706;
  const served = await currentHealthServer(servedPid);
  // pidが食い違うhealth＝記録のpidが再利用され、無関係のserviceがportに居る形。
  const unrelated = await healthServer({ schema: 'lattice.todo_dashboard_health.v1',
    pid: 222_222, project_ids: [] });
  await writeDaemonDescriptor(runtime, daemonDescriptor(servedPid, served.port));
  await plantDaemonRecord(runtime, daemonDescriptor(servedPid, served.port));
  await plantDaemonRecord(runtime, daemonDescriptor(strayPid, unrelated.port));
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  context.after(async () => {
    await new Promise((resolve) => served.server.close(resolve));
    await new Promise((resolve) => unrelated.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const result = await ensureTodoDashboardDaemon({ env,
    spawnDaemon() { throw new Error('配信中のdaemonが居るのにspawnしてはいけない'); },
    signalProcess() { throw new Error('認証できないpidへsignalしてはいけない'); },
    isProcessAlive: () => true,
  });
  assert.equal(result.pid, servedPid);
  assert.deepEqual(await daemonRecordNames(runtime), [`${servedPid}.json`, `${strayPid}.json`],
    '生きているが認証できないpidの記録は捨てない');
  assert.equal((await fetch(`http://127.0.0.1:${unrelated.port}/__lattice/health`)).status, 200);
});

test('停止に応じない孤児はtyped errorで報せ、descriptorの整合は保つ', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-stray-stuck-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const servedPid = 987_707;
  const strayPid = 987_708;
  const served = await currentHealthServer(servedPid);
  const stray = await healthServer({ schema: 'lattice.todo_dashboard_health.v1',
    pid: strayPid, project_ids: ['lattice'] });
  const descriptor = daemonDescriptor(servedPid, served.port);
  await writeDaemonDescriptor(runtime, descriptor);
  await plantDaemonRecord(runtime, descriptor);
  await plantDaemonRecord(runtime, daemonDescriptor(strayPid, stray.port));
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  const signals = [];
  context.after(async () => {
    await new Promise((resolve) => served.server.close(resolve));
    await new Promise((resolve) => stray.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(ensureTodoDashboardDaemon({ env, strayStopTimeoutMs: 120,
    spawnDaemon() { throw new Error('配信中のdaemonが居るのにspawnしてはいけない'); },
    signalProcess(pid, signal) { signals.push([pid, signal]); },
    isProcessAlive: () => true,
  }), (error) => error.code === 'DASHBOARD_ORPHAN_STOP_FAILED');
  assert.deepEqual(signals, [[strayPid, 'SIGTERM'], [strayPid, 'SIGKILL']], 'SIGTERMからSIGKILLへ上げる');
  assert.deepEqual(JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8')), descriptor);
  assert.equal((await fetch(`http://127.0.0.1:${served.port}/__lattice/health`)).status, 200);
});

test('起動のたびに死んだ記録を掃除するので登録簿が無限に育たない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-sweep-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const servedPid = 987_704;
  const served = await currentHealthServer(servedPid);
  await writeDaemonDescriptor(runtime, daemonDescriptor(servedPid, served.port));
  await plantDaemonRecord(runtime, daemonDescriptor(servedPid, served.port));
  for (let index = 0; index < 5; index += 1) {
    await plantDaemonRecord(runtime, daemonDescriptor(900_000 + index, 40_000 + index));
  }
  assert.equal((await daemonRecordNames(runtime)).length, 6);
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime };
  context.after(async () => {
    await new Promise((resolve) => served.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const result = await ensureTodoDashboardDaemon({ env,
    spawnDaemon() { throw new Error('配信中のdaemonが居るのにspawnしてはいけない'); },
    signalProcess() { throw new Error('死んだpidへsignalしてはいけない'); },
    isProcessAlive: (pid) => pid === servedPid,
  });
  assert.equal(result.pid, servedPid);
  assert.deepEqual(await daemonRecordNames(runtime), [`${servedPid}.json`]);
});

test('daemonは自分の記録をdescriptorと同時に置き、停止時に落とす', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-record-life-'));
  const runtime = path.join(root, 'runtime');
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
    LATTICE_DASHBOARD_PORT: '0', LATTICE_DASHBOARD_AUTOSTART: '1' };
  let daemonPid = null;
  context.after(async () => {
    if (daemonPid !== null) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  await ensureTodoDashboardActivity({ repoRoot: process.cwd(), projectId: 'lattice',
    displayName: 'Lattice', sessionId: 'session-record', env });
  const descriptor = JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8'));
  daemonPid = descriptor.pid;
  const recordRef = path.join(runtime, 'daemons', `${daemonPid}.json`);
  assert.deepEqual(await daemonRecordNames(runtime), [`${daemonPid}.json`]);
  assert.deepEqual(JSON.parse(await readFile(recordRef, 'utf8')), descriptor);
  if (process.platform !== 'win32') {
    assert.equal((await stat(recordRef)).mode & 0o777, 0o600);
  }

  if (process.platform === 'win32') {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/__lattice/shutdown`, { method: 'POST' });
    assert.equal(response.status, 202);
  } else {
    process.kill(daemonPid, 'SIGTERM');
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && (await daemonRecordNames(runtime)).length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await daemonRecordNames(runtime), [], 'SIGTERMで自分の記録を落とす');
  daemonPid = null;
});

test('登録のたびにrepo_rootが消えたentryを落とし、実在repoの登録は残す', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-prune-'));
  const alive = path.join(root, 'alive');
  const gone = path.join(root, 'gone');
  const storeless = path.join(root, 'storeless');
  await Promise.all([mkdir(alive), mkdir(gone), mkdir(storeless)]);
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'runtime') };
  const at = (minute) => new Date(`2026-08-08T00:0${minute}:00.000Z`);
  await registerTodoDashboardActivity({ repoRoot: alive, projectId: 'alive',
    displayName: 'Alive', sessionId: 'session-alive', env, now: at(0) });
  await registerTodoDashboardActivity({ repoRoot: gone, projectId: 'gone',
    displayName: 'Gone', sessionId: 'session-gone', env, now: at(1) });
  // storeを持たないだけのrepoは生きている。`.lattice`の有無で判定していないことの確認。
  await registerTodoDashboardActivity({ repoRoot: storeless, projectId: 'storeless',
    displayName: 'Storeless', sessionId: 'session-storeless', env, now: at(2) });
  await rm(gone, { recursive: true, force: true });

  const registered = await registerTodoDashboardActivity({ repoRoot: alive, projectId: 'alive',
    displayName: 'Alive', sessionId: 'session-alive-2', env, now: at(3) });
  assert.deepEqual(registered.pruned, ['gone']);
  const document = JSON.parse(await readFile(path.join(root, 'runtime', 'projects.json'), 'utf8'));
  assert.deepEqual(document.projects.map(({ project_id: projectId }) => projectId),
    ['alive', 'storeless']);
  assert.equal(document.projects.every((entry) => Object.hasOwn(entry, 'pruned')), false,
    'prunedは戻り値だけで、登録簿のbytesへは書かない');

  const clean = await registerTodoDashboardActivity({ repoRoot: alive, projectId: 'alive',
    displayName: 'Alive', sessionId: 'session-alive-3', env, now: at(4) });
  assert.deepEqual(clean.pruned, [], '落とすものが無ければ空配列');
});

test('dashboard removeは該当entryだけ外し、不在ならtyped errorで拒否する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-remove-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'runtime') };
  const now = new Date('2026-08-08T01:00:00.000Z');
  await registerTodoDashboardActivity({ repoRoot: first, projectId: 'first',
    displayName: 'First', sessionId: 'session-first', env, now });
  await registerTodoDashboardActivity({ repoRoot: second, projectId: 'second',
    displayName: 'Second', sessionId: 'session-second', env, now });

  assert.deepEqual(await removeTodoDashboardProject({ projectId: 'first', env }),
    { projectId: 'first', removed: true });
  const registryRef = path.join(root, 'runtime', 'projects.json');
  assert.deepEqual(JSON.parse(await readFile(registryRef, 'utf8'))
    .projects.map(({ project_id: projectId }) => projectId), ['second']);

  const before = await readFile(registryRef);
  await assert.rejects(removeTodoDashboardProject({ projectId: 'first', env }), (error) => {
    assert.equal(error.code, 'PROJECT_NOT_REGISTERED');
    assert.deepEqual(error.detail, { project_id: 'first' });
    return true;
  });
  assert.deepEqual(await readFile(registryRef), before, '拒否した時はbytesを変えない');
});

test('todo dashboard removeはrepoRoot解決もdaemon起動もせずに登録を外す', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-remove-cli-'));
  const runtime = path.join(root, 'runtime');
  const target = path.join(root, 'target');
  await mkdir(target);
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
    LATTICE_DASHBOARD_PORT: '0', LATTICE_TODO_ACTOR_HOST: 'codex',
    LATTICE_TODO_ACTOR_SESSION: 'session-cli', LATTICE_TODO_ACTOR_AGENT: 'root' };
  await registerTodoDashboardActivity({ repoRoot: target, projectId: 'ghost',
    displayName: 'Ghost', sessionId: 'session-ghost', env,
    now: new Date('2026-08-08T02:00:00.000Z') });
  // 消したいprojectのrepoはもう無い、が今日の実状。CLIがそれでも通ることを確かめる。
  await rm(target, { recursive: true, force: true });

  const run = async (argv) => {
    let stdout = '';
    let stderr = '';
    const code = await runTodoCli({ argv, cwd: process.cwd(), env,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } } });
    return { code, stdout, stderr };
  };

  const removed = await run(['dashboard', 'remove', 'ghost', '--json']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(removed.stderr, '');
  const payload = JSON.parse(removed.stdout);
  assert.equal(payload.schema, 'lattice.todo_dashboard_remove_result.v1');
  assert.equal(payload.project_id, 'ghost');
  assert.equal(payload.removed, true);
  assert.match(payload.result_digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await readActiveTodoDashboardProjects({
    env, now: Date.parse('2026-08-08T02:00:00.000Z'),
  }), []);
  await assert.rejects(stat(path.join(runtime, 'daemon.json')), (error) => error.code === 'ENOENT');

  const missing = await run(['dashboard', 'remove', 'ghost', '--json']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  const failure = JSON.parse(missing.stderr);
  assert.equal(failure.code, 'PROJECT_NOT_REGISTERED');
  assert.deepEqual(failure.detail, { project_id: 'ghost' });
});

test('store書き込みのtodo commandが明示serveなしでproject登録とdaemon起動をensureする', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-cli-'));
  const runtime = path.join(root, 'runtime');
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
    LATTICE_CONFIG_DIR: path.join(root, 'bridge-config'),
    LATTICE_DASHBOARD_PORT: '0', LATTICE_DASHBOARD_AUTOSTART: '1', LATTICE_TODO_ACTOR_HOST: 'codex',
    LATTICE_TODO_ACTOR_SESSION: 'session-cli', LATTICE_TODO_ACTOR_AGENT: 'root' };
  let daemonPid = null;
  context.after(async () => {
    if (daemonPid !== null) {
      try { process.kill(daemonPid, 'SIGTERM'); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  let stdout = '';
  let stderr = '';
  // 登録の前段hookはactionより先に走る。存在しないplanを指した`start`は、hookを
  // 通してからtypedに落ちるので、このrepoのstoreを一切書き換えずに前段だけを見られる。
  const code = await runTodoCli({
    argv: ['start', '--plan', 'no-such-plan', '--task', 'no-such-task'], cwd: process.cwd(), env,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } } });
  assert.equal(code, 1, stdout);
  assert.equal(JSON.parse(stderr.split('\n')[0]).state, 'local_only');
  const descriptor = JSON.parse(await readFile(path.join(runtime, 'daemon.json'), 'utf8'));
  daemonPid = descriptor.pid;
  assert.ok(descriptor.port > 0);
  const registry = await readActiveTodoDashboardProjects({ env });
  assert.equal(registry.length, 1);
  assert.equal(registry[0].project_id, 'lattice');
});

test('読み取りのtodo commandはproject登録もdaemon起動もしない', async (context) => {
  // activeであることはlocalな都合ではない。bridge heartbeatはactive project全件を
  // hubへ送り、hubはその集合から公開dashboardの配信元を決める。つまりactive化は
  // 「この端末がこのprojectを配信する」という主張であって、鮮度窓（1週間）のあいだ続く。
  // cloneを1回覗いただけの`todo status`がそれを主張し、本当に配信している端末と
  // 衝突して、その端末のproject集合ごと公開面から落としていた（2026-08-10）。
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-read-'));
  const runtime = path.join(root, 'runtime');
  const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
    LATTICE_DASHBOARD_PORT: '0', LATTICE_DASHBOARD_AUTOSTART: '1', LATTICE_TODO_ACTOR_HOST: 'codex',
    LATTICE_TODO_ACTOR_SESSION: 'session-read', LATTICE_TODO_ACTOR_AGENT: 'root' };
  context.after(() => rm(root, { recursive: true, force: true }));

  for (const argv of [['status', '--json'], ['verify', '--json']]) {
    let stdout = '';
    let stderr = '';
    const code = await runTodoCli({ argv, cwd: process.cwd(), env,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } } });
    assert.equal(code, 0, stderr);
    assert.deepEqual(await readActiveTodoDashboardProjects({ env }), [],
      `${argv[0]}はprojectをactive化してはならない`);
    await assert.rejects(stat(path.join(runtime, 'daemon.json')),
      (error) => error.code === 'ENOENT', `${argv[0]}はdaemonを起こしてはならない`);
  }
});
