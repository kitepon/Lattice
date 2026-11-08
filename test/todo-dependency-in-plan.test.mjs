import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { completeCreateInput } from '../src/todo-authoring-input.mjs';
import { desiredFromPlan } from '../src/plan-revise.mjs';
import { validatePlanCreateInput } from '../src/project-cli.mjs';
import { createTodoStoreWriter, readTodoStore } from '../src/todo-store.mjs';
import { projectTodoCrossPlanDependencies } from '../src/todo-store-view.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ACTOR = { host: 'fixture', session: 'fixture', agent: 'fixture' };
const SCHEMAS = ['lattice.plan_create_input.v4', 'lattice.plan_create_input.v5'];

function createInput(schema) {
  return { schema, project_id: 'example', plan_key: 'work', plan_version: 'v1', actor: ACTOR,
    recorded_at: new Date().toISOString(),
    tasks: ['a', 'b', 'c'].map((task_id) => ({ task_id, title: task_id, lane: 'main',
      design_memo: 'NO_PLAN', narrative_ref: null, narrative_anchor: null, parent_task_id: null,
      compile_binding: null, phase_id: 'p',
      ...(schema.endsWith('v5') ? { done_condition: null } : {}) })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
}
function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_RUNTIME_ERROR_REPORTING: '0', LATTICE_TODO_ACTOR_HOST: 'fixture',
      LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
async function fixture(context, schema = SCHEMAS[1]) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-dependency-in-plan-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(createInput(schema)));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const edgeArgs = (from, to) => ['--from-plan', 'work', '--from-task', from, '--to-plan', 'work', '--to-task', to];
const readWork = async (root) => (await readTodoStore({ repoRoot: root }))
  .members.find(({ plan }) => plan.plan_key === 'work');
const bodyEdges = (member) => member.plan.hard_dependencies.map(({ from, to }) => `${from.task_id}>${to.task_id}`);

for (const schema of SCHEMAS) {
  test(`desiredFromPlan(${schema}) passes completeCreateInput and the create validator`, async (context) => {
    const root = await fixture(context, schema);
    const member = await readWork(root);
    const desired = desiredFromPlan(member.plan, { env: { LATTICE_TODO_ACTOR_HOST: 'fixture',
      LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
    assert.equal(desired.schema, schema);
    validatePlanCreateInput(completeCreateInput(desired, { env: process.env, now: new Date() }));
  });
}

test('same-plan connect revises the plan body, carries in-progress work and records the reason', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'c']);
  const before = await readWork(root);
  const result = success(root, ['todo', 'dependency', 'connect', ...edgeArgs('a', 'c'), '--reason', '入力待ち']);
  assert.equal(result.schema, 'lattice.todo_dependency_revision_result.v1');
  assert.deepEqual(Object.keys(result), ['schema', 'project_id', 'plan_key', 'operation', 'from', 'to',
    'reason', 'actor', 'plan_version', 'revision_digest', 'rebound_task_ids', 'result_digest']);
  assert.equal(result.operation, 'connect');
  assert.deepEqual(result.rebound_task_ids, ['c']);
  const after = await readWork(root);
  assert.notEqual(after.plan.plan_version, before.plan.plan_version);
  assert.equal(result.plan_version, after.plan.plan_version);
  assert.deepEqual(bodyEdges(after), ['a>c']);
  assert.equal(after.tasks.find(({ task_id: id }) => id === 'c').status, 'in-progress');
  assert.equal(projectTodoCrossPlanDependencies((await readTodoStore({ repoRoot: root })).members).length, 0);
  const notes = JSON.stringify(success(root, ['todo', 'note', 'list', '--plan', 'work', '--json']));
  assert.match(notes, /dependency connect a→c: 入力待ち/u);
});

test('same-plan connect keeps the typed refusals for duplicate, self, cycle and unknown task', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'dependency', 'connect', ...edgeArgs('a', 'b'), '--reason', 'r']);
  const refusal = (args) => run(root, ['todo', 'dependency', 'connect', ...args, '--reason', 'r']);
  const stderrOf = (r) => { assert.notEqual(r.status, 0); return r.stderr + r.stdout; };
  assert.match(stderrOf(refusal(edgeArgs('a', 'b'))), /dependency_already_in_plan/u);
  assert.match(stderrOf(refusal(edgeArgs('a', 'a'))), /dependency_self_reference/u);
  assert.match(stderrOf(refusal(edgeArgs('x', 'b'))), /dependency_task_not_found/u);
  const before = (await readWork(root)).plan.plan_version;
  stderrOf(refusal(edgeArgs('b', 'a')));
  assert.equal((await readWork(root)).plan.plan_version, before, 'a cycle publishes nothing');
});

