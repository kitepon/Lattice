import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { digestTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  compileTodoExtraction,
  validateTodoExtraction,
} from '../src/todo-migration.mjs';
import { projectTodoChainV1 } from '../src/todo-chain.mjs';
import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { projectTodoStatus } from '../src/todo-status.mjs';
import {
  TodoStoreError,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'todo-migration');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

const task = (taskId) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null,
});

async function fixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURE_ROOT, name), 'utf8'));
}

function pinnedPlanCommit(root) {
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root,
    input: '# Imported plan\n- [x] A1 or U1\n- [ ] A2\n- [ ] P1\n- [ ] P2\n',
    encoding: 'utf8',
  });
  assert.equal(blob.status, 0, blob.stderr);
  const tree = spawnSync('git', ['mktree'], {
    cwd: root,
    input: `100644 blob ${blob.stdout.trim()}\tplan.md\n`,
    encoding: 'utf8',
  });
  assert.equal(tree.status, 0, tree.stderr);
  const commit = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: root,
    input: `tree ${tree.stdout.trim()}\nauthor Fixture <fixture@example.invalid> 1760000000 +0000\ncommitter Fixture <fixture@example.invalid> 1760000000 +0000\n\nfixture\n`,
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  return commit.stdout.trim();
}

async function bareWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-migration-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  return root;
}

async function workspace(context) {
  const root = await bareWorkspace(context);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
        predecessor_plan_digest: null, tasks: [task('T1')], hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  return root;
}

function currentExtraction(value) {
  const current = structuredClone(value);
  current.schema = 'lattice.todo_extraction.v3';
  for (const entry of current.tasks) {
    if (!Object.hasOwn(entry, 'start')) entry.start = null;
    entry.design_memo = 'NO_PLAN';
  }
  current.extraction_digest = todoSelfDigest(current, 'extraction_digest');
  return current;
}

function bindCommit(value, sourceCommit) {
  const bound = currentExtraction(value);
  for (const entry of bound.tasks) entry.source.source_commit = sourceCommit;
  bound.extraction_digest = todoSelfDigest(bound, 'extraction_digest');
  return bound;
}

async function writeInput(root, name, value) {
  const ref = `${name}.json`;
  await writeFile(path.join(root, ref), `${JSON.stringify(value)}\n`);
  return ref;
}

function runCli(root, inputRef, extraArgs = []) {
  const result = spawnSync(process.execPath, [CLI, 'todo', 'migrate', '--input', inputRef, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined);
  return result;
}

function chainExtraction({ projectId = 'chain-project', planKey = 'chain', taskCount = 6 } = {}) {
  const taskIds = Array.from({ length: taskCount }, (_, index) => `S${index + 1}`);
  const value = {
    schema: 'lattice.todo_extraction.v1', project_id: projectId, plan_key: planKey, plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: '2026-07-18T00:00:00.000Z',
    tasks: taskIds.map((taskId, index) => ({
      task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null,
      disposition: 'register_pending', completion: null,
      source: {
        origin_plan_ref: 'plan.md', origin_line: index + 2,
        source_commit: '1111111111111111111111111111111111111111',
        heading_path: ['Chain'], markdown_depth: 0, parent_task_id: null, checkbox_state: 'unchecked',
      },
      migration_context: {
        external_canonical_ref: null, carry_over_ref: null, h_required: false, condition: null,
        evidence_refs: [], notes: [],
      },
    })),
    hard_dependencies: taskIds.slice(1).map((taskId, index) => ({
      from: { project_id: projectId, plan_key: planKey, task_id: taskIds[index] },
      to: { project_id: projectId, plan_key: planKey, task_id: taskId },
    })),
    joins: [], extraction_digest: '',
  };
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  return value;
}

test('extraction v3/v4はschemaどおりlocal dependencyの任意reasonを受理する', () => {
  const value = currentExtraction(chainExtraction({ taskCount: 2 }));
  value.hard_dependencies[0].reason = 'protocol契約を先に固定する';
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');

  assert.equal(validateTodoExtraction(value), true);
  const v4 = structuredClone(value);
  v4.schema = 'lattice.todo_extraction.v4';
  v4.extraction_digest = todoSelfDigest(v4, 'extraction_digest');
  assert.equal(validateTodoExtraction(v4), true);
  assert.deepEqual(compileTodoExtraction(value).plan.hard_dependencies, [{
    from: { project_id: 'chain-project', plan_key: 'chain', task_id: 'S1' },
    to: { project_id: 'chain-project', plan_key: 'chain', task_id: 'S2' },
  }]);
});

test('local reasonはv2で拒否し、v4 cross-plan reasonは欠落と空文字を拒否する', () => {
  const v3 = currentExtraction(chainExtraction({ taskCount: 2 }));
  v3.hard_dependencies[0].reason = 'local reason';
  const v2 = structuredClone(v3);
  v2.schema = 'lattice.todo_extraction.v2';
  for (const entry of v2.tasks) delete entry.design_memo;
  v2.extraction_digest = todoSelfDigest(v2, 'extraction_digest');
  assert.equal(validateTodoExtraction(v2), false);

  const crossPlan = structuredClone(v3);
  crossPlan.schema = 'lattice.todo_extraction.v4';
  crossPlan.hard_dependencies[0].to = {
    project_id: 'other-project', plan_key: 'other-plan', task_id: 'T1',
  };
  delete crossPlan.hard_dependencies[0].reason;
  crossPlan.extraction_digest = todoSelfDigest(crossPlan, 'extraction_digest');
  assert.equal(validateTodoExtraction(crossPlan), false);
  crossPlan.hard_dependencies[0].reason = '';
  crossPlan.extraction_digest = todoSelfDigest(crossPlan, 'extraction_digest');
  assert.equal(validateTodoExtraction(crossPlan), false);
});

async function storeDigest(root) {
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const ref = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), ref);
      else entries.push([ref, await readFile(path.join(directory, entry.name))]);
    }
  }
  await visit(path.join(root, '.lattice', 'todo'));
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const hash = createHash('sha256');
  for (const [ref, bytes] of entries) hash.update(ref).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

