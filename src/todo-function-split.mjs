// ADR 0205 §3-§6 (b5): `todo function-split verify|decline`, the not-split reorganization, and the gate and rewrite of `todo done S`.
// todo-cli passes the pieces that live in it (`deps.declareRow`, `deps.retire`); nothing here touches the sensor or git except
// through Neve's `verifyFunctionSplit`.

import { resolveTodoActor } from './todo-authoring-input.mjs';
import { verifyFunctionSplit } from './function-split-verify.mjs';
import { measureWaveCount } from './seam-verification.mjs';
import { parseAnchor } from './sensor-resolve.mjs';
import { appendTodoNote } from './todo-note-store.mjs';
import { anchorsOf, claimsOf, judgeTask, rangeIndex } from './todo-judgment.mjs';
import { readTodoSplit, recordTodoSplit } from './todo-split-store.mjs';
import {
  createTodoStoreWriter, readTodoStore, readTodoWitnessSet, TodoStoreError,
} from './todo-store.mjs';

const FINISHED = new Set(['done', 'retired']);
const CONDITIONS = ['behaviour', 'tests', 'fresh', 'overlap', 'parallel'];
const refuse = (reason, detail) => new TodoStoreError('TODO_TRANSITION_REFUSED', reason, undefined, detail);
// A record detail is bounded (2 KiB) by the Store contract; a longer cause is cut here, the full one is in the verify result.
const clip = (text) => (Buffer.byteLength(text, 'utf8') <= 2_000 ? text : `${Buffer.from(text, 'utf8').subarray(0, 1_990).toString('utf8')}...`);

/** `--map U=src/a.js#f,T=src/b.js#g` → `[{task_id, path, symbol}]` sorted by task id; members only, one entry each. */
export function parseSplitMap(text, members) {
  const entries = [];
  for (const item of String(text).split(',').map((part) => part.trim()).filter(Boolean)) {
    const at = item.indexOf('=');
    const anchor = at < 0 ? null : parseAnchor(item.slice(at + 1));
    const taskId = at < 0 ? '' : item.slice(0, at);
    if (anchor === null || !members.includes(taskId) || entries.some((entry) => entry.task_id === taskId)) {
      throw new TodoStoreError('INPUT_INVALID', 'function_split_map_invalid', undefined, {
        pointer: '--map', entry: item, members,
        next_action: `--map takes one <task>=<path>#<function> per member of the split (${members.join(', ')}), comma separated.`,
      });
    }
    entries.push({ task_id: taskId, path: anchor.path, symbol: anchor.symbol });
  }
  if (entries.length === 0) {
    throw new TodoStoreError('INPUT_INVALID', 'function_split_map_invalid', undefined, { pointer: '--map', members,
      next_action: '--map needs at least one entry; to make no cut run `lattice todo function-split decline`.' });
  }
  return entries.sort((left, right) => (left.task_id < right.task_id ? -1 : 1));
}

/** The split task S, its mark and the plan it lives in; refuses when it is not an unfinished split task. */
function splitTask(store, planKey, taskId) {
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  const task = member?.plan.tasks.find(({ task_id: id }) => id === taskId);
  const status = member?.tasks.find(({ task_id: id }) => id === taskId)?.status;
  if (task === undefined) throw new TodoStoreError('TASK_NOT_FOUND', 'task_not_found', undefined, { requested_task_id: taskId });
  if (!task.function_split) {
    throw refuse('not_a_split_task', { plan_key: planKey, task_id: taskId, next_action: `${planKey}/${taskId} is not a function-split task (\`lattice todo status --json\` shows them).` });
  }
  return { member, task, mark: task.function_split, status };
}

