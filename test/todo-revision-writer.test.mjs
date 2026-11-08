import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  TodoStoreError,
  appendImportedPlan,
  applyTodoRevision,
  buildTodoPlan,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import {
  todoCutoverArchiveSourceRef,
  todoLegacyReconciliationDigest,
  todoReconciliationDigest,
  todoRevisionPlanVersion,
  todoSourceInventoryDigest,
} from '../src/todo-revision.mjs';

const NOW = '2026-07-19T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
const task = (taskId, title = taskId) => ({
  task_id: taskId, title, lane: 'main', narrative_ref: null,
  narrative_anchor: null, compile_binding: null, parent_task_id: null,
});
const ref = (taskId) => ({ project_id: 'project-1', plan_key: 'main', task_id: taskId });
const digest = (text) => createHash('sha256').update(text).digest('hex');

async function fixture(context, { hardDependencies = [], joins = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-revision-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'plan.md'), [1, 2, 3, 4, 5, 6]
    .map((index) => `- [ ] T${index}`).join('\n') + '\n');
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [task('T1'), task('T2'), task('T3'), task('T4'), task('T5')],
        hard_dependencies: hardDependencies, joins,
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
  });
  return root;
}

async function promoteManifestV2(root) {
  const manifestRef = path.join(root, '.lattice', 'todo', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestRef, 'utf8'));
  manifest.schema = 'lattice.todo_manifest.v2';
  for (const member of manifest.members) {
    const plan = JSON.parse(await readFile(path.join(root, member.plan_ref), 'utf8'));
    member.active_revision_digest = plan.plan_digest;
  }
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  await writeFile(manifestRef, `${canonicalizeTodoArtifact(manifest)}\n`);
}

