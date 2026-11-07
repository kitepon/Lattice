import { fsyncDirectory } from './fs-dir-sync.mjs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalizeArtifact, digestArtifact } from './artifact-contracts.mjs';
import { buildExecutorPackets } from './runtime-engine.mjs';
import { verifyRunEventChain } from './runtime-event-store.mjs';
import { validateRuntimeControlJournal } from './runtime-control-store.mjs';
import {
  RUNTIME_CONFLICT_KINDS,
  validateExecutorPacket,
  validateRunRequest,
  validateRuntimeBoundaryManifest,
  validateRuntimePlan,
  verifyRuntimePlanBinding,
} from './runtime-contracts.mjs';
import {
  validateRunRequestV2,
  validateRuntimeRecompileRequest,
  validateRuntimeTaskMigration,
} from './runtime-hold-recompile.mjs';

const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const EPOCH_DIRECTORY = /^\d{8}$/u;
const TRANSACTION_ID = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/u;
const RUNTIME_UPGRADE_COMMAND = 'npm install -g @quolu/lattice@latest --prefer-online';

export class RuntimeEpochStoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'RuntimeEpochStoreError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new RuntimeEpochStoreError(code, message, detail);
}

function schemaGeneration(schema, family) {
  if (typeof schema !== 'string') return null;
  const prefix = `${family}.v`;
  if (!schema.startsWith(prefix)) return null;
  const generationText = schema.slice(prefix.length);
  if (!/^[1-9][0-9]*$/u.test(generationText)) return null;
  const generation = Number.parseInt(generationText, 10);
  return Number.isSafeInteger(generation) ? generation : null;
}

export function rejectFutureRuntimeStoreSchema(schema, { artifact, family, expectedVersion }) {
  const observedVersion = schemaGeneration(schema, family);
  if (observedVersion === null || observedVersion <= expectedVersion) return;
  const expectedSchema = `${family}.v${expectedVersion}`;
  fail(
    'UNSUPPORTED_RUNTIME_STORE_VERSION',
    `${artifact}のschema ${schema} はこのLatticeが対応する ${expectedSchema} より新しい`,
    {
      artifact,
      observed_schema: schema,
      expected_schema: expectedSchema,
      observed_version: observedVersion,
      expected_version: expectedVersion,
      upgrade_command: RUNTIME_UPGRADE_COMMAND,
    },
  );
}

