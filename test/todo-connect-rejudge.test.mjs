// n2: a 接続's target changes (done, retire, reopen, missing) are judged again at the next read.
// docs/architecture/dfd-connect.md#re-judge-on-a-target-change-and-waiters-n1-2026-11-28

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

/** Two charts under one root: alpha (plan a: P) and beta (plan b: R), R waits on alpha/a/P. */
async function charts(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-rejudge-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CHARTS_ROOT: root };
  const ok = (chart, args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: path.join(root, chart), encoding: 'utf8',
      env: { ...process.env, ...env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
        LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
    assert.equal(result.status, 0, `${chart}: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const create = async (chart, planKey, taskId) => {
    const dir = path.join(root, chart);
    await mkdir(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify({
      schema: 'lattice.plan_create_input.v5', plan_key: planKey, phases: [{ phase_id: 'p', title: 'phase' }],
      tasks: [{ task_id: taskId, title: taskId, phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' }], hard_dependencies: [],
    }));
    ok(chart, ['plan', 'create', '--input', 'plan.json']);
  };
  await create('alpha', 'a', 'P');
  await create('beta', 'b', 'R');
  ok('beta', ['todo', 'connect', 'condition', 'add', '--plan', 'b', '--task', 'R', '--to', 'task:alpha/a/P', '--reason', 'R uses P']);
  const entry = () => ok('beta', ['todo', 'show', '--plan', 'b', '--task', 'R', '--json']).prerequisites;
  const ready = () => ok('beta', ['todo', 'status', '--json']).next_ready.map(({ task_id: id }) => id);
  return { root, ok, create, entry, ready };
}

const shown = ({ connections }) => connections.map(({ state, state_reason: reason, changed }) => [state, reason ?? null, changed?.kind ?? null]);

test('target done settles, reopen opens it again, retire is gone: each judged at the next read', async (context) => {
  const { ok, entry, ready } = await charts(context);
  assert.deepEqual([shown(entry()), ready()], [[['open', null, null]], []]);
  ok('alpha', ['todo', 'start', '--plan', 'a', '--task', 'P']);
  ok('alpha', ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']);
  assert.deepEqual([shown(entry()), ready()], [[['settled', 'target_done', 'done']], ['R']]);
  ok('alpha', ['todo', 'reopen', '--plan', 'a', '--task', 'P', '--reason', 'found a defect']);
  assert.deepEqual([shown(entry()), ready()], [[['open', null, 'reopen']], []]);
  ok('alpha', ['todo', 'retire', '--plan', 'a', '--task', 'P', '--reason', 'not needed']);
  assert.deepEqual([shown(entry()), ready()], [[['gone', 'target_retired', 'retire']], ['R']]);
});

test('a target missing from a readable chart is gone and never blocks; an unreadable chart stays open', async (context) => {
  const { root, ok, create, entry, ready } = await charts(context);
  await rename(path.join(root, 'alpha'), path.join(root, 'alpha-moved'));
  assert.deepEqual([shown(entry()), ready()], [[['open', 'chart_unreadable', null]], []]);
  await create('alpha', 'z', 'Z');
  assert.deepEqual([shown(entry()), ready()], [[['gone', 'target_missing', null]], ['R']]);
  assert.equal(ok('beta', ['todo', 'start', '--plan', 'b', '--task', 'R']).status, 'in-progress');
});

test('waiters: the target chart lists who waits on it, with the judgment; show, display read and the done result carry it', async (context) => {
  const { ok, root } = await charts(context);
  const target = (...args) => ok('alpha', args);
  const waiter = (state, reason) => ({ project_id: 'beta', plan_key: 'b', task_id: 'R', kind: 'task', state, ...(reason ? { state_reason: reason } : {}) });
  const slim = (list) => list.map(({ project_id: p, plan_key: k, task_id: t, kind, state, state_reason: r }) => ({ project_id: p, plan_key: k, task_id: t, kind, state, ...(r ? { state_reason: r } : {}) }));
  const listed = (result) => result.tasks.map(({ plan_key: k, task_id: t, waiters }) => [k, t, slim(waiters)]);
  assert.deepEqual(listed(target('todo', 'waiters', '--json')), [['a', 'P', [waiter('open')]]]);
  assert.deepEqual(target('todo', 'waiters', '--json').unread, []);
  assert.deepEqual(slim(target('todo', 'show', '--plan', 'a', '--task', 'P', '--json').waiters), [waiter('open')]);
  assert.deepEqual(display(target('todo', 'display', 'read', '--open', '--json')).map(([k, t, w]) => [k, t, slim(w)]), [['a', 'P', [waiter('open')]]]);
  assert.deepEqual(listed(target('todo', 'waiters', '--plan', 'a', '--task', 'nothing', '--json')), []);
  target('todo', 'start', '--plan', 'a', '--task', 'P');
  const done = target('todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged');
  assert.deepEqual(slim(done.waiters), [waiter('settled', 'target_done')]);
  // --open keeps only the ones still waiting; history stays in the full list
  assert.deepEqual(listed(target('todo', 'waiters', '--open', '--json')), []);
  assert.deepEqual(listed(target('todo', 'waiters', '--json')), [['a', 'P', [waiter('settled', 'target_done')]]]);
  assert.deepEqual(display(target('todo', 'display', 'read', '--open', '--json')), []);
  const reopened = target('todo', 'reopen', '--plan', 'a', '--task', 'P', '--reason', 'defect');
  assert.deepEqual(slim(reopened.waiters), [waiter('open')]);
  const retired = target('todo', 'retire', '--plan', 'a', '--task', 'P', '--reason', 'not needed');
  assert.deepEqual(slim(retired.waiters), [waiter('gone', 'target_retired')]);
  // an unreadable waiting chart is named, never "no waiters"
  await writeFile(path.join(root, 'beta', '.lattice', 'todo', 'manifest.json'), '{');
  const unread = target('todo', 'waiters', '--json');
  assert.deepEqual([unread.tasks, unread.unread.map(({ project_id: id }) => id)], [[], ['beta']]);
});

const display = (read) => read.waiters.map(({ plan_key: k, task_id: t, waiters }) => [k, t, waiters]);

test('K2: the waiting chart token moves when its target changes; the target chart token moves when a waiter appears or goes', async (context) => {
  const { ok, create } = await charts(context);
  const token = (id) => ok('alpha', ['charts', 'source', '--project', id, '--json']).charts[id];
  const both = () => [token('alpha'), token('beta')];
  const idle = both();
  assert.deepEqual(both(), idle, 'reading moves nothing');
  ok('alpha', ['todo', 'start', '--plan', 'a', '--task', 'P']);
  const started = both();
  assert.notEqual(started[1], idle[1], 'a target start moves the waiting chart token');
  ok('alpha', ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']);
  const done = both();
  assert.notEqual(done[1], started[1], 'target done in alpha moves the token of the chart that waits (beta)');
  assert.notEqual(done[0], started[0]);
  ok('beta', ['todo', 'connect', 'condition', 'remove', '--plan', 'b', '--task', 'R', '--to', 'task:alpha/a/P', '--reason', 'no longer']);
  const removed = both();
  assert.notEqual(removed[0], done[0], 'a waiter going moves the target chart token');
  assert.notEqual(removed[1], done[1]);
  // a waiter appearing moves the target chart's token (and the new waiter's own), not an unrelated chart's
  await create('gamma', 'g', 'G');
  const before = [token('alpha'), token('beta'), token('gamma')];
  ok('gamma', ['todo', 'connect', 'condition', 'add', '--plan', 'g', '--task', 'G', '--to', 'task:alpha/a/P', '--reason', 'G uses P']);
  const after = [token('alpha'), token('beta'), token('gamma')];
  assert.notEqual(after[0], before[0]);
  assert.equal(after[1], before[1]);
});

test('target content: a digest of title, done condition, lane and split rides each task 接続 and moves the waiting token; a note does not', async (context) => {
  const { root, ok, entry } = await charts(context);
  const digestOf = () => entry().connections[0].target_content_digest;
  const token = () => ok('beta', ['charts', 'source', '--project', 'beta', '--json']).charts.beta;
  const first = digestOf();
  assert.match(first, /^[0-9a-f]{64}$/u);
  const base = { schema: 'lattice.plan_create_input.v5', phases: [{ phase_id: 'p', title: 'phase' }], hard_dependencies: [] };
  const task = { task_id: 'P', title: 'P', phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' };
  const revise = async (patch, more = []) => {
    await writeFile(path.join(root, 'alpha', 'revise.json'), JSON.stringify({ ...base, tasks: [{ ...task, ...patch }, ...more] }));
    ok('alpha', ['plan', 'revise', '--plan', 'a', '--input', 'revise.json']);
    return [digestOf(), token()];
  };
  let seen = [first, token()];
  // an unrelated event (a note on the target) moves neither
  ok('alpha', ['todo', 'note', '--plan', 'a', '--task', 'P', '--message', 'just a note']);
  assert.deepEqual([digestOf(), token()], seen);
  for (const patch of [{ title: 'P renamed' }, { done_condition: 'merged and released' }, { lane: 'bot-d' }]) {
    const next = await revise(patch);
    assert.notEqual(next[0], seen[0], JSON.stringify(patch));
    assert.notEqual(next[1], seen[1], JSON.stringify(patch));
    seen = next;
  }
  // a child task of the target (what `todo split` extracts) is part of its content; the design memo is not
  const child = { task_id: 'Q', title: 'Q', phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN', parent_task_id: 'P' };
  const withChild = await revise({ lane: 'bot-d' }, [child]);
  assert.notEqual(withChild[0], seen[0]);
  assert.notEqual(withChild[1], seen[1]);
  assert.equal((await revise({ lane: 'bot-d', design_memo: 'another memo' }, [child]))[0], withChild[0]);
});

test('todoTaskContentDigest covers title, done condition, lane, children and the split mark; nothing else', async () => {
  const { todoTaskContentDigest } = await import('../src/todo-store-view.mjs');
  const task = { task_id: 'T', title: 'T', done_condition: 'D', lane: 'L', function_split: null, design_memo: 'm', status: 'pending' };
  const kids = [{ task_id: 'c2', parent_task_id: 'T' }, { task_id: 'c1', parent_task_id: 'T' }, { task_id: 'x', parent_task_id: 'c1' }];
  const digest = todoTaskContentDigest(task, kids);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  for (const changed of [todoTaskContentDigest({ ...task, title: 'T2' }, kids), todoTaskContentDigest({ ...task, done_condition: 'D2' }, kids),
    todoTaskContentDigest({ ...task, done_condition: null }, kids), todoTaskContentDigest({ ...task, lane: 'L2' }, kids),
    todoTaskContentDigest({ ...task, function_split: { path: 'src/a.mjs', symbol: 'f', members: ['g'] } }, kids),
    todoTaskContentDigest(task, kids.slice(1)), todoTaskContentDigest(task, [])]) {
    assert.notEqual(changed, digest);
  }
  assert.equal(todoTaskContentDigest({ ...task, design_memo: 'other', status: 'done' }, [...kids].reverse()), digest);
});
