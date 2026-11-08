// u03i: the effective source inventory follows light (v5) revisions of a source-backed plan.
// `plan revise` still refuses source-backed plans (Plan guard), so v5 is applied through the Store API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { digestTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  explainPhaseTodoRevision, phaseTodoRevisionPlanVersion, todoLegacyReconciliationDigest,
  validatePhaseTodoRevision,
} from '../src/todo-revision.mjs';
import { compileTodoSplit } from '../src/todo-split.mjs';
import {
  applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter, initializeTodoStore,
  readTodoEffectiveSourceInventory, readTodoStore, verifyEffectivePhaseTodoRevisionSources,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const ACTOR = { host: 'host-1', session: 'session-1', agent: 'agent-1' };
const AT = ['2026-11-08T00:00:00.000Z', '2026-11-08T00:00:01.000Z', '2026-11-08T00:00:02.000Z',
  '2026-11-08T00:00:03.000Z'];
const ARCHIVE = '.lattice/todo/source-ledger/cutover.md';
const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
const sha = (text) => createHash('sha256').update(text).digest('hex');
const SOURCE_LINES = ['- [ ] A source', '- [ ] B source', '- [ ] C source', '- [ ] X excluded'];
const migrationDigest = (value) => todoSelfDigest({ task_migration: value, task_migration_digest: '' },
  'task_migration_digest');

function task(taskId, narrativeRef) {
  return { task_id: taskId, title: taskId, lane: 'main', design_memo: 'NO_PLAN',
    narrative_ref: narrativeRef, narrative_anchor: null, compile_binding: null,
    parent_task_id: null, phase_id: 'phase-1' };
}

function withVersion(seed, { predecessor, taskMigration, phaseMigration }) {
  const desired = { ...seed };
  delete desired.topology_digest; delete desired.plan_digest;
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desired, taskMigration, phaseMigration });
  return buildTodoPlan(desired);
}

const predecessorOf = (member) => ({ plan_digest: member.plan.plan_digest,
  journal_head_digest: member.journal.events.at(-1).event_digest,
  plan_version: member.plan.plan_version });

/** v3 genesis (legacy plan -> recorded inventory): tasks A, B, C with sources and one tombstone. */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-inventory-light-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const phase = { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const initial = buildTodoPlan({ schema: 'lattice.todo_plan.v7', project_id: 'project-1',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: ['A', 'B', 'C'].map((id, index) => task(id, `${ARCHIVE}#L${index + 6}`)),
    phases: [phase], hard_dependencies: [], joins: [], phase_accept_dependencies: [] });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: initial, genesis: { actor: ACTOR, recorded_at: AT[0] } }], now: AT[0] });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'plan.md'), `${SOURCE_LINES.join('\n')}\n`);

  const member = (await readTodoStore({ repoRoot: root, now: AT[0] })).members[0];
  const predecessor = predecessorOf(member);
  const taskMigration = ['A', 'B', 'C'].map((id) => ({ from_task_id: id, to_task_id: id,
    state_policy: 'reset_pending' }));
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredPlan = withVersion({ ...member.plan, predecessor_plan_digest: predecessor.plan_digest },
    { predecessor, taskMigration, phaseMigration });
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1',
    entries: ['A', 'B', 'C'].map((id, index) => ({ predecessor_task_id: id, disposition: 'replace',
      successor_task_ids: [id], reason: `${id} restarts pending`,
      evidence_digests: [String(index + 1).repeat(64)] })), migration_digest: '' };
  runtimeTaskMigration.migration_digest = todoSelfDigest(runtimeTaskMigration, 'migration_digest');
  const batch = { batch_id: 'genesis-cutover', archive_ref: ARCHIVE, operations: SOURCE_LINES
    .map((line, index) => ({ task_id: index < 3 ? 'ABC'[index] : null,
      disposition: index < 3 ? 'active' : 'excluded', source_ref: `docs/plan.md#L${index + 1}`,
      source_digest: sha(line), live_replacement: `- moved ${index + 1}` })), batch_digest: '' };
  batch.batch_digest = todoSelfDigest(batch, 'batch_digest');
  const sourceInventory = {
    active: ['A', 'B', 'C'].map((id, index) => ({ task_id: id, source_ref: `${ARCHIVE}#L${index + 6}`,
      source_digest: sha(SOURCE_LINES[index]) })),
    excluded_tombstones: [{ source_ref: `${ARCHIVE}#L9`, source_digest: sha(SOURCE_LINES[3]),
      exclusion_reason: 'out of scope' }],
  };
  const reconciliation = { predecessor_reconciliation_digest: todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest }),
  source_inventory_digest: digestTodoArtifact(sourceInventory),
  desired_plan_digest: desiredPlan.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: migrationDigest(taskMigration),
  phase_migration_digest: digestTodoArtifact(phaseMigration),
  source_cutover_batch_digest: batch.batch_digest, reconciliation_digest: '' };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const genesis = { schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desiredPlan, runtime_task_migration: runtimeTaskMigration,
    task_migration: taskMigration, phase_migration: phaseMigration, source_inventory: sourceInventory,
    reconciliation, source_cutover_batch: batch, revision_digest: '' };
  genesis.revision_digest = todoSelfDigest(genesis, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(genesis), true);
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision: genesis, actor: ACTOR,
    recordedAt: AT[1], now: AT[1] });
  return { root, genesis, sourceInventory };
}

