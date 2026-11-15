/**
 * b10-plan-copy-per-add: a retained plan version keeps only what differs from its successor (Store internal, pure).
 *
 * Every revision used to leave a full plan.json, a revision.json that repeats the same plan, and a snapshot.json
 * in its version directory forever (612 revisions = 475 MB for a 415 KB plan). Once a successor is active, the
 * predecessor's three files are redundant: `compact.json` records the reverse patch (successor plan -> this plan),
 * the revision without its repeated `desired_plan`, and the three digests readers look up. Nothing is dropped:
 * `reconstructPlan` rebuilds the exact canonical plan, checked against `plan_digest` before anything is deleted.
 */
import { readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalizeTodoArtifact, isTodoDigest, isTodoIdentifier, todoSelfDigest } from './todo-contracts.mjs';

export const TODO_VERSION_COMPACT_SCHEMA = 'lattice.todo_version_compact.v1';
export const TODO_VERSION_COMPACT_FILE = 'compact.json.gz';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => canonicalizeTodoArtifact(left) === canonicalizeTodoArtifact(right);

/** Patch node: {"=": value} replace, {"o": {key: node}, "x": [deleted keys]} object edit, {"a": [at, deleted, inserted]} splice. */
export function diffJson(from, to) {
  if (isObject(from) && isObject(to)) {
    const o = {}; const x = Object.keys(from).filter((key) => !(key in to));
    for (const [key, value] of Object.entries(to)) {
      if (!(key in from)) o[key] = { '=': value };
      else if (!same(from[key], value)) o[key] = diffJson(from[key], value);
    }
    return { o, x };
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    const keys = from.map((item) => canonicalizeTodoArtifact(item)); const next = to.map((item) => canonicalizeTodoArtifact(item));
    let head = 0;
    while (head < keys.length && head < next.length && keys[head] === next[head]) head += 1;
    let tail = 0;
    while (tail < keys.length - head && tail < next.length - head
      && keys[keys.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
    return { a: [head, keys.length - head - tail, to.slice(head, next.length - tail)] };
  }
  return { '=': to };
}

export function applyJsonPatch(from, patch) {
  if ('=' in patch) return patch['='];
  if ('a' in patch) {
    const [at, deleted, inserted] = patch.a;
    return [...from.slice(0, at), ...inserted, ...from.slice(at + deleted)];
  }
  const result = { ...from };
  for (const key of patch.x) delete result[key];
  for (const [key, node] of Object.entries(patch.o)) result[key] = applyJsonPatch(from[key], node);
  return result;
}

/** The compact record of `retained` once `anchor` (its direct successor, full) is active. Null when the round trip is not exact. */
export function buildVersionCompact({ retained, anchor, revision }) {
  const patch = diffJson(anchor, retained);
  if (!same(applyJsonPatch(anchor, patch), retained) || anchor.predecessor_plan_digest !== retained.plan_digest) return null;
  const { desired_plan: repeated, ...slim } = revision ?? {};
  if (revision && !same(repeated, retained)) return null;
  const record = {
    schema: TODO_VERSION_COMPACT_SCHEMA, project_id: retained.project_id, plan_key: retained.plan_key,
    plan_version: retained.plan_version, plan_digest: retained.plan_digest,
    predecessor_plan_digest: retained.predecessor_plan_digest ?? null,
    predecessor_plan_version: revision?.predecessor?.plan_version ?? null, topology_digest: retained.topology_digest,
    anchor_plan_version: anchor.plan_version, anchor_plan_digest: anchor.plan_digest,
    plan_patch: patch, revision: revision ? slim : null, compact_digest: '',
  };
  record.compact_digest = todoSelfDigest(record, 'compact_digest');
  return record;
}

export function validateVersionCompact(value) {
  const keys = ['schema', 'project_id', 'plan_key', 'plan_version', 'plan_digest', 'predecessor_plan_digest', 'predecessor_plan_version',
    'topology_digest', 'anchor_plan_version', 'anchor_plan_digest', 'plan_patch', 'revision', 'compact_digest'];
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => key in value)
    && value.schema === TODO_VERSION_COMPACT_SCHEMA
    && [value.project_id, value.plan_key, value.plan_version, value.anchor_plan_version].every(isTodoIdentifier)
    && [value.plan_digest, value.topology_digest, value.anchor_plan_digest, value.compact_digest].every(isTodoDigest)
    && (value.predecessor_plan_digest === null || isTodoDigest(value.predecessor_plan_digest))
    && (value.predecessor_plan_version === null || isTodoIdentifier(value.predecessor_plan_version))
    && isObject(value.plan_patch) && (value.revision === null || isObject(value.revision))
    && value.compact_digest === todoSelfDigest(value, 'compact_digest');
}

/** The exact plan of `record`, from its anchor's full plan. Throws when the result does not match plan_digest's plan. */
export function reconstructPlan(record, anchorPlan) {
  if (anchorPlan.plan_digest !== record.anchor_plan_digest) throw new Error('compact_anchor_mismatch');
  const plan = applyJsonPatch(anchorPlan, record.plan_patch);
  if (plan.plan_digest !== record.plan_digest || plan.plan_version !== record.plan_version) throw new Error('compact_plan_mismatch');
  return plan;
}

/** The revision a compact record stood in for, with its repeated desired_plan put back Null for a genesis version. */
export const reconstructRevision = (record, plan) => (record.revision === null ? null : { ...record.revision, desired_plan: plan });

/** The record as stored: canonical JSON line, gzip-packed (a revision's per-task migration is long and repetitive). */
export const packVersionCompact = (record) => gzipSync(Buffer.from(`${canonicalizeTodoArtifact(record)}\n`, 'utf8'), { level: 9 });

/** The compact record in `directory`, or null when there is none. Throws when the file is not a canonical, digest-true record. */
export async function readVersionCompact(directory, maxBytes = 8 * 1024 * 1024) {
  let packed;
  try { packed = await readFile(`${directory}/${TODO_VERSION_COMPACT_FILE}`); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const text = gunzipSync(packed, { maxOutputLength: maxBytes }).toString('utf8');
  const value = JSON.parse(text);
  if (text !== `${canonicalizeTodoArtifact(value)}\n` || !validateVersionCompact(value)) throw new Error('compact_record_invalid');
  return value;
}