test('schema documentと正常/時刻unknown/曖昧fixtureはv1 exact contractを表す', async () => {
  const schema = JSON.parse(await readFile(
    path.join(REPO_ROOT, 'docs', 'schemas', 'lattice.todo_extraction.v1.schema.json'),
    'utf8',
  ));
  assert.equal(schema.title, 'lattice.todo_extraction.v1');
  assert.equal(schema.additionalProperties, false);
  for (const name of ['valid.json', 'missing-time-unknown.json', 'ambiguous.json']) {
    const value = await fixture(name);
    assert.equal(validateTodoExtraction(value), true, name);
    assert.equal(value.extraction_digest, todoSelfDigest(value, 'extraction_digest'));
  }
  const missing = await fixture('missing-time-unknown.json');
  assert.equal(missing.tasks[0].completion.completed_at, 'unknown_requires_evidence');
});

test('extraction v1は不変のままv2だけが輸入in-progressと開始時刻unknownを表す', async () => {
  const schema = JSON.parse(await readFile(
    path.join(REPO_ROOT, 'docs', 'schemas', 'lattice.todo_extraction.v2.schema.json'),
    'utf8',
  ));
  assert.equal(schema.title, 'lattice.todo_extraction.v2');
  assert.equal(schema.additionalProperties, false);
  const value = await fixture('in-progress.json');
  assert.equal(validateTodoExtraction(value), true);
  assert.equal(value.extraction_digest, todoSelfDigest(value, 'extraction_digest'));
  assert.deepEqual(value.tasks.map(({ start }) => start.started_at), [
    '2026-07-17T12:00:00.000Z', 'unknown_requires_evidence',
  ]);
  const v1Shape = structuredClone(value);
  v1Shape.schema = 'lattice.todo_extraction.v1';
  v1Shape.extraction_digest = todoSelfDigest(v1Shape, 'extraction_digest');
  assert.equal(validateTodoExtraction(v1Shape), false);
});

