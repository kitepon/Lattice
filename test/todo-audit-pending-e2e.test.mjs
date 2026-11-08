// ap06: 監査待ち表出のE2E。既存の3 test（ap02の共有module unit・ap03のprojection・ap04の
// project status）はいずれもmodule境界の内側か`lattice status`だけを見ている。本testが埋めるのは
// **`bin/lattice.mjs todo status --json`のstdoutそのもの**で、実CLIを起動して実storeを読ませ、
// 監査待ちが表出することと、それがdispatchを1バイトも動かさないことを同じ場所で固定する。
//
// この修正の値打ちは2つの両立にある。片方だけのtestでは守れない:
// 1. 監査待ちがstatusへ出る（AIが「残作業なし」と読まなくなる）
// 2. dispatchが変わらない（ADR 0062・ADR 0147裁定5・ADR 0063の不変条件）
//
// 実storeでgate_readyを作る時の落とし穴が2つある。次に書く人が2往復払わないよう明記する:
// - `NOW`を現在時刻より先に置くと`STORE_INCONSISTENT / future_clock_skew`でstatusごと落ちる
//   （許容は5分）。既存testが過去日付の固定NOWを使っているのはこのため。
// - `buildTodoPlan`のtask入力は`{task_id, title, lane, narrative_ref, narrative_anchor,
//   compile_binding, parent_task_id}`ちょうど。`design_memo`を足すとschema violationで弾かれる。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
   buildTodoPlan, createTodoStoreWriter, initializeTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { TODO_STATUS_SCHEMA, validateTodoStatusResult } from '../src/todo-status.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ACTOR_ENV = {
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
};
const TERMINAL_AUDIT = 'terminal-audit';
const STATUS_KEYS = [
  'schema', 'project_id', 'active_set', 'next_ready', 'dispatch_frontier', 'blocked',
  'audit_pending', 'structure_finalization_pending', 'plan_notes',
  'coordination', 'parallel_candidates', 'cross_plan_findings',
    'member_heads', 'result_digest',
];

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null });
const ref = (taskId, planKey) => ({ project_id: 'project-1', plan_key: planKey, task_id: taskId });

function run(root, args, env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', ...env };
  delete childEnv.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: childEnv });
}

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result;
}

function evidenceFor(root, label) {
  const bytes = Buffer.from(`${label} evidence\n`);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  return { evidence_id: label, repo_id: 'self', path: `${label}.txt`, git_blob_oid: oid,
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
}

/**
 * 2 planを持つphase無しstore:
 * - `audited`: A -> B。両方doneにすると暗黙terminal-audit Phaseがgate_readyになる対象
 * - `working`: 独立taskのPだけ。ずっとpendingのまま残し、`audited`側の監査状態が
 *   dispatchへ波及していないことを見るための対照
 *
 * storeの構築だけlibraryで行い、観測と遷移はすべて実CLIを通す。構築まで実CLIでやると
 * `plan create`が初期化済みprojectで使えず（`can_create_plan: false`）2 planを作れない。
 */
async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-audit-e2e-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(path.join(root, '.lattice'), { recursive: true });
  const plan = (planKey, tasks, hard) => buildTodoPlan({
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: planKey, plan_version: 'v1',
    predecessor_plan_digest: null, tasks, hard_dependencies: hard, joins: [],
  });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: plan('audited', [task('A'), task('B')], [{ from: ref('A', 'audited'), to: ref('B', 'audited') }]),
        genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('working', [task('P')], []), genesis: { actor: ACTOR, recorded_at: NOW } },
    ],
    now: NOW,
  });

  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const finish = async (planKey, taskId) => {
    for (const kind of ['start', 'done']) {
      await appendTodoEvent({ repoRoot: root, writer, planKey, now: NOW,
        event: { kind, task_id: taskId, actor: ACTOR, recorded_at: NOW,
          payload: kind === 'start' ? { override_reason: null } : { evidence: evidenceFor(root, taskId) } } });
    }
  };
  const status = () => JSON.parse(ok(run(root, ['todo', 'status', '--json'])).stdout);
  const discovery = () => JSON.parse(ok(run(root, ['status', '--json'])).stdout);
  const accept = (planKey, phaseId, reviewDigest) => {
    const evidence = evidenceFor(root, `${planKey}-accept`);
    const decision = { schema: 'lattice.phase_accept_input.v1', review_event_digest: reviewDigest,
      decision_evidence: evidence, evidence_slots: [{ slot_id: TERMINAL_AUDIT, evidence }], input_digest: '' };
    decision.input_digest = todoSelfDigest(decision, 'input_digest');
    return writeFile(path.join(root, '.lattice', 'accept.json'), `${canonicalizeTodoArtifact(decision)}\n`)
      .then(() => ok(run(root, ['todo', 'phase', 'accept', '--plan', planKey, '--phase', phaseId,
        '--input', '.lattice/accept.json'], ACTOR_ENV)));
  };
  return { root, finish, status, discovery, accept };
}

