// n3-store-task-added: readTodoTaskAdded names who added each task, from the retained revisions.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTodoStore, readTodoTaskAdded } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(cwd, agent, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: agent } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const add = (root, agent, id, extra = []) => run(root, agent, ['todo', 'add', '--plan', 'work', '--task', id, '--title', id,
  '--phase', 'p1', '--lane', 'bot-c', '--design-memo', 'NO_PLAN', '--reason', 'test', ...extra]);

test('a task has an entry from the revision that added it, plan-create tasks the creator; the walk follows carried ids', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-added-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'work', phases: [{ phase_id: 'p1', title: 'phase' }],
    tasks: ['a', 'b'].map((id) => ({ task_id: id, title: id, phase_id: 'p1', lane: 'bot-c', design_memo: 'NO_PLAN' })),
    hard_dependencies: [],
  }));
  run(root, 'creator', ['plan', 'create', '--input', 'plan.json']);
  const read = async () => {
    const store = await readTodoStore({ repoRoot: root });
    return readTodoTaskAdded({ repoRoot: root, member: store.members[0] });
  };
  // Plan create alone: its tasks belong to the creator (the first version's genesis).
  const created = await read();
  assert.deepEqual([...created.keys()].sort(), ['a', 'b']);
  assert.deepEqual([created.get('a').agent, created.get('b').agent], ['creator', 'creator']);
  add(root, 'x', 'c');
  add(root, 'y', 'd', ['--after', 'c']);
  add(root, 'z', 'e');
  const added = await read();
  assert.deepEqual([...added.keys()].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((id) => added.get(id).agent), ['creator', 'creator', 'x', 'y', 'z']);
  assert.equal(added.get('a').at, created.get('a').at);
  assert.ok(added.get('c').at < added.get('e').at && /^\d{4}-\d\d-\d\dT/u.test(added.get('c').at));
  // Reading again after another revision does not serve the memoized map.
  add(root, 'w', 'f');
  assert.equal((await read()).get('f').agent, 'w');
  assert.equal((await read()).get('c').agent, 'x');
  // The cache of the head one revision back is used: a planted value (with a valid digest) shows through; a bad digest is a miss.
  const cacheFile = path.join(root, '.lattice/generated/store-task-added/work.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(cache.tasks.a[1], 'creator');
  assert.deepEqual(Object.keys(cache.tasks).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  const plant = async (mutate, digest = true) => {
    const { cache_digest: _old, ...body } = JSON.parse(await readFile(cacheFile, 'utf8'));
    mutate(body);
    const text = JSON.stringify(body);
    await writeFile(cacheFile, digest ? `${text.slice(0, -1)},"cache_digest":"${createHash('sha256').update(text).digest('hex')}"}` : text);
  };
  await plant((body) => { body.tasks.c = ['2000-01-01T00:00:00.000Z', 'planted']; });
  add(root, 'v', 'g');
  const next = await read();
  assert.deepEqual([next.get('c').agent, next.get('g').agent], ['planted', 'v']);
  await plant((body) => { body.tasks.c = ['2000-01-01T00:00:00.000Z', 'planted']; }, false);
  add(root, 'u', 'h');
  const rebuilt = await read();
  assert.deepEqual([rebuilt.get('c').agent, rebuilt.get('h').agent], ['x', 'u']);
  // A v1 cache (null for plan-create tasks) is a miss and is rebuilt.
  await plant((body) => { body.schema = 'lattice.todo_task_added_cache.v1'; body.tasks.a = null; });
  add(root, 's', 'j');
  const upgraded = await read();
  assert.deepEqual([upgraded.get('a').agent, upgraded.get('j').agent], ['creator', 's']);
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).schema, 'lattice.todo_task_added_cache.v2');
  // A cache that cannot be written never fails the read.
  await rm(path.join(root, '.lattice/generated/store-task-added'), { recursive: true });
  await writeFile(path.join(root, '.lattice/generated/store-task-added'), 'not a directory');
  add(root, 't', 'i');
  assert.equal((await read()).get('i').agent, 't');
  assert.equal((await read()).get('c').agent, 'x');
});
