import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canonicalizeTodoArtifact, digestTodoArtifact, todoSelfDigest, validateTodoManifest,
  validateTodoPlan,
} from '../src/todo-contracts.mjs';
import {
  phaseTodoRevisionPlanVersion, todoLegacyReconciliationDigest, validatePhaseTodoRevision,
} from '../src/todo-revision.mjs';
import { projectTodoStatus } from '../src/todo-status.mjs';
import {
  appendTodoEvent, applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter,
  initializeTodoStore, readTodoStore, verifyPhaseTodoRevisionSources,
} from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = { host: 'host-1', session: 'session-1', agent: 'agent-1' };
const INITIAL_AT = '2026-07-21T00:00:00.000Z';
const COMMIT_AT = '2026-07-21T00:00:01.000Z';
const ref = (taskId) => ({ project_id: 'project-1', plan_key: 'main', task_id: taskId });
const migrationDigest = (migration) => todoSelfDigest(migration, 'migration_digest');
const todoMigrationDigest = (migration) => todoSelfDigest({
  task_migration: migration, task_migration_digest: '',
}, 'task_migration_digest');

function manifestV2Fixture(activeRevisionDigest = 'a'.repeat(64)) {
  const manifest = { schema: 'lattice.todo_manifest.v2', project_id: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }], members: [{ plan_key: 'main',
      active_plan_version: 'v2', active_revision_digest: activeRevisionDigest,
      plan_ref: '.lattice/todo/plans/main/v2/plan.json',
      journal_ref: '.lattice/todo/plans/main/v2/journal/active.jsonl',
      snapshot_ref: '.lattice/todo/plans/main/v2/snapshot.json',
      topology_digest: 'b'.repeat(64), journal_head_digest: 'c'.repeat(64) }],
    manifest_digest: '' };
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  return manifest;
}

async function fixture(t, {
  initialEdge = false, desiredEdge = true, crlf = false, carryT2 = false, t2Status = 'pending',
  digestCrlf = crlf, initialDesignMemo = null, desiredDesignMemo = null, t1StatePolicy = 'carry',
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-v3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const phase = { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const task = (taskId, line) => ({ task_id: taskId, title: taskId, lane: 'main',
    ...(initialDesignMemo === null ? {} : { design_memo: `${initialDesignMemo} ${taskId}` }),
    narrative_ref: `.lattice/todo/source-ledger/cutover.md#L${line}`,
    narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' });
  const initial = buildTodoPlan({ schema: initialDesignMemo === null
    ? 'lattice.todo_plan.v5' : 'lattice.todo_plan.v7', project_id: 'project-1',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [task('T1', 6), task('T2', 7)], phases: [phase],
    hard_dependencies: initialEdge ? [{ from: ref('T1'), to: ref('T2') }] : [],
    joins: [], phase_accept_dependencies: [] });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: initial, genesis: { actor: ACTOR, recorded_at: INITIAL_AT } }], now: INITIAL_AT });
  // 証拠blobはcommitまでして参照可能にする。`hash-object -w`だけだとdangling objectになり、
  // 手元では読めてもcloneした人には読めない。`todo verify`はその区別をするようになった。
  const evidenceBytes = Buffer.from('phase-v3 done evidence\n');
  await writeFile(path.join(root, 'evidence.txt'), evidenceBytes);
  execFileSync('git', ['add', 'evidence.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
    'commit', '--quiet', '-m', 'evidence'], { cwd: root });
  const oid = execFileSync('git', ['rev-parse', 'HEAD:evidence.txt'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const evidence = { evidence_id: 'phase-v3-done', repo_id: 'self', path: 'evidence.txt',
    git_blob_oid: oid, content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: INITIAL_AT,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: INITIAL_AT,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: INITIAL_AT,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: INITIAL_AT,
      payload: { evidence } } });
  if (['in-progress', 'blocked'].includes(t2Status)) {
    await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: INITIAL_AT,
      event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: INITIAL_AT,
        payload: { override_reason: null } } });
  }
  if (t2Status === 'blocked') {
    await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: INITIAL_AT,
      event: { kind: 'block', task_id: 'T2', actor: ACTOR, recorded_at: INITIAL_AT,
        payload: { reason: 'blocked during recompile' } } });
  }
  const member = (await readTodoStore({ repoRoot: root, now: INITIAL_AT })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1', entries: [
    { predecessor_task_id: 'T1', disposition: 'carry', successor_task_ids: ['T1'],
      reason: 'completed task survives recompile', evidence_digests: ['1'.repeat(64)] },
    { predecessor_task_id: 'T2', disposition: carryT2 ? 'carry' : 'replace', successor_task_ids: ['T2'],
      reason: 'unfinished task restarts pending', evidence_digests: ['2'.repeat(64)] },
  ], migration_digest: '' };
  runtimeTaskMigration.migration_digest = migrationDigest(runtimeTaskMigration);
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: t1StatePolicy },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: carryT2 ? 'carry' : 'reset_pending' },
  ];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredSeed = { ...member.plan, plan_version: 'pending',
    predecessor_plan_digest: predecessor.plan_digest,
    hard_dependencies: desiredEdge ? [{ from: ref('T1'), to: ref('T2') }] : [] };
  if (desiredDesignMemo !== null) {
    if (initialDesignMemo === null) desiredSeed.schema = 'lattice.todo_plan.v7';
    desiredSeed.tasks = desiredSeed.tasks.map((entry) => ({
      ...entry,
      design_memo: entry.task_id === 'T1' ? desiredDesignMemo : entry.design_memo ?? 'NO_PLAN',
    }));
  }
  delete desiredSeed.topology_digest; delete desiredSeed.plan_digest;
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredSeed, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredSeed);
  const sourceTexts = ['- [ ] T1 source', '- [ ] T2 source'];
  const sourceLines = sourceTexts
    .map((line) => `${line}${crlf ? '\r' : ''}`);
  const sourceCutoverBatch = { batch_id: 'phase-v3-cutover',
    archive_ref: '.lattice/todo/source-ledger/cutover.md', operations: sourceTexts.map((line, index) => ({
      task_id: `T${index + 1}`, disposition: 'active', source_ref: `docs/plan.md#L${index + 1}`,
      source_digest: createHash('sha256').update(`${line}${digestCrlf ? '\r' : ''}`).digest('hex'),
      live_replacement: `- T${index + 1} state is managed by Lattice`,
    })), batch_digest: '' };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const sourceInventory = { active: sourceCutoverBatch.operations.map((operation, index) => ({
    task_id: operation.task_id, source_ref: `${sourceCutoverBatch.archive_ref}#L${index + 6}`,
    source_digest: operation.source_digest,
  })), excluded_tombstones: [] };
  const reconciliation = { predecessor_reconciliation_digest: todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest }),
  source_inventory_digest: digestTodoArtifact(sourceInventory),
  desired_plan_digest: desiredPlan.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: todoMigrationDigest(taskMigration),
  phase_migration_digest: digestTodoArtifact(phaseMigration),
  source_cutover_batch_digest: sourceCutoverBatch.batch_digest, reconciliation_digest: '' };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const revision = { schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration, task_migration: taskMigration,
    phase_migration: phaseMigration, source_inventory: sourceInventory, reconciliation,
    source_cutover_batch: sourceCutoverBatch, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'plan.md'), `${sourceLines.join('\n')}\n`);
  return { root, revision, writer };
}

