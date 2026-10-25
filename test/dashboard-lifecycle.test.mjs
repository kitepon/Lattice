import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createLifecycleRun, LIFECYCLE_MAX_RUNS, readLifecycleRuns, recordLifecyclePhase,
  reconcileLifecycleRuns, writeLifecycleRun } from '../src/dashboard-lifecycle-journal.mjs';
import { observedDashboardExit, observeDashboardProcess,
  terminateOwnedWindowsDashboard } from '../src/dashboard-process-control.mjs';
import { registerManagedDaemonFixture } from './helpers/managed-daemon-fixture.mjs';
import { ensureTodoDashboardDaemon, registerTodoDashboardActivity } from '../src/todo-dashboard-registry.mjs';
import { runBridgeCli } from '../src/bridge-cli.mjs';
import { reportProjectDashboardDelivery, verifyBridgeHubDelivery } from '../src/dashboard-delivery.mjs';

const execute = promisify(execFile);

async function until(read, accepts, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw new Error('lifecycle fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function fixture(t, mode) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-lifecycle-'));
  registerManagedDaemonFixture(t, root);
  const run = await createLifecycleRun(root, 'fixture');
  const child = path.join(root, 'child.mjs');
  await writeFile(child, `
    import { existsSync } from 'node:fs';
    import path from 'node:path';
    const mode = process.argv[2];
    process.on('message', message => {
      if (message.type === 'dashboard_shutdown' && mode !== 'ignore-stop') process.exit(0);
    });
    process.stderr.write('secret-token-marker\\n'.repeat(10000), () => {
      process.send({type:'dashboard_phase', phase:'ready'});
      process.send({type:'dashboard_phase', phase:'secret-project-body-marker'});
      if (mode === 'zero') setTimeout(() => process.exit(0), 200);
      else if (mode === 'seven') setTimeout(() => process.exit(7), 200);
      else if (mode === 'throw') setTimeout(() => { throw new Error('secret-exception-marker'); }, 200);
      else if (mode === 'natural-race') setInterval(() => {
        if (existsSync(path.join(process.argv[3], 'natural-exit'))) process.exit(0);
      }, 10);
      else setInterval(() => {}, 1000);
    });
  `);
  const launcher = path.join(root, 'supervisor.mjs');
  const moduleUrl = pathToFileURL(path.resolve('src/dashboard-supervisor.mjs')).href;
  await writeFile(launcher, `
    import { superviseDashboard } from ${JSON.stringify(moduleUrl)};
    await superviseDashboard({args:${JSON.stringify([child, mode, root])}, env:process.env,
      root:${JSON.stringify(root)}, runId:${JSON.stringify(run.run_id)}, graceMs:200});
  `);
  const supervisor = spawn(process.execPath, [launcher, root], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  supervisor.stderr.on('data', (bytes) => { stderr += bytes; });
  const closed = new Promise((resolve) => supervisor.once('close', (code, signal) => resolve({ code, signal, stderr })));
  const read = async () => (await readLifecycleRuns(root))[0];
  await until(read, (value) => value.child !== null);
  return { root, read, supervisor, closed };
}

test('supervisorは実childの0・非0・例外をwaitし、段階と有限digestを残す', { timeout: 60_000 }, async (t) => {
  for (const [mode, expected] of [['zero', 0], ['seven', 7], ['throw', 1]]) {
    const f = await fixture(t, mode);
    assert.deepEqual(await f.closed, { code: expected, signal: null, stderr: '' });
    const run = await f.read();
    assert.equal(run.state, 'closed');
    assert.equal(run.observed_exit.status, 'observed');
    assert.equal(process.platform === 'win32' ? run.observed_exit.uint32 : run.observed_exit.code, expected);
    assert.equal(run.phase, 'ready');
    assert.ok(run.ready_at);
    assert.ok(run.exit_observed_at);
    assert.equal(run.stderr.hashed_bytes, 65_536);
    assert.equal(run.stderr.truncated, true);
    const serialized = JSON.stringify(run);
    assert.doesNotMatch(serialized, /secret-(?:token|exception|project)/u);
    assert.ok(Buffer.byteLength(serialized) < 16_384);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(f.root, 'lifecycle'))).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(f.root, 'lifecycle', `${run.run_id}.json`))).mode & 0o777, 0o600);
    }
  }
});

