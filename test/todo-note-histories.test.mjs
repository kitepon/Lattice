import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TODO_LIMITS, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  appendTodoNote, readTodoNoteContext, readTodoNoteContextsForPlan,
} from '../src/todo-note-store.mjs';
import {
  applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter, initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { phaseTodoRevisionPlanVersion } from '../src/todo-revision.mjs';

const actor = { host: 'host', session: 'session', agent: 'fixture' };
const recordedAt = '2026-11-07T00:00:00.000Z';
const writer = createTodoStoreWriter({ caller: 'g5-authoring' });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-note-histories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const plan = buildTodoPlan({
    schema: 'lattice.todo_plan.v4', project_id: 'project', plan_key: 'main',
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: ['a', 'b'].map((task_id) => ({ task_id, title: task_id, lane: 'main',
      narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'phase' })),
    phases: [{ phase_id: 'phase', title: 'Phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['gate'] }],
    hard_dependencies: [], joins: [],
  });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor, recorded_at: recordedAt } }] });
  return root;
}

const append = (root, taskId, body, extra = {}) => appendTodoNote({
  repoRoot: root, projectId: 'project', planKey: 'main', planVersion: 'v1', taskId,
  actor, recordedAt, body, supersedes: null, eligibleSupersedes: [], ...extra,
});

test('batch history opt-in preserves default shape and agrees with each single-task projection', async (t) => {
  const root = await fixture(t);
  await append(root, null, 'Plan note');
  const first = await append(root, 'a', '{"workflow":"opened","pr":45}');
  const corrected = await append(root, 'a', '{"workflow":"opened","pr":46}', {
    supersedes: first.event_digest, eligibleSupersedes: [first.event_digest],
  });
  await append(root, 'b', 'Other task');
  const store = await readTodoStore({ repoRoot: root });
  const options = { repoRoot: root, store, planKey: 'main' };
  const baseline = await readTodoNoteContextsForPlan(options);
  assert.deepEqual(await readTodoNoteContextsForPlan({ ...options, includeHistory: false }), baseline);
  assert.equal('histories' in baseline, false);
  const { histories, ...existing } = await readTodoNoteContextsForPlan({ ...options, includeHistory: true });
  assert.deepEqual(existing, baseline);
  assert.deepEqual(histories.map(({ task_id }) => task_id), ['a', 'b']);
  for (const { task_id, history } of histories) {
    const single = await readTodoNoteContext({ ...options, taskId: task_id });
    assert.deepEqual(history, single.history);
    assert.equal(history[0].scope, 'plan');
  }
  const superseded = histories[0].history.find(({ event_digest }) => event_digest === first.event_digest);
  assert.equal(superseded.superseded_by, corrected.event_digest);
  await assert.rejects(readTodoNoteContextsForPlan({ ...options, includeHistory: 'yes' }), TypeError);
});

test('full histories retain older opaque workflow bytes beyond bounded context without writing artifacts', async (t) => {
  const root = await fixture(t);
  const workflow = await append(root, 'a', '{"workflow":"ci","run":123}');
  for (let index = 0; index < 4; index++) {
    await append(root, 'a', `${index}`.padEnd(TODO_LIMITS.noteBodyBytes, 'x'));
  }
  const refs = ['manifest.json', 'plans/main/v1/journal/active.jsonl',
    'plans/main/v1/snapshot.json', 'notes/main/active.jsonl'];
  const before = await Promise.all(refs.map((ref) => readFile(path.join(root, '.lattice/todo', ref))));
  const store = await readTodoStore({ repoRoot: root });
  const result = await readTodoNoteContextsForPlan({ repoRoot: root, store, planKey: 'main', includeHistory: true });
  assert.equal(result.contexts[0].overflow_count, 1);
  assert.equal(result.contexts[0].notes.some(({ event_digest }) => event_digest === workflow.event_digest), false);
  assert.equal(result.histories[0].history.at(-1).body, workflow.body);
  assert.equal(result.histories[1].history.length, 0);
  assert.deepEqual(await Promise.all(refs.map((ref) => readFile(path.join(root, '.lattice/todo', ref)))), before);
});

test('batch histories use existing migration projection and preserve retired notes as archived', async (t) => {
  const root = await fixture(t);
  const carried = await append(root, 'a', 'Carried task history');
  const retired = await append(root, 'b', 'Retired task history');
  const previous = (await readTodoStore({ repoRoot: root })).members[0];
  const predecessor = { plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest, plan_version: 'v1' };
  const task_migration = [
    { from_task_id: 'a', to_task_id: 'renamed', state_policy: 'carry' },
    { from_task_id: 'b', to_task_id: 'removed', state_policy: 'removed' },
  ];
  const phase_migration = [{ from_phase_id: 'phase', to_phase_id: 'phase', state_policy: 'reset' }];
  const desired = { ...previous.plan, predecessor_plan_digest: predecessor.plan_digest,
    tasks: [{ ...previous.plan.tasks[0], task_id: 'renamed' }] };
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project', planKey: 'main',
    predecessor, desiredPlan: desired, taskMigration: task_migration, phaseMigration: phase_migration });
  const revision = { schema: 'lattice.phase_todo_revision.v1', project_id: 'project', plan_key: 'main',
    predecessor, desired_plan: buildTodoPlan(desired), task_migration, phase_migration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor, recordedAt });
  const store = await readTodoStore({ repoRoot: root });
  const options = { repoRoot: root, store, planKey: 'main' };
  const result = await readTodoNoteContextsForPlan({ ...options, includeHistory: true });
  const single = await readTodoNoteContext({ ...options, taskId: 'renamed' });
  assert.deepEqual(result.histories, [{ task_id: 'renamed', history: single.history }]);
  assert.equal(result.histories[0].history[0].event_digest, carried.event_digest);
  assert.deepEqual(result.archived, single.archived);
  assert.equal(result.archived[0].event_digest, retired.event_digest);
});
