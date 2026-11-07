// ADR 0148裁定6・7: 一括宣言`phase baseline`。104件を1件ずつ宣言させる設計は誰にも
// 実行されずgateをノイズへ変えるため、現在gate_readyかつphase eventを1つも持たないPhaseを
// まとめてclosed_unauditedへ宣言する明示コマンドを持つ。自動実行はしない(読み取り時に
// 勝手に書く経路を作らない)。
//
// 本testが固定するのは:
// 1. 対象の選定が正しい(gate_ready かつ phase eventゼロ、だけを拾う)
// 2. --exceptで指定したplanは書かず`excluded`へ回る
// 3. 既にaccepted等の対象外は書き換えられず、`not_applicable`として区別される
// 4. 未知のplan_keyを--exceptに渡すとtypedに拒否され、何も書かない
// 5. dispatch(next_ready/active_set/dispatch_frontier)へ影響しない
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TodoStoreError, buildTodoPlan, createTodoStoreWriter,
  initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import { projectTodoStatus } from '../src/todo-status.mjs';
import { runTodoCli } from '../src/todo-cli.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ACTOR_ENV = Object.freeze({
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
  LATTICE_DASHBOARD_AUTOSTART: '0',
});

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null });
const ref = (taskId, planKey) => ({ project_id: 'project-1', plan_key: planKey, task_id: taskId });

function evidenceFor(root, label) {
  const bytes = Buffer.from(`${label} evidence\n`);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  return { evidence_id: label, repo_id: 'self', path: `${label}.txt`,
    git_blob_oid: oid, content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
}

async function singleTaskPlan(root, writer, planKey, { doneAt = true } = {}) {
  if (doneAt) {
    await appendTodoEvent({ repoRoot: root, writer, planKey, now: NOW,
      event: { kind: 'start', task_id: 'X', actor: ACTOR, recorded_at: NOW,
        payload: { override_reason: null } } });
    await appendTodoEvent({ repoRoot: root, writer, planKey, now: NOW,
      event: { kind: 'done', task_id: 'X', actor: ACTOR, recorded_at: NOW,
        payload: { evidence: evidenceFor(root, `${planKey}-x`) } } });
  }
}

/**
 * 5 planを持つstore(全てphase無し・v3、terminal-audit Phaseのみ):
 * - planA: 全task done・gate_ready・phase event無し -> baselineの対象
 * - planB: 全task done・既にreview->acceptを経てaccepted -> 対象外(既に監査済み)
 * - planC: 全task done・review->reopenでgate_readyへ戻ったが、phase eventは既にある -> 対象外
 * - planD: taskがまだpending(not_gate_ready) -> 対象外
 * - planE: planAと同条件(gate_ready・phase event無し) -> --exceptの対象
 * - working: 独立task Pが常にpending -> dispatch非干渉の対照plan
 */
async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-baseline-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const plan = (planKey, tasks = [task('X')], hardDependencies = []) => buildTodoPlan({
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: planKey, plan_version: 'v1',
    predecessor_plan_digest: null, tasks, hard_dependencies: hardDependencies, joins: [],
  });
  const planD = plan('planD', [task('X'), task('Y')]);
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: plan('planA'), genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('planB'), genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('planC'), genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: planD, genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('planE'), genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('working', [task('P')]), genesis: { actor: ACTOR, recorded_at: NOW } },
    ], now: NOW,
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await singleTaskPlan(root, writer, 'planA');
  await singleTaskPlan(root, writer, 'planB');
  await singleTaskPlan(root, writer, 'planC');
  await singleTaskPlan(root, writer, 'planE');
  // planD: Xだけdone、Yはpendingのまま(not_gate_ready)。
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'planD', now: NOW,
    event: { kind: 'start', task_id: 'X', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'planD', now: NOW,
    event: { kind: 'done', task_id: 'X', actor: ACTOR, recorded_at: NOW,
      payload: { evidence: evidenceFor(root, 'plan-d-x') } } });

  // planB: review -> accept(既に監査済み)。
  const reviewedB = await appendTodoEvent({ repoRoot: root, writer, planKey: 'planB', now: NOW,
    event: { kind: 'phase_review', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '通常監査' } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'planB', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewedB.event.event_digest,
        decision_evidence: evidenceFor(root, 'plan-b-decision'),
        evidence_slots: [{ slot_id: 'terminal-audit', evidence: evidenceFor(root, 'plan-b-slot') }] } } });

  // planC: review -> reject -> reopen(構造的にはgate_readyへ戻るが、phase eventは既に持つ)。
  // reopenはaccepted/rejected/closed_unauditedからしか通らないため、reviewingのまま直接
  // reopenはできない——rejectを経由させる。
  const reviewedC = await appendTodoEvent({ repoRoot: root, writer, planKey: 'planC', now: NOW,
    event: { kind: 'phase_review', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '着手したが通らなかった監査' } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'planC', now: NOW,
    event: { kind: 'phase_reject', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewedC.event.event_digest, reason: '差し戻し',
        decision_evidence: evidenceFor(root, 'plan-c-decision') } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'planC', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '再監査予定', override_reason: null } } });

  return root;
}

