import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { validateTodoStatusResult } from '../src/todo-status.mjs';
import { projectTurn, validateProjectStatus } from '../src/project-cli.mjs';

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
  assert.equal(value.schema, 'lattice.session_context.v2');
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
  assert.equal(summary.guidance.next_action,
    `lattice todo independence compile --plan ${summary.plan_key} --input <file>`);
  assert.equal(summary.unreadable_reason, null);
});

const actorEnv = (agent) => ({
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1', LATTICE_TODO_ACTOR_AGENT: agent,
});

test('turnは自分の途中の工程だけをownに載せ、startableはnext_readyそのもの', async (context) => {
  const root = await initialized(context, ['T1', 'T2', 'T3', 'T4']);
  const start = (task, agent) => run(root, ['todo', 'start', '--plan', 'main', '--task', task], actorEnv(agent));
  for (const [task, agent] of [['T1', 'agent-1'], ['T2', 'agent-1'], ['T3', 'agent-2']]) {
    const started = start(task, agent);
    assert.equal(started.status, 0, started.stderr);
  }
  const blocked = run(root, ['todo', 'block', '--plan', 'main', '--task', 'T2', '--reason', 'waiting'], actorEnv('agent-1'));
  assert.equal(blocked.status, 0, blocked.stderr);

  const value = parse(run(root, ['session-context', '--json'], actorEnv('agent-1')).stdout);
  assert.deepEqual(value.turn.actor, { host: 'host-1', session: 'session-1', agent: 'agent-1' });
  // T3は別agentの工程、T4は未着手。ownに載るのは自分のT1(in-progress)とT2(blocked)だけ。
  assert.deepEqual(value.turn.own.map((entry) => [entry.task_id, entry.status, entry.blocked_reason]),
    [['T1', 'in-progress', null], ['T2', 'blocked', 'waiting']]);
  assert.deepEqual(Object.keys(value.turn.own[0]),
    ['plan_key', 'task_id', 'label', 'status', 'started_at', 'blocked_reason', 'done_condition']);
  assert.equal(value.turn.own[0].label, 'T1');
  assert.equal(value.turn.own[0].done_condition, null);
  assert.match(value.turn.own[0].started_at, /^\d{4}-/u);
  assert.deepEqual(value.turn.startable, value.todo.next_ready);
  assert.deepEqual(value.turn.startable.map(({ task_id: id }) => id), ['T4']);
  assert.equal('warning' in value.turn, false);
  assert.equal(value.result_digest, todoSelfDigest(value, 'result_digest'));

  const other = parse(run(root, ['session-context', '--json'], actorEnv('agent-2')).stdout);
  assert.deepEqual(other.turn.own.map(({ task_id: id }) => id), ['T3']);
});

test('seats sharing one USER are told apart by LATTICE_SEAT_ID: seat_id on top, own per seat', async (context) => {
  const root = await initialized(context, ['T1', 'T2', 'T3']);
  const seatEnv = (seat) => ({ LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: '', USER: 'bell', LATTICE_SEAT_ID: seat });
  for (const [task, seat] of [['T1', 'seat-a'], ['T2', 'seat-b']]) {
    const started = run(root, ['todo', 'start', '--plan', 'main', '--task', task], seatEnv(seat));
    assert.equal(started.status, 0, started.stderr);
  }
  const a = parse(run(root, ['session-context', '--json'], seatEnv('seat-a')).stdout);
  assert.equal(a.seat_id, 'seat-a');
  assert.equal(a.turn.actor.agent, 'seat-a');
  assert.deepEqual(a.turn.own.map(({ task_id: id }) => id), ['T1']);
  assert.equal(a.result_digest, todoSelfDigest(a, 'result_digest'));
  const b = parse(run(root, ['session-context', '--json'], seatEnv('seat-b')).stdout);
  assert.deepEqual(b.turn.own.map(({ task_id: id }) => id), ['T2']);
  const anonymous = parse(run(root, ['session-context', '--json'], { ...seatEnv('seat-a'), LATTICE_SEAT_ID: '' }).stdout);
  assert.equal('seat_id' in anonymous, false);
  assert.equal(anonymous.turn.actor.agent, 'bell');
});

test('a16: a revision by another seat keeps the carried start with the seat that started it', async (context) => {
  const root = await initialized(context, ['T1', 'T2', 'T3']);
  const started = run(root, ['todo', 'start', '--plan', 'main', '--task', 'T3'], actorEnv('seat-b'));
  assert.equal(started.status, 0, started.stderr);
  const connected = run(root, ['todo', 'dependency', 'connect', '--from-plan', 'main', '--from-task', 'T1',
    '--to-plan', 'main', '--to-task', 'T2', '--reason', 'T2 needs T1'], actorEnv('seat-a'));
  assert.equal(connected.status, 0, connected.stderr);
  const result = parse(connected.stdout);
  assert.deepEqual(result.rebound_task_ids, ['T3']);
  assert.equal(result.actor.agent, 'seat-a');
  const b = parse(run(root, ['session-context', '--json'], actorEnv('seat-b')).stdout);
  assert.deepEqual(b.turn.own.map(({ task_id: id }) => id), ['T3']);
  const a = parse(run(root, ['session-context', '--json'], actorEnv('seat-a')).stdout);
  assert.deepEqual(a.turn.own, []);
});

test('doneの工程はownに載らない', async (context) => {
  const root = await initialized(context, ['T1']);
  const env = actorEnv('agent-1');
  assert.equal(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1'], env).status, 0);
  const before = parse(run(root, ['session-context', '--json'], env).stdout);
  assert.equal(before.turn.own.length, 1);
  // doneにするには証拠が要る。ここではstate単位でprojectTurnの除外を確かめる。
  const done = structuredClone(before);
  const store = { members: [{ plan: { plan_key: 'main', tasks: [{ task_id: 'T1', title: 'T1' }] },
    journal: { events: [{ kind: 'start', task_id: 'T1', actor: { agent: 'agent-1' } }] },
    tasks: [{ task_id: 'T1', status: 'done', started_at: 'x', blocked_reason: null }] }] };
  assert.deepEqual(projectTurn({ store, todo: done.todo, actor: done.turn.actor }).own, []);
});

test('storeが無い・読めないときturnは空と理由を返し、終了コードは変わらない', async (context) => {
  const root = await workspace(context);
  const uninitialized = run(root, ['session-context', '--json'], actorEnv('agent-1'));
  assert.equal(uninitialized.status, 0);
  const value = parse(uninitialized.stdout);
  assert.deepEqual(value.turn, { actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    startable: [], own: [], warning: { reason: 'uninitialized' } });

  const bare = await mkdtemp(path.join(tmpdir(), 'lattice-session-context-bare-'));
  context.after(() => rm(bare, { recursive: true, force: true }));
  const invalid = run(bare, ['session-context', '--json'], actorEnv('agent-1'));
  assert.equal(invalid.status, 1);
  assert.deepEqual(parse(invalid.stdout).turn.warning, { reason: 'git_repository_unresolved' });
});

test('active_runのstatusは次の一歩としてsession-contextを指す', async (context) => {
  const root = await initialized(context);
  assert.equal(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1'], actorEnv('agent-1')).status, 0);
  const status = parse(run(root, ['status', '--json'], { ...actorEnv('agent-1'), LATTICE_DASHBOARD_AUTOSTART: '0' }).stdout);
  assert.deepEqual(status.next_action, { command: 'lattice session-context --json', reason: 'active_run_present' });
  assert.equal(validateProjectStatus(status), true);
});
