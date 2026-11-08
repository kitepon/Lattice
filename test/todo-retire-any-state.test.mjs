// u12: `todo retire`はpending/blocked/doneから閉じられ（prior_status記録）、in-progressもu03 A14rで閉じられる、
// 既にretiredなら成功（unchanged:true・event追加なし）。retiredの先行は後続を妨げない（u12、a13でどの状態からでも）。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ref = (task_id) => ({ project_id: 'example', plan_key: 'work', task_id });

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture',
      LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-retire-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# proof\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'evidence'], { cwd: root });
  const input = { schema: 'lattice.plan_create_input.v5', project_id: 'example', plan_key: 'work',
    plan_version: 'v1', actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: '2026-11-08T00:00:00.000Z',
    // a→b、cは独立。
    tasks: ['a', 'b', 'c'].map((task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
      done_condition: null, narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'p' })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [{ from: ref('a'), to: ref('b') }], joins: [], phase_accept_dependencies: [],
    input_digest: '' };
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(input));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const retire = (root, task) => run(root, ['todo', 'retire', '--plan', 'work', '--task', task, '--reason', '不要']);
const state = (root, task) => success(root, ['todo', 'show', '--plan', 'work', '--task', task, '--json']).state;
async function retireEvents(root) {
  const manifest = JSON.parse(await readFile(path.join(root, '.lattice/todo/manifest.json'), 'utf8'));
  const journal = await readFile(path.join(root, manifest.members[0].journal_ref), 'utf8');
  return journal.trim().split('\n').map(JSON.parse).filter((event) => event.kind === 'retire');
}
const readyIds = (root) => success(root, ['todo', 'status', '--json']).next_ready.map(({ task_id: id }) => id);

test('retire from pending and blocked records prior_status', async (context) => {
  const root = await fixture(context);
  assert.equal(retire(root, 'c').status, 0);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  success(root, ['todo', 'block', '--plan', 'work', '--task', 'a', '--reason', '待ち']);
  const blocked = retire(root, 'a');
  assert.equal(blocked.status, 0, blocked.stderr);
  const events = await retireEvents(root);
  assert.deepEqual(events.map(({ task_id: id, payload }) => [id, payload.prior_status, payload.reason]),
    [['c', 'pending', '不要'], ['a', 'blocked', '不要']]);
  assert.equal(state(root, 'a').status, 'retired');
});

test('retire from in-progress succeeds, records prior_status and closes the start binding (u03 A14r)', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'c']);
  const retired = retire(root, 'c');
  assert.equal(retired.status, 0, retired.stderr);
  const result = JSON.parse(retired.stdout);
  assert.equal(result.kind, 'retire');
  assert.equal(result.status, 'retired');
  assert.equal(state(root, 'c').status, 'retired');
  assert.deepEqual((await retireEvents(root)).map(({ task_id: id, payload }) => [id, payload.prior_status, payload.reason]),
    [['c', 'in-progress', '不要']]);
  // 再度のretireはunchangedで、eventを足さない。
  const again = JSON.parse(retire(root, 'c').stdout);
  assert.equal(again.unchanged, true);
  assert.equal((await retireEvents(root)).length, 1);
});

test('retire from done or pending keeps the successor startable and finishable (u12, a13)', async (context) => {
  const doneRoot = await fixture(context);
  success(doneRoot, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  success(doneRoot, ['todo', 'done', '--plan', 'work', '--task', 'a', '--evidence', 'evidence.md']);
  assert.equal(retire(doneRoot, 'a').status, 0);
  assert.equal((await retireEvents(doneRoot))[0].payload.prior_status, 'done');
  assert.equal(state(doneRoot, 'a').status, 'retired');
  assert.ok(readyIds(doneRoot).includes('b'));
  success(doneRoot, ['todo', 'start', '--plan', 'work', '--task', 'b']);
  success(doneRoot, ['todo', 'done', '--plan', 'work', '--task', 'b', '--evidence', 'evidence.md']);
  assert.equal(state(doneRoot, 'b').status, 'done');

  // a13: retire is the user deleting the task, so its edge counts as gone in readiness and Store replay.
  const pendingRoot = await fixture(context);
  assert.equal(retire(pendingRoot, 'a').status, 0);
  assert.ok(readyIds(pendingRoot).includes('b'));
  success(pendingRoot, ['todo', 'start', '--plan', 'work', '--task', 'b']);
  success(pendingRoot, ['todo', 'done', '--plan', 'work', '--task', 'b', '--evidence', 'evidence.md']);
  assert.equal(state(pendingRoot, 'b').status, 'done');
  success(pendingRoot, ['todo', 'verify', '--json']);
});

test('retiring an already retired task succeeds without a new event', async (context) => {
  const root = await fixture(context);
  const first = JSON.parse(retire(root, 'c').stdout);
  assert.equal(first.unchanged, undefined);
  const before = await retireEvents(root);
  const again = retire(root, 'c');
  assert.equal(again.status, 0, again.stderr);
  const result = JSON.parse(again.stdout);
  assert.equal(result.schema, 'lattice.todo_mutation_result.v2');
  assert.equal(result.unchanged, true);
  assert.equal(result.status, 'retired');
  assert.equal(result.event_digest, before[0].event_digest);
  assert.equal((await retireEvents(root)).length, 1);
});

test('a retire refused for a stale prior_status is reported as a retryable write conflict', async () => {
  const { TodoStoreError } = await import('../src/todo-store.mjs');
  const { retireStateConflict } = await import('../src/todo-readiness.mjs');
  const ids = { planKey: 'work', taskId: 'c', priorStatus: 'blocked' };
  for (const reason of ['retire_prior_status_mismatch', 'invalid_retire_transition']) {
    const mapped = retireStateConflict(new TodoStoreError('STORE_INCONSISTENT', reason), ids);
    assert.equal(mapped.code, 'STORE_WRITE_CONFLICT');
    assert.equal(mapped.detail.reason, 'retire_state_changed');
    assert.deepEqual(mapped.detail.expected, { status: 'blocked' });
  }
  const other = new TodoStoreError('STORE_INCONSISTENT', 'unknown_task');
  assert.equal(retireStateConflict(other, ids), other);
});