async function revisionFor(root, {
  title = 'T1', migrationPolicy = 'carry', removeT5 = false,
  removeT5Reason = 'task removed by successor revision', extraTombstones = [],
  hardDependencies = [], joins = [], t6Anchor = null, t1ParentTaskId = null, migrationPolicies = {},
  sourceTextByTask = {}, planSchema = 'lattice.todo_plan.v3', designMemoByTask = {},
} = {}) {
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const previous = store.members[0];
  const predecessor = {
    plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest,
    plan_version: previous.plan.plan_version,
  };
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: migrationPolicies.T1 ?? migrationPolicy },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: migrationPolicies.T2 ?? 'carry' },
    { from_task_id: 'T3', to_task_id: 'T3', state_policy: migrationPolicies.T3 ?? 'carry' },
    { from_task_id: 'T4', to_task_id: 'T4', state_policy: migrationPolicies.T4 ?? 'carry' },
    removeT5
      ? { from_task_id: 'T5', to_task_id: 'removed', state_policy: 'removed' }
      : { from_task_id: 'T5', to_task_id: 'T5', state_policy: 'reset_pending' },
    ...(previous.plan.tasks.some(({ task_id }) => task_id === 'T6')
      ? [{ from_task_id: 'T6', to_task_id: 'T6', state_policy: migrationPolicies.T6 ?? 'carry' }]
      : []),
  ];
  const sourceText = (taskId) => sourceTextByTask[taskId]
    ?? `- [ ] ${taskId}`;
  const sourceInventory = {
    active: [
      { task_id: 'T1', source_ref: 'plan.md#L1', source_digest: digest(sourceText('T1')) },
      { task_id: 'T2', source_ref: 'plan.md#L2', source_digest: digest(sourceText('T2')) },
      { task_id: 'T3', source_ref: 'plan.md#L3', source_digest: digest(sourceText('T3')) },
      { task_id: 'T4', source_ref: 'plan.md#L4', source_digest: digest(sourceText('T4')) },
      ...(removeT5 ? [] : [
        { task_id: 'T5', source_ref: 'plan.md#L5', source_digest: digest(sourceText('T5')) },
      ]),
      { task_id: 'T6', source_ref: 'plan.md#L6', source_digest: digest(sourceText('T6')) },
    ],
    excluded_tombstones: [...(removeT5 ? [{
      source_ref: 'plan.md#L5', source_digest: digest(sourceText('T5')),
      exclusion_reason: removeT5Reason,
    }] : []), ...extraTombstones].sort((left, right) => left.source_ref.localeCompare(right.source_ref)),
  };
  const desiredTask = (taskId, taskTitle = taskId) => ({
    ...task(taskId, taskTitle),
    ...(planSchema === 'lattice.todo_plan.v6'
      ? { design_memo: designMemoByTask[taskId]
          ?? (taskId === 'T1' ? 'NO_PLAN' : `## 方針\n\n${taskId}の設計メモ`) }
      : {}),
  });
  const desiredInput = {
    schema: planSchema, project_id: 'project-1', plan_key: 'main',
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [{ ...desiredTask('T1', title), parent_task_id: t1ParentTaskId },
      desiredTask('T2'), desiredTask('T3'), desiredTask('T4'),
      ...(removeT5 ? [] : [desiredTask('T5')]), {
        ...desiredTask('T6'),
        narrative_ref: t6Anchor === null ? null : t6Anchor.origin_plan_ref,
        narrative_anchor: t6Anchor,
      }],
    hard_dependencies: hardDependencies, joins,
  };
  desiredInput.plan_version = todoRevisionPlanVersion({
    projectId: 'project-1', planKey: 'main', predecessor, desiredPlan: desiredInput,
    taskMigration, sourceInventory,
  });
  const desiredPlan = buildTodoPlan(desiredInput);
  const activeGenesis = previous.journal.events[0];
  const predecessorReconciliationDigest = activeGenesis.schema === 'lattice.todo_event.v2'
    ? activeGenesis.reconciliation_digest
    : todoLegacyReconciliationDigest({
      planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest,
    });
  const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
  const reconciliation = {
    predecessor_reconciliation_digest: predecessorReconciliationDigest,
    source_inventory_digest: sourceInventoryDigest,
    reconciliation_digest: todoReconciliationDigest({
      predecessorReconciliationDigest, sourceInventoryDigest, predecessor,
      desiredPlanDigest: desiredPlan.plan_digest, taskMigration,
    }),
  };
  const revision = {
    schema: 'lattice.todo_revision.v1', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory, reconciliation, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

async function cutoverRevisionFor(root, {
  twoFiles = false, badDigest = false, breakListStructure = false,
} = {}) {
  if (twoFiles) {
    await writeFile(path.join(root, 'extra.md'), '- [ ] T6\n');
    await writeFile(path.join(root, 'plan.md'), [1, 2, 3, 4, 5]
      .map((index) => `- [ ] T${index}`).join('\n') + '\nT6はextra.mdへ記載\n');
  }
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const previous = store.members[0];
  const predecessor = {
    plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest,
    plan_version: previous.plan.plan_version,
  };
  const taskMigration = ['T1', 'T2', 'T3', 'T4', 'T5'].map((taskId) => ({
    from_task_id: taskId, to_task_id: taskId,
    state_policy: taskId === 'T5' ? 'reset_pending' : 'carry_reconciled_metadata',
  }));
  const operations = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((taskId, offset) => ({
    task_id: taskId,
    disposition: 'active',
    source_ref: twoFiles && taskId === 'T6' ? 'extra.md#L1' : `plan.md#L${offset + 1}`,
    source_digest: digest(`- [ ] ${taskId}`),
    live_replacement: `- Lattice管理: ${taskId}`,
  })).sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  if (badDigest) operations.at(-1).source_digest = 'f'.repeat(64);
  if (breakListStructure) operations.at(-1).live_replacement = '<!-- Lattice管理 -->';
  const sourceCutoverBatch = {
    batch_id: 'batch-1', archive_ref: 'docs/archive/main-batch-1.md',
    operations, batch_digest: '',
  };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const sourceInventory = {
    active: operations.map((operation, index) => ({
      task_id: operation.task_id,
      source_ref: todoCutoverArchiveSourceRef(sourceCutoverBatch, index),
      source_digest: operation.source_digest,
    })).sort((left, right) => left.task_id.localeCompare(right.task_id)),
    excluded_tombstones: [],
  };
  const desiredInput = {
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'main',
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((taskId) => {
      const index = operations.findIndex((operation) => operation.task_id === taskId);
      return { ...task(taskId), narrative_ref: todoCutoverArchiveSourceRef(sourceCutoverBatch, index) };
    }),
    hard_dependencies: [], joins: [],
  };
  desiredInput.plan_version = todoRevisionPlanVersion({
    projectId: 'project-1', planKey: 'main', predecessor, desiredPlan: desiredInput,
    taskMigration, sourceInventory, sourceCutoverBatch,
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
      desiredPlanDigest: desiredPlan.plan_digest, taskMigration, sourceCutoverBatch,
    }),
  };
  const revision = {
    schema: 'lattice.todo_revision.v2', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory, source_cutover_batch: sourceCutoverBatch,
    reconciliation, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

function pinnedLegacyCommit(root) {
  const content = '- [x] H1\n- [ ] H2\n';
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: content, encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['mktree'], {
    cwd: root, input: `100644 blob ${blob}\tlegacy.md\n`, encoding: 'utf8',
  }).trim();
  return execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: root,
    input: `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1760000000 +0000\ncommitter Fixture <fixture@example.invalid> 1760000000 +0000\n\nfixture\n`,
    encoding: 'utf8',
  }).trim();
}

