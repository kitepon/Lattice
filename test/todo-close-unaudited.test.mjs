// ADR 0148: 監査していない歴史は「監査なしで閉じた」として閉じる——監査済みに化けさせない。
// 0.36.0で入れた終端監査gate(ADR 0147)は、過去に終わった工程まで「監査待ち」にしてしまう
// 欠陥を持っていた。本testが固定するのは:
//
// 1. closed_unauditedはacceptedと機械的に区別され、phase_accept_dependenciesを解錠しない
//    (裁定2。ここが核心)
// 2. gate_readyでないPhaseへのclose-unauditedはtypedに拒否される(裁定3)
// 3. 理由なしのclose-unauditedは拒否される(裁定1)
// 4. phase_reopenはclosed_unauditedも初期状態へ戻す(裁定5)
// 5. closed_unauditedのplanは工程図で畳まれる——監査待ちの札が外れる(裁定4)
// 6. 終端監査gateと同じく、closed_unauditedもToDoのdispatch可否へ一切影響しない(ADR 0147裁定5)
// 7. gate_readyのadvisory/phase statusには、次に打つコマンドが2択でtypedに載る(裁定8)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  TodoStoreError, buildTodoPlan, createTodoStoreWriter,
  initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import { renderTodoGanttForProject } from '../src/todo-cli.mjs';
import { projectTodoStatus } from '../src/todo-status.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ACTOR_ENV = Object.freeze({
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
});
const run = (root, args, env = {}) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: root, encoding: 'utf8', env: {
    ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0', ...env,
  } });

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null });
const taskV4 = (taskId, phaseId) => ({ ...task(taskId), phase_id: phaseId });
const ref = (taskId, planKey = 'audited') => ({ project_id: 'project-1', plan_key: planKey, task_id: taskId });

async function expectCode(promise, code, reason) {
  await assert.rejects(promise, (error) => error instanceof TodoStoreError
    && error.code === code && (reason === undefined || error.detail.reason === reason));
}

function evidenceFor(root, label) {
  const bytes = Buffer.from(`${label} evidence\n`);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  return { evidence_id: label, repo_id: 'self', path: `${label}.txt`,
    git_blob_oid: oid, content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
}

async function evidenceFile(root, name) {
  const fileRef = `${name}.txt`;
  const bytes = Buffer.from(`${name}\n`, 'utf8');
  await writeFile(path.join(root, fileRef), bytes);
  const oid = execFileSync('git', ['hash-object', '-w', fileRef], { cwd: root, encoding: 'utf8' }).trim();
  const descriptor = { evidence_id: name, repo_id: 'self', path: fileRef, git_blob_oid: oid,
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
  const descriptorRef = `${name}.json`;
  await writeFile(path.join(root, descriptorRef), `${JSON.stringify(descriptor)}\n`);
  return descriptorRef;
}

/**
 * 2 planを持つphase無しstore(todo-terminal-audit.test.mjsと同じ構図):
 * - `audited`(phase無し・v3): A -> C の依存を持つ3 taskで、全doneのあと終端監査を経る対象
 * - `working`(phase無し・v3): 独立task Pだけを持ち、ずっとpendingのまま——dispatch非干渉の対照plan
 */
async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-close-unaudited-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const audited = buildTodoPlan({ schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'audited', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [task('A'), task('B'), task('C')],
    hard_dependencies: [{ from: ref('A'), to: ref('C') }], joins: [] });
  const working = buildTodoPlan({ schema: 'lattice.todo_plan.v3', project_id: 'project-1',
    plan_key: 'working', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [task('P')], hard_dependencies: [], joins: [] });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: audited, genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: working, genesis: { actor: ACTOR, recorded_at: NOW } },
    ], now: NOW,
  });
  return root;
}

async function doTask(root, writer, taskId, evidence) {
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'start', task_id: taskId, actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'done', task_id: taskId, actor: ACTOR, recorded_at: NOW,
      payload: { evidence } } });
}

