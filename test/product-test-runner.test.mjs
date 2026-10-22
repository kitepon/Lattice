import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nativeTestProfiles, productTestConcurrency, productTestEnvironment, selectProductTests,
} from '../scripts/run-product-tests.mjs';

test('product testは子processを含むsuiteを4本まで同時実行する', () => {
  assert.equal(productTestConcurrency(24), 4);
  assert.equal(productTestConcurrency(2), 2);
});

test('product test child envはFORCE_COLORを除去しdashboard autostartを無効化する', () => {
  const parentEnv = {
    PATH: '/fixture/bin',
    FORCE_COLOR: '1',
    NO_COLOR: '1',
    LATTICE_DASHBOARD_AUTOSTART: '1',
  };

  const childEnv = productTestEnvironment(parentEnv);

  assert.equal(Object.hasOwn(childEnv, 'FORCE_COLOR'), false);
  assert.equal(childEnv.NO_COLOR, '1');
  assert.equal(childEnv.LATTICE_DASHBOARD_AUTOSTART, '0');
  assert.equal(childEnv.LATTICE_SENSOR_PARSE_WORKERS, '1');
  assert.equal(childEnv.PATH, '/fixture/bin');
  assert.deepEqual(parentEnv, {
    PATH: '/fixture/bin',
    FORCE_COLOR: '1',
    NO_COLOR: '1',
    LATTICE_DASHBOARD_AUTOSTART: '1',
  });
});

test('product test child envは、端末の本物のhost設定を指す変数を渡さない', () => {
  // これらが残ると、一時のHOMEを渡した試験のCLIが、利用者の本物のCodex・Claude・Grokの設定を書き換える。
  const parentEnv = { PATH: '/fixture/bin', CODEX_HOME: '/real/.codex', CLAUDE_CONFIG_DIR: '/real/.claude',
    GROK_HOME: '/real/.grok' };
  const childEnv = productTestEnvironment(parentEnv);
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) assert.equal(Object.hasOwn(childEnv, name), false, name);
  assert.equal(childEnv.PATH, '/fixture/bin');
  assert.equal(parentEnv.CODEX_HOME, '/real/.codex');
});

test('product test child envは、設定の置き場をrunごとの一時の置き場へ向け、親の本物の値を渡さない', () => {
  // 名乗りの無いTodo操作は端末の識別子を設定の置き場へ作る（ADR 0197）。本物の`~/.lattice`へ作らせない。
  const parentEnv = { PATH: '/fixture/bin', LATTICE_CONFIG_DIR: '/real/.lattice' };
  assert.equal(productTestEnvironment(parentEnv, { configDir: '/tmp/run-config' }).LATTICE_CONFIG_DIR,
    '/tmp/run-config');
  assert.equal(Object.hasOwn(productTestEnvironment(parentEnv), 'LATTICE_CONFIG_DIR'), false);
  assert.equal(parentEnv.LATTICE_CONFIG_DIR, '/real/.lattice');
});

test('環境別profileはfocused再現用のsuiteだけを選びcoreの総当たりを複製しない', () => {
  const retired = 'control-compiler.test.mjs';
  const all = [
    retired,
    'portable-new-feature.test.mjs',
    ...new Set(Object.values(nativeTestProfiles).flat()),
  ].sort();

  const core = selectProductTests(all, 'core');
  assert.equal(core.includes(retired), false);
  assert.equal(core.includes('portable-new-feature.test.mjs'), true);
  for (const [profile, expected] of Object.entries(nativeTestProfiles)) {
    assert.deepEqual(selectProductTests(all, profile), [...expected]);
  }
  assert.equal(selectProductTests(all, 'windows').includes('hooks-cli.test.mjs'), false);
  assert.equal(selectProductTests(all, 'wsl2').includes('hooks-cli.test.mjs'), true);
});

test('未知のCI profileはcoreへfallbackせず失敗する', () => {
  assert.throws(() => selectProductTests([], 'unknown'), /unknown product test profile/u);
});
