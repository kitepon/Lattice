import {
  digestTodoArtifact,
  exactRecord,
  isNonNegativeSafeInteger,
  isStrictTodoTimestamp,
  isTodoDigest,
  isTodoIdentifier,
  todoSelfDigest,
} from './todo-contracts.mjs';
import {
  TODO_INDEPENDENCE_CONFLICT_KINDS,
  TODO_INDEPENDENCE_COVERAGE,
  TODO_INDEPENDENCE_SCHEMA,
  TODO_INDEPENDENCE_TASK_LIMIT,
  isGitSha,
  severabilityOfConflictKind,
} from './todo-independence-contracts.mjs';
import {
  SEAM_PROPOSAL_GUIDANCE_CODES,
  seamProposalGuidanceCode,
} from './todo-independence-guidance.mjs';

export const SEAM_PROPOSAL_SCHEMA = 'lattice.seam_proposal.v2';
export const SEAM_PROPOSAL_PROJECTION_SCHEMA = 'lattice.seam_proposal_projection.v1';
export const SEAM_PROPOSAL_VERDICTS = Object.freeze([
  'seam_candidate',
  'intentional_serial',
  'unknown_requires_evidence',
]);
export const SEAM_PROPOSAL_STABLE_SURFACE_ROLES = Object.freeze([
  'composition_test',
  'facade',
  'fixed_oracle',
]);

const LIST_LIMIT = 4_096;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const PROPOSAL_ID = /^seam-[0-9a-f]{64}$/u;
const SURFACE_KINDS = Object.freeze(['path', 'symbol']);
const STABLE_SURFACE_ROLES = new Set(SEAM_PROPOSAL_STABLE_SURFACE_ROLES);

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function boundedText(value, maxBytes = 4_096) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && !CONTROL.test(value) && Buffer.byteLength(value) <= maxBytes;
}

function boundedList(value, validator, { min = 0, max = LIST_LIMIT } = {}) {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every(validator);
}

function strictlySorted(values, key = (value) => value) {
  return values.every((value, index) => index === 0
    || compareText(key(values[index - 1]), key(value)) < 0);
}