test('R7難所18例はsource階層と移行context、明示edge/joinを失わずschemaへ載る', async () => {
  const value = await fixture('r7-hard-cases.json');
  assert.equal(validateTodoExtraction(value), true);
  assert.equal(value.tasks.length, 18);
  assert.equal(new Set(value.tasks.map((entry) => entry.source.origin_plan_ref)).size, 6);
  assert.equal(value.tasks.some((entry) => entry.source.checkbox_state === 'absent'), true);
  assert.equal(value.tasks.some((entry) => entry.source.checkbox_state === 'ambiguous'), true);
  assert.equal(value.tasks.some((entry) => entry.source.parent_task_id !== null), true);
  assert.equal(value.tasks.some((entry) => entry.migration_context.carry_over_ref !== null), true);
  assert.equal(value.tasks.some((entry) => entry.migration_context.h_required), true);
  assert.equal(value.tasks.some((entry) => entry.migration_context.condition !== null), true);
  assert.equal(value.tasks.some((entry) => entry.migration_context.external_canonical_ref !== null), true);
  assert.equal(value.tasks.some((entry) => entry.disposition === 'exclude_superseded'), true);
  assert.equal(value.tasks.some((entry) => entry.disposition === 'exclude_compatibility_record'), true);
  assert.equal(value.hard_dependencies.length, 1);
  assert.equal(value.joins.length, 1);

  const compatibilityOnly = {
    ...value,
    plan_key: 'compatibility-only',
    tasks: [value.tasks.find(({ task_id }) => task_id === 'R7-13')],
    hard_dependencies: [],
    joins: [],
    extraction_digest: '',
  };
  compatibilityOnly.extraction_digest = todoSelfDigest(compatibilityOnly, 'extraction_digest');
  assert.equal(validateTodoExtraction(compatibilityOnly), true);
  assert.throws(() => compileTodoExtraction(compatibilityOnly, '/repo'), (error) => error instanceof TodoStoreError
    && error.code === 'MIGRATION_EMPTY' && error.detail.reason === 'no_registered_tasks');
});

test('登録taskから除外taskへのparent・dependency・join参照は位置付きで拒否する', async () => {
  const base = await fixture('r7-hard-cases.json');
  const registered = base.tasks.find(({ disposition }) => disposition.startsWith('register_'));
  const excluded = base.tasks.find(({ disposition }) => disposition.startsWith('exclude_'));
  const ref = (taskId) => ({
    project_id: base.project_id, plan_key: base.plan_key, task_id: taskId,
  });
  const cases = [
    {
      expectedReason: 'registered_parent_task_id_unresolved',
      expectedPath: `/tasks/${base.tasks.indexOf(registered)}/source/parent_task_id`,
      mutate: (value) => { value.tasks.find(({ task_id }) => task_id === registered.task_id)
        .source.parent_task_id = excluded.task_id; },
    },
    {
      expectedReason: 'local_ref_unresolved', expectedPath: '/hard_dependencies/0/to',
      mutate: (value) => { value.hard_dependencies = [{
        from: ref(registered.task_id), to: ref(excluded.task_id),
      }]; value.joins = []; },
    },
    {
      expectedReason: 'local_ref_unresolved', expectedPath: '/joins/0/after/0',
      mutate: (value) => { value.hard_dependencies = []; value.joins = [{
        id: 'excluded-join', after: [ref(excluded.task_id)], before: ref(registered.task_id),
      }]; },
    },
  ];
  for (const { mutate, expectedReason, expectedPath } of cases) {
    const value = structuredClone(base);
    mutate(value);
    value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
    assert.equal(validateTodoExtraction(value), false);
    assert.throws(() => compileTodoExtraction(value, '/repo'), (error) => error instanceof TodoStoreError
      && error.code === 'INVALID_TODO_EXTRACTION'
      && error.detail.violation_reason === expectedReason
      && error.detail.violation_path === expectedPath);
  }
});

test('schema違反、task duplicate、done_mode矛盾fixtureはfail closed', async () => {
  for (const name of [
    'schema-violation.json', 'duplicate-task.json', 'done-mode-contradiction.json',
    'in-progress-done-contradiction.json', 'in-progress-blocked-contradiction.json',
  ]) {
    assert.equal(validateTodoExtraction(await fixture(name)), false, name);
  }
});

