import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  todoLegacyReconciliationDigest, todoReconciliationDigest, todoRevisionPlanVersion,
  todoSourceInventoryDigest,
} from '../src/todo-revision.mjs';
import {
  appendImportedPlan, applyTodoRevision, buildTodoPlan,
  createTodoStoreWriter, initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });
const ref = (taskId) => ({ project_id: 'project-1', plan_key: 'archive', task_id: taskId });

const MARKDOWN = '# Imported plan\n- [x] A1\n- [x] A2\n';

function pinnedMarkdownCommit(root, message = 'fixture') {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: MARKDOWN, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['mktree'],
    { cwd: root, input: `100644 blob ${blob}\tplan.md\n`, encoding: 'utf8' }).trim();
  return execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: root,
    input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1760000000 +0000\ncommitter Fixture <fixture@example.invalid> 1760000000 +0000\n\n${message}\n`,
    encoding: 'utf8',
  }).trim();
}

/**
 * A2 is `done` by historical import with an unknown completion time — the one
 * state `evidence promote` exists for — and is then carried across a revision,
 * so the successor journal holds no `done` event for it.
 */
async function carriedImportedDoneFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-promote-carried-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'plan.md'), MARKDOWN);
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{ plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
      plan_version: 'v1', predecessor_plan_digest: null, tasks: [task('T1')],
      hard_dependencies: [], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW } }] });

  const sourceCommits = {
    A1: pinnedMarkdownCommit(root, 'fixture A1'),
    A2: pinnedMarkdownCommit(root, 'fixture A2'),
  };
  const source = (taskId, origin_line) => ({ schema: 'lattice.todo_import_source.v1',
    origin_plan_ref: 'plan.md', origin_line, source_commit: sourceCommits[taskId] });
  await appendImportedPlan({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), now: NOW,
    plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'archive',
      plan_version: 'v1', predecessor_plan_digest: null, tasks: [task('A1'), task('A2')],
      hard_dependencies: [{ from: ref('A1'), to: ref('A2') }], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW },
    completedTasks: [
      { task_id: 'A2', completed_at: 'unknown_requires_evidence', evidence: source('A2', 3) },
      { task_id: 'A1', completed_at: NOW, evidence: source('A1', 2) },
    ] });

  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const previous = store.members.find(({ descriptor }) => descriptor.plan_key === 'archive');
  const predecessor = { plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest,
    plan_version: previous.plan.plan_version };
  const taskMigration = [
    { from_task_id: 'A1', to_task_id: 'A1', state_policy: 'carry' },
    { from_task_id: 'A2', to_task_id: 'A2', state_policy: 'carry' },
  ];
  const sourceInventory = {
    active: [
      { task_id: 'A1', source_ref: 'plan.md#L2', source_digest: digest('- [x] A1') },
      { task_id: 'A2', source_ref: 'plan.md#L3', source_digest: digest('- [x] A2') },
    ],
    excluded_tombstones: [],
  };
  // 後継planはv3へ上がる（revision契約）。
  const taskV3 = (taskId) => ({ ...task(taskId), narrative_anchor: null, parent_task_id: null });
  const desiredInput = { schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'archive', plan_version: 'pending',
    predecessor_plan_digest: predecessor.plan_digest, tasks: [taskV3('A1'), taskV3('A2')],
    hard_dependencies: [{ from: ref('A1'), to: ref('A2') }], joins: [] };
  desiredInput.plan_version = todoRevisionPlanVersion({ projectId: 'project-1',
    planKey: 'archive', predecessor, desiredPlan: desiredInput, taskMigration, sourceInventory });
  const desiredPlan = buildTodoPlan(desiredInput);
  const predecessorReconciliationDigest = todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest });
  const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
  const revision = { schema: 'lattice.todo_revision.v1', project_id: 'project-1',
    plan_key: 'archive', predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory,
    reconciliation: { predecessor_reconciliation_digest: predecessorReconciliationDigest,
      source_inventory_digest: sourceInventoryDigest,
      reconciliation_digest: todoReconciliationDigest({ predecessorReconciliationDigest,
        sourceInventoryDigest, predecessor, desiredPlanDigest: desiredPlan.plan_digest,
        taskMigration }) },
    revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await applyTodoRevision({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision, actor: ACTOR,
    recordedAt: NOW, now: NOW });
  return { root, source, sourceCommit: sourceCommits.A2 };
}

async function carryCurrentRevision(root) {
  const previous = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive');
  const predecessor = { plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest,
    plan_version: previous.plan.plan_version };
  const taskMigration = [
    { from_task_id: 'A1', to_task_id: 'A1', state_policy: 'carry' },
    { from_task_id: 'A2', to_task_id: 'A2', state_policy: 'carry' },
  ];
  const sourceInventory = { active: [
    { task_id: 'A1', source_ref: 'plan.md#L2', source_digest: digest('- [x] A1') },
    { task_id: 'A2', source_ref: 'plan.md#L3', source_digest: digest('- [x] A2') },
  ], excluded_tombstones: [] };
  const desiredInput = { schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'archive', plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [
      { ...task('A1'), narrative_anchor: null, parent_task_id: null },
      { ...task('A2'), narrative_anchor: null, parent_task_id: null },
    ], hard_dependencies: [{ from: ref('A1'), to: ref('A2') }], joins: [] };
  desiredInput.plan_version = todoRevisionPlanVersion({ projectId: 'project-1',
    planKey: 'archive', predecessor, desiredPlan: desiredInput, taskMigration, sourceInventory });
  const desiredPlan = buildTodoPlan(desiredInput);
  const activeGenesis = previous.journal.events[0];
  const predecessorReconciliationDigest = activeGenesis.schema === 'lattice.todo_event.v2'
    ? activeGenesis.reconciliation_digest
    : todoLegacyReconciliationDigest({ planDigest: predecessor.plan_digest,
      journalHeadDigest: predecessor.journal_head_digest });
  const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
  const revision = { schema: 'lattice.todo_revision.v1', project_id: 'project-1',
    plan_key: 'archive', predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory, reconciliation: {
      predecessor_reconciliation_digest: predecessorReconciliationDigest,
      source_inventory_digest: sourceInventoryDigest,
      reconciliation_digest: todoReconciliationDigest({ predecessorReconciliationDigest,
        sourceInventoryDigest, predecessor, desiredPlanDigest: desiredPlan.plan_digest,
        taskMigration }),
    }, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await applyTodoRevision({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision, actor: ACTOR,
    recordedAt: NOW, now: NOW });
}

function promotionEvidence(root) {
  const bytes = Buffer.from('promoted evidence\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  return { evidence_id: 'promoted', repo_id: 'self', path: 'evidence.txt', git_blob_oid: oid,
    content_digest: digest('promoted evidence\n'), media_type: 'text/plain', anchor_digest: null };
}

test('carryされたimported doneは後継journalにdoneイベントを持たない', async (t) => {
  const { root } = await carriedImportedDoneFixture(t);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive');
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'A2').status, 'done');
  assert.equal(member.journal.events.some(({ kind, task_id }) => kind === 'done' && task_id === 'A2'),
    false);
});

test('carried imported doneへevidence promoteできる', async (t) => {
  const { root } = await carriedImportedDoneFixture(t);
  await appendTodoEvent({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'archive', now: NOW,
    event: { kind: 'done', task_id: 'A2', actor: ACTOR, recorded_at: NOW,
      payload: { done_mode: 'evidence_promotion', imported: true,
        evidence: promotionEvidence(root) } } });
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive');
  const task2 = member.tasks.find(({ task_id }) => task_id === 'A2');
  assert.equal(task2.status, 'done');
  assert.equal(task2.evidence.evidence_id, 'promoted');
});

test('完了時刻が判明しているcarried doneも時刻を維持して証拠を再束縛する', async (t) => {
  const { root } = await carriedImportedDoneFixture(t);
  await appendTodoEvent({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'archive', now: NOW,
    event: { kind: 'done', task_id: 'A1', actor: ACTOR, recorded_at: NOW,
      payload: { done_mode: 'evidence_promotion', imported: true,
        evidence: promotionEvidence(root) } } });
  const task1 = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive').tasks
    .find(({ task_id: taskId }) => taskId === 'A1');
  assert.equal(task1.done_at, NOW);
  assert.equal(task1.imported, true);
  assert.equal(task1.evidence.evidence_id, 'promoted');
});

test('不達になったimport sourceを通常証拠へ再束縛して次のhard readを通す', async (t) => {
  const { root, sourceCommit } = await carriedImportedDoneFixture(t);
  await rm(path.join(root, '.git', 'objects', sourceCommit.slice(0, 2), sourceCommit.slice(2)));
  await appendTodoEvent({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'archive', now: NOW,
    event: { kind: 'done', task_id: 'A2', actor: ACTOR, recorded_at: NOW,
      payload: { done_mode: 'evidence_promotion', imported: true,
        evidence: promotionEvidence(root) } } });
  const task2 = (await readTodoStore({ repoRoot: root, now: NOW, forWrite: true })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive').tasks
    .find(({ task_id }) => task_id === 'A2');
  assert.equal(task2.evidence.evidence_id, 'promoted');
  assert.equal(task2.imported, true);
});

test('promote済みimported doneをrevision carryして通常証拠を維持する', async (t) => {
  const { root } = await carriedImportedDoneFixture(t);
  await appendTodoEvent({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'archive', now: NOW,
    event: { kind: 'done', task_id: 'A2', actor: ACTOR, recorded_at: NOW,
      payload: { done_mode: 'evidence_promotion', imported: true,
        evidence: promotionEvidence(root) } } });
  await carryCurrentRevision(root);
  const member = (await readTodoStore({ repoRoot: root, now: NOW, forWrite: true })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive');
  const task2 = member.tasks.find(({ task_id }) => task_id === 'A2');
  assert.equal(task2.status, 'done');
  assert.equal(task2.imported, true);
  assert.equal(task2.evidence.evidence_id, 'promoted');
});
