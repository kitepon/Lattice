// ADR 0205 b2: plan v9 `function_split` mark and the split record (Store). docs/architecture/dfd-store-split.md
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { explainTodoPlan, todoSelfDigest, validateTodoPlan, validateTodoSplitRecord } from '../src/todo-contracts.mjs';
import { phaseTodoRevisionPlanVersion, validatePhaseTodoRevision } from '../src/todo-revision.mjs';
import { readTodoSplit, recordTodoSplit } from '../src/todo-split-store.mjs';
import {
  NEWEST_KNOWN_TODO_SCHEMA, applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter,
  initializeAuthoredTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const actor = { host: 'fixture', session: 'fixture', agent: 'fixture' };
const recordedAt = '2026-11-16T00:00:00.000Z';
const authoring = createTodoStoreWriter({ caller: 'g5-authoring' });
const writer = createTodoStoreWriter({ caller: 'todo-splits' });
const reason = (code, value) => (error) => error.code === code && error.detail.reason === value;
const SHA = 'a'.repeat(40);

const task = (task_id, extra = {}) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN', narrative_ref: null,
  narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'p1', done_condition: null, ...extra });
const phases = [{ phase_id: 'p1', title: 'P1', gate_policy: 'heavy', predecessor_phase_ids: [], required_evidence_slots: ['gate'] }];
const planInput = (schema, tasks, extra = {}) => ({ schema, project_id: 'project', plan_key: 'main', plan_version: 'v1',
  predecessor_plan_digest: null, tasks, phases, hard_dependencies: [], joins: [], phase_accept_dependencies: [], ...extra });
const mark = (members = ['a', 'b']) => ({ path: 'src/x.mjs', symbol: 'f', start_line: 10, end_line: 20, members });
const ref = (id) => ({ project_id: 'project', plan_key: 'main', task_id: id });
const v9Tasks = (split = mark()) => [task('a', { function_split: null }), task('b', { function_split: null }),
  task('s', { function_split: split })];

/** A v8 store with `a` in progress, then the revision that promotes it to v9 and adds the split task `s` (S before a and b). */
async function fixture(t, { promote = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-split-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeAuthoredTodoStore({ repoRoot: root, writer: authoring, projectId: 'project',
    repositories: [{ repo_id: 'self', path: '.' }],
    plan: buildTodoPlan(planInput('lattice.todo_plan.v8', [task('a'), task('b')])),
    genesis: { actor, recorded_at: recordedAt } });
  await appendTodoEvent({ repoRoot: root, writer: authoring, planKey: 'main',
    event: { kind: 'start', task_id: 'a', actor, recorded_at: recordedAt, payload: { override_reason: null } } });
  if (promote) await apply(root, promotion((await readTodoStore({ repoRoot: root })).members[0]));
  return root;
}

function promotion(member, { tasks = v9Tasks(), schema = 'lattice.todo_plan.v9' } = {}) {
  const predecessor = { plan_digest: member.plan.plan_digest, journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const migration = member.plan.tasks.map(({ task_id: id }) => ({ from_task_id: id, to_task_id: id, state_policy: 'carry' }));
  const phaseMigration = [{ from_phase_id: 'p1', to_phase_id: 'p1', state_policy: 'carry' }];
  const desired = { ...planInput(schema, tasks), predecessor_plan_digest: predecessor.plan_digest,
    hard_dependencies: [{ from: ref('s'), to: ref('a') }, { from: ref('s'), to: ref('b') }] };
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project', planKey: 'main', predecessor, desiredPlan: desired,
    taskMigration: migration, phaseMigration });
  const revision = { schema: 'lattice.phase_todo_revision.v5', project_id: 'project', plan_key: 'main', predecessor,
    desired_plan: buildTodoPlan(desired), task_migration: migration, phase_migration: phaseMigration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}
const apply = (root, revision) => applyPhaseTodoRevision({ repoRoot: root, writer: authoring, revision, actor, recordedAt });

const record = (overrides = {}) => ({ map: [{ task_id: 'a', path: 'src/x.mjs', symbol: 'g' }], commit: SHA, base: 'b'.repeat(40),
  outcome: 'accepted', conditions: Object.fromEntries(['behaviour', 'tests', 'fresh', 'overlap', 'parallel']
    .map((key) => [key, { passed: true, detail: 'ok' }])), recorded_at: recordedAt, actor, ...overrides });

test('plan v9 holds a nullable function_split per task and explains a bad mark by pointer', () => {
  const plan = buildTodoPlan(planInput('lattice.todo_plan.v9', v9Tasks()));
  assert.equal(validateTodoPlan(plan), true);
  assert.equal(validateTodoPlan(buildTodoPlan(planInput('lattice.todo_plan.v9', [task('a', { function_split: null })]))), true);
  const bad = (edit) => {
    const broken = structuredClone(plan);
    edit(broken.tasks[2].function_split);
    return explainTodoPlan(broken)?.path;
  };
  assert.equal(bad((split) => { split.members = ['b', 'a']; }), '/tasks/2');
  assert.equal(bad((split) => { split.members = ['a']; }), '/tasks/2');
  assert.equal(bad((split) => { split.start_line = 30; }), '/tasks/2');
  assert.equal(bad((split) => { split.members = ['a', 'zz']; }), '/tasks/2/function_split/members');
  assert.equal(bad((split) => { split.members = ['a', 's']; }), '/tasks/2/function_split/members');
  const missing = structuredClone(plan);
  delete missing.tasks[0].function_split;
  assert.equal(explainTodoPlan(missing).reason, 'task_shape_invalid');
  assert.throws(() => buildTodoPlan(planInput('lattice.todo_plan.v8', v9Tasks())));
});

test('a v8 plan is promoted to v9 by one revision that carries state; v9 refuses to go back', async (t) => {
  const root = await fixture(t);
  const member = (await readTodoStore({ repoRoot: root })).members[0];
  assert.equal(member.plan.schema, 'lattice.todo_plan.v9');
  assert.equal(member.tasks.find(({ task_id: id }) => id === 'a').status, 'in-progress');
  assert.deepEqual(member.plan.tasks.find(({ task_id: id }) => id === 's').function_split.members, ['a', 'b']);
  const back = promotion(member, { tasks: [task('a'), task('b'), task('s')], schema: 'lattice.todo_plan.v8' });
  assert.equal(validatePhaseTodoRevision(back), true);
  await assert.rejects(apply(root, back), reason('REVISION_INVALID', 'function_split_schema_downgrade'));
});

test('the reader registration names the v9 plan and the split record', () => {
  assert.equal(NEWEST_KNOWN_TODO_SCHEMA.todo_plan, 9);
  assert.equal(NEWEST_KNOWN_TODO_SCHEMA.todo_split_record, 1);
});

test('a split record is written whole, replaced with attempt + 1, and read without a lock', async (t) => {
  const root = await fixture(t);
  assert.equal(await readTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's' }), null);
  const first = await recordTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's', writer, record: record() });
  assert.equal(first.attempt, 1);
  assert.equal(validateTodoSplitRecord(first), true);
  assert.deepEqual(await readTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's' }), first);
  const rejected = record({ outcome: 'rejected', commit: 'c'.repeat(40) });
  rejected.conditions.tests = { passed: false, detail: 'a test failed' };
  const second = await recordTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's', writer, record: rejected });
  assert.equal(second.attempt, 2);
  assert.equal((await readTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's' })).outcome, 'rejected');
});

