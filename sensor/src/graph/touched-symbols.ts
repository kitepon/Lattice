/**
 * Touched — diff hunks → the symbols they changed (ADR 0204 Touched, a6). Deterministic, no AI.
 *
 * The caller hands the hunks of a commit range (`git diff -U0`) and the index of the range END; each hunk's new-side lines are
 * mapped to the innermost indexed symbols they overlap. What no symbol can carry is never dropped: it comes back in
 * `unattributed` with a reason, so "no symbol" is read as "file-level", never as "touched nothing".
 */

import type { Node } from '../types';

const NOT_A_SYMBOL = new Set(['file', 'import', 'export', 'parameter']);

export interface HunkInput { old_start: number; old_count: number; new_start: number; new_count: number }
export interface FileChangeInput {
  path: string;
  old_path: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  hunks: HunkInput[];
}

export interface TouchedSymbol {
  path: string;
  symbol: string;
  kind: string;
  start_line: number;
  end_line: number;
}

export interface UnattributedChange {
  path: string;
  reason:
    | 'file_not_indexed' | 'file_deleted' | 'binary' | 'renamed'
    | 'outside_any_symbol' | 'partly_outside_any_symbol' | 'deleted_outside_any_symbol';
  old_range: [number, number] | null;
  new_range: [number, number] | null;
}

export interface TouchedResult { touched: TouchedSymbol[]; unattributed: UnattributedChange[] }

export interface TouchedHost { getNodesInFile(filePath: string): Node[] }

const chainOf = (node: Node): string[] => (node.qualifiedName || node.name).split(/::|\./).filter((p) => p.length > 0);
const display = (node: Node): string => chainOf(node).join('.');

/** `a` holds `b`: range containment, and on equal ranges (a one-line class and its method) the longer chain is the inner one. */
function holds(a: Node, b: Node): boolean {
  if (a === b || b.startLine < a.startLine || b.endLine > a.endLine) return false;
  if (b.startLine > a.startLine || b.endLine < a.endLine) return true;
  const ca = chainOf(a);
  const cb = chainOf(b);
  return cb.length > ca.length && ca.every((part, i) => part === cb[i]);
}

function innermost(nodes: Node[]): Node[] {
  return nodes.filter((node) => !nodes.some((other) => holds(node, other)));
}

const rangeOf = (start: number, count: number): [number, number] | null => (count > 0 ? [start, start + count - 1] : null);

export function touchedSymbols(host: TouchedHost, files: FileChangeInput[]): TouchedResult {
  const touched = new Map<string, TouchedSymbol>();
  const unattributed: UnattributedChange[] = [];
  const note = (path: string, reason: UnattributedChange['reason'], old_range: [number, number] | null, new_range: [number, number] | null) =>
    unattributed.push({ path, reason, old_range, new_range });

  for (const file of files) {
    if (file.status === 'binary') { note(file.path, 'binary', null, null); continue; }
    if (file.status === 'deleted') { note(file.path, 'file_deleted', null, null); continue; }
    if (file.status === 'renamed' && file.hunks.length === 0) { note(file.path, 'renamed', null, null); continue; }

    const all = host.getNodesInFile(file.path);
    const nodes = all.filter((node) => !NOT_A_SYMBOL.has(node.kind));
    for (const hunk of file.hunks) {
      const oldRange = rangeOf(hunk.old_start, hunk.old_count);
      const newRange = rangeOf(hunk.new_start, hunk.new_count);
      if (all.length === 0) { note(file.path, 'file_not_indexed', oldRange, newRange); continue; }

      // A pure deletion sits between new lines `new_start` and `new_start + 1`; it is inside a symbol only when both belong to it.
      const [first, last] = newRange ?? [hunk.new_start, hunk.new_start + 1];
      const overlapping = nodes.filter((node) => (newRange === null
        ? node.startLine <= first && node.endLine >= last
        : node.startLine <= last && node.endLine >= first));
      if (overlapping.length === 0) {
        note(file.path, newRange === null ? 'deleted_outside_any_symbol' : 'outside_any_symbol', oldRange, newRange);
        continue;
      }
      for (const node of innermost(overlapping)) {
        touched.set(`${file.path}\0${display(node)}\0${node.startLine}\0${node.endLine}`, {
          path: file.path, symbol: display(node), kind: node.kind, start_line: node.startLine, end_line: node.endLine,
        });
      }
      // Lines of an added or changed block that no symbol holds (imports, top-level code next to a function): disclosed, not lost.
      if (newRange !== null && file.status !== 'added') {
        let line = first;
        while (line <= last && overlapping.some((node) => node.startLine <= line && node.endLine >= line)) line++;
        if (line <= last) note(file.path, 'partly_outside_any_symbol', oldRange, newRange);
      }
    }
  }
  return { touched: [...touched.values()], unattributed };
}
