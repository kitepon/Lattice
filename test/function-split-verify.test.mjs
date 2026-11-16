import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cutCost, verifyFunctionSplit } from '../src/function-split-verify.mjs';
import { runSensorCli } from '../src/sensor-cli.mjs';

const BASE = [
  'export function work(x) {',
  '  const a = x + 1;',
  '  const b = a * 2;',
  '  return b - 1;',
  '}',
  '',
].join('\n');
const CUT = [
  'function stepA(x) {',
  '  return x + 1;',
  '}',
  'function stepB(a) {',
  '  return a * 2 - 1;',
  '}',
  'export function work(x) {',
  '  return stepB(stepA(x));',
  '}',
  '',
].join('\n');
const TEST = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { work } from '../src/lib.mjs';",
  "test('work', () => assert.equal(work(1), 3));",
  '',
].join('\n');

const target = { path: 'src/lib.mjs', symbol: 'work' };
const map = [{ task_id: 'u', path: 'src/lib.mjs', symbol: 'stepA' }, { task_id: 't', path: 'src/lib.mjs', symbol: 'stepB' }];

async function repo(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-split-verify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  await put('src/lib.mjs', BASE);
  await put('test/lib.test.mjs', TEST);
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const commitOn = async (branch, files, message = 'cut') => {
    git('checkout', '-q', '-b', branch, 'main');
    for (const [file, text] of Object.entries(files)) await put(file, text);
    git('add', '-A'); git('commit', '-q', '-m', message);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return sha;
  };
  return { root, git, put, commitOn };
}

test('b3: a clean cut passes behaviour, tests and fresh; ranges and existed_at_base are reported', async (t) => {
  const { root, commitOn } = await repo(t);
  const commit = await commitOn('cut', { 'src/lib.mjs': CUT });
  const out = await verifyFunctionSplit({ repoRoot: root, commit, target, map, anchors: [{ task_id: 'u', path: 'src/lib.mjs', symbol: 'work' }] });
  assert.equal(out.error, undefined);
  assert.deepEqual([out.behaviour.passed, out.tests.passed, out.fresh.passed], [true, true, true], JSON.stringify(out));
  assert.deepEqual(out.tests.ran, ['test/lib.test.mjs']);
  assert.deepEqual(out.target, { resolved: true, start_line: 7, end_line: 9 });
  assert.deepEqual(out.map.map(({ task_id: id, existed_at_base: existed }) => [id, existed]), [['u', false], ['t', false]]);
  assert.deepEqual(out.ranges.filter(({ symbol }) => symbol === 'stepA'), [{ task_id: 'u', path: 'src/lib.mjs', symbol: 'stepA', start_line: 1, end_line: 3 }]);
  assert.equal(out.ranges.some(({ symbol, start_line: line }) => symbol === 'work' && line === 7), true, 'the anchor range at the commit');
  assert.equal(out.base, (await verifyFunctionSplit({ repoRoot: root, commit, target, map })).base);
});