function workingSlice(status) {
  return {
    next_ready: status.next_ready.filter((entry) => entry.plan_key === 'working'),
    active_set: status.active_set.filter((entry) => entry.plan_key === 'working'),
    recommended_parallelism: status.dispatch_frontier.recommended_parallelism,
  };
}

test('gate_readyでないPhaseへのclose-unauditedはtypedに拒否される', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  // Aだけdone。B/Cが残っているのでterminal-auditはまだ'active'。
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'まだ早い' } } }),
  'STORE_INCONSISTENT', 'phase_gate_not_ready');
});

test('理由なしのclose-unauditedは拒否される', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));
  // reason: null はnullableTextを満たすが、validPayloadは`payload.reason !== null`も要求する
  // (ADR 0148裁定1: 理由は必須)。よってnextEventの契約検証がTypeErrorで落ちる。
  await assert.rejects(appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: null } } }), TypeError);
  // 空文字もnullableTextのlength>0を満たさず同様に拒否される。
  await assert.rejects(appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '' } } }), TypeError);
  // CLI入口でも--reasonを欠くと引数解析自体が失敗する(usageFailure、exit 2)。
  const missingReason = run(root, ['todo', 'phase', 'close-unaudited', '--plan', 'audited',
    '--phase', 'terminal-audit'], ACTOR_ENV);
  assert.equal(missingReason.status, 2);
});

test('closed_unauditedはacceptedと機械的に区別され、gantt上は畳まれ、phase_reopenで初期状態へ戻る', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));

  const closed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '過去分・監査対象のコードは既に変化しているため監査しない' } } });
  assert.equal(closed.phases[0].status, 'closed_unaudited');
  // acceptedと違う専用状態であり、'accepted'という文字列に丸められていないことを直接確認する。
  assert.notEqual(closed.phases[0].status, 'accepted');

  const phaseStatusResult = JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'audited']).stdout);
  assert.equal(phaseStatusResult.phases[0].status, 'closed_unaudited');
  // gate_readyの時に付くguidanceは、closed_unaudited到達後は付かない(二重案内しない)。
  assert.equal(phaseStatusResult.phases[0].guidance, null);

  // ADR 0148裁定4: closed_unauditedはAUDIT_PENDING_PHASE_STATUSESに含まれないため、
  // gate_ready/reviewing/rejectedと違って工程図では通常どおり畳まれる。
  const live = await renderTodoGanttForProject({ repoRoot: root, scope: 'live' });
  assert.equal(live.metadata.folded_task_count, 3);

  // ADR 0148裁定5: phase_reopenはclosed_unauditedも初期状態(gate_ready・digest類null)へ戻す。
  const reopened = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '本当に監査したくなった', override_reason: null } } });
  assert.equal(reopened.phases[0].status, 'gate_ready');
  assert.equal(reopened.phases[0].review_event_digest, null);
  assert.equal(reopened.phases[0].decision_event_digest, null);
  assert.equal(reopened.phases[0].decision_evidence, null);

  // reopen後は再びreview→acceptの通常経路が普通に通ることを確認する(締め出されていない)。
  const reviewed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_review', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '本当の重監査' } } });
  const accepted = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewed.event.event_digest,
        decision_evidence: evidenceFor(root, 'decision'),
        evidence_slots: [{ slot_id: 'terminal-audit', evidence: evidenceFor(root, 'slot') }] } } });
  assert.equal(accepted.phases[0].status, 'accepted');
});

test('closed_unauditedの後のtask単独reopenは通り、phaseの記録は残ったまま受入が古いと示される（u03 A15）', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));

  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '過去分は監査しない' } } });

  // 旧: task_reopen_requires_phase_reopenで拒否していた。task単独reopenは利用者の変更なので通す。
  // phaseの決定は記録のまま残り(closed_unaudited)、taskだけがin-progressへ戻る。
  const reopened = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'reopen', task_id: 'C', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '直す', override_reason: null } } });
  const taskC = reopened.snapshot.tasks.find(({ task_id }) => task_id === 'C');
  assert.equal(taskC.status, 'in-progress');
  assert.equal(reopened.phases[0].status, 'closed_unaudited');

  // 対比: phase_reopenを先に打つ従来の経路も通る。
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '本当に直す', override_reason: null } } });
});

