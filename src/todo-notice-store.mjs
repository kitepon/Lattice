import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LOCK_WAIT_MS, StoreLockError, withStoreLock } from './store-lock.mjs';
import {
  TODO_LIMITS, TODO_NOTICE_ACKS_SCHEMA, TODO_NOTICE_WAITS_SCHEMA, canonicalizeTodoArtifact, digestTodoArtifact, exactRecord,
  isStrictTodoTimestamp, isTodoDigest, isTodoIdentifier, todoSelfDigest,
} from './todo-contracts.mjs';
import { TodoStoreError, atomicWrite, rejectNewerTodoSchema } from './todo-store.mjs';

export { TODO_NOTICE_ACKS_SCHEMA, TODO_NOTICE_WAITS_SCHEMA };

/**
 * Per-lane ack set of startable notices and per-plan waits (dfd-done-notice.md, rows "Store: ack set",
 * "Store: waits record", "Store: ack key"). Host-local delivery state, not a plan fact: git-ignored (its own
 * .gitignore), one lock for both, never touching the lifecycle journals. Losing an ack means a notice is
 * delivered again; losing a wait loses the wake mark (the notice still lists) until `todo wait` runs again.
 */
export const TODO_NOTICE_ROOT_REF = '.lattice/todo/notices';
const ACKS_V1_SCHEMA = 'lattice.todo_notice_acks.v1';
const LANE_FILE = /^[0-9a-f]{16}\.json$/u;
const WAIT_FILE = /^wait-[0-9a-f]{16}\.json$/u;

const fail = (code, reason, detail) => { throw new TodoStoreError(code, reason, reason, detail); };
const canonicalLine = (value) => `${canonicalizeTodoArtifact(value)}\n`;
// Lane is the exact string the plan records (bot id or name); bounded so the record stays bounded.
const isLane = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/\p{Cc}/u.test(value);
const isReason = (value) => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/\p{Cc}/u.test(value));
const isActor = (value) => exactRecord(value, ['host', 'session', 'agent'])
  && [value.host, value.session, value.agent].every(isTodoIdentifier);
const sortedUnique = (keys) => keys.every((key, index) => index === 0 || keys[index - 1] < key);
const byKey = (keyOf) => (left, right) => (keyOf(left) < keyOf(right) ? -1 : 1);
// Digests are fixed-length hex and identifiers never hold \0, so these keys sort like the tuples.
const ackKey = ({ notice_id: id, waiting_digest: digest }) => `${id}:${digest}`;
const waitKey = ({ task_id: task, agent }) => `${task}\0${agent}`;
const pairOf = ({ notice_id, waiting_digest }) => ({ notice_id, waiting_digest });

const hex16 = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
const laneRef = (lane) => path.posix.join(TODO_NOTICE_ROOT_REF, `${hex16(lane)}.json`);
const waitRef = (planKey) => path.posix.join(TODO_NOTICE_ROOT_REF, `wait-${hex16(planKey)}.json`);

/**
 * The ack key's waiter-set digest: sha256 hex of the canonical sorted `[[agent, since], ...]`.
 * Plan imports this and never computes it itself; the Store needs digest([]) to read v1 acks.
 */
export function todoNoticeWaitingDigest(waiters) {
  if (!Array.isArray(waiters) || !waiters.every((w) => isLane(w?.agent) && isStrictTodoTimestamp(w?.since))) {
    throw new TypeError('todoNoticeWaitingDigest waiters invalid');
  }
  const pairs = waiters.map(({ agent, since }) => [agent, since])
    .sort(([la, ls], [ra, rs]) => (la < ra || (la === ra && ls < rs) ? -1 : 1));
  return digestTodoArtifact(pairs);
}
const NO_WAITERS_DIGEST = todoNoticeWaitingDigest([]);

const isRecipients = (value, lane) => Array.isArray(value) && value.length > 0 && value.every(isLane)
  && sortedUnique(value) && value.includes(lane);
const isAckV1 = (value) => exactRecord(value, ['notice_id', 'acked_at', 'actor'])
  && isTodoDigest(value.notice_id) && isStrictTodoTimestamp(value.acked_at) && isActor(value.actor);
const isAck = (value, lane) => exactRecord(value, ['notice_id', 'waiting_digest', 'recipients', 'acked_at', 'actor'])
  && isTodoDigest(value.notice_id) && isTodoDigest(value.waiting_digest) && isRecipients(value.recipients, lane)
  && isStrictTodoTimestamp(value.acked_at) && isActor(value.actor);
