import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renamePublishedFile } from '../src/fs-publish.mjs';
import {
  TODO_LIMITS, canonicalizeTodoArtifact, isStrictTodoTimestamp, todoSelfDigest,
} from '../src/todo-contracts.mjs';
import {
  TodoStoreError, appendImportedPlan, appendTodoEvent, applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter,
  createSuccessorTodoPlan, initializeAuthoredTodoStore, initializeTodoStore, readTodoStore, readTodoStoreStable,
  rebuildTodoSnapshot,
} from '../src/todo-store.mjs';
import { projectTodoChainV1 } from '../src/todo-chain.mjs';
import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { phaseTodoRevisionPlanVersion } from '../src/todo-revision.mjs';
import { projectTodoStatus } from '../src/todo-status.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const planRef = '.lattice/todo/plans/main/v1/plan.json';
const journalRef = '.lattice/todo/plans/main/v1/journal/active.jsonl';
const snapshotRef = '.lattice/todo/plans/main/v1/snapshot.json';
const manifestRef = '.lattice/todo/manifest.json';

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null });
const taskV3 = (taskId, parentTaskId = null) => ({
  ...task(taskId), narrative_anchor: null, parent_task_id: parentTaskId,
});
const taskV4 = (taskId, phaseId, parentTaskId = null) => ({
  ...taskV3(taskId, parentTaskId), phase_id: phaseId,
});
const ref = (taskId, planKey = 'main', projectId = 'project-1', expected) => ({
  project_id: projectId, plan_key: planKey, task_id: taskId,
  ...(expected === undefined ? {} : { expected_topology_digest: expected }),
});

async function bareWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-store-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

async function workspace(context, overrides = {}) {
  const root = await bareWorkspace(context);
  const plan = overrides.plan ?? {
    schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('T1'), task('T2')],
    hard_dependencies: [{ from: ref('T1'), to: ref('T2') }], joins: [],
  };
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: overrides.projectId ?? 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: overrides.plans ?? [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  return root;
}