test('unknown_requires_evidenceは全体拒否し、裁定後JSONを再compileできる', async () => {
  const value = await fixture('ambiguous.json');
  assert.throws(() => compileTodoExtraction(value, '/repo'), (error) => error instanceof TodoStoreError
    && error.code === 'MIGRATION_UNRESOLVED'
    && error.detail.reason === 'unknown_requires_evidence'
    && error.detail.task_ids[0] === 'Q1');

  value.tasks[0].disposition = 'register_pending';
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  const request = compileTodoExtraction(value, '/repo');
  assert.equal(request.plan.schema, 'lattice.todo_plan.v2');
  assert.deepEqual(request.plan.tasks.map(({ task_id }) => task_id), ['Q1', 'Q2']);
  assert.deepEqual(request.plan.tasks.map(({ narrative_anchor }) => narrative_anchor), [null, null]);
  assert.deepEqual(request.narrativeAnchorSources.map(({ task_id }) => task_id), ['Q1', 'Q2']);
  assert.deepEqual(request.completedTasks, []);
  assert.deepEqual(request.inProgressTasks, []);
});

test('todo migrateはstrict/unknown開始時刻を輸入しstatus active_setとganttへactive投影する', async (context) => {
  const root = await workspace(context);
  const input = bindCommit(await fixture('in-progress.json'), pinnedPlanCommit(root));
  const execution = runCli(root, await writeInput(root, 'in-progress', input));
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, '');
  const result = JSON.parse(execution.stdout);
  assert.equal(result.imported_task_count, 2);
  assert.equal(result.completed_task_count, 0);

  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === 'active-import');
  assert.deepEqual(member.tasks.map(({ task_id, status, started_at, imported }) => (
    [task_id, status, started_at, imported]
  )), [
    ['P1', 'in-progress', '2026-07-17T12:00:00.000Z', true],
    ['P2', 'in-progress', null, true],
  ]);
  const starts = member.journal.events.filter(({ kind }) => kind === 'start');
  assert.deepEqual(starts.map(({ payload }) => payload.started_at), [
    '2026-07-17T12:00:00.000Z', 'unknown_requires_evidence',
  ]);
  assert.equal(starts.every(({ payload }) => payload.start_mode === 'historical_import'
    && payload.status === 'in-progress' && payload.imported === true), true);

  const status = projectTodoStatus(store, { parallelCandidates: [], planNotes: [] });
  assert.deepEqual(status.active_set, [
    {
      plan_key: 'active-import', task_id: 'P1', label: 'Strict historical start', unmet_dependencies: [],
    },
    {
      plan_key: 'active-import', task_id: 'P2', label: 'Unknown historical start',
      unmet_dependencies: [{ plan_key: 'active-import', task_id: 'P1' }],
    },
  ]);
  const topology = {
    nodes: store.members.flatMap(({ plan }) => plan.tasks.map(({ task_id: taskId }) => ({
      project_id: plan.project_id, plan_key: plan.plan_key, task_id: taskId,
    }))),
    hard_edges: store.members.flatMap(({ plan }) => plan.hard_dependencies),
    joins: store.members.flatMap(({ plan }) => plan.joins),
  };
  const layout = layoutTodoGantt(store);
  assert.deepEqual(layout.nodes.filter(({ ref }) => ref.plan_key === 'active-import')
    .map(({ ref, status: taskStatus, visibility }) => [ref.task_id, taskStatus, visibility.active]), [
    ['P1', 'in-progress', true], ['P2', 'in-progress', true],
  ]);
});

test('todo migrateは未初期化repoへ抽出project_idのstoreとimport planを一括登録する', async (context) => {
  const root = await bareWorkspace(context);
  const input = bindCommit(await fixture('valid.json'), pinnedPlanCommit(root));
  const execution = runCli(root, await writeInput(root, 'bootstrap-success', input));
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, '');
  const result = JSON.parse(execution.stdout);
  assert.equal(result.project_id, input.project_id);
  assert.equal(result.plan_key, input.plan_key);
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.project_id, input.project_id);
  assert.deepEqual(store.manifest.repositories, [{ repo_id: 'self', path: '.' }]);
  assert.deepEqual(store.members.map(({ descriptor }) => descriptor.plan_key), ['archive']);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.lattice-todo-bootstrap-')), []);
});

