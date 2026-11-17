// b5 (ADR 0205 §3-§6): `todo function-split verify|decline`, the not-split reorganization and `todo done S` (gate + rewrite).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { moveAnchor, parseSplitMap } from '../src/todo-function-split.mjs';
import { readTodoStore, readTodoWitnessSet } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ENV = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
  LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' };
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: ENV });
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
const refusal = (root, args) => {
  const result = run(root, args);
  assert.notEqual(result.status, 0, `${args.join(' ')} should be refused`);
  return result.stderr + result.stdout;
};

const BASE = 'export function work(x) {\n  const a = x + 1;\n  const b = a * 2;\n  return b - 1;\n}\n';
const CUT = 'function stepA(x) {\n  return x + 1;\n}\nfunction stepB(a) {\n  return a * 2 - 1;\n}\nexport function work(x) {\n  return stepB(stepA(x));\n}\n';
const BROKEN = 'function stepA(x) {\n  return x + 1;\n}\nfunction stepB(a) {\n  return a * 2 - 1;\n}\nexport function other(x) {\n  return stepB(stepA(x));\n}\n';
const TEST = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { work } from '../src/lib.mjs';\ntest('work', () => assert.equal(work(1), 3));\n";

/** A repo with plan `dev`: U (lane-a, in progress) and T (lane-b) both own src/lib.mjs#work, so T's start made the split S. */
async function split(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-b5-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  await put('.gitignore', '.lattice/\n');
  await put('src/lib.mjs', BASE);
  await put('test/lib.test.mjs', TEST);
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: [['U', 'lane-a'], ['T', 'lane-b']].map(([task_id, lane]) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN', lane })) }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  success(root, ['todo', 'independence', 'mode', '--plan', 'dev', '--set', 'witness', '--reason', 'fixture']);
  for (const id of ['U', 'T']) success(root, ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', id, '--owns', 'src/lib.mjs#work']);
  success(root, ['todo', 'start', '--plan', 'dev', '--task', 'U']);
  const [{ task_id: splitId }] = success(root, ['todo', 'start', '--plan', 'dev', '--task', 'T']).splits;
  const commitOn = async (branch, files) => {
    git('checkout', '-q', '-b', branch, 'main');
    for (const [file, text] of Object.entries(files)) await put(file, text);
    git('add', '-A'); git('commit', '-q', '-m', 'cut');
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return sha;
  };
  return { root, git, splitId, commitOn };
}
const member = async (root) => (await readTodoStore({ repoRoot: root })).members.find(({ plan }) => plan.plan_key === 'dev');
const status = (m, id) => m.tasks.find(({ task_id: taskId }) => taskId === id).status;
const edges = (m) => m.plan.hard_dependencies.map(({ from, to }) => `${from.task_id}>${to.task_id}`).sort();

test('decline retires S, makes the member in progress the predecessor of the other, and notes both', async (context) => {
  const { root, splitId } = await split(context);
  const result = success(root, ['todo', 'function-split', 'decline', '--plan', 'dev', '--task', splitId, '--reason', 'too heavy for today']);
  assert.equal(result.outcome, 'declined');
  assert.deepEqual(result.predecessor_edges, [{ from: 'U', to: 'T' }]);
  const m = await member(root);
  assert.equal(status(m, splitId), 'retired');
  assert.ok(edges(m).includes('U>T'));
  assert.equal(status(m, 'U'), 'in-progress');
  const notes = JSON.stringify(success(root, ['todo', 'note', 'list', '--plan', 'dev', '--json']));
  assert.match(notes, /was not made: too heavy for today; T now waits for U/u);
  // the same decline again changes nothing
  assert.notEqual(success(root, ['todo', 'function-split', 'decline', '--plan', 'dev', '--task', splitId, '--reason', 'too heavy for today']), null);
  assert.equal(edges(await member(root)).filter((edge) => edge === 'U>T').length, 1);
});

test('decline with no member in progress adds no edge', async (context) => {
  const { root, splitId } = await split(context);
  success(root, ['todo', 'retract', '--plan', 'dev', '--task', 'U', '--reason', 'paused']);
  const result = success(root, ['todo', 'function-split', 'decline', '--plan', 'dev', '--task', splitId, '--reason', 'no cut']);
  assert.deepEqual(result.predecessor_edges, []);
  assert.equal(status(await member(root), splitId), 'retired');
});

test('decline after U redeclared away from the function: the overlap is gone, T gets no edge and starts at once', async (context) => {
  const { root, git, splitId } = await split(context);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/other.mjs'), 'export function elsewhere() {\n  return 1;\n}\n');
  git('add', '-A'); git('commit', '-q', '-m', 'other');
  // U moves its change out of `work` and declares again: ADR 0204 judges the relations again and closes the one with T
  success(root, ['sensor', 'sync', '.', '--json']);
  assert.equal(success(root, ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', 'U', '--owns', 'src/other.mjs#elsewhere']).declaration.written, true);
  const result = success(root, ['todo', 'function-split', 'decline', '--plan', 'dev', '--task', splitId, '--reason', 'moved out']);
  assert.deepEqual(result.predecessor_edges, []);
  const m = await member(root);
  assert.equal(status(m, splitId), 'retired');
  assert.ok(!edges(m).includes('U>T'));
  const notes = JSON.stringify(success(root, ['todo', 'note', 'list', '--plan', 'dev', '--json']));
  assert.match(notes, /was not made: moved out; the overlap with U is gone, T does not wait/u);
  assert.doesNotMatch(notes, /now waits for/u);
  assert.equal(success(root, ['todo', 'start', '--plan', 'dev', '--task', 'T']).status, 'in-progress');
});

test('done S is refused until verify accepts, and a task that is not a split task is refused by the new commands', async (context) => {
  const { root, splitId } = await split(context);
  assert.match(refusal(root, ['todo', 'done', '--plan', 'dev', '--task', splitId, '--message', 'x']), /split_not_accepted/u);
  assert.match(refusal(root, ['todo', 'function-split', 'decline', '--plan', 'dev', '--task', 'T', '--reason', 'x']), /not_a_split_task/u);
  assert.match(refusal(root, ['todo', 'function-split', 'verify', '--plan', 'dev', '--task', splitId, '--commit', 'a'.repeat(40), '--map', 'Z=src/lib.mjs#f']), /function_split_map_invalid/u);
});

test('an accepted cut: done S rewrites both rows and closes the relation', async (context) => {
  const { root, git, splitId, commitOn } = await split(context);
  success(root, ['todo', 'start', '--plan', 'dev', '--task', splitId]);
  const commit = await commitOn('cut', { 'src/lib.mjs': CUT });
  const verified = success(root, ['todo', 'function-split', 'verify', '--plan', 'dev', '--task', splitId, '--commit', commit,
    '--map', 'U=src/lib.mjs#stepA,T=src/lib.mjs#stepB']);
  assert.equal(verified.outcome, 'accepted', JSON.stringify(verified.conditions));
  assert.deepEqual(Object.keys(verified.conditions), ['behaviour', 'tests', 'fresh', 'overlap', 'parallel']);
  assert.match(verified.conditions.parallel.detail, /waves 2 -> 1/u);
  // the new functions are on a branch, not on main yet: done still rewrites both rows, keeping the names as new names (ADR 0204 §7)
  const done = success(root, ['todo', 'done', '--plan', 'dev', '--task', splitId, '--message', 'merged the cut']);
  assert.equal(done.status, 'done');
  assert.deepEqual((await readTodoWitnessSet({ repoRoot: root, planKey: 'dev' })).manual_witness.U.concern_anchors[0].new_symbols, ['stepA']);
  git('merge', '--ff-only', 'cut');
  success(root, ['sensor', 'sync', '.', '--json']); // what `chart repo sync` does after it takes main in
  const witness = (await readTodoWitnessSet({ repoRoot: root, planKey: 'dev' })).manual_witness;
  assert.deepEqual(witness.U.concern_anchors.map(({ symbols }) => symbols), [['stepA']]);
  assert.deepEqual(witness.T.concern_anchors.map(({ symbols }) => symbols), [['stepB']]);
  assert.deepEqual(success(root, ['todo', 'show', '--plan', 'dev', '--task', 'T']).relations?.open ?? [], []);
  // T is offered again and starts in parallel with U
  assert.equal(success(root, ['todo', 'start', '--plan', 'dev', '--task', 'T']).status, 'in-progress');
});

test('a cut that breaks behaviour is rejected, recorded and reorganized as not split', async (context) => {
  const { root, splitId, commitOn } = await split(context);
  const commit = await commitOn('bad', { 'src/lib.mjs': BROKEN });
  const verified = success(root, ['todo', 'function-split', 'verify', '--plan', 'dev', '--task', splitId, '--commit', commit,
    '--map', 'U=src/lib.mjs#stepA,T=src/lib.mjs#stepB']);
  assert.equal(verified.outcome, 'rejected');
  assert.equal(verified.conditions.behaviour.passed, false);
  assert.equal(verified.reorganized.outcome, 'declined');
  assert.match(verified.reorganized.reason, /verify rejected \(.*behaviour/u);
  const m = await member(root);
  assert.equal(status(m, splitId), 'retired');
  assert.ok(edges(m).includes('U>T'));
});

test('parseSplitMap and moveAnchor', () => {
  assert.deepEqual(parseSplitMap('T=b.js#g,U=a.js#f', ['T', 'U']), [{ task_id: 'T', path: 'b.js', symbol: 'g' }, { task_id: 'U', path: 'a.js', symbol: 'f' }]);
  for (const bad of ['', 'U=a.js', 'X=a.js#f', 'U=a.js#f,U=a.js#g']) assert.throws(() => parseSplitMap(bad, ['T', 'U']), /function_split_map_invalid/u);
  const row = { owns: [{ kind: 'path', target: 'a.js' }], reads: [], writes: [],
    concern_anchors: [{ within: { kind: 'path', target: 'a.js' }, symbols: ['f', 'h'] }] };
  const moved = moveAnchor(row, { path: 'a.js', symbol: 'f' }, { path: 'b.js', symbol: 'g' });
  assert.deepEqual(moved.concern_anchors.map(({ within, symbols }) => [within.target, symbols]), [['a.js', ['h']], ['b.js', ['g']]]);
  assert.deepEqual(moved.owns.map(({ target }) => target), ['a.js', 'b.js']);
  assert.equal(moveAnchor(moved, { path: 'a.js', symbol: 'f' }, { path: 'b.js', symbol: 'g' }), null);
  const whole = moveAnchor({ ...row, concern_anchors: [{ within: { kind: 'path', target: 'a.js' }, symbols: ['f'] }] }, { path: 'a.js', symbol: 'f' }, { path: 'b.js', symbol: 'g' });
  assert.deepEqual(whole.owns.map(({ target }) => target), ['b.js'], 'a file left with no anchor is not claimed whole');
});
