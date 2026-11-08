import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * PR CI scope (common rule verification.minimal: scope CI by the diagrams to the range the
 * change affects). The function map's "Callers / connections" column is realised in code as
 * imports, so the affected range of a change is: the changed modules plus every module and
 * test that reaches them through imports (the callers), plus changed tests. The Sensor role
 * (`sensor/`) has its own gate (`test:sensor`) and runs only when that role is touched.
 * Anything the graph cannot place (gate/workflow/package files, a source file no one imports)
 * runs the full gate. main pushes, tags and manual runs always run the full gate.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Gate definition and shared inputs: a change here can affect every suite.
const FULL_GATE = [/^package(-lock)?\.json$/u, /^scripts\//u, /^\.github\//u, /^sensor\/package(-lock)?\.json$/u];
const SENSOR = [/^sensor\//u, /^src\/sensor-cli\.mjs$/u, /^bin\/lattice-mcp\.mjs$/u];
const DOCS_ONLY = /\.md$/u;
const MODULE = /\.(mjs|cjs|js)$/u;
const CODE = /\.(mjs|cjs|js|json)$/u; // files scanned for references

/** Relative module references in one source text: static/dynamic imports, require, URLs and repo paths. */
export function referencesIn(text, fromFile) {
  const found = new Set();
  const relative = /(?:from\s+|import\(\s*|require\(\s*|new URL\(\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/gu;
  for (const [, ref] of text.matchAll(relative)) {
    found.add(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), ref)));
  }
  // Tests also reach product code by repo path strings (spawned bins, url('src/x.mjs')).
  for (const [, ref] of text.matchAll(/['"`/](?:\.\.\/)*((?:src|bin)\/[\w./-]+\.(?:mjs|cjs|js|json))/gu)) found.add(ref);
  if (/sensor\/dist\b|@quolu\/lattice-sensor/u.test(text)) found.add('sensor/');
  return [...found];
}

/** Pure selection over a reverse import graph; `importers(file)` lists files that reference it. */
export function selectScope({ changed, tests, importers, isImported }) {
  const reasons = [];
  const full = changed.filter((file) => FULL_GATE.some((pattern) => pattern.test(file)));
  if (full.length > 0) return { full: true, reason: `gate inputs changed: ${full.join(', ')}`, tests, sensor: true };
  let sensor = false;
  const affected = new Set();
  for (const file of changed) {
    if (DOCS_ONLY.test(file)) continue;
    if (SENSOR.some((pattern) => pattern.test(file))) { sensor = true; affected.add('sensor/'); }
    if (file.startsWith('sensor/')) continue;
    // A file no import reaches (fixture read by path, data, research) cannot be placed: run everything.
    const suite = file.startsWith('test/') && tests.includes(file.slice('test/'.length));
    // Data (json, txt, fixtures) can also be read by a built path that no import shows.
    // shortcut: a JS module both imported and read by path elsewhere picks only its importers; widen if that appears.
    if (!suite && (!MODULE.test(file) || !isImported(file))) {
      return { full: true, reason: `no import path places ${file}`, tests, sensor: true };
    }
    affected.add(file);
  }
  // Reverse closure: every module/test that reaches a changed file is in the affected range.
  const queue = [...affected];
  while (queue.length > 0) {
    for (const importer of importers(queue.pop())) {
      if (!affected.has(importer)) { affected.add(importer); queue.push(importer); }
    }
  }
  const selected = tests.filter((relative) => affected.has(`test/${relative}`));
  reasons.push(`${selected.length} of ${tests.length} product suites reach the change`);
  reasons.push(sensor ? 'Sensor role touched: test:sensor runs' : 'Sensor role untouched: test:sensor skipped');
  return { full: false, reason: reasons.join('; '), tests: selected, sensor };
}

async function listFiles(directory, prefix) {
  const files = [];
  for (const entry of await readdir(path.join(repoRoot, directory), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (CODE.test(entry.name)) files.push(relative);
  }
  return files;
}

/** Scope for the current checkout against `base`; null base or an unreadable diff runs the full gate. */
export async function computeCiScope(base, { allTests }) {
  if (!base) return { full: true, reason: 'not a pull request', tests: allTests, sensor: true };
  const diff = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: repoRoot, encoding: 'utf8' });
  if (diff.status !== 0) return { full: true, reason: 'comparison base unavailable', tests: allTests, sensor: true };
  const changed = diff.stdout.split('\n').filter(Boolean);
  const sources = [...await listFiles('src', 'src'), ...await listFiles('bin', 'bin'), ...await listFiles('test', 'test')];
  const reverse = new Map();
  for (const file of sources) {
    const text = await readFile(path.join(repoRoot, file), 'utf8');
    for (const ref of referencesIn(text, file)) {
      if (!reverse.has(ref)) reverse.set(ref, new Set());
      reverse.get(ref).add(file);
    }
  }
  return selectScope({ changed, tests: allTests,
    importers: (file) => [...(reverse.get(file) ?? [])],
    isImported: (file) => reverse.has(file) });
}
