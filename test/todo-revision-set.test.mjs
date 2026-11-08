import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { runTodoCli } from '../src/todo-cli.mjs';
import {
  TodoStoreError,
  applyTodoRevision,
  applyTodoRevisionSet,
  buildTodoPlan,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';
import {
  todoCutoverArchiveSourceRef,
  phaseTodoRevisionPlanVersion,
  todoLegacyReconciliationDigest,
  todoReconciliationDigest,
  todoRevisionPlanVersion,
  todoSourceInventoryDigest,
} from '../src/todo-revision.mjs';

const NOW = '2026-07-20T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const task = (taskId, title = taskId) => ({
  task_id: taskId, title, lane: 'main', narrative_ref: null,
  narrative_anchor: null, compile_binding: null, parent_task_id: null,
});
const phaseTask = (taskId, phaseId) => ({ ...task(taskId), phase_id: phaseId });
const ref = (planKey, taskId, expectedTopologyDigest) => ({
  project_id: 'project-1', plan_key: planKey, task_id: taskId,
  ...(expectedTopologyDigest === undefined ? {} : { expected_topology_digest: expectedTopologyDigest }),
});

async function fixture(context, { designMemos = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-revision-set-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'a.md'), '- [ ] A1\n');
  await writeFile(path.join(root, 'b.md'), '- [ ] B1\n');
  const upstream = buildTodoPlan({
    schema: designMemos ? 'lattice.todo_plan.v6' : 'lattice.todo_plan.v3',
    project_id: 'project-1', plan_key: 'b', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [{ ...task('B1'), ...(designMemos ? { design_memo: 'B1の設計メモ' } : {}) }],
    hard_dependencies: [], joins: [],
  });
  const downstream = {
    schema: designMemos ? 'lattice.todo_plan.v6' : 'lattice.todo_plan.v3',
    project_id: 'project-1', plan_key: 'a', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [{ ...task('A1'), ...(designMemos ? { design_memo: 'A1の設計メモ' } : {}) }],
    hard_dependencies: [{
      from: ref('b', 'B1', upstream.topology_digest),
      to: ref('a', 'A1'),
    }],
    joins: [],
  };
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: downstream, genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: upstream, genesis: { actor: ACTOR, recorded_at: NOW } },
    ],
    now: NOW,
  });
  return root;
}

async function phaseFixture(context, { downstreamPhase = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-revision-set-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'a.md'), '- [ ] A1\n');
  const phase = [{ phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }];
  const upstream = buildTodoPlan({
    schema: 'lattice.todo_plan.v4', project_id: 'project-1', plan_key: 'b', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [phaseTask('B1', 'phase-1')], phases: phase,
    hard_dependencies: [], joins: [],
  });
  const downstream = buildTodoPlan(downstreamPhase ? {
    schema: 'lattice.todo_plan.v4', project_id: 'project-1', plan_key: 'a', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [phaseTask('A1', 'phase-1')], phases: phase,
    hard_dependencies: [{ from: ref('b', 'B1', upstream.topology_digest), to: ref('a', 'A1') }], joins: [],
  } : {
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'a', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('A1')],
    hard_dependencies: [{ from: ref('b', 'B1', upstream.topology_digest), to: ref('a', 'A1') }], joins: [],
  });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], plans: [
      { plan: downstream, genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: upstream, genesis: { actor: ACTOR, recorded_at: NOW } },
    ], now: NOW });
  return root;
}