function findEntry(list, planKey) {
  return list.find((entry) => entry.plan_key === planKey);
}

test('phase baselineは未知のplan_keyを--exceptに渡すとtypedに拒否し、何も書かない', async (t) => {
  const root = await workspace(t);
  const before = await readTodoStore({ repoRoot: root, now: NOW });
  const stdout = []; const stderr = [];
  const exitCode = await runTodoCli({
    argv: ['phase', 'baseline', '--reason', '基準線', '--except', 'no-such-plan'],
    cwd: root, env: ACTOR_ENV,
    stdout: { write: (text) => stdout.push(text) }, stderr: { write: (text) => stderr.push(text) },
  });
  assert.equal(exitCode, 1);
  const error = JSON.parse(stderr.join(''));
  assert.equal(error.code, 'PHASE_BASELINE_INVALID');
  assert.deepEqual(error.detail.unknown_plan_keys, ['no-such-plan']);
  const after = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(before.members.map((member) => member.journal.events.length),
    after.members.map((member) => member.journal.events.length));
});

test('phase baselineは対象を正しく選び、--exceptが効き、既にaccepted等を書き換えない', async (t) => {
  const root = await workspace(t);
  const stdout = [];
  const exitCode = await runTodoCli({
    argv: ['phase', 'baseline', '--reason', '過去分の基準線', '--except', 'planE'],
    cwd: root, env: ACTOR_ENV,
    stdout: { write: (text) => stdout.push(text) }, stderr: { write: () => {} },
  });
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout.join(''));

  assert.deepEqual(result.applied.map(({ plan_key }) => plan_key), ['planA']);
  assert.deepEqual(result.excluded.map(({ plan_key }) => plan_key), ['planE']);
  assert.equal(findEntry(result.excluded, 'planE').cause, 'excepted');
  assert.equal(findEntry(result.not_applicable, 'planB').cause, 'already_accepted');
  assert.equal(findEntry(result.not_applicable, 'planC').cause, 'already_has_phase_event');
  assert.equal(findEntry(result.not_applicable, 'planD').cause, 'not_gate_ready');
  assert.deepEqual(result.failed, []);

  // planAは実際にclosed_unauditedへ書かれている。CLI(runTodoCli)経由の書込みは実時刻を使うため、
  // 以降の読み出しは固定NOW(過去日時)でなく既定(実時刻)で読む——固定NOWのままだと、実時刻で
  // 書かれたeventがそれより「未来」に見えてfuture_clock_skewになる。
  const store = await readTodoStore({ repoRoot: root });
  const planA = store.members.find(({ descriptor }) => descriptor.plan_key === 'planA');
  assert.equal(planA.phases[0].status, 'closed_unaudited');
  // planEはexceptで除外されたので、baseline前と変わらずgate_readyのまま。
  const planE = store.members.find(({ descriptor }) => descriptor.plan_key === 'planE');
  assert.equal(planE.phases[0].status, 'gate_ready');
  // planB(既にaccepted)は書き換えられていない。
  const planB = store.members.find(({ descriptor }) => descriptor.plan_key === 'planB');
  assert.equal(planB.phases[0].status, 'accepted');
  // planC(review->reopenで構造上gate_readyへ戻ったが既にphase eventを持つ)も書き換えられていない。
  const planC = store.members.find(({ descriptor }) => descriptor.plan_key === 'planC');
  assert.equal(planC.phases[0].status, 'gate_ready');

  // 再度baselineを--except無しで打つと、今度はplanEが拾われ、既にclosed_unauditedのplanAは
  // 対象外(already_has_phase_event)になる——宣言はべき等な選定であり、二重書込みしない。
  const secondStdout = [];
  const secondExit = await runTodoCli({
    argv: ['phase', 'baseline', '--reason', '2回目'],
    cwd: root, env: ACTOR_ENV,
    stdout: { write: (text) => secondStdout.push(text) }, stderr: { write: () => {} },
  });
  assert.equal(secondExit, 0);
  const secondResult = JSON.parse(secondStdout.join(''));
  assert.deepEqual(secondResult.applied.map(({ plan_key }) => plan_key), ['planE']);
  assert.equal(findEntry(secondResult.not_applicable, 'planA').cause, 'already_closed_unaudited');
});