test('supervisorの通常TERMはIPCを転送し、要求と実child exitを分ける', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, 'wait');
  await until(f.read, (run) => run.phase === 'ready');
  f.supervisor.kill('SIGTERM');
  const closed = await f.closed;
  // Windows ChildProcess.kill is a forced termination, not a delivered POSIX signal.
  if (process.platform === 'win32') {
    const run = await f.read();
    assert.equal(run.state, 'active');
    assert.equal(run.observed_exit.status, 'unknown');
    assert.notEqual(await observeDashboardProcess(run.child.pid), null);
  } else {
    assert.equal(closed.code, 0);
    const run = await f.read();
    assert.equal(run.termination_request.reason, 'supervisor_SIGTERM');
    assert.equal(run.termination_request.mechanism, 'ipc_shutdown');
    assert.equal(run.observed_exit.code, 0);
  }
});

test('supervisorだけのKILLはchildを残し、終了値をunknownのまま照合する', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, 'wait');
  const before = await until(f.read, (run) => run.phase === 'ready');
  f.supervisor.kill('SIGKILL');
  await f.closed;
  assert.notEqual(await observeDashboardProcess(before.child.pid), null);
  await reconcileLifecycleRuns(f.root, observeDashboardProcess);
  const run = await f.read();
  assert.equal(run.state, 'supervisor_lost');
  assert.equal(run.observed_exit.status, 'unknown');
  assert.equal(run.exit_observed_at, null);
  assert.match(run.child_at_reconciliation, /^present/u);
});

test('POSIX child TERM/KILLの実signalをexit0へ変えない',
  { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const f = await fixture(t, 'wait');
      const before = await until(f.read, (run) => run.phase === 'ready');
      process.kill(before.child.pid, signal);
      await f.closed;
      const run = await f.read();
      assert.equal(run.observed_exit.signal, signal);
      assert.equal(run.observed_exit.code, null);
    }
  });

test('Windows DWORDはunsigned/hexで保持し、値だけでAVや外部killを断定しない', () => {
  assert.deepEqual(observedDashboardExit(-1073741819, null, 'win32'), {
    status: 'observed', uint32: 3221225477, hex: '0xC0000005', signal: 'not_applicable',
    source: 'node_child_wait', origin: 'unknown',
  });
  assert.deepEqual(observedDashboardExit(null, 'SIGTERM', 'win32'), {
    status: 'unknown', signal: 'not_applicable',
  });
});

test('正常shutdownに応じない所有childをOS別に止め、要求と実観測を残す',
  { timeout: 45_000 }, async (t) => {
    const f = await fixture(t, 'ignore-stop');
    await until(f.read, (run) => run.phase === 'ready');
    f.supervisor.send({ type: 'dashboard_supervisor_stop' });
    assert.equal((await f.closed).code, 1);
    const run = await f.read();
    if (process.platform === 'win32') {
      assert.equal(run.termination_request.os_request.mechanism, 'TerminateProcess');
      assert.equal(run.termination_request.os_request.api_succeeded, true);
      assert.equal(run.termination_request.os_request.actual_exit_code, 1);
      assert.equal(run.observed_exit.uint32, 1);
      assert.equal(run.observed_exit.origin, 'owned_terminate_request');
      assert.equal(run.observed_exit.signal, 'not_applicable');
    } else {
      assert.equal(run.termination_request.os_request.signal, 'SIGKILL');
      assert.equal(run.observed_exit.signal, 'SIGKILL');
    }
  });

test('通常ensureは監督側だけを失った実daemonを再利用し二重起動しない',
  { timeout: 45_000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-supervisor-loss-'));
    registerManagedDaemonFixture(t, root);
    const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: root, LATTICE_DASHBOARD_PORT: '0' };
    await registerTodoDashboardActivity({ env, repoRoot: process.cwd(), projectId: 'lattice',
      displayName: 'Lattice', sessionId: 'lifecycle-fixture' });
    const first = await ensureTodoDashboardDaemon({ env });
    const before = (await readLifecycleRuns(root))[0];
    assert.equal(before.child.pid, first.pid);
    process.kill(before.supervisor.pid, 'SIGKILL');
    await until(() => observeDashboardProcess(before.supervisor.pid), (identity) => identity === null);
    const second = await ensureTodoDashboardDaemon({ env });
    assert.equal(second.pid, first.pid);
    const runs = await readLifecycleRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'supervisor_lost');
    assert.equal(runs[0].observed_exit.status, 'unknown');
    assert.equal((await readdir(path.join(root, 'daemons'))).length, 1);
  });