const auditPendingOf = (status, planKey) => status.audit_pending.filter((entry) => entry.plan_key === planKey);
// dispatchの同一性は「readyの集合」ではなく「候補集合のidentity」で見る。frontier_digestは
// ADR 0063でその identity そのものなので、ここが動けば監査がdispatchへ漏れている。
const dispatchOf = (status) => ({
  active_set: status.active_set, next_ready: status.next_ready,
  blocked: status.blocked, dispatch_frontier: status.dispatch_frontier,
});

test('(a) 全taskがdoneになるとCLIのstdoutが監査待ちを名指しし、次の一手まで返す', async (context) => {
  const { finish, status, discovery } = await workspace(context);
  await finish('audited', 'A');
  await finish('audited', 'B');

  const result = status();
  assert.equal(result.schema, TODO_STATUS_SCHEMA);
  assert.deepEqual(auditPendingOf(result, 'audited'), [{
    plan_key: 'audited', phase_id: TERMINAL_AUDIT, phase_status: 'gate_ready', implicit: true,
    required_evidence_slots: [TERMINAL_AUDIT],
    next_commands: [
      `lattice todo phase review --plan audited --phase ${TERMINAL_AUDIT} --reason <text>`,
      `lattice todo phase close-unaudited --plan audited --phase ${TERMINAL_AUDIT} --reason <text>`,
    ],
  }]);

  // audited側のtaskは尽きたが、working planのPがまだreadyなので次アクションはready側が勝つ
  // （ADR 0063の優先順位。監査で並列開始を上書きしない）。ready1件なので`next_ready_present`、
  // 2件以上なら`parallel_frontier_present`——どちらもready側であって`audit_pending`ではない、
  // が固定したい事実である。
  const state = discovery();
  assert.equal(state.state, 'ready');
  assert.equal(state.next_action.reason, 'next_ready_present');
});

test('(a) readyが尽きた時、案内はno_ready_taskではなくaudit_pendingになる', async (context) => {
  const { finish, status, discovery } = await workspace(context);
  for (const [planKey, taskId] of [['audited', 'A'], ['audited', 'B'], ['working', 'P']]) {
    await finish(planKey, taskId);
  }

  const result = status();
  assert.deepEqual(result.next_ready, []);
  assert.deepEqual(result.active_set, []);
  // 全taskがdoneでも「残作業なし」ではない。ここが空を返していたのが事故の直接原因だった。
  assert.deepEqual(result.audit_pending.map(({ plan_key, phase_status }) => [plan_key, phase_status]),
    [['audited', 'gate_ready'], ['working', 'gate_ready']]);

  const state = discovery();
  assert.equal(state.state, 'ready', 'stateは閉じたenumなので動かさない。信号はreasonが持つ');
  assert.equal(state.next_action.reason, 'audit_pending');
});

