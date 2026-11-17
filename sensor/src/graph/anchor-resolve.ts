/**
 * Anchor resolution — `{path, symbol}` → the line span(s) of that symbol in that file (ADR 0204 Resolve, a3).
 *
 * Deterministic, no AI. Unlike `lookupSymbolNodes` (a name typed by a human, anywhere in the project) this answers one
 * question: "in THIS file, which definition does this written chain name?". Matching is exact on a boundary-aligned
 * chain; a miss never degrades to a fuzzy hit, it answers the nearest names so the caller can correct the typo.
 */

import type { Node } from '../types';

/** Kinds that are not a unit of change inside a file. */
const NOT_A_SYMBOL = new Set(['file', 'import', 'export', 'parameter']);

export interface ResolvedSpan {
  path: string;
  symbol: string;
  /** The extractor's own chain, written with `.` (`Bar.baz`), so a caller can write it back. */
  qualified: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Only when asked for: direct callers/callees from the graph (information and freshness, never a conflict by itself). */
  related?: { callers: RelatedNode[]; callees: RelatedNode[]; truncated: boolean };
}

export interface RelatedNode { path: string; symbol: string; kind: string; startLine: number; endLine: number }

export interface UnresolvedAnchor {
  path: string;
  symbol: string;
  reason: 'file_not_indexed' | 'symbol_not_found' | 'symbol_empty' | 'path_invalid';
  /** Closest names inside the same file (empty when the file is not indexed). */
  nearest: Array<Omit<ResolvedSpan, 'path' | 'symbol'> & { symbol: string }>;
  /** Exact-name definitions in other files: the usual cause of a wrong path. */
  elsewhere: Array<{ path: string; symbol: string; kind: string; startLine: number; endLine: number }>;
}

export interface AnchorResolution {
  resolved: ResolvedSpan[];
  unresolved: UnresolvedAnchor[];
  /** A written chain that names more than one distinct definition in its file (the caller must disclose it). */
  ambiguous: Array<{ path: string; symbol: string; names: string[] }>;
}

/** The slice of LatticeSensor a resolution needs; keeps this module testable without an index. */
export interface AnchorResolveHost {
  getNodesInFile(filePath: string): Node[];
  getNodesByName(name: string): Node[];
  getCallers?(nodeId: string, maxDepth?: number): Array<{ node: Node }>;
  getCallees?(nodeId: string, maxDepth?: number): Array<{ node: Node }>;
}

const NEAREST_LIMIT = 5;
const ELSEWHERE_LIMIT = 5;
const RELATED_LIMIT = 20;

/** Scope separators are `::` in the extractors and `.` in what people write; `/n` is Erlang arity. */
function chainOf(text: string): string[] {
  return text.split(/::|\./).filter((part) => part.length > 0);
}

const display = (node: Node): string => chainOf(node.qualifiedName || node.name).join('.');

/**
 * Does the node's chain end with the written chain? Leading parts that the extractor does not keep in the name
 * (Rust modules, Python packages live in the path) may instead match a path segment.
 */
function nodeMatches(node: Node, written: string[], pathSegments: Set<string>): boolean {
  const own = chainOf(node.qualifiedName || node.name);
  for (let tail = written.length; tail >= 1; tail--) {
    const wantedTail = written.slice(written.length - tail);
    if (wantedTail.length > own.length) continue;
    const ownTail = own.slice(own.length - tail);
    if (!wantedTail.every((part, i) => part === ownTail[i])) continue;
    if (written.slice(0, written.length - tail).every((part) => pathSegments.has(part))) return true;
  }
  return false;
}

function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[y.length]!;
}

function span(path: string, symbol: string, node: Node): ResolvedSpan {
  return { path, symbol, qualified: display(node), kind: node.kind, startLine: node.startLine, endLine: node.endLine };
}

function relatedOf(host: AnchorResolveHost, node: Node): NonNullable<ResolvedSpan['related']> {
  const take = (rows: Array<{ node: Node }>) => rows.slice(0, RELATED_LIMIT).map(({ node: n }) => ({
    path: n.filePath, symbol: display(n), kind: n.kind, startLine: n.startLine, endLine: n.endLine,
  }));
  const callers = host.getCallers?.(node.id, 1) ?? [];
  const callees = host.getCallees?.(node.id, 1) ?? [];
  return { callers: take(callers), callees: take(callees), truncated: callers.length > RELATED_LIMIT || callees.length > RELATED_LIMIT };
}

