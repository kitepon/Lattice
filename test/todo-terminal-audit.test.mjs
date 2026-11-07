// ADR 0147: 終端重監査gate。phase無しplan(todo_plan.v1/v2/v3)は、終端に暗黙のterminal-audit
// Phaseを持つ——全task doneは「完走」ではなく「監査待ち」であり、監査(review→evidence束縛
// accept)が記録されるまでplanは閉じない。この暗黙Phaseは既存のPhase gate機構(review/accept/
// evidence slot/journal event)をそのまま再利用する(新しい状態機械を増やさない)。
//
// このtestが固定するのは4点:
// 1. 監査を経ずに閉じられない(全task doneでもgantt live scopeで畳まれない・phase statusが
//    gate_readyを返す)
// 2. 監査すれば閉じる(review→evidence束縛acceptでacceptedになり、畳まれるようになる)
// 3. 予約phase_id(terminal-audit)以外のphase eventはtypedに拒否される
// 4. 終端監査gateはToDoのdispatch可否(next_ready/active_set/dispatch_frontier)に一切
//    影響しない(ADR 0147裁定5・ADR 0062)
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

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null });
const ref = (taskId, planKey = 'audited') => ({ project_id: 'project-1', plan_key: planKey, task_id: taskId });
const ACTOR_ENV = Object.freeze({
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
});
const run = (root, args, env = {}) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: root, encoding: 'utf8', env: {
    ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0', ...env,
  } });

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

async function expectCode(promise, code, reason) {
  await assert.rejects(promise, (error) => error instanceof TodoStoreError
    && error.code === code && (reason === undefined || error.detail.reason === reason));
}

/**
 * 2 planを持つstore:
 * - `audited`(phase無し・v3): A -> C の依存を持つ3 taskで、全doneのあと終端監査を経る対象
 * - `working`(phase無し・v3): 独立task Pだけを持ち、ずっとpendingのまま——`audited`側の
 *   Phase遷移がdispatchへ波及していないことを見るための対照plan
 */
async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-terminal-audit-'));
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

function evidenceFor(root, label) {
  const bytes = Buffer.from(`${label} evidence\n`);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  return { evidence_id: label, repo_id: 'self', path: `${label}.txt`,
    git_blob_oid: oid, content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
}

async function doTask(root, writer, taskId, evidence) {
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'start', task_id: taskId, actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'done', task_id: taskId, actor: ACTOR, recorded_at: NOW,
      payload: { evidence } } });
}

// working plan(P)にだけ絞ったnext_ready/active_set/dispatch_frontierを取り出す。
// dispatch_frontierはnext_ready全体から決まる値なので、比較はworking側のnext_ready部分集合と
// dispatch_frontier.recommended_parallelism（全体値。working側task数が変わらない限り不変）の
// 両方で見る。
function workingSlice(status) {
  return {
    next_ready: status.next_ready.filter((entry) => entry.plan_key === 'working'),
    active_set: status.active_set.filter((entry) => entry.plan_key === 'working'),
    recommended_parallelism: status.dispatch_frontier.recommended_parallelism,
  };
}

test('phase無しplanは終端監査(gate_ready)を経るまでgantt live scopeで畳まれない', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));

  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const audited = store.members.find(({ descriptor }) => descriptor.plan_key === 'audited');
  // snapshot artifactの形式(phase無しplanはv1・phasesキー無し)は変えていない。暗黙Phaseの
  // 状態はreadTodoStoreが導出済みで返すmember.phasesで見る。
  assert.equal(audited.snapshot.schema, 'lattice.todo_snapshot.v1');
  assert.equal(Object.hasOwn(audited.snapshot, 'phases'), false);
  assert.deepEqual(audited.phases.map(({ phase_id, status }) => [phase_id, status]),
    [['terminal-audit', 'gate_ready']]);

  const phaseStatusResult = JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'audited']).stdout);
  assert.equal(phaseStatusResult.implicit, true);
  assert.equal(phaseStatusResult.phases[0].phase_id, 'terminal-audit');
  assert.equal(phaseStatusResult.phases[0].status, 'gate_ready');

  const liveResult = await renderTodoGanttForProject({ repoRoot: root, scope: 'live' });
  // A/B/Cは全done、Pはずっとpendingで生きているが、`audited`は監査未了なので
  // A/B/Cも「畳まれてよい死んだ枝」として扱われない。foldされるのは0件。
  assert.equal(liveResult.metadata.folded_task_count, 0);
});

