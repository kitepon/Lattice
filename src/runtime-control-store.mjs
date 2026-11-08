import { randomUUID } from 'node:crypto';
import { fsyncDirectory } from './fs-dir-sync.mjs';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { canonicalizeArtifact, digestArtifact as canonicalDigest } from './artifact-contracts.mjs';
import { selfDigest } from './runtime-contracts.mjs';
import {
  validateQuiescenceAck,
  validateRuntimeControlRequest,
  validateRuntimeControlResponse,
} from './runtime-controller-protocol.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVENT_FIELDS = Object.freeze([
  'schema', 'run_id', 'sequence', 'previous_digest', 'kind',
  'session_nonce_digest', 'payload', 'recorded_at', 'event_digest',
]);
const TEMPLATE_FIELDS = Object.freeze(['run_id', 'kind', 'session_nonce_digest', 'payload']);
const TIMED_TEMPLATE_FIELDS = Object.freeze([...TEMPLATE_FIELDS, 'recorded_at']);
const MAX_EVENTS = 100_000;
const MAX_REQUESTS = 100_000;

// factoryを作り直しても同一process内の同じrunは必ず一列に並ぶ。
const mutationQueues = new Map();

export class RuntimeControlStoreError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'RuntimeControlStoreError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) { throw new RuntimeControlStoreError(code, detail); }
function digest(value) { return typeof value === 'string' && SHA256.test(value); }
function identifier(value) { return typeof value === 'string' && ID.test(value); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, fields) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}
function timestamp(value) {
  return typeof value === 'string' && TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function selfDigestValid(value, field) {
  if (!digest(value?.[field])) return false;
  try { return selfDigest(value, field) === value[field]; } catch { return false; }
}
function canonicalBytes(value) { return Buffer.from(`${canonicalizeArtifact(value)}\n`); }

export function validateRuntimeControlEventPayload(kind, value) {
  if (!plain(value)) return false;
  if (kind === 'supervisor_activated') {
    return exact(value, ['supervisor_descriptor_digest', 'controller_descriptor_digest', 'registration_digest'])
      && [value.supervisor_descriptor_digest, value.controller_descriptor_digest,
        value.registration_digest].every(digest);
  }
  if (kind === 'supervisor_stopped') {
    return (exact(value, ['shutdown_result_digest']) && digest(value.shutdown_result_digest))
      || (exact(value, ['signal']) && typeof value.signal === 'string' && value.signal.length > 0);
  }
  if (kind === 'controller_registered') {
    return exact(value, ['controller_id', 'registration_digest'])
      && identifier(value.controller_id) && digest(value.registration_digest);
  }
  if (kind === 'controller_heartbeat') {
    return exact(value, ['controller_id', 'registration_digest', 'sequence', 'lease_set_digest'])
      && identifier(value.controller_id) && digest(value.registration_digest)
      && Number.isSafeInteger(value.sequence) && value.sequence > 0
      && digest(value.lease_set_digest);
  }
  if (kind === 'controller_recovery_rebound') {
    return exact(value, ['old_registration_digests', 'new_registration_digest', 'running_todo_ids'])
      && Array.isArray(value.old_registration_digests)
      && value.old_registration_digests.every(digest)
      && new Set(value.old_registration_digests).size === value.old_registration_digests.length
      && value.old_registration_digests.every((entry, index) => index === 0 || value.old_registration_digests[index - 1] < entry)
      && digest(value.new_registration_digest)
      && Array.isArray(value.running_todo_ids) && value.running_todo_ids.every(identifier)
      && new Set(value.running_todo_ids).size === value.running_todo_ids.length
      && value.running_todo_ids.every((entry, index) => index === 0 || value.running_todo_ids[index - 1] < entry);
  }
  if (kind === 'dispatch_routed' || kind === 'observation_routed') {
    return exact(value, ['controller_id', 'request_digest', 'response_digest'])
      && identifier(value.controller_id) && digest(value.request_digest)
      && digest(value.response_digest);
  }
  if (kind === 'barrier_requested') {
    return exact(value, ['barrier_id', 'reason', 'running_count', 'running_todo_ids', 'frozen_event_digest'])
      && identifier(value.barrier_id) && typeof value.reason === 'string' && value.reason.length > 0
      && Number.isSafeInteger(value.running_count) && value.running_count >= 0
      && Array.isArray(value.running_todo_ids) && value.running_todo_ids.length === value.running_count
      && value.running_todo_ids.every(identifier)
      && new Set(value.running_todo_ids).size === value.running_todo_ids.length
      && value.running_todo_ids.every((todo, index) => index === 0 || value.running_todo_ids[index - 1] < todo)
      && digest(value.frozen_event_digest);
  }
  if (kind === 'hold_prepared') {
    return exact(value, ['request_id', 'logical_intent_digest', 'finding_digest',
      'barrier_id', 'recorded_at'])
      && identifier(value.request_id) && digest(value.logical_intent_digest)
      && digest(value.finding_digest) && identifier(value.barrier_id)
      && timestamp(value.recorded_at);
  }
  if (kind === 'executor_quiesced') {
    const observed = value.direct_observation;
    return exact(value, ['barrier_id', 'barrier_control_digest', 'todo_id', 'ack',
      'direct_observation', 'evidence_digest'])
      && identifier(value.barrier_id) && digest(value.barrier_control_digest)
      && identifier(value.todo_id) && validateQuiescenceAck(value.ack)
      && value.ack.todo_id === value.todo_id
      && value.ack.barrier_control_digest === value.barrier_control_digest
      && exact(observed, ['quiesced', 'process_observation_digest', 'worktree_fingerprint_digest',
        'final_checkpoint_digest', 'observation', 'worktree_fingerprint', 'checkpoint', 'write_enabled'])
      && observed.quiesced === true && observed.write_enabled === false
      && digest(observed.process_observation_digest)
      && digest(observed.worktree_fingerprint_digest) && digest(observed.final_checkpoint_digest)
      && observed.process_observation_digest === canonicalDigest(observed.observation)
      && observed.worktree_fingerprint_digest === canonicalDigest(observed.worktree_fingerprint)
      && observed.final_checkpoint_digest === observed.checkpoint?.checkpoint_digest
      && value.ack.process_observation_digest === observed.process_observation_digest
      && value.ack.worktree_fingerprint_digest === observed.worktree_fingerprint_digest
      && value.ack.final_checkpoint_digest === observed.final_checkpoint_digest
      && value.evidence_digest === canonicalDigest({ ack: value.ack, direct_observation: observed });
  }
  if (kind === 'lease_revoked') {
    return (exact(value, ['controller_id', 'reason'])
        || exact(value, ['controller_id', 'reason', 'response_digest']))
      && identifier(value.controller_id) && typeof value.reason === 'string' && value.reason.length > 0
      && (value.response_digest === undefined || digest(value.response_digest));
  }
  if (kind === 'epoch_rebind_acknowledged') {
    return exact(value, ['todo_id', 'ack_digest', 'staged_lease_digest'])
      && identifier(value.todo_id) && digest(value.ack_digest) && digest(value.staged_lease_digest);
  }
  if (kind === 'write_gate_committed') {
    return exact(value, ['gate_digest', 'gate_generation']) && digest(value.gate_digest)
      && Number.isSafeInteger(value.gate_generation) && value.gate_generation > 0;
  }
  if (kind === 'epoch_activated' || kind === 'intake_resumed') {
    return exact(value, ['plan_epoch', 'gate_digest'])
      && Number.isSafeInteger(value.plan_epoch) && value.plan_epoch > 0
      && digest(value.gate_digest);
  }
  if (kind === 'supervisor_recovery_barrier') {
    return exact(value, ['barrier_id']) && identifier(value.barrier_id);
  }
  // I/O sentinelの早期警報（ADR 0143）。**findingではない**——検知の正本はcheckpointのままで、
  // これは「早くcheckpointを撮って確かめろ」という引き金の記録である。記録しない選択肢は無い:
  // 機械が何かに気づいたのに黙っている状態を残さない。
  if (kind === 'io_warning_observed') {
    return exact(value, ['warning_kind', 'todo_ids', 'path', 'probe_outcome', 'warning_digest'])
      && ['io_overlap_warning', 'io_undeclared_write_warning'].includes(value.warning_kind)
      && Array.isArray(value.todo_ids) && value.todo_ids.length >= 1 && value.todo_ids.length <= 256
      && value.todo_ids.every(identifier)
      && value.todo_ids.every((id, index) => index === 0 || value.todo_ids[index - 1] < id)
      && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
      && ['observed', 'transient', 'escalated', 'unprobed'].includes(value.probe_outcome)
      && value.warning_digest === canonicalDigest({
        warning_kind: value.warning_kind, todo_ids: value.todo_ids, path: value.path,
      });
  }
  // hold裁定のcontinue_setをprocessへ反映した記録（請求項7・8の再開側）。
  // barrierは全workerを止めるので、続けてよいと判定した作業を再開しなければ、
  // 判定と実行が食い違ったままになる。
  if (kind === 'workers_resumed') {
    return exact(value, ['resumed_todo_ids', 'skipped_count'])
      && Array.isArray(value.resumed_todo_ids) && value.resumed_todo_ids.length <= 4096
      && value.resumed_todo_ids.every(identifier)
      && value.resumed_todo_ids.every((id, index) => index === 0
        || value.resumed_todo_ids[index - 1] < id)
      && Number.isSafeInteger(value.skipped_count) && value.skipped_count >= 0;
  }
  // 破棄の決定としてworker processを終了した記録。**cleanupではない。**
  // 停止したworkerの行き先は「再開」か「破棄」の二択であり、破棄を選んだなら
  // 誰を止めたかが残っていなければ、後から何が捨てられたか説明できない。
  if (kind === 'worker_processes_terminated') {
    // signal_unavailable_pids (u03 C25): alive but not re-authenticated, so not signalled.
    const pidList = (pids) => Array.isArray(pids) && pids.length > 0 && pids.length <= 4096
      && pids.every((pid, index) => Number.isSafeInteger(pid) && pid > 0
        && (index === 0 || pids[index - 1] < pid));
    return (exact(value, ['reason', 'terminated_pids', 'skipped_count'])
      || (exact(value, ['reason', 'terminated_pids', 'skipped_count', 'signal_unavailable_pids'])
        && pidList(value.signal_unavailable_pids)))
      && typeof value.reason === 'string' && value.reason.length > 0
      && Array.isArray(value.terminated_pids) && value.terminated_pids.length <= 4096
      && value.terminated_pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
      && value.terminated_pids.every((pid, index) => index === 0
        || value.terminated_pids[index - 1] < pid)
      && Number.isSafeInteger(value.skipped_count) && value.skipped_count >= 0;
  }
  // probeを通った警報を既存hold経路へ入れた顛末（ADR 0143の三段目）。
  // 成否どちらも残す。自動escalationが黙って失敗する状態を作らない——失敗の理由は
  // `detail`が持ち、これが無いと「警報は出たのにholdが掛かっていない」を後から説明できない。
  if (kind === 'io_escalation_decided') {
    return exact(value, ['warning_digest', 'anchor_todo_id', 'checkpoint_digest',
      'finding_digest', 'outcome', 'detail'])
      && digest(value.warning_digest) && identifier(value.anchor_todo_id)
      && digest(value.checkpoint_digest)
      && (value.finding_digest === null || digest(value.finding_digest))
      && ['held', 'rejected', 'skipped'].includes(value.outcome)
      // holdまで通ったなら、どのfindingで止めたかを必ず指す。途中で落ちた時は
      // 記録済みfindingがあればそれを残す（無ければnull）——後追いの手掛かりを捨てない。
      && (value.outcome !== 'held' || digest(value.finding_digest))
      && typeof value.detail === 'string' && value.detail.length > 0 && value.detail.length <= 4096;
  }
  return false;
}

export function validateRuntimeControlJournal(value, expectedRunId = null) {
  if (!Array.isArray(value) || value.length > MAX_EVENTS) return false;
  return value.every((event, index) => (
    exact(event, EVENT_FIELDS)
    && event.schema === 'lattice.runtime_control_event.v1'
    && identifier(event.run_id)
    && (expectedRunId === null || event.run_id === expectedRunId)
    && Number.isSafeInteger(event.sequence) && event.sequence === index + 1
    && event.previous_digest === (index === 0 ? null : value[index - 1].event_digest)
    && identifier(event.kind)
    && digest(event.session_nonce_digest)
    && validateRuntimeControlEventPayload(event.kind, event.payload)
    && timestamp(event.recorded_at)
    && selfDigestValid(event, 'event_digest')
  ));
}

function validLedgerEntry(entry, runId) {
  if (!exact(entry, ['request_id', 'request_digest', 'intent_digest', 'state', 'response'])
    || !identifier(entry.request_id) || !digest(entry.request_digest) || !digest(entry.intent_digest)
    || !['in_progress', 'completed'].includes(entry.state)) return false;
  if (entry.state === 'in_progress') return entry.response === null;
  return validateRuntimeControlResponse(entry.response)
    && entry.response.request_id === entry.request_id
    && entry.response.run_id === runId;
}

export function validateRuntimeControlRequestLedger(value, expectedRunId = null) {
  if (!exact(value, ['schema', 'run_id', 'entries', 'ledger_digest'])
    || value.schema !== 'lattice.runtime_control_request_ledger.v1'
    || !identifier(value.run_id)
    || (expectedRunId !== null && value.run_id !== expectedRunId)
    || !Array.isArray(value.entries) || value.entries.length > MAX_REQUESTS
    || !value.entries.every((entry) => validLedgerEntry(entry, value.run_id))
    || !value.entries.every((entry, index) => index === 0
      || value.entries[index - 1].request_id < entry.request_id)
    || new Set(value.entries.map((entry) => entry.request_id)).size !== value.entries.length) return false;
  return selfDigestValid(value, 'ledger_digest');
}

async function ensureRunDirectory(runDir) {
  let info;
  try { info = await lstat(runDir); } catch { fail('INVALID_CONTROL_STORE', 'run directoryを読めない'); }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('INVALID_CONTROL_STORE', 'run directoryがreal directoryでない');
  }
}

