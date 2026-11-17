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
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
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

test('a name that does not exist yet keeps the row: it is a new name, listed with the nearest names (ADR 0204 §7)', async (context) => {
  const root = await fixture(context);
  const declared = success(root, declare('P', '--owns', 'src/a.js#alpa,src/a.js#beta', '--reads', 'src/b.js#nope_at_all'));
  assert.equal(declared.declaration.written, true);
  assert.deepEqual(declared.declaration.unresolved, []);
  const [near, none] = declared.declaration.new_names;
  assert.deepEqual([near.path, near.symbol], ['src/a.js', 'alpa']);
  assert.ok(near.nearest.includes('alpha'), JSON.stringify(near));
  assert.deepEqual([none.path, none.symbol], ['src/b.js', 'nope_at_all']);
  assert.deepEqual(declared.declaration.resolved.map(({ symbol }) => symbol), ['beta']);
  const row = (await readSet(root)).manual_witness.P;
  assert.deepEqual(row.concern_anchors, [{ within: { kind: 'path', target: 'src/a.js' }, symbols: ['alpa', 'beta'], new_symbols: ['alpa'] }]);
  assert.deepEqual(row.read_anchors, [{ within: { kind: 'path', target: 'src/b.js' }, symbols: ['nope_at_all'], new_symbols: ['nope_at_all'] }]);
  assert.equal(explainTodoWitnessSet(await readSet(root)).valid, true);
  // The same declaration with the right name replaces the row: no new name is left.
  const again = success(root, declare('P', '--owns', 'src/a.js#alpha'));
  assert.deepEqual(again.declaration.new_names, []);
  assert.equal((await readSet(root)).manual_witness.P.concern_anchors[0].new_symbols, undefined);
});

test('a new name says so in its own text: the nearest name only when there is one (ADR 0204 §7.4)', async (context) => {
  const root = await fixture(context);
  const declared = success(root, declare('P', '--owns', 'src/a.js#alpa,src/new.js#Fresh'));
  const [near, none] = declared.declaration.new_names;
  assert.equal(near.text, 'src/a.js#alpa: not in the code, recorded as a new function; if you meant alpha, declare again with that name');
  assert.deepEqual(none.nearest, []);
  assert.equal(none.text, 'src/new.js#Fresh: not in the code, recorded as a new function');
});