async function historicalRevisionFor(root) {
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const previous = store.members.find(({ plan }) => plan.plan_key === 'archive');
  const predecessor = { plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest,
    plan_version: previous.plan.plan_version };
  const taskMigration = [
    { from_task_id: 'H1', to_task_id: 'H1', state_policy: 'carry' },
    { from_task_id: 'H2', to_task_id: 'H2', state_policy: 'carry' },
  ];
  const sourceInventory = { active: [
    { task_id: 'H1', source_ref: 'reconcile.md#L1', source_digest: digest('- [x] H1') },
    { task_id: 'H2', source_ref: 'reconcile.md#L2', source_digest: digest('- [ ] H2') },
  ], excluded_tombstones: [] };
  const desiredInput = { schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'archive', plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [task('H1'), task('H2')], hard_dependencies: [], joins: [] };
  desiredInput.plan_version = todoRevisionPlanVersion({ projectId: 'project-1', planKey: 'archive',
    predecessor, desiredPlan: desiredInput, taskMigration, sourceInventory });
  const desiredPlan = buildTodoPlan(desiredInput);
  const predecessorReconciliationDigest = todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest,
  });
  const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
  const reconciliation = { predecessor_reconciliation_digest: predecessorReconciliationDigest,
    source_inventory_digest: sourceInventoryDigest,
    reconciliation_digest: todoReconciliationDigest({ predecessorReconciliationDigest,
      sourceInventoryDigest, predecessor, desiredPlanDigest: desiredPlan.plan_digest, taskMigration }) };
  const revision = { schema: 'lattice.todo_revision.v1', project_id: 'project-1',
    plan_key: 'archive', predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory, reconciliation, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

const apply = (root, revision, extra = {}) => applyTodoRevision({
  repoRoot: root, writer, revision, actor: ACTOR, recordedAt: NOW, now: NOW, ...extra,
});

test('v2 cutoverは複数ToDo・複数fileを一括移転してlive checkboxを断ち切る', async (context) => {
  const root = await fixture(context);
  const revision = await cutoverRevisionFor(root, { twoFiles: true });
  await chmod(path.join(root, 'plan.md'), 0o1754);
  const sourceMode = (await stat(path.join(root, 'plan.md'))).mode & 0o7777;
  const result = await apply(root, revision);
  assert.equal(result.schema, 'lattice.todo_revise_result.v2');
  assert.equal(result.source_cutover.operation_count, 6);
  assert.equal((await readFile(path.join(root, 'plan.md'), 'utf8')).match(/\[[ xX]\]/gu), null);
  assert.equal((await readFile(path.join(root, 'extra.md'), 'utf8')).match(/\[[ xX]\]/gu), null);
  assert.equal((await stat(path.join(root, 'plan.md'))).mode & 0o7777, sourceMode);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(root, 'docs/archive/main-batch-1.md'))).mode & 0o777, 0o644);
  }
  const archive = await readFile(path.join(root, 'docs/archive/main-batch-1.md'), 'utf8');
  assert.deepEqual(archive.split('\n').slice(5, 11), revision.source_cutover_batch.operations
    .map(({ task_id }) => `- [ ] ${task_id}`));
});

test('v2 cutoverはbatch内1件の不一致でsource・archive・storeを全て無変更にする', async (context) => {
  const root = await fixture(context);
  const revision = await cutoverRevisionFor(root, { badDigest: true });
  const beforeSource = await readFile(path.join(root, 'plan.md'));
  const beforeManifest = await readFile(path.join(root, '.lattice/todo/manifest.json'));
  await assert.rejects(apply(root, revision), (error) => error instanceof TodoStoreError
    && error.code === 'RECONCILIATION_INCOMPLETE');
  assert.deepEqual(await readFile(path.join(root, 'plan.md')), beforeSource);
  assert.deepEqual(await readFile(path.join(root, '.lattice/todo/manifest.json')), beforeManifest);
  await assert.rejects(readFile(path.join(root, 'docs/archive/main-batch-1.md')), { code: 'ENOENT' });
});

test('v2 cutoverはcheckbox親listを壊すreplacementを全体無変更で拒否する', async (context) => {
  const root = await fixture(context);
  const revision = await cutoverRevisionFor(root, { breakListStructure: true });
  const beforeSource = await readFile(path.join(root, 'plan.md'));
  const beforeManifest = await readFile(path.join(root, '.lattice/todo/manifest.json'));
  await assert.rejects(apply(root, revision), (error) => error instanceof TodoStoreError
    && error.code === 'RECONCILIATION_INCOMPLETE'
    && error.detail.reason === 'live_replacement_breaks_list_structure');
  assert.deepEqual(await readFile(path.join(root, 'plan.md')), beforeSource);
  assert.deepEqual(await readFile(path.join(root, '.lattice/todo/manifest.json')), beforeManifest);
});

