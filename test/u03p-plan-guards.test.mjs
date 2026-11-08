// u03p: 機械が答えを出せる拒否を外し、その答えを適用する(create補完・継続算出・migrate・revise-phase補完・backchain束縛改訂)。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compilePlanRevision } from '../src/plan-revise.mjs';
import { completeCreateInput } from '../src/todo-authoring-input.mjs';
import { digestTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  completePhaseTodoRevision, phaseTodoRevisionPlanVersion, todoLegacyReconciliationDigest,
  validatePhaseTodoRevision,
} from '../src/todo-revision.mjs';
import { buildTodoPlan, readTodoStore } from '../src/todo-store.mjs';

const BIN = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/todo-migration');
const ENV = {
  ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0', NO_COLOR: '1',
  LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture',
};
const ref = (taskId) => ({ project_id: 'probe', plan_key: 'main', task_id: taskId });

async function repo(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-u03p-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: ENV });
}

async function write(root, name, value) {
  await writeFile(path.join(root, name), `${JSON.stringify(value)}\n`);
  return name;
}

const taskV4 = (id, extra = {}) => ({ task_id: id, title: id, lane: 'main', design_memo: 'NO_PLAN',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null,
  phase_id: 'p', ...extra });
const phase = { phase_id: 'p', title: 'phase', gate_policy: 'heavy',
  predecessor_phase_ids: [], required_evidence_slots: ['proof'] };