function competingRevision(revision) {
  const value = structuredClone(revision);
  value.source_cutover_batch.operations[0].live_replacement = '- T1 competing replacement';
  value.source_cutover_batch.batch_digest = todoSelfDigest(value.source_cutover_batch, 'batch_digest');
  value.reconciliation.source_cutover_batch_digest = value.source_cutover_batch.batch_digest;
  value.reconciliation.reconciliation_digest = todoSelfDigest(value.reconciliation,
    'reconciliation_digest');
  value.revision_digest = todoSelfDigest(value, 'revision_digest');
  return value;
}

function competingVersionRevision(revision) {
  const value = structuredClone(revision);
  const desiredInput = structuredClone(value.desired_plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.tasks.find(({ task_id }) => task_id === 'T2').title = 'competing T2';
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: value.project_id,
    planKey: value.plan_key, predecessor: value.predecessor, desiredPlan: desiredInput,
    taskMigration: value.task_migration, phaseMigration: value.phase_migration });
  value.desired_plan = buildTodoPlan(desiredInput);
  value.reconciliation.desired_plan_digest = value.desired_plan.plan_digest;
  value.reconciliation.reconciliation_digest = todoSelfDigest(value.reconciliation,
    'reconciliation_digest');
  value.revision_digest = todoSelfDigest(value, 'revision_digest');
  return value;
}

test('todo_manifest.v2はactive_revision_digestをexact必須化しv1を読み続ける', () => {
  const v2 = manifestV2Fixture();
  assert.equal(validateTodoManifest(v2), true);
  const missing = structuredClone(v2);
  delete missing.members[0].active_revision_digest;
  missing.manifest_digest = todoSelfDigest(missing, 'manifest_digest');
  assert.equal(validateTodoManifest(missing), false);
  const v1 = structuredClone(v2);
  v1.schema = 'lattice.todo_manifest.v1';
  delete v1.members[0].active_revision_digest;
  v1.manifest_digest = todoSelfDigest(v1, 'manifest_digest');
  assert.equal(validateTodoManifest(v1), true);
});

test('phase_todo_revision.v3 validatorはruntime migrationとreconciliationをexact検証する', async (t) => {
  const { revision } = await fixture(t);
  assert.equal(validatePhaseTodoRevision(revision), true);
  const memoRevision = structuredClone(revision);
  const memoDesiredInput = structuredClone(memoRevision.desired_plan);
  delete memoDesiredInput.topology_digest; delete memoDesiredInput.plan_digest;
  memoDesiredInput.schema = 'lattice.todo_plan.v7';
  memoDesiredInput.tasks = memoDesiredInput.tasks.map((task) => ({
    ...task, design_memo: `${task.task_id}の設計・実装・検証方針。`,
  }));
  memoDesiredInput.plan_version = phaseTodoRevisionPlanVersion({
    projectId: memoRevision.project_id, planKey: memoRevision.plan_key,
    predecessor: memoRevision.predecessor, desiredPlan: memoDesiredInput,
    taskMigration: memoRevision.task_migration, phaseMigration: memoRevision.phase_migration,
  });
  memoRevision.desired_plan = buildTodoPlan(memoDesiredInput);
  memoRevision.reconciliation.desired_plan_digest = memoRevision.desired_plan.plan_digest;
  memoRevision.reconciliation.reconciliation_digest = todoSelfDigest(
    memoRevision.reconciliation, 'reconciliation_digest');
  memoRevision.revision_digest = todoSelfDigest(memoRevision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(memoRevision), true);
  const missingMemo = structuredClone(memoRevision);
  delete missingMemo.desired_plan.tasks[0].design_memo;
  missingMemo.revision_digest = todoSelfDigest(missingMemo, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(missingMemo), false);
  const missingRuntime = structuredClone(revision);
  delete missingRuntime.runtime_task_migration;
  missingRuntime.revision_digest = todoSelfDigest(missingRuntime, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(missingRuntime), false);
  const unfinishedCarry = structuredClone(revision);
  unfinishedCarry.task_migration[1].state_policy = 'carry';
  unfinishedCarry.revision_digest = todoSelfDigest(unfinishedCarry, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(unfinishedCarry), false);
  const orphanSplit = structuredClone(revision);
  orphanSplit.runtime_task_migration.entries[1].disposition = 'split';
  orphanSplit.runtime_task_migration.entries[1].successor_task_ids = ['T2', 'T3'];
  orphanSplit.runtime_task_migration.migration_digest = migrationDigest(
    orphanSplit.runtime_task_migration);
  orphanSplit.reconciliation.runtime_task_migration_digest
    = orphanSplit.runtime_task_migration.migration_digest;
  orphanSplit.reconciliation.reconciliation_digest = todoSelfDigest(orphanSplit.reconciliation,
    'reconciliation_digest');
  orphanSplit.revision_digest = todoSelfDigest(orphanSplit, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(orphanSplit), false);

  const reconciled = structuredClone(revision);
  reconciled.task_migration[0].state_policy = 'carry_reconciled_metadata';
  const desiredInput = structuredClone(reconciled.desired_plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: reconciled.project_id,
    planKey: reconciled.plan_key, predecessor: reconciled.predecessor, desiredPlan: desiredInput,
    taskMigration: reconciled.task_migration, phaseMigration: reconciled.phase_migration });
  reconciled.desired_plan = buildTodoPlan(desiredInput);
  reconciled.reconciliation.desired_plan_digest = reconciled.desired_plan.plan_digest;
  reconciled.reconciliation.task_migration_digest = todoMigrationDigest(reconciled.task_migration);
  reconciled.reconciliation.reconciliation_digest = todoSelfDigest(reconciled.reconciliation,
    'reconciliation_digest');
  reconciled.revision_digest = todoSelfDigest(reconciled, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(reconciled), true);
});

test('phase v3 splitはlexicographic最小ではなく先頭successorへ旧stateを投影する', async (t) => {
  const { revision } = await fixture(t);
  const value = structuredClone(revision);
  const desiredInput = structuredClone(value.desired_plan);
  delete desiredInput.topology_digest;
  delete desiredInput.plan_digest;
  desiredInput.tasks.push({
    ...structuredClone(desiredInput.tasks.find(({ task_id: taskId }) => taskId === 'T2')),
    task_id: 'T0', title: 'T0', narrative_ref: '.lattice/todo/source-ledger/cutover.md#L8',
  });
  desiredInput.tasks.sort((left, right) => left.task_id.localeCompare(right.task_id));
  value.runtime_task_migration.entries[1] = {
    predecessor_task_id: 'T2', disposition: 'split', successor_task_ids: ['T2', 'T0'],
    reason: 'T2 remains the primary identity and T0 is the new split task',
    evidence_digests: ['2'.repeat(64), '3'.repeat(64)],
  };
  value.runtime_task_migration.migration_digest = migrationDigest(value.runtime_task_migration);
  value.phase_migration[0].state_policy = 'reset';
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({
    projectId: value.project_id, planKey: value.plan_key, predecessor: value.predecessor,
    desiredPlan: desiredInput, taskMigration: value.task_migration,
    phaseMigration: value.phase_migration,
  });
  value.desired_plan = buildTodoPlan(desiredInput);
  const newSourceDigest = createHash('sha256').update('- [ ] T0 source').digest('hex');
  value.source_cutover_batch.operations.push({
    task_id: 'T0', disposition: 'active', source_ref: 'docs/plan.md#L3',
    source_digest: newSourceDigest, live_replacement: '- T0 state is managed by Lattice',
  });
  value.source_cutover_batch.batch_digest = todoSelfDigest(value.source_cutover_batch, 'batch_digest');
  value.source_inventory.active.push({
    task_id: 'T0', source_ref: '.lattice/todo/source-ledger/cutover.md#L8',
    source_digest: newSourceDigest,
  });
  value.source_inventory.active.sort((left, right) => left.task_id.localeCompare(right.task_id));
  value.reconciliation.source_inventory_digest = digestTodoArtifact(value.source_inventory);
  value.reconciliation.desired_plan_digest = value.desired_plan.plan_digest;
  value.reconciliation.runtime_task_migration_digest = value.runtime_task_migration.migration_digest;
  value.reconciliation.phase_migration_digest = digestTodoArtifact(value.phase_migration);
  value.reconciliation.source_cutover_batch_digest = value.source_cutover_batch.batch_digest;
  value.reconciliation.reconciliation_digest = todoSelfDigest(value.reconciliation,
    'reconciliation_digest');
  value.revision_digest = todoSelfDigest(value, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(value), true);

  const lexical = structuredClone(value);
  lexical.runtime_task_migration.entries[1].successor_task_ids = ['T0', 'T2'];
  lexical.runtime_task_migration.migration_digest = migrationDigest(lexical.runtime_task_migration);
  lexical.reconciliation.runtime_task_migration_digest
    = lexical.runtime_task_migration.migration_digest;
  lexical.reconciliation.reconciliation_digest = todoSelfDigest(lexical.reconciliation,
    'reconciliation_digest');
  lexical.revision_digest = todoSelfDigest(lexical, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(lexical), false);
});

