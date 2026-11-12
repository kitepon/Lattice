import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  TODO_WITNESS_SET_SCHEMA,
  validateTodoIndependenceProjection,
} from '../src/todo-independence-contracts.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
  readTodoWitnessSet,
  writeTodoIndependenceArtifact,
  writeTodoWitnessSet,
} from '../src/todo-store.mjs';
import { ganttLiveHeadDigest, renderTodoGanttForProject } from '../src/todo-cli.mjs';
import { TODO_INDEPENDENCE_SCHEMA } from '../src/todo-independence-contracts.mjs';
import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';

// ADR 0127 Decision 5。読み出しはsensorを引かず、記録済みartifactとHEAD照合だけで閉じる。
// dirty worktreeでのcompileは拒否し、未commitの観測を検証済み証拠にしない。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-07-26T00:00:00.000Z';

const task = (taskId) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null,
});

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim();
}

const planFor = (planKey, tasks) => ({
  plan: {
    schema: 'lattice.todo_plan.v1',
    project_id: 'project-1',
    plan_key: planKey,
    plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: tasks.map(task),
    hard_dependencies: [],
    joins: [],
  },
  genesis: { actor: ACTOR, recorded_at: NOW },
});

async function workspace(context, { tasks = ['T1', 'T2'], extraPlans = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-independence-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'fixture']);
  await writeFile(path.join(root, 'README.md'), 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [planFor('main', tasks), ...extraPlans],
    now: NOW,
  });
  return root;
}

function runCli(root, args) {
  const env = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, 'todo', ...args], { cwd: root, encoding: 'utf8', env });
}

const parse = (text) => JSON.parse(text.trim().split('\n').at(-1));

test('記録が無い時はcoverage missingでready全件を未検査として返す', async (context) => {
  const root = await workspace(context);
  const result = runCli(root, ['independence', '--json']);

  assert.equal(result.status, 0);
  const projection = parse(result.stdout);
  assert.equal(validateTodoIndependenceProjection(projection), true);
  assert.equal(projection.coverage, 'missing');
  assert.equal(projection.plan_key, 'main');
  assert.deepEqual(projection.frontier.parallel_groups, []);
  assert.deepEqual(projection.frontier.unknown.map(({ task_id: id }) => id), ['T1', 'T2']);
});

test('既知の旧artifactはsupersededとしてindependence・session-context・Ganttで読める',
  async (context) => {
    const root = await workspace(context);
    const legacyRef = path.join(root, '.lattice/todo/plans/main/v1/independence.json');
    const legacyArtifact = {
      schema: 'lattice.todo_independence.v2',
      project_id: 'project-1',
      plan_key: 'main',
      plan_version: 'v1',
      topology_digest: parse(runCli(root, ['verify', '--json']).stdout)
        .verified_members[0].topology_digest,
      base_sha: git(root, ['rev-parse', 'HEAD']),
      witness_set_digest: 'd'.repeat(64),
      compiled_at: NOW,
      task_ids: ['T1', 'T2'],
      task_boundaries: [
        { task_id: 'T1', paths: ['src/t1.mjs'] },
        { task_id: 'T2', paths: ['src/t2.mjs'] },
      ],
      conflicts: [],
      precedences: [],
      unknowns: [],
      wave_plan: { waves: [{ task_ids: ['T1', 'T2'] }], minimum_feasible_waves: 1 },
      outcome: 'compiled',
      result_digest: '',
    };
    legacyArtifact.result_digest = todoSelfDigest(legacyArtifact, 'result_digest');
    await writeFile(legacyRef, `${canonicalizeTodoArtifact(legacyArtifact)}\n`);

    const independenceResult = runCli(root, ['independence', '--plan', 'main', '--json']);
    assert.equal(independenceResult.status, 0, independenceResult.stderr);
    const projection = parse(independenceResult.stdout);
    assert.equal(projection.coverage, 'superseded');
    assert.equal(projection.compiled_base_sha, null);
    assert.equal(projection.guidance.code, 'independence_contract_superseded');
    assert.equal(projection.guidance.next_action,
      `lattice todo independence compile --plan ${projection.plan_key} --input <file>`);
    assert.deepEqual(projection.frontier.unknown, [
      {
        task_id: 'T1',
        unknowns: [{ kind: 'record_superseded', ref: 'lattice.todo_independence.v2' }],
      },
      {
        task_id: 'T2',
        unknowns: [{ kind: 'record_superseded', ref: 'lattice.todo_independence.v2' }],
      },
    ]);

    const actorEnv = {
      LATTICE_TODO_ACTOR_HOST: 'host-1',
      LATTICE_TODO_ACTOR_SESSION: 'session-1',
      LATTICE_TODO_ACTOR_AGENT: 'agent-1', LATTICE_DASHBOARD_AUTOSTART: '0',
    };
    const started = spawnSync(process.execPath, [
      CLI, 'todo', 'start', '--plan', 'main', '--task', 'T1', '--parallel-frontier',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...actorEnv, LATTICE_DASHBOARD_AUTOSTART: '0' },
    });
    // u03 B1-B6: 失効した記録は助言に載るだけで、startは拒否しない。
    assert.equal(started.status, 0, started.stderr);
    const startResult = parse(started.stdout);
    assert.equal(startResult.kind, 'start');
    assert.equal(startResult.advisory.guidance.code, 'independence_contract_superseded');
    assert.deepEqual(startResult.advisory.guidance.next_action, projection.guidance.next_action);

    const session = spawnSync(process.execPath, [CLI, 'session-context', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
    });
    assert.equal(session.status, 0, session.stderr);
    const summary = parse(session.stdout).independence[0];
    assert.equal(summary.coverage, 'superseded');
    assert.equal(summary.guidance.code, 'independence_contract_superseded');
    assert.deepEqual(summary.guidance, projection.guidance);
    assert.equal(summary.unreadable_reason, null);

    const gantt = await renderTodoGanttForProject({ repoRoot: root });
    assert.match(gantt.rendered.html, /class="todo-gantt"/u);
  });

