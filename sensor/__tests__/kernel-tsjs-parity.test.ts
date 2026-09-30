/**
 * Kernel↔wasm TS/JS extraction parity (R2 of the kernel migration).
 *
 * Asserts the native walker (lattice-sensor-kernel/src/tsjs/) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over:
 *   - the checked-in torture fixtures (every ported feature: components/HOCs,
 *     stores, RTK, vuex, fn-refs, value-ref shadowing, decorators, enums,
 *     type-alias members/tuple contracts, re-exports, JSX, field methods), and
 *   - this repo's own extraction sources (real-world TS).
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (excalidraw et al.,
 * run for the §5 gate); this suite keeps the invariant alive in `npm test`.
 * Skips when no kernel binary is staged; LATTICE_SENSOR_KERNEL_EXPECT=1 turns that
 * into a failure (wired in kernel-scaffold.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'lattice-sensor-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'lattice-sensor-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'kernel-parity');
const REAL_SOURCES = [
  'src/extraction/kernel/loader.ts',
  'src/extraction/kernel/decode.ts',
  'src/extraction/parse-pool.ts',
  'src/extraction/function-ref.ts',
  'src/mcp/tools.ts',
];

function canon(result: ExtractionResult): { nodes: string[]; edges: string[]; refs: string[] } {
  return {
    nodes: result.nodes
      .map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort()))
      .sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort(),
  };
}

const ENV_KEYS = ['LATTICE_SENSOR_KERNEL', 'LATTICE_SENSOR_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

describe.skipIf(!kernelBuilt)('kernel TS/JS extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function assertParity(filePath: string, source: string, language: Language): ExtractionResult {
    process.env.LATTICE_SENSOR_KERNEL_LANGS = 'all';
    delete process.env.LATTICE_SENSOR_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, language);
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.LATTICE_SENSOR_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, language);
    delete process.env.LATTICE_SENSOR_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    // Meaningful comparison, not empty-vs-empty.
    expect(viaWasm.nodes.length).toBeGreaterThan(3);
    return viaWasm;
  }

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('same-line accessors retain distinct identities after Unicode: %s (#1349)', (ext, language) => {
    const source = 'class Point { /* é😀 */ get x() { return read(); } set x(v) { write(v); } }';
    const result = assertParity(`point.${ext}`, source, language);
    const x = result.nodes.filter((n) => n.name === 'x');
    expect(x).toHaveLength(2);
    expect(x[1]!.id).toBe(`${x[0]!.id}:${source.indexOf('set x')}`);
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => [r.fromNodeId, r.referenceName]))
      .toEqual([[x[0]!.id, 'read'], [x[1]!.id, 'write']]);
    // No state leaks between files or repeated extractions.
    expect(canon(assertParity(`point.${ext}`, source, language))).toEqual(canon(result));
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('leaves nested identifier receivers unresolved and keeps argument calls: %s (#1566)', (ext, language) => {
    const result = assertParity(`fixture.${ext}`, `
function readKey() { return 'answer'; }
function local() {
  const values = new Map();
  return values.get(readKey());
}
function nested(holder) {
  holder.values.get(readKey());
  holder.values?.get(readKey());
  holder['values'].get(readKey());
  holder.deep.values.get(readKey());
}
`, language);
    const nested = result.nodes.find((n) => n.name === 'nested' && n.kind === 'function');
    expect(nested).toBeDefined();
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' && r.fromNodeId === nested!.id)
      // Qualified sites are retained for effects; computed keys still make no
      // receiver claim. All four calls inside arguments must also survive.
      .map((r) => r.referenceName)).toEqual([
        'holder.values.get', 'readKey', 'holder.values.get', 'readKey',
        'readKey', 'holder.deep.values.get', 'readKey',
      ]);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'values.get')).toBe(true);
  });

  describe.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('private field receivers: %s (#1987)', (ext, language) => {
    it.each(['LF', 'CRLF'])('preserves private fields and optional calls (%s)', (ending) => {
      const source = `
class Mailer { send() {} }
class Vault {
  #mailer = new Mailer();
  #items = new Set();
  notify() { this.#mailer?.send(); }
  optional() { this.#mailer.send?.(); }
  put() { this.#items?.add('x'); }
}
`;
      const result = assertParity(`vault.${ext}`, ending === 'CRLF' ? source.replace(/\n/g, '\r\n') : source, language);
      expect(result.unresolvedReferences.filter(r => r.referenceKind === 'calls').map(r => r.referenceName))
        .toEqual(['this.#mailer.send', 'this.#mailer.send', 'this.#items.add']);
    });
  });

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('peels transparent receivers and drops untyped expression receivers: %s', (ext, language) => {
    const typed = language === 'typescript' || language === 'tsx';
    const result = assertParity(`fixture.${ext}`, `
function list() { return []; }
class Runner { go() { return 1; } }
async function exprReceivers(x, y) {
  (await list()).map(g);
  (x).run();
  ${typed ? 'x!.run(); (y as X).run(); (x satisfies X).stop(); getTarget("a")!.install(); if (x && y!.c.has(1)) {} if (x && this.e!.c.has(1)) {}' : ''}
  (a ?? b).map(g);
  arr[0].run();
  f().list.map(g);
  (() => 1).call(null);
  this.a.b.run();
  super.stop();
  new Runner().go();
  window.Api.start();
}
`, language);
    const fn = result.nodes.find((n) => n.name === 'exprReceivers');
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls' && r.fromNodeId === fn!.id)
      .map((r) => r.referenceName)).toEqual([
        'list().map', 'list', 'x.run',
        ...(typed ? ['x.run', 'y.run', 'x.stop', 'getTarget().install', 'getTarget', 'has'] : []),
        'f', 'run', 'stop', 'go', 'start',
      ]);
  });

  it('torture fixture (tsx): components, stores, RTK, fn-refs, value-refs, decorators', () => {
    const file = path.join(FIXTURE_DIR, 'torture.tsx');
    assertParity('fixtures/torture.tsx', fs.readFileSync(file, 'utf8'), 'tsx');
  });

  it('torture fixture (js): field methods, wrappers, vuex module shape', () => {
    const file = path.join(FIXTURE_DIR, 'torture.js');
    assertParity('fixtures/torture.js', fs.readFileSync(file, 'utf8'), 'javascript');
  });

  it('torture fixture (java): Lombok, anonymous classes, method refs, chains', () => {
    const file = path.join(FIXTURE_DIR, 'Torture.java');
    assertParity('fixtures/Torture.java', fs.readFileSync(file, 'utf8'), 'java');
  });

  it('torture fixture (python): decorators, self fn-refs, imports, shadowing', () => {
    const file = path.join(FIXTURE_DIR, 'torture.py');
    assertParity('fixtures/torture.py', fs.readFileSync(file, 'utf8'), 'python');
  });

  it.each(['LF', 'CRLF'])('Python body docstrings parity (%s, #1905)', (ending) => {
    const source = fs.readFileSync(path.join(FIXTURE_DIR, 'docstrings.py'), 'utf8');
    const result = assertParity('ledger.py', ending === 'CRLF' ? source.replace(/\n/g, '\r\n') : source, 'python');
    expect(result.nodes.find((n) => n.kind === 'file')?.docstring).toBe('Ledger module documentation.');
    expect(result.nodes.find((n) => n.name === 'settle')?.docstring).toBe('Method comment.\n\nSettle the ledger.');
  });

  it('torture fixture (go): receivers, embedding, interfaces, composite literals', () => {
    const file = path.join(FIXTURE_DIR, 'torture.go');
    assertParity('fixtures/torture.go', fs.readFileSync(file, 'utf8'), 'go');
  });

  it.each([
    ['typescript', 'state.ts', [
      'export const HIT_TABLE = { n: 0 };',
      'export function readOnly() { return HIT_TABLE.n; }',
      'export function mutateMember() { HIT_TABLE.n += 1; }',
      'export function readThenWrite() { const n = HIT_TABLE.n; HIT_TABLE.n = n + 1; }',
    ].join('\n')],
    ['go', 'state.go', [
      'package state',
      'var HIT_TABLE = struct{ N int }{0}',
      'func readOnly() int { return HIT_TABLE.N }',
      'func mutateMember() { HIT_TABLE.N += 1 }',
      'func readThenWrite() { n := HIT_TABLE.N; HIT_TABLE.N = n + 1 }',
    ].join('\n')],
    ['python', 'state.py', [
      'HIT_TABLE = {"n": 0}',
      'def read_only(): return HIT_TABLE["n"]',
      'def mutate_member(): HIT_TABLE["n"] += 1',
      'def read_then_write():',
      '    n = HIT_TABLE["n"]',
      '    HIT_TABLE["n"] = n + 1',
    ].join('\n')],
    ['java', 'State.java', [
      'class State {',
      '  static final int[] HIT_TABLE = { 0 };',
      '  int readOnly() { return HIT_TABLE[0]; }',
      '  void mutateMember() { HIT_TABLE[0] += 1; }',
      '  void readThenWrite() { int n = HIT_TABLE[0]; HIT_TABLE[0] = n + 1; }',
      '}',
    ].join('\n')],
  ] as const)('value-reference write metadata parity (%s)', (language, filePath, source) => {
    assertParity(filePath, source, language);
  });

  it.each([
    ['typescript', 'lowercase.ts', [
      'const counter = 1;',
      'export function readCounter() { return counter; }',
      'export function readCounterAgain() { return counter + 1; }',
    ].join('\n')],
    ['go', 'lowercase.go', [
      'package state',
      'var counter = 1',
      'func readCounter() int { return counter }',
      'func readCounterAgain() int { return counter + 1 }',
    ].join('\n')],
    ['python', 'lowercase.py', [
      'counter = 1',
      'def read_counter(): return counter',
      'def read_counter_again(): return counter + 1',
    ].join('\n')],
    ['java', 'Lowercase.java', [
      'class Lowercase {',
      '  static int counter = 1;',
      '  int readCounter() { return counter; }',
      '}',
    ].join('\n')],
  ] as const)('lowercase value-reference target parity (%s)', (language, filePath, source) => {
    assertParity(filePath, source, language);
  });

  it('Python member values preserve receivers across callback, assignment and collection positions (#1820)', () => {
    const result = assertParity('members.py', `
class Store:
    def fetch(self, ids):
        return ids
class Consumer:
    def wire(self, pool, obj):
        pool.submit(self.store.fetch, obj.fetch)
        cb = self.store.fetch
        table = [obj.fetch, Store.fetch, self.fetch, cls.fetch]
        keyword(callback=obj.fetch)
        obj.fetch([])
        pool.submit(factory().fetch, obj[0].fetch)
`, 'python');
    const names = result.unresolvedReferences.filter(r => r.referenceKind === 'function_ref').map(r => r.referenceName);
    expect(names.sort()).toEqual(['Store.fetch', 'cls.fetch', 'obj.fetch', 'self.fetch', 'self.store.fetch']);
    expect(result.unresolvedReferences.some(r => r.referenceKind === 'calls' && r.referenceName === 'obj.fetch')).toBe(true);
  });

  it('Go method values preserve receivers and exclude invocation receivers (#1820)', () => {
    const result = assertParity('members.go', `package demo
 type Store struct{}
 func (s *Store) Fetch() {}
 func wire(c *Store, pool Pool) {
   Submit(c.Fetch)
   cb := c.Fetch
   table := []func(){c.Fetch, Store.Fetch}
   Submit(c.store.Fetch)
   go c.Fetch()
   Submit(factory().Fetch, items[0].Fetch)
 }
`, 'go');
    const names = result.unresolvedReferences.filter(r => r.referenceKind === 'function_ref').map(r => r.referenceName);
    expect(names.sort()).toEqual(['Store.Fetch', 'c.Fetch', 'c.store.Fetch']);
    expect(result.unresolvedReferences.some(r => r.referenceKind === 'calls' && r.referenceName === 'c.Fetch')).toBe(true);
  });

  it.each(REAL_SOURCES)('real source parity: %s', (rel) => {
    const file = path.join(__dirname, '..', rel);
    assertParity(rel, fs.readFileSync(file, 'utf8'), 'typescript');
  });

  // Every torture fixture again with CRLF line endings — the shape every
  // Windows autocrlf checkout has. Derived in memory (not a checked-in CRLF
  // file) so no platform or editor can silently normalize it away. Pins the
  // JS-multiline-^ semantics in the kernel's docstring cleaning: JS `^`/m
  // anchors after \r too, so the block-continuation `\s*` eats the `\n` and
  // the cleaned docstring keeps a bare `\r` (caught on the Windows VM leg of
  // the O2 gate; diverged in the kernel until docstring.rs mirrored it).
  it.each([
    ['torture.tsx', 'tsx'],
    ['torture.js', 'javascript'],
    ['Torture.java', 'java'],
    ['torture.py', 'python'],
    ['torture.go', 'go'],
  ] as const)('torture fixture CRLF parity: %s', (name, lang) => {
    const file = path.join(FIXTURE_DIR, name);
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity(`fixtures/${name} (crlf)`, crlf, lang);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    // tree-sitter error RECOVERY differs between UTF-8 (native) and UTF-16
    // (web-tree-sitter) parsing — same grammar, same core version — so the
    // kernel defers any erroring file to keep routing graph-neutral.
    const broken = 'export function f( {\n  return }} 12 (\n';
    process.env.LATTICE_SENSOR_KERNEL_LANGS = 'all';
    delete process.env.LATTICE_SENSOR_KERNEL;
    expect(tryKernelExtract('src/broken.ts', broken, 'typescript')).toBeNull();
    // The seam still serves the file — through the wasm path.
    process.env.LATTICE_SENSOR_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.ts', broken, 'typescript');
    delete process.env.LATTICE_SENSOR_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });

  it('typescript fixture parsed as plain typescript variant', () => {
    // Same content through the non-tsx grammar exercises the typescript
    // (vs tsx) LangSpec pairing.
    const file = path.join(__dirname, '..', 'src/extraction/kernel/index.ts');
    assertParity('src/extraction/kernel/index.ts', fs.readFileSync(file, 'utf8'), 'typescript');
  });
});