test('(a) 返された次の一手は、placeholderを埋めればそのまま実行できる', async (context) => {
  const { root, finish, status } = await workspace(context);
  await finish('audited', 'A');
  await finish('audited', 'B');

  const [command] = auditPendingOf(status(), 'audited')[0].next_commands;
  const argv = command.split(' ').slice(1).map((token) => (token === '<text>' ? '終端監査を開始' : token));
  assert.equal(argv[0], 'todo');
  ok(run(root, argv, ACTOR_ENV));
  assert.equal(auditPendingOf(status(), 'audited')[0].phase_status, 'reviewing');
});

test('(b) 監査待ちの3状態はそれぞれ実行できる遷移だけを案内し、判断が着けば消える', async (context) => {
  const { root, finish, status, accept } = await workspace(context);
  await finish('audited', 'A');
  await finish('audited', 'B');
  const commandsOf = () => auditPendingOf(status(), 'audited')[0]?.next_commands ?? null;

  const review = ok(run(root, ['todo', 'phase', 'review', '--plan', 'audited',
    '--phase', TERMINAL_AUDIT, '--reason', '終端監査を開始'], ACTOR_ENV));
  assert.deepEqual(commandsOf(), [
    `lattice todo phase accept --plan audited --phase ${TERMINAL_AUDIT} --input <file>`,
    `lattice todo phase reject --plan audited --phase ${TERMINAL_AUDIT} --input <file>`,
  ]);

  const evidence = evidenceFor(root, 'reject');
  const rejection = { schema: 'lattice.phase_reject_input.v1',
    review_event_digest: JSON.parse(review.stdout).event_digest,
    decision_evidence: evidence, reason: '証跡が足りない', input_digest: '' };
  rejection.input_digest = todoSelfDigest(rejection, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'reject.json'), `${canonicalizeTodoArtifact(rejection)}\n`);
  ok(run(root, ['todo', 'phase', 'reject', '--plan', 'audited', '--phase', TERMINAL_AUDIT,
    '--input', '.lattice/reject.json'], ACTOR_ENV));
  // rejectedは「判断が着いた」ではなく「差し戻して待っている」なので監査待ちのまま残る。
  assert.equal(auditPendingOf(status(), 'audited')[0].phase_status, 'rejected');
  assert.deepEqual(commandsOf(), [
    `lattice todo phase reopen --plan audited --phase ${TERMINAL_AUDIT} --reason <text>`,
  ]);

  ok(run(root, ['todo', 'phase', 'reopen', '--plan', 'audited', '--phase', TERMINAL_AUDIT,
    '--reason', '証跡を揃えて再監査'], ACTOR_ENV));
  assert.equal(auditPendingOf(status(), 'audited')[0].phase_status, 'gate_ready');

  const reviewed = ok(run(root, ['todo', 'phase', 'review', '--plan', 'audited',
    '--phase', TERMINAL_AUDIT, '--reason', '再監査'], ACTOR_ENV));
  await accept('audited', TERMINAL_AUDIT, JSON.parse(reviewed.stdout).event_digest);
  assert.deepEqual(auditPendingOf(status(), 'audited'), []);
});

test('(b) close-unauditedで閉じた工程も監査待ちには残らない', async (context) => {
  const { root, finish, status } = await workspace(context);
  await finish('audited', 'A');
  await finish('audited', 'B');

  ok(run(root, ['todo', 'phase', 'close-unaudited', '--plan', 'audited', '--phase', TERMINAL_AUDIT,
    '--reason', '歴史として閉じる'], ACTOR_ENV));
  assert.deepEqual(auditPendingOf(status(), 'audited'), []);
});