test('Ganttは読めないindependence・seam artifactをplan単位で未検査へ縮退する',
  async (context) => {
    const root = await workspace(context, {
      tasks: ['T1'],
      extraPlans: [planFor('other', ['U1'])],
    });
    const planDir = path.join(root, '.lattice/todo/plans/other/v1');
    const independenceRef = path.join(planDir, 'independence.json');
    const seamRef = path.join(planDir, 'seam-proposal.json');

    await writeFile(independenceRef, '{"schema":"lattice.todo_independence.future"}\n');
    const unreadableIndependence = await renderTodoGanttForProject({ repoRoot: root });
    assert.match(unreadableIndependence.rendered.html, /T1/u);
    assert.match(unreadableIndependence.rendered.html, /U1/u);
    assert.match(unreadableIndependence.rendered.html, /並列可否:<\/strong> 未検査です/u);

    await rm(independenceRef);
    await writeFile(seamRef, '{"schema":"lattice.todo_seam_proposal.future"}\n');
    const unreadableSeam = await renderTodoGanttForProject({ repoRoot: root });
    assert.match(unreadableSeam.rendered.html, /T1/u);
    assert.match(unreadableSeam.rendered.html, /U1/u);
    assert.match(unreadableSeam.rendered.html,
      /参照元のplanまたは並列可否記録が更新され/u);
  });

test('記録があればHEAD一致でverified並列グループを返す（sensorは引かない）', async (context) => {
  const root = await workspace(context);
  const head = git(root, ['rev-parse', 'HEAD']);
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: parse(runCli(root, ['verify', '--json']).stdout)
      .verified_members[0].topology_digest,
    base_sha: head,
    witness_set_digest: 'd'.repeat(64),
    compiled_at: NOW,
    task_ids: ['T1', 'T2'],
    task_boundaries: [
      { task_id: 'T1', paths: ['src/t1.mjs'] },
      { task_id: 'T2', paths: ['src/t2.mjs'] },
    ],
    conflict_resources: [],
    conflicts: [],
    precedences: [],
    unknowns: [],
    wave_plan: { waves: [{ task_ids: ['T1', 'T2'] }], minimum_feasible_waves: 1 },
    outcome: 'compiled',
    result_digest: '',
  };
  // v4: scope_expanded は task_ids と1:1でなければ validator が落とす。
  // fixture の既定は「膨張ゼロ・比較相手なし」で、履歴を測る test は明示的に上書きする
  artifact.scope_expanded = artifact.scope_expanded ?? (artifact.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact, now: NOW });

  const projection = parse(runCli(root, ['independence', '--json']).stdout);
  assert.equal(projection.coverage, 'verified');
  assert.equal(projection.compiled_base_sha, head);
  assert.deepEqual(projection.frontier.parallel_groups, [{ task_ids: ['T1', 'T2'] }]);
  assert.deepEqual(projection.frontier.unknown, []);

  // 宣言境界に触れないcommitでHEADが進んでも、観測は変わらないのでverified独立は維持する。
  // coverageはsha水準の事実としてstaleを述べるが、taskは未検査へ落とさない。
  await writeFile(path.join(root, 'NEXT.md'), 'next\n');
  git(root, ['add', 'NEXT.md']);
  git(root, ['commit', '--quiet', '-m', 'advance head outside declared boundaries']);

  const untouched = parse(runCli(root, ['independence', '--json']).stdout);
  assert.equal(untouched.coverage, 'stale');
  assert.equal(untouched.drift.base_reachable, true);
  assert.equal(untouched.drift.changed_path_count, 1);
  assert.deepEqual(untouched.drift.intersecting_task_ids, []);
  assert.deepEqual(untouched.frontier.parallel_groups, [{ task_ids: ['T1', 'T2'] }]);
  assert.deepEqual(untouched.frontier.unknown, []);

  // 宣言境界に触れたcommitは、そのtaskだけを未検査へ落とす。
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 't1.mjs'), 'export const t1 = 1;\n');
  git(root, ['add', 'src/t1.mjs']);
  git(root, ['commit', '--quiet', '-m', 'touch declared boundary of T1']);

  const touched = parse(runCli(root, ['independence', '--json']).stdout);
  assert.equal(touched.coverage, 'stale');
  assert.deepEqual(touched.drift.intersecting_task_ids, ['T1']);
  assert.deepEqual(touched.frontier.unknown.map(({ task_id: id }) => id), ['T1']);
  assert.equal(touched.frontier.unknown[0].unknowns[0].kind, 'record_stale');
  // 触れていないT2は検証済みのまま残る。
  assert.deepEqual(touched.frontier.parallel_groups, [{ task_ids: ['T2'] }]);
});

