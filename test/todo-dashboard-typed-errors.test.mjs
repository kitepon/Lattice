import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureTodoDashboardDaemon } from '../src/todo-dashboard-registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'lattice.mjs');

// 生きているprocess（この試験自身）が握ったままの新しいlock。待つ側は待ち切れで終わる。
async function holdLocks(runtime) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const held = `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`;
  for (const name of ['registry.lock', 'daemon-start.lock']) {
    await writeFile(path.join(runtime, name), held, { mode: 0o600 });
  }
}

test('登録簿とdaemonの故障はcodeとdetailを持つ（CLIのtyped契約に乗る）', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-typed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  await holdLocks(runtime);
  await assert.rejects(
    ensureTodoDashboardDaemon({ env: { LATTICE_DASHBOARD_RUNTIME_DIR: runtime },
      spawnDaemon() { throw new Error('must not spawn'); } }),
    (error) => {
      assert.equal(error.code, 'DASHBOARD_REGISTRY_BUSY');
      assert.deepEqual(error.detail, { reason: 'dashboard_registry_busy',
        next_action: 'lattice todo dashboard ensure --json' });
      return true;
    },
  );
});

test('todo dashboard ensureはlockの待ち切れをINTERNAL_FAILUREでなくDASHBOARD_REGISTRY_BUSYで返す', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dashboard-typed-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  await holdLocks(runtime);
  // このrepository自身のtodo storeを読む（読むだけ）。lockを取れないのでdaemonは起動しない。
  const result = spawnSync(process.execPath, [cliPath, 'todo', 'dashboard', 'ensure', '--json'], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
      LATTICE_TODO_ACTOR_HOST: 'fixture-host', LATTICE_TODO_ACTOR_SESSION: 'fixture-session',
      LATTICE_TODO_ACTOR_AGENT: 'fixture-agent' },
  });
  assert.equal(result.status, 1, result.stderr);
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1));
  assert.equal(error.schema, 'lattice.cli_error.v2');
  assert.equal(error.code, 'DASHBOARD_REGISTRY_BUSY');
  assert.equal(error.detail.next_action, 'lattice todo dashboard ensure --json');
  assert.equal(Object.hasOwn(error.detail, 'stack_excerpt'), false);
  assert.deepEqual((await readdir(runtime)).sort(), ['daemon-start.lock', 'registry.lock']);
});