/** AIが書く意図だけの入力: actor・recorded_at・input_digestが無い。 */
function bareInput(ids = ['a', 'b', 'c'], schema = 'lattice.plan_create_input.v4') {
  return { schema, project_id: 'probe', plan_key: 'main', plan_version: 'v1',
    tasks: ids.map((id) => taskV4(id)), phases: [phase],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
}

test('completeCreateInput fills actor, recorded_at, NO_PLAN, order and digest; other values pass through', () => {
  const now = new Date('2026-11-08T01:02:03.456Z');
  const input = bareInput(['b', 'a', 'a']);
  delete input.tasks[0].design_memo;
  input.tasks[1].design_memo = '  ';
  input.input_digest = 'wrong';
  const completed = completeCreateInput(input, { env: ENV, now });
  assert.deepEqual(completed.actor, { host: 'fixture', session: 'fixture', agent: 'fixture' });
  assert.equal(completed.recorded_at, '2026-11-08T01:02:03.456Z');
  assert.deepEqual(completed.tasks.map(({ task_id: id }) => id), ['a', 'b']);
  assert.deepEqual(completed.tasks.map(({ design_memo: memo }) => memo), ['NO_PLAN', 'NO_PLAN']);
  assert.equal(completed.input_digest, todoSelfDigest(completed, 'input_digest'));
  const kept = completeCreateInput({ ...input, actor: { host: 'h', session: 's', agent: 'g' } }, { env: ENV, now });
  assert.deepEqual(kept.actor, { host: 'h', session: 's', agent: 'g' });
  assert.equal(completeCreateInput(null, { env: ENV, now }), null);
  const other = { schema: 'lattice.plan_revise_input.v1' };
  assert.equal(completeCreateInput(other, { env: ENV, now }), other);
  assert.throws(() => completeCreateInput(bareInput(), { env: { LATTICE_TODO_ACTOR_HOST: '!' }, now }),
    (error) => error.code === 'ACTOR_UNRESOLVED');
});

test('plan create accepts an input without actor, recorded_at, input_digest, design_memo and with unsorted tasks', async (context) => {
  const root = await repo(context);
  const input = bareInput(['c', 'a', 'b']);
  for (const task of input.tasks) delete task.design_memo;
  const result = run(root, ['plan', 'create', '--input', await write(root, 'in.json', input)]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(await readFile(path.join(root, JSON.parse(result.stdout).plan_ref), 'utf8'));
  assert.deepEqual(plan.tasks.map(({ task_id: id }) => id), ['a', 'b', 'c']);
  assert.ok(plan.tasks.every(({ design_memo: memo }) => memo === 'NO_PLAN'));
  const journal = await readFile(path.join(root, JSON.parse(result.stdout).journal_ref), 'utf8');
  assert.match(journal, /"agent":"fixture"/u);
});

test('plan create builds the older plan schemas from create input v1/v2/v3 (plan_create_schema_retired removed)', async (context) => {
  const expected = { 1: 'lattice.todo_plan.v3', 2: 'lattice.todo_plan.v4', 3: 'lattice.todo_plan.v5' };
  for (const version of [1, 2, 3]) {
    const root = await repo(context);
    const input = bareInput(['b', 'a'], `lattice.plan_create_input.v${version}`);
    for (const task of input.tasks) {
      delete task.design_memo;
      if (version === 1) delete task.phase_id;
    }
    if (version === 1) { delete input.phases; delete input.phase_accept_dependencies; }
    if (version === 2) delete input.phase_accept_dependencies;
    const result = run(root, ['plan', 'create', '--input', await write(root, 'in.json', input)]);
    assert.equal(result.status, 0, `v${version}: ${result.stderr}`);
    const plan = JSON.parse(await readFile(path.join(root, JSON.parse(result.stdout).plan_ref), 'utf8'));
    assert.equal(plan.schema, expected[version]);
    assert.deepEqual(plan.tasks.map(({ task_id: id }) => id), ['a', 'b']);
  }
});

async function createMain(root, ids = ['a', 'b', 'c']) {
  const result = run(root, ['plan', 'create', '--input', await write(root, 'create.json', bareInput(ids))]);
  assert.equal(result.status, 0, result.stderr);
}

test('plan revise without continuity carries kept tasks and retires dropped ones with computed reasons', async (context) => {
  const root = await repo(context);
  await createMain(root);
  const desired = bareInput(['a', 'b', 'd']);
  desired.plan_version = 'v2';
  desired.tasks[0].title = 'a revised';
  const input = { schema: 'lattice.plan_revise_input.v1', desired };
  const result = run(root, ['plan', 'revise', '--input', await write(root, 'revise.json', input), '--json']);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(out.continuity, [
    { task_id: 'a', policy: 'carry', reason: 'computed carry' },
    { task_id: 'b', policy: 'carry', reason: 'computed carry' },
    { task_id: 'c', policy: 'retire', reason: 'computed retire' },
  ]);
  assert.deepEqual(out.revision.task_migration.map(({ state_policy: policy }) => policy),
    ['carry_reconciled_metadata', 'carry_reconciled_metadata', 'removed']);
  const store = await readTodoStore({ repoRoot: root });
  const member = store.members.find(({ plan }) => plan.plan_key === 'main');
  assert.deepEqual(member.plan.tasks.map(({ task_id: id }) => id), ['a', 'b', 'd']);
  assert.equal(member.plan.tasks[0].title, 'a revised');
});

test('plan revise: author entries win for kept tasks, presence in desired wins over a contradicting entry', async (context) => {
  const root = await repo(context);
  await createMain(root);
  const desired = bareInput(['a', 'b']);
  const input = { schema: 'lattice.plan_revise_input.v1', desired, continuity: [
    { task_id: 'a', policy: 'reset', reason: '作り直す' },
    { task_id: 'b', policy: 'retire' },
    { task_id: 'c', policy: 'carry' },
  ] };
  const out = JSON.parse(run(root, ['plan', 'revise', '--input', await write(root, 'r.json', input),
    '--dry-run', '--json']).stdout);
  assert.deepEqual(out.continuity, [
    { task_id: 'a', policy: 'reset', reason: '作り直す' },
    { task_id: 'b', policy: 'carry', reason: 'computed carry' },
    { task_id: 'c', policy: 'retire', reason: 'computed retire' },
  ]);
  const bad = run(root, ['plan', 'revise', '--input', await write(root, 'bad.json', {
    ...input, continuity: [{ task_id: 'zzz', policy: 'carry' }] }), '--json']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).detail.pointer, '/continuity/0');
});

async function migrationInput(name, tasks = undefined) {
  const value = JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));
  value.schema = 'lattice.todo_extraction.v3';
  for (const entry of value.tasks) {
    if (!Object.hasOwn(entry, 'start')) entry.start = null;
    entry.design_memo = 'NO_PLAN';
  }
  if (tasks !== undefined) value.tasks = tasks(value.tasks);
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  return value;
}

