// Plan/lifecycle: the add-time conflict judgment (ADR 0204 §3). Pure: it compares one task's declared claims with every other
// unfinished task's, on resolved ranges the caller passes in. Resolve, sensor and git run outside (transactTodoRelations
// forbids them inside its lock); nothing here refuses anything.

import { digestTodoArtifact } from './todo-contracts.mjs';

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * A task's claims per path, from its witness row: `Map<path, [{symbol, access}]>`. A path declared with anchors is a
 * container: it claims only those functions. A path without anchors claims the whole file (`symbol: null`).
 */
export function claimsOf(row) {
  const claims = new Map();
  const add = (target, claim) => claims.set(target, [...(claims.get(target) ?? []), claim]);
  const anchored = (list) => new Map((list ?? []).map(({ within, symbols, new_symbols: fresh = [] }) => [within.target,
    symbols.map((symbol) => ({ symbol, fresh: fresh.includes(symbol) }))]));
  const concern = anchored(row.concern_anchors);
  const readAnchor = anchored(row.read_anchors);
  const written = new Set([...row.owns.filter(({ kind }) => kind === 'path').map(({ target }) => target), ...row.writes]);
  const nameless = [{ symbol: null, fresh: false }];
  for (const target of written) for (const { symbol, fresh } of concern.get(target) ?? nameless) add(target, { symbol, fresh, access: 'write' });
  for (const target of row.reads) for (const { symbol, fresh } of readAnchor.get(target) ?? nameless) add(target, { symbol, fresh, access: 'read' });
  return claims;
}

/** `[{path, symbol}]` of every anchored claim in `claims`, for one batched Resolve. */
export const anchorsOf = (claims) => [...claims].flatMap(([target, list]) => list
  .filter(({ symbol }) => symbol !== null).map(({ symbol }) => ({ path: target, symbol })));

const rangeKey = (target, symbol) => `${target}\0${symbol}`;

/** `Map<path\0symbol, {start_line, end_line}>` from Resolve's `resolved` list. */
export const rangeIndex = (resolved) => new Map(resolved.map(({ path: target, symbol, start_line: start, end_line: end }) => [
  rangeKey(target, symbol), { start_line: start, end_line: end }]));

/**
 * Judge `taskId` against every other task in `rows` (`{taskId: witnessRow}`, already limited to unfinished tasks).
 * `ranges` is a `rangeIndex`; an anchored claim with no range (the name no longer resolves) is read as a whole-file claim
 * and counted in `unresolved` (distinct names), except a name the task declared as new (`new_symbols`): it keeps its name with no lines
 * and overlaps only a whole-file claim and the same name (ADR 0204 §7). Overlap needs at least one write; two reads never conflict (ADR 0204, claim 4).
 * → `{relations: [{task_a, task_b, path, overlaps}], gone: [{task_a, task_b, path}], unresolved}`: `gone` names the pairs of
 * this task that no longer overlap on a path they once shared (the caller closes only those that are open).
 */
export function judgeTask({ taskId, rows, ranges, openRelations = [], only = null }) {
  const mine = claimsOf(rows[taskId]);
  const relations = [];
  const missing = new Set();
  // A name declared as new that has no range yet keeps its name and no lines (ADR 0204 §7); a name NOT declared as new that
  // no longer resolves (renamed on main) is read as a whole-file claim, never as "no conflict".
  const side = (target, claim) => {
    const range = claim.symbol === null ? undefined : ranges.get(rangeKey(target, claim.symbol));
    if (range === undefined && claim.symbol !== null && claim.fresh) return { symbol: claim.symbol, start_line: null, end_line: null, access: claim.access };
    if (claim.symbol !== null && range === undefined) missing.add(rangeKey(target, claim.symbol));
    return range === undefined
      ? { symbol: null, start_line: null, end_line: null, access: claim.access }
      : { symbol: claim.symbol, start_line: range.start_line, end_line: range.end_line, access: claim.access };
  };
  const unranged = (entry) => entry.symbol !== null && entry.start_line === null;
  const overlap = (left, right) => {
    if (left.symbol === null || right.symbol === null) return true;
    if (unranged(left) || unranged(right)) return unranged(left) && unranged(right) && left.symbol === right.symbol;
    return !(left.end_line < right.start_line || right.end_line < left.start_line);
  };
  for (const otherId of Object.keys(rows).sort(compareText)) {
    if (otherId === taskId) continue;
    const [taskA, taskB] = taskId < otherId ? [taskId, otherId] : [otherId, taskId];
    const theirs = claimsOf(rows[otherId]);
    for (const [target, claims] of [...mine].sort(([left], [right]) => compareText(left, right))) {
      const others = theirs.get(target);
      if (others === undefined) continue;
      const found = new Map();
      for (const claim of claims) {
        for (const other of others) {
          if (claim.access === 'read' && other.access === 'read') continue;
          // `only` narrows to one resource's meaning (a5b): 'ww' = both write, 'rw' = one writes and the other reads.
          if ((only === 'ww' && (claim.access !== 'write' || other.access !== 'write')) || (only === 'rw' && claim.access === other.access)) continue;
          const [first, second] = taskA === taskId ? [side(target, claim), side(target, other)] : [side(target, other), side(target, claim)];
          if (!overlap(first, second)) continue;
          found.set(JSON.stringify([first, second]), { a: first, b: second });
        }
      }
      if (found.size > 0) {
        relations.push({ task_a: taskA, task_b: taskB, path: target,
          overlaps: [...found.entries()].sort(([left], [right]) => compareText(left, right)).map(([, entry]) => entry) });
      }
    }
  }
  const keep = new Set(relations.map(({ task_a: a, task_b: b, path: target }) => `${a}\0${b}\0${target}`));
  const gone = openRelations
    .filter(({ task_a: a, task_b: b, path: target }) => (a === taskId || b === taskId) && !keep.has(`${a}\0${b}\0${target}`))
    .map(({ task_a: a, task_b: b, path: target }) => ({ task_a: a, task_b: b, path: target }));
  return { relations, gone, unresolved: missing.size };
}