test('acceptedのphaseでtaskをreopenするとadvisoryとphase statusのacceptance_staleが立ち、受入し直すと消える（u03 A15）', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));
  const phaseEntry = () => JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'audited'], ACTOR_ENV)
    .stdout).phases[0];
  const review = () => appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_review', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '監査' } } });
  const accept = async (label) => {
    const reviewed = await review();
    return appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
      event: { kind: 'phase_accept', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
        payload: { review_event_digest: reviewed.event.event_digest,
          decision_evidence: evidenceFor(root, `decision-${label}`),
          evidence_slots: [{ slot_id: 'terminal-audit', evidence: evidenceFor(root, `slot-${label}`) }] } } });
  };
  await accept('1');
  assert.equal(phaseEntry().status, 'accepted');
  assert.equal(phaseEntry().acceptance_stale, false);

  const reopen = run(root, ['todo', 'reopen', '--plan', 'audited', '--task', 'C', '--reason', '受入後に直す'], ACTOR_ENV);
  assert.equal(reopen.status, 0, reopen.stderr);
  const result = JSON.parse(reopen.stdout);
  assert.equal(result.status, 'in-progress');
  assert.equal(result.advisory.phase_acceptance_stale, true);
  assert.equal(result.advisory.phase_id, 'terminal-audit');
  assert.equal(result.advisory.status, 'accepted');
  assert.match(result.advisory.guidance, /todo phase reopen --plan audited --phase terminal-audit/u);
  const stale = phaseEntry();
  assert.equal(stale.status, 'accepted');
  assert.equal(stale.acceptance_stale, true);
  assert.match(stale.guidance, /todo phase reopen --plan audited --phase terminal-audit/u);

  // 自分で抜ける: phase reopen → taskを終える → review → accept で新しい決定が記録され、旗が消える。
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_reopen', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '受け直す', override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'done', task_id: 'C', actor: ACTOR, recorded_at: NOW,
      payload: { evidence: evidenceFor(root, 'c2') } } });
  await accept('2');
  assert.equal(phaseEntry().status, 'accepted');
  assert.equal(phaseEntry().acceptance_stale, false);
});

test('closed_unauditedはphase_accept_dependenciesを解錠しない(ADR 0148裁定2。ここが核心)', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-close-unaudited-v5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  // phase-1がT3の前提(phase_accept_dependencies)。acceptedだけが解錠する経路であり、
  // closed_unauditedはこの解錠には数えない。
  const plan = buildTodoPlan({
    schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [taskV4('T1', 'phase-1'), taskV4('T2', 'phase-2'), taskV4('T3', 'phase-2')],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [], joins: [],
    phase_accept_dependencies: [{
      from: { project_id: 'project-1', plan_key: 'main', phase_id: 'phase-1' },
      to: { project_id: 'project-1', plan_key: 'main', task_id: 'T3' },
    }],
  });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });

  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { evidence: evidenceFor(root, 'v5-t1') } } });

  const closed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'phase-1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '過去分・対象コードは既に変化している' } } });
  assert.equal(closed.phases.find(({ phase_id }) => phase_id === 'phase-1').status, 'closed_unaudited');

  // T3はphase-1のphase_accept_dependenciesで縛られている。phase-1はclosed_unauditedであって
  // acceptedではないので、T3のstartは引き続き拒否される——ここがADR 0148裁定2の核心。
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T3', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } }), 'STORE_INCONSISTENT', 'invalid_start_transition');

  // 比較対照: phase-2(T3自身のphase)は普通にactiveなので、T2は無関係に始められる
  // (closed_unauditedがdispatchを壊していないことの確認)。
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T2', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members[0].tasks.find(({ task_id }) => task_id === 'T2').status, 'in-progress');
});

