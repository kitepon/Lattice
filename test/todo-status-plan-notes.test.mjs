// ob02: plan単位noteのstatus表出のE2E。ob01が作った書き込み・配達（`todo start`の
// `note_context`）は「着手した人」へは届くが、**まだ誰も着手していない工程の義務は
// どこにも出ない**。本testが固定するのは`bin/lattice.mjs todo status --json`のstdoutで、
// 実CLIを起動して実storeを読ませ、次の2つを同じ場所で守る:
//
// 1. plan単位noteが在れば`plan_notes`へ出て、次に打つコマンドまで名指しされる
// 2. noteを書いてもdispatchは1バイトも動かない（ADR 0062・0063の不変条件）
//
// 落とし穴は`test/todo-audit-pending-e2e.test.mjs`の冒頭と同じ2点（未来のNOWは
// `future_clock_skew`・`buildTodoPlan`のtask形はexact）。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTodoPlan, createTodoStoreWriter, initializeTodoStore,
} from '../src/todo-store.mjs';
import { TODO_STATUS_SCHEMA, validateTodoStatusResult } from '../src/todo-status.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ACTOR_ENV = {
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
};

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null });

function run(root, args, env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', ...env };
  delete childEnv.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: childEnv });
}

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result;
}

/**
 * 2 planのphase無しstore。`carrier`へplan noteを貼り、`quiet`は最後まで無noteのまま残す。
 * 「note在り」と「note無し」を同じstatus応答の中で同時に見るための対照である。
 */
async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-note-e2e-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(path.join(root, '.lattice'), { recursive: true });
  const plan = (planKey, tasks) => buildTodoPlan({
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: planKey, plan_version: 'v1',
    predecessor_plan_digest: null, tasks, hard_dependencies: [], joins: [],
  });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: plan('carrier', [task('A')]), genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('quiet', [task('P')]), genesis: { actor: ACTOR, recorded_at: NOW } },
    ],
    now: NOW,
  });
  const status = () => JSON.parse(ok(run(root, ['todo', 'status', '--json'])).stdout);
  const planNote = (planKey, message) => ok(run(root,
    ['todo', 'note', '--plan', planKey, '--message', message], ACTOR_ENV));
  const taskNote = (planKey, taskId, message) => ok(run(root,
    ['todo', 'note', '--plan', planKey, '--task', taskId, '--message', message], ACTOR_ENV));
  return { root, status, planNote, taskNote };
}

const notesOf = (status, planKey) => status.plan_notes.filter((entry) => entry.plan_key === planKey);
// dispatchの同一性はfrontier_digest（ADR 0063でidentityそのもの）で見る。
const dispatchBytes = (status) => JSON.stringify({
  active_set: status.active_set, next_ready: status.next_ready,
  dispatch_frontier: status.dispatch_frontier, blocked: status.blocked,
});

test('plan単位noteはstatusのplan_notesへ出て、次に打つコマンドまで名指しする', async (context) => {
  const { status, planNote } = await workspace(context);

  const before = status();
  assert.equal(before.schema, TODO_STATUS_SCHEMA);
  // 前提: noteを貼る前は空である（貼った後の1件が「元から在った」ではないことを先に固定する）。
  assert.deepEqual(before.plan_notes, []);

  planNote('carrier', 'この工程の終端監査は一度しか観測機会が無い');
  const after = status();

  assert.equal(after.plan_notes.length, 1);
  const [entry] = notesOf(after, 'carrier');
  assert.equal(entry.plan_key, 'carrier');
  assert.equal(entry.count, 1);
  assert.equal(entry.latest.length, 1);
  assert.equal(entry.latest[0].event_digest, entry.plan_note_head_digest);
  assert.equal(entry.latest[0].actor_agent, 'agent-1');
  // 欄に在るだけでは読まれない。次の一手が名指しされていることが配達の条件である。
  assert.deepEqual(entry.next_commands, ['lattice todo note list --plan carrier --json']);
  // 本文はstatusへ載せない（capture limitを踏まないための設計。中身はnote listが持つ）。
  assert.equal(JSON.stringify(after.plan_notes).includes('終端監査'), false);
  // noteを持たないplanはentryごと出ない（満杯で始まる欄を作らない）。
  assert.deepEqual(notesOf(after, 'quiet'), []);
  assert.equal(validateTodoStatusResult(after), true);
});

test('task単位noteはplan_notesを1件も動かさない', async (context) => {
  const { status, taskNote } = await workspace(context);

  taskNote('carrier', 'A', 'これはtask宛の申し送り');
  const after = status();

  // task noteは着手した人のnote_contextが運ぶ。plan_notesはplanに属する義務だけを数える。
  assert.deepEqual(after.plan_notes, []);
});

test('plan noteを書いてもdispatchは1バイトも動かない', async (context) => {
  const { status, planNote, taskNote } = await workspace(context);

  const before = status();
  const beforeBytes = dispatchBytes(before);
  const beforeDigest = before.dispatch_frontier.frontier_digest;

  planNote('carrier', '1件目');
  planNote('carrier', '2件目');
  taskNote('quiet', 'P', 'task宛');
  const after = status();

  // 記録が実際に立ったことを先に確かめる。立っていなければ「変わらない」は当たり前になる。
  assert.equal(notesOf(after, 'carrier')[0].count, 2);
  assert.equal(dispatchBytes(after), beforeBytes);
  assert.equal(after.dispatch_frontier.frontier_digest, beforeDigest);
  // next_readyはリテラルでも固定する（両側が同時に壊れた時に通る形を避ける）。
  assert.deepEqual(after.next_ready, [
    { plan_key: 'carrier', task_id: 'A', label: 'A', done_condition: null },
    { plan_key: 'quiet', task_id: 'P', label: 'P', done_condition: null },
  ]);
});

test('latestは最大3件で新しい順、countは全件を数える', async (context) => {
  const { status, planNote } = await workspace(context);

  for (const index of [1, 2, 3, 4]) planNote('carrier', `note ${index}`);
  const [entry] = notesOf(status(), 'carrier');

  assert.equal(entry.count, 4);
  assert.equal(entry.latest.length, 3);
  const recordedAt = entry.latest.map(({ recorded_at: value }) => value);
  assert.deepEqual([...recordedAt].sort().reverse(), recordedAt);
  assert.equal(entry.latest[0].event_digest, entry.plan_note_head_digest);
});

test('plan_notesはsession_contextのtodoへそのまま届く', async (context) => {
  const { root, planNote } = await workspace(context);

  planNote('carrier', '工程の義務');
  const context1 = JSON.parse(ok(run(root, ['session-context', '--json'])).stdout);

  // session_contextの`todo`は`todo status`のresultそのもの（ADR 0131）。SessionStartで
  // 読まれる面へ、追加のwire bumpなしで届くことをここで固定する。
  assert.equal(context1.todo.schema, TODO_STATUS_SCHEMA);
  assert.equal(context1.todo.plan_notes.length, 1);
  assert.equal(context1.todo.plan_notes[0].plan_key, 'carrier');
});