test('進行中ToDoとの競合をconflicts_with_activeとして返す', async (context) => {
  const root = await workspace(context, { tasks: ['T1', 'T2'] });
  const head = git(root, ['rev-parse', 'HEAD']);
  const topologyDigest = parse(runCli(root, ['verify', '--json']).stdout)
    .verified_members[0].topology_digest;
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: topologyDigest,
    base_sha: head,
    witness_set_digest: 'd'.repeat(64),
    compiled_at: NOW,
    task_ids: ['T1', 'T2'],
    task_boundaries: [
      { task_id: 'T1', paths: ['src/shared.mjs'] },
      { task_id: 'T2', paths: ['src/shared.mjs'] },
    ],
    conflict_resources: [{
      resource_id: 'own-path-shared', kind: 'path', target: 'src/shared.mjs',
    }],
    conflicts: [{ task_ids: ['T1', 'T2'], resource_id: 'own-path-shared' }],
    precedences: [],
    unknowns: [],
    wave_plan: {
      waves: [{ task_ids: ['T1'] }, { task_ids: ['T2'] }],
      minimum_feasible_waves: 2,
    },
    outcome: 'compiled',
    result_digest: '',
  };
  // v4: scope_expanded は task_ids と1:1でなければ validator が落とす。
  // fixture の既定は「膨張ゼロ・比較相手なし」で、履歴を測る test は明示的に上書きする
  artifact.scope_expanded = artifact.scope_expanded ?? (artifact.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact, now: NOW });

  // T1を着手すると、readyはT2だけになりペアの片端がactiveになる。
  const env = {
    LATTICE_TODO_ACTOR_HOST: 'host-1',
    LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1', LATTICE_DASHBOARD_AUTOSTART: '0',
  };
  const started = spawnSync(process.execPath, [
    CLI, 'todo', 'start', '--plan', 'main', '--task', 'T1', '--override-reason', 'fixture', '--serial-confirmed',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env, NO_COLOR: '1' } });
  assert.equal(started.status, 0, started.stderr);

  const projection = parse(runCli(root, ['independence', '--json']).stdout);
  assert.deepEqual(projection.active_task_ids, ['T1']);
  assert.deepEqual(projection.uncovered_active_task_ids, []);
  // v1はここで黙って捨てていた。着手時に最も危ない組み合わせを落とさない。
  assert.deepEqual(projection.frontier.conflicts_with_active, [{
    ready_task_id: 'T2',
    active_task_id: 'T1',
    type: 'conflict',
    detail: 'own-path-shared',
    kind: 'path',
    severability: 'code_seam',
  }]);
  assert.deepEqual(projection.frontier.serialize_pairs, []);
});

test('readyが無くても記録があればplan指定でverifiedを返す', async (context) => {
  const root = await workspace(context);
  const head = git(root, ['rev-parse', 'HEAD']);
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: parse(runCli(root, ['verify', '--json']).stdout)
      .verified_members[0].topology_digest,
    base_sha: head,
    witness_set_digest: 'd'.repeat(64),
    compiled_at: NOW,
    task_ids: ['T1'],
    task_boundaries: [{ task_id: 'T1', paths: ['src/t1.mjs'] }],
    conflict_resources: [],
    conflicts: [],
    precedences: [],
    unknowns: [],
    wave_plan: { waves: [{ task_ids: ['T1'] }], minimum_feasible_waves: 1 },
    outcome: 'compiled',
    result_digest: '',
  };
  // v4: scope_expanded は task_ids と1:1でなければ validator が落とす。
  // fixture の既定は「膨張ゼロ・比較相手なし」で、履歴を測る test は明示的に上書きする
  artifact.scope_expanded = artifact.scope_expanded ?? (artifact.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact, now: NOW });

  // 単一planならready集合が空でもそのplanが候補になる。記録があるのに
  // coverage missingと報告してしまう経路を残さない。
  const projection = parse(runCli(root, ['independence', '--json']).stdout);
  assert.equal(projection.plan_key, 'main');
  assert.equal(projection.coverage, 'verified');
});