test('終端監査gateと同じく、closed_unauditedもToDoのdispatch(next_ready/active_set/dispatch_frontier)へ影響しない', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));

  const before = workingSlice(projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] }));
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '過去分は監査しない' } } });
  const after = workingSlice(projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] }));
  assert.deepEqual(after, before);
});

test('todo doneのterminal_audit_required advisoryとtodo phase statusのguidanceは、0.36.0の原因と2択の次の一手を言う', async (t) => {
  const root = await workspace(t);
  for (const taskId of ['A', 'B']) {
    assert.equal(run(root, ['todo', 'start', '--plan', 'audited', '--task', taskId,
      '--parallel-frontier'], ACTOR_ENV).status, 0);
    assert.equal(run(root, ['todo', 'done', '--plan', 'audited', '--task', taskId,
      '--evidence', await evidenceFile(root, `evidence-${taskId}`)], ACTOR_ENV).status, 0);
  }
  // working planのPが常にreadyのままなので、B完了後のnext_readyは常に[C, P]の2件で
  // contestedになる——working側を一切触らないこのtestではCにも--parallel-frontierが要る。
  assert.equal(run(root, ['todo', 'start', '--plan', 'audited', '--task', 'C',
    '--parallel-frontier'], ACTOR_ENV).status, 0);
  const finalDone = run(root, ['todo', 'done', '--plan', 'audited', '--task', 'C',
    '--evidence', await evidenceFile(root, 'evidence-c')], ACTOR_ENV);
  assert.equal(finalDone.status, 0, finalDone.stderr);
  const advisory = JSON.parse(finalDone.stdout).advisory;
  assert.match(advisory.guidance, /0\.36\.0/u);
  assert.match(advisory.guidance, /phase review/u);
  assert.match(advisory.guidance, /phase close-unaudited/u);
  assert.match(advisory.guidance, /phase baseline/u);

  const phaseStatusResult = JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'audited']).stdout);
  const guidance = phaseStatusResult.phases[0].guidance;
  assert.match(guidance, /0\.36\.0/u);
  assert.match(guidance, /phase review/u);
  assert.match(guidance, /phase close-unaudited/u);
  assert.match(guidance, /phase baseline/u);
});

test('CLI経由のtodo phase close-unauditedはclosed_unauditedを記録する', async (t) => {
  const root = await workspace(t);
  for (const taskId of ['A', 'B']) {
    assert.equal(run(root, ['todo', 'start', '--plan', 'audited', '--task', taskId,
      '--parallel-frontier'], ACTOR_ENV).status, 0);
    assert.equal(run(root, ['todo', 'done', '--plan', 'audited', '--task', taskId,
      '--evidence', await evidenceFile(root, `evidence-${taskId}`)], ACTOR_ENV).status, 0);
  }
  // working planのPが常にreadyのままなので、B完了後のnext_readyは常に[C, P]の2件で
  // contestedになる——working側を一切触らないこのtestではCにも--parallel-frontierが要る。
  assert.equal(run(root, ['todo', 'start', '--plan', 'audited', '--task', 'C',
    '--parallel-frontier'], ACTOR_ENV).status, 0);
  assert.equal(run(root, ['todo', 'done', '--plan', 'audited', '--task', 'C',
    '--evidence', await evidenceFile(root, 'evidence-c')], ACTOR_ENV).status, 0);

  const closed = run(root, ['todo', 'phase', 'close-unaudited', '--plan', 'audited',
    '--phase', 'terminal-audit', '--reason', '過去分は監査しない'], ACTOR_ENV);
  assert.equal(closed.status, 0, closed.stderr);
  const result = JSON.parse(closed.stdout);
  assert.equal(result.kind, 'phase_close_unaudited');
  assert.equal(result.status, 'closed_unaudited');
});