test('v2 cutoverは既存archiveとhardlink sourceをactivation前に拒否する', async (context) => {
  const archiveConflict = await fixture(context);
  const conflictRevision = await cutoverRevisionFor(archiveConflict);
  await mkdir(path.join(archiveConflict, 'docs/archive'), { recursive: true });
  await writeFile(path.join(archiveConflict, 'docs/archive/main-batch-1.md'), 'occupied\n');
  await assert.rejects(apply(archiveConflict, conflictRevision), (error) => error instanceof TodoStoreError
    && error.code === 'REVISION_CONFLICT' && error.detail.reason === 'source_cutover_archive_exists');
  assert.match(await readFile(path.join(archiveConflict, 'plan.md'), 'utf8'), /- \[ \] T1/u);

  const hardlinked = await fixture(context);
  const hardlinkRevision = await cutoverRevisionFor(hardlinked);
  await link(path.join(hardlinked, 'plan.md'), path.join(hardlinked, 'plan-hardlink.md'));
  await assert.rejects(apply(hardlinked, hardlinkRevision), (error) => error instanceof TodoStoreError
    && error.code === 'RECONCILIATION_INCOMPLETE'
    && error.detail.reason === 'source_path_not_regular');
  assert.match(await readFile(path.join(hardlinked, 'plan.md'), 'utf8'), /- \[ \] T1/u);
});

test('revision writerはv2 genesisからcarry/reset/source-seeded stateを投影しretryを冪等化する', async (context) => {
  const root = await fixture(context);
  const revision = await revisionFor(root);
  const oldJournal = await readFile(path.join(root, '.lattice/todo/plans/main/v1/journal/active.jsonl'));
  const first = await apply(root, revision);
  const second = await apply(root, revision);
  assert.deepEqual(second, first);
  assert.equal(first.schema, 'lattice.todo_revise_result.v1');
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members[0].journal.events[0].schema, 'lattice.todo_event.v2');
  assert.equal(store.members[0].journal.events[0].reconciliation_state, 'reconciled');
  assert.deepEqual(store.members[0].tasks.map(({ task_id, status }) => [task_id, status]), [
    ['T1', 'pending'], ['T2', 'pending'], ['T3', 'pending'], ['T4', 'pending'],
    ['T5', 'pending'], ['T6', 'pending'],
  ]);
  assert.deepEqual(await readFile(path.join(root, '.lattice/todo/plans/main/v1/journal/active.jsonl')), oldJournal);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T6', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  const transitioned = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.deepEqual(transitioned.journal.events.map(({ schema }) => schema), [
    'lattice.todo_event.v2', 'lattice.todo_event.v1',
  ]);
  assert.equal(transitioned.tasks.find(({ task_id }) => task_id === 'T6').status, 'in-progress');
});

test('同じpredecessorへ異なるrevision bytesを発行したretryはconflictにする', async (context) => {
  const root = await fixture(context);
  const accepted = await revisionFor(root);
  const competing = await revisionFor(root, { title: 'changed', migrationPolicy: 'reset_pending' });
  await apply(root, accepted);
  await assert.rejects(apply(root, competing), (error) => error instanceof TodoStoreError
    && error.code === 'REVISION_CONFLICT' && error.detail.reason === 'revision_bytes_conflict');
});

test('未activation transactionがある同じpredecessorへ別revisionを発行しない', async (context) => {
  const root = await fixture(context);
  const interrupted = await revisionFor(root);
  const competing = await revisionFor(root, { title: 'changed', migrationPolicy: 'reset_pending' });
  await assert.rejects(apply(root, interrupted, {
    onProtocolStage: (stage) => { if (stage === 'revision_marker_durable') throw new Error('crash'); },
  }), /crash/u);
  await assert.rejects(apply(root, competing), (error) => error instanceof TodoStoreError
    && error.code === 'REVISION_CONFLICT' && error.detail.reason === 'revision_bytes_conflict');
  await apply(root, interrupted);
});

test('carryはpending・in-progress・blocked・doneを保ちresetとsource-seededだけpending化する', async (context) => {
  const root = await fixture(context);
  const proof = Buffer.from('verified proof\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: proof, encoding: 'utf8',
  }).trim();
  const evidence = {
    evidence_id: 'ev-1', repo_id: 'self', path: 'proof.txt', git_blob_oid: oid,
    content_digest: digest(proof), media_type: 'text/plain', anchor_digest: null,
  };
  for (const taskId of ['T2', 'T3', 'T4', 'T5']) {
    await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
      event: { kind: 'start', task_id: taskId, actor: ACTOR, recorded_at: NOW,
        payload: { override_reason: null } } });
  }
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'block', task_id: 'T3', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'waiting' } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T4', actor: ACTOR, recorded_at: NOW,
      payload: { evidence } } });

  const revision = await revisionFor(root);
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const states = new Map(member.tasks.map((state) => [state.task_id, state]));
  assert.equal(states.get('T1').status, 'pending');
  assert.equal(states.get('T2').status, 'in-progress');
  assert.equal(states.get('T2').started_at, NOW);
  assert.equal(states.get('T3').status, 'blocked');
  assert.equal(states.get('T3').blocked_reason, 'waiting');
  assert.equal(states.get('T4').status, 'done');
  assert.deepEqual(states.get('T4').evidence, evidence);
  assert.equal(states.get('T5').status, 'pending');
  assert.equal(states.get('T5').started_at, null);
  assert.equal(states.get('T6').status, 'pending');
  assert.equal(member.journal.events[0].state_migration
    .find(({ from_task_id }) => from_task_id === 'T5').state, null);
});

