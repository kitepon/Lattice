import { canonicalizeArtifact, digestArtifact } from './artifact-contracts.mjs';
// 切断可能性の写像はtodo側と同じ正本を使う。計画時と実行時で「切れる種類」の定義が
// 分かれると、同じ資源が段によって別の答えを持つ。
import { severabilityOfConflictKind } from './todo-independence-contracts.mjs';
import { buildNextRunEvent, buildExecutorPackets } from './runtime-engine.mjs';
import { projectRuntimeState } from './runtime-projection.mjs';
import {
  recomputeHoldDecision,
  verifyCarryOverWitness,
} from './runtime-decision-verifier.mjs';
import {
  computeContextContentDigest,
  RUN_REQUEST_SCHEMA,
  selfDigest,
  validateCarryOverWitness,
  validateEpochRebindPacket,
  validateHoldDecision,
  validateRunRequest,
  validateRuntimePlan,
  validateRuntimePlanDiff,
  verifyRuntimePlanBinding,
} from './runtime-contracts.mjs';

/**
 * RC3-G 後発競合のselective holdとplan vN+1 recompile（ADR 0044 Decision 6・7、plan RC3-G）。
 *
 * producer側の裁定実装。affected closure・hold／continue集合は
 * `runtime-decision-verifier.mjs`と独立に計算した上で、保存bytesからの
 * verifier再計算とのexact一致をfail-loudに自己検査する（divergenceは即例外）。
 *
 * - 競合発見時はactive planへ追記しない。frozen prefixを固定してclosureを計算し、
 *   closure外のin-flight TODOはcarry-over witnessを実証できた場合だけ継続する。
 *   1 fieldでも証明不能ならholdへ戻す（fail closed、silent fallbackなし）。
 * - carry-overは旧contextの継続利用ではない。content digest不変・epochだけ更新の
 *   epoch rebind packetによる、失効後の再認可である（Decision 7.3）。
 * - 旧plan・旧context・partial patchはcontext_invalidated eventで失効し、
 *   redispatch TODOへは新plan_ref由来の別contentのpacketを発行する。
 * - irreducible conflictはprecedenceへ偽装せず、unordered conflictのまま
 *   intentional serialとして保持する（Decision 7.6）。
 */

function fail(reason) {
  throw new TypeError(`hold/recompile契約違反: ${reason}`);
}

function plainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactRecord(value, keys) {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function sorted(values) {
  return [...values].sort();
}

function sha16(value) {
  return digestArtifact({ path: value }).slice(0, 16);
}

const WITNESS_KINDS = Object.freeze(['state', 'schema', 'invariant', 'effect', 'external_effect']);
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/u;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function selfDigestValid(value, field) {
  return plainRecord(value) && HEX_DIGEST.test(value[field] ?? '')
    && selfDigest(value, field) === value[field];
}

function sortedUnique(values, predicate) {
  return Array.isArray(values) && values.every(predicate)
    && values.every((value, index) => index === 0
      || canonicalizeArtifact(values[index - 1]) < canonicalizeArtifact(value));
}

function primaryFirstUnique(values, predicate) {
  if (!Array.isArray(values) || !values.every(predicate)
    || new Set(values).size !== values.length) return false;
  const tail = values.slice(1);
  return tail.every((value, index) => index === 0
    || canonicalizeArtifact(tail[index - 1]) < canonicalizeArtifact(value));
}

/** ADR 0064 Decision 5のfull predecessor→successor mapping。 */
export function validateRuntimeTaskMigration(value, { predecessorTaskIds = null,
  successorTaskIds = null } = {}) {
  if (!exactRecord(value, ['schema', 'entries', 'migration_digest'])
    || value.schema !== 'lattice.runtime_task_migration.v1'
    || !Array.isArray(value.entries) || value.entries.length > 10_000
    || !selfDigestValid(value, 'migration_digest')) return false;
  const predecessor = [];
  const successorOwners = new Map();
  for (const entry of value.entries) {
    if (!exactRecord(entry, ['predecessor_task_id', 'disposition', 'successor_task_ids',
      'reason', 'evidence_digests'])
      || !IDENTIFIER.test(entry.predecessor_task_id ?? '')
      || !['carry', 'replace', 'split', 'retire', 'stay'].includes(entry.disposition)
      || typeof entry.reason !== 'string' || entry.reason.length === 0
      || !primaryFirstUnique(entry.successor_task_ids, (id) => IDENTIFIER.test(id))
      || !sortedUnique(entry.evidence_digests, (digest) => HEX_DIGEST.test(digest))) return false;
    if (['carry', 'stay'].includes(entry.disposition)
      && canonicalizeArtifact(entry.successor_task_ids) !== canonicalizeArtifact([entry.predecessor_task_id])) return false;
    if (entry.disposition === 'retire' && entry.successor_task_ids.length !== 0) return false;
    if (['replace', 'split'].includes(entry.disposition) && entry.successor_task_ids.length === 0) return false;
    predecessor.push(entry.predecessor_task_id);
    for (const id of entry.successor_task_ids) {
      const owners = successorOwners.get(id) ?? [];
      owners.push(entry.predecessor_task_id);
      successorOwners.set(id, owners);
    }
  }
  if (!sortedUnique(predecessor, (id) => IDENTIFIER.test(id))) return false;
  if ([...successorOwners.values()].some((owners) => owners.length !== 1)) return false;
  if (predecessorTaskIds !== null
    && canonicalizeArtifact(predecessor) !== canonicalizeArtifact(sorted(predecessorTaskIds))) return false;
  if (successorTaskIds !== null) {
    const mapped = sorted(successorOwners.keys());
    if (canonicalizeArtifact(mapped) !== canonicalizeArtifact(sorted(successorTaskIds))) return false;
  }
  return true;
}

export function validateRunRequestV2(value) {
  if (!exactRecord(value, ['schema', 'request_id', 'repo', 'capacity', 'todos', 'manual_witness',
    'sensor_query_set', 'executor_capability', 'claim_mode', 'predecessor_request_digest',
    'task_migration_digest', 'request_digest'])
    || value.schema !== 'lattice.run_request.v2'
    || !HEX_DIGEST.test(value.predecessor_request_digest ?? '')
    || !HEX_DIGEST.test(value.task_migration_digest ?? '')
    || !selfDigestValid(value, 'request_digest')) return false;
  const projected = {
    // 後継requestの本体はbase契約と同じ規律で読む。v1へ固定すると、創作境界を持つ
    // 宣言が再計画を跨げない（ADR 0136）。
    schema: RUN_REQUEST_SCHEMA, request_id: value.request_id, repo: value.repo,
    capacity: value.capacity, todos: value.todos, manual_witness: value.manual_witness,
    sensor_query_set: value.sensor_query_set, executor_capability: value.executor_capability,
    claim_mode: value.claim_mode, request_digest: '',
  };
  projected.request_digest = selfDigest(projected, 'request_digest');
  return validateRunRequest(projected);
}

export function validateRuntimeRecompileRequest(value, { predecessorBundle = null,
  frozenEventDigest = null, holdDecisionDigest = null, validatePhaseRevision = null } = {}) {
  if (!exactRecord(value, ['schema', 'request_id', 'run_id', 'predecessor_epoch',
    'frozen_event_digest', 'hold_decision_digest', 'mode', 'reason', 'successor_request',
    'task_migration', 'phase_revision', 'seam_split', 'intentional_serial', 'request_digest'])
    || value.schema !== 'lattice.runtime_recompile_request.v1'
    || !IDENTIFIER.test(value.request_id ?? '') || !IDENTIFIER.test(value.run_id ?? '')
    || !Number.isSafeInteger(value.predecessor_epoch) || value.predecessor_epoch < 1
    || !HEX_DIGEST.test(value.frozen_event_digest ?? '')
    || !HEX_DIGEST.test(value.hold_decision_digest ?? '')
    || !['seam_split', 'intentional_serial'].includes(value.mode)
    || typeof value.reason !== 'string' || value.reason.length === 0
    || !validateRunRequestV2(value.successor_request)
    || !validateRuntimeTaskMigration(value.task_migration, {
      predecessorTaskIds: predecessorBundle?.plan?.nodes?.map(({ todo_id: id }) => id) ?? null,
      successorTaskIds: value.successor_request.todos?.map(({ todo_id: id }) => id) ?? null,
    })
    || value.successor_request.request_id !== value.run_id
    || value.successor_request.task_migration_digest !== value.task_migration.migration_digest
    || !selfDigestValid(value, 'request_digest')) return false;
  if (predecessorBundle !== null
    && (value.predecessor_epoch !== predecessorBundle.plan_epoch
      || value.successor_request.predecessor_request_digest !== predecessorBundle.request.request_digest)) return false;
  if (frozenEventDigest !== null && value.frozen_event_digest !== frozenEventDigest) return false;
  if (holdDecisionDigest !== null && value.hold_decision_digest !== holdDecisionDigest) return false;
  if (value.phase_revision === null) {
    // phase revisionを省略できるのは、TODO/source/edge入力とtask identityが完全に不変な時だけ。
    // intentional_serialのruntime conflict edgeはplan overlayでありTODO工程revisionではない。
    if (predecessorBundle !== null) {
      const predecessorRequest = predecessorBundle.request;
      const stableInputs = ['todos', 'manual_witness', 'sensor_query_set'];
      if (stableInputs.some((key) => canonicalizeArtifact(value.successor_request[key])
        !== canonicalizeArtifact(predecessorRequest[key]))) return false;
      if (value.task_migration.entries.some((entry) => !['stay', 'carry'].includes(entry.disposition)
        || entry.successor_task_ids.length !== 1
        || entry.successor_task_ids[0] !== entry.predecessor_task_id)) return false;
    }
  } else if (typeof validatePhaseRevision !== 'function'
    || validatePhaseRevision(structuredClone(value.phase_revision)) !== true
    || canonicalizeArtifact(value.phase_revision.runtime_task_migration)
      !== canonicalizeArtifact(value.task_migration)) return false;
  if (value.mode === 'seam_split') {
    if (value.intentional_serial !== null || !validateRuntimeSeamSplit(value.seam_split, value)) return false;
    if (value.phase_revision === null && [
      value.seam_split.ownership_diff.added, value.seam_split.ownership_diff.removed,
      value.seam_split.edge_diff.added, value.seam_split.edge_diff.removed,
    ].some((entries) => entries.length > 0)) return false;
  } else if (value.seam_split !== null || !validateRuntimeIntentionalSerial(value.intentional_serial, value)) return false;
  return true;
}

function validateRuntimeSeamSplit(value, request) {
  return exactRecord(value, ['schema', 'finding_digest', 'predecessor_task_ids',
    'task_migration_digest', 'ownership_diff', 'edge_diff', 'verifier_refs', 'split_digest'])
    && value.schema === 'lattice.runtime_seam_split.v1'
    && HEX_DIGEST.test(value.finding_digest ?? '')
    && sortedUnique(value.predecessor_task_ids, (id) => IDENTIFIER.test(id))
    && value.task_migration_digest === request.task_migration.migration_digest
    && validateOwnershipDiff(value.ownership_diff) && validateEdgeDiff(value.edge_diff)
    && sortedUnique(value.verifier_refs, (ref) => typeof ref === 'string' && ref.length > 0)
    && selfDigestValid(value, 'split_digest');
}

function validateOwnershipDiff(value) {
  const entry = (item) => exactRecord(item, ['resource_id', 'owner_todo_id', 'access_kind'])
    && IDENTIFIER.test(item.resource_id ?? '') && IDENTIFIER.test(item.owner_todo_id ?? '')
    && ['read', 'write', 'own'].includes(item.access_kind);
  return exactRecord(value, ['schema', 'added', 'removed', 'diff_digest'])
    && value.schema === 'lattice.runtime_ownership_diff.v1'
    && sortedUnique(value.added, entry) && sortedUnique(value.removed, entry)
    && selfDigestValid(value, 'diff_digest');
}

function validateEdgeDiff(value) {
  const entry = (item) => exactRecord(item, ['from_todo_id', 'to_todo_id', 'kind'])
    && IDENTIFIER.test(item.from_todo_id ?? '') && IDENTIFIER.test(item.to_todo_id ?? '')
    && ['hard_dependency', 'conflict'].includes(item.kind);
  return exactRecord(value, ['schema', 'added', 'removed', 'diff_digest'])
    && value.schema === 'lattice.runtime_edge_diff.v1'
    && sortedUnique(value.added, entry) && sortedUnique(value.removed, entry)
    && selfDigestValid(value, 'diff_digest');
}

function validateRuntimeIntentionalSerial(value, request) {
  if (!exactRecord(value, ['schema', 'finding_digest', 'todo_ids', 'resource_id',
    'stay_todo_id', 'reason', 'serial_digest'])
    || value.schema !== 'lattice.runtime_intentional_serial.v1'
    || !HEX_DIGEST.test(value.finding_digest ?? '')
    || !sortedUnique(value.todo_ids, (id) => IDENTIFIER.test(id)) || value.todo_ids.length < 2
    || !IDENTIFIER.test(value.resource_id ?? '') || !value.todo_ids.includes(value.stay_todo_id)
    || typeof value.reason !== 'string' || value.reason.length === 0
    || !selfDigestValid(value, 'serial_digest')) return false;
  const byId = new Map(request.task_migration.entries.map((entry) => [entry.predecessor_task_id, entry]));
  return value.todo_ids.every((id) => byId.has(id))
    && byId.get(value.stay_todo_id)?.disposition === 'stay';
}

function manifestResourceIds(manifest) {
  const ids = new Set(manifest?.resources ?? []);
  for (const effect of manifest?.state_effects ?? []) {
    if (WITNESS_KINDS.includes(effect.kind) && typeof effect.resource_id === 'string') {
      ids.add(effect.resource_id);
    }
  }
  return ids;
}

/** producer独自のaffected closure計算（conflict edge伝播＋共有resource witness到達）。 */
function computeAffectedClosure(plan, manifests, seedTodoIds) {
  const closure = new Set(seedTodoIds);
  const byResource = new Map();
  for (const [todoId, manifest] of Object.entries(manifests)) {
    for (const resourceId of manifestResourceIds(manifest)) {
      const members = byResource.get(resourceId) ?? new Set();
      members.add(todoId);
      byResource.set(resourceId, members);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const conflict of plan.conflicts) {
      const [left, right] = conflict.todo_ids;
      if (closure.has(left) !== closure.has(right)) {
        closure.add(left);
        closure.add(right);
        changed = true;
      }
    }
    // hard predecessorの下流はaffected（前提が失効するため。Decision 6.3）。
    for (const edge of plan.precedence) {
      if (closure.has(edge.from_todo_id) && !closure.has(edge.to_todo_id)) {
        closure.add(edge.to_todo_id);
        changed = true;
      }
    }
    for (const todoId of [...closure]) {
      const manifest = manifests[todoId];
      if (manifest === undefined) continue;
      for (const resourceId of manifestResourceIds(manifest)) {
        for (const member of byResource.get(resourceId) ?? []) {
          if (!closure.has(member)) {
            closure.add(member);
            changed = true;
          }
        }
      }
    }
  }
  return closure;
}

/** runtime findingから、停止・再計画する作業群だけを取り出す。 */
export function affectedTodoIds(plan, manifests, seedTodoIds) {
  return sorted(computeAffectedClosure(plan, manifests, seedTodoIds));
}

/**
 * carry-over witness documentを構築し、提供sourcesに対して自己実証する。
 * 実証できない場合はnullでなくreasons付きの失敗を返す（呼び出し側がholdへ戻す）。
 */
export function buildCarryOverWitness(options = {}) {
  if (!exactRecord(options, [
    'todoId', 'predecessorEpoch', 'successorEpoch', 'sources', 'nonOverlapEvidence', 'receiptBindings',
  ])) {
    fail('buildCarryOverWitness optionsがexact shapeでない');
  }
  const { todoId, predecessorEpoch, successorEpoch, sources, nonOverlapEvidence, receiptBindings } = options;
  const witness = {
    schema: 'lattice.carry_over_witness.v1',
    witness_id: `witness-${todoId}-e${successorEpoch}`,
    todo_id: todoId,
    predecessor_epoch: predecessorEpoch,
    successor_epoch: successorEpoch,
    invariant_digests: {
      todo_input: digestArtifact(sources.todo_input),
      boundary_manifest: digestArtifact(sources.boundary_manifest),
      validator: digestArtifact(sources.validator),
      context_content: digestArtifact(sources.context_content),
    },
    non_overlap_evidence: [...nonOverlapEvidence],
    receipt_bindings: structuredClone(receiptBindings),
  };
  witness.witness_digest = selfDigest(witness, 'witness_digest');
  // 構築不能はthrowでなくtyped失敗で返す（呼び出し側がholdへ戻すため）。
  if (!validateCarryOverWitness(witness)) {
    return { witness: null, reasons: ['witness_schema', 'carry_over_unprovable'] };
  }
  const verified = verifyCarryOverWitness({ witness, sources });
  if (!verified.valid) {
    return { witness: null, reasons: verified.reasons };
  }
  return { witness, reasons: [] };
}

/**
 * frozen prefixからhold decisionを裁定し、carry_over_witnessed／hold_decided eventを
 * 追記する。continueできるのはwitnessを実証済みのclosure外running TODOだけで、
 * 証明不能TODOはholdへ戻す。裁定はverifier再計算とのexact一致を自己検査する。
 */
export function decideHoldAndCarryOver(options = {}) {
  if (!exactRecord(options, [
    'runId', 'request', 'plan', 'manifests', 'packets', 'events', 'recordedAt',
  ])) {
    fail('decideHoldAndCarryOver optionsがexact shapeでない');
  }
  const { runId, request, plan, manifests, packets, events, recordedAt } = options;
  if (!validateRuntimePlan(plan)) fail('planがruntime_plan.v1 contractを満たさない');
  if (!validateRunRequest(request)) fail('requestがrun_request.v1 contractを満たさない');

  const state = projectRuntimeState({ events });
  if (state.freeze === null) fail('freezeされていないprefixからholdを裁定できない');
  const freezeSequence = state.freeze.sequence;
  // seedは現plan epochのconflictだけにする（過去epochで処理済みのconflictを
  // 再seedしない。二度目以降のfreezeでの再混入防止）。
  const currentEpochConflictSequences = new Set(events
    .filter((event) => event.kind === 'conflict_found' && event.plan_epoch === plan.plan_epoch)
    .map((event) => event.sequence));
  const frozenConflicts = state.conflicts.filter((conflict) => (
    conflict.sequence <= freezeSequence && currentEpochConflictSequences.has(conflict.sequence)
  ));
  if (frozenConflicts.length === 0) fail('frozen prefix内にconflict findingがない');

  const seed = frozenConflicts.flatMap((conflict) => conflict.todo_ids ?? []);
  const closure = computeAffectedClosure(plan, manifests, seed);

  // frozen prefix時点のrunning集合（producer独自計算）。
  const frozenRunning = new Set();
  for (const event of events) {
    if (event.sequence > freezeSequence) continue;
    if (event.kind === 'executor_dispatched' && event.subject?.kind === 'todo') {
      frozenRunning.add(event.subject.ref);
    }
    if ((event.kind === 'receipt_accepted' || event.kind === 'executor_terminal')
      && event.subject?.kind === 'todo') {
      frozenRunning.delete(event.subject.ref);
    }
  }

  const conflictEventDigests = events
    .filter((event) => event.kind === 'conflict_found' && event.sequence <= freezeSequence)
    .map((event) => event.event_digest);

  let next = [...events];
  const holdSet = new Set();
  const continueSet = new Set();
  const witnessFailures = {};

  // 競合findingが指すpath集合（carry-over候補の非交差検査に使う）。
  const findingPaths = new Set(frozenConflicts.flatMap((conflict) => (
    typeof conflict.path === 'string' ? [conflict.path] : (conflict.paths ?? [])
  )));

  for (const todoId of sorted(frozenRunning)) {
    if (closure.has(todoId)) {
      holdSet.add(todoId);
      continue;
    }
    // u03 C43 (claim 10): closure外は影響群でない限りcontinue。witnessは実証できた時だけ記録する。
    const packet = packets[todoId];
    // freeze後に当該TODOの未取り込みdiff／receipt eventが存在するなら
    // carry-over不能（Decision 7.2「freeze後に未取り込みdiff eventが存在しない」）。
    const postFreezeEvents = events.some((event) => (
      event.sequence > freezeSequence
      && event.subject?.kind === 'todo'
      && event.subject.ref === todoId
      && ['checkpoint_observed', 'receipt_recorded'].includes(event.kind)
      && event.payload?.barrier_final !== true
    ));
    const declaredWrites = manifests[todoId]?.writes ?? [];
    // 競合finding pathと当該TODOのdeclared write／観測pathが交差するなら
    // 非交差を証明できない（Decision 7.2の changed scope 非交差条件）。
    const observedPaths = state.checkpoints
      .filter((entry) => entry.todo_id === todoId && entry.sequence <= freezeSequence)
      .flatMap((entry) => (entry.payload?.diff?.entries ?? []).map(({ path }) => path));
    const intersects = [...findingPaths].some((findingPath) => (
      declaredWrites.some((declared) => (
        declared === findingPath || (declared.endsWith('/') && findingPath.startsWith(declared))
      ))
      || observedPaths.includes(findingPath)
    ));
    if (intersects) {
      holdSet.add(todoId);
      witnessFailures[todoId] = ['finding_scope_overlap'];
      continue;
    }
    // witnessを作れない理由はcontinueを妨げない。記録だけ返す。
    if (packet === undefined || manifests[todoId] === undefined) {
      continueSet.add(todoId);
      witnessFailures[todoId] = ['missing_packet_or_manifest'];
      continue;
    }
    if (postFreezeEvents) {
      continueSet.add(todoId);
      witnessFailures[todoId] = ['post_freeze_events'];
      continue;
    }
    const receiptBindings = state.receipts
      .filter((receipt) => (
        receipt.todo_id === todoId
        && receipt.sequence <= freezeSequence
        && receipt.accepted_sequence === null
        && receipt.rejected_sequence === null
      ))
      .map((receipt) => ({
        receipt_id: receipt.receipt_id,
        checkpoint_digest: receipt.payload?.checkpoint_digest ?? '0'.repeat(64),
        recorded_sequence: receipt.sequence,
        within_frozen_prefix: true,
      }));
    const sources = {
      todo_input: request.manual_witness[todoId],
      boundary_manifest: manifests[todoId],
      validator: packet.verifier_refs,
      context_content: {
        todo_id: packet.todo_id,
        task_ref: packet.task_ref,
        scope: packet.scope,
        base_sha: packet.base_sha,
        verifier_refs: packet.verifier_refs,
        forbidden_operations: packet.forbidden_operations,
      },
    };
    const built = buildCarryOverWitness({
      todoId,
      predecessorEpoch: plan.plan_epoch,
      successorEpoch: plan.plan_epoch + 1,
      sources,
      nonOverlapEvidence: conflictEventDigests.map((digest) => `conflict_found#${digest.slice(0, 16)}`),
      receiptBindings,
    });
    if (built.witness === null) {
      continueSet.add(todoId);
      witnessFailures[todoId] = built.reasons;
      continue;
    }
    next.push(buildNextRunEvent({
      events: next,
      runId,
      kind: 'carry_over_witnessed',
      planEpoch: plan.plan_epoch,
      subject: { kind: 'todo', ref: todoId },
      payload: { witness_digest: built.witness.witness_digest, witness: built.witness },
      recordedAt,
    }));
    continueSet.add(todoId);
  }
  for (const todoId of closure) {
    if (!continueSet.has(todoId)) holdSet.add(todoId);
  }

  const holdDecision = {
    schema: 'lattice.hold_decision.v1',
    decision_id: `hold-${runId}-seq${freezeSequence}`,
    finding: structuredClone(frozenConflicts.at(-1)),
    frozen_prefix_digest: state.freeze.frozen_prefix_digest ?? digestArtifact(
      events.filter((event) => event.sequence <= freezeSequence).map((event) => event.event_digest),
    ),
    affected_closure: sorted(closure),
    hold_set: sorted(holdSet),
    continue_set: sorted(continueSet),
    evidence_digests: conflictEventDigests,
  };
  holdDecision.decision_digest = selfDigest(holdDecision, 'decision_digest');
  if (!validateHoldDecision(holdDecision)) fail('hold decisionがcontractを満たさない');

  next.push(buildNextRunEvent({
    events: next,
    runId,
    kind: 'hold_decided',
    planEpoch: plan.plan_epoch,
    subject: { kind: 'runtime_plan', ref: plan.plan_ref },
    payload: structuredClone(holdDecision),
    recordedAt,
  }));

  // 独立verifierとのexact一致を自己検査する（divergenceはfail loud）。
  const recomputed = recomputeHoldDecision({ plan, events: next, manifests });
  if (JSON.stringify(recomputed.hold_set) !== JSON.stringify(holdDecision.hold_set)
    || JSON.stringify(recomputed.continue_set) !== JSON.stringify(holdDecision.continue_set)) {
    fail(`hold裁定がverifier再計算と一致しない: producer=${JSON.stringify({
      hold: holdDecision.hold_set, continue: holdDecision.continue_set,
    })} verifier=${JSON.stringify({ hold: recomputed.hold_set, continue: recomputed.continue_set })}`);
  }

  return { events: next, holdDecision, witnessFailures };
}

/**
 * 競合findingをtreatment laneへ送る（Decision 7.6）。
 * predeclared treatmentがfindingのpath集合を覆う場合だけseam laneを返し、
 * それ以外（shared state/effect・未宣言path競合）はintentional serialにする。
 */
/**
 * 同じ競合が何epochにわたって観測されたかを数える。
 *
 * 過去epochのconflictを再seedしないguardは既に在るが、**新しく観測された同じ競合**は毎epoch
 * seedされる。原因が続く限り「hold→再計画→再開→また同じ競合」が繰り返せる。
 * 誤帰属でも、scope違反を繰り返すworkerでも、変換で解けない競合でも同じことが起きる。
 *
 * 鍵は種別・資源・関与task対である。plan_epochで数えるのは、同一epoch内の複数回観測を
 * 繰り返しと数えないためで、再計画を1回挟んで再び現れたことだけを繰り返しとする。
 */
export function countConflictRecurrence(events = []) {
  const epochsByKey = new Map();
  for (const event of events) {
    if (event?.kind !== 'conflict_found') continue;
    const finding = event.payload ?? {};
    if (typeof finding.kind !== 'string' || !Array.isArray(finding.todo_ids)) continue;
    const key = [
      finding.kind,
      typeof finding.path === 'string' ? finding.path : '',
      [...finding.todo_ids].sort(compareText).join(','),
    ].join('\u0000');
    if (!epochsByKey.has(key)) epochsByKey.set(key, new Set());
    epochsByKey.get(key).add(event.plan_epoch);
  }
  return epochsByKey;
}

/**
 * 再計画で解けていない競合。1つでもあれば、もう一度同じ処置を試しても収束しない。
 *
 * 既定の閾値を3とするのは、1回目は通常の競合、2回目は再計画が効かなかった可能性（順序の綾を
 * 含む）、3回目で「同じことが繰り返されている」と言えるためである。直列化で誤魔化さない——
 * 誤帰属が原因なら直列化しても解けず、解けないことを解けたように見せることになる。
 */
export const NON_CONVERGENT_EPOCH_THRESHOLD = 3;

export function detectNonConvergentConflicts(options = {}) {
  if (!exactRecord(options, ['events']) && !exactRecord(options, ['events', 'threshold'])) {
    fail('detectNonConvergentConflicts optionsがexact shapeでない');
  }
  const { events, threshold = NON_CONVERGENT_EPOCH_THRESHOLD } = options;
  if (!Array.isArray(events)) fail('eventsがarrayでない');
  if (!Number.isSafeInteger(threshold) || threshold < 2) fail('thresholdが2以上の整数でない');
  const recurrence = countConflictRecurrence(events);
  const entries = [];
  for (const [key, epochs] of recurrence) {
    if (epochs.size < threshold) continue;
    const [kind, resource, todoIds] = key.split('\u0000');
    entries.push({
      kind,
      resource,
      todo_ids: todoIds === '' ? [] : todoIds.split(','),
      epochs: [...epochs].sort((left, right) => left - right),
    });
  }
  return entries.sort((left, right) => compareText(
    `${left.kind}\u0000${left.resource}\u0000${left.todo_ids.join(',')}`,
    `${right.kind}\u0000${right.resource}\u0000${right.todo_ids.join(',')}`,
  ));
}

/**
 * 係争資源が構造的に切れる種類かを返す（ADR 0144の続き、請求項8の入口判定）。
 *
 * pathやsymbolは面を分ければ別々に所有できる。共有stateや外部effectは分けられない——
 * 変換をどれだけ工夫しても同じ資源に触り続ける。**これは「切れる」ではなく「切れる種類だ」で
 * あって、実際に切れるかは試して初めて分かる。**
 */
export function severabilityOfRuntimeFinding(finding) {
  return severabilityOfConflictKind(typeof finding?.path === 'string' ? 'path' : 'state');
}

/**
 * 競合をどちらの処置へ運ぶか（請求項7＝直列化／請求項8＝変換）。
 *
 * `seam_transform`を返すのは事前宣言済みtreatmentが係争pathを覆っている時だけである。
 * それ以外の既定は直列化だが、**それは「変換が不可能」という意味ではない**。実行時に初めて
 * 見つかった競合には事前宣言が無いので、既定だけを見ると請求項8へ行く道が無いように見える。
 *
 * そこで`severability`と`transform_attemptable`を併せて返す。装置が言えるのは「切れる種類の
 * 資源か」までで、**実際の難しさは変換を試して五条件で測る**（`run seam resolve`）。試すかどうかは
 * 費用のかかる判断なので装置が決めない——隔離worktreeでの変換、focused test、再indexを毎回
 * 走らせるかは、操作するAIが持つ文脈で決める（AGENTS.md「装置の境界にAIを含める」）。
 */
export function routeConflictTreatment(options = {}) {
  if (!exactRecord(options, ['finding', 'predeclaredTreatments'])) {
    fail('routeConflictTreatment optionsがexact shapeでない');
  }
  const { finding, predeclaredTreatments } = options;
  if (!plainRecord(finding) || typeof finding.kind !== 'string') fail('findingが不正');
  const severability = severabilityOfRuntimeFinding(finding);
  if (finding.kind === 'observed_write_conflict' && typeof finding.path === 'string') {
    for (const treatment of predeclaredTreatments) {
      if (Array.isArray(treatment.covered_paths) && treatment.covered_paths.includes(finding.path)) {
        return { lane: 'seam_transform', treatment: structuredClone(treatment),
          severability, transform_attemptable: true };
      }
    }
  }
  return { lane: 'intentional_serial', treatment: null,
    severability, transform_attemptable: severability === 'code_seam' };
}

/**
 * hold決定後のplan vN+1をcompileする。carried-over TODOへはepoch rebind packet
 * （content不変・epoch/plan refのみ更新）、hold TODOへは新plan_ref由来の
 * 新context packetを発行し、旧contextを失効する。rebind／prepare ack、epoch pointer、
 * controller ready/release ack、中央gate commit前にはepoch_rebound/intake_resumedを発行しない。
 *
 * baseはここでは動かさない。変換で構造が変わった時に後継baseを決めるのは後継run requestで
 * あり、それが本当に変換を含むかは`verifySeamSplitSuccessor`が見る（ADR 0141）。
 */
export function recompileNextEpochPlan(options = {}) {
  if (!exactRecord(options, [
    'runId', 'request', 'plan', 'manifests', 'packets', 'events', 'holdDecision',
    'additionalConflicts', 'recordedAt',
  ])) {
    fail('recompileNextEpochPlan optionsがexact shapeでない');
  }
  const {
    runId, request, plan, manifests, packets, events, holdDecision, additionalConflicts, recordedAt,
  } = options;
  if (!validateRuntimePlan(plan)) fail('planがruntime_plan.v1 contractを満たさない');
  if (!validateHoldDecision(holdDecision)) fail('holdDecisionがcontractを満たさない');
  if (!Array.isArray(additionalConflicts)) fail('additionalConflictsがarrayではない');
  // 同じ競合が閾値のepoch数だけ繰り返しているなら、もう一度同じ処置を試しても収束しない。
  // 直列化やもう1周で誤魔化さず、解けていないことをtypedに述べて止める。
  const nonConvergent = detectNonConvergentConflicts({ events });
  if (nonConvergent.length > 0) {
    fail(`再計画で解けていない競合がある（非収束）: ${nonConvergent
      .map((entry) => `${entry.kind}:${entry.resource}:${entry.todo_ids.join(',')}@${entry.epochs.join('/')}`)
      .join(' ')}`);
  }

  const state = projectRuntimeState({ events });
  if (state.freeze === null) fail('freeze中でないprefixからrecompileできない');

  // 新planは追記でなく全体を再発行する（plan version barrier）。
  const conflictKeys = new Set(plan.conflicts.map((conflict) => (
    `${[...conflict.todo_ids].sort().join(',')}|${conflict.resource_id}`
  )));
  const mergedConflicts = [...plan.conflicts.map((conflict) => structuredClone(conflict))];
  for (const conflict of additionalConflicts) {
    if (!plainRecord(conflict) || !Array.isArray(conflict.todo_ids) || typeof conflict.resource_id !== 'string') {
      fail('additional conflictが不正');
    }
    const key = `${[...conflict.todo_ids].sort().join(',')}|${conflict.resource_id}`;
    if (conflictKeys.has(key)) continue;
    conflictKeys.add(key);
    mergedConflicts.push({ todo_ids: [...conflict.todo_ids].sort(), resource_id: conflict.resource_id });
  }
  mergedConflicts.sort((left, right) => (
    (left.todo_ids[0] < right.todo_ids[0] ? -1 : left.todo_ids[0] > right.todo_ids[0] ? 1 : 0)
    || (left.todo_ids[1] < right.todo_ids[1] ? -1 : left.todo_ids[1] > right.todo_ids[1] ? 1 : 0)
    || (left.resource_id < right.resource_id ? -1 : 1)
  ));

  const newEpoch = plan.plan_epoch + 1;
  const newPlanRef = `plan-${request.request_id}-e${newEpoch}`;
  const acceptedCheckpoints = state.receipts
    .filter((receipt) => receipt.accepted_sequence !== null)
    .map((receipt) => receipt.payload?.checkpoint_digest)
    .filter((digest) => typeof digest === 'string');

  const newPlan = {
    schema: 'lattice.runtime_plan.v1',
    plan_ref: newPlanRef,
    plan_epoch: newEpoch,
    request_digest: request.request_digest,
    base_sha: plan.base_sha,
    nodes: structuredClone(plan.nodes),
    precedence: structuredClone(plan.precedence),
    conflicts: mergedConflicts,
    capacity: structuredClone(plan.capacity),
    manifest_digests: structuredClone(plan.manifest_digests),
    claim: { mode: 'exact_minimum' },
    predecessor_refs: [plan.plan_ref, ...acceptedCheckpoints.map((digest) => `checkpoint:${digest}`)],
  };
  newPlan.plan_digest = selfDigest(newPlan, 'plan_digest');
  if (!validateRuntimePlan(newPlan)) fail('新planがruntime_plan.v1 contractを満たさない');
  if (!verifyRuntimePlanBinding({ plan: newPlan, request })) fail('新planがrequestへbindできない');

  let next = [...events];

  // hold集合のrunning executorを旧epochで終端する（放棄の証拠化。runningから
  // 外れることで、新epochでのredispatchが可能になる）。
  const runningSet = new Set(state.running);
  for (const todoId of holdDecision.hold_set) {
    if (!runningSet.has(todoId)) continue;
    const dispatch = state.dispatches[todoId];
    next.push(buildNextRunEvent({
      events: next,
      runId,
      kind: 'executor_terminal',
      planEpoch: plan.plan_epoch,
      subject: { kind: 'todo', ref: todoId },
      payload: {
        executor_handle: dispatch?.payload?.executor_handle ?? 'unknown',
        terminal_state: 'context_invalidated',
      },
      recordedAt,
    }));
  }

  next.push(buildNextRunEvent({
    events: next,
    runId,
    kind: 'plan_recompiled',
    planEpoch: newEpoch,
    subject: { kind: 'runtime_plan', ref: newPlanRef },
    payload: {
      old_plan_ref: plan.plan_ref,
      new_plan_digest: newPlan.plan_digest,
      hold_decision_digest: holdDecision.decision_digest,
    },
    recordedAt,
  }));

  // 失効するのは停止・再計画対象だけ。closure外のrunning TODOはorigin bindingのまま
  // 継続するため、contextもpartial patchも無効化しない。
  for (const todoId of sorted(holdDecision.hold_set)) {
    next.push(buildNextRunEvent({
      events: next,
      runId,
      kind: 'context_invalidated',
      planEpoch: newEpoch,
      subject: { kind: 'todo', ref: todoId },
      payload: {
        old_plan_ref: plan.plan_ref,
        invalidated: ['agent_context', 'partial_patch', 'interface_assumption', 'boundary_evidence'],
        reauthorized_via: 'redispatch',
      },
      recordedAt,
    }));
  }

  // carried-over TODOがrecompileで追加されるconflictの当事者なら設計矛盾
  // （closureに入っているべき）。fail loudで止める。
  for (const conflict of additionalConflicts) {
    for (const todoId of conflict.todo_ids ?? []) {
      if (holdDecision.continue_set.includes(todoId)) {
        fail(`carried-over TODOが追加conflictの当事者になっている: ${todoId}`);
      }
    }
  }

  // freeze時点のfrozen prefix境界（authorized checkpoint lineageの基準）。
  const freezeSequenceForLineage = events
    .filter((event) => event.kind === 'intake_frozen' && event.plan_epoch === plan.plan_epoch)
    .map((event) => event.sequence)
    .sort((left, right) => left - right)[0] ?? null;

  // restart時は全process barrierになるため、その場合だけcarry-overを現epochへ復元できる
  // rebind packetをbundleへ残す。通常のrecompileでは使わずorigin bindingを維持する。
  const rebindPackets = {};
  for (const todoId of holdDecision.continue_set) {
    const packet = packets[todoId];
    const dispatch = state.dispatches[todoId];
    const witnessRecord = state.witnesses[todoId];
    // shortcut: unwitnessed carry has no rebind packet; it keeps its origin binding, and
    // hold_decided.continue_set (durable) still accepts its receipts after a restart.
    if (witnessRecord?.payload?.witness?.predecessor_epoch !== plan.plan_epoch) continue;
    if (packet === undefined || dispatch === undefined) {
      fail(`carried-over TODOのpacket／dispatchが欠落: ${todoId}`);
    }
    // authorized checkpointはfrozen prefix内の最後の観測checkpoint。checkpointが
    // 一件もないcarry-overはgenesis sentinel（64桁ゼロ、RC3-J ADRで正式裁定予定）。
    const frozenCheckpoints = state.checkpoints.filter((entry) => (
      entry.todo_id === todoId
      && (freezeSequenceForLineage === null || entry.sequence <= freezeSequenceForLineage)
    ));
    const authorizedCheckpointDigest = frozenCheckpoints.length > 0
      ? frozenCheckpoints[frozenCheckpoints.length - 1].payload?.checkpoint_digest ?? '0'.repeat(64)
      : '0'.repeat(64);
    const rebind = {
      schema: 'lattice.epoch_rebind_packet.v1',
      packet_id: `${newPlanRef}-rebind-${todoId}`,
      todo_id: todoId,
      executor_handle: dispatch.payload.executor_handle,
      worktree_id: dispatch.payload.worktree_id,
      witness_digest: witnessRecord.payload.witness_digest,
      context_content_digest: packet.context_content_digest,
      authorized_checkpoint_digest: authorizedCheckpointDigest,
      old_plan_ref: plan.plan_ref,
      new_plan_ref: newPlanRef,
      new_plan_epoch: newEpoch,
    };
    rebind.packet_digest = selfDigest(rebind, 'packet_digest');
    if (!validateEpochRebindPacket(rebind)) fail(`rebind packetがcontractを満たさない: ${todoId}`);
    if (rebind.context_content_digest !== computeContextContentDigest({
      todo_id: packet.todo_id,
      task_ref: packet.task_ref,
      scope: packet.scope,
      base_sha: packet.base_sha,
      verifier_refs: packet.verifier_refs,
      forbidden_operations: packet.forbidden_operations,
    })) {
      fail(`rebindのcontent digestがvN packet contentと一致しない: ${todoId}`);
    }
    rebindPackets[todoId] = rebind;
  }

  // redispatch TODOへは新plan_ref由来の別content packetを発行する。
  const allNewPackets = buildExecutorPackets({ plan: newPlan, manifests });
  const redispatchPackets = Object.fromEntries(
    holdDecision.hold_set.map((todoId) => [todoId, allNewPackets[todoId]]),
  );

  const planDiff = {
    schema: 'lattice.runtime_plan_diff.v1',
    old_plan_ref: plan.plan_ref,
    new_plan_ref: newPlanRef,
    accepted_checkpoints: sorted(acceptedCheckpoints),
    invalidated_contexts: [...holdDecision.hold_set],
    carried_over: [...holdDecision.continue_set],
    redispatched: [...holdDecision.hold_set],
    node_edge_diff: {
      added_nodes: [],
      removed_nodes: [],
      added_conflicts: mergedConflicts.length - plan.conflicts.length,
    },
  };
  planDiff.diff_digest = selfDigest(planDiff, 'diff_digest');
  if (!validateRuntimePlanDiff(planDiff)) fail('plan diffがcontractを満たさない');

  return {
    events: next,
    newPlan,
    planDiff,
    rebindPackets,
    redispatchPackets,
  };
}

/**
 * controller direct ackと中央gate commitが全件揃った後だけrun eventを公開する。
 * producer compileとは分離し、ack前の呼出しは一切のpartial eventを返さない。
 */
export function finalizeRecompileActivation(options = {}) {
  if (!exactRecord(options, ['runId', 'events', 'plan', 'planDiff', 'rebindPackets',
    'rebindAcks', 'gateDigest', 'gateControlEventDigest', 'recordedAt'])) {
    fail('finalizeRecompileActivation optionsがexact shapeでない');
  }
  const { runId, events, plan, planDiff, rebindPackets, rebindAcks, gateDigest,
    gateControlEventDigest, recordedAt } = options;
  if (!validateRuntimePlan(plan) || !validateRuntimePlanDiff(planDiff)
    || !HEX_DIGEST.test(gateDigest ?? '') || !HEX_DIGEST.test(gateControlEventDigest ?? '')
    || !plainRecord(rebindPackets) || !plainRecord(rebindAcks)) {
    fail('activation bindingが不正');
  }
  const packetIds = Object.keys(rebindPackets).sort();
  if (canonicalizeArtifact(Object.keys(rebindAcks).sort()) !== canonicalizeArtifact(packetIds)) {
    fail('rebind ack集合がpacket集合とexact一致しない');
  }
  for (const todoId of packetIds) {
    const packet = rebindPackets[todoId];
    const ack = rebindAcks[todoId];
    if (!validateEpochRebindPacket(packet)
      || !plainRecord(ack) || ack.schema !== 'lattice.executor_epoch_rebind_ack.v1'
      || ack.todo_id !== todoId || ack.rebind_packet_digest !== packet.packet_digest
      || ack.successor_epoch !== plan.plan_epoch || !HEX_DIGEST.test(ack.ack_digest ?? '')
      || !selfDigestValid(ack, 'ack_digest')) fail(`rebind ack bindingが不正: ${todoId}`);
  }
  let next = [...events];
  // 全件を先に検証した後にだけbatchを構築する（partial epoch_rebound禁止）。
  for (const todoId of packetIds) {
    next.push(buildNextRunEvent({ events: next, runId, kind: 'epoch_rebound',
      planEpoch: plan.plan_epoch, subject: { kind: 'todo', ref: todoId },
      payload: structuredClone(rebindPackets[todoId]), recordedAt }));
  }
  next.push(buildNextRunEvent({ events: next, runId, kind: 'intake_resumed',
    planEpoch: plan.plan_epoch, subject: { kind: 'runtime_plan', ref: plan.plan_ref },
    payload: { plan_diff_digest: planDiff.diff_digest, write_gate_digest: gateDigest,
      control_event_digest: gateControlEventDigest }, recordedAt }));
  return { events: next, redispatchTodoIds: [...planDiff.redispatched].sort() };
}
