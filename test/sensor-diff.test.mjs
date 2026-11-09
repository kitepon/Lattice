/**
 * `lattice sensor diff` の受入。実sensorで実際にindexを作ってから突き合わせる。
 *
 * 中心の主張は「行がずれただけの変化を差分として報告しない」である。node idは行番号を
 * 含むので、idで比べる実装ならこのtestは落ちる。落ちないことがこの機能の存在理由である。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'lattice.mjs');

function invokeSensorCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [CLI, 'sensor', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: '/usr/bin:/bin', LATTICE_SENSOR_ALLOW_UNSAFE_NODE: '1' },
  });
}

async function writeSource(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/** 索引済みのfixture repoを1つ作る。索引は実sensorのCLIを通す。 */
async function buildRepo(label, files) {
  const root = await mkdtemp(path.join(tmpdir(), `lattice-sensor-diff-${label}-`));
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeSource(root, relativePath, contents);
  }
  const indexed = invokeSensorCli(['init', '.', '--json'], root);
  assert.equal(indexed.status, 0, `${label} init failed: ${indexed.stdout}\n${indexed.stderr}`);
  return root;
}

const A_LIB = `export function alpha() { return beta(); }
export function beta() { return 1; }
export function doomed() { return 2; }
`;

// alphaとbetaは中身も並びも同じで、先頭に2行足したぶんだけ下へずれる。埋めるのは空行である
// ——コメントで埋めると直下のsymbolのdocstringが変わり、それは行ズレでなく本物の変化になる。
const B_LIB = `

export function alpha() { return beta(); }
export function beta() { return 1; }
export function fresh() { return alpha(); }
`;

const fixtures = {};
const derived = [];

/**
 * 索引済みfixtureを複製し、DBへ直接手を入れた変種を作る。
 * 抽出error・version食い違い・古いschemaは、sourceを書いても再現できない索引側の状態である。
 */
async function deriveIndex(label, sourceRoot, mutate) {
  const root = await mkdtemp(path.join(tmpdir(), `lattice-sensor-diff-${label}-`));
  derived.push(root);
  await cp(sourceRoot, root, { recursive: true });
  const db = new DatabaseSync(path.join(root, '.lattice', 'sensor', 'sensor.db'));
  try { mutate(db); } finally { db.close(); }
  return root;
}

before(async () => {
  fixtures.a = await buildRepo('a', {
    'lib.mjs': A_LIB,
    'mode.mjs': 'export function toggle() { return 1; }\n',
    'gone.mjs': 'export const gone = true;\n',
    'pkg-old/x.mjs': 'export function shared() { return 3; }\n',
  });
  fixtures.b = await buildRepo('b', {
    'lib.mjs': B_LIB,
    'mode.mjs': 'export async function toggle() { return 1; }\n',
    'arrived.mjs': 'export const arrived = true;\n',
    'pkg-old/x.mjs': 'export function shared() { return 3; }\n',
  });
  // A側のrootと突き合わせるための、部分木＋改名を持つ側。`outside.mjs`はsubtreeの外にある
  // 実sourceで、除外件数が実際に出ることを確かめるために置く。
  fixtures.nested = await buildRepo('nested', {
    'sub/lib.mjs': A_LIB,
    'sub/mode.mjs': 'export function toggle() { return 1; }\n',
    'sub/gone.mjs': 'export const gone = true;\n',
    'sub/pkg-new/x.mjs': 'export function shared() { return 3; }\n',
    'outside.mjs': 'export const outside = true;\n',
  });
  fixtures.unindexed = await mkdtemp(path.join(tmpdir(), 'lattice-sensor-diff-none-'));
}, { timeout: 180_000 });

after(async () => {
  await Promise.all([...Object.values(fixtures), ...derived]
    .filter((root) => typeof root === 'string')
    .map((root) => rm(root, { recursive: true, force: true })));
});

