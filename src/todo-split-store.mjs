// ADR 0205 b2: the verify outcome of one split task, `.lattice/todo/splits/<plan_key>/<task_id>.json`. docs/architecture/dfd-store-split.md
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LOCK_WAIT_MS, StoreLockError, withStoreLock } from './store-lock.mjs';
import {
  TODO_SPLIT_RECORD_SCHEMA, canonicalizeTodoArtifact, isTodoIdentifier, validateTodoSplitRecord,
} from './todo-contracts.mjs';
import {
  TodoStoreError, atomicWrite, readTodoStore, rejectNewerTodoSchema, requireTodoStoreWriter,
} from './todo-store.mjs';

const ROOT_REF = '.lattice/todo/splits';
const RECORD_MAX_BYTES = 65_536;
const FINISHED = new Set(['done', 'retired']);

const fail = (code, reason, detail) => { throw new TodoStoreError(code, reason, reason, detail); };
const refOf = (planKey, taskId) => `${ROOT_REF}/${planKey}/${taskId}.json`;

function idsOf(planKey, taskId) {
  if (!isTodoIdentifier(planKey) || !isTodoIdentifier(taskId)) throw new TypeError('planKey and taskId must be todo identifiers');
}

/** The split record of task S, or null when none was written (never listed, never scanned). Lock-free: a write replaces the file whole. */
export async function readTodoSplit({ repoRoot = process.cwd(), planKey, taskId } = {}) {
  idsOf(planKey, taskId);
  const ref = refOf(planKey, taskId);
  let text;
  try {
    const absolute = path.resolve(repoRoot, ref);
    const state = await lstat(absolute);
    if (state.isSymbolicLink() || !state.isFile() || state.size > RECORD_MAX_BYTES) fail('STORE_INCONSISTENT', 'split_record_invalid', { ref });
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(text); } catch { fail('STORE_INCONSISTENT', 'split_record_invalid', { ref }); }
  rejectNewerTodoSchema(value, 'todo_split_record', ref);
  if (!validateTodoSplitRecord(value) || value.plan_key !== planKey || value.task_id !== taskId) {
    fail('STORE_INCONSISTENT', 'split_record_invalid', { ref });
  }
  return value;
}

async function ensureSplitDirectory(repoRoot, planKey) {
  const stale = () => fail('STORE_WRITE_CONFLICT', 'store_locked', {
    next_action: 'Initialize a published Todo Store before writing a split record, then retry.',
  });
  for (const ref of ['.lattice', '.lattice/todo', '.lattice/todo/manifest.json']) {
    const state = await lstat(path.resolve(repoRoot, ref)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
      return null;
    });
    if (state === null || state.isSymbolicLink() || (ref.endsWith('.json') ? !state.isFile() : !state.isDirectory())) stale();
  }
  for (const ref of [ROOT_REF, `${ROOT_REF}/${planKey}`]) {
    const absolute = path.resolve(repoRoot, ref);
    await mkdir(absolute).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
    const state = await lstat(absolute);
    if (state.isSymbolicLink() || !state.isDirectory()) fail('STORE_INCONSISTENT', 'split_record_invalid', { ref });
  }
}

/**
 * Writes the verify outcome of split task S: `record` = `{map, commit, base, outcome, conditions, recorded_at, actor}`; the Store adds
 * schema, plan_key, task_id and `attempt` (the previous attempt + 1, so a re-verify replaces the file whole). Under
 * `splits/<plan_key>/.write.lock`, held only for this write (never across the verify run), taken before any Store read: never call
 * this while holding the Todo Store lock. Checks, then writes: S is an unfinished task of the plan with a function_split mark, every
 * map entry names a member of it. An over-bound or malformed record is a writer bug (TypeError), never truncated.
 */
export async function recordTodoSplit({ repoRoot = process.cwd(), planKey, taskId, writer, record } = {}) {
  requireTodoStoreWriter(writer, 'todo-splits');
  idsOf(planKey, taskId);
  const root = path.resolve(repoRoot);
  await ensureSplitDirectory(root, planKey);
  try {
    return await withStoreLock({ lockPath: path.join(root, ROOT_REF, planKey, '.write.lock'), createParent: false,
      waitMs: LOCK_WAIT_MS }, async (assertHeld) => {
      const store = await readTodoStore({ repoRoot: root });
      const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
      const mark = member?.plan.tasks.find(({ task_id: id }) => id === taskId)?.function_split ?? null;
      if (mark === null) throw new TypeError('taskId is not a task of an active plan with a function_split mark');
      const status = member.tasks.find(({ task_id: id }) => id === taskId)?.status;
      if (FINISHED.has(status)) fail('STORE_WRITE_CONFLICT', 'split_task_finished', { plan_key: planKey, task_id: taskId, status });
      const previous = await readTodoSplit({ repoRoot: root, planKey, taskId });
      const value = { ...record, schema: TODO_SPLIT_RECORD_SCHEMA, plan_key: planKey, task_id: taskId,
        attempt: (previous?.attempt ?? 0) + 1 };
      const bytes = Buffer.from(`${canonicalizeTodoArtifact(value)}\n`, 'utf8');
      if (!validateTodoSplitRecord(value) || bytes.length > RECORD_MAX_BYTES
        || !value.map.every(({ task_id: id }) => mark.members.includes(id))) throw new TypeError('split record invalid');
      await assertHeld();
      await atomicWrite(path.resolve(root, refOf(planKey, taskId)), bytes);
      return value;
    });
  } catch (error) {
    if (error instanceof StoreLockError) fail('STORE_WRITE_CONFLICT', error.reason, error.detail);
    throw error;
  }
}
