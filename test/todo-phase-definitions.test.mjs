// ap01: 終端監査Phaseの定義(required_evidence_slots)はterminalAuditPhase()の中だけに在り、
// store外から読めなかった。todo-status側が「終端監査が何を要求するか」を再導出すると定義が
// 二重化するため、todoPhaseDefinitions()として1つの正本を公開する。
//
// 本testが固定するのは:
// 1. phase無しplan(v1/v2/v3)へ渡すと暗黙のterminal-audit Phase定義がslots込みで返る
// 2. plan.schema・plan.phasesを持たないsynthetic read modelでも壊れず同じ定義を返す(全域性)
// 3. Phase planでは合成せずplan.phasesをそのまま返す
// 4. 返ったslotsが、実storeの終端監査gateが実際に要求するslotと一致する(定義が二重化していない)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TERMINAL_AUDIT_PHASE_ID, TodoStoreError, createTodoStoreWriter,
  initializeTodoStore, todoPhaseDefinitions,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null });

const phaselessPlan = {
  schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
  predecessor_plan_digest: null, tasks: [task('T1')], hard_dependencies: [], joins: [],
};

const TERMINAL_AUDIT_DEFINITION = {
  phase_id: TERMINAL_AUDIT_PHASE_ID, title: '終端重監査', gate_policy: 'terminal-audit',
  predecessor_phase_ids: [], required_evidence_slots: ['terminal-audit'],
};

test('phase無しplanへ渡すと暗黙のterminal-audit Phase定義がslots込みで返る', () => {
  for (const schema of ['lattice.todo_plan.v1', 'lattice.todo_plan.v2', 'lattice.todo_plan.v3']) {
    assert.deepEqual(todoPhaseDefinitions({ ...phaselessPlan, schema }), [TERMINAL_AUDIT_DEFINITION]);
  }
});

test('schema・phasesを持たないsynthetic read modelでも同じ定義を返す(全域性)', () => {
  // todo-status側のtestはplan相当の最小オブジェクトを組む。schema未定義はphaselessと判定され、
  // 存在しないplan.phasesを読みに行かないことをここで固定する。
  assert.deepEqual(todoPhaseDefinitions({}), [TERMINAL_AUDIT_DEFINITION]);
  assert.deepEqual(todoPhaseDefinitions({ tasks: [] }), [TERMINAL_AUDIT_DEFINITION]);
});

test('Phase planでは合成せずplan.phasesをそのまま返す', () => {
  const phases = [
    { phase_id: 'phase-1', title: '設計', gate_policy: 'dotagents-heavy', predecessor_phase_ids: [],
      required_evidence_slots: ['heavy-check'] },
    { phase_id: 'phase-2', title: '実装', gate_policy: 'dotagents-heavy', predecessor_phase_ids: ['phase-1'],
      required_evidence_slots: ['heavy-check'] },
  ];
  for (const schema of ['lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7']) {
    assert.deepEqual(todoPhaseDefinitions({ ...phaselessPlan, schema, phases }), phases);
  }
});

test('返ったslotsは実storeの終端監査gateが実際に要求するslotと一致する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-definitions-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: phaselessPlan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const append = (event) => appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { actor: ACTOR, recorded_at: NOW, ...event } });

  const bytes = Buffer.from('terminal audit evidence\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  const evidence = { evidence_id: 'terminal-audit-gate', repo_id: 'self', path: 'audit.txt',
    git_blob_oid: oid, content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };

  await append({ kind: 'start', task_id: 'T1', payload: { override_reason: null } });
  await append({ kind: 'done', task_id: 'T1', payload: { evidence } });

  const [definition] = todoPhaseDefinitions(phaselessPlan);
  const reviewed = await append({ kind: 'phase_review', phase_id: definition.phase_id,
    payload: { reason: '終端監査を開始' } });

  // 宣言と違うslotで閉じようとするとgateは拒否する——gateが見ている定義が別物なら、この
  // 拒否と次のacceptの成否が逆になる。
  const wrong = await append({ kind: 'phase_accept', phase_id: definition.phase_id,
    payload: { review_event_digest: reviewed.event.event_digest, decision_evidence: evidence,
      evidence_slots: [{ slot_id: 'not-the-declared-slot', evidence }] } }).then(() => null, (error) => error);
  assert.ok(wrong instanceof TodoStoreError);
  assert.equal(wrong.detail.reason, 'phase_accept_binding_invalid');

  const accepted = await append({ kind: 'phase_accept', phase_id: definition.phase_id,
    payload: { review_event_digest: reviewed.event.event_digest, decision_evidence: evidence,
      evidence_slots: definition.required_evidence_slots.map((slotId) => ({ slot_id: slotId, evidence })) } });
  // phase無しplanのsnapshot artifact(v1/v2)はphases欄を持たない。導出ビューは別途返る側にある。
  assert.equal(accepted.phases.find(({ phase_id }) => phase_id === definition.phase_id).status, 'accepted');
});
