import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_HUB_LANDING_LANGUAGES, renderBridgeHubLanding,
} from '../src/bridge-hub-landing.mjs';

const PROJECTS = [
  { project_id: 'lattice', display_name: 'build-win', status: 'online', last_seen_at: '2026-08-10T00:00:00.000Z' },
  { project_id: 'root-site-promotion', display_name: 'terminal-0a1b2c3d4e5f', status: 'offline', last_seen_at: '2026-08-10T00:00:00.000Z' },
];

test('JA renderは正典コピー・言語属性・eyebrowを含む', () => {
  const html = renderBridgeHubLanding({ projects: PROJECTS, lang: 'ja' });
  assert.ok(html.includes('<html lang="ja">'));
  assert.ok(html.includes('公開 / 特許出願済み'));
  assert.ok(html.includes('schedulability compiler。競合する場合は境界を分割し、計画を再コンパイルする。'));
  assert.ok(html.includes('ライブ工程表'));
});

test('EN renderは正典コピー・言語属性・eyebrowを含む', () => {
  const html = renderBridgeHubLanding({ projects: PROJECTS, lang: 'en' });
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes('PUBLIC / PATENT PENDING'));
  assert.ok(html.includes('recompiles the plan.'));
  assert.ok(html.includes('Live plans'));
});

test('カードは主見出し=プロジェクト・従=ホスト名の入替後構造を持つ', () => {
  for (const lang of BRIDGE_HUB_LANDING_LANGUAGES) {
    const html = renderBridgeHubLanding({ projects: PROJECTS, lang });
    assert.ok(html.includes('<strong>lattice</strong>'));
    assert.ok(/class="host">[^<]*build-win</u.test(html));
    assert.ok(!html.includes('<strong>build-win</strong>'));
  }
});

test('display_namesマップが主見出しへ適用され、未登録IDは素のまま', () => {
  const html = renderBridgeHubLanding({
    projects: PROJECTS, lang: 'ja',
    displayNames: { 'root-site-promotion': 'kitepon.dev' },
  });
  assert.ok(html.includes('<strong>kitepon.dev</strong>'));
  assert.ok(html.includes('<strong>lattice</strong>'));
});

test('正典hexを含み、旧デザインhexを含まない', () => {
  for (const lang of BRIDGE_HUB_LANDING_LANGUAGES) {
    const html = renderBridgeHubLanding({ projects: PROJECTS, lang });
    for (const hex of ['#f8f5ef', '#fffef9', '#111b35', '#ef8d32', '#c65300', '#a84400', '#fbe5d2', '#2149aa']) {
      assert.ok(html.includes(hex), `${lang}: ${hex} missing`);
    }
    for (const hex of ['#e85f2a', '#315cbe', '#f7f3ea', '#0ca30c', '#d03b3b']) {
      assert.ok(!html.includes(hex), `${lang}: legacy ${hex} present`);
    }
  }
});

test('矢印グリフをリンク装飾に含まない', () => {
  for (const lang of BRIDGE_HUB_LANDING_LANGUAGES) {
    const html = renderBridgeHubLanding({ projects: PROJECTS, lang });
    assert.ok(!/[→↗↘⇒➔➜]/u.test(html), `${lang}: arrow glyph present`);
  }
});

test('noindexを出力しない', () => {
  for (const lang of BRIDGE_HUB_LANDING_LANGUAGES) {
    const html = renderBridgeHubLanding({ projects: PROJECTS, lang });
    assert.ok(!html.includes('noindex'));
  }
});

test('canonicalとhreflangが相互を指す', () => {
  const ja = renderBridgeHubLanding({ projects: [], lang: 'ja' });
  const en = renderBridgeHubLanding({ projects: [], lang: 'en' });
  assert.ok(ja.includes('<link rel="canonical" href="https://lattice.kitepon.dev/">'));
  assert.ok(en.includes('<link rel="canonical" href="https://lattice.kitepon.dev/en/">'));
  for (const html of [ja, en]) {
    assert.ok(html.includes('hreflang="ja" href="https://lattice.kitepon.dev/"'));
    assert.ok(html.includes('hreflang="en" href="https://lattice.kitepon.dev/en/"'));
    assert.ok(html.includes('hreflang="x-default" href="https://lattice.kitepon.dev/"'));
  }
});

test('敵対的なproject_id・display_nameはエスケープされる', () => {
  const hostile = [{
    project_id: '"><script>alert(1)</script>',
    display_name: '<img onerror=x>', status: 'online', last_seen_at: '2026-08-10T00:00:00.000Z',
  }];
  const html = renderBridgeHubLanding({ projects: hostile, lang: 'ja' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img onerror=x>'));
});

test('空一覧はempty stateを出し、ul.plansを出さない', () => {
  for (const lang of BRIDGE_HUB_LANDING_LANGUAGES) {
    const html = renderBridgeHubLanding({ projects: [], lang });
    assert.ok(html.includes('class="empty"'));
    assert.ok(!html.includes('class="plans"'));
  }
});

test('未対応言語はRangeErrorで拒否する', () => {
  assert.throws(() => renderBridgeHubLanding({ projects: [], lang: 'fr' }), RangeError);
});

test('CTAはGitHubとルートサイトを指し、外部リソース参照を持たない', () => {
  for (const lang of BRIDGE_HUB_LANDING_LANGUAGES) {
    const html = renderBridgeHubLanding({ projects: PROJECTS, lang });
    assert.ok(html.includes('https://github.com/kitepon/Lattice'));
    assert.ok(html.includes('https://kitepon.dev/'));
    assert.ok(!/<link rel="stylesheet"|<script|url\(http|@import|fonts\./u.test(html));
  }
});