test('planを絞らない呼び出しで候補が複数なら曖昧として止まる', async (context) => {
  const root = await workspace(context, { extraPlans: [planFor('second', ['S1'])] });

  const result = runCli(root, ['independence', '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = parse(result.stderr);
  assert.equal(error.code, 'INDEPENDENCE_PLAN_AMBIGUOUS');
  assert.deepEqual(error.detail.plan_keys, ['main', 'second']);
  assert.equal(error.detail.next_action, 'rerun_with_plan_flag');

  // planを絞れば答えられる。
  const projection = parse(runCli(root, ['independence', '--plan', 'second', '--json']).stdout);
  assert.equal(projection.plan_key, 'second');
  assert.equal(projection.coverage, 'missing');
});

test('着手時のadvisoryが進行中との競合と切断可能性を返す', async (context) => {
  const root = await workspace(context, { tasks: ['T1', 'T2'] });
  const head = git(root, ['rev-parse', 'HEAD']);
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: parse(runCli(root, ['verify', '--json']).stdout)
      .verified_members[0].topology_digest,
    base_sha: head,
    witness_set_digest: 'd'.repeat(64),
    compiled_at: NOW,
    task_ids: ['T1', 'T2'],
    task_boundaries: [
      { task_id: 'T1', paths: ['src/shared.mjs'] },
      { task_id: 'T2', paths: ['src/shared.mjs'] },
    ],
    conflict_resources: [{
      resource_id: 'own-path-shared', kind: 'path', target: 'src/shared.mjs',
    }],
    conflicts: [{ task_ids: ['T1', 'T2'], resource_id: 'own-path-shared' }],
    precedences: [],
    unknowns: [],
    wave_plan: {
      waves: [{ task_ids: ['T1'] }, { task_ids: ['T2'] }],
      minimum_feasible_waves: 2,
    },
    outcome: 'compiled',
    result_digest: '',
  };
  artifact.scope_expanded = [
    {
      task_id: 'T1', compared_witness_digest: 'e'.repeat(64), first_seen_path_count: 1,
      path_count: 3, added_paths: ['src/extra.mjs'], removed_paths: [],
      growth_events: 2, gate_shape: true,
    },
    {
      task_id: 'T2', compared_witness_digest: 'e'.repeat(64), first_seen_path_count: 1,
      path_count: 1, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
    },
  ];
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact, now: NOW });

  const actorEnv = {
    LATTICE_TODO_ACTOR_HOST: 'host-1',
    LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1', LATTICE_DASHBOARD_AUTOSTART: '0',
  };
  const start = (taskId) => spawnSync(process.execPath, [
    CLI, 'todo', 'start', '--plan', 'main', '--task', taskId, '--override-reason', 'fixture', '--serial-confirmed',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ...actorEnv, NO_COLOR: '1' } });

  const first = start('T1');
  assert.equal(first.status, 0, first.stderr);
  const firstResult = parse(first.stdout);
  assert.equal(firstResult.advisory.coverage, 'verified');
  // まだactiveが無いので競合相手はいない。
  assert.deepEqual(firstResult.advisory.conflicts_with_active, []);
  assert.deepEqual(firstResult.advisory.self_unknowns, []);
  assert.deepEqual(firstResult.advisory.scope_expansion_recommendations, [{
    code: 'scope_expanded_consider_split',
    task_id: 'T1',
    growth_events: 2,
    first_seen_path_count: 1,
    path_count: 3,
    gate_shape: true,
    message: '宣言が2回膨張している。このtaskは依存の合流点であり、内側にgateのリストが生えているなら、A1..Anと残余A\'への分割を検討できる。',
    next_action: 'consider_todo_split',
  }]);

  // T1が進行中の状態でT2へ着手すると、相手と切断可能性が助言に載る。
  const second = start('T2');
  assert.equal(second.status, 0, second.stderr);
  const advisory = parse(second.stdout).advisory;
  assert.deepEqual(advisory.conflicts_with_active, [{
    active_task_id: 'T1',
    type: 'conflict',
    detail: 'own-path-shared',
    kind: 'path',
    severability: 'code_seam',
  }]);
  assert.equal(advisory.coverage, 'verified');
  assert.equal(advisory.drift_intersecting, null);
  assert.deepEqual(advisory.scope_expansion_recommendations, [],
    '膨張ゼロのtaskには別taskの助言を漏らさない');
});

test('記録が無い時の着手も助言を返し、未検査であることを告げる', async (context) => {
  const root = await workspace(context, { tasks: ['T1'] });
  const actorEnv = {
    LATTICE_TODO_ACTOR_HOST: 'host-1',
    LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1', LATTICE_DASHBOARD_AUTOSTART: '0',
  };
  const started = spawnSync(process.execPath, [
    CLI, 'todo', 'start', '--plan', 'main', '--task', 'T1',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ...actorEnv, NO_COLOR: '1' } });

  assert.equal(started.status, 0, started.stderr);
  const advisory = parse(started.stdout).advisory;
  assert.equal(advisory.coverage, 'missing');
  assert.deepEqual(advisory.scope_expansion_recommendations, []);
  // 「競合なし」でなく「まだ判定していない」として返す。
  assert.deepEqual(advisory.self_unknowns, [
    { kind: 'witness_missing', ref: 'no_independence_record' },
  ]);
});