async function readCanonical(pathname, validator, label, { missing = false } = {}) {
  let info;
  let bytes;
  try {
    info = await lstat(pathname);
    if (!info.isFile() || info.isSymbolicLink()) fail('INVALID_CONTROL_STORE', `${label}がregular fileでない`);
    bytes = await readFile(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT' && missing) return null;
    if (error instanceof RuntimeControlStoreError) throw error;
    fail('INVALID_CONTROL_STORE', `${label}を読めない`);
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_CONTROL_STORE', `${label}がJSONでない`); }
  if (!validator(value)) fail('INVALID_CONTROL_STORE', `${label}のexact schema又はdigest chainが不正`);
  if (!bytes.equals(canonicalBytes(value))) fail('INVALID_CONTROL_STORE', `${label}がcanonical bytesでない`);
  return { value, bytes };
}


async function inject(crashInjector, point, context) {
  if (typeof crashInjector === 'function') await crashInjector(point, structuredClone(context));
}

async function replaceCanonical({ pathname, expectedBytes, value, validator, crashInjector,
  label, directoryFsyncPoint }) {
  const current = await readCanonical(pathname, validator, label, { missing: expectedBytes === null });
  if ((current === null) !== (expectedBytes === null)
    || (current !== null && !current.bytes.equals(expectedBytes))) {
    fail('CONTROL_STORE_CONFLICT', `${label}のdisk prefixが変化した`);
  }
  const bytes = canonicalBytes(value);
  const temporary = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await inject(crashInjector, `after_${label}_file_fsync`, { pathname });
    await rename(temporary, pathname);
    await inject(crashInjector, `after_${label}_rename`, { pathname });
    await fsyncDirectory(path.dirname(pathname));
    await inject(crashInjector, directoryFsyncPoint, { pathname });
  } finally {
    if (handle !== null && handle !== undefined) await handle.close().catch(() => {});
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/**
 * control-events.jsonを書く他module（gate storeのatomic commit）が、このstoreのappendと
 * 同じper-directory直列化を共有するための入口。同一process内で書き手が2つの規律に
 * 分かれると、appendがcommitの読みと置換の間へ挟まり偽のcommitted prefix衝突になる。
 */
export function withControlJournalMutation(runDir, mutation) {
  return enqueue(path.resolve(runDir), mutation);
}

function enqueue(runDir, mutation) {
  const previous = mutationQueues.get(runDir) ?? Promise.resolve();
  const result = previous.then(mutation);
  const settled = result.catch(() => {});
  mutationQueues.set(runDir, settled);
  settled.finally(() => {
    if (mutationQueues.get(runDir) === settled) mutationQueues.delete(runDir);
  });
  return result;
}

function templateRecordedAt(template, clock) {
  if (exact(template, TIMED_TEMPLATE_FIELDS)) return template.recorded_at;
  if (exact(template, TEMPLATE_FIELDS)) return clock();
  fail('INVALID_CONTROL_EVENT', 'append templateのexact fieldが不正');
}

function sameEventIntent(event, template) {
  return event.run_id === template.run_id
    && event.kind === template.kind
    && event.session_nonce_digest === template.session_nonce_digest
    && canonicalizeArtifact(event.payload) === canonicalizeArtifact(template.payload);
}

function buildEvent(template, priorEvents, recordedAt, runId) {
  if (template.run_id !== runId || !identifier(template.kind)
    || !digest(template.session_nonce_digest)
    || !validateRuntimeControlEventPayload(template.kind, template.payload)
    || !timestamp(recordedAt)) fail('INVALID_CONTROL_EVENT', 'append template値が不正');
  try { canonicalizeArtifact(template.payload); } catch {
    fail('INVALID_CONTROL_EVENT', 'append payloadがcanonical JSON値でない');
  }
  const previous = priorEvents.at(-1) ?? null;
  const event = {
    schema: 'lattice.runtime_control_event.v1', run_id: runId,
    sequence: (previous?.sequence ?? 0) + 1,
    previous_digest: previous?.event_digest ?? null,
    kind: template.kind, session_nonce_digest: template.session_nonce_digest,
    payload: structuredClone(template.payload), recorded_at: recordedAt, event_digest: '',
  };
  event.event_digest = selfDigest(event, 'event_digest');
  return event;
}

function emptyLedger(runId) {
  const ledger = {
    schema: 'lattice.runtime_control_request_ledger.v1', run_id: runId,
    entries: [], ledger_digest: '',
  };
  ledger.ledger_digest = selfDigest(ledger, 'ledger_digest');
  return ledger;
}

function withLedgerEntries(ledger, entries) {
  const next = { ...ledger, entries: [...entries].sort((a, b) => (
    a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0
  )), ledger_digest: '' };
  next.ledger_digest = selfDigest(next, 'ledger_digest');
  return next;
}

function assertRequest(request, runId) {
  if (!validateRuntimeControlRequest(request) || request.run_id !== runId) {
    fail('INVALID_CONTROL_REQUEST', 'request exact schema又はrun binding不正');
  }
}

function logicalIntentDigest(request) {
  return selfDigest({ request_id: request.request_id, run_id: request.run_id,
    operation: request.operation, payload: request.payload, intent_digest: '' }, 'intent_digest');
}

function publicLedgerResult(entry, disposition = entry.state) {
  return Object.freeze({
    disposition,
    state: entry.state,
    request_digest: entry.request_digest,
    intent_digest: entry.intent_digest,
    response: entry.response === null ? null : structuredClone(entry.response),
  });
}

/** run単位のcontrol journalとrequest idempotency ledgerを所有するdurable store。 */
export function createRuntimeControlStore({ runDir, runId, clock = () => new Date().toISOString(),
  crashInjector = null }) {
  if (typeof runDir !== 'string' || !path.isAbsolute(runDir)
    || !identifier(runId) || typeof clock !== 'function'
    || (crashInjector !== null && typeof crashInjector !== 'function')) {
    fail('INVALID_CONTROL_STORE', 'control store設定不正');
  }
  const normalizedRunDir = path.resolve(runDir);
  const eventPath = path.join(normalizedRunDir, 'control-events.json');
  const ledgerPath = path.join(normalizedRunDir, 'control-request-ledger.json');
  const journalValidator = (value) => validateRuntimeControlJournal(value, runId);
  const ledgerValidator = (value) => validateRuntimeControlRequestLedger(value, runId);

  async function append(template) {
    return enqueue(normalizedRunDir, async () => {
      await ensureRunDirectory(normalizedRunDir);
      const prior = await readCanonical(eventPath, journalValidator, 'control_events', { missing: true });
      const events = prior?.value ?? [];
      const recordedAt = templateRecordedAt(template, clock);
      // tail比較のcanonicalizeより前に入力全体を検査する。
      buildEvent(template, events, recordedAt, runId);
      const tail = events.at(-1);
      // rename後に応答前crashした呼出しは、同じintentから同じevent digestを再発見する。
      if (tail !== undefined && sameEventIntent(tail, template)) {
        await fsyncDirectory(normalizedRunDir);
        return tail.event_digest;
      }
      if (events.length >= MAX_EVENTS) fail('CONTROL_STORE_LIMIT', 'control event上限超過');
      const event = buildEvent(template, events, recordedAt, runId);
      const next = [...events, event];
      await replaceCanonical({
        pathname: eventPath, expectedBytes: prior?.bytes ?? null, value: next,
        validator: journalValidator, crashInjector, label: 'control_events',
        directoryFsyncPoint: 'after_run_directory_fsync',
      });
      return event.event_digest;
    });
  }

  async function beginRequest(request) {
    return enqueue(normalizedRunDir, async () => {
      await ensureRunDirectory(normalizedRunDir);
      assertRequest(request, runId);
      const prior = await readCanonical(ledgerPath, ledgerValidator, 'request_ledger', { missing: true });
      const ledger = prior?.value ?? emptyLedger(runId);
      const existing = ledger.entries.find((entry) => entry.request_id === request.request_id);
      if (existing !== undefined) {
        if (existing.intent_digest !== logicalIntentDigest(request)) {
          fail('REQUEST_ID_CONFLICT', '同一request_idへ異なるlogical intent');
        }
        await fsyncDirectory(normalizedRunDir);
        return publicLedgerResult(existing);
      }
      if (ledger.entries.length >= MAX_REQUESTS) fail('CONTROL_STORE_LIMIT', 'request ledger上限超過');
      const entry = { request_id: request.request_id, request_digest: request.request_digest,
        intent_digest: logicalIntentDigest(request),
        state: 'in_progress', response: null };
      const next = withLedgerEntries(ledger, [...ledger.entries, entry]);
      await replaceCanonical({
        pathname: ledgerPath, expectedBytes: prior?.bytes ?? null, value: next,
        validator: ledgerValidator, crashInjector, label: 'request_ledger',
        directoryFsyncPoint: 'after_request_ledger_directory_fsync',
      });
      return publicLedgerResult(entry, 'started');
    });
  }

  async function completeRequest(request, response) {
    return enqueue(normalizedRunDir, async () => {
      await ensureRunDirectory(normalizedRunDir);
      assertRequest(request, runId);
      if (!validateRuntimeControlResponse(response)
        || response.request_id !== request.request_id || response.run_id !== runId
        || response.result.operation !== request.operation) {
        fail('INVALID_CONTROL_RESPONSE', 'response exact schema又はrequest binding不正');
      }
      const prior = await readCanonical(ledgerPath, ledgerValidator, 'request_ledger');
      const ledger = prior.value;
      const index = ledger.entries.findIndex((entry) => entry.request_id === request.request_id);
      if (index < 0) fail('REQUEST_NOT_STARTED', 'request ledgerにin_progressがない');
      const existing = ledger.entries[index];
      if (existing.intent_digest !== logicalIntentDigest(request)) {
        fail('REQUEST_ID_CONFLICT', '同一request_idへ異なるlogical intent');
      }
      if (existing.state === 'completed') {
        if (existing.response.response_digest !== response.response_digest) {
          fail('REQUEST_RESPONSE_CONFLICT', 'completed response digest衝突');
        }
        await fsyncDirectory(normalizedRunDir);
        return structuredClone(existing.response);
      }
      const completed = { ...existing, state: 'completed', response: structuredClone(response) };
      const entries = [...ledger.entries];
      entries[index] = completed;
      const next = withLedgerEntries(ledger, entries);
      await replaceCanonical({
        pathname: ledgerPath, expectedBytes: prior.bytes, value: next,
        validator: ledgerValidator, crashInjector, label: 'request_ledger',
        directoryFsyncPoint: 'after_request_ledger_directory_fsync',
      });
      return structuredClone(response);
    });
  }

  async function recoverCompletedRequest(request, response) {
    return enqueue(normalizedRunDir, async () => {
      await ensureRunDirectory(normalizedRunDir);
      assertRequest(request, runId);
      if (!validateRuntimeControlResponse(response)
        || response.request_id !== request.request_id || response.run_id !== runId
        || response.result.operation !== request.operation || response.outcome !== 'completed') {
        fail('INVALID_CONTROL_RESPONSE', 'recovery response exact schema又はrequest binding不正');
      }
      const prior = await readCanonical(ledgerPath, ledgerValidator, 'request_ledger');
      const ledger = prior.value;
      const index = ledger.entries.findIndex((entry) => entry.request_id === request.request_id);
      if (index < 0) fail('REQUEST_NOT_STARTED', 'request ledgerにentryがない');
      const existing = ledger.entries[index];
      if (existing.intent_digest !== logicalIntentDigest(request)) {
        fail('REQUEST_ID_CONFLICT', '同一request_idへ異なるlogical intent');
      }
      if (existing.state !== 'completed' || existing.response?.outcome !== 'rejected') {
        fail('REQUEST_RESPONSE_CONFLICT', 'rejected response以外はrecovery昇格できない');
      }
      const recovered = { ...existing, request_digest: request.request_digest,
        response: structuredClone(response) };
      const entries = [...ledger.entries];
      entries[index] = recovered;
      const next = withLedgerEntries(ledger, entries);
      await replaceCanonical({
        pathname: ledgerPath, expectedBytes: prior.bytes, value: next,
        validator: ledgerValidator, crashInjector, label: 'request_ledger',
        directoryFsyncPoint: 'after_request_ledger_directory_fsync',
      });
      return structuredClone(response);
    });
  }

  async function replaceCompletedActivationRequest(request, response) {
    return enqueue(normalizedRunDir, async () => {
      await ensureRunDirectory(normalizedRunDir);
      assertRequest(request, runId);
      if (request.operation !== 'activate' || !validateRuntimeControlResponse(response, 'activate')
        || response.request_id !== request.request_id || response.run_id !== runId
        || response.outcome !== 'completed') {
        fail('INVALID_CONTROL_RESPONSE', 'activation recovery response binding不正');
      }
      const prior = await readCanonical(ledgerPath, ledgerValidator, 'request_ledger');
      const ledger = prior.value;
      const index = ledger.entries.findIndex((entry) => entry.request_id === request.request_id);
      if (index < 0) fail('REQUEST_NOT_STARTED', 'request ledgerにactivation entryがない');
      const existing = ledger.entries[index];
      if (existing.intent_digest !== logicalIntentDigest(request)) {
        fail('REQUEST_ID_CONFLICT', '同一request_idへ異なるlogical intent');
      }
      if (existing.state === 'completed' && existing.request_digest === request.request_digest
        && existing.response.response_digest === response.response_digest) {
        await fsyncDirectory(normalizedRunDir);
        return structuredClone(existing.response);
      }
      const recovered = { ...existing, request_digest: request.request_digest,
        state: 'completed', response: structuredClone(response) };
      const entries = [...ledger.entries];
      entries[index] = recovered;
      const next = withLedgerEntries(ledger, entries);
      await replaceCanonical({
        pathname: ledgerPath, expectedBytes: prior.bytes, value: next,
        validator: ledgerValidator, crashInjector, label: 'request_ledger',
        directoryFsyncPoint: 'after_request_ledger_directory_fsync',
      });
      return structuredClone(response);
    });
  }

  async function readRequest(request) {
    return enqueue(normalizedRunDir, async () => {
      await ensureRunDirectory(normalizedRunDir);
      assertRequest(request, runId);
      const stored = await readCanonical(ledgerPath, ledgerValidator, 'request_ledger', { missing: true });
      if (stored === null) return null;
      const entry = stored.value.entries.find((candidate) => candidate.request_id === request.request_id);
      if (entry === undefined) return null;
      if (entry.intent_digest !== logicalIntentDigest(request)) {
        fail('REQUEST_ID_CONFLICT', '同一request_idへ異なるlogical intent');
      }
      return publicLedgerResult(entry);
    });
  }

  async function readEvents() {
    return enqueue(normalizedRunDir, async () => {
      await ensureRunDirectory(normalizedRunDir);
      const stored = await readCanonical(eventPath, journalValidator, 'control_events', { missing: true });
      return structuredClone(stored?.value ?? []);
    });
  }

  return Object.freeze({ append, beginRequest, completeRequest, recoverCompletedRequest,
    replaceCompletedActivationRequest, readRequest, readEvents });
}
