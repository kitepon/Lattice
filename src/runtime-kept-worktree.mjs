/**
 * R2k: what a SIGKILLed worker leaves in its kept worktree (dfd-runtime-hold-resume.md).
 *
 * Git's index.lock names no owner. The owner is every process Runtime put in that 1:1 tree,
 * recorded by `executor_dispatched`. The lock goes only when all of them are proven gone, and
 * only the judged inode. Half-written files are reported, never repaired: close keeps the tree.
 */

import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { captureWorktreeDiff } from './runtime-diff-observer.mjs';
import { removeJudgedEntry } from './runtime-lifecycle-lock.mjs';
import { observeManagedProcessStartIdentity } from './runtime-managed-supervisor.mjs';
import { observePsSnapshot } from './runtime-os-observation.mjs';

const DEAD_WAIT_MS = 2_000;

function gitPath(worktreePath, name) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', '--git-path', name], {
      cwd: worktreePath, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0
      ? resolve(path.resolve(worktreePath, stdout.trim()))
      : reject(new Error(`git rev-parse --git-path failed (${code})`))));
  });
}

/** 'dead' | 'live' | 'unproven' for the set of workers bound to one tree. */
async function ownersState(bindings) {
  let rows;
  try {
    rows = (await observePsSnapshot()).split('\n').map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields.length >= 4)
      .map(([pid, , pgid, state]) => ({ pid: Number(pid), pgid: Number(pgid), state }));
  } catch {
    return 'unproven'; // no ps (win32) or failed observation: the group cannot be shown empty
  }
  const live = rows.filter((row) => !row.state.startsWith('Z'));
  for (const binding of bindings) {
    if (!Number.isSafeInteger(binding.process_group_id)) return 'unproven';
    if (live.some((row) => row.pgid === binding.process_group_id)) return 'live';
    if (!live.some((row) => row.pid === binding.process_pid)) continue;
    let observed;
    try { observed = await observeManagedProcessStartIdentity(binding.process_pid); }
    catch { return 'unproven'; } // alive but not re-authenticated (u03 C25)
    if (observed.identity_digest === binding.process_start_identity?.identity_digest) return 'live';
  }
  return 'dead';
}

async function waitOwners(bindings) {
  const deadline = Date.now() + DEAD_WAIT_MS;
  for (;;) {
    const state = await ownersState(bindings);
    if (state !== 'live' || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function recoverIndexLock(worktreePath, bindings) {
  const lockPath = await gitPath(worktreePath, 'index.lock');
  let info;
  try { info = await lstat(lockPath); }
  catch (error) { if (error?.code === 'ENOENT') return 'absent'; throw error; }
  const owners = await waitOwners(bindings);
  if (owners !== 'dead') return `owner_${owners}`;
  try { return await removeJudgedEntry(lockPath, info); }
  catch { return 'conflict_kept'; } // put-back raced a new lock: both entries are kept
}

function unobservedPaths(current, checkpoint) {
  const recorded = new Map((checkpoint?.payload?.diff?.entries ?? [])
    .map((entry) => [entry.path, `${entry.change}:${entry.content_digest}`]));
  return current.diff.entries
    .filter((entry) => recorded.get(entry.path) !== `${entry.change}:${entry.content_digest}`)
    .map((entry) => entry.path);
}

/**
 * For every TODO whose last dispatch has no terminal (the work close/abandon ended), recover
 * its tree's stale index.lock and list paths written after the last checkpoint. Never throws.
 */
export async function recoverKeptWorktrees({ events }) {
  const lastDispatch = new Map();
  for (const event of events) {
    const todoId = event.subject?.ref;
    if (event.kind === 'executor_dispatched') lastDispatch.set(todoId, event);
    if (event.kind === 'executor_terminal') lastDispatch.delete(todoId);
  }
  const trees = new Map();
  for (const [todoId, dispatch] of lastDispatch) {
    const binding = dispatch.payload?.direct_os_observation_binding;
    if (typeof binding?.worktree_path !== 'string') continue;
    const tree = trees.get(binding.worktree_path)
      ?? { todo_ids: [], bindings: [], base_sha: binding.base_sha, checkpoints: [] };
    tree.todo_ids.push(todoId);
    tree.bindings.push(binding);
    tree.checkpoints.push(events.findLast((event) => event.kind === 'checkpoint_observed'
      && event.subject?.ref === todoId && event.sequence > dispatch.sequence));
    trees.set(binding.worktree_path, tree);
  }
  const results = [];
  for (const [worktreePath, tree] of [...trees].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const entry = { todo_ids: tree.todo_ids.sort(), worktree_path: worktreePath };
    try {
      entry.index_lock = await recoverIndexLock(worktreePath, tree.bindings);
      const current = await captureWorktreeDiff({ worktreePath, baseSha: tree.base_sha });
      // shortcut: a tree shared by several TODOs is compared with the first TODO's checkpoint only, upgrade if trees stop being 1:1 per TODO.
      entry.unobserved_paths = unobservedPaths(current, tree.checkpoints[0]);
    } catch (error) {
      entry.index_lock ??= 'unknown';
      entry.observation_error = String(error?.message ?? error).slice(0, 512);
    }
    results.push(entry);
  }
  return results;
}