test('legacy planからdesign_memo付きv6へ改訂してもcarry lifecycleを保持する', async (context) => {
  const root = await fixture(context);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });

  const revision = await revisionFor(root, { planSchema: 'lattice.todo_plan.v6' });
  await apply(root, revision);

  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const states = new Map(member.tasks.map((state) => [state.task_id, state]));
  assert.equal(member.plan.schema, 'lattice.todo_plan.v6');
  assert.equal(member.plan.tasks.find(({ task_id }) => task_id === 'T1').design_memo, 'NO_PLAN');
  assert.match(member.plan.tasks.find(({ task_id }) => task_id === 'T2').design_memo,
    /T2の設計メモ/u);
  assert.equal(states.get('T2').status, 'in-progress');
  assert.equal(states.get('T2').started_at, NOW);
  assert.equal(states.get('T6').status, 'pending');
});

test('既存design_memo変更は通常carryでもstateを保ち、明示reconcileはpolicyも記録する', async (context) => {
  const root = await fixture(context);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await apply(root, await revisionFor(root, { planSchema: 'lattice.todo_plan.v6' }));

  const changed = await revisionFor(root, {
    planSchema: 'lattice.todo_plan.v6', designMemoByTask: { T1: '## 改訂方針\n\n本文を更新する。' },
  });
  await apply(root, changed);
  const carried = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(carried.plan.tasks.find(({ task_id }) => task_id === 'T1').design_memo,
    '## 改訂方針\n\n本文を更新する。');
  assert.equal(carried.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
  assert.equal(carried.journal.events[0].state_migration
    .find(({ from_task_id }) => from_task_id === 'T1').state_policy, 'carry');

  const reconciled = await revisionFor(root, {
    planSchema: 'lattice.todo_plan.v6',
    designMemoByTask: { T1: '## 改訂方針\n\n本文をさらに更新する。' },
    migrationPolicies: { T1: 'carry_reconciled_metadata' },
  });
  await apply(root, reconciled);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.plan.tasks.find(({ task_id }) => task_id === 'T1').design_memo,
    '## 改訂方針\n\n本文をさらに更新する。');
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
  assert.equal(member.journal.events[0].state_migration
    .find(({ from_task_id }) => from_task_id === 'T1').state_policy,
  'carry_reconciled_metadata');
});

test('通常revisionのacquire_phaseは既存design_memoが変わってもstateを保つ', async (context) => {
  const root = await fixture(context);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await apply(root, await revisionFor(root, { planSchema: 'lattice.todo_plan.v6' }));

  const changed = await revisionFor(root, {
    planSchema: 'lattice.todo_plan.v6',
    designMemoByTask: { T1: '## 改訂方針\n\nacquire_phase経路から本文を更新する。' },
    migrationPolicies: { T1: 'acquire_phase' },
  });
  await apply(root, changed);
  const replaced = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(replaced.plan.tasks.find(({ task_id }) => task_id === 'T1').design_memo,
    '## 改訂方針\n\nacquire_phase経路から本文を更新する。');
  assert.equal(replaced.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');

  const unchanged = await revisionFor(root, {
    planSchema: 'lattice.todo_plan.v6', migrationPolicies: { T1: 'acquire_phase' },
  });
  await apply(root, unchanged);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
  assert.equal(member.journal.events[0].state_migration
    .find(({ from_task_id }) => from_task_id === 'T1').state_policy, 'acquire_phase');
});

test('設計メモを持つplanからmemo無しschemaへの後退はrevision入口でtyped拒否する', async (context) => {
  const root = await fixture(context);
  await apply(root, await revisionFor(root, { planSchema: 'lattice.todo_plan.v6' }));
  const downgrade = await revisionFor(root, { planSchema: 'lattice.todo_plan.v3' });
  await assert.rejects(apply(root, downgrade), (error) => error instanceof TodoStoreError
    && error.code === 'REVISION_INVALID' && error.detail.reason === 'design_memo_schema_downgrade'
    && error.detail.predecessor_schema === 'lattice.todo_plan.v6'
    && error.detail.desired_schema === 'lattice.todo_plan.v3');
});

test('removed taskはsuccessorから除外しpredecessor v1履歴とevidenceを不変保存する', async (context) => {
  const root = await fixture(context);
  const proof = Buffer.from('removed task proof\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: proof, encoding: 'utf8',
  }).trim();
  const evidence = {
    evidence_id: 'ev-removed', repo_id: 'self', path: 'removed-proof.txt', git_blob_oid: oid,
    content_digest: digest(proof), media_type: 'text/plain', anchor_digest: null,
  };
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T5', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T5', actor: ACTOR, recorded_at: NOW,
      payload: { evidence } } });
  const oldJournalRef = path.join(root, '.lattice/todo/plans/main/v1/journal/active.jsonl');
  const oldJournal = await readFile(oldJournalRef);

  const revision = await revisionFor(root, { removeT5: true });
  await apply(root, revision);

  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.deepEqual(member.plan.tasks.map(({ task_id }) => task_id), ['T1', 'T2', 'T3', 'T4', 'T6']);
  assert.equal(member.tasks.some(({ task_id }) => task_id === 'T5'), false);
  assert.deepEqual(member.journal.events[0].state_migration
    .find(({ from_task_id }) => from_task_id === 'T5'), {
    from_task_id: 'T5', to_task_id: 'removed', state_policy: 'removed', state: null,
  });
  assert.deepEqual(await readFile(oldJournalRef), oldJournal);
  const predecessorEvents = oldJournal.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(predecessorEvents.slice(-2).map(({ kind }) => kind), ['start', 'done']);
  assert.deepEqual(predecessorEvents.at(-1).payload.evidence, evidence);
});

