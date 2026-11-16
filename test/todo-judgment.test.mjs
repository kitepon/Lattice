// a5 (ADR 0204 §3): the add-time judgment. Unit: judgeTask on witness rows and ranges. Integration: `witness declare` and
// `todo add --owns` append function-level relations, list them in the result, never refuse, and close them when a claim moves.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claimsOf, judgeTask, neededAnchors, rangeIndex } from '../src/todo-judgment.mjs';

const row = ({ owns = [], reads = [], writes = [], concern = [], readAnchors = [] }) => ({
  owns: owns.map((target) => ({ kind: 'path', target })), reads, writes,
  ...(concern.length > 0 ? { concern_anchors: concern.map(([target, symbols]) => ({ within: { kind: 'path', target }, symbols })) } : {}),
  ...(readAnchors.length > 0 ? { read_anchors: readAnchors.map(([target, symbols]) => ({ within: { kind: 'path', target }, symbols })) } : {}),
});
const ranges = rangeIndex([
  { path: 'a.js', symbol: 'alpha', start_line: 1, end_line: 3 },
  { path: 'a.js', symbol: 'beta', start_line: 5, end_line: 7 },
  { path: 'a.js', symbol: 'Box', start_line: 1, end_line: 10 },
  { path: 'a.js', symbol: 'Box.open', start_line: 6, end_line: 8 },
]);

test('judgeTask: different functions of one file do not conflict, the same function does, overlapping ranges do', () => {
  const rows = { P: row({ owns: ['a.js'], concern: [['a.js', ['alpha']]] }), Q: row({ owns: ['a.js'], concern: [['a.js', ['beta']]] }),
    R: row({ owns: ['a.js'], concern: [['a.js', ['alpha']]] }), S: row({ owns: ['a.js'], concern: [['a.js', ['Box.open']]] }) };
  assert.deepEqual(judgeTask({ taskId: 'Q', rows: { P: rows.P, Q: rows.Q }, ranges }).relations, []);
  const same = judgeTask({ taskId: 'R', rows: { P: rows.P, R: rows.R }, ranges }).relations;
  assert.deepEqual(same.map(({ task_a: a, task_b: b, path: where }) => [a, b, where]), [['P', 'R', 'a.js']]);
  assert.deepEqual(same[0].overlaps, [{ a: { symbol: 'alpha', start_line: 1, end_line: 3, access: 'write' },
    b: { symbol: 'alpha', start_line: 1, end_line: 3, access: 'write' } }]);
  // Box.open (6-8) overlaps beta (5-7) by range though the names differ.
  assert.equal(judgeTask({ taskId: 'S', rows: { Q: rows.Q, S: rows.S }, ranges }).relations.length, 1);
});

test('judgeTask: read x write conflicts, read x read does not, a plain path is a whole-file claim', () => {
  const writer = row({ owns: ['a.js'], concern: [['a.js', ['alpha']]] });
  const reader = row({ reads: ['a.js'], readAnchors: [['a.js', ['alpha']]] });
  const otherReader = row({ reads: ['a.js'], readAnchors: [['a.js', ['alpha']]] });
  const whole = row({ owns: ['a.js'] });
  const [found] = judgeTask({ taskId: 'R', rows: { W: writer, R: reader }, ranges }).relations;
  assert.deepEqual([found.task_a, found.task_b, found.overlaps[0].a.access, found.overlaps[0].b.access], ['R', 'W', 'read', 'write']);
  assert.deepEqual(judgeTask({ taskId: 'R', rows: { R: reader, S: otherReader }, ranges }).relations, []);
  const wholeFile = judgeTask({ taskId: 'X', rows: { P: writer, X: whole }, ranges }).relations[0];
  assert.deepEqual(wholeFile.overlaps, [{ a: { symbol: 'alpha', start_line: 1, end_line: 3, access: 'write' },
    b: { symbol: null, start_line: null, end_line: null, access: 'write' } }]);
  // A whole-file read of a file another task writes conflicts; two whole-file reads do not.
  assert.equal(judgeTask({ taskId: 'X', rows: { X: row({ reads: ['a.js'] }), W: whole }, ranges }).relations.length, 1);
  assert.equal(judgeTask({ taskId: 'X', rows: { X: row({ reads: ['a.js'] }), Y: row({ reads: ['a.js'] }) }, ranges }).relations.length, 0);
});