test('compile結果が既知の宣言膨張だけを分割検討の助言へ写す',
  { timeout: 120_000 }, async (context) => {
    const root = await workspace(context, { tasks: ['T1'] });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), '.lattice/\n');
    await writeFile(path.join(root, 'src/a.mjs'), 'export const a = 1;\n');
    await writeFile(path.join(root, 'src/b.mjs'), 'export const b = 2;\n');

    const witnessSet = {
      schema: TODO_WITNESS_SET_SCHEMA,
      project_id: 'project-1',
      plan_key: 'main',
      capacity: { executors: 2 },
      sensor_query_set: {
        queries: [
          { id: 'q-status', operation: 'status' },
          { id: 'q-a', operation: 'affected', target: 'src/a.mjs' },
          { id: 'q-b', operation: 'affected', target: 'src/b.mjs' },
        ],
      },
      manual_witness: {
        T1: {
          owns: [
            { kind: 'path', target: 'src/a.mjs' },
            { kind: 'path', target: 'src/b.mjs' },
          ],
          reads: [],
          writes: ['src/a.mjs', 'src/b.mjs'],
          resources: [],
          state_effects: [],
          sensor_provenance: {
            queries: [
              { query_id: 'q-a', expect: { kind: 'affected', path: 'src/a.mjs' } },
              { query_id: 'q-b', expect: { kind: 'affected', path: 'src/b.mjs' } },
            ],
          },
          affected_tests: [],
          unknowns: [],
        },
      },
      witness_set_digest: '',
    };
    witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
    await writeFile(path.join(root, 'witness.json'),
      `${canonicalizeTodoArtifact(witnessSet)}\n`);
    git(root, ['add', '.gitignore', 'src/a.mjs', 'src/b.mjs', 'witness.json']);
    git(root, ['commit', '--quiet', '-m', 'expanded witness']);

    const topologyDigest = parse(runCli(root, ['verify', '--json']).stdout)
      .verified_members[0].topology_digest;
    const previous = {
      schema: TODO_INDEPENDENCE_SCHEMA,
      project_id: 'project-1',
      plan_key: 'main',
      plan_version: 'v1',
      topology_digest: topologyDigest,
      base_sha: git(root, ['rev-parse', 'HEAD']),
      witness_set_digest: 'd'.repeat(64),
      compiled_at: NOW,
      task_ids: ['T1'],
      task_boundaries: [{ task_id: 'T1', paths: ['src/a.mjs'] }],
      conflict_resources: [],
      conflicts: [],
      precedences: [],
      unknowns: [],
      wave_plan: { waves: [{ task_ids: ['T1'] }], minimum_feasible_waves: 1 },
      outcome: 'compiled',
      scope_expanded: [{
        task_id: 'T1', compared_witness_digest: null, first_seen_path_count: 1,
        path_count: 1, added_paths: [], removed_paths: [], growth_events: 0,
        gate_shape: false,
      }],
      result_digest: '',
    };
    previous.result_digest = todoSelfDigest(previous, 'result_digest');
    await writeTodoIndependenceArtifact({ repoRoot: root, artifact: previous, now: NOW });

    const initialized = spawnSync(process.execPath, [CLI, 'sensor', 'init', '.', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const compiled = runCli(root, [
      'independence', 'compile', '--plan', 'main', '--input', 'witness.json',
    ]);
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = parse(compiled.stdout);
    assert.equal(result.schema, 'lattice.todo_independence_compile_result.v2');
    assert.deepEqual(result.scope_expansion_recommendations.map((entry) => ({
      task_id: entry.task_id,
      growth_events: entry.growth_events,
      first_seen_path_count: entry.first_seen_path_count,
      path_count: entry.path_count,
      gate_shape: entry.gate_shape,
      next_action: entry.next_action,
    })), [{
      task_id: 'T1',
      growth_events: 1,
      first_seen_path_count: 1,
      path_count: 2,
      gate_shape: false,
      next_action: 'consider_todo_split',
    }]);
  });

test('存在しないplanはfail closedにする', async (context) => {
  const root = await workspace(context);
  const result = runCli(root, ['independence', '--plan', 'absent', '--json']);

  assert.equal(result.status, 1);
  const error = parse(result.stderr);
  assert.equal(error.schema, 'lattice.cli_error.v2');
  assert.equal(error.code, 'PLAN_NOT_FOUND');
  assert.equal(error.detail.reason, 'plan_not_active');
});

test('dirty worktreeの無関係WIPを残したままclean基準でcompileする', async (context) => {
  const root = await workspace(context, { tasks: ['T1'] });
  const witnessSet = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    capacity: { executors: 2 },
    sensor_query_set: { queries: [{ id: 'q-status', operation: 'status' }] },
    manual_witness: {
      T1: {
        owns: [],
        reads: [],
        writes: ['src/a.mjs'],
        resources: [],
        state_effects: [],
        sensor_provenance: { queries: [] },
        affected_tests: [],
        unknowns: [],
      },
    },
    witness_set_digest: '',
  };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  await writeFile(path.join(root, 'witness.json'), `${JSON.stringify(witnessSet)}\n`);

  const result = runCli(root, ['independence', 'compile', '--plan', 'main', '--input', 'witness.json']);
  assert.equal(result.status, 0, result.stderr);
  const compiled = parse(result.stdout);
  assert.equal(compiled.schema, 'lattice.todo_independence_compile_result.v2');
  assert.equal(compiled.outcome, 'compiled');
  assert.equal(git(root, ['status', '--porcelain']).includes('?? witness.json'), true);
});