/**
 * The other tasks' anchored claims on the paths `paths` (a Set) touches: what the same Resolve call must also answer so
 * `judgeTask` can compare ranges. Rows are witness rows (`manual_witness`); `taskId`'s own row is skipped.
 */
export function neededAnchors(rows, taskId, paths) {
  const found = new Map();
  for (const [otherId, row] of Object.entries(rows)) {
    if (otherId === taskId) continue;
    for (const anchor of anchorsOf(claimsOf(row))) if (paths.has(anchor.path)) found.set(`${anchor.path}\0${anchor.symbol}`, anchor);
  }
  return [...found.values()];
}

/**
 * ADR 0204 a5b: narrow the compile's shared path resources to the task pairs that really overlap. A resource on path P
 * (an owned path `own-…`, or a read x write `rw-…` state on P) is shared by `todo_ids`; when both tasks of a pair claim
 * P and at least one of them declared functions in it, the pair stays only if `judgeTask` finds an overlap (same function,
 * overlapping lines, a write on either side). A pair with no claim on exactly P, or with only whole-file claims, stays
 * as the compile made it. → a function for `compileRuntimePlanV1`'s `refineResources`.
 */
export function refineResourcesByFunction({ rows, ranges }) {
  const comparable = (target, first, second) => {
    const left = claimsOf(rows[first] ?? {owns: [], reads: [], writes: []}).get(target);
    const right = claimsOf(rows[second] ?? {owns: [], reads: [], writes: []}).get(target);
    return left !== undefined && right !== undefined && [...left, ...right].some(({ symbol }) => symbol !== null);
  };
  const overlaps = (target, first, second, only) => judgeTask({ taskId: first, rows: { [first]: rows[first], [second]: rows[second] }, ranges, only })
    .relations.some(({ path: where }) => where === target);
  // The path a shared resource stands for, or null when it is not one this can narrow: an owned path (`own-…`), a read x write
  // state on one path (`rw-…`), or a predicted write overlap of one path with itself (`predicted-ww-…`, target `P ↔ P`).
  const pathOf = (resource) => {
    if (resource.kind === 'path' && resource.resource_id.startsWith('own-')) return resource.target;
    if (resource.kind !== 'state') return null;
    if (resource.resource_id.startsWith('rw-')) return resource.target;
    const [left, right, ...rest] = resource.target.split(' ↔ ');
    return resource.resource_id.startsWith('predicted-ww-') && rest.length === 0 && left === right ? left : null;
  };
  return (resources) => resources.flatMap((resource) => {
    const target = pathOf(resource);
    if (target === null || resource.todo_ids.length < 2) return [resource];
    const pairs = [];
    for (let left = 0; left < resource.todo_ids.length; left += 1) {
      for (let right = left + 1; right < resource.todo_ids.length; right += 1) pairs.push([resource.todo_ids[left], resource.todo_ids[right]]);
    }
    const kept = pairs.filter(([first, second]) => !comparable(target, first, second) || overlaps(target, first, second, resource.resource_id.startsWith('rw-') ? 'rw' : 'ww'));
    if (kept.length === pairs.length) return [resource];
    return kept.map(([first, second]) => ({ ...resource,
      resource_id: `${resource.resource_id}-fn-${digestTodoArtifact({ first, second }).slice(0, 12)}`, todo_ids: [first, second] }));
  });
}

/** One relation as seen from `taskId`: `{with, path, overlaps: [{self, other}]}` (`self` is this task's side). */
export function relationView(taskId, { task_a: a, task_b: b, path: where, overlaps }) {
  return { with: a === taskId ? b : a, path: where,
    overlaps: overlaps.map(({ a: first, b: second }) => (a === taskId ? { self: first, other: second } : { self: second, other: first })) };
}
