import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  digestTodoArtifact, explainTodoPlan, todoSelfDigest, validateTodoPlan,
} from '../src/todo-contracts.mjs';
import { phaseTodoRevisionPlanVersion, validatePhaseTodoRevision } from '../src/todo-revision.mjs';
import {
  applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter,
  initializeAuthoredTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const actor = { host: 'fixture', session: 'fixture', agent: 'fixture' };
const recordedAt = '2026-11-08T00:00:00.000Z';
const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
const reason = (code, value) => (error) => error.code === code && error.detail.reason === value;
const BINDING = { boundary_manifest_digest: 'a'.repeat(64), compiled_plan_digest: 'b'.repeat(64),
  topology_digest: 'c'.repeat(64), base_sha: 'd'.repeat(40) };

const task = (task_id, phase_id, extra = {}) => ({ task_id, title: task_id, lane: 'main',
  design_memo: 'NO_PLAN', narrative_ref: null, narrative_anchor: null,
  compile_binding: null, parent_task_id: null, phase_id, ...extra });
const phases = [
  { phase_id: 'p1', title: 'P1', gate_policy: 'heavy', predecessor_phase_ids: [], required_evidence_slots: ['gate'] },
  { phase_id: 'p2', title: 'P2', gate_policy: 'heavy', predecessor_phase_ids: ['p1'], required_evidence_slots: ['gate'] },
];
const planInput = (schema, tasks) => ({ schema, project_id: 'project', plan_key: 'main',
  plan_version: 'v1', predecessor_plan_digest: null, tasks, phases,
  hard_dependencies: [], joins: [], phase_accept_dependencies: [] });
const v7Tasks = () => [task('a', 'p1', { compile_binding: BINDING }), task('b', 'p1'), task('c', 'p2')];
const withDone = (tasks, done_condition = null) => tasks.map((entry) => ({ ...entry, done_condition }));

async function fixture(t, { schema = 'lattice.todo_plan.v7' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-store-u12-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const tasks = schema === 'lattice.todo_plan.v8' ? withDone(v7Tasks()) : v7Tasks();
  await initializeAuthoredTodoStore({ repoRoot: root, writer, projectId: 'project',
    repositories: [{ repo_id: 'self', path: '.' }], plan: buildTodoPlan(planInput(schema, tasks)),
    genesis: { actor, recorded_at: recordedAt } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main',
    event: { kind: 'start', task_id: 'a', actor, recorded_at: recordedAt,
      payload: { override_reason: null } } });
  return { root, member: (await readTodoStore({ repoRoot: root })).members[0] };
}

const carry = (policy, ids = ['a', 'b', 'c']) => ids.map((id) => ({ from_task_id: id, to_task_id: id,
  state_policy: policy }));
const phaseCarry = [
  { from_phase_id: 'p1', to_phase_id: 'p1', state_policy: 'carry' },
  { from_phase_id: 'p2', to_phase_id: 'p2', state_policy: 'carry' },
];

/** Builds a phase_todo_revision.v5 from the member's plan; `edit` mutates the desired plan input. */
function revisionFor(member, { edit = () => {}, schema = member.plan.schema, tasks = carry('carry_reconciled_metadata'),
  phase_migration = phaseCarry } = {}) {
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest, plan_version: member.plan.plan_version };
  const desired = structuredClone(member.plan);
  delete desired.topology_digest; delete desired.plan_digest;
  desired.schema = schema;
  desired.predecessor_plan_digest = predecessor.plan_digest;
  if (schema === 'lattice.todo_plan.v8') desired.tasks = desired.tasks.map((entry) => ({ done_condition: null, ...entry }));
  else desired.tasks = desired.tasks.map(({ done_condition, ...entry }) => entry);
  edit(desired);
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project', planKey: 'main',
    predecessor, desiredPlan: desired, taskMigration: tasks, phaseMigration: phase_migration });
  const revision = { schema: 'lattice.phase_todo_revision.v5', project_id: 'project', plan_key: 'main',
    predecessor, desired_plan: buildTodoPlan(desired), task_migration: tasks, phase_migration,
    revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

const apply = (root, revision) => applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor, recordedAt });
const stateOf = (store, id) => store.members[0].tasks.find(({ task_id }) => task_id === id);

test('todo_plan.v8 accepts null/text done_condition and explains a bad one by task pointer', () => {
  for (const done_condition of [null, 'テストがgreenで、差分がdocsと一致する。']) {
    const plan = buildTodoPlan(planInput('lattice.todo_plan.v8', withDone(v7Tasks(), done_condition)));
    assert.equal(validateTodoPlan(plan), true);
    assert.equal(explainTodoPlan(plan), null);
  }
  const plan = buildTodoPlan(planInput('lattice.todo_plan.v8', withDone(v7Tasks())));
  for (const bad of [undefined, '', '   ', 5]) {
    const broken = structuredClone(plan);
    if (bad === undefined) delete broken.tasks[1].done_condition; else broken.tasks[1].done_condition = bad;
    assert.equal(validateTodoPlan(broken), false);
    assert.deepEqual(explainTodoPlan(broken), { reason: 'task_shape_invalid', path: '/tasks/1' });
  }
  const v7WithDone = structuredClone(planInput('lattice.todo_plan.v7', withDone(v7Tasks())));
  assert.throws(() => buildTodoPlan(v7WithDone));
});