test('phase v3 applyはpredecessor inventory差分にないbatch欠落を拒否する', async (t) => {
  const { root, revision, writer } = await fixture(t);
  const missing = structuredClone(revision);
  missing.source_cutover_batch.operations.pop();
  missing.source_cutover_batch.batch_digest = todoSelfDigest(missing.source_cutover_batch,
    'batch_digest');
  missing.reconciliation.source_cutover_batch_digest = missing.source_cutover_batch.batch_digest;
  missing.reconciliation.reconciliation_digest = todoSelfDigest(missing.reconciliation,
    'reconciliation_digest');
  missing.revision_digest = todoSelfDigest(missing, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(missing), true);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision: missing,
    actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'source_cutover_inventory_diff_mismatch');
});

test('phase v3 transactionはsourceとreceiptをmanifest v2 CASでactivateしretryする', async (t) => {
  const { root, revision, writer } = await fixture(t);
  assert.equal(validatePhaseTodoRevision(revision), true);
  assert.equal(validatePhaseTodoRevision(revision), true);
  assert.equal(validatePhaseTodoRevision(JSON.parse(JSON.stringify(revision))), true);
  const revisionBefore = structuredClone(revision);
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT,
    onProtocolStage(stage) {
      assert.equal(validatePhaseTodoRevision(revision), true, stage);
    } });
  assert.deepEqual(revision, revisionBefore);
  assert.equal(validatePhaseTodoRevision(revision), true);
  assert.equal(receipt.schema, 'lattice.phase_revision_commit_receipt.v1');
  assert.equal(receipt.revision_digest, revision.revision_digest);
  const storedRevision = JSON.parse(await readFile(path.join(root, '.lattice', 'todo', 'plans',
    'main', revision.desired_plan.plan_version, 'revision.json'), 'utf8'));
  assert.deepEqual(storedRevision, revision);
  assert.equal(storedRevision.revision_digest, todoSelfDigest(storedRevision, 'revision_digest'));
  assert.equal(validateTodoPlan(storedRevision.desired_plan), true);
  assert.equal(storedRevision.desired_plan.plan_version, phaseTodoRevisionPlanVersion({
    projectId: storedRevision.project_id, planKey: storedRevision.plan_key,
    predecessor: storedRevision.predecessor, desiredPlan: storedRevision.desired_plan,
    taskMigration: storedRevision.task_migration, phaseMigration: storedRevision.phase_migration,
  }));
  assert.equal(storedRevision.runtime_task_migration.migration_digest,
    migrationDigest(storedRevision.runtime_task_migration));
  assert.equal(storedRevision.reconciliation.reconciliation_digest,
    todoSelfDigest(storedRevision.reconciliation, 'reconciliation_digest'));
  assert.equal(storedRevision.source_cutover_batch.batch_digest,
    todoSelfDigest(storedRevision.source_cutover_batch, 'batch_digest'));
  assert.equal(storedRevision.reconciliation.source_inventory_digest,
    digestTodoArtifact(storedRevision.source_inventory));
  assert.equal(storedRevision.reconciliation.task_migration_digest,
    todoMigrationDigest(storedRevision.task_migration));
  assert.equal(storedRevision.reconciliation.phase_migration_digest,
    digestTodoArtifact(storedRevision.phase_migration));
  assert.equal(validatePhaseTodoRevision(storedRevision), true);
  const store = await readTodoStore({ repoRoot: root, now: COMMIT_AT });
  assert.equal(store.manifest.schema, 'lattice.todo_manifest.v2');
  assert.equal(store.members[0].descriptor.active_revision_digest, revision.revision_digest);
  assert.deepEqual(store.members[0].tasks.map(({ status }) => status), ['done', 'pending']);
  const planRoot = path.join(root, '.lattice', 'todo', 'plans', 'main',
    revision.desired_plan.plan_version);
  const sourceReceipt = JSON.parse(await readFile(path.join(planRoot,
    'source-cutover-receipt.json'), 'utf8'));
  assert.equal(sourceReceipt.entries.length, 2);
  assert.equal(sourceReceipt.published_state, 'source_and_archive_published');
  const retry = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: '2026-07-21T00:00:02.000Z', now: '2026-07-21T00:00:02.000Z' });
  assert.deepEqual(retry, receipt);
});

test('phase v3はactive sourceを明示cutoverで次のarchiveへ移転できる', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  const member = (await readTodoStore({ repoRoot: root, now: COMMIT_AT })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const currentSource = member.revision.source_inventory.active
    .find(({ task_id: taskId }) => taskId === 'T2');
  const nextArchiveRef = '.lattice/todo/source-ledger/cutover-next.md';
  const sourceCutoverBatch = { batch_id: 'phase-v3-next-cutover', archive_ref: nextArchiveRef,
    operations: [{ task_id: 'T2', disposition: 'active', source_ref: currentSource.source_ref,
      source_digest: currentSource.source_digest, live_replacement: '- T2 moved to next Lattice source' }],
    batch_digest: '' };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1', entries: [
    { predecessor_task_id: 'T1', disposition: 'stay', successor_task_ids: ['T1'],
      reason: 'T1 remains unchanged', evidence_digests: ['1'.repeat(64)] },
    { predecessor_task_id: 'T2', disposition: 'replace', successor_task_ids: ['T2'],
      reason: 'T2 source and ordering changed', evidence_digests: ['2'.repeat(64)] },
  ], migration_digest: '' };
  runtimeTaskMigration.migration_digest = migrationDigest(runtimeTaskMigration);
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: 'carry' },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: 'reset_pending' },
  ];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1',
    state_policy: 'carry' }];
  const desiredSeed = structuredClone(member.plan);
  delete desiredSeed.topology_digest;
  delete desiredSeed.plan_digest;
  desiredSeed.predecessor_plan_digest = predecessor.plan_digest;
  desiredSeed.tasks.find(({ task_id: taskId }) => taskId === 'T2').title = 'T2 moved last';
  desiredSeed.tasks.find(({ task_id: taskId }) => taskId === 'T2').narrative_ref
    = `${nextArchiveRef}#L6`;
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({
    projectId: member.plan.project_id, planKey: member.plan.plan_key, predecessor,
    desiredPlan: desiredSeed, taskMigration, phaseMigration,
  });
  const desiredPlan = buildTodoPlan(desiredSeed);
  const sourceInventory = {
    active: member.revision.source_inventory.active.map((entry) => entry.task_id === 'T2'
      ? { ...entry, source_ref: `${nextArchiveRef}#L6` } : entry),
    excluded_tombstones: member.revision.source_inventory.excluded_tombstones,
  };
  const reconciliation = {
    predecessor_reconciliation_digest: member.revision.reconciliation.reconciliation_digest,
    source_inventory_digest: digestTodoArtifact(sourceInventory),
    desired_plan_digest: desiredPlan.plan_digest,
    runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
    task_migration_digest: todoMigrationDigest(taskMigration),
    phase_migration_digest: digestTodoArtifact(phaseMigration),
    source_cutover_batch_digest: sourceCutoverBatch.batch_digest,
    reconciliation_digest: '',
  };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const successor = { schema: 'lattice.phase_todo_revision.v3', project_id: member.plan.project_id,
    plan_key: member.plan.plan_key, predecessor, desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration, task_migration: taskMigration,
    phase_migration: phaseMigration, source_inventory: sourceInventory, reconciliation,
    source_cutover_batch: sourceCutoverBatch, revision_digest: '' };
  successor.revision_digest = todoSelfDigest(successor, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(successor), true);
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision: successor,
    actor: ACTOR, recordedAt: '2026-07-21T00:00:02.000Z', now: '2026-07-21T00:00:02.000Z' });
  assert.equal(receipt.revision_digest, successor.revision_digest);
  assert.equal(await verifyPhaseTodoRevisionSources({ repoRoot: root, revision: successor }), true);
});