const isWait = (value) => exactRecord(value, ['task_id', 'agent', 'since', 'reason'])
  && isTodoIdentifier(value.task_id) && isLane(value.agent) && isStrictTodoTimestamp(value.since) && isReason(value.reason);

function sealedAcks(lane, acks) {
  const record = { schema: TODO_NOTICE_ACKS_SCHEMA, lane, acks, acks_digest: '' };
  record.acks_digest = todoSelfDigest(record, 'acks_digest');
  return record;
}

function sealedWaits(planKey, waits) {
  const record = { schema: TODO_NOTICE_WAITS_SCHEMA, plan_key: planKey, waits, waits_digest: '' };
  record.waits_digest = todoSelfDigest(record, 'waits_digest');
  return record;
}

// Both file kinds: every refusal names the file, so one bad file never hides another.
const ACK_FILE = {
  family: 'todo_notice_acks', label: 'notice_acks', digest: 'acks_digest',
  advice: 'is a host-local notice ack set, not plan data. Delete it to start the lane\'s acks over'
    + ' (its open notices are listed and delivered again), or run `lattice todo notice ack` to replace it.',
  // A v1 file is returned as its v2 reading: no waiters, the lane as the only recipient.
  parse(record) {
    const v1 = record.schema === ACKS_V1_SCHEMA;
    if (!exactRecord(record, ['schema', 'lane', 'acks', 'acks_digest']) || (!v1 && record.schema !== TODO_NOTICE_ACKS_SCHEMA)
      || !isLane(record.lane) || !Array.isArray(record.acks) || !isTodoDigest(record.acks_digest)
      || !record.acks.every((ack) => (v1 ? isAckV1(ack) : isAck(ack, record.lane)))
      || !sortedUnique(record.acks.map(v1 ? ({ notice_id: id }) => id : ackKey))) return null;
    return {
      ref: laneRef(record.lane),
      view: () => (v1 ? sealedAcks(record.lane, record.acks.map(({ notice_id, acked_at, actor }) => ({
        notice_id, waiting_digest: NO_WAITERS_DIGEST, recipients: [record.lane], acked_at, actor,
      }))) : record),
    };
  },
};
const WAIT_RECORD = {
  family: 'todo_notice_waits', label: 'notice_waits', digest: 'waits_digest',
  advice: 'is a host-local notice wait file, not plan data. Delete it to drop the plan\'s wake marks'
    + ' (re-run `lattice todo wait` to restore one), or run `lattice todo wait` to replace it.',
  parse(record) {
    if (!exactRecord(record, ['schema', 'plan_key', 'waits', 'waits_digest']) || record.schema !== TODO_NOTICE_WAITS_SCHEMA
      || !isTodoIdentifier(record.plan_key) || !Array.isArray(record.waits) || !record.waits.every(isWait)
      || !sortedUnique(record.waits.map(waitKey)) || !isTodoDigest(record.waits_digest)) return null;
    return { ref: waitRef(record.plan_key), view: () => record };
  },
};

async function readNoticeFile(repoRoot, ref, kind) {
  const corrupt = (reason) => fail('STORE_CORRUPT', `${kind.label}_${reason}`, { ref, next_action: `${ref} ${kind.advice}` });
  let bytes;
  try {
    const state = await lstat(path.resolve(repoRoot, ref));
    if (!state.isFile()) corrupt('not_file');
    if (state.size > TODO_LIMITS.journalSegmentBytes) corrupt('too_large');
    bytes = await readFile(path.resolve(repoRoot, ref), 'utf8');
  } catch (error) {
    if (error instanceof TodoStoreError) throw error;
    if (error?.code === 'ENOENT') return null;
    corrupt('unreadable');
  }
  let record;
  try { record = JSON.parse(bytes); } catch { corrupt('json_invalid'); }
  rejectNewerTodoSchema(record, kind.family, ref);
  const parsed = kind.parse(record);
  if (parsed === null) corrupt('shape_invalid');
  if (canonicalLine(record) !== bytes) corrupt('not_canonical');
  if (record[kind.digest] !== todoSelfDigest(record, kind.digest)) corrupt('digest_mismatch');
  if (parsed.ref !== ref) corrupt(kind === ACK_FILE ? 'lane_mismatch' : 'plan_mismatch');
  return parsed.view();
}

