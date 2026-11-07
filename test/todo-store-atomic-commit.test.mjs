import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { commitTodoStoreMutation } from '../src/todo-store-git-transaction.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
} from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-08-09T00:00:00.000Z';

function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.error, undefined);
  if (options.allowFailure !== true) assert.equal(result.status, 0, result.stderr);
  return result;
}

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Lattice Test']);
  git(root, ['config', 'user.email', 'lattice-test@example.invalid']);
  git(root, ['config', 'commit.gpgSign', 'false']);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1',
        project_id: 'project-1',
        plan_key: 'main',
        plan_version: 'v1',
        predecessor_plan_digest: null,
        tasks: [{
          task_id: 'T1', title: 'T1', lane: 'main', narrative_ref: null, compile_binding: null,
        }],
        hard_dependencies: [],
        joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  await writeFile(path.join(root, 'source.txt'), 'source-base\n');
  await writeFile(path.join(root, 'staged.txt'), 'stage-base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

function cliEnv() {
  return {
    ...process.env,
    NO_COLOR: '1',
    LATTICE_DASHBOARD_AUTOSTART: '0',
    LATTICE_TODO_ACTOR_HOST: ACTOR.host,
    LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
    LATTICE_TODO_ACTOR_AGENT: ACTOR.agent,
  };
}

function runCli(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: cliEnv(),
  });
  assert.equal(result.error, undefined);
  return result;
}

const parseCliResult = (text) => JSON.parse(text.trim().split(/\r?\n/u)
  .findLast((line) => line.trimStart().startsWith('{')));

function storeStatus(root) {
  return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.lattice/todo'])
    .stdout;
}

test('dirty sourceと既存stageを保ったままstore pathだけをcommitしreceiptを返す', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'source.txt'), 'source-dirty\n');
  await writeFile(path.join(root, 'staged.txt'), 'stage-next\n');
  git(root, ['add', '--', 'staged.txt']);
  const stagedBefore = git(root, ['ls-files', '--stage', '--', 'staged.txt']).stdout;

  const started = runCli(root,
    ['todo', 'start', '--plan', 'main', '--task', 'T1', '--commit-store']);
  assert.equal(started.status, 0, started.stderr);
  const result = JSON.parse(started.stdout);
  assert.equal(result.schema, 'lattice.todo_store_atomic_commit_result.v1');
  assert.equal(result.operation_result.schema, 'lattice.todo_mutation_result.v5');
  assert.match(result.commit.commit_sha, /^[0-9a-f]{40}$/u);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), result.commit.commit_sha);
  assert.deepEqual(result.commit.paths, [...result.commit.paths].sort());
  assert.ok(result.commit.paths.length > 0);
  assert.ok(result.commit.paths.every((ref) => ref.startsWith('.lattice/todo/')));

  const committed = git(root,
    ['diff-tree', '--no-commit-id', '--name-only', '-r', result.commit.commit_sha]).stdout
    .trim().split('\n').filter(Boolean);
  assert.deepEqual(committed, result.commit.paths);
  assert.equal(await readFile(path.join(root, 'source.txt'), 'utf8'), 'source-dirty\n');
  assert.equal(git(root, ['ls-files', '--stage', '--', 'staged.txt']).stdout, stagedBefore);
  assert.equal(storeStatus(root), '');
});

test('store commits exclude host-local lock/temporary/claim state without consumer ignore rules', async (t) => {
  const root = await workspace(t);
  const transient = [
    '.lattice/todo/.write.lock', '.lattice/todo/.write.lock.dead.tmp',
    '.lattice/todo/.cross-plan-recovery/dead/owner',
    '.lattice/todo/notes/.write.lock', '.lattice/todo/notes/.write.lock.dead.tmp',
    '.lattice/todo/notes/.write.lock.recovery/dead/owner',
  ];
  for (const ref of transient) {
    await mkdir(path.dirname(path.join(root, ref)), { recursive: true });
    await writeFile(path.join(root, ref), 'host-local\n');
  }
  await commitTodoStoreMutation({ repoRoot: root, argv: ['todo', 'note'], env: cliEnv(),
    action: async () => {
      await writeFile(path.join(root, '.lattice/todo/durable-note.txt'), 'committed\n');
      return { ok: true };
    } });
  const tree = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout.split('\n');
  assert.ok(tree.includes('.lattice/todo/durable-note.txt'));
  for (const ref of transient) {
    assert.ok(!tree.includes(ref), ref);
    assert.equal(await readFile(path.join(root, ref), 'utf8'), 'host-local\n');
  }
});