test('todo add whose declaration was not written carries the same next_action as witness declare (ADR 0204 §7.4)', async (context) => {
  const root = await fixture(context);
  const added = success(root, ['todo', 'add', '--plan', 'dev', '--task', 'S', '--title', 'S', '--phase', 'p', '--design-memo', 'NO_PLAN',
    '--owns', 'src/a.js#']);
  assert.equal(added.task_id, 'S');
  assert.equal(added.declaration.written, false);
  assert.match(added.declaration.next_action, /^dev\/S's functions were not recorded: src\/a\.js# \(expected_path_hash_symbol; write path#function/u);
  assert.equal(added.declaration.next_action, success(root, declare('Q', '--owns', 'src/a.js#')).next_action.replace('dev/Q', 'dev/S'));
  // a written declaration has none
  const fine = success(root, ['todo', 'add', '--plan', 'dev', '--task', 'T', '--title', 'T', '--phase', 'p', '--design-memo', 'NO_PLAN', '--owns', 'src/a.js#alpha']);
  assert.equal(fine.declaration.next_action, undefined);
});

test('new_symbols must be a sorted subset of symbols', async (context) => {
  const root = await fixture(context);
  success(root, declare('P', '--owns', 'src/a.js#alpa,src/a.js#beta'));
  for (const bad of [['gamma'], ['beta', 'alpa'], []]) {
    const set = structuredClone(await readSet(root));
    set.manual_witness.P.concern_anchors[0].new_symbols = bad;
    set.witness_set_digest = todoSelfDigest(set, 'witness_set_digest');
    assert.equal(explainTodoWitnessSet(set).valid, false, JSON.stringify(bad));
  }
});

test('a path or symbol Resolve cannot read is still not written', async (context) => {
  const root = await fixture(context);
  const declared = success(root, declare('P', '--owns', '../outside.js#alpha'));
  assert.equal(declared.declaration.written, false);
  assert.deepEqual(declared.declaration.unresolved.map(({ reason }) => reason), ['path_invalid']);
  await assert.rejects(readFile(path.join(root, '.lattice/todo/witness/dev.json')), { code: 'ENOENT' });
});

test('two tasks that declare the same new name conflict; a new name does not conflict with another function or another new name', async (context) => {
  const root = await fixture(context);
  success(root, declare('P', '--owns', 'src/a.js#Fresh'));
  const same = success(root, declare('Q', '--owns', 'src/a.js#Fresh'));
  assert.equal(same.declaration.conflicts.length, 1);
  assert.deepEqual(same.declaration.conflicts[0].overlaps[0].self, { symbol: 'Fresh', start_line: null, end_line: null, access: 'write' });
  const other = success(root, declare('Q', '--owns', 'src/a.js#alpha'));
  assert.deepEqual(other.declaration.conflicts, []);
  const otherNew = success(root, declare('Q', '--owns', 'src/a.js#Other'));
  assert.deepEqual(otherNew.declaration.conflicts, []);
  // a whole-file claim on that path overlaps the new name
  const whole = success(root, declare('Q', '--owns', 'src/a.js'));
  assert.equal(whole.declaration.conflicts.length, 1);
});

test('a name that was not declared as new and no longer resolves stays a whole-file claim', async (context) => {
  const root = await fixture(context);
  success(root, declare('P', '--owns', 'src/a.js#alpha'));
  await writeFile(path.join(root, 'src/a.js'), SOURCE.replace('alpha', 'alphaRenamed'));
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-am', 'rename'], { cwd: root, stdio: 'pipe' });
  success(root, ['sensor', 'sync', '.', '--json']);
  const declared = success(root, declare('Q', '--owns', 'src/a.js#beta'));
  assert.equal(declared.declaration.conflicts.length, 1);
  assert.deepEqual(declared.declaration.conflicts[0].overlaps[0].other, { symbol: null, start_line: null, end_line: null, access: 'write' });
});

test('a whole code file is accepted as today and the result says how many functions it makes conflicting (ADR 0204 §7.3)', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'README.md'), '# notes\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'docs');
  const declared = success(root, declare('P', '--owns', 'src/a.js,README.md', '--reads', 'src/b.js'));
  assert.equal(declared.declaration.written, true);
  const [a, b] = declared.declaration.whole_files;
  assert.deepEqual([a.path, a.access, a.functions > 1, a.candidates], ['src/a.js', 'write', true, []]);
  assert.deepEqual([b.path, b.access], ['src/b.js', 'read']);
  assert.equal(declared.declaration.whole_files.length, 2, 'README.md has no functions: no entry');
  assert.equal(a.text, `src/a.js: whole file, its ${a.functions} functions all conflict; by function: --owns src/a.js#<function>`);
  // a function claim, even next to a whole file elsewhere, gets no entry for the file it names functions in
  const narrowed = success(root, declare('Q', '--owns', 'src/a.js#alpha', '--reads', 'src/b.js#beta'));
  assert.deepEqual(narrowed.declaration.whole_files, []);
});

test('whole_files candidates are the functions the title and design memo name in that file; an add keeps the file', async (context) => {
  const root = await fixture(context);
  const added = success(root, ['todo', 'add', '--plan', 'dev', '--task', 'S', '--title', 'S', '--phase', 'p',
    '--design-memo', 'Change `beta` so it returns more.', '--owns', 'src/a.js']);
  assert.equal(added.declaration.written, true);
  const [entry] = added.declaration.whole_files;
  assert.deepEqual(entry.candidates, ['beta']);
  assert.match(entry.text, /^src\/a\.js: whole file, its \d+ functions all conflict; by function: --owns src\/a\.js#beta$/u);
  assert.equal((await readSet(root)).manual_witness.S.concern_anchors, undefined);
});

test('a Store root with no commit leaves whole_files out; the declaration is unaffected', async (context) => {
  const root = await fixture(context, { commit: false });
  const declared = success(root, declare('P', '--owns', 'src/a.js'));
  assert.equal(declared.declaration.written, true);
  assert.deepEqual(declared.declaration.whole_files, []);
});

test('a malformed entry is reported, not recorded', async (context) => {
  const root = await fixture(context);
  const declared = success(root, declare('P', '--owns', 'src/a.js#,src/b.js'));
  assert.equal(declared.declaration.written, false);
  assert.deepEqual(declared.declaration.malformed, [{ text: 'src/a.js#', reason: 'expected_path_hash_symbol' }]);
  assert.match(declared.next_action, /write path#function/u);
});

test('functions on a Store root with no commit cannot be checked: the row is written with the names as new names', async (context) => {
  const root = await fixture(context, { commit: false });
  const declared = success(root, declare('P', '--owns', 'src/a.js#alpha'));
  assert.equal(declared.declaration.written, true);
  assert.deepEqual(declared.declaration.new_names.map(({ symbol }) => symbol), ['alpha']);
  assert.deepEqual((await readSet(root)).manual_witness.P.concern_anchors[0].new_symbols, ['alpha']);
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
  assert.equal(second.declaration.written, true);
  assert.ok(second.declaration.new_names[0].nearest.includes('beta'));
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
