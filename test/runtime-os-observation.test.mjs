import nodeTest from 'node:test';

const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import {
  observeArgv,
  observeStartIdentityRaw,
  processStartIdentityEpochMs,
} from '../src/runtime-os-observation.mjs';

nodeTest('start identityのepoch変換はps lstartとWindows UTC ticksを同じ時刻へ正規化する', () => {
  const lstart = 'Mon Sep 21 23:13:09 2026';
  const expected = Date.parse(lstart);
  assert.equal(processStartIdentityEpochMs(lstart), expected);
  const ticks = (BigInt(expected) * 10_000n) + 621_355_968_000_000_000n;
  assert.equal(processStartIdentityEpochMs(String(ticks)), expected);
  assert.equal(processStartIdentityEpochMs('not a process start identity'), null);
});

test('非ASCII argvを持つprocessの観測結果は、観測者自身のLC_ALLに依存しない', async (context) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '日本語引数'], {
    detached: true, stdio: 'ignore',
  });
  context.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const originalLcAll = process.env.LC_ALL;
  context.after(() => {
    if (originalLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
  });

  process.env.LC_ALL = 'C';
  const identityUnderC = await observeStartIdentityRaw(child.pid);
  const argvUnderC = await observeArgv(child.pid);

  process.env.LC_ALL = 'ja_JP.UTF-8';
  const identityUnderJa = await observeStartIdentityRaw(child.pid);
  const argvUnderJa = await observeArgv(child.pid);

  assert.equal(identityUnderJa, identityUnderC);
  assert.equal(argvUnderJa, argvUnderC);
});