test('todo verifyはactive phase v3を正規verifierへrouteしsource digest driftを拒否する', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(await verifyPhaseTodoRevisionSources({ repoRoot: root, revision }), true);
  const verified = spawnSync(process.execPath, [CLI, 'todo', 'verify'], { cwd: root, encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).verified_members[0].revision_digest,
    revision.revision_digest);
  const status = spawnSync(process.execPath, [CLI, 'todo', 'status'], { cwd: root, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).member_heads[0].reconciliation_digest,
    revision.reconciliation.reconciliation_digest);
  const legacyReadModel = await readTodoStore({ repoRoot: root, now: COMMIT_AT });
  legacyReadModel.members[0].revision.schema = 'lattice.phase_todo_revision.v2';
  assert.equal(projectTodoStatus(legacyReadModel, { parallelCandidates: [], planNotes: [] }).member_heads[0].reconciliation_digest,
    revision.revision_digest);

  const archiveRef = path.join(root, revision.source_cutover_batch.archive_ref);
  const archive = await readFile(archiveRef, 'utf8');
  await writeFile(archiveRef, archive.replace('- [ ] T1 source', '- [ ] T1 drifted'));
  await assert.rejects(verifyPhaseTodoRevisionSources({ repoRoot: root, revision }),
    (error) => error.code === 'RECONCILIATION_INCOMPLETE'
      && error.detail.reason === 'source_digest_mismatch');
  const drifted = spawnSync(process.execPath, [CLI, 'todo', 'verify'], { cwd: root, encoding: 'utf8' });
  assert.equal(drifted.status, 1);
  const failure = JSON.parse(drifted.stderr);
  assert.equal(failure.code, 'RECONCILIATION_INCOMPLETE');
  assert.equal(failure.detail.reason, 'source_digest_mismatch');
});

test('active revisionのfuture schemaは破損と分離してstatus/verifyへtyped公開する', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  const revisionPath = path.join(root, '.lattice', 'todo', 'plans', 'main',
    revision.desired_plan.plan_version, 'revision.json');
  const futureRevision = { ...revision, schema: 'lattice.phase_todo_revision.v5' };
  await writeFile(revisionPath, `${canonicalizeTodoArtifact(futureRevision)}\n`);

  await assert.rejects(readTodoStore({ repoRoot: root, now: COMMIT_AT }), (error) => (
    error.code === 'UNSUPPORTED_SCHEMA'
      && error.detail.reason === 'unsupported_revision_schema'
      && error.detail.schema === 'lattice.phase_todo_revision.v5'
      && error.detail.supported_schemas.at(-1) === 'lattice.phase_todo_revision.v4'
  ));
  const status = spawnSync(process.execPath, [CLI, 'status', '--json'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(status.status, 1);
  assert.equal(JSON.parse(status.stdout).next_action.reason,
    'UNSUPPORTED_SCHEMA:unsupported_revision_schema');
  const verification = spawnSync(process.execPath, [CLI, 'todo', 'verify'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(verification.status, 1);
  assert.equal(verification.stdout, '');
  assert.deepEqual(JSON.parse(verification.stderr), {
    schema: 'lattice.cli_error.v2',
    code: 'UNSUPPORTED_SCHEMA',
    message: 'unsupported_revision_schema',
    detail: {
      reason: 'unsupported_revision_schema',
      schema: 'lattice.phase_todo_revision.v5',
      supported_schemas: [
        'lattice.phase_todo_revision.v1',
        'lattice.phase_todo_revision.v2',
        'lattice.phase_todo_revision.v3',
        'lattice.phase_todo_revision.v4',
      ],
    },
  });
});

test('active revisionの既知schema構造破損はSTORE_INCONSISTENTのままfail closedする', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  const revisionPath = path.join(root, '.lattice', 'todo', 'plans', 'main',
    revision.desired_plan.plan_version, 'revision.json');
  const corrupted = structuredClone(revision);
  delete corrupted.runtime_task_migration;
  await writeFile(revisionPath, `${canonicalizeTodoArtifact(corrupted)}\n`);

  await assert.rejects(readTodoStore({ repoRoot: root, now: COMMIT_AT }), (error) => (
    error.code === 'STORE_INCONSISTENT' && error.detail.reason === 'schema_invalid'
  ));
  const verification = spawnSync(process.execPath, [CLI, 'todo', 'verify'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(verification.status, 1);
  const failure = JSON.parse(verification.stderr);
  assert.equal(failure.code, 'STORE_INCONSISTENT');
  assert.equal(failure.detail.reason, 'schema_invalid');
});

test('phase v3はsource publish crashをsame digestだけroll-forwardする', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT,
    onProtocolStage(stage) { if (stage === 'phase_v3_source_published') throw new Error('crash:v3'); },
  }), /crash:v3/u);
  const competing = competingRevision(revision);
  assert.equal(validatePhaseTodoRevision(competing), true);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision: competing,
    actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'SOURCE_CUTOVER_RECOVERY_REQUIRED');
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, revision.revision_digest);
});

test('phase v3 marker durable後は同predecessorの別versionを拒否しsame retryだけ許す', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT,
    onProtocolStage(stage) { if (stage === 'phase_v3_marker_durable') throw new Error('crash:marker'); },
  }), /crash:marker/u);
  const competing = competingVersionRevision(revision);
  assert.equal(validatePhaseTodoRevision(competing), true);
  assert.notEqual(competing.desired_plan.plan_version, revision.desired_plan.plan_version);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision: competing,
    actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_CONFLICT' && error.detail.reason === 'revision_bytes_conflict');
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, revision.revision_digest);
});

test('phase v3はmarker前crashのcurrent空transaction dirをsame revisionでclaimする', async (t) => {
  const { root, revision, writer } = await fixture(t);
  const transaction = path.join(root, '.lattice', 'todo', 'transactions', 'phase-v3', 'main',
    revision.desired_plan.plan_version);
  await mkdir(transaction, { recursive: true });
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, revision.revision_digest);
});