test('(c) 混在: 監査待ちのplanがあってもdispatchはacceptedにした場合とbyte等価である', async (context) => {
  const pending = await workspace(context);
  await pending.finish('audited', 'A');
  await pending.finish('audited', 'B');

  // 対照: task状態は同じで、audited側の監査だけ着けた store。
  const settled = await workspace(context);
  await settled.finish('audited', 'A');
  await settled.finish('audited', 'B');
  const reviewed = ok(run(settled.root, ['todo', 'phase', 'review', '--plan', 'audited',
    '--phase', TERMINAL_AUDIT, '--reason', '終端監査'], ACTOR_ENV));
  await settled.accept('audited', TERMINAL_AUDIT, JSON.parse(reviewed.stdout).event_digest);

  const pendingStatus = pending.status();
  const settledStatus = settled.status();
  assert.equal(auditPendingOf(pendingStatus, 'audited').length, 1);
  assert.deepEqual(auditPendingOf(settledStatus, 'audited'), []);

  // これがADR 0062・ADR 0147裁定5のanchor。監査状態が違ってもdispatch面は1バイトも違わない。
  assert.equal(JSON.stringify(dispatchOf(pendingStatus)), JSON.stringify(dispatchOf(settledStatus)));
  assert.equal(pendingStatus.dispatch_frontier.frontier_digest,
    settledStatus.dispatch_frontier.frontier_digest);
  assert.deepEqual(pendingStatus.next_ready.map(({ task_id }) => task_id), ['P']);
});

/**
 * 宣言Phase plan（`plan create`のv4入力）を1つ持つstore。暗黙のterminal-auditではなく
 * plan自身が持つPhaseなので、`implicit: false`とplan由来のslotsが出る側の対照になる。
 * 2 planを作れないCLI経路（初期化済みprojectは`can_create_plan: false`）だが、
 * ここは1 planで足りる。
 */
async function phasePlanWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-audit-e2e-phase-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(path.join(root, '.lattice'), { recursive: true });
  const phaseTask = (taskId, title, phaseId) => ({ task_id: taskId, title, lane: 'main',
    design_memo: `${title}を検証可能に記録する。`, narrative_ref: null, narrative_anchor: null,
    compile_binding: null, parent_task_id: null, phase_id: phaseId });
  const input = {
    schema: 'lattice.plan_create_input.v4', project_id: 'audit-project', plan_key: 'main',
    plan_version: 'v1', actor: { ...ACTOR }, recorded_at: new Date().toISOString(),
    tasks: [phaseTask('T1', '設計', 'phase-1'), phaseTask('T2', '実装', 'phase-2')],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'heavy', predecessor_phase_ids: ['phase-1'],
        required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '',
  };
  input.input_digest = todoSelfDigest(input, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'plan.json'), `${canonicalizeTodoArtifact(input)}\n`);
  ok(run(root, ['plan', 'create', '--input', '.lattice/plan.json']));

  const evidence = evidenceFor(root, 'heavy');
  await writeFile(path.join(root, '.lattice', 'evidence.json'), `${JSON.stringify(evidence)}\n`);
  const finish = (taskId) => {
    ok(run(root, ['todo', 'start', '--plan', 'main', '--task', taskId, '--parallel-frontier'], ACTOR_ENV));
    ok(run(root, ['todo', 'done', '--plan', 'main', '--task', taskId,
      '--evidence', '.lattice/evidence.json'], ACTOR_ENV));
  };
  const status = () => JSON.parse(ok(run(root, ['todo', 'status', '--json'])).stdout);
  const accept = (phaseId, reviewDigest) => {
    const decision = { schema: 'lattice.phase_accept_input.v1', review_event_digest: reviewDigest,
      decision_evidence: evidence, evidence_slots: [{ slot_id: 'heavy', evidence }], input_digest: '' };
    decision.input_digest = todoSelfDigest(decision, 'input_digest');
    return writeFile(path.join(root, '.lattice', 'accept.json'), `${canonicalizeTodoArtifact(decision)}\n`)
      .then(() => ok(run(root, ['todo', 'phase', 'accept', '--plan', 'main', '--phase', phaseId,
        '--input', '.lattice/accept.json'], ACTOR_ENV)));
  };
  return { root, finish, status, accept };
}

