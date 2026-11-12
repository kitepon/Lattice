import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LOCK_WAIT_MS, StoreLockError, withStoreLock } from './store-lock.mjs';
import {
  TODO_LIMITS, TODO_NOTICE_ACKS_SCHEMA, canonicalizeTodoArtifact, exactRecord, isStrictTodoTimestamp, isTodoDigest, isTodoIdentifier,
  todoSelfDigest,
} from './todo-contracts.mjs';
import { TodoStoreError, atomicWrite, rejectNewerTodoSchema } from './todo-store.mjs';

export { TODO_NOTICE_ACKS_SCHEMA };

/**
 * Per-lane ack set of startable notices (dfd-done-notice.md, row "Store: ack set").
 * Host-local delivery state, not a plan fact: it is git-ignored (its own .gitignore), has its own lock, and never touches the
 * lifecycle journals. Losing it means a notice is delivered again, never lost.
 */
export const TODO_NOTICE_ROOT_REF = '.lattice/todo/notices';
const LANE_FILE = /^[0-9a-f]{16}\.json$/u;

const fail = (code, reason, detail) => { throw new TodoStoreError(code, reason, reason, detail); };
const canonicalLine = (value) => `${canonicalizeTodoArtifact(value)}\n`;
// Lane is the exact string the plan records (bot id or name); bounded so the record stays bounded.
const isLane = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/\p{Cc}/u.test(value);
const isActor = (value) => exactRecord(value, ['host', 'session', 'agent'])
  && [value.host, value.session, value.agent].every(isTodoIdentifier);
const isAck = (value) => exactRecord(value, ['notice_id', 'acked_at', 'actor'])
  && isTodoDigest(value.notice_id) && isStrictTodoTimestamp(value.acked_at) && isActor(value.actor);
const sortedUnique = (ids) => ids.every((id, index) => index === 0 || ids[index - 1] < id);

const laneFileName = (lane) => `${createHash('sha256').update(lane, 'utf8').digest('hex').slice(0, 16)}.json`;
const laneRef = (lane) => path.posix.join(TODO_NOTICE_ROOT_REF, laneFileName(lane));

function sealed(lane, acks) {
  const record = { schema: TODO_NOTICE_ACKS_SCHEMA, lane, acks, acks_digest: '' };
  record.acks_digest = todoSelfDigest(record, 'acks_digest');
  return record;
}

// Every refusal names the lane file, so one bad lane never hides another.
async function readLaneFile(repoRoot, ref) {
  const corrupt = (reason) => fail('STORE_CORRUPT', reason, {
    ref,
    next_action: `${ref} is a host-local notice ack set, not plan data. Delete it to start the lane's acks over`
      + ' (its open notices are listed and delivered again), or run `lattice todo notice ack` to replace it.',
  });
  let bytes;
  try {
    const state = await lstat(path.resolve(repoRoot, ref));
    if (!state.isFile()) corrupt('notice_acks_not_file');
    if (state.size > TODO_LIMITS.journalSegmentBytes) corrupt('notice_acks_too_large');
    bytes = await readFile(path.resolve(repoRoot, ref), 'utf8');
  } catch (error) {
    if (error instanceof TodoStoreError) throw error;
    if (error?.code === 'ENOENT') return null;
    corrupt('notice_acks_unreadable');
  }
  let record;
  try { record = JSON.parse(bytes); } catch { corrupt('notice_acks_json_invalid'); }
  rejectNewerTodoSchema(record, 'todo_notice_acks', ref);
  if (!exactRecord(record, ['schema', 'lane', 'acks', 'acks_digest']) || record.schema !== TODO_NOTICE_ACKS_SCHEMA
    || !isLane(record.lane) || !Array.isArray(record.acks) || !record.acks.every(isAck)
    || !sortedUnique(record.acks.map(({ notice_id: id }) => id)) || !isTodoDigest(record.acks_digest)) {
    corrupt('notice_acks_shape_invalid');
  }
  if (canonicalLine(record) !== bytes) corrupt('notice_acks_not_canonical');
  if (record.acks_digest !== todoSelfDigest(record, 'acks_digest')) corrupt('notice_acks_digest_mismatch');
  if (laneRef(record.lane) !== ref) corrupt('notice_acks_lane_mismatch');
  return record;
}

/** The lane's ack set, or null when the lane has none. */
export async function readTodoNoticeAcks({ repoRoot, lane } = {}) {
  if (typeof repoRoot !== 'string' || !isLane(lane)) throw new TypeError('readTodoNoticeAcks options invalid');
  const ref = laneRef(lane);
  const record = await readLaneFile(path.resolve(repoRoot), ref);
  // A different lane whose hash prefix collides is not this lane's record.
  if (record !== null && record.lane !== lane) {
    fail('STORE_CORRUPT', 'notice_acks_lane_mismatch', { ref, lane, recorded_lane: record.lane });
  }
  return record;
}

