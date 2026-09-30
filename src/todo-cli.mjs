import { gitSync } from './git-process.mjs';
import { createHash } from 'node:crypto';
import {
  hostname,
} from 'node:os';
import {
  lstat, mkdir, readFile, realpath, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAuthoringPathToken,
  matchFlagCommand,
  parseAuthoringJson,
  readAuthoringJsonFile,
  resolveAuthoringInputPath,
} from './todo-authoring-input.mjs';

import {
  TODO_COORDINATION_MODES,
  TODO_DESIGN_MEMO_PROMPT,
  TODO_TEST_RESULT_CONTRACT_ID,
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  exactRecord,
  explainTodoDesignMemo,
  isTodoDigest,
  isTodoDesignMemo,
  isTodoIdentifier,
  isTodoRef,
  isTodoTestResult,
  todoSelfDigest,
  validateEvidenceDescriptor,
} from './todo-contracts.mjs';
import {
  adoptTodoDashboardActivity,
  ensureTodoDashboardActivity,
  removeTodoDashboardProject,
} from './todo-dashboard-registry.mjs';
import { readProjectExternalPane, resolveProjectIdentity } from './project-identity.mjs';
import { layoutTodoGantt } from './todo-gantt-layout.mjs';
import { TODO_GANTT_SCOPES } from './todo-gantt-scope.mjs';
import { loadTodoGanttPresentation } from './todo-gantt-presentation.mjs';
import { loadTodoStructurePresentation } from './todo-structure-presentation.mjs';
import { startTodoGanttLiveServer } from './todo-gantt-live.mjs';
import {
  renderTodoGanttHtml,
  TODO_GANTT_RENDERER_VERSION,
} from './todo-gantt-html.mjs';
import { verifyNarrativeAnchors } from './todo-narrative-anchor.mjs';
import {
  appendTodoEvent,
  appendTodoStructureRealization,
  applyPhaseTodoRevision,
  applyTodoRevision,
  applyTodoRevisionSet,
  buildTodoPlan,
  createTodoStoreWriter,
  TodoStoreError,
  isPhaselessTodoPlanSchema,
  projectTodoCrossPlanDependencies,
  TERMINAL_AUDIT_PHASE_ID,
  todoPhaseDefinitions,
  readTodoIndependenceArtifact,
  readTodoSeamProposalArtifact,
  readTodoStore,
  readTodoStructureBinding,
  readTodoStructureRealizationChain,
  readTodoStructureSource,
  todoStructureSourceRef,
  resolveTodoStartRetractionBinding,
  readTodoWitnessSet,
  todoWitnessRef,
  writeTodoWitnessSet,
  readTodoStoreStable,
  rebuildTodoSnapshot,
  writeTodoIndependenceArtifact,
  writeTodoSeamProposalArtifact,
  writeTodoStructureBinding,
  writeTodoStructureCompileArtifact,
  writeTodoStructureFinalization,
  writeTodoStructureSource,
  verifyEffectivePhaseTodoRevisionSources,
  verifyTodoRevisionSources,
} from './todo-store.mjs';
import {
  TODO_STRUCTURE_BINDING_SCHEMA,
  TODO_STRUCTURE_LIMITS,
  TODO_STRUCTURE_REALIZATION_SCHEMA,
  digestTodoStructureTransform,
  explainTodoStructureTransform,
  explainTodoStructureRealization,
  explainTodoStructureSet,
} from './todo-structure-contracts.mjs';
import { collectTodoStructureAuthoritativeObservation } from './todo-structure-authoritative-observation.mjs';
import { compileTodoStructureOverlay } from './todo-structure-overlay.mjs';
import {
  buildTodoStructureCompileArtifact,
  projectTodoStructureEffective,
  readTodoStructureArtifactDiagnostics,
  readTodoStructureFinalizationState,
  readTodoStructureFinalizationsForStatus,
  readTodoStructureState,
} from './todo-structure-store.mjs';
import { withStartRetractionGuard } from './runtime-pull-intake.mjs';
import {
  appendTodoExtraction,
  compileTodoExtraction,
  explainTodoExtraction,
  isTodoExtractionConnectionOnly,
  TODO_EXTRACTION_SCHEMA_V3,
  TODO_EXTRACTION_SCHEMA_V4,
  validateTodoExtraction,
} from './todo-migration.mjs';
import {
  computeTodoDispatchShapeForPlan,
} from './todo-dispatch-shape.mjs';
import {
  computeReadyFrontier,
  projectTodoBindings,
  TODO_STATUS_DISPATCH_ONLY,
  projectTodoStatus,
} from './todo-status.mjs';
import {
  TODO_INDEPENDENCE_PROJECTION_SCHEMA,
  explainTodoWitnessSet,
  isTodoIndependenceLegacyMarker,
  validateTodoIndependence,
  validateTodoIndependenceProjection,
} from './todo-independence-contracts.mjs';
import {
  collectWitnessSensorEvidence,
  compileTodoIndependence,
  migrateWitnessSetTaskIds,
  projectIndependenceFrontier,
  TodoIndependenceError,
} from './todo-independence.mjs';
import {
  independenceStartRefusal,
  selectIndependenceGuidance,
  selectWitnessScaffoldGuidance,
  selectSeamProposalGuidance,
  scopeExpansionRecommendations,
} from './todo-independence-guidance.mjs';
import {
  buildSeamProposalQuerySet,
  collectSeamProposalEvidenceBundle,
} from './seam-proposal-queries.mjs';
import {
  SEAM_PROPOSAL_PROJECTION_SCHEMA,
  validateSeamProposalProjection,
} from './seam-proposal-contracts.mjs';
import { compileSeamProposalArtifact, declaredConcernSymbols } from './seam-proposal.mjs';
import { collectSensorEvidence } from './sensor-adapter.mjs';
import { collectTodoIndependenceAuthoritativeObservation } from './todo-independence-authoritative-observation.mjs';
import { applySeamProposal } from './seam-apply.mjs';
import { todoPlanPrecedences } from './seam-verification.mjs';
import {
  WITNESS_DRAFT_SCHEMA, buildWitnessObservationQuerySet, buildWitnessSet, serializeWitnessSet,
  validateWitnessDraft,
} from './witness-scaffold.mjs';
import {
  explainPhaseTodoRevision, explainTodoRevision, explainTodoRevisionSet,
  parseTodoSourceRef, todoLegacyReconciliationDigest, validatePhaseTodoRevision,
  validateTodoRevision, validateTodoRevisionSet,
} from './todo-revision.mjs';
import {
  compileTodoSplit,
  prepareTodoSplitWitnessMigration,
} from './todo-split.mjs';
import {
  appendTodoNote,
  readTodoNoteContext,
  readTodoNoteContextsForPlan,
  readTodoNoteEvents,
  readTodoPlanNotesForStatus,
} from './todo-note-store.mjs';
import { readTodoParallelCandidatesForStatus } from './todo-parallel-candidates.mjs';
import { commitTodoStoreMutation } from './todo-store-git-transaction.mjs';
import { repairTodoStoreWorktreeEol } from './todo-store-worktree-eol.mjs';

const CLI_ERROR_SCHEMA = 'lattice.cli_error.v2';
const DEFAULT_GANTT_SCOPE = 'live';
const MAX_NOTE_INPUT_BYTES = 16_384;
const ACTOR_ENV_KEYS = Object.freeze([
  'LATTICE_TODO_ACTOR_HOST',
  'LATTICE_TODO_ACTOR_SESSION',
  'LATTICE_TODO_ACTOR_AGENT',
]);

/**
 * `revise` / `revise-set` / `revise-phase` / `migrate`が実際に受理する最新契約のJSON
 * Schemaを配布物から読む入口（`project-cli.mjs`の`runPlanCreateSchema`と同じ作法）。
 *
 * schemaを取る手段がCLIに無いと、AIはsrcを読んで必須keyを数えるしかなくなる
 * （実運用で`phase_todo_revision.v3`の必須12 keyを試行錯誤で当てた）。storeは読まない
 * ——`plan create --schema`と同じく決定的な出力・exit 0にする。
 */
const TODO_SCHEMA_COMMANDS = Object.freeze({
  revise: { title: 'lattice.todo_revision.v2', file: 'lattice.todo_revision.v2.schema.json' },
  'revise-set': { title: 'lattice.todo_revision_set.v3', file: 'lattice.todo_revision_set.v3.schema.json' },
  'revise-phase': {
    title: 'lattice.phase_todo_revision.v3', file: 'lattice.phase_todo_revision.v3.schema.json',
  },
  migrate: { title: 'lattice.todo_extraction.v4', file: 'lattice.todo_extraction.v4.schema.json' },
  structure: {
    title: 'lattice.todo_structure_set.v1', file: 'lattice.todo_structure_set.v1.schema.json',
  },
});