/** `row` with its write anchor on `from` replaced by `to`; null when it has none (already moved, or never on it). */
export function moveAnchor(row, from, to) {
  const group = row.concern_anchors?.find(({ within }) => within.target === from.path);
  if (group === undefined || !group.symbols.includes(from.symbol)) return null;
  const groups = (row.concern_anchors ?? []).map((entry) => (entry === group
    ? { ...entry, symbols: entry.symbols.filter((symbol) => symbol !== from.symbol) } : entry));
  const target = groups.find(({ within }) => within.target === to.path);
  const moved = target === undefined
    ? [...groups, { within: { kind: 'path', target: to.path }, symbols: [to.symbol] }]
    : groups.map((entry) => (entry === target ? { ...entry, symbols: [...new Set([...entry.symbols, to.symbol])].sort() } : entry));
  const concern = moved.filter(({ symbols }) => symbols.length > 0);
  const kept = new Set(concern.map(({ within }) => within.target));
  return { ...row,
    concern_anchors: concern,
    // a file left with no anchor must not become a whole-file claim
    owns: [...row.owns.filter(({ target: where }) => where !== from.path || kept.has(where)),
      ...(row.owns.some(({ target: where }) => where === to.path) ? [] : [{ kind: 'path', target: to.path }])] };
}

/** The `--owns/--reads/--writes` flags that declare `row` again (`declareTaskRow` takes flags). */
// shortcut: `creates` and `unknowns` of the old row are not expressible as flags and are dropped; add them if a split task ever needs them.
export function flagsOf(row) {
  const tokens = (paths, anchors) => paths.flatMap((target) => {
    const symbols = anchors?.find(({ within }) => within.target === target)?.symbols ?? [];
    return symbols.length > 0 ? symbols.map((symbol) => `${target}#${symbol}`) : [target];
  });
  const owned = new Set(row.owns.map(({ target }) => target));
  return { owns: tokens(row.owns.map(({ target }) => target), row.concern_anchors), reads: tokens(row.reads, row.read_anchors),
    writes: row.writes.filter((target) => !owned.has(target)) };
}

/** Overlap and parallel (ADR 0205 §4) over the mapped members, from Neve's ranges at the commit. */
function judgeMapped({ rows, lanes, ranges }) {
  const ids = Object.keys(rows).sort();
  const index = rangeIndex([...ranges.reduce((merged, row) => {
    const key = `${row.path}\0${row.symbol}`;
    const known = merged.get(key);
    merged.set(key, known === undefined ? { ...row } : { ...known, start_line: Math.min(known.start_line, row.start_line), end_line: Math.max(known.end_line, row.end_line) });
    return merged;
  }, new Map()).values()]);
  const pairs = ids.flatMap((left, at) => ids.slice(at + 1).map((right) => [left, right])).filter(([left, right]) => lanes.get(left) !== lanes.get(right));
  const still = (only) => pairs.filter(([left, right]) => judgeTask({ taskId: left, rows: { [left]: rows[left], [right]: rows[right] }, ranges: index, only })
    .relations.some(({ task_a: a, task_b: b }) => (a === left && b === right) || (a === right && b === left)));
  const writing = still('ww');
  const anyConflict = still(null);
  // one executor per member: the waves then count only what the conflicts force (a single executor serializes everything)
  const before = measureWaveCount({ taskIds: ids, conflictPairs: pairs, executors: ids.length });
  const after = measureWaveCount({ taskIds: ids, conflictPairs: anyConflict, executors: ids.length });
  return {
    overlap: { passed: writing.length === 0, detail: writing.length === 0 ? 'ok' : clip(`still write the same lines: ${writing.map((pair) => pair.join('/')).join(', ')}`) },
    parallel: before.waves !== null && after.waves !== null && after.waves < before.waves
      ? { passed: true, detail: `waves ${before.waves} -> ${after.waves}` }
      : { passed: false, detail: clip(`waves ${before.waves ?? before.reason} -> ${after.waves ?? after.reason}: not lower`) },
  };
}

/**
 * `todo function-split verify` (ADR 0205 §3-§4): Neve's checks on the worker's commit, then overlap and parallel, recorded on S.
 * Input errors refuse and reorganize nothing. A rejected outcome is written first and then reorganized as not split.
 */
