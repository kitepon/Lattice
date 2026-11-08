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