test('removed宣言と無関係なhard edgeの削除もcarryはstateを保ったまま通る', async (context) => {
  const dependency = { from: ref('T1'), to: ref('T2') };
  const root = await fixture(context, { hardDependencies: [dependency] });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  const revision = await revisionFor(root, { removeT5: true, hardDependencies: [] });
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.deepEqual(member.plan.hard_dependencies, []);
  assert.equal(member.plan.tasks.some(({ task_id }) => task_id === 'T5'), false);
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
});

test('carryはremoved taskへのhard incomingとoutgoingだけを除外する', async (context) => {
  const incomingRoot = await fixture(context, {
    hardDependencies: [{ from: ref('T5'), to: ref('T1') }],
  });
  await apply(incomingRoot, await revisionFor(incomingRoot, { removeT5: true }));

  const outgoingRoot = await fixture(context, {
    hardDependencies: [{ from: ref('T1'), to: ref('T5') }],
  });
  await apply(outgoingRoot, await revisionFor(outgoingRoot, { removeT5: true }));
});

test('carryはremovedを含むjoinから残差をsortし単独joinは全体を除外する', async (context) => {
  const partialJoin = { id: 'join-partial', after: [ref('T2'), ref('T5')], before: ref('T1') };
  const partialRoot = await fixture(context, { joins: [partialJoin] });
  await apply(partialRoot, await revisionFor(partialRoot, {
    removeT5: true,
    joins: [{ ...partialJoin, after: [ref('T2')] }],
  }));

  const singleRoot = await fixture(context, {
    joins: [{ id: 'join-single', after: [ref('T5')], before: ref('T1') }],
  });
  await apply(singleRoot, await revisionFor(singleRoot, { removeT5: true }));
});

test('carry_reconciled_metadataもremoved taskへのedgeだけを除外する', async (context) => {
  const root = await fixture(context, {
    hardDependencies: [{ from: ref('T1'), to: ref('T5') }],
  });
  await apply(root, await revisionFor(root, {
    removeT5: true,
    migrationPolicies: { T1: 'carry_reconciled_metadata' },
  }));
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'pending');
});

test('historical importのdone・in-progress stateとsource evidenceもv2 genesisへcarryする', async (context) => {
  const root = await fixture(context);
  const sourceCommit = pinnedLegacyCommit(root);
  const source = (originLine) => ({ schema: 'lattice.todo_import_source.v1',
    origin_plan_ref: 'legacy.md', origin_line: originLine, source_commit: sourceCommit });
  await appendImportedPlan({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    now: NOW, plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'archive',
      plan_version: 'v1', predecessor_plan_digest: null,
      tasks: [
        { task_id: 'H1', title: 'H1', lane: 'main', narrative_ref: null, compile_binding: null },
        { task_id: 'H2', title: 'H2', lane: 'main', narrative_ref: null, compile_binding: null },
      ], hard_dependencies: [], joins: [] }, genesis: { actor: ACTOR, recorded_at: NOW },
    completedTasks: [{ task_id: 'H1', completed_at: NOW, evidence: source(1) }],
    inProgressTasks: [{ task_id: 'H2', started_at: NOW, evidence: source(2) }],
  });
  await writeFile(path.join(root, 'reconcile.md'), '- [x] H1\n- [ ] H2\n');
  const revision = await historicalRevisionFor(root);
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ plan }) => plan.plan_key === 'archive');
  assert.deepEqual(member.tasks.map(({ task_id, status, imported }) => [task_id, status, imported]), [
    ['H1', 'done', true], ['H2', 'in-progress', true],
  ]);
  assert.equal(member.journal.events[0].state_migration[0].state.evidence.source_commit, sourceCommit);
  assert.equal(member.journal.events[0].state_migration[1].state.evidence.source_commit, sourceCommit);
});