function rejectFutureArtifact(value, options) {
  rejectFutureRuntimeStoreSchema(value?.schema, options);
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactRecord(value, keys) {
  return plainRecord(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function selfDigestValid(value, field) {
  if (!plainRecord(value) || !HEX_DIGEST.test(value[field] ?? '')) return false;
  const body = { ...value };
  delete body[field];
  return digestArtifact(body) === value[field];
}

function activationPrefixEvidence(events, expectedDigest, { stream, runId, plan }) {
  plan ??= {};
  const isArray = Array.isArray(events);
  const index = isArray ? events.findIndex((event) => event?.event_digest === expectedDigest) : -1;
  const actual = isArray ? events.at(-1)?.event_digest : null;
  const chainValid = isArray && (stream === 'run'
    ? verifyRunEventChain({ events }).valid && events[0]?.run_id === runId
    : validateRuntimeControlJournal(events, runId));
  const conflicting = chainValid && index >= 0 ? events.slice(index + 1).find((event) => {
    if (stream === 'run') {
      return event.plan_epoch > plan.plan_epoch
        || ['run_closed', 'intake_frozen'].includes(event.kind)
        || (event.kind === 'intake_resumed' && event.plan_epoch === plan.plan_epoch)
        || (event.kind === 'plan_recompiled' && event.plan_epoch >= plan.plan_epoch
          && (event.plan_epoch !== plan.plan_epoch
            || event.payload.new_plan_digest !== plan.plan_digest
            || event.subject.ref !== plan.plan_ref));
    }
    return ['supervisor_stopped', 'supervisor_recovery_barrier', 'write_gate_committed'].includes(event.kind)
      || (['epoch_activated', 'intake_resumed'].includes(event.kind)
        && event.payload.plan_epoch >= plan.plan_epoch);
  }) : null;
  return {
    expected_tail: expectedDigest, actual_tail: HEX_DIGEST.test(actual ?? '') ? actual : null,
    expected_in_chain: index >= 0, chain_valid: chainValid,
    conflicting_event_digest: conflicting?.event_digest ?? null,
  };
}

function activationEvidence(runEvents, controlEvents, runDigest, controlDigest, runId, plan) {
  return {
    run: activationPrefixEvidence(runEvents, runDigest, { stream: 'run', runId, plan }),
    control: activationPrefixEvidence(controlEvents, controlDigest, { stream: 'control', runId, plan }),
  };
}

export function validateRuntimeFindingRecord(value) {
  if (!exactRecord(value, ['schema', 'finding_id', 'run_id', 'plan_epoch',
    'source_checkpoint_digest', 'observed_event_digest', 'finding', 'recorded_by', 'finding_digest'])
    || value.schema !== 'lattice.runtime_finding_record.v1'
    || !TRANSACTION_ID.test(value.finding_id ?? '') || !TRANSACTION_ID.test(value.run_id ?? '')
    || !Number.isSafeInteger(value.plan_epoch) || value.plan_epoch < 1
    || !HEX_DIGEST.test(value.source_checkpoint_digest ?? '')
    || !HEX_DIGEST.test(value.observed_event_digest ?? '')
    || !selfDigestValid(value, 'finding_digest')) return false;
  const finding = value.finding;
  if (!exactRecord(finding, ['schema', 'kind', 'todo_ids', 'path', 'resource_id',
    'evidence_digests', 'finding_digest'])
    || finding.schema !== 'lattice.runtime_conflict_finding.v1'
    || !RUNTIME_CONFLICT_KINDS.includes(finding.kind)
    || !Array.isArray(finding.todo_ids) || finding.todo_ids.length < 1 || finding.todo_ids.length > 256
    || finding.todo_ids.some((todoId) => !TRANSACTION_ID.test(todoId))
    || new Set(finding.todo_ids).size !== finding.todo_ids.length
    || finding.todo_ids.some((todoId, index) => index > 0 && finding.todo_ids[index - 1] >= todoId)
    || !(finding.path === null || (typeof finding.path === 'string' && finding.path.length > 0))
    || !(finding.resource_id === null || TRANSACTION_ID.test(finding.resource_id))
    || !Array.isArray(finding.evidence_digests) || finding.evidence_digests.length > 256
    || finding.evidence_digests.some((entry) => !HEX_DIGEST.test(entry))
    || new Set(finding.evidence_digests).size !== finding.evidence_digests.length
    || finding.evidence_digests.some((entry, index) => index > 0 && finding.evidence_digests[index - 1] >= entry)
    || !selfDigestValid(finding, 'finding_digest')) return false;
  const pathKind = ['observed_write_conflict', 'undeclared_write', 'stale_context'].includes(finding.kind);
  if (pathKind !== (finding.path !== null) || pathKind === (finding.resource_id !== null)) return false;
  const observer = value.recorded_by;
  return exactRecord(observer, ['schema', 'kind', 'controller_registration_digest',
    'executor_handle', 'identity_digest'])
    && observer.schema === 'lattice.runtime_observer_identity.v1'
    && ['supervisor', 'controller', 'executor'].includes(observer.kind)
    && (observer.controller_registration_digest === null
      || HEX_DIGEST.test(observer.controller_registration_digest))
    && (observer.executor_handle === null || TRANSACTION_ID.test(observer.executor_handle))
    && selfDigestValid(observer, 'identity_digest');
}

export function validateRuntimeFindingCandidate(value) {
  if (!exactRecord(value, ['schema', 'proposed_kind', 'todo_ids', 'path', 'resource_id',
    'evidence_digests', 'candidate_digest'])
    || value.schema !== 'lattice.runtime_finding_candidate.v1'
    || !RUNTIME_CONFLICT_KINDS.includes(value.proposed_kind)
    || !Array.isArray(value.todo_ids) || value.todo_ids.length < 1 || value.todo_ids.length > 256
    || value.todo_ids.some((id) => !TRANSACTION_ID.test(id))
    || value.todo_ids.some((id, index) => index > 0 && value.todo_ids[index - 1] >= id)
    || !Array.isArray(value.evidence_digests) || value.evidence_digests.length > 256
    || value.evidence_digests.some((digest) => !HEX_DIGEST.test(digest))
    || value.evidence_digests.some((digest, index) => index > 0
      && value.evidence_digests[index - 1] >= digest)
    || !selfDigestValid(value, 'candidate_digest')) return false;
  const pathKind = ['observed_write_conflict', 'undeclared_write', 'stale_context']
    .includes(value.proposed_kind);
  return pathKind
    ? typeof value.path === 'string' && value.path.length > 0 && value.resource_id === null
    : value.path === null && TRANSACTION_ID.test(value.resource_id ?? '');
}

/** candidate本文を信用せず保存checkpointとactive bundleへ再束縛してfindingを発行する。 */
export async function recordRuntimeFinding({ runDir, candidate, checkpointDigest,
  observedEventDigest, recordedBy, deriveFinding = null, verifyFinding = null }) {
  if (!validateRuntimeFindingCandidate(candidate) || !HEX_DIGEST.test(checkpointDigest ?? '')
    || !HEX_DIGEST.test(observedEventDigest ?? '')) fail('FINDING_UNRESOLVED', 'finding candidate入力不正');
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null) fail('RUN_NOT_MANAGED', 'managed epochが存在しない');
  const todoSet = new Set(committed.bundle.plan.nodes.map(({ todo_id: id }) => id));
  if (!candidate.todo_ids.every((id) => todoSet.has(id))) {
    fail('STALE_FINDING', 'candidateがactive epoch外TODOを参照する');
  }
  const events = await readRegularJson(path.join(runDir, 'events.json'), 'run events');
  const observed = events.find((event) => event.event_digest === observedEventDigest
    && event.plan_epoch === committed.pointer.plan_epoch
    && event.payload?.checkpoint_digest === checkpointDigest);
  if (observed === undefined) fail('FINDING_UNRESOLVED', 'checkpoint/event bindingを解決できない');
  const proposed = typeof deriveFinding === 'function'
    ? await deriveFinding(structuredClone(candidate), {
      checkpoint: structuredClone(observed), bundle: structuredClone(committed.bundle),
    })
    : { schema: 'lattice.runtime_conflict_finding.v1', kind: candidate.proposed_kind,
      todo_ids: [...candidate.todo_ids], path: candidate.path, resource_id: candidate.resource_id,
      evidence_digests: [...candidate.evidence_digests], finding_digest: '' };
  proposed.finding_digest = digestArtifact(Object.fromEntries(Object.entries(proposed)
    .filter(([key]) => key !== 'finding_digest')));
  if (typeof verifyFinding === 'function' && await verifyFinding(structuredClone(proposed), {
    candidate: structuredClone(candidate), checkpoint: structuredClone(observed),
    bundle: structuredClone(committed.bundle),
  }) !== true) fail('FINDING_UNRESOLVED', 'independent finding verifierが不一致');
  const record = { schema: 'lattice.runtime_finding_record.v1',
    finding_id: `finding-${proposed.finding_digest.slice(0, 24)}`, run_id: committed.meta.run_id,
    plan_epoch: committed.pointer.plan_epoch, source_checkpoint_digest: checkpointDigest,
    observed_event_digest: observedEventDigest, finding: proposed,
    recorded_by: structuredClone(recordedBy), finding_digest: '' };
  const recordBody = { ...record }; delete recordBody.finding_digest;
  record.finding_digest = digestArtifact(recordBody);
  if (!validateRuntimeFindingRecord(record)) fail('FINDING_UNRESOLVED', 'derived finding recordが不正');
  const findingsDir = path.join(runDir, 'findings');
  await mkdir(findingsDir, { recursive: true });
  const findingPath = path.join(findingsDir, `${record.finding_digest}.json`);
  try {
    await writeDurableJson(findingPath, record);
    await fsyncDirectory(findingsDir);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readRegularJson(findingPath, 'runtime finding');
    if (!validateRuntimeFindingRecord(existing)
      || existing.finding_digest !== record.finding_digest) fail('FINDING_CONFLICT', 'finding digest alias競合');
  }
  return record;
}

async function readRegularJson(filePath, label) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    fail('INVALID_RUN_STORE', `${label}を読めない`);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail('INVALID_RUN_STORE', `${label}がregular fileではない`);
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    fail('INVALID_RUN_STORE', `${label}がvalid JSONではない`);
  }
}


