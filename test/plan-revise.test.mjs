import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compilePlanRevision } from '../src/plan-revise.mjs';
import { planSeed } from '../src/plan-backchain.mjs';
import { buildTodoPlan } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const task = (task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
  phase_id: 'p', parent_task_id: null, narrative_ref: null, narrative_anchor: null, compile_binding: null });
const continuity = (task_id, policy = 'carry') => ({ task_id, policy, reason: '明示した作業状態を引き継ぐ' });
function desired(ids = ['a', 'b', 'c']) {
  return { schema: 'lattice.plan_create_input.v4', project_id: 'project', plan_key: 'plan',
    plan_version: 'authored-placeholder', actor: { host: 'h', session: 's', agent: 'a' },
    recorded_at: '2026-11-07T00:00:00.000Z', tasks: ids.map(task),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
}
function member() {
  return { plan: buildTodoPlan({ ...planSeed(desired(), null), plan_version: 'v1' }),
    tasks: ['a', 'b', 'c'].map((task_id) => ({ task_id, status: 'pending' })),
    journal: { events: [{ schema: 'lattice.todo_event.v3', event_digest: 'a'.repeat(64) }] } };
}
function intent(ids = ['a', 'b', 'c']) {
  return { schema: 'lattice.plan_revise_input.v1', desired: desired(ids),
    continuity: ['a', 'b', 'c'].map((id) => continuity(id)) };
}

test('light revision machine-fills predecessor and version from full desired state and explicit policies', () => {
  const previous = member();
  const input = intent(['a', 'b', 'd']);
  input.continuity = [continuity('c', 'retire'), continuity('a'), continuity('b', 'reset')];
  const before = structuredClone({ previous, input });
  const revision = compilePlanRevision({ member: previous, input });
  assert.equal(revision.schema, 'lattice.phase_todo_revision.v5');
  assert.equal(Object.hasOwn(revision, 'backchain'), false);
  assert.deepEqual(revision.predecessor, { plan_digest: previous.plan.plan_digest,
    journal_head_digest: 'a'.repeat(64), plan_version: 'v1' });
  assert.match(revision.desired_plan.plan_version, /^rev-[0-9a-f]{24}$/u);
  assert.deepEqual(revision.task_migration, [
    { from_task_id: 'a', to_task_id: 'a', state_policy: 'carry_reconciled_metadata' },
    { from_task_id: 'b', to_task_id: 'b', state_policy: 'reset_pending' },
    { from_task_id: 'c', to_task_id: 'removed', state_policy: 'removed' },
  ]);
  assert.deepEqual(revision.phase_migration, [{ from_phase_id: 'p', to_phase_id: 'p', state_policy: 'reset' }]);
  const repeated = structuredClone(input);
  repeated.desired.recorded_at = '2026-11-07T01:00:00.000Z';
  repeated.desired.plan_version = 'another-placeholder';
  assert.deepEqual(compilePlanRevision({ member: previous, input: repeated }), revision);
  assert.deepEqual({ previous, input }, before);
});

test('light revision refuses missing/duplicate/unknown policies and retire/desired mismatch before apply', () => {
  for (const mutate of [
    (input) => input.continuity.pop(),
    (input) => { input.continuity[2] = continuity('a'); },
    (input) => { input.continuity[2] = continuity('unknown'); },
    (input) => { input.continuity[2].reason = ''; },
    (input) => { input.continuity[2].policy = 'retire'; },
  ]) {
    const input = intent();
    mutate(input);
    assert.throws(() => compilePlanRevision({ member: member(), input }),
      (error) => error.code === 'INPUT_INVALID' && error.detail.pointer.startsWith('/continuity'));
  }
});

test('light revision preserves create field diagnostics in the desired namespace', () => {
  const input = intent();
  input.desired.actor.agent = '';
  assert.throws(() => compilePlanRevision({ member: member(), input }),
    (error) => error.code === 'INPUT_INVALID' && error.detail.pointer === '/desired/actor/agent');
});

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0', NO_COLOR: '1' } });
}

test('plan revise --schema distributes the light authoring contract', () => {
  const execution = run(path.dirname(CLI), ['plan', 'revise', '--schema', '--json']);
  assert.equal(execution.status, 0, execution.stderr);
  const schema = JSON.parse(execution.stdout);
  assert.equal(schema.title, 'lattice.plan_revise_input.v1');
  assert.deepEqual(schema.properties.continuity.items.properties.policy.enum, ['carry', 'reset', 'retire']);
});

test('an unchanged all-carry CLI request retains its version and journal across repeated calls', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-revise-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(desired()));
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
  const initial = JSON.parse(created.stdout);
  const journal = await readFile(path.join(root, initial.journal_ref), 'utf8');
  await writeFile(path.join(root, 'revise.json'), JSON.stringify(intent()));
  for (let index = 0; index < 2; index += 1) {
    const execution = run(root, ['plan', 'revise', '--input', 'revise.json', '--json']);
    assert.equal(execution.status, 0, execution.stderr);
    const result = JSON.parse(execution.stdout);
    assert.equal(result.schema, 'lattice.plan_revise_unchanged.v1');
    assert.equal(result.plan_version, 'authored-placeholder');
    assert.equal(result.revision, null);
    assert.equal(await readFile(path.join(root, initial.journal_ref), 'utf8'), journal);
  }
});
