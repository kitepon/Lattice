// a32: after choosing the witness route a seat can find every input shape from the CLI, and a reopen
// of a task that is not done names its state instead of a store inconsistency.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { todoIndependenceGuidance } from '../src/todo-independence-guidance.mjs';
import { validateWitnessDraft } from '../src/witness-scaffold.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ref = (task_id) => ({ project_id: 'example', plan_key: 'work', task_id });

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function refused(root, args, status = 1) {
  const result = run(root, args);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stderr);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a32-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const input = { schema: 'lattice.plan_create_input.v5', project_id: 'example', plan_key: 'work',
    plan_version: 'v1', actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: '2026-11-08T00:00:00.000Z',
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
const task = (name) => ['--plan', 'work', '--task', name];
const edge = (from, to) => ['--from-plan', 'work', '--from-task', from, '--to-plan', 'work', '--to-task', to];

test('the witness route shows its input shapes and a starting draft', async (context) => {
  const root = await fixture(context);
  assert.equal(success(root, ['todo', 'independence', 'witness', 'scaffold', '--schema', '--json']).title,
    'lattice.todo_witness_draft.v2');
  assert.equal(success(root, ['todo', 'independence', 'compile', '--schema', '--json']).title,
    'lattice.todo_witness_set.v5');
  success(root, ['todo', 'start', ...task('a')]);
  success(root, ['todo', 'done', ...task('a')]);
  const template = success(root, ['todo', 'independence', 'witness', 'scaffold', '--template', '--plan', 'work']);
  assert.deepEqual(template, { schema: 'lattice.todo_witness_draft.v2', project_id: 'example', plan_key: 'work',
    capacity: { executors: 1 }, tasks: { b: { owns: [], reads: [], writes: [] }, c: { owns: [], reads: [], writes: [] } } });
  assert.equal(validateWitnessDraft(template), true);
  assert.equal(todoIndependenceGuidance('independence_unrecorded', { planKey: 'work' }).next_action,
    'lattice todo independence witness scaffold --template --plan work');
});

test('witness refusals name the missing keys and point at the template and schema', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'wit.json'), '{}\n');
  const draft = refused(root, ['todo', 'independence', 'witness', 'scaffold', '--plan', 'work', '--input', 'wit.json']);
  assert.equal(draft.code, 'WITNESS_DRAFT_INVALID');
  assert.deepEqual([draft.detail.reason, draft.detail.pointer], ['missing_top_level_keys', '/']);
  assert.deepEqual(draft.detail.missing_keys, ['schema', 'project_id', 'plan_key', 'capacity', 'tasks']);
  assert.match(draft.detail.next_action, /scaffold --template --plan work.*scaffold --schema --json/u);
  assert.doesNotMatch(draft.detail.next_action, /todo independence --schema/u);

  const set = refused(root, ['todo', 'independence', 'compile', '--plan', 'work', '--input', 'wit.json']);
  assert.equal(set.code, 'INVALID_TODO_WITNESS_SET');
  assert.equal(set.detail.pointer, '/');
  assert.deepEqual(set.detail.missing_keys, ['schema', 'project_id', 'plan_key', 'capacity', 'sensor_query_set',
    'manual_witness', 'witness_set_digest']);
  assert.match(set.detail.next_action, /scaffold --template --plan work/u);

  const migrate = refused(root, ['todo', 'independence', 'witness', 'migrate', '--plan', 'work']);
  assert.match(migrate.detail.next_action, /scaffold --template --plan work/u);
  const mode = refused(root, ['todo', 'independence', 'mode', '--plan', 'work', '--set', 'witness'], 2);
  assert.deepEqual([mode.detail.pointer, mode.detail.rule], ['--reason', 'flag_missing']);
  assert.match(mode.detail.next_action, /lattice todo independence mode --plan work --set witness --reason <text>/u);
});

test('reopen of a task that is not done names its state and the step that fits', async (context) => {
  const root = await fixture(context);
  const pending = refused(root, ['todo', 'reopen', ...task('a'), '--reason', 'r']);
  assert.deepEqual([pending.code, pending.detail.reason, pending.detail.status],
    ['TODO_TRANSITION_REFUSED', 'invalid_reopen_transition', 'pending']);
  assert.match(pending.detail.next_action, /Only a done task can be reopened; work\/a is pending\. .*lattice todo start --plan work --task a/u);
  success(root, ['todo', 'start', ...task('a')]);
  assert.match(refused(root, ['todo', 'reopen', ...task('a'), '--reason', 'r']).detail.next_action,
    /is in-progress\. .*lattice todo done --plan work --task a/u);
  success(root, ['todo', 'retire', ...task('c'), '--reason', 'gone']);
  assert.match(refused(root, ['todo', 'reopen', ...task('c'), '--reason', 'r']).detail.next_action,
    /is retired\. Retire is permanent/u);
});