test('migrate registers unknown_requires_evidence tasks as pending and lists them (dry-run too)', async (context) => {
  const root = await repo(context);
  const input = await migrationInput('ambiguous.json');
  const ref = await write(root, 'ambiguous.json', input);
  const dry = JSON.parse(run(root, ['todo', 'migrate', '--input', ref, '--dry-run', '--json']).stdout);
  assert.deepEqual(dry.violations.filter(({ code }) => code === 'unknown_requires_evidence'), []);
  assert.deepEqual(dry.defaulted_pending_task_ids, ['Q1']);
  const migrated = run(root, ['todo', 'migrate', '--input', ref]);
  assert.equal(migrated.status, 0, migrated.stderr);
  const stdout = migrated.stdout.trim().split('\n').pop();
  const result = JSON.parse(stdout);
  assert.deepEqual(result.defaulted_pending_task_ids, ['Q1']);
  assert.equal(result.imported_task_count, 2);
  const store = await readTodoStore({ repoRoot: root });
  const member = store.members.find(({ plan }) => plan.plan_key === 'ambiguous');
  assert.deepEqual(member.tasks.map(({ task_id: id, status }) => [id, status]), [['Q1', 'pending'], ['Q2', 'pending']]);
});

test('todo revise-phase completes missing task/phase migration rows and applies the same revision', async (context) => {
  const root = await repo(context);
  await createMain(root);
  const store = await readTodoStore({ repoRoot: root });
  const member = store.members.find(({ plan }) => plan.plan_key === 'main');
  const desired = bareInput(['a', 'b']);
  desired.plan_version = 'v2';
  const complete = compilePlanRevision({ member, env: ENV,
    input: { schema: 'lattice.plan_revise_input.v1', desired } });
  assert.equal(complete.task_migration.length, 3);
  const partial = structuredClone(complete);
  partial.task_migration = partial.task_migration.filter(({ from_task_id: id }) => id !== 'c');
  partial.phase_migration = [];
  const applied = run(root, ['todo', 'revise-phase', '--plan', 'main',
    '--input', await write(root, 'partial.json', partial)]);
  assert.equal(applied.status, 0, applied.stderr);
  const after = await readTodoStore({ repoRoot: root });
  const next = after.members.find(({ plan }) => plan.plan_key === 'main');
  assert.equal(next.plan.plan_version, complete.desired_plan.plan_version);
  assert.deepEqual(next.plan.tasks.map(({ task_id: id }) => id), ['a', 'b']);
  assert.deepEqual(next.revision.task_migration, complete.task_migration);
});

const ACTOR = { host: 'fixture', session: 'fixture', agent: 'fixture' };
const searchRef = (taskId) => ({ project_id: 'example', plan_key: 'search', task_id: taskId });
const searchTask = (id, memo) => ({ task_id: id, title: id, lane: 'implementation', design_memo: memo,
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'delivery' });
const searchPhase = { phase_id: 'delivery', title: '利用可能にする', gate_policy: 'heavy',
  predecessor_phase_ids: [], required_evidence_slots: ['proof'] };

