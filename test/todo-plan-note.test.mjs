// plan単位のnote（ob01）。工程レベルの義務——「ap08をap03より先に着地させる」「この観測は
// 一度しか取れない」——は特定のtaskに属さないので、task必須のnoteでは書けなかった。
//
// 固定するのは「書ける」だけではない。**書けるが届かない面を作らないこと**が要点で、前campaignが
// 直した穴（監査待ちは呼ぶ動機の無いdrilldownには最初から出ていた）と同じ形になる。だから
// `todo start`のnote_contextへ載ることまでを同じtestで見る。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { TODO_LIMITS } from '../src/todo-contracts.mjs';
import { appendTodoNote } from '../src/todo-note-store.mjs';
import { dependencyNoteBody, todoAddNoteBody } from '../src/todo-revision-note.mjs';
import { createTodoStoreWriter, initializeTodoStore } from '../src/todo-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/lattice.mjs');
const ACTOR = { host: 'host-1', session: 'session-1', agent: 'agent-1' };
const NOW = '2026-08-01T00:00:00.000Z';

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-note-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [task('T1'), task('T2')], hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  return root;
}

function run(root, args) {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env,
      NO_COLOR: '1',
      LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_TODO_ACTOR_HOST: ACTOR.host,
      LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
      LATTICE_TODO_ACTOR_AGENT: ACTOR.agent },
  });
}

const json = (result) => JSON.parse(result.stdout);

test('plan単位noteは--task無しで書け、scope込みでlistへ出る', async (t) => {
  const root = await workspace(t);
  // 前campaignで散文へ落ちた実例をそのままfixtureにする。
  const body = 'ap08をap03より先に着地させること。順序が逆になるとhostのstatus読取が壊れる。';
  const appended = run(root, ['todo', 'note', '--plan', 'main', '--message', body]);
  assert.equal(appended.status, 0, appended.stderr);
  const result = json(appended);
  assert.equal(result.schema, 'lattice.todo_note_append_result.v2');
  assert.equal(result.scope, 'plan');
  assert.equal(result.task_id, null);
  assert.equal(result.event.schema, 'lattice.todo_note_event.v2');
  assert.equal(result.event.scope, 'plan');
  assert.equal(result.event.task_id, null);
  // plan noteはどのtaskのcontextにも載るので、1つを選んで返すと嘘になる。
  assert.equal(result.note_context, null);

  const listed = json(run(root, ['todo', 'note', 'list', '--plan', 'main', '--json']));
  assert.equal(listed.notes.length, 1);
  assert.equal(listed.notes[0].body, body);
});

test('plan noteは同じplanの全taskのstartへ、呼ぶ動機なしに届く', async (t) => {
  const root = await workspace(t);
  const body = 'この工程の陽性実測はgate_readyの一瞬しか取れない。';
  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--message', body]).status, 0);

  // 書いた時点では、誰がどのtaskを取るか分からない。だから全taskへ届かないと意味がない。
  for (const taskId of ['T1', 'T2']) {
    const started = json(run(root, ['todo', 'start', '--plan', 'main', '--task', taskId,
      '--parallel-frontier']));
    const context = started.note_context;
    assert.equal(context.schema, 'lattice.todo_note_context.v2', taskId);
    assert.deepEqual(context.notes.map(({ scope }) => scope), ['plan'], taskId);
    assert.equal(context.notes[0].body, body, taskId);
    assert.equal(context.notes[0].origin_task_id, null, taskId);
    // contextがplan noteを載せる以上、全部を取りに行く案内もplan形でなければ嘘になる。
    assert.equal(context.full_history_command, 'lattice todo note list --plan main --json', taskId);
  }
});

test('task noteとplan noteは同じcontextに並び、scopeで区別できる', async (t) => {
  const root = await workspace(t);
  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--message', 'plan宛の申し送り']).status, 0);
  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--task', 'T1',
    '--message', 'T1宛の申し送り']).status, 0);

  const started = json(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1',
    '--parallel-frontier']));
  const byScope = new Map(started.note_context.notes.map((note) => [note.scope, note]));
  assert.deepEqual([...byScope.keys()].sort(), ['plan', 'task']);
  assert.equal(byScope.get('task').origin_task_id, 'T1');
  assert.equal(byScope.get('plan').origin_task_id, null);

  // T2のcontextにはplan noteだけが載る——T1宛の申し送りはT1のものである。
  const other = json(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T2',
    '--parallel-frontier']));
  assert.deepEqual(other.note_context.notes.map(({ scope }) => scope), ['plan']);
});

// 分離の値打ちは「別fileに在る」ことではなく、**task chainのbyteが1つも動かない**ことにある。
// 旧CLIが読むのは`active.jsonl`と`sealed/*`だけなので、そこが同一なら旧CLIの挙動は同一である。
test('plan noteを書いてもtask chainのbyteは1つも変わらない', async (t) => {
  const root = await workspace(t);
  const taskChain = path.join(root, '.lattice/todo/notes/main/active.jsonl');
  const planChain = path.join(root, '.lattice/todo/notes/main/plan-active.jsonl');

  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--task', 'T1', '--message', 'T1宛']).status, 0);
  const before = await readFile(taskChain);

  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--message', 'plan宛']).status, 0);
  assert.deepEqual(await readFile(taskChain), before, 'task chainが動いた');

  // plan noteは別fileへ積まれ、そこには v2 しか居ない。
  const planLines = (await readFile(planChain, 'utf8')).trimEnd().split('\n');
  assert.equal(planLines.length, 1);
  assert.equal(JSON.parse(planLines[0]).schema, 'lattice.todo_note_event.v2');
  // task chain には v1 しか居ない。混在は読み出し時に typed に落ちる。
  for (const line of (await readFile(taskChain, 'utf8')).trimEnd().split('\n')) {
    assert.equal(JSON.parse(line).schema, 'lattice.todo_note_event.v1');
  }
});

