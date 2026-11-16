// Plan/lifecycle: the add-time conflict judgment (ADR 0204 §3). Pure: it compares one task's declared claims with every other
// unfinished task's, on resolved ranges the caller passes in. Resolve, sensor and git run outside (transactTodoRelations
// forbids them inside its lock); nothing here refuses anything.

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * A task's claims per path, from its witness row: `Map<path, [{symbol, access}]>`. A path declared with anchors is a
 * container: it claims only those functions. A path without anchors claims the whole file (`symbol: null`).
 */
export function claimsOf(row) {
  const claims = new Map();
  const add = (target, claim) => claims.set(target, [...(claims.get(target) ?? []), claim]);
  const anchored = (list) => new Map((list ?? []).map(({ within, symbols }) => [within.target, symbols]));
  const concern = anchored(row.concern_anchors);
  const readAnchor = anchored(row.read_anchors);
  const written = new Set([...row.owns.filter(({ kind }) => kind === 'path').map(({ target }) => target), ...row.writes]);
  for (const target of written) for (const symbol of concern.get(target) ?? [null]) add(target, { symbol, access: 'write' });
  for (const target of row.reads) for (const symbol of readAnchor.get(target) ?? [null]) add(target, { symbol, access: 'read' });
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
 * and counted in `unresolved` (distinct names). Overlap needs at least one write; two reads never conflict (ADR 0204, claim 4).
 * → `{relations: [{task_a, task_b, path, overlaps}], gone: [{task_a, task_b, path}], unresolved}`: `gone` names the pairs of
 * this task that no longer overlap on a path they once shared (the caller closes only those that are open).
 */
export function judgeTask({ taskId, rows, ranges, openRelations = [] }) {
  const mine = claimsOf(rows[taskId]);
  const relations = [];
  const missing = new Set();
  const side = (target, claim) => {
    const range = claim.symbol === null ? undefined : ranges.get(rangeKey(target, claim.symbol));
    if (claim.symbol !== null && range === undefined) missing.add(rangeKey(target, claim.symbol));
    return range === undefined
      ? { symbol: null, start_line: null, end_line: null, access: claim.access }
      : { symbol: claim.symbol, start_line: range.start_line, end_line: range.end_line, access: claim.access };
  };
  const overlap = (left, right) => left.symbol === null || right.symbol === null
    || !(left.end_line < right.start_line || right.end_line < left.start_line);
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

/** One relation as seen from `taskId`: `{with, path, overlaps: [{self, other}]}` (`self` is this task's side). */
export function relationView(taskId, { task_a: a, task_b: b, path: where, overlaps }) {
  return { with: a === taskId ? b : a, path: where,
    overlaps: overlaps.map(({ a: first, b: second }) => (a === taskId ? { self: first, other: second } : { self: second, other: first })) };
}