const readMember = async (root) => (await readTodoStore({ repoRoot: root })).members[0];

/** Light v5: A carried, B carried as B2, C removed, N (no source) added. */
async function applyLightRevision(root) {
  const member = await readMember(root);
  const predecessor = predecessorOf(member);
  const taskMigration = [
    { from_task_id: 'A', to_task_id: 'A', state_policy: 'carry_reconciled_metadata' },
    { from_task_id: 'B', to_task_id: 'B2', state_policy: 'reset_pending' },
    { from_task_id: 'C', to_task_id: 'removed', state_policy: 'removed' },
  ];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const byId = new Map(member.plan.tasks.map((entry) => [entry.task_id, entry]));
  const tasks = [byId.get('A'), { ...byId.get('B'), task_id: 'B2', title: 'B2' }, task('N', null)];
  const desired = withVersion({ ...member.plan, predecessor_plan_digest: predecessor.plan_digest, tasks },
    { predecessor, taskMigration, phaseMigration });
  const revision = { schema: 'lattice.phase_todo_revision.v5', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desired, task_migration: taskMigration, phase_migration: phaseMigration,
    revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(revision), true);
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: AT[2], now: AT[2] });
  return revision;
}

test('u03i: effective inventory follows a light v5 revision (carry, rename, remove, add)', async (t) => {
  const { root, sourceInventory } = await fixture(t);
  assert.equal((await readTodoEffectiveSourceInventory({ repoRoot: root, member: await readMember(root) }))
    .recorded, true);
  const revision = await applyLightRevision(root);
  const member = await readMember(root);
  assert.equal(member.revision.revision_digest, revision.revision_digest);
  const { inventory, recorded } = await readTodoEffectiveSourceInventory({ repoRoot: root, member });
  const [a, b] = sourceInventory.active;
  assert.equal(recorded, true);
  assert.deepEqual(inventory.active, [a, { ...b, task_id: 'B2' }]);
  assert.deepEqual(inventory.excluded_tombstones, sourceInventory.excluded_tombstones);
  assert.equal((await verifyEffectivePhaseTodoRevisionSources({ repoRoot: root, member })).active.length, 2);
});