async function phaseRevisionFixture(context) {
  const root = await bareWorkspace(context);
  const phase = { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const plan = buildTodoPlan({ schema: 'lattice.todo_plan.v4', project_id: 'project-1',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [taskV4('T1', 'phase-1')], phases: [phase], hard_dependencies: [], joins: [] });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW });
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const taskMigration = [{ from_task_id: 'T1', to_task_id: 'T1', state_policy: 'carry' }];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredInput = structuredClone(member.plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.predecessor_plan_digest = predecessor.plan_digest;
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  const revision = { schema: 'lattice.phase_todo_revision.v1', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    phase_migration: phaseMigration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return { root, revision };
}

async function bytes(root, refValue) { return readFile(path.join(root, refValue)); }
async function expectCode(promise, code, reason) {
  await assert.rejects(promise, (error) => error instanceof TodoStoreError
    && error.code === code && (reason === undefined || error.detail.reason === reason));
}

function pinnedMarkdownCommit(root, input = '# Imported plan\n- [x] A1\n- [x] A2\n') {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input, encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['mktree'], {
    cwd: root, input: `100644 blob ${blob}\tplan.md\n`, encoding: 'utf8',
  }).trim();
  return execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: root,
    input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1760000000 +0000\ncommitter Fixture <fixture@example.invalid> 1760000000 +0000\n\nfixture\n`,
    encoding: 'utf8',
  }).trim();
}

function importedPlanRequest(root, overrides = {}) {
  const sourceCommit = overrides.sourceCommit ?? pinnedMarkdownCommit(root);
  const source = (origin_line) => ({ schema: 'lattice.todo_import_source.v1', origin_plan_ref: 'plan.md',
    origin_line, source_commit: sourceCommit });
  return {
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }), now: NOW,
    plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'archive', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [task('A1'), task('A2')],
      hard_dependencies: [{ from: ref('A1', 'archive'), to: ref('A2', 'archive') }], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW },
    completedTasks: [
      { task_id: 'A2', completed_at: 'unknown_requires_evidence', evidence: source(3) },
      { task_id: 'A1', completed_at: NOW, evidence: source(2) },
    ],
    ...overrides,
  };
}

function todoTopology(store) {
  return {
    nodes: store.members.flatMap(({ plan }) => plan.tasks.map(({ task_id }) => ref(task_id, plan.plan_key))),
    hard_edges: store.members.flatMap(({ plan }) => plan.hard_dependencies),
    joins: store.members.flatMap(({ plan }) => plan.joins),
  };
}

test('todo timestampはmillisecond UTCのparse→toISOString byte一致だけを受理する', () => {
  assert.equal(isStrictTodoTimestamp(NOW), true);
  for (const value of [
    '2026-02-30T00:00:00.000Z', '2026-07-18T00:00:00Z',
    '2026-07-18T00:00:00.00Z', '2026-07-18T09:00:00.000+09:00',
  ]) assert.equal(isStrictTodoTimestamp(value), false, value);
});

test('todo_plan.v3はparent存在・self禁止・cycle禁止をdigest込みで検証する', () => {
  const input = {
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'main', plan_version: 'v2',
    predecessor_plan_digest: '1'.repeat(64), tasks: [taskV3('P1'), taskV3('T1', 'P1')],
    hard_dependencies: [], joins: [],
  };
  const plan = buildTodoPlan(input);
  assert.equal(plan.schema, 'lattice.todo_plan.v3');
  for (const tasks of [
    [taskV3('T1', 'missing')],
    [taskV3('T1', 'T1')],
    [taskV3('T1', 'T2'), taskV3('T2', 'T1')],
  ]) assert.throws(() => buildTodoPlan({ ...input, tasks }), /declared schema/u);
});

test('Phaseは重いgateをjournalで証明しacceptまで後続ToDoを閉じる', async (context) => {
  const root = await bareWorkspace(context);
  const plan = {
    schema: 'lattice.todo_plan.v4', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [taskV4('T1', 'phase-1'), taskV4('T2', 'phase-2')],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'dotagents-heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy-check'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'dotagents-heavy', predecessor_phase_ids: ['phase-1'],
        required_evidence_slots: ['heavy-check'] },
    ],
    hard_dependencies: [], joins: [],
  };
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } }), 'STORE_INCONSISTENT', 'invalid_start_transition');

  const evidenceBytes = Buffer.from('heavy phase verification\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: evidenceBytes, encoding: 'utf8',
  }).trim();
  const evidence = { evidence_id: 'phase-gate', repo_id: 'self', path: 'phase-evidence.txt',
    git_blob_oid: oid, content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { evidence } } });
  let store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(store.members[0].snapshot.phases.map(({ phase_id, status }) => [phase_id, status]),
    [['phase-1', 'gate_ready'], ['phase-2', 'locked']]);
  let reviewed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_review', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '重い検証を開始' } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewed.event.event_digest, decision_evidence: evidence,
        evidence_slots: [{ slot_id: 'wrong-slot', evidence }] } } }),
  'STORE_INCONSISTENT', 'phase_accept_binding_invalid');
  const rejected = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_reject', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewed.event.event_digest, reason: '修正が必要',
        decision_evidence: evidence } } });
  assert.equal(rejected.snapshot.phases[0].status, 'rejected');
  const reopened = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '修正完了', override_reason: null } } });
  assert.equal(reopened.snapshot.phases[0].status, 'gate_ready');
  reviewed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_review', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '再検証' } } });
  const accepted = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewed.event.event_digest, decision_evidence: evidence,
        evidence_slots: [{ slot_id: 'heavy-check', evidence }] } } });
  assert.equal(accepted.snapshot.phases[0].status, 'accepted');
  assert.equal(accepted.snapshot.phases[1].status, 'active');
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '再監査', override_reason: null } } }),
  'STORE_INCONSISTENT', 'phase_reopen_has_started_successor');
  store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members[0].journal.events.every(({ schema }) => schema === 'lattice.todo_event.v3'), true);
  assert.equal(store.members[0].snapshot.schema, 'lattice.todo_snapshot.v2');

  const predecessor = { plan_digest: store.members[0].plan.plan_digest,
    journal_head_digest: store.members[0].journal.events.at(-1).event_digest,
    plan_version: store.members[0].plan.plan_version };
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: 'carry' },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: 'carry' },
  ];
  const phaseMigration = [
    { from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' },
    { from_phase_id: 'phase-2', to_phase_id: 'phase-2', state_policy: 'carry' },
  ];
  const desiredInput = { ...store.members[0].plan, plan_version: 'placeholder',
    predecessor_plan_digest: predecessor.plan_digest };
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  const revision = { schema: 'lattice.phase_todo_revision.v1', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    phase_migration: phaseMigration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: NOW, now: NOW,
    onProtocolStage: (stage) => { if (stage === 'phase_revision_marker_durable') throw new Error('crash'); } }),
  /crash/u);
  const retryTime = '2026-07-18T00:00:00.001Z';
  const recovered = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: retryTime, now: retryTime });
  assert.equal(recovered.recovered, false);
  store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members[0].journal.events[0].schema, 'lattice.todo_event.v4');
  assert.deepEqual(store.members[0].snapshot.phases.map(({ status }) => status), ['accepted', 'active']);
  assert.deepEqual(store.members[0].tasks.map(({ status }) => status), ['done', 'in-progress']);

  const nextPredecessor = { plan_digest: store.members[0].plan.plan_digest,
    journal_head_digest: store.members[0].journal.events.at(-1).event_digest,
    plan_version: store.members[0].plan.plan_version };
  const movedTaskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: 'reset_pending' },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: 'carry' },
  ];
  const movedInput = structuredClone(store.members[0].plan);
  delete movedInput.topology_digest; delete movedInput.plan_digest;
  movedInput.predecessor_plan_digest = nextPredecessor.plan_digest;
  movedInput.plan_version = 'placeholder';
  movedInput.tasks.find(({ task_id }) => task_id === 'T1').phase_id = 'phase-2';
  movedInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor: nextPredecessor, desiredPlan: movedInput, taskMigration: movedTaskMigration,
    phaseMigration });
  const movedPlan = buildTodoPlan(movedInput);
  const movedRevision = { schema: 'lattice.phase_todo_revision.v1', project_id: 'project-1',
    plan_key: 'main', predecessor: nextPredecessor, desired_plan: movedPlan,
    task_migration: movedTaskMigration, phase_migration: phaseMigration, revision_digest: '' };
  movedRevision.revision_digest = todoSelfDigest(movedRevision, 'revision_digest');
  await expectCode(applyPhaseTodoRevision({ repoRoot: root, writer, revision: movedRevision,
    actor: ACTOR, recordedAt: NOW, now: NOW }), 'REVISION_INVALID', 'phase_carry_semantics_changed');
});

test('todo_plan.v5はPhaseを監査境界に限定しToDo DAGの並列性を維持する', async (context) => {
  const root = await bareWorkspace(context);
  const plan = buildTodoPlan({
    schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [taskV4('T1', 'phase-1'), taskV4('T2', 'phase-2'), taskV4('T3', 'phase-2')],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'heavy', predecessor_phase_ids: ['phase-1'],
        required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [], joins: [],
    phase_accept_dependencies: [{
      from: { project_id: 'project-1', plan_key: 'main', phase_id: 'phase-1' },
      to: ref('T3'),
    }],
  });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const initial = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(projectTodoStatus(initial, { parallelCandidates: [], planNotes: [] }).next_ready.map(({ task_id }) => task_id), ['T1', 'T2']);
  assert.deepEqual(initial.members[0].snapshot.phases.map(({ phase_id, status }) => [phase_id, status]),
    [['phase-1', 'active'], ['phase-2', 'locked']]);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T3', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } }), 'STORE_INCONSISTENT', 'invalid_start_transition');
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T3', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: '明示Phase gateを迂回' } } }),
  'STORE_INCONSISTENT', 'invalid_start_transition');
  const evidenceBytes = Buffer.from('v5 phase audit\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: evidenceBytes, encoding: 'utf8',
  }).trim();
  const evidence = { evidence_id: 'v5-audit', repo_id: 'self', path: 'v5-audit.txt',
    git_blob_oid: oid, content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { evidence } } });
  const reviewed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_review', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '重監査' } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewed.event.event_digest, decision_evidence: evidence,
        evidence_slots: [{ slot_id: 'heavy', evidence }] } } });
  const reopened = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '再監査', override_reason: null } } });
  assert.equal(reopened.snapshot.phases[0].status, 'gate_ready');
});

test('todo_plan.v5はtask・Phase gateを合わせたcycleを拒否する', async (context) => {
  const root = await bareWorkspace(context);
  const plan = buildTodoPlan({
    schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [taskV4('T1', 'phase-1'), taskV4('T2', 'phase-2')],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [{ from: ref('T2'), to: ref('T1') }], joins: [],
    phase_accept_dependencies: [{
      from: { project_id: 'project-1', plan_key: 'main', phase_id: 'phase-1' },
      to: ref('T2'),
    }],
  });
  await expectCode(initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  }), 'STORE_INCONSISTENT', 'merged_cycle');
});

test('phase_todo_revision.v2はv4 planを分離型v5へ原子的に昇格する', async (context) => {
  const { root } = await phaseRevisionFixture(context);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const taskMigration = [{ from_task_id: 'T1', to_task_id: 'T1', state_policy: 'reset_pending' }];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'reset' }];
  const desiredInput = structuredClone(member.plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.schema = 'lattice.todo_plan.v5';
  desiredInput.phase_accept_dependencies = [];
  desiredInput.predecessor_plan_digest = predecessor.plan_digest;
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  const revision = { schema: 'lattice.phase_todo_revision.v2', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    phase_migration: phaseMigration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await applyPhaseTodoRevision({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    revision, actor: ACTOR, recordedAt: NOW, now: NOW });
  const revised = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(revised.plan.schema, 'lattice.todo_plan.v5');
  assert.deepEqual(revised.plan.phase_accept_dependencies, []);
  assert.equal(revised.journal.events[0].schema, 'lattice.todo_event.v4');
});

for (const stage of [
  'phase_revision_marker_durable', 'phase_revision_input_durable', 'phase_revision_plan_durable',
  'phase_revision_genesis_durable', 'phase_revision_snapshot_durable',
  'phase_revision_manifest_activated',
]) {
  test(`Phase revision crash recoveryは${stage}から異なる時刻のretryで収束する`, async (context) => {
    const { root, revision } = await phaseRevisionFixture(context);
    const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
    await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
      recordedAt: NOW, now: NOW,
      onProtocolStage(current) { if (current === stage) throw new Error(`crash:${stage}`); },
    }), new RegExp(`crash:${stage}`, 'u'));
    const retryTime = '2026-07-18T00:00:00.001Z';
    const result = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
      recordedAt: retryTime, now: retryTime });
    assert.equal(result.recovered, stage === 'phase_revision_manifest_activated');
    const member = (await readTodoStore({ repoRoot: root, now: retryTime })).members[0];
    assert.equal(member.plan.plan_version, revision.desired_plan.plan_version);
    assert.equal(member.journal.events[0].schema, 'lattice.todo_event.v4');
    assert.equal(member.journal.events[0].recorded_at, NOW);
  });
}

test('canonical journalを唯一正本としてplanとsnapshotを束縛して読む', async (context) => {
  const root = await workspace(context);
  const result = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(result.schema, 'lattice.todo_store_read.v1');
  assert.equal(result.snapshot_stale, false);
  assert.equal(result.members[0].plan.schema, 'lattice.todo_plan.v1');
  assert.equal(Object.hasOwn(result.members[0].plan.tasks[0], 'narrative_anchor'), false);
  assert.deepEqual(result.members[0].tasks.map(({ task_id, status }) => [task_id, status]), [['T1', 'pending'], ['T2', 'pending']]);
});

test('writer capabilityはG4 migrationとG5 authoringだけに限定する', () => {
  assert.throws(() => createTodoStoreWriter({ caller: 'todo-cli' }), TypeError);
  assert.equal(createTodoStoreWriter({ caller: 'g4-migration' }).caller, 'g4-migration');
  assert.equal(createTodoStoreWriter({ caller: 'g5-authoring' }).caller, 'g5-authoring');
});

test('closed transitionと依存gateをappend前に検証し、失敗時bytesを変えない', async (context) => {
  const root = await workspace(context);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const before = await bytes(root, journalRef);
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } }),
  'STORE_INCONSISTENT', 'invalid_start_transition');
  assert.deepEqual(await bytes(root, journalRef), before);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'block', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { reason: 'waiting' } } });
  const result = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(result.members[0].tasks[0].status, 'blocked');
  assert.equal(result.members[0].tasks[0].blocked_reason, 'waiting');
});

test('cross-plan predecessorはstart/done/reopenをmerged graphで保護する', async (context) => {
  const root = await bareWorkspace(context);
  const upstream = buildTodoPlan({
    schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'upstream', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('U1')], hard_dependencies: [], joins: [],
  });
  const downstream = {
    schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'downstream', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('D1'), task('D2')],
    hard_dependencies: [{
      from: ref('U1', 'upstream', 'project-1', upstream.topology_digest),
      to: ref('D1', 'downstream'),
    }],
    joins: [{
      id: 'cross-plan-all-of',
      after: [ref('U1', 'upstream', 'project-1', upstream.topology_digest)],
      before: ref('D2', 'downstream'),
    }],
  };
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: upstream, genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: downstream, genesis: { actor: ACTOR, recorded_at: NOW } },
    ],
    now: NOW,
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const storeBeforeStart = await bytes(root, manifestRef);
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'downstream', now: NOW,
    event: { kind: 'start', task_id: 'D1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } }), 'STORE_INCONSISTENT', 'invalid_start_transition');
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'downstream', now: NOW,
    event: { kind: 'start', task_id: 'D2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } }), 'STORE_INCONSISTENT', 'invalid_start_transition');
  assert.deepEqual(await bytes(root, manifestRef), storeBeforeStart);

  const evidenceBytes = Buffer.from('cross-plan evidence\n');
  await writeFile(path.join(root, 'evidence.txt'), evidenceBytes);
  const oid = execFileSync('git', ['hash-object', '-w', 'evidence.txt'], { cwd: root, encoding: 'utf8' }).trim();
  const evidence = { evidence_id: 'cross-plan', repo_id: 'self', path: 'evidence.txt', git_blob_oid: oid,
    content_digest: createHash('sha256').update(evidenceBytes).digest('hex'), media_type: 'text/plain', anchor_digest: null };
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'downstream', now: NOW,
    event: { kind: 'start', task_id: 'D1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: 'parallel audit' } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'downstream', now: NOW,
    event: { kind: 'done', task_id: 'D1', actor: ACTOR, recorded_at: NOW, payload: { evidence } } }),
  'STORE_INCONSISTENT', 'invalid_done_transition');

  await appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'start', task_id: 'U1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'done', task_id: 'U1', actor: ACTOR, recorded_at: NOW, payload: { evidence } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'downstream', now: NOW,
    event: { kind: 'start', task_id: 'D2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'reopen', task_id: 'U1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'correction', override_reason: null } } }),
  'STORE_INCONSISTENT', 'reopen_has_started_successor');
});

test('cross-plan後続はpredecessor ToDo doneでなくPhase acceptedまで閉じreopenも保護する', async (context) => {
  const root = await bareWorkspace(context);
  const upstream = buildTodoPlan({
    schema: 'lattice.todo_plan.v4', project_id: 'project-1', plan_key: 'upstream', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [taskV4('U1', 'phase-1')],
    phases: [{ phase_id: 'phase-1', title: 'upstream', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: [], joins: [],
  });
  const downstream = {
    schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'downstream', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('D1')], hard_dependencies: [{
      from: ref('U1', 'upstream', 'project-1', upstream.topology_digest), to: ref('D1', 'downstream'),
    }], joins: [],
  };
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], plans: [
      { plan: downstream, genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: upstream, genesis: { actor: ACTOR, recorded_at: NOW } },
    ], now: NOW });
  const evidenceBytes = Buffer.from('cross phase evidence\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: evidenceBytes,
    encoding: 'utf8' }).trim();
  const evidence = { evidence_id: 'cross-phase', repo_id: 'self', path: 'cross-phase.txt',
    git_blob_oid: oid, content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'start', task_id: 'U1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'done', task_id: 'U1', actor: ACTOR, recorded_at: NOW, payload: { evidence } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'downstream', now: NOW,
    event: { kind: 'start', task_id: 'D1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } }), 'STORE_INCONSISTENT', 'invalid_start_transition');
  const review = await appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'phase_review', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'heavy' } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: review.event.event_digest, decision_evidence: evidence,
        evidence_slots: [{ slot_id: 'heavy', evidence }] } } });
  const downstreamStart = await appendTodoEvent({ repoRoot: root, writer, planKey: 'downstream', now: NOW,
    event: { kind: 'start', task_id: 'D1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  assert.equal(downstreamStart.event.schema, 'lattice.todo_event.v1');
  assert.equal(Object.hasOwn(downstreamStart.event, 'causal_predecessors'), false);
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'upstream', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'recheck', override_reason: null } } }),
  'STORE_INCONSISTENT', 'phase_reopen_has_started_successor');
});

const journalCorruptions = [
  ['duplicate_key', 'journal_non_canonical_or_duplicate_key', (line) => Buffer.from(`{"schema":"lattice.todo_event.v1",${line.slice(1)}`)],
  ['invalid_utf8', 'journal_invalid_utf8', () => Buffer.from([0xff, 0x0a])],
  ['bom', 'journal_byte_contract', (line) => Buffer.from(`\uFEFF${line}`)],
  ['crlf', 'artifact_eol_converted', (line) => Buffer.from(line.replace(/\n$/u, '\r\n'))],
  ['truncated_write', 'journal_byte_contract', (line) => Buffer.from(line.slice(0, -2))],
  ['merge_marker', 'journal_json_invalid', () => Buffer.from('<<<<<<< HEAD\n')],
  ['schema_version_mixed', 'journal_schema_invalid', (line) => Buffer.from(line.replace('lattice.todo_event.v1', 'lattice.todo_event.v2'))],
  ['size_limit', 'journal_segment_limit_exceeded', () => Buffer.alloc(1_048_577, 0x20)],
];

for (const [name, reason, corrupt] of journalCorruptions) {
  test(`journal byte fixture ${name} はSTORE_CORRUPTで全拒否する`, async (context) => {
    const root = await workspace(context);
    const original = (await bytes(root, journalRef)).toString('utf8');
    await writeFile(path.join(root, journalRef), corrupt(original));
    await expectCode(readTodoStore({ repoRoot: root, now: NOW }), 'STORE_CORRUPT', reason);
  });
}

test('genesis欠落はvalid event bytesでもSTORE_CORRUPT', async (context) => {
  const root = await workspace(context);
  const original = JSON.parse((await bytes(root, journalRef)).toString('utf8'));
  original.kind = 'start'; original.task_id = 'T1'; original.payload = { override_reason: null };
  original.event_digest = todoSelfDigest(original, 'event_digest');
  await writeFile(path.join(root, journalRef), `${canonicalizeTodoArtifact(original)}\n`);
  await expectCode(readTodoStore({ repoRoot: root, now: NOW }), 'STORE_CORRUPT', 'genesis_missing_or_repeated');
});

test('clock reversalはtyped anomalyとしてSTORE_INCONSISTENT', async (context) => {
  const root = await workspace(context); const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  const events = (await bytes(root, journalRef)).toString('utf8').trimEnd().split('\n').map(JSON.parse);
  events[1].recorded_at = '2026-07-17T23:59:59.999Z'; events[1].event_digest = todoSelfDigest(events[1], 'event_digest');
  await writeFile(path.join(root, journalRef), `${events.map(canonicalizeTodoArtifact).join('\n')}\n`);
  const manifest = JSON.parse((await bytes(root, manifestRef)).toString('utf8'));
  manifest.members[0].journal_head_digest = events[1].event_digest;
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  await writeFile(path.join(root, manifestRef), `${canonicalizeTodoArtifact(manifest)}\n`);
  await expectCode(readTodoStore({ repoRoot: root, now: NOW }), 'STORE_INCONSISTENT', 'clock_reversal');
});

test('journal symlink escapeはSTORE_CORRUPTでhard rejectする', async (context) => {
  const root = await workspace(context);
  const outside = path.join(root, 'outside.jsonl');
  await writeFile(outside, await bytes(root, journalRef));
  await unlink(path.join(root, journalRef)); await symlink(outside, path.join(root, journalRef));
  await expectCode(readTodoStore({ repoRoot: root, now: NOW }), 'STORE_CORRUPT', 'unsafe_artifact_path');
});

for (const [name, mutate] of [
  ['missing', async (root) => unlink(path.join(root, snapshotRef))],
  ['digest_mismatch', async (root) => {
    const value = JSON.parse((await bytes(root, snapshotRef)).toString('utf8'));
    value.snapshot_digest = 'f'.repeat(64); await writeFile(path.join(root, snapshotRef), `${canonicalizeTodoArtifact(value)}\n`);
  }],
  ['invalid_utf8', async (root) => writeFile(path.join(root, snapshotRef), Buffer.from([0xff, 0x0a]))],
  ['duplicate_key', async (root) => {
    const line = (await bytes(root, snapshotRef)).toString('utf8');
    await writeFile(path.join(root, snapshotRef), `{"schema":"lattice.todo_snapshot.v1",${line.slice(1)}`);
  }],
  ['old_head', async (root) => {
    const value = JSON.parse((await bytes(root, snapshotRef)).toString('utf8'));
    value.journal_head_digest = 'e'.repeat(64); value.snapshot_digest = todoSelfDigest(value, 'snapshot_digest');
    await writeFile(path.join(root, snapshotRef), `${canonicalizeTodoArtifact(value)}\n`);
  }],
  ['projection_body_mismatch', async (root) => {
    const value = JSON.parse((await bytes(root, snapshotRef)).toString('utf8'));
    value.tasks[0].status = 'done'; value.tasks[0].done_at = NOW;
    value.snapshot_digest = todoSelfDigest(value, 'snapshot_digest');
    await writeFile(path.join(root, snapshotRef), `${canonicalizeTodoArtifact(value)}\n`);
  }],
  ['bom', async (root) => writeFile(path.join(root, snapshotRef), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await bytes(root, snapshotRef)]))],
  ['truncated', async (root) => {
    const value = await bytes(root, snapshotRef); await writeFile(path.join(root, snapshotRef), value.subarray(0, value.length - 2));
  }],
  ['merge_marker', async (root) => writeFile(path.join(root, snapshotRef), '<<<<<<< HEAD\n')],
  ['schema_mixed', async (root) => writeFile(path.join(root, snapshotRef), (await bytes(root, snapshotRef)).toString('utf8').replace('lattice.todo_snapshot.v1', 'lattice.todo_snapshot.v2'))],
  ['trailing_bytes', async (root) => writeFile(path.join(root, snapshotRef), Buffer.concat([await bytes(root, snapshotRef), Buffer.from('x')]))],
  ['size_limit', async (root) => writeFile(path.join(root, snapshotRef), Buffer.alloc(8_388_609, 0x20))],
]) {
  test(`snapshot単独 ${name} はreader継続＋snapshot_stale、writer拒否`, async (context) => {
    const root = await workspace(context); await mutate(root);
    const result = await readTodoStore({ repoRoot: root, now: NOW });
    assert.equal(result.snapshot_stale, true);
    await expectCode(readTodoStore({ repoRoot: root, now: NOW, forWrite: true }), 'STORE_WRITE_REFUSED', 'snapshot_stale');
    const rebuilt = await rebuildTodoSnapshot({ repoRoot: root, planKey: 'main', now: NOW });
    assert.equal(rebuilt.schema, 'lattice.todo_snapshot.v1');
    assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).snapshot_stale, false);
  });
}

test('snapshot単独CRLFはstaleへ丸めず正規repair導線付きで拒否する', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, snapshotRef),
    (await bytes(root, snapshotRef)).toString('utf8').replace(/\n$/u, '\r\n'));
  await assert.rejects(readTodoStore({ repoRoot: root, now: NOW }), (error) => (
    error?.code === 'SNAPSHOT_INVALID'
    && error.detail?.reason === 'artifact_eol_converted'
    && error.detail?.ref === snapshotRef
    && error.detail?.next_action === 'lattice todo repair-eol --json'
  ));
});

test('snapshot symlinkはsnapshot_staleへ丸めずhard rejectする', async (context) => {
  const root = await workspace(context); const outside = path.join(root, 'snapshot-copy.json');
  await writeFile(outside, await bytes(root, snapshotRef)); await unlink(path.join(root, snapshotRef));
  await symlink(outside, path.join(root, snapshotRef));
  await expectCode(readTodoStore({ repoRoot: root, now: NOW }), 'STORE_INCONSISTENT', 'unsafe_artifact_path');
});

for (const [name, refValue] of [['manifest', manifestRef], ['plan', planRef]]) {
  test(`${name} canonical/schema破損はSTORE_INCONSISTENT`, async (context) => {
    const root = await workspace(context); const line = (await bytes(root, refValue)).toString('utf8');
    await writeFile(path.join(root, refValue), `{"schema":"duplicate",${line.slice(1)}`);
    await expectCode(readTodoStore({ repoRoot: root, now: NOW }), 'STORE_INCONSISTENT');
  });
}

test('cross-plan expected_topology_digest違反はdetail.reason=binding_stale', async (context) => {
  const planB = buildTodoPlan({ schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'b', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('B1')], hard_dependencies: [], joins: [] });
  const planA = { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'a', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('A1')], hard_dependencies: [{
      from: ref('B1', 'b', 'project-1', 'f'.repeat(64)), to: ref('A1', 'a'),
    }], joins: [] };
  const plans = [planA, planB].map((plan) => ({ plan, genesis: { actor: ACTOR, recorded_at: NOW } }));
  await assert.rejects(workspace(context, { plans }), (error) => error instanceof TodoStoreError
    && error.code === 'STORE_INCONSISTENT' && error.detail.reason === 'binding_stale');
});

test('snapshot rebuildはcurrentでも同一canonical bytesを返す', async (context) => {
  const root = await workspace(context); const before = await bytes(root, snapshotRef);
  await rebuildTodoSnapshot({ repoRoot: root, planKey: 'main', now: NOW });
  assert.deepEqual(await bytes(root, snapshotRef), before);
});

test('crash matrix: journal commit後にmanifestが旧headなら不整合、snapshotだけ旧版ならstale', async (context) => {
  const root = await workspace(context); const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const oldManifest = await bytes(root, manifestRef); const oldSnapshot = await bytes(root, snapshotRef);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  const newManifest = await bytes(root, manifestRef);
  await writeFile(path.join(root, manifestRef), oldManifest);
  await expectCode(readTodoStore({ repoRoot: root, now: NOW }), 'STORE_INCONSISTENT', 'manifest_journal_head_mismatch');
  // 恒久的に千切れた状態（このtestではmanifestを書き戻していないので、attempt間で一切変化
  // しない）では、汎用STORE_BUSYへ丸めず実際のSTORE_INCONSISTENT reasonを返す——
  // 復旧を試みる呼び出し元がまず読むべき情報を隠さない（2026-08-10 P0の教訓）。
  await expectCode(readTodoStoreStable({ repoRoot: root, now: NOW, maximumAttempts: 2 }),
    'STORE_INCONSISTENT', 'manifest_journal_head_mismatch');
  await writeFile(path.join(root, manifestRef), newManifest); await writeFile(path.join(root, snapshotRef), oldSnapshot);
  assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).snapshot_stale, true);
});

test('readTodoStoreStableは書込中の一時窓（毎attemptでmanifestが動く）なら引き続きリトライで自己解決する', async (context) => {
  const root = await workspace(context); const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const oldManifest = await bytes(root, manifestRef);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  const newManifest = await bytes(root, manifestRef);
  // 千切れを模すが、初回readの直後に「書込が完了する」ところまで再現する: 1回だけ
  // 古いmanifestへ戻し、readTodoStoreStableの最初のattemptがそれを踏んだ直後に
  // 正しいmanifestへ戻す。これは「まだ書込中だった」場合の正常系であり、恒久的な
  // 千切れ（上のtest）とは区別してリトライで解決できることを固定する。
  await writeFile(path.join(root, manifestRef), oldManifest);
  const publication = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const manifest = path.join(root, manifestRef);
    const temporary = `${manifest}.publish`;
    await writeFile(temporary, newManifest);
    await renamePublishedFile(temporary, manifest);
  })();
  const store = await readTodoStoreStable({ repoRoot: root, now: NOW, maximumAttempts: 8 });
  await publication;
  assert.equal(store.manifest.manifest_digest, JSON.parse(newManifest.toString('utf8')).manifest_digest);
});

test('1 MiB到達時にactive segmentをsealし、exact bytes digestと連結を検証する', async (context) => {
  const root = await workspace(context);
  const events = [JSON.parse((await bytes(root, journalRef)).toString('utf8'))];
  const append = (kind, payload) => {
    const previous = events.at(-1);
    const event = { schema: 'lattice.todo_event.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      sequence: previous.sequence + 1, previous_digest: previous.event_digest, kind, task_id: 'T1', actor: ACTOR,
      recorded_at: NOW, provenance: null, payload, event_digest: '' };
    event.event_digest = todoSelfDigest(event, 'event_digest'); events.push(event);
  };
  append('start', { override_reason: null });
  const largeBlock = { reason: 'x'.repeat(16_000) };
  for (;;) {
    const probe = { schema: 'lattice.todo_event.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      sequence: events.at(-1).sequence + 1, previous_digest: events.at(-1).event_digest, kind: 'block', task_id: 'T1',
      actor: ACTOR, recorded_at: NOW, provenance: null, payload: largeBlock, event_digest: '' };
    probe.event_digest = todoSelfDigest(probe, 'event_digest');
    const currentBytes = Buffer.byteLength(`${events.map(canonicalizeTodoArtifact).join('\n')}\n`);
    if (currentBytes + Buffer.byteLength(`${canonicalizeTodoArtifact(probe)}\n`) > 1_048_576) break;
    append('block', { reason: 'padding' }); append('unblock', {});
  }
  await writeFile(path.join(root, journalRef), `${events.map(canonicalizeTodoArtifact).join('\n')}\n`);
  const manifest = JSON.parse((await bytes(root, manifestRef)).toString('utf8'));
  manifest.members[0].journal_head_digest = events.at(-1).event_digest;
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  await writeFile(path.join(root, manifestRef), `${canonicalizeTodoArtifact(manifest)}\n`);
  await rebuildTodoSnapshot({ repoRoot: root, planKey: 'main', now: NOW });
  await appendTodoEvent({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'main', now: NOW,
    event: { kind: 'block', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: largeBlock } });
  const sealed = await readdir(path.join(root, path.dirname(journalRef), 'sealed'));
  assert.equal(sealed.length, 1); assert.match(sealed[0], /^\d{12}-\d{12}-[0-9a-f]{64}-[0-9a-f]{64}\.jsonl$/u);
  assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).members[0].tasks[0].status, 'blocked');
});

test('done evidenceはpinned git blobとcontent digestをwrite時にhard検証する', async (context) => {
  const root = await workspace(context);
  const evidenceBytes = Buffer.from('verified evidence\n');
  await writeFile(path.join(root, 'evidence.txt'), evidenceBytes);
  const oid = execFileSync('git', ['hash-object', '-w', 'evidence.txt'], { cwd: root, encoding: 'utf8' }).trim();
  const evidence = { evidence_id: 'ev-1', repo_id: 'self', path: 'evidence.txt', git_blob_oid: oid,
    content_digest: createHash('sha256').update(evidenceBytes).digest('hex'), media_type: 'text/plain', anchor_digest: null };
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { evidence } } });
  assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).members[0].tasks[0].status, 'done');
});

test('topology変更はactive file上書きでなくsuccessor versionを発行する', async (context) => {
  const root = await workspace(context); const oldPlan = await bytes(root, planRef);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const current = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const sourceCommit = pinnedMarkdownCommit(root);
  await createSuccessorTodoPlan({ repoRoot: root, writer, planKey: 'main', now: NOW,
    plan: { schema: 'lattice.todo_plan.v2', project_id: 'project-1', plan_key: 'main', plan_version: 'v2',
      predecessor_plan_digest: current.plan.plan_digest, tasks: [
        { ...task('T1'), narrative_ref: 'plan.md', narrative_anchor: {
          origin_plan_ref: 'plan.md', origin_line: 2, source_commit: sourceCommit,
          source_line_digest: createHash('sha256').update('- [x] A1').digest('hex'),
        } },
        { ...task('T3'), narrative_anchor: null },
      ], hard_dependencies: [], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW, task_migration: [
      { from_task_id: 'T1', to_task_id: 'T1' }, { from_task_id: 'T2', to_task_id: 'removed' },
    ] } });
  const result = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(result.members[0].plan.schema, 'lattice.todo_plan.v2');
  assert.equal(result.members[0].plan.plan_version, 'v2');
  assert.deepEqual(await bytes(root, planRef), oldPlan);
  await assert.rejects(createSuccessorTodoPlan({ repoRoot: root, writer, planKey: 'main', now: NOW,
    plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v3',
      predecessor_plan_digest: result.members[0].plan.plan_digest, tasks: [task('T1'), task('T3')],
      hard_dependencies: [], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW, task_migration: [
      { from_task_id: 'T1', to_task_id: 'T1' }, { from_task_id: 'T3', to_task_id: 'T3' },
    ] } }), /cannot regress from v2 to v1/u);
});

for (const stage of [
  'manifest_validated', 'plan_key_absent', 'staging_fsynced',
  'manifest_cas_matched', 'pre_activation_renamed', 'manifest_activated',
]) {
  test(`historical import crash recovery: ${stage}`, async (context) => {
    const root = await workspace(context);
    const request = importedPlanRequest(root, {
      onProtocolStage(current) { if (current === stage) throw new Error(`crash:${stage}`); },
    });
    await assert.rejects(appendImportedPlan(request), new RegExp(`crash:${stage}`, 'u'));
    const afterCrash = await readTodoStore({ repoRoot: root, now: NOW });
    if (stage === 'manifest_activated') {
      assert.deepEqual(afterCrash.members.map(({ descriptor }) => descriptor.plan_key), ['archive', 'main']);
      await expectCode(appendImportedPlan(importedPlanRequest(root)), 'STORE_WRITE_CONFLICT', 'plan_key_already_imported');
    } else {
      assert.deepEqual(afterCrash.members.map(({ descriptor }) => descriptor.plan_key), ['main']);
      await appendImportedPlan(importedPlanRequest(root));
      assert.deepEqual((await readTodoStore({ repoRoot: root, now: NOW })).members
        .map(({ descriptor }) => descriptor.plan_key), ['archive', 'main']);
    }
  });
}

test('historical import manifest digest CAS不一致はstagingをmember化せず無変更拒否する', async (context) => {
  const root = await workspace(context);
  const request = importedPlanRequest(root, { onProtocolStage: async (stage) => {
    if (stage !== 'staging_fsynced') return;
    const manifest = JSON.parse((await bytes(root, manifestRef)).toString('utf8'));
    manifest.repositories.push({ repo_id: 'secondary', path: '.' });
    manifest.repositories.sort((left, right) => left.repo_id < right.repo_id ? -1 : 1);
    manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
    await writeFile(path.join(root, manifestRef), `${canonicalizeTodoArtifact(manifest)}\n`);
  } });
  await expectCode(appendImportedPlan(request), 'STORE_WRITE_CONFLICT', 'manifest_digest_changed');
  assert.deepEqual((await readTodoStore({ repoRoot: root, now: NOW })).members
    .map(({ descriptor }) => descriptor.plan_key), ['main']);
});

test('bootstrap importはparent準備後の失敗でも.latticeとstagingを全rollbackする', async (context) => {
  const root = await bareWorkspace(context);
  const request = importedPlanRequest(root, {
    initializeIfMissing: { projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }] },
    onProtocolStage(stage) {
      if (stage === 'bootstrap_parent_prepared') throw new Error('bootstrap registration failed');
    },
  });
  await assert.rejects(appendImportedPlan(request), /bootstrap registration failed/u);
  await assert.rejects(lstat(path.join(root, '.lattice')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.lattice-todo-bootstrap-')), []);
});

test('initial authoringはrename後の検証失敗でもstoreとstagingをrollbackする', async (context) => {
  const root = await bareWorkspace(context);
  await assert.rejects(initializeAuthoredTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plan: {
      schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [taskV3('T1')], hard_dependencies: [], joins: [],
    },
    genesis: { actor: ACTOR, recorded_at: new Date().toISOString(), provenance: null },
    async onProtocolStage(stage) {
      assert.equal(stage, 'authoring_renamed');
      const altered = JSON.parse(await readFile(path.join(root, manifestRef), 'utf8'));
      altered.repositories = [{ repo_id: 'self', path: 'elsewhere' }];
      altered.manifest_digest = todoSelfDigest(altered, 'manifest_digest');
      await writeFile(path.join(root, manifestRef), `${canonicalizeTodoArtifact(altered)}\n`);
    },
  }), (error) => error instanceof TodoStoreError && error.code === 'STORE_WRITE_CONFLICT'
    && error.detail.reason === 'authoring_activation_verification_failed');
  await assert.rejects(lstat(path.join(root, '.lattice', 'todo')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.lattice-todo-authoring-')), []);
});

test('initial authoringはstaleへ丸められるsnapshot改竄も成功扱いせずrollbackする', async (context) => {
  const root = await bareWorkspace(context);
  await assert.rejects(initializeAuthoredTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plan: {
      schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [taskV3('T1')], hard_dependencies: [], joins: [],
    },
    genesis: { actor: ACTOR, recorded_at: new Date().toISOString(), provenance: null },
    async onProtocolStage() {
      await writeFile(path.join(root, snapshotRef), '{}\n');
    },
  }), (error) => error instanceof TodoStoreError && error.code === 'STORE_WRITE_CONFLICT'
    && error.detail.reason === 'authoring_activation_verification_failed');
  await assert.rejects(lstat(path.join(root, '.lattice', 'todo')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.lattice-todo-authoring-')), []);
});

test('historical importはimport済みとauthored既存plan_keyを区別して再取込拒否する', async (context) => {
  const root = await workspace(context);
  await appendImportedPlan(importedPlanRequest(root));
  await expectCode(appendImportedPlan(importedPlanRequest(root)), 'STORE_WRITE_CONFLICT', 'plan_key_already_imported');
  const mainPlan = { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('T1')], hard_dependencies: [], joins: [] };
  await expectCode(appendImportedPlan(importedPlanRequest(root, { plan: mainPlan })),
    'STORE_WRITE_CONFLICT', 'plan_key_already_exists');
});

test('manifest v2 storeへのhistorical importはactive revisionをplan digestへ結合する', async (context) => {
  const root = await workspace(context);
  const current = await readTodoStore({ repoRoot: root, now: NOW });
  const manifest = JSON.parse((await bytes(root, manifestRef)).toString('utf8'));
  manifest.schema = 'lattice.todo_manifest.v2';
  manifest.members = manifest.members.map((descriptor) => ({
    ...descriptor,
    active_revision_digest: current.members
      .find(({ descriptor: member }) => member.plan_key === descriptor.plan_key).plan.plan_digest,
  }));
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  await writeFile(path.join(root, manifestRef), `${canonicalizeTodoArtifact(manifest)}\n`);

  const imported = await appendImportedPlan(importedPlanRequest(root));
  assert.equal(imported.descriptor.active_revision_digest, imported.plan.plan_digest);
  const archive = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive');
  assert.equal(archive.descriptor.active_revision_digest, archive.plan.plan_digest);
});

test('todo_plan.v2のanchor hash不一致はactivation前にfail closedする', async (context) => {
  const root = await workspace(context);
  const sourceCommit = pinnedMarkdownCommit(root);
  const request = importedPlanRequest(root, { sourceCommit });
  request.plan = {
    ...request.plan,
    schema: 'lattice.todo_plan.v2',
    tasks: request.plan.tasks.map((entry, index) => ({
      ...entry,
      narrative_ref: 'plan.md',
      narrative_anchor: {
        origin_plan_ref: 'plan.md', origin_line: index + 2, source_commit: sourceCommit,
        source_line_digest: '0'.repeat(64),
      },
    })),
  };
  await expectCode(appendImportedPlan(request), 'STORE_INCONSISTENT', 'narrative_anchor_unverified');
  assert.deepEqual((await readTodoStore({ repoRoot: root, now: NOW })).members
    .map(({ descriptor }) => descriptor.plan_key), ['main']);
});

test('historical doneは通常writerから追加できず、import source不在は未検証のまま書込みを許す', async (context) => {
  const root = await workspace(context);
  const sourceCommit = pinnedMarkdownCommit(root);
  await appendImportedPlan(importedPlanRequest(root, { sourceCommit }));
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const archive = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive');
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'archive', now: NOW,
    event: { kind: 'done', task_id: 'A1', actor: ACTOR, recorded_at: NOW,
      payload: archive.journal.events[1].payload } }),
  'STORE_WRITE_CONFLICT', 'historical_import_writer_required');
  await unlink(path.join(root, '.git', 'objects', sourceCommit.slice(0, 2), sourceCommit.slice(2)));
  const readable = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(readable.members.find(({ descriptor }) => descriptor.plan_key === 'archive')
    .tasks.every(({ evidence_unverified }) => evidence_unverified), true);
  const writable = await readTodoStore({ repoRoot: root, now: NOW, forWrite: true });
  assert.equal(writable.members.find(({ descriptor }) => descriptor.plan_key === 'archive')
    .tasks.every(({ evidence_unverified }) => evidence_unverified), true);
});

test('上限超過pinned source blobはbatch予算に収まっても未検証として拒否する', async (context) => {
  const root = await workspace(context);
  const prefix = Buffer.from('# Imported plan\n- [x] A1\n- [x] A2\n');
  const sourceCommit = pinnedMarkdownCommit(root, Buffer.concat([
    prefix, Buffer.alloc(TODO_LIMITS.narrativeSectionBytes + 1 - prefix.length, 0x61),
  ]));
  await expectCode(appendImportedPlan(importedPlanRequest(root, { sourceCommit })),
    'STORE_INCONSISTENT', 'import_source_unverified');
});

// git呼び出し回数を数えるshimはshebang+PATH解決というPOSIX exec意味論が前提。
// WindowsのCreateProcessは.exeしか自動解決せず拡張子なしshim/.cmdはexecFileから見えないため、
// この計数fixtureはPOSIXだけで成立する（検証対象の読み取り回数最適化自体はOS非依存）。
test('同一pinned sourceのread-time検証はstore read内でcommitとblobを一度だけ読む',
  { skip: process.platform === 'win32' }, async (context) => {
  const root = await workspace(context);
  await appendImportedPlan(importedPlanRequest(root));
  const shimDirectory = path.join(root, 'git-shim');
  const counter = path.join(root, 'git-count');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await mkdir(shimDirectory);
  await writeFile(path.join(shimDirectory, 'git'), [
    '#!/bin/sh',
    'printf x >> "$LATTICE_GIT_COUNT_FILE"',
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n'));
  await chmod(path.join(shimDirectory, 'git'), 0o700);
  const previousPath = process.env.PATH;
  const previousCounter = process.env.LATTICE_GIT_COUNT_FILE;
  process.env.PATH = `${shimDirectory}:${previousPath}`;
  process.env.LATTICE_GIT_COUNT_FILE = counter;
  try {
    const store = await readTodoStore({ repoRoot: root, now: NOW });
    assert.equal(store.members.find(({ plan }) => plan.plan_key === 'archive').tasks.length, 2);
  } finally {
    process.env.PATH = previousPath;
    if (previousCounter === undefined) delete process.env.LATTICE_GIT_COUNT_FILE;
    else process.env.LATTICE_GIT_COUNT_FILE = previousCounter;
  }
  // commit型検査+blob読みはcat-file --batch 1回へ統合された（0.52.4: git子起動の雪崩防止）
  assert.equal((await readFile(counter, 'utf8')).length, 1);
});

// narrativeSectionBytes超のevidence blobは単体読みのbytes上限で拒否され未検証注釈になる。
// prefetchのbatch同乗（maxBufferが件数×予算）で検証済みへ昇格させないことを固定する。
test('上限超過evidence blobはprefetch経由でも未検証注釈のまま変わらない', async (context) => {
  const root = await workspace(context);
  // 通常writerは書込時hard検証で上限超過evidenceを拒むので、読み手の挙動固定には
  // journalを直接構築する（1 MiB seal testと同じ手口）。
  const events = [JSON.parse((await bytes(root, journalRef)).toString('utf8'))];
  const append = (kind, taskId, payload) => {
    const previous = events.at(-1);
    const event = { schema: 'lattice.todo_event.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      sequence: previous.sequence + 1, previous_digest: previous.event_digest, kind, task_id: taskId, actor: ACTOR,
      recorded_at: NOW, provenance: null, payload, event_digest: '' };
    event.event_digest = todoSelfDigest(event, 'event_digest');
    events.push(event);
  };
  // 到達可能性検査（rev-list --all）を通すため、blobはdanglingでなくcommit済みにする。
  const evidenceFor = async (name, evidenceBytes) => {
    await writeFile(path.join(root, `${name}.txt`), evidenceBytes);
    execFileSync('git', ['add', `${name}.txt`], { cwd: root });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', name], { cwd: root });
    const oid = execFileSync('git', ['rev-parse', `HEAD:${name}.txt`], { cwd: root, encoding: 'utf8' }).trim();
    return { evidence_id: name, repo_id: 'self', path: `${name}.txt`, git_blob_oid: oid,
      content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
      media_type: 'text/plain', anchor_digest: null };
  };
  // 小さいblobも同乗させ、batch prefetchが上限内だけをseedした後の個別検証を固定する。
  append('start', 'T1', { override_reason: null });
  append('done', 'T1', { done_mode: 'authored', imported: false,
    evidence: await evidenceFor('ev-small', Buffer.from('small evidence\n')) });
  append('start', 'T2', { override_reason: null });
  append('done', 'T2', { done_mode: 'authored', imported: false,
    evidence: await evidenceFor('ev-oversized', Buffer.alloc(TODO_LIMITS.narrativeSectionBytes + 1, 0x61)) });
  await writeFile(path.join(root, journalRef), `${events.map(canonicalizeTodoArtifact).join('\n')}\n`);
  const manifest = JSON.parse((await bytes(root, manifestRef)).toString('utf8'));
  manifest.members[0].journal_head_digest = events.at(-1).event_digest;
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  await writeFile(path.join(root, manifestRef), `${canonicalizeTodoArtifact(manifest)}\n`);
  await rebuildTodoSnapshot({ repoRoot: root, planKey: 'main', now: NOW });
  // module cacheの温まりに依存しない判定にするため、statusと同じ新processで読む。
  const storeUrl = new URL('../src/todo-store.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', [
    `const { readTodoStore } = await import(${JSON.stringify(storeUrl)});`,
    `const store = await readTodoStore({ repoRoot: ${JSON.stringify(root)}, now: ${JSON.stringify(NOW)} });`,
    'console.log(JSON.stringify(store.members[0].tasks.map(({ task_id, evidence_unverified }) => [task_id, evidence_unverified === true])));',
  ].join('\n')], { encoding: 'utf8' });
  const rows = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(rows.find(([taskId]) => taskId === 'T1')[1], false,
    '上限内の到達可能blobは検証済みになる（fixture健全性）');
  assert.equal(rows.find(([taskId]) => taskId === 'T2')[1], true,
    '上限超過blobがprefetchのbatch同乗で検証済みへ昇格してはならない');
});

// 上と同じPOSIX前提の計数fixture。evidence blob読みがtaskごとのgit子起動へ戻る退行を防ぐ。
test('store readはevidence blobを1回のcat-file --batchへ集約して読む',
  { skip: process.platform === 'win32' }, async (context) => {
  const root = await workspace(context);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  for (const [taskId, body] of [['T1', 'evidence one\n'], ['T2', 'evidence two\n']]) {
    const evidenceBytes = Buffer.from(body);
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root, input: evidenceBytes, encoding: 'utf8',
    }).trim();
    const evidence = { evidence_id: `ev-${taskId}`, repo_id: 'self', path: `${taskId}.txt`,
      git_blob_oid: oid, content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
      media_type: 'text/plain', anchor_digest: null };
    await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
      event: { kind: 'start', task_id: taskId, actor: ACTOR, recorded_at: NOW,
        payload: { override_reason: null } } });
    await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
      event: { kind: 'done', task_id: taskId, actor: ACTOR, recorded_at: NOW,
        payload: { evidence } } });
  }
  const shimDirectory = path.join(root, 'git-shim');
  const counter = path.join(root, 'git-count');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await mkdir(shimDirectory);
  await writeFile(path.join(shimDirectory, 'git'), [
    '#!/bin/sh',
    'printf x >> "$LATTICE_GIT_COUNT_FILE"',
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n'));
  await chmod(path.join(shimDirectory, 'git'), 0o700);
  // module内cache（evidenceBlobCache等）が温まった本processでは集約経路を観測できないため、
  // statusと同じ「新しいprocessでの初回store読み」を子processで再現して数える。
  const storeUrl = new URL('../src/todo-store.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', [
    `const { readTodoStore } = await import(${JSON.stringify(storeUrl)});`,
    `const store = await readTodoStore({ repoRoot: ${JSON.stringify(root)}, now: ${JSON.stringify(NOW)} });`,
    'console.log(JSON.stringify(store.members[0].tasks.map(({ task_id, status }) => [task_id, status])));',
  ].join('\n')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}`, LATTICE_GIT_COUNT_FILE: counter },
  });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), [['T1', 'done'], ['T2', 'done']]);
  // evidence blobのprefetch batch 1回 + 到達可能性のrev-list 1回だけ。taskごとの個別起動は許さない。
  assert.equal((await readFile(counter, 'utf8')).length, 2);
});