function diff(args) {
  const result = invokeSensorCli(['diff', ...args, '--json']);
  assert.equal(result.status, 0, `diff failed: ${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

const named = (entries, name) => entries.filter((entry) => entry.name === name);

test('行がずれただけのsymbolはmovedになり、added/removedにもedgeの差分にも出ない', () => {
  const payload = diff([fixtures.a, fixtures.b]);
  assert.equal(payload.schema, 'lattice.sensor_diff_result.v1');

  assert.equal(named(payload.nodes.added, 'alpha').length, 0);
  assert.equal(named(payload.nodes.removed, 'alpha').length, 0);
  assert.equal(named(payload.nodes.changed, 'alpha').length, 0);
  const movedAlpha = named(payload.nodes.moved, 'alpha');
  assert.equal(movedAlpha.length, 1);
  assert.equal(movedAlpha[0].file_path, 'lib.mjs');
  assert.equal(movedAlpha[0].b_start_line - movedAlpha[0].a_start_line, 2);

  // 行がずれても alpha -> beta の呼び出し辺は同じものとして数えられる。
  const shifted = (entries) => entries.filter((edge) => edge.source.name === 'alpha' && edge.target.name === 'beta');
  assert.deepEqual(shifted(payload.edges.added), []);
  assert.deepEqual(shifted(payload.edges.removed), []);
  assert.ok(payload.summary.edges.common > 0);
});

test('追加・削除されたsymbolと、その辺が列挙される', () => {
  const payload = diff([fixtures.a, fixtures.b]);

  assert.equal(named(payload.nodes.added, 'fresh').length, 1);
  assert.equal(named(payload.nodes.removed, 'doomed').length, 1);
  assert.equal(payload.summary.nodes_added_by_kind.function >= 1, true);

  const freshCall = payload.edges.added
    .filter((edge) => edge.source.name === 'fresh' && edge.target.name === 'alpha');
  assert.equal(freshCall.length, 1, JSON.stringify(payload.edges.added));
});

test('属性だけ変わったsymbolはchangedになり、変わった属性名が返る', () => {
  const payload = diff([fixtures.a, fixtures.b]);
  const changed = named(payload.nodes.changed, 'toggle');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].file_path, 'mode.mjs');
  assert.ok(changed[0].fields.includes('is_async'), JSON.stringify(changed[0]));
  assert.equal(payload.summary.nodes_changed_by_field.is_async >= 1, true);
});

test('fileの増減と、内容同一fileの件数が出る', () => {
  const payload = diff([fixtures.a, fixtures.b]);
  assert.deepEqual(payload.files.removed.map((file) => file.path), ['gone.mjs']);
  assert.deepEqual(payload.files.added.map((file) => file.path), ['arrived.mjs']);
  // pkg-old/x.mjs は両側で同一。
  assert.ok(payload.summary.files.identical_content >= 1);
});

test('subtreeと改名写像で、階層の違う2つのtreeを揃えて突き合わせられる', () => {
  const aligned = diff([
    fixtures.a, fixtures.nested,
    '--subtree-b', 'sub',
    '--map-b', 'pkg-new=pkg-old',
  ]);
  assert.deepEqual(aligned.summary.nodes, { added: 0, removed: 0, changed: 0, moved: 0, unchanged: aligned.summary.nodes.unchanged });
  assert.ok(aligned.summary.nodes.unchanged > 0);
  assert.deepEqual(aligned.summary.edges.added, 0);
  assert.deepEqual(aligned.summary.edges.removed, 0);
  assert.deepEqual(aligned.summary.files, {
    added: 0, removed: 0, changed: 0,
    common: aligned.summary.files.common,
    identical_content: aligned.summary.files.common,
  });
  assert.equal(aligned.b.subtree, 'sub');
  // subtreeの外に置いたsourceは、比較対象から外したことが件数で見える。
  assert.ok(aligned.excluded.b.files_outside_subtree >= 1);
  assert.ok(aligned.excluded.b.nodes_outside_subtree >= 1);
});

test('索引のどのfileにも当たらないsubtreeは、okでなく打ち間違いとして名指す(a29)', () => {
  const result = invokeSensorCli(['diff', fixtures.a, fixtures.nested, '--subtree-b', 'nosuch', '--json']);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'LATTICE_SENSOR_DIFF_SUBTREE_EMPTY');
  assert.deepEqual([error.detail.side, error.detail.subtree], ['b', 'nosuch']);
});

test('subtreeも写像も指定しなければ、同じ2つのtreeは全面的に食い違う', () => {
  const naive = diff([fixtures.a, fixtures.nested]);
  assert.ok(naive.summary.nodes.added > 0);
  assert.ok(naive.summary.nodes.removed > 0);
});

test('明細を切った時は、切った量が必ずtruncationに出る', () => {
  const payload = diff([fixtures.a, fixtures.nested, '--limit', '1']);
  assert.equal(payload.limit, 1);
  const truncated = Object.entries(payload.truncation);
  assert.ok(truncated.length > 0);
  for (const [name, info] of truncated) {
    assert.equal(info.returned, 1, name);
    assert.equal(info.total, info.returned + info.omitted, name);
    const [group, bucket] = name.split('.');
    assert.equal(payload[group][bucket].length, 1, name);
  }
  // 件数summaryは切らない。
  assert.equal(payload.summary.nodes.added, payload.truncation['nodes.added'].total);
});

test('両側のindexが同じ素性なら comparability は ok', () => {
  const payload = diff([fixtures.a, fixtures.b]);
  assert.equal(payload.comparability.status, 'ok');
  assert.deepEqual(payload.comparability.reasons, []);
});

test('未索引のtreeは、勝手に索引せずtyped errorと次の一手を返す', () => {
  const result = invokeSensorCli(['diff', fixtures.a, fixtures.unindexed, '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'LATTICE_SENSOR_DIFF_INDEX_MISSING');
  assert.equal(error.detail.next_action, `lattice sensor init ${fixtures.unindexed} --json`);
  assert.equal(error.detail.root, fixtures.unindexed);
});

test('抽出errorを記録したfileは、正常な索引の顔で通さずdegradedにする', async () => {
  const broken = await deriveIndex('errors', fixtures.a, (db) => {
    db.exec("UPDATE files SET errors = '[\"parse failed\"]' WHERE path = 'lib.mjs'");
  });
  const payload = diff([broken, fixtures.a]);
  assert.equal(payload.integrity.a.files_with_extraction_errors, 1);
  assert.equal(payload.integrity.b.files_with_extraction_errors, 0);
  assert.equal(payload.comparability.status, 'degraded');
  assert.ok(payload.comparability.reasons.some((reason) => /extraction errors/u.test(reason)),
    JSON.stringify(payload.comparability.reasons));
});

test('同じfileが違うextraction versionで抽出されていればdegradedになる（集合一致では見逃す）', async () => {
  // A={lib:99, mode:既定} B={lib:既定, mode:99}。versionの集合は両側同じで、対応だけが違う。
  const swapA = await deriveIndex('swap-a', fixtures.a, (db) => {
    db.exec("UPDATE files SET extraction_version = 99 WHERE path = 'lib.mjs'");
  });
  const swapB = await deriveIndex('swap-b', fixtures.a, (db) => {
    db.exec("UPDATE files SET extraction_version = 99 WHERE path = 'mode.mjs'");
  });
  const payload = diff([swapA, swapB]);
  assert.equal(payload.comparability.status, 'degraded');
  assert.equal(payload.comparability.extraction_version_mismatched_files, 2);
  assert.deepEqual(
    Object.keys(payload.comparability.a.extraction_versions).sort(),
    Object.keys(payload.comparability.b.extraction_versions).sort(),
    '集合としては一致していることが前提のtestである',
  );
});

test('必要な列を欠く古いindexは、生の例外でなくtyped errorで止まる', async () => {
  const old = await deriveIndex('old-schema', fixtures.a, (db) => {
    db.exec('ALTER TABLE files RENAME COLUMN extraction_version TO legacy_extraction_version');
  });
  const result = invokeSensorCli(['diff', old, fixtures.a, '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'LATTICE_SENSOR_DIFF_SCHEMA_UNSUPPORTED');
  assert.equal(error.detail.side, 'a');
  assert.deepEqual(error.detail.missing_columns, ['files.extraction_version']);
});

test('写像が2つのfileを同じpathへ潰したら、片方を黙って捨てずに止まる', () => {
  const result = invokeSensorCli([
    'diff', fixtures.a, fixtures.b,
    '--map-a', 'mode.mjs=lib.mjs',
    '--json',
  ]);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'LATTICE_SENSOR_DIFF_PATH_COLLISION');
  assert.equal(error.detail.side, 'a');
  assert.equal(error.detail.normalized_path, 'lib.mjs');
  assert.deepEqual(error.detail.source_paths.sort(), ['lib.mjs', 'mode.mjs']);
});

test('--subtree に "." を渡してもroot指定として効く（全件除外にならない）', () => {
  const dotted = diff([fixtures.a, fixtures.b, '--subtree-a', '.', '--subtree-b', '.']);
  const plain = diff([fixtures.a, fixtures.b]);
  assert.deepEqual(dotted.summary.nodes, plain.summary.nodes);
  assert.equal(dotted.excluded.a.nodes_outside_subtree, 0);
  assert.ok(dotted.summary.nodes.unchanged > 0);
});

test('知らないoptionは黙って捨てずusage errorにする', () => {
  for (const args of [
    ['diff', '--json'],
    ['diff', 'only-one-root', '--json'],
    ['diff', 'a', 'b', '--unknown', 'x', '--json'],
    ['diff', 'a', 'b', '--limit', 'many', '--json'],
    ['diff', 'a', 'b', '--map-a', 'no-equals-sign', '--json'],
    ['diff', 'a', 'b', '--subtree-a', '--json'],
    // 桁だけ見てNumber()へ渡すとInfinityになり、上限が黙って消える。
    ['diff', 'a', 'b', '--limit', '99999999999999999999999999', '--json'],
  ]) {
    const result = invokeSensorCli(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(JSON.parse(result.stderr).code, 'USAGE', JSON.stringify(args));
  }
});
