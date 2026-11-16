// ADR 0204 a4: per-plan function-level conflict relations. docs/architecture/dfd-store-relations.md
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { LOCK_WAIT_MS, StoreLockError, withStoreLock } from './store-lock.mjs';
import {
  TODO_RELATION_EVENT_SCHEMA, TODO_RELATION_SUMMARY_OPEN, TODO_RELATION_SUMMARY_SCHEMA,
  canonicalizeTodoArtifact, exactRecord, isStrictTodoTimestamp, isTodoIdentifier, todoRelationId,
  todoRelationOverlapsValid, validateTodoRelationEvent, validateTodoRelationSummary,
} from './todo-contracts.mjs';
import {
  TodoStoreError, atomicWrite, readTodoStore, readTodoWitnessSet, rejectNewerTodoSchema, requireTodoStoreWriter,
  writeTodoWitnessSet,
} from './todo-store.mjs';

const ROOT_REF = '.lattice/todo/relations';
const TASK_FILE_MAX_BYTES = 4_194_304;
const LOG_SEGMENT_BYTES = 4_194_304;
const SUMMARY_MAX_BYTES = 65_536;
const FINISHED = new Set(['done', 'retired']);

const fail = (code, reason, detail) => { throw new TodoStoreError(code, reason, reason, detail); };
const line = (value) => Buffer.from(`${canonicalizeTodoArtifact(value)}\n`, 'utf8');
const keyOf = ({ task_a: a, task_b: b, path: p }) => `${a}\0${b}\0${p}`;
const refs = (planKey) => ({ dir: `${ROOT_REF}/${planKey}`, open: `${ROOT_REF}/${planKey}/open`,
  log: `${ROOT_REF}/${planKey}/log.jsonl`, summary: `${ROOT_REF}/${planKey}/summary.json`,
  task: (taskId) => `${ROOT_REF}/${planKey}/open/${taskId}.json` });

function planKeyOf(planKey) {
  if (!isTodoIdentifier(planKey)) throw new TypeError('planKey must be a todo identifier');
  return planKey;
}

/** A file under the relation directory: missing = null; a symlink, non-file or oversize file is invalid. */
async function readBounded(repoRoot, ref, maxBytes) {
  const absolute = path.resolve(repoRoot, ref);
  try {
    const state = await lstat(absolute);
    if (state.isSymbolicLink() || !state.isFile() || state.size > maxBytes) {
      fail('STORE_INCONSISTENT', 'relation_file_invalid', { ref });
    }
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function parseLines(text, ref, validate, family) {
  if (text === null || text === '') return [];
  if (!text.endsWith('\n')) fail('STORE_INCONSISTENT', 'relation_log_invalid', { ref });
  return text.slice(0, -1).split('\n').map((entry) => {
    let value;
    try { value = JSON.parse(entry); } catch { fail('STORE_INCONSISTENT', 'relation_log_invalid', { ref }); }
    if (!validate(value)) {
      rejectNewerTodoSchema(value, family, ref);
      fail('STORE_INCONSISTENT', 'relation_log_invalid', { ref });
    }
    return value;
  });
}

/** The open relations of one task: its file, one `relation` event per line (missing file = none). */
async function readTaskFile(repoRoot, planKey, taskId) {
  const ref = refs(planKey).task(taskId);
  const about = (event) => validateTodoRelationEvent(event) && event.kind === 'relation'
    && (event.task_a === taskId || event.task_b === taskId);
  return parseLines(await readBounded(repoRoot, ref, TASK_FILE_MAX_BYTES), ref, about, 'todo_relation_event');
}

/**
 * The plan's relation summary, or null when it has none (a missing file is "no records", not an error).
 * Reads exactly this one small file and never verifies it (ADR 0203).
 */
export async function readTodoRelationSummary({ repoRoot = process.cwd(), planKey } = {}) {
  const ref = refs(planKeyOf(planKey)).summary;
  const text = await readBounded(path.resolve(repoRoot), ref, SUMMARY_MAX_BYTES);
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); } catch { fail('STORE_INCONSISTENT', 'relation_summary_invalid', { ref }); }
  rejectNewerTodoSchema(value, 'todo_relation_summary', ref);
  if (!validateTodoRelationSummary(value) || value.plan_key !== planKey) {
    fail('STORE_INCONSISTENT', 'relation_summary_invalid', { ref });
  }
  return value;
}