function repoRelativePathOrPrefix(value) {
  if (!boundedText(value) || value.startsWith('/') || value.includes('\\')
    || /^[A-Za-z]:/u.test(value)) return false;
  const body = value.endsWith('/') ? value.slice(0, -1) : value;
  return body.length > 0 && body.split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function repoRelativePath(value) {
  return repoRelativePathOrPrefix(value) && !value.endsWith('/');
}

function sourceBinding(value) {
  return exactRecord(value, [
    'independence_schema', 'independence_result_digest', 'witness_set_digest',
    'plan_version', 'topology_digest', 'base_sha',
  ])
    && value.independence_schema === TODO_INDEPENDENCE_SCHEMA
    && isTodoDigest(value.independence_result_digest)
    && isTodoDigest(value.witness_set_digest)
    && isTodoIdentifier(value.plan_version)
    && isTodoDigest(value.topology_digest)
    && isGitSha(value.base_sha);
}

function taskPair(value, taskIds) {
  return Array.isArray(value) && value.length === 2
    && value.every(isTodoIdentifier)
    && compareText(value[0], value[1]) < 0
    && value.every((taskId) => taskIds.has(taskId));
}

function conflictEntry(value, taskIds) {
  return exactRecord(value, ['resource_id', 'kind', 'target', 'task_pairs'])
    && boundedText(value.resource_id)
    && TODO_INDEPENDENCE_CONFLICT_KINDS.includes(value.kind)
    && (value.kind === 'path'
      ? repoRelativePathOrPrefix(value.target)
      : boundedText(value.target))
    && boundedList(value.task_pairs, (pair) => taskPair(pair, taskIds), { min: 1 })
    && strictlySorted(value.task_pairs, (pair) => `${pair[0]}\0${pair[1]}`);
}

function conflictsFormConnectedComponent(conflicts, taskIds) {
  const adjacency = new Map([...taskIds].map((taskId) => [taskId, new Set()]));
  for (const { task_pairs: pairs } of conflicts) {
    for (const [left, right] of pairs) {
      adjacency.get(left).add(right);
      adjacency.get(right).add(left);
    }
  }
  const first = taskIds.values().next().value;
  const visited = new Set([first]);
  const pending = [first];
  while (pending.length > 0) {
    for (const adjacent of adjacency.get(pending.pop())) {
      if (!visited.has(adjacent)) {
        visited.add(adjacent);
        pending.push(adjacent);
      }
    }
  }
  return visited.size === taskIds.size;
}

const surfaceKey = (value) => `${value.kind}\0${value.target}\0${value.path}\0${value.role}`;

function surfaceEntry(value, taskIds, { proposed }) {
  if (!exactRecord(value, ['kind', 'target', 'path', 'role', 'owner_task_ids'])
    || !SURFACE_KINDS.includes(value.kind)
    || !repoRelativePathOrPrefix(value.path)
    || !boundedText(value.target)
    || !isTodoIdentifier(value.role)
    || !boundedList(value.owner_task_ids, isTodoIdentifier, {
      max: proposed ? 1 : TODO_INDEPENDENCE_TASK_LIMIT,
    })
    || !strictlySorted(value.owner_task_ids)
    || !value.owner_task_ids.every((taskId) => taskIds.has(taskId))) return false;
  if (value.kind === 'path' && value.target !== value.path) return false;
  if (value.kind === 'symbol' && !repoRelativePath(value.path)) return false;
  if (!proposed) return true;
  return STABLE_SURFACE_ROLES.has(value.role)
    ? value.owner_task_ids.length === 0
    : value.owner_task_ids.length === 1;
}

/**
 * `candidate_paths`は、同名symbolが複数fileに居た時だけ埋まる（ADR 0134）。
 *
 * 単数の`resolved_path`と併存させるのは、両者が別の事実だからである。前者は「一意に決まった」、
 * 後者は「決まらず、候補はこれだけあった」。候補を持つ受け皿が無かった頃、後者は`unknown`へ
 * 潰れ、宣言の`within`で絞れる情報が記録に残らなかった。一意に決まった時に候補を並べない
 * （空配列に限る）のは、決まった事実と決まらなかった事実を同じ形にしないためである。
 */
function queryEntry(value) {
  return exactRecord(value, [
    'query_id', 'operation', 'target', 'outcome', 'resolved_name', 'resolved_path',
    'candidate_paths', 'result_digest',
  ])
    && isTodoIdentifier(value.query_id)
    && isTodoIdentifier(value.operation)
    && boundedText(value.target)
    && isTodoIdentifier(value.outcome)
    && (value.resolved_name === null || boundedText(value.resolved_name))
    && (value.resolved_path === null || repoRelativePath(value.resolved_path))
    && boundedList(value.candidate_paths, repoRelativePath)
    && strictlySorted(value.candidate_paths)
    && (value.outcome === 'ambiguous'
      ? value.candidate_paths.length >= 2 && value.resolved_path === null
        && boundedText(value.resolved_name)
      : value.candidate_paths.length === 0)
    && isTodoDigest(value.result_digest);
}

/**
 * `query_set_digest` is an external binding to the exact sensor query set input used for
 * collection (the same meaning as `digestArtifact(request.sensor_query_set)` in the runtime
 * front end). That input is not embedded here, so this validator can check only digest shape.
 * `evidence_digest` separately self-seals this record, including that binding and every receipt.
 */
function evidenceEntry(value) {
  return exactRecord(value, ['query_set_digest', 'evidence_digest', 'queries'])
    && isTodoDigest(value.query_set_digest)
    && isTodoDigest(value.evidence_digest)
    && boundedList(value.queries, queryEntry)
    && strictlySorted(value.queries, (query) => query.query_id)
    && value.evidence_digest === todoSelfDigest(value, 'evidence_digest');
}

function verificationEntry(value) {
  return exactRecord(value, [
    'virtual_compile_input_digest', 'virtual_compile_result_digest', 'residual_conflicts',
  ])
    && isTodoDigest(value.virtual_compile_input_digest)
    && isTodoDigest(value.virtual_compile_result_digest)
    && Array.isArray(value.residual_conflicts)
    && value.residual_conflicts.length === 0;
}

function normalizeConflictIdentity(conflicts) {
  return conflicts.map(({ resource_id: resourceId, kind, target, task_pairs: taskPairs }) => ({
    resource_id: resourceId,
    kind,
    target,
    task_pairs: taskPairs.map(([left, right]) => [left, right])
      .sort((left, right) => compareText(`${left[0]}\0${left[1]}`, `${right[0]}\0${right[1]}`)),
  })).sort((left, right) => compareText(left.resource_id, right.resource_id));
}

function normalizeProposedOwnership(surfaces) {
  return surfaces.map(({ kind, target, path, role, owner_task_ids: ownerTaskIds }) => ({
    kind,
    target,
    path,
    role,
    owner_task_ids: [...ownerTaskIds].sort(compareText),
  })).sort((left, right) => compareText(surfaceKey(left), surfaceKey(right)));
}

/**
 * Content receipts and source freshness deliberately do not participate in semantic identity.
 * The caller still has to pass the same conflict component and proposed ownership shape.
 */
export function deriveSeamProposalId({ conflicts, proposed_surfaces: proposedSurfaces }) {
  const semanticKey = {
    conflicts: normalizeConflictIdentity(conflicts),
    proposed_surfaces: normalizeProposedOwnership(proposedSurfaces),
  };
  return `seam-${digestTodoArtifact(semanticKey)}`;
}

function seamCandidate(value, conflicts, taskIds) {
  if (!exactRecord(value, [
    'proposal_id', 'current_surfaces', 'proposed_surfaces', 'affected_tests',
    'verification', 'evidence', 'limits', 'proposal_digest',
  ])
    || !PROPOSAL_ID.test(value.proposal_id)
    || !boundedList(value.current_surfaces,
      (surface) => surfaceEntry(surface, taskIds, { proposed: false }))
    || !strictlySorted(value.current_surfaces, surfaceKey)
    || !boundedList(value.proposed_surfaces,
      (surface) => surfaceEntry(surface, taskIds, { proposed: true }), { min: 1 })
    || !strictlySorted(value.proposed_surfaces, surfaceKey)
    || !boundedList(value.affected_tests, repoRelativePath)
    || !strictlySorted(value.affected_tests)
    || !verificationEntry(value.verification)
    || !evidenceEntry(value.evidence)
    || !boundedList(value.limits, isTodoIdentifier, { min: 1 })
    || !strictlySorted(value.limits)
    || !value.limits.includes('structural_only')
    || !isTodoDigest(value.proposal_digest)) return false;
  const proposedOwnerTaskIds = new Set(value.proposed_surfaces
    .flatMap(({ owner_task_ids: ownerTaskIds }) => ownerTaskIds));
  if (proposedOwnerTaskIds.size !== taskIds.size
    || ![...taskIds].every((taskId) => proposedOwnerTaskIds.has(taskId))) return false;
  if (value.proposal_id !== deriveSeamProposalId({
    conflicts,
    proposed_surfaces: value.proposed_surfaces,
  })) return false;
  return value.proposal_digest === todoSelfDigest(value, 'proposal_digest');
}

function reasonEntry(value) {
  return exactRecord(value, ['code', 'detail'])
    && isTodoIdentifier(value.code) && boundedText(value.detail);
}

function unknownEntry(value) {
  return exactRecord(value, ['kind', 'ref'])
    && isTodoIdentifier(value.kind) && boundedText(value.ref);
}

function decisionEntry(value) {
  if (!exactRecord(value, [
    'component_id', 'task_ids', 'conflicts', 'verdict', 'seam_candidate',
    'reasons', 'unknowns',
  ])
    || !isTodoIdentifier(value.component_id)
    || !boundedList(value.task_ids, isTodoIdentifier, {
      min: 2, max: TODO_INDEPENDENCE_TASK_LIMIT,
    })
    || !strictlySorted(value.task_ids)
    || !SEAM_PROPOSAL_VERDICTS.includes(value.verdict)
    || !boundedList(value.reasons, reasonEntry)
    || !strictlySorted(value.reasons, (reason) => `${reason.code}\0${reason.detail}`)
    || !boundedList(value.unknowns, unknownEntry)
    || !strictlySorted(value.unknowns, (unknown) => `${unknown.kind}\0${unknown.ref}`)) return false;
  const taskIds = new Set(value.task_ids);
  if (!boundedList(value.conflicts, (conflict) => conflictEntry(conflict, taskIds), { min: 1 })
    || !strictlySorted(value.conflicts, (conflict) => conflict.resource_id)
    || !conflictsFormConnectedComponent(value.conflicts, taskIds)) return false;
  if (value.verdict === 'seam_candidate') {
    return value.unknowns.length === 0
      && value.conflicts.every(({ kind }) => severabilityOfConflictKind(kind) === 'code_seam')
      && seamCandidate(value.seam_candidate, value.conflicts, taskIds);
  }
  if (value.seam_candidate !== null) return false;
  if (value.verdict === 'intentional_serial') return value.reasons.length > 0;
  return value.unknowns.length > 0;
}

/**
 * Validate the immutable public `lattice.seam_proposal.v2` artifact.
 *
 * This validates the artifact's closed runtime shape and canonical relations. Binding the
 * recorded conflicts back to the referenced independence bytes is a consumer responsibility.
 */
export function validateSeamProposal(value) {
  try {
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'source_binding', 'compiled_at',
      'decisions', 'result_digest',
    ])
      || value.schema !== SEAM_PROPOSAL_SCHEMA
      || !isTodoIdentifier(value.project_id)
      || !isTodoIdentifier(value.plan_key)
      || !sourceBinding(value.source_binding)
      || !isStrictTodoTimestamp(value.compiled_at)
      || !boundedList(value.decisions, decisionEntry)
      || !strictlySorted(value.decisions, (decision) => decision.component_id)
      || !isTodoDigest(value.result_digest)) return false;
    const resourceIds = value.decisions
      .flatMap(({ conflicts }) => conflicts.map(({ resource_id: resourceId }) => resourceId));
    if (new Set(resourceIds).size !== resourceIds.length) return false;
    return value.result_digest === todoSelfDigest(value, 'result_digest');
  } catch {
    return false;
  }
}