test('historical doneはlatent start付きdoneとしてchain/ganttへ投影し依存順を捏造しない', async (context) => {
  const root = await workspace(context);
  const result = await appendImportedPlan(importedPlanRequest(root));
  assert.equal(result.genesis.payload.historical_import, true);
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const archive = store.members.find(({ descriptor }) => descriptor.plan_key === 'archive');
  assert.deepEqual(archive.tasks.map(({ task_id, status, started_at, done_at, imported }) =>
    [task_id, status, started_at, done_at, imported]), [
    ['A1', 'done', null, NOW, true], ['A2', 'done', null, null, true],
  ]);
  const chain = projectTodoChainV1(todoTopology(store));
  // ここで見るのは状態投影と依存順であり表示密度ではないため、完全投影のscopeで確認する。
  const layout = layoutTodoGantt(store, { scope: 'all' });
  assert.deepEqual(layout.nodes.filter(({ ref: taskRef }) => taskRef.plan_key === 'archive')
    .map(({ ref: taskRef, status }) => [taskRef.task_id, status]), [['A1', 'done'], ['A2', 'done']]);
});

test('historical startはappendImportedPlanだけがactiveとして輸入しdone重複を無変更拒否する', async (context) => {
  const root = await workspace(context);
  const request = importedPlanRequest(root);
  const activeSource = request.completedTasks.find(({ task_id: taskId }) => taskId === 'A1').evidence;
  request.inProgressTasks = [{
    task_id: 'A1', started_at: 'unknown_requires_evidence', evidence: activeSource,
  }];
  request.completedTasks = request.completedTasks.filter(({ task_id: taskId }) => taskId === 'A2');
  const imported = await appendImportedPlan(request);
  const start = imported.events.find(({ kind }) => kind === 'start');
  assert.deepEqual(start.payload, {
    start_mode: 'historical_import', imported: true, status: 'in-progress',
    started_at: 'unknown_requires_evidence', evidence: activeSource,
  });
  const archive = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive');
  assert.deepEqual(archive.tasks.map(({ task_id, status, started_at, evidence, imported: fromImport }) => (
    [task_id, status, started_at, evidence, fromImport]
  )), [
    ['A1', 'in-progress', null, activeSource, true],
    ['A2', 'done', null, request.completedTasks[0].evidence, true],
  ]);

  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'archive', now: NOW,
    event: { kind: 'start', task_id: 'A1', actor: ACTOR, recorded_at: NOW, payload: start.payload } }),
  'STORE_WRITE_CONFLICT', 'historical_import_writer_required');

  const conflictingRoot = await workspace(context);
  const conflicting = importedPlanRequest(conflictingRoot);
  conflicting.inProgressTasks = [{ task_id: 'A1', started_at: NOW,
    evidence: conflicting.completedTasks.find(({ task_id: taskId }) => taskId === 'A1').evidence }];
  await expectCode(appendImportedPlan(conflicting), 'STORE_INCONSISTENT', 'historical_import_disposition_conflict');
  assert.deepEqual((await readTodoStore({ repoRoot: conflictingRoot, now: NOW })).members
    .map(({ descriptor }) => descriptor.plan_key), ['main']);

  const blockedRoot = await workspace(context);
  const blocked = importedPlanRequest(blockedRoot);
  const blockedSource = blocked.completedTasks.find(({ task_id: taskId }) => taskId === 'A1').evidence;
  blocked.completedTasks = blocked.completedTasks.filter(({ task_id: taskId }) => taskId === 'A2');
  blocked.inProgressTasks = [{ task_id: 'A1', started_at: NOW, evidence: blockedSource, status: 'blocked' }];
  await expectCode(appendImportedPlan(blocked), 'STORE_INCONSISTENT', 'historical_import_disposition_invalid');
  assert.deepEqual((await readTodoStore({ repoRoot: blockedRoot, now: NOW })).members
    .map(({ descriptor }) => descriptor.plan_key), ['main']);
});