test('same-plan connect refuses a finished target', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'proof.md'), '# proof\n');
  execFileSync('git', ['add', 'proof.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '--quiet', '-m', 'p'], { cwd: root });
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'b']);
  success(root, ['todo', 'done', '--plan', 'work', '--task', 'b', '--evidence', 'proof.md']);
  const refused = run(root, ['todo', 'dependency', 'connect', ...edgeArgs('a', 'b'), '--reason', 'r']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /dependency_target_terminal/u);
});

test('same-plan disconnect removes a body edge by revision', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'dependency', 'connect', ...edgeArgs('a', 'b'), '--reason', 'r']);
  const result = success(root, ['todo', 'dependency', 'disconnect', ...edgeArgs('a', 'b'), '--reason', '誤った辺']);
  assert.equal(result.schema, 'lattice.todo_dependency_revision_result.v1');
  assert.equal(result.operation, 'disconnect');
  assert.deepEqual(bodyEdges(await readWork(root)), []);
  assert.match(JSON.stringify(success(root, ['todo', 'note', 'list', '--plan', 'work', '--json'])),
    /dependency disconnect a→b: 誤った辺/u);
});

test('same-plan disconnect still tombstones a ledger edge and refuses a missing edge with next_action', async (context) => {
  const root = await fixture(context);
  const member = await readWork(root);
  const ref = (taskId) => ({ project_id: 'example', plan_key: 'work', task_id: taskId,
    expected_topology_digest: member.plan.topology_digest });
  await appendTodoEvent({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: 'work', event: { kind: 'cross_plan_dependency', actor: ACTOR,
      recorded_at: new Date().toISOString(), payload: { from: ref('a'), to: ref('b'), reason: '旧台帳' } } });
  // 台帳に生きている同じ辺を、connectは本体へ二重に足さない。
  const duplicate = run(root, ['todo', 'dependency', 'connect', ...edgeArgs('a', 'b'), '--reason', '二重']);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr + duplicate.stdout, /cross_plan_dependency_duplicate/u);
  assert.deepEqual(bodyEdges(await readWork(root)), []);
  const removed = success(root, ['todo', 'dependency', 'disconnect', ...edgeArgs('a', 'b'), '--reason', '除去']);
  assert.equal(removed.schema, 'lattice.todo_dependency_disconnect_result.v1');
  const missing = run(root, ['todo', 'dependency', 'disconnect', ...edgeArgs('a', 'b'), '--reason', '再除去']);
  assert.notEqual(missing.status, 0);
  const text = missing.stderr + missing.stdout;
  assert.match(text, /cross_plan_dependency_not_found/u);
  assert.match(text, /lattice plan show work --json/u);
});

test('same-plan connect works while another plan holds a live connection bound to this plan', async (context) => {
  const root = await fixture(context);
  const other = createInput(SCHEMAS[1]);
  other.plan_key = 'other';
  await writeFile(path.join(root, 'other.json'), JSON.stringify(other));
  success(root, ['plan', 'create', '--input', 'other.json']);
  success(root, ['todo', 'dependency', 'connect', '--from-plan', 'work', '--from-task', 'a',
    '--to-plan', 'other', '--to-task', 'b', '--reason', '跨ぎ']);
  const result = success(root, ['todo', 'dependency', 'connect', ...edgeArgs('b', 'c'), '--reason', '同一plan']);
  assert.equal(result.schema, 'lattice.todo_dependency_revision_result.v1');
  const store = await readTodoStore({ repoRoot: root });
  assert.equal(projectTodoCrossPlanDependencies(store.members).length, 1, 'cross-plan edge stays live');
  assert.deepEqual(bodyEdges(store.members.find(({ plan }) => plan.plan_key === 'work')), ['b>c']);
});
