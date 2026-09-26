import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp, readFile, readdir, rm, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canonicalizeTodoArtifact,
  todoSelfDigest,
} from '../src/todo-contracts.mjs';
import {
  appendImportedPlan,
  appendTodoEvent,
  buildTodoPlan,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';
import {
  phaseTodoRevisionPlanVersion, todoLegacyReconciliationDigest,
  todoReconciliationDigest,
  todoRevisionPlanVersion,
  todoSourceInventoryDigest,
} from '../src/todo-revision.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-07-18T00:00:00.000Z';
const manifestRef = '.lattice/todo/manifest.json';
const journalRef = '.lattice/todo/plans/main/v1/journal/active.jsonl';
const snapshotRef = '.lattice/todo/plans/main/v1/snapshot.json';

const task = (taskId) => ({
  task_id: taskId,
  title: taskId,
  lane: 'main',
  narrative_ref: null,
  compile_binding: null,
});

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1',
        project_id: 'project-1',
        plan_key: 'main',
        plan_version: 'v1',
        predecessor_plan_digest: null,
        tasks: [task('T1'), task('T2')],
        hard_dependencies: [{
          from: { project_id: 'project-1', plan_key: 'main', task_id: 'T1' },
          to: { project_id: 'project-1', plan_key: 'main', task_id: 'T2' },
        }],
        joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  return root;
}

async function parallelWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-cli-parallel-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' }).status, 0);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
        predecessor_plan_digest: null, tasks: [task('T1'), task('T2')],
        hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  return root;
}

function runCli(root, args, { actor = true } = {}) {
  const env = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' };
  delete env.FORCE_COLOR;
  if (actor) {
    env.LATTICE_TODO_ACTOR_HOST = ACTOR.host;
    env.LATTICE_TODO_ACTOR_SESSION = ACTOR.session;
    env.LATTICE_TODO_ACTOR_AGENT = ACTOR.agent;
  } else {
    delete env.LATTICE_TODO_ACTOR_HOST;
    delete env.LATTICE_TODO_ACTOR_SESSION;
    delete env.LATTICE_TODO_ACTOR_AGENT;
  }
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.error, undefined);
  return result;
}

async function evidenceFixture(root, name = 'evidence', body = `${name}\n`) {
  const ref = `${name}.txt`;
  const bytes = Buffer.from(body, 'utf8');
  await writeFile(path.join(root, ref), bytes);
  const object = spawnSync('git', ['hash-object', '-w', ref], { cwd: root, encoding: 'utf8' });
  assert.equal(object.status, 0, object.stderr);
  const descriptor = {
    evidence_id: name,
    repo_id: 'self',
    path: ref,
    git_blob_oid: object.stdout.trim(),
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain',
    anchor_digest: null,
  };
  const descriptorRef = `${name}.json`;
  await writeFile(path.join(root, descriptorRef), `${JSON.stringify(descriptor)}\n`);
  return { descriptor, descriptorRef };
}