test('carryはtitle変更でもstateを保ちsource digest不一致はactivation前に拒否する', async (context) => {
  const root = await fixture(context);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await apply(root, await revisionFor(root, { title: 'changed' }));
  const applied = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(applied.plan.tasks.find(({ task_id }) => task_id === 'T1').title, 'changed');
  assert.equal(applied.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
  const revision = await revisionFor(root);
  await writeFile(path.join(root, 'plan.md'), [
    '- [x] T1', '- [ ] T2', '- [ ] T3', '- [ ] T4', '- [ ] T5', '- [ ] T6',
  ].join('\n') + '\n');
  await assert.rejects(apply(root, revision), (error) => error instanceof TodoStoreError
    && error.code === 'RECONCILIATION_INCOMPLETE' && error.detail.reason === 'source_digest_mismatch');
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members[0].plan.plan_version, applied.plan.plan_version);
});

test('carry_reconciled_metadataは親子校正もtitle変更もtask stateを保存する', async (context) => {
  const root = await fixture(context);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  const revision = await revisionFor(root, {
    t1ParentTaskId: 'T2',
    migrationPolicies: { T1: 'carry_reconciled_metadata' },
  });
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const taskState = member.tasks.find(({ task_id }) => task_id === 'T1');
  const taskPlan = member.plan.tasks.find(({ task_id }) => task_id === 'T1');
  assert.equal(taskState.status, 'in-progress');
  assert.equal(taskPlan.parent_task_id, 'T2');

  const changedTitle = await fixture(context);
  await appendTodoEvent({ repoRoot: changedTitle, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await apply(changedTitle, await revisionFor(changedTitle, {
    title: 'changed', migrationPolicies: { T1: 'carry_reconciled_metadata' },
  }));
  const retitled = (await readTodoStore({ repoRoot: changedTitle, now: NOW })).members[0];
  assert.equal(retitled.plan.tasks.find(({ task_id }) => task_id === 'T1').title, 'changed');
  assert.equal(retitled.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
});

test('source inventoryは数字＋英字付きcheckbox markerをTODOとして検証する', async (context) => {
  const root = await fixture(context);
  const lines = ['0a. [ ] T1', '6A. [ ] T2', '- [ ] T3', '- [ ] T4', '- [ ] T5', '- [ ] T6'];
  await writeFile(path.join(root, 'plan.md'), `${lines.join('\n')}\n`);
  const revision = await revisionFor(root, { sourceTextByTask: { T1: lines[0], T2: lines[1] } });
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.revision.source_inventory.active[0].source_ref, 'plan.md#L1');
});

test('source inventoryはrepo内symlinkを辿らずactivation前に拒否する', async (context) => {
  const root = await fixture(context);
  const revision = await revisionFor(root);
  await writeFile(path.join(root, 'actual.md'), [1, 2, 3, 4, 5, 6]
    .map((index) => `- [ ] T${index}`).join('\n') + '\n');
  await unlink(path.join(root, 'plan.md'));
  await symlink('actual.md', path.join(root, 'plan.md'));
  await assert.rejects(apply(root, revision), (error) => error instanceof TodoStoreError
    && error.code === 'RECONCILIATION_INCOMPLETE' && error.detail.reason === 'source_path_symlink');
});

test('revision作成後にpredecessor journalが進んだ場合はstaleとしてactivation前に拒否する', async (context) => {
  const root = await fixture(context);
  const revision = await revisionFor(root);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await assert.rejects(apply(root, revision), (error) => error instanceof TodoStoreError
    && error.code === 'STORE_WRITE_CONFLICT' && error.detail.reason === 'stale_predecessor');
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.plan.plan_version, 'v1');
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
});

test('successorで追加するnarrative anchorのdigest driftはactivation前に拒否する', async (context) => {
  const root = await fixture(context);
  const sourceCommit = pinnedLegacyCommit(root);
  const revision = await revisionFor(root, { t6Anchor: {
    origin_plan_ref: 'legacy.md', origin_line: 1, source_commit: sourceCommit,
    source_line_digest: digest('- [ ] drifted'),
  } });
  await assert.rejects(apply(root, revision), (error) => error instanceof TodoStoreError
    && error.code === 'STORE_INCONSISTENT' && error.detail.reason === 'narrative_anchor_unverified');
  assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).members[0].plan.plan_version, 'v1');
});