test('pretty-printされたwitnessをcompileするとstoreへcanonical bytesで保存する', async (context) => {
  const root = await workspace(context, { tasks: ['T1'] });
  const witnessSet = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: 'project-1', plan_key: 'main', capacity: { executors: 1 },
    sensor_query_set: { queries: [{ id: 'q-status', operation: 'status' }] },
    manual_witness: {
      T2: {
        owns: [{ kind: 'path', target: 'src/t1.mjs' }], reads: [], writes: ['src/t1.mjs'],
        resources: [], state_effects: [], sensor_provenance: { queries: [] },
        affected_tests: [], unknowns: [],
      },
    },
    witness_set_digest: '',
  };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  await writeFile(path.join(root, '.gitignore'), '.lattice/\n');
  await writeFile(path.join(root, 'witness.json'), `${JSON.stringify(witnessSet, null, 2)}\n`);
  git(root, ['add', '.gitignore', 'witness.json']);
  git(root, ['commit', '--quiet', '-m', 'pretty witness']);
  assert.equal(git(root, ['status', '--porcelain']), '');

  const rejected = runCli(root, [
    'independence', 'compile', '--plan', 'main', '--input', 'witness.json',
  ]);
  assert.equal(rejected.status, 1);
  assert.equal(parse(rejected.stderr).code, 'INDEPENDENCE_TASK_ABSENT');
  assert.equal(await readTodoWitnessSet({ repoRoot: root, planKey: 'main' }), null);

  witnessSet.manual_witness.T1 = witnessSet.manual_witness.T2;
  delete witnessSet.manual_witness.T2;
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  await writeFile(path.join(root, 'witness.json'), `${JSON.stringify(witnessSet, null, 2)}\n`);
  git(root, ['add', 'witness.json']);
  git(root, ['commit', '--quiet', '-m', 'valid pretty witness']);

  const artifactRef = path.join(
    root, '.lattice', 'todo', 'plans', 'main', 'v1', 'independence.json',
  );
  await mkdir(artifactRef);
  const artifactWriteFailed = runCli(root, [
    'independence', 'compile', '--plan', 'main', '--input', 'witness.json',
  ]);
  assert.equal(artifactWriteFailed.status, 1);
  assert.equal(await readTodoWitnessSet({ repoRoot: root, planKey: 'main' }), null);
  await rm(artifactRef, { recursive: true });

  const compiled = runCli(root, [
    'independence', 'compile', '--plan', 'main', '--input', 'witness.json',
  ]);
  assert.equal(compiled.status, 0, compiled.stderr);

  assert.deepEqual(await readTodoWitnessSet({ repoRoot: root, planKey: 'main' }), witnessSet);
  assert.equal(
    (await readFile(path.join(root, '.lattice', 'todo', 'witness', 'main.json'))).toString('utf8'),
    `${canonicalizeTodoArtifact(witnessSet)}\n`,
  );
});

test('契約を満たさないwitness setはtyped errorで止まる', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'witness.json'), `${JSON.stringify({ schema: 'nope' })}\n`);
  git(root, ['add', 'witness.json']);
  git(root, ['commit', '--quiet', '-m', 'witness']);

  const result = runCli(root, ['independence', 'compile', '--plan', 'main', '--input', 'witness.json']);
  assert.equal(result.status, 1);
  assert.equal(parse(result.stderr).code, 'INVALID_TODO_WITNESS_SET');
});

test('witness migrateは宣言もrevisionも無い状態をfail closedにする', async (context) => {
  const root = await workspace(context);

  const noWitness = runCli(root, ['independence', 'witness', 'migrate', '--plan', 'main']);
  assert.equal(noWitness.status, 1);
  const absent = parse(noWitness.stderr);
  assert.equal(absent.code, 'WITNESS_MIGRATION_UNAVAILABLE');
  assert.equal(absent.detail.reason, 'witness_set_absent');
  assert.equal(absent.detail.witness_ref, '.lattice/todo/witness/main.json');

  // 宣言はあるがrevisionを経ていないplanは、写す先が無いので「移行済み」と装わない。
  const witnessSet = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    capacity: { executors: 2 },
    sensor_query_set: { queries: [{ id: 'q-status', operation: 'status' }] },
    manual_witness: {
      T1: {
        owns: [],
        reads: [],
        writes: ['src/a.mjs'],
        resources: [],
        state_effects: [],
        sensor_provenance: { queries: [] },
        affected_tests: [],
        unknowns: [],
      },
    },
    witness_set_digest: '',
  };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  await writeTodoWitnessSet({ repoRoot: root, witnessSet });

  const noRevision = runCli(root, ['independence', 'witness', 'migrate', '--plan', 'main']);
  assert.equal(noRevision.status, 1);
  assert.equal(parse(noRevision.stderr).detail.reason, 'plan_has_no_revision');

  const absentPlan = runCli(root, ['independence', 'witness', 'migrate', '--plan', 'nope']);
  assert.equal(absentPlan.status, 1);
  assert.equal(parse(absentPlan.stderr).detail.reason, 'plan_not_active');
});

test('案内はadvisoryと投影の両方へ同じ文言で載る', async (context) => {
  const root = await workspace(context, { tasks: ['T1'] });

  // 記録が無く、調整方式も未宣言の状態（ob03）: 「witness setを宣言しろ」ではなく
  // 「どちらで行くか選べ」を返す。誰の受入条件でもない作業を指す督促が、前campaignで
  // 8件のToDo全部を素通りされた当のものである（オーナー裁定C①）。
  const projection = parse(runCli(root, ['independence', '--json']).stdout);
  assert.equal(projection.guidance.code, 'coordination_mode_undeclared');
  assert.equal(projection.guidance.next_action,
    `lattice todo independence mode --plan ${projection.plan_key} --set <witness|conversation|enforced> --reason <text>`);
  assert.match(projection.guidance.message, /調整方式をまだ選んでいない/u);

  const actorEnv = {
    LATTICE_TODO_ACTOR_HOST: 'host-1',
    LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1', LATTICE_DASHBOARD_AUTOSTART: '0',
  };
  const started = spawnSync(process.execPath, [
    CLI, 'todo', 'start', '--plan', 'main', '--task', 'T1',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ...actorEnv, NO_COLOR: '1' } });
  assert.equal(started.status, 0, started.stderr);

  // 読みに来た人と着手する人へ、同じ状況について同じ文言を返す（文言の正本が1つ）。
  assert.deepEqual(parse(started.stdout).advisory.guidance, projection.guidance);
});