test('phase v3 CRLF sourceはpublish crash後もCRをreceiptへbindしてretry収束する', async (t) => {
  const { root, revision, writer } = await fixture(t, { crlf: true });
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT,
    onProtocolStage(stage) { if (stage === 'phase_v3_source_published') throw new Error('crash:crlf'); },
  }), /crash:crlf/u);
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  const sourceReceipt = JSON.parse(await readFile(path.join(root, '.lattice', 'todo', 'plans',
    'main', revision.desired_plan.plan_version, 'source-cutover-receipt.json'), 'utf8'));
  assert.equal(sourceReceipt.entries[0].published_source_bytes_digest,
    createHash('sha256').update(`${revision.source_cutover_batch.operations[0].live_replacement}\r`)
      .digest('hex'));
  assert.equal(receipt.source_cutover_receipt_digest, sourceReceipt.receipt_digest);
});

test('phase v3はLFで作ったrevisionをCRLF checkoutへ適用してreceiptを検証する', async (t) => {
  const { root, revision, writer } = await fixture(t, { crlf: true, digestCrlf: false });
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, revision.revision_digest);
  const verified = await readTodoStore({ repoRoot: root, now: COMMIT_AT, hardVerify: true });
  assert.equal(verified.members[0].revision.revision_digest, revision.revision_digest);
  assert.match(await readFile(path.join(root, 'docs', 'plan.md'), 'utf8'), /\r\n/u);
});

test('phase v3 recoveryはstage traversalをrejectしtransaction外を削除しない', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT,
    onProtocolStage(stage) { if (stage === 'phase_v3_cutover_barrier_durable') throw new Error('crash:barrier'); },
  }), /crash:barrier/u);
  const sentinel = path.join(root, 'sentinel.txt');
  const sentinelBytes = Buffer.from('must survive\n');
  await writeFile(sentinel, sentinelBytes);
  const transaction = path.join(root, '.lattice', 'todo', 'transactions', 'phase-v3', 'main',
    revision.desired_plan.plan_version);
  const descriptorRef = path.join(transaction, 'source-cutover.json');
  const descriptor = JSON.parse(await readFile(descriptorRef, 'utf8'));
  descriptor.files[0].before = '../../../../../../sentinel.txt';
  descriptor.files[0].before_digest = createHash('sha256').update(sentinelBytes).digest('hex');
  await writeFile(descriptorRef, `${canonicalizeTodoArtifact(descriptor)}\n`);
  const manifestBefore = await readFile(path.join(root, '.lattice', 'todo', 'manifest.json'));
  const sourceBefore = await readFile(path.join(root, 'docs', 'plan.md'));
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'SOURCE_CUTOVER_RECOVERY_REQUIRED');
  assert.deepEqual(await readFile(sentinel), sentinelBytes);
  assert.deepEqual(await readFile(path.join(root, '.lattice', 'todo', 'manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(path.join(root, 'docs', 'plan.md')), sourceBefore);
});

test('phase v3 recoveryはpublish前のmissing descriptorをrestageせず拒否する', async (t) => {
  const { root, revision, writer } = await fixture(t);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT,
    onProtocolStage(stage) { if (stage === 'phase_v3_cutover_barrier_durable') throw new Error('crash:barrier'); },
  }), /crash:barrier/u);
  const sourceRef = path.join(root, 'docs', 'plan.md');
  const sourceBefore = await readFile(sourceRef);
  await unlink(path.join(root, '.lattice', 'todo', 'transactions', 'phase-v3', 'main',
    revision.desired_plan.plan_version, 'source-cutover.json'));
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'SOURCE_CUTOVER_RECOVERY_REQUIRED'
    && error.detail.reason === 'source_cutover_postimage_invalid');
  assert.deepEqual(await readFile(sourceRef), sourceBefore);
  await assert.rejects(readFile(path.join(root, revision.source_cutover_batch.archive_ref)));
});

test('phase v3はplan-version symlink経由のstore外publishをactivation前に拒否する', async (t) => {
  const { root, revision, writer } = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  const versionRef = path.join(root, '.lattice', 'todo', 'plans', 'main',
    revision.desired_plan.plan_version);
  await symlink(outside, versionRef);
  const manifestBefore = await readFile(path.join(root, '.lattice', 'todo', 'manifest.json'));
  const sourceBefore = await readFile(path.join(root, 'docs', 'plan.md'));
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_CONFLICT'
    && error.detail.reason === 'revision_directory_unsafe');
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readFile(path.join(root, '.lattice', 'todo', 'manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(path.join(root, 'docs', 'plan.md')), sourceBefore);
});

test('phase v3はnested journal symlink経由のstore外publishをactivation前に拒否する', async (t) => {
  const { root, revision, writer } = await fixture(t);
  const outside = path.join(root, 'outside-journal');
  await mkdir(outside);
  const versionRef = path.join(root, '.lattice', 'todo', 'plans', 'main',
    revision.desired_plan.plan_version);
  await mkdir(versionRef);
  await symlink(outside, path.join(versionRef, 'journal'));
  const manifestBefore = await readFile(path.join(root, '.lattice', 'todo', 'manifest.json'));
  const sourceBefore = await readFile(path.join(root, 'docs', 'plan.md'));
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_CONFLICT'
    && error.detail.reason === 'revision_directory_unsafe');
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readFile(path.join(root, '.lattice', 'todo', 'manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(path.join(root, 'docs', 'plan.md')), sourceBefore);
});

for (const crashStage of [
  'phase_v3_marker_durable',
  'phase_v3_cutover_barrier_durable',
  'phase_v3_source_cleanup',
  'phase_v3_commit_receipt_durable',
  'phase_v3_manifest_activated',
]) {
  test(`phase v3 failure injectionは${crashStage}からsame digest retryで収束する`, async (t) => {
    const { root, revision, writer } = await fixture(t);
    await assert.rejects(applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
      recordedAt: COMMIT_AT, now: COMMIT_AT,
      onProtocolStage(stage) { if (stage === crashStage) throw new Error(`crash:${crashStage}`); },
    }), new RegExp(`crash:${crashStage}`, 'u'));
    const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
      recordedAt: '2026-07-21T00:00:02.000Z', now: '2026-07-21T00:00:02.000Z' });
    assert.equal(receipt.revision_digest, revision.revision_digest);
    const store = await readTodoStore({ repoRoot: root, now: '2026-07-21T00:00:02.000Z' });
    assert.equal(store.members[0].descriptor.active_revision_digest, revision.revision_digest);
  });
}

test('phase v3 carryは旧outgoing削除を拒否しsafe outgoing追加を許す', async (t) => {
  const safe = await fixture(t);
  const receipt = await applyPhaseTodoRevision({ repoRoot: safe.root, writer: safe.writer,
    revision: safe.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, safe.revision.revision_digest);
  const removed = await fixture(t, { initialEdge: true, desiredEdge: false });
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: removed.root, writer: removed.writer,
    revision: removed.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'carry_outgoing_edge_removed');
});

test('phase v3の既存memo変更はcarryを拒否し明示reconcileだけがpolicy付きで保持する', async (t) => {
  const normal = await fixture(t, {
    initialDesignMemo: '初期方針', desiredDesignMemo: '## 改訂方針\n\n本文を更新する。',
    desiredEdge: false,
  });
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: normal.root, writer: normal.writer,
    revision: normal.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID' && error.detail.reason === 'carry_semantics_changed');

  const explicit = await fixture(t, {
    initialDesignMemo: '初期方針', desiredDesignMemo: '## 改訂方針\n\n本文を更新する。',
    desiredEdge: false, t1StatePolicy: 'carry_reconciled_metadata',
  });
  await applyPhaseTodoRevision({ repoRoot: explicit.root, writer: explicit.writer,
    revision: explicit.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  const member = (await readTodoStore({ repoRoot: explicit.root, now: COMMIT_AT })).members[0];
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'done');
  assert.equal(member.journal.events[0].state_migration[0].state_policy,
    'carry_reconciled_metadata');
});

test('phase legacy planへの初回design_memo追加は通常carryでdone stateを保持する', async (t) => {
  const value = await fixture(t, {
    desiredDesignMemo: '## 初回設計\n\nlegacy taskへ設計を与える。', desiredEdge: false,
  });
  await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  const member = (await readTodoStore({ repoRoot: value.root, now: COMMIT_AT })).members[0];
  assert.equal(member.plan.schema, 'lattice.todo_plan.v7');
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'done');
  assert.match(member.plan.tasks.find(({ task_id }) => task_id === 'T1').design_memo,
    /legacy task/u);
});

