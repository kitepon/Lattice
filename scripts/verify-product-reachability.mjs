#!/usr/bin/env node
/**
 * Package source must be reachable from a product entry point.
 * Historical research remains available through Git history, not as shipped source.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));


// import文は複数行に跨る。行内に閉じる形だけを見ると、この codebase の大半を取り落とす。
// 相対specifierだけを拾えば、layoutに関係なく静的import／re-exportの両方を覆える。
const IMPORT = /from\s*['"](\.[^'"]+)['"]/gu;
const DYNAMIC = /import\(\s*['"](\.[^'"]+)['"]\s*\)/gu;

async function readIfPresent(file) {
  try { return await readFile(path.join(ROOT, file), 'utf8'); } catch { return null; }
}

async function reachableFrom(entries) {
  const seen = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    const text = await readIfPresent(current);
    if (text === null) continue;
    seen.add(current);
    const dir = path.posix.dirname(current);
    for (const pattern of [IMPORT, DYNAMIC]) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        pending.push(path.posix.normalize(path.posix.join(dir, match[1])));
      }
    }
  }
  return seen;
}

const entries = [];
for (const directory of ['bin', 'scripts']) {
  for (const name of await readdir(path.join(ROOT, directory))) {
    if (name.endsWith('.mjs')) entries.push(`${directory}/${name}`);
  }
}
const reachable = await reachableFrom(entries);
const sources = (await readdir(path.join(ROOT, 'src')))
  .filter((name) => name.endsWith('.mjs')).map((name) => `src/${name}`).sort();

const undeclared = sources.filter((file) => !reachable.has(file));

const report = {
  schema: 'lattice.product_reachability_report.v1',
  entry_points: entries.length,
  product_modules: sources.filter((file) => reachable.has(file)).length,
  declared_research_artifacts: 0,
  undeclared_unreachable: undeclared,
  stale_declarations: [],
};
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
if (undeclared.length > 0) {
  process.stderr.write(`product reachability drifted: ${undeclared.length} unreachable source files\n`);
  process.exit(1);
}
process.stdout.write(`product reachability verified: ${report.product_modules} product modules\n`);