function phaseRevisionFor(member, hardDependencies) {
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const taskId = member.plan.tasks[0].task_id;
  const taskMigration = [{ from_task_id: taskId, to_task_id: taskId, state_policy: 'reset_pending' }];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredInput = structuredClone(member.plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.plan_version = 'pending'; desiredInput.predecessor_plan_digest = predecessor.plan_digest;
  desiredInput.hard_dependencies = hardDependencies;
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1',
    planKey: member.plan.plan_key, predecessor, desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  const revision = { schema: 'lattice.phase_todo_revision.v1', project_id: 'project-1',
    plan_key: member.plan.plan_key, predecessor, desired_plan: desiredPlan,
    task_migration: taskMigration, phase_migration: phaseMigration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

function revisionFor(member, { title, hardDependencies, sourceRef, sourceText, cutover = false }) {
  const predecessor = {
    plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version,
  };
  const taskId = member.plan.tasks[0].task_id;
  const taskMigration = [{ from_task_id: taskId, to_task_id: taskId, state_policy: 'reset_pending' }];
  let sourceCutoverBatch;
  if (cutover) {
    sourceCutoverBatch = {
      batch_id: `cutover-${member.plan.plan_key}`,
      archive_ref: `docs/archive/${member.plan.plan_key}-cutover.md`,
      operations: [{ task_id: taskId, disposition: 'active', source_ref: sourceRef,
        source_digest: digest(sourceText), live_replacement: `- Lattice管理: ${taskId}` }],
      batch_digest: '',
    };
    sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  }
  const narrativeRef = cutover ? todoCutoverArchiveSourceRef(sourceCutoverBatch, 0) : null;
  const sourceInventory = {
    active: [{ task_id: taskId, source_ref: narrativeRef ?? sourceRef, source_digest: digest(sourceText) }],
    excluded_tombstones: [],
  };
  const desiredInput = {
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: member.plan.plan_key,
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [{ ...task(taskId, title), narrative_ref: narrativeRef }],
    hard_dependencies: hardDependencies, joins: [],
  };
  desiredInput.plan_version = todoRevisionPlanVersion({
    projectId: 'project-1', planKey: member.plan.plan_key, predecessor,
    desiredPlan: desiredInput, taskMigration, sourceInventory,
    ...(cutover ? { sourceCutoverBatch } : {}),
  });
  const desiredPlan = buildTodoPlan(desiredInput);
  const predecessorReconciliationDigest = todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest,
  });
  const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
  const reconciliation = {
    predecessor_reconciliation_digest: predecessorReconciliationDigest,
    source_inventory_digest: sourceInventoryDigest,
    reconciliation_digest: todoReconciliationDigest({
      predecessorReconciliationDigest, sourceInventoryDigest, predecessor,
      desiredPlanDigest: desiredPlan.plan_digest, taskMigration,
      ...(cutover ? { sourceCutoverBatch } : {}),
    }),
  };
  const revision = {
    schema: cutover ? 'lattice.todo_revision.v2' : 'lattice.todo_revision.v1',
    project_id: 'project-1', plan_key: member.plan.plan_key,
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory,
    ...(cutover ? { source_cutover_batch: sourceCutoverBatch } : {}),
    reconciliation, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

async function revisions(root, { cutover = false } = {}) {
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const beforeA = store.members.find(({ descriptor }) => descriptor.plan_key === 'a');
  const beforeB = store.members.find(({ descriptor }) => descriptor.plan_key === 'b');
  const revisionB = revisionFor(beforeB, {
    title: 'B1 successor', hardDependencies: [], sourceRef: 'b.md#L1', sourceText: '- [ ] B1', cutover,
  });
  const revisionA = revisionFor(beforeA, {
    title: 'A1 successor', sourceRef: 'a.md#L1', sourceText: '- [ ] A1', cutover,
    hardDependencies: [{
      from: ref('b', 'B1', revisionB.desired_plan.topology_digest),
      to: ref('a', 'A1'),
    }],
  });
  return [revisionA, revisionB];
}

function revisionSet(revisionsValue, schema = 'lattice.todo_revision_set.v1') {
  const value = {
    schema, project_id: 'project-1',
    revisions: revisionsValue, revision_set_digest: '',
  };
  value.revision_set_digest = todoSelfDigest(value, 'revision_set_digest');
  return value;
}

test('cross-plan successorは一件ずつ公開でき、authored edgeはbinding_stale findingとして残る', async (context) => {
  const root = await fixture(context);
  const set = await revisions(root);
  await applyTodoRevision({
    repoRoot: root, writer, revision: set[1], actor: ACTOR, recordedAt: NOW, now: NOW,
  });
  const store = await readTodoStore({ repoRoot: root });
  assert.deepEqual(store.cross_plan_findings.map(({ owner_plan_key: owner, event_digest: event, side, reason }) => (
    [owner, event, side, reason])), [['a', null, 'from', 'binding_stale']]);
});

test('revision setはcross-plan successorsを同時activationしてfindingを残さない', async (context) => {
  const root = await fixture(context);
  const set = await revisions(root);
  const result = await applyTodoRevisionSet({
    repoRoot: root, writer, revisionSet: revisionSet(set), actor: ACTOR, recordedAt: NOW, now: NOW,
  });
  assert.equal(result.schema, 'lattice.todo_revision_set_result.v1');
  assert.equal(result.recovered, false);
  assert.deepEqual(result.members.map(({ plan_key }) => plan_key), ['a', 'b']);
  const active = await readTodoStore({ repoRoot: root });
  assert.deepEqual(active.cross_plan_findings, []);
  assert.deepEqual(active.members.map(({ plan }) => [plan.plan_key, plan.plan_version]), [
    ['a', set[0].desired_plan.plan_version], ['b', set[1].desired_plan.plan_version],
  ]);
});

test('revision setもv6からmemo無しschemaへの後退を一括activation前に拒否する', async (context) => {
  const root = await fixture(context, { designMemos: true });
  const set = revisionSet(await revisions(root));
  const before = await readFile(path.join(root, '.lattice/todo/manifest.json'));
  await assert.rejects(applyTodoRevisionSet({
    repoRoot: root, writer, revisionSet: set, actor: ACTOR, recordedAt: NOW, now: NOW,
  }), (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'design_memo_schema_downgrade');
  assert.deepEqual(await readFile(path.join(root, '.lattice/todo/manifest.json')), before);
});

test('revision set v3はcross-plan Phase successorsを一つのmanifestで同時activationする', async (context) => {
  const root = await phaseFixture(context);
  const before = await readTodoStore({ repoRoot: root, now: NOW });
  const memberA = before.members.find(({ plan }) => plan.plan_key === 'a');
  const memberB = before.members.find(({ plan }) => plan.plan_key === 'b');
  const revisionB = phaseRevisionFor(memberB, []);
  const revisionA = phaseRevisionFor(memberA, [{
    from: ref('b', 'B1', revisionB.desired_plan.topology_digest), to: ref('a', 'A1'),
  }]);
  const set = revisionSet([revisionA, revisionB], 'lattice.todo_revision_set.v3');
  await assert.rejects(applyTodoRevisionSet({ repoRoot: root, writer, revisionSet: set,
    actor: ACTOR, recordedAt: NOW, now: NOW,
    onProtocolStage(stage) {
      if (stage === 'revision_set_marker_durable') throw new Error('simulated phase set crash');
    },
  }), /simulated phase set crash/u);
  const retryTime = '2026-07-20T00:00:00.001Z';
  const result = await applyTodoRevisionSet({ repoRoot: root, writer, revisionSet: set,
    actor: ACTOR, recordedAt: retryTime, now: retryTime });
  assert.equal(result.recovered, false);
  const active = await readTodoStore({ repoRoot: root, now: retryTime });
  assert.deepEqual(active.members.map(({ plan, journal }) => [
    plan.plan_key, plan.plan_version, journal.events[0].schema,
  ]), [
    ['a', revisionA.desired_plan.plan_version, 'lattice.todo_event.v4'],
    ['b', revisionB.desired_plan.plan_version, 'lattice.todo_event.v4'],
  ]);
  assert.deepEqual(active.members.flatMap(({ snapshot }) => snapshot.phases.map(({ status }) => status)),
    ['active', 'active']);
});

test('revision set v3はPhase revisionと通常revisionを混在して同時activationする', async (context) => {
  const root = await phaseFixture(context, { downstreamPhase: false });
  const before = await readTodoStore({ repoRoot: root, now: NOW });
  const memberA = before.members.find(({ plan }) => plan.plan_key === 'a');
  const memberB = before.members.find(({ plan }) => plan.plan_key === 'b');
  const revisionB = phaseRevisionFor(memberB, []);
  const revisionA = revisionFor(memberA, { title: 'A1 successor', sourceRef: 'a.md#L1',
    sourceText: '- [ ] A1', hardDependencies: [{
      from: ref('b', 'B1', revisionB.desired_plan.topology_digest), to: ref('a', 'A1'),
    }] });
  const set = revisionSet([revisionA, revisionB], 'lattice.todo_revision_set.v3');
  await writeFile(path.join(root, 'phase-revision-set.json'), `${canonicalizeTodoArtifact(set)}\n`);
  let stdout = ''; let stderr = '';
  const exit = await runTodoCli({ argv: ['revise-set', '--input', 'phase-revision-set.json'], cwd: root,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    env: { LATTICE_TODO_ACTOR_HOST: ACTOR.host, LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
      LATTICE_TODO_ACTOR_AGENT: ACTOR.agent, LATTICE_DASHBOARD_AUTOSTART: '0' } });
  assert.equal(exit, 0, stderr);
  assert.equal(JSON.parse(stdout).revision_set_digest, set.revision_set_digest);
  const active = await readTodoStore({ repoRoot: root });
  assert.deepEqual(active.members.map(({ plan, journal }) => [plan.plan_key, journal.events[0].schema]), [
    ['a', 'lattice.todo_event.v2'], ['b', 'lattice.todo_event.v4'],
  ]);
});

test('todo revise-set CLIはcanonical setだけを受理して一行JSONを返す', async (context) => {
  const root = await fixture(context);
  const set = revisionSet(await revisions(root));
  await writeFile(path.join(root, 'revision-set.json'), `${canonicalizeTodoArtifact(set)}\n`);
  let stdout = ''; let stderr = '';
  const exit = await runTodoCli({
    argv: ['revise-set', '--input', 'revision-set.json'], cwd: root,
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    env: {
      LATTICE_TODO_ACTOR_HOST: ACTOR.host,
      LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
      LATTICE_TODO_ACTOR_AGENT: ACTOR.agent,
      LATTICE_DASHBOARD_AUTOSTART: '0',
    },
  });
  assert.equal(exit, 0, stderr);
  assert.equal(stderr, '');
  const output = JSON.parse(stdout);
  assert.equal(output.schema, 'lattice.todo_revision_set_result.v1');
  assert.equal(output.revision_set_digest, set.revision_set_digest);
});

test('revision setはmanifest activation後のretryをexact recoveredとして閉じる', async (context) => {
  const root = await fixture(context);
  const set = await revisions(root);
  await assert.rejects(applyTodoRevisionSet({
    repoRoot: root, writer, revisions: set, actor: ACTOR, recordedAt: NOW, now: NOW,
    onProtocolStage(stage) {
      if (stage === 'revision_set_manifest_activated') throw new Error('simulated crash');
    },
  }), /simulated crash/u);
  const recovered = await applyTodoRevisionSet({
    repoRoot: root, writer, revisions: set, actor: ACTOR, recordedAt: NOW, now: NOW,
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.result_digest, todoSelfDigest(recovered, 'result_digest'));
});

test('revision setはmarker後停止から異なる再試行時刻でもdurable genesisへ収束する', async (context) => {
  const root = await fixture(context);
  const set = await revisions(root);
  await assert.rejects(applyTodoRevisionSet({
    repoRoot: root, writer, revisions: set, actor: ACTOR, recordedAt: NOW, now: NOW,
    onProtocolStage(stage) {
      if (stage === 'revision_set_marker_durable') throw new Error('simulated marker crash');
    },
  }), /simulated marker crash/u);
  const retryTime = '2026-07-20T00:00:00.001Z';
  const result = await applyTodoRevisionSet({
    repoRoot: root, writer, revisions: set, actor: ACTOR, recordedAt: retryTime, now: retryTime,
  });
  assert.equal(result.recovered, false);
  assert.equal((await readTodoStore({ repoRoot: root, now: retryTime })).members.length, 2);
});

test('revision set v2は複数planのsource cutoverも一つのbarrierで公開する', async (context) => {
  const root = await fixture(context);
  const set = revisionSet(await revisions(root, { cutover: true }), 'lattice.todo_revision_set.v2');
  const result = await applyTodoRevisionSet({
    repoRoot: root, writer, revisionSet: set, actor: ACTOR, recordedAt: NOW, now: NOW,
  });
  assert.equal(result.recovered, false);
  assert.equal((await readFile(path.join(root, 'a.md'), 'utf8')), '- Lattice管理: A1\n');
  assert.equal((await readFile(path.join(root, 'b.md'), 'utf8')), '- Lattice管理: B1\n');
  assert.match(await readFile(path.join(root, 'docs/archive/a-cutover.md'), 'utf8'), /- \[ \] A1/u);
  assert.match(await readFile(path.join(root, 'docs/archive/b-cutover.md'), 'utf8'), /- \[ \] B1/u);
  await assert.rejects(readFile(path.join(root, '.lattice/todo/source-cutover-recovery.json')),
    (error) => error?.code === 'ENOENT');
});

test('revision set v2はsource一件目で停止してもopenだけで同じsetを復旧する', async (context) => {
  const root = await fixture(context);
  const set = revisionSet(await revisions(root, { cutover: true }), 'lattice.todo_revision_set.v2');
  await assert.rejects(applyTodoRevisionSet({
    repoRoot: root, writer, revisionSet: set, actor: ACTOR, recordedAt: NOW, now: NOW,
    onProtocolStage(stage) {
      if (stage === 'revision_set_source_published_0') throw new Error('simulated source crash');
    },
  }), /simulated source crash/u);
  const reopened = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(reopened.members.map(({ plan }) => plan.plan_digest), set.revisions.map(({ desired_plan: plan }) => plan.plan_digest));
  const recovered = await applyTodoRevisionSet({
    repoRoot: root, writer, revisionSet: set, actor: ACTOR, recordedAt: NOW, now: NOW,
  });
  assert.equal(recovered.recovered, true);
  assert.equal((await readFile(path.join(root, 'a.md'), 'utf8')), '- Lattice管理: A1\n');
  assert.equal((await readFile(path.join(root, 'b.md'), 'utf8')), '- Lattice管理: B1\n');
  assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).members.length, 2);
});