/**
 * 案内は、鮮度と載っているunknownから一意に決まる。生成側の文言をそのまま載せる規約なので
 * shapeだけを見ると、投影が状況と噛み合わない案内を載せても通ってしまう。codeは規則正本へ
 * 引き直して照合する（ADR 0130 Decision 1・2）。
 */
function projectionGuidance(value, coverage, components) {
  if (!exactRecord(value, ['code', 'message', 'next_action'])
    || !SEAM_PROPOSAL_GUIDANCE_CODES.includes(value.code)
    || !boundedText(value.message)
    || !(value.next_action === 'none'
      || (boundedText(value.next_action) && value.next_action.startsWith('lattice ')))) return false;
  const unknownKinds = Array.isArray(components)
    ? components.flatMap((component) => (Array.isArray(component?.unknowns)
      ? component.unknowns.map((unknown) => unknown?.kind) : []))
    : [];
  return value.code === seamProposalGuidanceCode({ coverage, unknownKinds });
}

function projectionComponent(value) {
  if (!exactRecord(value, [
    'component_id', 'verdict', 'task_ids', 'conflicts', 'proposed_surfaces',
    'affected_tests', 'limits', 'reasons', 'unknowns',
  ])
    || !isTodoIdentifier(value.component_id)
    || !SEAM_PROPOSAL_VERDICTS.includes(value.verdict)
    || !boundedList(value.task_ids, isTodoIdentifier, {
      min: 2, max: TODO_INDEPENDENCE_TASK_LIMIT,
    })
    || !strictlySorted(value.task_ids)
    || !boundedList(value.reasons, reasonEntry)
    || !strictlySorted(value.reasons, (reason) => `${reason.code}\0${reason.detail}`)
    || !boundedList(value.unknowns, unknownEntry)
    || !strictlySorted(value.unknowns, (unknown) => `${unknown.kind}\0${unknown.ref}`)
    || !boundedList(value.affected_tests, repoRelativePath)
    || !strictlySorted(value.affected_tests)
    || !boundedList(value.limits, isTodoIdentifier)
    || !strictlySorted(value.limits)) return false;
  const taskIds = new Set(value.task_ids);
  if (!boundedList(value.conflicts, (conflict) => conflictEntry(conflict, taskIds), { min: 1 })
    || !strictlySorted(value.conflicts, (conflict) => conflict.resource_id)
    || !conflictsFormConnectedComponent(value.conflicts, taskIds)
    || !boundedList(value.proposed_surfaces,
      (surface) => surfaceEntry(surface, taskIds, { proposed: true }))
    || !strictlySorted(value.proposed_surfaces, surfaceKey)) return false;
  if (value.verdict === 'seam_candidate') {
    const ownerTaskIds = new Set(value.proposed_surfaces
      .flatMap(({ owner_task_ids: owners }) => owners));
    return value.unknowns.length === 0
      && value.proposed_surfaces.length > 0
      && value.limits.includes('structural_only')
      && ownerTaskIds.size === taskIds.size
      && [...taskIds].every((taskId) => ownerTaskIds.has(taskId));
  }
  if (value.proposed_surfaces.length > 0
    || value.affected_tests.length > 0
    || value.limits.length > 0) return false;
  if (value.verdict === 'intentional_serial') return value.reasons.length > 0;
  return value.unknowns.length > 0;
}