test('未初期化repoの登録失敗は初期化directoryもbootstrap stagingも残さない', async (context) => {
  const root = await bareWorkspace(context);
  const execution = runCli(root, await writeInput(
    root, 'bootstrap-failure', currentExtraction(await fixture('valid.json')),
  ));
  assert.equal(execution.status, 1);
  assert.equal(execution.stdout, '');
  const error = JSON.parse(execution.stderr);
  assert.equal(error.code, 'STORE_INCONSISTENT');
  assert.equal(error.detail.reason, 'import_source_unverified');
  await assert.rejects(lstat(path.join(root, '.lattice')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.lattice-todo-bootstrap-')), []);
});

test('既存store経路のtodo migrateは検証済みJSONを一度だけ追加しexact resultを返す', async (context) => {
  const root = await workspace(context);
  const extracted = await fixture('valid.json');
  for (const task of extracted.tasks) task.narrative_ref = 'plan.md';
  const input = bindCommit(extracted, pinnedPlanCommit(root));
  const inputRef = await writeInput(root, 'valid', input);
  const first = runCli(root, inputRef);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, /^\{.*\}\n$/u);
  const result = JSON.parse(first.stdout);
  assertExactKeys(result, [
    'schema', 'project_id', 'plan_key', 'plan_version', 'extraction_digest',
    'imported_task_count', 'defaulted_pending_task_ids', 'completed_task_count', 'plan_ref', 'journal_ref', 'snapshot_ref',
    'topology_digest', 'journal_head_digest', 'dispatch_shape', 'terminal_audit_required',
    'phase_guidance', 'coordination_guidance',
    'companion',
    'result_digest',
  ]);
  assert.equal(result.schema, 'lattice.todo_migrate_result.v4');
  assert.equal(result.companion, null);
  // ob03: 起票直後は調整方式が未宣言。選ぶ機会をここで案内する。
  assert.deepEqual(result.coordination_guidance, {
    mode: null,
    modes: ['witness', 'conversation', 'enforced'],
    next_action: `lattice todo independence mode --plan ${result.plan_key} --set <witness|conversation|enforced> --reason <text>`,
  });
  assert.equal(result.imported_task_count, 2);
  assert.equal(result.completed_task_count, 1);
  assert.deepEqual(result.dispatch_shape, {
    task_count: 2, critical_path_length: 2, max_frontier_width: 1, serialization_ratio: '1.0000',
  });
  // ADR 0147裁定3: migrateで作るplanは常にphase無しなので終端監査が要ることを結果へ明示する。
  assert.equal(result.terminal_audit_required, true);
  assert.deepEqual(result.phase_guidance, {
    capability: 'acquire_phase', preserves_completed_state: true,
    schema_command: 'lattice todo revise-phase --schema --json',
    required_state_policy: 'acquire_phase',
    next_action: 'lattice todo revise-phase --plan archive --input <phase-revision.json>',
  });
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const archive = store.members.find(({ descriptor }) => descriptor.plan_key === 'archive');
  assert.equal(archive.plan.schema, 'lattice.todo_plan.v6');
  assert.deepEqual(archive.plan.tasks.map(({ task_id, narrative_anchor: anchor }) => [task_id, anchor]), [
    ['A1', {
      origin_plan_ref: 'plan.md', origin_line: 2, source_commit: input.tasks[0].source.source_commit,
      source_line_digest: createHash('sha256').update('- [x] A1 or U1').digest('hex'),
    }],
    ['A2', {
      origin_plan_ref: 'plan.md', origin_line: 3, source_commit: input.tasks[1].source.source_commit,
      source_line_digest: createHash('sha256').update('- [ ] A2').digest('hex'),
    }],
  ]);
  assert.equal(archive.plan.topology_digest, digestTodoArtifact({
    project_id: archive.plan.project_id, plan_key: archive.plan.plan_key,
    plan_version: archive.plan.plan_version, tasks: archive.plan.tasks,
    hard_dependencies: archive.plan.hard_dependencies, joins: archive.plan.joins,
  }));
  assert.deepEqual(archive.tasks.map(({ task_id, status }) => [task_id, status]), [
    ['A1', 'done'], ['A2', 'pending'],
  ]);
  assert.equal(archive.journal.events[0].payload.historical_import, true);

  const beforeDuplicate = await storeDigest(root);
  const duplicate = runCli(root, inputRef);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, '');
  const error = JSON.parse(duplicate.stderr);
  assert.equal(error.code, 'STORE_WRITE_CONFLICT');
  assert.equal(error.detail.reason, 'plan_key_already_imported');
  assert.equal(await storeDigest(root), beforeDuplicate);
});