test('b3: ranges and unresolved anchors are never truncated (a lost row could hide an overlap)', async (t) => {
  const { root, commitOn } = await repo(t);
  const many = Array.from({ length: 70 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');
  const commit = await commitOn('many', { 'src/lib.mjs': `${CUT}${many}\n` });
  const names = Array.from({ length: 70 }, (_, i) => `f${i}`);
  const anchors = [...names, ...names.map((name) => `${name}x`)].map((symbol) => ({ task_id: 'u', path: 'src/lib.mjs', symbol }));
  const out = await verifyFunctionSplit({ repoRoot: root, commit, target, map, anchors });
  assert.equal(out.ranges.filter(({ symbol }) => /^f\d+$/u.test(symbol)).length, 70);
  assert.equal(out.anchors_unresolved.length, 70);
});

test('b3: lost export, missing map entry and a failing test each fail their own condition', async (t) => {
  const { root, commitOn } = await repo(t);
  const lost = await commitOn('lost', { 'src/lib.mjs': CUT.replace('export function work', 'function work') });
  const a = await verifyFunctionSplit({ repoRoot: root, commit: lost, target, map: [{ task_id: 'u', path: 'src/lib.mjs', symbol: 'stepZ' }] });
  assert.equal(a.behaviour.passed, false);
  assert.match(a.behaviour.detail, /export_surface_lost:src\/lib\.mjs:work/u);
  assert.equal(a.fresh.passed, false);
  assert.deepEqual(a.fresh.unresolved.map(({ task_id: id, reason }) => [id, reason]), [['u', 'not_found']]);
  assert.equal(a.fresh.unresolved[0].nearest.length > 0, true, 'a miss answers the nearest names');

  const broken = await commitOn('broken', { 'src/lib.mjs': CUT.replace('a * 2 - 1', 'a * 2') });
  const b = await verifyFunctionSplit({ repoRoot: root, commit: broken, target, map });
  assert.equal(b.tests.passed, false);
  assert.deepEqual(b.tests.ran, ['test/lib.test.mjs']);
  assert.match(b.tests.detail, /verifier failed/u);
  assert.equal(b.behaviour.passed, true);
  assert.equal(b.fresh.passed, true);
});

test('b3: no test reaching the function is a failure, never a vacuous pass; a test in the commit is the exit', async (t) => {
  const { root, git, put, commitOn } = await repo(t);
  git('rm', '-q', 'test/lib.test.mjs'); await put('src/other.mjs', 'export const k = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'drop the test');
  const none = await commitOn('none', { 'src/lib.mjs': CUT });
  const a = await verifyFunctionSplit({ repoRoot: root, commit: none, target, map });
  assert.equal(a.tests.passed, false);
  assert.equal(a.tests.detail, 'no_test_reaches_function');
  const withTest = await commitOn('with-test', { 'src/lib.mjs': CUT, 'test/lib.test.mjs': TEST });
  const b = await verifyFunctionSplit({ repoRoot: root, commit: withTest, target, map });
  assert.deepEqual([b.tests.passed, b.tests.ran], [true, ['test/lib.test.mjs']]);
});

test('b3: input errors answer {error} and nothing else', async (t) => {
  const { root, put, commitOn } = await repo(t);
  const commit = await commitOn('cut', { 'src/lib.mjs': CUT });
  const code = async (args) => (await verifyFunctionSplit({ repoRoot: root, commit, target, map, ...args })).error?.code;
  assert.equal(await code({ commit: '0'.repeat(40) }), 'commit_not_found');
  assert.equal(await code({ base: commit }), 'empty_diff');
  assert.equal(await code({ target: { path: 'src/none.mjs', symbol: 'work' } }), 'target_untouched');
  assert.equal(await code({ map: [{ task_id: 'u', path: '../x', symbol: 's' }] }), 'map_entry_malformed');
  assert.equal(await code({ map: [map[0], map[0]] }), 'map_entry_malformed');
  await put('dirty.txt', 'x');
  assert.equal(await code({}), 'source_dirty');
});

test('b3: --base lets a worker verify after the merge', async (t) => {
  const { root, git, commitOn } = await repo(t);
  const before = git('rev-parse', 'main');
  const commit = await commitOn('cut', { 'src/lib.mjs': CUT });
  git('merge', '-q', '--ff-only', 'cut');
  assert.equal((await verifyFunctionSplit({ repoRoot: root, commit, target, map })).error.code, 'empty_diff');
  const out = await verifyFunctionSplit({ repoRoot: root, commit, base: before, target, map });
  assert.deepEqual([out.base, out.behaviour.passed, out.tests.passed, out.fresh.passed], [before, true, true, true]);
});

test('b3: a changed file of another language that has graph nodes is unobserved, not passed', async (t) => {
  const { root, commitOn } = await repo(t);
  const commit = await commitOn('py', { 'src/lib.mjs': CUT, 'tools/x.py': 'def f():\n    return 1\n' });
  const out = await verifyFunctionSplit({ repoRoot: root, commit, target, map });
  assert.equal(out.behaviour.passed, false);
  assert.match(out.behaviour.detail, /export_surface_unobserved:tools\/x\.py/u);
});

test('b3: cutCost sizes the function for the worker; a missing source is an answer', async (t) => {
  const { root } = await repo(t);
  assert.equal(await runSensorCli({ argv: ['init', root, '--json'], stdout: { write() {} }, stderr: { write() {} } }), 0);
  const sized = await cutCost({ repoRoot: root, target, memberTaskIds: ['u', 't'] });
  assert.deepEqual(sized.reasons, []);
  assert.deepEqual(Object.keys(sized.profile.tasks), ['t+u']);
  assert.deepEqual(sized.profile.tasks['t+u'].symbols, [{ name: 'work', kind: 'function', lines: 5, exported: true }]);
  const missing = await cutCost({ repoRoot: root, target: { path: 'src/none.mjs', symbol: 'work' }, memberTaskIds: ['u', 't'] });
  assert.deepEqual(missing, { profile: null, reasons: ['source_unreadable'] });
  assert.deepEqual((await cutCost({ repoRoot: root, target: {}, memberTaskIds: [] })).reasons, ['target_or_members_malformed']);
});

test('b3: a host clone that took in main only fetches the commit and the history it needs from origin', async (t) => {
  const origin = await repo(t);
  origin.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const commit = await origin.commitOn('cut', { 'src/lib.mjs': CUT });
  // main moves on after the cut branched, so a depth-1 clone cannot see the common ancestor without deepening.
  await origin.put('docs/one.md', '1'); origin.git('add', '-A'); origin.git('commit', '-q', '-m', 'main 2');
  await origin.put('docs/two.md', '2'); origin.git('add', '-A'); origin.git('commit', '-q', '-m', 'main 3');
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-split-clone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--depth', '1', '--single-branch', '--branch', 'main', `file://${origin.root}`, root]);
  const inClone = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.throws(() => inClone('cat-file', '-e', `${commit}^{commit}`), 'the clone starts without the commit');
  const headBefore = inClone('rev-parse', 'HEAD');
  const refsBefore = inClone('for-each-ref');

  const out = await verifyFunctionSplit({ repoRoot: root, commit, target, map });
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.deepEqual([out.behaviour.passed, out.tests.passed, out.fresh.passed], [true, true, true]);
  assert.equal(inClone('rev-parse', 'HEAD'), headBefore);
  assert.equal(inClone('for-each-ref'), refsBefore, 'objects only: no ref moved');

  const missing = await verifyFunctionSplit({ repoRoot: root, commit: 'f'.repeat(40), target, map });
  assert.equal(missing.error.code, 'commit_not_found', 'origin lacks it too: the worker pushes');
});