test('phase baselineはToDoのdispatch(next_ready/active_set/dispatch_frontier)へ影響しない', async (t) => {
  const root = await workspace(t);
  const before = projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  const workingBefore = {
    next_ready: before.next_ready.filter((entry) => entry.plan_key === 'working'),
    active_set: before.active_set.filter((entry) => entry.plan_key === 'working'),
    recommended_parallelism: before.dispatch_frontier.recommended_parallelism,
  };
  await runTodoCli({
    argv: ['phase', 'baseline', '--reason', '過去分の基準線'],
    cwd: root, env: ACTOR_ENV, stdout: { write: () => {} }, stderr: { write: () => {} },
  });
  // CLI経由の書込みは実時刻を使うため、書込み後の読み出しは固定NOWでなく既定(実時刻)で読む。
  const after = projectTodoStatus(await readTodoStore({ repoRoot: root }), { parallelCandidates: [], planNotes: [] });
  const workingAfter = {
    next_ready: after.next_ready.filter((entry) => entry.plan_key === 'working'),
    active_set: after.active_set.filter((entry) => entry.plan_key === 'working'),
    recommended_parallelism: after.dispatch_frontier.recommended_parallelism,
  };
  assert.deepEqual(workingAfter, workingBefore);
});

test('phase baselineのCLI引数解析: --exceptは0回以上繰り返せ、不正な並びはusageFailureになる', async (t) => {
  const root = await workspace(t);
  const okStdout = [];
  const ok = await runTodoCli({
    argv: ['phase', 'baseline', '--reason', 'r', '--except', 'planE', '--except', 'planB'],
    cwd: root, env: ACTOR_ENV,
    stdout: { write: (text) => okStdout.push(text) }, stderr: { write: () => {} },
  });
  assert.equal(ok, 0);
  assert.deepEqual(JSON.parse(okStdout.join('')).except_plan_keys, ['planB', 'planE']);

  // --exceptの値を欠く(奇数個)と、TodoStoreErrorではなくusageFailure(exit 2)になる
  // ——argv解析の時点で弾かれ、storeへは一切触れない。
  const stderr = [];
  const badExit = await runTodoCli({
    argv: ['phase', 'baseline', '--reason', 'r', '--except'],
    cwd: root, env: ACTOR_ENV, stdout: { write: () => {} }, stderr: { write: (text) => stderr.push(text) },
  });
  assert.equal(badExit, 2);
});