test('unknown historical doneは正規evidenceへ新eventで昇格しreopenでin-progressへ戻る', async (context) => {
  const root = await workspace(context);
  const imported = await appendImportedPlan(importedPlanRequest(root));
  const sourceEvent = imported.events.find(({ task_id }) => task_id === 'A2');
  const sourceBytes = Buffer.from('promoted evidence\n');
  await writeFile(path.join(root, 'promoted.txt'), sourceBytes);
  const oid = execFileSync('git', ['hash-object', '-w', 'promoted.txt'], { cwd: root, encoding: 'utf8' }).trim();
  const evidence = { evidence_id: 'promoted', repo_id: 'self', path: 'promoted.txt', git_blob_oid: oid,
    content_digest: createHash('sha256').update(sourceBytes).digest('hex'), media_type: 'text/plain', anchor_digest: null };
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const promotion = await appendTodoEvent({ repoRoot: root, writer, planKey: 'archive', now: NOW,
    event: { kind: 'done', task_id: 'A2', actor: ACTOR, recorded_at: NOW,
      payload: { done_mode: 'evidence_promotion', imported: true, evidence } } });
  assert.equal(promotion.event.payload.target_done_digest, sourceEvent.event_digest);
  let state = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive').tasks.find(({ task_id }) => task_id === 'A2');
  assert.equal(state.status, 'done'); assert.deepEqual(state.evidence, evidence); assert.equal(state.done_at, null);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'archive', now: NOW,
    event: { kind: 'reopen', task_id: 'A2', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'correct history', override_reason: null } } });
  state = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'archive').tasks.find(({ task_id }) => task_id === 'A2');
  assert.equal(state.status, 'in-progress'); assert.equal(state.started_at, null); assert.equal(state.evidence, null);
  assert.equal(state.imported, true);
});

