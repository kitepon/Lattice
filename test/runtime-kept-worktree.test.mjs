import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureWorktreeDiff } from '../src/runtime-diff-observer.mjs';
import { recoverKeptWorktrees } from '../src/runtime-kept-worktree.mjs';
import { observeManagedProcessStartIdentity } from '../src/runtime-managed-supervisor.mjs';

// R2k needs `ps -g`-style group observation; win32 records owner_unproven by design.
const posix = { skip: process.platform === 'win32' ? 'R2k lock recovery needs ps (win32 keeps the lock)' : false };

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function keptTree(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lattice-kept-wt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'fixture');
  await writeFile(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'base');
  const tree = path.join(root, 'tree');
  git(repo, 'worktree', 'add', '-q', '--detach', tree, 'HEAD');
  return { repo, tree, baseSha: git(repo, 'rev-parse', 'HEAD'),
    lockPath: path.resolve(tree, git(tree, 'rev-parse', '--git-path', 'index.lock')) };
}

async function realWorker(t, tree) {
  // A real worker in its own process group, as a dispatched executor is.
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { cwd: tree, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(worker.pid, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise((resolve) => worker.once('spawn', resolve));
  const binding = { process_pid: worker.pid, process_group_id: worker.pid,
    process_start_identity: await observeManagedProcessStartIdentity(worker.pid),
    worktree_path: tree, worktree_realpath: tree };
  return { worker, binding };
}

function runEvents(binding, baseSha, checkpoint) {
  const events = [{ sequence: 1, kind: 'executor_dispatched', subject: { kind: 'todo', ref: 'T1' },
    payload: { direct_os_observation_binding: { ...binding, base_sha: baseSha } } }];
  if (checkpoint) {
    events.push({ sequence: 2, kind: 'checkpoint_observed', subject: { kind: 'todo', ref: 'T1' },
      payload: checkpoint });
  }
  return events;
}

test('R2k: a SIGSTOPped live worker keeps its index.lock; after SIGKILL the stale lock is removed and late writes are named', posix, async (t) => {
  const { tree, baseSha, lockPath } = await keptTree(t);
  const { worker, binding } = await realWorker(t, tree);
  await writeFile(path.join(tree, 'a.txt'), 'observed\n');
  const checkpoint = await captureWorktreeDiff({ worktreePath: tree, baseSha });
  // Written after the last checkpoint: what a killed worker may leave half-written.
  await writeFile(path.join(tree, 'a.txt'), 'half-wri');
  await writeFile(path.join(tree, 'b.txt'), 'new');
  await writeFile(lockPath, 'partial index');
  const events = runEvents(binding, baseSha, checkpoint);

  process.kill(worker.pid, 'SIGSTOP');
  const [stopped] = await recoverKeptWorktrees({ events });
  assert.equal(stopped.index_lock, 'owner_live');
  assert.ok((await lstat(lockPath)).isFile(), 'a live owner keeps its lock');

  process.kill(worker.pid, 'SIGKILL');
  const [killed] = await recoverKeptWorktrees({ events });
  assert.deepEqual(killed, { todo_ids: ['T1'], worktree_path: tree, index_lock: 'removed',
    unobserved_paths: ['a.txt', 'b.txt'] });
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  git(tree, 'add', 'a.txt'); // the next Git write in the kept tree works again

  const [again] = await recoverKeptWorktrees({ events });
  assert.equal(again.index_lock, 'absent');
});

test('R2k: a terminal TODO is not touched, and an unreadable tree is recorded instead of failing', posix, async (t) => {
  const { tree, baseSha, lockPath } = await keptTree(t);
  const { worker, binding } = await realWorker(t, tree);
  process.kill(worker.pid, 'SIGKILL');
  await writeFile(lockPath, '');
  const events = runEvents(binding, baseSha);
  events.push({ sequence: 3, kind: 'executor_terminal', subject: { kind: 'todo', ref: 'T1' }, payload: {} });
  assert.deepEqual(await recoverKeptWorktrees({ events }), []);
  assert.ok((await lstat(lockPath)).isFile());

  const gone = runEvents({ ...binding, worktree_path: path.join(tree, 'missing') }, baseSha);
  const [entry] = await recoverKeptWorktrees({ events: gone });
  assert.equal(entry.index_lock, 'unknown');
  assert.equal(typeof entry.observation_error, 'string');
});

test('R2k: a checkpoint path reverted to base is reported as unobserved', posix, async (t) => {
  const { tree, baseSha } = await keptTree(t);
  const { worker, binding } = await realWorker(t, tree);
  await writeFile(path.join(tree, 'a.txt'), 'checkpointed\n');
  const checkpoint = await captureWorktreeDiff({ worktreePath: tree, baseSha });
  await writeFile(path.join(tree, 'a.txt'), 'base\n');
  process.kill(worker.pid, 'SIGKILL');

  const [entry] = await recoverKeptWorktrees({ events: runEvents(binding, baseSha, checkpoint) });
  assert.deepEqual(entry.unobserved_paths, ['a.txt']);
});

test('R2k: a lock recovery permission error is recorded as unknown with observation_error', posix, async (t) => {
  const { tree, baseSha, lockPath } = await keptTree(t);
  const { worker, binding } = await realWorker(t, tree);
  process.kill(worker.pid, 'SIGKILL');
  await writeFile(lockPath, 'partial index');
  const gitDir = path.dirname(lockPath);
  await chmod(gitDir, 0o555);
  try {
    const [entry] = await recoverKeptWorktrees({ events: runEvents(binding, baseSha) });
    assert.equal(entry.index_lock, 'unknown');
    assert.match(entry.observation_error, /permission denied/i);
  } finally {
    await chmod(gitDir, 0o755);
  }
});