test('進行中との競合では案内が切断可能性まで述べる', async (context) => {
  const root = await workspace(context, { tasks: ['T1', 'T2'] });
  const head = git(root, ['rev-parse', 'HEAD']);
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: parse(runCli(root, ['verify', '--json']).stdout)
      .verified_members[0].topology_digest,
    base_sha: head,
    witness_set_digest: 'd'.repeat(64),
    compiled_at: NOW,
    task_ids: ['T1', 'T2'],
    task_boundaries: [
      { task_id: 'T1', paths: ['src/shared.mjs'] },
      { task_id: 'T2', paths: ['src/shared.mjs'] },
    ],
    conflict_resources: [{
      resource_id: 'own-path-shared', kind: 'path', target: 'src/shared.mjs',
    }],
    conflicts: [{ task_ids: ['T1', 'T2'], resource_id: 'own-path-shared' }],
    precedences: [],
    unknowns: [],
    wave_plan: {
      waves: [{ task_ids: ['T1'] }, { task_ids: ['T2'] }],
      minimum_feasible_waves: 2,
    },
    outcome: 'compiled',
    result_digest: '',
  };
  // v4: scope_expanded は task_ids と1:1でなければ validator が落とす。
  // fixture の既定は「膨張ゼロ・比較相手なし」で、履歴を測る test は明示的に上書きする
  artifact.scope_expanded = artifact.scope_expanded ?? (artifact.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact, now: NOW });

  const actorEnv = {
    LATTICE_TODO_ACTOR_HOST: 'host-1',
    LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1', LATTICE_DASHBOARD_AUTOSTART: '0',
  };
  const start = (taskId) => spawnSync(process.execPath, [
    CLI, 'todo', 'start', '--plan', 'main', '--task', taskId, '--override-reason', 'fixture', '--serial-confirmed',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ...actorEnv, NO_COLOR: '1' } });

  assert.equal(start('T1').status, 0);
  const advisory = parse(start('T2').stdout).advisory;
  assert.equal(advisory.guidance.code, 'independence_conflict_with_active');
  assert.equal(advisory.guidance.next_action,
    'lattice todo dependency connect --from-plan main --from-task <id> --to-plan main --to-task <id> --reason <text>');
  // pathの衝突なので、分割で並列化しうることまで述べる。
  assert.match(advisory.guidance.message, /refactorで並列化しうる/u);
});

test('live head digestは独立性の変化を拾う', async (context) => {
  const root = await workspace(context);
  const store = await readTodoStore({ repoRoot: root });
  const before = await ganttLiveHeadDigest({ repoRoot: root, store });

  const head = git(root, ['rev-parse', 'HEAD']);
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: parse(runCli(root, ['verify', '--json']).stdout)
      .verified_members[0].topology_digest,
    base_sha: head,
    witness_set_digest: 'd'.repeat(64),
    compiled_at: NOW,
    task_ids: ['T1', 'T2'],
    task_boundaries: [
      { task_id: 'T1', paths: ['src/t1.mjs'] },
      { task_id: 'T2', paths: ['src/t2.mjs'] },
    ],
    conflict_resources: [],
    conflicts: [],
    precedences: [],
    unknowns: [],
    wave_plan: { waves: [{ task_ids: ['T1', 'T2'] }], minimum_feasible_waves: 1 },
    outcome: 'compiled',
    result_digest: '',
  };
  // v4: scope_expanded は task_ids と1:1でなければ validator が落とす。
  // fixture の既定は「膨張ゼロ・比較相手なし」で、履歴を測る test は明示的に上書きする
  artifact.scope_expanded = artifact.scope_expanded ?? (artifact.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact, now: NOW });

  // manifestは動いていないが、記録が生まれたので画面は更新されなければならない。
  const afterStore = await readTodoStore({ repoRoot: root });
  assert.equal(afterStore.manifest.manifest_digest, store.manifest.manifest_digest);
  const after = await ganttLiveHeadDigest({ repoRoot: root, store: afterStore });
  assert.notEqual(after, before);

  // 同じ状態からは同じ値が出る（描画側と検知側が食い違わない根拠）。
  assert.equal(await ganttLiveHeadDigest({ repoRoot: root, store: afterStore }), after);
});

test('未知の引数はusage failureで終わる', async (context) => {
  const root = await workspace(context);
  for (const args of [
    ['independence', 'compile'],
    ['independence', 'compile', '--plan', 'main', '--input'],
    ['independence', '--plan'],
    ['independence', 'witness'],
    ['independence', 'witness', 'migrate'],
    ['independence', 'witness', 'migrate', '--plan'],
  ]) {
    const result = runCli(root, args);
    assert.equal(result.status, 2, `expected usage failure for: ${args.join(' ')}`);
    assert.equal(result.stdout, '');
  }
});