test('headはchainごとに言い、片方だけ在っても壊れと読まない', async (t) => {
  const root = await workspace(t);
  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--message', 'plan宛']).status, 0);

  // task noteが1件も無い状態。`notes`は非空だが task chain の head は null。
  const started = json(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1',
    '--parallel-frontier']));
  const context = started.note_context;
  assert.equal(context.note_head_digest, null);
  assert.notEqual(context.plan_note_head_digest, null);
  assert.deepEqual(context.notes.map(({ scope }) => scope), ['plan']);

  const listed = json(run(root, ['todo', 'note', 'list', '--plan', 'main', '--json']));
  assert.equal(listed.note_head_digest, null);
  assert.equal(listed.plan_note_head_digest, context.plan_note_head_digest);
});

test('訂正はscopeを跨げない', async (t) => {
  const root = await workspace(t);
  const planNote = json(run(root, ['todo', 'note', '--plan', 'main', '--message', 'plan宛']));
  const taskNote = json(run(root, ['todo', 'note', '--plan', 'main', '--task', 'T1', '--message', 'T1宛']));

  // task noteをplan noteで訂正することはできない。届く先が違うものを同じ履歴へ畳ませない。
  const crossed = run(root, ['todo', 'note', '--plan', 'main', '--message', '訂正',
    '--supersedes', taskNote.event.event_digest]);
  assert.notEqual(crossed.status, 0);
  assert.equal(JSON.parse(crossed.stdout || crossed.stderr).detail.reason,
    'superseded_note_not_plan_scoped');

  // 同じscopeなら訂正できる。
  const corrected = run(root, ['todo', 'note', '--plan', 'main', '--message', 'plan宛（訂正後）',
    '--supersedes', planNote.event.event_digest]);
  assert.equal(corrected.status, 0, corrected.stderr);
  const started = json(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T2',
    '--parallel-frontier']));
  const states = new Map(started.note_context.notes.map((note) => [note.body, note.correction_state]));
  assert.equal(states.get('plan宛'), 'superseded');
  assert.equal(states.get('plan宛（訂正後）'), 'current');
});

test('byteに収まってもplan noteが件数上限を超えたらcontextは上限で切りoverflowへ数える', async (t) => {
  const root = await workspace(t);
  const cap = TODO_LIMITS.tasksPerPlan;
  const excess = 3;
  // 本番の落ち方（546件・38KB）と同じ形: 1件ずつは短く、合計はbyte予算に余裕がある。
  for (let i = 0; i < cap + excess; i += 1) {
    await appendTodoNote({ repoRoot: root, projectId: 'project-1', planKey: 'main',
      planVersion: 'v1', taskId: null, actor: ACTOR, recordedAt: NOW, body: `申し送り${i}`,
      supersedes: null, eligibleSupersedes: [] });
  }
  const listed = run(root, ['todo', 'note', 'list', '--plan', 'main', '--task', 'T1', '--json']);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const started = json(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1',
    '--parallel-frontier']));
  const context = started.note_context;
  assert.equal(context.schema, 'lattice.todo_note_context.v2');
  assert.equal(context.notes.length, cap);
  assert.equal(context.overflow_count, excess);
  // 新しい順に残し、古いものから溢れる。
  assert.equal(context.notes[0].body, `申し送り${cap + excess - 1}`);
  assert.equal(context.notes.at(-1).body, `申し送り${excess}`);
});

test('上限を超えるLattice自身の改訂記録があっても、taskの申し送りと人のplan noteは届く(n3)', async (t) => {
  const root = await workspace(t);
  const append = (taskId, body) => appendTodoNote({ repoRoot: root, projectId: 'project-1',
    planKey: 'main', planVersion: 'v1', taskId, actor: ACTOR, recordedAt: NOW, body,
    supersedes: null, eligibleSupersedes: [] });
  await append('T1', 'T1の引き継ぎ');
  await append(null, '人が書いた工程の義務');
  await append(null, todoAddNoteBody('T1', 'T1を足した理由'));
  // 他のchartの側がどう書かれても、自分のidが片側に在れば自分の記録。
  await append(null, dependencyNoteBody('connect', 'bellteam/plan-x/a151', 'T1', '外の\n待ち'));
  for (let i = 0; i < TODO_LIMITS.tasksPerPlan + 3; i += 1) {
    await append(null, i % 2 === 0 ? todoAddNoteBody(`other-${i}`, null)
      : dependencyNoteBody('disconnect', `other-${i}`, 'T2', `理由${i}`));
  }
  const started = json(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1',
    '--parallel-frontier']));
  const context = started.note_context;
  assert.deepEqual(context.notes.map(({ body }) => body), [
    dependencyNoteBody('connect', 'bellteam/plan-x/a151', 'T1', '外の\n待ち'),
    todoAddNoteBody('T1', 'T1を足した理由'), '人が書いた工程の義務', 'T1の引き継ぎ']);
  assert.equal(context.overflow_count, 0);
  // 外した記録は全履歴に残る。
  const listed = json(run(root, ['todo', 'note', 'list', '--plan', 'main', '--json']));
  assert.ok(JSON.stringify(listed).includes(todoAddNoteBody('other-0', null)));
});
