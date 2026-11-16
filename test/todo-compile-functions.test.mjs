// a5b (ADR 0204 §6): the independence compile judges a path declared with functions by those functions only.
// Different functions of one file no longer conflict; the same function, overlapping lines, read x write on a function,
// and a plain whole-file claim still do.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refineResourcesByFunction, rangeIndex } from '../src/todo-judgment.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ENV = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
  LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' };
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: ENV });
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
const SOURCE = 'export function alpha() { return 1; }\n\nexport function beta() { return 2; }\n';

async function repo(context, taskIds) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a5b-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), SOURCE);
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: taskIds.map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })) }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const declare = (root, taskId, ...flags) => success(root, ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', taskId, ...flags]);
const conflictsAfter = async (root) => {
  const compiled = success(root, ['todo', 'independence', 'compile', '--plan', 'dev', '--input', '.lattice/todo/witness/dev.json']);
  return compiled.conflict_count;
};

test('refineResourcesByFunction splits a shared path resource to the pairs that overlap and leaves the rest alone', () => {
  const row = (target, symbols, access = 'write') => ({ owns: access === 'write' ? [{ kind: 'path', target }] : [], reads: access === 'read' ? [target] : [],
    writes: access === 'write' ? [target] : [],
    ...(access === 'write' ? { concern_anchors: [{ within: { kind: 'path', target }, symbols }] } : { read_anchors: [{ within: { kind: 'path', target }, symbols }] }) });
  const rows = { A: row('a.js', ['alpha']), B: row('a.js', ['beta']), C: row('a.js', ['alpha']), W: { owns: [{ kind: 'path', target: 'a.js' }], reads: [], writes: ['a.js'] } };
  const ranges = rangeIndex([{ path: 'a.js', symbol: 'alpha', start_line: 1, end_line: 3 }, { path: 'a.js', symbol: 'beta', start_line: 5, end_line: 7 }]);
  const refine = refineResourcesByFunction({ rows, ranges });
  const own = (ids) => ({ resource_id: 'own-path-x', kind: 'path', target: 'a.js', todo_ids: ids, provenance: [] });
  assert.deepEqual(refine([own(['A', 'B'])]), []);
  assert.deepEqual(refine([own(['A', 'C'])]).map(({ todo_ids: ids }) => ids), [['A', 'C']]);
  assert.deepEqual(refine([own(['A', 'B', 'C'])]).map(({ todo_ids: ids }) => ids), [['A', 'C']]);
  assert.equal(refine([own(['A', 'W'])]).length, 1);
  const other = { resource_id: 'state-x', kind: 'state', target: 'a.js', todo_ids: ['A', 'B'], provenance: [] };
  assert.deepEqual(refine([other]), [other]);
});

test('compile: functions of one file do not conflict, the same function and a whole-file claim do', async (context) => {
  const root = await repo(context, ['P', 'Q', 'R', 'T']);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  declare(root, 'Q', '--owns', 'src/a.js#beta');
  assert.equal(await conflictsAfter(root), 0);
  declare(root, 'R', '--owns', 'src/a.js#alpha');
  assert.equal(await conflictsAfter(root), 1);
  declare(root, 'R', '--owns', 'src/a.js#beta');
  declare(root, 'Q', '--owns', 'src/a.js#beta');
  assert.equal(await conflictsAfter(root), 1);
  declare(root, 'T', '--owns', 'src/a.js');
  assert.ok(await conflictsAfter(root) >= 3);
});

test('compile: a read of the function another task writes conflicts, a read of another function does not', async (context) => {
  const root = await repo(context, ['P', 'Q']);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  declare(root, 'Q', '--owns', 'src/a.js#beta', '--reads', 'src/a.js#beta');
  assert.equal(await conflictsAfter(root), 0);
  declare(root, 'Q', '--owns', 'src/a.js#beta', '--reads', 'src/a.js#alpha');
  assert.equal(await conflictsAfter(root), 1);
});

test('enforced start: two tasks on different functions of one file both start; the same function is refused', async (context) => {
  const root = await repo(context, ['P', 'Q', 'R']);
  success(root, ['todo', 'independence', 'mode', '--plan', 'dev', '--set', 'enforced', '--reason', 'test']);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  declare(root, 'Q', '--owns', 'src/a.js#beta');
  declare(root, 'R', '--owns', 'src/a.js#alpha');
  success(root, ['todo', 'start', '--plan', 'dev', '--task', 'P']);
  success(root, ['todo', 'start', '--plan', 'dev', '--task', 'Q']);
  const refused = run(root, ['todo', 'start', '--plan', 'dev', '--task', 'R']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /enforced_conflict_with_active/u);
});