test('u03i: a revise-phase v3 on top of the derived inventory neither resurrects C nor needs N', async (t) => {
  const { root } = await fixture(t);
  await applyLightRevision(root);
  const member = await readMember(root);
  const { inventory } = await readTodoEffectiveSourceInventory({ repoRoot: root, member });
  const predecessor = predecessorOf(member);
  // A v3 batch needs at least one operation, so "carry everything" is impossible: relocate B2's line.
  const b2 = inventory.active.find(({ task_id: id }) => id === 'B2');
  const nextArchive = '.lattice/todo/source-ledger/cutover-next.md';
  const batch = { batch_id: 'next-cutover', archive_ref: nextArchive, operations: [{
    task_id: 'B2', disposition: 'active', source_ref: b2.source_ref, source_digest: b2.source_digest,
    live_replacement: '- B2 moved to next Lattice source' }], batch_digest: '' };
  batch.batch_digest = todoSelfDigest(batch, 'batch_digest');
  const sourceInventory = { active: inventory.active.map((entry) => (entry.task_id === 'B2'
    ? { ...entry, source_ref: `${nextArchive}#L6` } : entry)),
  excluded_tombstones: inventory.excluded_tombstones };
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1',
    entries: member.plan.tasks.map(({ task_id: id }, index) => ({ predecessor_task_id: id,
      disposition: id === 'B2' ? 'replace' : 'stay', successor_task_ids: [id],
      reason: `${id} unchanged`,
      evidence_digests: [String(index + 1).repeat(64)] })), migration_digest: '' };
  runtimeTaskMigration.migration_digest = todoSelfDigest(runtimeTaskMigration, 'migration_digest');
  // B2's source moves, so it restarts pending (carry would refuse the changed narrative_ref).
  const taskMigration = member.plan.tasks.map(({ task_id: id }) => ({ from_task_id: id,
    to_task_id: id, state_policy: id === 'B2' ? 'reset_pending' : 'carry' }));
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const tasks = member.plan.tasks.map((entry) => (entry.task_id === 'B2'
    ? { ...entry, narrative_ref: `${nextArchive}#L6` } : entry));
  const desired = withVersion({ ...member.plan, predecessor_plan_digest: predecessor.plan_digest, tasks },
    { predecessor, taskMigration, phaseMigration });
  const reconciliation = { predecessor_reconciliation_digest: todoLegacyReconciliationDigest({
    planDigest: predecessor.plan_digest, journalHeadDigest: predecessor.journal_head_digest }),
  source_inventory_digest: digestTodoArtifact(sourceInventory), desired_plan_digest: desired.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: migrationDigest(taskMigration),
  phase_migration_digest: digestTodoArtifact(phaseMigration),
  source_cutover_batch_digest: batch.batch_digest, reconciliation_digest: '' };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const v3 = { schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desired, runtime_task_migration: runtimeTaskMigration,
    task_migration: taskMigration, phase_migration: phaseMigration, source_inventory: sourceInventory,
    reconciliation, source_cutover_batch: batch, revision_digest: '' };
  v3.revision_digest = todoSelfDigest(v3, 'revision_digest');
  // The inventory omits N (narrative_ref null): valid only through the relaxed validator.
  assert.equal(validatePhaseTodoRevision(v3), true);
  assert.deepEqual(sourceInventory.active.map(({ task_id: id }) => id), ['A', 'B2']);
  const receipt = await applyPhaseTodoRevision({ repoRoot: root, writer, revision: v3, actor: ACTOR,
    recordedAt: AT[3], now: AT[3] });
  assert.equal(receipt.revision_digest, v3.revision_digest);
  const after = await readMember(root);
  assert.equal(after.revision.revision_digest, v3.revision_digest);
  assert.deepEqual(after.plan.tasks.map(({ task_id: id }) => id), ['A', 'B2', 'N']);
});

/** v3 artifact variants: only `source_inventory` / desired tasks change; digests are re-sealed. */
function sealedWith(revision, mutate) {
  const value = structuredClone(revision);
  mutate(value);
  value.reconciliation.source_inventory_digest = digestTodoArtifact(value.source_inventory);
  value.reconciliation.reconciliation_digest = todoSelfDigest(value.reconciliation, 'reconciliation_digest');
  value.revision_digest = todoSelfDigest(value, 'revision_digest');
  return value;
}