async function readAllNoticeFiles(repoRoot, pattern, kind, fileField) {
  const root = path.resolve(repoRoot);
  let names;
  try { names = (await readdir(path.resolve(root, TODO_NOTICE_ROOT_REF))).filter((name) => pattern.test(name)).sort(); }
  catch (error) {
    if (error?.code === 'ENOENT') return { records: [], unreadable: [] };
    return { records: [], unreadable: [{ [fileField]: TODO_NOTICE_ROOT_REF, code: 'STORE_CORRUPT', reason: `${kind.label}_unreadable` }] };
  }
  const records = [];
  const unreadable = [];
  for (const name of names) {
    const ref = path.posix.join(TODO_NOTICE_ROOT_REF, name);
    try {
      const record = await readNoticeFile(root, ref, kind);
      if (record !== null) records.push(record);
    } catch (error) {
      if (!(error instanceof TodoStoreError)) throw error;
      unreadable.push({ [fileField]: ref, code: error.code, reason: error.detail.reason });
    }
  }
  return { records, unreadable };
}

// The current record, or null when missing, unreadable or another key's (prefix collision): the write replaces it.
// A newer Lattice's file is refused, never downgraded.
async function replaceableRecord(root, ref, kind, owns) {
  try {
    const record = await readNoticeFile(root, ref, kind);
    return record !== null && owns(record) ? record : null;
  } catch (error) {
    if (!(error instanceof TodoStoreError) || error.code !== 'STORE_CORRUPT') throw error;
    return null;
  }
}