test('phase revisionもv7からmemo無しv5へのschema後退をtyped拒否する', async (t) => {
  const value = await fixture(t, { initialDesignMemo: '初期方針', desiredEdge: false });
  const revision = structuredClone(value.revision);
  const desiredInput = structuredClone(revision.desired_plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.schema = 'lattice.todo_plan.v5';
  desiredInput.tasks = desiredInput.tasks.map(({ design_memo, ...entry }) => entry);
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: revision.project_id,
    planKey: revision.plan_key, predecessor: revision.predecessor, desiredPlan: desiredInput,
    taskMigration: revision.task_migration, phaseMigration: revision.phase_migration });
  revision.desired_plan = buildTodoPlan(desiredInput);
  revision.reconciliation.desired_plan_digest = revision.desired_plan.plan_digest;
  revision.reconciliation.reconciliation_digest = todoSelfDigest(
    revision.reconciliation, 'reconciliation_digest');
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(revision), true);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'design_memo_schema_downgrade');
});

test('phase v3 carryはphase ID migration後のtask semanticsを比較する', async (t) => {
  const value = await fixture(t, { desiredEdge: false });
  const revision = structuredClone(value.revision);
  revision.task_migration[0].state_policy = 'carry_reconciled_metadata';
  revision.phase_migration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-2',
    state_policy: 'carry' }];
  const desiredInput = structuredClone(revision.desired_plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.phases[0].phase_id = 'phase-2';
  for (const task of desiredInput.tasks) task.phase_id = 'phase-2';
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: revision.project_id,
    planKey: revision.plan_key, predecessor: revision.predecessor, desiredPlan: desiredInput,
    taskMigration: revision.task_migration, phaseMigration: revision.phase_migration });
  revision.desired_plan = buildTodoPlan(desiredInput);
  revision.reconciliation.desired_plan_digest = revision.desired_plan.plan_digest;
  revision.reconciliation.task_migration_digest = todoMigrationDigest(revision.task_migration);
  revision.reconciliation.phase_migration_digest = digestTodoArtifact(revision.phase_migration);
  revision.reconciliation.reconciliation_digest = todoSelfDigest(revision.reconciliation,
    'reconciliation_digest');
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(revision), true);
  const receipt = await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, revision.revision_digest);
  const store = await readTodoStore({ repoRoot: value.root, now: COMMIT_AT });
  assert.equal(store.members[0].plan.tasks[0].phase_id, 'phase-2');
});

test('phase v3 carry_reconciled_metadataは別Phaseへのtask移動を拒否する', async (t) => {
  const value = await fixture(t, { desiredEdge: false, carryT2: true, t2Status: 'in-progress' });
  const revision = structuredClone(value.revision);
  revision.task_migration[1].state_policy = 'carry_reconciled_metadata';
  revision.phase_migration = [
    { from_phase_id: null, to_phase_id: 'phase-2', state_policy: 'reset' },
    { from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' },
  ];
  const desiredInput = structuredClone(revision.desired_plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.phases.push({ ...desiredInput.phases[0], phase_id: 'phase-2', title: 'Phase 2' });
  desiredInput.tasks.find(({ task_id }) => task_id === 'T2').phase_id = 'phase-2';
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: revision.project_id,
    planKey: revision.plan_key, predecessor: revision.predecessor, desiredPlan: desiredInput,
    taskMigration: revision.task_migration, phaseMigration: revision.phase_migration });
  revision.desired_plan = buildTodoPlan(desiredInput);
  revision.reconciliation.desired_plan_digest = revision.desired_plan.plan_digest;
  revision.reconciliation.task_migration_digest = todoMigrationDigest(revision.task_migration);
  revision.reconciliation.phase_migration_digest = digestTodoArtifact(revision.phase_migration);
  revision.reconciliation.reconciliation_digest = todoSelfDigest(revision.reconciliation,
    'reconciliation_digest');
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(revision), true);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'carry_semantics_changed');
});

for (const status of ['in-progress', 'blocked']) {
  test(`phase v3 carryは${status} stateをsemantic/edge不変時に保持する`, async (t) => {
    const value = await fixture(t, { desiredEdge: false, carryT2: true, t2Status: status });
    const receipt = await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
      revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
    assert.equal(receipt.revision_digest, value.revision.revision_digest);
    const store = await readTodoStore({ repoRoot: value.root, now: COMMIT_AT });
    assert.equal(store.members[0].tasks.find(({ task_id }) => task_id === 'T2').status, status);
  });
}

// 先行planがPhaseを持たない世代（todo_plan.v3）からのcarryは、素のTypeErrorではなく
// typedなREVISION_INVALIDで拒否されなければならない。Phase割当ての獲得は意味変化である。
async function phaselessFixture(t, { statePolicy = 'carry' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-v3-phaseless-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const legacyTask = (taskId, line) => ({ task_id: taskId, title: taskId, lane: 'main',
    narrative_ref: `.lattice/todo/source-ledger/cutover.md#L${line}`,
    narrative_anchor: null, compile_binding: null, parent_task_id: null });
  const initial = buildTodoPlan({ schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [legacyTask('T1', 6), legacyTask('T2', 7)], hard_dependencies: [], joins: [] });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: initial, genesis: { actor: ACTOR, recorded_at: INITIAL_AT } }], now: INITIAL_AT });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: INITIAL_AT,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: INITIAL_AT,
      payload: { override_reason: null } } });
  const member = (await readTodoStore({ repoRoot: root, now: INITIAL_AT })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const phase = { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const sourceLines = ['- [ ] T1 source', '- [ ] T2 source'];
  const sourceCutoverBatch = { batch_id: 'phaseless-cutover',
    archive_ref: '.lattice/todo/source-ledger/cutover.md',
    operations: sourceLines.map((line, index) => ({
      task_id: `T${index + 1}`, disposition: 'active', source_ref: `docs/plan.md#L${index + 1}`,
      source_digest: createHash('sha256').update(line).digest('hex'),
      live_replacement: `- T${index + 1} state is managed by Lattice`,
    })), batch_digest: '' };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const desiredTask = (taskId, index) => ({ task_id: taskId, title: taskId, lane: 'main',
    narrative_ref: `${sourceCutoverBatch.archive_ref}#L${index + 6}`,
    narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' });
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: statePolicy },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: 'reset_pending' },
  ];
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1', entries: [
    { predecessor_task_id: 'T1', disposition: statePolicy === 'carry' ? 'carry' : 'replace',
      successor_task_ids: ['T1'], reason: 'phase世代の昇格', evidence_digests: ['1'.repeat(64)] },
    { predecessor_task_id: 'T2', disposition: 'replace', successor_task_ids: ['T2'],
      reason: 'phase世代の昇格', evidence_digests: ['2'.repeat(64)] },
  ], migration_digest: '' };
  runtimeTaskMigration.migration_digest = migrationDigest(runtimeTaskMigration);
  const phaseMigration = [{ from_phase_id: null, to_phase_id: 'phase-1', state_policy: 'reset' }];
  const desiredSeed = { schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: 'main',
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [desiredTask('T1', 0), desiredTask('T2', 1)], phases: [phase],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredSeed, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredSeed);
  const sourceInventory = { active: sourceCutoverBatch.operations.map((operation, index) => ({
    task_id: operation.task_id, source_ref: `${sourceCutoverBatch.archive_ref}#L${index + 6}`,
    source_digest: operation.source_digest,
  })), excluded_tombstones: [] };
  const reconciliation = { predecessor_reconciliation_digest: todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest }),
  source_inventory_digest: digestTodoArtifact(sourceInventory),
  desired_plan_digest: desiredPlan.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: todoMigrationDigest(taskMigration),
  phase_migration_digest: digestTodoArtifact(phaseMigration),
  source_cutover_batch_digest: sourceCutoverBatch.batch_digest, reconciliation_digest: '' };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const revision = { schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration, task_migration: taskMigration,
    phase_migration: phaseMigration, source_inventory: sourceInventory, reconciliation,
    source_cutover_batch: sourceCutoverBatch, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'plan.md'), `${sourceLines.join('\n')}\n`);
  return { root, revision, writer };
}