test('u03i: v3 source_inventory may omit only null-ref tasks and keeps desired order', async (t) => {
  const { genesis } = await fixture(t);
  // C is replaced by N, a task without a source: the inventory lists A and B only.
  const nullRef = (value) => {
    value.task_migration = value.task_migration.map((row) => (row.from_task_id === 'C'
      ? { ...row, to_task_id: 'N', state_policy: 'reset_pending' } : row));
    value.reconciliation.task_migration_digest = migrationDigest(value.task_migration);
    value.runtime_task_migration.entries[2] = { predecessor_task_id: 'C', disposition: 'replace',
      successor_task_ids: ['N'], reason: 'C replaced by a task without a source',
      evidence_digests: ['3'.repeat(64)] };
    value.runtime_task_migration.migration_digest = todoSelfDigest(value.runtime_task_migration,
      'migration_digest');
    value.reconciliation.runtime_task_migration_digest = value.runtime_task_migration.migration_digest;
    const seed = structuredClone(value.desired_plan);
    seed.tasks = [seed.tasks[0], seed.tasks[1], task('N', null)];
    delete seed.topology_digest; delete seed.plan_digest;
    seed.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
      predecessor: value.predecessor, desiredPlan: seed, taskMigration: value.task_migration,
      phaseMigration: value.phase_migration });
    value.desired_plan = buildTodoPlan(seed);
    value.reconciliation.desired_plan_digest = value.desired_plan.plan_digest;
    // C leaves the batch, so the excluded line moves up one archive slot.
    value.source_inventory.active = value.source_inventory.active.slice(0, 2);
    value.source_inventory.excluded_tombstones[0].source_ref = `${ARCHIVE}#L8`;
    value.source_cutover_batch.operations = value.source_cutover_batch.operations
      .filter(({ task_id: id }) => id !== 'C');
    value.source_cutover_batch.batch_digest = todoSelfDigest(value.source_cutover_batch, 'batch_digest');
    value.reconciliation.source_cutover_batch_digest = value.source_cutover_batch.batch_digest;
  };
  const base = sealedWith(genesis, nullRef);
  assert.equal(validatePhaseTodoRevision(base), true, JSON.stringify(explainPhaseTodoRevision(base)));
  assert.deepEqual(base.desired_plan.tasks.map(({ task_id: id }) => id), ['A', 'B', 'N']);
  assert.deepEqual(base.source_inventory.active.map(({ task_id: id }) => id), ['A', 'B']);

  // A task with a source (narrative_ref non-null) cannot be omitted. Its batch operation goes too,
  // so the only thing wrong is the missing inventory entry.
  const dropB = sealedWith(base, (value) => {
    value.source_inventory.active.pop();
    value.source_cutover_batch.operations = value.source_cutover_batch.operations
      .filter(({ task_id: id }) => id !== 'B');
    value.source_inventory.excluded_tombstones[0].source_ref = `${ARCHIVE}#L7`;
    value.source_cutover_batch.batch_digest = todoSelfDigest(value.source_cutover_batch, 'batch_digest');
    value.reconciliation.source_cutover_batch_digest = value.source_cutover_batch.batch_digest;
  });
  const dropped = explainPhaseTodoRevision(dropB);
  assert.deepEqual(dropped, { valid: false, reason: 'source_inventory_task_set_mismatch',
    path: '/source_inventory/active' });
  // Entries out of desired order are invalid.
  const swapped = sealedWith(base, (value) => { value.source_inventory.active.reverse(); });
  const swappedExplain = explainPhaseTodoRevision(swapped);
  assert.deepEqual(swappedExplain, { valid: false, reason: 'source_inventory_task_set_mismatch',
    path: '/source_inventory/active' });
});

test('u03i: todo split after a light revision does not need an entry for N and omits it', async (t) => {
  const { root } = await fixture(t);
  await applyLightRevision(root);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: AT[3],
    event: { kind: 'start', task_id: 'B2', actor: ACTOR, recorded_at: AT[3],
      payload: { override_reason: null } } });
  await appendFile(path.join(root, 'docs', 'plan.md'), '- [ ] B21 extracted\n');
  const member = await readMember(root);
  const proposal = { schema: 'lattice.todo_split.v1', project_id: 'project-1', plan_key: 'main',
    task_id: 'B2', reason: 'extract an independent duty', evidence_digests: ['a'.repeat(64)],
    archive_ref: 'docs/archive/split.md',
    residual: { title: 'B2 residual', lane: 'main', design_memo: 'finish the residual' },
    extracted_tasks: [{ task_id: 'B21', title: 'B21', lane: 'main', design_memo: 'extracted duty',
      source_ref: `docs/plan.md#L${SOURCE_LINES.length + 1}`, depends_on: [] }] };
  const { revision } = await compileTodoSplit({ repoRoot: root, member, proposal });
  assert.equal(validatePhaseTodoRevision(revision), true);
  assert.deepEqual(revision.source_inventory.active.map(({ task_id: id }) => id).sort(),
    ['A', 'B2', 'B21']);
  assert.equal(revision.desired_plan.tasks.some(({ task_id: id }) => id === 'N'), true);
  assert.equal(revision.source_inventory.active.some(({ task_id: id }) => id === 'N'), false);
  assert.deepEqual(revision.source_cutover_batch.operations.map(({ task_id: id }) => id), ['B21']);
  assert.deepEqual(revision.source_inventory.excluded_tombstones.length, 1);
  assert.equal(await readFile(path.join(root, 'docs', 'plan.md'), 'utf8').then((text) => text.includes('B21')), true);
});
