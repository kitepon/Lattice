// ob03: 調整方式（witness検証で並列する／会話で調整する）の起票時宣言。
//
// witnessが全planの暗黙義務だった時、「誰がやるか」が誰にも属さなかった。だから
// `coverage: missing` の案内は文言まで正確だったのに、8件のToDo全部で素通りされた
// （前campaign room [96] #3）。是正は督促を強めることではなく、**帰属を作る**ことである
// （オーナー裁定C①）。
//
// 本testが固定するのは:
// 1. 宣言がjournal eventとしてstoreへ残り、actorが「誰が選んだか」を持つ
// 2. 宣言はplanへ帰属する——taskにもPhaseにも属さない（task_idもphase_idもnull）
// 3. 最後の宣言が現在の方式で、宣言し直せる
// 4. **宣言の有無・内容はdispatchを変えない**（ADR 0160・ob04のProtected behavior）
// 5. 案内が方式で変わる: 未宣言→方式を選ぶ／conversation→督促しない／witness→未compileを督促
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TODO_COORDINATION_MODES } from '../src/todo-contracts.mjs';
import {
   createTodoStoreWriter, initializeTodoStore, projectTodoCoordination, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import {
  pullIntakeReadinessGuidance,
  selectIndependenceGuidance,
} from '../src/todo-independence-guidance.mjs';

const NOW = '2026-07-26T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const OTHER = Object.freeze({ host: 'host-2', session: 'session-2', agent: 'agent-2' });
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-coordination-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [task('T1'), task('T2')], hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }], now: NOW,
  });
  const declare = (mode, reason, actor = ACTOR) => appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'main', now: NOW,
    event: { kind: 'coordination_mode', actor, recorded_at: NOW, payload: { mode, reason } },
  });
  const read = () => readTodoStore({ repoRoot: root, now: NOW });
  return { root, declare, read };
}

test('宣言はstoreへ残り、誰が選んだかを持つ', async (context) => {
  const { declare, read } = await workspace(context);

  // 未宣言は「witnessで行く」でも「会話で行く」でもなく、まだ選んでいない。
  assert.equal((await read()).members[0].coordination, null);

  await declare('conversation', '円卓の会話で調整する');
  const coordination = (await read()).members[0].coordination;
  assert.equal(coordination.mode, 'conversation');
  assert.equal(coordination.reason, '円卓の会話で調整する');
  // 帰属が本体である。witnessが暗黙義務だった時に無かったのがこれで、
  // ここを落とすとこの機構は「もう1つの督促」に戻る。
  assert.deepEqual(coordination.declared_by, ACTOR);
  assert.equal(coordination.declared_at, NOW);
});

test('宣言はplanへ帰属する——taskにもPhaseにも属さない', async (context) => {
  const { declare, read } = await workspace(context);
  const { event } = await declare('witness', '独立性を宣言して並列する');

  assert.equal(event.kind, 'coordination_mode');
  assert.equal(event.task_id, null, 'taskに属さない');
  assert.equal(event.phase_id ?? null, null, 'Phaseにも属さない');
  assert.equal(event.plan_key, 'main');

  // task状態はどれも動いていない。宣言はlifecycleではない。
  const { tasks } = (await read()).members[0];
  assert.deepEqual(tasks.map(({ status }) => status), ['pending', 'pending']);
});

test('宣言し直せる。現在の方式は最後の宣言である', async (context) => {
  const { declare, read } = await workspace(context);
  await declare('witness', 'まずwitnessで行く');
  await declare('conversation', '境界が読めないので会話へ切り替える', OTHER);

  const coordination = (await read()).members[0].coordination;
  assert.equal(coordination.mode, 'conversation');
  assert.equal(coordination.reason, '境界が読めないので会話へ切り替える');
  // 切り替えた人が帰属を持つ。前の宣言者のままにすると、誰が今の方式を選んだかが嘘になる。
  assert.deepEqual(coordination.declared_by, OTHER);
});

test('宣言はdispatchを変えない', async (context) => {
  const { declare, read } = await workspace(context);
  const { projectTodoStatus } = await import('../src/todo-status.mjs');
  const dispatchFacing = (status) => JSON.stringify({
    active_set: status.active_set, next_ready: status.next_ready,
    blocked: status.blocked, dispatch_frontier: status.dispatch_frontier,
  });

  const before = projectTodoStatus(await read(), { parallelCandidates: [], planNotes: [] });
  await declare('conversation', '会話で調整する');
  const afterConversation = projectTodoStatus(await read(), { parallelCandidates: [], planNotes: [] });
  await declare('witness', 'やはり宣言して並列する');
  const afterWitness = projectTodoStatus(await read(), { parallelCandidates: [], planNotes: [] });

  // 未宣言→conversation→witness と動かしても、dispatch面は1バイトも動かない。
  assert.equal(dispatchFacing(afterConversation), dispatchFacing(before));
  assert.equal(dispatchFacing(afterWitness), dispatchFacing(before));
  // リテラルでも固定する（両側が同時に壊れた時に通る形を避ける）。
  assert.deepEqual(before.next_ready.map(({ task_id: id }) => id), ['T1', 'T2']);
});