/**
 * a4c: one task's open relations and the plan's counts, from two small bounded files (the summary and `open/<task>.json`);
 * never the history. → null when the plan has no open relation, else
 * `{relation_count, unresolved_count, head_sha, open: [{task_a, task_b, path, overlaps}]}` (this task's, by pair and path).
 * Unreadable or damaged: STORE_INCONSISTENT, as the summary read.
 */
export async function readTodoTaskRelations({ repoRoot = process.cwd(), planKey, taskId } = {}) {
  if (!isTodoIdentifier(taskId)) throw new TypeError('taskId must be a todo identifier');
  const root = path.resolve(repoRoot);
  const summary = await readTodoRelationSummary({ repoRoot: root, planKey });
  if (summary === null || summary.relation_count === 0) return null;
  const open = (await readTaskFile(root, planKey, taskId)).map(({ task_a: a, task_b: b, path: where, overlaps }) => ({
    task_a: a, task_b: b, path: where, overlaps })).sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : 1));
  return { relation_count: summary.relation_count, unresolved_count: summary.unresolved_count, head_sha: summary.head_sha, open };
}

/** Every task file of the plan: `Map<taskId, Map<key, event>>` (the open set; names that are not task ids are ignored). */
async function readOpenFiles(repoRoot, planKey) {
  const names = await readdir(path.resolve(repoRoot, refs(planKey).open)).catch((error) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  });
  const files = new Map();
  for (const name of names) {
    const taskId = name.endsWith('.json') ? name.slice(0, -5) : null;
    if (!isTodoIdentifier(taskId)) continue;
    files.set(taskId, new Map((await readTaskFile(repoRoot, planKey, taskId)).map((event) => [keyOf(event), event])));
  }
  return files;
}

async function ensureRelationDirectory(repoRoot, planKey) {
  const stale = () => fail('STORE_WRITE_CONFLICT', 'store_locked', {
    next_action: 'Initialize a published Todo Store before writing relations, then retry.',
  });
  for (const ref of ['.lattice', '.lattice/todo', '.lattice/todo/manifest.json']) {
    const state = await lstat(path.resolve(repoRoot, ref)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
      return null;
    });
    if (state === null || state.isSymbolicLink() || (ref.endsWith('.json') ? !state.isFile() : !state.isDirectory())) stale();
  }
  for (const ref of [ROOT_REF, refs(planKey).dir, refs(planKey).open]) {
    const absolute = path.resolve(repoRoot, ref);
    await mkdir(absolute).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
    const state = await lstat(absolute);
    if (state.isSymbolicLink() || !state.isDirectory()) fail('STORE_INCONSISTENT', 'relation_file_invalid', { ref });
  }
}

const sameOverlaps = (left, right) => canonicalizeTodoArtifact(left) === canonicalizeTodoArtifact(right);

function checkInput(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).some((key) => !['witnessSet', 'relations', 'gone', 'headSha', 'unresolvedCount', 'computedAt']
      .includes(key))) throw new TypeError('relation update result invalid');
  const relations = result.relations ?? [];
  const gone = result.gone ?? [];
  const pair = (value, keys) => exactRecord(value, keys) && isTodoIdentifier(value.task_a)
    && isTodoIdentifier(value.task_b) && value.task_a < value.task_b
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 1024;
  if (!Array.isArray(relations) || !Array.isArray(gone)
    || !relations.every((entry) => pair(entry, ['task_a', 'task_b', 'path', 'overlaps'])
      && todoRelationOverlapsValid(entry.overlaps))
    || !gone.every((entry) => pair(entry, ['task_a', 'task_b', 'path']))
    || new Set(relations.map(keyOf)).size !== relations.length
    || (result.headSha !== undefined && result.headSha !== null
      && (typeof result.headSha !== 'string' || result.headSha.length === 0 || result.headSha.length > 1024))
    || (result.unresolvedCount !== undefined
      && !(Number.isSafeInteger(result.unresolvedCount) && result.unresolvedCount >= 0))
    || (result.computedAt !== undefined && !isStrictTodoTimestamp(result.computedAt))) {
    throw new TypeError('relation update result invalid');
  }
  return { relations, gone };
}

