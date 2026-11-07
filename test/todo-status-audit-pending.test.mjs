// ap03: `todo_status_result`をv5へ上げ、監査待ちPhaseを`audit_pending`欄として表出する。
//
// 直そうとしている事故は「全taskがdoneになるとstatusが空を返し、AIが正しくそれを信じて
// 完了報告する」である。したがって本testが固定するのは:
// 1. 全taskがdoneでnext_readyが空になった時、audit_pendingが埋まり次コマンドまで案内する
// 2. accepted / closed_unauditedは出ない（判断が着いた終端状態は待っていない）
// 3. Phase planではimplicit=falseでplan由来のslotsが出る（暗黙Phaseと区別できる）
// 4. **dispatchが監査状態で動かない**——task状態が同じなら next_ready と dispatch_frontier
//    （frontier_digestを含む）はbyte等価のまま、audit_pendingだけが変わる（ADR 0062・0063）
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
   createTodoStoreWriter, initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import { TODO_STATUS_SCHEMA, projectTodoStatus } from '../src/todo-status.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null });
const taskV4 = (taskId, phaseId) => ({ ...task(taskId), narrative_anchor: null, parent_task_id: null, phase_id: phaseId });

async function storeWith(context, plan) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-audit-pending-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const bytes = Buffer.from('audit evidence\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  const evidence = { evidence_id: 'audit-gate', repo_id: 'self', path: 'audit.txt', git_blob_oid: oid,
    content_digest: createHash('sha256').update(bytes).digest('hex'), media_type: 'text/plain', anchor_digest: null };
  const append = (event) => appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { actor: ACTOR, recorded_at: NOW, ...event } });
  const status = async () => projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  const finish = async (taskId) => {
    await append({ kind: 'start', task_id: taskId, payload: { override_reason: null } });
    await append({ kind: 'done', task_id: taskId, payload: { evidence } });
  };
  return { root, append, status, finish, evidence };
}

const phaselessPlan = {
  schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
  predecessor_plan_digest: null, tasks: [task('T1'), task('T2')], hard_dependencies: [], joins: [],
};

test('全taskがdoneでnext_readyが空になった時、audit_pendingが監査待ちと次コマンドを返す', async (context) => {
  const { status, finish } = await storeWith(context, phaselessPlan);

  const before = await status();
  assert.equal(before.schema, TODO_STATUS_SCHEMA);
  assert.equal(before.schema, 'lattice.todo_status_result.v7');
  assert.deepEqual(before.audit_pending, [], '未doneのtaskが残る間は監査の地点に到達していない');

  await finish('T1');
  await finish('T2');

  const after = await status();
  // ここが事故の現場である——「残作業なし」に見える状態で、監査待ちが残っている。
  assert.deepEqual(after.next_ready, []);
  assert.deepEqual(after.active_set, []);
  assert.deepEqual(after.audit_pending, [{
    plan_key: 'main',
    phase_id: 'terminal-audit',
    phase_status: 'gate_ready',
    implicit: true,
    required_evidence_slots: ['terminal-audit'],
    next_commands: [
      'lattice todo phase review --plan main --phase terminal-audit --reason <text>',
      'lattice todo phase close-unaudited --plan main --phase terminal-audit --reason <text>',
    ],
  }]);
});

test('reviewingは次コマンドを持ったまま残り、acceptedとclosed_unauditedは消える', async (context) => {
  const { append, status, finish, evidence } = await storeWith(context, phaselessPlan);
  await finish('T1');
  await finish('T2');

  const reviewed = await append({ kind: 'phase_review', phase_id: 'terminal-audit', payload: { reason: '監査開始' } });
  const reviewing = await status();
  assert.equal(reviewing.audit_pending.length, 1, '監査中はまだ判断が着いていない');
  assert.equal(reviewing.audit_pending[0].phase_status, 'reviewing');
  assert.deepEqual(reviewing.audit_pending[0].next_commands, [
    'lattice todo phase accept --plan main --phase terminal-audit --input <file>',
    'lattice todo phase reject --plan main --phase terminal-audit --input <file>',
  ]);

  await append({ kind: 'phase_accept', phase_id: 'terminal-audit',
    payload: { review_event_digest: reviewed.event.event_digest, decision_evidence: evidence,
      evidence_slots: [{ slot_id: 'terminal-audit', evidence }] } });
  assert.deepEqual((await status()).audit_pending, [], 'acceptedは待っていない');
});

