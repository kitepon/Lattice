import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { validateTodoStatusResult } from '../src/todo-status.mjs';
import { validateProjectStatus } from '../src/project-cli.mjs';

// ADR 0131。session開始時の現在地を1プロセス・1 store読みで返す。
// 既存2面は不変で、これはその合成。dashboard活動の登録は行わない。

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-session-context-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

function run(root, args, env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', ...env };
  delete childEnv.FORCE_COLOR;
  if (env.LATTICE_SEAT_ID === null) delete childEnv.LATTICE_SEAT_ID;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: childEnv });
}

const parse = (text) => JSON.parse(text.trim().split('\n').at(-1));

function createInput(taskIds) {
  const value = {
    schema: 'lattice.plan_create_input.v4',
    project_id: 'sample-project',
    plan_key: 'main',
    plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: taskIds.map((taskId) => ({
      task_id: taskId, title: taskId, lane: 'main', design_memo: 'NO_PLAN',
      narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'phase-1',
    })),
    phases: [{ phase_id: 'phase-1', title: '実装', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: [],
    joins: [],
    phase_accept_dependencies: [],
    input_digest: '',
  };
  value.input_digest = todoSelfDigest(value, 'input_digest');
  return value;
}

async function initialized(context, taskIds = ['T1', 'T2']) {
  const root = await workspace(context);
  await writeFile(path.join(root, 'plan.json'),
    `${canonicalizeTodoArtifact(createInput(taskIds))}\n`);
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
  return root;
}

test('session contextはstatusとtodoを1プロセスで返す', async (context) => {
  const root = await initialized(context);
  const result = run(root, ['session-context', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const value = parse(result.stdout);
  assert.equal(value.schema, 'lattice.session_context.v1');
  // 埋め込みは既存契約そのもの。hostは持っている検証器を再利用できる。
  assert.equal(validateProjectStatus(value.status), true);
  assert.equal(validateTodoStatusResult(value.todo), true);
  assert.equal(value.status.state, 'ready');
  assert.deepEqual(value.todo.next_ready.map(({ task_id: id }) => id), ['T1', 'T2']);
  assert.equal(value.result_digest, todoSelfDigest(value, 'result_digest'));
});

test('埋め込みstatusは既存のstatus面とバイト一致する', async (context) => {
  const root = await initialized(context);
  // 副作用の有無だけが違い、答えは同じでなければならない（合成であって別実装ではない）。
  const standalone = parse(run(root, ['status', '--json'], { LATTICE_DASHBOARD_AUTOSTART: '0' }).stdout);
  const embedded = parse(run(root, ['session-context', '--json']).stdout).status;
  assert.deepEqual(embedded, standalone);
});

test('dashboard活動を登録しない', async (context) => {
  const root = await initialized(context);
  // autostartを止める指示なしで呼んでも、常駐面へは触らない（ADR 0131 Decision 4）。
  const result = run(root, ['session-context', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const registry = spawnSync('ls', [path.join(root, '.lattice', 'dashboard')], { encoding: 'utf8' });
  assert.notEqual(registry.status, 0, 'session-contextがdashboard状態を作ってはならない');
});

test('未初期化projectでもstatusと同じ判定を返し、独立性は空になる', async (context) => {
  const root = await workspace(context);
  const value = parse(run(root, ['session-context', '--json']).stdout);

  assert.equal(value.status.state, 'uninitialized');
  assert.equal(value.status.can_create_plan, true);
  // storeが無ければ工程も並列可否も語る対象が無い。空へ丸めるのでなく「無い」を返す。
  assert.equal(value.todo, null);
  assert.deepEqual(value.independence, []);
});

test('git repositoryの外ではstatusと同じくinvalidで終わる', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-session-context-bare-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = run(root, ['session-context', '--json']);

  assert.equal(result.status, 1);
  const value = parse(result.stdout);
  assert.equal(value.status.state, 'invalid');
  assert.equal(value.todo, null);
  assert.deepEqual(value.independence, []);
});

test('session-contextはstatusと同じseat identityを投影しdigestに含める', async (context) => {
  const root = await workspace(context);
  for (const [seat, expected] of [['seat-alice', 'seat-alice'], [null, undefined], ['bad seat', undefined]]) {
    const result = run(root, ['session-context', '--json'], { LATTICE_SEAT_ID: seat });
    assert.equal(result.status, 0, result.stderr);
    const value = parse(result.stdout);
    assert.equal(value.seat_id, expected);
    assert.equal(value.status.seat_id, expected);
    assert.equal(Object.hasOwn(value, 'seat_id'), expected !== undefined);
    assert.equal(validateProjectStatus(value.status), true);
    assert.equal(value.result_digest, todoSelfDigest(value, 'result_digest'));
  }
});

test('readyがあるplanだけ並列可否を要約し、記録が無ければ未判定と述べる', async (context) => {
  const root = await initialized(context);
  const value = parse(run(root, ['session-context', '--json']).stdout);

  assert.equal(value.independence.length, 1);
  const [summary] = value.independence;
  assert.equal(summary.plan_key, 'main');
  assert.equal(summary.coverage, 'missing');
  // ob03: 調整方式が未宣言なので、案内は未compileの督促ではなく「どちらで行くか選べ」。
  assert.equal(summary.guidance.code, 'coordination_mode_undeclared');
  assert.equal(summary.unreadable_reason, null);
  // 記録が無い＝「競合なし」ではないので、検証済みグループを作らない。
  assert.deepEqual(summary.parallel_groups, []);
  assert.deepEqual(summary.unknown_task_ids, ['T1', 'T2']);
});

test('壊れた記録は未判定へ丸めず理由を載せる', async (context) => {
  const root = await initialized(context);
  const artifactRef = path.join(root, '.lattice', 'todo', 'plans', 'main', 'v1', 'independence.json');
  await writeFile(artifactRef, '{"schema":"lattice.todo_independence.v2"}\n');

  const value = parse(run(root, ['session-context', '--json']).stdout);
  const [summary] = value.independence;
  assert.equal(summary.coverage, null);
  assert.match(summary.unreadable_reason, /INDEPENDENCE_ARTIFACT_INVALID/u);
  assert.deepEqual(summary.parallel_groups, []);
});

test('identityが揃った旧v2記録は旧契約由来のsupersededとして要約する', async (context) => {
  const root = await initialized(context);
  const artifactRef = path.join(root, '.lattice', 'todo', 'plans', 'main', 'v1', 'independence.json');
  const artifact = {
    schema: 'lattice.todo_independence.v2',
    project_id: 'sample-project',
    plan_key: 'main',
    plan_version: 'v1',
    topology_digest: 'b'.repeat(64),
    base_sha: 'a'.repeat(40),
    witness_set_digest: 'c'.repeat(64),
    compiled_at: '2026-07-26T00:00:00.000Z',
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
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeFile(artifactRef, `${canonicalizeTodoArtifact(artifact)}\n`);

  const value = parse(run(root, ['session-context', '--json']).stdout);
  const [summary] = value.independence;
  assert.equal(summary.coverage, 'superseded');
  assert.equal(summary.guidance.code, 'independence_contract_superseded');
  assert.equal(summary.guidance.next_action, 'recompile_independence');
  assert.equal(summary.unreadable_reason, null);
});
