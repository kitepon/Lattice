// notice-impl: a done that makes a task startable returns a notice for that task's lane, and the notice
// is a projection of the Store journal, so a later process reads the same notice.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectTodoNotices } from '../src/todo-notices.mjs';
import { readTodoStore } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-notice-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  const plan = (planKey, tasks, edges = []) => writeFile(path.join(root, `${planKey}.json`), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: planKey, phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: tasks.map(([task_id, lane]) => ({ task_id, title: task_id, phase_id: 'p', lane, design_memo: 'NO_PLAN' })),
    hard_dependencies: edges.map(([from, to]) => ({ from: { task_id: from }, to: { task_id: to } })),
  }));
  await plan('a', [['P', 'bot-a'], ['Q', 'bot-b'], ['S', 'bot-a']], [['P', 'Q']]);
  await plan('b', [['R', 'bot-c']]);
  success(root, ['plan', 'create', '--input', 'a.json']);
  success(root, ['plan', 'create', '--input', 'b.json']);
  success(root, ['todo', 'dependency', 'connect', '--from-plan', 'a', '--from-task', 'P',
    '--to-plan', 'b', '--to-task', 'R', '--reason', 'R uses P']);
  return root;
}

test('done returns notices for the released tasks, cross-plan included; a later read sees the same notice', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'a', '--task', 'P']);
  const done = success(root, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']);
  assert.deepEqual(done.notices.map(({ plan_key, task_id, lane }) => [plan_key, task_id, lane]),
    [['a', 'Q', 'bot-b'], ['b', 'R', 'bot-c']]);
  const [q] = done.notices;
  assert.deepEqual(q.triggers.map(({ plan_key, task_id, kind, event_digest }) => [plan_key, task_id, kind, event_digest]),
    [['a', 'P', 'done', done.event_digest]]);
  assert.equal(q.next_action, 'lattice todo start --plan a --task Q');
  // S waited on nothing: no notice. A repeated done appends nothing and releases nothing.
  assert.equal(done.notices.some(({ task_id: id }) => id === 'S'), false);
  assert.deepEqual(success(root, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']).notices, []);
  // Another process (this test, not the CLI that wrote) projects the same notice from the Store.
  const later = projectTodoNotices(await readTodoStore({ repoRoot: root }), { lane: 'bot-b' });
  assert.deepEqual(later.map(({ notice_id: id }) => id), [q.notice_id]);
  // Starting Q closes its notice.
  success(root, ['todo', 'start', '--plan', 'a', '--task', 'Q']);
  assert.deepEqual(projectTodoNotices(await readTodoStore({ repoRoot: root }), { lane: 'bot-b' }), []);
});

test('re-earned readiness is a new notice; an enforced plan without a row offers declare first', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'independence', 'mode', '--plan', 'b', '--set', 'enforced', '--reason', 'gates']);
  success(root, ['todo', 'start', '--plan', 'a', '--task', 'P']);
  const first = success(root, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'one']).notices
    .find(({ task_id: id }) => id === 'R');
  assert.match(first.next_action, /^lattice todo independence witness declare --plan b --task R /u);
  assert.equal(first.coordination_mode, 'enforced');
  success(root, ['todo', 'reopen', '--plan', 'a', '--task', 'P', '--reason', 'again']);
  assert.deepEqual(projectTodoNotices(await readTodoStore({ repoRoot: root }), { lane: 'bot-c' }), []);
  const second = success(root, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'two']).notices
    .find(({ task_id: id }) => id === 'R');
  assert.notEqual(second.notice_id, first.notice_id);
});

test('notice list shows unacked notices per lane or for every lane; ack hides them and reports closed ids', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'a', '--task', 'P']);
  const released = success(root, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']).notices;
  const all = success(root, ['todo', 'notice', 'list']);
  assert.equal(all.schema, 'lattice.todo_notice_list_result.v1');
  assert.deepEqual([all.lane, all.notices.map(({ notice_id: id, acked }) => [id, acked])],
    [null, released.map(({ notice_id: id }) => [id, false])]);
  const q = released.find(({ task_id: id }) => id === 'Q').notice_id;
  const acked = success(root, ['todo', 'notice', 'ack', '--lane', 'bot-b', '--notice', q, '--json']);
  assert.deepEqual([acked.acked, acked.already, acked.closed], [[q], [], []]);
  assert.deepEqual(success(root, ['todo', 'notice', 'list', '--lane', 'bot-b']).notices, []);
  assert.deepEqual(success(root, ['todo', 'notice', 'list', '--lane', 'bot-b', '--include-acked']).notices
    .map(({ notice_id: id, acked: flag }) => [id, flag]), [[q, true]]);
  assert.deepEqual(success(root, ['todo', 'notice', 'ack', '--lane', 'bot-b', '--notice', q]).already, [q]);
  // The ack is host-local: the Store stays git-clean for the next write.
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.lattice/todo/notices'], { cwd: root, encoding: 'utf8' }), '');
  // Started: the notice closed, so a late ack reports it as closed instead of refusing.
  success(root, ['todo', 'start', '--plan', 'a', '--task', 'Q']);
  assert.deepEqual(success(root, ['todo', 'notice', 'ack', '--lane', 'bot-b', '--notice', q]).closed, [q]);
});