export async function verifySplit({ repoRoot, env, planKey, taskId, commit, base, mapText, deps }) {
  const { member, mark, status } = splitTask(await readTodoStore({ repoRoot }), planKey, taskId);
  if (FINISHED.has(status)) throw refuse('split_task_finished', { plan_key: planKey, task_id: taskId, status });
  const map = parseSplitMap(mapText, mark.members);
  const witness = await readTodoWitnessSet({ repoRoot, planKey }).catch(() => null);
  const rowOf = (id) => witness?.plan_key === planKey ? witness.manual_witness[id] : undefined;
  const anchors = map.flatMap(({ task_id: id }) => (rowOf(id) === undefined ? [] : anchorsOf(claimsOf(rowOf(id))).map((anchor) => ({ task_id: id, ...anchor }))));
  const target = { path: mark.path, symbol: mark.symbol };
  const answer = await verifyFunctionSplit({ repoRoot, commit, ...(base === undefined ? {} : { base }), target, map, anchors });
  if (answer.error !== undefined) {
    throw new TodoStoreError('INPUT_INVALID', `function_split_${answer.error.code}`, undefined, { ...answer.error, pointer: '--commit' });
  }
  const rows = {};
  for (const entry of map) {
    const row = rowOf(entry.task_id);
    if (row !== undefined) rows[entry.task_id] = moveAnchor(row, target, entry) ?? row;
  }
  const lanes = new Map(member.plan.tasks.map(({ task_id: id, lane }) => [id, lane]));
  const judged = judgeMapped({ rows, lanes, ranges: answer.ranges });
  const conditions = {
    behaviour: { passed: answer.behaviour.passed, detail: clip(answer.behaviour.detail) },
    tests: { passed: answer.tests.passed, detail: clip(answer.tests.detail) },
    fresh: { passed: answer.fresh.passed, detail: answer.fresh.passed ? 'ok' : clip(answer.fresh.detail ?? JSON.stringify(answer.fresh.unresolved)) },
    ...judged,
  };
  const outcome = CONDITIONS.every((name) => conditions[name].passed) ? 'accepted' : 'rejected';
  await recordTodoSplit({ repoRoot, planKey, taskId, writer: createTodoStoreWriter({ caller: 'todo-splits' }), record: {
    map, commit: answer.commit, base: answer.base, outcome, conditions, recorded_at: new Date().toISOString(), actor: resolveTodoActor(env) } });
  const failed = CONDITIONS.filter((name) => !conditions[name].passed);
  const result = { schema: 'lattice.todo_function_split_verify_result.v1', project_id: member.plan.project_id, plan_key: planKey,
    task_id: taskId, outcome, commit: answer.commit, base: answer.base, conditions, tests_ran: answer.tests.ran, target: answer.target };
  if (outcome === 'accepted') {
    return { ...result, next_action: `open the PR with \`[skip ci]\` in the commit message, merge it, then \`lattice todo done --plan ${planKey} --task ${taskId} --message <what you merged>\`.` };
  }
  const reason = `verify rejected (${failed.join(', ')}): ${failed.map((name) => `${name}: ${conditions[name].detail}`).join(' | ')}`;
  return { ...result, reorganized: await reorganizeNotSplit({ repoRoot, env, planKey, taskId, reason: clip(reason), deps }),
    next_action: 'the split is withdrawn; the later tasks now wait for the one that started first.' };
}

/** Does `from` already reach `to` through the plan's hard dependencies? */
const reaches = (plan, from, to) => {
  const seen = new Set();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of plan.hard_dependencies) if (edge.from.task_id === current) stack.push(edge.to.task_id);
  }
  return false;
};

/**
 * Not split (D6, D7): the member in progress that started first becomes the predecessor of the unfinished members that have
 * not started, each member gets a note with the reason, then S is retired. The edges go first, so a crash leaves S open and
 * the same command finishes the job; with no member in progress there is no edge and the next start detects again.
 */