/** The history log: appended, never read. At LOG_SEGMENT_BYTES the file is sealed under its last sequence and a new one starts. */
async function appendHistory(repoRoot, logRef, lastSequence, events) {
  const absolute = path.resolve(repoRoot, logRef);
  const state = await lstat(absolute).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  if (state !== null && (state.isSymbolicLink() || !state.isFile())) fail('STORE_INCONSISTENT', 'relation_file_invalid', { ref: logRef });
  if (state !== null && state.size >= LOG_SEGMENT_BYTES) {
    await rename(absolute, path.resolve(path.dirname(absolute), `log-${lastSequence}.jsonl`));
  }
  await appendFile(absolute, Buffer.concat(events.map(line)), { mode: 0o644 });
}

/**
 * ADR 0204: one transaction over a plan's witness set and relation record, so two adds at once never miss each other.
 * Under `relations/<planKey>/.write.lock` Store reads the witness set, the open relations and the plan's unfinished task
 * ids, calls `update({witnessSet, openRelations, logSequence, unfinishedTaskIds})` (no Resolve, sensor or git inside:
 * it only compares resolved ranges), then writes witness set, log, summary in that order. A crash between them leaves the
 * row without its relations; the next write of that task recomputes its pairs (ids are content digests).
 * Open relations are one per {task_a, task_b, path}: a changed one replaces the old, an identical one is a no-op, `gone`
 * closes by key, and a relation of a task that is no longer unfinished is closed without being asked.
 * Never call this while holding the Todo Store lock: this takes the relations lock first, then reads the Store.
 */
