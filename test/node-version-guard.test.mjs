import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_NODE_MAJOR,
  evaluateNodeVersionGuard,
} from '../src/node-version-guard.mjs';
import {
  buildNode25BlockBanner,
  buildNodeTooOldBanner,
} from '../sensor/dist/bin/node-version-check.js';

// lattice-mcp bin向けNode versionガード(ADR 0049 wave2レビューでのスコープ外
// 発見の修理)の境界値固定。閾値・banner文言はsensor CLIの
// sensor/dist/bin/node-version-check.js を再利用しているだけなので、ここでは
// 「同じ入力に対して同じbannerが返るか」と「blocked判定の境界」だけを見る。

test(`MIN_NODE_MAJORはsensorと同じ${MIN_NODE_MAJOR}`, () => {
  assert.equal(MIN_NODE_MAJOR, 20);
});

test('nodeMajor 24 (MIN_NODE_MAJOR未満ではなく25未満) はサポート対象内 — blocked=false, banner=null', () => {
  const result = evaluateNodeVersionGuard('24.0.0', false);
  assert.equal(result.blocked, false);
  assert.equal(result.banner, null);
});

test('nodeMajor 25はoverride無しでblocked、bannerはbuildNode25BlockBannerと同一', () => {
  const result = evaluateNodeVersionGuard('25.0.0', false);
  assert.equal(result.blocked, true);
  assert.equal(result.banner, buildNode25BlockBanner('25.0.0'));
});

test('nodeMajor 25はoverride有りでblocked=falseだがbannerは表示のみ非null', () => {
  const result = evaluateNodeVersionGuard('25.0.0', true);
  assert.equal(result.blocked, false);
  assert.equal(result.banner, buildNode25BlockBanner('25.0.0'));
});

test('patched Node26.10 is supported — blocked=false, banner=null', () => {
  const result = evaluateNodeVersionGuard('26.10.0', false);
  assert.equal(result.blocked, false);
  assert.equal(result.banner, null);
});

test(`nodeMajor ${MIN_NODE_MAJOR}(floorちょうど)はサポート対象内 — blocked=false, banner=null`, () => {
  const result = evaluateNodeVersionGuard(`${MIN_NODE_MAJOR}.0.0`, false);
  assert.equal(result.blocked, false);
  assert.equal(result.banner, null);
});

test(`nodeMajor ${MIN_NODE_MAJOR - 1}(floor未満)はoverride無しでblocked、bannerはbuildNodeTooOldBannerと同一`, () => {
  const version = `${MIN_NODE_MAJOR - 1}.0.0`;
  const result = evaluateNodeVersionGuard(version, false);
  assert.equal(result.blocked, true);
  assert.equal(result.banner, buildNodeTooOldBanner(version));
});

test(`nodeMajor ${MIN_NODE_MAJOR - 1}(floor未満)はoverride有りでblocked=falseだがbannerは表示のみ非null`, () => {
  const version = `${MIN_NODE_MAJOR - 1}.0.0`;
  const result = evaluateNodeVersionGuard(version, true);
  assert.equal(result.blocked, false);
  assert.equal(result.banner, buildNodeTooOldBanner(version));
});

for (const version of ['24.20.0', '24.21.0', '26.9.0']) {
  test(`Realm lifetime: MCP blocks unpatched Node ${version} before worker startup`, () => {
    const result = evaluateNodeVersionGuard(version, false);
    assert.equal(result.blocked, true);
    assert.match(result.banner, /nodejs\/node\/pull\/65778/);
    assert.match(result.banner, /24\.22\.0/);
    assert.match(result.banner, /26\.10\.0/);
  });
}