test('(d) 宣言Phase planはimplicit=falseでplan由来のslotsを出し、locked/activeは出ない', async (context) => {
  const { root, finish, status, accept } = await phasePlanWorkspace(context);

  // T1だけdoneの時点ではphase-1はまだ監査待ちに入っていない（activeであってgate_readyではない）。
  finish('T1');
  finish('T2');

  // 後続Phaseは先行がacceptedになるまで`locked`で、gate_readyにはならない。全taskがdoneでも
  // 監査待ちに出るのは先頭Phaseだけである——ここを取り違えると「2件出るはず」と読んで落ちる。
  assert.deepEqual(status().audit_pending, [{
    plan_key: 'main', phase_id: 'phase-1', phase_status: 'gate_ready', implicit: false,
    required_evidence_slots: ['heavy'],
    next_commands: [
      'lattice todo phase review --plan main --phase phase-1 --reason <text>',
      'lattice todo phase close-unaudited --plan main --phase phase-1 --reason <text>',
    ],
  }]);

  const phases = JSON.parse(ok(run(root, ['todo', 'phase', 'status', '--plan', 'main'])).stdout);
  assert.deepEqual(phases.phases.map(({ phase_id, status: phaseStatus }) => [phase_id, phaseStatus]),
    [['phase-1', 'gate_ready'], ['phase-2', 'locked']]);

  // phase-1をacceptで閉じるとphase-2がlockedから解けて監査待ちへ入れ替わる。監査待ちは
  // 「いま判断を待っている面」だけを指し、まだ到達していないPhaseを先出ししない。
  const reviewed = ok(run(root, ['todo', 'phase', 'review', '--plan', 'main', '--phase', 'phase-1',
    '--reason', '監査開始'], ACTOR_ENV));
  await accept('phase-1', JSON.parse(reviewed.stdout).event_digest);
  assert.deepEqual(status().audit_pending.map(({ phase_id, phase_status }) => [phase_id, phase_status]),
    [['phase-2', 'gate_ready']]);
});

test('(d) close-unauditedは後続Phaseを解かない——acceptだけが次の監査待ちを開く', async (context) => {
  const { root, finish, status } = await phasePlanWorkspace(context);
  finish('T1');
  finish('T2');

  // 実測した非対称。`accepted`は後続をlockedから解くが、`closed_unaudited`は解かない。
  // 「監査せず歴史として閉じる」は受入ではないので後続の前提を満たさない、という設計である。
  // 結果として、非終端Phaseをclose-unauditedで閉じたplanは後続がlockedのまま残り、
  // 監査待ちは空になる。工程を畳むなら全Phaseを畳む（`todo phase baseline`）のが正しい使い方で、
  // 途中の1つだけを閉じる操作ではない。ここを取り違えると「閉じたのに何も案内されない」に見える。
  ok(run(root, ['todo', 'phase', 'close-unaudited', '--plan', 'main', '--phase', 'phase-1',
    '--reason', '歴史として閉じる'], ACTOR_ENV));
  const phases = JSON.parse(ok(run(root, ['todo', 'phase', 'status', '--plan', 'main'])).stdout);
  assert.deepEqual(phases.phases.map(({ phase_id, status: phaseStatus }) => [phase_id, phaseStatus]),
    [['phase-1', 'closed_unaudited'], ['phase-2', 'locked']]);
  assert.deepEqual(status().audit_pending, []);
});

test('(e) 上位キーはexactで、result_digestとvalidateTodoStatusResultが応答を自証する', async (context) => {
  const { finish, status } = await workspace(context);
  await finish('audited', 'A');
  await finish('audited', 'B');

  const result = status();
  assert.deepEqual(Object.keys(result).sort(), [...STATUS_KEYS].sort());
  assert.equal(validateTodoStatusResult(result), true);
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));

  // v4形（audit_pending欠落）は受理しない。欄の欠落は「監査待ちが無い」ではなく
  // 「監査待ちを答えていない」であり、そこを空扱いにすると今回直している失念がそのまま戻る。
  const withoutAuditPending = { ...result };
  delete withoutAuditPending.audit_pending;
  assert.equal(validateTodoStatusResult(withoutAuditPending), false);
  assert.equal(validateTodoStatusResult({ ...result, audit_pending: [{ ...result.audit_pending[0], phase_status: 'accepted' }] }), false);
});