export async function transactTodoRelations({ repoRoot = process.cwd(), planKey, writer, update } = {}) {
  requireTodoStoreWriter(writer, 'todo-relations');
  planKeyOf(planKey);
  if (typeof update !== 'function') throw new TypeError('update must be a function');
  const root = path.resolve(repoRoot);
  const { dir, log: logRef, summary: summaryRef } = refs(planKey);
  await ensureRelationDirectory(root, planKey);
  try {
    return await withStoreLock({ lockPath: path.join(root, dir, '.write.lock'), createParent: false,
      waitMs: LOCK_WAIT_MS }, async (assertHeld) => {
      const store = await readTodoStore({ repoRoot: root });
      const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
      if (member === undefined) throw new TypeError('planKey is not an active plan of this Store');
      const unfinished = new Set(member.tasks.filter(({ status }) => !FINISHED.has(status)).map(({ task_id: id }) => id));
      const files = await readOpenFiles(root, planKey);
      const dirty = new Set();
      const open = new Map();
      for (const entries of files.values()) {
        for (const [key, event] of entries) if ((open.get(key)?.sequence ?? 0) < event.sequence) open.set(key, event);
      }
      // A relation lives in both its tasks' files; a crash between the two writes leaves one side: complete it.
      const place = (event) => {
        for (const id of [event.task_a, event.task_b]) {
          if (!files.has(id)) files.set(id, new Map());
          const held = files.get(id).get(keyOf(event));
          if (held?.sequence !== event.sequence || held.relation_id !== event.relation_id) {
            files.get(id).set(keyOf(event), event);
            dirty.add(id);
          }
        }
      };
      const unplace = (event) => {
        for (const id of [event.task_a, event.task_b]) if (files.get(id)?.delete(keyOf(event))) dirty.add(id);
      };
      for (const event of open.values()) place(event);
      const previous = await readTodoRelationSummary({ repoRoot: root, planKey });
      const witnessSet = await readTodoWitnessSet({ repoRoot: root, planKey });
      const lastSequence = Math.max(previous?.log_sequence ?? 0, ...[...open.values()].map(({ sequence }) => sequence));

      const result = await update({ witnessSet, openRelations: [...open.values()].map((event) => structuredClone(event)),
        logSequence: lastSequence, unfinishedTaskIds: [...unfinished].sort() });
      const { relations, gone } = checkInput(result ?? {});
      const computedAt = result?.computedAt ?? new Date().toISOString();
      const headSha = result?.headSha === undefined ? previous?.head_sha ?? null : result.headSha;
      const unresolvedCount = result?.unresolvedCount ?? previous?.unresolved_count ?? 0;

      const appended = [];
      let sequence = lastSequence;
      const close = (event) => {
        open.delete(keyOf(event));
        unplace(event);
        appended.push({ schema: TODO_RELATION_EVENT_SCHEMA, kind: 'gone', sequence: ++sequence,
          relation_id: event.relation_id, task_a: event.task_a, task_b: event.task_b, path: event.path,
          head_sha: headSha, computed_at: computedAt });
      };
      for (const event of [...open.values()]) {
        if (!unfinished.has(event.task_a) || !unfinished.has(event.task_b)) close(event);
      }
      for (const entry of gone) if (open.has(keyOf(entry))) close(open.get(keyOf(entry)));
      let added = 0;
      for (const entry of relations) {
        if (!unfinished.has(entry.task_a) || !unfinished.has(entry.task_b)) continue;
        const id = todoRelationId(entry);
        const current = open.get(keyOf(entry));
        if (current !== undefined && current.relation_id === id && sameOverlaps(current.overlaps, entry.overlaps)) continue;
        if (current !== undefined) close(current);
        const event = { schema: TODO_RELATION_EVENT_SCHEMA, kind: 'relation', sequence: ++sequence, relation_id: id,
          task_a: entry.task_a, task_b: entry.task_b, path: entry.path, overlaps: entry.overlaps,
          head_sha: headSha, computed_at: computedAt };
        if (!validateTodoRelationEvent(event)) throw new TypeError('relation update result invalid');
        open.set(keyOf(entry), event);
        place(event);
        appended.push(event);
        added += 1;
      }

      const openList = [...open.values()].sort((left, right) => right.sequence - left.sequence);
      const summary = { schema: TODO_RELATION_SUMMARY_SCHEMA, plan_key: planKey, relation_count: openList.length,
        open_relations: openList.slice(0, TODO_RELATION_SUMMARY_OPEN).map(({ relation_id: id, task_a: a, task_b: b,
          path: p, overlaps }) => ({ relation_id: id, task_a: a, task_b: b, path: p, overlaps })),
        open_truncated: openList.length > TODO_RELATION_SUMMARY_OPEN, unresolved_count: unresolvedCount,
        head_sha: headSha, log_sequence: sequence, computed_at: computedAt };
      const stable = ({ computed_at: _at, ...rest }) => canonicalizeTodoArtifact(rest);
      // The summary is recounted from the task files, so a crash that left it behind is healed by any later write.
      const summaryChanged = previous === null
        ? appended.length > 0 || openList.length > 0 || result?.headSha !== undefined || result?.unresolvedCount !== undefined
        : stable(summary) !== stable(previous);

      await assertHeld();
      let writtenWitness = witnessSet;
      if (result?.witnessSet !== undefined && result.witnessSet !== null) {
        writtenWitness = (await writeTodoWitnessSet({ repoRoot: root, witnessSet: result.witnessSet })).witnessSet;
      }
      for (const id of [...dirty].sort()) {
        const target = path.resolve(root, refs(planKey).task(id));
        if (files.get(id).size === 0) await rm(target, { force: true });
        else await atomicWrite(target, Buffer.concat([...files.get(id).values()].sort((l, r) => l.sequence - r.sequence).map(line)));
      }
      if (summaryChanged) await atomicWrite(path.resolve(root, summaryRef), line(summary));
      if (appended.length > 0) await appendHistory(root, logRef, lastSequence, appended);
      return { witnessSet: writtenWitness, summary: summaryChanged ? summary : previous, appended: added,
        gone: appended.length - added };
    });
  } catch (error) {
    if (error instanceof StoreLockError) fail('STORE_WRITE_CONFLICT', error.reason, error.detail);
    throw error;
  }
}
