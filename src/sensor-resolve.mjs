// Code graph role, public interface "Resolve" (ADR 0204 §4, a3). Plan/lifecycle calls these two functions; it never reads
// `sensor/` or the index. One sensor process per call; the index must exist (Observe makes it).
import { spawn } from 'node:child_process';

import { sensorCliInvocation } from './sensor-runtime.mjs';

export class SensorResolveError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SensorResolveError';
    this.code = code;
    this.detail = detail;
  }
}

/** `path#symbol` → `{path, symbol}`. Splits at the FIRST `#` (Ruby `Foo#bar` stays in the symbol); null = malformed. */
export function parseAnchor(text) {
  if (typeof text !== 'string') return null;
  const at = text.indexOf('#');
  if (at <= 0 || at === text.length - 1) return null;
  const path = text.slice(0, at).trim();
  const symbol = text.slice(at + 1).trim();
  return path === '' || symbol === '' ? null : { path, symbol };
}

// An identifier a person means as code: camelCase, snake_case, a Capitalised.dotted chain, or one in backticks / followed by `(`.
const CODE_TOKEN = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`|\b([A-Za-z_$][\w$]*)\(|\b([A-Z][\w$]*\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|[A-Za-z_$][\w$]*[_][\w$]*|[a-z][a-z0-9]*[A-Z][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*)\b/gu;
const MAX_NAMES = 30;

/** Identifier candidates in a task's title / design memo, in order of appearance, last dotted part only. */
export function identifiersFromText(...texts) {
  const names = new Set();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(CODE_TOKEN)) {
      const raw = match[1] ?? match[2] ?? match[3];
      const name = raw.split('.').at(-1);
      if (name.length >= 3) names.add(name);
      if (names.size >= MAX_NAMES) return [...names];
    }
  }
  return [...names];
}

function runResolve({ root, request }) {
  const invocation = sensorCliInvocation(['resolve', '--path', root]);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: { ...process.env, LATTICE_SENSOR_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) {
        reject(new SensorResolveError(
          /not initialized/u.test(stderr) ? 'RESOLVE_INDEX_MISSING' : 'RESOLVE_SENSOR_FAILED',
          'sensor resolve failed', { exit_code: code, stderr },
        ));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); } catch (error) {
        reject(new SensorResolveError('RESOLVE_OUTPUT_INVALID', 'sensor resolve returned invalid JSON', { cause: error.message }));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const snake = ({ startLine, endLine, qualified, ...rest }) => ({ ...rest, qualified, start_line: startLine, end_line: endLine });

/**
 * Resolve `{path, symbol}[]` against the maintained index of `root`.
 * → `{resolved: [{path, symbol, qualified, kind, start_line, end_line, related?}], unresolved: [{path, symbol, reason, nearest[], elsewhere[]}],
 *     ambiguous: [{path, symbol, names[]}]}`
 * Exact match only. A symbol with several definitions in its file (overloads, same name in two classes) returns every span, and
 * `ambiguous` names the case when they are different definitions. `unresolved` is an answer, not an error.
 */
export async function resolveAnchors({ root, anchors, related = false }) {
  const result = await runResolve({ root, request: { anchors, related } });
  const moveRelated = (node) => (node.related === undefined ? node : {
    ...node,
    related: Object.fromEntries(Object.entries(node.related).map(([key, value]) => [key,
      Array.isArray(value) ? value.map(snake) : value])),
  });
  return {
    resolved: result.resolved.map((node) => moveRelated(snake(node))),
    unresolved: result.unresolved.map((anchor) => ({
      ...anchor, nearest: anchor.nearest.map(snake), elsewhere: anchor.elsewhere.map(snake),
    })),
    ambiguous: result.ambiguous,
  };
}

/**
 * Seed fallback (2b): identifiers in the task's title and design memo that name graph symbols exactly. A proposal for the AI
 * that adds the task; nothing is recorded. `missed` says what the text did not name, so "no proposal" is never read as "touches
 * nothing".
 * → `{proposed: [{name, definitions: [{path, symbol, kind, start_line, end_line}]}], too_common: [name], not_found: [name]}`
 */
export async function proposeSymbols({ root, title, memo }) {
  const names = identifiersFromText(title, memo);
  if (names.length === 0) return { proposed: [], too_common: [], not_found: [] };
  const { named } = await runResolve({ root, request: { names } });
  return {
    proposed: named.filter((n) => n.definitions.length > 0)
      .map((n) => ({ name: n.name, definitions: n.definitions.map(snake) })),
    too_common: named.filter((n) => n.tooCommon).map((n) => n.name),
    not_found: named.filter((n) => !n.tooCommon && n.definitions.length === 0).map((n) => n.name),
  };
}