function gitOutput(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function pinnedImportCommit(root) {
  const blob = gitOutput(root, ['hash-object', '-w', '--stdin'], '# Imported plan\n- [x] A1\n- [x] A2\n');
  const tree = gitOutput(root, ['mktree'], `100644 blob ${blob}\tplan.md\n`);
  return gitOutput(root, ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1760000000 +0000\ncommitter Fixture <fixture@example.invalid> 1760000000 +0000\n\nfixture\n`);
}

async function importedUnknownDone(root) {
  const sourceCommit = pinnedImportCommit(root);
  const source = (originLine) => ({
    schema: 'lattice.todo_import_source.v1',
    origin_plan_ref: 'plan.md',
    origin_line: originLine,
    source_commit: sourceCommit,
  });
  return appendImportedPlan({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    plan: {
      schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'archive', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [task('A1'), task('A2')],
      hard_dependencies: [{
        from: { project_id: 'project-1', plan_key: 'archive', task_id: 'A1' },
        to: { project_id: 'project-1', plan_key: 'archive', task_id: 'A2' },
      }],
      joins: [],
    },
    genesis: { actor: ACTOR, recorded_at: NOW },
    completedTasks: [
      { task_id: 'A1', completed_at: NOW, evidence: source(2) },
      { task_id: 'A2', completed_at: 'unknown_requires_evidence', evidence: source(3) },
    ],
    now: NOW,
  });
}

function successJson(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^\{.*\}\n$/u);
  return JSON.parse(result.stdout);
}

async function fileBytes(root, ref) {
  return readFile(path.join(root, ref));
}

async function storeDigest(root) {
  const storeRoot = path.join(root, '.lattice', 'todo');
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const ref = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), ref);
      else entries.push([ref, await readFile(path.join(directory, entry.name))]);
    }
  }
  await visit(storeRoot);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const hash = createHash('sha256');
  for (const [ref, bytes] of entries) hash.update(ref).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

async function writeCanonical(root, ref, value) {
  await writeFile(path.join(root, ref), `${canonicalizeTodoArtifact(value)}\n`);
}

async function revisionInput(root) {
  await writeFile(path.join(root, 'plan.md'), '- [ ] T1\n- [ ] T2\n');
  const previous = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const predecessor = { plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest,
    plan_version: previous.plan.plan_version };
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: 'carry' },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: 'carry' },
  ];
  const sourceInventory = { active: [
    { task_id: 'T1', source_ref: 'plan.md#L1',
      source_digest: createHash('sha256').update('- [ ] T1').digest('hex') },
    { task_id: 'T2', source_ref: 'plan.md#L2',
      source_digest: createHash('sha256').update('- [ ] T2').digest('hex') },
  ], excluded_tombstones: [] };
  const v3task = (taskId) => ({ ...task(taskId), narrative_anchor: null, parent_task_id: null });
  const desiredInput = { schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'main', plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [v3task('T1'), v3task('T2')], hard_dependencies: [{
      from: { project_id: 'project-1', plan_key: 'main', task_id: 'T1' },
      to: { project_id: 'project-1', plan_key: 'main', task_id: 'T2' },
    }], joins: [] };
  desiredInput.plan_version = todoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
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
  const revision = { schema: 'lattice.todo_revision.v1', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    source_inventory: sourceInventory, reconciliation, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

test('todo verifyは全member/plan指定のexact result wireを一行で返す', async (context) => {
  const root = await workspace(context);
  for (const args of [['todo', 'verify'], ['todo', 'verify', '--plan', 'main']]) {
    const output = successJson(runCli(root, args));
    assertExactKeys(output, [
      'schema', 'project_id', 'requested_plan_key', 'verified_members', 'snapshot_stale', 'result_digest',
    ]);
    assert.equal(output.schema, 'lattice.todo_verify_result.v3');
    assert.equal(output.project_id, 'project-1');
    assert.equal(output.requested_plan_key, args.length === 2 ? null : 'main');
    assert.equal(output.snapshot_stale, false);
    assert.equal(output.result_digest, todoSelfDigest(output, 'result_digest'));
    assert.equal(output.verified_members.length, 1);
    assertExactKeys(output.verified_members[0], [
      'plan_key', 'plan_version', 'topology_digest', 'journal_head_digest', 'through_sequence',
      'snapshot_stale', 'reconciliation_state', 'revision_digest', 'reconciliation_digest',
      'source_inventory_count', 'active_task_count', 'excluded_tombstone_count',
      'reconciliation_guidance',
    ]);
    assert.equal(output.verified_members[0].reconciliation_state, 'registered_unreconciled');
    assert.equal(output.verified_members[0].revision_digest, null);
    assert.equal(output.verified_members[0].source_inventory_count, null);
    assert.deepEqual(output.verified_members[0].reconciliation_guidance, {
      meaning: 'source_inventory_verification_state', lifecycle_blocked: false,
      dashboard_visibility_blocked: false,
      schema_command: 'lattice todo revise --schema --json',
      next_action: 'lattice todo revise --plan main --input <revision.json>',
    });
  }
});

test('todo status/verifyは末尾--jsonをflag無しJSON wireの互換aliasとして受理する', async (context) => {
  const root = await workspace(context);
  assert.deepEqual(successJson(runCli(root, ['todo', 'status', '--json'])),
    successJson(runCli(root, ['todo', 'status'])));
  assert.deepEqual(successJson(runCli(root, ['todo', 'verify', '--json'])),
    successJson(runCli(root, ['todo', 'verify'])));
  assert.deepEqual(successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json'])),
    successJson(runCli(root, ['todo', 'verify', '--plan', 'main'])));
});

test('todo bindingsはcompile_binding付きTaskをTODO identityつきで投影する', async (context) => {
  // 出荷しているのにCLIから一度も走らせていないコマンドを残さない。
  const root = await workspace(context);
  const withFlag = successJson(runCli(root, ['todo', 'bindings', '--json']));
  assert.equal(typeof withFlag.schema, 'string');
  assert.match(withFlag.schema, /^lattice\.todo_/u);
  // 末尾--jsonはflag無しJSON wireの互換aliasである。
  assert.deepEqual(successJson(runCli(root, ['todo', 'bindings'])), withFlag);
  // plan絞り込みも同じ契約で応える。
  const scoped = successJson(runCli(root, ['todo', 'bindings', '--plan', 'main', '--json']));
  assert.equal(scoped.schema, withFlag.schema);
});

test('todo reviseはcanonical revisionだけを発行しstatus/verifyへreconciled identityを公開する', async (context) => {
  const root = await workspace(context);
  const revision = await revisionInput(root);
  await writeCanonical(root, 'revision.json', revision);
  const output = successJson(runCli(root, ['todo', 'revise', '--plan', 'main', '--input', 'revision.json']));
  assert.equal(output.schema, 'lattice.todo_revise_result.v1');
  assert.equal(output.revision_digest, revision.revision_digest);
  assert.equal(output.result_digest, todoSelfDigest(output, 'result_digest'));
  const status = successJson(runCli(root, ['todo', 'status']));
  assert.equal(status.member_heads[0].reconciliation_state, 'reconciled');
  assert.equal(status.member_heads[0].revision_digest, revision.revision_digest);
  const verified = successJson(runCli(root, ['todo', 'verify', '--plan', 'main']));
  assert.equal(verified.verified_members[0].reconciliation_state, 'reconciled');
  assert.equal(verified.verified_members[0].source_inventory_count, 2);
  assert.equal(verified.verified_members[0].active_task_count, 2);
  assert.equal(verified.verified_members[0].excluded_tombstone_count, 0);
  await writeFile(path.join(root, 'plan.md'), '- [x] T1\n- [ ] T2\n');
  const drifted = runCli(root, ['todo', 'verify', '--plan', 'main']);
  assert.equal(drifted.status, 1);
  assert.equal(drifted.stdout, '');
  assert.equal(JSON.parse(drifted.stderr).code, 'RECONCILIATION_INCOMPLETE');
});

test('todo revise/verifyはsource inventoryのLF digestをCRLF checkoutでも照合する', async (context) => {
  const root = await workspace(context);
  const revision = await revisionInput(root);
  await writeFile(path.join(root, 'plan.md'), '- [ ] T1\r\n- [ ] T2\r\n');
  await writeCanonical(root, 'revision.json', revision);

  const revised = runCli(root, ['todo', 'revise', '--plan', 'main', '--input', 'revision.json']);
  assert.equal(revised.status, 0, revised.stderr);
  const verified = runCli(root, ['todo', 'verify', '--plan', 'main']);
  assert.equal(verified.status, 0, verified.stderr);

  await writeFile(path.join(root, 'plan.md'), '- [ ] T1 changed\r\n- [ ] T2\r\n');
  const drifted = runCli(root, ['todo', 'verify', '--plan', 'main']);
  assert.equal(drifted.status, 1);
  assert.equal(JSON.parse(drifted.stderr).detail.reason, 'source_digest_mismatch');
});

test('todo reviseのcarryは完了済みTaskのtest_resultを次版へ引き継ぐ', async (context) => {
  const root = await workspace(context);
  const { descriptor } = await evidenceFixture(root);
  const markdown = '## 最終試験\n\n- focused: 2/2\n';
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { evidence: descriptor, test_result: markdown } } });

  const revision = await revisionInput(root);
  await writeCanonical(root, 'revision.json', revision);
  successJson(runCli(root, ['todo', 'revise', '--plan', 'main', '--input', 'revision.json']));

  const shown = successJson(runCli(root, ['todo', 'show', '--plan', 'main', '--task', 'T1', '--json']));
  assert.equal(shown.state.status, 'done');
  assert.equal(shown.state.test_result, markdown);
});

test('todo verifyはactive phase v1/v2でも履歴上のsource inventoryを検証する', async (context) => {
  const root = await workspace(context);
  const revision = await revisionInput(root);
  await writeCanonical(root, 'revision.json', revision);
  successJson(runCli(root, ['todo', 'revise', '--plan', 'main', '--input', 'revision.json']));

  const member = (await readTodoStore({ repoRoot: root })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const taskMigration = member.plan.tasks.map(({ task_id }) => ({
    from_task_id: task_id, to_task_id: task_id, state_policy: 'reset_pending',
  }));
  const phaseMigration = [{ from_phase_id: null, to_phase_id: 'phase-1', state_policy: 'reset' }];
  const desiredInput = structuredClone(member.plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.schema = 'lattice.todo_plan.v5';
  desiredInput.plan_version = 'pending';
  desiredInput.predecessor_plan_digest = predecessor.plan_digest;
  desiredInput.tasks = desiredInput.tasks.map((entry) => ({ ...entry, phase_id: 'phase-1' }));
  desiredInput.phases = [{ phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }];
  desiredInput.phase_accept_dependencies = [];
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1',
    planKey: 'main', predecessor, desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  const phaseRevision = { schema: 'lattice.phase_todo_revision.v2', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan,
    task_migration: taskMigration, phase_migration: phaseMigration, revision_digest: '' };
  phaseRevision.revision_digest = todoSelfDigest(phaseRevision, 'revision_digest');
  await writeCanonical(root, 'phase-revision.json', phaseRevision);
  successJson(runCli(root, ['todo', 'revise-phase', '--plan', 'main', '--input',
    'phase-revision.json']));

  const verified = successJson(runCli(root, ['todo', 'verify', '--plan', 'main']));
  assert.equal(verified.verified_members[0].source_inventory_count, 2);
  assert.equal(verified.verified_members[0].active_task_count, 2);
  await writeFile(path.join(root, 'plan.md'), '- [ ] T1 drifted\n- [ ] T2\n');
  const drifted = runCli(root, ['todo', 'verify', '--plan', 'main']);
  assert.equal(drifted.status, 1);
  assert.equal(JSON.parse(drifted.stderr).code, 'RECONCILIATION_INCOMPLETE');
  assert.equal(JSON.parse(drifted.stderr).detail.reason, 'source_digest_mismatch');
});

test('todo reviseはpretty-print入力を受理してcanonical storeへ書く', async (context) => {
  const root = await workspace(context);
  const revision = await revisionInput(root);
  await writeFile(path.join(root, 'revision.json'), JSON.stringify(revision, null, 2));
  const result = runCli(root, ['todo', 'revise', '--plan', 'main', '--input', 'revision.json']);
  assert.equal(result.status, 0, result.stderr);
});

test('authoring CLIはclosed遷移をappendしmutation resultをdigest束縛する', async (context) => {
  const root = await workspace(context);
  const { descriptorRef } = await evidenceFixture(root);
  const commands = [
    [['todo', 'start', '--plan', 'main', '--task', 'T1'], 'start', 'in-progress'],
    [['todo', 'block', '--plan', 'main', '--task', 'T1', '--reason', 'waiting'], 'block', 'blocked'],
    [['todo', 'unblock', '--plan', 'main', '--task', 'T1'], 'unblock', 'in-progress'],
    [['todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', descriptorRef], 'done', 'done'],
    [['todo', 'reopen', '--plan', 'main', '--task', 'T1', '--reason', 'correction'], 'reopen', 'in-progress'],
  ];
  let sequence = 0;
  for (const [args, kind, status] of commands) {
    const output = successJson(runCli(root, args));
    sequence += 1;
    const keys = [
      'schema', 'project_id', 'plan_key', 'plan_version', 'task_id', 'kind', 'sequence',
      'event_digest', 'journal_head_digest', 'snapshot_digest', 'status', 'advisory',
      'result_digest',
    ];
    if (kind === 'start') keys.push('design_memo', 'note_context', 'structure_context');
    assertExactKeys(output, keys);
    assert.equal(output.schema, kind === 'start'
      ? 'lattice.todo_mutation_result.v5' : 'lattice.todo_mutation_result.v2');
    // 助言はstartだけが持つ。他の遷移で独立性を語らない（ADR 0128 Decision 5）。
    if (kind === 'start') {
      assert.deepEqual(output.design_memo.status, 'missing_legacy');
      assert.equal(output.design_memo.markdown, null);
      assert.deepEqual(output.note_context.notes, []);
      assert.deepEqual(output.structure_context, {
        status: 'not_enabled', enabled: false, freshness: null, stale_reasons: [],
        structure_set_digest: null, task: null, next_actions: [],
      });
      assertExactKeys(output.advisory, [
        'coverage', 'drift_intersecting', 'conflicts_with_active',
        'scope_expansion_recommendations', 'uncovered_active_task_ids', 'self_unknowns', 'guidance',
      ]);
      // 案内は単一正本のcatalogから来る（ADR 0130 Decision 1）。
      assertExactKeys(output.advisory.guidance, ['code', 'message', 'next_action']);
    } else {
      assert.equal(output.advisory, null);
    }
    assert.equal(output.kind, kind);
    assert.equal(output.status, status);
    assert.equal(output.sequence, sequence);
    assert.equal(output.journal_head_digest, output.event_digest);
    assert.equal(output.result_digest, todoSelfDigest(output, 'result_digest'));
  }
  const journal = (await readFile(path.join(root, journalRef), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.slice(1).map(({ actor }) => actor), Array(commands.length).fill(ACTOR));
  assert.equal(journal.at(-1).payload.target_done_digest, journal.at(-2).event_digest);
});

test('authoring CLIはtask IDのcase差をlock内でcanonical IDへ解決する', async (context) => {
  const root = await workspace(context);
  const { descriptorRef } = await evidenceFixture(root, 'case-normalization');
  const started = successJson(runCli(root, [
    'todo', 'start', '--plan', 'main', '--task', 't1',
  ]));
  assert.equal(started.task_id, 'T1');
  assert.equal(started.status, 'in-progress');
  const done = successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 't1', '--evidence', descriptorRef,
  ]));
  assert.equal(done.task_id, 'T1');
  assert.equal(done.status, 'done');
  const journal = (await readFile(path.join(root, journalRef), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.slice(1).map(({ task_id: taskId }) => taskId), ['T1', 'T1']);
  const before = await storeDigest(root);
  const missing = runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'missing']);
  assert.equal(missing.status, 1);
  const error = JSON.parse(missing.stderr);
  assert.equal(error.code, 'TASK_NOT_FOUND');
  assert.equal(error.detail.reason, 'task_not_found');
  assert.equal(error.detail.requested_task_id, 'missing');
  assert.equal(await storeDigest(root), before);
});

test('authoring CLIはactor欠落をdefaultで通し、順序違反・blocked中doneを無変更拒否する', async (context) => {
  const root = await workspace(context);
  const { descriptorRef } = await evidenceFixture(root);
  const defaulted = successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1'], {
    actor: false,
  }));
  assert.equal(defaulted.status, 'in-progress');
  const before = await storeDigest(root);
  const skipped = runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T2']);
  assert.equal(skipped.status, 1);
  assert.equal(JSON.parse(skipped.stderr).code, 'STORE_INCONSISTENT');
  assert.equal(JSON.parse(skipped.stderr).detail.reason, 'invalid_start_transition');
  assert.equal(await storeDigest(root), before);
  successJson(runCli(root, ['todo', 'block', '--plan', 'main', '--task', 'T1', '--reason', 'waiting']));
  const blockedBefore = await storeDigest(root);
  const blockedDone = runCli(root, ['todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', descriptorRef]);
  assert.equal(blockedDone.status, 1);
  assert.equal(JSON.parse(blockedDone.stderr).detail.reason, 'invalid_done_transition');
  assert.equal(await storeDigest(root), blockedBefore);
  const blockedMessage = runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--message', '残してはならない',
  ]);
  assert.equal(blockedMessage.status, 1);
  assert.equal(JSON.parse(blockedMessage.stderr).detail.reason, 'invalid_done_transition');
  assert.equal(await storeDigest(root), blockedBefore);
});

test('authoring CLIは不正actor環境だけを拒否し、欠落はdefaultする', async (context) => {
  const root = await workspace(context);
  const env = {
    ...process.env,
    LATTICE_TODO_ACTOR_HOST: 'host-1',
    LATTICE_TODO_ACTOR_SESSION: 'invalid session',
  };
  delete env.LATTICE_TODO_ACTOR_AGENT;
  const result = spawnSync(process.execPath, [CLI, 'todo', 'start', '--plan', 'main', '--task', 'T1'], {
    cwd: root, env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'ACTOR_UNRESOLVED');
  assert.deepEqual(error.detail.missing_environment, []);
  assert.deepEqual(error.detail.invalid_environment, ['LATTICE_TODO_ACTOR_SESSION']);
  assert.equal(error.detail.next_action, 'set_required_actor_environment_and_retry');
});

test('flag順と証拠本文・repo内絶対pathでstart/doneが通る', async (context) => {
  const root = await workspace(context);
  const started = successJson(runCli(root, ['todo', 'start', '--task', 'T1', '--plan', 'main']));
  assert.equal(started.status, 'in-progress');
  const byMessage = successJson(runCli(root, [
    'todo', 'done', '--task', 'T1', '--plan', 'main', '--message', '閉じた',
  ]));
  assert.equal(byMessage.status, 'done');

  const startedT2 = successJson(runCli(root, [
    'todo', 'start', '--plan', 'main', '--task', 'T2', '--override-reason', 'after T1',
  ]));
  assert.equal(startedT2.status, 'in-progress');
  const bodyRef = path.join(root, 'body-evidence.md');
  await writeFile(bodyRef, '# 実装メモ\n');
  const byAbsolute = successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T2', '--evidence', bodyRef,
  ]));
  assert.equal(byAbsolute.status, 'done');
});

test('CRLF evidenceはGit clean filter後のcommit blobへ束縛されhard verifyを通る', async (context) => {
  const root = await workspace(context);
  gitOutput(root, ['config', 'user.email', 'fixture@example.invalid']);
  gitOutput(root, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(root, '.gitattributes'), '*.md text eol=lf\n');
  const bodyRef = 'crlf-evidence.md';
  await writeFile(path.join(root, bodyRef), '# Evidence\r\n\r\nverified\r\n');

  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', bodyRef,
  ]));
  gitOutput(root, ['add', '.']);
  gitOutput(root, ['commit', '--quiet', '-m', 'commit normalized evidence']);

  const committedOid = gitOutput(root, ['rev-parse', `HEAD:${bodyRef}`]);
  const committedBody = spawnSync('git', ['cat-file', 'blob', committedOid], {
    cwd: root, encoding: 'buffer',
  });
  assert.equal(committedBody.status, 0, committedBody.stderr?.toString('utf8'));
  const member = (await readTodoStore({ repoRoot: root, forWrite: true })).members[0];
  const descriptor = member.tasks.find(({ task_id: taskId }) => taskId === 'T1').evidence;
  assert.equal(descriptor.git_blob_oid, committedOid);
  assert.equal(descriptor.content_digest,
    createHash('sha256').update(committedBody.stdout).digest('hex'));
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));
});

test('--messageはcontent-addressed evidence fileをstoreへ保存してcommit後verifyを通る', async (context) => {
  const root = await workspace(context);
  gitOutput(root, ['config', 'user.email', 'fixture@example.invalid']);
  gitOutput(root, ['config', 'user.name', 'Fixture']);
  gitOutput(root, ['add', '.']);
  gitOutput(root, ['commit', '--quiet', '-m', 'commit initial store']);
  successJson(runCli(root, [
    'todo', 'start', '--plan', 'main', '--task', 'T1', '--commit-store',
  ]));
  const committed = successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--message', '完了証拠', '--commit-store',
  ]));

  const member = (await readTodoStore({ repoRoot: root })).members[0];
  const descriptor = member.tasks.find(({ task_id: taskId }) => taskId === 'T1').evidence;
  assert.match(descriptor.path,
    /^\.lattice\/todo\/evidence\/main\/T1\/[0-9a-f]{64}\.md$/u);
  assert.equal((await readFile(path.join(root, descriptor.path), 'utf8')), '完了証拠');
  assert.equal(committed.commit.paths.includes(descriptor.path), true);
  assert.equal(gitOutput(root, ['rev-parse', `HEAD:${descriptor.path}`]), descriptor.git_blob_oid);
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));
});

test('start/reopen overrideとdescriptor schema拒否をexact argvで処理する', async (context) => {
  const root = await workspace(context);
  const { descriptorRef } = await evidenceFixture(root);
  const overridden = successJson(runCli(root, [
    'todo', 'start', '--plan', 'main', '--task', 'T2', '--override-reason', 'parallel audit',
  ]));
  assert.equal(overridden.status, 'in-progress');

  const invalidRef = 'invalid-evidence.json';
  await writeFile(path.join(root, invalidRef), '{"path":"evidence.txt"}\n');
  const before = await storeDigest(root);
  const invalid = runCli(root, ['todo', 'done', '--plan', 'main', '--task', 'T2', '--evidence', invalidRef]);
  assert.equal(invalid.status, 1);
  const invalidError = JSON.parse(invalid.stderr);
  assert.equal(invalidError.code, 'INVALID_EVIDENCE');
  assert.match(invalidError.detail.expected.shape, /git_blob_oid/u);
  assert.equal(await storeDigest(root), before);

  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  successJson(runCli(root, ['todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', descriptorRef]));
  const withoutOverride = runCli(root, [
    'todo', 'reopen', '--plan', 'main', '--task', 'T1', '--reason', 'correction',
  ]);
  assert.equal(withoutOverride.status, 1);
  assert.equal(JSON.parse(withoutOverride.stderr).detail.reason, 'reopen_has_started_successor');
  assert.match(JSON.parse(withoutOverride.stderr).detail.next_action, /todo split/u);
  const reopened = successJson(runCli(root, [
    'todo', 'reopen', '--plan', 'main', '--task', 'T1', '--reason', 'correction',
    '--override-reason', 'successor audited',
  ]));
  assert.equal(reopened.status, 'in-progress');
});

test('複数readyのplain startは宣言なしで通り、直列理由は記録するだけ', async (context) => {
  const root = await parallelWorkspace(context);
  const started = successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  assert.equal(started.status, 'in-progress');
  const second = successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T2']));
  assert.equal(second.status, 'in-progress');

  const serialRoot = await parallelWorkspace(context);
  const serialized = successJson(runCli(serialRoot, [
    'todo', 'start', '--plan', 'main', '--task', 'T1', '--override-reason',
    'single host capacity',
  ]));
  assert.equal(serialized.status, 'in-progress');
  const journal = (await readFile(path.join(serialRoot, journalRef), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).payload.override_reason, 'single host capacity');

  const confirmedRoot = await parallelWorkspace(context);
  const confirmed = successJson(runCli(confirmedRoot, [
    'todo', 'start', '--plan', 'main', '--task', 'T1', '--override-reason',
    'single host capacity', '--serial-confirmed',
  ]));
  assert.equal(confirmed.status, 'in-progress');
});

test('直列化理由の文言は審査せず記録する', async (context) => {
  const root = await parallelWorkspace(context);
  const accepted = successJson(runCli(root, [
    'todo', 'start', '--plan', 'main', '--task', 'T1',
    '--override-reason', '単一セッションでの逐次実行',
  ]));
  assert.equal(accepted.status, 'in-progress');
  const journal = (await readFile(path.join(root, journalRef), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).payload.override_reason, '単一セッションでの逐次実行');

  const englishRoot = await parallelWorkspace(context);
  const english = successJson(runCli(englishRoot, [
    'todo', 'start', '--plan', 'main', '--task', 'T1',
    '--override-reason', 'single agent, sequential run', '--serial-confirmed',
  ]));
  assert.equal(english.status, 'in-progress');

  const singleRoot = await workspace(context);
  const acknowledgedSingleFrontier = successJson(runCli(singleRoot, [
    'todo', 'start', '--plan', 'main', '--task', 'T1', '--parallel-frontier',
  ]));
  assert.equal(acknowledgedSingleFrontier.status, 'in-progress');
});

test('evidence promote CLIはlock内でunknown historical doneを解決する', async (context) => {
  const root = await workspace(context);
  const imported = await importedUnknownDone(root);
  const sourceDone = imported.events.find(({ kind, task_id: taskId }) => kind === 'done' && taskId === 'A2');
  const { descriptorRef } = await evidenceFixture(root, 'promoted');
  const output = successJson(runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'archive', '--task', 'A2', '--evidence', descriptorRef,
  ]));
  assert.equal(output.kind, 'done');
  assert.equal(output.status, 'done');
  const journal = (await readFile(path.join(root,
    '.lattice/todo/plans/archive/v1/journal/active.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).payload.done_mode, 'evidence_promotion');
  assert.equal(journal.at(-1).payload.target_done_digest, sourceDone.event_digest);
});

test('CRLF evidence promoteはcommit時のLF blobへ再束縛してhard verifyを通る', async (context) => {
  const root = await workspace(context);
  gitOutput(root, ['config', 'user.email', 'fixture@example.invalid']);
  gitOutput(root, ['config', 'user.name', 'Fixture']);
  await writeFile(path.join(root, '.gitattributes'), '*.md text eol=lf\n');
  const original = await evidenceFixture(root, 'promotion-original', 'before\n');
  gitOutput(root, ['add', 'promotion-original.txt']);
  gitOutput(root, ['commit', '--quiet', '-m', 'commit original evidence']);
  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', original.descriptorRef,
  ]));

  const replacementRef = 'promotion-replacement.md';
  await writeFile(path.join(root, replacementRef), '# Replacement\r\n\r\nverified\r\n');
  successJson(runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'main', '--task', 'T1',
    '--evidence', replacementRef,
  ]));
  gitOutput(root, ['add', '.']);
  gitOutput(root, ['commit', '--quiet', '-m', 'commit promoted evidence']);

  const descriptor = (await readTodoStore({ repoRoot: root, forWrite: true })).members[0]
    .tasks.find(({ task_id: taskId }) => taskId === 'T1').evidence;
  assert.equal(descriptor.git_blob_oid, gitOutput(root, ['rev-parse', `HEAD:${replacementRef}`]));
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));
});

test('authored doneの証拠更新は追記eventで再束縛し完了時刻を維持する', async (context) => {
  const root = await workspace(context);
  const original = await evidenceFixture(root, 'authored', 'before\n');
  gitOutput(root, ['add', 'authored.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'original evidence',
  ]);
  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', original.descriptorRef,
  ]));
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));
  const before = (await readTodoStore({ repoRoot: root })).members[0].tasks
    .find(({ task_id: taskId }) => taskId === 'T1');

  const replacement = await evidenceFixture(root, 'authored', 'after\n');
  gitOutput(root, ['add', 'authored.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'updated evidence',
  ]);
  const oldObject = original.descriptor.git_blob_oid;
  await unlink(path.join(root, '.git', 'objects', oldObject.slice(0, 2), oldObject.slice(2)));
  const unverified = runCli(root, ['todo', 'verify', '--plan', 'main', '--json']);
  assert.equal(unverified.status, 1);
  assert.equal(JSON.parse(unverified.stderr).detail.reason, 'evidence_unverified');

  const promoted = successJson(runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'main', '--task', 'T1',
    '--evidence', replacement.descriptorRef,
  ]));
  assert.equal(promoted.status, 'done');
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));

  const firstMember = (await readTodoStore({ repoRoot: root })).members[0];
  const after = firstMember.tasks.find(({ task_id: taskId }) => taskId === 'T1');
  assert.equal(after.done_at, before.done_at);
  assert.equal(after.imported, false);
  assert.equal(after.evidence.content_digest, replacement.descriptor.content_digest);
  assert.equal(firstMember.journal.events.at(-1).payload.done_mode, 'evidence_promotion');
  assert.equal(firstMember.journal.events.at(-1).payload.imported, false);
  // promotionはそのappendだけの一時免除ではない。旧blob不達のままでも、次の通常
  // mutationが読むhard-verify storeを再びbrickさせない。
  await readTodoStore({ repoRoot: root, forWrite: true });

  const firstPromotionDigest = firstMember.journal.events.at(-1).event_digest;
  const final = await evidenceFixture(root, 'authored', 'final\n');
  gitOutput(root, ['add', 'authored.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'final evidence',
  ]);
  const replacementObject = replacement.descriptor.git_blob_oid;
  await unlink(path.join(root, '.git', 'objects', replacementObject.slice(0, 2), replacementObject.slice(2)));
  successJson(runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'main', '--task', 'T1',
    '--evidence', final.descriptorRef,
  ]));
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));
  const finalMember = (await readTodoStore({ repoRoot: root })).members[0];
  const finalState = finalMember.tasks.find(({ task_id: taskId }) => taskId === 'T1');
  assert.equal(finalState.done_at, before.done_at);
  assert.equal(finalState.imported, false);
  assert.equal(finalMember.journal.events.at(-1).payload.target_done_digest, firstPromotionDigest);
  await readTodoStore({ repoRoot: root, forWrite: true });
});

test('reopen前後の全旧done証拠は最新promotion後のhard readを再停止させない', async (context) => {
  const root = await workspace(context);
  const first = await evidenceFixture(root, 'reopen-chain', 'first\n');
  gitOutput(root, ['add', 'reopen-chain.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'first completion evidence',
  ]);
  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', first.descriptorRef,
  ]));
  successJson(runCli(root, [
    'todo', 'reopen', '--plan', 'main', '--task', 'T1', '--reason', 'correction',
  ]));

  const second = await evidenceFixture(root, 'reopen-chain', 'second\n');
  gitOutput(root, ['add', 'reopen-chain.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'second completion evidence',
  ]);
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', second.descriptorRef,
  ]));

  const final = await evidenceFixture(root, 'reopen-chain', 'final\n');
  gitOutput(root, ['add', 'reopen-chain.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'final completion evidence',
  ]);
  for (const descriptor of [first.descriptor, second.descriptor]) {
    await unlink(path.join(root, '.git', 'objects', descriptor.git_blob_oid.slice(0, 2),
      descriptor.git_blob_oid.slice(2)));
  }
  successJson(runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'main', '--task', 'T1',
    '--evidence', final.descriptorRef,
  ]));
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));
  const task1 = (await readTodoStore({ repoRoot: root, forWrite: true })).members[0].tasks
    .find(({ task_id: taskId }) => taskId === 'T1');
  assert.equal(task1.evidence.content_digest, final.descriptor.content_digest);
});

test('evidence promoteは過去の不達だけを許し新しい不正証拠を記録しない', async (context) => {
  const root = await workspace(context);
  const original = await evidenceFixture(root, 'repair-target', 'before\n');
  gitOutput(root, ['add', 'repair-target.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'original evidence',
  ]);
  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', original.descriptorRef,
  ]));
  const oldObject = original.descriptor.git_blob_oid;
  await unlink(path.join(root, '.git', 'objects', oldObject.slice(0, 2), oldObject.slice(2)));

  const writable = await readTodoStore({ repoRoot: root, forWrite: true });
  assert.equal(writable.members[0].tasks.find(({ task_id }) => task_id === 'T1').evidence_unverified, true);

  const invalid = {
    ...original.descriptor,
    git_blob_oid: 'f'.repeat(40),
    content_digest: 'e'.repeat(64),
  };
  await writeFile(path.join(root, 'invalid-replacement.json'), `${JSON.stringify(invalid)}\n`);
  const before = await storeDigest(root);
  const result = runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'main', '--task', 'T1',
    '--evidence', 'invalid-replacement.json',
  ]);
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.detail.reason, 'evidence_unverified');
  assert.equal(failure.detail.plan_key, 'main');
  assert.equal(failure.detail.task_id, 'T1');
  assert.equal(await storeDigest(root), before);
});

test('evidence promoteは別taskの不達を残して順に修復できる', async (context) => {
  const root = await workspace(context);
  const first = await evidenceFixture(root, 'first-task', 'first\n');
  gitOutput(root, ['add', 'first-task.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'first task evidence',
  ]);
  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']));
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T1', '--evidence', first.descriptorRef,
  ]));

  const second = await evidenceFixture(root, 'second-task', 'second\n');
  gitOutput(root, ['add', 'second-task.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'second task evidence',
  ]);
  successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T2']));
  successJson(runCli(root, [
    'todo', 'done', '--plan', 'main', '--task', 'T2', '--evidence', second.descriptorRef,
  ]));

  const firstReplacement = await evidenceFixture(root, 'first-task', 'first replacement\n');
  gitOutput(root, ['add', 'first-task.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'first task replacement',
  ]);
  for (const descriptor of [first.descriptor, second.descriptor]) {
    const oid = descriptor.git_blob_oid;
    await unlink(path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  }

  const firstResult = successJson(runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'main', '--task', 'T1',
    '--evidence', firstReplacement.descriptorRef,
  ]));
  assert.equal(firstResult.status, 'done');
  const stillUnverified = runCli(root, ['todo', 'verify', '--plan', 'main', '--json']);
  assert.equal(stillUnverified.status, 1);
  const failure = JSON.parse(stillUnverified.stderr);
  assert.equal(failure.detail.reason, 'evidence_unverified');
  assert.equal(failure.detail.task_id, 'T2');

  const secondReplacement = await evidenceFixture(root, 'second-task', 'second replacement\n');
  gitOutput(root, ['add', 'second-task.txt']);
  gitOutput(root, [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'second task replacement',
  ]);
  const secondResult = successJson(runCli(root, [
    'todo', 'evidence', 'promote', '--plan', 'main', '--task', 'T2',
    '--evidence', secondReplacement.descriptorRef,
  ]));
  assert.equal(secondResult.status, 'done');
  successJson(runCli(root, ['todo', 'verify', '--plan', 'main', '--json']));
});

const snapshotCases = [
  ['missing', async (root) => unlink(path.join(root, snapshotRef))],
  ['stale_projection', async (root) => {
    const value = JSON.parse(await fileBytes(root, snapshotRef));
    value.plan_version = 'old';
    value.snapshot_digest = todoSelfDigest(value, 'snapshot_digest');
    await writeCanonical(root, snapshotRef, value);
  }],
  ['digest_mismatch', async (root) => {
    const value = JSON.parse(await fileBytes(root, snapshotRef));
    value.snapshot_digest = 'f'.repeat(64);
    await writeCanonical(root, snapshotRef, value);
  }],
  ['body_mismatch', async (root) => {
    const value = JSON.parse(await fileBytes(root, snapshotRef));
    value.tasks[0].status = 'in-progress';
    value.tasks[0].started_at = NOW;
    value.snapshot_digest = todoSelfDigest(value, 'snapshot_digest');
    await writeCanonical(root, snapshotRef, value);
  }],
  ['byte_corrupt', async (root) => {
    await writeFile(path.join(root, snapshotRef), Buffer.from([0xff, 0x0a]));
  }],
  ['previous_head', async (root) => {
    const oldSnapshot = await fileBytes(root, snapshotRef);
    await appendTodoEvent({
      repoRoot: root,
      writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
      planKey: 'main',
      now: NOW,
      event: {
        kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
        payload: { override_reason: null },
      },
    });
    await writeFile(path.join(root, snapshotRef), oldSnapshot);
  }],
];

for (const [name, mutate] of snapshotCases) {
  test(`crash matrix: journal健全×snapshot ${name} はverify read-only＋明示rebuild`, async (context) => {
    const root = await workspace(context);
    await mutate(root);
    const beforeVerify = await storeDigest(root);
    const verify = successJson(runCli(root, ['todo', 'verify']));
    assert.equal(verify.snapshot_stale, true);
    assert.equal(verify.verified_members[0].snapshot_stale, true);
    assert.equal(await storeDigest(root), beforeVerify, 'verify must not regenerate or modify snapshot');

    const journalBefore = await fileBytes(root, journalRef);
    const manifestBefore = await fileBytes(root, manifestRef);
    const rebuilt = successJson(runCli(root, ['todo', 'snapshot', '--rebuild', '--plan', 'main']));
    assertExactKeys(rebuilt, [
      'schema', 'project_id', 'plan_key', 'snapshot_ref', 'through_sequence',
      'journal_head_digest', 'snapshot_digest', 'result_digest',
    ]);
    assert.equal(rebuilt.schema, 'lattice.todo_snapshot_result.v1');
    assert.equal(rebuilt.snapshot_ref, snapshotRef);
    assert.equal(rebuilt.result_digest, todoSelfDigest(rebuilt, 'result_digest'));
    assert.deepEqual(await fileBytes(root, journalRef), journalBefore);
    assert.deepEqual(await fileBytes(root, manifestRef), manifestBefore);
    assert.equal(successJson(runCli(root, ['todo', 'verify'])).snapshot_stale, false);

    const rebuiltBytes = await fileBytes(root, snapshotRef);
    const second = successJson(runCli(root, ['todo', 'snapshot', '--rebuild', '--plan', 'main']));
    assert.deepEqual(await fileBytes(root, snapshotRef), rebuiltBytes);
    assert.deepEqual(second, rebuilt);
  });
}

test('crash matrix: current snapshotのrebuildもbytes/resultが決定的', async (context) => {
  const root = await workspace(context);
  const before = await fileBytes(root, snapshotRef);
  const first = successJson(runCli(root, ['todo', 'snapshot', '--rebuild', '--plan', 'main']));
  assert.deepEqual(await fileBytes(root, snapshotRef), before);
  const second = successJson(runCli(root, ['todo', 'snapshot', '--rebuild', '--plan', 'main']));
  assert.deepEqual(second, first);
  assert.deepEqual(await fileBytes(root, snapshotRef), before);
});

test('journal破損はSTORE_CORRUPT exit 1で全store bytes不変', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, journalRef), Buffer.from([0xff, 0x0a]));
  const before = await storeDigest(root);
  for (const args of [
    ['todo', 'verify'],
    ['todo', 'snapshot', '--rebuild', '--plan', 'main'],
  ]) {
    const result = runCli(root, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^\{.*\}\n$/u);
    const error = JSON.parse(result.stderr);
    assert.equal(error.schema, 'lattice.cli_error.v2');
    assert.equal(error.code, 'STORE_CORRUPT');
    assert.equal(error.detail.reason, 'journal_invalid_utf8');
    assert.equal(await storeDigest(root), before);
  }
});

test('todo namespaceの未知subcommandと不正引数は別codeのtyped exit 2', async (context) => {
  const root = await workspace(context);
  const malformed = [
    ['todo'],
    ['todo', 'unknown'],
    ['todo', 'status', 'extra'],
    ['todo', 'status', '--json', '--json'],
    ['todo', 'verify', '--plan'],
    ['todo', 'verify', '--json', '--plan', 'main'],
    ['todo', 'verify', '--plan', 'main', 'extra'],
    ['todo', 'verify', '--plan', 'main', '--plan', 'main'],
    ['todo', 'snapshot', '--plan', 'main', '--rebuild'],
    ['todo', 'snapshot', '--rebuild', '--plan', 'main', 'extra'],
    ['todo', 'migrate'],
    ['todo', 'migrate', '--input'],
    ['todo', 'migrate', 'extraction.json', '--input'],
    ['todo', 'migrate', '--input', 'extraction.json', 'extra'],
    ['todo', 'start', '--plan', 'main', '--task', 'T1', '--override-reason'],
    ['todo', 'block', '--plan', 'main', '--task', 'T1'],
    ['todo', 'unblock', '--plan', 'main', '--task', 'T1', 'extra'],
    ['todo', 'done', '--plan', 'main', '--task', 'T1'],
    ['todo', 'reopen', '--plan', 'main', '--task', 'T1', '--reason', 'why', '--override-reason'],
  ];
  for (const args of malformed) {
    const before = await storeDigest(root);
    const result = runCli(root, args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    const expectedCode = args[1] === 'unknown' ? 'UNKNOWN_SUBCOMMAND' : 'INVALID_ARGUMENTS';
    assert.equal(error.code, expectedCode, args.join(' '));
    assert.equal(typeof error.detail.next_action, 'string');
    assert.equal(await storeDigest(root), before);
  }
});

test('存在しないplanはtyped exit 1でstore bytes不変', async (context) => {
  const root = await workspace(context);
  for (const args of [
    ['todo', 'verify', '--plan', 'absent'],
    ['todo', 'snapshot', '--rebuild', '--plan', 'absent'],
  ]) {
    const before = await storeDigest(root);
    const result = runCli(root, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'STORE_INCONSISTENT');
    assert.equal(await storeDigest(root), before);
  }
});

test('todo verifyはdone evidenceをhard検証し、解決不能ならtyped exit 1', async (context) => {
  const root = await workspace(context);
  const blob = Buffer.from('completion evidence\n');
  const object = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root,
    input: blob,
    encoding: 'utf8',
  });
  assert.equal(object.status, 0);
  const oid = object.stdout.trim();
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({
    repoRoot: root, writer, planKey: 'main', now: NOW,
    event: {
      kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null },
    },
  });
  await appendTodoEvent({
    repoRoot: root, writer, planKey: 'main', now: NOW,
    event: {
      kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { evidence: {
        evidence_id: 'evidence-1', repo_id: 'self', path: 'evidence.txt', git_blob_oid: oid,
        content_digest: createHash('sha256').update(blob).digest('hex'),
        media_type: 'text/plain', anchor_digest: null,
      } },
    },
  });
  await unlink(path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  const before = await storeDigest(root);
  const result = runCli(root, ['todo', 'verify']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'STORE_INCONSISTENT');
  assert.equal(error.detail.reason, 'evidence_unverified');
  assert.equal(error.detail.plan_key, 'main');
  assert.equal(error.detail.task_id, 'T1');
  assert.equal(await storeDigest(root), before);
});

test('start --rebindはcarryされたin-progressへ現版のstart束縛を積み、pendingを拒否する', async (context) => {
  const root = await workspace(context);
  // fixtureの固定時刻NOWで開始を積む（CLI実時刻で積むとrevisionInputのnow=NOW読みが
  // future_clock_skewになる）
  await appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } },
  });
  const revision = await revisionInput(root);
  await writeCanonical(root, 'revision.json', revision);
  successJson(runCli(root, ['todo', 'revise', '--plan', 'main', '--input', 'revision.json']));
  const rebound = successJson(runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T1',
    '--rebind', '--reason', '改訂後の再束縛']));
  assert.equal(rebound.kind, 'start');
  assert.equal(rebound.status, 'in-progress');
  assert.equal(rebound.plan_version, revision.desired_plan.plan_version);
  const pending = runCli(root, ['todo', 'start', '--plan', 'main', '--task', 'T2',
    '--rebind', '--reason', 'pendingは拒否']);
  assert.notEqual(pending.status, 0);
  assert.equal(JSON.parse(pending.stderr).code, 'TASK_START_BINDING_UNSUPPORTED');
});