function nearestIn(nodes: Node[], written: string[]): UnresolvedAnchor['nearest'] {
  const target = written.join('.');
  return nodes
    .map((node) => ({ node, score: distance(target, display(node)) }))
    .sort((a, b) => a.score - b.score || a.node.startLine - b.node.startLine)
    .slice(0, NEAREST_LIMIT)
    .map(({ node }) => ({
      symbol: display(node), qualified: display(node), kind: node.kind, startLine: node.startLine, endLine: node.endLine,
    }));
}

export function resolveAnchors(
  host: AnchorResolveHost,
  anchors: Array<{ path: string; symbol: string }>,
  options: { related?: boolean } = {},
): AnchorResolution {
  const out: AnchorResolution = { resolved: [], unresolved: [], ambiguous: [] };
  const fileCache = new Map<string, Node[]>();
  for (const anchor of anchors) {
    const path = anchor.path.replace(/^\.\//, '');
    const written = chainOf(anchor.symbol.replace(/\/\d{1,3}$/, ''));
    const miss = (reason: UnresolvedAnchor['reason'], nearest: UnresolvedAnchor['nearest'] = [], elsewhere: UnresolvedAnchor['elsewhere'] = []) =>
      out.unresolved.push({ path: anchor.path, symbol: anchor.symbol, reason, nearest, elsewhere });
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) { miss('path_invalid'); continue; }
    if (written.length === 0) { miss('symbol_empty'); continue; }

    let all = fileCache.get(path);
    if (all === undefined) { all = host.getNodesInFile(path); fileCache.set(path, all); }
    const symbols = all.filter((node) => !NOT_A_SYMBOL.has(node.kind));
    const segments = new Set(path.split('/').flatMap((part) => [part, part.replace(/\.[^.]+$/, '')]));
    const hits = symbols.filter((node) => nodeMatches(node, written, segments));
    if (hits.length > 0) {
      for (const node of hits) {
        const resolved = span(path, anchor.symbol, node);
        if (options.related === true) resolved.related = relatedOf(host, node);
        out.resolved.push(resolved);
      }
      const names = [...new Set(hits.map(display))];
      if (names.length > 1) out.ambiguous.push({ path, symbol: anchor.symbol, names });
      continue;
    }
    const elsewhere = host.getNodesByName(written[written.length - 1]!)
      .filter((node) => node.filePath !== path && !NOT_A_SYMBOL.has(node.kind))
      .slice(0, ELSEWHERE_LIMIT)
      .map((node) => ({ path: node.filePath, symbol: display(node), kind: node.kind, startLine: node.startLine, endLine: node.endLine }));
    miss(all.length === 0 ? 'file_not_indexed' : 'symbol_not_found', nearestIn(symbols, written), elsewhere);
  }
  return out;
}

/** Function-like definitions: functions, methods (constructors are methods). Types, fields and variables are not. */
const FUNCTION_LIKE = new Set(['function', 'method']);

/**
 * How many functions a whole-file claim makes conflicting (ADR 0204 §7.3). A file with none, a path that is not indexed or
 * not a repo-relative path answers 0; there is no refusal.
 */
export function countFunctions(host: AnchorResolveHost, paths: string[]): Array<{ path: string; functions: number }> {
  return paths.map((written) => {
    const path = written.replace(/^\.\//, '');
    const valid = path !== '' && !path.startsWith('/') && !path.split('/').includes('..');
    return { path: written, functions: valid ? host.getNodesInFile(path).filter((node) => FUNCTION_LIKE.has(node.kind)).length : 0 };
  });
}

export interface NamedDefinitions {
  name: string;
  /** Exact-name definitions across the project (at most {@link NAME_DEFINITION_LIMIT}); empty when none or too common. */
  definitions: Array<{ path: string; symbol: string; kind: string; startLine: number; endLine: number }>;
  /** More definitions than the limit: the name is too common to propose, the caller names the file itself. */
  tooCommon: boolean;
}

const NAME_DEFINITION_LIMIT = 5;

/** Seed fallback (2b): which graph symbols does a bare identifier name? Exact name only, never fuzzy. */
export function lookupNames(host: AnchorResolveHost, names: string[]): NamedDefinitions[] {
  return names.map((name) => {
    const found = host.getNodesByName(name).filter((node) => !NOT_A_SYMBOL.has(node.kind));
    const tooCommon = found.length > NAME_DEFINITION_LIMIT;
    return {
      name,
      tooCommon,
      definitions: tooCommon ? [] : found.map((node) => ({
        path: node.filePath, symbol: display(node), kind: node.kind, startLine: node.startLine, endLine: node.endLine,
      })),
    };
  });
}