test('archive・superseded・全完了sourceはtombstoneとして固定しactive taskへ復活させない', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'plan.md'), [1, 2, 3, 4, 5, 6, 7, 8]
    .map((index) => `- [ ] T${index}`).join('\n') + '\n');
  const revision = await revisionFor(root, {
    removeT5: true,
    removeT5Reason: 'archived source excluded from successor',
    extraTombstones: [
      { source_ref: 'plan.md#L7', source_digest: digest('- [ ] T7'),
        exclusion_reason: 'explicitly superseded source excluded from successor' },
      { source_ref: 'plan.md#L8', source_digest: digest('- [ ] T8'),
        exclusion_reason: 'fully completed source excluded from successor' },
    ],
  });
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.tasks.some(({ task_id }) => ['T5', 'T7', 'T8'].includes(task_id)), false);
  assert.deepEqual(member.revision.source_inventory.excluded_tombstones
    .map(({ source_ref, exclusion_reason }) => [source_ref, exclusion_reason]), [
    ['plan.md#L5', 'archived source excluded from successor'],
    ['plan.md#L7', 'explicitly superseded source excluded from successor'],
    ['plan.md#L8', 'fully completed source excluded from successor'],
  ]);
});

test('successor revisionはpredecessorの依存edgeを削除し、carryならstateを保ったまま新topologyだけを有効化する', async (context) => {
  const dependency = { from: ref('T1'), to: ref('T2') };
  for (const migrationPolicies of [
    {}, { T1: 'carry_reconciled_metadata', T2: 'carry_reconciled_metadata' },
  ]) {
    const carryRoot = await fixture(context, { hardDependencies: [dependency] });
    await appendTodoEvent({ repoRoot: carryRoot, writer, planKey: 'main', now: NOW,
      event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
        payload: { override_reason: null } } });
    await apply(carryRoot, await revisionFor(carryRoot, { hardDependencies: [], migrationPolicies }));
    const carried = (await readTodoStore({ repoRoot: carryRoot, now: NOW })).members[0];
    assert.deepEqual(carried.plan.hard_dependencies, []);
    assert.equal(carried.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
  }
  const root = await fixture(context, { hardDependencies: [dependency] });
  const revision = await revisionFor(root, {
    hardDependencies: [], migrationPolicies: { T1: 'reset_pending', T2: 'reset_pending' },
  });
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.deepEqual(member.plan.hard_dependencies, []);
  assert.equal(member.plan.predecessor_plan_digest, revision.predecessor.plan_digest);
});

test('manifest v2へのsuccessor revisionはactive_revision_digestを新revisionへ追従させる', async (context) => {
  const root = await fixture(context);
  await promoteManifestV2(root);
  const revision = await revisionFor(root);
  await apply(root, revision);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.descriptor.active_revision_digest, revision.revision_digest);
});

for (const stage of [
  'revision_marker_durable', 'revision_input_durable', 'revision_plan_durable', 'revision_genesis_durable',
  'revision_snapshot_durable', 'revision_manifest_activated',
]) {
  test(`revision crash recoveryは${stage}からexact retryで完遂する`, async (context) => {
    const root = await fixture(context);
    const revision = await revisionFor(root);
    await assert.rejects(apply(root, revision, {
      onProtocolStage: (current) => { if (current === stage) throw new Error(`crash:${stage}`); },
    }), new RegExp(`crash:${stage}`, 'u'));
    const result = await apply(root, revision);
    assert.equal(result.revision_digest, revision.revision_digest);
    const store = await readTodoStore({ repoRoot: root, now: NOW });
    assert.equal(store.members[0].plan.plan_version, revision.desired_plan.plan_version);
  });
}

for (const stage of [
  'source_cutover_staged', 'source_cutover_barrier_durable', 'source_cutover_published',
  'revision_manifest_activated', 'source_cutover_cleanup',
]) {
  test(`v2 source cutoverは${stage}停止からopenまたは同一revisionで収束する`, async (context) => {
    const root = await fixture(context);
    const revision = await cutoverRevisionFor(root, { twoFiles: true });
    await assert.rejects(apply(root, revision, {
      onProtocolStage: (current) => { if (current === stage) throw new Error(`crash:${stage}`); },
    }), new RegExp(`crash:${stage}`, 'u'));
    if (['source_cutover_barrier_durable', 'source_cutover_published',
      'revision_manifest_activated'].includes(stage)) {
      const reopened = await readTodoStore({ repoRoot: root, now: NOW });
      assert.equal(reopened.members[0].plan.plan_version, revision.desired_plan.plan_version);
    }
    const result = await apply(root, revision);
    assert.equal(result.revision_digest, revision.revision_digest);
    assert.equal((await readFile(path.join(root, 'plan.md'), 'utf8')).match(/\[[ xX]\]/gu), null);
    assert.equal((await readFile(path.join(root, 'extra.md'), 'utf8')).match(/\[[ xX]\]/gu), null);
    const store = await readTodoStore({ repoRoot: root, now: NOW });
    assert.equal(store.members[0].plan.plan_version, revision.desired_plan.plan_version);
  });
}