export async function reorganizeNotSplit({ repoRoot, env, planKey, taskId, reason, deps }) {
  const store = await readTodoStore({ repoRoot });
  const { member, mark, status } = splitTask(store, planKey, taskId);
  if (status === 'retired') return deps.retire({ repoRoot, env, planKey, taskId, reason });
  if (status === 'done') throw refuse('split_task_finished', { plan_key: planKey, task_id: taskId, status });
  const state = new Map(member.tasks.map((task) => [task.task_id, task]));
  const open = mark.members.filter((id) => state.has(id) && !FINISHED.has(state.get(id).status));
  const lead = open.filter((id) => state.get(id).status === 'in-progress')
    .sort((left, right) => (state.get(left).started_at < state.get(right).started_at ? -1 : 1))[0];
  const edges = lead === undefined ? [] : open.filter((id) => state.get(id).status !== 'in-progress' && !reaches(member.plan, lead, id))
    .map((id) => ({ from: lead, to: id }));
  let planVersion = member.plan.plan_version;
  if (edges.length > 0) {
    const { applyPlanRevision, desiredFromPlan } = await import('./plan-revise.mjs');
    const desired = desiredFromPlan(member.plan, { env });
    const ref = (id) => ({ project_id: member.plan.project_id, plan_key: planKey, task_id: id });
    desired.hard_dependencies = [...desired.hard_dependencies, ...edges.map(({ from, to }) => ({ from: ref(from), to: ref(to) }))];
    planVersion = (await applyPlanRevision({ repoRoot, env, input: { schema: 'lattice.plan_revise_input.v1', desired } })).plan_version;
  }
  const actor = resolveTodoActor(env);
  for (const id of open) {
    await appendTodoNote({ repoRoot, projectId: member.plan.project_id, planKey, planVersion, taskId: id, actor,
      recordedAt: new Date().toISOString(), supersedes: null, eligibleSupersedes: [],
      body: `function split ${taskId} on ${mark.path}#${mark.symbol} was not made: ${reason}${lead !== undefined && id !== lead && state.get(id).status !== 'in-progress' ? `; ${id} now waits for ${lead}` : ''}` });
  }
  const retired = await deps.retire({ repoRoot, env, planKey, taskId, reason });
  return { schema: 'lattice.todo_function_split_decline_result.v1', project_id: member.plan.project_id, plan_key: planKey,
    task_id: taskId, outcome: 'declined', reason, predecessor_edges: edges, retired: { kind: retired.kind, status: retired.status } };
}

/**
 * The gate and the rewrite of `todo done S` (ADR 0205 §5): needs an accepted record, then each unfinished mapped member's
 * write anchor on F becomes its mapped function through the ADR 0204 declaration path (resolved at the repository's HEAD, so
 * relations are judged again and close where the overlap is gone; a function not on HEAD yet is kept as a new name, ADR 0204 §7). A row without the anchor is skipped: the rewrite is idempotent.
 */
export async function splitDoneGate({ repoRoot, planKey, taskId, deps }) {
  // shortcut: one more Store read on every `todo done` to learn whether the task is a split task; read the mark from the done's own read if that cost shows.
  const member = (await readTodoStore({ repoRoot })).members.find(({ descriptor }) => descriptor.plan_key === planKey);
  const mark = member?.plan.tasks.find(({ task_id: id }) => id === taskId)?.function_split;
  if (!mark) return;
  const record = await readTodoSplit({ repoRoot, planKey, taskId });
  if (record === null || record.outcome !== 'accepted') {
    throw refuse('split_not_accepted', { plan_key: planKey, task_id: taskId, outcome: record?.outcome ?? null,
      next_action: `\`lattice todo function-split verify --plan ${planKey} --task ${taskId} --commit <sha> --map <task>=<path#function>,...\`, or \`lattice todo function-split decline --plan ${planKey} --task ${taskId} --reason <text>\`.` });
  }
  const witness = await readTodoWitnessSet({ repoRoot, planKey }).catch(() => null);
  const status = new Map(member.tasks.map((task) => [task.task_id, task.status]));
  const target = { path: mark.path, symbol: mark.symbol };
  const unresolved = [];
  for (const entry of record.map) {
    const row = witness?.plan_key === planKey ? witness.manual_witness[entry.task_id] : undefined;
    const moved = row === undefined || FINISHED.has(status.get(entry.task_id)) ? null : moveAnchor(row, target, entry);
    if (moved === null) continue;
    const written = await deps.declareRow({ taskId: entry.task_id, flags: flagsOf(moved) });
    if (written.scaffolded === null) unresolved.push({ task_id: entry.task_id, path: entry.path, symbol: entry.symbol, ...written.declaration });
  }
  if (unresolved.length > 0) {
    throw refuse('split_map_unresolved', { plan_key: planKey, task_id: taskId, unresolved,
      next_action: `A mapped function cannot be stored as a declaration (see unresolved): run \`lattice todo function-split decline --plan ${planKey} --task ${taskId} --reason <text>\`.` });
  }
}