async function runTodoSchemaCommand(command, stdout) {
  const spec = TODO_SCHEMA_COMMANDS[command];
  const schemaUrl = new URL(`../docs/schemas/${spec.file}`, import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  if (schema?.title !== spec.title) throw new TypeError(`bundled ${command} schema invalid`);
  stdout.write(`${JSON.stringify(schema)}\n`);
}

function typedFailure(stderr, error) {
  const payload = {
    schema: CLI_ERROR_SCHEMA,
    code: error.code,
    message: error.message,
  };
  if (error.detail !== null && typeof error.detail === 'object'
    && !Array.isArray(error.detail) && Object.keys(error.detail).length > 0) {
    payload.detail = error.detail;
  }
  stderr.write(`${JSON.stringify(payload)}\n`);
  return 1;
}

/**
 * An error that reached here is, by definition, one none of the typed
 * TodoStoreError/TypeError branches recognized — the one case where the
 * caller most needs to know *what actually happened*. Collapsing it to just
 * the constructor name (`{code:'INTERNAL_FAILURE',message:'Error'}`) was
 * itself a diagnosability defect: a crashed `todo start` produced exactly
 * that content-free payload, and the only way to find the real cause
 * (`manifest_journal_head_mismatch`) was importing todo-store.mjs directly
 * and calling readTodoStore() by hand (2026-08-10 P0). The actual message
 * and a short stack excerpt cost nothing to include — this is a local CLI's
 * own stderr, not a response surface with an untrusted audience.
 */
function internalFailure(stderr, error) {
  const constructorName = error?.constructor?.name ?? 'Error';
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message : constructorName;
  const detail = { error_name: constructorName };
  if (typeof error?.stack === 'string' && error.stack.length > 0) {
    detail.stack_excerpt = error.stack.split('\n').slice(0, 6).join('\n');
  }
  return typedFailure(stderr, { code: 'INTERNAL_FAILURE', message, detail });
}

const TODO_COMMAND_NAMES = Object.freeze([
  'status', 'show', 'note', 'bindings', 'independence', 'structure', 'seam-profile', 'seam-proposal',
  'verify', 'repair-eol', 'snapshot', 'gantt', 'dashboard', 'phase', 'migrate', 'start', 'block',
  'unblock', 'retire', 'done', 'reopen', 'evidence', 'split', 'revise', 'revise-phase', 'revise-set',
]);

function typedArgumentFailure(stderr, code, message, detail) {
  const payload = { schema: CLI_ERROR_SCHEMA, code, message, detail };
  stderr.write(`${JSON.stringify(payload)}\n`);
  return 2;
}

function supportsAtomicStoreCommit(argv) {
  const command = argv[0];
  if (command === 'note') return argv[1] !== 'list';
  if (command === 'independence') {
    return argv[1] === 'mode'
      || (argv[1] === 'witness' && ['migrate', 'scaffold'].includes(argv[2]));
  }
  if (command === 'snapshot') return argv[1] === '--rebuild';
  if (command === 'migrate') return !argv.includes('--dry-run') && !argv.includes('--schema');
  if (['revise', 'split', 'revise-set', 'revise-phase', 'start', 'retract', 'block',
    'unblock', 'retire', 'done', 'reopen'].includes(command)) return true;
  if (command === 'evidence') return argv[1] === 'promote';
  if (command === 'phase') return argv[1] !== 'status';
  return false;
}

function atomicStoreCommitUnsupported(stderr, argv) {
  return typedArgumentFailure(stderr, 'STORE_COMMIT_UNSUPPORTED',
    'todo_command_does_not_mutate_only_the_store', {
      command: argv.slice(0, 3),
      next_action: 'remove_--commit-store_or_use_a_supported_todo_write_command',
    });
}

function resolveRepoRoot(cwd) {
  try {
    // gitはWindowsでもforward slashを返すため、OS nativeへ正規化する（runtime-cliと同じ規律）。
    // trimは末尾空白のrepo rootを改変するのでnewlineだけを剥がす。
    return path.resolve(gitSync(['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, ''));
  } catch {
    throw new TodoStoreError('REPO_UNRESOLVED', 'git_toplevel_unresolved', 'cwdのgit toplevelを解決できない');
  }
}

function selectMembers(store, requestedPlanKey) {
  if (requestedPlanKey === null) return store.members;
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === requestedPlanKey);
  if (member === undefined) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active');
  }
  return [member];
}

function selectNoteTask(member, requestedTaskId) {
  const exact = member.plan.tasks.find(({ task_id: taskId }) => taskId === requestedTaskId);
  if (exact !== undefined) return exact;
  const folded = requestedTaskId.toLowerCase();
  const matches = member.plan.tasks.filter(({ task_id: taskId }) => taskId.toLowerCase() === folded);
  if (matches.length !== 1) {
    throw new TodoStoreError('NOTE_TASK_NOT_FOUND', 'note_task_not_active', undefined, {
      plan_key: member.plan.plan_key, task_id: requestedTaskId,
    });
  }
  return matches[0];
}

async function readNoteTextInput(repoRoot, inputRef) {
  const located = await resolveAuthoringInputPath(repoRoot, inputRef, { inlineFlag: '--message' });
  const bytes = await readFile(located.absolute);
  if (bytes.length > MAX_NOTE_INPUT_BYTES) {
    throw new TodoStoreError('INPUT_TOO_LARGE', 'note_input_too_large');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TodoStoreError('INPUT_UNREADABLE', 'note_input_invalid_utf8'); }
}

async function readTestResultInput(repoRoot, inputRef) {
  const result = await readNoteTextInput(repoRoot, inputRef);
  if (!isTodoTestResult(result)) {
    throw new TodoStoreError('INVALID_TEST_RESULT', 'test_result_must_be_non_empty_markdown', undefined, {
      contract_id: TODO_TEST_RESULT_CONTRACT_ID,
    });
  }
  return result;
}

function taskRef(plan, taskId) {
  return { project_id: plan.project_id, plan_key: plan.plan_key, task_id: taskId };
}

function mergedTopology(store) {
  const crossPlanDependencies = projectTodoCrossPlanDependencies(store.members);
  return {
    nodes: store.members.flatMap(({ plan }) => plan.tasks.map(({ task_id: taskId }) => taskRef(plan, taskId))),
    hard_edges: [
      ...store.members.flatMap(({ plan }) => plan.hard_dependencies),
      ...crossPlanDependencies.map(({ from, to }) => ({ from, to })),
    ],
    joins: store.members.flatMap(({ plan }) => plan.joins),
  };
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function readMigrationInput(repoRoot, inputRef, { requireValid = true } = {}) {
  const extraction = await readAuthoringJsonFile(repoRoot, inputRef);
  if (!requireValid) return extraction;
  if (![TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(extraction?.schema)) {
    throw new TodoStoreError('INVALID_TODO_EXTRACTION', 'todo_extraction_schema_unsupported', undefined, {
      expected: TODO_EXTRACTION_SCHEMA_V4,
      next_action: 'lattice todo migrate --schema --json',
    });
  }
  if (!validateTodoExtraction(extraction)) {
    // 「schema_invalid」だけでは何のfieldがどう壊れているか分からない（ADR 0130の案内規律）。
    // explainは可否判定を変えず、診断だけを追加する。
    const explained = explainTodoExtraction(extraction);
    const detail = explained.valid ? undefined : {
      violation_kind: explained.reason,
      pointer: explained.path,
      violation_reason: explained.reason,
      violation_path: explained.path,
      ...(explained.task_id === undefined ? {} : { task_id: explained.task_id }),
      ...(explained.expected === undefined ? {} : { expected: explained.expected }),
      ...(explained.actual === undefined ? {} : { actual: explained.actual }),
      ...(explained.path.endsWith('/design_memo')
        ? { design_memo_prompt: TODO_DESIGN_MEMO_PROMPT } : {}),
      next_action: 'correct_the_reported_pointer_then_rerun_migrate_dry_run',
    };
    throw new TodoStoreError('INVALID_TODO_EXTRACTION', 'schema_invalid', undefined, detail);
  }
  return extraction;
}

async function readRevisionInput(repoRoot, inputRef, {
  validate = validateTodoRevision,
  invalidCode = 'REVISION_INVALID',
  invalidReason = 'revision_schema_or_digest_invalid',
  explain = explainTodoRevision,
} = {}) {
  const revision = await readAuthoringJsonFile(repoRoot, inputRef, { invalidCode });
  if (!validate(revision)) {
    const explained = explain === null ? null : explain(revision);
    throw new TodoStoreError(invalidCode, invalidReason, undefined,
      explained === null || explained.valid ? undefined : {
        violation_reason: explained.reason, violation_path: explained.path,
      });
  }
  return revision;
}

// --evidenceが受け取るのは生の証拠ファイルではなくJSON記述子。ここを間違えた呼び出しAIが
// json_parse_failed/schema_invalidだけを見て手詰まりになるので、期待形をエラーに同梱する（ADR 0130）。
const EVIDENCE_DESCRIPTOR_EXPECTED = Object.freeze({
  shape: '{ "evidence_id": "<identifier>", "repo_id": "<identifier>", "path": "<repo相対path>",'
    + ' "git_blob_oid": "<40/64桁hex>", "content_digest": "<sha256 64桁hex>",'
    + ' "media_type": "text/markdown", "anchor_digest": null }',
  note: '証拠ファイル本体ではなく、コミット済みblobを指すJSON記述子を渡す。'
    + '対象ファイルをcommitした後、git_blob_oidは `git rev-parse HEAD:<path>`、'
    + 'content_digestはblob bytesのsha256（hex）で得る。refsから到達可能なblobだけが検証を通る',
});

function evidenceIdFor(planKey, taskId) {
  const compact = `ev-${planKey}-${taskId}`.replace(/[^0-9A-Za-z._-]/gu, '-').slice(0, 128);
  return isTodoIdentifier(compact) ? compact : 'evidence';
}

function mediaTypeFor(ref) {
  if (ref.endsWith('.md')) return 'text/markdown';
  if (ref.endsWith('.json')) return 'application/json';
  return 'text/plain';
}

function looksLikeEvidenceDescriptor(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeEvidenceBlob(repoRoot, bytes, blobPath) {
  // worktree pathから作る証拠は`git add`と同じclean filterを通す。生のCRLF bytesを
  // そのままhashすると、commit先はLFへ正規化される一方、descriptorはdangling blobを
  // 指すため、commit後もhard検証を通せない。
  const oid = gitSync(['hash-object', '-w', `--path=${blobPath}`, '--stdin'], {
    cwd: repoRoot, input: bytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  const storedBytes = gitSync(['cat-file', 'blob', oid], {
    cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return {
    git_blob_oid: oid,
    content_digest: createHash('sha256').update(storedBytes).digest('hex'),
  };
}

async function resolveDoneEvidence({ repoRoot, evidenceRef, evidenceMessage, planKey, taskId }) {
  if (typeof evidenceMessage === 'string') {
    const bytes = Buffer.from(evidenceMessage, 'utf8');
    const sourceDigest = createHash('sha256').update(bytes).digest('hex');
    const evidencePath = `.lattice/todo/evidence/${planKey}/${taskId}/${sourceDigest}.md`;
    const descriptor = {
      evidence_id: evidenceIdFor(planKey, taskId),
      repo_id: 'self',
      path: evidencePath,
      ...writeEvidenceBlob(repoRoot, bytes, evidencePath),
      media_type: 'text/markdown',
      anchor_digest: null,
    };
    if (!validateEvidenceDescriptor(descriptor) || !isTodoRef(descriptor.path)) {
      throw new TodoStoreError('INVALID_EVIDENCE', 'authored_evidence_descriptor_invalid');
    }
    return descriptor;
  }
  const located = await resolveAuthoringInputPath(repoRoot, evidenceRef, { inlineFlag: '--message' });
  const bytes = await readFile(located.absolute);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TodoStoreError('INVALID_EVIDENCE', 'evidence_input_invalid_utf8'); }
  let parsed = null;
  try {
    parsed = parseAuthoringJson(text, { invalidCode: 'INVALID_JSON' });
  } catch (error) {
    if (error instanceof TodoStoreError && error.code !== 'INVALID_JSON') throw error;
  }
  if (looksLikeEvidenceDescriptor(parsed)) {
    if (!validateEvidenceDescriptor(parsed)) {
      throw new TodoStoreError('INVALID_EVIDENCE', 'schema_invalid', undefined, {
        expected: EVIDENCE_DESCRIPTOR_EXPECTED,
      });
    }
    return parsed;
  }
  const descriptor = {
    evidence_id: evidenceIdFor(planKey, taskId),
    repo_id: 'self',
    path: located.inputRef,
    ...writeEvidenceBlob(repoRoot, bytes, located.inputRef),
    media_type: mediaTypeFor(located.inputRef),
    anchor_digest: null,
  };
  if (!validateEvidenceDescriptor(descriptor)) {
    throw new TodoStoreError('INVALID_EVIDENCE', 'authored_evidence_descriptor_invalid');
  }
  return descriptor;
}

async function readEvidenceInput(repoRoot, inputRef) {
  return resolveDoneEvidence({
    repoRoot, evidenceRef: inputRef, evidenceMessage: null, planKey: 'evidence', taskId: 'body',
  });
}

async function readJsonInput(repoRoot, inputRef, { validate, invalidCode, expected = null }) {
  let descriptor;
  try {
    descriptor = await readAuthoringJsonFile(repoRoot, inputRef, { invalidCode: 'INVALID_JSON' });
  } catch (error) {
    if (error?.code === 'INVALID_JSON' && expected !== null && error.detail?.reason === 'json_parse_failed') {
      throw new TodoStoreError('INVALID_JSON', 'json_parse_failed', undefined, { expected });
    }
    throw error;
  }
  if (!validate(descriptor)) {
    throw new TodoStoreError(invalidCode, 'schema_invalid', undefined,
      expected === null ? undefined : { expected });
  }
  return descriptor;
}

/** 安全読み取りとcanonical JSON規律を共有したまま、witness set契約で検証する。 */
async function readWitnessSetInput(repoRoot, inputRef) {
  let explained = null;
  const witnessSet = await readJsonInput(repoRoot, inputRef, {
    validate: (value) => {
      explained = explainTodoWitnessSet(value);
      return explained.valid;
    },
    invalidCode: 'INVALID_TODO_WITNESS_SET',
  }).catch((error) => {
    if (error?.code === 'INVALID_TODO_WITNESS_SET' && explained !== null) {
      throw new TodoStoreError('INVALID_TODO_WITNESS_SET', explained.reason, undefined, {
        input_ref: inputRef, path: explained.path,
      });
    }
    throw error;
  });
  return witnessSet;
}

/** structure draftはpointer診断のためcontract違反でもparseし、判定はdry-runへ返す。 */
async function readStructureSetDraft(repoRoot, inputRef) {
  return readJsonInput(repoRoot, inputRef, {
    validate: () => true,
    invalidCode: 'INVALID_TODO_STRUCTURE_SET',
  });
}

function sanitizeActorIdentifier(raw, fallback) {
  const compact = String(raw ?? '').replace(/[^0-9A-Za-z._-]/gu, '-').replace(/^-+/u, '').slice(0, 128);
  return isTodoIdentifier(compact) ? compact : fallback;
}

function mutationActor(env) {
  const provided = ACTOR_ENV_KEYS.map((key) => ({ key, value: env[key] }));
  const invalidEnvironment = provided
    .filter(({ value }) => typeof value === 'string' && value.length > 0 && !isTodoIdentifier(value))
    .map(({ key }) => key);
  if (invalidEnvironment.length > 0) {
    throw new TodoStoreError('ACTOR_UNRESOLVED', 'actor_environment_invalid', undefined, {
      required_environment: ACTOR_ENV_KEYS,
      missing_environment: [],
      invalid_environment: invalidEnvironment,
      next_action: 'set_required_actor_environment_and_retry',
    });
  }
  return {
    host: isTodoIdentifier(env.LATTICE_TODO_ACTOR_HOST)
      ? env.LATTICE_TODO_ACTOR_HOST
      : sanitizeActorIdentifier(hostname(), 'host'),
    session: isTodoIdentifier(env.LATTICE_TODO_ACTOR_SESSION)
      ? env.LATTICE_TODO_ACTOR_SESSION
      : 'session',
    agent: isTodoIdentifier(env.LATTICE_TODO_ACTOR_AGENT)
      ? env.LATTICE_TODO_ACTOR_AGENT
      : sanitizeActorIdentifier(env.USER ?? env.LOGNAME, 'agent'),
  };
}

/**
 * gate_readyの札が出た理由と次の一歩をtypedに言う(ADR 0148裁定8)。
 *
 * 0.36.0で入れた終端監査gate(ADR 0147)は、これから終わる工程だけでなく過去に完了した
 * 工程まで監査待ちにしてしまっていた——原因を言わないgateは、なぜ止まっているかを
 * 説明しないのと同じなので、ここでその経緯を明示する。次の一歩は2択で書く:
 * 今から監査する(review→accept)か、監査せず歴史として閉じる(close-unaudited、
 * 複数plan一括ならbaseline)か。
 */
function auditGateGuidance(planKey, phaseId) {
  return '全ToDoがdoneになり監査待ち(gate_ready)。0.36.0で入れた終端監査gateは、'
    + 'これから終わる工程だけでなく過去に完了した工程まで監査待ちにしてしまっていた'
    + '(ADR 0148で修正)。今から監査するなら: '
    + `todo phase review --plan ${planKey} --phase ${phaseId} --reason <text> → `
    + `todo phase accept --plan ${planKey} --phase ${phaseId} --input <file>。`
    + '監査せず歴史として閉じるなら: '
    + `todo phase close-unaudited --plan ${planKey} --phase ${phaseId} --reason <text>`
    + '（複数planをまとめて畳むなら todo phase baseline --reason <text> [--except <plan_key>]...）。';
}

/**
 * phase無しplanで、この変異の結果terminal-audit Phaseがgate_ready(全task done・未監査)に
 * なっていれば助言を返す(ADR 0147)。doneの結果だけを見て機械的に判定するので、既にreview
 * まで進んでいれば`gate_ready`ではなくなり、二重に案内しない。phase付きplanや、まだ
 * pending taskが残っているplanではterminal-audit Phase自体が無い/gate_readyでないので、
 * このヘルパはnullを返し既存の`advisory: null`の挙動を変えない。
 */
function terminalAuditDoneAdvisory(plan, phases) {
  if (!isPhaselessTodoPlanSchema(plan.schema)) return null;
  const phase = phases.find(({ phase_id }) => phase_id === TERMINAL_AUDIT_PHASE_ID);
  if (phase?.status !== 'gate_ready') return null;
  return {
    terminal_audit_required: true, phase_id: TERMINAL_AUDIT_PHASE_ID, status: phase.status,
    guidance: auditGateGuidance(plan.plan_key, TERMINAL_AUDIT_PHASE_ID),
  };
}

async function mutate({
  repoRoot, env, planKey, taskId, kind, payload, evidenceRef, evidenceMessage = null,
  advisory = null, noteContext = null, structureContext = null, testResultRef = null,
}) {
  const actor = mutationActor(env);
  const evidence = evidenceRef === null && evidenceMessage === null
    ? null
    : await resolveDoneEvidence({
      repoRoot, evidenceRef, evidenceMessage, planKey, taskId,
    });
  const testResult = testResultRef === null ? null : await readTestResultInput(repoRoot, testResultRef);
  const materializedEvidence = typeof evidenceMessage === 'string'
    ? {
      ref: evidence.path,
      bytes: gitSync(['cat-file', 'blob', evidence.git_blob_oid], {
        cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'],
      }),
    }
    : null;
  let eventPayload = payload;
  if (kind === 'done' && payload === 'authored') {
    eventPayload = { evidence, ...(testResult === null ? {} : { test_result: testResult }) };
  }
  if (kind === 'done' && payload === 'evidence_promotion') {
    // imported/authored の由来はlock内のcanonical stateから解決する。
    // CLI側で固定するとauthored doneの証拠を再束縛できず、path更新後の
    // evidence_unverifiedを修復する公開経路が無くなる。
    eventPayload = { done_mode: 'evidence_promotion', evidence };
  }
  const { event, snapshot, plan, phases } = await appendTodoEvent({
    repoRoot,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey,
    event: { kind, task_id: taskId, actor, payload: eventPayload },
    materializedEvidence,
  });
  const task = snapshot.tasks.find(({ task_id: current }) => current === event.task_id);
  const authoredTask = plan.tasks.find(({ task_id: current }) => current === event.task_id);
  if (authoredTask === undefined) throw new TypeError('mutation task content is missing');
  // advisoryは呼び出し側(startTask)がstart用に既に組んでいればそれを尊重し、無ければ
  // done時だけ終端監査の要否を調べる。block/unblock/reopenはnullのまま(既存挙動を変えない)。
  // Phase状態はsnapshot(v1にはphasesキーが無い)でなく、appendTodoEventが別途返す
  // 導出ビュー`phases`から読む。
  const resolvedAdvisory = advisory ?? (kind === 'done' ? terminalAuditDoneAdvisory(plan, phases) : null);
  const includesNoteContext = kind === 'start';
  if (includesNoteContext && noteContext === null) {
    throw new TypeError('start mutation requires note context');
  }
  const result = {
    schema: includesNoteContext ? 'lattice.todo_mutation_result.v5' : 'lattice.todo_mutation_result.v2',
    project_id: event.project_id,
    plan_key: event.plan_key,
    plan_version: event.plan_version,
    task_id: event.task_id,
    kind: event.kind,
    sequence: event.sequence,
    event_digest: event.event_digest,
    journal_head_digest: event.event_digest,
    snapshot_digest: snapshot.snapshot_digest,
    status: task.status,
    advisory: resolvedAdvisory,
    ...(includesNoteContext ? {
      design_memo: designMemoProjection(authoredTask),
      note_context: noteContext,
      structure_context: structureContext,
    } : {}),
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function startStructureContext({ repoRoot, store, planKey, taskId }) {
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (member === undefined) throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active');
  const source = await readTodoStructureSource({ repoRoot, planKey });
  const binding = await readTodoStructureBinding({
    repoRoot, planKey, planVersion: member.plan.plan_version,
  });
  if (source === null || binding === null) return {
    status: 'not_enabled', enabled: false, freshness: null, stale_reasons: [],
    structure_set_digest: null, task: null, next_actions: [],
  };
  if (source.structure_set_digest !== binding.structure_set_digest) {
    return {
      status: 'unreadable', enabled: true, freshness: 'stale',
      stale_reasons: ['enabled_structure_source_unreadable'],
      structure_set_digest: source.structure_set_digest,
      task: null,
      next_actions: [`lattice todo structure compile --plan ${planKey} --input <file>`],
    };
  }
  const task = source.tasks.find(({ task_id: id }) => id === taskId);
  if (task === undefined) {
    return {
      status: 'unreadable', enabled: true, freshness: 'stale',
      stale_reasons: ['enabled_structure_task_missing'],
      structure_set_digest: source.structure_set_digest,
      task: null,
      next_actions: [`lattice todo structure compile --plan ${planKey} --input <file>`],
    };
  }
  const state = await readTodoStructureState({ repoRoot, store, planKey });
  return {
    status: 'available', enabled: true, freshness: state.status,
    stale_reasons: state.stale_reasons,
    structure_set_digest: source.structure_set_digest,
    task: structuredClone(task),
    next_actions: task.applicability === 'graph'
      ? [
        `lattice todo structure realize --plan ${planKey} --task ${taskId} --planned`,
        `lattice todo structure realize --plan ${planKey} --task ${taskId} --realized <actual-structure.json>`,
      ]
      : [],
  };
}

function designMemoProjection(task) {
  if (typeof task.design_memo === 'string') {
    return { status: 'available', markdown: task.design_memo, prompt: TODO_DESIGN_MEMO_PROMPT };
  }
  return { status: 'missing_legacy', markdown: null, prompt: TODO_DESIGN_MEMO_PROMPT };
}

/**
 * 着手しようとしているtaskについて、記録済みの独立性から助言を組む（ADR 0128 Decision 5）。
 *
 * どの ready を取るかは助言のまま。記録があるのに対象工程が未検証なら呼び出し側が
 * start を拒否する（ADR 0182）。助言を計算できない状況——git HEADが読めない等——は
 * silent degradeせず、呼び出し側でstart自体を止める。
 */
async function startAdvisory({ repoRoot, store, projection, planKey, taskId }) {
  const artifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
  // 調整方式の宣言（ob03）。未宣言はnullで、「まだ選んでいない」を意味する。
  const coordinationMode = store.members
    .find(({ descriptor }) => descriptor.plan_key === planKey)?.coordination?.mode ?? null;
  if (artifact === null) {
    // 記録が無ければ鮮度を語る相手がいない。HEADを要求すると、commitがまだ無いrepoで
    // 「判定できない」でなく「startできない」になってしまう。
    return {
      coverage: 'missing',
      drift_intersecting: null,
      conflicts_with_active: [],
      scope_expansion_recommendations: [],
      uncovered_active_task_ids: projection.active_set
        .filter((task) => task.plan_key === planKey).map(({ task_id: id }) => id),
      self_unknowns: [{ kind: 'witness_missing', ref: 'no_independence_record' }],
      guidance: selectIndependenceGuidance({
        coverage: 'missing', taskDeclared: false, taskStale: false, coordinationMode,
      }),
    };
  }
  // 記録があるなら鮮度の判定にHEADが要る。ここで読めないのは判定不能であり、
  // 助言なしで通してよい状態ではない。
  const currentBaseSha = currentHeadSha(repoRoot);
  const changedPaths = artifact.base_sha !== null && artifact.base_sha !== currentBaseSha
    ? changedPathsSince(repoRoot, artifact.base_sha) : null;
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  const projected = projectIndependenceFrontier({
    artifact,
    readyTaskIds: projection.next_ready
      .filter((task) => task.plan_key === planKey).map(({ task_id: id }) => id),
    activeTaskIds: projection.active_set
      .filter((task) => task.plan_key === planKey).map(({ task_id: id }) => id),
    plan: member?.plan ?? { plan_version: null, topology_digest: null },
    currentBaseSha,
    changedPaths,
  });
  const selfUnknowns = projected.frontier.unknown
    .find((entry) => entry.task_id === taskId)?.unknowns ?? [];
  const conflictsWithActive = projected.frontier.conflicts_with_active
    .filter((entry) => entry.ready_task_id === taskId)
    .map((entry) => ({
      active_task_id: entry.active_task_id,
      type: entry.type,
      detail: entry.detail,
      kind: entry.kind,
      severability: entry.severability,
    }));
  const readyConflict = projected.frontier.serialize_pairs
    .find((pair) => pair.task_ids.includes(taskId)) ?? null;
  const declared = !selfUnknowns.some(({ kind }) => kind === 'witness_missing');
  return {
    coverage: projected.coverage,
    drift_intersecting: projected.drift === null
      ? null : projected.drift.intersecting_task_ids.includes(taskId),
    conflicts_with_active: conflictsWithActive,
    scope_expansion_recommendations: scopeExpansionRecommendations(
      Array.isArray(artifact.scope_expanded) ? artifact.scope_expanded : [],
    ).filter(({ task_id: expandedTaskId }) => expandedTaskId === taskId),
    uncovered_active_task_ids: projected.uncovered_active_task_ids,
    self_unknowns: selfUnknowns,
    guidance: selectIndependenceGuidance({
      coverage: projected.coverage,
      taskDeclared: declared,
      taskStale: selfUnknowns.some(({ kind }) => kind === 'record_stale'),
      contractSuperseded: isTodoIndependenceLegacyMarker(artifact),
      conflictWithActive: conflictsWithActive[0]?.severability ?? null,
      conflictBetweenReady: readyConflict?.severability ?? null,
      verdictsAbsent: selfUnknowns.some(({ kind }) => kind === 'plan_verdicts_absent'),
      coordinationMode,
    }),
  };
}

async function startTask({
  repoRoot, env, planKey, taskId, overrideReason, parallelFrontier,
}) {
  const store = await readTodoStore({ repoRoot });
  // startはready判定にしかprojectionを使わず、resultを出力しない。
  const projection = projectTodoStatus(store, TODO_STATUS_DISPATCH_ONLY);
  const readyTask = projection.next_ready.find((task) => (
    task.plan_key === planKey && task.task_id.toLowerCase() === taskId.toLowerCase()
  ));
  const targetReady = readyTask !== undefined;
  // `--parallel-frontier`は方針の記録口で、対象がreadyでないときにだけ用法誤り。
  // 複数readyのplain startや直列理由の文言審査で着手を止めない（ADR 0180）。
  if (parallelFrontier && !targetReady) {
    throw new TodoStoreError('PARALLEL_DISPATCH_INVALID', 'parallel_frontier_not_applicable');
  }
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (member === undefined) throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active');
  const taskMatches = member.plan.tasks.filter(({ task_id: candidate }) => (
    candidate.toLowerCase() === taskId.toLowerCase()
  ));
  if (taskMatches.length === 0) {
    throw new TodoStoreError('TASK_NOT_FOUND', 'task_not_found', undefined, {
      requested_task_id: taskId,
    });
  }
  if (taskMatches.length > 1) {
    throw new TodoStoreError('TASK_ID_AMBIGUOUS', 'task_id_case_ambiguous', undefined, {
      requested_task_id: taskId,
      matching_task_ids: taskMatches.map(({ task_id: candidate }) => candidate).sort(),
    });
  }
  const resolvedTaskId = readyTask?.task_id ?? taskMatches[0].task_id;
  // noteはjournal appendより前に読む。壊れていてもstartは通す（ADR 0166 / 0181）。
  let noteContext;
  try {
    ({ context: noteContext } = await readTodoNoteContext({
      repoRoot, store, planKey, taskId: resolvedTaskId,
    }));
  } catch (error) {
    if (!['NOTE_LOG_CORRUPT', 'NOTE_PROJECTION_INVALID'].includes(error?.code)) {
      throw error;
    }
    noteContext = {
      schema: 'lattice.todo_note_context.unreadable.v1',
      project_id: member.plan.project_id,
      plan_key: planKey,
      task_id: resolvedTaskId,
      code: error.code,
      reason: error.detail?.reason ?? 'note_context_unreadable',
      next_action: `lattice todo note list --plan ${planKey} --json`,
    };
  }
  // 助言はjournalへ書く前に確定させる。計算できないならstart自体を止める。
  const advisory = await startAdvisory({
    repoRoot, store, projection, planKey, taskId: resolvedTaskId,
  });
  const refusal = independenceStartRefusal(advisory.guidance);
  if (refusal !== null) {
    throw new TodoStoreError('INDEPENDENCE_UNVERIFIED', refusal.code, refusal.message, {
      plan_key: planKey,
      task_id: resolvedTaskId,
      next_action: refusal.next_action,
    });
  }
  const structureContext = await startStructureContext({
    repoRoot, store, planKey, taskId: resolvedTaskId,
  });
  return mutate({ repoRoot, env, planKey, taskId: resolvedTaskId, kind: 'start',
    payload: { override_reason: overrideReason }, evidenceRef: null, advisory, noteContext,
    structureContext });
}

// plan改訂でcarryされたin-progress ToDoの再束縛入口（ADR 0191）。task状態・開始時刻は
// 変えず、現plan_version・現actorのstart束縛だけをjournalへ積む。runtime intakeは
// literal startだけを束縛に使いcarryを推定しないため、改訂を跨いだ進行中工程の
// 再開はこの入口だけが正規経路になる。advisory・independence gateは初回startで
// 済んでいるため再適用しない。
async function rebindStart({ repoRoot, env, planKey, taskId, reason }) {
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (member === undefined) throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active');
  const task = member.tasks.find(({ task_id: candidate }) => candidate === taskId);
  if (task === undefined) {
    throw new TodoStoreError('TASK_NOT_FOUND', 'task_not_found', undefined, {
      requested_task_id: taskId,
    });
  }
  if (task.status !== 'in-progress') {
    throw new TodoStoreError('TASK_START_BINDING_UNSUPPORTED', 'rebind_requires_in_progress', undefined, {
      task_id: taskId, status: task.status,
    });
  }
  let noteContext;
  try {
    ({ context: noteContext } = await readTodoNoteContext({ repoRoot, store, planKey, taskId }));
  } catch (error) {
    if (!['NOTE_LOG_CORRUPT', 'NOTE_PROJECTION_INVALID'].includes(error?.code)) throw error;
    noteContext = {
      schema: 'lattice.todo_note_context.unreadable.v1',
      project_id: member.plan.project_id,
      plan_key: planKey,
      task_id: taskId,
      code: error.code,
      reason: error.detail?.reason ?? 'note_context_unreadable',
      next_action: `lattice todo note list --plan ${planKey} --json`,
    };
  }
  return mutate({
    repoRoot, env, planKey, taskId, kind: 'start',
    payload: { start_mode: 'rebind', reason }, evidenceRef: null, noteContext,
  });
}

async function retractStart({ repoRoot, env, planKey, taskId, reason }) {
  const actor = mutationActor(env);
  const store = await readTodoStore({ repoRoot });
  const binding = resolveTodoStartRetractionBinding(store, { planKey, taskId, actor });
  return withStartRetractionGuard({
    repoRoot,
    planKey,
    taskId: binding.task_id,
    activationEventDigest: binding.activation_event_digest,
    action: () => mutate({
      repoRoot, env, planKey, taskId: binding.task_id, kind: 'start_retracted',
      payload: { reason, target_start_digest: binding.activation_event_digest },
      evidenceRef: null,
    }),
  });
}

function validatePhaseDecisionInput(value, outcome) {
  const keys = outcome === 'accept'
    ? ['schema', 'review_event_digest', 'decision_evidence', 'evidence_slots', 'input_digest']
    : ['schema', 'review_event_digest', 'reason', 'decision_evidence', 'input_digest'];
  return exactRecord(value, keys) && value.schema === `lattice.phase_${outcome}_input.v1`
    && isTodoDigest(value.review_event_digest) && validateEvidenceDescriptor(value.decision_evidence)
    && (outcome === 'accept'
      ? Array.isArray(value.evidence_slots) && value.evidence_slots.length > 0
        && value.evidence_slots.every((entry) => exactRecord(entry, ['slot_id', 'evidence'])
          && isTodoIdentifier(entry.slot_id) && validateEvidenceDescriptor(entry.evidence))
        && value.evidence_slots.every((entry, index) => index === 0
          || value.evidence_slots[index - 1].slot_id < entry.slot_id)
      : typeof value.reason === 'string' && value.reason.length > 0)
    && isTodoDigest(value.input_digest) && value.input_digest === todoSelfDigest(value, 'input_digest');
}

// `--input`の形が合わないとき、期待形をerrorへ同梱する（ADR 0130）。自己digestは入口が補うので
// 空でよい（ADR 0181）。証拠記述子を手で作らせないために、ふつうは`--evidence`を案内する。
const PHASE_DECISION_EXPECTED = Object.freeze({
  accept: '{ "schema": "lattice.phase_accept_input.v1", "review_event_digest": "<phase reviewのevent_digest>",'
    + ' "decision_evidence": <evidence記述子>, "evidence_slots": [{ "slot_id": "<必須slot>", "evidence": <evidence記述子> }],'
    + ' "input_digest": "" }',
  reject: '{ "schema": "lattice.phase_reject_input.v1", "review_event_digest": "<phase reviewのevent_digest>",'
    + ' "reason": "<text>", "decision_evidence": <evidence記述子>, "input_digest": "" }',
  note: 'input_digestは入口が計算する。証拠fileがcommit済みなら、`--evidence <file>`で'
    + 'review_event_digest・記述子・必須slotを機械が埋める。evidence記述子の形はEVIDENCE_DESCRIPTOR_EXPECTEDを見る。',
});

async function phaseDecision({ repoRoot, env, planKey, phaseId, outcome, inputRef }) {
  let input;
  try {
    input = await readRevisionInput(repoRoot, inputRef, {
      validate: (value) => validatePhaseDecisionInput(value, outcome),
      invalidCode: 'PHASE_DECISION_INVALID', invalidReason: 'phase_decision_schema_or_digest_invalid',
      // phase decision入力はrevision契約と別形状。既定のrevision explainを誤って当てない。
      explain: null,
    });
  } catch (error) {
    if (error instanceof TodoStoreError && error.code === 'PHASE_DECISION_INVALID') {
      throw new TodoStoreError('PHASE_DECISION_INVALID', 'phase_decision_schema_or_digest_invalid', undefined, {
        expected: PHASE_DECISION_EXPECTED[outcome], note: PHASE_DECISION_EXPECTED.note,
        evidence_descriptor: EVIDENCE_DESCRIPTOR_EXPECTED,
        next_action: `lattice todo phase ${outcome} --plan ${planKey} --phase ${phaseId}`
          + (outcome === 'reject' ? ' --reason <text>' : '') + ' --evidence <repo内の監査file>',
      });
    }
    throw error;
  }
  const payload = outcome === 'accept'
    ? { review_event_digest: input.review_event_digest, decision_evidence: input.decision_evidence,
      evidence_slots: input.evidence_slots }
    : { review_event_digest: input.review_event_digest, reason: input.reason,
      decision_evidence: input.decision_evidence };
  return phaseMutation({ repoRoot, env, planKey, phaseId, kind: `phase_${outcome}`, payload });
}

/**
 * `--evidence <file>`から判断入力を組み立てる（ADR 0181の下書き受理をphase判断へ広げる）。
 * review_event_digestはstoreの現在のreviewから、記述子は`todo done`と同じ処理でcommit済み
 * fileから作る。必須slotが1つならその証拠で埋める。複数slotへ1つの証拠を流用すると
 * 「各slotを別々に確かめた」ことを偽るので、その場合は`--input`で明示させる。
 */
async function phaseDecisionFromEvidence({ repoRoot, env, planKey, phaseId, outcome, evidenceRef, reason }) {
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ plan }) => plan.plan_key === planKey);
  if (member === undefined) {
    throw new TodoStoreError('PHASE_DECISION_INVALID', 'plan_not_active', undefined, { plan_key: planKey });
  }
  const state = member.phases.find(({ phase_id: current }) => current === phaseId);
  const definition = todoPhaseDefinitions(member.plan).find(({ phase_id: current }) => current === phaseId);
  if (state === undefined || definition === undefined) {
    throw new TodoStoreError('PHASE_DECISION_INVALID', 'phase_not_found', undefined, {
      plan_key: planKey, phase_id: phaseId,
      phases: todoPhaseDefinitions(member.plan).map(({ phase_id: id }) => id),
    });
  }
  if (state.status !== 'reviewing' || state.review_event_digest === null) {
    throw new TodoStoreError('PHASE_DECISION_INVALID', 'phase_not_reviewing', undefined, {
      plan_key: planKey, phase_id: phaseId, status: state.status,
      next_action: `lattice todo phase review --plan ${planKey} --phase ${phaseId} --reason <text>`,
    });
  }
  if (outcome === 'accept' && definition.required_evidence_slots.length !== 1) {
    throw new TodoStoreError('PHASE_DECISION_INVALID', 'multiple_evidence_slots_need_input', undefined, {
      required_evidence_slots: definition.required_evidence_slots,
      expected: PHASE_DECISION_EXPECTED.accept, evidence_descriptor: EVIDENCE_DESCRIPTOR_EXPECTED,
      next_action: `lattice todo phase accept --plan ${planKey} --phase ${phaseId} --input <file>`,
    });
  }
  const evidence = await resolveDoneEvidence({
    repoRoot, evidenceRef, evidenceMessage: null, planKey, taskId: `${phaseId}-${outcome}`,
  });
  const payload = outcome === 'accept'
    ? { review_event_digest: state.review_event_digest, decision_evidence: evidence,
      evidence_slots: definition.required_evidence_slots.map((slotId) => ({ slot_id: slotId, evidence })) }
    : { review_event_digest: state.review_event_digest, reason, decision_evidence: evidence };
  return phaseMutation({ repoRoot, env, planKey, phaseId, kind: `phase_${outcome}`, payload });
}

async function phaseMutation({ repoRoot, env, planKey, phaseId, kind, payload }) {
  const { event, snapshot, phases } = await appendTodoEvent({
    repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey,
    event: { kind, phase_id: phaseId, actor: mutationActor(env), payload },
  });
  // snapshot.phasesはv1(phase無しplan)には存在しない。導出ビュー`phases`を見る
  // (これは暗黙のterminal-audit Phaseにも常に埋まっている)。
  const phase = phases.find(({ phase_id: current }) => current === phaseId);
  if (phase === undefined) throw new TodoStoreError('STORE_INCONSISTENT', 'phase_not_active');
  const result = {
    schema: 'lattice.phase_mutation_result.v1', project_id: event.project_id,
    plan_key: event.plan_key, plan_version: event.plan_version, phase_id: event.phase_id,
    kind: event.kind, sequence: event.sequence, event_digest: event.event_digest,
    journal_head_digest: event.event_digest, snapshot_digest: snapshot.snapshot_digest,
    status: phase.status, result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * 調整方式を宣言する（ob03・オーナー裁定C①）。
 *
 * witnessが全planの暗黙義務だった時、「誰がやるか」が誰にも属さず、正確な案内が素通りされた。
 * 起票後にこのコマンドで明示選択させ、eventのactorへ帰属を残す。宣言はdispatchを変えない
 * ——未宣言でもready frontierは通常どおり出る（ADR 0160・ob04のProtected behavior）。
 */
async function independenceMode({ repoRoot, env, planKey, mode, reason }) {
  const { event } = await appendTodoEvent({
    repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey,
    event: { kind: 'coordination_mode', actor: mutationActor(env), payload: { mode, reason } },
  });
  const result = {
    schema: 'lattice.todo_coordination_mode_result.v1', project_id: event.project_id,
    plan_key: event.plan_key, plan_version: event.plan_version,
    mode: event.payload.mode, reason: event.payload.reason,
    declared_by: event.actor, declared_at: event.recorded_at,
    // 宣言はplan-scoped chainのheadを進める。lifecycle journalのheadは動かない——
    // 「作業が進んだ」の意味をここへ混ぜないため、journal_head_digestは返さない。
    sequence: event.sequence, event_digest: event.event_digest,
    plan_scoped_head_digest: event.event_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/** 開発中に発見した依存（同一plan内・plan跨ぎとも）を、consumer planのplan-scoped chainへ接続する。 */
async function dependencyConnect({
  repoRoot, env, fromPlanKey, fromTaskId, toPlanKey, toTaskId, reason,
}) {
  const store = await readTodoStore({ repoRoot });
  const dependencyMember = (planKey) => {
    const member = store.members.find(({ plan }) => plan.plan_key === planKey);
    if (member === undefined) {
      throw new TodoStoreError('DEPENDENCY_INVALID', 'dependency_plan_not_found', undefined, {
        plan_key: planKey,
      });
    }
    return member;
  };
  const source = dependencyMember(fromPlanKey);
  const target = dependencyMember(toPlanKey);
  if (!source.plan.tasks.some(({ task_id: taskId }) => taskId === fromTaskId)) {
    throw new TodoStoreError('DEPENDENCY_INVALID', 'dependency_task_not_found', undefined, {
      plan_key: fromPlanKey, task_id: fromTaskId,
    });
  }
  if (!target.plan.tasks.some(({ task_id: taskId }) => taskId === toTaskId)) {
    throw new TodoStoreError('DEPENDENCY_INVALID', 'dependency_task_not_found', undefined, {
      plan_key: toPlanKey, task_id: toTaskId,
    });
  }
  const from = {
    project_id: store.project_id, plan_key: fromPlanKey, task_id: fromTaskId,
    expected_topology_digest: source.plan.topology_digest,
  };
  const to = {
    project_id: store.project_id, plan_key: toPlanKey, task_id: toTaskId,
    expected_topology_digest: target.plan.topology_digest,
  };
  const { event } = await appendTodoEvent({
    repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: toPlanKey,
    event: {
      kind: 'cross_plan_dependency', actor: mutationActor(env), payload: { from, to, reason },
    },
  });
  const result = {
    schema: 'lattice.todo_dependency_connect_result.v1', project_id: store.project_id,
    from: event.payload.from, to: event.payload.to, reason: event.payload.reason,
    connected_by: event.actor, connected_at: event.recorded_at,
    event_digest: event.event_digest, plan_scoped_head_digest: event.event_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

// connectの対。誤って張った線の除去（tombstone）。端点で一意に生きた接続を特定し、
// その接続eventが積まれているplanのplan-scoped chainへ除去eventを積む。
async function dependencyDisconnect({
  repoRoot, env, fromPlanKey, fromTaskId, toPlanKey, toTaskId, reason,
}) {
  // 修理扉: 越境依存の固定digestが陳腐化した store でも disconnect だけは通す（todo-store.mjs 参照）
  const store = await readTodoStore({ repoRoot, tolerateStaleBindings: true });
  const live = projectTodoCrossPlanDependencies(store.members).filter((dependency) => (
    dependency.from.plan_key === fromPlanKey && dependency.from.task_id === fromTaskId
    && dependency.to.plan_key === toPlanKey && dependency.to.task_id === toTaskId
  ));
  if (live.length === 0) {
    throw new TodoStoreError('DEPENDENCY_INVALID', 'cross_plan_dependency_not_found', undefined, {
      from: { plan_key: fromPlanKey, task_id: fromTaskId },
      to: { plan_key: toPlanKey, task_id: toTaskId },
    });
  }
  const [target] = live;
  const owner = store.members.find((member) => (member.plan_scoped?.events ?? [])
    .some((event) => event.event_digest === target.event_digest));
  const { event } = await appendTodoEvent({
    repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: owner.plan.plan_key,
    tolerateStaleBindings: true,
    event: {
      kind: 'cross_plan_dependency_removed', actor: mutationActor(env),
      payload: { target_event_digest: target.event_digest, reason },
    },
  });
  const result = {
    schema: 'lattice.todo_dependency_disconnect_result.v1', project_id: store.project_id,
    from: target.from, to: target.to, reason,
    removed_event_digest: target.event_digest,
    disconnected_by: event.actor, disconnected_at: event.recorded_at,
    event_digest: event.event_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function phaseStatus({ repoRoot, planKey }) {
  const store = await readTodoStore({ repoRoot });
  const [member] = selectMembers(store, planKey);
  const structureFinalization = await readTodoStructureFinalizationState({
    repoRoot, store, planKey: member.plan.plan_key,
  });
  // ADR 0147以降、phase無しplan(v1/v2/v3)もreadTodoStoreが導出済みの暗黙terminal-audit
  // Phaseをmember.phasesへ積んでいる(snapshot artifactの形式は変えない・v1にはphasesキーが
  // 無いのでsnapshot.phasesは直接読まない)。ここでPHASE_UNAVAILABLEへ拒否せず、その暗黙Phase
  // をそのまま返す——`implicit`で機械可読に「宣言されたPhaseではない」ことを示す。
  const implicit = isPhaselessTodoPlanSchema(member.plan.schema);
  // ADR 0148裁定8: gate_readyのPhaseには、なぜ監査待ちになったかと次の一歩をここでも言う
  // (todo doneのadvisoryと同じ文言)。implicit(暗黙のterminal-audit Phase)に限らず、
  // v4/v5の実Phaseがgate_readyになった場合も同じ理由で同じ案内が要る。
  const phases = member.phases.map((phase) => ({
    ...phase,
    guidance: phase.status === 'gate_ready'
      ? [
        auditGateGuidance(member.plan.plan_key, phase.phase_id),
        ...(structureFinalization.required && structureFinalization.status !== 'fresh'
          ? [`構造finalizationが${structureFinalization.status}です。先に lattice todo structure finalize --plan ${member.plan.plan_key} --json を実行してください。`]
          : []),
      ].join('\n') : null,
  }));
  const result = {
    schema: 'lattice.phase_status_result.v2', project_id: store.project_id,
    plan_key: member.plan.plan_key, plan_version: member.plan.plan_version,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    implicit, phases,
    structure_finalization: {
      enabled: structureFinalization.enabled, required: structureFinalization.required,
      status: structureFinalization.status, reason: structureFinalization.reason,
      stale_reasons: structureFinalization.stale_reasons,
      next_command: structureFinalization.required && structureFinalization.status !== 'fresh'
        ? `lattice todo structure finalize --plan ${member.plan.plan_key} --json` : null,
    },
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * `phase baseline --reason <text> [--except <plan_key>]...`の可変長`--except`を解析する。
 * 他のargvはすべて固定位置(argv.length + 位置一致)で判定しているが、0回以上繰り返せる
 * flagだけは固定位置で表現できないため、並び全体を見る専用ヘルパへ切り出す
 * (bridge-cliの`parseOptions`と同じ発想)。不正な並びはnullを返し、呼び出し側の
 * 分岐条件がそのままusageFailureへ落ちる。
 */
function parseBaselineExceptFlags(rest) {
  if (rest.length % 2 !== 0) return null;
  const planKeys = [];
  for (let index = 0; index < rest.length; index += 2) {
    if (rest[index] !== '--except' || !isTodoIdentifier(rest[index + 1])) return null;
    planKeys.push(rest[index + 1]);
  }
  return planKeys;
}

/**
 * `phase baseline`——現在gate_readyかつphase eventを1つも持たないPhaseを一括で
 * closed_unauditedへ宣言する(ADR 0148裁定6)。「phase eventを1つも持たない」は
 * derivedStatusだけでは判定できない——一度reviewしてからreopenしたPhaseは、構造的には
 * また`gate_ready`に戻り得るが、既に監査に触れている以上は対象外である。journalの実event
 * 履歴(phase_id別に`phase_`で始まるkindがあるか)を直接見て区別する。
 *
 * `--except`はplan単位の除外(ADR 0148裁定7)。ServerManagerの26 ToDoのような
 * 「最近の作業でコードも生きている」campaignを基準線で流さないための口であり、
 * Phase単位では絞れない(そのplanのPhaseは丸ごと対象外になる)。
 */
async function phaseBaseline({ repoRoot, env, reason, exceptPlanKeys }) {
  const store = await readTodoStore({ repoRoot });
  const knownPlanKeys = new Set(store.members.map(({ descriptor }) => descriptor.plan_key));
  const unknownExcept = exceptPlanKeys.filter((planKey) => !knownPlanKeys.has(planKey));
  if (unknownExcept.length > 0) {
    throw new TodoStoreError('PHASE_BASELINE_INVALID', 'except_plan_key_unknown', undefined, {
      unknown_plan_keys: unknownExcept,
    });
  }
  const exceptSet = new Set(exceptPlanKeys);
  const applied = [];
  const excluded = [];
  const notApplicable = [];
  const failed = [];
  for (const member of store.members) {
    const planKey = member.descriptor.plan_key;
    const touchedPhaseIds = new Set(member.journal.events
      .filter((event) => event.kind.startsWith('phase_'))
      .map((event) => event.phase_id));
    for (const phase of member.phases) {
      const entry = { plan_key: planKey, phase_id: phase.phase_id, status: phase.status };
      // 「対象外だったもの(既にaccepted等)も区別して返す」——まだgate_readyに到達していない
      // (locked/active)のと、既に監査の決着が付いている(accepted/rejected/closed_unaudited)のは
      // 原因が違うので、causeを分けて機械可読にする。
      if (['accepted', 'rejected', 'closed_unaudited'].includes(phase.status)) {
        notApplicable.push({ ...entry, cause: `already_${phase.status}` });
      } else if (phase.status !== 'gate_ready') {
        notApplicable.push({ ...entry, cause: 'not_gate_ready' });
      } else if (touchedPhaseIds.has(phase.phase_id)) {
        notApplicable.push({ ...entry, cause: 'already_has_phase_event' });
      } else if (exceptSet.has(planKey)) {
        excluded.push({ ...entry, cause: 'excepted' });
      } else {
        // ADR 0148裁定6の非目標: journalはappend-onlyで、一度書いた宣言を後から取り消す
        // 手段が無い。1件失敗しても既に書けた他件を無かったことにはできない以上、
        // 全件一括のtransactionは新設せず、appendTodoEvent単位(1 event = 1排他書込み)の
        // 独立実行を続ける。各書込みは呼ぶたびにstoreを読み直してgate_ready前提を
        // 再検証するため、他項目の成否とは無関係に安全である——1件の失敗で残りを
        // 止めず、続行して全件の結果をtypedで返す。
        try {
          const result = await phaseMutation({
            repoRoot, env, planKey, phaseId: phase.phase_id,
            kind: 'phase_close_unaudited', payload: { reason },
          });
          applied.push({ ...entry, event_digest: result.event_digest,
            journal_head_digest: result.journal_head_digest });
        } catch (error) {
          failed.push({ ...entry, code: error?.code ?? 'INTERNAL_FAILURE',
            message: typeof error?.message === 'string' ? error.message : null });
        }
      }
    }
  }
  const result = {
    schema: 'lattice.phase_baseline_result.v1',
    reason, except_plan_keys: [...exceptSet].sort(),
    applied, excluded, not_applicable: notApplicable, failed,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function migrate({ repoRoot, inputRef }) {
  const extraction = await readMigrationInput(repoRoot, inputRef);
  // unresolved/空集合の早期gateは、compileTodoExtraction内部の同名gateをここでも
  // 先に通しておくことで、既存のエラー優先順位を変えない。
  // dispatch_shapeは結果へ載せる観測であり、直列度では書込みを拒まない（ADR 0180）。
  const unresolvedTaskIds = extraction.tasks
    .filter(({ disposition }) => disposition === 'unknown_requires_evidence')
    .map(({ task_id: taskId }) => taskId);
  if (unresolvedTaskIds.length > 0) {
    throw new TodoStoreError('MIGRATION_UNRESOLVED', 'unknown_requires_evidence', undefined, {
      task_ids: unresolvedTaskIds,
    });
  }
  const registered = extraction.tasks.filter(({ disposition }) => disposition.startsWith('register_'));
  const connectionOnly = isTodoExtractionConnectionOnly(extraction);
  if (registered.length === 0 && !connectionOnly) {
    throw new TodoStoreError('MIGRATION_EMPTY', 'no_registered_tasks');
  }

  const dispatchShape = connectionOnly ? null : computeTodoDispatchShapeForPlan({
    projectId: extraction.project_id,
    planKey: extraction.plan_key,
    taskIds: registered.map(({ task_id: taskId }) => taskId),
    hardDependencies: extraction.hard_dependencies,
    joins: extraction.joins,
  });

  const imported = await appendTodoExtraction({ repoRoot, extraction });
  let companion = null;
  if ((imported.crossPlanDependencies ?? []).length > 0) {
    const connectedStore = await readTodoStore({ repoRoot });
    const event = imported.crossPlanDependencies[0];
    companion = {
      repair: event.payload.from,
      target: event.payload.to,
      reason: event.payload.reason,
      event_digest: event.event_digest,
      connected_frontier: computeReadyFrontier(connectedStore),
      next_action: imported.connectionOnly === true ? 'lattice todo status --json'
        : isPhaselessTodoPlanSchema(imported.plan.schema)
        ? `lattice todo revise-phase --plan ${imported.plan.plan_key} --input <phase-revision.json>`
        : 'lattice todo status --json',
    };
  }
  const result = {
    // companionを足す時点でv4へ上げ、通常移行もnullを常在させてresult shapeを固定する。
    schema: 'lattice.todo_migrate_result.v4',
    project_id: imported.plan.project_id,
    plan_key: imported.plan.plan_key,
    plan_version: imported.plan.plan_version,
    extraction_digest: extraction.extraction_digest,
    imported_task_count: registered.length,
    completed_task_count: extraction.tasks.filter(({ disposition }) => disposition === 'register_done').length,
    plan_ref: imported.descriptor.plan_ref,
    journal_ref: imported.descriptor.journal_ref,
    snapshot_ref: imported.descriptor.snapshot_ref,
    topology_digest: imported.plan.topology_digest,
    journal_head_digest: imported.events.at(-1).event_digest,
    dispatch_shape: dispatchShape === null ? null : {
      task_count: dispatchShape.task_count,
      critical_path_length: dispatchShape.critical_path_length,
      max_frontier_width: dispatchShape.max_frontier_width,
      serialization_ratio: dispatchShape.serialization_ratio,
    },
    // ADR 0147裁定3: phase無しplanの作成は拒否せず、終端監査が要ることを結果へ明示するに
    // 留める。extraction経由のmigrateは常にphase無しplan(todo_plan.v2)を作るが、将来の
    // 拡張に備えisPhaselessTodoPlanSchemaで動的に判定する。
    terminal_audit_required: imported.connectionOnly !== true && isPhaselessTodoPlanSchema(imported.plan.schema),
    phase_guidance: imported.connectionOnly !== true && isPhaselessTodoPlanSchema(imported.plan.schema) ? {
      capability: 'acquire_phase',
      preserves_completed_state: true,
      schema_command: 'lattice todo revise-phase --schema --json',
      required_state_policy: 'acquire_phase',
      next_action: `lattice todo revise-phase --plan ${imported.plan.plan_key} --input <phase-revision.json>`,
    } : null,
    // ob03: 起票直後のplanは必ず調整方式が未宣言である。ここで案内しないと、選ぶ機会が
    // 「誰も呼ぶ動機の無いdrilldown」にしか無くなる——前campaignの監査待ちと同じ形になる。
    coordination_guidance: imported.connectionOnly === true ? null : {
      mode: null,
      modes: [...TODO_COORDINATION_MODES],
      next_action: `lattice todo independence mode --plan ${imported.plan.plan_key} --set <witness|conversation> --reason <text>`,
    },
    companion,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

function extractionFreshnessViolations(repoRoot, extraction) {
  let reachable;
  try {
    // rev-listの出力はobject数に比例して伸びる（本repo実測で既定maxBuffer 1MiB超過済み）。
    // 隣のgit showと同様にmaxBufferを明示しないと、ENOBUFSが握られて
    // source_reachability_unreadableへ誤変換される。
    reachable = new Set(gitSync(['rev-list', '--objects', '--all'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 134_217_728,
    }).split('\n').filter(Boolean).map((line) => line.split(' ')[0]));
  } catch {
    return [{ code: 'source_reachability_unreadable', path: '/tasks', task_ids: [],
      next_action: 'git fsck --connectivity-only' }];
  }
  const violations = [];
  for (const [index, task] of (Array.isArray(extraction.tasks) ? extraction.tasks : []).entries()) {
    const source = task?.source;
    if (source === null || typeof source !== 'object'
      || !['checked', 'unchecked'].includes(source.checkbox_state)
      || task.narrative_ref !== source.origin_plan_ref) continue;
    const at = `/tasks/${index}/source`;
    if (!reachable.has(source.source_commit)) {
      violations.push({ code: 'source_commit_unreachable', path: `${at}/source_commit`,
        task_ids: [task.task_id].filter(isTodoIdentifier), next_action: 'commit_or_reference_source_commit' });
      continue;
    }
    let markdown;
    try {
      markdown = gitSync(['show', `${source.source_commit}:${source.origin_plan_ref}`], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8_388_608,
      });
    } catch {
      violations.push({ code: 'source_path_unreadable', path: `${at}/origin_plan_ref`,
        task_ids: [task.task_id].filter(isTodoIdentifier), next_action: 'correct_pinned_source_ref' });
      continue;
    }
    const line = markdown.split('\n')[source.origin_line - 1];
    const checkbox = /^\s*[-*+]\s+\[([ xX])\]/u.exec(line ?? '');
    const actual = checkbox === null ? null : checkbox[1].toLowerCase() === 'x' ? 'checked' : 'unchecked';
    if (actual !== source.checkbox_state) {
      violations.push({ code: 'source_checkbox_state_mismatch', path: `${at}/checkbox_state`,
        task_ids: [task.task_id].filter(isTodoIdentifier), next_action: 'refresh_extraction_from_pinned_source' });
    }
  }
  return violations;
}

function extractionAuthoringViolations(extraction, now = new Date()) {
  const violations = [];
  const tasks = Array.isArray(extraction?.tasks) ? extraction.tasks : [];
  for (const [index, task] of tasks.entries()) {
    const taskIds = isTodoIdentifier(task?.task_id) ? [task.task_id] : [];
    if (task?.disposition === 'register_done'
      && task?.completion?.done_mode !== 'historical_import') {
      violations.push({ code: 'enum_mismatch', path: `/tasks/${index}/completion/done_mode`,
        task_ids: taskIds, expected: 'historical_import',
        actual: task?.completion?.done_mode ?? null,
        next_action: 'use_historical_import_for_imported_completion' });
    }
    if (task?.migration_context !== null && typeof task?.migration_context === 'object'
      && !Array.isArray(task.migration_context.notes)) {
      violations.push({ code: 'expected_array', path: `/tasks/${index}/migration_context/notes`,
        task_ids: taskIds, expected: 'array', actual: typeof task.migration_context.notes,
        next_action: 'replace_notes_with_a_bounded_string_array' });
    }
  }
  if (typeof extraction?.extraction_digest === 'string') {
    const expected = todoSelfDigest(extraction, 'extraction_digest');
    if (extraction.extraction_digest !== expected) {
      violations.push({ code: 'extraction_digest_mismatch', path: '/extraction_digest', task_ids: [],
        expected, actual: extraction.extraction_digest,
        next_action: 'replace_extraction_digest_with_expected' });
    }
  }
  const edges = Array.isArray(extraction?.hard_dependencies) ? extraction.hard_dependencies : [];
  const edgeKey = (edge) => [edge?.from?.project_id, edge?.from?.plan_key, edge?.from?.task_id,
    edge?.to?.project_id, edge?.to?.plan_key, edge?.to?.task_id].join('\0');
  for (let index = 1; index < edges.length; index += 1) {
    if (edgeKey(edges[index - 1]) >= edgeKey(edges[index])) {
      violations.push({ code: 'array_not_sorted', path: `/hard_dependencies/${index}`, task_ids: [],
        expected: 'strict ascending order', sort_key: 'from.project_id, from.plan_key, from.task_id, '
          + 'to.project_id, to.plan_key, to.task_id',
        next_action: 'sort_hard_dependencies_by_the_reported_key' });
      break;
    }
  }
  const registered = new Set(tasks.filter(({ disposition }) => typeof disposition === 'string'
    && disposition.startsWith('register_')).map(({ task_id: taskId }) => taskId));
  const connectionOnly = isTodoExtractionConnectionOnly(extraction);
  const unresolvedLocal = (ref) => ref?.project_id === extraction?.project_id
    && ref?.plan_key === extraction?.plan_key && !connectionOnly && !registered.has(ref?.task_id);
  for (const [index, edge] of edges.entries()) {
    for (const side of ['from', 'to']) {
      if (unresolvedLocal(edge?.[side])) {
        violations.push({ code: 'local_ref_unresolved', path: `/hard_dependencies/${index}/${side}`,
          task_ids: isTodoIdentifier(edge[side].task_id) ? [edge[side].task_id] : [],
          expected: 'task_id registered in this extraction', actual: edge[side].task_id ?? null,
          next_action: 'register_the_task_or_reference_its_actual_project_and_plan' });
      }
    }
  }
  const recordedAt = Date.parse(extraction?.recorded_at);
  const maxFutureSkewMs = 5 * 60 * 1_000;
  if (Number.isFinite(recordedAt) && recordedAt > now.valueOf() + maxFutureSkewMs) {
    violations.push({ code: 'future_clock_skew', path: '/recorded_at', task_ids: [],
      expected: { current_time: now.toISOString(), max_future_skew_ms: maxFutureSkewMs },
      actual: extraction.recorded_at, next_action: 'correct_recorded_at_and_recompute_extraction_digest' });
  }
  return violations;
}

async function migrateDryRun({ repoRoot, inputRef }) {
  const extraction = await readMigrationInput(repoRoot, inputRef, { requireValid: false });
  const violations = [];
  const tasks = Array.isArray(extraction?.tasks) ? extraction.tasks : [];
  const designMemoSchema = [TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(extraction?.schema);
  const invalidMemos = (designMemoSchema ? tasks : []).map((task, index) => ({
    task, index, explained: explainTodoDesignMemo(task?.design_memo),
  })).filter(({ explained }) => !explained.valid).slice(0, 64);
  const supportedSchema = [TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4]
    .includes(extraction?.schema);
  if (!supportedSchema) {
    violations.push({ code: 'schema_retired', path: '/schema', task_ids: [],
      expected: TODO_EXTRACTION_SCHEMA_V4,
      actual: typeof extraction?.schema === 'string' ? extraction.schema
        : { type: typeof extraction?.schema },
      next_action: 'lattice todo migrate --schema --json' });
  }
  for (const { task, index, explained } of invalidMemos) {
    violations.push({ code: `design_memo_${explained.reason}`, path: `/tasks/${index}/design_memo`,
      task_ids: isTodoIdentifier(task?.task_id) ? [task.task_id] : [],
      expected: explained.expected, actual: explained.actual,
      prompt: TODO_DESIGN_MEMO_PROMPT, next_action: 'lattice todo migrate --schema --json' });
  }
  const schemaValid = supportedSchema && validateTodoExtraction(extraction);
  if (!schemaValid) {
    const explained = explainTodoExtraction(extraction);
    if (!explained.valid && !explained.path.endsWith('/design_memo')) {
      violations.push({ code: explained.reason, path: explained.path,
        task_ids: isTodoIdentifier(explained.task_id) ? [explained.task_id] : [],
        ...(explained.expected === undefined ? {} : { expected: explained.expected }),
        ...(explained.actual === undefined ? {} : { actual: explained.actual }),
        next_action: 'correct_extraction_input' });
    }
  }
  for (const violation of extractionAuthoringViolations(extraction)) {
    if (!violations.some((entry) => entry.code === violation.code && entry.path === violation.path)) {
      violations.push(violation);
    }
  }
  const unresolvedTaskIds = tasks
    .filter(({ disposition }) => disposition === 'unknown_requires_evidence')
    .map(({ task_id: taskId }) => taskId).filter(isTodoIdentifier);
  if (unresolvedTaskIds.length > 0) {
    violations.push({ code: 'unknown_requires_evidence', path: '/tasks',
      task_ids: unresolvedTaskIds.slice(0, 64), next_action: 'adjudicate_task_disposition' });
  }
  const registered = tasks.filter(({ disposition }) => typeof disposition === 'string'
    && disposition.startsWith('register_'));
  const connectionOnly = schemaValid && isTodoExtractionConnectionOnly(extraction);
  if (registered.length === 0 && !connectionOnly) {
    violations.push({ code: 'no_registered_tasks', path: '/tasks', task_ids: [],
      next_action: 'register_at_least_one_task' });
  }

  let dispatchShape = null;
  let plannedPlan = null;
  let plannedConnection = null;
  if (schemaValid && unresolvedTaskIds.length === 0 && (registered.length > 0 || connectionOnly)) {
    try {
      const compiled = compileTodoExtraction(extraction, repoRoot);
      if (connectionOnly) {
        plannedConnection = {
          source: compiled.crossPlanDependencies[0].from,
          target: compiled.crossPlanDependencies[0].to,
          reason: compiled.crossPlanDependencies[0].reason,
        };
      } else {
        plannedPlan = buildTodoPlan(compiled.plan);
        dispatchShape = computeTodoDispatchShapeForPlan({
          projectId: extraction.project_id, planKey: extraction.plan_key,
          taskIds: registered.map(({ task_id: taskId }) => taskId),
          hardDependencies: extraction.hard_dependencies, joins: extraction.joins,
        });
      }
    } catch (error) {
      plannedPlan = null;
      dispatchShape = null;
      violations.push({ code: error?.detail?.reason ?? 'topology_invalid', path: '/hard_dependencies',
        task_ids: [], next_action: 'correct_extraction_topology' });
    }
    if (plannedPlan !== null && dispatchShape !== null) {
      violations.push(...extractionFreshnessViolations(repoRoot, extraction));
      let manifestPresent = false;
      try {
        const stats = await lstat(path.join(repoRoot, '.lattice', 'todo', 'manifest.json'));
        manifestPresent = stats.isFile() && !stats.isSymbolicLink();
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new TodoStoreError('MIGRATION_DRY_RUN_IO_FAILED', 'manifest_status_unreadable',
            undefined, { path: '.lattice/todo/manifest.json' });
        }
      }
      if (manifestPresent) {
        const store = await readTodoStore({ repoRoot });
        if (store.project_id !== extraction.project_id) {
          violations.push({ code: 'project_id_mismatch', path: '/project_id', task_ids: [],
            next_action: 'use_the_active_store_project_id' });
        }
        if (store.members.some(({ plan }) => plan.plan_key === extraction.plan_key)) {
          violations.push({ code: 'plan_key_already_exists', path: '/plan_key', task_ids: [],
            next_action: 'choose_a_new_plan_key_or_use_revision' });
        }
      }
    }
  }
  const bounded = violations.slice(0, 64);
  const result = {
    schema: 'lattice.todo_migrate_dry_run_result.v2',
    valid: bounded.length === 0,
    project_id: isTodoIdentifier(extraction?.project_id) ? extraction.project_id : null,
    plan_key: isTodoIdentifier(extraction?.plan_key) ? extraction.plan_key : null,
    violations: bounded,
    overflow_count: Math.max(0, violations.length - bounded.length),
    planned: plannedConnection !== null ? {
      connection_only: true,
      source: plannedConnection.source,
      target: plannedConnection.target,
      reason: plannedConnection.reason,
    } : plannedPlan === null ? null : {
      connection_only: false,
      plan_schema: plannedPlan.schema,
      task_count: registered.length,
      topology_digest: plannedPlan.topology_digest,
      dispatch_shape: {
        task_count: dispatchShape.task_count,
        critical_path_length: dispatchShape.critical_path_length,
        max_frontier_width: dispatchShape.max_frontier_width,
        serialization_ratio: dispatchShape.serialization_ratio,
      },
    },
    next_action: bounded.length === 0
      ? `lattice todo migrate --input ${inputRef}`
      : 'correct_all_reported_violations_and_rerun_dry_run',
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function revise({ repoRoot, env, planKey, inputRef }) {
  const revision = await readRevisionInput(repoRoot, inputRef);
  if (revision.plan_key !== planKey) {
    throw new TodoStoreError('REVISION_INVALID', 'requested_plan_mismatch');
  }
  return applyTodoRevision({
    repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision,
    actor: mutationActor(env), recordedAt: new Date().toISOString(),
  });
}

async function reviseSet({ repoRoot, env, inputRef }) {
  const revisionSet = await readRevisionInput(repoRoot, inputRef, {
    validate: validateTodoRevisionSet,
    invalidCode: 'REVISION_SET_INVALID',
    invalidReason: 'revision_set_schema_invalid',
    explain: explainTodoRevisionSet,
  });
  return applyTodoRevisionSet({
    repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revisionSet,
    actor: mutationActor(env), recordedAt: new Date().toISOString(),
  });
}

async function revisePhase({ repoRoot, env, planKey, inputRef }) {
  const revision = await readRevisionInput(repoRoot, inputRef, {
    validate: validatePhaseTodoRevision, invalidCode: 'REVISION_INVALID',
    invalidReason: 'phase_revision_schema_or_digest_invalid',
    explain: explainPhaseTodoRevision,
  });
  if (revision.plan_key !== planKey) throw new TodoStoreError('REVISION_INVALID', 'requested_plan_mismatch');
  return applyPhaseTodoRevision({ repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    revision, actor: mutationActor(env), recordedAt: new Date().toISOString() });
}

async function splitTodo({ repoRoot, env, planKey, inputRef }) {
  const proposal = await readMigrationInput(repoRoot, inputRef, { requireValid: false });
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (member === undefined) throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active');
  const witnessSet = await readTodoWitnessSet({ repoRoot, planKey });
  if (witnessSet === null) {
    throw new TodoStoreError('WITNESS_MIGRATION_UNAVAILABLE', 'witness_set_absent', undefined, {
      witness_ref: todoWitnessRef(planKey),
      next_action: `lattice todo independence witness scaffold --plan ${planKey} --input <draft>`,
    });
  }
  const compiled = await compileTodoSplit({ repoRoot, member, proposal });
  const actor = mutationActor(env);
  const recordedAt = new Date().toISOString();
  // splitのmigrationは既存taskへのidentity写像だけである。宣言を純粋に移行・検査し、
  // 同じcanonical bytesをwitness先へ書けることまでapply前に確定する。これにより、
  // witness失敗をrevision適用後に返してplan/sourceだけ進んだ状態を作らない。
  const preparedWitness = prepareTodoSplitWitnessMigration({
    witnessSet, revision: compiled.revision,
  });
  const { ref: witnessRef } = await writeTodoWitnessSet({
    repoRoot, witnessSet: preparedWitness.witnessSet,
  });
  const witnessMigration = {
    schema: 'lattice.todo_witness_migrate_result.v1',
    project_id: store.project_id,
    plan_key: planKey,
    plan_version: compiled.revision.desired_plan.plan_version,
    witness_ref: witnessRef,
    migrated_count: preparedWitness.migrated_count,
    removed_count: preparedWitness.removed_count,
    unchanged_count: preparedWitness.unchanged_count,
    witness_set_digest: preparedWitness.witnessSet.witness_set_digest,
    result_digest: '',
  };
  witnessMigration.result_digest = todoSelfDigest(witnessMigration, 'result_digest');
  const receipt = compiled.revision.schema === 'lattice.phase_todo_revision.v3'
    ? await applyPhaseTodoRevision({
      repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
      revision: compiled.revision, actor, recordedAt,
    })
    : await applyTodoRevision({
      repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
      revision: compiled.revision, actor, recordedAt,
    });
  const result = {
    schema: 'lattice.todo_split_result.v1',
    project_id: store.project_id,
    plan_key: planKey,
    predecessor_task_id: proposal.task_id,
    residual_task_id: proposal.task_id,
    extracted_task_ids: compiled.extracted_task_ids,
    plan_version: compiled.revision.desired_plan.plan_version,
    revision_digest: compiled.revision.revision_digest,
    revision_receipt_digest: receipt.receipt_digest ?? receipt.result_digest,
    witness_migration_result_digest: witnessMigration.result_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function status({ repoRoot }) {
  const store = await readTodoStore({ repoRoot });
  const result = projectTodoStatus(store, {
    planNotes: await readTodoPlanNotesForStatus({ repoRoot, store }),
    parallelCandidates: await readTodoParallelCandidatesForStatus({
      repoRoot, store, gitHead: currentHeadSha, changedPathsSince,
    }),
    structureFinalizations: await readTodoStructureFinalizationsForStatus({ repoRoot, store }),
  });
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function adoptDashboardRoot({ repoRoot, env }) {
  const store = await readTodoStoreStable({ repoRoot });
  const actor = mutationActor(env);
  const identity = await resolveProjectIdentity({ repoRoot, projectId: store.project_id, env });
  await adoptTodoDashboardActivity({
    repoRoot, projectId: store.project_id, displayName: identity.displayName,
    sessionId: actor.session, env,
  });
  const result = {
    schema: 'lattice.todo_dashboard_adopt_result.v1',
    project_id: store.project_id,
    adopted: true,
    next_action: `open /projects/${encodeURIComponent(store.project_id)}/ on the dynamic dashboard`,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function todoDetail({ repoRoot, planKey, taskId }) {
  const store = await readTodoStore({ repoRoot });
  const [member] = selectMembers(store, planKey);
  const task = selectNoteTask(member, taskId);
  const state = member.tasks.find(({ task_id: current }) => current === task.task_id);
  if (state === undefined) throw new TodoStoreError('STORE_INCONSISTENT', 'task_state_missing');
  const { context } = await readTodoNoteContext({
    repoRoot, store, planKey, taskId: task.task_id,
  });
  const result = {
    schema: 'lattice.todo_detail_result.v3',
    project_id: store.project_id,
    plan_key: planKey,
    plan_version: member.plan.plan_version,
    task,
    design_memo: designMemoProjection(task),
    state,
    note_context: context,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * `taskId === null`はplan単位note。task noteと違い宛先taskが無いので、
 * 訂正できる相手はplan noteだけ、返すcontextも特定taskのものにできない。
 */
async function appendNote({ repoRoot, env, planKey, taskId, message, inputRef, supersedes }) {
  const store = await readTodoStore({ repoRoot });
  const [member] = selectMembers(store, planKey);
  const task = taskId === null ? null : selectNoteTask(member, taskId);
  const body = inputRef === null ? message : await readNoteTextInput(repoRoot, inputRef);
  // 訂正はscopeを跨げない。plan noteはplan chainの中だけ、task noteは自分のtaskの中だけを
  // 訂正できる。contextはplan noteも載せるので、task側はscopeで絞らないと跨げてしまう。
  const eligibleSupersedes = task === null
    ? (await readTodoNoteEvents({ repoRoot, planKey, scope: 'plan' })).events
      .map(({ event_digest: digest }) => digest)
    : (await readTodoNoteContext({ repoRoot, store, planKey, taskId: task.task_id }))
      .history.filter(({ scope }) => scope === 'task').map(({ event_digest: digest }) => digest);
  const event = await appendTodoNote({
    repoRoot,
    projectId: store.project_id,
    planKey,
    planVersion: member.plan.plan_version,
    taskId: task?.task_id ?? null,
    actor: mutationActor(env),
    recordedAt: new Date().toISOString(),
    body,
    supersedes,
    eligibleSupersedes,
  });
  // plan noteはどのtaskのcontextにも載るので、1つを選んで返すと嘘になる。全部読むなら
  // `note list --plan <k>`。書けたことの証拠はeventそのものが持つ。
  const context = task === null
    ? null : (await readTodoNoteContext({ repoRoot, store, planKey, taskId: task.task_id })).context;
  const result = {
    schema: 'lattice.todo_note_append_result.v2',
    project_id: store.project_id,
    plan_key: planKey,
    scope: task === null ? 'plan' : 'task',
    task_id: task?.task_id ?? null,
    event,
    note_context: context,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function listNotes({ repoRoot, planKey, taskId }) {
  const store = await readTodoStore({ repoRoot });
  const [member] = selectMembers(store, planKey);
  const chain = await readTodoNoteEvents({ repoRoot, planKey });
  const planChain = await readTodoNoteEvents({ repoRoot, planKey, scope: 'plan' });
  // plan全体の一覧は両chainを返す。`full_history_command`がこの形を指す以上、片方でも
  // 落とせば「full」と名乗りながら全部を取りに行けない。並びはcontextと同じくplanが先。
  let notes = [...planChain.events, ...chain.events];
  let archived = [];
  let resolvedTaskId = null;
  if (taskId !== null) {
    const task = selectNoteTask(member, taskId);
    resolvedTaskId = task.task_id;
    const projected = await readTodoNoteContext({
      repoRoot, store, planKey, taskId: task.task_id,
    });
    // `--task`は「そのtaskのnote」を問う形。plan noteはtaskのものではないので混ぜない
    // ——欲しければ`--task`を外す。
    notes = projected.history.filter(({ scope }) => scope === 'task');
    archived = projected.archived;
  }
  const result = {
    schema: 'lattice.todo_note_list_result.v2',
    project_id: store.project_id,
    plan_key: planKey,
    requested_task_id: resolvedTaskId,
    notes,
    archived,
    note_head_digest: chain.head_digest,
    plan_note_head_digest: planChain.head_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function bindings({ repoRoot, requestedPlanKey }) {
  return projectTodoBindings(await readTodoStore({ repoRoot }), { requestedPlanKey });
}

function currentHeadSha(repoRoot) {
  let head;
  try {
    head = gitSync(['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new TodoStoreError('INDEPENDENCE_BASE_UNRESOLVED', 'git_head_unresolved');
  }
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    throw new TodoStoreError('INDEPENDENCE_BASE_UNRESOLVED', 'git_head_invalid');
  }
  return head;
}

/**
 * `base_sha..HEAD`で変わったrepo相対pathを返す。
 *
 * baseがgit historyから到達できない場合（rebase・shallow等）はnullを返す。
 * 「変更なし」の空配列と「差分を確定できない」を同じ顔にしない——前者は記録の有効性を
 * 支える事実だが、後者は支えない（ADR 0128 Decision 4）。
 */
function changedPathsSince(repoRoot, baseSha) {
  try {
    gitSync(['cat-file', '-e', `${baseSha}^{commit}`], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    return null;
  }
  let output;
  try {
    output = gitSync(['diff', '--name-only', '--no-renames', `${baseSha}..HEAD`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  return [...new Set(output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0))]
    .sort();
}

function structureGitIdentity(repoRoot, baselineSha, violations) {
  let currentHeadSha = null;
  try {
    currentHeadSha = gitSync(['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, '');
  } catch {
    violations.push({
      code: 'git_head_unresolved', path: '/baseline_sha',
      expected: 'current repository HEAD commit', actual: null,
      next_action: 'repair_git_head_then_rerun_structure_input_dry_run',
    });
    return { currentHeadSha: null };
  }
  if (!/^[0-9a-f]{40}$/u.test(currentHeadSha)) {
    violations.push({
      code: 'git_head_invalid', path: '/baseline_sha',
      expected: '40 lowercase hex commit OID', actual: currentHeadSha,
      next_action: 'repair_git_head_then_rerun_structure_input_dry_run',
    });
    return { currentHeadSha: null };
  }
  try {
    gitSync(['cat-file', '-e', `${baselineSha}^{commit}`], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    violations.push({
      code: 'baseline_commit_unresolved', path: '/baseline_sha',
      expected: 'commit object reachable in this repository', actual: baselineSha,
      next_action: 'fetch_the_baseline_or_correct_baseline_sha',
    });
    return { currentHeadSha };
  }
  try {
    gitSync(['merge-base', '--is-ancestor', baselineSha, currentHeadSha], {
      cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    violations.push({
      code: 'baseline_not_ancestor', path: '/baseline_sha',
      expected: { ancestor_of: currentHeadSha }, actual: baselineSha,
      next_action: 'select_an_ancestor_baseline_or_rebase_the_structure_input',
    });
  }
  return { currentHeadSha };
}

async function analyzeStructureInput({ repoRoot, planKey, inputRef }) {
  const structureSet = await readStructureSetDraft(repoRoot, inputRef);
  const violations = [];
  const explained = explainTodoStructureSet(structureSet);
  if (!explained.valid) {
    violations.push({
      code: explained.reason,
      path: explained.path,
      ...(explained.detail === undefined ? {} : { actual: explained.detail }),
      next_action: 'correct_the_reported_pointer_then_rerun_structure_input_dry_run',
    });
  }

  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey) ?? null;
  if (member === null) {
    violations.push({
      code: 'plan_not_active', path: '/plan_key', expected: planKey,
      actual: typeof structureSet?.plan_key === 'string' ? structureSet.plan_key : null,
      next_action: 'define_the_plan_before_adding_structure_input',
    });
  }

  let currentHeadSha = null;
  if (explained.valid && member !== null) {
    const identities = [
      ['project_id', store.project_id, structureSet.project_id],
      ['plan_key', planKey, structureSet.plan_key],
      ['plan_version', member.plan.plan_version, structureSet.plan_version],
      ['topology_digest', member.plan.topology_digest, structureSet.topology_digest],
    ];
    for (const [field, expected, actual] of identities) {
      if (actual !== expected) {
        violations.push({
          code: `${field}_mismatch`, path: `/${field}`, expected, actual,
          next_action: 'regenerate_structure_input_for_the_active_plan_identity',
        });
      }
    }
    const expectedTaskIds = member.tasks.filter(({ status }) => status !== 'done')
      .map(({ task_id: taskId }) => taskId);
    const coverage = explainTodoStructureSet(structureSet, { expectedTaskIds });
    if (!coverage.valid && ['coverage_missing', 'coverage_extra'].includes(coverage.reason)) {
      violations.push({
        code: coverage.reason, path: coverage.path,
        expected: { task_ids: [...expectedTaskIds].sort() },
        actual: coverage.detail,
        next_action: 'list_every_unfinished_task_as_graph_or_excluded',
      });
    }
    ({ currentHeadSha } = structureGitIdentity(repoRoot, structureSet.baseline_sha, violations));
  }

  const bounded = violations.slice(0, 64);
  const result = {
    schema: 'lattice.todo_structure_input_dry_run_result.v1',
    valid: bounded.length === 0,
    project_id: member?.plan.project_id ?? null,
    plan_key: member?.plan.plan_key ?? planKey,
    plan_version: member?.plan.plan_version ?? null,
    input_ref: inputRef,
    source_ref: todoStructureSourceRef(planKey),
    current_head_sha: currentHeadSha,
    violations: bounded,
    overflow_count: Math.max(0, violations.length - bounded.length),
    next_action: bounded.length === 0
      ? `lattice todo structure input --plan ${planKey} --input ${inputRef}`
      : 'correct_the_reported_violations_then_rerun_structure_input_dry_run',
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return { result, structureSet };
}

async function structureInputDryRun({ repoRoot, planKey, inputRef }) {
  return (await analyzeStructureInput({ repoRoot, planKey, inputRef })).result;
}

async function structureInput({ repoRoot, planKey, inputRef }) {
  const analyzed = await analyzeStructureInput({ repoRoot, planKey, inputRef });
  if (!analyzed.result.valid) {
    throw new TodoStoreError('INVALID_TODO_STRUCTURE_SET', 'structure_input_dry_run_failed', undefined, {
      violations: analyzed.result.violations,
      overflow_count: analyzed.result.overflow_count,
      next_action: `lattice todo structure input --plan ${planKey} --input ${inputRef} --dry-run --json`,
    });
  }
  const written = await writeTodoStructureSource({ repoRoot, structureSet: analyzed.structureSet });
  const result = {
    schema: 'lattice.todo_structure_input_result.v1',
    project_id: analyzed.structureSet.project_id,
    plan_key: analyzed.structureSet.plan_key,
    plan_version: analyzed.structureSet.plan_version,
    topology_digest: analyzed.structureSet.topology_digest,
    baseline_sha: analyzed.structureSet.baseline_sha,
    structure_set_digest: analyzed.structureSet.structure_set_digest,
    source_ref: written.ref,
    enabled: false,
    next_action: `commit ${written.ref}, then run lattice todo structure compile --plan ${planKey} --input ${written.ref}`,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

function structurePlanMember(store, requestedPlanKey) {
  if (requestedPlanKey !== null) {
    const member = store.members.find(({ plan }) => plan.plan_key === requestedPlanKey);
    if (member === undefined) {
      throw new TodoStoreError('STRUCTURE_PLAN_NOT_FOUND', 'plan_not_active', undefined, {
        plan_key: requestedPlanKey,
      });
    }
    return member;
  }
  if (store.members.length !== 1) {
    throw new TodoStoreError('STRUCTURE_PLAN_AMBIGUOUS', 'plan_selection_ambiguous', undefined, {
      plan_keys: store.members.map(({ plan }) => plan.plan_key).sort(),
      next_action: 'rerun_with_plan_flag',
    });
  }
  return store.members[0];
}

function parseAutomatedStructureRealizeArgs(argv) {
  if (argv[0] !== 'structure' || argv[1] !== 'realize'
    || argv[2] !== '--plan' || !isTodoIdentifier(argv[3])
    || argv[4] !== '--task' || !isTodoIdentifier(argv[5])) return null;
  let cursor;
  let usePlanned;
  let realizedRef = null;
  if (argv[6] === '--planned') {
    cursor = 7; usePlanned = true;
  } else if (argv[6] === '--realized' && isAuthoringPathToken(argv[7])) {
    cursor = 8; usePlanned = false; realizedRef = argv[7];
  } else {
    return null;
  }
  const commitRefs = [];
  while (cursor < argv.length) {
    if (argv[cursor] !== '--commit' || typeof argv[cursor + 1] !== 'string') return null;
    commitRefs.push(argv[cursor + 1]);
    cursor += 2;
  }
  return {
    planKey: argv[3], taskId: argv[5], usePlanned, realizedRef, commitRefs,
  };
}

function structureNextActions({ coverage, planKey, findings = [], staleReasons = [] }) {
  const actions = [];
  const add = (value) => { if (!actions.includes(value)) actions.push(value); };
  if (coverage === 'missing') {
    add(`lattice todo structure input --plan ${planKey} --input <structure-set.json> --dry-run --json`);
    add(`lattice todo structure input --plan ${planKey} --input <structure-set.json>`);
    add(`lattice todo structure compile --plan ${planKey} --input .lattice/todo/structure/${planKey}.json`);
  } else if (['inconsistent', 'unknown'].includes(coverage)) {
    findings.forEach(({ next_action: nextAction }) => add(nextAction));
    add(`lattice todo structure input --plan ${planKey} --input <corrected-structure-set.json> --dry-run --json`);
    add(`lattice todo structure compile --plan ${planKey} --input .lattice/todo/structure/${planKey}.json`);
  } else if (coverage === 'stale') {
    if (staleReasons.includes('realization_head_digest')) {
      add(`lattice todo structure --plan ${planKey} --json`);
    } else {
      add(`lattice todo structure realize --plan ${planKey} --task <task-id> --planned`);
      add(`lattice todo structure realize --plan ${planKey} --task <task-id> --realized <actual-structure.json>`);
    }
    add(`lattice todo structure finalize --plan ${planKey} --json`);
  } else if (coverage === 'superseded') {
    add(`lattice todo structure input --plan ${planKey} --input <migrated-structure-set.json> --dry-run --json`);
  } else if (coverage === 'consistent') {
    add(`lattice todo structure --plan ${planKey} --json`);
    add(`lattice todo structure realize --plan ${planKey} --task <task-id> --planned`);
    add(`lattice todo structure realize --plan ${planKey} --task <task-id> --realized <actual-structure.json>`);
    add(`lattice todo structure finalize --plan ${planKey} --json`);
  }
  return actions;
}

async function structureCompile({ repoRoot, env, planKey, inputRef }) {
  const structureSet = await readStructureSetDraft(repoRoot, inputRef);
  const explained = explainTodoStructureSet(structureSet);
  if (!explained.valid) {
    throw new TodoStoreError('INVALID_TODO_STRUCTURE_SET', explained.reason, undefined, {
      input_ref: inputRef, path: explained.path,
      next_action: `lattice todo structure input --plan ${planKey} --input ${inputRef} --dry-run --json`,
    });
  }
  const store = await readTodoStore({ repoRoot });
  const member = structurePlanMember(store, planKey);
  const source = await readTodoStructureSource({ repoRoot, planKey });
  if (source === null) {
    throw new TodoStoreError('STRUCTURE_SOURCE_MISSING', 'planned_source_missing', undefined, {
      plan_key: planKey,
      next_action: `lattice todo structure input --plan ${planKey} --input ${inputRef}`,
    });
  }
  if (canonicalizeTodoArtifact(source) !== canonicalizeTodoArtifact(structureSet)) {
    throw new TodoStoreError('STRUCTURE_SOURCE_MISMATCH', 'compile_input_is_not_saved_source', undefined, {
      input_ref: inputRef, source_ref: todoStructureSourceRef(planKey),
      next_action: `lattice todo structure input --plan ${planKey} --input ${inputRef}`,
    });
  }
  const existingBinding = await readTodoStructureBinding({
    repoRoot, planKey, planVersion: member.plan.plan_version,
  });
  if (existingBinding !== null) {
    throw new TodoStoreError('STRUCTURE_ALREADY_ENABLED', 'immutable_binding_exists', undefined, {
      plan_key: planKey, plan_version: member.plan.plan_version,
      next_action: `lattice todo structure --plan ${planKey} --json`,
    });
  }
  const actor = mutationActor(env);
  const observation = await collectTodoStructureAuthoritativeObservation({ repoRoot, structureSet });
  const sourceEvidence = observation.source_evidence;
  const gitProvenance = observation.git_provenance;
  const realizations = [];
  for (const task of structureSet.tasks.filter(({ applicability }) => applicability === 'graph')) {
    realizations.push(...await readTodoStructureRealizationChain({
      repoRoot, structureSet, taskId: task.task_id,
    }));
  }
  const overlay = compileTodoStructureOverlay({
    structureSet,
    topology: mergedTopology(store),
    taskStates: member.tasks.map(({ task_id: taskId, status }) => ({ task_id: taskId, status })),
    sourceProjection: sourceEvidence.projection,
    gitProvenance,
    realizations,
  });
  const compiledAt = new Date().toISOString();
  const artifact = buildTodoStructureCompileArtifact({
    structureSet, sourceProjection: sourceEvidence.projection, gitProvenance, overlay,
    realizations, compiledAt, actor,
  });
  const written = await writeTodoStructureCompileArtifact({ repoRoot, artifact });
  let bindingRef = null;
  if (overlay.verdict === 'consistent') {
    const binding = {
      schema: TODO_STRUCTURE_BINDING_SCHEMA,
      project_id: structureSet.project_id, plan_key: structureSet.plan_key,
      plan_version: structureSet.plan_version, topology_digest: structureSet.topology_digest,
      profile: structureSet.profile, baseline_sha: structureSet.baseline_sha,
      structure_set_digest: structureSet.structure_set_digest,
      compiled_head_sha: artifact.current_head_sha,
      compile_artifact_digest: artifact.artifact_digest,
      activated_at: compiledAt, actor, binding_digest: '',
    };
    binding.binding_digest = todoSelfDigest(binding, 'binding_digest');
    bindingRef = (await writeTodoStructureBinding({ repoRoot, binding })).ref;
  }
  const nextActions = structureNextActions({
    coverage: overlay.verdict, planKey, findings: overlay.findings,
  });
  const result = {
    schema: 'lattice.todo_structure_compile_result.v1',
    project_id: structureSet.project_id, plan_key: planKey,
    plan_version: structureSet.plan_version, topology_digest: structureSet.topology_digest,
    structure_set_digest: structureSet.structure_set_digest,
    current_head_sha: artifact.current_head_sha,
    verdict: overlay.verdict, enabled: bindingRef !== null,
    artifact_ref: written.ref, binding_ref: bindingRef,
    finding_summary: overlay.finding_summary, findings: overlay.findings,
    next_actions: nextActions, result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function readStructureRealizationInput(repoRoot, inputRef) {
  let explained = null;
  return readJsonInput(repoRoot, inputRef, {
    validate: (value) => {
      explained = explainTodoStructureRealization(value);
      return explained.valid;
    },
    invalidCode: 'INVALID_TODO_STRUCTURE_REALIZATION',
  }).catch((error) => {
    if (error?.code === 'INVALID_TODO_STRUCTURE_REALIZATION' && explained !== null) {
      throw new TodoStoreError(error.code, explained.reason, undefined, {
        input_ref: inputRef, path: explained.path,
      });
    }
    throw error;
  });
}

async function readStructureRealizedTransformInput(repoRoot, inputRef) {
  let explained = null;
  return readJsonInput(repoRoot, inputRef, {
    validate: (value) => {
      explained = explainTodoStructureTransform(value);
      return explained.valid;
    },
    invalidCode: 'INVALID_TODO_STRUCTURE_TRANSFORM',
  }).catch((error) => {
    if (error?.code === 'INVALID_TODO_STRUCTURE_TRANSFORM' && explained !== null) {
      throw new TodoStoreError(error.code, explained.reason, undefined, {
        input_ref: inputRef, path: explained.path,
      });
    }
    throw error;
  });
}

async function readCurrentStructureEffective(repoRoot, structureSet) {
  const realizations = [];
  for (const task of structureSet.tasks.filter(({ applicability }) => applicability === 'graph')) {
    realizations.push(...await readTodoStructureRealizationChain({
      repoRoot, structureSet, taskId: task.task_id,
    }));
  }
  return projectTodoStructureEffective({ structureSet, realizations });
}

async function recordStructureRealization({ repoRoot, planKey, taskId, realization }) {
  const appended = await appendTodoStructureRealization({ repoRoot, realization });
  const structureSet = await readTodoStructureSource({ repoRoot, planKey });
  const effective = await readCurrentStructureEffective(repoRoot, structureSet);
  const taskProjection = effective.tasks.find(({ task_id: id }) => id === taskId);
  const result = {
    schema: 'lattice.todo_structure_realize_result.v1',
    project_id: realization.project_id, plan_key: planKey,
    plan_version: realization.plan_version, task_id: taskId,
    realization_ref: appended.ref,
    realization_digest: realization.realization_digest,
    previous_realization_digest: appended.previous_realization_digest,
    history_length: appended.history_length,
    effective: taskProjection,
    next_action: `lattice todo done --plan ${planKey} --task ${taskId} --evidence <file>`,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function structureRealize({ repoRoot, env, planKey, taskId, inputRef }) {
  const realization = await readStructureRealizationInput(repoRoot, inputRef);
  const actor = mutationActor(env);
  if (realization.plan_key !== planKey || realization.task_id !== taskId) {
    throw new TodoStoreError('STRUCTURE_REALIZATION_BINDING_MISMATCH',
      'cli_target_mismatch', undefined, {
        expected: { plan_key: planKey, task_id: taskId },
        actual: { plan_key: realization.plan_key, task_id: realization.task_id },
      });
  }
  if (canonicalizeTodoArtifact(realization.actor) !== canonicalizeTodoArtifact(actor)) {
    throw new TodoStoreError('STRUCTURE_REALIZATION_BINDING_MISMATCH',
      'actor_environment_mismatch', undefined, {
      expected_actor: actor, actual_actor: realization.actor,
    });
  }
  return recordStructureRealization({ repoRoot, planKey, taskId, realization });
}

function resolveStructureRealizationCommits(repoRoot, refs) {
  const requested = refs.length === 0 ? ['HEAD'] : refs;
  if (requested.length > TODO_STRUCTURE_LIMITS.commitsPerRealization) {
    throw new TodoStoreError('STRUCTURE_REALIZATION_COMMIT_REF_INVALID',
      'commit_ref_count_exceeds_limit', undefined, {
        actual: requested.length, limit: TODO_STRUCTURE_LIMITS.commitsPerRealization,
      });
  }
  const resolved = [];
  for (const ref of requested) {
    if (!(ref === 'HEAD' || /^[0-9a-f]{40}$/u.test(ref))) {
      throw new TodoStoreError('STRUCTURE_REALIZATION_COMMIT_REF_INVALID',
        'commit_ref_must_be_head_or_full_sha', undefined, { commit_ref: ref });
    }
    let oid;
    try {
      oid = gitSync(['rev-parse', '--verify', `${ref}^{commit}`], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new TodoStoreError('STRUCTURE_REALIZATION_COMMIT_REF_INVALID',
        'commit_ref_unresolved', undefined, { commit_ref: ref });
    }
    if (!/^[0-9a-f]{40}$/u.test(oid)) {
      throw new TodoStoreError('STRUCTURE_REALIZATION_COMMIT_REF_INVALID',
        'commit_ref_resolved_invalid_oid', undefined, { commit_ref: ref });
    }
    if (resolved.includes(oid)) {
      throw new TodoStoreError('STRUCTURE_REALIZATION_COMMIT_REF_INVALID',
        'duplicate_commit_ref', undefined, { commit_ref: ref, commit_oid: oid });
    }
    resolved.push(oid);
  }
  return resolved.sort();
}

async function structureRealizeActual({
  repoRoot, env, planKey, taskId, realizedRef, usePlanned, commitRefs,
}) {
  const structureSet = await readTodoStructureSource({ repoRoot, planKey });
  if (structureSet === null) {
    throw new TodoStoreError('STRUCTURE_REALIZATION_BINDING_MISMATCH',
      'planned_structure_source_missing', undefined, { plan_key: planKey });
  }
  const task = structureSet.tasks.find(({ task_id: id }) => id === taskId);
  if (task?.applicability !== 'graph') {
    throw new TodoStoreError('STRUCTURE_REALIZATION_BINDING_MISMATCH',
      'task_not_graph_applicable', undefined, { plan_key: planKey, task_id: taskId });
  }
  const realized = usePlanned
    ? structuredClone(task.planned)
    : await readStructureRealizedTransformInput(repoRoot, realizedRef);
  const chain = await readTodoStructureRealizationChain({
    repoRoot, structureSet, taskId,
  });
  const previous = chain.at(-1) ?? null;
  const realization = {
    schema: TODO_STRUCTURE_REALIZATION_SCHEMA,
    project_id: structureSet.project_id,
    plan_key: structureSet.plan_key,
    plan_version: structureSet.plan_version,
    task_id: taskId,
    sequence: (previous?.sequence ?? 0) + 1,
    previous_digest: previous?.realization_digest ?? null,
    structure_set_digest: structureSet.structure_set_digest,
    planned_digest: digestTodoStructureTransform(task.planned),
    head_sha: currentHeadSha(repoRoot),
    commit_oids: resolveStructureRealizationCommits(repoRoot, commitRefs),
    realized,
    supersedes: previous?.realization_digest ?? null,
    actor: mutationActor(env),
    recorded_at: new Date().toISOString(),
    realization_digest: '',
  };
  realization.realization_digest = todoSelfDigest(realization, 'realization_digest');
  return recordStructureRealization({ repoRoot, planKey, taskId, realization });
}

async function structureFinalize({ repoRoot, env, planKey }) {
  const store = await readTodoStore({ repoRoot });
  const member = structurePlanMember(store, planKey);
  const source = await readTodoStructureSource({ repoRoot, planKey });
  const binding = await readTodoStructureBinding({
    repoRoot, planKey, planVersion: member.plan.plan_version,
  });
  if (source === null || binding === null
    || source.structure_set_digest !== binding.structure_set_digest) {
    throw new TodoStoreError('STRUCTURE_FINALIZATION_UNAVAILABLE',
      'structure_not_enabled_or_stale', undefined, {
        plan_key: planKey,
        next_action: `lattice todo structure compile --plan ${planKey} --input .lattice/todo/structure/${planKey}.json`,
      });
  }
  const incompleteTaskIds = member.tasks
    .filter(({ status }) => status !== 'done')
    .map(({ task_id: taskId }) => taskId).sort();
  if (incompleteTaskIds.length > 0) {
    throw new TodoStoreError('STRUCTURE_FINALIZATION_UNAVAILABLE',
      'plan_not_fully_done', undefined, {
        plan_key: planKey, incomplete_task_ids: incompleteTaskIds,
      });
  }
  const realizations = [];
  const effectiveTransforms = new Map();
  for (const task of source.tasks.filter(({ applicability }) => applicability === 'graph')) {
    const chain = await readTodoStructureRealizationChain({
      repoRoot, structureSet: source, taskId: task.task_id,
    });
    const latest = chain.at(-1);
    if (latest === undefined) {
      throw new TodoStoreError('STRUCTURE_FINALIZATION_UNAVAILABLE',
        'realization_missing', undefined, {
          plan_key: planKey, task_id: task.task_id,
          next_action: `lattice todo structure realize --plan ${planKey} --task ${task.task_id} --realized <actual-structure.json>`,
        });
    }
    realizations.push(...chain);
    effectiveTransforms.set(task.task_id, latest.realized);
  }
  const actor = mutationActor(env);
  const observation = await collectTodoStructureAuthoritativeObservation({
    repoRoot, structureSet: source, effectiveTransforms,
  });
  const sourceEvidence = observation.source_evidence;
  const gitProvenance = observation.git_provenance;
  const overlay = compileTodoStructureOverlay({
    structureSet: source,
    topology: mergedTopology(store),
    taskStates: member.tasks.map(({ task_id: taskId, status }) => ({ task_id: taskId, status })),
    sourceProjection: sourceEvidence.projection,
    gitProvenance,
    realizations,
  });
  const artifact = buildTodoStructureCompileArtifact({
    structureSet: source, sourceProjection: sourceEvidence.projection,
    gitProvenance, overlay, realizations,
    compiledAt: new Date().toISOString(), actor,
  });
  let finalizationRef = null;
  if (overlay.verdict === 'consistent') {
    finalizationRef = (await writeTodoStructureFinalization({ repoRoot, artifact })).ref;
  }
  const finalizationNextActions = [...new Set([
    ...overlay.findings.map(({ next_action: nextAction }) => nextAction),
    `lattice todo structure finalize --plan ${planKey} --json`,
  ])];
  const result = {
    schema: 'lattice.todo_structure_finalize_result.v1',
    project_id: source.project_id, plan_key: source.plan_key,
    plan_version: source.plan_version, topology_digest: source.topology_digest,
    structure_set_digest: source.structure_set_digest,
    current_head_sha: artifact.current_head_sha,
    realization_head_digest: artifact.realization_head_digest,
    verdict: overlay.verdict, finalized: finalizationRef !== null,
    finalization_ref: finalizationRef,
    finalization_digest: finalizationRef === null ? null : artifact.artifact_digest,
    finding_summary: overlay.finding_summary, findings: overlay.findings,
    next_actions: finalizationRef === null
      ? finalizationNextActions
      : [`lattice todo phase status --plan ${planKey}`],
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function structure({ repoRoot, requestedPlanKey }) {
  const store = await readTodoStore({ repoRoot });
  const member = structurePlanMember(store, requestedPlanKey);
  const state = await readTodoStructureState({
    repoRoot, store, planKey: member.plan.plan_key,
  });
  const unboundVerdict = state.status === 'missing'
    && state.reason === 'activation_binding_missing'
    && ['inconsistent', 'unknown'].includes(state.compiled_verdict)
    ? state.compiled_verdict : null;
  const coverage = unboundVerdict
    ?? (state.status === 'fresh' ? state.effective_verdict : state.status);
  const findings = state.artifact?.overlay?.findings ?? [];
  const source = await readTodoStructureSource({ repoRoot, planKey: member.plan.plan_key });
  const effective = source !== null && source.plan_version === member.plan.plan_version
    ? await readCurrentStructureEffective(repoRoot, source) : null;
  const nextActions = structureNextActions({
    coverage, planKey: member.plan.plan_key, findings, staleReasons: state.stale_reasons,
  });
  const finalization = await readTodoStructureFinalizationState({
    repoRoot, store, planKey: member.plan.plan_key,
  });
  const result = {
    schema: 'lattice.todo_structure_projection.v1',
    project_id: store.project_id, plan_key: member.plan.plan_key,
    plan_version: member.plan.plan_version, topology_digest: member.plan.topology_digest,
    coverage, freshness: state.status,
    enabled: state.binding_digest !== null,
    structure_set_digest: state.structure_set_digest,
    artifact_digest: state.artifact_digest,
    compiled_verdict: state.compiled_verdict,
    verdict: unboundVerdict ?? state.effective_verdict,
    stale_reasons: state.stale_reasons,
    graph: state.artifact?.overlay?.graph ?? null,
    finding_summary: state.artifact?.overlay?.finding_summary ?? null,
    findings,
    effective,
    finalization: {
      required: finalization.required, status: finalization.status,
      reason: finalization.reason, finalization_digest: finalization.finalization_digest,
      stale_reasons: finalization.stale_reasons,
    },
    next_actions: nextActions,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function independenceCompile({ repoRoot, planKey, inputRef }) {
  const witnessSet = await readWitnessSetInput(repoRoot, inputRef);
  const storeForReady = await readTodoStore({ repoRoot });
  const memberForReady = storeForReady.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (!memberForReady) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, { plan_key: planKey });
  }
  const planTaskIds = new Set(memberForReady.plan.tasks.map(({ task_id: taskId }) => taskId));
  const declaredIds = Object.keys(witnessSet.manual_witness ?? {});
  const absentFromPlan = declaredIds.filter((taskId) => !planTaskIds.has(taskId)).sort();
  if (absentFromPlan.length > 0) {
    throw new TodoIndependenceError(
      'INDEPENDENCE_TASK_ABSENT',
      'witness_task_absent_from_plan',
      { task_ids: absentFromPlan },
    );
  }
  const readyIds = projectTodoStatus(storeForReady, TODO_STATUS_DISPATCH_ONLY).next_ready
    .filter((task) => task.plan_key === planKey)
    .map((task) => task.task_id);
  const declared = new Set(declaredIds);
  const missingReady = readyIds.filter((taskId) => !declared.has(taskId)).sort();
  if (missingReady.length > 0) {
    throw new TodoStoreError(
      'INDEPENDENCE_READY_UNDECLARED',
      'ready_tasks_missing_from_witness',
      undefined,
      {
        plan_key: planKey,
        missing_task_ids: missingReady,
        next_action: 'add_task_to_witness_set_then_compile',
      },
    );
  }
  const observation = await collectTodoIndependenceAuthoritativeObservation({ repoRoot, witnessSet });
  const baseSha = observation.head_sha;
  const store = storeForReady;
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (!member) throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, { plan_key: planKey });

  // 前回artifactを渡して膨張の履歴を継ぐ。**例外を握り潰さない。**
  // `readTodoIndependenceArtifact` は「欠落だけnull・旧版はlegacy marker・壊れた記録は
  // INDEPENDENCE_ARTIFACT_INVALIDでtyped fail」を既に区別している。ここでcatchすると
  // **corrupt/permission/I-Oまで「初回」へ化けて履歴が黙って切れる**（suzune の監査で実測・room [1148]）。
  const previousArtifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
  const artifact = compileTodoIndependence({
    witnessSet,
    plan: member.plan,
    baseSha,
    compiledAt: new Date().toISOString(),
    sensorEvidence: observation.sensor_evidence,
    previousArtifact,
  });
  const { ref } = await writeTodoIndependenceArtifact({ repoRoot, artifact });
  // compile成功後にだけ、受理した宣言をruntime readerが要求するcanonical bytesで固定する。
  // inputがstore自身でも外部draftでも、唯一の正規writerを通して同じ契約へ収束させる。
  await writeTodoWitnessSet({ repoRoot, witnessSet });

  const result = {
    schema: 'lattice.todo_independence_compile_result.v2',
    project_id: artifact.project_id,
    plan_key: artifact.plan_key,
    plan_version: artifact.plan_version,
    base_sha: artifact.base_sha,
    artifact_ref: ref,
    outcome: artifact.outcome,
    task_count: artifact.task_ids.length,
    conflict_count: artifact.conflicts.length,
    unknown_count: artifact.unknowns.length,
    scope_expansion_recommendations: scopeExpansionRecommendations(artifact.scope_expanded),
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * revision後のwitness宣言をtask migrationで写す（ADR 0128 Decision 6）。
 *
 * compileしないので証拠を固定化せず、dirty worktreeを拒否しない。
 * 想定運用は「移行 → commit → cleanな状態でcompile」である。
 */
async function independenceWitnessMigrate({ repoRoot, planKey }) {
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (!member) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, { plan_key: planKey });
  }
  const witnessSet = await readTodoWitnessSet({ repoRoot, planKey });
  if (witnessSet === null) {
    throw new TodoStoreError('WITNESS_MIGRATION_UNAVAILABLE', 'witness_set_absent', undefined, {
      witness_ref: todoWitnessRef(planKey),
    });
  }
  const revision = member.revision;
  if (!revision || !Array.isArray(revision.task_migration)) {
    // revisionを経ていないplanには写す先が無い。「移行済み」と装わない。
    throw new TodoStoreError('WITNESS_MIGRATION_UNAVAILABLE', 'plan_has_no_revision', undefined, {
      plan_key: planKey, plan_version: member.plan.plan_version,
    });
  }

  const migration = migrateWitnessSetTaskIds({
    witnessSet,
    taskMigration: revision.task_migration,
    planTaskIds: member.plan.tasks.map(({ task_id: taskId }) => taskId),
  });
  const { ref } = await writeTodoWitnessSet({ repoRoot, witnessSet: migration.witnessSet });

  const result = {
    schema: 'lattice.todo_witness_migrate_result.v1',
    project_id: store.project_id,
    plan_key: planKey,
    plan_version: member.plan.plan_version,
    witness_ref: ref,
    migrated_count: migration.migrated_count,
    removed_count: migration.removed_count,
    unchanged_count: migration.unchanged_count,
    witness_set_digest: migration.witnessSet.witness_set_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function independence({ repoRoot, requestedPlanKey }) {
  const store = await readTodoStore({ repoRoot });
  if (requestedPlanKey !== null
    && !store.members.some(({ descriptor }) => descriptor.plan_key === requestedPlanKey)) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, {
      plan_key: requestedPlanKey,
    });
  }
  const frontier = computeReadyFrontier(store);
  const readyPlanKeys = [...new Set(frontier.map(({ plan_key: key }) => key))].sort();
  // planを絞らない呼び出しではreadyがどのplanを指しているかで決める。readyが無い時は
  // 全planが候補になる。どちらの場合も候補が複数なら、片方だけ見せて答えたことにしない。
  // ここで黙ってnullへ倒すと、記録があるのにcoverage missingと報告してしまう。
  const candidatePlanKeys = readyPlanKeys.length > 0
    ? readyPlanKeys
    : store.members.map(({ descriptor }) => descriptor.plan_key).sort();
  if (requestedPlanKey === null && candidatePlanKeys.length > 1) {
    throw new TodoStoreError('INDEPENDENCE_PLAN_AMBIGUOUS', 'plan_selection_ambiguous', undefined, {
      plan_keys: candidatePlanKeys,
      ready_plan_keys: readyPlanKeys,
      next_action: 'rerun_with_plan_flag',
    });
  }
  const planKey = requestedPlanKey ?? candidatePlanKeys[0] ?? null;

  const currentBaseSha = currentHeadSha(repoRoot);
  const ready = frontier.filter((task) => task.plan_key === planKey);
  const member = planKey === null
    ? undefined : store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  const artifact = member === undefined
    ? null : await readTodoIndependenceArtifact({ repoRoot, store, planKey });
  const active = projectTodoStatus(store, TODO_STATUS_DISPATCH_ONLY).active_set
    .filter((task) => task.plan_key === planKey);
  // HEADが進んでいる時だけdiffを取る。一致していれば宣言境界を見るまでもない。
  const changedPaths = artifact !== null && artifact.base_sha !== null
    && artifact.base_sha !== currentBaseSha
    ? changedPathsSince(repoRoot, artifact.base_sha) : null;

  const projected = projectIndependenceFrontier({
    artifact,
    readyTaskIds: ready.map(({ task_id: taskId }) => taskId),
    activeTaskIds: active.map(({ task_id: taskId }) => taskId),
    plan: member?.plan ?? { plan_version: null, topology_digest: null },
    currentBaseSha,
    changedPaths,
  });

  const result = {
    schema: TODO_INDEPENDENCE_PROJECTION_SCHEMA,
    project_id: store.project_id,
    plan_key: planKey,
    coverage: projected.coverage,
    compiled_base_sha: artifact?.base_sha ?? null,
    current_base_sha: currentBaseSha,
    plan_version: artifact?.plan_version ?? null,
    topology_digest: artifact?.topology_digest ?? null,
    active_task_ids: projected.active_task_ids,
    uncovered_active_task_ids: projected.uncovered_active_task_ids,
    drift: projected.drift,
    // planを読みに来た人にも、着手する人と同じ文言を返す（ADR 0130 Decision 1）。
    guidance: selectIndependenceGuidance({
      coverage: projected.coverage,
      // 旧契約markerはreadyが空でも「対象なし」へ隠さず、superseded guidanceを返す。
      readyCount: isTodoIndependenceLegacyMarker(artifact) ? null : ready.length,
      contractSuperseded: isTodoIndependenceLegacyMarker(artifact),
      taskDeclared: projected.frontier.unknown
        .every(({ unknowns }) => !unknowns.some(({ kind }) => kind === 'witness_missing')),
      taskStale: projected.frontier.unknown
        .some(({ unknowns }) => unknowns.some(({ kind }) => kind === 'record_stale')),
      conflictWithActive: projected.frontier.conflicts_with_active[0]?.severability ?? null,
      conflictBetweenReady: projected.frontier.serialize_pairs[0]?.severability ?? null,
      // 案内の正本は1つ（ADR 0130 Decision 1）。着手する人と読みに来た人が同じ状況について
      // 違う文言を受け取らないよう、調整方式もここへ渡す。
      coordinationMode: member?.coordination?.mode ?? null,
      verdictsAbsent: projected.frontier.unknown
        .some(({ unknowns }) => unknowns.some(({ kind }) => kind === 'plan_verdicts_absent')),
    }),
    frontier: projected.frontier,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  if (!validateTodoIndependenceProjection(result)) {
    throw new TodoStoreError('INDEPENDENCE_PROJECTION_INVALID', 'independence_projection_invalid');
  }
  return result;
}

/**
 * 切断コストの内訳を投影する（read-only、docs/plan_seam-cost.md）。
 *
 * 係争fileについて「何を共有しているから単純に切れないのか」を数えられる事実として出す。
 * task別のsymbol帰属はwitness setのconcern_anchorsから取る——係争資源に対する宣言は
 * そこに既に在り、ここで発明しない。閾値も可否判定も返さない。
 *
 * 投影であって記録ではない。sensorが進めば変わる値なので、artifactへ焼き込まず
 * stdoutへ返すだけにする（ADR 0127のindependence記録と同じ線）。
 */
async function seamProfile({ repoRoot, planKey, filePath }) {
  const witnessSet = await readTodoWitnessSet({ repoRoot, planKey });
  if (witnessSet === null) {
    throw new TodoStoreError('SEAM_PROFILE_UNAVAILABLE', 'witness_set_absent', undefined, {
      plan_key: planKey, next_action: 'declare_witness_set',
    });
  }
  const ownedSymbolsByTask = {};
  for (const [taskId, witness] of Object.entries(witnessSet.manual_witness ?? {})) {
    const symbols = (witness.concern_anchors ?? [])
      .filter((anchor) => anchor.within?.target === filePath)
      .flatMap((anchor) => anchor.symbols);
    if (symbols.length > 0) ownedSymbolsByTask[taskId] = [...symbols].sort();
  }
  if (Object.keys(ownedSymbolsByTask).length < 2) {
    // 帰属が2 task未満なら「切断のコスト」という問いが立たない。宣言が無いことを
    // 空の内訳へ丸めず、何を書けば観測できるかを返す（ADR 0130の案内規律）。
    throw new TodoStoreError('SEAM_PROFILE_UNAVAILABLE', 'concern_anchors_below_two_tasks', undefined, {
      plan_key: planKey, file: filePath,
      next_action: 'declare_concern_anchors_for_contested_file',
    });
  }
  let sourceText;
  try {
    sourceText = await readFile(path.join(repoRoot, filePath), 'utf8');
  } catch {
    throw new TodoStoreError('SEAM_PROFILE_UNAVAILABLE', 'contested_file_unreadable', undefined, {
      file: filePath,
    });
  }
  const { computeSeamCostProfile } = await import('./seam-cost.mjs');
  const { profile, reasons } = await computeSeamCostProfile({
    repoRoot, sourcePath: filePath, sourceText, ownedSymbolsByTask,
  });
  if (profile === null) {
    throw new TodoStoreError('SEAM_PROFILE_UNAVAILABLE', reasons[0] ?? 'profile_unavailable');
  }
  return profile;
}

async function seamProposalCompile({ repoRoot, planKey }) {
  const currentBaseSha = currentHeadSha(repoRoot);
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (!member) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, {
      plan_key: planKey,
    });
  }
  const independenceArtifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
  if (independenceArtifact === null || !validateTodoIndependence(independenceArtifact)) {
    throw new TodoStoreError(
      'SEAM_PROPOSAL_COMPILE_UNAVAILABLE',
      independenceArtifact === null ? 'independence_artifact_absent' : 'independence_artifact_superseded',
      undefined,
      { next_action: 'compile_independence' },
    );
  }
  if (independenceArtifact.outcome !== 'compiled') {
    throw new TodoStoreError('SEAM_PROPOSAL_COMPILE_UNAVAILABLE', 'independence_outcome_not_compiled', undefined, {
      outcome: independenceArtifact.outcome,
      next_action: 'recompile_independence',
    });
  }
  if (independenceArtifact.base_sha !== currentBaseSha) {
    throw new TodoStoreError('SEAM_PROPOSAL_COMPILE_UNAVAILABLE', 'independence_artifact_stale', undefined, {
      independence_base_sha: independenceArtifact.base_sha,
      current_base_sha: currentBaseSha,
      next_action: 'recompile_independence',
    });
  }
  const witnessSet = await readTodoWitnessSet({ repoRoot, planKey });
  if (witnessSet === null) {
    throw new TodoStoreError('SEAM_PROPOSAL_COMPILE_UNAVAILABLE', 'witness_set_absent', undefined, {
      next_action: 'declare_witness_set_then_compile_independence',
    });
  }
  if (witnessSet.witness_set_digest !== independenceArtifact.witness_set_digest) {
    throw new TodoStoreError('SEAM_PROPOSAL_COMPILE_UNAVAILABLE', 'witness_set_changed', undefined, {
      next_action: 'recompile_independence',
    });
  }

  const { query_set: querySet } = buildSeamProposalQuerySet({
    conflictResources: independenceArtifact.conflict_resources,
    concernSymbols: declaredConcernSymbols(witnessSet.manual_witness),
  });
  const [sensorEvidence, proposalEvidence] = await Promise.all([
    collectWitnessSensorEvidence({ cwd: repoRoot, witnessSet }),
    collectSeamProposalEvidenceBundle({ cwd: repoRoot, querySet }),
  ]);
  const artifact = compileSeamProposalArtifact({
    independenceArtifact,
    witnessSet,
    plan: member.plan,
    compiledAt: new Date().toISOString(),
    sensorEvidence,
    evidence: proposalEvidence.evidence,
    rawCollected: proposalEvidence.raw_collected,
  });
  const { ref } = await writeTodoSeamProposalArtifact({ repoRoot, artifact });
  const verdictCounts = {
    seam_candidate: artifact.decisions.filter(({ verdict }) => verdict === 'seam_candidate').length,
    intentional_serial: artifact.decisions
      .filter(({ verdict }) => verdict === 'intentional_serial').length,
    unknown_requires_evidence: artifact.decisions
      .filter(({ verdict }) => verdict === 'unknown_requires_evidence').length,
  };
  const result = {
    schema: 'lattice.seam_proposal_compile_result.v1',
    project_id: artifact.project_id,
    plan_key: artifact.plan_key,
    plan_version: artifact.source_binding.plan_version,
    base_sha: artifact.source_binding.base_sha,
    artifact_ref: ref,
    component_count: artifact.decisions.length,
    conflict_resource_count: artifact.decisions
      .reduce((count, decision) => count + decision.conflicts.length, 0),
    verdict_counts: verdictCounts,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * 下書きとfresh観測から、そのまま通るwitness setを書き出す。
 *
 * 推定はしない。何を所有し何を触るかは下書きが述べ、ここが供給するのはAIには作れないもの——
 * affected testのfresh観測、query setとprovenanceの配線、canonical bytesと自己digest——だけである。
 */
async function witnessScaffold({ repoRoot, planKey, inputRef }) {
  const draft = await readJsonInput(repoRoot, inputRef, {
    validate: validateWitnessDraft,
    invalidCode: 'WITNESS_DRAFT_INVALID',
  });
  if (draft.plan_key !== planKey) {
    throw new TodoStoreError('INPUT_INVALID', 'witness_draft_plan_mismatch', undefined, {
      draft_plan_key: draft.plan_key, plan_key: planKey,
    });
  }
  const { queries, paths } = buildWitnessObservationQuerySet(draft);
  const collected = await collectSensorEvidence({ cwd: repoRoot, querySet: { queries } });
  const observationByPath = {};
  queries.forEach((query, index) => {
    if (query.operation !== 'affected') return;
    const entry = collected.outcomes[index]?.targets?.[0];
    // 観測できていないものを空配列へ丸めない。丸めるとdriftでcompileが落ちる。
    // 不存在（absent）は観測**できている**——fsのlstat結果である。未観測と混ぜると、
    // 創作境界を宣言したToDoが「まだ確かめていない」側へ落ちる（ADR 0136）。
    if (!Array.isArray(entry?.data?.affectedTests) || !Array.isArray(entry?.data?.changedFiles)) return;
    observationByPath[query.target] = {
      state: entry.path_state === 'absent' ? 'absent' : 'present',
      affectedTests: [...entry.data.affectedTests],
      changedFiles: [...entry.data.changedFiles],
    };
  });
  const { witnessSet, reasons } = buildWitnessSet({ draft, observationByPath });
  if (witnessSet === null) {
    // 理由コードは具体的なのに次の一手が汎用だと、何をどう直すのかが伝わらない。
    const guidance = selectWitnessScaffoldGuidance(reasons);
    throw new TodoStoreError('WITNESS_SCAFFOLD_INCOMPLETE', 'witness_scaffold_incomplete', undefined, {
      reasons, guidance, next_action: guidance.next_action,
    });
  }
  const ref = todoWitnessRef(planKey);
  await mkdir(path.dirname(path.join(repoRoot, ref)), { recursive: true });
  await writeFile(path.join(repoRoot, ref), serializeWitnessSet(witnessSet));
  return {
    schema: 'lattice.todo_witness_scaffold_result.v1',
    project_id: draft.project_id,
    plan_key: planKey,
    witness_ref: ref,
    observed_paths: paths,
    task_count: Object.keys(witnessSet.manual_witness).length,
    witness_set_digest: witnessSet.witness_set_digest,
    next_action: 'compile_independence',
  };
}

/**
 * 着地時に使うsurface名。提案が出すhash由来の仮名を、人が読む名前へ置き換える。
 *
 * 名前を付けるのは判断なので製品が発明しない（AGENTS.md「装置の境界」）。与えられた名前は
 * 導出の入力として最初から使う——後から改名すると、生成済みのimport指定子が旧名を指す。
 */
async function readSeamPathNames(repoRoot, inputRef) {
  const value = await readJsonInput(repoRoot, inputRef, {
    validate: (candidate) => candidate !== null && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && candidate.schema === 'lattice.seam_path_names.v1'
      && typeof candidate.names === 'object' && candidate.names !== null
      && !Array.isArray(candidate.names)
      && Object.entries(candidate.names)
        .every(([key, target]) => isTodoIdentifier(key) && isTodoRef(target)),
    invalidCode: 'SEAM_PATH_NAMES_INVALID',
    expected: {
      schema: 'lattice.seam_path_names.v1',
      shape: '{ "schema": "lattice.seam_path_names.v1", "names": { "<task_id>": "<repo相対path>" } }',
      note: '所有面はtask_idごとに、共有面は"shared"というkeyで名前を与える',
    },
  });
  return value.names;
}

/**
 * 記録済みseam提案を隔離worktreeで適用し、五条件で採否を決める（ADR 0137・0138）。
 *
 * 本repositoryは変更しない。採用された変換の着地は別入口が持つ——検証と着地を同じ操作に
 * すると、五条件を満たさない変換が「途中まで着地した」状態を作りうる。
 */
async function seamProposalApply({ repoRoot, planKey, pathNames = {}, land = false }) {
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (!member) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, { plan_key: planKey });
  }
  const artifact = await readTodoSeamProposalArtifact({ repoRoot, store, planKey });
  if (artifact === null) {
    throw new TodoStoreError('SEAM_PROPOSAL_COMPILE_UNAVAILABLE', 'seam_proposal_absent', undefined, {
      plan_key: planKey, next_action: 'compile_seam_proposal',
    });
  }
  const witnessSet = await readTodoWitnessSet({ repoRoot, planKey });
  if (witnessSet === null) {
    throw new TodoStoreError('SEAM_PROPOSAL_COMPILE_UNAVAILABLE', 'witness_set_absent', undefined, {
      plan_key: planKey, next_action: 'declare_witness_set_then_compile_independence',
    });
  }
  const baseArtifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
  const { outcome: result, files } = await applySeamProposal({
    repoRoot,
    planKey,
    pathNames,
    sourceProposal: artifact,
    witnessSet,
    // 配布物内の自分自身を指す。repoRoot配下を指すと、Lattice自身のrepositoryでしか動かない
    // ——消費側のprojectに`bin/lattice.mjs`は存在しない。
    latticeBin: fileURLToPath(new URL('../bin/lattice.mjs', import.meta.url)),
    sharedPathFor: (sourcePath) => sourcePath.replace(/(\.[^./]+)$/u, '.seam-shared$1'),
    executors: witnessSet.capacity.executors,
    precedences: todoPlanPrecedences(member.plan),
    compileIndependence: {
      baseArtifact,
      // 変換後のworktreeで、写した宣言と再indexした索引から実compileする。
      // 仮想再compileの再実行では、実ソースで残余0である証拠にならない（ADR 0137 Decision 4）。
      inWorktree: async ({ worktreePath, witnessSet: postWitness }) => compileTodoIndependence({
        witnessSet: postWitness,
        plan: member.plan,
        baseSha: artifact.source_binding.base_sha,
        compiledAt: new Date().toISOString(),
        sensorEvidence: await collectWitnessSensorEvidence({
          cwd: worktreePath, witnessSet: postWitness,
        }),
      }),
    },
  });
  if (!land) return result;
  // 着地は採用された変換だけへ。検証と着地を同じ操作にしないのは、五条件を満たさない変換が
  // 途中まで着地した状態を作らないためである（ADR 0137）。
  if (result.decision !== 'accepted' || files === null) {
    return { ...result, landed: false, landed_paths: [] };
  }
  const landed = [];
  for (const [target, text] of Object.entries(files)) {
    const absolute = path.join(repoRoot, target);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    landed.push(target);
  }
  return { ...result, landed: true, landed_paths: landed.sort() };
}

function summarizeSeamProposalDecision(decision) {
  return {
    component_id: decision.component_id,
    verdict: decision.verdict,
    task_ids: decision.task_ids,
    conflicts: decision.conflicts.map(({
      resource_id: resourceId, kind, target, task_pairs: taskPairs,
    }) => ({
      resource_id: resourceId,
      kind,
      target,
      task_pairs: taskPairs,
    })),
    proposed_surfaces: decision.seam_candidate?.proposed_surfaces ?? [],
    affected_tests: decision.seam_candidate?.affected_tests ?? [],
    limits: decision.seam_candidate?.limits ?? [],
    reasons: decision.reasons,
    unknowns: decision.unknowns,
  };
}

async function seamProposal({ repoRoot, requestedPlanKey }) {
  const store = await readTodoStore({ repoRoot });
  if (requestedPlanKey !== null
    && !store.members.some(({ descriptor }) => descriptor.plan_key === requestedPlanKey)) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, {
      plan_key: requestedPlanKey,
    });
  }
  const frontier = computeReadyFrontier(store);
  const readyPlanKeys = [...new Set(frontier.map(({ plan_key: key }) => key))].sort();
  const candidatePlanKeys = readyPlanKeys.length > 0
    ? readyPlanKeys
    : store.members.map(({ descriptor }) => descriptor.plan_key).sort();
  if (requestedPlanKey === null && candidatePlanKeys.length > 1) {
    throw new TodoStoreError('SEAM_PROPOSAL_PLAN_AMBIGUOUS', 'plan_selection_ambiguous', undefined, {
      plan_keys: candidatePlanKeys,
      ready_plan_keys: readyPlanKeys,
      next_action: 'rerun_with_plan_flag',
    });
  }
  const planKey = requestedPlanKey ?? candidatePlanKeys[0] ?? null;
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  const currentBaseSha = currentHeadSha(repoRoot);
  const independenceArtifact = member === undefined
    ? null : await readTodoIndependenceArtifact({ repoRoot, store, planKey });
  const artifact = member === undefined
    ? null : await readTodoSeamProposalArtifact({ repoRoot, store, planKey });

  let coverage = 'verified';
  if (artifact === null) coverage = 'missing';
  else {
    const binding = artifact.source_binding;
    const independenceMatches = independenceArtifact !== null
      && validateTodoIndependence(independenceArtifact)
      && independenceArtifact.schema === binding.independence_schema
      && independenceArtifact.result_digest === binding.independence_result_digest
      && independenceArtifact.witness_set_digest === binding.witness_set_digest
      && independenceArtifact.plan_version === binding.plan_version
      && independenceArtifact.topology_digest === binding.topology_digest
      && independenceArtifact.base_sha === binding.base_sha;
    const planMatches = member !== undefined
      && member.plan.plan_version === binding.plan_version
      && member.plan.topology_digest === binding.topology_digest;
    if (!independenceMatches || !planMatches) coverage = 'superseded';
    else if (binding.base_sha !== currentBaseSha) coverage = 'stale';
  }

  const components = artifact?.decisions.map(summarizeSeamProposalDecision) ?? [];
  const result = {
    schema: SEAM_PROPOSAL_PROJECTION_SCHEMA,
    project_id: store.project_id,
    plan_key: planKey,
    coverage,
    compiled_base_sha: artifact?.source_binding.base_sha ?? null,
    current_base_sha: currentBaseSha,
    plan_version: artifact?.source_binding.plan_version ?? null,
    topology_digest: artifact?.source_binding.topology_digest ?? null,
    independence_result_digest: artifact?.source_binding.independence_result_digest ?? null,
    compiled_at: artifact?.compiled_at ?? null,
    guidance: selectSeamProposalGuidance({
      coverage,
      unknownKinds: components.flatMap(({ unknowns }) => unknowns.map(({ kind }) => kind)),
    }),
    component_count: artifact === null ? null : components.length,
    conflict_resource_count: artifact === null ? null : components
      .reduce((count, component) => count + component.conflicts.length, 0),
    components,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  if (!validateSeamProposalProjection(result)) {
    throw new TodoStoreError('SEAM_PROPOSAL_PROJECTION_INVALID', 'seam_proposal_projection_invalid');
  }
  return result;
}

async function readNarrative(repoRoot, ref) {
  const canonicalRoot = await realpath(repoRoot);
  const source = parseTodoSourceRef(ref);
  const fileRef = source?.path ?? ref;
  const absolute = path.resolve(canonicalRoot, fileRef);
  if (!within(canonicalRoot, absolute)) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'narrative_path_outside_repo', undefined, { ref });
  }
  let stats;
  try { stats = await lstat(absolute); } catch {
    throw new TodoStoreError('STORE_INCONSISTENT', 'narrative_missing', undefined, { ref });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'unsafe_narrative_path', undefined, { ref });
  }
  const resolved = await realpath(absolute);
  if (resolved !== absolute || !within(canonicalRoot, resolved)) {
    throw new TodoStoreError('STORE_INCONSISTENT', 'narrative_path_alias_or_escape', undefined, { ref });
  }
  const fileBytes = await readFile(resolved);
  let bytes = fileBytes;
  if (source !== null) {
    const lines = [];
    let start = 0;
    for (let index = 0; index <= fileBytes.length; index += 1) {
      if (index === fileBytes.length || fileBytes[index] === 0x0a) {
        lines.push(fileBytes.subarray(start, index));
        start = index + 1;
      }
    }
    bytes = lines[source.line - 1];
    if (bytes === undefined) {
      throw new TodoStoreError('STORE_INCONSISTENT', 'narrative_line_missing', undefined, { ref });
    }
  }
  let markdown;
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new TodoStoreError('STORE_INCONSISTENT', 'narrative_invalid_utf8', undefined, { ref });
  }
  return { markdown, content_digest: createHash('sha256').update(bytes).digest('hex') };
}

async function loadNarratives(store, repoRoot) {
  const content = new Map();
  const bindings = [];
  const narratives = [];
  for (const member of store.members) for (const task of member.plan.tasks) {
    const ref = taskRef(member.plan, task.task_id);
    if (task.narrative_ref === null) {
      bindings.push({ ...ref, narrative_ref: null, content_digest: null });
      narratives.push({ ref, markdown: '', narrative_ref: null, content_digest: null });
      continue;
    }
    let loaded = content.get(task.narrative_ref);
    if (loaded === undefined) {
      loaded = await readNarrative(repoRoot, task.narrative_ref);
      content.set(task.narrative_ref, loaded);
    }
    bindings.push({ ...ref, narrative_ref: task.narrative_ref, content_digest: loaded.content_digest });
    narratives.push({ ref, markdown: loaded.markdown, narrative_ref: task.narrative_ref,
      content_digest: loaded.content_digest });
  }
  return { narratives, bindings };
}

/**
 * 図が描く全planについて独立性を投影する（ADR 0129 Decision 4）。
 *
 * Ganttは複数planを同時に描くので、単一plan前提の`todo independence`の曖昧判定は持ち込まない。
 * plan単位で記録を引き、記録が無いplanは投影を持たないまま通す——描けない事実を
 * 図の側で作り出さない。
 */
/**
 * live配信の更新検知に使うhead digest（ADR 0129 Decision 6）。
 *
 * manifest_digestだけでは、独立性の再compileもHEAD前進も検知できず画面が古いまま残る。
 * 同じ値を描画側と検知側で別々に組み立てると、更新されない状態が静かに再発するため、
 * 一つの関数だけが組む。
 */
export async function ganttLiveHeadDigest({ repoRoot, store }) {
  const [independence, seamProposals, noteHeads, structures] = await Promise.all([
    independenceForGantt({ repoRoot, store }),
    seamProposalsForGantt({ repoRoot, store }),
    noteHeadsForGantt({ repoRoot, store }),
    loadTodoStructurePresentation({ repoRoot, readModel: store }),
  ]);
  return digestTodoArtifact({
    schema: 'lattice.todo_gantt_live_head.v3',
    manifest_digest: store.manifest.manifest_digest,
    independence: independence === null ? null : independence.map((entry) => ({
      plan_key: entry.plan_key,
      coverage: entry.coverage,
      frontier_digest: digestTodoArtifact(entry.frontier),
    })),
    seam_proposals: seamProposals.map((entry) => ({
      plan_key: entry.plan_key,
      coverage: entry.coverage,
      projection_digest: digestTodoArtifact(entry),
    })),
    note_heads: noteHeads,
    structure_projection_digest: structures.projection_digest,
  });
}

async function noteHeadsForGantt({ repoRoot, store }) {
  const bindings = [];
  for (const member of store.members) {
    try {
      const chain = await readTodoNoteEvents({ repoRoot, planKey: member.plan.plan_key });
      bindings.push({ plan_key: member.plan.plan_key, note_head_digest: chain.head_digest, error: null });
    } catch (error) {
      if (typeof error?.code !== 'string' || !error.code.startsWith('NOTE_')) throw error;
      bindings.push({ plan_key: member.plan.plan_key, note_head_digest: null, error: error.code });
    }
  }
  return bindings;
}

async function notesForGantt({ repoRoot, store }) {
  const contexts = [];
  const warnings = [];
  const headBindings = [];
  for (const member of store.members) {
    try {
      const projected = await readTodoNoteContextsForPlan({
        repoRoot, store, planKey: member.plan.plan_key,
      });
      contexts.push(...projected.contexts);
      headBindings.push({
        plan_key: member.plan.plan_key, note_head_digest: projected.note_head_digest,
      });
    } catch (error) {
      if (typeof error?.code !== 'string' || !error.code.startsWith('NOTE_')) throw error;
      warnings.push({ plan_key: member.plan.plan_key, code: error.code, message: error.message });
      headBindings.push({ plan_key: member.plan.plan_key, note_head_digest: null });
    }
  }
  return { contexts, warnings, headBindings };
}

async function independenceForGantt({ repoRoot, store }) {
  const frontier = computeReadyFrontier(store);
  const status = projectTodoStatus(store, TODO_STATUS_DISPATCH_ONLY);
  let currentBaseSha = null;
  const projections = [];
  for (const member of store.members) {
    const planKey = member.plan.plan_key;
    let artifact = null;
    let unreadableReason = null;
    try {
      artifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
    } catch (error) {
      if (!(error instanceof TodoStoreError)) throw error;
      unreadableReason = `${error.code}:${error.detail?.reason ?? error.message}`;
    }
    if (unreadableReason !== null) {
      if (currentBaseSha === null) currentBaseSha = currentHeadSha(repoRoot);
      const projected = projectIndependenceFrontier({
        artifact: null,
        readyTaskIds: frontier.filter((task) => task.plan_key === planKey)
          .map(({ task_id: taskId }) => taskId),
        activeTaskIds: status.active_set.filter((task) => task.plan_key === planKey)
          .map(({ task_id: taskId }) => taskId),
        plan: member.plan,
        currentBaseSha,
        changedPaths: null,
      });
      projections.push({
        project_id: member.plan.project_id,
        plan_key: planKey,
        coverage: 'unreadable',
        unreadable_reason: unreadableReason,
        frontier: projected.frontier,
      });
      continue;
    }
    if (artifact === null) continue;
    // 記録があるplanが1つでもあれば鮮度の判定にHEADが要る。
    if (currentBaseSha === null) currentBaseSha = currentHeadSha(repoRoot);
    const changedPaths = artifact.base_sha !== null && artifact.base_sha !== currentBaseSha
      ? changedPathsSince(repoRoot, artifact.base_sha) : null;
    const projected = projectIndependenceFrontier({
      artifact,
      readyTaskIds: frontier.filter((task) => task.plan_key === planKey)
        .map(({ task_id: taskId }) => taskId),
      activeTaskIds: status.active_set.filter((task) => task.plan_key === planKey)
        .map(({ task_id: taskId }) => taskId),
      plan: member.plan,
      currentBaseSha,
      changedPaths,
    });
    projections.push({
      project_id: member.plan.project_id,
      plan_key: planKey,
      coverage: projected.coverage,
      unreadable_reason: null,
      frontier: projected.frontier,
    });
  }
  return projections.length === 0 ? null : projections;
}

/**
 * 図が描く全planのseam提案記録を読む。生成は行わず、記録が無いplanもmissing guidanceを
 * 持つ投影として残すので、「提案対象なし」と「まだ生成していない」を混同しない。
 */
async function seamProposalsForGantt({ repoRoot, store }) {
  let currentBaseSha = null;
  const projections = [];
  for (const member of store.members) {
    const planKey = member.plan.plan_key;
    let artifact = null;
    try {
      artifact = await readTodoSeamProposalArtifact({ repoRoot, store, planKey });
    } catch (error) {
      if (!(error instanceof TodoStoreError)) throw error;
      projections.push({
        project_id: member.plan.project_id,
        plan_key: planKey,
        coverage: 'superseded',
        unreadable_reason: `${error.code}:${error.detail?.reason ?? error.message}`,
        guidance: selectSeamProposalGuidance({ coverage: 'superseded' }),
        component_count: null,
        conflict_resource_count: null,
        components: [],
      });
      continue;
    }
    if (artifact === null) {
      projections.push({
        project_id: member.plan.project_id,
        plan_key: planKey,
        coverage: 'missing',
        unreadable_reason: null,
        guidance: selectSeamProposalGuidance({ coverage: 'missing' }),
        component_count: null,
        conflict_resource_count: null,
        components: [],
      });
      continue;
    }

    if (currentBaseSha === null) currentBaseSha = currentHeadSha(repoRoot);
    let independenceArtifact = null;
    let unreadableReason = null;
    try {
      independenceArtifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
    } catch (error) {
      if (!(error instanceof TodoStoreError)) throw error;
      unreadableReason = `${error.code}:${error.detail?.reason ?? error.message}`;
    }
    const binding = artifact.source_binding;
    const independenceMatches = independenceArtifact !== null
      && validateTodoIndependence(independenceArtifact)
      && independenceArtifact.schema === binding.independence_schema
      && independenceArtifact.result_digest === binding.independence_result_digest
      && independenceArtifact.witness_set_digest === binding.witness_set_digest
      && independenceArtifact.plan_version === binding.plan_version
      && independenceArtifact.topology_digest === binding.topology_digest
      && independenceArtifact.base_sha === binding.base_sha;
    const planMatches = member.plan.plan_version === binding.plan_version
      && member.plan.topology_digest === binding.topology_digest;
    const coverage = !independenceMatches || !planMatches ? 'superseded'
      : binding.base_sha !== currentBaseSha ? 'stale' : 'verified';
    const components = artifact.decisions.map(summarizeSeamProposalDecision);
    projections.push({
      project_id: member.plan.project_id,
      plan_key: planKey,
      coverage,
      unreadable_reason: unreadableReason,
      guidance: selectSeamProposalGuidance({ coverage }),
      component_count: components.length,
      conflict_resource_count: components
        .reduce((count, component) => count + component.conflicts.length, 0),
      components,
    });
  }
  return projections;
}

export async function renderTodoGanttForProject({
  repoRoot, stable = false, displayName = null, env = process.env, readModel = null,
  scope = DEFAULT_GANTT_SCOPE,
}) {
  const store = readModel
    ?? (stable ? await readTodoStoreStable({ repoRoot }) : await readTodoStore({ repoRoot }));
  const identity = displayName === null
    ? await resolveProjectIdentity({ repoRoot, projectId: store.project_id, env })
    : { displayName };
  const presentation = await loadTodoGanttPresentation({ repoRoot, readModel: store });
  const [independence, seamProposals, notes, structures] = await Promise.all([
    independenceForGantt({ repoRoot, store }),
    seamProposalsForGantt({ repoRoot, store }),
    notesForGantt({ repoRoot, store }),
    loadTodoStructurePresentation({ repoRoot, readModel: store }),
  ]);
  const layout = layoutTodoGantt(store, { scope, independence, seamProposals });
  // When the diagram hides history, the page also carries the full diagram so
  // the reader can bring it back in place. Nothing is hidden under `all`.
  const expandedLayout = layout.scope.folded_task_count === 0
    ? null : layoutTodoGantt(store, {
      scope: 'all', independence, seamProposals,
    });
  const narrative = await loadNarratives(store, repoRoot);
  const anchorOutcomes = verifyNarrativeAnchors({
    readModel: store,
    narratives: narrative.narratives,
  });
  const outcomesByRef = new Map(anchorOutcomes.map((entry) => [
    JSON.stringify([entry.ref.project_id, entry.ref.plan_key, entry.ref.task_id]), entry,
  ]));
  const narrativeBindings = narrative.bindings.map((entry) => {
    const key = JSON.stringify([entry.project_id, entry.plan_key, entry.task_id]);
    const anchor = outcomesByRef.get(key);
    return { ...entry, anchored: anchor.anchored, reason: anchor.reason };
  });
  const memberBindings = store.members.map((member) => ({
    plan_key: member.descriptor.plan_key,
    topology_digest: member.plan.topology_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
  }));
  const metadata = {
    manifest_digest: store.manifest.manifest_digest,
    member_bindings: memberBindings,
    narrative_bindings_digest: digestTodoArtifact(narrativeBindings),
    presentation_digest: presentation.presentation_digest,
    layout_digest: digestTodoArtifact(layout),
    note_bindings_digest: digestTodoArtifact(notes.headBindings),
    structure_projection_digest: structures.projection_digest,
    renderer_version: TODO_GANTT_RENDERER_VERSION,
    project_display_name: identity.displayName,
    folded_task_count: layout.scope.folded_task_count,
  };
  const rendered = renderTodoGanttHtml({
    readModel: store,
    layout,
    expandedLayout,
    narratives: narrative.narratives,
    anchorOutcomes,
    presentation,
    metadata,
    noteContexts: notes.contexts,
    noteWarnings: notes.warnings,
    structurePresentation: structures,
  });
  return { store, metadata, memberBindings, rendered };
}

async function serveGantt({ repoRoot, port, stdout, env, scope = DEFAULT_GANTT_SCOPE }) {
  const initialStore = await readTodoStoreStable({ repoRoot });
  const identity = await resolveProjectIdentity({ repoRoot, projectId: initialStore.project_id, env });
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const live = await startTodoGanttLiveServer({
    projectId: initialStore.project_id,
    displayName: identity.displayName,
    port,
    render: async () => {
      const store = await readTodoStoreStable({ repoRoot });
      const { rendered } = await renderTodoGanttForProject({
        repoRoot, stable: true, displayName: identity.displayName, scope, readModel: store,
      });
      return { html: rendered.html, head_digest: await ganttLiveHeadDigest({ repoRoot, store }),
        // ローカルの動的dashboardも公開daemonと同じ口を通す（毎描画で読むので差し外しが即反映される）。
        external_pane: await readProjectExternalPane({ repoRoot, projectId: store.project_id }) };
    },
    readHead: async () => ganttLiveHeadDigest({
      repoRoot, store: await readTodoStoreStable({ repoRoot }),
    }),
    onShutdown: process.platform === 'win32' ? stop : null,
  });
  const result = { schema: 'lattice.todo_gantt_live_result.v3', project_id: live.projectId,
    resource_scope: 'project', selection_scope: scope,
    included_plan_keys: initialStore.members.map(({ descriptor }) => descriptor.plan_key).sort(),
    media_type: 'text/html; charset=utf-8', dynamic: true,
    host: live.host, port: live.port, project_path: live.projectPath,
    url: live.url, events_url: live.eventsUrl };
  stdout.write(`${JSON.stringify(result)}\n`);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await stopped;
  await live.close();
  return null;
}

/**
 * Whether this command should mark the repo as an actively-worked project.
 *
 * Being "active" is not a local convenience: the bridge heartbeat sends every
 * active project to the hub, and the hub routes the published dashboard from
 * that set. So a command that flips this flag is claiming, on the operator's
 * behalf, that this terminal serves this project — for the next two hours.
 *
 * A read must never make that claim. Running `lattice todo status` inside a
 * clone to look at it once used to register the project here, contest it with
 * whichever terminal actually serves it, and (before partial acceptance landed)
 * take that terminal's whole project set down with it. The diagnosing operator
 * extended the very outage they were investigating (2026-08-10).
 *
 * The rule is an allowlist of store writes, not a denylist of known-bad reads.
 * The denylist it replaces had grown one incident at a time — `verify` was
 * added to it the day before, after `todo verify` turned out to be unreachable
 * for exactly the store inconsistency it exists to diagnose — and every read
 * added later would have defaulted back to claiming ownership.
 *
 * `dashboard` commands are excluded: they own the registry themselves, and
 * pre-registering the current repo ahead of `dashboard remove` would re-add
 * what the operator is asking to drop.
 */
function writesTodoStore(argv) {
  const [command, second, third] = argv;
  if (argv.includes('--schema')) return false;
  switch (command) {
    case 'note': return second !== 'list';
    case 'migrate': return !argv.includes('--dry-run');
    case 'snapshot': return argv.includes('--rebuild');
    case 'independence': return second === 'compile'
      || (second === 'witness' && ['migrate', 'scaffold'].includes(third));
    case 'structure': return ['compile', 'realize', 'finalize'].includes(second)
      || (second === 'input' && !argv.includes('--dry-run'));
    case 'seam-proposal': return ['compile', 'apply', 'land'].includes(second);
    case 'evidence': return second === 'promote';
    case 'dependency': return ['connect', 'disconnect'].includes(second);
    case 'phase': return second !== 'status';
    case 'start': case 'retract': case 'block': case 'unblock': case 'retire': case 'done':
    case 'reopen': case 'split': case 'revise': case 'revise-phase': case 'revise-set':
      return true;
    default: return false;
  }
}

async function ensureActiveProjectDashboard({ repoRoot, env, stderr, strict = false }) {
  if (env.LATTICE_DASHBOARD_AUTOSTART === '0') return null;
  let actor;
  try { actor = mutationActor(env); } catch (error) { if (strict) throw error; return null; }
  const sessionId = actor.session;
  let store;
  try { store = await readTodoStoreStable({ repoRoot }); }
  catch (error) { if (strict) throw error; return null; }
  let identity;
  try { identity = await resolveProjectIdentity({ repoRoot, projectId: store.project_id, env }); }
  catch (error) { if (strict) throw error; return null; }
  try {
    const activity = await ensureTodoDashboardActivity({
      repoRoot, projectId: store.project_id, displayName: identity.displayName, sessionId, env,
    });
    const { reportProjectDashboardDelivery } = await import('./dashboard-delivery.mjs');
    const delivery = await reportProjectDashboardDelivery({ projectId: store.project_id, env, stderr });
    if (strict && delivery.state === 'failed') {
      throw new TodoStoreError('DASHBOARD_DELIVERY_FAILED', 'dashboard_delivery_failed', undefined,
        { delivery });
    }
    return { ...activity, delivery };
  } catch (error) {
    // dashboardは副作用。start/doneをdashboard故障で止めない（ADR 0181）。
    if (strict) throw error;
    stderr?.write(`${JSON.stringify({ schema: 'lattice.dashboard_delivery.v1', state: 'failed',
      reason: error.code ?? 'DASHBOARD_FAILED', project_ids: [store.project_id], urls: [],
      next_action: 'lattice todo dashboard ensure --json' })}\n`);
    return null;
  }
}

async function verify({ repoRoot, requestedPlanKey }) {
  const store = await readTodoStore({ repoRoot });
  const members = selectMembers(store, requestedPlanKey);
  // note chainはlifecycle storeと独立だが、verifyは両方を検査する。破損を空扱いしない。
  for (const member of members) {
    await readTodoNoteEvents({ repoRoot, planKey: member.plan.plan_key });
  }
  const verifiedSourceInventories = new Map();
  for (const member of members) {
    const unverified = member.tasks.find((task) => task.evidence_unverified);
    if (unverified !== undefined) {
      throw new TodoStoreError('STORE_INCONSISTENT', 'evidence_unverified', 'evidence_unverified', {
        plan_key: member.descriptor.plan_key,
        task_id: unverified.task_id,
      });
    }
    if (member.revision !== null) {
      switch (member.revision.schema) {
        case 'lattice.todo_revision.v1':
        case 'lattice.todo_revision.v2':
          await verifyTodoRevisionSources({ repoRoot, revision: member.revision });
          verifiedSourceInventories.set(member.descriptor.plan_key,
            member.revision.source_inventory);
          break;
        case 'lattice.phase_todo_revision.v1':
        case 'lattice.phase_todo_revision.v2':
        case 'lattice.phase_todo_revision.v3':
          verifiedSourceInventories.set(member.descriptor.plan_key,
            await verifyEffectivePhaseTodoRevisionSources({ repoRoot, member }));
          break;
        default:
          throw new TodoStoreError('REVISION_INVALID', 'revision_schema_or_digest_invalid');
      }
    }
  }
  const verifiedMembers = members.map((member) => {
    const reconciled = member.revision !== null;
    const sourceInventory = verifiedSourceInventories.get(member.descriptor.plan_key) ?? null;
    const phaseRevision = ['lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2',
      'lattice.phase_todo_revision.v3']
      .includes(member.revision?.schema);
    return {
      plan_key: member.descriptor.plan_key,
      plan_version: member.plan.plan_version,
      topology_digest: member.plan.topology_digest,
      journal_head_digest: member.journal.events.at(-1).event_digest,
      through_sequence: member.journal.events.at(-1).sequence,
      snapshot_stale: member.snapshot_stale,
      reconciliation_state: reconciled ? 'reconciled' : 'registered_unreconciled',
      revision_digest: reconciled ? member.revision.revision_digest : null,
      reconciliation_digest: reconciled
        ? phaseRevision && member.revision.schema !== 'lattice.phase_todo_revision.v3'
          ? member.revision.revision_digest : member.revision.reconciliation.reconciliation_digest
        : todoLegacyReconciliationDigest({ planDigest: member.plan.plan_digest,
          journalHeadDigest: member.journal.events.at(-1).event_digest }),
      source_inventory_count: reconciled
        ? sourceInventory.active.length + sourceInventory.excluded_tombstones.length : null,
      active_task_count: reconciled
        ? sourceInventory.active.length : null,
      excluded_tombstone_count: reconciled
        ? sourceInventory.excluded_tombstones.length : null,
      reconciliation_guidance: {
        meaning: 'source_inventory_verification_state',
        lifecycle_blocked: false,
        dashboard_visibility_blocked: false,
        schema_command: reconciled ? null : 'lattice todo revise --schema --json',
        next_action: reconciled ? null
          : `lattice todo revise --plan ${member.descriptor.plan_key} --input <revision.json>`,
      },
    };
  });
  const structureDiagnostics = [];
  for (const member of members) {
    const diagnostics = await readTodoStructureArtifactDiagnostics({
      repoRoot,
      store: { ...store, members: [member] },
    });
    structureDiagnostics.push(...diagnostics);
  }
  if (structureDiagnostics.length > 0) {
    throw new TodoStoreError(
      'STRUCTURE_ARTIFACT_INVALID', structureDiagnostics[0].reason, undefined,
      { diagnostics: structureDiagnostics },
    );
  }
  const result = {
    schema: 'lattice.todo_verify_result.v3',
    project_id: store.project_id,
    requested_plan_key: requestedPlanKey,
    verified_members: verifiedMembers,
    snapshot_stale: verifiedMembers.some((member) => member.snapshot_stale),
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function rebuildSnapshot({ repoRoot, planKey }) {
  // Read first so every typed validation failure happens before the rebuild writer is entered.
  const store = await readTodoStore({ repoRoot });
  const [member] = selectMembers(store, planKey);
  const snapshot = await rebuildTodoSnapshot({ repoRoot, planKey });
  const result = {
    schema: 'lattice.todo_snapshot_result.v1',
    project_id: store.project_id,
    plan_key: planKey,
    snapshot_ref: member.descriptor.snapshot_ref,
    through_sequence: snapshot.through_sequence,
    journal_head_digest: snapshot.journal_head_digest,
    snapshot_digest: snapshot.snapshot_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function repairStoreEol({ repoRoot }) {
  const repair = await repairTodoStoreWorktreeEol({ repoRoot });
  const store = await readTodoStore({ repoRoot });
  const result = {
    schema: 'lattice.todo_eol_repair_result.v1',
    project_id: store.project_id,
    ...repair,
    repaired_count: repair.repaired_refs.length,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * `lattice todo` namespace. Exact position, order, and argument count are part of
 * the public contract; usage failures never use a JSON envelope.
 */
export async function runTodoCli({ argv, cwd, stdout, stderr, env = process.env }) {
  if (!Array.isArray(argv) || typeof cwd !== 'string'
    || typeof stdout?.write !== 'function' || typeof stderr?.write !== 'function'
    || env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('runTodoCli optionsが不正');
  }

  const atomicCommit = argv.at(-1) === '--commit-store';
  if (atomicCommit) argv = argv.slice(0, -1);
  if (atomicCommit && ((argv[1] === '--schema' && argv[2] === '--json')
    || (argv[0] === 'dashboard' && argv[1] === 'remove'))) {
    return atomicStoreCommitUnsupported(stderr, argv);
  }

  // `--schema --json`はstoreを読まない決定的な出力（`plan create --schema`と同じ規律）。
  // 通常dispatchより前に処理し、repoRoot解決やdashboard daemon起動を経由させない。
  if (argv.length === 3 && argv[1] === '--schema' && argv[2] === '--json'
    && Object.hasOwn(TODO_SCHEMA_COMMANDS, argv[0])) {
    try {
      await runTodoSchemaCommand(argv[0], stdout);
      return 0;
    } catch (error) {
      return internalFailure(stderr, error);
    }
  }

  // 登録を外したいprojectのrepoは、もう存在しないことが普通である（それが外す理由になる）。
  // 通常dispatchより前に処理し、repoRoot解決・store読取・dashboard daemon起動を経由させない。
  if (argv.length === 4 && argv[0] === 'dashboard' && argv[1] === 'remove'
    && isTodoIdentifier(argv[2]) && argv[3] === '--json') {
    try {
      await removeTodoDashboardProject({ projectId: argv[2], env });
      const result = {
        schema: 'lattice.todo_dashboard_remove_result.v1',
        project_id: argv[2],
        removed: true,
        result_digest: '',
      };
      result.result_digest = todoSelfDigest(result, 'result_digest');
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } catch (error) {
      if (typeof error?.code === 'string' && error.detail !== null
        && typeof error.detail === 'object') return typedFailure(stderr, error);
      return internalFailure(stderr, error);
    }
  }

  const automatedStructureRealize = parseAutomatedStructureRealizeArgs(argv);
  let action = null;
  if (argv.length === 2 && argv[0] === 'repair-eol' && argv[1] === '--json') {
    // 壊れたstoreを読めない時の入口なので、dashboard所有権pre-hookを通さない。
    action = (repoRoot) => repairStoreEol({ repoRoot });
  } else if ((argv.length === 1 && argv[0] === 'status')
    || (argv.length === 2 && argv[0] === 'status' && argv[1] === '--json')) {
    action = (repoRoot) => status({ repoRoot });
  } else if (argv.length === 3 && argv[0] === 'dashboard'
    && argv[1] === 'adopt' && argv[2] === '--json') {
    action = (repoRoot) => adoptDashboardRoot({ repoRoot, env });
  } else if (argv.length === 3 && argv[0] === 'dashboard'
    && argv[1] === 'ensure' && argv[2] === '--json') {
    // 生存保証の独立入口（2026-08-29 オーナー裁定「死んだら自動で起こせ」）。従来は書込み
    // コマンドの副作用でしか daemon を ensure できず、OS再起動後に誰も書込まなければ
    // 公開工程図が503のまま沈黙した。launchd等の周期実行から叩く冪等な入口。
    action = async (repoRoot) => {
      const ensured = await ensureActiveProjectDashboard({ repoRoot,
        env: { ...env, LATTICE_DASHBOARD_AUTOSTART: '1' }, stderr, strict: true });
      return { schema: 'lattice.todo_dashboard_ensure_result.v1',
        ensured: ensured !== null, activity: ensured };
    };
  } else if (argv.length === 6 && argv[0] === 'show'
    && argv[1] === '--plan' && isTodoIdentifier(argv[2])
    && argv[3] === '--task' && isTodoIdentifier(argv[4]) && argv[5] === '--json') {
    action = (repoRoot) => todoDetail({ repoRoot, planKey: argv[2], taskId: argv[4] });
  } else if ((argv.length === 1 && argv[0] === 'bindings')
    || (argv.length === 2 && argv[0] === 'bindings' && argv[1] === '--json')) {
    action = (repoRoot) => bindings({ repoRoot, requestedPlanKey: null });
  } else if ((argv.length === 3 || argv.length === 4) && argv[0] === 'bindings'
    && argv[1] === '--plan' && isTodoIdentifier(argv[2])
    && (argv.length === 3 || argv[3] === '--json')) {
    action = (repoRoot) => bindings({ repoRoot, requestedPlanKey: argv[2] });
  } else if (argv[0] === 'note' && argv[1] !== 'list') {
    const flags = matchFlagCommand(argv, ['note'], {
      known: ['plan', 'task', 'message', 'input', 'supersedes'],
      required: ['plan'],
    });
    const hasMessage = typeof flags?.message === 'string' && flags.message.length > 0;
    const hasInput = isAuthoringPathToken(flags?.input);
    if (flags !== null && isTodoIdentifier(flags.plan)
      && (flags.task === undefined || isTodoIdentifier(flags.task))
      && (flags.supersedes === undefined || isTodoDigest(flags.supersedes))
      && hasMessage !== hasInput) {
      action = (repoRoot) => appendNote({
        repoRoot, env, planKey: flags.plan,
        taskId: flags.task ?? null,
        message: hasMessage ? flags.message : null,
        inputRef: hasInput ? flags.input : null,
        supersedes: flags.supersedes ?? null,
      });
    }
  } else if (argv.length === 5 && argv[0] === 'note' && argv[1] === 'list'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3]) && argv[4] === '--json') {
    action = (repoRoot) => listNotes({ repoRoot, planKey: argv[3], taskId: null });
  } else if (argv.length === 7 && argv[0] === 'note' && argv[1] === 'list'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--task' && isTodoIdentifier(argv[5]) && argv[6] === '--json') {
    action = (repoRoot) => listNotes({ repoRoot, planKey: argv[3], taskId: argv[5] });
  } else if (argv.length === 5 && argv[0] === 'independence' && argv[1] === 'witness'
    && argv[2] === 'migrate' && argv[3] === '--plan' && isTodoIdentifier(argv[4])) {
    action = (repoRoot) => independenceWitnessMigrate({ repoRoot, planKey: argv[4] });
  } else if (argv.length === 8 && argv[0] === 'independence' && argv[1] === 'mode'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3]) && argv[4] === '--set'
    && TODO_COORDINATION_MODES.includes(argv[5]) && argv[6] === '--reason' && argv[7].length > 0) {
    action = (repoRoot) => independenceMode({
      repoRoot, env, planKey: argv[3], mode: argv[5], reason: argv[7],
    });
  } else if (argv.length === 12 && argv[0] === 'dependency' && argv[1] === 'connect'
    && argv[2] === '--from-plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--from-task' && isTodoIdentifier(argv[5])
    && argv[6] === '--to-plan' && isTodoIdentifier(argv[7])
    && argv[8] === '--to-task' && isTodoIdentifier(argv[9])
    && argv[10] === '--reason' && argv[11].length > 0) {
    action = (repoRoot) => dependencyConnect({
      repoRoot, env, fromPlanKey: argv[3], fromTaskId: argv[5],
      toPlanKey: argv[7], toTaskId: argv[9], reason: argv[11],
    });
  } else if (argv.length === 12 && argv[0] === 'dependency' && argv[1] === 'disconnect'
    && argv[2] === '--from-plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--from-task' && isTodoIdentifier(argv[5])
    && argv[6] === '--to-plan' && isTodoIdentifier(argv[7])
    && argv[8] === '--to-task' && isTodoIdentifier(argv[9])
    && argv[10] === '--reason' && argv[11].length > 0) {
    action = (repoRoot) => dependencyDisconnect({
      repoRoot, env, fromPlanKey: argv[3], fromTaskId: argv[5],
      toPlanKey: argv[7], toTaskId: argv[9], reason: argv[11],
    });
  } else if (argv[0] === 'independence' && argv[1] === 'compile') {
    const flags = matchFlagCommand(argv, ['independence', 'compile'], {
      known: ['plan', 'input'], required: ['plan', 'input'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isAuthoringPathToken(flags.input)) {
      action = (repoRoot) => independenceCompile({
        repoRoot, planKey: flags.plan, inputRef: flags.input,
      });
    }
  } else if (argv[0] === 'structure' && argv[1] === 'input') {
    const flags = matchFlagCommand(argv, ['structure', 'input'], {
      known: ['plan', 'input', 'dry-run', 'json'],
      required: ['plan', 'input'],
      booleans: ['dry-run', 'json'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isAuthoringPathToken(flags.input)) {
      action = flags['dry-run'] === true
        ? (repoRoot) => structureInputDryRun({
          repoRoot, planKey: flags.plan, inputRef: flags.input,
        })
        : (repoRoot) => structureInput({
          repoRoot, planKey: flags.plan, inputRef: flags.input,
        });
    }
  } else if (argv[0] === 'structure' && argv[1] === 'compile') {
    const flags = matchFlagCommand(argv, ['structure', 'compile'], {
      known: ['plan', 'input'], required: ['plan', 'input'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isAuthoringPathToken(flags.input)) {
      action = (repoRoot) => structureCompile({
        repoRoot, env, planKey: flags.plan, inputRef: flags.input,
      });
    }
  } else if (argv.length === 8 && argv[0] === 'structure' && argv[1] === 'realize'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--task' && isTodoIdentifier(argv[5])
    && argv[6] === '--input' && isAuthoringPathToken(argv[7])) {
    action = (repoRoot) => structureRealize({
      repoRoot, env, planKey: argv[3], taskId: argv[5], inputRef: argv[7],
    });
  } else if (automatedStructureRealize !== null) {
    action = (repoRoot) => structureRealizeActual({
      repoRoot, env, ...automatedStructureRealize,
    });
  } else if (argv.length === 5 && argv[0] === 'structure' && argv[1] === 'finalize'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3]) && argv[4] === '--json') {
    action = (repoRoot) => structureFinalize({ repoRoot, env, planKey: argv[3] });
  } else if (argv.length === 2 && argv[0] === 'structure' && argv[1] === '--json') {
    action = (repoRoot) => structure({ repoRoot, requestedPlanKey: null });
  } else if (argv.length === 4 && argv[0] === 'structure'
    && argv[1] === '--plan' && isTodoIdentifier(argv[2]) && argv[3] === '--json') {
    action = (repoRoot) => structure({ repoRoot, requestedPlanKey: argv[2] });
  } else if ((argv.length === 1 && argv[0] === 'independence')
    || (argv.length === 2 && argv[0] === 'independence' && argv[1] === '--json')) {
    action = (repoRoot) => independence({ repoRoot, requestedPlanKey: null });
  } else if ((argv.length === 3 || argv.length === 4) && argv[0] === 'independence'
    && argv[1] === '--plan' && isTodoIdentifier(argv[2])
  && (argv.length === 3 || argv[3] === '--json')) {
    action = (repoRoot) => independence({ repoRoot, requestedPlanKey: argv[2] });
  } else if (argv.length === 4 && argv[0] === 'seam-proposal' && argv[1] === 'apply'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])) {
    action = (repoRoot) => seamProposalApply({ repoRoot, planKey: argv[3] });
  } else if (argv.length === 7 && argv[0] === 'independence' && argv[1] === 'witness'
    && argv[2] === 'scaffold' && argv[3] === '--plan' && isTodoIdentifier(argv[4])
    && argv[5] === '--input' && isAuthoringPathToken(argv[6])) {
    action = (repoRoot) => witnessScaffold({ repoRoot, planKey: argv[4], inputRef: argv[6] });
  } else if (argv.length === 6 && argv[0] === 'seam-proposal' && argv[1] === 'land'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--names' && isAuthoringPathToken(argv[5])) {
    action = async (repoRoot) => seamProposalApply({
      repoRoot,
      planKey: argv[3],
      pathNames: await readSeamPathNames(repoRoot, argv[5]),
      land: true,
    });
  } else if ((argv.length === 5 || argv.length === 6) && argv[0] === 'seam-profile'
    && argv[1] === '--plan' && isTodoIdentifier(argv[2])
    && argv[3] === '--file' && isAuthoringPathToken(argv[4])
    && (argv.length === 5 || argv[5] === '--json')) {
    action = (repoRoot) => seamProfile({ repoRoot, planKey: argv[2], filePath: argv[4] });
  } else if (argv.length === 4 && argv[0] === 'seam-proposal' && argv[1] === 'compile'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])) {
    action = (repoRoot) => seamProposalCompile({ repoRoot, planKey: argv[3] });
  } else if ((argv.length === 1 && argv[0] === 'seam-proposal')
    || (argv.length === 2 && argv[0] === 'seam-proposal' && argv[1] === '--json')) {
    action = (repoRoot) => seamProposal({ repoRoot, requestedPlanKey: null });
  } else if ((argv.length === 3 || argv.length === 4) && argv[0] === 'seam-proposal'
    && argv[1] === '--plan' && isTodoIdentifier(argv[2])
    && (argv.length === 3 || argv[3] === '--json')) {
    action = (repoRoot) => seamProposal({ repoRoot, requestedPlanKey: argv[2] });
  } else if ((argv.length === 1 && argv[0] === 'verify')
    || (argv.length === 2 && argv[0] === 'verify' && argv[1] === '--json')) {
    action = (repoRoot) => verify({ repoRoot, requestedPlanKey: null });
  } else if ((argv.length === 3 || argv.length === 4) && argv[0] === 'verify'
    && argv[1] === '--plan' && isTodoIdentifier(argv[2])
    && (argv.length === 3 || argv[3] === '--json')) {
    action = (repoRoot) => verify({ repoRoot, requestedPlanKey: argv[2] });
  } else if (argv.length === 4 && argv[0] === 'snapshot' && argv[1] === '--rebuild'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])) {
    action = (repoRoot) => rebuildSnapshot({ repoRoot, planKey: argv[3] });
  } else if (argv.length === 4 && argv[0] === 'gantt' && argv[1] === 'serve'
    && argv[2] === '--port' && /^(?:0|[1-9][0-9]{0,4})$/u.test(argv[3])
    && Number(argv[3]) <= 65_535) {
    action = (repoRoot) => serveGantt({ repoRoot, port: Number(argv[3]), stdout, env });
  } else if (argv.length === 6 && argv[0] === 'gantt' && argv[1] === 'serve'
    && argv[2] === '--port' && /^(?:0|[1-9][0-9]{0,4})$/u.test(argv[3])
    && Number(argv[3]) <= 65_535 && argv[4] === '--scope'
    && TODO_GANTT_SCOPES.includes(argv[5])) {
    action = (repoRoot) => serveGantt({
      repoRoot, port: Number(argv[3]), stdout, env, scope: argv[5],
    });
  } else if (argv[0] === 'gantt' && argv[1] !== 'serve') {
    action = () => {
      throw new TodoStoreError('STATIC_GANTT_RETIRED', 'dynamic_dashboard_only', undefined, {
        next_action: 'lattice todo gantt serve --port 0',
      });
    };
  } else if (argv[0] === 'migrate' && argv[1] !== '--schema') {
    const flags = matchFlagCommand(argv, ['migrate'], {
      known: ['input', 'json', 'serialization-reviewed', 'dry-run'],
      required: ['input'],
      booleans: ['json', 'serialization-reviewed', 'dry-run'],
    });
    if (flags !== null && isAuthoringPathToken(flags.input)) {
      action = flags['dry-run'] === true
        ? (repoRoot) => migrateDryRun({ repoRoot, inputRef: flags.input })
        : (repoRoot) => migrate({ repoRoot, inputRef: flags.input });
    }
  }
  if (action === null && argv[0] === 'revise') {
    const flags = matchFlagCommand(argv, ['revise'], {
      known: ['plan', 'input'], required: ['plan', 'input'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isAuthoringPathToken(flags.input)) {
      action = (repoRoot) => revise({ repoRoot, env, planKey: flags.plan, inputRef: flags.input });
    }
  } else if (argv[0] === 'split') {
    const flags = matchFlagCommand(argv, ['split'], {
      known: ['plan', 'input'], required: ['plan', 'input'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isAuthoringPathToken(flags.input)) {
      action = (repoRoot) => splitTodo({ repoRoot, env, planKey: flags.plan, inputRef: flags.input });
    }
  } else if (argv[0] === 'revise-set') {
    const flags = matchFlagCommand(argv, ['revise-set'], {
      known: ['input'], required: ['input'],
    });
    if (flags !== null && isAuthoringPathToken(flags.input)) {
      action = (repoRoot) => reviseSet({ repoRoot, env, inputRef: flags.input });
    }
  } else if (argv[0] === 'revise-phase') {
    const flags = matchFlagCommand(argv, ['revise-phase'], {
      known: ['plan', 'input'], required: ['plan', 'input'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isAuthoringPathToken(flags.input)) {
      action = (repoRoot) => revisePhase({ repoRoot, env, planKey: flags.plan, inputRef: flags.input });
    }
  } else if (argv.length === 4 && argv[0] === 'phase' && argv[1] === 'status'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])) {
    action = (repoRoot) => phaseStatus({ repoRoot, planKey: argv[3] });
  } else if (argv.length === 8 && argv[0] === 'phase' && argv[1] === 'review'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--phase' && isTodoIdentifier(argv[5])
    && argv[6] === '--reason' && argv[7].length > 0) {
    action = (repoRoot) => phaseMutation({ repoRoot, env, planKey: argv[3], phaseId: argv[5],
      kind: 'phase_review', payload: { reason: argv[7] } });
  } else if (argv[0] === 'phase' && ['accept', 'reject'].includes(argv[1])) {
    const outcome = argv[1];
    const flags = matchFlagCommand(argv, ['phase', outcome], {
      known: ['plan', 'phase', 'input', 'evidence', 'reason'], required: ['plan', 'phase'],
    });
    const base = flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.phase);
    if (base && isAuthoringPathToken(flags.input) && flags.evidence === undefined && flags.reason === undefined) {
      action = (repoRoot) => phaseDecision({
        repoRoot, env, planKey: flags.plan, phaseId: flags.phase,
        outcome, inputRef: flags.input,
      });
    } else if (base && flags.input === undefined && isAuthoringPathToken(flags.evidence)
      && (outcome === 'accept' ? flags.reason === undefined
        : typeof flags.reason === 'string' && flags.reason.length > 0)) {
      action = (repoRoot) => phaseDecisionFromEvidence({
        repoRoot, env, planKey: flags.plan, phaseId: flags.phase,
        outcome, evidenceRef: flags.evidence, reason: flags.reason ?? null,
      });
    }
  } else if ((argv.length === 8 || argv.length === 10) && argv[0] === 'phase'
    && argv[1] === 'reopen' && argv[2] === '--plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--phase' && isTodoIdentifier(argv[5])
    && argv[6] === '--reason' && argv[7].length > 0
    && (argv.length === 8 || (argv[8] === '--override-reason' && argv[9].length > 0))) {
    action = (repoRoot) => phaseMutation({ repoRoot, env, planKey: argv[3], phaseId: argv[5],
      kind: 'phase_reopen', payload: { reason: argv[7], override_reason: argv[9] ?? null } });
  } else if (argv.length === 8 && argv[0] === 'phase' && argv[1] === 'close-unaudited'
    && argv[2] === '--plan' && isTodoIdentifier(argv[3])
    && argv[4] === '--phase' && isTodoIdentifier(argv[5])
    && argv[6] === '--reason' && argv[7].length > 0) {
    action = (repoRoot) => phaseMutation({ repoRoot, env, planKey: argv[3], phaseId: argv[5],
      kind: 'phase_close_unaudited', payload: { reason: argv[7] } });
  } else if (argv.length >= 4 && argv[0] === 'phase' && argv[1] === 'baseline'
    && argv[2] === '--reason' && argv[3].length > 0
    && parseBaselineExceptFlags(argv.slice(4)) !== null) {
    const exceptPlanKeys = parseBaselineExceptFlags(argv.slice(4));
    action = (repoRoot) => phaseBaseline({ repoRoot, env, reason: argv[3], exceptPlanKeys });
  } else if (argv[0] === 'start') {
    const flags = matchFlagCommand(argv, ['start'], {
      known: ['plan', 'task', 'parallel-frontier', 'override-reason', 'serial-confirmed', 'rebind', 'reason'],
      required: ['plan', 'task'],
      booleans: ['parallel-frontier', 'serial-confirmed', 'rebind'],
    });
    if (flags !== null && flags.rebind === true) {
      if (isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)
        && typeof flags.reason === 'string' && flags.reason.length > 0) {
        action = (repoRoot) => rebindStart({
          repoRoot, env, planKey: flags.plan, taskId: flags.task, reason: flags.reason,
        });
      }
    } else if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)
      && (flags['override-reason'] === undefined || (typeof flags['override-reason'] === 'string'
        && flags['override-reason'].length > 0))) {
      action = (repoRoot) => startTask({
        repoRoot, env, planKey: flags.plan, taskId: flags.task,
        overrideReason: typeof flags['override-reason'] === 'string' ? flags['override-reason'] : null,
        parallelFrontier: flags['parallel-frontier'] === true,
      });
    }
  } else if (argv[0] === 'done') {
    const flags = matchFlagCommand(argv, ['done'], {
      known: ['plan', 'task', 'evidence', 'test-result', 'message'],
      required: ['plan', 'task'],
    });
    const hasEvidence = isAuthoringPathToken(flags?.evidence);
    const hasMessage = typeof flags?.message === 'string' && flags.message.length > 0;
    if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)
      && hasEvidence !== hasMessage
      && (flags['test-result'] === undefined || isAuthoringPathToken(flags['test-result']))) {
      action = (repoRoot) => mutate({
        repoRoot, env, planKey: flags.plan, taskId: flags.task,
        kind: 'done', payload: 'authored',
        evidenceRef: hasEvidence ? flags.evidence : null,
        evidenceMessage: hasMessage ? flags.message : null,
        testResultRef: flags['test-result'] ?? null,
      });
    }
  }
  if (action === null && argv[0] === 'retract') {
    const flags = matchFlagCommand(argv, ['retract'], {
      known: ['plan', 'task', 'reason'], required: ['plan', 'task', 'reason'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)) {
      action = (repoRoot) => retractStart({
        repoRoot, env, planKey: flags.plan, taskId: flags.task, reason: flags.reason,
      });
    }
  } else if (argv[0] === 'block') {
    const flags = matchFlagCommand(argv, ['block'], {
      known: ['plan', 'task', 'reason'], required: ['plan', 'task', 'reason'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)) {
      action = (repoRoot) => mutate({
        repoRoot, env, planKey: flags.plan, taskId: flags.task,
        kind: 'block', payload: { reason: flags.reason }, evidenceRef: null,
      });
    }
  } else if (argv[0] === 'retire') {
    // 恒久除去（2026-08-29オーナー裁定）。planの形は変えず、状態遷移として工程を閉じる。
    const flags = matchFlagCommand(argv, ['retire'], {
      known: ['plan', 'task', 'reason'], required: ['plan', 'task', 'reason'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)) {
      action = (repoRoot) => mutate({
        repoRoot, env, planKey: flags.plan, taskId: flags.task,
        kind: 'retire', payload: { reason: flags.reason }, evidenceRef: null,
      });
    }
  } else if (argv[0] === 'unblock') {
    const flags = matchFlagCommand(argv, ['unblock'], {
      known: ['plan', 'task'], required: ['plan', 'task'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)) {
      action = (repoRoot) => mutate({
        repoRoot, env, planKey: flags.plan, taskId: flags.task,
        kind: 'unblock', payload: {}, evidenceRef: null,
      });
    }
  } else if (argv[0] === 'evidence' && argv[1] === 'promote') {
    const flags = matchFlagCommand(argv, ['evidence', 'promote'], {
      known: ['plan', 'task', 'evidence'], required: ['plan', 'task', 'evidence'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)
      && isAuthoringPathToken(flags.evidence)) {
      action = (repoRoot) => mutate({
        repoRoot, env, planKey: flags.plan, taskId: flags.task,
        kind: 'done', payload: 'evidence_promotion', evidenceRef: flags.evidence,
      });
    }
  } else if (argv[0] === 'reopen') {
    const flags = matchFlagCommand(argv, ['reopen'], {
      known: ['plan', 'task', 'reason', 'override-reason'],
      required: ['plan', 'task', 'reason'],
    });
    if (flags !== null && isTodoIdentifier(flags.plan) && isTodoIdentifier(flags.task)
      && (flags['override-reason'] === undefined
        || (typeof flags['override-reason'] === 'string' && flags['override-reason'].length > 0))) {
      action = (repoRoot) => mutate({
        repoRoot, env, planKey: flags.plan, taskId: flags.task,
        kind: 'reopen',
        payload: {
          reason: flags.reason,
          override_reason: typeof flags['override-reason'] === 'string' ? flags['override-reason'] : null,
        },
        evidenceRef: null,
      });
    }
  }
  if (action === null) {
    const command = typeof argv[0] === 'string' ? argv[0] : null;
    if (command !== null && !TODO_COMMAND_NAMES.includes(command)) {
      return typedArgumentFailure(stderr, 'UNKNOWN_SUBCOMMAND', 'todo_subcommand_unknown', {
        command, available_commands: TODO_COMMAND_NAMES,
        next_action: 'lattice todo --help',
      });
    }
    const argumentHelp = argv[0] === 'gantt' && argv[1] === 'serve'
      ? 'lattice todo gantt serve --help'
      : command === null ? 'lattice todo --help' : `lattice todo ${command} --help`;
    return typedArgumentFailure(stderr, 'INVALID_ARGUMENTS', 'todo_arguments_invalid', {
      command, next_action: argumentHelp,
    });
  }
  if (atomicCommit && !supportsAtomicStoreCommit(argv)) {
    return atomicStoreCommitUnsupported(stderr, argv);
  }

  try {
    const repoRoot = resolveRepoRoot(cwd);
    // Only a store write claims this terminal as the project's live source; see
    // `writesTodoStore`. This also keeps the pre-hook away from `verify`, whose
    // whole job is to diagnose a store too inconsistent for the pre-hook's own
    // `readTodoStoreStable` to read (2026-08-10 P0: `todo verify` was
    // unreachable for exactly the case it exists to diagnose).
    if (writesTodoStore(argv)) {
      await ensureActiveProjectDashboard({ repoRoot, env, stderr });
    }
    const result = atomicCommit
      ? await commitTodoStoreMutation({ repoRoot, argv, action, env })
      : await action(repoRoot);
    if (result !== null) stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof TodoStoreError || (typeof error?.code === 'string'
      && error.detail !== null && typeof error.detail === 'object')) return typedFailure(stderr, error);
    if (error instanceof TypeError) {
      return typedFailure(stderr, {
        code: 'CONTRACT_VIOLATION',
        message: error.message,
      });
    }
    return internalFailure(stderr, error);
  }
}
