import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { affectedNodes, buildFunctionGraph, changedNodes, hunkRanges, parseModule } from '../scripts/ci-function-scope.mjs';
import { referencesIn, selectScope } from '../scripts/ci-scope.mjs';

const files = new Map(Object.entries({
  'src/lib.mjs': [
    'import { helper } from "./util.mjs";',
    '',
    '/** f is exported. */',
    'export function f() { return inner() + helper(); }',
    '',
    'function inner() { return 1; }',
    '',
    'export const g = () => 2;',
    '',
    'export function unused() { return 3; }',
    '',
  ].join('\n'),
  'src/util.mjs': 'export function helper() { return 1; }\nexport function other() { return 2; }\n',
  'src/barrel.mjs': 'export { f } from "./lib.mjs";\nexport * from "./util.mjs";\n',
  'src/user-f.mjs': 'import { f } from "./lib.mjs";\nexport function useF() { return f(); }\n',
  'src/user-g.mjs': 'import { g } from "./lib.mjs";\nexport function useG() { return g(); }\n',
  'src/user-ns.mjs': 'import * as lib from "./lib.mjs";\nexport function useNs() { return lib.g(); }\n',
  'src/user-barrel.mjs': 'import { other } from "./barrel.mjs";\nexport function useBarrel() { return other(); }\n',
  'bin/cli.mjs': 'import { useF } from "../src/user-f.mjs";\nawait useF();\n',
  'test/f.test.mjs': 'import { useF } from "../src/user-f.mjs";\ntest("f", () => useF());\n',
  'test/g.test.mjs': 'import { useG } from "../src/user-g.mjs";\ntest("g", () => useG());\n',
  'test/ns.test.mjs': 'import { useNs } from "../src/user-ns.mjs";\ntest("ns", () => useNs());\n',
  'test/dyn.test.mjs': 'test("dyn", async () => {\n  const { g } = await import("../src/lib.mjs");\n  g();\n});\n',
  'test/spawn.test.mjs': 'test("spawn", () => spawnSync(process.execPath, ["bin/cli.mjs"]));\n',
  'test/barrel.test.mjs': 'import { useBarrel } from "../src/user-barrel.mjs";\ntest("barrel", () => useBarrel());\n',
  'test/unrelated.test.mjs': 'import { other } from "../src/util.mjs";\ntest("o", () => other());\n',
}));
const graph = buildFunctionGraph(files, [...files.keys()].filter((file) => /^(src|bin)\//u.test(file)), referencesIn);
const testsReached = (...seeds) => [...affectedNodes(graph, seeds)].filter((node) => /^test\/.*#\*$/u.test(node)).map((node) => node.slice(5, -2)).sort();

test('a changed function selects only the tests that name it, directly or through callers', () => {
  assert.deepEqual(testsReached('src/lib.mjs#g'), ['dyn.test.mjs', 'g.test.mjs', 'ns.test.mjs']);
  // inner is a private helper of f: reaches f's callers, the CLI that runs them, and the barrel's re-export
  assert.deepEqual(testsReached('src/lib.mjs#inner'), ['f.test.mjs', 'spawn.test.mjs']);
  assert.deepEqual(testsReached('src/lib.mjs#unused'), []);
});

test('a named import reaches through a re-export barrel and a star export', () => {
  assert.deepEqual(testsReached('src/util.mjs#other'), ['barrel.test.mjs', 'unrelated.test.mjs']);
  assert.deepEqual(testsReached('src/lib.mjs#f'), ['f.test.mjs', 'spawn.test.mjs']);
});

test('a module-level change widens to the whole file; the import line is module-level', () => {
  const seeds = changedNodes('src/lib.mjs', { oldText: files.get('src/lib.mjs'), newText: files.get('src/lib.mjs'), oldRanges: [[1, 1]], newRanges: [[1, 1]] });
  assert.ok(seeds.has('src/lib.mjs#*') && seeds.has('src/lib.mjs#g') && seeds.has('src/lib.mjs#unused'));
  // barrel.test imports lib only through the barrel, whose import runs lib's module-level code
  assert.deepEqual(testsReached(...seeds), ['barrel.test.mjs', 'dyn.test.mjs', 'f.test.mjs', 'g.test.mjs', 'ns.test.mjs', 'spawn.test.mjs']);
});

test('a deleted function still seeds its old name so its importers are selected', () => {
  const oldText = files.get('src/lib.mjs');
  const newText = oldText.replace('export const g = () => 2;\n\n', '');
  const seeds = changedNodes('src/lib.mjs', { oldText, newText, oldRanges: [[8, 9]], newRanges: [[8, 8]] });
  assert.ok(seeds.has('src/lib.mjs#g'));
  assert.ok(!seeds.has('src/lib.mjs#*'));
  assert.deepEqual(testsReached(...seeds), ['dyn.test.mjs', 'g.test.mjs', 'ns.test.mjs']);
});

test('hunk ranges: a pure insertion or deletion covers the lines around it', () => {
  assert.deepEqual(hunkRanges('@@ -3,2 +3 @@\n@@ -9 +8,0 @@\n@@ -1,0 +2,3 @@'), {
    oldRanges: [[3, 4], [9, 9], [1, 2]],
    newRanges: [[3, 3], [8, 9], [2, 4]],
  });
});

test('selectScope: function-placed files narrow the selection; others keep the file-level closure', () => {
  const tests = ['f.test.mjs', 'g.test.mjs', 'unrelated.test.mjs'];
  const importers = (file) => ({ 'src/lib.mjs': ['test/f.test.mjs', 'test/g.test.mjs'] })[file] ?? [];
  const functions = {
    seedsFor: (file) => (file === 'src/lib.mjs' ? new Set(['src/lib.mjs#g']) : null),
    affected: () => new Set(['src/lib.mjs#g', 'test/g.test.mjs#*']),
  };
  const placed = selectScope({ changed: ['src/lib.mjs'], tests, importers, isImported: () => true, functions });
  assert.deepEqual(placed.tests, ['g.test.mjs']);
  assert.match(placed.reason, /1 changed function nodes placed/u);
  const widened = selectScope({ changed: ['src/lib.mjs'], tests, importers, isImported: () => true });
  assert.deepEqual(widened.tests, ['f.test.mjs', 'g.test.mjs']);
  // a file no import reaches still runs everything, placed or not
  assert.equal(selectScope({ changed: ['src/lib.mjs'], tests, importers, isImported: () => false, functions }).full, true);
});

test('the statement parser covers every line of the real src/ and bin/ modules and finds every exported declaration', async () => {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  for (const directory of ['src', 'bin']) {
    for (const name of (await readdir(path.join(root, directory))).filter((entry) => /\.mjs$/u.test(entry))) {
      const text = await readFile(path.join(root, directory, name), 'utf8');
      const statements = parseModule(text);
      const lines = text.split('\n').length;
      assert.equal(statements[0].first, 1, `${directory}/${name} first line`);
      assert.equal(statements.at(-1).last, lines, `${directory}/${name} last line`);
      statements.slice(1).forEach((statement, index) => assert.equal(statement.first, statements[index].last + 1, `${directory}/${name} gap`));
      const declared = (text.match(/^export\s+(?:async\s+)?(?:function\*?|class)\s+[\w$]+/gmu) ?? []).length;
      const parsed = statements.filter((statement) => statement.kind === 'unit' && statement.exported && /^export\s+(?:async\s+)?(?:function|class)/u.test(statement.body.replace(/^(?:\s*(?:\/\/.*|\/\*[\s\S]*?\*\/))*\s*/u, ''))).length;
      assert.equal(parsed, declared, `${directory}/${name} exported declarations`);
    }
  }
});