test('closed_unauditedも監査待ちには出ない', async (context) => {
  const { append, status, finish } = await storeWith(context, phaselessPlan);
  await finish('T1');
  await finish('T2');
  assert.equal((await status()).audit_pending.length, 1);

  await append({ kind: 'phase_close_unaudited', phase_id: 'terminal-audit',
    payload: { reason: '監査なしで閉じる' } });
  assert.deepEqual((await status()).audit_pending, []);
});

test('Phase planはimplicit=falseでplan由来のslotsを出す', async (context) => {
  const plan = {
    schema: 'lattice.todo_plan.v4', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [taskV4('T1', 'phase-1'), taskV4('T2', 'phase-2')],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'dotagents-heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy-check'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'dotagents-heavy', predecessor_phase_ids: ['phase-1'],
        required_evidence_slots: ['heavy-check'] },
    ],
    hard_dependencies: [], joins: [],
  };
  const { status, finish } = await storeWith(context, plan);
  await finish('T1');

  const result = await status();
  assert.deepEqual(result.audit_pending, [{
    plan_key: 'main',
    phase_id: 'phase-1',
    phase_status: 'gate_ready',
    implicit: false,
    required_evidence_slots: ['heavy-check'],
    next_commands: [
      'lattice todo phase review --plan main --phase phase-1 --reason <text>',
      'lattice todo phase close-unaudited --plan main --phase phase-1 --reason <text>',
    ],
  }], 'phase-2はまだlockedで監査の地点に無い');
});

test('dispatchは監査状態で動かない——task状態が同じならnext_readyとfrontierはbyte等価', async (context) => {
  const { append, status, finish } = await storeWith(context, phaselessPlan);
  await finish('T1');
  await finish('T2');

  const gateReady = await status();
  // phase_reviewはtask状態を1つも動かさない。動くのはPhaseの監査状態だけである。
  await append({ kind: 'phase_review', phase_id: 'terminal-audit', payload: { reason: '監査開始' } });
  const reviewing = await status();

  assert.equal(JSON.stringify(reviewing.next_ready), JSON.stringify(gateReady.next_ready));
  assert.equal(JSON.stringify(reviewing.dispatch_frontier), JSON.stringify(gateReady.dispatch_frontier));
  assert.equal(reviewing.dispatch_frontier.frontier_digest, gateReady.dispatch_frontier.frontier_digest);
  assert.equal(JSON.stringify(reviewing.active_set), JSON.stringify(gateReady.active_set));
  assert.equal(JSON.stringify(reviewing.blocked), JSON.stringify(gateReady.blocked));
  // 変わったのは監査欄だけ。
  assert.notEqual(reviewing.audit_pending[0].phase_status, gateReady.audit_pending[0].phase_status);
});

test('未doneのtaskが残る間もfrontierは監査欄の有無に影響されない', async (context) => {
  const { status, finish } = await storeWith(context, phaselessPlan);
  const initial = await status();
  assert.deepEqual(initial.next_ready.map(({ task_id: id }) => id), ['T1', 'T2']);
  assert.deepEqual(initial.audit_pending, []);

  await finish('T1');
  const partial = await status();
  assert.deepEqual(partial.next_ready.map(({ task_id: id }) => id), ['T2']);
  assert.deepEqual(partial.audit_pending, [], 'pending taskが残る限りPhaseはactiveで監査待ちではない');
  assert.equal(partial.dispatch_frontier.recommended_parallelism, 1);
});
