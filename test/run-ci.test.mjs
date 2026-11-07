import assert from 'node:assert/strict';
import test from 'node:test';
import { ciSteps, runAll } from '../scripts/run-ci.mjs';

test('full gateは途中の失敗後も全stepを走らせ、失敗したstepを全部返す', () => {
  const ran = [];
  const failed = runAll(ciSteps, (step) => { ran.push(step); return step === 'test' || step === 'check' ? 1 : 0; });
  assert.deepEqual(ran, ciSteps);
  assert.deepEqual(failed, ['test', 'check']);
});