test('Windows所有handleはbirth不一致を拒否し実TerminateProcess終了値を読む',
  { skip: process.platform !== 'win32', timeout: 60_000 }, async (t) => {
    const f = await fixture(t, 'wait');
    const run = await until(f.read, (value) => value.phase === 'ready' && value.child.birth !== null);
    await assert.rejects(terminateOwnedWindowsDashboard({ ...run.child, birth: '1' }), /IDENTITY_MISMATCH/u);
    assert.notEqual(await observeDashboardProcess(run.child.pid), null);
    // This is deliberately an external TerminateProcess with a chosen NTSTATUS-shaped value.
    // It proves lossless observation, not an actual access violation or its cause.
    const result = await terminateOwnedWindowsDashboard(run.child, 3221225477);
    assert.equal(result.termination_requested, true);
    assert.equal(result.actual_exit_hex, '0xC0000005');
    await f.closed;
    const after = await f.read();
    assert.equal(after.observed_exit.uint32, 3221225477);
    assert.equal(after.observed_exit.origin, 'unknown');
    assert.equal(after.termination_request, null);
  });

test('Windowsの自然終了と外部終了要求のraceでも要求値で実結果を埋めない',
  { skip: process.platform !== 'win32', timeout: 60_000 }, async (t) => {
    const f = await fixture(t, 'natural-race');
    const run = await until(f.read, (value) => value.phase === 'ready' && value.child.birth !== null);
    await writeFile(path.join(f.root, 'natural-exit'), 'exit\n');
    let result = null; let failure = null;
    try { result = await terminateOwnedWindowsDashboard(run.child, 7); }
    catch (error) { failure = error; }
    await f.closed;
    const after = await f.read();
    if (result === null) {
      assert.ok(failure);
      assert.equal(after.observed_exit.uint32, 0);
    } else {
      assert.equal(after.observed_exit.uint32, result.actual_exit_code);
      assert.ok([0, 7].includes(result.actual_exit_code));
      if (!result.termination_requested) assert.equal(result.actual_exit_code, 0);
    }
    assert.equal(after.termination_request, null);
    assert.equal(after.observed_exit.origin, 'unknown');
  });

test('Windows GetExitCodeProcess失敗は実APIの無効handleで非0になりstdout値を返さない',
  { skip: process.platform !== 'win32', timeout: 60_000 }, async (t) => {
    const f = await fixture(t, 'wait');
    const run = await until(f.read, (value) => value.phase === 'ready' && value.child.birth !== null);
    const source = await readFile('src/dashboard-windows-process-control.ps1', 'utf8');
    const anchor = '  if (-not [DashboardOwnedProcess]::GetExitCodeProcess';
    assert.equal(source.split(anchor).length, 2);
    // Fault injection is confined to a private copy, with the same owned identity.
    // The product ships no fault flag. Close just this handle immediately before read.
    const script = path.join(f.root, 'closed-handle-control.ps1');
    await writeFile(script, source.replace(anchor,
      '  [void][DashboardOwnedProcess]::CloseHandle($handle)\n' + anchor));
    await assert.rejects(execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script,
      '-ChildPid', String(run.child.pid), '-BirthFileTime', run.child.birth, '-RequestedExitCode', '7'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true }), (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /DASHBOARD_CHILD_EXIT_READ_FAILED/u);
      assert.equal(error.stdout.trim(), '');
      return true;
    });
    await f.closed;
    const after = await f.read();
    assert.equal(after.observed_exit.uint32, 7, 'the independent Node wait still observes the child');
    assert.equal(after.observed_exit.origin, 'unknown');
  });

test('journalは上限でclosedだけを消し、activeを捨てずspawn前に拒否する', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-journal-'));
  registerManagedDaemonFixture(t, root);
  const first = await createLifecycleRun(root, 'fixture');
  recordLifecyclePhase(first, 'ready');
  recordLifecyclePhase(first, 'store_read_failed');
  for (let index = 0; index < 100; index += 1) recordLifecyclePhase(first, index % 2 ? 'registry' : 'store');
  assert.equal(first.events.length, 64);
  assert.equal(first.events.some((event) => event.phase === 'ready'), false, 'retain the recent tail');
  assert.ok(first.ready_at, 'startup time remains even when its event rotates');
  assert.equal(first.events.at(-1).phase, first.phase);
  assert.equal(first.last_failure_observed.phase, 'store_read_failed');
  for (let index = 1; index < LIFECYCLE_MAX_RUNS; index += 1) await createLifecycleRun(root, 'fixture');
  await assert.rejects(createLifecycleRun(root, 'fixture'), { code: 'DASHBOARD_LIFECYCLE_CAPACITY' });
  first.state = 'closed'; await writeLifecycleRun(root, first);
  await createLifecycleRun(root, 'fixture');
  assert.equal((await readLifecycleRuns(root)).length, LIFECYCLE_MAX_RUNS);
  assert.equal((await readdir(path.join(root, 'lifecycle'))).includes(`${first.run_id}.json`), false);
});