test('予約phase_id以外のphase eventはtypedに拒否される', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));
  await expectCode(appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_review', phase_id: 'not-a-reserved-phase', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '任意phase_idは通らないはず' } } }),
  'STORE_INCONSISTENT', 'event_phase_missing');
});

test('終端監査をreview→evidence束縛acceptで通すとacceptedになりgantt上も畳まれる', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));

  const reviewed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_review', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '終端の重監査を開始' } } });
  // snapshot artifactはv1のまま(phasesキー無し)。導出ビュー`phases`(appendTodoEventの
  // 返り値)を見る。
  assert.equal(reviewed.phases[0].status, 'reviewing');

  const decisionEvidence = evidenceFor(root, 'decision');
  const slotEvidence = evidenceFor(root, 'slot');
  const accepted = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewed.event.event_digest, decision_evidence: decisionEvidence,
        evidence_slots: [{ slot_id: 'terminal-audit', evidence: slotEvidence }] } } });
  assert.equal(accepted.phases[0].status, 'accepted');

  const phaseStatusResult = JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'audited']).stdout);
  assert.equal(phaseStatusResult.phases[0].status, 'accepted');

  const liveResult = await renderTodoGanttForProject({ repoRoot: root, scope: 'live' });
  // 監査が通ったので、他に生きた後続を持たないA/B/Cは通常どおり畳まれる。
  assert.equal(liveResult.metadata.folded_task_count, 3);
});

test('終端監査gateはToDoのdispatch(next_ready/active_set/dispatch_frontier)へ影響しない', async (t) => {
  const root = await workspace(t);
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });

  // Aがdoneになる前は、working planのPと独立taskのA/Bだけがready。Cはaudited内の
  // hard_dependency(A->C)未達で外れる——ここはPhaseでなくhard_dependencyだけで決まる。
  const beforeA = projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  assert.deepEqual(beforeA.next_ready.map(({ task_id }) => task_id).sort(), ['A', 'B', 'P']);

  await doTask(root, writer, 'A', evidenceFor(root, 'a'));
  // Aがdoneになった直後(terminal-auditはまだ'active'、B/Cが残っている)、Cはhard_dependencyだけで
  // readyになる。Phaseの状態(まだgate_readyですらない)は一切参照されない。
  const afterA = projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  assert.deepEqual(afterA.next_ready.map(({ task_id }) => task_id).sort(), ['B', 'C', 'P']);
  const auditedAfterA = (await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ descriptor }) => descriptor.plan_key === 'audited');
  assert.equal(auditedAfterA.phases[0].status, 'active');

  await doTask(root, writer, 'B', evidenceFor(root, 'b'));
  await doTask(root, writer, 'C', evidenceFor(root, 'c'));

  // ここからworking plan側だけを固定して見る。監査未了(gate_ready) -> review -> accept と
  // audited planのPhaseが進んでも、他planのdispatchは一切動かないことを確認する。
  const gateReadyStatus = projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  const gateReady = workingSlice(gateReadyStatus);
  // ap06: 「dispatchが動かない」ことだけを固定すると、監査待ちが**表出していない**状態でも
  // このtestは緑のまま通る。表出と不変は片方ずつでは守れないので、同じ場所で両方を見る。
  assert.deepEqual(gateReadyStatus.audit_pending
    .map(({ plan_key, phase_status }) => [plan_key, phase_status]), [['audited', 'gate_ready']]);

  const reviewed = await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_review', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '重監査開始' } } });
  const reviewingStatus = projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  const reviewing = workingSlice(reviewingStatus);
  assert.deepEqual(reviewing, gateReady);
  assert.equal(reviewingStatus.audit_pending[0].phase_status, 'reviewing');

  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'phase_accept', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
      payload: { review_event_digest: reviewed.event.event_digest,
        decision_evidence: evidenceFor(root, 'decision2'),
        evidence_slots: [{ slot_id: 'terminal-audit', evidence: evidenceFor(root, 'slot2') }] } } });
  const afterAcceptStatus = projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  const acceptedStatus = workingSlice(afterAcceptStatus);
  assert.deepEqual(acceptedStatus, gateReady);
  // 監査が着けば監査欄からは消える。消えてもdispatchは1つ上のdeepEqualのとおり動かない。
  assert.deepEqual(afterAcceptStatus.audit_pending, []);

  // dispatch_frontier全体もrecommended_parallelism以外の主要な形は変わらない
  // (next_readyが変わっていないので当然だが、projectTodoStatusの生成物として明示しておく)。
  const finalStatus = projectTodoStatus(await readTodoStore({ repoRoot: root, now: NOW }), { parallelCandidates: [], planNotes: [] });
  assert.equal(finalStatus.next_ready.some(({ task_id }) => task_id === 'P'), true);
});

