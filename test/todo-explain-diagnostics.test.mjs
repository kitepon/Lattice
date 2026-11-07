import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalizeTodoArtifact, digestTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { explainTodoExtraction, validateTodoExtraction } from '../src/todo-migration.mjs';
import { buildTodoPlan } from '../src/todo-store.mjs';
import {
  explainPhaseTodoRevision, explainTodoRevision, explainTodoRevisionSet,
  phaseTodoRevisionPlanVersion, todoLegacyReconciliationDigest, todoReconciliationDigest,
  todoRevisionPlanVersion, todoSourceInventoryDigest, validatePhaseTodoRevision,
  validateTodoRevision, validateTodoRevisionSet,
} from '../src/todo-revision.mjs';
import { runTodoCli } from '../src/todo-cli.mjs';

/**
 * ADR 0130の案内規律をmigration/revision入口へ拡張したt06の固定テスト。
 *
 * 目的は「schema_invalidだけでは何のfieldがどう壊れているか分からない」という
 * 実運用の詰まりを解消したことの検証であり、既存の可否判定（validateTodoExtraction等）は
 * 一切変えていないことも併せて固定する。特に、実運用で最も時間を溶かした
 * 「配列のソート漏れ」を1件、名指しできることを固定する。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'todo-migration');
const DIGEST = '1'.repeat(64);
const HEAD = '2'.repeat(64);

function stdio() {
  const out = []; const err = [];
  return {
    stdout: { write: (chunk) => { out.push(chunk); } },
    stderr: { write: (chunk) => { err.push(chunk); } },
    out, err,
  };
}

async function gitWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-explain-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

// --- extraction (migrate) ---

test('explainTodoExtractionは必須key欠落をfieldごと名指しし、validateTodoExtractionの可否は変えない', async () => {
  const value = JSON.parse(await readFile(path.join(FIXTURE_ROOT, 'valid.json'), 'utf8'));
  assert.equal(validateTodoExtraction(value), true);
  assert.deepEqual(explainTodoExtraction(value), { valid: true });

  const missingPlanVersion = structuredClone(value);
  delete missingPlanVersion.plan_version;
  assert.equal(validateTodoExtraction(missingPlanVersion), false);
  assert.deepEqual(explainTodoExtraction(missingPlanVersion), {
    valid: false, reason: 'missing_required_key', path: '/plan_version',
  });
});

test('explainTodoExtractionはtasksのソート違反をindexで名指しする（実運用最頻出の詰まり）', async () => {
  const value = JSON.parse(await readFile(path.join(FIXTURE_ROOT, 'valid.json'), 'utf8'));
  const unsorted = structuredClone(value);
  unsorted.tasks.reverse();
  unsorted.extraction_digest = todoSelfDigest(unsorted, 'extraction_digest');
  assert.equal(validateTodoExtraction(unsorted), false);
  const explained = explainTodoExtraction(unsorted);
  assert.equal(explained.valid, false);
  assert.equal(explained.reason, 'unsorted_or_duplicate_collection');
  assert.match(explained.path, /^\/tasks\/\d+$/u);
});

test('explainTodoExtractionはdigest不一致を該当fieldへ名指しする', async () => {
  const value = JSON.parse(await readFile(path.join(FIXTURE_ROOT, 'valid.json'), 'utf8'));
  const corrupted = structuredClone(value);
  corrupted.extraction_digest = 'f'.repeat(64);
  assert.equal(validateTodoExtraction(corrupted), false);
  const explained = explainTodoExtraction(corrupted);
  assert.equal(explained.valid, false);
  assert.equal(explained.reason, 'extraction_digest_mismatch');
  assert.equal(explained.path, '/extraction_digest');
  assert.equal(explained.actual, 'f'.repeat(64));
  assert.match(explained.expected, /^[0-9a-f]{64}$/u);
});

test('todo migrate --inputはschema違反detailへviolation_reason/violation_pathを載せる（CLI入口経由）', async (context) => {
  const root = await gitWorkspace(context);
  const value = JSON.parse(await readFile(path.join(FIXTURE_ROOT, 'valid.json'), 'utf8'));
  const broken = structuredClone(value);
  broken.schema = 'lattice.todo_extraction.v3';
  for (const task of broken.tasks) {
    task.start = null;
    task.design_memo = 'NO_PLAN';
  }
  delete broken.plan_version;
  broken.extraction_digest = todoSelfDigest(broken, 'extraction_digest');
  await writeFile(path.join(root, 'broken.json'), `${JSON.stringify(broken)}\n`);
  const { stdout, stderr, err } = stdio();
  const env = { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' };
  const exitCode = await runTodoCli({
    argv: ['migrate', '--input', 'broken.json'], cwd: root, stdout, stderr, env,
  });
  assert.equal(exitCode, 1);
  const payload = JSON.parse(err[0]);
  assert.equal(payload.code, 'INVALID_TODO_EXTRACTION');
  assert.equal(payload.detail.violation_reason, 'missing_required_key');
  assert.equal(payload.detail.violation_path, '/plan_version');
  assert.equal(payload.detail.violation_kind, 'missing_required_key');
  assert.equal(payload.detail.pointer, '/plan_version');
  assert.equal(typeof payload.detail.next_action, 'string');
});

// --- revise (todo_revision.v1/v2) ---

test('todo migrateはhard dependencyの整列規則と入力indexを返す', async (context) => {
  const root = await gitWorkspace(context);
  const value = JSON.parse(await readFile(path.join(FIXTURE_ROOT, 'valid.json'), 'utf8'));
  value.schema = 'lattice.todo_extraction.v3';
  for (const task of value.tasks) {
    task.start = null;
    task.design_memo = 'NO_PLAN';
  }
  value.hard_dependencies.push(structuredClone(value.hard_dependencies[0]));
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  await writeFile(path.join(root, 'unsorted.json'), `${JSON.stringify(value)}\n`);
  const { stdout, stderr, err } = stdio();
  const exitCode = await runTodoCli({
    argv: ['migrate', '--input', 'unsorted.json'], cwd: root, stdout, stderr,
    env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(exitCode, 1);
  const payload = JSON.parse(err[0]);
  assert.equal(payload.code, 'INVALID_TODO_EXTRACTION');
  assert.equal(payload.detail.pointer, '/hard_dependencies/1');
  assert.equal(payload.detail.violation_kind, 'unsorted_or_duplicate_collection');
  assert.equal(payload.detail.expected.order, 'ascending_unique');
});

const taskV3 = (taskId, parentTaskId = null) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null,
  narrative_anchor: null, compile_binding: null, parent_task_id: parentTaskId,
});

function revisionFixture(planKey = 'main') {
  const predecessor = { plan_digest: DIGEST, journal_head_digest: HEAD, plan_version: 'v1' };
  const taskMigration = [
    { from_task_id: 'A1', to_task_id: 'P1', state_policy: 'carry' },
    { from_task_id: 'A2', to_task_id: 'T1', state_policy: 'reset_pending' },
  ];
  const desiredPlanInput = {
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: planKey, plan_version: 'pending',
    predecessor_plan_digest: DIGEST, tasks: [taskV3('P1'), taskV3('T1', 'P1')],
    hard_dependencies: [], joins: [],
  };
  const sourceInventory = {
    active: [
      { task_id: 'P1', source_ref: 'docs/plan.md#L1', source_digest: '3'.repeat(64) },
      { task_id: 'T1', source_ref: 'docs/plan.md#L2', source_digest: '4'.repeat(64) },
    ],
    excluded_tombstones: [{
      source_ref: 'docs/plan.md#L3', source_digest: '5'.repeat(64), exclusion_reason: 'retired',
    }],
  };
  desiredPlanInput.plan_version = todoRevisionPlanVersion({
    projectId: 'project-1', planKey, predecessor, desiredPlan: desiredPlanInput,
    taskMigration, sourceInventory,
  });
  const desiredPlan = buildTodoPlan(desiredPlanInput);
  const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
  const predecessorReconciliationDigest = todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest,
  });
  const reconciliation = {
    predecessor_reconciliation_digest: predecessorReconciliationDigest,
    source_inventory_digest: sourceInventoryDigest,
    reconciliation_digest: todoReconciliationDigest({
      predecessorReconciliationDigest, sourceInventoryDigest, predecessor,
      desiredPlanDigest: desiredPlan.plan_digest, taskMigration,
    }),
  };
  const revision = {
    schema: 'lattice.todo_revision.v1', project_id: 'project-1', plan_key: planKey,
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory, reconciliation, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

test('explainTodoRevisionは必須key欠落・ソート違反・digest不一致を名指しし、可否は変えない', () => {
  const revision = revisionFixture();
  assert.equal(validateTodoRevision(revision), true);
  assert.deepEqual(explainTodoRevision(revision), { valid: true });

  const missingPredecessor = structuredClone(revision);
  delete missingPredecessor.predecessor;
  assert.equal(validateTodoRevision(missingPredecessor), false);
  assert.deepEqual(explainTodoRevision(missingPredecessor), {
    valid: false, reason: 'missing_required_key', path: '/predecessor',
  });

  const unsortedMigration = structuredClone(revision);
  unsortedMigration.task_migration.reverse();
  unsortedMigration.revision_digest = todoSelfDigest(unsortedMigration, 'revision_digest');
  assert.equal(validateTodoRevision(unsortedMigration), false);
  const explainedSort = explainTodoRevision(unsortedMigration);
  assert.equal(explainedSort.valid, false);
  assert.equal(explainedSort.reason, 'unsorted_or_duplicate_collection');
  assert.match(explainedSort.path, /^\/task_migration\/\d+\/from_task_id$/u);

  const corruptedDigest = structuredClone(revision);
  corruptedDigest.revision_digest = 'f'.repeat(64);
  assert.equal(validateTodoRevision(corruptedDigest), false);
  assert.deepEqual(explainTodoRevision(corruptedDigest), {
    valid: false, reason: 'revision_digest_mismatch', path: '/revision_digest',
  });
});

// --- revise-phase (phase_todo_revision.v3) ---

function phaseRevisionV3Fixture(planKey = 'main') {
  const predecessor = { plan_digest: DIGEST, journal_head_digest: HEAD, plan_version: 'v1' };
  const phase = {
    phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'],
  };
  const taskV4 = (taskId, line) => ({
    task_id: taskId, title: taskId, lane: 'main',
    narrative_ref: `.lattice/todo/source-ledger/cutover.md#L${line}`,
    narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1',
  });
  const runtimeTaskMigration = {
    schema: 'lattice.runtime_task_migration.v1',
    entries: [
      { predecessor_task_id: 'T1', disposition: 'carry', successor_task_ids: ['T1'],
        reason: 'completed task survives recompile', evidence_digests: ['6'.repeat(64)] },
      { predecessor_task_id: 'T2', disposition: 'carry', successor_task_ids: ['T2'],
        reason: 'unfinished task carries pending', evidence_digests: ['7'.repeat(64)] },
    ],
    migration_digest: '',
  };
  runtimeTaskMigration.migration_digest = todoSelfDigest(runtimeTaskMigration, 'migration_digest');
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: 'carry' },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: 'carry' },
  ];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredSeed = {
    schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: planKey,
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [taskV4('T1', 6), taskV4('T2', 7)], phases: [phase],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [],
  };
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({
    projectId: 'project-1', planKey, predecessor, desiredPlan: desiredSeed,
    taskMigration, phaseMigration,
  });
  const desiredPlan = buildTodoPlan(desiredSeed);
  const sourceCutoverBatch = {
    batch_id: 'cutover-1', archive_ref: '.lattice/todo/source-ledger/cutover.md',
    operations: [
      { task_id: 'T1', disposition: 'active', source_ref: 'docs/plan.md#L1',
        source_digest: '8'.repeat(64), live_replacement: '- T1 state is managed by Lattice' },
      { task_id: 'T2', disposition: 'active', source_ref: 'docs/plan.md#L2',
        source_digest: '9'.repeat(64), live_replacement: '- T2 state is managed by Lattice' },
    ],
    batch_digest: '',
  };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const sourceInventory = {
    active: sourceCutoverBatch.operations.map((operation, index) => ({
      task_id: operation.task_id,
      source_ref: `${sourceCutoverBatch.archive_ref}#L${index + 6}`,
      source_digest: operation.source_digest,
    })),
    excluded_tombstones: [],
  };
  const reconciliation = {
    predecessor_reconciliation_digest: todoLegacyReconciliationDigest({
      planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest,
    }),
    source_inventory_digest: digestTodoArtifact(sourceInventory),
    desired_plan_digest: desiredPlan.plan_digest,
    runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
    task_migration_digest: todoSelfDigest(
      { task_migration: taskMigration, task_migration_digest: '' }, 'task_migration_digest',
    ),
    phase_migration_digest: digestTodoArtifact(phaseMigration),
    source_cutover_batch_digest: sourceCutoverBatch.batch_digest,
    reconciliation_digest: '',
  };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const revision = {
    schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1', plan_key: planKey,
    predecessor, desired_plan: desiredPlan, runtime_task_migration: runtimeTaskMigration,
    task_migration: taskMigration, phase_migration: phaseMigration, source_inventory: sourceInventory,
    reconciliation, source_cutover_batch: sourceCutoverBatch, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

test('explainPhaseTodoRevisionは12 keyのうちどれが欠けても名指しし、可否は変えない', () => {
  const revision = phaseRevisionV3Fixture();
  assert.equal(validatePhaseTodoRevision(revision), true);
  assert.deepEqual(explainPhaseTodoRevision(revision), { valid: true });

  for (const key of Object.keys(revision)) {
    const missing = structuredClone(revision);
    delete missing[key];
    assert.equal(validatePhaseTodoRevision(missing), false, key);
    const explained = explainPhaseTodoRevision(missing);
    assert.equal(explained.valid, false, key);
    if (key === 'schema') {
      // schema自体の欠落は「必須key欠落」より前に「契約が特定できない」として弾かれる
      // ——validatePhaseTodoRevisionもまず schema で版を選ぶため、この優先順位は本体の判定と一致する。
      assert.equal(explained.reason, 'schema_mismatch', key);
      assert.equal(explained.path, '/schema', key);
    } else {
      assert.equal(explained.reason, 'missing_required_key', key);
      assert.equal(explained.path, `/${key}`, key);
    }
  }
});

test('explainPhaseTodoRevisionはtask_migrationのソート違反をindexで名指しする（実運用最頻出の詰まり）', () => {
  const revision = phaseRevisionV3Fixture();
  const unsorted = structuredClone(revision);
  unsorted.task_migration.reverse();
  unsorted.reconciliation.task_migration_digest = todoSelfDigest(
    { task_migration: unsorted.task_migration, task_migration_digest: '' }, 'task_migration_digest',
  );
  unsorted.reconciliation.reconciliation_digest = todoSelfDigest(
    unsorted.reconciliation, 'reconciliation_digest',
  );
  unsorted.revision_digest = todoSelfDigest(unsorted, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(unsorted), false);
  const explained = explainPhaseTodoRevision(unsorted);
  assert.equal(explained.valid, false);
  assert.equal(explained.reason, 'unsorted_or_duplicate_collection');
  assert.match(explained.path, /^\/task_migration\/\d+\/from_task_id$/u);
});

test('explainPhaseTodoRevisionはruntime_task_migration.entriesのソート違反もindexで名指しする', () => {
  const revision = phaseRevisionV3Fixture();
  const unsorted = structuredClone(revision);
  unsorted.runtime_task_migration.entries.reverse();
  unsorted.runtime_task_migration.migration_digest = todoSelfDigest(
    unsorted.runtime_task_migration, 'migration_digest',
  );
  unsorted.reconciliation.runtime_task_migration_digest = unsorted.runtime_task_migration.migration_digest;
  unsorted.reconciliation.reconciliation_digest = todoSelfDigest(
    unsorted.reconciliation, 'reconciliation_digest',
  );
  unsorted.revision_digest = todoSelfDigest(unsorted, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(unsorted), false);
  const explained = explainPhaseTodoRevision(unsorted);
  assert.equal(explained.valid, false);
  assert.equal(explained.reason, 'unsorted_or_duplicate_collection');
  assert.match(explained.path, /^\/runtime_task_migration\/entries\/\d+\/predecessor_task_id$/u);
});

test('explainPhaseTodoRevisionはreconciliationの各digestを個別に名指しする', () => {
  const revision = phaseRevisionV3Fixture();
  const corrupted = structuredClone(revision);
  corrupted.reconciliation.phase_migration_digest = 'f'.repeat(64);
  corrupted.reconciliation.reconciliation_digest = todoSelfDigest(
    corrupted.reconciliation, 'reconciliation_digest',
  );
  corrupted.revision_digest = todoSelfDigest(corrupted, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(corrupted), false);
  assert.deepEqual(explainPhaseTodoRevision(corrupted), {
    valid: false, reason: 'phase_migration_digest_mismatch', path: '/reconciliation/phase_migration_digest',
  });
});

test('todo revise-phaseはtask_migrationのソート違反detailへviolation_path/violation_reasonを載せる（CLI入口経由）', async (context) => {
  const root = await gitWorkspace(context);
  const revision = phaseRevisionV3Fixture();
  const unsorted = structuredClone(revision);
  unsorted.task_migration.reverse();
  unsorted.reconciliation.task_migration_digest = todoSelfDigest(
    { task_migration: unsorted.task_migration, task_migration_digest: '' }, 'task_migration_digest',
  );
  unsorted.reconciliation.reconciliation_digest = todoSelfDigest(
    unsorted.reconciliation, 'reconciliation_digest',
  );
  unsorted.revision_digest = todoSelfDigest(unsorted, 'revision_digest');
  await writeFile(path.join(root, 'revise-phase.json'), `${canonicalizeTodoArtifact(unsorted)}\n`);
  const { stdout, stderr, err } = stdio();
  const env = { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' };
  const exitCode = await runTodoCli({
    argv: ['revise-phase', '--plan', 'main', '--input', 'revise-phase.json'],
    cwd: root, stdout, stderr, env,
  });
  assert.equal(exitCode, 1);
  const payload = JSON.parse(err[0]);
  assert.equal(payload.code, 'REVISION_INVALID');
  assert.equal(payload.detail.violation_reason, 'unsorted_or_duplicate_collection');
  assert.match(payload.detail.violation_path, /^\/task_migration\/\d+\/from_task_id$/u);
});

// --- revise-set (todo_revision_set.v3) ---

function phaseRevisionV1Fixture(planKey = 'main-b') {
  const predecessor = { plan_digest: DIGEST, journal_head_digest: HEAD, plan_version: 'v1' };
  const phase = {
    phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'],
  };
  const taskV4 = (taskId) => ({
    task_id: taskId, title: taskId, lane: 'main', narrative_ref: null,
    narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1',
  });
  const taskMigration = [{ from_task_id: 'B1', to_task_id: 'B1', state_policy: 'carry' }];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredSeed = {
    schema: 'lattice.todo_plan.v4', project_id: 'project-1', plan_key: planKey,
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [taskV4('B1')], phases: [phase], hard_dependencies: [], joins: [],
  };
  desiredSeed.plan_version = phaseTodoRevisionPlanVersion({
    projectId: 'project-1', planKey, predecessor, desiredPlan: desiredSeed,
    taskMigration, phaseMigration,
  });
  const desiredPlan = buildTodoPlan(desiredSeed);
  const revision = {
    schema: 'lattice.phase_todo_revision.v1', project_id: 'project-1', plan_key: planKey,
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    phase_migration: phaseMigration, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

function revisionSetFixture() {
  const first = revisionFixture('main-a');
  const second = phaseRevisionV1Fixture('main-b');
  const set = {
    schema: 'lattice.todo_revision_set.v3', project_id: 'project-1',
    revisions: [first, second], revision_set_digest: '',
  };
  set.revision_set_digest = todoSelfDigest(set, 'revision_set_digest');
  return set;
}

test('explainTodoRevisionSetはmember違反をrevisions配下のpathへ伝播し、可否は変えない', () => {
  const set = revisionSetFixture();
  assert.equal(validateTodoRevisionSet(set), true);
  assert.deepEqual(explainTodoRevisionSet(set), { valid: true });

  const missingRevisions = structuredClone(set);
  delete missingRevisions.revisions;
  assert.equal(validateTodoRevisionSet(missingRevisions), false);
  assert.deepEqual(explainTodoRevisionSet(missingRevisions), {
    valid: false, reason: 'missing_required_key', path: '/revisions',
  });

  const memberBroken = structuredClone(set);
  delete memberBroken.revisions[0].predecessor;
  assert.equal(validateTodoRevisionSet(memberBroken), false);
  assert.deepEqual(explainTodoRevisionSet(memberBroken), {
    valid: false, reason: 'missing_required_key', path: '/revisions/0/predecessor',
  });
});

test('explainTodoRevisionSetはplan_keyのソート違反を名指しする（実運用最頻出の詰まり）', () => {
  const set = revisionSetFixture();
  const unsorted = structuredClone(set);
  unsorted.revisions.reverse();
  unsorted.revision_set_digest = todoSelfDigest(unsorted, 'revision_set_digest');
  assert.equal(validateTodoRevisionSet(unsorted), false);
  const explained = explainTodoRevisionSet(unsorted);
  assert.equal(explained.valid, false);
  assert.equal(explained.reason, 'unsorted_or_duplicate_collection');
  assert.match(explained.path, /^\/revisions\/\d+\/plan_key$/u);
});

test('explainTodoRevisionSetはdigest不一致を該当fieldへ名指しする', () => {
  const set = revisionSetFixture();
  const corrupted = structuredClone(set);
  corrupted.revision_set_digest = 'f'.repeat(64);
  assert.equal(validateTodoRevisionSet(corrupted), false);
  assert.deepEqual(explainTodoRevisionSet(corrupted), {
    valid: false, reason: 'revision_set_digest_mismatch', path: '/revision_set_digest',
  });
});

test('todo revise-setはmember欠落detailへviolation_path/violation_reasonを載せる（CLI入口経由）', async (context) => {
  const root = await gitWorkspace(context);
  const set = revisionSetFixture();
  const broken = structuredClone(set);
  delete broken.revisions[0].predecessor;
  await writeFile(path.join(root, 'revise-set.json'), `${canonicalizeTodoArtifact(broken)}\n`);
  const { stdout, stderr, err } = stdio();
  const env = { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' };
  const exitCode = await runTodoCli({
    argv: ['revise-set', '--input', 'revise-set.json'], cwd: root, stdout, stderr, env,
  });
  assert.equal(exitCode, 1);
  const payload = JSON.parse(err[0]);
  assert.equal(payload.code, 'REVISION_SET_INVALID');
  assert.equal(payload.detail.violation_reason, 'missing_required_key');
  assert.equal(payload.detail.violation_path, '/revisions/0/predecessor');
});