test('監視外childが後で消えても終了値はunknownで、保持対象だけを更新する', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-lost-child-'));
  registerManagedDaemonFixture(t, root);
  const run = await createLifecycleRun(root, 'fixture');
  run.supervisor = { pid: 111, birth: 'observer-birth' };
  run.child = { pid: 222, birth: 'child-birth' };
  await writeLifecycleRun(root, run);
  await reconcileLifecycleRuns(root, async (pid) => pid === 222 ? run.child : null);
  const [alive] = await readLifecycleRuns(root);
  assert.equal(alive.child_at_reconciliation, 'present_identity_matched');
  await reconcileLifecycleRuns(root, async () => null);
  const [gone] = await readLifecycleRuns(root);
  assert.equal(gone.child_at_reconciliation, 'absent');
  assert.equal(gone.observer_loss_observed_at, alive.observer_loss_observed_at);
  assert.equal(gone.observed_exit.status, 'unknown');
  assert.equal(gone.exit_observed_at, null);
});

test('journalはsymlink先へ書かずtyped拒否する', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-journal-link-'));
  registerManagedDaemonFixture(t, root);
  await symlink(root, path.join(root, 'lifecycle'), 'dir');
  await assert.rejects(createLifecycleRun(root, 'fixture'), { code: 'DASHBOARD_LIFECYCLE_UNSAFE_PATH' });
});

test('通常bridge statusは最後の終了を読み、daemonやensure記録を書かない', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-status-'));
  registerManagedDaemonFixture(t, root);
  const run = await createLifecycleRun(root, 'fixture');
  run.state = 'closed'; run.exit_observed_at = new Date().toISOString();
  run.observed_exit = observedDashboardExit(7, null);
  await writeLifecycleRun(root, run);
  const before = await readdir(root);
  let stdout = ''; let stderr = '';
  const code = await runBridgeCli({ argv: ['status', '--json'],
    env: { LATTICE_CONFIG_DIR: root, LATTICE_DASHBOARD_RUNTIME_DIR: root },
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    launchAgent: { snapshot: async () => ({ installed: false }), describe: async () => null },
    runtimeIdentity: async () => ({ state: 'not_running' }),
  });
  assert.equal(code, 0, stderr);
  const status = JSON.parse(stdout).dashboard_lifecycle;
  assert.equal(status.schema, 'lattice.dashboard_lifecycle_status.v1');
  assert.deepEqual(status.active, []);
  assert.equal(status.last_termination.run_id, run.run_id);
  assert.deepEqual(status.last_termination.observed_exit, run.observed_exit);
  assert.equal(status.last_ensure, null);
  assert.deepEqual(await readdir(root), before);
});

test('実HTTPの登録・一覧・project配信失敗は生存中daemonの置換理由にならない',
  { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-delivery-stages-'));
    registerManagedDaemonFixture(t, root);
    const env = { ...process.env, LATTICE_DASHBOARD_RUNTIME_DIR: root, LATTICE_DASHBOARD_PORT: '0' };
    await registerTodoDashboardActivity({ env, repoRoot: process.cwd(), projectId: 'lattice',
      displayName: 'Lattice', sessionId: 'delivery-stage-fixture' });
    const daemon = await ensureTodoDashboardDaemon({ env });
    let failure = 'heartbeat_registration';
    const server = createServer((request, response) => {
      const stage = request.url === '/register' ? 'heartbeat_registration'
        : request.url === '/projects/' ? 'hub_listing' : 'project_route';
      if (stage === failure) { response.writeHead(503).end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === '/register'
        ? { schema: 'lattice.bridge_hub_registration_result.v2', registered: ['lattice'], rejected: [] }
        : [{ project_id: 'lattice', status: 'online' }]));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const hub = `http://127.0.0.1:${server.address().port}/`;
    for (const stage of ['heartbeat_registration', 'hub_listing', 'project_route']) {
      failure = stage;
      const receipt = await reportProjectDashboardDelivery({ projectId: 'lattice', env,
        ensureDelivery: () => verifyBridgeHubDelivery({ config: { hub: { url: hub } },
          projectId: 'lattice', heartbeat: async () => {
            const response = await fetch(new URL('register', hub), { method: 'POST' });
            return response.ok ? { state: 'accepted', result: await response.json() } : { state: 'unreachable' };
          } }),
      });
      assert.equal(receipt.state, 'failed');
      assert.equal(receipt.failure.stage, stage);
      assert.equal((await ensureTodoDashboardDaemon({ env })).pid, daemon.pid);
    }
    assert.equal((await readLifecycleRuns(root)).length, 1);
  });

test('supervisorのimport閉包はstdlibと制御・receiptのleafだけ', async () => {
  const files = ['src/dashboard-supervisor.mjs', 'src/dashboard-process-control.mjs',
    'src/dashboard-lifecycle-journal.mjs'];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"].*(?:sensor|todo-|bridge|sqlite)/u);
  }
});