test('todo doneはphase無しplanの最後のpending taskがdoneになった時だけ終端監査のadvisoryを返す', async (t) => {
  const root = await workspace(t);
  const middle = run(root, ['todo', 'start', '--plan', 'audited', '--task', 'A'], ACTOR_ENV);
  assert.equal(middle.status, 0, middle.stderr);
  const middleDone = run(root, ['todo', 'done', '--plan', 'audited', '--task', 'A',
    '--evidence', await evidenceFile(root, 'evidence-a')], ACTOR_ENV);
  assert.equal(middleDone.status, 0, middleDone.stderr);
  // Aはaudited planの最初のdoneであり、B/Cがまだpendingなので終端監査のadvisoryは付かない。
  assert.equal(JSON.parse(middleDone.stdout).advisory, null);

  for (const taskId of ['B', 'C']) {
    const started = run(root, ['todo', 'start', '--plan', 'audited', '--task', taskId], ACTOR_ENV);
    assert.equal(started.status, 0, started.stderr);
  }
  const lastDone = run(root, ['todo', 'done', '--plan', 'audited', '--task', 'B',
    '--evidence', await evidenceFile(root, 'evidence-b')], ACTOR_ENV);
  assert.equal(lastDone.status, 0, lastDone.stderr);
  // Bの時点ではCがまだpendingなので、まだ終端監査のadvisoryは付かない。
  assert.equal(JSON.parse(lastDone.stdout).advisory, null);

  const finalDone = run(root, ['todo', 'done', '--plan', 'audited', '--task', 'C',
    '--evidence', await evidenceFile(root, 'evidence-c')], ACTOR_ENV);
  assert.equal(finalDone.status, 0, finalDone.stderr);
  // Cでaudited planの全taskがdoneになった。ここで初めて終端監査のadvisoryが機械可読に付く。
  const advisory = JSON.parse(finalDone.stdout).advisory;
  assert.equal(advisory.terminal_audit_required, true);
  assert.equal(advisory.phase_id, 'terminal-audit');
  assert.equal(advisory.status, 'gate_ready');

  // working planのPはまだpendingで、doneにしても終端監査の対象(audited)には無関係。
  assert.equal(run(root, ['todo', 'start', '--plan', 'working', '--task', 'P'], ACTOR_ENV).status, 0);
  const workingDone = run(root, ['todo', 'done', '--plan', 'working', '--task', 'P',
    '--evidence', await evidenceFile(root, 'evidence-p')], ACTOR_ENV);
  assert.equal(workingDone.status, 0, workingDone.stderr);
  const workingAdvisory = JSON.parse(workingDone.stdout).advisory;
  assert.equal(workingAdvisory.terminal_audit_required, true);
  assert.equal(workingAdvisory.phase_id, 'terminal-audit');
});
