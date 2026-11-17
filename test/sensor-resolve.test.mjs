import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSensorCli } from '../src/sensor-cli.mjs';
import { identifiersFromText, parseAnchor, proposeSymbols, resolveAnchors } from '../src/sensor-resolve.mjs';

const sink = { write() {} };

async function indexed(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-resolve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.mjs'), [
    'export function alpha() { return 1; }',
    'export class Bar {',
    '  baz() { return alpha(); }',
    '  qux() { return 3; }',
    '}',
    'export class Other { baz() { return 4; } }',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'src/b.mjs'), 'export function renderThing() { return 1; }\n');
  await writeFile(path.join(root, 'src/J.java'), 'package x;\npublic class J {\n  public int f() { return 1; }\n  public int f(int a) { return a; }\n}\n');
  // d3 fixture: a constructor and a method, an arrow function, and a file of types only
  await writeFile(path.join(root, 'src/c.mjs'), 'export const LIMIT = 3;\nexport class Box { constructor() {} get() { return 1; } }\nexport const arrow = () => 2;\n');
  await writeFile(path.join(root, 'src/types.d.ts'), 'export interface Shape { x: number }\n');
  assert.equal(await runSensorCli({ argv: ['init', root, '--json'], stdout: sink, stderr: sink }), 0);
  return root;
}

test('parseAnchor splits at the first # and refuses malformed text', () => {
  assert.deepEqual(parseAnchor('src/a.mjs#Bar.baz'), { path: 'src/a.mjs', symbol: 'Bar.baz' });
  assert.deepEqual(parseAnchor('lib/x.rb#Foo#bar'), { path: 'lib/x.rb', symbol: 'Foo#bar' });
  for (const bad of ['src/a.mjs', '#x', 'src/a.mjs#', '', null]) assert.equal(parseAnchor(bad), null);
});

test('identifiersFromText takes code-looking names only, last dotted part', () => {
  assert.deepEqual(
    identifiersFromText('Fix `Bar.baz` and renderThing()', 'also collect_all, helperName and a plain sentence'),
    ['baz', 'renderThing', 'collect_all', 'helperName'],
  );
});

test('a3: Resolve returns exact spans; qualified, bare and overloaded names', async (t) => {
  const root = await indexed(t);
  const result = await resolveAnchors({ root, anchors: [
    { path: 'src/a.mjs', symbol: 'alpha' },
    { path: 'src/a.mjs', symbol: 'Bar.baz' },
    { path: 'src/a.mjs', symbol: 'baz' },
    { path: 'src/J.java', symbol: 'J.f' },
  ] });
  const spans = (symbol) => result.resolved.filter((r) => r.symbol === symbol)
    .map((r) => `${r.qualified}:${r.kind}:${r.start_line}-${r.end_line}`);
  assert.deepEqual(spans('alpha'), ['alpha:function:1-1']);
  assert.deepEqual(spans('Bar.baz'), ['Bar.baz:method:3-3'], 'the container chain pins one definition');
  assert.deepEqual(spans('baz'), ['Bar.baz:method:3-3', 'Other.baz:method:6-6'], 'a bare name returns every span');
  assert.equal(spans('J.f').length, 2, 'overloads return every span');
  assert.deepEqual(result.ambiguous, [{ path: 'src/a.mjs', symbol: 'baz', names: ['Bar.baz', 'Other.baz'] }],
    'different definitions are disclosed; overloads of one name are not ambiguous');
  assert.deepEqual(result.unresolved, []);
});

test('a3: a miss is an answer with the nearest names, never a fuzzy hit', async (t) => {
  const root = await indexed(t);
  const result = await resolveAnchors({ root, anchors: [
    { path: 'src/a.mjs', symbol: 'Bar.bax' },
    { path: 'src/a.mjs', symbol: 'FooBar.baz' },
    { path: 'src/a.mjs', symbol: 'renderThing' },
    { path: 'src/nope.mjs', symbol: 'alpha' },
    { path: '../x.mjs', symbol: 'alpha' },
  ] });
  assert.deepEqual(result.resolved, []);
  const byReason = Object.fromEntries(result.unresolved.map((u) => [`${u.path}#${u.symbol}`, u]));
  assert.equal(byReason['src/a.mjs#Bar.bax'].reason, 'symbol_not_found');
  assert.equal(byReason['src/a.mjs#Bar.bax'].nearest[0].qualified, 'Bar.baz');
  assert.equal(byReason['src/a.mjs#FooBar.baz'].reason, 'symbol_not_found', 'a longer container never matches by substring');
  assert.deepEqual(byReason['src/a.mjs#renderThing'].elsewhere.map((e) => e.path), ['src/b.mjs'], 'wrong path: where the name lives');
  assert.equal(byReason['src/nope.mjs#alpha'].reason, 'file_not_indexed');
  assert.equal(byReason['../x.mjs#alpha'].reason, 'path_invalid');
});