/**
 * Validate the read-only lattice.seam_proposal_projection.v1 public CLI projection.
 * The immutable seam proposal artifact contract above remains independent from this read model.
 */
export function validateSeamProposalProjection(value) {
  try {
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'coverage', 'compiled_base_sha',
      'current_base_sha', 'plan_version', 'topology_digest', 'independence_result_digest',
      'compiled_at', 'guidance', 'component_count', 'conflict_resource_count',
      'components', 'result_digest',
    ])
      || value.schema !== SEAM_PROPOSAL_PROJECTION_SCHEMA
      || !isTodoIdentifier(value.project_id)
      || !isTodoIdentifier(value.plan_key)
      || !TODO_INDEPENDENCE_COVERAGE.includes(value.coverage)
      || !isGitSha(value.current_base_sha)
      || !projectionGuidance(value.guidance, value.coverage, value.components)
      || !isTodoDigest(value.result_digest)) return false;

    if (value.coverage === 'missing') {
      return value.compiled_base_sha === null
        && value.plan_version === null
        && value.topology_digest === null
        && value.independence_result_digest === null
        && value.compiled_at === null
        && value.component_count === null
        && value.conflict_resource_count === null
        && Array.isArray(value.components)
        && value.components.length === 0
        && value.result_digest === todoSelfDigest(value, 'result_digest');
    }

    if (!isGitSha(value.compiled_base_sha)
      || !isTodoIdentifier(value.plan_version)
      || !isTodoDigest(value.topology_digest)
      || !isTodoDigest(value.independence_result_digest)
      || !isStrictTodoTimestamp(value.compiled_at)
      || !isNonNegativeSafeInteger(value.component_count)
      || !isNonNegativeSafeInteger(value.conflict_resource_count)
      || !boundedList(value.components, projectionComponent)
      || !strictlySorted(value.components, (component) => component.component_id)
      || value.component_count !== value.components.length
      || value.conflict_resource_count !== value.components
        .reduce((count, component) => count + component.conflicts.length, 0)) return false;
    if (value.coverage === 'verified' && value.compiled_base_sha !== value.current_base_sha) {
      return false;
    }
    if (value.coverage === 'stale' && value.compiled_base_sha === value.current_base_sha) {
      return false;
    }
    const resourceIds = value.components
      .flatMap(({ conflicts }) => conflicts.map(({ resource_id: resourceId }) => resourceId));
    return new Set(resourceIds).size === resourceIds.length
      && value.result_digest === todoSelfDigest(value, 'result_digest');
  } catch {
    return false;
  }
}