test('phase v3 carryはPhase無し先行planをtyped REVISION_INVALIDで拒否する', async (t) => {
  const value = await phaselessFixture(t);
  assert.equal(validatePhaseTodoRevision(value.revision), true);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'carry_semantics_changed'
    && error.detail.from_task_id === 'T1');
});

test('phase v3 reset_pendingはPhase無し先行planからPhaseを獲得できる', async (t) => {
  const value = await phaselessFixture(t, { statePolicy: 'reset_pending' });
  const receipt = await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, value.revision.revision_digest);
  const store = await readTodoStore({ repoRoot: value.root, now: COMMIT_AT });
  assert.equal(store.members[0].plan.schema, 'lattice.todo_plan.v5');
  assert.equal(store.members[0].tasks.find(({ task_id }) => task_id === 'T1').status, 'pending');
});

// acquire_phase専用fixture(ADR 0147裁定4): phase無し先行plan(todo_plan.v3)のtaskをdoneにした
// 状態で、v3 phase revisionへacquire_phaseを渡す。carryと違いphase_id獲得だけを許すpolicyであり、
// done等の状態は完全に持ち越る。retitleT1でtitle変更を混ぜ、獲得以外の意味論変化が従来どおり
// 拒否されることも同じfixtureで検証できるようにする。
async function acquirePhaseFixture(t, { retitleT1 = false, retireT2 = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-v3-acquire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const initial = buildTodoPlan({ schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [{ task_id: 'T1', title: 'T1', lane: 'main',
      narrative_ref: '.lattice/todo/source-ledger/cutover.md#L6',
      narrative_anchor: null, compile_binding: null, parent_task_id: null },
    { task_id: 'T2', title: 'T2', lane: 'main',
      narrative_ref: '.lattice/todo/source-ledger/cutover.md#L7',
      narrative_anchor: null, compile_binding: null, parent_task_id: null }],
    hard_dependencies: retireT2 ? [{ from: ref('T1'), to: ref('T2') }] : [], joins: [] });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: initial, genesis: { actor: ACTOR, recorded_at: INITIAL_AT } }], now: INITIAL_AT });
  const evidenceBytes = Buffer.from('acquire-phase done evidence\n');
  await writeFile(path.join(root, 'evidence.txt'), evidenceBytes);
  execFileSync('git', ['add', 'evidence.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
    'commit', '--quiet', '-m', 'evidence'], { cwd: root });
  const oid = execFileSync('git', ['rev-parse', 'HEAD:evidence.txt'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const evidence = { evidence_id: 'acquire-phase-done', repo_id: 'self', path: 'evidence.txt',
    git_blob_oid: oid, content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: INITIAL_AT,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: INITIAL_AT,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: INITIAL_AT,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: INITIAL_AT,
      payload: { evidence } } });
  const member = (await readTodoStore({ repoRoot: root, now: INITIAL_AT })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const phase = { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const sourceLines = ['- [ ] T1 source', '- [ ] T2 source'];
  const sourceCutoverBatch = { batch_id: 'acquire-phase-cutover',
    archive_ref: '.lattice/todo/source-ledger/cutover.md', operations: sourceLines.map((line, index) => ({
      task_id: retireT2 && index === 1 ? null : `T${index + 1}`,
      disposition: retireT2 && index === 1 ? 'excluded' : 'active',
      source_ref: `docs/plan.md#L${index + 1}`,
      source_digest: createHash('sha256').update(line).digest('hex'),
      live_replacement: `- T${index + 1} state is managed by Lattice`,
    })), batch_digest: '' };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const taskMigration = [{ from_task_id: 'T1', to_task_id: 'T1', state_policy: 'acquire_phase' },
    ...(retireT2 ? [{ from_task_id: 'T2', to_task_id: 'removed', state_policy: 'removed' }]
      : [{ from_task_id: 'T2', to_task_id: 'T2', state_policy: 'reset_pending' }])];
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1', entries: [
    { predecessor_task_id: 'T1', disposition: 'carry', successor_task_ids: ['T1'],
      reason: 'Phase獲得', evidence_digests: ['1'.repeat(64)] },
    { predecessor_task_id: 'T2', disposition: retireT2 ? 'retire' : 'replace',
      successor_task_ids: retireT2 ? [] : ['T2'],
      reason: retireT2 ? '削除' : '未完了taskの再起動', evidence_digests: ['2'.repeat(64)] },
  ], migration_digest: '' };
  runtimeTaskMigration.migration_digest = migrationDigest(runtimeTaskMigration);
  const phaseMigration = [{ from_phase_id: null, to_phase_id: 'phase-1', state_policy: 'reset' }];
  const desiredSeed = { schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: 'main',
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [{ task_id: 'T1', title: retitleT1 ? 'T1 retitled' : 'T1', lane: 'main',
      narrative_ref: `${sourceCutoverBatch.archive_ref}#L6`,
      narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' },
    ...(retireT2 ? [] : [{ task_id: 'T2', title: 'T2', lane: 'main',
      narrative_ref: `${sourceCutoverBatch.archive_ref}#L7`,
      narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' }])],
    phases: [phase], hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredSeed, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredSeed);
  const sourceInventory = { active: sourceCutoverBatch.operations
    .filter(({ disposition }) => disposition === 'active').map((operation, index) => ({
      task_id: operation.task_id, source_ref: `${sourceCutoverBatch.archive_ref}#L${index + 6}`,
      source_digest: operation.source_digest,
    })), excluded_tombstones: sourceCutoverBatch.operations
    .flatMap((operation, index) => operation.disposition === 'excluded' ? [{
      source_ref: `${sourceCutoverBatch.archive_ref}#L${index + 6}`,
      source_digest: operation.source_digest, exclusion_reason: 'removed task source',
    }] : []) };
  const reconciliation = { predecessor_reconciliation_digest: todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest }),
  source_inventory_digest: digestTodoArtifact(sourceInventory),
  desired_plan_digest: desiredPlan.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: todoMigrationDigest(taskMigration),
  phase_migration_digest: digestTodoArtifact(phaseMigration),
  source_cutover_batch_digest: sourceCutoverBatch.batch_digest, reconciliation_digest: '' };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const revision = { schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration, task_migration: taskMigration,
    phase_migration: phaseMigration, source_inventory: sourceInventory, reconciliation,
    source_cutover_batch: sourceCutoverBatch, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'plan.md'), `${sourceLines.join('\n')}\n`);
  return { root, revision, writer };
}

test('phase v3 acquire_phaseはPhase無し先行planのdoneを保ったままPhaseを獲得できる', async (t) => {
  const value = await acquirePhaseFixture(t);
  assert.equal(validatePhaseTodoRevision(value.revision), true);
  const receipt = await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  assert.equal(receipt.revision_digest, value.revision.revision_digest);
  const store = await readTodoStore({ repoRoot: value.root, now: COMMIT_AT });
  assert.equal(store.members[0].plan.schema, 'lattice.todo_plan.v5');
  const t1 = store.members[0].tasks.find(({ task_id }) => task_id === 'T1');
  assert.equal(t1.status, 'done');
  assert.equal(t1.started_at, INITIAL_AT);
  assert.equal(t1.done_at, INITIAL_AT);
  assert.notEqual(t1.evidence, null);
});

test('phase v3 acquire_phaseもremoved taskへのoutgoingだけを除外する', async (t) => {
  const value = await acquirePhaseFixture(t, { retireT2: true });
  assert.equal(validatePhaseTodoRevision(value.revision), true);
  await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  const store = await readTodoStore({ repoRoot: value.root, now: COMMIT_AT });
  assert.equal(store.members[0].tasks.find(({ task_id }) => task_id === 'T1').status, 'done');
  assert.equal(store.members[0].tasks.some(({ task_id }) => task_id === 'T2'), false);
});

test('phase v3 acquire_phaseはtitle変更をcarry_semantics_changedで拒否する', async (t) => {
  const value = await acquirePhaseFixture(t, { retitleT1: true });
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'carry_semantics_changed'
    && error.detail.from_task_id === 'T1');
});

