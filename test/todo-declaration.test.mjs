// a3b (ADR 0204): the functions a task changes are declared with `path#symbol`, resolved through the code graph, and
// refused with the nearest names when unresolved; the add and the command still succeed.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseDeclarationList } from '../src/todo-declaration.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';
import { explainTodoWitnessSet } from '../src/todo-independence-contracts.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const SOURCE = `export function alpha() { return 1; }

export function beta() { return 2; }

export class Box {
  open() { return 3; }
}
`;

async function fixture(context, { commit = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a3b-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  for (const name of ['a', 'b']) await writeFile(path.join(root, 'src', `${name}.js`), SOURCE);
  if (commit) {
    git('add', '.');
    git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  }
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: ['P', 'Q'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })),
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const declare = (taskId, ...flags) => ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', taskId, ...flags];
const readSet = async (root) => JSON.parse(await readFile(path.join(root, '.lattice/todo/witness/dev.json'), 'utf8'));

test('parseDeclarationList: bare paths, path#symbol anchors, and entries that cannot be stored', () => {
  const parsed = parseDeclarationList('src/a.js, src/b.js#Box.open,src/c.js#,#x,src/d.rb#Foo#bar');
  assert.deepEqual(parsed.paths, ['src/a.js']);
  assert.deepEqual(parsed.anchors, [{ path: 'src/b.js', symbol: 'Box.open' }]);
  assert.deepEqual(parsed.malformed.map(({ reason }) => reason),
    ['expected_path_hash_symbol', 'expected_path_hash_symbol', 'symbol_not_a_dotted_identifier']);
  assert.deepEqual(parseDeclarationList(undefined), { paths: [], anchors: [], malformed: [] });
});

test('declare resolves --owns path#symbol into concern_anchors and keeps the witness set at v5', async (context) => {
  const root = await fixture(context);
  const declared = success(root, declare('P', '--owns', 'src/a.js#alpha,src/a.js#Box.open'));
  assert.equal(declared.schema, 'lattice.todo_witness_declare_result.v2');
  assert.equal(declared.declaration.written, true);
  assert.deepEqual(declared.declaration.resolved.map(({ symbol, start_line: start }) => [symbol, start]),
    [['alpha', 1], ['Box.open', 6]]);
  assert.deepEqual(declared.owns, ['src/a.js']);
  const set = await readSet(root);
  assert.equal(set.schema, 'lattice.todo_witness_set.v5');
  assert.deepEqual(set.manual_witness.P.concern_anchors, [{ within: { kind: 'path', target: 'src/a.js' }, symbols: ['Box.open', 'alpha'] }]);
  assert.equal(explainTodoWitnessSet(set).valid, true);
});

test('--reads path#symbol writes read_anchors and moves the set to v6; v5 refuses the field', async (context) => {
  const root = await fixture(context);
  success(root, declare('P', '--owns', 'src/a.js#alpha', '--reads', 'src/b.js#beta'));
  const set = await readSet(root);
  assert.equal(set.schema, 'lattice.todo_witness_set.v6');
  assert.deepEqual(set.manual_witness.P.reads, ['src/b.js']);
  assert.deepEqual(set.manual_witness.P.read_anchors, [{ within: { kind: 'path', target: 'src/b.js' }, symbols: ['beta'] }]);
  assert.equal(explainTodoWitnessSet(set).valid, true);
  // The probe request never carries the anchors; an older schema cannot carry them.
  const v5 = structuredClone(set);
  v5.schema = 'lattice.todo_witness_set.v5';
  v5.witness_set_digest = todoSelfDigest(v5, 'witness_set_digest');
  assert.equal(explainTodoWitnessSet(v5).reason, 'read_anchors_require_witness_set_v6');
  // A read anchor must sit inside a path the task reads.
  const stray = structuredClone(set);
  stray.manual_witness.P.read_anchors[0].within.target = 'src/a.js';
  stray.witness_set_digest = todoSelfDigest(stray, 'witness_set_digest');
  assert.equal(explainTodoWitnessSet(stray).valid, false);
  // Re-declaring without reads goes back to v5: the version follows what the plan uses.
  success(root, declare('P', '--owns', 'src/a.js#alpha'));
  assert.equal((await readSet(root)).schema, 'lattice.todo_witness_set.v5');
});

test('an unresolved name is refused with the nearest names, exit 0, and nothing is written', async (context) => {
  const root = await fixture(context);
  const declared = success(root, declare('P', '--owns', 'src/a.js#alpa,src/a.js#beta', '--reads', 'src/b.js#nope_at_all'));
  assert.equal(declared.declaration.written, false);
  const [near, none] = declared.declaration.unresolved;
  assert.deepEqual([near.path, near.symbol, near.reason], ['src/a.js', 'alpa', 'symbol_not_found']);
  assert.ok(near.nearest.includes('alpha'), JSON.stringify(near));
  assert.deepEqual([none.symbol, none.nearest.length >= 0], ['nope_at_all', true]);
  assert.equal(declared.witness_ref, null);
  assert.match(declared.next_action, /src\/a\.js#alpa \(symbol_not_found\); nearest: .*alpha/u);
  await assert.rejects(readFile(path.join(root, '.lattice/todo/witness/dev.json')), { code: 'ENOENT' });
  // The same declaration with the right name then succeeds from scratch.
  assert.equal(success(root, declare('P', '--owns', 'src/a.js#alpha')).declaration.written, true);
});

test('a malformed entry is reported, not recorded', async (context) => {
  const root = await fixture(context);
  const declared = success(root, declare('P', '--owns', 'src/a.js#,src/b.js'));
  assert.equal(declared.declaration.written, false);
  assert.deepEqual(declared.declaration.malformed, [{ text: 'src/a.js#', reason: 'expected_path_hash_symbol' }]);
  assert.match(declared.next_action, /write path#function/u);
});

test('functions on a Store root with no commit cannot be checked: reported, never recorded as a guess', async (context) => {
  const root = await fixture(context, { commit: false });
  const declared = success(root, declare('P', '--owns', 'src/a.js#alpha'));
  assert.equal(declared.declaration.written, false);
  assert.deepEqual(declared.declaration.unresolved.map(({ reason }) => reason), ['no_code_tree']);
  // Bare paths still declare there, as before.
  assert.equal(success(root, declare('P', '--owns', 'src/a.js')).declaration.written, true);
});

test('todo add --owns/--reads: the task is added first; the declaration comes back in the result', async (context) => {
  const root = await fixture(context);
  const added = success(root, ['todo', 'add', '--plan', 'dev', '--task', 'S', '--title', 'S', '--phase', 'p', '--design-memo', 'NO_PLAN',
    '--owns', 'src/a.js#beta', '--reads', 'src/b.js#alpha']);
  assert.equal(added.schema, 'lattice.todo_task_add_result.v2');
  assert.equal(added.declaration.written, true);
  assert.equal((await readSet(root)).manual_witness.S.concern_anchors[0].symbols[0], 'beta');
  // A wrong name does not undo the add.
  const second = success(root, ['todo', 'add', '--plan', 'dev', '--task', 'T', '--title', 'T', '--phase', 'p', '--design-memo', 'NO_PLAN',
    '--owns', 'src/a.js#betta']);
  assert.equal(second.task_id, 'T');
  assert.equal(second.declaration.written, false);
  assert.ok(second.declaration.unresolved[0].nearest.includes('beta'));
  const shown = success(root, ['todo', 'show', '--plan', 'dev', '--task', 'T']);
  assert.equal(shown.task.task_id, 'T');
});

test('todo add without seeds proposes the graph names its title and memo mention, and records nothing', async (context) => {
  const root = await fixture(context);
  // The proposal needs an existing index; the first declaration builds it.
  success(root, declare('P', '--owns', 'src/a.js#alpha'));
  const added = success(root, ['todo', 'add', '--plan', 'dev', '--task', 'S', '--title', 'S', '--phase', 'p',
    '--design-memo', 'Change `beta` so it returns more.']);
  assert.equal(added.declaration.written, false);
  assert.deepEqual(added.declaration.proposed.proposed.map(({ name }) => name), ['beta']);
  assert.equal((await readSet(root)).manual_witness.S, undefined);
});