test('plan revision v7 to v8 is accepted and v8 to v7 refuses done_condition_schema_downgrade', async (t) => {
  const { root, member } = await fixture(t);
  const up = revisionFor(member, { schema: 'lattice.todo_plan.v8' });
  assert.equal(validatePhaseTodoRevision(up), true);
  await apply(root, up);
  const upgraded = (await readTodoStore({ repoRoot: root })).members[0];
  assert.equal(upgraded.plan.schema, 'lattice.todo_plan.v8');
  assert.equal(upgraded.tasks.find(({ task_id }) => task_id === 'a').status, 'in-progress');
  const down = revisionFor(upgraded, { schema: 'lattice.todo_plan.v7' });
  assert.equal(validatePhaseTodoRevision(down), true);
  await assert.rejects(apply(root, down), reason('REVISION_INVALID', 'done_condition_schema_downgrade'));
  assert.equal((await readTodoStore({ repoRoot: root })).members[0].plan.plan_version,
    upgraded.plan.plan_version);
});

test('v4 revision validator accepts a v8 desired plan', async (t) => {
  const { member } = await fixture(t);
  const v5 = revisionFor(member, { schema: 'lattice.todo_plan.v8' });
  const backchainTasks = v5.desired_plan.tasks.map(({ task_id }) => ({ task_id }));
  const backchain = { schema: 'lattice.plan_backchain.v1', authoring_ref: 'docs/plan.md',
    project_id: 'project', plan_key: 'main', plan_version: '', goal: 'goal', features: [],
    tasks: backchainTasks, chain_digest: '' };
  const featureGraphDigest = digestTodoArtifact({ goal: backchain.goal, features: backchain.features,
    tasks: backchain.tasks });
  const desired = structuredClone(v5.desired_plan);
  delete desired.topology_digest; delete desired.plan_digest;
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project', planKey: 'main',
    predecessor: v5.predecessor, desiredPlan: desired, taskMigration: v5.task_migration,
    phaseMigration: v5.phase_migration, featureGraphDigest });
  backchain.plan_version = desired.plan_version;
  backchain.chain_digest = todoSelfDigest(backchain, 'chain_digest');
  const revision = { ...v5, schema: 'lattice.phase_todo_revision.v4', desired_plan: buildTodoPlan(desired),
    backchain, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(revision), true);
});

test('v5 light carry accepts title, edge and phase changes and keeps carried state', async (t) => {
  const { root, member } = await fixture(t);
  const revision = revisionFor(member, { edit(desired) {
    desired.tasks[0].title = 'renamed';
    desired.tasks[1].phase_id = 'p2';
    desired.hard_dependencies = [{ from: { project_id: 'project', plan_key: 'main', task_id: 'a' },
      to: { project_id: 'project', plan_key: 'main', task_id: 'b' } }];
  } });
  await apply(root, revision);
  const store = await readTodoStore({ repoRoot: root });
  assert.equal(stateOf(store, 'a').status, 'in-progress');
  assert.equal(store.members[0].plan.tasks[0].title, 'renamed');
});

test('v5 light carry refuses a compile_binding change; carry policy still refuses a title change', async (t) => {
  const { root, member } = await fixture(t);
  const rebound = revisionFor(member, { edit(desired) {
    desired.tasks[0].compile_binding = { ...BINDING, base_sha: 'e'.repeat(40) };
  } });
  await assert.rejects(apply(root, rebound), reason('REVISION_INVALID', 'carry_semantics_changed'));
  const unbound = revisionFor(member, { edit(desired) { desired.tasks[0].compile_binding = null; } });
  await assert.rejects(apply(root, unbound), reason('REVISION_INVALID', 'carry_semantics_changed'));
  const strict = revisionFor(member, { tasks: carry('carry'), edit(desired) { desired.tasks[1].title = 'renamed'; } });
  await assert.rejects(apply(root, strict), reason('REVISION_INVALID', 'carry_semantics_changed'));
  assert.equal((await readTodoStore({ repoRoot: root })).members[0].plan.plan_version, 'v1');
});

test('v5 carried phase may change membership (older revisions keep phase_carry_semantics_changed in todo-store.test.mjs)', async (t) => {
  const { root, member } = await fixture(t);
  const revision = revisionFor(member, { edit(desired) { desired.tasks[1].phase_id = 'p2'; } });
  await apply(root, revision);
  const store = await readTodoStore({ repoRoot: root });
  assert.deepEqual(store.members[0].plan.tasks.map(({ phase_id }) => phase_id), ['p1', 'p2', 'p2']);
  assert.equal(store.members[0].snapshot.phases.length, 2);
});

test('one finished predicate: done, or retired from done including historical_import with unknown time', async () => {
  const { isFinishedTodoTaskState } = await import('../src/todo-store.mjs');
  const retired = { status: 'retired', done_at: null, imported: false };
  assert.equal(isFinishedTodoTaskState({ status: 'done', done_at: null, imported: true }), true);
  assert.equal(isFinishedTodoTaskState({ ...retired, done_at: '2026-11-08T00:00:00.000Z' }), true);
  assert.equal(isFinishedTodoTaskState({ ...retired, imported: true }), true);
  assert.equal(isFinishedTodoTaskState(retired), false);
  assert.equal(isFinishedTodoTaskState({ status: 'in-progress', done_at: null, imported: false }), false);
});