test('plan revise on a backchain-bound plan adds a task, compiles the chain revision and reports findings', async (context) => {
  const root = await repo(context);
  await writeFile(path.join(root, 'README.md'), 'x\n');
  const authoring = { schema: 'lattice.plan_create_input.v4', project_id: 'example', plan_key: 'search',
    plan_version: 'v1', actor: ACTOR, recorded_at: new Date().toISOString(),
    tasks: [searchTask('index', '索引を作る。'), searchTask('search', '検索を作る。')],
    phases: [searchPhase], hard_dependencies: [{ from: searchRef('index'), to: searchRef('search') }],
    joins: [], phase_accept_dependencies: [] };
  const chain = { schema: 'lattice.plan_backchain.v1', authoring_ref: 'plan.json', project_id: 'example',
    plan_key: 'search', plan_version: 'v1',
    goal: { purpose: '文書を見つける。', outcome: '結果へ到達できる。', acceptance: '開ける。',
      required_feature_ids: ['results'] },
    features: [
      { feature_id: 'index', capability: '索引', acceptance: '検索対象に入る',
        requires_feature_ids: [], provider: { kind: 'task', task_id: 'index' } },
      { feature_id: 'results', capability: '結果', acceptance: '開ける',
        requires_feature_ids: ['index'], provider: { kind: 'task', task_id: 'search' } }],
    tasks: [
      { task_id: 'index', requires_feature_ids: [], provides_feature_ids: ['index'] },
      { task_id: 'search', requires_feature_ids: ['index'], provides_feature_ids: ['results'] }],
    chain_digest: '' };
  chain.chain_digest = todoSelfDigest(chain, 'chain_digest');
  await write(root, 'plan.json', authoring);
  await write(root, 'chain.json', chain);
  const created = run(root, ['plan', 'backchain', '--input', 'chain.json', '--json']);
  assert.equal(created.status, 0, created.stderr);

  const desired = { ...authoring, plan_version: 'v2',
    tasks: [searchTask('export', '結果を書き出す。'), searchTask('index', '索引を作る。'),
      searchTask('search', '検索を作る。')],
    hard_dependencies: [{ from: searchRef('index'), to: searchRef('search') }] };
  delete desired.actor;
  delete desired.recorded_at;
  const revised = run(root, ['plan', 'revise', '--json', '--input', await write(root, 'revise.json',
    { schema: 'lattice.plan_revise_input.v1', desired })]);
  assert.equal(revised.status, 0, revised.stderr);
  const out = JSON.parse(revised.stdout);
  assert.equal(out.revision.schema, 'lattice.phase_todo_revision.v4');
  assert.deepEqual(out.revision.backchain.tasks.map(({ task_id: id }) => id), ['export', 'index', 'search']);
  assert.ok(out.feature_chain_findings.some(({ reason, task_id: id }) => reason === 'task_invalid' && id === 'export'));
  const store = await readTodoStore({ repoRoot: root });
  const member = store.members.find(({ plan }) => plan.plan_key === 'search');
  assert.deepEqual(member.plan.tasks.map(({ task_id: id }) => id), ['export', 'index', 'search']);
  assert.equal(member.plan.plan_version, out.plan_version);
});

const DIGEST = '1'.repeat(64);
const HEAD = '2'.repeat(64);

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


test('completePhaseTodoRevision adds a silently dropped predecessor source to excluded_tombstones (v3)', () => {
  const revision = phaseRevisionV3Fixture();
  assert.equal(validatePhaseTodoRevision(revision), true);
  const dropped = { source_ref: 'docs/plan.md#L9', source_digest: 'a'.repeat(64) };
  const previousTombstone = { source_ref: 'docs/plan.md#L3', source_digest: 'b'.repeat(64), exclusion_reason: 'old' };
  const predecessorInventory = {
    active: [...revision.source_inventory.active, { task_id: 'T0', ...dropped }],
    excluded_tombstones: [previousTombstone],
  };
  const member = { plan: { schema: 'lattice.todo_plan.v5', tasks: [{ task_id: 'T1' }, { task_id: 'T2' }],
    phases: [{ phase_id: 'phase-1' }] } };
  const completed = completePhaseTodoRevision(revision, { member, predecessorInventory, buildPlan: buildTodoPlan });
  assert.notEqual(completed, revision);
  assert.deepEqual(completed.source_inventory.excluded_tombstones.map(({ source_ref: sourceRef }) => sourceRef),
    ['docs/plan.md#L3', 'docs/plan.md#L9']);
  assert.equal(validatePhaseTodoRevision(completed), true);
  const same = completePhaseTodoRevision(revision, { member, buildPlan: buildTodoPlan,
    predecessorInventory: revision.source_inventory });
  assert.equal(same, revision);
});
