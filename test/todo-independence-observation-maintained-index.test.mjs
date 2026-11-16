import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { portableSensorOutcome } from '../src/sensor-adapter.mjs';
import { collectTodoIndependenceAuthoritativeObservation } from '../src/todo-independence-authoritative-observation.mjs';

const witnessSet = (target) => ({
  sensor_query_set: { queries: [{ id: 'q1', operation: 'query', target }] },
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const worktrees = (cwd) => git(cwd, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
const statusOf = (observation) => observation.sensor_evidence.outcomes[0].status;

async function fixture(t) {
  const repo = await mkdtemp(path.join(tmpdir(), 'lattice-observe-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  await writeFile(path.join(repo, 'a.mjs'), 'export function alpha() { return 1; }\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'init');
  return repo;
}

test('a2: a clean tree is observed through its maintained index, no worktree, and follows HEAD', async (t) => {
  const repo = await fixture(t);
  const first = await collectTodoIndependenceAuthoritativeObservation({ repoRoot: repo, witnessSet: witnessSet('alpha') });
  assert.equal(first.head_sha, git(repo, 'rev-parse', 'HEAD'));
  assert.notEqual(statusOf(first), 'symbol_absent');
  assert.ok(existsSync(path.join(repo, '.lattice/sensor/sensor.db')), 'the index is maintained in the tree itself');
  assert.equal(worktrees(repo).length, 1, 'no detached worktree was added');

  const again = await collectTodoIndependenceAuthoritativeObservation({ repoRoot: repo, witnessSet: witnessSet('alpha') });
  assert.deepEqual(portableSensorOutcome(again.sensor_evidence.outcomes[0].raw), portableSensorOutcome(first.sensor_evidence.outcomes[0].raw));

  await writeFile(path.join(repo, 'a.mjs'), 'export function beta() { return 1; }\n');
  git(repo, 'commit', '--quiet', '-am', 'rename');
  const renamed = await collectTodoIndependenceAuthoritativeObservation({ repoRoot: repo, witnessSet: witnessSet('beta') });
  assert.notEqual(statusOf(renamed), 'symbol_absent', 'the sync step brings the index to the new HEAD');
});

test('a2: a dirty tree is never observed; it falls back to HEAD in an isolated worktree and removes it', async (t) => {
  const repo = await fixture(t);
  await writeFile(path.join(repo, 'a.mjs'), 'export function gamma() { return 1; }\n');
  const dirty = await collectTodoIndependenceAuthoritativeObservation({ repoRoot: repo, witnessSet: witnessSet('gamma') });
  assert.equal(statusOf(dirty), 'symbol_absent', 'uncommitted edits are not observed');
  const head = await collectTodoIndependenceAuthoritativeObservation({ repoRoot: repo, witnessSet: witnessSet('alpha') });
  assert.notEqual(statusOf(head), 'symbol_absent', 'HEAD content is');
  assert.equal(worktrees(repo).length, 1, 'the isolated worktree is removed');
  assert.ok(!existsSync(path.join(repo, '.lattice/sensor/sensor.db')), 'the dirty path leaves no index in the shared tree');
});
