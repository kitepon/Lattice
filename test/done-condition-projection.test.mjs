// u12: 作成者が書いた終了条件の投影面（Gantt詳細・todo show/start・plan show・status ready）。
// Latticeは記録して表示するだけで、評価も完了記録もしない。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectTodoChainV1 } from '../src/todo-chain.mjs';
import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { projectTodoGanttPresentation } from '../src/todo-gantt-presentation.mjs';
import {
  renderTodoGanttHtml, TODO_GANTT_PROSE_MAX_BYTES, TodoGanttRenderError,
} from '../src/todo-gantt-html.mjs';
import { TODO_MARKDOWN_SECTION_MAX_BYTES } from '../src/todo-markdown-renderer.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ref = (task_id) => ({ project_id: 'project-1', plan_key: 'main', task_id });

function readFixture(extra) {
  const tasks = ['A', 'B'].map((task_id) => ({ task_id, title: task_id, lane: 'lane', narrative_ref: null,
    compile_binding: null, design_memo: '設計', ...(extra[task_id] ?? {}) }));
  return {
    schema: 'lattice.todo_store_read.v1', project_id: 'project-1',
    members: [{
      plan: { project_id: 'project-1', plan_key: 'main', schema: 'lattice.todo_plan.v8', tasks,
        hard_dependencies: [], joins: [] },
      tasks: tasks.map(({ task_id }) => ({ task_id, status: 'pending', started_at: null, done_at: null,
        blocked_reason: null, evidence: null, evidence_unverified: false })),
    }],
  };
}
function render(read) {
  return renderTodoGanttHtml({ readModel: read, layout: layoutTodoGantt(read), narratives: [],
    anchorOutcomes: [], presentation: projectTodoGanttPresentation(read, null), metadata: {} });
}
const panel = (html, id) => html.split('<article class="task-detail')
  .find((chunk) => chunk.slice(0, 200).includes(`&quot;${id}&quot;]"`));

test('gantt detail shows 終了条件 as escaped text right after the design memo, and nothing otherwise', () => {
  const { html } = render(readFixture({
    A: { done_condition: '<b>全て</b> & "通る"\n二行目' },
    B: { done_condition: null },
  }));
  const a = panel(html, 'A');
  assert.match(a, /<\/section><section><h2>終了条件<\/h2><p class="done-condition-body">&lt;b&gt;全て&lt;\/b&gt; &amp; (?:&quot;|")通る(?:&quot;|")<br>二行目<\/p><\/section><section><h2>前提工程<\/h2>/u);
  assert.ok(a.indexOf('設計メモ') < a.indexOf('終了条件'));
  assert.equal(a.includes('<b>全て'), false);
  assert.equal(panel(html, 'B').includes('終了条件'), false);
  // v7以前（欄なし）も、文字列でない値も何も出さない。
  const { html: legacy } = render(readFixture({ A: { done_condition: 5 } }));
  assert.equal(panel(legacy, 'A').includes('終了条件'), false);
  assert.equal(panel(legacy, 'B').includes('終了条件'), false);
});

test('done_condition counts toward the aggregate prose budget', { timeout: 15_000 }, () => {
  const section = 'a'.repeat(TODO_MARKDOWN_SECTION_MAX_BYTES);
  const tasks = Array.from({ length: 33 }, (_, index) => ({ task_id: `T${index}`, title: `t${index}`,
    lane: 'lane', narrative_ref: null, compile_binding: null,
    done_condition: index < 32 ? section : null }));
  const read = readFixture({});
  read.members[0].plan.tasks = tasks;
  read.members[0].tasks = tasks.map(({ task_id }) => ({ task_id, status: 'pending', started_at: null,
    done_at: null, blocked_reason: null, evidence: null, evidence_unverified: false }));
  assert.equal(render(read).prose_bytes, TODO_GANTT_PROSE_MAX_BYTES);
  tasks[32].done_condition = 'a';
  assert.throws(() => render(read), (error) => error instanceof TodoGanttRenderError
    && error.code === 'TODO_SCALE_EXCEEDED' && error.detail.prose_bytes === TODO_GANTT_PROSE_MAX_BYTES + 1);
});

// --- CLI projections ------------------------------------------------------

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture',
      LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function authored(schema) {
  const v5 = schema === 'lattice.plan_create_input.v5';
  return { schema, project_id: 'example', plan_key: 'work', plan_version: 'v1',
    actor: { host: 'fixture', session: 'fixture', agent: 'fixture' }, recorded_at: '2026-11-08T00:00:00.000Z',
    tasks: ['a', 'b'].map((task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
      ...(v5 ? { done_condition: task_id === 'a' ? 'aは全部通る' : null } : {}),
      narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'p' })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '' };
}
async function project(context, schema) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-done-condition-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(authored(schema)));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}

test('v8 plan: todo show, todo start, plan show and status ready entries project done_condition', async (context) => {
  const root = await project(context, 'lattice.plan_create_input.v5');
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'a', '--json']).task.done_condition, 'aは全部通る');
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'b', '--json']).task.done_condition, null);
  const shown = success(root, ['plan', 'show', 'work', '--json']);
  assert.deepEqual(shown.tasks.map((task) => task.done_condition), ['aは全部通る', null]);
  const status = success(root, ['todo', 'status', '--json']);
  assert.deepEqual(status.next_ready.map((entry) => [entry.task_id, entry.done_condition]),
    [['a', 'aは全部通る'], ['b', null]]);
  const started = success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  assert.equal(started.done_condition, 'aは全部通る');
  // 開始しても、Latticeは終了条件で何も決めない: 状態はin-progressのまま。
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'a', '--json']).state.status, 'in-progress');
});

test('v7 plan projects done_condition as null everywhere', async (context) => {
  const root = await project(context, 'lattice.plan_create_input.v4');
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'a', '--json']).task.done_condition, null);
  assert.deepEqual(success(root, ['plan', 'show', 'work', '--json']).tasks.map((task) => task.done_condition), [null, null]);
  assert.deepEqual(success(root, ['todo', 'status', '--json']).next_ready.map((entry) => entry.done_condition), [null, null]);
  assert.equal(success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']).done_condition, null);
});
