// ap04: `lattice status --json`が全task done時に`next_action: {"reason":"no_ready_task"}`を返す。
// 機械が「残作業なし」と答える限り、AIは正しくそれを信じて完了報告する。監査待ちが在る限り
// そう答えないようにする。
//
// 本testが固定するのは:
// 1. 優先順位 active_run > next_ready > audit_pending > なし（ready frontierを監査で上書きしない）
// 2. ready taskが尽きても監査待ちが在れば`reason: 'audit_pending'`で次コマンドまで案内する
// 3. `state`は`ready`のまま（閉じたenumでhostが分岐に使う。信号はreasonが持つ）
// 4. gate_readyなら案内は軽い出口close-unaudited 1行で、`<text>`を埋めればそのまま通る（a22）
// 5. 監査が着けば`no_ready_task`へ戻る
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR_ENV = {
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
};

function run(root, args, env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', ...env };
  delete childEnv.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: childEnv });
}

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-status-audit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(path.join(root, '.lattice'));

  const input = {
    schema: 'lattice.plan_create_input.v4', project_id: 'audit-project', plan_key: 'main', plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: [
      { task_id: 'T1', title: '設計', lane: 'main', design_memo: '設計内容を検証可能に記録する。',
        narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' },
      { task_id: 'T2', title: '実装', lane: 'main', design_memo: '設計と独立に着手可能な実装を進める。',
        narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-2' },
    ],
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
  const created = run(root, ['plan', 'create', '--input', '.lattice/plan.json']);
  assert.equal(created.status, 0, created.stderr);

  const bytes = Buffer.from('heavy check\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  const evidence = { evidence_id: 'heavy', repo_id: 'self', path: 'heavy.txt', git_blob_oid: oid,
    content_digest: createHash('sha256').update(bytes).digest('hex'), media_type: 'text/plain', anchor_digest: null };
  await writeFile(path.join(root, '.lattice', 'evidence.json'), `${JSON.stringify(evidence)}\n`);

  const discovery = () => JSON.parse(run(root, ['status', '--json']).stdout);
  const finish = (taskId) => {
    // ready frontierが複数ある間はADR 0063の並列宣言が要る（既定は全ready分の同時dispatch）。
    const started = run(root, ['todo', 'start', '--plan', 'main', '--task', taskId,
      '--parallel-frontier'], ACTOR_ENV);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
    const done = run(root, ['todo', 'done', '--plan', 'main', '--task', taskId,
      '--evidence', '.lattice/evidence.json'], ACTOR_ENV);
    assert.equal(done.status, 0, `${done.stdout}${done.stderr}`);
  };
  return { root, evidence, discovery, finish };
}

test('監査待ちが在ってもready frontierとactive_runが優先される', async (context) => {
  const { root, discovery, finish } = await workspace(context);

  assert.equal(discovery().next_action.reason, 'parallel_frontier_present');

  // T1がdoneでphase-1はgate_ready。ここで監査待ちが生まれるが、T2がまだreadyである。
  finish('T1');
  const phases = JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'main']).stdout);
  // phase-2はphase-1がacceptedになるまでlockedである（Phaseの監査順とToDoの実行順は別物で、
  // T2はlocked Phaseに属したままreadyでいられる）。
  assert.deepEqual(phases.phases.map(({ phase_id, status }) => [phase_id, status]),
    [['phase-1', 'gate_ready'], ['phase-2', 'locked']]);
  const withReady = discovery();
  // ready frontierを監査で上書きするとdispatchが再直列化する（ADR 0063）。
  assert.equal(withReady.next_action.reason, 'next_ready_present');
  assert.equal(withReady.next_action.command, 'lattice todo start --plan main --task T2');

  assert.equal(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T2'], ACTOR_ENV).status, 0);
  const withActive = discovery();
  assert.equal(withActive.state, 'active_run');
  assert.equal(withActive.next_action.reason, 'active_run_present');
});

test('ready taskが尽きても監査待ちが在れば残作業なしと答えない', async (context) => {
  const { root, discovery, finish } = await workspace(context);
  finish('T1');
  finish('T2');

  const result = discovery();
  // 事故の現場: 実装前はここが`no_ready_task`で、AIは正しくそれを信じて完了報告していた。
  assert.equal(result.next_action.reason, 'audit_pending');
  assert.equal(result.next_action.command,
    'lattice todo phase close-unaudited --plan main --phase phase-1 --reason <text>');
  // stateは閉じたenumでhostが分岐に使う。信号はreasonが持ち、stateは動かさない。
  assert.equal(result.state, 'ready');
  assert.equal(result.schema, 'lattice.project_status.v1');
  assert.deepEqual(result.active_runs, []);

  // 案内は`<text>`を埋めればそのまま実行でき、phase-1を監査なしで閉じる。
  const guided = run(root, result.next_action.command.replace('<text>', 'finished').split(' ').slice(1), ACTOR_ENV);
  assert.equal(guided.status, 0, guided.stderr);
  const phases = JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'main']).stdout).phases;
  assert.equal(phases.find(({ phase_id: id }) => id === 'phase-1').status, 'closed_unaudited');
});

test('監査が着けばno_ready_taskへ戻る', async (context) => {
  const { root, evidence, discovery, finish } = await workspace(context);
  finish('T1');
  finish('T2');
  assert.equal(discovery().next_action.reason, 'audit_pending');

  const review = run(root, ['todo', 'phase', 'review', '--plan', 'main', '--phase', 'phase-1',
    '--reason', '終端監査'], ACTOR_ENV);
  assert.equal(review.status, 0, review.stderr);
  const decision = {
    schema: 'lattice.phase_accept_input.v1', review_event_digest: JSON.parse(review.stdout).event_digest,
    decision_evidence: evidence, evidence_slots: [{ slot_id: 'heavy', evidence }], input_digest: '',
  };
  decision.input_digest = todoSelfDigest(decision, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'accept.json'), `${canonicalizeTodoArtifact(decision)}\n`);
  const accepted = run(root, ['todo', 'phase', 'accept', '--plan', 'main', '--phase', 'phase-1',
    '--input', '.lattice/accept.json'], ACTOR_ENV);
  assert.equal(accepted.status, 0, accepted.stderr);
  // phase-1がacceptedになってもphase-2がまだ監査待ちなので、案内は消えない。
  assert.equal(discovery().next_action.reason, 'audit_pending');

  const closed = run(root, ['todo', 'phase', 'close-unaudited', '--plan', 'main', '--phase', 'phase-2',
    '--reason', '監査なしで閉じる'], ACTOR_ENV);
  assert.equal(closed.status, 0, closed.stderr);
  const result = discovery();
  assert.equal(result.next_action.reason, 'no_ready_task');
  assert.equal(result.state, 'ready');
});
