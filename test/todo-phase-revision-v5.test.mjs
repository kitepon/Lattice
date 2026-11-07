import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  explainPhaseTodoRevision, phaseTodoRevisionPlanVersion, validatePhaseTodoRevision,
} from '../src/todo-revision.mjs';
import {
  applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter,
  initializeAuthoredTodoStore, readTodoStore, todoTaskCarrySemantics,
} from '../src/todo-store.mjs';
import { todoTaskCarrySemantics as pureCarrySemantics } from '../src/todo-store-view.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const actor = { host: 'fixture', session: 'fixture', agent: 'fixture' };
const recordedAt = '2026-11-07T00:00:00.000Z';
const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
const line = (value) => `${canonicalizeTodoArtifact(value)}\n`;
const reason = (code, value) => (error) => error.code === code && error.detail.reason === value;

function initialPlan() {
  return buildTodoPlan({
    schema: 'lattice.todo_plan.v7', project_id: 'project', plan_key: 'main',
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: ['a', 'b'].map((task_id) => ({ task_id, title: task_id, lane: 'main',
      design_memo: 'NO_PLAN', narrative_ref: null, narrative_anchor: null,
      compile_binding: null, parent_task_id: null, phase_id: 'phase' })),
    phases: [{ phase_id: 'phase', title: 'Phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['gate'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [],
  });
}

function revisionFor(member, { changedTitle = false } = {}) {
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const task_migration = [
    { from_task_id: 'a', to_task_id: 'a', state_policy: 'carry_reconciled_metadata' },
    { from_task_id: 'b', to_task_id: 'b', state_policy: 'reset_pending' },
  ];
  const phase_migration = [{ from_phase_id: 'phase', to_phase_id: 'phase', state_policy: 'reset' }];
  const desired = { ...member.plan, plan_version: 'pending',
    predecessor_plan_digest: predecessor.plan_digest,
    tasks: member.plan.tasks.map((task) => ({ ...task, design_memo: 'Revised design',
      title: changedTitle && task.task_id === 'a' ? 'Changed identity semantics' : task.title })) };
  delete desired.plan_digest;
  delete desired.topology_digest;
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project', planKey: 'main',
    predecessor, desiredPlan: desired, taskMigration: task_migration, phaseMigration: phase_migration });
  const revision = { schema: 'lattice.phase_todo_revision.v5', project_id: 'project', plan_key: 'main',
    predecessor, desired_plan: buildTodoPlan(desired), task_migration, phase_migration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-v5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeAuthoredTodoStore({ repoRoot: root, writer, projectId: 'project',
    repositories: [{ repo_id: 'self', path: '.' }], plan: initialPlan(),
    genesis: { actor, recorded_at: recordedAt } });
  for (const task_id of ['a', 'b']) {
    await appendTodoEvent({ repoRoot: root, writer, planKey: 'main',
      event: { kind: 'start', task_id, actor, recorded_at: recordedAt,
        payload: { override_reason: null } } });
  }
  const store = await readTodoStore({ repoRoot: root });
  return { root, member: store.members[0] };
}

const apply = (root, revision, extra = {}) => applyPhaseTodoRevision({
  repoRoot: root, writer, revision, actor, recordedAt, ...extra,
});

test('v5 registers base keys, v7 plan and the existing backchain-free version rule', async (t) => {
  const { member } = await fixture(t);
  const revision = revisionFor(member);
  assert.equal(validatePhaseTodoRevision(revision), true);
  assert.deepEqual(explainPhaseTodoRevision(revision), { valid: true });
  assert.equal('backchain' in revision, false);
  assert.equal(todoTaskCarrySemantics, pureCarrySemantics);
  const before = canonicalizeTodoArtifact(member.plan);
  assert.equal(pureCarrySemantics(member.plan, 'absent', new Map()), null);
  assert.ok(pureCarrySemantics(member.plan, 'a', new Map(), { reconciliationMetadata: true }));
  assert.equal(canonicalizeTodoArtifact(member.plan), before);
});

test('v5 refuses foreign keys, wrong desired schema, version and artifact digest', async (t) => {
  const { member } = await fixture(t);
  const revision = revisionFor(member);
  const wrongSchema = structuredClone(revision);
  wrongSchema.desired_plan.schema = 'lattice.todo_plan.v5';
  wrongSchema.desired_plan.tasks = wrongSchema.desired_plan.tasks.map(({ design_memo, ...task }) => task);
  wrongSchema.desired_plan = buildTodoPlan(wrongSchema.desired_plan);
  const wrongVersion = structuredClone(revision);
  wrongVersion.desired_plan.plan_version = 'wrong';
  wrongVersion.desired_plan = buildTodoPlan(wrongVersion.desired_plan);
  for (const invalid of [
    { ...revision, backchain: {} }, { ...revision, source_inventory: {} },
    wrongSchema, wrongVersion, { ...revision, revision_digest: '0'.repeat(64) },
  ]) {
    assert.equal(validatePhaseTodoRevision(invalid), false);
    assert.equal(explainPhaseTodoRevision(invalid).valid, false);
  }
  assert.equal(validatePhaseTodoRevision({ ...revision, schema: 'lattice.phase_todo_revision.v4' }), false);
});

test('v5 generic apply reopens, carries and resets state while preserving predecessor bytes', async (t) => {
  const { root, member } = await fixture(t);
  const refs = ['plan_ref', 'journal_ref', 'snapshot_ref'].map((key) => member.descriptor[key]);
  const bytes = await Promise.all(refs.map((ref) => readFile(path.join(root, ref))));
  const revision = revisionFor(member);
  const result = await apply(root, revision);
  assert.equal(result.recovered, false);
  const reopened = (await readTodoStore({ repoRoot: root })).members[0];
  assert.deepEqual(reopened.revision, revision);
  assert.equal(reopened.journal.events[0].schema, 'lattice.todo_event.v4');
  assert.equal(reopened.journal.events[0].revision_digest, revision.revision_digest);
  assert.equal(reopened.tasks.find(({ task_id }) => task_id === 'a').status, 'in-progress');
  assert.equal(reopened.tasks.find(({ task_id }) => task_id === 'b').status, 'pending');
  assert.deepEqual(await Promise.all(refs.map((ref) => readFile(path.join(root, ref)))), bytes);
  const files = await readdir(path.dirname(path.join(root, reopened.descriptor.plan_ref)));
  assert.equal(files.includes('backchain.json'), false);
  assert.equal((await apply(root, revision)).recovered, true);
});

test('v5 keeps locked carry refusal and predecessor bytes on a changed task title', async (t) => {
  const { root, member } = await fixture(t);
  const manifestPath = path.join(root, '.lattice/todo/manifest.json');
  const before = await readFile(manifestPath);
  const revision = revisionFor(member, { changedTitle: true });
  assert.equal(validatePhaseTodoRevision(revision), true);
  await assert.rejects(apply(root, revision), reason('REVISION_INVALID', 'carry_semantics_changed'));
  assert.deepEqual(await readFile(manifestPath), before);
});

test('v5 marker retry uses the existing generic transaction validator and finishes publication', async (t) => {
  const { root, member } = await fixture(t);
  const revision = revisionFor(member);
  await assert.rejects(apply(root, revision, { onProtocolStage(stage) {
    if (stage === 'phase_revision_snapshot_durable') throw new Error('fixture interruption');
  } }), /fixture interruption/u);
  assert.equal((await readTodoStore({ repoRoot: root })).members[0].plan.plan_version, 'v1');
  assert.equal((await apply(root, revision)).recovered, false);
  assert.equal((await readTodoStore({ repoRoot: root })).members[0].revision.revision_digest,
    revision.revision_digest);
});

test('active reader retains typed unsupported-schema refusal for a future phase revision', async (t) => {
  const { root, member } = await fixture(t);
  const revision = revisionFor(member);
  await apply(root, revision);
  const directory = path.join(root, '.lattice/todo/plans/main', revision.desired_plan.plan_version);
  await writeFile(path.join(directory, 'revision.json'), line({ ...revision,
    schema: 'lattice.phase_todo_revision.v99' }));
  await assert.rejects(readTodoStore({ repoRoot: root }), (error) =>
    reason('UNSUPPORTED_SCHEMA', 'unsupported_revision_schema')(error)
      && error.detail.supported_schemas.includes('lattice.phase_todo_revision.v5'));
});