test('next_ready が witness に無い compile は拒否する', async (context) => {
  const root = await workspace(context);
  const witnessSet = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    capacity: { executors: 2 },
    sensor_query_set: { queries: [{ id: 'q-status', operation: 'status' }] },
    manual_witness: {
      T1: {
        owns: [], reads: [], writes: ['src/t1.mjs'], resources: [],
        state_effects: [], sensor_provenance: { queries: [] },
        affected_tests: [], unknowns: [],
      },
    },
    witness_set_digest: '',
  };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  await writeFile(path.join(root, 'witness.json'), `${JSON.stringify(witnessSet)}\n`);

  const compiled = runCli(root, [
    'independence', 'compile', '--plan', 'main', '--input', 'witness.json',
  ]);
  assert.equal(compiled.status, 1, compiled.stderr);
  const error = parse(compiled.stderr);
  assert.equal(error.code, 'INDEPENDENCE_READY_UNDECLARED');
  assert.deepEqual(error.detail.missing_task_ids, ['T2']);
  // a35: compiling the same set again cannot add T2; the way on is the template route.
  assert.match(error.detail.next_action, /^Declare T2 in the witness set\. .*scaffold --template --plan main/u);
});

// T1だけを宣言したcompiled記録をstoreへ書く（baseは現在のHEAD）。
async function writeCompiledArtifact(root) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: parse(runCli(root, ['verify', '--json']).stdout)
      .verified_members[0].topology_digest,
    base_sha: head,
    witness_set_digest: 'd'.repeat(64),
    compiled_at: NOW,
    task_ids: ['T1'],
    task_boundaries: [{ task_id: 'T1', paths: ['src/t1.mjs'] }],
    conflict_resources: [],
    conflicts: [],
    precedences: [],
    unknowns: [],
    wave_plan: { waves: [{ task_ids: ['T1'] }], minimum_feasible_waves: 1 },
    outcome: 'compiled',
    result_digest: '',
  };
  artifact.scope_expanded = [{
    task_id: 'T1', compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }];
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact, now: NOW });
}

test('記録がある未宣言 task の start も止めず、未宣言は助言に載せ、宣言済みはその助言を載せない（u03 B1-B6）', async (context) => {
  const root = await workspace(context);
  await writeCompiledArtifact(root);

  const undeclared = runCli(root, ['start', '--plan', 'main', '--task', 'T2']);
  assert.equal(undeclared.status, 0, undeclared.stderr);
  const startedT2 = parse(undeclared.stdout);
  assert.equal(startedT2.kind, 'start');
  assert.equal(startedT2.task_id, 'T2');
  assert.equal(startedT2.advisory.guidance.code, 'independence_task_undeclared');
  assert.equal(startedT2.advisory.guidance.next_action,
    'lattice todo independence compile --plan main --input <file>');

  const declared = runCli(root, ['start', '--plan', 'main', '--task', 'T1']);
  assert.equal(declared.status, 0, declared.stderr);
  const startedT1 = parse(declared.stdout);
  assert.equal(startedT1.kind, 'start');
  assert.notEqual(startedT1.advisory.guidance.code, 'independence_task_undeclared');
});

const NO_RECORD_SELF_UNKNOWN = (ref) => [{ kind: 'witness_missing', ref }];

test('記録があってもHEADを解決できないstartは通り、記録なしの助言と警告を返す（u03 B7）', async (context) => {
  const root = await workspace(context);
  await writeCompiledArtifact(root);
  // HEADを存在しないbranchへ向けて`git rev-parse HEAD`だけを失敗させる（storeは読める）。
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/no-such-branch\n');
  assert.throws(() => git(root, ['rev-parse', 'HEAD']));

  const started = runCli(root, ['start', '--plan', 'main', '--task', 'T1']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stderr, /LATTICE_START_INDEPENDENCE_UNUSABLE/u);
  assert.match(started.stderr, /git_head_unresolved/u);
  const result = parse(started.stdout);
  assert.equal(result.kind, 'start');
  assert.equal(result.advisory.coverage, 'missing');
  assert.deepEqual(result.advisory.self_unknowns, NO_RECORD_SELF_UNKNOWN('git_head_unresolved'));
  assert.equal(result.advisory.guidance.code, 'coordination_mode_undeclared');
});

test('読めない独立性記録があってもstartは通り、記録なしの助言と警告を返す（u03 B16）', async (context) => {
  const root = await workspace(context);
  await writeCompiledArtifact(root);
  const recordRef = path.join(root, '.lattice/todo/plans/main/v1/independence.json');
  await writeFile(recordRef, `${await readFile(recordRef, 'utf8')} `);

  const started = runCli(root, ['start', '--plan', 'main', '--task', 'T1']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stderr, /LATTICE_START_INDEPENDENCE_UNUSABLE/u);
  assert.match(started.stderr, /independence_record_unreadable/u);
  const result = parse(started.stdout);
  assert.equal(result.kind, 'start');
  assert.equal(result.advisory.coverage, 'missing');
  assert.deepEqual(result.advisory.self_unknowns, NO_RECORD_SELF_UNKNOWN('independence_record_unreadable'));
});