test('a3: related callers/callees only when asked; seed fallback proposes exact names', async (t) => {
  const root = await indexed(t);
  const plain = await resolveAnchors({ root, anchors: [{ path: 'src/a.mjs', symbol: 'alpha' }] });
  assert.equal(plain.resolved[0].related, undefined);
  const withRelated = await resolveAnchors({ root, anchors: [{ path: 'src/a.mjs', symbol: 'alpha' }], related: true });
  assert.deepEqual(withRelated.resolved[0].related.callers.map((c) => c.symbol), ['Bar.baz']);

  const seeds = await proposeSymbols({ root, title: 'Change `renderThing` and missingFunction()', memo: 'touches Bar.qux' });
  assert.deepEqual(seeds.proposed.map((p) => p.name), ['renderThing', 'qux']);
  assert.deepEqual(seeds.proposed[0].definitions.map((d) => d.path), ['src/b.mjs']);
  assert.deepEqual(seeds.not_found, ['missingFunction']);
});

test('d3: Resolve counts the function-like definitions of a whole file; an unknown path answers 0', async (t) => {
  const root = await indexed(t);
  const { files, resolved } = await resolveAnchors({ root, anchors: [{ path: 'src/a.mjs', symbol: 'alpha' }],
    files: ['src/a.mjs', 'src/c.mjs', './src/b.mjs', 'src/types.d.ts', 'src/nope.mjs', '../x.mjs'] });
  assert.deepEqual(files, [
    { path: 'src/a.mjs', functions: 4 },
    { path: 'src/c.mjs', functions: 3 },
    { path: './src/b.mjs', functions: 1 },
    { path: 'src/types.d.ts', functions: 0 },
    { path: 'src/nope.mjs', functions: 0 },
    { path: '../x.mjs', functions: 0 },
  ]);
  assert.equal(resolved.length, 1, 'anchors in the same request are answered as before');
  assert.deepEqual((await resolveAnchors({ root, anchors: [] })).files, [], 'no files asked, none answered');
});

test('a3: lattice sensor resolve answers on stdout, exit 0 on a miss, typed error without an index', async (t) => {
  const root = await indexed(t);
  const capture = () => { let text = ''; return { stream: { write: (chunk) => { text += chunk; } }, text: () => text }; };
  const run = async (argv) => {
    const stdout = capture();
    const stderr = capture();
    const status = await runSensorCli({ argv, stdout: stdout.stream, stderr: stderr.stream });
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  };

  const ok = await run(['resolve', 'src/a.mjs#Bar.baz', 'src/a.mjs#Nope', 'broken', '--path', root, '--json']);
  assert.equal(ok.status, 0);
  const payload = JSON.parse(ok.stdout);
  assert.equal(payload.schema, 'lattice.sensor_resolve_result.v1');
  assert.deepEqual(payload.resolved.map((r) => [r.qualified, r.start_line, r.end_line]), [['Bar.baz', 3, 3]]);
  assert.deepEqual(payload.unresolved.map((u) => [u.symbol, u.reason]), [['Nope', 'symbol_not_found']]);
  assert.deepEqual(payload.malformed, ['broken']);

  const bare = await mkdtemp(path.join(tmpdir(), 'lattice-resolve-bare-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  const missing = await run(['resolve', 'a.mjs#x', '--path', bare, '--json']);
  assert.equal(missing.status, 1);
  const error = JSON.parse(missing.stderr);
  assert.equal(error.code, 'LATTICE_SENSOR_NOT_INITIALIZED');
  assert.equal(error.detail.next_action, `lattice sensor init ${bare} --json`);

  assert.equal((await run(['resolve', '--json'])).status, 2, 'no anchors is a usage error');
});