test('同じcommon Git-dirのatomic lock競合はtyped RUN_BUSYでstoreを変えない', async (t) => {
  const root = await workspace(t);
  const linked = `${root}-linked`;
  git(root, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
  t.after(async () => {
    await rm(linked, { recursive: true, force: true });
  });
  let entered;
  let entryFailed;
  const actionEntered = new Promise((resolve, reject) => { entered = resolve; entryFailed = reject; });
  let release;
  const actionRelease = new Promise((resolve) => { release = resolve; });
  const holder = commitTodoStoreMutation({
    repoRoot: root,
    argv: ['start', '--plan', 'main', '--task', 'T1'],
    env: cliEnv(),
    action: async () => {
      entered();
      await actionRelease;
      return null;
    },
  }).catch((error) => { entryFailed(error); return error; });
  await actionEntered;

  const blocked = runCli(linked,
    ['todo', 'start', '--plan', 'main', '--task', 'T1', '--commit-store']);
  assert.equal(blocked.status, 1);
  const failure = parseCliResult(blocked.stderr);
  assert.equal(failure.code, 'RUN_BUSY');
  assert.equal(storeStatus(root), '');
  release();
  const holderResult = await holder;
  assert.equal(holderResult.code, 'STORE_COMMIT_NO_CHANGES');
  assert.equal(storeStatus(root), '');
});

test('source commitでHEADが先行したら期待ref更新を拒否しstoreだけrollbackする', async (t) => {
  const root = await workspace(t);
  const headBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const manifest = path.join(root, '.lattice/todo/manifest.json');
  const manifestBefore = await readFile(manifest, 'utf8');

  const failure = await commitTodoStoreMutation({
    repoRoot: root,
    argv: ['note', '--plan', 'main', '--message', 'head-race'],
    env: cliEnv(),
    action: async () => {
      await writeFile(manifest, `${manifestBefore} `);
      await writeFile(path.join(root, 'source.txt'), 'source-advanced\n');
      git(root, ['add', '--', 'source.txt']);
      git(root, ['commit', '--quiet', '-m', 'concurrent source']);
      return null;
    },
  }).catch((error) => error);

  assert.equal(failure.code, 'STORE_COMMIT_HEAD_CONFLICT');
  assert.notEqual(git(root, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
  assert.equal(await readFile(path.join(root, 'source.txt'), 'utf8'), 'source-advanced\n');
  assert.equal(await readFile(manifest, 'utf8'), manifestBefore);
  assert.equal(storeStatus(root), '');
});

test('共有index.lock競合はref更新前にtyped拒否しstoreをrollbackする', async (t) => {
  const root = await workspace(t);
  const headBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const lockPath = path.join(root, '.git/index.lock');
  await writeFile(lockPath, 'foreign-index-owner\n', { flag: 'wx' });

  const blocked = runCli(root,
    ['todo', 'start', '--plan', 'main', '--task', 'T1', '--commit-store']);
  assert.equal(blocked.status, 1);
  assert.equal(parseCliResult(blocked.stderr).code, 'STORE_COMMIT_INDEX_BUSY');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
  assert.equal(storeStatus(root), '');
  assert.equal(await readFile(lockPath, 'utf8'), 'foreign-index-owner\n');
});

test('commit hook失敗はtyped failureになりstoreを開始時bytesへrollbackする', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'source.txt'), 'source-dirty\n');
  const hook = path.join(root, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const headBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();

  const failed = runCli(root,
    ['todo', 'start', '--plan', 'main', '--task', 'T1', '--commit-store']);
  assert.equal(failed.status, 1);
  assert.equal(parseCliResult(failed.stderr).code, 'STORE_COMMIT_FAILED');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
  assert.equal(storeStatus(root), '');
  assert.equal(await readFile(path.join(root, 'source.txt'), 'utf8'), 'source-dirty\n');
});

test('成功するhookがstore worktreeを再変更してもref更新前に検出してrollbackする', async (t) => {
  const root = await workspace(t);
  const hook = path.join(root, '.git/hooks/pre-commit');
  await writeFile(hook,
    '#!/bin/sh\nprintf " " >> .lattice/todo/manifest.json\nexit 0\n', { mode: 0o755 });
  const headBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();

  const failed = runCli(root,
    ['todo', 'start', '--plan', 'main', '--task', 'T1', '--commit-store']);
  assert.equal(failed.status, 1);
  assert.equal(parseCliResult(failed.stderr).code, 'STORE_COMMIT_INDEX_DIRTY');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
  assert.equal(storeStatus(root), '');
});

test('dirty storeは所有者を推測せずtyped拒否し、既存bytesを変更しない', async (t) => {
  const root = await workspace(t);
  const manifest = path.join(root, '.lattice/todo/manifest.json');
  const dirtyBytes = `${await readFile(manifest, 'utf8')} `;
  await writeFile(manifest, dirtyBytes);
  const headBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();

  const failed = runCli(root,
    ['todo', 'start', '--plan', 'main', '--task', 'T1', '--commit-store']);
  assert.equal(failed.status, 1);
  assert.equal(parseCliResult(failed.stderr).code, 'STORE_COMMIT_DIRTY');
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
  assert.equal(await readFile(manifest, 'utf8'), dirtyBytes);
});

test('store actionの契約違反はrollback後もTypeErrorとして保持する', async (t) => {
  const root = await workspace(t);
  const manifest = path.join(root, '.lattice/todo/manifest.json');
  const manifestBefore = await readFile(manifest, 'utf8');

  const failure = await commitTodoStoreMutation({
    repoRoot: root,
    argv: ['start', '--plan', 'main', '--task', 'T1'],
    env: cliEnv(),
    action: async () => {
      await writeFile(manifest, `${manifestBefore} `);
      throw new TypeError('fixture contract violation');
    },
  }).catch((error) => error);

  assert.equal(failure instanceof TypeError, true);
  assert.equal(failure.message, 'fixture contract violation');
  assert.equal(await readFile(manifest, 'utf8'), manifestBefore);
  assert.equal(storeStatus(root), '');
});

test('primary errorとcleanup失敗が併発しても両方をtyped detailへ保持する',
  { skip: process.platform === 'win32' }, async (t) => {
  const root = await workspace(t);
  const commonDir = path.join(root, '.git');
  let transactionDir = null;
  let failure;
  try {
    failure = await commitTodoStoreMutation({
      repoRoot: root,
      argv: ['start', '--plan', 'main', '--task', 'T1'],
      env: cliEnv(),
      action: async () => {
        const entry = (await readdir(commonDir))
          .find((name) => name.startsWith('lattice-todo-rollback-'));
        assert.notEqual(entry, undefined);
        transactionDir = path.join(commonDir, entry);
        await chmod(transactionDir, 0o500);
        throw new TypeError('fixture primary failure');
      },
    }).catch((error) => error);
  } finally {
    if (transactionDir !== null) {
      await chmod(transactionDir, 0o700).catch(() => {});
      await rm(transactionDir, { recursive: true, force: true });
    }
  }

  assert.equal(failure.code, 'STORE_COMMIT_CLEANUP_FAILED');
  assert.deepEqual(failure.detail.primary, {
    code: null,
    type: 'TypeError',
    message: 'fixture primary failure',
  });
  assert.ok(failure.detail.failures.includes('EACCES'));
  assert.equal(storeStatus(root), '');
});

test('read commandの--commit-storeはunsupportedで、既存writeは非atomicのまま', async (t) => {
  const root = await workspace(t);
  for (const args of [
    ['todo', 'status', '--commit-store'],
    ['todo', 'revise', '--schema', '--json', '--commit-store'],
    ['todo', 'dashboard', 'remove', 'project-1', '--json', '--commit-store'],
  ]) {
    const unsupported = runCli(root, args);
    assert.equal(unsupported.status, 2);
    assert.equal(parseCliResult(unsupported.stderr).code, 'STORE_COMMIT_UNSUPPORTED');
  }

  const headBefore = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const started = runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(git(root, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
  assert.notEqual(storeStatus(root), '');
});

test('ignored再生成artifactだけのcompile commandはatomic commit対象外にする', async (t) => {
  const root = await workspace(t);
  for (const args of [
    ['todo', 'independence', 'compile', '--plan', 'main', '--input', 'witness.json',
      '--commit-store'],
    ['todo', 'seam-proposal', 'compile', '--plan', 'main', '--commit-store'],
  ]) {
    const unsupported = runCli(root, args);
    assert.equal(unsupported.status, 2);
    assert.equal(parseCliResult(unsupported.stderr).code, 'STORE_COMMIT_UNSUPPORTED');
    assert.equal(storeStatus(root), '');
  }
});

test('todo helpはatomic suffixとdirty store拒否を公開する', () => {
  const shown = spawnSync(process.execPath, [CLI, 'todo', '--help'], { encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /末尾へ--commit-store/u);
  assert.match(shown.stdout, /store自身がdirtyなら拒否/u);
});