async function underNoticesLock(root, { create }, body) {
  const directory = path.resolve(root, TODO_NOTICE_ROOT_REF);
  if (create) {
    try { await mkdir(directory); }
    catch (error) {
      // Protects against creating a Store skeleton outside a published Store; leaves once the Store exists.
      if (error?.code === 'ENOENT') {
        fail('STORE_WRITE_CONFLICT', 'store_missing', { next_action: 'Initialize the Todo Store, then retry.' });
      }
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  try {
    return await withStoreLock({ lockPath: path.join(directory, '.write.lock'), createParent: false, waitMs: LOCK_WAIT_MS },
      async () => {
        // Ignored in any repository, not only where the host's .gitignore says so.
        await writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => {
          if (error?.code !== 'EEXIST') throw error;
        });
        return body();
      });
  } catch (error) {
    if (error instanceof StoreLockError) fail('STORE_WRITE_CONFLICT', error.reason, error.detail);
    throw error;
  }
}

/** The lane's ack set (a v1 file as its v2 reading), or null when the lane has none. */
export async function readTodoNoticeAcks({ repoRoot, lane } = {}) {
  if (typeof repoRoot !== 'string' || !isLane(lane)) throw new TypeError('readTodoNoticeAcks options invalid');
  const ref = laneRef(lane);
  const record = await readNoticeFile(path.resolve(repoRoot), ref, ACK_FILE);
  // A different lane whose hash prefix collides is not this lane's record.
  if (record !== null && record.lane !== lane) {
    fail('STORE_CORRUPT', 'notice_acks_lane_mismatch', { ref, lane, recorded_lane: record.lane });
  }
  return record;
}

/** Every lane's ack set; an unreadable lane file is named in `unreadable` and never hides the others. */
export async function readAllTodoNoticeAcks({ repoRoot } = {}) {
  if (typeof repoRoot !== 'string') throw new TypeError('readAllTodoNoticeAcks options invalid');
  const { records, unreadable } = await readAllNoticeFiles(repoRoot, LANE_FILE, ACK_FILE, 'lane_file');
  return { acks: records, unreadable };
}

/**
 * Record acks for `notices` (each `{notice_id, waiting_digest, recipients}` with notice_id in `openIds`, the lane's
 * open notices Plan read) and drop acks whose notice is no longer open. Every digest variant of an open notice is
 * kept, so the recipients already informed stay known; an existing pair is `already` and keeps its first entry.
 */
export async function ackTodoNotices({ repoRoot, lane, notices, openIds, actor, now } = {}) {
  if (typeof repoRoot !== 'string' || !isLane(lane) || !Array.isArray(notices) || notices.length === 0
    || !notices.every((n) => exactRecord(n, ['notice_id', 'waiting_digest', 'recipients']) && isTodoDigest(n.notice_id)
      && isTodoDigest(n.waiting_digest) && isRecipients(n.recipients, lane))
    || !Array.isArray(openIds) || !openIds.every(isTodoDigest) || !isActor(actor) || !isStrictTodoTimestamp(now)) {
    throw new TypeError('ackTodoNotices options invalid');
  }
  const open = new Set(openIds);
  if (!notices.every(({ notice_id: id }) => open.has(id))) throw new TypeError('ackTodoNotices notices must be open notices');
  const root = path.resolve(repoRoot);
  const ref = laneRef(lane);
  return underNoticesLock(root, { create: true }, async () => {
    const current = await replaceableRecord(root, ref, ACK_FILE, (record) => record.lane === lane);
    const kept = (current?.acks ?? []).filter(({ notice_id: id }) => open.has(id));
    const keptKeys = new Set(kept.map(ackKey));
    const requested = [...new Map(notices.map((n) => [ackKey(n), n])).values()].sort(byKey(ackKey));
    const already = requested.filter((n) => keptKeys.has(ackKey(n)));
    const acked = requested.filter((n) => !keptKeys.has(ackKey(n)));
    const acks = [...kept, ...acked.map(({ notice_id, waiting_digest, recipients }) => ({
      notice_id, waiting_digest, recipients, acked_at: now, actor,
    }))].sort(byKey(ackKey));
    const next = sealedAcks(lane, acks);
    // An unchanged v1 file reads the same, so it is left for an older Lattice that still reads it.
    if (current === null || next.acks_digest !== current.acks_digest) {
      await atomicWrite(path.resolve(root, ref), Buffer.from(canonicalLine(next), 'utf8'));
    }
    return { acked: acked.map(pairOf), already: already.map(pairOf) };
  });
}

/** Every plan's wait record, raw (Plan applies its in-effect check); an unreadable file is named in `unreadable`. */
export async function readAllTodoNoticeWaits({ repoRoot } = {}) {
  if (typeof repoRoot !== 'string') throw new TypeError('readAllTodoNoticeWaits options invalid');
  const { records, unreadable } = await readAllNoticeFiles(repoRoot, WAIT_FILE, WAIT_RECORD, 'wait_file');
  return { waits: records, unreadable };
}

/**
 * Record that `agent` waits for `taskId`. `keep(wait)` is Plan's synchronous, pure in-effect predicate; it runs under
 * the lock on the existing waits and each write drops the ones it rejects. A wait still in effect keeps its `since`
 * and takes the new reason (`recorded: false`). Plan checks the new wait itself before calling.
 */
export async function writeTodoNoticeWait({ repoRoot, planKey, taskId, agent, reason, now, keep } = {}) {
  if (typeof repoRoot !== 'string' || !isTodoIdentifier(planKey) || !isTodoIdentifier(taskId) || !isLane(agent)
    || !isReason(reason) || !isStrictTodoTimestamp(now) || typeof keep !== 'function') {
    throw new TypeError('writeTodoNoticeWait options invalid');
  }
  const root = path.resolve(repoRoot);
  const ref = waitRef(planKey);
  return underNoticesLock(root, { create: true }, async () => {
    const current = await replaceableRecord(root, ref, WAIT_RECORD, (record) => record.plan_key === planKey);
    const kept = (current?.waits ?? []).filter((wait) => keep(wait));
    const key = waitKey({ task_id: taskId, agent });
    const existing = kept.find((wait) => waitKey(wait) === key);
    const since = existing?.since ?? now;
    const waits = [...kept.filter((wait) => wait !== existing), { task_id: taskId, agent, since, reason }].sort(byKey(waitKey));
    const next = sealedWaits(planKey, waits);
    if (current === null || next.waits_digest !== current.waits_digest) {
      await atomicWrite(path.resolve(root, ref), Buffer.from(canonicalLine(next), 'utf8'));
    }
    return { recorded: existing === undefined, since };
  });
}

/** Remove `agent`'s wait for `taskId`; `cancelled: false` when there was none (an unreadable file holds none). */
export async function cancelTodoNoticeWait({ repoRoot, planKey, taskId, agent } = {}) {
  if (typeof repoRoot !== 'string' || !isTodoIdentifier(planKey) || !isTodoIdentifier(taskId) || !isLane(agent)) {
    throw new TypeError('cancelTodoNoticeWait options invalid');
  }
  const root = path.resolve(repoRoot);
  const ref = waitRef(planKey);
  try { await lstat(path.resolve(root, TODO_NOTICE_ROOT_REF)); }
  catch (error) {
    if (error?.code === 'ENOENT') return { cancelled: false };
    throw error;
  }
  return underNoticesLock(root, { create: false }, async () => {
    const current = await replaceableRecord(root, ref, WAIT_RECORD, (record) => record.plan_key === planKey);
    const key = waitKey({ task_id: taskId, agent });
    const waits = (current?.waits ?? []).filter((wait) => waitKey(wait) !== key);
    if (current === null || waits.length === current.waits.length) return { cancelled: false };
    await atomicWrite(path.resolve(root, ref), Buffer.from(canonicalLine(sealedWaits(planKey, waits)), 'utf8'));
    return { cancelled: true };
  });
}