test('案内は方式で変わる——未宣言は督促でなく選択を指す', async (context) => {
  const base = { coverage: 'missing', taskDeclared: false, taskStale: false };

  // 未宣言: 「witness setを宣言しろ」ではなく「どちらで行くか選べ」。誰の受入条件でもない
  // 作業を指す督促が、8件で素通りされた当のものである。
  const undeclared = selectIndependenceGuidance({ ...base, coordinationMode: null });
  assert.equal(undeclared.code, 'coordination_mode_undeclared');
  assert.equal(undeclared.next_action, 'declare_coordination_mode');

  // conversation: 選択を尊重して督促しない。
  const conversation = selectIndependenceGuidance({ ...base, coordinationMode: 'conversation' });
  assert.equal(conversation.code, 'coordination_conversation');
  assert.equal(conversation.next_action, 'none');

  // witness: 未compileが一級で出る。督促が出るのは選んだplanだけ。
  const witness = selectIndependenceGuidance({ ...base, coordinationMode: 'witness' });
  assert.equal(witness.code, 'independence_unrecorded');
  assert.equal(witness.next_action, 'declare_witness_set_then_compile');

  // 既定は witness。宣言を渡さない既存の呼び出し側の挙動を変えない。
  assert.deepEqual(selectIndependenceGuidance(base), witness);
});

test('conversationの一般案内は督促せず、pull設備だけがindependence前提を返す', () => {
  const general = selectIndependenceGuidance({
    coverage: 'missing', taskDeclared: false, taskStale: false,
    coordinationMode: 'conversation',
  });
  assert.equal(general.next_action, 'none');

  const required = pullIntakeReadinessGuidance({
    coordinationMode: 'conversation', ready: false,
  });
  assert.deepEqual(
    [required.code, required.plan_binding_ready,
      required.coordination_mode, required.next_action],
    ['pull_independence_required', false, 'conversation',
      'compile_independence_or_choose_non_pull_execution'],
  );

  const ready = pullIntakeReadinessGuidance({
    coordinationMode: 'conversation', ready: true,
  });
  assert.deepEqual(
    [ready.code, ready.plan_binding_ready, ready.coordination_mode, ready.next_action],
    ['pull_independence_ready', true, 'conversation', 'none'],
  );
});

test('方式は2値で、壊れた宣言はstoreへ入らない', async (context) => {
  const { declare } = await workspace(context);
  assert.deepEqual([...TODO_COORDINATION_MODES], ['witness', 'conversation']);

  for (const invalid of ['auto', '', 'WITNESS', null]) {
    await assert.rejects(() => declare(invalid, '理由'), /declared schema/u);
  }
  // 理由は必須。何を選んだかだけでは、後から読む人が判断を再構成できない。
  await assert.rejects(() => declare('witness', null), /declared schema/u);
});

test('statusのcoordination欄は宣言済みplanだけを列挙する', async (context) => {
  const { declare, read } = await workspace(context);
  const { projectTodoStatus } = await import('../src/todo-status.mjs');

  // 未宣言は載せない。全plan分をmode:nullで出すと、plan数ぶん常に埋まって読み飛ばされる
  // 列になる（前campaignでaudit_pendingの設計時に避けた形）。
  const before = projectTodoStatus(await read(), { parallelCandidates: [], planNotes: [] });
  assert.equal(before.schema, 'lattice.todo_status_result.v9');
  assert.deepEqual(before.coordination, []);
  assert.deepEqual(before.member_heads.map(({ plan_key: key }) => key), ['main'],
    '未宣言はmember_headsに居てcoordinationに居ない、で引ける');

  await declare('conversation', '円卓の会話で調整する');
  const after = projectTodoStatus(await read(), { parallelCandidates: [], planNotes: [] });
  assert.deepEqual(after.coordination, [{
    plan_key: 'main',
    mode: 'conversation',
    declared_by: ACTOR,
    declared_at: NOW,
    reason: '円卓の会話で調整する',
  }]);
  // 上位キーの並びは合意どおり（監査待ち→構造finalization待ち→note→coordination）。
  assert.deepEqual(Object.keys(after), [
    'schema', 'project_id', 'active_set', 'next_ready', 'dispatch_frontier',
    'blocked', 'audit_pending', 'structure_finalization_pending', 'plan_notes',
    'coordination', 'parallel_candidates', 'cross_plan_findings',
    'member_heads', 'truncated', 'result_digest',
  ]);
});

test('宣言はlifecycle journalへ混ざらず、別chainへ積まれる', async (context) => {
  const { declare, read } = await workspace(context);
  const member = async () => (await read()).members[0];

  const before = await member();
  assert.deepEqual(before.plan_scoped.events, [], '未宣言のchainは空');
  assert.equal(before.plan_scoped.ref, '.lattice/todo/plans/main/v1/journal/plan-scoped.jsonl');

  await declare('witness', '宣言して並列する');
  const after = await member();

  // 宣言はplan-scoped chainにだけ在る。lifecycle journalは1バイトも増えていない。
  assert.equal(after.plan_scoped.events.length, 1);
  assert.equal(after.plan_scoped.events[0].kind, 'coordination_mode');
  assert.equal(after.plan_scoped.events[0].sequence, 0, 'chainの先頭はsequence 0');
  assert.equal(after.journal.activeBytes.length, before.journal.activeBytes.length);
  assert.deepEqual(after.journal.events.map(({ kind }) => kind), before.journal.events.map(({ kind }) => kind));

  // member_headsが指すのはtask chainのまま——方式を選んだだけでlifecycleは進まない。
  assert.equal(after.journal.events.at(-1).event_digest, before.journal.events.at(-1).event_digest);

  assert.equal(projectTodoCoordination(after.plan_scoped.events).mode, 'witness');
  assert.equal(projectTodoCoordination(after.journal.events), null, 'journal側には宣言が無い');
});
