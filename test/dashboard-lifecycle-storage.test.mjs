import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLifecycleRun, readDashboardLifecycleStatus, readLifecycleRuns,
  recordDashboardEnsureDecision, writeLifecycleRun } from '../src/dashboard-lifecycle-journal.mjs';
import { registerManagedDaemonFixture } from './helpers/managed-daemon-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-lifecycle-storage-'));
  registerManagedDaemonFixture(t, root);
  const run = await createLifecycleRun(root, 'fixture');
  return { root, run, ref: path.join(root, 'lifecycle', `${run.run_id}.json`) };
}

async function holdAgainstDelete(root, ref) {
  const script = path.join(root, 'hold-owned-receipt.ps1');
  await writeFile(script, `param([string]$OwnedFile)
$ErrorActionPreference = 'Stop'
$stream = [System.IO.FileStream]::new($OwnedFile, [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('held'); [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally { $stream.Dispose() }
`);
  const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script, ref],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let stdinError = null;
  child.stdout.on('data', (bytes) => { stdout += bytes; });
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-4000); });
  child.stdin.on('error', (error) => { stdinError = error.code; });
  let closedState = null; let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => { closedState = { code, signal }; resolve(closedState); });
  });
  const deadline = Date.now() + 15_000;
  while (!stdout.includes('held')) {
    if (spawnError) throw spawnError;
    if (closedState || Date.now() >= deadline) throw new Error(`owned locker failed: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { async release() {
    if (!closedState && !child.stdin.writableEnded) child.stdin.end('release\n');
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(stdinError, null);
  } };
}

test('lifecycleのrunとensureは完全なsnapshotを公開する', async (t) => {
  const { root, run } = await fixture(t);
  run.phase = 'ready';
  await writeLifecycleRun(root, run);
  assert.equal((await readLifecycleRuns(root))[0].phase, 'ready');
  await recordDashboardEnsureDecision(root, 'start_missing', null);
  assert.equal((await readDashboardLifecycleStatus(root)).last_ensure.decision, 'start_missing');
  assert.deepEqual((await readdir(path.join(root, 'lifecycle'))).filter((x) => x.endsWith('.tmp')), []);
});

test('lifecycleのunsafeな宛先と容量超過は公開前に拒否する', async (t) => {
  const { root, run, ref } = await fixture(t);
  const previous = await readFile(ref);
  run.extra = 'x'.repeat(16 * 1024);
  await assert.rejects(writeLifecycleRun(root, run), { code: 'DASHBOARD_LIFECYCLE_CAPACITY' });
  assert.deepEqual(await readFile(ref), previous);
  const unsafe = { ...run, run_id: '11111111-1111-1111-1111-111111111111' };
  delete unsafe.extra;
  await mkdir(path.join(root, 'lifecycle', `${unsafe.run_id}.json`));
  await assert.rejects(writeLifecycleRun(root, unsafe), { code: 'DASHBOARD_LIFECYCLE_UNSAFE_PATH' });
});

test('Windowsの実delete共有拒否では旧記録を残し解除後にrunとensureを公開する',
  { skip: process.platform !== 'win32', timeout: 45_000 }, async (t) => {
    for (const kind of ['run', 'ensure']) {
      const { root, run, ref: runRef } = await fixture(t);
      if (kind === 'ensure') await recordDashboardEnsureDecision(root, 'start_missing', null);
      const ref = kind === 'run' ? runRef : path.join(root, 'lifecycle', 'ensure.json');
      const previous = await readFile(ref);
      const locker = await holdAgainstDelete(root, ref);
      try {
        const probe = path.join(root, 'probe.json');
        await writeFile(probe, '{}');
        await assert.rejects(rename(probe, ref), (error) => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
        run.phase = 'ready';
        const publication = (kind === 'run' ? writeLifecycleRun(root, run)
          : recordDashboardEnsureDecision(root, 'reuse_current', null))
          .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.deepEqual(await readFile(ref), previous, 'the old complete receipt remains visible while held');
        await locker.release();
        const result = await publication;
        if (!result.ok) throw result.error;
        const stored = JSON.parse(await readFile(ref, 'utf8'));
        assert.equal(kind === 'run' ? stored.phase : stored.decision, kind === 'run' ? 'ready' : 'reuse_current');
      } finally { await locker.release(); }
    }
  });

test('Windowsで共有拒否が続けば有限に失敗し旧記録と元errorを保持する',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async (t) => {
    const { root, run, ref } = await fixture(t);
    const previous = await readFile(ref);
    const locker = await holdAgainstDelete(root, ref);
    try {
      run.phase = 'ready';
      await assert.rejects(writeLifecycleRun(root, run), (error) => {
        assert.equal(error.code, 'DASHBOARD_LIFECYCLE_PUBLISH_FAILED');
        assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.cause.code));
        assert.equal(error.detail.fs_code, error.cause.code);
        assert.ok(error.detail.attempts > 1 && error.detail.attempts <= 32);
        assert.equal(error.detail.temporary_retained, true);
        return true;
      });
      assert.deepEqual(await readFile(ref), previous);
      const pending = (await readdir(path.join(root, 'lifecycle'))).filter((name) => name.endsWith('.tmp'));
      assert.equal(pending.length, 1);
    } finally { await locker.release(); }
  });