test('critical pathがほぼ一直線のtodo migrateはdispatch_shapeを載せて通り、'
  + '--serialization-reviewedは不要', async (context) => {
  const root = await workspace(context);
  const input = bindCommit(
    chainExtraction({ projectId: 'project-1', planKey: 'chain', taskCount: 6 }),
    pinnedPlanCommit(root),
  );
  const inputRef = await writeInput(root, 'chain', input);
  const accepted = runCli(root, inputRef);
  assert.equal(accepted.status, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.deepEqual(result.dispatch_shape, {
    task_count: 6, critical_path_length: 6, max_frontier_width: 1, serialization_ratio: '1.0000',
  });
});

test('task数が閾値未満の一直線todo migrateはdispatch_shape gateを素通りする', async (context) => {
  const root = await workspace(context);
  const input = bindCommit(
    chainExtraction({ projectId: 'project-1', planKey: 'small-chain', taskCount: 3 }),
    pinnedPlanCommit(root),
  );
  const result = runCli(root, await writeInput(root, 'small-chain', input));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).dispatch_shape, {
    task_count: 3, critical_path_length: 3, max_frontier_width: 1, serialization_ratio: '1.0000',
  });
});

test('履歴時刻欠落は現在時刻で埋めずunknownのhistorical doneとして登録する', async (context) => {
  const root = await workspace(context);
  const input = bindCommit(await fixture('missing-time-unknown.json'), pinnedPlanCommit(root));
  const result = runCli(root, await writeInput(root, 'unknown-time', input));
  assert.equal(result.status, 0, result.stderr);
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === 'unknown-time');
  assert.equal(member.plan.schema, 'lattice.todo_plan.v6');
  assert.equal(member.plan.tasks[0].narrative_anchor, null);
  const done = member.journal.events.find(({ kind }) => kind === 'done');
  assert.equal(done.payload.done_mode, 'historical_import');
  assert.equal(done.payload.completed_at, 'unknown_requires_evidence');
  assert.equal(member.tasks[0].done_at, null);
});

test('anchor sourceを取得できないpending taskは推定せずnull anchorで登録する', async (context) => {
  const root = await workspace(context);
  const input = currentExtraction(await fixture('valid.json'));
  input.plan_key = 'anchor-missing';
  input.tasks = [input.tasks.find(({ task_id }) => task_id === 'A2')];
  input.tasks[0].narrative_ref = 'plan.md';
  input.hard_dependencies = [];
  input.extraction_digest = todoSelfDigest(input, 'extraction_digest');
  const result = runCli(root, await writeInput(root, 'anchor-missing', input));
  assert.equal(result.status, 0, result.stderr);
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === 'anchor-missing');
  assert.equal(member.plan.schema, 'lattice.todo_plan.v6');
  assert.equal(member.plan.tasks[0].narrative_anchor, null);
});

test('曖昧・schema違反・duplicate・done_mode矛盾はtyped exit 1でstore bytes不変', async (context) => {
  const root = await workspace(context);
  for (const [name, code] of [
    ['schema-violation.json', 'INVALID_TODO_EXTRACTION'],
    ['duplicate-task.json', 'INVALID_TODO_EXTRACTION'],
    ['done-mode-contradiction.json', 'INVALID_TODO_EXTRACTION'],
    ['in-progress-done-contradiction.json', 'INVALID_TODO_EXTRACTION'],
    ['in-progress-blocked-contradiction.json', 'INVALID_TODO_EXTRACTION'],
  ]) {
    const inputRef = await writeInput(
      root, name.replace('.json', ''), currentExtraction(await fixture(name)),
    );
    const before = await storeDigest(root);
    const result = runCli(root, inputRef);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^\{.*\}\n$/u);
    const error = JSON.parse(result.stderr);
    assert.equal(error.schema, 'lattice.cli_error.v2');
    assert.equal(error.code, code);
    assert.equal(await storeDigest(root), before, name);
  }
});

test('JSON objectのduplicate keyもparse後上書きへ丸めず拒否する', async (context) => {
  const root = await workspace(context);
  const inputRef = 'duplicate-key.json';
  await writeFile(path.join(root, inputRef), await readFile(path.join(FIXTURE_ROOT, inputRef)));
  const before = await storeDigest(root);
  const result = runCli(root, inputRef);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'INVALID_JSON');
  assert.equal(error.detail.reason, 'duplicate_key');
  assert.equal(await storeDigest(root), before);
});