test('a split record is refused for a bad writer, a task without a mark, a non-member map entry and an accepted record with a failed condition', async (t) => {
  const root = await fixture(t);
  const call = (overrides, taskId = 's', who = writer) => recordTodoSplit({ repoRoot: root, planKey: 'main', taskId, writer: who,
    record: record(overrides) });
  await assert.rejects(call({}, 's', authoring), TypeError);
  await assert.rejects(call({}, 'a'), TypeError);
  await assert.rejects(call({ map: [{ task_id: 'zz', path: 'src/x.mjs', symbol: 'g' }] }), TypeError);
  const failed = record();
  failed.conditions.fresh.passed = false;
  await assert.rejects(call(failed), TypeError);
  await assert.rejects(call({ extra: 1 }), TypeError);
  await assert.rejects(call({ map: [{ task_id: 'a', path: 'src/x.mjs', symbol: 'g' }, { task_id: 'a', path: 'src/x.mjs', symbol: 'h' }] }), TypeError);
  assert.equal(await readTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's' }), null);
});

test('a finished split task takes no record', async (t) => {
  const root = await fixture(t);
  await appendTodoEvent({ repoRoot: root, writer: authoring, planKey: 'main',
    event: { kind: 'retire', task_id: 's', actor, recorded_at: recordedAt, payload: { reason: 'declined', prior_status: 'pending' } } });
  await assert.rejects(recordTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's', writer, record: record() }),
    reason('STORE_WRITE_CONFLICT', 'split_task_finished'));
});

test('a damaged, aliased or newer record is named, not mistaken for none', async (t) => {
  const root = await fixture(t);
  await recordTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's', writer, record: record() });
  const file = path.join(root, '.lattice/todo/splits/main/s.json');
  const good = await readFile(file, 'utf8');
  const read = () => readTodoSplit({ repoRoot: root, planKey: 'main', taskId: 's' });
  await writeFile(file, '{"schema":"lattice.todo_split_record.v1"}\n');
  await assert.rejects(read(), reason('STORE_INCONSISTENT', 'split_record_invalid'));
  await writeFile(file, 'not json\n');
  await assert.rejects(read(), reason('STORE_INCONSISTENT', 'split_record_invalid'));
  await writeFile(file, good.replace('"task_id":"s"', '"task_id":"a"'));
  await assert.rejects(read(), reason('STORE_INCONSISTENT', 'split_record_invalid'));
  await writeFile(file, good.replace('todo_split_record.v1', 'todo_split_record.v2'));
  await assert.rejects(read(), (error) => error.code === 'UNSUPPORTED_SCHEMA' && error.detail.reason === 'newer_lattice_value');
  await rm(file);
  await symlink(path.join(root, 'elsewhere.json'), file);
  await assert.rejects(read(), reason('STORE_INCONSISTENT', 'split_record_invalid'));
  await rm(file);
  await mkdir(file);
  await assert.rejects(read(), reason('STORE_INCONSISTENT', 'split_record_invalid'));
});