test('judgeTask: a name with no range is a whole-file claim and counted; moved claims go `gone`; neededAnchors lists the others only', () => {
  const rows = { P: row({ owns: ['a.js'], concern: [['a.js', ['alpha']]] }), Q: row({ owns: ['a.js'], concern: [['a.js', ['lost']]] }) };
  const judged = judgeTask({ taskId: 'Q', rows, ranges });
  assert.equal(judged.unresolved, 1);
  assert.equal(judged.relations[0].overlaps[0].b.symbol, null);
  const moved = judgeTask({ taskId: 'Q', rows: { P: rows.P, Q: row({ owns: ['b.js'] }) }, ranges, openRelations: [
    { task_a: 'P', task_b: 'Q', path: 'a.js' }, { task_a: 'P', task_b: 'Z', path: 'a.js' }] });
  assert.deepEqual(moved.gone, [{ task_a: 'P', task_b: 'Q', path: 'a.js' }]);
  assert.deepEqual(neededAnchors(rows, 'Q', new Set(['a.js'])), [{ path: 'a.js', symbol: 'alpha' }]);
  assert.deepEqual(neededAnchors(rows, 'Q', new Set(['b.js'])), []);
  assert.equal(claimsOf(rows.P).get('a.js')[0].access, 'write');
});

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

async function repo(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a5-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), SOURCE);
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: ['P', 'Q', 'R'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })) }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const declare = (root, taskId, ...flags) => success(root, ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', taskId, ...flags]);
const summaryOf = async (root) => JSON.parse(await readFile(path.join(root, '.lattice/todo/relations/dev/summary.json'), 'utf8'));

test('declare: functions of one file that differ record no relation; the same function records one and lists it, the add is never refused', async (context) => {
  const root = await repo(context);
  assert.deepEqual(declare(root, 'P', '--owns', 'src/a.js#alpha').declaration.conflicts, []);
  const apart = declare(root, 'Q', '--owns', 'src/a.js#beta');
  assert.deepEqual(apart.declaration.conflicts, []);
  assert.equal((await summaryOf(root)).relation_count, 0);
  const clash = declare(root, 'R', '--owns', 'src/a.js#alpha');
  assert.equal(clash.declaration.written, true);
  assert.deepEqual(clash.declaration.conflicts.map(({ with: other, path: where }) => [other, where]), [['P', 'src/a.js']]);
  assert.deepEqual(clash.declaration.conflicts[0].overlaps[0].self, { symbol: 'alpha', start_line: 1, end_line: 1, access: 'write' });
  const summary = await summaryOf(root);
  assert.equal(summary.relation_count, 1);
  assert.deepEqual([summary.open_relations[0].task_a, summary.open_relations[0].task_b], ['P', 'R']);
  assert.match(summary.head_sha, /^[0-9a-f]{40}$/u);
});

test('declare: a read of a function another task writes conflicts; moving the claim away closes the relation', async (context) => {
  const root = await repo(context);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  const reader = declare(root, 'Q', '--owns', 'src/a.js#beta', '--reads', 'src/a.js#alpha');
  assert.deepEqual(reader.declaration.conflicts.map(({ with: other }) => other), ['P']);
  assert.equal((await summaryOf(root)).relation_count, 1);
  const moved = declare(root, 'Q', '--owns', 'src/a.js#beta');
  assert.deepEqual(moved.declaration.conflicts, []);
  assert.equal((await summaryOf(root)).relation_count, 0);
});

test('todo add --owns judges the new task; a finished task leaves no open relation', async (context) => {
  const root = await repo(context);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  const added = success(root, ['todo', 'add', '--plan', 'dev', '--task', 'N', '--title', 'N', '--phase', 'p',
    '--design-memo', 'NO_PLAN', '--owns', 'src/a.js#alpha']);
  assert.deepEqual(added.declaration.conflicts.map(({ with: other }) => other), ['P']);
  assert.equal((await summaryOf(root)).relation_count, 1);
  success(root, ['todo', 'retire', '--plan', 'dev', '--task', 'N', '--reason', 'test']);
  assert.equal((await summaryOf(root)).relation_count, 0);
});
