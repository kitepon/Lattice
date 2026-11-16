// ADR 0204 a4: per-plan function-level conflict relations. docs/architecture/dfd-store-relations.md
import { lstat, mkdir, readFile } from 'node:fs/promises';
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
const FILE_MAX_BYTES = 67_108_864;
const SUMMARY_MAX_BYTES = 65_536;
const FINISHED = new Set(['done', 'retired']);

const fail = (code, reason, detail) => { throw new TodoStoreError(code, reason, reason, detail); };
const line = (value) => Buffer.from(`${canonicalizeTodoArtifact(value)}\n`, 'utf8');
const keyOf = ({ task_a: a, task_b: b, path: p }) => `${a}\0${b}\0${p}`;
const refs = (planKey) => ({ dir: `${ROOT_REF}/${planKey}`, log: `${ROOT_REF}/${planKey}/log.jsonl`,
  summary: `${ROOT_REF}/${planKey}/summary.json` });

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

/** Fold the log: the open relation per pair key, and the last sequence. */
function foldLog(events) {
  const open = new Map();
  for (const event of events) {
    if (event.kind === 'gone') open.delete(keyOf(event));
    else open.set(keyOf(event), event);
  }
  return { open, sequence: events.at(-1)?.sequence ?? 0 };
}

async function readLog(repoRoot, planKey) {
  const { log } = refs(planKey);
  return parseLines(await readBounded(repoRoot, log, FILE_MAX_BYTES), log, validateTodoRelationEvent, 'todo_relation_event');
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

/** Open relations of the plan (optionally of one task); `includeGone` returns the whole event log instead. */
export async function readTodoRelations({ repoRoot = process.cwd(), planKey, taskId = null, includeGone = false } = {}) {
  const events = await readLog(path.resolve(repoRoot), planKeyOf(planKey));
  const about = (event) => taskId === null || event.task_a === taskId || event.task_b === taskId;
  if (includeGone) return events.filter(about);
  return [...foldLog(events).open.values()].filter(about);
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
  for (const ref of [ROOT_REF, refs(planKey).dir]) {
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
      const events = await readLog(root, planKey);
      const { open, sequence: lastSequence } = foldLog(events);
      const previous = await readTodoRelationSummary({ repoRoot: root, planKey });
      const witnessSet = await readTodoWitnessSet({ repoRoot: root, planKey });

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
        appended.push(event);
        added += 1;
      }

      const openList = [...open.values()];
      const summary = { schema: TODO_RELATION_SUMMARY_SCHEMA, plan_key: planKey, relation_count: openList.length,
        open_relations: openList.slice(-TODO_RELATION_SUMMARY_OPEN).reverse().map(({ relation_id: id, task_a: a, task_b: b,
          path: p, overlaps }) => ({ relation_id: id, task_a: a, task_b: b, path: p, overlaps })),
        open_truncated: openList.length > TODO_RELATION_SUMMARY_OPEN, unresolved_count: unresolvedCount,
        head_sha: headSha, log_sequence: sequence, computed_at: computedAt };
      const summaryChanged = previous === null
        ? appended.length > 0 || result?.headSha !== undefined || result?.unresolvedCount !== undefined
        : appended.length > 0 || previous.head_sha !== headSha || previous.unresolved_count !== unresolvedCount
          // A crash between log and summary left the summary behind the log: the next write heals it.
          || previous.log_sequence !== sequence;

      await assertHeld();
      let writtenWitness = witnessSet;
      if (result?.witnessSet !== undefined && result.witnessSet !== null) {
        writtenWitness = (await writeTodoWitnessSet({ repoRoot: root, witnessSet: result.witnessSet })).witnessSet;
      }
      if (appended.length > 0) {
        const existing = await readBounded(root, logRef, FILE_MAX_BYTES) ?? '';
        await atomicWrite(path.resolve(root, logRef), Buffer.concat([Buffer.from(existing, 'utf8'),
          ...appended.map(line)]));
      }
      if (summaryChanged) await atomicWrite(path.resolve(root, summaryRef), line(summary));
      return { witnessSet: writtenWitness, summary: summaryChanged ? summary : previous, appended: added,
        gone: appended.length - added };
    });
  } catch (error) {
    if (error instanceof StoreLockError) fail('STORE_WRITE_CONFLICT', error.reason, error.detail);
    throw error;
  }
}
