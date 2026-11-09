import assert from 'node:assert/strict';
import test from 'node:test';
import { ciSteps, runAll } from '../scripts/run-ci.mjs';

test('full gateは途中の失敗後も全stepを走らせ、失敗したstepを全部返す', () => {
  const ran = [];
  const failed = runAll(ciSteps, (step) => { ran.push(step); return step === 'test' || step === 'check' ? 1 : 0; });
  assert.deepEqual(ran, ciSteps);
  assert.deepEqual(failed, ['test', 'check']);
});

test('PR scope runs only the suites that reach the change and skips untouched Sensor', async () => {
  const { scopedSteps } = await import('../scripts/run-ci.mjs');
  const { selectScope } = await import('../scripts/ci-scope.mjs');
  const graph = new Map([
    ['src/a.mjs', ['src/b.mjs']], ['src/b.mjs', ['test/b.test.mjs']],
    ['src/c.mjs', ['test/c.test.mjs']],
  ]);
  const importers = (file) => graph.get(file) ?? [];
  const isImported = (file) => graph.has(file);
  const tests = ['b.test.mjs', 'c.test.mjs'];
  const scope = selectScope({ changed: ['src/a.mjs', 'docs/x.md'], tests, importers, isImported });
  assert.equal(scope.full, false);
  assert.deepEqual(scope.tests, ['b.test.mjs']);
  assert.equal(scope.sensor, false);
  assert.deepEqual(scopedSteps(ciSteps, scope), ciSteps.filter((step) => step !== 'test:sensor'));
  assert.equal(selectScope({ changed: ['sensor/src/x.ts'], tests, importers, isImported }).sensor, true);
  assert.equal(selectScope({ changed: ['scripts/run-ci.mjs'], tests, importers, isImported }).full, true);
  assert.equal(selectScope({ changed: ['src/orphan.mjs'], tests, importers, isImported }).full, true);
  assert.deepEqual(selectScope({ changed: ['test/c.test.mjs'], tests, importers, isImported }).tests, ['c.test.mjs']);
  // A fixture read by path (no import edge) must not drop every suite (Shiratsuru's review).
  for (const file of ['test/fixtures/todo-migration/valid.json', 'test/fixtures/x.txt', 'research/a.js', '.lattice/x.json']) {
    assert.equal(selectScope({ changed: [file], tests, importers, isImported }).full, true, file);
  }
});

test('a CLI reached by path segments is in scope (PR #100 missed cli-stdout-epipe)', async () => {
  const { referencesIn, referenceGraph, selectScope } = await import('../scripts/ci-scope.mjs');
  const text = "const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');";
  const refs = referencesIn(text, 'test/x.test.mjs', ['bin/lattice.mjs', 'src/lattice.mjs', 'src/other.mjs']);
  assert.deepEqual(refs.sort(), ['bin/lattice.mjs', 'src/lattice.mjs']);
  const changed = ['CHANGELOG.md', 'docs/architecture/function-map.md', 'src/todo-cli.mjs',
    'test/todo-cli.test.mjs', 'test/todo-status.test.mjs'];
  const tests = ['cli-stdout-epipe.test.mjs', 'todo-cli.test.mjs', 'todo-status.test.mjs'];
  const scope = selectScope({ changed, tests, ...await referenceGraph() });
  assert.equal(scope.full, false);
  assert.ok(scope.tests.includes('cli-stdout-epipe.test.mjs'), scope.reason);
});

test('a version-only package bump is told apart from a dependency change', async () => {
  const { withoutVersion } = await import('../scripts/ci-scope.mjs');
  const lock = (version, dep) => JSON.stringify({ name: 'x', version, packages: { '': { version }, 'node_modules/a': { version: dep } } });
  assert.equal(withoutVersion(lock('0.82.0', '1.0.0')), withoutVersion(lock('0.83.0', '1.0.0')));
  assert.notEqual(withoutVersion(lock('0.82.0', '1.0.0')), withoutVersion(lock('0.83.0', '1.0.1')));
});

test('a main push skips its full gate only when a full, three-OS green PR run tested the same tree', async () => {
  const { decideCoverage } = await import('../scripts/ci-main-coverage.mjs');
  const tree = 'a'.repeat(40);
  const jobsFor = ({ scope = 'full', testedTree = tree, macos = 'success' } = {}) => [
    { name: 'full / classify', conclusion: 'success', steps: [{ name: `tested merge ${'b'.repeat(40)} tree ${testedTree} scope ${scope}` }] },
    { name: 'full / full (macos-native)', conclusion: macos },
    { name: 'full / full (linux-workstation)', conclusion: 'success' },
    { name: 'full / full (windows-native)', conclusion: 'success' },
  ];
  const decide = (jobs, extra = {}) => decideCoverage({ pushedTree: tree, pr: 77, run: { id: 1 }, jobs, ...extra });
  assert.equal(decide(jobsFor()).covered, true);
  assert.match(decide(jobsFor()).reason, /^covered by PR #77 run 1 \(merge b{40}, tree a{40}\)$/u);
  assert.equal(decide(jobsFor({ scope: 'scoped' })).covered, false);
  assert.equal(decide(jobsFor({ testedTree: 'c'.repeat(40) })).covered, false);
  assert.equal(decide(jobsFor({ macos: 'failure' })).covered, false);
  assert.equal(decide(jobsFor({ macos: null })).covered, false);
  assert.equal(decide(jobsFor().filter((job) => !job.name.includes('windows'))).covered, false);
  assert.equal(decide(jobsFor().slice(1)).covered, false);
  assert.equal(decideCoverage({ pushedTree: tree }).covered, false);
});
