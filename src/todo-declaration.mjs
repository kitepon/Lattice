// Plan/lifecycle: the functions a task changes or reads, declared once when the task is added (ADR 0204 §1, §6).
// `--owns src/a.mjs#foo,src/b.mjs` / `--reads src/c.mjs#bar` → one witness-draft row. Resolution goes through the code graph's
// public Resolve interface only; nothing here reads the sensor index.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runSensorCli } from './sensor-cli.mjs';
import { parseAnchor, proposeSymbols, resolveAnchors, SensorResolveError } from './sensor-resolve.mjs';
import { isTodoIdentifier } from './todo-contracts.mjs';

const items = (value) => (typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : []);
const sortedUnique = (values) => [...new Set(values)].sort();

/** `a.mjs,b.mjs#foo` → bare paths, anchors, and entries that cannot be stored (with why). */
export function parseDeclarationList(value) {
  const paths = [];
  const anchors = [];
  const malformed = [];
  for (const text of items(value)) {
    if (!text.includes('#')) { paths.push(text); continue; }
    const anchor = parseAnchor(text);
    if (anchor === null) malformed.push({ text, reason: 'expected_path_hash_symbol' });
    // The witness row stores the symbol as a dotted identifier chain (Ruby `Foo#bar` cannot be stored).
    else if (!isTodoIdentifier(anchor.symbol)) malformed.push({ text, reason: 'symbol_not_a_dotted_identifier' });
    else anchors.push(anchor);
  }
  return { paths, anchors, malformed };
}

const byWithin = (anchors) => {
  const grouped = new Map();
  for (const { path: within, symbol } of anchors) grouped.set(within, [...(grouped.get(within) ?? []), symbol]);
  return [...grouped].map(([within, symbols]) => ({ within, symbols: sortedUnique(symbols) }));
};

async function resolveOnce(root, anchors) {
  try { return await resolveAnchors({ root, anchors }); } catch (error) {
    if (!(error instanceof SensorResolveError) || error.code !== 'RESOLVE_INDEX_MISSING') throw error;
  }
  // First use only: the maintained index does not exist yet (Observe builds it; later calls reuse it).
  const sink = { write() {} };
  await runSensorCli({ argv: ['init', root, '--json'], stdout: sink, stderr: sink });
  return resolveAnchors({ root, anchors });
}

const unresolvedEntry = (anchor, reason, nearest = [], elsewhere = []) => ({
  path: anchor.path, symbol: anchor.symbol, reason, nearest, elsewhere,
});

/**
 * Resolve a task's declared functions and build its witness-draft row.
 * → `{row, declaration: {written, resolved[], unresolved[], malformed[]}}`; `row` is null when `written` is false
 * (a task's row is not written until every name resolves, so the next declare retries from scratch).
 * `observable` false = the Store root has no code tree: functions cannot be checked, never recorded as a guess.
 */
export async function buildDeclarationRow({ root, observable, owns, reads, writes }) {
  const own = parseDeclarationList(owns);
  const read = parseDeclarationList(reads);
  const malformed = [...own.malformed, ...read.malformed];
  const wanted = [...new Map([...own.anchors, ...read.anchors].map((anchor) => [`${anchor.path}\0${anchor.symbol}`, anchor])).values()];
  const declaration = { written: false, resolved: [], unresolved: [], malformed };
  if (malformed.length > 0) return { row: null, declaration };
  if (wanted.length > 0) {
    if (!observable) {
      declaration.unresolved = wanted.map((anchor) => unresolvedEntry(anchor, 'no_code_tree'));
      return { row: null, declaration };
    }
    let answer;
    try { answer = await resolveOnce(root, wanted); } catch (error) {
      declaration.unresolved = wanted.map((anchor) => unresolvedEntry(anchor, 'resolve_unavailable'));
      declaration.resolve_error = error?.code ?? error?.message ?? 'resolve_failed';
      return { row: null, declaration };
    }
    declaration.unresolved = answer.unresolved.map((anchor) => unresolvedEntry(
      anchor, anchor.reason,
      anchor.nearest.map(({ qualified }) => qualified),
      anchor.elsewhere.map(({ path: where, qualified }) => `${where}#${qualified}`),
    ));
    declaration.resolved = answer.resolved.map(({ path: where, symbol, kind, start_line: start, end_line: end }) => ({
      path: where, symbol, kind, start_line: start, end_line: end,
    }));
    if (declaration.unresolved.length > 0) return { row: null, declaration };
  }
  const concern = byWithin(own.anchors);
  const readAnchors = byWithin(read.anchors);
  const row = {
    owns: sortedUnique([...own.paths, ...concern.map(({ within }) => within)]),
    reads: sortedUnique([...read.paths, ...readAnchors.map(({ within }) => within)]),
    writes: items(writes),
    ...(concern.length > 0 ? { concern_anchors: concern } : {}),
    ...(readAnchors.length > 0 ? { read_anchors: readAnchors } : {}),
  };
  declaration.written = true;
  return { row, declaration };
}

/**
 * Fallback without seeds (ADR 0204 §1): identifiers in the title and design memo that name graph symbols are proposed in the
 * result and never recorded; the AI that adds the task decides. Needs an existing index and a code tree; any failure = no proposal.
 */
export async function proposeFromText({ root, observable, title, memo }) {
  if (!observable || !existsSync(path.join(root, '.lattice/sensor/sensor.db'))) return null;
  // Resolve's `snake` leaves `qualified: undefined` on a definition; a result is canonical JSON, so drop undefined here.
  try { return JSON.parse(JSON.stringify(await proposeSymbols({ root, title, memo }))); } catch { return null; }
}