async function writeDurableJson(filePath, value, { exclusive = true } = {}) {
  const bytes = `${JSON.stringify(value, null, 1)}\n`;
  const handle = await open(filePath, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceDurableJson(directory, name, value) {
  const temporary = path.join(directory, `.${name}-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeDurableJson(temporary, value);
    await rename(temporary, path.join(directory, name));
    await fsyncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function validateLegacyInputs({ request, compileArtifact, legacyMeta }) {
  const compileKeys = ['schema', 'request_digest', 'plan', 'manifests', 'schedule', 'graph_digest', 'result_digest'];
  const metaKeys = ['schema', 'run_id', 'executor_adapter', 'plan_digest'];
  const compileBody = { ...compileArtifact };
  delete compileBody.result_digest;
  if (!validateRunRequest(request)
    || !exactRecord(legacyMeta, metaKeys) || legacyMeta.schema !== 'lattice.run_meta.v1'
    || legacyMeta.run_id !== request.request_id
    || !exactRecord(compileArtifact, compileKeys)
    || compileArtifact.schema !== 'lattice.plan_compile_result.v1'
    || compileArtifact.result_digest !== digestArtifact(compileBody)
    || compileArtifact.request_digest !== request.request_digest
    || !validateRuntimePlan(compileArtifact.plan)
    || !verifyRuntimePlanBinding({ plan: compileArtifact.plan, request })
    || compileArtifact.plan.plan_digest !== legacyMeta.plan_digest) {
    fail('INVALID_RUN_STORE', 'legacy epoch 1 artifact bindingが不正');
  }
  const todoIds = compileArtifact.plan.nodes.map(({ todo_id: todoId }) => todoId).sort();
  if (Object.keys(compileArtifact.manifests ?? {}).sort().join('\0') !== todoIds.join('\0')) {
    fail('INVALID_RUN_STORE', 'epoch 1 manifest key集合がplanと一致しない');
  }
  for (const todoId of todoIds) {
    const manifest = compileArtifact.manifests[todoId];
    if (!validateRuntimeBoundaryManifest(manifest)
      || manifest.manifest_digest !== compileArtifact.plan.manifest_digests[todoId]) {
      fail('INVALID_RUN_STORE', `epoch 1 manifest bindingが不正: ${todoId}`);
    }
  }
}

function normalizeActivationMeta(meta, request, compileArtifact) {
  rejectFutureArtifact(meta, { artifact: 'run_meta', family: 'lattice.run_meta', expectedVersion: 2 });
  if (meta?.schema === 'lattice.run_meta.v1') return meta;
  if (exactRecord(meta, [
    'schema', 'run_id', 'executor_adapter', 'run_event_schema', 'control_event_schema',
    'epoch_bundle_schema', 'created_plan_digest', 'meta_digest',
  ]) && meta.schema === 'lattice.run_meta.v2'
    && meta.run_id === request.request_id
    && meta.created_plan_digest === compileArtifact.plan.plan_digest
    && selfDigestValid(meta, 'meta_digest')) {
    return {
      schema: 'lattice.run_meta.v1',
      run_id: meta.run_id,
      executor_adapter: meta.executor_adapter,
      plan_digest: meta.created_plan_digest,
    };
  }
  fail('INVALID_RUN_STORE', 'activation対象run metaがv1／同一runのv2ではない');
}

function buildEpochOneBundle({ request, compileArtifact, legacyMeta }) {
  validateLegacyInputs({ request, compileArtifact, legacyMeta });
  const bundle = {
    schema: 'lattice.runtime_epoch_bundle.v1',
    run_id: legacyMeta.run_id,
    plan_epoch: 1,
    request,
    plan: compileArtifact.plan,
    manifests: compileArtifact.manifests,
    executor_packets: buildExecutorPackets({
      plan: compileArtifact.plan,
      manifests: compileArtifact.manifests,
    }),
    rebind_packets: null,
    plan_diff: null,
    task_migration: null,
    treatment: null,
    phase_revision_digest: null,
    phase_revision_commit_receipt: null,
    predecessor_bundle_digest: null,
  };
  bundle.bundle_digest = digestArtifact(bundle);
  return bundle;
}

export function validateRuntimeEpochBundle(bundle) {
  if (!exactRecord(bundle, [
    'schema', 'run_id', 'plan_epoch', 'request', 'plan', 'manifests', 'executor_packets',
    'rebind_packets', 'plan_diff', 'task_migration', 'treatment', 'phase_revision_digest',
    'phase_revision_commit_receipt', 'predecessor_bundle_digest', 'bundle_digest',
  ]) || bundle.schema !== 'lattice.runtime_epoch_bundle.v1'
    || !Number.isInteger(bundle.plan_epoch) || bundle.plan_epoch < 1
    || bundle.plan_epoch !== bundle.plan?.plan_epoch
    || bundle.run_id !== bundle.request?.request_id
    || !(bundle.plan_epoch === 1 ? validateRunRequest(bundle.request) : validateRunRequestV2(bundle.request))
    || !validateRuntimePlan(bundle.plan)
    || !(bundle.plan_epoch === 1
      ? verifyRuntimePlanBinding({ plan: bundle.plan, request: bundle.request })
      : bundle.plan.request_digest === bundle.request.request_digest
        && bundle.plan.base_sha === bundle.request.repo.base_sha)
    || !selfDigestValid(bundle, 'bundle_digest')) return false;
  const todoIds = bundle.plan.nodes.map(({ todo_id: todoId }) => todoId).sort();
  if (Object.keys(bundle.manifests ?? {}).sort().join('\0') !== todoIds.join('\0')
    || Object.keys(bundle.executor_packets ?? {}).sort().join('\0') !== todoIds.join('\0')) return false;
  for (const todoId of todoIds) {
    const manifest = bundle.manifests[todoId];
    const packet = bundle.executor_packets[todoId];
    if (!validateRuntimeBoundaryManifest(manifest)
      || manifest.manifest_digest !== bundle.plan.manifest_digests[todoId]
      || !validateExecutorPacket(packet)
      || packet.todo_id !== todoId
      || packet.plan_ref !== bundle.plan.plan_ref
      || packet.plan_epoch !== bundle.plan_epoch) return false;
  }
  if (bundle.plan_epoch === 1) {
    return ['rebind_packets', 'plan_diff', 'task_migration', 'treatment',
      'phase_revision_digest', 'phase_revision_commit_receipt', 'predecessor_bundle_digest']
      .every((key) => bundle[key] === null);
  }
  if (!HEX_DIGEST.test(bundle.predecessor_bundle_digest ?? '')
    || !validateRuntimeTaskMigration(bundle.task_migration)
    || !plainRecord(bundle.rebind_packets) || !plainRecord(bundle.plan_diff)
    || !plainRecord(bundle.treatment)) return false;
  if (bundle.phase_revision_digest === null) {
    return bundle.phase_revision_commit_receipt === null;
  }
  return HEX_DIGEST.test(bundle.phase_revision_digest)
    && validatePhaseRevisionCommitReceipt(bundle.phase_revision_commit_receipt)
    && bundle.phase_revision_commit_receipt.revision_digest === bundle.phase_revision_digest;
}

export function validatePhaseRevisionCommitReceipt(value) {
  return exactRecord(value, ['schema', 'project_id', 'plan_key', 'plan_version',
    'revision_digest', 'committed_member_digest', 'active_plan_digest', 'journal_genesis_digest',
    'reconciliation_digest', 'source_cutover_receipt_digest', 'committed_at', 'receipt_digest'])
    && value.schema === 'lattice.phase_revision_commit_receipt.v1'
    && TRANSACTION_ID.test(value.project_id ?? '') && TRANSACTION_ID.test(value.plan_key ?? '')
    && typeof value.plan_version === 'string' && value.plan_version.length > 0
    && [value.revision_digest, value.committed_member_digest, value.active_plan_digest,
      value.journal_genesis_digest, value.reconciliation_digest,
      value.source_cutover_receipt_digest].every((digest) => HEX_DIGEST.test(digest ?? ''))
    && typeof value.committed_at === 'string' && !Number.isNaN(Date.parse(value.committed_at))
    && selfDigestValid(value, 'receipt_digest');
}

function validateRunMetaV2Envelope(meta) {
  return exactRecord(meta, [
    'schema', 'run_id', 'executor_adapter', 'run_event_schema', 'control_event_schema',
    'epoch_bundle_schema', 'created_plan_digest', 'meta_digest',
  ]) && meta.schema === 'lattice.run_meta.v2'
    && typeof meta.run_id === 'string'
    && typeof meta.executor_adapter === 'string'
    && typeof meta.run_event_schema === 'string'
    && typeof meta.control_event_schema === 'string'
    && typeof meta.epoch_bundle_schema === 'string'
    && HEX_DIGEST.test(meta.created_plan_digest ?? '')
    && selfDigestValid(meta, 'meta_digest');
}

function validateRunMetaV2(meta, createdBundle) {
  return validateRunMetaV2Envelope(meta)
    && meta.run_id === createdBundle.run_id
    && meta.run_event_schema === 'lattice.run_event.v1'
    && meta.control_event_schema === 'lattice.runtime_control_event.v1'
    && meta.epoch_bundle_schema === 'lattice.runtime_epoch_bundle.v1'
    && meta.created_plan_digest === createdBundle.plan.plan_digest;
}

function validateCommittedPointerEnvelope(pointer) {
  return exactRecord(pointer, [
    'schema', 'run_id', 'plan_epoch', 'plan_ref', 'bundle_digest',
    'activation_run_event_digest', 'activation_control_event_digest', 'pointer_digest',
  ]) && pointer.schema === 'lattice.committed_epoch_pointer.v1'
    && typeof pointer.run_id === 'string'
    && Number.isSafeInteger(pointer.plan_epoch) && pointer.plan_epoch >= 1
    && typeof pointer.plan_ref === 'string'
    && HEX_DIGEST.test(pointer.bundle_digest ?? '')
    && HEX_DIGEST.test(pointer.activation_run_event_digest ?? '')
    && HEX_DIGEST.test(pointer.activation_control_event_digest ?? '')
    && selfDigestValid(pointer, 'pointer_digest');
}

function validateCommittedPointer(pointer, bundle) {
  return validateCommittedPointerEnvelope(pointer)
    && pointer.run_id === bundle.run_id
    && pointer.plan_epoch === bundle.plan_epoch
    && pointer.plan_ref === bundle.plan.plan_ref
    && pointer.bundle_digest === bundle.bundle_digest;
}

/** v1 aliasをbyte不変のままepoch 1へ昇格し、pointerを最後にcommitする。 */
export async function activateEpochOneStore({
  runDir, request, compileArtifact, legacyMeta, activationRunEventDigest, activationControlEventDigest,
}) {
  if (!HEX_DIGEST.test(activationRunEventDigest ?? '')
    || !HEX_DIGEST.test(activationControlEventDigest ?? '')) {
    fail('INVALID_RUN_STORE', 'activation event digestが不正');
  }
  const runEvents = await readRegularJson(path.join(runDir, 'events.json'), 'run events');
  const controlEvents = await readRegularJson(path.join(runDir, 'control-events.json'), 'runtime control events');
  const evidence = activationEvidence(runEvents, controlEvents, activationRunEventDigest,
    activationControlEventDigest, request?.request_id, compileArtifact?.plan);
  if (!Object.values(evidence).every((entry) => entry.chain_valid && entry.expected_in_chain
      && entry.conflicting_event_digest === null)
    || controlEvents.find((event) => event.event_digest === activationControlEventDigest)?.kind !== 'supervisor_activated') {
    fail('INVALID_RUN_STORE', `activation pointerがdurable event prefixへbindしない: ${JSON.stringify(evidence)}`, evidence);
  }
  const normalizedMeta = normalizeActivationMeta(legacyMeta, request, compileArtifact);
  const bundle = buildEpochOneBundle({ request, compileArtifact, legacyMeta: normalizedMeta });
  const epochsDir = path.join(runDir, 'epochs');
  const epochDir = path.join(epochsDir, '00000001');
  const stagingDir = path.join(runDir, `.epoch-1-${process.pid}-${Date.now()}.tmp`);
  await mkdir(epochsDir, { recursive: true });
  await mkdir(path.join(runDir, 'staging'), { recursive: true });
  await mkdir(path.join(runDir, 'findings'), { recursive: true });
  await mkdir(path.join(runDir, 'controllers'), { recursive: true });
  await mkdir(path.join(runDir, 'leases'), { recursive: true });
  for (const directory of [epochsDir, path.join(runDir, 'staging'), path.join(runDir, 'findings'),
    path.join(runDir, 'controllers'), path.join(runDir, 'leases')]) await fsyncDirectory(directory);
  await fsyncDirectory(runDir);

  try {
    const existing = await readRegularJson(path.join(epochDir, 'epoch-bundle.json'), 'epoch 1 bundle');
    if (!validateRuntimeEpochBundle(existing) || existing.bundle_digest !== bundle.bundle_digest) {
      fail('EPOCH_BUNDLE_CONFLICT', 'epoch 1へ異なるbundleが存在する');
    }
  } catch (error) {
    if (error instanceof RuntimeEpochStoreError && error.message.endsWith('を読めない')) {
      await mkdir(stagingDir);
      await writeDurableJson(path.join(stagingDir, 'epoch-bundle.json'), bundle);
      await fsyncDirectory(stagingDir);
      try {
        await rename(stagingDir, epochDir);
        await fsyncDirectory(epochsDir);
      } catch (renameError) {
        await rm(stagingDir, { recursive: true, force: true });
        if (renameError?.code !== 'EEXIST' && renameError?.code !== 'ENOTEMPTY') throw renameError;
        const raced = await readRegularJson(path.join(epochDir, 'epoch-bundle.json'), 'epoch 1 bundle');
        if (!validateRuntimeEpochBundle(raced) || raced.bundle_digest !== bundle.bundle_digest) {
          fail('EPOCH_BUNDLE_CONFLICT', 'epoch 1 concurrent commitが異なる');
        }
      }
    } else {
      throw error;
    }
  }

  // pointerをmetaより先に書く。読み手はmeta v2を見てからpointerを読むので、逆順だと
  // 2書き込みの間にmeta v2だけが見え、並行するreaderがINVALID_RUN_STORE
  // （committed epoch pointerを読めない）で落ちる（2026-08-22 CI負荷下で実被弾）。
  // この順ならmeta v2の可視がpointer実在を含意し、途中crashはmeta v1のまま
  // （余剰のpointerはlegacy読取りに影響せず、再activationが置換する）。
  const pointer = {
    schema: 'lattice.committed_epoch_pointer.v1',
    run_id: normalizedMeta.run_id,
    plan_epoch: 1,
    plan_ref: compileArtifact.plan.plan_ref,
    bundle_digest: bundle.bundle_digest,
    activation_run_event_digest: activationRunEventDigest,
    activation_control_event_digest: activationControlEventDigest,
  };
  pointer.pointer_digest = digestArtifact(pointer);
  await replaceDurableJson(runDir, 'committed-epoch.json', pointer);

  const meta = {
    schema: 'lattice.run_meta.v2',
    run_id: normalizedMeta.run_id,
    executor_adapter: normalizedMeta.executor_adapter,
    run_event_schema: 'lattice.run_event.v1',
    control_event_schema: 'lattice.runtime_control_event.v1',
    epoch_bundle_schema: 'lattice.runtime_epoch_bundle.v1',
    created_plan_digest: compileArtifact.plan.plan_digest,
  };
  meta.meta_digest = digestArtifact(meta);
  await replaceDurableJson(runDir, 'run-meta.json', meta);
  return { bundle, meta, pointer, activation_evidence: evidence };
}

/** pointerを正本としてactive bundleだけを読む。directory最大値へfallbackしない。 */
export async function readCommittedEpochStore(runDir) {
  const meta = await readRegularJson(path.join(runDir, 'run-meta.json'), 'run meta');
  rejectFutureArtifact(meta, { artifact: 'run_meta', family: 'lattice.run_meta', expectedVersion: 2 });
  if (meta?.schema !== 'lattice.run_meta.v2') return null;
  if (!validateRunMetaV2Envelope(meta)) fail('INVALID_RUN_STORE', 'run meta envelopeが不正');
  rejectFutureRuntimeStoreSchema(meta.run_event_schema,
    { artifact: 'run_event', family: 'lattice.run_event', expectedVersion: 1 });
  rejectFutureRuntimeStoreSchema(meta.control_event_schema,
    { artifact: 'runtime_control_event', family: 'lattice.runtime_control_event', expectedVersion: 1 });
  rejectFutureRuntimeStoreSchema(meta.epoch_bundle_schema,
    { artifact: 'runtime_epoch_bundle', family: 'lattice.runtime_epoch_bundle', expectedVersion: 1 });
  if (meta.run_event_schema !== 'lattice.run_event.v1'
    || meta.control_event_schema !== 'lattice.runtime_control_event.v1'
    || meta.epoch_bundle_schema !== 'lattice.runtime_epoch_bundle.v1') {
    fail('INVALID_RUN_STORE', 'run meta schema bindingが不正');
  }
  const pointer = await readRegularJson(path.join(runDir, 'committed-epoch.json'), 'committed epoch pointer');
  rejectFutureArtifact(pointer, {
    artifact: 'committed_epoch_pointer', family: 'lattice.committed_epoch_pointer', expectedVersion: 1,
  });
  if (!validateCommittedPointerEnvelope(pointer)) fail('INVALID_RUN_STORE', 'committed epoch pointer envelopeが不正');
  const epochName = String(pointer.plan_epoch).padStart(8, '0');
  if (!EPOCH_DIRECTORY.test(epochName)) fail('INVALID_RUN_STORE', 'epoch directory名が不正');
  const bundle = await readRegularJson(path.join(runDir, 'epochs', epochName, 'epoch-bundle.json'), 'epoch bundle');
  rejectFutureArtifact(bundle,
    { artifact: 'runtime_epoch_bundle', family: 'lattice.runtime_epoch_bundle', expectedVersion: 1 });
  const createdBundle = pointer.plan_epoch === 1
    ? bundle
    : await readRegularJson(path.join(runDir, 'epochs', '00000001', 'epoch-bundle.json'), 'created epoch bundle');
  rejectFutureArtifact(createdBundle,
    { artifact: 'runtime_epoch_bundle', family: 'lattice.runtime_epoch_bundle', expectedVersion: 1 });
  if (!validateRuntimeEpochBundle(bundle)
    || !validateRuntimeEpochBundle(createdBundle)
    || createdBundle.plan_epoch !== 1
    || !validateRunMetaV2(meta, createdBundle)
    || !validateCommittedPointer(pointer, bundle)) {
    fail('INVALID_RUN_STORE', 'multi-epoch store bindingが不正');
  }
  let previous = createdBundle;
  for (let epoch = 2; epoch <= pointer.plan_epoch; epoch += 1) {
    const current = epoch === pointer.plan_epoch
      ? bundle
      : await readRegularJson(path.join(runDir, 'epochs', String(epoch).padStart(8, '0'), 'epoch-bundle.json'), `epoch ${epoch} bundle`);
    rejectFutureArtifact(current,
      { artifact: 'runtime_epoch_bundle', family: 'lattice.runtime_epoch_bundle', expectedVersion: 1 });
    if (!validateRuntimeEpochBundle(current) || current.plan_epoch !== epoch
      || current.run_id !== meta.run_id
      || current.predecessor_bundle_digest !== previous.bundle_digest) {
      fail('INVALID_RUN_STORE', `epoch ${epoch} predecessor chainが不正`);
    }
    previous = current;
  }
  return { meta, pointer, bundle };
}

/**
 * successorはLPG028のrun_request.v2／migration／treatment verifierを必須注入する。
 * v1 validatorやopaque objectへfallbackせず、verifier未導入中はstore無変更で拒否する。
 */
export async function stageSuccessorEpoch({ runDir, transactionId, bundle, recompileRequest = null,
  validateSuccessor, validatePhaseRevision = null, commitPhaseRevision = null }) {
  if (!TRANSACTION_ID.test(transactionId ?? '')) {
    fail('INVALID_RUN_STORE', 'staging transaction idが不正');
  }
  if (typeof validateSuccessor !== 'function') {
    fail('UNSUPPORTED_SUCCESSOR_SCHEMA', 'run_request.v2 successor verifierが未指定');
  }
  const committed = await readCommittedEpochStore(runDir);
  if (recompileRequest !== null && !validateRuntimeRecompileRequest(recompileRequest, {
    predecessorBundle: committed?.bundle ?? null,
    validatePhaseRevision,
  })) fail('INVALID_RECOMPILE_REQUEST', 'runtime recompile requestがcontractを満たさない');
  let candidate = structuredClone(bundle);
  if (committed === null || candidate?.schema !== 'lattice.runtime_epoch_bundle.v1'
    || candidate.plan_epoch !== committed.pointer.plan_epoch + 1
    || candidate.predecessor_bundle_digest !== committed.bundle.bundle_digest) {
    fail('EPOCH_BUNDLE_CONFLICT', 'successor bundleがcommitted predecessorへbindしない');
  }
  if (recompileRequest !== null) {
    if (candidate?.request?.request_digest !== recompileRequest.successor_request.request_digest
      || candidate?.task_migration?.migration_digest !== recompileRequest.task_migration.migration_digest) {
      fail('EPOCH_BUNDLE_CONFLICT', 'successor bundleがrecompile requestへbindしない');
    }
    if (recompileRequest.phase_revision === null) {
      if (candidate.phase_revision_digest !== null
        || candidate.phase_revision_commit_receipt !== null) {
        fail('PHASE_REVISION_COMMIT_MISMATCH', 'null phase revisionへreceiptが存在する');
      }
    } else {
      const preview = { ...candidate, phase_revision_digest: null,
        phase_revision_commit_receipt: null };
      const previewBody = { ...preview }; delete previewBody.bundle_digest;
      preview.bundle_digest = digestArtifact(previewBody);
      if (!validateRuntimeEpochBundle(preview)
        || await validateSuccessor(structuredClone(preview), {
          predecessor: structuredClone(committed.bundle),
          pointer: structuredClone(committed.pointer), phase_revision_pending: true,
        }) !== true) {
        fail('UNSUPPORTED_SUCCESSOR_SCHEMA', 'phase commit前successor verifierがbundleを棄却した');
      }
      if (typeof commitPhaseRevision !== 'function') {
        fail('PHASE_REVISION_UNAVAILABLE', 'phase_todo_revision.v3 committerが未指定');
      }
      // validate後、runtime storeへ一byteも書く前にTODO transactionをcommitする。
      const receipt = await commitPhaseRevision(structuredClone(recompileRequest.phase_revision));
      if (!validatePhaseRevisionCommitReceipt(receipt)
        || receipt.revision_digest !== recompileRequest.phase_revision.revision_digest
        || receipt.project_id !== recompileRequest.phase_revision.project_id
        || receipt.plan_key !== recompileRequest.phase_revision.plan_key
        || receipt.plan_version !== recompileRequest.phase_revision.desired_plan?.plan_version
        || receipt.active_plan_digest !== recompileRequest.phase_revision.desired_plan?.plan_digest
        || receipt.reconciliation_digest !== recompileRequest.phase_revision.reconciliation?.reconciliation_digest) {
        fail('PHASE_REVISION_COMMIT_MISMATCH', 'phase revision commit receipt bindingが不正');
      }
      candidate.phase_revision_digest = recompileRequest.phase_revision.revision_digest;
      candidate.phase_revision_commit_receipt = receipt;
      const body = { ...candidate };
      delete body.bundle_digest;
      candidate.bundle_digest = digestArtifact(body);
    }
  }
  const verdict = await validateSuccessor(structuredClone(candidate), {
    predecessor: structuredClone(committed.bundle),
    pointer: structuredClone(committed.pointer),
  });
  if (verdict !== true) {
    fail('UNSUPPORTED_SUCCESSOR_SCHEMA', 'run_request.v2 successor verifierがbundleを棄却した');
  }
  if (!validateRuntimeEpochBundle(candidate)) {
    fail('EPOCH_BUNDLE_CONFLICT', 'successor epoch bundle contractが不正');
  }
  const stagingRoot = path.join(runDir, 'staging');
  const transactionDir = path.join(stagingRoot, transactionId);
  const prepare = { schema: 'lattice.runtime_epoch_prepare.v1',
    transaction_id: transactionId, bundle_digest: candidate.bundle_digest, prepare_digest: '' };
  const prepareBody = { ...prepare }; delete prepareBody.prepare_digest;
  prepare.prepare_digest = digestArtifact(prepareBody);
  await mkdir(stagingRoot, { recursive: true });
  await fsyncDirectory(runDir);
  try {
    await mkdir(transactionDir);
    await writeDurableJson(path.join(transactionDir, 'epoch-bundle.json'), candidate);
    await writeDurableJson(path.join(transactionDir, 'prepare.json'), prepare);
    await fsyncDirectory(transactionDir);
    await fsyncDirectory(stagingRoot);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      await rm(transactionDir, { recursive: true, force: true });
      throw error;
    }
    const bundlePath = path.join(transactionDir, 'epoch-bundle.json');
    let existing;
    try {
      existing = await readRegularJson(bundlePath, 'staged epoch bundle');
    } catch (readError) {
      try { await lstat(bundlePath); throw readError; }
      catch (statError) {
        if (statError === readError || statError?.code !== 'ENOENT') throw readError;
      }
      await writeDurableJson(bundlePath, candidate);
      existing = candidate;
    }
    if (!validateRuntimeEpochBundle(existing) || existing.bundle_digest !== candidate.bundle_digest) {
      fail('EPOCH_BUNDLE_CONFLICT', '同一transactionへ異なるsuccessor bundleが存在する');
    }
    const preparePath = path.join(transactionDir, 'prepare.json');
    try {
      const existingPrepare = await readRegularJson(preparePath, 'staged epoch prepare');
      if (canonicalizeArtifact(existingPrepare) !== canonicalizeArtifact(prepare)) {
        fail('EPOCH_BUNDLE_CONFLICT', '同一transactionのprepare bindingが異なる');
      }
    } catch (readError) {
      try { await lstat(preparePath); throw readError; }
      catch (statError) {
        if (statError === readError || statError?.code !== 'ENOENT') throw readError;
      }
      await writeDurableJson(preparePath, prepare);
    }
    await fsyncDirectory(transactionDir);
    await fsyncDirectory(stagingRoot);
  }
  return { transaction_id: transactionId, bundle_digest: candidate.bundle_digest,
    bundle: structuredClone(candidate) };
}

/**
 * staged successorをepoch historyへrenameし、durable activation prefixを確認してpointerを最後にcommitする。
 * 同digest retryだけを許し、directory最大値や別transactionへfallbackしない。
 */
export async function commitStagedSuccessorEpoch({ runDir, transactionId,
  activationRunEventDigest, activationControlEventDigest, readActivationControlEvents = null }) {
  if (!TRANSACTION_ID.test(transactionId ?? '')
    || !HEX_DIGEST.test(activationRunEventDigest ?? '')
    || !HEX_DIGEST.test(activationControlEventDigest ?? '')) {
    fail('INVALID_RUN_STORE', 'successor commit入力が不正');
  }
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null) fail('INVALID_RUN_STORE', 'managed predecessorが存在しない');
  const transactionDir = path.join(runDir, 'staging', transactionId);
  let bundle;
  let alreadyRenamed = false;
  try {
    bundle = await readRegularJson(path.join(transactionDir, 'epoch-bundle.json'), 'staged epoch bundle');
  } catch (error) {
    if (!(error instanceof RuntimeEpochStoreError)) throw error;
    const successorDir = path.join(runDir, 'epochs', String(committed.pointer.plan_epoch + 1).padStart(8, '0'));
    let prepare;
    try {
      prepare = await readRegularJson(path.join(successorDir, 'prepare.json'), 'renamed epoch prepare');
      bundle = await readRegularJson(path.join(successorDir, 'epoch-bundle.json'), 'renamed epoch bundle');
      alreadyRenamed = true;
    } catch {
      const currentDir = path.join(runDir, 'epochs', String(committed.pointer.plan_epoch).padStart(8, '0'));
      prepare = await readRegularJson(path.join(currentDir, 'prepare.json'), 'committed epoch prepare');
      bundle = committed.bundle;
    }
    if (!exactRecord(prepare, ['schema', 'transaction_id', 'bundle_digest', 'prepare_digest'])
      || prepare.schema !== 'lattice.runtime_epoch_prepare.v1'
      || prepare.transaction_id !== transactionId || !selfDigestValid(prepare, 'prepare_digest')
      || prepare.bundle_digest !== bundle.bundle_digest) throw error;
    if (bundle.plan_epoch === committed.pointer.plan_epoch) {
      if (committed.pointer.activation_run_event_digest !== activationRunEventDigest
        || committed.pointer.activation_control_event_digest !== activationControlEventDigest) throw error;
      return { bundle: committed.bundle, pointer: committed.pointer };
    }
  }
  if (!validateRuntimeEpochBundle(bundle)
    || bundle.plan_epoch !== committed.pointer.plan_epoch + 1
    || bundle.predecessor_bundle_digest !== committed.bundle.bundle_digest) {
    fail('EPOCH_BUNDLE_CONFLICT', 'staged successor bindingが不正');
  }
  const runEvents = await readRegularJson(path.join(runDir, 'events.json'), 'run events');
  const controlEvents = typeof readActivationControlEvents === 'function'
    ? await readActivationControlEvents()
    : await readRegularJson(path.join(runDir, 'control-events.json'), 'runtime control events');
  const evidence = activationEvidence(runEvents, controlEvents, activationRunEventDigest,
    activationControlEventDigest, bundle.run_id, bundle.plan);
  if (!Object.values(evidence).every((entry) => entry.chain_valid && entry.expected_in_chain
      && entry.conflicting_event_digest === null)) {
    fail('EPOCH_ACTIVATION_INCOMPLETE',
      `successor activation event prefixが未耐久化又は矛盾: ${JSON.stringify(evidence)}`, evidence);
  }
  const epochsDir = path.join(runDir, 'epochs');
  const epochDir = path.join(epochsDir, String(bundle.plan_epoch).padStart(8, '0'));
  try {
    if (!alreadyRenamed) {
      await rename(transactionDir, epochDir);
      await fsyncDirectory(epochsDir);
      await fsyncDirectory(path.join(runDir, 'staging'));
    } else {
      await fsyncDirectory(epochDir);
      await fsyncDirectory(epochsDir);
    }
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    const existing = await readRegularJson(path.join(epochDir, 'epoch-bundle.json'), 'committed successor bundle');
    if (!validateRuntimeEpochBundle(existing) || existing.bundle_digest !== bundle.bundle_digest) {
      fail('EPOCH_BUNDLE_CONFLICT', 'successor epoch concurrent commitが異なる');
    }
  }
  const pointer = {
    schema: 'lattice.committed_epoch_pointer.v1', run_id: bundle.run_id,
    plan_epoch: bundle.plan_epoch, plan_ref: bundle.plan.plan_ref,
    bundle_digest: bundle.bundle_digest, activation_run_event_digest: activationRunEventDigest,
    activation_control_event_digest: activationControlEventDigest,
  };
  pointer.pointer_digest = digestArtifact(pointer);
  await replaceDurableJson(runDir, 'committed-epoch.json', pointer);
  return { bundle, pointer, activation_evidence: evidence };
}

export async function commitReleaseEpochBarrier({ runDir, barrier }) {
  if (!exactRecord(barrier, ['schema', 'run_id', 'committed_epoch_pointer_digest',
    'plan_epoch', 'activation_digest', 'controller_ready_ack_digests',
    'staged_lease_digests', 'gate_generation', 'release_digest'])
    || barrier.schema !== 'lattice.release_epoch_barrier.v1'
    || !HEX_DIGEST.test(barrier.committed_epoch_pointer_digest ?? '')
    || !HEX_DIGEST.test(barrier.activation_digest ?? '')
    || !Array.isArray(barrier.controller_ready_ack_digests)
    || !Array.isArray(barrier.staged_lease_digests)
    || !barrier.controller_ready_ack_digests.every((value, index) => HEX_DIGEST.test(value)
      && (index === 0 || barrier.controller_ready_ack_digests[index - 1] < value))
    || !barrier.staged_lease_digests.every((value, index) => HEX_DIGEST.test(value)
      && (index === 0 || barrier.staged_lease_digests[index - 1] < value))
    || !selfDigestValid(barrier, 'release_digest')) {
    fail('EPOCH_ACTIVATION_INCOMPLETE', 'release epoch barrier contractが不正');
  }
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null || barrier.run_id !== committed.meta.run_id
    || barrier.plan_epoch !== committed.pointer.plan_epoch
    || barrier.committed_epoch_pointer_digest !== committed.pointer.pointer_digest
    || !Number.isSafeInteger(barrier.gate_generation) || barrier.gate_generation < 1) {
    fail('EPOCH_ACTIVATION_INCOMPLETE', 'release barrierがcommitted pointerへbindしない');
  }
  await replaceDurableJson(runDir, 'release-epoch.json', barrier);
  return { release_digest: barrier.release_digest };
}

export async function isManagedRunFrozen(runDir, events) {
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null) return false;
  const lastFreeze = events.findLast((event) => event.kind === 'intake_frozen');
  const lastResume = events.findLast((event) => event.kind === 'intake_resumed'
    && event.plan_epoch === committed.pointer.plan_epoch);
  const hasFreeze = lastFreeze !== undefined
    && (lastResume === undefined || lastResume.sequence < lastFreeze.sequence);
  let gateValid = false;
  try {
    const gate = await readRegularJson(path.join(runDir, 'supervisor', 'write-gate.json'), 'supervisor write gate');
    gateValid = exactRecord(gate, [
      'schema', 'run_id', 'plan_epoch', 'gate_generation', 'release_barrier_digest',
      'controller_release_ack_digests', 'armed_lease_digests', 'previous_gate_digest',
      'committed_at', 'gate_digest',
    ]) && gate.schema === 'lattice.supervisor_write_gate.v1'
      && gate.run_id === committed.meta.run_id
      && gate.plan_epoch === committed.pointer.plan_epoch
      && selfDigestValid(gate, 'gate_digest');
  } catch (error) {
    if (!(error instanceof RuntimeEpochStoreError)) throw error;
  }
  return hasFreeze || !gateValid;
}