test('authored doneはpending/blockedを許さず従来のhard evidence検証も維持する', async (context) => {
  const root = await workspace(context);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const invalidEvidence = { evidence_id: 'missing', repo_id: 'self', path: 'missing.txt', git_blob_oid: 'f'.repeat(40),
    content_digest: 'e'.repeat(64), media_type: 'text/plain', anchor_digest: null };
  const authored = { done_mode: 'authored', imported: false, evidence: invalidEvidence };
  const before = await bytes(root, journalRef);
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: authored } }),
  'STORE_INCONSISTENT', 'invalid_done_transition');
  assert.deepEqual(await bytes(root, journalRef), before);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: authored } }),
  'STORE_INCONSISTENT', 'evidence_unverified');
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'block', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { reason: 'blocked' } } });
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: authored } }),
  'STORE_INCONSISTENT', 'invalid_done_transition');
});

// 一度もcommitされないままGCで消えたblobを指す旧doneがjournalに残ると、hard検証が
// 全書き込みを恒久拒否していた（2026-08-22実被弾: reopen済み旧doneのdangling blob）。
// hard検証は現在状態を支える記述子だけに掛かることを固定する。
async function danglingDoneFixture(context, { replace }) {
  const root = await workspace(context);
  const events = [JSON.parse((await bytes(root, journalRef)).toString('utf8'))];
  const append = (kind, taskId, payload) => {
    const previous = events.at(-1);
    const event = { schema: 'lattice.todo_event.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      sequence: previous.sequence + 1, previous_digest: previous.event_digest, kind, task_id: taskId, actor: ACTOR,
      recorded_at: NOW, provenance: null, payload, event_digest: '' };
    event.event_digest = todoSelfDigest(event, 'event_digest');
    events.push(event);
  };
  const vanished = { evidence_id: 'vanished', repo_id: 'self', path: 'vanished.txt',
    git_blob_oid: '0123456789abcdef0123456789abcdef01234567',
    content_digest: 'a'.repeat(64), media_type: 'text/plain', anchor_digest: null };
  append('start', 'T1', { override_reason: null });
  append('done', 'T1', { done_mode: 'authored', imported: false, evidence: vanished });
  if (replace) {
    append('reopen', 'T1', { reason: 'evidence replaced',
      target_done_digest: events.at(-1).event_digest, override_reason: null });
    const replacedBytes = Buffer.from('replaced evidence\n');
    await writeFile(path.join(root, 'replaced.txt'), replacedBytes);
    execFileSync('git', ['add', 'replaced.txt'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'replaced'], { cwd: root });
    const oid = execFileSync('git', ['rev-parse', 'HEAD:replaced.txt'], { cwd: root, encoding: 'utf8' }).trim();
    append('done', 'T1', { done_mode: 'authored', imported: false,
      evidence: { evidence_id: 'replaced', repo_id: 'self', path: 'replaced.txt', git_blob_oid: oid,
        content_digest: createHash('sha256').update(replacedBytes).digest('hex'),
        media_type: 'text/plain', anchor_digest: null } });
  }
  await writeFile(path.join(root, journalRef), `${events.map(canonicalizeTodoArtifact).join('\n')}\n`);
  const manifest = JSON.parse((await bytes(root, manifestRef)).toString('utf8'));
  manifest.members[0].journal_head_digest = events.at(-1).event_digest;
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  await writeFile(path.join(root, manifestRef), `${canonicalizeTodoArtifact(manifest)}\n`);
  await rebuildTodoSnapshot({ repoRoot: root, planKey: 'main', now: NOW });
  return root;
}

test('reopenで差し替え済みの旧doneが指す消えたblobは書き込みhard検証の対象外になる', async (context) => {
  const root = await danglingDoneFixture(context, { replace: true });
  const writable = await readTodoStore({ repoRoot: root, now: NOW, forWrite: true });
  assert.equal(writable.members[0].tasks.find(({ task_id }) => task_id === 'T1').evidence_unverified, false);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const started = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  assert.equal(started.event.kind, 'start');
});

test('現在のdoneが指す消えたblobは未検証と表示し、別taskの開始を止めない', async (context) => {
  const root = await danglingDoneFixture(context, { replace: false });
  const writable = await readTodoStore({ repoRoot: root, now: NOW, forWrite: true });
  assert.equal(writable.members[0].tasks.find(({ task_id }) => task_id === 'T1').evidence_unverified, true);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const started = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  assert.equal(started.event.kind, 'start');
  const after = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(after.members[0].tasks.find(({ task_id }) => task_id === 'T1').evidence_unverified, true);
});
