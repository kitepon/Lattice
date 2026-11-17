// ADR 0205 §1 and §3 (b4): when a task starts and writes a function another lane's in-progress task writes, plan the split task.
// Pure: reads the plan and the starting task's open relations, returns what the revision must add; todo-cli applies it.

import { createHash } from 'node:crypto';

import { relationView } from './todo-judgment.mjs';
import { TODO_SPLIT_MAX_MEMBERS } from './todo-contracts.mjs';

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const FINISHED = new Set(['done', 'retired']);
const rangesOverlap = (left, right) => !(left.end_line < right.start_line || right.end_line < left.start_line);

/** What a split worker must do, from the split task's current mark. The one text members get (no member rule exists for B). */
export function splitGuide({ planKey, taskId, mark }) {
  const target = `${mark.path}#${mark.symbol}`;
  const base = `lattice todo function-split`;
  return [
    `Tasks ${mark.members.join(', ')} all change ${target}. You decide whether to split it so each can change its own function.`,
    'Before you cut: verify needs at least one node-runnable test that statically imports a file the cut changes (otherwise tests fails with no_test_reaches_function): check one exists, and add one in the cut commit if none does.'
      + ' A cut whose changed code is not JS/TS fails behaviour (export_surface_unobserved): then decline without cutting.',
    `Split: write the cut on a branch from main (each member gets its own function), push the branch, then run`
      + ` \`${base} verify --plan ${planKey} --task ${taskId} --commit <sha> --map ${mark.members.map((id) => `${id}=<path#function>`).join(',')}\``
      + ' (map the members whose function changed; an unmapped member keeps its declaration).'
      + ' Once verify accepts, open the PR with `[skip ci]` in the commit message (verify already ran the checks for the cut), merge it,'
      + ` then run \`lattice todo done --plan ${planKey} --task ${taskId} --message <what you merged>\`.`,
    `Not split: run \`${base} decline --plan ${planKey} --task ${taskId} --reason <text>\`; the later tasks then wait for the one that started first,`
      + ' unless you moved your change out of the function and declared again first: with no write overlap left there is no wait.',
  ].join('\n');
}

/**
 * The split task and edges one `todo start T` needs, or null (start as today).
 * `read` = `readTodoTaskRelations` of T (open relations only). `member` = the Store member (plan + task states).
 * → `{splits: [{task_id, path, symbol, joined, members}], tasks: [new task], edges: [{from, to}], marks: Map, notes: [{task_id, body}]}`
 */
export function planSplitHold({ member, taskId, read }) {
  const { plan } = member;
  const planKey = plan.plan_key;
  const byId = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const state = new Map(member.tasks.map(({ task_id: id, status }) => [id, status]));
  const self = byId.get(taskId);
  if (read === null) return null;
  // F = U's side of a write x write overlap with an in-progress task of another lane; a whole-file claim has no function to cut.
  const functions = new Map();
  for (const relation of read.open) {
    const { with: otherId, path: where, overlaps } = relationView(taskId, relation);
    const other = byId.get(otherId);
    if (state.get(otherId) !== 'in-progress' || other.lane === self.lane) continue;
    for (const { self: mine, other: theirs } of overlaps) {
      if (mine.access !== 'write' || theirs.access !== 'write' || mine.symbol === null || theirs.symbol === null) continue;
      const key = `${where}\0${theirs.symbol}`;
      const entry = functions.get(key) ?? { path: where, symbol: theirs.symbol, start_line: theirs.start_line, end_line: theirs.end_line, owners: new Set() };
      entry.owners.add(otherId);
      functions.set(key, entry);
    }
  }
  const edges = [];
  const marks = new Map();
  const tasks = [];
  const splits = [];
  const notes = [];
  const edgeKey = (from, to) => `${from}\0${to}`;
  const have = new Set(plan.hard_dependencies.map(({ from, to }) => edgeKey(from.task_id, to.task_id)));
  const edge = (from, to) => { if (!have.has(edgeKey(from, to))) { have.add(edgeKey(from, to)); edges.push({ from, to }); } };
  const open = plan.tasks.filter(({ task_id: id, function_split: mark }) => mark && !FINISHED.has(state.get(id)));
  for (const found of [...functions.values()].sort((left, right) => compare(`${left.path}\0${left.symbol}`, `${right.path}\0${right.symbol}`))) {
    const owners = [...found.owners].sort(compare);
    // Two lanes already in progress on one function (started before B, or with --override-reason) is a runtime conflict (stage C).
    if (new Set(owners.map((id) => byId.get(id).lane)).size > 1) continue;
    const existing = open.find(({ function_split: mark }) => mark.path === found.path && mark.symbol === found.symbol)
      ?? open.find(({ function_split: mark }) => mark.path === found.path && rangesOverlap(mark, found));
    if (existing !== undefined) {
      const mark = marks.get(existing.task_id) ?? existing.function_split;
      if (!mark.members.includes(taskId)) {
        if (mark.members.length >= TODO_SPLIT_MAX_MEMBERS) continue;
        marks.set(existing.task_id, { ...mark, members: [...mark.members, taskId].sort(compare) });
        notes.push({ task_id: existing.task_id, body: `split ${existing.task_id}: ${taskId} started on ${found.path}#${found.symbol} and joins the split` });
      }
      edge(existing.task_id, taskId);
      splits.push({ task_id: existing.task_id, path: mark.path, symbol: mark.symbol, joined: true, members: marks.get(existing.task_id)?.members ?? mark.members });
      continue;
    }
    const digest = createHash('sha256').update(`${planKey}\0${found.path}\0${found.symbol}`).digest('hex').slice(0, 12);
    let id = `split-${digest}`;
    for (let n = 2; byId.has(id); n += 1) id = `split-${digest}-${n}`;
    const mark = { path: found.path, symbol: found.symbol, start_line: found.start_line, end_line: found.end_line,
      members: [...owners, taskId].sort(compare) };
    const lead = byId.get(owners[0]);
    tasks.push({ task_id: id, title: `Split ${found.path}#${found.symbol}`, lane: lead.lane, phase_id: lead.phase_id,
      design_memo: `Added by Lattice (ADR 0205): ${owners.join(', ')} (lane ${lead.lane}) is in progress and ${taskId} (lane ${self.lane}) is starting,`
        + ` both writing ${found.path}#${found.symbol}. ${taskId} waits for this task.\n\n${splitGuide({ planKey, taskId: id, mark })}` });
    for (const owner of owners) edge(id, owner);
    edge(id, taskId);
    marks.set(id, mark);
    splits.push({ task_id: id, path: mark.path, symbol: mark.symbol, joined: false, members: mark.members });
    // a later function of this start may overlap the split just made: it is open now.
    open.push({ task_id: id, function_split: mark });
    byId.set(id, tasks.at(-1));
  }
  return splits.length === 0 ? null : { splits, tasks, edges, marks, notes };
}