// 既にphaseを持つtask(v5世代)がacquire_phaseで別Phaseへ付け替えを試みるfixture。
// 「獲得」はpredecessor側が未割当(null)の場合だけを許し、既存割当の変更は意味論の変化として
// 拒否し続ける(ADR 0147裁定4)。
async function acquirePhaseReassignFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-v3-acquire-reassign-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const phase1 = { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const initial = buildTodoPlan({ schema: 'lattice.todo_plan.v5', project_id: 'project-1',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [{ task_id: 'T1', title: 'T1', lane: 'main',
      narrative_ref: '.lattice/todo/source-ledger/cutover.md#L6',
      narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' }],
    phases: [phase1], hard_dependencies: [], joins: [], phase_accept_dependencies: [] });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: initial, genesis: { actor: ACTOR, recorded_at: INITIAL_AT } }], now: INITIAL_AT });
  const member = (await readTodoStore({ repoRoot: root, now: INITIAL_AT })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const phase2 = { phase_id: 'phase-2', title: 'Phase 2', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const sourceLines = ['- [ ] T1 source'];
  const sourceCutoverBatch = { batch_id: 'acquire-reassign-cutover',
    archive_ref: '.lattice/todo/source-ledger/cutover.md',
    operations: [{ task_id: 'T1', disposition: 'active', source_ref: 'docs/plan.md#L1',
      source_digest: createHash('sha256').update(sourceLines[0]).digest('hex'),
      live_replacement: '- T1 state is managed by Lattice' }], batch_digest: '' };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const taskMigration = [{ from_task_id: 'T1', to_task_id: 'T1', state_policy: 'acquire_phase' }];
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1', entries: [
    { predecessor_task_id: 'T1', disposition: 'carry', successor_task_ids: ['T1'],
      reason: 'Phase付け替え', evidence_digests: ['1'.repeat(64)] },
  ], migration_digest: '' };
  runtimeTaskMigration.migration_digest = migrationDigest(runtimeTaskMigration);
  const phaseMigration = [
    { from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' },
    { from_phase_id: null, to_phase_id: 'phase-2', state_policy: 'reset' },
  ];
  const desiredSeed = { schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: 'main',
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [{ task_id: 'T1', title: 'T1', lane: 'main',
      narrative_ref: `${sourceCutoverBatch.archive_ref}#L6`,
      narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-2' }],
    phases: [phase1, phase2], hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredSeed, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredSeed);
  const sourceInventory = { active: [{ task_id: 'T1',
    source_ref: `${sourceCutoverBatch.archive_ref}#L6`,
    source_digest: sourceCutoverBatch.operations[0].source_digest }], excluded_tombstones: [] };
  const reconciliation = { predecessor_reconciliation_digest: todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest }),
  source_inventory_digest: digestTodoArtifact(sourceInventory),
  desired_plan_digest: desiredPlan.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: todoMigrationDigest(taskMigration),
  phase_migration_digest: digestTodoArtifact(phaseMigration),
  source_cutover_batch_digest: sourceCutoverBatch.batch_digest, reconciliation_digest: '' };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const revision = { schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration, task_migration: taskMigration,
    phase_migration: phaseMigration, source_inventory: sourceInventory, reconciliation,
    source_cutover_batch: sourceCutoverBatch, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'plan.md'), `${sourceLines.join('\n')}\n`);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  return { root, revision, writer };
}

test('phase v3 acquire_phaseは既にPhaseを持つtaskの付け替えを拒否する', async (t) => {
  const value = await acquirePhaseReassignFixture(t);
  assert.equal(validatePhaseTodoRevision(value.revision), true);
  await assert.rejects(applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT }),
  (error) => error.code === 'REVISION_INVALID'
    && error.detail.reason === 'acquire_phase_requires_unassigned_predecessor'
    && error.detail.from_task_id === 'T1');
});

// v3 revisionはmanifestをv2へ昇格させる。以後のv1/v2 phase revisionがactive_revision_digestを
// 更新しないと、書込みは成功したように見えるのにstoreが二度と読めなくなる。
test('v3昇格後のv2 phase revisionはmanifestのactive_revision_digestを追従させる', async (t) => {
  const value = await fixture(t, { desiredEdge: false });
  await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision: value.revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  const afterV3 = await readTodoStore({ repoRoot: value.root, now: COMMIT_AT });
  assert.equal(afterV3.manifest.schema, 'lattice.todo_manifest.v2');
  const member = afterV3.members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const taskMigration = member.plan.tasks.map(({ task_id }) => ({
    from_task_id: task_id, to_task_id: task_id, state_policy: 'reset_pending' }));
  const phaseMigration = member.plan.phases.map(({ phase_id }) => ({
    from_phase_id: phase_id, to_phase_id: phase_id, state_policy: 'reset' }));
  const desiredSeed = { ...member.plan, plan_version: 'pending',
    predecessor_plan_digest: predecessor.plan_digest,
    tasks: member.plan.tasks.map((task) => (task.task_id === 'T2'
      ? { ...task, title: 'T2 retitled by v2 revision' } : { ...task })) };
  delete desiredSeed.topology_digest; delete desiredSeed.plan_digest;
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredSeed, taskMigration, phaseMigration });
  const revision = { schema: 'lattice.phase_todo_revision.v2', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: buildTodoPlan(desiredSeed),
    task_migration: taskMigration, phase_migration: phaseMigration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(revision), true);
  await applyPhaseTodoRevision({ repoRoot: value.root, writer: value.writer,
    revision, actor: ACTOR, recordedAt: COMMIT_AT, now: COMMIT_AT });
  const after = await readTodoStore({ repoRoot: value.root, now: COMMIT_AT });
  assert.equal(after.manifest.members[0].active_revision_digest, revision.revision_digest);
  assert.equal(after.members[0].plan.plan_version, revision.desired_plan.plan_version);
  assert.equal(projectTodoStatus(after, { parallelCandidates: [], planNotes: [] }).schema, 'lattice.todo_status_result.v7');
});