/** Every lane's ack set; an unreadable lane file is named in `unreadable` and never hides the others. */
export async function readAllTodoNoticeAcks({ repoRoot } = {}) {
  if (typeof repoRoot !== 'string') throw new TypeError('readAllTodoNoticeAcks options invalid');
  const root = path.resolve(repoRoot);
  let names;
  try { names = (await readdir(path.resolve(root, TODO_NOTICE_ROOT_REF))).filter((name) => LANE_FILE.test(name)).sort(); }
  catch (error) {
    if (error?.code === 'ENOENT') return { acks: [], unreadable: [] };
    return { acks: [], unreadable: [{ lane_file: TODO_NOTICE_ROOT_REF, code: 'STORE_CORRUPT', reason: 'notice_acks_unreadable' }] };
  }
  const acks = [];
  const unreadable = [];
  for (const name of names) {
    const ref = path.posix.join(TODO_NOTICE_ROOT_REF, name);
    try {
      const record = await readLaneFile(root, ref);
      if (record !== null) acks.push(record);
    } catch (error) {
      if (!(error instanceof TodoStoreError)) throw error;
      unreadable.push({ lane_file: ref, code: error.code, reason: error.detail.reason });
    }
  }
  return { acks, unreadable };
}

/**
 * Record acks for `noticeIds` (each must be in `openIds`, the lane's open notices Plan read) and drop
 * acks whose notice is no longer open, so the set stays bounded by the open notices.
 * An unreadable older file is replaced (its acks were already unusable: list shows them unacked);
 * a newer Lattice's file is refused, never downgraded.
 */
export async function ackTodoNotices({ repoRoot, lane, noticeIds, openIds, actor, now } = {}) {
  if (typeof repoRoot !== 'string' || !isLane(lane) || !Array.isArray(noticeIds) || noticeIds.length === 0
    || !Array.isArray(openIds) || ![...noticeIds, ...openIds].every(isTodoDigest)
    || !isActor(actor) || !isStrictTodoTimestamp(now)) {
    throw new TypeError('ackTodoNotices options invalid');
  }
  const open = new Set(openIds);
  if (!noticeIds.every((id) => open.has(id))) throw new TypeError('ackTodoNotices noticeIds must be open notices');
  const root = path.resolve(repoRoot);
  const directory = path.resolve(root, TODO_NOTICE_ROOT_REF);
  try { await mkdir(directory); }
  catch (error) {
    // Protects against creating a Store skeleton outside a published Store; leaves once the Store exists.
    if (error?.code === 'ENOENT') {
      fail('STORE_WRITE_CONFLICT', 'store_missing', { next_action: 'Initialize the Todo Store, then retry the ack.' });
    }
    if (error?.code !== 'EEXIST') throw error;
  }
  const ref = laneRef(lane);
  try {
    return await withStoreLock({ lockPath: path.join(directory, '.write.lock'), createParent: false, waitMs: LOCK_WAIT_MS },
      async () => {
        // Ignored in any repository, not only where the host's .gitignore says so.
        await writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => {
          if (error?.code !== 'EEXIST') throw error;
        });
        let current = null;
        try { current = await readLaneFile(root, ref); }
        catch (error) {
          if (!(error instanceof TodoStoreError) || error.code !== 'STORE_CORRUPT') throw error;
        }
        // A colliding lane's record is not ours to keep; it is replaced like any unreadable file.
        const kept = (current?.lane === lane ? current.acks : []).filter(({ notice_id: id }) => open.has(id));
        const keptIds = new Set(kept.map(({ notice_id: id }) => id));
        const requested = [...new Set(noticeIds)].sort();
        const already = requested.filter((id) => keptIds.has(id));
        const acked = requested.filter((id) => !keptIds.has(id));
        const acks = [...kept, ...acked.map((id) => ({ notice_id: id, acked_at: now, actor }))]
          .sort((left, right) => (left.notice_id < right.notice_id ? -1 : 1));
        const next = sealed(lane, acks);
        if (current === null || next.acks_digest !== current.acks_digest) {
          await atomicWrite(path.resolve(root, ref), Buffer.from(canonicalLine(next), 'utf8'));
        }
        return { acked, already };
      });
  } catch (error) {
    if (error instanceof StoreLockError) fail('STORE_WRITE_CONFLICT', error.reason, error.detail);
    throw error;
  }
}
