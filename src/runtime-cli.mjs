import { gitSpawn } from './git-process.mjs';
import { fsyncDirectory } from './fs-dir-sync.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalizeArtifact, digestArtifact } from './artifact-contracts.mjs';
import { collectSensorEvidence } from './sensor-adapter.mjs';
import { captureWorktreeDiff, detectCheckpointFindings } from './runtime-diff-observer.mjs';
import {
  buildIoEscalation, createRunSentinel, probeIoWarning, syncSentinelWatches,
} from './runtime-io-sentinel.mjs';
import { ensureScriptedWorktree, removeScriptedWorktrees } from './runtime-scripted-worktree.mjs';
import { recoverKeptWorktrees } from './runtime-kept-worktree.mjs';
import {
  buildRuntimeSeamResolution, readRuntimeFindingRecord, resolveRuntimeSeam,
  validateRuntimeSeamRequest, verifySeamSplitSuccessor,
} from './runtime-seam-resolve.mjs';
import {
  compileRuntimePlanV1,
  evidenceFromCollectedOutcomes,
} from './runtime-front-end.mjs';
import {
  explainTodoWitnessSet,
  isGitSha,
  synthesizeWitnessRunRequest,
} from './todo-independence-contracts.mjs';
import {
  explainRunRequest,
  validateRunRequest,
  validateRuntimeBoundaryManifest,
  validateRuntimePlan,
  validRuntimeAbandonReason,
  validateExecutorReceipt,
  verifyRuntimePlanBinding,
  selfDigest,
} from './runtime-contracts.mjs';
import {
  adjudicatePendingReceipts,
  buildNextRunEvent,
  buildExecutorPackets,
  closeRunAbandoningRemaining,
  closeRunIfComplete,
  dispatchReadyFrontier,
  initializeRunEvents,
  observeExecutor,
} from './runtime-engine.mjs';
import {
  computeReadyFrontier,
  recomputeReceiptDecisions,
  classifyObservedDiff,
} from './runtime-decision-verifier.mjs';
import { verifyRunEventChain } from './runtime-event-store.mjs';
import { projectRuntimeState, projectRuntimeStatusOverlays } from './runtime-projection.mjs';
import {
  affectedTodoIds,
  decideHoldAndCarryOver,
  recompileNextEpochPlan,
  validateRuntimeRecompileRequest,
} from './runtime-hold-recompile.mjs';
import { verifySchedulabilityPlanV2 } from './schedulability-verifier-v2.mjs';
import {
  activateEpochOneStore,
  commitStagedSuccessorEpoch,
  commitReleaseEpochBarrier,
  RuntimeEpochStoreError,
  isManagedRunFrozen,
  readCommittedEpochStore,
  recordRuntimeFinding,
  rejectFutureRuntimeStoreSchema,
  stageSuccessorEpoch,
  validateRuntimeEpochBundle,
  validateRuntimeFindingCandidate,
  validateRuntimeFindingRecord,
} from './runtime-multi-epoch-store.mjs';
import {
  acceptsHostDrivenEpoch,
  createRuntimeControlRequest,
  validateRuntimeControlResponse,
} from './runtime-controller-protocol.mjs';
import { createRuntimeControlStore } from './runtime-control-store.mjs';
import { createRuntimeGateStore } from './runtime-gate-store.mjs';
import {
  RuntimeLifecycleLockError,
  acquireRuntimeLifecycleLock,
} from './runtime-lifecycle-lock.mjs';
import {
  PullRunError,
  acceptPullTask,
  attachPullWorker,
  closePullRun,
  detachPullWorker,
  inspectRunMode as inspectPullRunMode,
  intakePullTask,
  interventionPullTask,
  landingPullRun,
  listPullRunEntry,
  observePullRun,
  releasePullTask,
  startPullRun,
  statusPullRun,
} from './runtime-pull-intake.mjs';
import {
  RuntimeDriverStateError,
  readRuntimeDriverState,
  replaceRuntimeDriverState,
} from './runtime-driver-state.mjs';

import {
  AdapterRegistryError,
  listRuntimeAdapters,
  registerRuntimeAdapter,
} from './runtime-adapter-registry.mjs';
import {
  ManagedRuntimeError,
  launchDurableSupervisor,
  observeManagedProcessStartIdentity,
  prepareManagedSupervisorRestart,
  resolveActiveRuntimePaths,
  sendRuntimeActivationRequestUntilSettled,
  sendRuntimeControlRequest,
} from './runtime-managed-supervisor.mjs';
import { TodoStoreError } from './todo-store.mjs';

async function inspectRunMode(runDir) {
  try {
    return await inspectPullRunMode(runDir);
  } catch (error) {
    if (error instanceof PullRunError && error.code === 'UNSUPPORTED_RUN_STORE_SCHEMA') {
      rejectFutureRuntimeStoreSchema(error.detail?.schema, {
        artifact: 'run_meta', family: 'lattice.run_meta', expectedVersion: 2,
      });
    }
    throw error;
  }
}

async function requireLegacyRunMode(runDir, operation) {
  if ((await inspectRunMode(runDir)).mode !== 'legacy') {
    throw new PullRunError('RUN_MODE_MISMATCH', `pull runはlegacy専用${operation}を受け付けない`);
  }
}

/**
 * RC3-D CLI surface（ADR 0044 Decision 8）。
 *
 *   lattice plan compile --request <run-request.json>
 *   lattice plan verify  --request <run-request.json> --plan <plan.json>
 *   lattice run start    --request <run-request.json> --executor <adapter>
 *   lattice run request synthesize --witness <witness-set.json> --base-sha <sha> --id <request-id>
 *   lattice run adapter register --input <descriptor.json>
 *   lattice run adapter list --json
 *   lattice run observe  --run .lattice/runs/<run-id>
 *   lattice run status   --run .lattice/runs/<run-id>
 *   lattice run resume   --run .lattice/runs/<run-id>
 *   lattice run landing  --run .lattice/runs/<run-id>
 *   lattice run close    --run .lattice/runs/<run-id>
 *   lattice run abandon  --run .lattice/runs/<run-id> --reason <reason>
 *   lattice event verify --run .lattice/runs/<run-id>
 *
 * - stdout: versioned JSON 1行のみ。診断はstderr。
 * - exit 0: 成功（artifact refとdigestを含むversioned JSON）。
 * - exit 1: typed契約失敗。stderrへ`lattice.cli_error.v2` JSON 1行。
 * - exit 2: usage違反（未知command、引数の欠落・重複・余剰・順序不正）。
 * - `--executor`等の暗黙fallbackを持たず、未実装surfaceはusage違反として拒否する。
 *
 * plan verifyは保存planを信用せず、requestとfresh LatticeSensor観測からplanを
 * producerで再コンパイルしてdigest完全一致を要求し、さらにschedule minimumを
 * producer非依存の`verifySchedulabilityPlanV2`で再計算する（成功条件5）。
 */

const MAX_INPUT_BYTES = 8_388_608;
const COMPILE_RESULT_SCHEMA = 'lattice.plan_compile_result.v1';
const VERIFY_RESULT_SCHEMA = 'lattice.plan_verify_result.v1';
const CLI_ERROR_SCHEMA = 'lattice.cli_error.v2';
// 現役run storeは対象Git repo内のLattice-owned・ignored rootへ限定する。
const RUN_STORE_ROOT = ['.lattice', 'runs'];
const RUN_REF = /^\.lattice\/runs\/([0-9A-Za-z](?:[0-9A-Za-z._-]{0,127}))$/u;
const KNOWN_ADAPTERS = Object.freeze([
  'scripted', 'isolated-worktree', 'actual-agent', 'work-order',
]);
/**
 * 自動escalationがlifecycle lockを待つ上限（ADR 0143）。
 *
 * 待つのは、警報が飛んだ瞬間にactivateやrecompileが走っていることが普通にあるからである。
 * 待たずに諦めると、早期警報がいちばん効く場面——複数TODOが同時に動いている最中——で
 * 必ず取り逃す。上限を置くのは、待ち続けてdaemonの他の仕事を止めないため。
 * 超えたら`rejected`として理由ごとjournalへ残す（黙って見送らない）。
 */
const IO_ESCALATION_LOCK_TIMEOUT_MS = 15_000;
/**
 * 係争pathから資源idを導出する（front-endと同じ形）。
 *
 * front-endは`owns`から`own-<kind>-<sha256(target)先頭16>`を作る。path競合の直列化資源は
 * その形でなければ、後継planの競合辺が実ownershipの資源と別物になってしまう。
 * **形を1箇所で決める。** 別の形で作ると、同じpathが別の資源に見える。
 */
function ownedResourceId(kind, target) {
  return `own-${kind}-${createHash('sha256').update(target, 'utf8').digest('hex').slice(0, 16)}`;
}

function ownedPathResourceId(pathValue) {
  return ownedResourceId('path', pathValue);
}
/** 走行中workerの完了を観測する間隔。待てないと走行中の観測が成立しない。 */
const SCRIPTED_OBSERVE_POLL_MS = 20;

class CliContractError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CliContractError';
    this.code = code;
    this.detail = detail;
  }
}

function usageFailure(stderr, args) {
  const received = args.length === 0 ? '(none)' : args.join(' ');
  stderr.write(`lattice: unsupported command or arguments: ${received}\n`);
  return 2;
}

function typedFailure(stderr, code, message, detail) {
  const payload = { schema: CLI_ERROR_SCHEMA, code, message };
  // ADR 0052 Decision 1: detailは非空plain objectの場合だけ出す（null・非object・空objectは省略）。
  if (detail !== null && typeof detail === 'object' && !Array.isArray(detail) && Object.keys(detail).length > 0) {
    payload.detail = detail;
  }
  stderr.write(`${JSON.stringify(payload)}\n`);
  return 1;
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    const child = gitSpawn(args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => resolve({ code: -1, stdout: '', stderr: String(error) }));
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function readBoundedJson(filePath, label) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    throw new CliContractError('INPUT_UNREADABLE', `${label}を読めない: ${filePath}`);
  }
  // FIFO・symlink・deviceを拒否し、regular fileのbytesだけを受ける。
  if (!info.isFile()) {
    throw new CliContractError('INPUT_UNREADABLE', `${label}がregular fileではない: ${filePath}`);
  }
  if (info.size > MAX_INPUT_BYTES) {
    throw new CliContractError('INPUT_TOO_LARGE', `${label}が${MAX_INPUT_BYTES} bytesを超える`);
  }
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch {
    throw new CliContractError('INPUT_UNREADABLE', `${label}を読めない: ${filePath}`);
  }
  // stat→read間の増大（TOCTOU）を実bytesで再検査する。
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new CliContractError('INPUT_TOO_LARGE', `${label}が${MAX_INPUT_BYTES} bytesを超える`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new CliContractError('INVALID_JSON', `${label}がJSONとしてparseできない`);
  }
}

async function resolveRepoBinding(cwd, request) {
  const head = await runGit(['rev-parse', 'HEAD'], cwd);
  if (head.code !== 0) {
    throw new CliContractError('REPO_UNRESOLVED', `cwdのgit HEADを解決できない: ${head.stderr.trim()}`);
  }
  const headSha = head.stdout.trim();
  if (headSha !== request.repo.base_sha) {
    throw new CliContractError(
      'STALE_BASE',
      `repo HEAD(${headSha})がrequest base_sha(${request.repo.base_sha})と一致しない`,
    );
  }
}

async function resolveRepoRoot(cwd) {
  const root = await runGit(['rev-parse', '--show-toplevel'], cwd);
  if (root.code !== 0 || root.stdout.trim().length === 0) {
    throw new CliContractError('REPO_UNRESOLVED', `cwdのgit rootを解決できない: ${root.stderr.trim()}`);
  }
  return path.resolve(root.stdout.trim());
}

async function requireIgnoredRunStore(repoRoot) {
  const probe = '.lattice/runs/.lattice-ignore-probe';
  const ignored = await runGit(['check-ignore', '-q', '--', probe], repoRoot);
  if (ignored.code !== 0) {
    throw new CliContractError(
      'RUN_STORE_NOT_IGNORED',
      '.lattice/runs/ がgit ignore対象ではない',
      { guidance: '.gitignoreへ `.lattice/runs/` を追加してから再実行する' },
    );
  }
}

async function requireSafeRunAncestors(repoRoot) {
  for (const relative of ['.lattice', '.lattice/runs']) {
    try {
      const state = await lstat(path.join(repoRoot, relative));
      if (state.isSymbolicLink() || !state.isDirectory()) {
        throw new CliContractError('INVALID_RUN_STORE', `${relative}が安全なdirectoryではない`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function resolveRunStore(cwd, runRef) {
  const normalized = runRef.replaceAll('\\', '/');
  const match = RUN_REF.exec(normalized);
  if (match === null || path.isAbsolute(runRef)) {
    throw new CliContractError(
      'INVALID_RUN_REF',
      'run refは `.lattice/runs/<run-id>` のrepo相対形式でなければならない',
    );
  }
  const repoRoot = await resolveRepoRoot(cwd);
  await requireSafeRunAncestors(repoRoot);
  return { repoRoot, runDir: path.join(repoRoot, ...RUN_STORE_ROOT, match[1]), runRef: normalized };
}

function canonicalNow() {
  return new Date().toISOString();
}

/**
 * 同梱の`lattice.run_request.v1` JSON Schemaをstdoutへ出す（ADR 0123）。
 * hostがrequestを推測で組まずに済むよう、契約を配布物から直接取れるようにする。
 */
async function runRequestSchema({ stdout }) {
  const schemaUrl = new URL('../docs/schemas/lattice.run_request.v1.schema.json', import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  if (schema?.title !== 'lattice.run_request.v1') {
    throw new CliContractError('CONTRACT_VIOLATION', '同梱run_request schemaが不正');
  }
  stdout.write(`${JSON.stringify(schema)}\n`);
  return 0;
}

/** 公開登録入力を推測させないため、配布物に同梱したJSON Schemaをそのまま返す（ADR 0125）。 */
async function runAdapterRegisterSchema({ stdout }) {
  const schemaUrl = new URL(
    '../docs/schemas/lattice.runtime_adapter_registration_input.v2.schema.json',
    import.meta.url,
  );
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  if (schema?.title !== 'lattice.runtime_adapter_registration_input.v2') {
    throw new CliContractError('CONTRACT_VIOLATION', '同梱adapter registration input schemaが不正');
  }
  stdout.write(`${JSON.stringify(schema)}\n`);
  return 0;
}

async function runAdapterRegister({ cwd, inputPath, stdout }) {
  try {
    const repoRoot = await resolveRepoRoot(cwd);
    const input = await readBoundedJson(inputPath, 'adapter registration input');
    const result = await registerRuntimeAdapter({ repoRoot, input });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AdapterRegistryError) throw error;
    if (error instanceof CliContractError) {
      if (error.detail !== undefined) throw error;
      throw new CliContractError(error.code, error.message, {
        path: inputPath,
        reason: error.code.toLowerCase(),
      });
    }
    throw new CliContractError('ADAPTER_REGISTRY_WRITE_FAILED', 'adapter registryを書けない', {
      path: '.lattice/runtime/adapter-registry/registry.json',
      reason: typeof error?.code === 'string' ? error.code : 'unexpected_write_failure',
    });
  }
}

/**
 * witness setから`run start`へ渡せるrun requestを組み立てて返す（read-only）。
 *
 * **推測しない面である。** base shaもrequest idもCLIが決めず、呼び手が渡す——どのbaseへ
 * 対する計画なのかは装置が知らないし、HEADを黙って採ると「撮ったつもりのbaseと違う木」で
 * runが始まる。witness setの検査は`explainTodoWitnessSet`が単一の正本なので、ここでは
 * 判定を持たず理由とpathをそのまま返す。
 *
 * request idの旗が`--id`なのは、`--request-id`が末尾2引数のときrun mutationの
 * idempotency keyとして先に横取りされるためである（同じ綴りで別の意味を持たせない）。
 */
async function runRequestSynthesize({ cwd, witnessPath, baseSha, requestId, stdout }) {
  if (!isGitSha(baseSha)) {
    throw new CliContractError('INVALID_BASE_SHA', '--base-shaが40桁のgit shaでない', {
      base_sha: baseSha,
    });
  }
  if (!/^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/u.test(requestId)) {
    throw new CliContractError('INVALID_REQUEST_ID', '--idは128文字以下の識別子でなければならない', {
      request_id: requestId,
    });
  }
  const witnessSet = await readBoundedJson(path.resolve(cwd, witnessPath), 'witness set');
  const verdict = explainTodoWitnessSet(witnessSet);
  if (!verdict.valid) {
    throw new CliContractError('WITNESS_SET_INVALID', 'witness setが契約を満たさない', {
      path: witnessPath, reason: verdict.reason, pointer: verdict.path ?? null,
    });
  }
  const request = synthesizeWitnessRunRequest(witnessSet, { baseSha, requestId });
  const explained = explainRunRequest(request);
  if (!explained.valid) {
    // 生成物が自分の契約を満たさないなら、それは装置の不具合である。黙って出さない
    throw new CliContractError('CONTRACT_VIOLATION', '生成したrun requestがrun_request契約を満たさない', {
      reason: explained.reason, pointer: explained.path ?? null,
    });
  }
  stdout.write(`${JSON.stringify(request)}\n`);
  return 0;
}

async function runAdapterList({ cwd, stdout }) {
  try {
    const repoRoot = await resolveRepoRoot(cwd);
    const result = await listRuntimeAdapters({ repoRoot });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AdapterRegistryError || error instanceof CliContractError) throw error;
    throw new CliContractError('ADAPTER_REGISTRY_READ_FAILED', 'adapter registryを読めない', {
      path: '.lattice/runtime/adapter-registry/registry.json',
      reason: typeof error?.code === 'string' ? error.code : 'unexpected_read_failure',
    });
  }
}

async function loadRequest(requestPath) {
  const request = await readBoundedJson(requestPath, 'run request');
  const verdict = explainRunRequest(request);
  if (!verdict.valid) {
    // 拒否理由と違反箇所を返す（ADR 0123）。TODO面と同じdiagnosabilityへ揃え、
    // hostがschemaを推測せずにrequestを直せるようにする。
    throw new CliContractError(
      'INVALID_RUN_REQUEST',
      'run_request.v1 contractを満たさない',
      { reason: verdict.reason, path: verdict.path },
    );
  }
  return request;
}

async function compileFromRepo({ request, cwd, planRef, planEpoch, predecessorRefs }) {
  const collected = await collectSensorEvidence({
    cwd,
    querySet: request.sensor_query_set,
  });
  // 観測中にHEADが動いた場合、観測とbase束縛が別snapshotになるためreject
  // （TOCTOU窓の閉鎖。base再確認は観測の後に行う）。
  await resolveRepoBinding(cwd, request);
  const sensorEvidence = evidenceFromCollectedOutcomes({
    querySet: request.sensor_query_set,
    collected,
  });
  return compileRuntimePlanV1({
    request,
    sensorEvidence,
    planRef,
    planEpoch,
    predecessorRefs,
  });
}

async function planCompile({ requestPath, cwd, stdout }) {
  const request = await loadRequest(requestPath);
  await resolveRepoBinding(cwd, request);
  const result = await compileFromRepo({
    request,
    cwd,
    planRef: `plan-${request.request_id}-e1`,
    planEpoch: 1,
    predecessorRefs: [],
  });
  if (result.outcome !== 'dispatchable') {
    throw new CliContractError(result.code, 'dispatchable planを発行できない', result.detail);
  }
  const artifact = {
    schema: COMPILE_RESULT_SCHEMA,
    request_digest: request.request_digest,
    plan: result.plan,
    manifests: result.manifests,
    schedule: result.schedule,
    graph_digest: result.graph_digest,
  };
  artifact.result_digest = digestArtifact(artifact);
  stdout.write(`${JSON.stringify(artifact)}\n`);
  return 0;
}

async function planVerify({ requestPath, planPath, cwd, stdout }) {
  const request = await loadRequest(requestPath);
  const artifact = await readBoundedJson(planPath, 'plan artifact');
  if (artifact === null
    || typeof artifact !== 'object'
    || Array.isArray(artifact)
    || artifact.schema !== COMPILE_RESULT_SCHEMA) {
    throw new CliContractError('INVALID_PLAN_ARTIFACT', `schemaが${COMPILE_RESULT_SCHEMA}ではない`);
  }
  const { result_digest: claimedDigest, ...body } = artifact;
  if (claimedDigest !== digestArtifact(body)) {
    throw new CliContractError('INVALID_PLAN_ARTIFACT', 'result_digestが再計算と一致しない');
  }
  if (artifact.request_digest !== request.request_digest) {
    throw new CliContractError('STALE_PLAN', 'plan artifactが別のrequestに属する');
  }
  await resolveRepoBinding(cwd, request);
  const plan = artifact.plan;
  // 保存plan本体をschema・自己digestごと検証する。digest field文字列との比較だけに
  // 依存すると、bodyを改竄しdigestを残した再封印planが通る（review P0採用）。
  if (!validateRuntimePlan(plan)) {
    throw new CliContractError('INVALID_PLAN_ARTIFACT', '保存planがruntime_plan.v1 contractを満たさない');
  }
  const planNodeIds = plan.nodes.map((node) => node.todo_id);
  if (artifact.manifests === null || typeof artifact.manifests !== 'object' || Array.isArray(artifact.manifests)
    || Object.keys(artifact.manifests).sort().join('\0') !== [...planNodeIds].sort().join('\0')) {
    throw new CliContractError('INVALID_PLAN_ARTIFACT', 'manifestsのkey集合がplan nodesと一致しない');
  }
  for (const todoId of planNodeIds) {
    const manifest = artifact.manifests[todoId];
    if (!validateRuntimeBoundaryManifest(manifest)
      || manifest.manifest_digest !== plan.manifest_digests[todoId]) {
      throw new CliContractError('INVALID_PLAN_ARTIFACT', `manifestがplanのdigestと一致しない: ${todoId}`);
    }
  }
  // 再コンパイルはcompileと同一の導出規則を使う（保存planのref/epochを鵜呑みに
  // すると、self-digestを再計算したrelabel改竄がdigest比較を素通りする）。
  const recompiled = await compileFromRepo({
    request,
    cwd,
    planRef: `plan-${request.request_id}-e1`,
    planEpoch: 1,
    predecessorRefs: [],
  });
  if (recompiled.outcome !== 'dispatchable') {
    throw new CliContractError(
      recompiled.code,
      'fresh観測からの再コンパイルがdispatchableにならない',
      recompiled.detail,
    );
  }
  // 再コンパイル結果と保存planの構造完全一致（digest fieldでなくbody全体）。
  if (digestArtifact(recompiled.plan) !== digestArtifact(plan)) {
    throw new CliContractError('PLAN_DIGEST_MISMATCH', '再コンパイルplanが保存plan本体と一致しない');
  }
  for (const todoId of planNodeIds) {
    if (digestArtifact(recompiled.manifests[todoId]) !== digestArtifact(artifact.manifests[todoId])) {
      throw new CliContractError('PLAN_DIGEST_MISMATCH', `再コンパイルmanifestが保存値と一致しない: ${todoId}`);
    }
  }
  if (recompiled.graph_digest !== artifact.graph_digest) {
    throw new CliContractError('PLAN_DIGEST_MISMATCH', '再コンパイルgraph digestが保存値と一致しない');
  }
  const verified = verifySchedulabilityPlanV2(recompiled.graph, artifact.schedule);
  if (verified.outcome !== 'verified') {
    throw new CliContractError('SCHEDULE_NOT_MINIMUM', `独立verifierがscheduleを棄却した: ${JSON.stringify(verified)}`);
  }
  const output = {
    schema: VERIFY_RESULT_SCHEMA,
    outcome: 'verified',
    request_digest: request.request_digest,
    plan_digest: plan.plan_digest,
    graph_digest: artifact.graph_digest,
    minimum_feasible_waves: verified.minimum_feasible_waves,
  };
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}


function runStorePath(cwd, runId) {
  return path.join(cwd, ...RUN_STORE_ROOT, runId);
}

async function readRunStore(runDir) {
  let runState;
  try {
    runState = await lstat(runDir);
  } catch {
    throw new CliContractError('INVALID_RUN_STORE', 'run store directoryを読めない');
  }
  if (runState.isSymbolicLink() || !runState.isDirectory()) {
    throw new CliContractError('INVALID_RUN_STORE', 'run storeが安全なdirectoryではない');
  }
  const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
  if (!Array.isArray(events)) {
    throw new CliContractError('INVALID_RUN_STORE', 'events.jsonがarrayではない');
  }
  const meta = await readBoundedJson(path.join(runDir, 'run-meta.json'), 'run meta');
  rejectFutureRuntimeStoreSchema(meta?.schema, {
    artifact: 'run_meta', family: 'lattice.run_meta', expectedVersion: 2,
  });
  const compileArtifact = await readBoundedJson(
    path.join(runDir, 'plan-compile-result.json'), 'plan compile result',
  );
  const request = await readBoundedJson(path.join(runDir, 'request.json'), 'run request');
  const compileKeys = ['schema', 'request_digest', 'plan', 'manifests', 'schedule', 'graph_digest', 'result_digest'];
  const metaKeys = ['schema', 'run_id', 'executor_adapter', 'plan_digest'];
  const { result_digest: claimedCompileDigest, ...compileBody } = compileArtifact ?? {};
  const legacyMetaValid = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    && Object.keys(meta).sort().join('\0') === metaKeys.sort().join('\0')
    && meta.schema === 'lattice.run_meta.v1'
    && meta.run_id === request.request_id
    && KNOWN_ADAPTERS.includes(meta.executor_adapter)
    && compileArtifact?.plan?.plan_digest === meta.plan_digest;
  // v1だけがlegacy alias。その他はmulti-epoch readerへ渡し、既知familyの
  // 将来世代を破損storeへ潰さずtyped診断する。
  const managed = meta?.schema === 'lattice.run_meta.v1'
    ? null
    : await readCommittedEpochStore(runDir);
  const managedMetaValid = managed !== null
    && managed.meta.run_id === request.request_id
    && KNOWN_ADAPTERS.includes(managed.meta.executor_adapter)
    && managed.meta.created_plan_digest === compileArtifact.plan.plan_digest;
  if (!validateRunRequest(request)
    || (!legacyMetaValid && !managedMetaValid)
    || compileArtifact === null || typeof compileArtifact !== 'object' || Array.isArray(compileArtifact)
    || Object.keys(compileArtifact).sort().join('\0') !== compileKeys.sort().join('\0')
    || compileArtifact.schema !== COMPILE_RESULT_SCHEMA
    || claimedCompileDigest !== digestArtifact(compileBody)
    || compileArtifact.request_digest !== request.request_digest
    || !validateRuntimePlan(compileArtifact?.plan)
    || !verifyRuntimePlanBinding({ plan: compileArtifact.plan, request })
    ) {
    throw new CliContractError('INVALID_RUN_STORE', 'run storeのartifact bindingが不正');
  }
  if (managed === null) return { events, meta, compileArtifact, request, managed: null };
  return {
    events,
    meta: {
      schema: 'lattice.run_meta.v1',
      run_id: managed.meta.run_id,
      executor_adapter: managed.meta.executor_adapter,
      plan_digest: managed.bundle.plan.plan_digest,
    },
    compileArtifact: {
      ...compileArtifact,
      request_digest: managed.bundle.request.request_digest,
      plan: managed.bundle.plan,
      manifests: managed.bundle.manifests,
    },
    request: managed.bundle.request,
    managed,
  };
}

async function writeJsonFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
}

async function writeCanonicalJsonFile(filePath, value) {
  await writeFile(filePath, `${canonicalizeArtifact(value)}\n`, { mode: 0o600, flag: 'wx' });
}

async function replaceEventsAtomically(runDir, events) {
  const temporaryPath = path.join(runDir, `.events-${process.pid}-${Date.now()}.tmp`);
  await writeJsonFile(temporaryPath, events);
  await rename(temporaryPath, path.join(runDir, 'events.json'));
}

async function replaceNamedJsonAtomically(runDir, name, value) {
  await durableReplaceBytes(runDir, name, Buffer.from(`${JSON.stringify(value, null, 1)}\n`));
}

async function replaceCanonicalJsonAtomically(directory, name, value) {
  await durableReplaceBytes(directory, name, Buffer.from(`${canonicalizeArtifact(value)}\n`));
}

function runtimeEventBatchReceiptName(transactionId, phase) {
  return `run-event-batch-${digestArtifact({ transaction_id: transactionId, phase })}.json`;
}

function sameDigestPrefix(left, right) {
  return left.length <= right.length && left.every((digest, index) => digest === right[index]);
}

/**
 * Recompileのrun event副作用をtransaction単位でexact-once publishする。
 * receiptをevents.jsonより先にdurable化するため、receipt直後のcrashは同じ
 * event object（recorded_atを含む）をroll-forwardできる。events.jsonはatomic
 * replaceだが、検証はpartial prefixも受け、別branchや別batchは拒否する。
 */
async function publishRuntimeEventBatch({ runDir, transactionId, phase, planEpoch,
  bindingDigest, currentEvents, proposedBatch, crashInjector }) {
  if (!verifyRunEventChain({ events: currentEvents }).valid) {
    throw new ManagedRuntimeError('EVENT_CHAIN_INVALID', 'event batch publish前のrun event chainが不正');
  }
  const receiptName = runtimeEventBatchReceiptName(transactionId, phase);
  const receiptPath = path.join(runDir, receiptName);
  let receipt = await readBoundedJson(receiptPath, 'runtime event batch receipt').catch((error) => {
    if (error?.code === 'INPUT_UNREADABLE') return null;
    throw error;
  });
  if (receipt === null) {
    const combined = [...currentEvents, ...proposedBatch];
    const chain = verifyRunEventChain({ events: combined });
    if (!chain.valid) {
      throw new ManagedRuntimeError('EVENT_CHAIN_INVALID', 'recompile event batchのchainが不正');
    }
    receipt = {
      schema: 'lattice.runtime_run_event_batch_receipt.v1',
      transaction_id: transactionId,
      phase,
      plan_epoch: planEpoch,
      binding_digest: bindingDigest,
      base_event_digests: currentEvents.map((event) => event.event_digest),
      batch_events: structuredClone(proposedBatch),
      ordered_event_digests: proposedBatch.map((event) => event.event_digest),
      batch_digest: digestArtifact(proposedBatch.map((event) => event.event_digest)),
      receipt_digest: '',
    };
    receipt.receipt_digest = selfDigest(receipt, 'receipt_digest');
    await replaceCanonicalJsonAtomically(runDir, receiptName, receipt);
    if (typeof crashInjector === 'function') await crashInjector('after_run_event_batch_receipt', {
      transaction_id: transactionId, phase, receipt_digest: receipt.receipt_digest,
    });
  }
  const receiptValid = receipt?.schema === 'lattice.runtime_run_event_batch_receipt.v1'
    && receipt.transaction_id === transactionId
    && receipt.phase === phase
    && receipt.plan_epoch === planEpoch
    && receipt.binding_digest === bindingDigest
    && receipt.receipt_digest === selfDigest(receipt, 'receipt_digest')
    && Array.isArray(receipt.base_event_digests)
    && Array.isArray(receipt.batch_events)
    && Array.isArray(receipt.ordered_event_digests)
    && canonicalizeArtifact(receipt.batch_events.map((event) => event.event_digest))
      === canonicalizeArtifact(receipt.ordered_event_digests)
    && receipt.batch_digest === digestArtifact(receipt.ordered_event_digests);
  if (!receiptValid) {
    throw new ManagedRuntimeError('RECOMPILE_EVENT_BATCH_CONFLICT', 'event batch receiptのbindingが不正');
  }
  const currentDigests = currentEvents.map((event) => event.event_digest);
  const fullDigests = [...receipt.base_event_digests, ...receipt.ordered_event_digests];
  if (!sameDigestPrefix(currentDigests, fullDigests) && !sameDigestPrefix(fullDigests, currentDigests)) {
    throw new ManagedRuntimeError('RECOMPILE_EVENT_BATCH_CONFLICT', 'events.jsonがreceiptと異なるbranchにある');
  }
  if (currentDigests.length >= fullDigests.length) return currentEvents;
  if (currentDigests.length < receipt.base_event_digests.length) {
    throw new ManagedRuntimeError('RECOMPILE_EVENT_BATCH_CONFLICT', 'receiptのbase event chainが欠落している');
  }
  const baseEvents = currentEvents.slice(0, receipt.base_event_digests.length);
  const completed = [...baseEvents, ...receipt.batch_events];
  const chain = verifyRunEventChain({ events: completed });
  if (!chain.valid) {
    throw new ManagedRuntimeError('EVENT_CHAIN_INVALID', 'receiptから復元したevent batchのchainが不正');
  }
  await replaceEventsAtomically(runDir, completed);
  return completed;
}

async function durableReplaceBytes(directory, name, bytes) {
  const temporaryPath = path.join(directory, `.${name}-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path.join(directory, name));
    await fsyncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function withLifecycleLock(runDir, action) {
  // managed mutationの正本lockはdurable supervisorが所有する。これはunmanaged/launch CLI競合だけを塞ぐ。
  const lockPath = path.join(runDir, '.cli-lifecycle.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new CliContractError('RUN_BUSY', 'run lifecycle操作が既に進行中');
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function readScriptedControllerReceipt({
  runDir,
  controllerId,
  payloadDigest,
}) {
  const receiptPath = path.join(
    runDir,
    'controllers',
    controllerId,
    'receipts',
    `${payloadDigest}.json`,
  );
  const info = await lstat(receiptPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ManagedRuntimeError(
      'ADAPTER_CONTROLLER_UNAVAILABLE',
      'scripted controller receipt sidecarがregular fileではない',
    );
  }
  const bytes = await readFile(receiptPath);
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ManagedRuntimeError(
      'ADAPTER_CONTROLLER_UNAVAILABLE',
      'scripted controller receipt sidecarのJSONが不正',
    );
  }
  if (bytes.toString('utf8') !== `${canonicalizeArtifact(receipt)}\n`
    || !validateExecutorReceipt(receipt)
    || digestArtifact(receipt) !== payloadDigest) {
    throw new ManagedRuntimeError(
      'ADAPTER_CONTROLLER_UNAVAILABLE',
      'scripted controller receipt sidecarのdigest bindingが不正',
    );
  }
  return receipt;
}

/**
 * runが起こしたworker processを、耐久記録から回収する。
 *
 * **記録が正本である。** 誰を起こしたかは`executor_dispatched`の
 * `direct_os_observation_binding`が持っており、controllerが落ちていても残る。
 *
 * pidだけで殺さない。pidは再利用されるので、start identityを取り直して記録と一致した
 * ものだけを止める——一致しなければ、それは別のprocessである。
 *
 * SIGKILLで送る。holdで止めたworkerはSIGSTOP状態にあり、SIGTERMは継続されるまで
 * 配送されない。停止したまま放置されたprocessは自分では終われない。
 */
async function reapRunWorkerProcesses({ events }) {
  const reaped = [];
  const skipped = [];
  const unavailable = [];
  const seen = new Set();
  for (const event of events) {
    if (event.kind !== 'executor_dispatched') continue;
    const binding = event.payload?.direct_os_observation_binding;
    const pid = binding?.process_pid;
    const recorded = binding?.process_start_identity?.identity_digest;
    if (!Number.isSafeInteger(pid) || typeof recorded !== 'string' || seen.has(pid)) continue;
    seen.add(pid);
    const observed = await observeManagedProcessStartIdentity(pid).catch(() => null);
    if (observed === null) {
      // 居ないか、居るのに再認証できない。後者には送らず記録する（u03 C25）。
      try { process.kill(pid, 0); unavailable.push(pid); } catch { /* 既に居ない */ }
      continue;
    }
    if (observed.identity_digest !== recorded) {
      skipped.push({ pid, reason: 'start identity不一致（pid再利用）' });
      continue;
    }
    try { process.kill(pid, 'SIGKILL'); reaped.push(pid); } catch { /* 競合で既に消えた */ }
  }
  return { reaped, skipped, unavailable };
}

async function driveScriptedManagedEpoch({
  runDir,
  repoRoot,
  request,
  committed,
  activation,
  managedSupervisor,
  initialEvents,
  controlEvents,
  sentinel = null,
  preDispatchBindings = null,
  drainEscalations = null,
  escalateTerminalConflict = null,
  preactivated = null,
  reportDriverState = null,
}) {
  let events = [...initialEvents];
  const { plan, manifests, executor_packets: packets } = committed.bundle;
  const controllerId = activation.controllerDescriptor.controller_id;
  const registrationDigest = activation.registration.registration_digest;
  const sessionNonceDigest = digestArtifact(activation.sessionNonce);
  const preactivatedByPacket = new Map((preactivated?.armedLeases ?? []).map((lease) => [
    lease.packet_digest,
    lease,
  ]));
  for (;;) {
    const frontier = computeReadyFrontier({ plan, events }).dispatchable;
    if (frontier.length === 0) break;
    await reportDriverState?.({ kind: 'frontier_dispatch', todo_ids: [...frontier].sort() });
    const alreadyRunning = projectRuntimeState({ events }).running;
    const issuedControlDigest = controlEvents().at(-1)?.event_digest;
    if (typeof issuedControlDigest !== 'string') {
      throw new ManagedRuntimeError(
        'EPOCH_ACTIVATION_INCOMPLETE',
        'initial dispatch leaseのcontrol bindingが無い',
      );
    }
    // workerの木を先に用意し、**dispatchの前から**監視を張る。dispatch応答を待つと、
    // 応答の中で書き込みが終わっている構成では観測対象のイベントが一度も起きない。
    // 木がTODOごとに分かれて初めて、書き込みの帰属をrootから決められる。
    const worktreeByTodo = new Map();
    for (const todoId of frontier) {
      const worktreePath = await ensureScriptedWorktree({
        repoRoot, runDir, packet: packets[todoId],
      });
      worktreeByTodo.set(todoId, worktreePath);
      preDispatchBindings?.set(todoId, {
        worktree_path: worktreePath, base_sha: packets[todoId].base_sha,
      });
    }
    syncSentinelWatches({ sentinel, runningTodoIds: [...frontier],
      rootOf: (todoId) => worktreeByTodo.get(todoId) });
    let activated = frontier.every((todoId) => preactivatedByPacket.has(packets[todoId].packet_digest))
      ? { armedLeases: frontier.map((todoId) => {
        const packetDigest = packets[todoId].packet_digest;
        const lease = preactivatedByPacket.get(packetDigest);
        preactivatedByPacket.delete(packetDigest);
        return lease;
      }) }
      : null;
    if (activated === null) {
      await managedSupervisor.barrierAll({
        barrierId: `dispatch-${plan.plan_epoch}-${events.length}`,
        reason: 'scripted_dispatch',
        frozenEventDigest: events.at(-1).event_digest,
      });
      const stagedLeases = [];
      for (const todoId of frontier) {
        const packet = packets[todoId];
        const staged = {
          schema: 'lattice.runtime_write_lease.v1',
          lease_id: `lease-${packet.packet_digest.slice(0, 24)}`,
          run_id: request.request_id,
          todo_id: todoId,
          plan_epoch: plan.plan_epoch,
          packet_digest: packet.packet_digest,
          controller_registration_digest: registrationDigest,
          supervisor_session_nonce_digest: sessionNonceDigest,
          state: 'staged',
          ttl_ms: 60_000,
          issued_control_digest: issuedControlDigest,
          lease_digest: '',
        };
        staged.lease_digest = selfDigest(staged, 'lease_digest');
        await managedSupervisor.prepareController({
          controllerId,
          executorPacket: packet,
          stagedLease: staged,
        });
        stagedLeases.push(staged);
      }
      const activationDigest = digestArtifact({
        schema: 'lattice.scripted_activation.v1',
        committed_epoch_pointer_digest: committed.pointer.pointer_digest,
        staged_lease_digests: stagedLeases.map((lease) => lease.lease_digest).sort(),
      });
      activated = await managedSupervisor.commitWriteGate({
        planEpoch: plan.plan_epoch,
        committedEpochDigest: committed.pointer.pointer_digest,
        activationDigest,
        commitReleaseBarrier: (barrier) => commitReleaseEpochBarrier({ runDir, barrier }),
        committedAt: canonicalNow(),
      });
    }
    const armedByPacket = new Map(activated.armedLeases.map((lease) => [
      lease.packet_digest,
      lease,
    ]));
    const terminalCheckpointByHandle = new Map();
    const managedAdapter = {
      async dispatch({ packet }) {
        const lease = armedByPacket.get(packet.packet_digest);
        if (lease === undefined) {
          throw new ManagedRuntimeError(
            'EPOCH_ACTIVATION_INCOMPLETE',
            `armed leaseが無い: ${packet.todo_id}`,
          );
        }
        await managedSupervisor.authorizeWrite({ leaseDigest: lease.lease_digest });
        const response = await managedSupervisor.route('dispatch', controllerId, {
          packet,
          write_lease: lease,
        });
        if (response.packet_digest !== packet.packet_digest
          || response.lease_digest !== lease.lease_digest) {
          throw new ManagedRuntimeError(
            'ADAPTER_CONTROLLER_UNAVAILABLE',
            `dispatch response binding不一致: ${packet.todo_id}`,
          );
        }
        return {
          executor_handle: response.executor_handle,
          worktree_id: response.worktree_id,
          write_lease_id: lease.lease_id,
          write_lease_digest: lease.lease_digest,
          controller_registration_digest: registrationDigest,
          controller_session_nonce_digest:
            activation.controllerDescriptor.controller_session_nonce_digest,
          direct_os_observation_binding: {
            // **controllerではなくworker processを指す。** holdは静止の証明を要求し、
            // 直接OS観測はここで名指しされたprocessが実際に停止していることを確かめる。
            // controllerを指していた頃は、止めれば応答できず止めなければ証明できなかった。
            process_pid: response.worker_process.pid,
            process_group_id: response.worker_process.process_group_id,
            process_start_identity:
              structuredClone(response.worker_process.process_start_identity),
            // 省略は従来adapterのstatic child集合。外部長寿命workerはroot identityと
            // PGIDだけを不変にし、barrier時点の全group member静止を検証する。
            process_children: [],
            process_membership_policy:
              response.worker_process.process_membership ?? 'static',
            // TODOごとの木を指す。ここがrepo rootだった頃、帰属はrootから決まらなかった。
            worktree_path: worktreeByTodo.get(packet.todo_id),
            worktree_realpath: worktreeByTodo.get(packet.todo_id),
            base_sha: packet.base_sha,
          },
        };
      },
      async observe({ executor_handle: executorHandle }) {
        const dispatch = events.findLast((event) => (
          event.kind === 'executor_dispatched'
          && event.payload?.executor_handle === executorHandle
        ));
        // **ここでpollしない。** 待つのは駆動側の仕事である——workerが走っている間が
        // 実行時競合を掴める唯一の窓であり、その窓は駆動側がeventsを手元に持っている時
        // にしか安全に触れない。ここで待つと、窓の間ずっと駆動側が止まる。
        const response = await managedSupervisor.route('observe', controllerId, {
          executor_handle: executorHandle,
          expected_epoch: dispatch.plan_epoch,
          expected_lease_digest: dispatch.payload.write_lease_digest,
        });
        if (response.observation.state === 'running') return { state: 'running' };
        if (response.observation.state !== 'terminal') {
          throw new ManagedRuntimeError(
            'ADAPTER_CONTROLLER_UNAVAILABLE',
            `scripted controllerが未知のstateを返した: ${response.observation.state}`,
          );
        }
        const receipt = await readScriptedControllerReceipt({
          runDir,
          controllerId,
          payloadDigest: response.observation.payload_digest,
        });
        const binding = dispatch.payload?.direct_os_observation_binding;
        if (typeof binding?.worktree_path !== 'string' || typeof binding?.base_sha !== 'string') {
          throw new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE',
            `terminal diffのorigin bindingが無い: ${dispatch.subject.ref}`);
        }
        const checkpoint = await captureWorktreeDiff({
          worktreePath: binding.worktree_path, baseSha: binding.base_sha,
        });
        // receiptのcheckpointはexecutor申告、これはsupervisorの独立観測でdigest schemaも異なる。
        // 同じeventへ混ぜず、receipt記録後に別checkpointとして追記する。
        terminalCheckpointByHandle.set(executorHandle, checkpoint);
        return { state: 'terminal', receipt };
      },
    };
    const dispatched = await dispatchReadyFrontier({
      runId: request.request_id,
      plan,
      events,
      packets,
      manifests,
      adapter: managedAdapter,
      recordedAt: canonicalNow(),
    });
    if (dispatched.failure !== null) {
      throw new ManagedRuntimeError(
        'ADAPTER_CONTROLLER_UNAVAILABLE',
        `scripted dispatch失敗: ${dispatched.failure.todo_id}: ${dispatched.failure.message}`,
      );
    }
    events = dispatched.events;
    await replaceEventsAtomically(runDir, events);
    // 走り出した瞬間から見る。checkpointは完了時まで撮られないので、ここを逃すと
    // 早期警報の意味が無くなる。
    syncSentinelWatches({ sentinel, runningTodoIds: projectRuntimeState({ events }).running,
      rootOf: (todoId) => events.findLast((event) => event.kind === 'executor_dispatched'
        && event.subject?.kind === 'todo' && event.subject.ref === todoId)
        ?.payload?.direct_os_observation_binding?.worktree_path });
    // **workerが走っている間だけが、実行時競合を掴める窓である。** 観測を1件ずつ待たずに
    // 回し、その合間に早期警報のescalationを捌く。捌くのは`replaceEventsAtomically`の
    // 直後だけ——そこでしかdiskとメモリのeventsが一致していない。
    const awaiting = new Set([...dispatched.dispatched, ...alreadyRunning]);
    if (awaiting.size > 0) {
      await reportDriverState?.({ kind: 'executor_completion', todo_ids: [...awaiting].sort() });
    }
    const completedReceiptIds = new Set();
    let frozen = false;
    while (awaiting.size > 0) {
      const drained = await drainEscalations?.(events) ?? null;
      if (drained !== null) {
        events = drained;
        if (projectRuntimeState({ events }).freeze !== null) { frozen = true; break; }
      }
      let progressed = false;
      for (const todoId of [...awaiting]) {
        const observed = await observeExecutor({
          runId: request.request_id,
          todoId,
          plan,
          events,
          adapter: managedAdapter,
          recordedAt: canonicalNow(),
        });
        if (observed.observation.state === 'running') continue;
        events = observed.events;
        if (observed.observation.state === 'terminal') {
          const dispatchForTerminal = events.findLast((event) => (
            event.kind === 'executor_dispatched'
            && event.subject?.kind === 'todo' && event.subject.ref === todoId
          ));
          const terminalCheckpoint = terminalCheckpointByHandle
            .get(dispatchForTerminal.payload.executor_handle);
          if (terminalCheckpoint === undefined) {
            throw new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE',
              `terminal diffが保存されていない: ${todoId}`);
          }
          terminalCheckpointByHandle.delete(dispatchForTerminal.payload.executor_handle);
          events.push(buildNextRunEvent({
            events,
            runId: request.request_id,
            kind: 'checkpoint_observed',
            planEpoch: plan.plan_epoch,
            subject: { kind: 'todo', ref: todoId },
            payload: { ...terminalCheckpoint, observed_by: 'supervisor_terminal' },
            recordedAt: canonicalNow(),
          }));
          const recordedReceipt = events.findLast((event) => event.kind === 'receipt_recorded'
            && event.subject?.kind === 'todo' && event.subject.ref === todoId);
          completedReceiptIds.add(recordedReceipt.payload.receipt_id);
          const terminalEvent = events.findLast((event) => event.kind === 'executor_terminal'
            && event.subject?.kind === 'todo' && event.subject.ref === todoId);
          const currentDispatch = events.findLast((event) => event.kind === 'executor_dispatched'
            && event.subject?.kind === 'todo' && event.subject.ref === todoId
            && event.sequence < terminalEvent.sequence);
          const overlappingTodoIds = plan.nodes.map((node) => node.todo_id)
            .filter((otherId) => {
              if (otherId === todoId) return false;
              const otherDispatch = events.findLast((event) => event.kind === 'executor_dispatched'
                && event.subject?.kind === 'todo' && event.subject.ref === otherId
                && event.sequence < terminalEvent.sequence);
              if (otherDispatch === undefined) return false;
              const otherTerminal = events.find((event) => event.kind === 'executor_terminal'
                && event.subject?.kind === 'todo' && event.subject.ref === otherId
                && event.sequence > otherDispatch.sequence);
              return otherTerminal === undefined || otherTerminal.sequence > currentDispatch.sequence;
            });
          const relevantTodoIds = [todoId, ...overlappingTodoIds];
          const terminalCheckpointEvent = events.findLast((event) => event.kind === 'checkpoint_observed'
            && event.subject?.kind === 'todo' && event.subject.ref === todoId
            && event.payload?.observed_by === 'supervisor_terminal');
          const observations = [{ todo_id: todoId,
            paths: terminalCheckpointEvent.payload.diff.entries.map((entry) => entry.path) }];
          for (const peerId of overlappingTodoIds) {
            const peerCheckpoint = events.findLast((event) => event.kind === 'checkpoint_observed'
              && event.subject?.kind === 'todo' && event.subject.ref === peerId
              && event.payload?.observed_by === 'supervisor_terminal');
            if (peerCheckpoint !== undefined) observations.push({ todo_id: peerId,
              paths: peerCheckpoint.payload.diff.entries.map((entry) => entry.path) });
          }
          const actionable = classifyObservedDiff({ plan, manifests, observations,
            relevantTodoIds }).findings.filter((finding) => [
            'observed_write_conflict', 'observed_line_change',
          ].includes(finding.kind)
              && finding.todo_ids.includes(todoId));
          if (actionable.length > 0) {
            if (typeof escalateTerminalConflict !== 'function') {
              throw new ManagedRuntimeError('FINDING_UNRESOLVED',
                'terminal conflictのmanaged escalation経路が無い');
            }
            await replaceEventsAtomically(runDir, events);
            events = await escalateTerminalConflict({ finding: actionable[0],
              checkpointDigest: terminalCheckpointEvent.payload.checkpoint_digest });
            frozen = true;
          }
        }
        await replaceEventsAtomically(runDir, events);
        syncSentinelWatches({ sentinel, runningTodoIds: projectRuntimeState({ events }).running,
          rootOf: (id) => events.findLast((event) => event.kind === 'executor_dispatched'
            && event.subject?.kind === 'todo' && event.subject.ref === id)
            ?.payload?.direct_os_observation_binding?.worktree_path });
        awaiting.delete(todoId);
        if (awaiting.size > 0) {
          await reportDriverState?.({ kind: 'executor_completion', todo_ids: [...awaiting].sort() });
        }
        progressed = true;
        if (frozen) break;
      }
      if (frozen) break;
      if (awaiting.size === 0) break;
      // 長寿命workerの正常な作業時間を固定期限でcontroller障害へ変換しない。
      // controllerとのroute自体が失敗した時だけtyped errorになり、running応答中は
      // durable supervisorが観測を継続する。CLIはoutcome unknownで先に戻り得るが、
      // run resumeは同じstoreをread-only投影し、leaseを再認可しない。
      if (!progressed) {
        await new Promise((resolve) => { setTimeout(resolve, SCRIPTED_OBSERVE_POLL_MS); });
      }
    }
    // holdが掛かったらdispatchを進めない。記録済みreceiptは失わず、対象群の再compile後に
    // origin bindingとcarry witnessを満たすものだけを後続epochで裁定する。
    if (frozen) return events;
    const adjudicated = adjudicatePendingReceipts({
      runId: request.request_id,
      plan,
      events,
      recordedAt: canonicalNow(),
    });
    const rejectedCompleted = adjudicated.decisions.filter((decision) => (
      completedReceiptIds.has(decision.receipt_id) && decision.decision !== 'accepted'
    ));
    if (rejectedCompleted.length > 0) {
      throw new ManagedRuntimeError(
        'ADAPTER_CONTROLLER_UNAVAILABLE',
        `scripted controller receiptが受理されなかった: ${rejectedCompleted
          .map((decision) => `${decision.receipt_id}:${decision.detail}`).join(',')}`,
      );
    }
    events = adjudicated.events;
    await replaceEventsAtomically(runDir, events);
  }
  return events;
}

function isHostDrivenEpochActivation(activation) {
  const controllerCapabilities = activation?.controllerDescriptor?.capabilities;
  if (acceptsHostDrivenEpoch(controllerCapabilities)) {
    return activation?.launchDescriptor?.capabilities_digest
      === controllerCapabilities.capabilities_digest;
  }
  return controllerCapabilities?.schema === 'lattice.runtime_adapter_capabilities.v1'
    && activation?.controllerDescriptor?.adapter_kind === 'scripted'
    && activation?.launchDescriptor?.launch_kind === 'host_binary'
    && activation.launchDescriptor.argv.some((argument) => (
      path.basename(argument) === 'lattice-scripted-adapter.mjs'
    ));
}

async function runStart({ requestPath, executorAdapter, cwd, stdout }) {
  // --executor省略時の暗黙fallbackは持たない（Decision 8）。未知adapterはtyped reject。
  if (!KNOWN_ADAPTERS.includes(executorAdapter)) {
    throw new CliContractError('UNKNOWN_ADAPTER', `未知のexecutor adapter: ${executorAdapter}`);
  }
  const request = await loadRequest(requestPath);
  if (!Array.isArray(request.executor_capability?.adapters)
    || !request.executor_capability.adapters.includes(executorAdapter)) {
    throw new CliContractError('UNKNOWN_ADAPTER', 'requestのexecutor_capabilityに含まれないadapter');
  }
  const repoRoot = await resolveRepoRoot(cwd);
  await requireSafeRunAncestors(repoRoot);
  await requireIgnoredRunStore(repoRoot);
  await resolveRepoBinding(repoRoot, request);
  const result = await compileFromRepo({
    request,
    cwd: repoRoot,
    planRef: `plan-${request.request_id}-e1`,
    planEpoch: 1,
    predecessorRefs: [],
  });
  if (result.outcome !== 'dispatchable') {
    throw new CliContractError(result.code, 'dispatchable planを発行できない', result.detail);
  }
  const compileArtifact = {
    schema: COMPILE_RESULT_SCHEMA,
    request_digest: request.request_digest,
    plan: result.plan,
    manifests: result.manifests,
    schedule: result.schedule,
    graph_digest: result.graph_digest,
  };
  compileArtifact.result_digest = digestArtifact(compileArtifact);
  const events = initializeRunEvents({
    runId: request.request_id,
    request,
    plan: result.plan,
    manifests: result.manifests,
    recordedAt: new Date().toISOString().replace(/\.\d+Z$/u, '.000Z'),
  });
  const runDir = runStorePath(repoRoot, request.request_id);
  await mkdir(path.dirname(runDir), { recursive: true });
  const temporaryDir = await mkdtemp(path.join(path.dirname(runDir), `.${request.request_id}.tmp-`));
  try {
    await lstat(runDir);
    await rm(temporaryDir, { recursive: true, force: true });
    throw new CliContractError('RUN_EXISTS', 'run storeが既に存在する');
  } catch (error) {
    if (error instanceof CliContractError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  const meta = {
    schema: 'lattice.run_meta.v1',
    run_id: request.request_id,
    executor_adapter: executorAdapter,
    plan_digest: result.plan.plan_digest,
  };
  try {
    await writeJsonFile(path.join(temporaryDir, 'request.json'), request);
    await writeJsonFile(path.join(temporaryDir, 'plan-compile-result.json'), compileArtifact);
    await writeJsonFile(path.join(temporaryDir, 'events.json'), events);
    await writeJsonFile(path.join(temporaryDir, 'run-meta.json'), meta);
    await rename(temporaryDir, runDir);
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      throw new CliContractError('RUN_EXISTS', 'run storeが既に存在する');
    }
    throw error;
  }
  const output = {
    schema: 'lattice.run_start_result.v1',
    run_id: request.request_id,
    run_dir: path.relative(repoRoot, runDir),
    executor_adapter: executorAdapter,
    plan_digest: result.plan.plan_digest,
    events_digest: digestArtifact(events.map(({ event_digest: digest }) => digest)),
  };
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

async function runPullStart({ runId, planKey, equipment, cwd, stdout }) {
  const repoRoot = await resolveRepoRoot(cwd);
  await requireSafeRunAncestors(repoRoot);
  await requireIgnoredRunStore(repoRoot);
  const runDir = runStorePath(repoRoot, runId);
  await mkdir(path.dirname(runDir), { recursive: true });
  const output = await startPullRun({ repoRoot, runDir, runId, planKey, equipment });
  output.run_dir = path.relative(repoRoot, runDir);
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

/**
 * 記録済み競合findingを、実際の変換で解消する（請求項8・ADR 0137〜0141）。
 *
 * 事前宣言されたtreatmentが無い競合は、これが無い間ずっと意図的直列へ退化していた。
 * 隔離worktreeで変換し、五条件（ADR 0138）を通り、確定できた時だけseam splitを返す。
 *
 * branchは動かさない。返す`successor_base_sha`へ進めるかどうかは操作するAIが決める——
 * 静的側の`land`と同じ責務分担であり、Latticeは変換・検証・記録と、後継baseの検査を持つ。
 */
async function runSeamResolve({ runDir, repoRoot, findingDigest, requestPath, stdout }) {
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null) {
    throw new CliContractError('RUN_NOT_MANAGED', 'runがmanaged storeへactivateされていない');
  }
  const declaration = await readBoundedJson(requestPath, 'runtime seam request');
  if (!validateRuntimeSeamRequest(declaration)) {
    throw new CliContractError('INVALID_SEAM_REQUEST', 'lattice.runtime_seam_request.v1として不正');
  }
  if (declaration.run_id !== committed.meta.run_id) {
    throw new CliContractError('INVALID_SEAM_REQUEST', '宣言のrun_idがrun storeと一致しない');
  }
  if (declaration.finding_digest !== findingDigest) {
    throw new CliContractError('INVALID_SEAM_REQUEST', '宣言のfinding_digestが--findingと一致しない');
  }
  const found = await readRuntimeFindingRecord({
    runDir, findingDigest, planEpoch: committed.pointer.plan_epoch,
  });
  if (found.record === null) throw new CliContractError('STALE_FINDING', found.reason);

  const resolved = await resolveRuntimeSeam({
    repoRoot,
    runDir,
    findingRecord: found.record,
    bundle: committed.bundle,
    declaration,
    latticeBin: fileURLToPath(new URL('../bin/lattice.mjs', import.meta.url)),
    compiledAt: canonicalNow(),
  });
  const resolution = buildRuntimeSeamResolution({
    runId: committed.meta.run_id, findingDigest, resolved,
  });
  stdout.write(`${JSON.stringify(resolution)}\n`);
  return resolution.lane === 'seam_transform' ? 0 : 1;
}

/**
 * 切断コストの内訳を、記録済みfindingについて投影する（read-only、docs/plan_seam-cost.md）。
 *
 * `seam resolve`が隔離worktreeで実変換まで行うのに対し、これは**変換を試す前の安い観測**である。
 * 「何を共有しているから単純に切れないのか」を数えられる事実として返し、試すかどうかの判断は
 * 操作するAIに残す。閾値も可否判定も返さない。投影であって記録ではないので、runへ何も書かない。
 *
 * symbolの帰属（concern_symbols）は入力で受ける。実行時のwitnessはpath単位の宣言しか持たず、
 * 係争fileの中で誰がどのsymbolを触るかはAIだけが知っている——ここで推定しない。
 */
async function runSeamProfile({ runDir, repoRoot, findingDigest, inputPath, stdout }) {
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null) {
    throw new CliContractError('RUN_NOT_MANAGED', 'runがmanaged storeへactivateされていない');
  }
  const found = await readRuntimeFindingRecord({
    runDir, findingDigest, planEpoch: committed.pointer.plan_epoch,
  });
  if (found.record === null) throw new CliContractError('STALE_FINDING', found.reason);
  const finding = found.record.finding;
  if (typeof finding.path !== 'string') {
    throw new CliContractError('SEAM_PROFILE_UNAVAILABLE',
      'path findingではない競合に切断コストの内訳は立たない');
  }

  const declaration = await readBoundedJson(inputPath, 'seam profile input');
  const identifier = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/u;
  const symbols = declaration?.concern_symbols;
  const todoIds = [...finding.todo_ids].sort();
  const declaredIds = symbols === null || typeof symbols !== 'object' || Array.isArray(symbols)
    ? null : Object.keys(symbols).sort();
  if (declaredIds === null
    || declaredIds.join('\0') !== todoIds.join('\0')
    || declaredIds.some((todoId) => !Array.isArray(symbols[todoId])
      || symbols[todoId].length === 0
      || !symbols[todoId].every((name) => identifier.test(name)))) {
    throw new CliContractError('SEAM_PROFILE_UNAVAILABLE',
      'concern_symbolsがfindingのtodo集合と一致しない。'
      + `{"concern_symbols": {${todoIds.map((id) => `"${id}": ["<symbol>"]`).join(', ')}}}の形で渡す`);
  }

  let sourceText;
  try {
    sourceText = await readFile(path.join(repoRoot, finding.path), 'utf8');
  } catch {
    throw new CliContractError('SEAM_PROFILE_UNAVAILABLE', `係争fileを読めない: ${finding.path}`);
  }
  const { computeSeamCostProfile } = await import('./seam-cost.mjs');
  const { profile, reasons } = await computeSeamCostProfile({
    repoRoot, sourcePath: finding.path, sourceText, ownedSymbolsByTask: symbols,
  });
  if (profile === null) {
    throw new CliContractError('SEAM_PROFILE_UNAVAILABLE', reasons.join(',') || 'profile_unavailable');
  }
  stdout.write(`${JSON.stringify(profile)}\n`);
  return 0;
}

const stoppedDriverProjection = () => ({ driver_state: 'stopped', waiting_on: null });

async function runtimeDriverProjection(runDir) {
  const state = await readRuntimeDriverState({ runDir });
  if (state === null || state.driver_state === 'stopped') return stoppedDriverProjection();
  const descriptorPath = path.join(runDir, ...state.supervisor_descriptor_ref.split('/'));
  let descriptor;
  try {
    descriptor = await readBoundedJson(descriptorPath, 'runtime supervisor descriptor');
  } catch (error) {
    if (error instanceof CliContractError && error.code === 'INPUT_UNREADABLE') {
      return stoppedDriverProjection();
    }
    throw error;
  }
  if (descriptor?.descriptor_digest !== state.supervisor_descriptor_digest
    || descriptor?.process_start_identity?.identity_digest
      !== state.supervisor_process_start_identity_digest) {
    throw new RuntimeDriverStateError('INVALID_RUN_STORE', 'driver stateがsupervisor descriptorへbindしない');
  }
  let observedIdentity;
  try {
    observedIdentity = await observeManagedProcessStartIdentity(descriptor.pid);
  } catch (error) {
    if (error instanceof ManagedRuntimeError && error.code === 'ADAPTER_CONTROLLER_UNAVAILABLE') {
      return stoppedDriverProjection();
    }
    throw error;
  }
  if (observedIdentity.identity_digest !== state.supervisor_process_start_identity_digest) {
    return stoppedDriverProjection();
  }
  return { driver_state: 'driving', waiting_on: structuredClone(state.waiting_on) };
}

async function withRuntimeDriverProjection(output, runDir) {
  const projected = { ...output, ...await runtimeDriverProjection(runDir) };
  delete projected.result_digest;
  projected.result_digest = digestArtifact(projected);
  return projected;
}

async function runObserve({ runDir, stdout }) {
  if ((await inspectRunMode(runDir)).mode === 'pull') {
    const output = await withRuntimeDriverProjection(await observePullRun(runDir), runDir);
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  const { events } = await readRunStore(runDir);
  const chain = verifyRunEventChain({ events });
  if (!chain.valid) {
    throw new CliContractError('EVENT_CHAIN_INVALID', 'event chainが不正', { failed_conditions: chain.failed_conditions });
  }
  const state = projectRuntimeState({ events });
  const output = {
    schema: 'lattice.run_observation.v1',
    running: state.running,
    accepted: state.accepted,
    terminal: state.terminal,
    hold_count: state.holds.length,
    conflict_count: state.conflicts.length,
    freeze_active: state.freeze !== null,
    closed: state.closed,
    event_count: events.length,
    events_digest: digestArtifact(events.map(({ event_digest: digest }) => digest)),
    ...await runtimeDriverProjection(runDir),
  };
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

async function runStatus({ runDir, stdout }) {
  if ((await inspectRunMode(runDir)).mode === 'pull') {
    const output = await withRuntimeDriverProjection(await statusPullRun(runDir), runDir);
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  const { events, meta, compileArtifact, managed } = await readRunStore(runDir);
  const chain = verifyRunEventChain({ events });
  if (!chain.valid) {
    throw new CliContractError('EVENT_CHAIN_INVALID', 'event chainが不正', { failed_conditions: chain.failed_conditions });
  }
  const state = projectRuntimeState({ events });
  const computedFrontier = computeReadyFrontier({ plan: compileArtifact.plan, events });
  const managedFrozen = managed === null ? false : await isManagedRunFrozen(runDir, events);
  const frontier = managedFrozen ? { dispatchable: [] } : computedFrontier;
  const output = {
    schema: 'lattice.run_status.v1',
    run_id: meta.run_id,
    executor_adapter: meta.executor_adapter,
    plan_digest: compileArtifact.plan.plan_digest,
    running: state.running,
    accepted: state.accepted,
    dispatchable: frontier.dispatchable,
    freeze_active: state.freeze !== null,
    closed: state.closed,
    event_count: events.length,
    ...await runtimeDriverProjection(runDir),
  };
  if (managed !== null) {
    output.schema = 'lattice.managed_run_status.v1';
    const runtimeProjection = {
      // v2は`treatment_advice`の追加。既定modeが直列化でも変換を試せる場合があることを、
      // 運転側が見える形にした（ct-003）。
      schema: 'lattice.runtime_status_projection.v2',
      ...projectRuntimeStatusOverlays({ events }),
      runtime_frozen: managedFrozen,
    };
    runtimeProjection.projection_digest = digestArtifact(runtimeProjection);
    output.runtime_projection = runtimeProjection;
  }
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

async function runList({ cwd, stdout }) {
  const repoRoot = await resolveRepoRoot(cwd);
  await requireSafeRunAncestors(repoRoot);
  const root = path.join(repoRoot, ...RUN_STORE_ROOT);
  let entries;
  try {
    const rootState = await lstat(root);
    if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
      throw new CliContractError('INVALID_RUN_STORE', '.lattice/runsが安全なdirectoryではない');
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') entries = [];
    else throw error;
  }
  const activeRuns = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !RUN_REF.test(`.lattice/runs/${entry.name}`)) {
      throw new CliContractError('INVALID_RUN_STORE', `不正なrun store entry: ${entry.name}`);
    }
    const runDir = path.join(root, entry.name);
    const mode = await inspectRunMode(runDir);
    if (mode.mode === 'pull') {
      const pull = await listPullRunEntry(runDir);
      if (!pull.closed) activeRuns.push({
        ...pull.entry, run_ref: `.lattice/runs/${entry.name}`,
      });
      continue;
    }
    const { events, meta, request } = await readRunStore(runDir);
    requireValidEventChain(events);
    if (!projectRuntimeState({ events }).closed) {
      activeRuns.push({
        run_id: meta.run_id,
        run_ref: `.lattice/runs/${entry.name}`,
        base_sha: request.repo.base_sha,
        executor_adapter: meta.executor_adapter,
      });
    }
  }
  const output = { schema: 'lattice.run_list.v1', active_runs: activeRuns };
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

function requireValidEventChain(events) {
  const chain = verifyRunEventChain({ events });
  if (!chain.valid) {
    throw new CliContractError('EVENT_CHAIN_INVALID', 'event chainが不正', { failed_conditions: chain.failed_conditions });
  }
}

async function runResume({ runDir, repoRoot, stdout }) {
  const { events, meta, compileArtifact, request, managed } = await readRunStore(runDir);
  requireValidEventChain(events);
  const state = projectRuntimeState({ events });
  if (state.closed) {
    throw new CliContractError('RUN_CLOSED', 'closed runはresumeできない');
  }
  await resolveRepoBinding(repoRoot, request);
  // managed write gateの完全検証とdispatch・長寿命workerの観測継続はsupervisorだけが
  // 所有する。read-only resumeがCLIからleaseを再認可しないよう、managed runでは
  // 常に空frontierを返し、生きたsupervisorが更新するstoreの現在地だけを返す。
  const managedFrozen = managed === null ? false : await isManagedRunFrozen(runDir, events);
  const frontier = managedFrozen
    ? { dispatchable: [] }
    : computeReadyFrontier({ plan: compileArtifact.plan, events });
  const output = {
    schema: 'lattice.run_resume_result.v1',
    outcome: 'resumable',
    run_id: meta.run_id,
    executor_adapter: meta.executor_adapter,
    dispatchable: frontier.dispatchable,
    running: state.running,
    accepted: state.accepted,
    event_count: events.length,
  };
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

/**
 * accepted receiptが束縛したworktree HEADの、remote既定branchへの着地状態を投影する。
 *
 * receipt本体はhead_shaを持たない。裁定時にexact bindされたcheckpoint_digestから、
 * 同じTODOのcheckpoint_observed.diff.head_shaへ辿る。git refsとrun storeを読むだけで、
 * branchもevent列も動かさない。未着地・upstream無しは判断結果であり失敗ではない。
 */
async function buildRunLandingReport({ runDir, repoRoot, events: providedEvents = null,
  runId: providedRunId = null }) {
  let events = providedEvents;
  let runId = providedRunId;
  if (events === null || runId === null) {
    const stored = await readRunStore(runDir);
    events = stored.events;
    runId = stored.meta.run_id;
  }
  requireValidEventChain(events);
  const state = projectRuntimeState({ events });

  const push = await runGit(['rev-parse', '--symbolic-full-name', '@{push}'], repoRoot);
  let pushState = 'no_upstream';
  let pushRef = null;
  let unpushedCommits = null;
  let remoteName = null;
  if (push.code === 0 && push.stdout.trim().length > 0) {
    pushRef = push.stdout.trim();
    const remoteMatch = /^refs\/remotes\/([^/]+)\/.+$/u.exec(pushRef);
    remoteName = remoteMatch?.[1] ?? null;
    const count = await runGit(['rev-list', '--count', `${pushRef}..HEAD`], repoRoot);
    if (count.code !== 0 || !/^\d+$/u.test(count.stdout.trim())) {
      throw new CliContractError('LANDING_GIT_UNRESOLVED',
        `push差分を読めない: ${count.stderr.trim() || count.stdout.trim()}`);
    }
    pushState = 'tracked';
    unpushedCommits = Number(count.stdout.trim());
  }

  if (remoteName === null) {
    const remotes = await runGit(['remote'], repoRoot);
    if (remotes.code !== 0) {
      throw new CliContractError('LANDING_GIT_UNRESOLVED',
        `remote一覧を読めない: ${remotes.stderr.trim()}`);
    }
    const names = remotes.stdout.split('\n').map((name) => name.trim()).filter(Boolean);
    if (names.length === 1) [remoteName] = names;
  }
  let defaultBranchState = 'unresolved';
  let defaultBranchRef = null;
  if (remoteName !== null) {
    const symbolic = await runGit(
      ['symbolic-ref', '--quiet', `refs/remotes/${remoteName}/HEAD`], repoRoot,
    );
    const candidate = symbolic.stdout.trim();
    if (symbolic.code === 0
      && candidate.startsWith(`refs/remotes/${remoteName}/`)
      && candidate !== `refs/remotes/${remoteName}/HEAD`) {
      defaultBranchState = 'resolved';
      defaultBranchRef = candidate;
    }
  }

  const acceptedReceipts = [];
  const accepted = state.receipts
    .filter((receipt) => receipt.accepted_sequence !== null)
    .sort((left, right) => left.todo_id.localeCompare(right.todo_id)
      || left.receipt_id.localeCompare(right.receipt_id));
  for (const receipt of accepted) {
    const checkpointDigest = receipt.payload?.checkpoint_digest;
    const checkpoint = state.checkpoints.findLast((entry) => (
      entry.todo_id === receipt.todo_id
      && entry.sequence < receipt.accepted_sequence
      && entry.payload?.checkpoint_digest === checkpointDigest
    ));
    const candidateHead = checkpoint?.payload?.diff?.head_sha;
    const headSha = typeof candidateHead === 'string' && /^[0-9a-f]{40}$/u.test(candidateHead)
      ? candidateHead : null;
    let landingState = 'head_unavailable';
    let landed = false;
    if (headSha !== null && defaultBranchRef === null) {
      landingState = 'default_branch_unresolved';
    } else if (headSha !== null) {
      const ancestry = await runGit(
        ['merge-base', '--is-ancestor', headSha, defaultBranchRef], repoRoot,
      );
      if (ancestry.code === 0) {
        landingState = 'landed';
        landed = true;
      } else if (ancestry.code === 1) {
        landingState = 'not_landed';
      } else {
        throw new CliContractError('LANDING_GIT_UNRESOLVED',
          `receipt HEADの祖先性を読めない: ${ancestry.stderr.trim()}`);
      }
    }
    acceptedReceipts.push({
      todo_id: receipt.todo_id,
      receipt_id: receipt.receipt_id,
      head_sha: headSha,
      landing_state: landingState,
      landed,
    });
  }

  const output = {
    schema: 'lattice.run_landing_report.v1',
    run_id: runId,
    landed: acceptedReceipts.length > 0 && acceptedReceipts.every((receipt) => receipt.landed),
    accepted_receipts: acceptedReceipts,
    repository: {
      default_branch_state: defaultBranchState,
      default_branch_ref: defaultBranchRef,
      push_state: pushState,
      push_ref: pushRef,
      unpushed_commits: unpushedCommits,
    },
  };
  output.result_digest = digestArtifact(output);
  return output;
}

async function runLanding({ runDir, repoRoot, stdout }) {
  const output = (await inspectRunMode(runDir)).mode === 'pull'
    ? await landingPullRun({ runDir, repoRoot })
    : await buildRunLandingReport({ runDir, repoRoot });
  stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

async function runClose({ runDir, repoRoot, stdout, requestId = null }) {
  if ((await inspectRunMode(runDir)).mode === 'pull') {
    const output = await closePullRun({ runDir, repoRoot });
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  return withLifecycleLock(runDir, async () => {
    const { events, meta, compileArtifact, request, managed } = await readRunStore(runDir);
    requireValidEventChain(events);
    const initialState = projectRuntimeState({ events });
    let next = events;
    let alreadyClosed = initialState.closed;
    const existingClose = events.findLast((event) => event.kind === 'run_closed');
    if (alreadyClosed && existingClose?.payload?.outcome === 'abandoned') {
      throw new CliContractError('RUN_ABANDONED', 'abandoned runは正常closeへ変更できない');
    }
    let abandonedTodoIds = [];
    if (!alreadyClosed) {
      const closed = closeRunAbandoningRemaining({
        runId: meta.run_id,
        plan: compileArtifact.plan,
        events,
        recordedAt: canonicalNow(),
      });
      abandonedTodoIds = closed.abandoned_todo_ids;
      if (managed !== null) {
        await runManagedControl({ runDir, runRef: path.relative(repoRoot, runDir),
          operation: 'close', artifactDigest: null, stdout, shutdownReason: 'normal-close',
          emit: false, requestId });
        next = (await readRunStore(runDir)).events;
      } else {
        next = closed.events;
        await replaceEventsAtomically(runDir, next);
      }
    }
    const output = {
      schema: 'lattice.run_close_result.v1',
      outcome: 'closed',
      run_id: meta.run_id,
      already_closed: alreadyClosed,
      ...(abandonedTodoIds.length > 0 ? { abandoned_todo_ids: abandonedTodoIds } : {}),
      event_count: next.length,
      events_digest: digestArtifact(next.map(({ event_digest: digest }) => digest)),
      landing: await buildRunLandingReport({
        runDir, repoRoot, events: next, runId: meta.run_id,
      }),
    };
    output.result_digest = digestArtifact(output);
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  });
}

async function runAbandon({ runDir, runRef, reason, stdout, requestId = null }) {
  if (!validRuntimeAbandonReason(reason)) {
    throw new CliContractError(
      'INVALID_ABANDON_REASON',
      'reasonは前後空白・制御文字を含まない1〜256文字の説明でなければならない',
    );
  }
  return withLifecycleLock(runDir, async () => {
    const current = await readRunStore(runDir);
    const { events, meta, compileArtifact } = current;
    requireValidEventChain(events);
    const state = projectRuntimeState({ events });
    if (state.closed) {
      const existing = events.findLast((event) => event.kind === 'run_closed');
      if (current.managed !== null && existing?.payload?.outcome === 'abandoned'
        && existing.payload.reason === reason) {
        const output = { schema: 'lattice.run_abandon_result.v1', outcome: 'abandoned', reason,
          run_id: meta.run_id, event_count: events.length,
          events_digest: digestArtifact(events.map(({ event_digest: value }) => value)) };
        output.result_digest = digestArtifact(output); stdout.write(`${JSON.stringify(output)}\n`); return 0;
      }
      throw new CliContractError('RUN_CLOSED', 'closed runはabandonできない');
    }
    let next = [...events];
    if (current.managed !== null) {
      await runManagedControl({ runDir, runRef, operation: 'abandon', artifactDigest: null,
        shutdownReason: reason, stdout, emit: false, requestId });
      next = (await readRunStore(runDir)).events;
    } else next.push(buildNextRunEvent({
      events: next,
      runId: meta.run_id,
      kind: 'run_closed',
      planEpoch: compileArtifact.plan.plan_epoch,
      subject: { kind: 'runtime_plan', ref: compileArtifact.plan.plan_ref },
      payload: { outcome: 'abandoned', reason, accepted: state.accepted },
      recordedAt: canonicalNow(),
    }));
    if (current.managed === null) await replaceEventsAtomically(runDir, next);
    const output = {
      schema: 'lattice.run_abandon_result.v1',
      outcome: 'abandoned',
      reason,
      run_id: meta.run_id,
      event_count: next.length,
      events_digest: digestArtifact(next.map(({ event_digest: digest }) => digest)),
    };
    output.result_digest = digestArtifact(output);
    stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  });
}

async function readManagedSession(runDir) {
  const supervisorDir = path.join(runDir, 'supervisor');
  const activePaths = await resolveActiveRuntimePaths({ runDir });
  const descriptorPath = activePaths.descriptorPath;
  const sessionPath = activePaths.sessionPath;
  const descriptor = await readBoundedJson(descriptorPath, 'runtime supervisor descriptor');
  const sessionInfo = await lstat(sessionPath).catch(() => null);
  const descriptorKeys = ['schema', 'run_id', 'pid', 'process_start_identity', 'socket_ref',
    'session_nonce_digest', 'protocol_version', 'activated_at', 'descriptor_digest'];
  const identityKeys = ['schema', 'platform', 'pid', 'started_identity', 'identity_digest'];
  const descriptorBody = { ...descriptor };
  delete descriptorBody.descriptor_digest;
  const identity = descriptor?.process_start_identity;
  const identityBody = { ...identity };
  delete identityBody.identity_digest;
  if (descriptor?.schema !== 'lattice.runtime_supervisor_descriptor.v1'
    || Object.keys(descriptor).sort().join('\0') !== descriptorKeys.sort().join('\0')
    || typeof descriptor.run_id !== 'string'
    || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1
    || identity?.schema !== 'lattice.process_start_identity.v1'
    || Object.keys(identity).sort().join('\0') !== identityKeys.sort().join('\0')
    || identity.pid !== descriptor.pid
    || identity.identity_digest !== digestArtifact(identityBody)
    || descriptor.descriptor_digest !== digestArtifact(descriptorBody)
    || descriptor.socket_ref !== 'supervisor/control.sock'
    || sessionInfo === null || !sessionInfo.isFile() || sessionInfo.isSymbolicLink()
    || (sessionInfo.mode & 0o077) !== 0) {
    throw new CliContractError('RUN_NOT_MANAGED', 'live supervisor bindingが不正');
  }
  const sessionNonce = (await readFile(sessionPath, 'utf8')).trim();
  const nonceDigest = digestArtifact(sessionNonce);
  if (sessionNonce.length < 32 || nonceDigest !== descriptor.session_nonce_digest) {
    throw new CliContractError('RUN_NOT_MANAGED', 'supervisor sessionがdescriptorと一致しない');
  }
  if (activePaths.pointer !== null
    && (activePaths.pointer.descriptor_digest !== descriptor.descriptor_digest
      || activePaths.pointer.session_nonce_digest !== nonceDigest)) {
    throw new CliContractError('RUN_NOT_MANAGED', 'active runtime pointer bindingが不正');
  }
  const socketPath = path.join(supervisorDir, 'control.sock');
  const socketInfo = await lstat(socketPath).catch(() => null);
  if (socketInfo === null || !socketInfo.isSocket() || socketInfo.isSymbolicLink()) {
    throw new CliContractError('RUN_NOT_MANAGED', 'supervisor control socketがliveではない');
  }
  return { descriptor, sessionNonce, socketPath };
}

function controlOperationPayload({ operation, runRef, artifact = null, artifactDigest,
  checkpointDigest = null, expectedEpoch, expectedQueueDigest, shutdownReason = null }) {
  const value = {
    schema: 'lattice.runtime_control_operation.v1',
    operation,
    run_ref: runRef,
    artifact,
    artifact_digest: artifactDigest,
    checkpoint_digest: checkpointDigest,
    expected_epoch: expectedEpoch,
    expected_queue_digest: expectedQueueDigest,
    shutdown_reason: shutdownReason,
  };
  value.operation_digest = digestArtifact(value);
  return value;
}

async function isActiveSupervisorGateCommitted(runDir, events, expectedEpoch) {
  if (await isManagedRunFrozen(runDir, events)) return false;
  const active = await resolveActiveRuntimePaths({ runDir });
  const sessionNonceDigest = active.pointer?.session_nonce_digest
    ?? digestArtifact((await readFile(active.sessionPath, 'utf8')).trim());
  const gateDocument = await readBoundedJson(path.join(runDir, 'supervisor', 'write-gate.json'),
    'supervisor write gate');
  const committedGate = await createRuntimeGateStore({ runDir, runId: gateDocument.run_id,
    sessionNonceDigest, controlEventsPath: active.controlEventsPath }).read();
  if (committedGate === null || committedGate.gate.plan_epoch !== expectedEpoch) return false;
  const gate = committedGate.gate;
  const controlEvents = await readBoundedJson(active.controlEventsPath,
    'runtime control events');
  const resumed = controlEvents.findLast((event) => event.kind === 'intake_resumed'
    && event.payload?.plan_epoch === expectedEpoch
    && event.payload?.gate_digest === gate.gate_digest);
  return resumed !== undefined && resumed.session_nonce_digest === sessionNonceDigest;
}

async function runManagedControl({ runDir, runRef, operation, artifact = null, artifactDigest, stdout,
  checkpointDigest = null, shutdownReason = null, emit = true, requestId = null }) {
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null) throw new CliContractError('RUN_NOT_MANAGED', 'runがmanaged storeへactivateされていない');
  const { descriptor, sessionNonce, socketPath } = await readManagedSession(runDir);
  if (descriptor.run_id !== committed.meta.run_id) {
    throw new CliContractError('RUN_NOT_MANAGED', 'supervisor descriptorが別runに属する');
  }
  let expectedQueueDigest = null;
  try {
    const queue = await readBoundedJson(path.join(runDir, 'queued-events.json'), 'runtime queue');
    expectedQueueDigest = queue.queue_digest;
  } catch (error) {
    if (!(error instanceof CliContractError) || error.code !== 'INPUT_UNREADABLE') throw error;
  }
  let expectedEpoch = operation === 'activate' ? 1 : operation === 'recompile'
    && Number.isSafeInteger(artifact?.predecessor_epoch)
    ? artifact.predecessor_epoch : committed.pointer.plan_epoch;
  if (operation === 'recompile' && requestId !== null) {
    const transaction = await readBoundedJson(path.join(runDir,
      'epoch-activation-transaction.json'), 'epoch activation transaction').catch(() => null);
    if (transaction?.request_id === requestId
      && transaction.recompile_request_digest === artifact?.request_digest) {
      expectedEpoch = transaction.successor_epoch - 1;
      expectedQueueDigest = transaction.queue_head_digest;
    }
  }
  if (operation === 'reprocess' && requestId !== null) {
    const pending = await readBoundedJson(path.join(runDir, 'pending-recompile.json'),
      'pending recompile').catch(() => null);
    if (pending?.reprocess_request_id === requestId
      && pending.pending_digest === selfDigest(pending, 'pending_digest')) {
      expectedEpoch = pending.predecessor_epoch;
      expectedQueueDigest = pending.reprocess_queue_digest;
    } else {
      const transaction = await readBoundedJson(path.join(runDir,
        'epoch-activation-transaction.json'), 'epoch activation transaction').catch(() => null);
      if (transaction?.schema === 'lattice.runtime_epoch_activation_transaction.v1'
        && transaction.transaction_digest === selfDigest(transaction, 'transaction_digest')) {
        expectedEpoch = transaction.successor_epoch - 1;
        expectedQueueDigest = transaction.queue_head_digest;
      }
    }
  }
  if (operation === 'activate') expectedQueueDigest = null;
  const payload = controlOperationPayload({
    operation, runRef, artifact, artifactDigest, checkpointDigest,
    expectedEpoch,
    expectedQueueDigest, shutdownReason,
  });
  const request = createRuntimeControlRequest({
    requestId: requestId ?? randomUUID(), runId: committed.meta.run_id, operation,
    payload, sessionNonce,
  });
  if (operation === 'reprocess' && requestId !== null
    && committed.pointer.plan_epoch === expectedEpoch + 1) {
    const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
    if (await isActiveSupervisorGateCommitted(runDir, events, committed.pointer.plan_epoch)) {
      const activeRuntime = await resolveActiveRuntimePaths({ runDir });
      const journal = await readBoundedJson(activeRuntime.controlEventsPath,
        'runtime control events');
      const result = buildControlResult({ operation: 'reprocess', outcome: 'reprocessed',
        eventHeadDigest: events.at(-1)?.event_digest ?? null,
        controlHeadDigest: journal.at(-1)?.event_digest ?? null,
        activeEpoch: committed.pointer.plan_epoch, stagedEpoch: null });
      let response = buildControlResponse(request, 'completed', result,
        journal.at(-1)?.event_digest ?? null);
      const store = createRuntimeControlStore({ runDir, runId: committed.meta.run_id,
        clock: canonicalNow });
      const known = await store.readRequest(request);
      if (known?.state === 'completed' && known.response.outcome === 'completed') {
        response = known.response;
      } else if (known?.state === 'completed' && known.response.outcome === 'rejected') {
        response = await store.recoverCompletedRequest(request, response);
      } else {
        response = await store.completeRequest(request, response);
      }
      if (emit) stdout.write(`${JSON.stringify(response.result)}\n`);
      return emit ? 0 : response.result;
    }
  }
  let response;
  let ambiguous = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      response = await sendRuntimeControlRequest({ socketPath, request,
        timeoutMs: ['recompile', 'reprocess'].includes(operation) ? 60_000 : 5_000 });
    } catch (error) {
      if (error?.code === 'RUN_OUTCOME_UNKNOWN') ambiguous = true;
      else if (!(ambiguous && error?.code === 'RUN_NOT_MANAGED')) throw error;
      if (operation === 'reprocess' && requestId !== null) {
        const latest = await readCommittedEpochStore(runDir);
        const latestEvents = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        if (latest?.pointer.plan_epoch === expectedEpoch + 1
          && await isActiveSupervisorGateCommitted(runDir, latestEvents,
            latest.pointer.plan_epoch)) {
          return runManagedControl({ runDir, runRef, operation, artifact, artifactDigest,
            stdout, checkpointDigest, shutdownReason, emit, requestId });
        }
      }
      if (attempt === 99) throw new CliContractError('RUN_OUTCOME_UNKNOWN',
        `managed ${operation}の結果が確定しない。同一request_id=${request.request_id}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (response.outcome !== 'unknown') break;
    if (operation === 'reprocess' && requestId !== null) {
      const latest = await readCommittedEpochStore(runDir);
      const latestEvents = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
      if (latest?.pointer.plan_epoch === expectedEpoch + 1
        && await isActiveSupervisorGateCommitted(runDir, latestEvents,
          latest.pointer.plan_epoch)) {
        return runManagedControl({ runDir, runRef, operation, artifact, artifactDigest,
          stdout, checkpointDigest, shutdownReason, emit, requestId });
      }
    }
    if (attempt === 99) throw new CliContractError('RUN_OUTCOME_UNKNOWN',
      `managed ${operation}の結果が確定しない。同一request_id=${request.request_id}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (response.outcome !== 'completed') {
    const code = response.result?.unmet?.[0] ?? 'RUN_FROZEN';
    throw new CliContractError(code, `managed ${operation}が${response.outcome}で終了した: ${response.result?.unmet?.[1] ?? code}`);
  }
  const resultKeys = ['schema', 'operation', 'outcome', 'event_head_digest', 'control_head_digest',
    'active_epoch', 'staged_epoch', 'unmet', 'result_digest'];
  if (operation === 'finding_record') resultKeys.push('finding_digest');
  const resultBody = { ...response.result };
  delete resultBody.result_digest;
  if (response.result?.schema !== 'lattice.runtime_control_result.v1'
    || Object.keys(response.result).sort().join('\0') !== resultKeys.sort().join('\0')
    || response.result.operation !== operation
    || response.result.result_digest !== digestArtifact(resultBody)) {
    throw new CliContractError('RUN_NOT_MANAGED', 'managed control result bindingが不正');
  }
  if (emit) stdout.write(`${JSON.stringify(response.result)}\n`);
  return emit ? 0 : response.result;
}

function buildControlResult({ operation, outcome, eventHeadDigest, controlHeadDigest, activeEpoch, stagedEpoch = null, unmet = [] }) {
  const result = {
    schema: 'lattice.runtime_control_result.v1', operation, outcome,
    event_head_digest: eventHeadDigest, control_head_digest: controlHeadDigest,
    active_epoch: activeEpoch, staged_epoch: stagedEpoch, unmet,
  };
  result.result_digest = digestArtifact(result);
  return result;
}

function buildControlResponse(request, outcome, result, controlHeadDigest) {
  const response = {
    schema: 'lattice.runtime_control_response.v1', request_id: request.request_id,
    run_id: request.run_id, outcome, result, control_head_digest: controlHeadDigest,
  };
  response.response_digest = digestArtifact(response);
  return response;
}

function validateRuntimeQueue(queue, runId, frozenEpoch) {
  return queue !== null && typeof queue === 'object' && !Array.isArray(queue)
    && Object.keys(queue).sort().join('\0') === ['schema', 'run_id', 'frozen_epoch', 'entries', 'queue_digest'].sort().join('\0')
    && queue.schema === 'lattice.runtime_queue.v1' && queue.run_id === runId
    && queue.frozen_epoch === frozenEpoch && Array.isArray(queue.entries)
    && queue.entries.every((entry, index) => entry !== null && typeof entry === 'object'
      && !Array.isArray(entry)
      && Object.keys(entry).sort().join('\0') === ['sequence', 'kind', 'subject_digest', 'artifact_digest'].sort().join('\0')
      && Number.isSafeInteger(entry.sequence) && entry.sequence === index + 1
      && typeof entry.kind === 'string' && entry.kind.length > 0
      && /^[0-9a-f]{64}$/u.test(entry.subject_digest)
      && /^[0-9a-f]{64}$/u.test(entry.artifact_digest))
    && queue.queue_digest === selfDigest(queue, 'queue_digest');
}

function controlIntentDigest(request) {
  return selfDigest({ request_id: request.request_id, run_id: request.run_id,
    operation: request.operation, payload: request.payload, intent_digest: '' }, 'intent_digest');
}

export function reconstructHoldResultFromJournal({ journal, runId, requestId, intentDigest }) {
  if (!Array.isArray(journal)) return null;
  const preparedIndex = journal.findIndex((event) => event.kind === 'hold_prepared'
    && event.payload?.request_id === requestId
    && event.payload?.logical_intent_digest === intentDigest);
  const prepared = journal[preparedIndex];
  const barrierIndex = prepared === undefined ? -1 : journal.findIndex((event, index) => (
    index > preparedIndex && event.kind === 'barrier_requested'
    && event.payload?.barrier_id === prepared.payload.barrier_id));
  const barrier = journal[barrierIndex];
  if (prepared === undefined || barrier === undefined) return null;
  const acknowledgements = journal.slice(barrierIndex + 1)
    .filter((event) => event.kind === 'executor_quiesced'
      && event.payload?.barrier_id === prepared.payload.barrier_id
      && event.payload?.barrier_control_digest === barrier.event_digest);
  const acknowledgedTodos = acknowledgements.map((event) => event.payload.todo_id).sort();
  if (acknowledgements.length !== barrier.payload.running_count
    || acknowledgements.some((event) => typeof event.payload?.ack?.ack_digest !== 'string')
    || new Set(acknowledgedTodos).size !== acknowledgedTodos.length
    || JSON.stringify(acknowledgedTodos) !== JSON.stringify(barrier.payload.running_todo_ids)) return null;
  const result = {
    schema: 'lattice.runtime_hold_result.v1', run_id: runId,
    finding_digest: prepared.payload.finding_digest, barrier_id: prepared.payload.barrier_id,
    quiescence_ack_digests: acknowledgements.map((event) => event.payload.ack.ack_digest).sort(),
    outcome: 'held', recorded_at: prepared.payload.recorded_at, result_digest: '',
  };
  result.result_digest = selfDigest(result, 'result_digest');
  return result;
}

/** 現在registryが持つadapter kindを返す。registryが無ければ空配列（推測で埋めない）。 */
async function registeredAdapterKinds(repoRoot) {
  try {
    const registry = JSON.parse(await readFile(
      path.join(repoRoot, '.lattice/runtime/adapter-registry/registry.json'), 'utf8',
    ));
    if (!Array.isArray(registry?.entries)) return [];
    return registry.entries
      .map((entry) => entry?.adapter_kind)
      .filter((kind) => typeof kind === 'string')
      .sort();
  } catch { return []; }
}

async function runActivate({ runDir, runRef, repoRoot, stdout, requestId = null }) {
  return withLifecycleLock(runDir, async () => {
  const { events, meta, managed } = await readRunStore(runDir);
  if (!['lattice.run_meta.v1', 'lattice.run_meta.v2'].includes(meta.schema)) throw new CliContractError('RUN_NOT_MANAGED', 'run metaがactivate対象でない');
  if (projectRuntimeState({ events }).closed) throw new CliContractError('RUN_CLOSED', 'closed runは再activateできない');
  if (managed !== null && requestId !== null) {
    try {
      return await runManagedControl({ runDir, runRef, operation: 'activate', artifactDigest: null,
        stdout, requestId });
    } catch (error) {
      if (error?.code !== 'RUN_NOT_MANAGED') throw error;
    }
  }
  if (managed !== null) await prepareManagedSupervisorRestart({ runDir });
  const launched = await launchDurableSupervisor({ runDir });
  const payload = controlOperationPayload({
    operation: 'activate', runRef, artifactDigest: null, expectedEpoch: 1, expectedQueueDigest: null,
  });
  const request = createRuntimeControlRequest({ requestId: requestId ?? randomUUID(), runId: meta.run_id,
    operation: 'activate', payload, sessionNonce: launched.sessionNonce });
  let response;
  let ambiguous = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      response = await sendRuntimeActivationRequestUntilSettled({
        socketPath: launched.socketPath, request, expectedPid: launched.pid,
        expectedProcessStartIdentity: launched.processStartIdentity,
      });
    } catch (error) {
      if (error?.code === 'RUN_OUTCOME_UNKNOWN') ambiguous = true;
      else if (!(ambiguous && error?.code === 'RUN_NOT_MANAGED')) throw error;
      if (attempt === 99) throw new CliContractError('RUN_OUTCOME_UNKNOWN',
        `managed activateの結果が確定しない。同一request_id=${request.request_id}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (response.outcome !== 'unknown') break;
    if (attempt === 99) throw new CliContractError('RUN_OUTCOME_UNKNOWN',
      `managed activateの結果が確定しない。同一request_id=${request.request_id}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (response.outcome !== 'completed') {
    const code = response.result?.unmet?.[0] ?? 'ADAPTER_CONTROLLER_UNAVAILABLE';
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { await lstat(path.join(runDir, 'supervisor')); } catch (error) {
        if (error?.code === 'ENOENT') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // ADAPTER_NOT_REGISTEREDは「registryが無い／そのadapterのentryが無い」だけを意味し、
    // 何をどこへ置けば解決するかをそれ自体は伝えない。行き止まりにしないため、
    // 必要な成果物と現在registryが持つadapterを返す（ADR 0123と同じdiagnosability規律）。
    if (code === 'ADAPTER_NOT_REGISTERED') {
      throw new CliContractError(code, `managed activateが${response.outcome}で終了した: ${response.result?.unmet?.[1] ?? code}`, {
        adapter_kind: meta?.executor_adapter ?? null,
        required_artifact: '.lattice/runtime/adapter-registry/registry.json',
        registered_adapters: await registeredAdapterKinds(repoRoot),
        reason: 'run activateは登録済みexecutor adapterを要求する。run adapter registerで登録する',
      });
    }
    throw new CliContractError(code, `managed activateが${response.outcome}で終了した: ${response.result?.unmet?.[1] ?? code}`);
  }
  // daemonがpointerまでcommitしたことを再読してから成功を返す。
  const committed = await readCommittedEpochStore(runDir);
  if (committed === null
    || !events.some((event) => event.event_digest === committed.pointer.activation_run_event_digest)) {
    throw new CliContractError('RUN_NOT_MANAGED', 'activate commitを再検証できない');
  }
  stdout.write(`${JSON.stringify(response.result)}\n`);
  return 0;
  });
}

export async function runManagedSupervisorDaemon({
  runDir, sessionNonce, serveRuntimeControlSocket, activateController, onReady,
  registerDaemonCleanup = () => {}, crashInjector = null,
  validatePhaseRevision = null, commitPhaseRevision = null,
}) {
  const repoRoot = await realpath(path.resolve(runDir, '..', '..', '..'));
  const request = await readBoundedJson(path.join(runDir, 'request.json'), 'run request');
  const compileArtifact = await readBoundedJson(path.join(runDir, 'plan-compile-result.json'), 'plan compile result');
  const legacyMeta = await readBoundedJson(path.join(runDir, 'run-meta.json'), 'run meta');
  const supervisorDir = path.join(runDir, 'supervisor');
  await mkdir(supervisorDir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(supervisorDir, 'control.sock');
  let managedSupervisor = null;
  let activation = null;
  let additionalActivations = [];
  let activationCommitted = false;
  let controlEvents = [];
  const restarting = legacyMeta.schema === 'lattice.run_meta.v2';
  let candidateDir = null;
  let candidateControllerDir = null;
  let recoveryRegistrationDigest = null;
  const requestStore = createRuntimeControlStore({ runDir, runId: request.request_id,
    clock: canonicalNow });
  let eventStore = requestStore;
  let server;
  let sentinel = null;

  const appendControl = async ({ run_id: runId, kind, session_nonce_digest: sessionDigest, payload }) => {
    const eventDigest = await eventStore.append({ run_id: runId, kind,
      session_nonce_digest: sessionDigest, payload });
    controlEvents = await eventStore.readEvents();
    return eventDigest;
  };
  let gateWriter = null;

  /**
   * 警報を無停止のcheckpointで確かめる（ADR 0143の二段目）。
   *
   * probeが撮るのはgitから読んだ本物のdiffなので、そのままfindingの証拠になる。
   * fs eventをfindingへ昇格させる必要が無く、契約を1つも緩めずに済む。
   */
  /**
   * dispatch event耐久化より前のobservation binding。
   *
   * frontierのworktreeを用意した時点でsupervisorが知っている値を置く。警報はdispatchの
   * 最中に飛ぶので、eventの耐久化を待つと最も早い観測を取り逃す。
   */
  const preDispatchBindings = new Map();

  const probeWarning = async (warning) => {
    const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events')
      .catch(() => null);
    if (!Array.isArray(events)) {
      return { outcome: 'unprobed', writers: [], checkpoints: {}, roots: {} };
    }
    const checkpoints = {};
    const roots = {};
    for (const todoId of warning.todo_ids) {
      const dispatch = events.findLast((event) => event.kind === 'executor_dispatched'
        && event.subject?.kind === 'todo' && event.subject.ref === todoId);
      // dispatch eventは、frontier全体のdispatchが終わってから一括で耐久化される。
      // 警報はその最中に飛ぶので、eventだけを頼りにすると**いちばん早い観測を必ず取り逃す**。
      // supervisorはdispatchの前にworktreeを用意した時点で同じbindingを知っているので、
      // そちらを先に見る。値はどちらも同一で、早いか遅いかの違いしかない。
      const binding = dispatch?.payload?.direct_os_observation_binding
        ?? preDispatchBindings.get(todoId);
      if (typeof binding?.worktree_path !== 'string' || typeof binding?.base_sha !== 'string') continue;
      roots[todoId] = binding.worktree_path;
      // 観測できないTODOは「書いていない」へ丸めない。probeIoWarningが未観測として扱う。
      const captured = await captureWorktreeDiff({
        worktreePath: binding.worktree_path, baseSha: binding.base_sha,
      }).catch(() => null);
      if (captured !== null) checkpoints[todoId] = captured;
    }
    if (Object.keys(checkpoints).length === 0) {
      return { outcome: 'unprobed', writers: [], checkpoints, roots };
    }
    return { ...probeIoWarning({ warning, checkpointsByTodo: checkpoints }), checkpoints, roots };
  };

  /**
   * 書き手を特定できる構成かを確かめる。
   *
   * sentinelの帰属はworktree rootだけで決まる（プロセス帰属を持たない）。だから
   * **複数TODOが同じrootを共有している構成では、誰が書いたかを観測から言えない**。
   * 実際、管理daemonのscripted構成は全TODOのbindingが同じrepo rootを指す。
   *
   * そこでは警報も、probeが撮るcheckpointも、TODO間で区別が付かない——同じ木を2回読んで
   * 「両方が書いた」と読めてしまう。これをholdへ繋ぐと、無実のTODOを止める。
   * 帰属が立たないならescalationへ進めない。警報と実在の記録はそのまま残す。
   */
  /**
   * holdが要求する静止を、この構成で証明できるか。
   *
   * 直接OS観測はexecutorのprocessが停止していることを実測する。scripted controllerは
   * 自分のprocessで作業するので、そのprocessを止めると制御そのものが止まる——止めない限り
   * 証明できず、止めれば応答できない。**別processのexecutorを持つまでこの穴は埋まらない。**
   */
  const attributionIsDistinct = (warning, roots) => {
    const paths = warning.todo_ids.map((todoId) => roots[todoId]);
    if (paths.some((value) => typeof value !== 'string')) return false;
    return new Set(paths).size === paths.length;
  };

  /**
   * I/O sentinelの早期警報を耐久化する（ADR 0143）。
   *
   * **findingにはしない。** findingの契約はcheckpoint digestを必須にしており、それはfindingが
   * 事後に再読して再導出できる主張であることの担保である。fs eventは取りこぼすし再読もできない。
   * ここで残すのは「機械が気づいた」という事実だけで、判定の正本はcheckpointのままである。
   *
   * 記録しない選択肢は無い。気づいたのに黙っている状態を残さない。
   */
  const warningDigestOf = (warning) => digestArtifact({
    warning_kind: warning.kind, todo_ids: [...warning.todo_ids].sort(), path: warning.path,
  });

  const recordIoWarning = async (warning, probeOutcome) => {
    const payload = {
      warning_kind: warning.kind,
      todo_ids: [...warning.todo_ids].sort(),
      path: warning.path,
      probe_outcome: probeOutcome,
      warning_digest: warningDigestOf(warning),
    };
    await appendControl({ run_id: request.request_id, kind: 'io_warning_observed',
      session_nonce_digest: digestArtifact(sessionNonce), payload });
  };

  /**
   * probeが撮ったcheckpointをrun eventへ耐久化する（ADR 0143の三段目・前段）。
   *
   * `finding_record`はcheckpointがactive epochのevent prefixから解決できることを要求する。
   * probeのcheckpointは他のcheckpointと同じくgitから読んだ実diffなので、findingの証拠に
   * そのまま使える。ただし**由来は印として残す**——これはexecutorの申告境界ではなく
   * supervisorが選んだ走行中の一点であり、receipt裁定のbinding基準に混ぜると、
   * probe後も書き続けた正当なreceiptがcheckpoint_mismatchで落ちる。
   * events.jsonは全体置換なので、lifecycle lockの内側でだけ触る。
   *
   * @returns {{ok: true, expected_epoch: number}|{ok: false, outcome: string, detail: string}}
   */
  const recordProbeCheckpointsUnlocked = async (escalation, checkpointsByTodo) => {
    try {
      const active = await readCommittedEpochStore(runDir);
      if (active === null) return { ok: false, outcome: 'skipped', detail: 'managed epochが未commit' };
      const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
      const state = projectRuntimeState({ events });
      // 既にfreeze済みなら、この警報が指す競合はもう止まっている。二重にholdを掛けない。
      if (state.freeze !== null) {
        return { ok: false, outcome: 'skipped', detail: 'runは既にfreeze済み' };
      }
      // 走り終わったTODOはcheckpoint findingが従来どおり捕まえる。早期警報の出番ではない。
      const running = new Set(state.running);
      if (!escalation.writers.every((todoId) => running.has(todoId))) {
        return { ok: false, outcome: 'skipped', detail: '観測したTODOが既にrunningでない' };
      }
      let next = events;
      for (const todoId of escalation.writers) {
        const checkpoint = checkpointsByTodo[todoId];
        if (next.some((event) => event.kind === 'checkpoint_observed'
          && event.payload?.checkpoint_digest === checkpoint.checkpoint_digest)) continue;
        next = [...next, buildNextRunEvent({ events: next, runId: request.request_id,
          kind: 'checkpoint_observed', planEpoch: active.pointer.plan_epoch,
          subject: { kind: 'todo', ref: todoId },
          payload: { ...structuredClone(checkpoint), observed_by: 'supervisor_probe' },
          recordedAt: canonicalNow() })];
      }
      if (next !== events) await replaceEventsAtomically(runDir, next);
      return { ok: true, expected_epoch: active.pointer.plan_epoch };
    } catch (error) {
      return { ok: false, outcome: 'rejected',
        detail: `probe checkpointを耐久化できない: ${error?.code ?? String(error?.message ?? error)}` };
    }
  };

  /** lifecycle lockを自分で取ってから耐久化する版（epoch駆動の外から呼ぶ時）。 */
  const durablyRecordProbeCheckpoints = async (escalation, checkpointsByTodo) => {
    let lock;
    try {
      lock = await acquireRuntimeLifecycleLock({ runDir,
        sessionNonceDigest: digestArtifact(sessionNonce), operation: 'finding_record',
        requestId: `${escalation.escalation_id}.checkpoint`,
        timeoutMs: IO_ESCALATION_LOCK_TIMEOUT_MS, retryIntervalMs: 25 });
    } catch (error) {
      return { ok: false, outcome: 'rejected',
        detail: `lifecycle lockを取れない: ${error?.code ?? 'RUN_BUSY'}` };
    }
    try {
      return await recordProbeCheckpointsUnlocked(escalation, checkpointsByTodo);
    } finally {
      await lock.release();
    }
  };

  /**
   * probeが実在と判定した警報を、既存のhold経路へ入れる（ADR 0143の三段目）。
   *
   * **新しい停止経路を作らない。** daemon自身が、hostが叩くのとまったく同じ
   * `finding_record`→`conflict`→`hold`をcontrol requestとして発行する。findingの再導出も、
   * epoch束縛も、durable evidenceの照合も、既存handlerがそのまま行う——早期警報が短くするのは
   * **気づくまでの時間**だけで、通す関門は1つも減らない。
   *
   * 途中で断られたらそこで止め、理由をjournalへ残す。静かに別経路へ逃げない。
   */
  const escalateIoWarning = async (warning, probed, packets, options = {}) => {
    // 耐久化と送信の経路だけを差し替える。判断そのものはどちらの文脈でも同一にする——
    // 分けると「epoch駆動の中と外で違う止め方をする」ことになり、記録が読めなくなる。
    const { recordCheckpoints = durablyRecordProbeCheckpoints, dispatchControl = null } = options;
    const built = buildIoEscalation({ warning, probe: probed,
      checkpointsByTodo: probed.checkpoints, packets });
    if (built === null) return null;
    const escalation = { ...built, escalation_id: `io-esc-${randomUUID()}` };
    const decide = async (outcome, detail, findingDigest = null) => {
      await appendControl({ run_id: request.request_id, kind: 'io_escalation_decided',
        session_nonce_digest: digestArtifact(sessionNonce), payload: {
          warning_digest: warningDigestOf(warning),
          anchor_todo_id: escalation.anchor_todo_id,
          checkpoint_digest: escalation.checkpoint_digest,
          finding_digest: findingDigest, outcome, detail,
        } });
      return { outcome, detail, finding_digest: findingDigest };
    };
    if (!attributionIsDistinct(warning, probed.roots)) {
      return decide('skipped',
        'worktree rootを共有する構成では書き手を特定できない（帰属はrootだけで決まる）');
    }
    const recorded = await recordCheckpoints(escalation, probed.checkpoints);
    if (!recorded.ok) return decide(recorded.outcome, recorded.detail);

    const submit = async (operation, { artifact = null, artifactDigest = null,
      checkpointDigest = null } = {}) => {
      const controlRequest = createRuntimeControlRequest({
        requestId: `${escalation.escalation_id}.${operation.replace(/_/gu, '-')}`,
        runId: request.request_id, operation, sessionNonce,
        payload: controlOperationPayload({ operation, runRef: request.request_id,
          artifact, artifactDigest, checkpointDigest,
          expectedEpoch: recorded.expected_epoch, expectedQueueDigest: null }),
      });
      return dispatchControl === null ? handler(controlRequest) : dispatchControl(controlRequest);
    };
    const unmetOf = (response) => (response?.result?.unmet ?? []).join('/')
      || String(response?.outcome ?? 'unknown');

    const findingResponse = await submit('finding_record', {
      // control operationが要求するのはartifact全体のdigestである。`candidate_digest`は
      // 自分の欄を除いた自己digestなので、そのまま渡すとbindingが合わず必ず弾かれる。
      artifact: escalation.candidate, artifactDigest: digestArtifact(escalation.candidate),
      checkpointDigest: escalation.checkpoint_digest,
    }).catch((error) => ({ outcome: 'rejected',
      result: { unmet: [String(error?.code ?? error?.message ?? error)] } }));
    const findingDigest = findingResponse?.result?.finding_digest ?? null;
    if (findingResponse?.outcome !== 'completed' || !/^[0-9a-f]{64}$/u.test(findingDigest ?? '')) {
      return decide('rejected', `finding_recordが通らない: ${unmetOf(findingResponse)}`);
    }

    const conflictResponse = await submit('conflict', { artifactDigest: findingDigest })
      .catch((error) => ({ outcome: 'rejected',
        result: { unmet: [String(error?.code ?? error?.message ?? error)] } }));
    if (conflictResponse?.outcome !== 'completed') {
      return decide('rejected', `conflictが通らない: ${unmetOf(conflictResponse)}`, findingDigest);
    }

    const holdResponse = await submit('hold').catch((error) => ({ outcome: 'rejected',
      result: { unmet: [String(error?.code ?? error?.message ?? error)] } }));
    if (holdResponse?.outcome !== 'completed') {
      return decide('rejected', `holdが通らない: ${unmetOf(holdResponse)}`, findingDigest);
    }
    return decide('held', `早期警報からhold: ${warning.kind}/${warning.path}`, findingDigest);
  };

  /**
   * epoch駆動中に届いた、実在確認済みの警報。
   *
   * **駆動中はここへ積むだけにする。** epoch駆動はrun eventsをメモリに抱えたままawaitを
   * またぎ、節目ごとに全体を置換する。その最中に横から追記すると、次の置換で消える——
   * 静かに記録を失う方向に壊れる。捌くのは駆動側の安全点（disk とメモリが一致している点）
   * であり、そこはworkerがまだ走っている最中なのでholdが成立する。
   */
  const pendingEscalations = [];
  let epochDriveActive = false;

  /**
   * 警報1件の全行程（probe → 記録 → escalation）。
   *
   * probeが`observed`でも、escalationは走らないことがある（既にfreeze済み、当該TODOが
   * 走り終わっている）。その差を`probe_outcome`で区別する——`escalated`はhold経路へ
   * 渡したことまでを言い、渡さなかったなら`observed`のまま残す。
   */
  const handleIoWarning = async (warning, packets) => {
    const probed = await probeWarning(warning).catch(() => (
      { outcome: 'unprobed', writers: [], checkpoints: {} }));
    if (probed.outcome === 'observed' && epochDriveActive) {
      pendingEscalations.push({ warning, probed, packets });
      await recordIoWarning(warning, 'observed');
      return;
    }
    const decided = probed.outcome === 'observed'
      ? await escalateIoWarning(warning, probed, packets).catch(() => null)
      : null;
    await recordIoWarning(warning,
      decided === null || decided.outcome === 'skipped' ? probed.outcome : 'escalated');
  };

  /**
   * epoch駆動の安全点でescalationを捌く（ADR 0143）。
   *
   * 呼ぶのは`replaceEventsAtomically`の直後だけとする。そこではdiskとメモリのeventsが
   * 一致しているので、control operationがdiskを読み書きしても駆動側の像とずれない。
   * 捌いた後はdiskを読み直して返す——`conflict`と`hold`はevents.jsonを書き換えるため。
   *
   * lifecycle lockは取らない。既に駆動側（activate）が握っている内側であり、ここで
   * 取り直すと自分自身を待つ。同じ理由で`handler`ではなく`executeControl`を直接使う。
   *
   * @returns {Promise<Array|null>} 捌いた結果のevents。何も捌かなければnull。
   */
  const drainPendingEscalations = async (events) => {
    if (pendingEscalations.length === 0) return null;
    let current = events;
    while (pendingEscalations.length > 0) {
      const { warning, probed, packets } = pendingEscalations.shift();
      const decided = await escalateIoWarning(warning, probed, packets, {
        recordCheckpoints: recordProbeCheckpointsUnlocked,
        dispatchControl: (controlRequest) => executeControl(controlRequest),
      }).catch((error) => ({ outcome: 'rejected',
        detail: String(error?.message ?? error), finding_digest: null }));
      if (decided === null) continue;
      current = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
      // holdが掛かったら、残りの警報は同じfreezeの下にある。二重にholdを試みない。
      if (projectRuntimeState({ events: current }).freeze !== null) break;
    }
    return current;
  };

  const escalateTerminalConflict = async ({ finding, checkpointDigest }) => {
    const activeEpoch = await readCommittedEpochStore(runDir);
    const resourceFinding = finding.kind === 'observed_line_change';
    const candidate = {
      schema: 'lattice.runtime_finding_candidate.v1',
      proposed_kind: finding.kind,
      todo_ids: [...finding.todo_ids].sort(),
      path: resourceFinding ? null : finding.path,
      resource_id: resourceFinding ? finding.resource_id : null,
      evidence_digests: [checkpointDigest],
      candidate_digest: '',
    };
    candidate.candidate_digest = selfDigest(candidate, 'candidate_digest');
    const submit = (operation, { artifact = null, artifactDigest = null,
      checkpoint = null } = {}) => executeControl(createRuntimeControlRequest({
      requestId: `terminal-${randomUUID()}-${operation.replace(/_/gu, '-')}`,
      runId: request.request_id, operation, sessionNonce,
      payload: controlOperationPayload({ operation, runRef: request.request_id,
        artifact, artifactDigest, checkpointDigest: checkpoint,
        expectedEpoch: activeEpoch.pointer.plan_epoch,
        expectedQueueDigest: null }),
    }));
    const recorded = await submit('finding_record', {
      artifact: candidate, artifactDigest: digestArtifact(candidate),
      checkpoint: checkpointDigest,
    });
    if (recorded.outcome !== 'completed') {
      throw new ManagedRuntimeError('FINDING_UNRESOLVED',
        'terminal findingを耐久化できない');
    }
    const findingDigest = recorded.result.finding_digest;
    const conflicted = await submit('conflict', { artifactDigest: findingDigest });
    if (conflicted.outcome !== 'completed') {
      throw new ManagedRuntimeError('FINDING_UNRESOLVED',
        'terminal findingをfreezeへ運べない');
    }
    const held = await submit('hold');
    if (held.outcome !== 'completed') {
      throw new ManagedRuntimeError('HOLD_ACKS_INCOMPLETE',
        'terminal conflictの対象barrierが完了しない');
    }
    return readBoundedJson(path.join(runDir, 'events.json'), 'run events');
  };

  /** 警報の処理を直列化する鎖。`onWarning`はここへ繋ぐだけにする。 */
  let escalationChain = Promise.resolve();

  const resolveObservationBinding = async ({ binding, ack }) => {
    // rebind経路はrunning bindingを持たず、ackだけで来る（`kind: 'rebind'`）。どちらから来ても
    // 同じdispatch記録へ辿り着けなければ、繋ぎ直す相手を特定できない。
    const todoId = binding?.todo_id ?? ack?.todo_id;
    const executorHandle = binding?.executor_handle ?? ack?.executor_handle;
    const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
    const dispatch = events.findLast((event) => event.kind === 'executor_dispatched'
      && event.subject?.kind === 'todo' && event.subject.ref === todoId
      && event.payload?.executor_handle === executorHandle);
    const observation = dispatch?.payload?.direct_os_observation_binding;
    if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new ManagedRuntimeError('HOLD_ACKS_INCOMPLETE', `durable Direct OS binding不足: ${todoId ?? 'unknown'}`);
    }
    return structuredClone(observation);
  };
  const resolveRunningBindings = async ({ runId }) => {
    const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
    const state = projectRuntimeState({ events });
    return state.running.map((todoId) => {
      const dispatch = events.findLast((event) => event.kind === 'executor_dispatched'
        && event.subject?.kind === 'todo' && event.subject.ref === todoId);
      const payload = dispatch?.payload ?? {};
      const binding = {
        todo_id: todoId, executor_handle: payload.executor_handle,
        worktree_id: payload.worktree_id, plan_epoch: dispatch?.plan_epoch,
        packet_digest: payload.packet_digest, write_lease_id: payload.write_lease_id,
        controller_registration_digest: recoveryRegistrationDigest
          ?? payload.controller_registration_digest,
      };
      if (Object.values(binding).some((value) => value === undefined)) {
        throw new ManagedRuntimeError('HOLD_ACKS_INCOMPLETE', `durable running binding不足: ${todoId}`);
      }
      return binding;
    });
  };

  const executeControl = async (controlRequest) => {
    if (controlRequest.run_id !== request.request_id || controlRequest.session_nonce !== sessionNonce) {
      throw new ManagedRuntimeError('RUN_NOT_MANAGED', 'daemon session binding不一致');
    }
    try {
      if (controlRequest.operation === 'activate') {
        if (activation !== null) throw new ManagedRuntimeError('RUN_BUSY', '既にactivate済み');
        if (restarting) {
          candidateDir = path.join(supervisorDir, 'restart-candidates', digestArtifact(sessionNonce));
          await mkdir(candidateDir, { recursive: true, mode: 0o700 });
          const priorActive = await resolveActiveRuntimePaths({ runDir });
          const priorControl = await readFile(priorActive.controlEventsPath).catch((error) => {
            if (error?.code === 'ENOENT') return Buffer.from('[]\n');
            throw error;
          });
          await durableReplaceBytes(candidateDir, 'control-events.json', priorControl);
          eventStore = createRuntimeControlStore({ runDir: candidateDir,
            runId: request.request_id, clock: canonicalNow });
        }
        activation = await activateController({ repoRoot, runId: request.request_id,
          adapterKind: legacyMeta.executor_adapter });
        const activationDelayMs = process.env.NODE_ENV === 'test'
          ? Number(process.env.LATTICE_INTERNAL_TEST_ACTIVATION_DELAY_MS ?? 0) : 0;
        if (Number.isSafeInteger(activationDelayMs) && activationDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, activationDelayMs));
        }
        if (process.env.NODE_ENV === 'test'
          && process.env.LATTICE_INTERNAL_TEST_CONTROLLER_COUNT === '2') {
          additionalActivations = [await activateController({ repoRoot, runId: request.request_id,
            adapterKind: legacyMeta.executor_adapter })];
        }
        if (restarting) recoveryRegistrationDigest = activation.registration.registration_digest;
        const activationControlDigest = await appendControl({ run_id: request.request_id,
          kind: 'supervisor_activated', session_nonce_digest: digestArtifact(sessionNonce),
          payload: activation.activationControlEvent.payload });
        if (restarting) {
          const recoveryEvents = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
          const runningTodos = projectRuntimeState({ events: recoveryEvents }).running;
          const oldRegistrations = [...new Set(runningTodos.map((todoId) => recoveryEvents.findLast((event) => (
            event.kind === 'executor_dispatched' && event.subject?.ref === todoId
          ))?.payload?.controller_registration_digest).filter(Boolean))].sort();
          await appendControl({ run_id: request.request_id, kind: 'controller_recovery_rebound',
            session_nonce_digest: digestArtifact(sessionNonce), payload: {
              old_registration_digests: oldRegistrations,
              new_registration_digest: activation.registration.registration_digest,
              running_todo_ids: [...runningTodos].sort(),
            } });
        }
        const controllerDir = path.join(runDir, 'controllers', activation.controllerDescriptor.controller_id);
        candidateControllerDir = controllerDir;
        await mkdir(controllerDir, { recursive: true, mode: 0o700 });
        await writeCanonicalJsonFile(path.join(controllerDir, 'descriptor.json'), activation.controllerDescriptor);
        await writeCanonicalJsonFile(path.join(controllerDir, 'registration.json'), activation.registration);
        for (const extra of additionalActivations) {
          const extraDir = path.join(runDir, 'controllers', extra.controllerDescriptor.controller_id);
          await mkdir(extraDir, { recursive: true, mode: 0o700 });
          await writeCanonicalJsonFile(path.join(extraDir, 'descriptor.json'), extra.controllerDescriptor);
          await writeCanonicalJsonFile(path.join(extraDir, 'registration.json'), extra.registration);
        }
        if (restarting) {
          await replaceCanonicalJsonAtomically(candidateDir, 'descriptor.json', activation.supervisorDescriptor);
          await durableReplaceBytes(candidateDir, 'session', Buffer.from(`${sessionNonce}\n`));
        } else {
          await writeCanonicalJsonFile(path.join(supervisorDir, 'descriptor.json'), activation.supervisorDescriptor);
          await durableReplaceBytes(supervisorDir, 'session', Buffer.from(`${sessionNonce}\n`));
        }
        gateWriter = createRuntimeGateStore({ runDir, runId: request.request_id,
          sessionNonceDigest: digestArtifact(sessionNonce),
          controlEventsPath: restarting ? path.join(candidateDir, 'control-events.json')
            : path.join(runDir, 'control-events.json') });
        const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        const committed = restarting
          ? await readCommittedEpochStore(runDir)
          : await activateEpochOneStore({ runDir, request, compileArtifact, legacyMeta,
            activationRunEventDigest: events.at(-1).event_digest,
            activationControlEventDigest: activationControlDigest });
        managedSupervisor = await activation.createManagedSupervisor({
          resolveObservationBinding, resolveRunningBindings,
          journal: { append: appendControl }, gateWriter,
        });
        for (const extra of additionalActivations) {
          await extra.registerWithManagedSupervisor(managedSupervisor);
        }
        if (!restarting && isHostDrivenEpochActivation(activation)) {
          sentinel = createRunSentinel({
            packets: committed.bundle.executor_packets,
            onWarning: (warning) => {
              // escalationはrun全体の状態（events.json・lifecycle lock・freeze）を触るので、
              // 警報が同時に何本飛んでも1本ずつ処理する。並べると、同じcheckpointを二重に
              // 積んだり、holdが掛かった後の警報でもう一度holdを試したりする。
              const settled = escalationChain.then(() => handleIoWarning(warning,
                committed.bundle.executor_packets));
              // 鎖自体は必ずresolvedへ戻す（1件の失敗で以後の警報を止めない）。
              // 失敗そのものは呼び出し側へ返す方を残し、握り潰さない。
              escalationChain = settled.catch(() => {});
              return settled;
            },
          });
          const reportDriverState = (waitingOn) => replaceRuntimeDriverState({
            runDir,
            runId: request.request_id,
            supervisorDescriptorRef: restarting
              ? `supervisor/restart-candidates/${path.basename(candidateDir)}/descriptor.json`
              : 'supervisor/descriptor.json',
            supervisorDescriptorDigest: activation.supervisorDescriptor.descriptor_digest,
            supervisorProcessStartIdentityDigest:
              activation.supervisorDescriptor.process_start_identity.identity_digest,
            driverState: 'driving',
            waitingOn,
            updatedAt: canonicalNow(),
          });
          epochDriveActive = true;
          try {
            await driveScriptedManagedEpoch({
              runDir,
              repoRoot,
              request,
              committed,
              activation,
              managedSupervisor,
              sentinel,
              initialEvents: events,
              controlEvents: () => controlEvents,
              preDispatchBindings,
              drainEscalations: drainPendingEscalations,
              escalateTerminalConflict,
              reportDriverState,
            });
          } finally {
            epochDriveActive = false;
            await replaceRuntimeDriverState({
              runDir,
              runId: request.request_id,
              supervisorDescriptorRef: restarting
                ? `supervisor/restart-candidates/${path.basename(candidateDir)}/descriptor.json`
                : 'supervisor/descriptor.json',
              supervisorDescriptorDigest: activation.supervisorDescriptor.descriptor_digest,
              supervisorProcessStartIdentityDigest:
                activation.supervisorDescriptor.process_start_identity.identity_digest,
              driverState: 'stopped',
              waitingOn: null,
              updatedAt: canonicalNow(),
            });
          }
        }
        if (restarting) {
          await managedSupervisor.recoveryBarrier({ barrierId: `recovery-${randomUUID()}`,
            frozenEventDigest: events.at(-1).event_digest });
          // recovery barrierのdurable receipt後、単一pointer renameをcommit pointにする。
          const candidateEvents = await eventStore.readEvents();
          const restartResult = buildControlResult({ operation: 'activate', outcome: 'activated',
            eventHeadDigest: events.at(-1).event_digest,
            controlHeadDigest: candidateEvents.at(-1).event_digest,
            activeEpoch: committed.pointer.plan_epoch });
          const restartResponse = buildControlResponse(controlRequest, 'completed', restartResult,
            candidateEvents.at(-1).event_digest);
          await replaceCanonicalJsonAtomically(candidateDir, 'activation-response.json', restartResponse);
          const activePointer = {
            schema: 'lattice.runtime_active_pointer.v1', run_id: request.request_id,
            candidate_ref: path.relative(runDir, candidateDir),
            activation_request_id: controlRequest.request_id,
            activation_request_digest: controlRequest.request_digest,
            activation_intent_digest: controlIntentDigest(controlRequest),
            activation_response_digest: restartResponse.response_digest,
            descriptor_digest: activation.supervisorDescriptor.descriptor_digest,
            session_nonce_digest: digestArtifact(sessionNonce),
            control_head_digest: candidateEvents.at(-1).event_digest,
            control_head_sequence: candidateEvents.at(-1).sequence,
            committed_at: canonicalNow(), pointer_digest: '',
          };
          activePointer.pointer_digest = selfDigest(activePointer, 'pointer_digest');
          await replaceCanonicalJsonAtomically(supervisorDir, 'active-runtime.json', activePointer);
          activationCommitted = true;
          if (typeof crashInjector === 'function') await crashInjector(
            'after_active_runtime_pointer_commit', { request_id: controlRequest.request_id,
              pointer_digest: activePointer.pointer_digest });
          return restartResponse;
        }
        if (!restarting) activationCommitted = true;
        const result = buildControlResult({ operation: 'activate', outcome: 'activated',
          eventHeadDigest: events.at(-1).event_digest, controlHeadDigest: controlEvents.at(-1).event_digest,
          activeEpoch: committed.pointer.plan_epoch });
        return buildControlResponse(controlRequest, 'completed', result, controlEvents.at(-1).event_digest);
      }
      if (managedSupervisor === null) throw new ManagedRuntimeError('RUN_NOT_MANAGED', 'activate未完了');
      if (controlRequest.operation === 'finding_record') {
        const candidate = controlRequest.payload.artifact;
        if (!validateRuntimeFindingCandidate(candidate)
          || digestArtifact(candidate) !== controlRequest.payload.artifact_digest) {
          throw new ManagedRuntimeError('FINDING_UNRESOLVED', 'finding candidate/digest binding不正');
        }
        const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        const active = await readCommittedEpochStore(runDir);
        const checkpointDigest = controlRequest.payload.checkpoint_digest;
        const observed = events.findLast((event) => event.plan_epoch === controlRequest.payload.expected_epoch
          && event.payload?.checkpoint_digest === checkpointDigest);
        if (observed === undefined) {
          if (events.some((event) => event.payload?.checkpoint_digest === checkpointDigest)) {
            throw new ManagedRuntimeError('STALE_FINDING', 'checkpointは旧epochに属する');
          }
          throw new ManagedRuntimeError('FINDING_UNRESOLVED', '保存checkpointをactive event prefixから解決できない');
        }
        const activeRequestV1 = active.bundle.request.schema === 'lattice.run_request.v1'
          ? structuredClone(active.bundle.request) : {
            schema: 'lattice.run_request.v1', request_id: active.bundle.request.request_id,
            repo: active.bundle.request.repo, capacity: active.bundle.request.capacity,
            todos: active.bundle.request.todos, manual_witness: active.bundle.request.manual_witness,
            sensor_query_set: active.bundle.request.sensor_query_set,
            executor_capability: active.bundle.request.executor_capability,
            claim_mode: active.bundle.request.claim_mode, request_digest: '',
          };
        activeRequestV1.request_digest = selfDigest(activeRequestV1, 'request_digest');
        const fresh = await compileFromRepo({ request: activeRequestV1, cwd: repoRoot,
          planRef: active.bundle.plan.plan_ref, planEpoch: active.pointer.plan_epoch,
          predecessorRefs: active.bundle.plan.predecessor_refs });
        if (fresh.outcome !== 'dispatchable'
          || canonicalizeArtifact(fresh.manifests) !== canonicalizeArtifact(active.bundle.manifests)
          || canonicalizeArtifact(fresh.plan.nodes.map(({ todo_id: id }) => id))
            !== canonicalizeArtifact(active.bundle.plan.nodes.map(({ todo_id: id }) => id))) {
          throw new ManagedRuntimeError('STALE_FINDING', 'current compile/sensorがactive epochから変化した');
        }
        const checkpointEntries = Array.isArray(observed.payload?.diff?.entries)
          ? observed.payload.diff.entries : [];
        const durableEvidence = new Set([checkpointDigest, observed.event_digest]);
        for (const entry of checkpointEntries) {
          if (/^[0-9a-f]{64}$/u.test(entry?.content_digest ?? '')) durableEvidence.add(entry.content_digest);
        }
        for (const manifest of Object.values(fresh.manifests)) {
          for (const graph of manifest.graph_evidence) {
            if (/^[0-9a-f]{64}$/u.test(graph?.result_digest ?? '')) durableEvidence.add(graph.result_digest);
          }
        }
        let derivedTodoIds;
        let derivedKind;
        const observationSet = events.filter((event) => event.plan_epoch === active.pointer.plan_epoch
          && event.kind === 'checkpoint_observed' && Array.isArray(event.payload?.diff?.entries)
          && event.subject?.kind === 'todo').map((event) => ({ todo_id: event.subject.ref,
          paths: event.payload.diff.entries.map((entry) => entry.path) }));
        const independentlyClassified = classifyObservedDiff({ plan: active.bundle.plan,
          manifests: fresh.manifests, observations: observationSet }).findings;
        if (candidate.path !== null) {
          const producer = detectCheckpointFindings({ todoId: observed.subject.ref,
            checkpoint: observed.payload, packets: active.bundle.executor_packets,
            manifests: fresh.manifests,
            runningTodoIds: projectRuntimeState({ events }).running }).findings;
          const match = producer.find((findingValue) => findingValue.kind === candidate.proposed_kind
            && findingValue.path === candidate.path
            && canonicalizeArtifact(findingValue.todo_ids) === canonicalizeArtifact(candidate.todo_ids));
          const verified = independentlyClassified.find((findingValue) => findingValue.kind === candidate.proposed_kind
            && findingValue.path === candidate.path
            && canonicalizeArtifact(findingValue.todo_ids) === canonicalizeArtifact(candidate.todo_ids));
          const terminalSupervisorObservation = observed.payload?.observed_by === 'supervisor_terminal';
          if ((!terminalSupervisorObservation && match === undefined) || verified === undefined) throw new ManagedRuntimeError(
            'FINDING_UNRESOLVED', 'path findingのproducer/verifier再導出が一致しない');
          derivedTodoIds = [...(match ?? verified).todo_ids];
          derivedKind = (match ?? verified).kind;
        } else {
          const match = independentlyClassified.find((findingValue) => findingValue.kind === candidate.proposed_kind
            && findingValue.resource_id === candidate.resource_id
            && canonicalizeArtifact(findingValue.todo_ids) === canonicalizeArtifact(candidate.todo_ids));
          if (match === undefined) throw new ManagedRuntimeError('FINDING_UNRESOLVED',
            'resource findingをindependent checkpoint classifierから再導出できない');
          derivedTodoIds = [...match.todo_ids];
          derivedKind = match.kind;
        }
        if (derivedTodoIds.length === 0
          || derivedKind !== candidate.proposed_kind
          || canonicalizeArtifact(derivedTodoIds) !== canonicalizeArtifact(candidate.todo_ids)) {
          throw new ManagedRuntimeError('FINDING_UNRESOLVED', 'candidate todo集合をcheckpoint/current manifestsから再導出できない');
        }
        if (!candidate.evidence_digests.every((digest) => durableEvidence.has(digest))) {
          throw new ManagedRuntimeError('FINDING_UNRESOLVED', 'candidate evidenceをdurable checkpoint/sensor artifactへ解決できない');
        }
        const observer = { schema: 'lattice.runtime_observer_identity.v1', kind: 'supervisor',
          controller_registration_digest: activation.registration.registration_digest,
          executor_handle: null, identity_digest: '' };
        observer.identity_digest = selfDigest(observer, 'identity_digest');
        const finding = await recordRuntimeFinding({ runDir, candidate, checkpointDigest,
          observedEventDigest: observed.event_digest, recordedBy: observer,
          // producerとは別のcallbackでも同一active bundle/checkpoint bindingを再検査する。
          deriveFinding: (_untrusted, evidence) => {
            return { schema: 'lattice.runtime_conflict_finding.v1',
              kind: derivedKind, todo_ids: derivedTodoIds,
              path: candidate.path, resource_id: candidate.resource_id,
              evidence_digests: [...new Set([checkpointDigest,
                ...candidate.evidence_digests])].sort(), finding_digest: '' };
          },
          verifyFinding: (derived, evidence) => derived.kind === candidate.proposed_kind
            && derived.finding_digest === selfDigest(derived, 'finding_digest')
            && evidence.checkpoint.event_digest === observed.event_digest
            && canonicalizeArtifact(evidence.bundle.manifests)
              === canonicalizeArtifact(fresh.manifests)
            && derived.todo_ids.every((id) => Object.hasOwn(fresh.manifests, id)) });
        if (projectRuntimeState({ events }).freeze !== null) {
          let queue = await readBoundedJson(path.join(runDir, 'queued-events.json'),
            'runtime queue').catch((error) => {
            if (error instanceof CliContractError && error.code === 'INPUT_UNREADABLE') return null;
            throw error;
          });
          if (queue === null) queue = { schema: 'lattice.runtime_queue.v1',
            run_id: request.request_id, frozen_epoch: controlRequest.payload.expected_epoch,
            entries: [], queue_digest: '' };
          else if (!validateRuntimeQueue(queue, request.request_id,
            controlRequest.payload.expected_epoch)) {
            throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED', 'finding queue binding不正');
          }
          queue.entries.push({ sequence: queue.entries.length + 1, kind: 'finding',
            subject_digest: candidate.candidate_digest,
            artifact_digest: finding.finding_digest });
          queue.queue_digest = selfDigest(queue, 'queue_digest');
          await replaceCanonicalJsonAtomically(runDir, 'queued-events.json', queue);
        }
        const result = buildControlResult({ operation: 'finding_record', outcome: 'recorded',
          eventHeadDigest: events.at(-1).event_digest,
          controlHeadDigest: controlEvents.at(-1).event_digest,
          activeEpoch: controlRequest.payload.expected_epoch,
          stagedEpoch: null });
        result.finding_digest = finding.finding_digest;
        const unsigned = { ...result }; delete unsigned.result_digest;
        result.result_digest = digestArtifact(unsigned);
        return buildControlResponse(controlRequest, 'completed', result,
          controlEvents.at(-1).event_digest);
      }
      if (controlRequest.operation === 'conflict') {
        const findingDigest = controlRequest.payload.artifact_digest;
        const finding = await readBoundedJson(path.join(runDir, 'findings', `${findingDigest}.json`), 'runtime finding');
        const active = await readCommittedEpochStore(runDir);
        if (!validateRuntimeFindingRecord(finding)
          || finding.finding_digest !== findingDigest
          || finding.run_id !== request.request_id) {
          throw new ManagedRuntimeError('FINDING_UNRESOLVED', 'finding binding不正');
        }
        if (finding.plan_epoch !== active.pointer.plan_epoch) {
          throw new ManagedRuntimeError('STALE_FINDING', 'findingはactive epochに属さない');
        }
        // 競合は2者以上いて初めて競合である。1者しか名指していない観測——誰の領分とも
        // 重なっていない予測超過——でfreezeすると、抜け道が無い。処置は2つとも2者を要求する
        // （直列化は`todo_ids.length >= 2`、seam変換は2つの面へ切る）ので、legalなrecompileが
        // 作れないまま止まる。予測が狭かっただけなので、記録して次のcompileで宣言を実態へ
        // 合わせるのが正しい応答である。
        if ((finding.finding?.todo_ids ?? []).length < 2) {
          throw new ManagedRuntimeError('FINDING_NOT_A_CONFLICT',
            '1 TODOしか名指していない観測はfreezeへ運べない。'
            + '予測超過は競合ではないので、記録のまま次のcompileで宣言を観測へ合わせる', {
              finding_kind: finding.finding?.kind ?? null,
              todo_ids: [...(finding.finding?.todo_ids ?? [])],
            });
        }
        let events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        const todoId = finding.finding?.todo_ids?.[0] ?? active.bundle.plan.nodes[0].todo_id;
        events.push(buildNextRunEvent({ events, runId: request.request_id, kind: 'conflict_found', planEpoch: active.pointer.plan_epoch,
          subject: { kind: 'todo', ref: todoId }, payload: {
            ...finding.finding, finding_digest: findingDigest, reported_by: 'lattice-supervisor',
          }, recordedAt: canonicalNow() }));
        events.push(buildNextRunEvent({ events, runId: request.request_id, kind: 'intake_frozen', planEpoch: active.pointer.plan_epoch,
          subject: { kind: 'runtime_plan', ref: active.bundle.plan.plan_ref },
          payload: { frozen_prefix_digest: digestArtifact(events.map(({ event_digest: value }) => value)), reason_kind: finding.finding.kind }, recordedAt: canonicalNow() }));
        await replaceEventsAtomically(runDir, events);
        const result = buildControlResult({ operation: 'conflict', outcome: 'frozen',
          eventHeadDigest: events.at(-1).event_digest, controlHeadDigest: controlEvents.at(-1).event_digest,
          activeEpoch: active.pointer.plan_epoch });
        return buildControlResponse(controlRequest, 'completed', result, controlEvents.at(-1).event_digest);
      }
      if (controlRequest.operation === 'hold') {
        let events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        const conflict = events.findLast((event) => event.kind === 'conflict_found');
        if (!conflict) throw new ManagedRuntimeError('FINDING_UNRESOLVED', '保存済みconflictなし');
        const active = await readCommittedEpochStore(runDir);
        const holdTodoIds = affectedTodoIds(active.bundle.plan, active.bundle.manifests,
          conflict.payload.todo_ids);
        const holdBarrierId = `barrier-${randomUUID()}`;
        const holdRecordedAt = canonicalNow();
        await appendControl({ run_id: request.request_id, kind: 'hold_prepared',
          session_nonce_digest: digestArtifact(sessionNonce), payload: {
            request_id: controlRequest.request_id,
            logical_intent_digest: controlIntentDigest(controlRequest),
            finding_digest: conflict.payload.finding_digest,
            barrier_id: holdBarrierId, recorded_at: holdRecordedAt,
          } });
        const held = await managedSupervisor.holdConflict({
          findingDigest: conflict.payload.finding_digest, frozenEventDigest: events.at(-1).event_digest,
          barrierId: holdBarrierId, reason: conflict.payload.kind,
          recordedAt: holdRecordedAt, todoIds: holdTodoIds,
        });
        controlEvents = await eventStore.readEvents();
        const quiesced = controlEvents.filter((event) => event.kind === 'executor_quiesced'
          && held.quiescence_ack_digests.includes(event.payload?.ack?.ack_digest));
        for (const evidence of quiesced) {
          const checkpoint = evidence.payload.direct_observation.checkpoint;
          events.push(buildNextRunEvent({ events, runId: request.request_id,
            kind: 'checkpoint_observed', planEpoch: controlRequest.payload.expected_epoch,
            subject: { kind: 'todo', ref: evidence.payload.todo_id },
            payload: { ...structuredClone(checkpoint), barrier_final: true,
              barrier_evidence_digest: evidence.payload.evidence_digest },
            recordedAt: holdRecordedAt }));
        }
        const decided = decideHoldAndCarryOver({ runId: request.request_id,
          request: active.bundle.request, plan: active.bundle.plan,
          manifests: active.bundle.manifests, packets: active.bundle.executor_packets,
          events, recordedAt: holdRecordedAt });
        events = decided.events;
        await replaceEventsAtomically(runDir, events);
        if (typeof crashInjector === 'function') await crashInjector('after_hold_effect', {
          request_id: controlRequest.request_id, hold_result_digest: held.result_digest,
        });
        await replaceNamedJsonAtomically(runDir, 'hold-result.json', held);
        const operationReceipt = {
          schema: 'lattice.runtime_control_operation_receipt.v1',
          request_id: controlRequest.request_id,
          logical_intent_digest: controlIntentDigest(controlRequest),
          operation: 'hold', outcome: 'held', effect_digest: held.result_digest,
          receipt_digest: '',
        };
        operationReceipt.receipt_digest = selfDigest(operationReceipt, 'receipt_digest');
        await replaceCanonicalJsonAtomically(runDir, 'hold-operation-receipt.json', operationReceipt);
        const result = buildControlResult({ operation: 'hold', outcome: 'held',
          eventHeadDigest: events.at(-1).event_digest, controlHeadDigest: controlEvents.at(-1).event_digest,
          activeEpoch: 1 });
        return buildControlResponse(controlRequest, 'completed', result, controlEvents.at(-1).event_digest);
      }
      if (controlRequest.operation === 'recompile') {
        const recompileRequest = controlRequest.payload.artifact;
        if (digestArtifact(recompileRequest) !== controlRequest.payload.artifact_digest) {
          throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST', 'recompile artifact digest不一致');
        }
        const active = await readCommittedEpochStore(runDir);
        let events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        const freeze = events.findLast((event) => event.kind === 'intake_frozen');
        const holdEvent = events.findLast((event) => event.kind === 'hold_decided'
          && event.plan_epoch === active.pointer.plan_epoch);
        if (freeze === undefined || holdEvent === undefined
          || !validateRuntimeRecompileRequest(recompileRequest, {
            predecessorBundle: active.bundle, frozenEventDigest: freeze.event_digest,
            holdDecisionDigest: holdEvent.payload?.decision_digest, validatePhaseRevision,
          })) throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST', 'frozen/hold/successor binding不正');

        // front-endはv1入力を再利用するが、successor identityはv2 digestへ再封印する。
        const successorV1 = { schema: 'lattice.run_request.v1',
          request_id: recompileRequest.successor_request.request_id,
          repo: recompileRequest.successor_request.repo,
          capacity: recompileRequest.successor_request.capacity,
          todos: recompileRequest.successor_request.todos,
          manual_witness: recompileRequest.successor_request.manual_witness,
          sensor_query_set: recompileRequest.successor_request.sensor_query_set,
          executor_capability: recompileRequest.successor_request.executor_capability,
          claim_mode: recompileRequest.successor_request.claim_mode, request_digest: '' };
        successorV1.request_digest = selfDigest(successorV1, 'request_digest');
        const nextEpoch = active.pointer.plan_epoch + 1;
        const compiled = await compileFromRepo({ request: successorV1, cwd: repoRoot,
          planRef: `plan-${recompileRequest.run_id}-e${nextEpoch}`, planEpoch: nextEpoch,
          predecessorRefs: [active.bundle.plan.plan_ref] });
        if (compiled.outcome !== 'dispatchable') {
          throw new ManagedRuntimeError(compiled.code ?? 'SEAM_SPLIT_UNPROVEN', 'successor compileがdispatchableでない');
        }
        const newPlan = structuredClone(compiled.plan);
        newPlan.request_digest = recompileRequest.successor_request.request_digest;
        if (recompileRequest.mode === 'intentional_serial') {
          const serial = recompileRequest.intentional_serial;
          const key = `${serial.todo_ids.join('\0')}\0${serial.resource_id}`;
          const exists = newPlan.conflicts.some((entry) => `${entry.todo_ids.join('\0')}\0${entry.resource_id}` === key);
          if (!exists) newPlan.conflicts.push({ todo_ids: [...serial.todo_ids], resource_id: serial.resource_id });
          newPlan.conflicts.sort((left, right) => `${left.todo_ids.join('\0')}\0${left.resource_id}`
            .localeCompare(`${right.todo_ids.join('\0')}\0${right.resource_id}`));
        }
        if (recompileRequest.mode === 'seam_split') {
          // 変換を含まないbaseを指したseam_splitを通さない（ADR 0141）。splitが新しい面の
          // 所有を宣言するのに後継treeにそのfileが無い、という状態を作らせない。
          const predecessorBaseSha = active.bundle.request.repo.base_sha;
          const successorBaseSha = recompileRequest.successor_request.repo.base_sha;
          const ancestry = await runGit(
            ['merge-base', '--is-ancestor', predecessorBaseSha, successorBaseSha], repoRoot,
          );
          const verdict = verifySeamSplitSuccessor({
            split: recompileRequest.seam_split,
            predecessorBaseSha,
            successorBaseSha,
            successorIsDescendant: ancestry.code === 0,
            successorConflicts: newPlan.conflicts,
            successorWitness: recompileRequest.successor_request.manual_witness,
          });
          if (!verdict.ok) {
            throw new ManagedRuntimeError('SEAM_SPLIT_UNPROVEN',
              `後継baseがseam splitの主張を満たさない: ${verdict.reasons.join(', ')}`);
          }
        }
        newPlan.plan_digest = selfDigest(newPlan, 'plan_digest');
        const executorPackets = buildExecutorPackets({ plan: newPlan, manifests: compiled.manifests });

        // 既存pure coreからcontext invalidationとcarry rebind packetだけを再利用する。
        const predecessorRequest = active.bundle.request.schema === 'lattice.run_request.v1'
          ? active.bundle.request : { ...active.bundle.request, schema: 'lattice.run_request.v1' };
        delete predecessorRequest.predecessor_request_digest;
        delete predecessorRequest.task_migration_digest;
        predecessorRequest.request_digest = selfDigest(predecessorRequest, 'request_digest');
        const corePlan = active.bundle.request.schema === 'lattice.run_request.v1'
          ? active.bundle.plan : { ...active.bundle.plan, request_digest: predecessorRequest.request_digest };
        corePlan.plan_digest = selfDigest(corePlan, 'plan_digest');
        const predecessorEvents = events;
        // event batch receiptより先に、outer reprocessが同じrecompile transactionを
        // 再構成できるbindingをdurable化する。
        const priorPending = await readBoundedJson(path.join(runDir, 'pending-recompile.json'),
          'pending recompile').catch(() => null);
        const pendingRecompile = {
          schema: 'lattice.runtime_pending_recompile.v1',
          control_request_id: controlRequest.request_id,
          reprocess_request_id: priorPending?.reprocess_request_id ?? null,
          reprocess_queue_digest: priorPending?.reprocess_queue_digest ?? null,
          recovery_response_outcome: priorPending?.recovery_response_outcome ?? null,
          recompile_request: structuredClone(recompileRequest),
          predecessor_epoch: active.pointer.plan_epoch,
          frozen_event_digest: freeze.event_digest,
          hold_decision_digest: holdEvent.payload.decision_digest,
          pending_digest: '',
        };
        pendingRecompile.pending_digest = selfDigest(pendingRecompile, 'pending_digest');
        await replaceCanonicalJsonAtomically(runDir, 'pending-recompile.json', pendingRecompile);
        const core = recompileNextEpochPlan({ runId: active.meta.run_id,
          request: predecessorRequest, plan: corePlan, manifests: active.bundle.manifests,
          packets: active.bundle.executor_packets, events, holdDecision: holdEvent.payload,
          additionalConflicts: recompileRequest.mode === 'intentional_serial'
            ? [{ todo_ids: recompileRequest.intentional_serial.todo_ids,
              resource_id: recompileRequest.intentional_serial.resource_id }] : [],
          recordedAt: canonicalNow() });
        const proposedCoreBatch = [];
        let proposedCoreEvents = [...predecessorEvents];
        for (const proposed of core.events.slice(predecessorEvents.length)) {
          const payload = proposed.kind === 'plan_recompiled'
            ? { ...proposed.payload, new_plan_digest: newPlan.plan_digest }
            : proposed.payload;
          const event = buildNextRunEvent({ events: proposedCoreEvents, runId: active.meta.run_id,
            kind: proposed.kind, planEpoch: proposed.plan_epoch,
            subject: proposed.kind === 'plan_recompiled'
              ? { kind: 'runtime_plan', ref: newPlan.plan_ref } : proposed.subject,
            payload, recordedAt: proposed.recorded_at });
          proposedCoreEvents.push(event);
          proposedCoreBatch.push(event);
        }
        events = [...predecessorEvents];
        const planDiff = { ...core.planDiff, new_plan_ref: newPlan.plan_ref };
        planDiff.diff_digest = selfDigest(planDiff, 'diff_digest');
        const rebindPackets = Object.fromEntries(Object.entries(core.rebindPackets)
          .filter(([todoId]) => Object.hasOwn(executorPackets, todoId)));
        const bundleBody = { schema: 'lattice.runtime_epoch_bundle.v1', run_id: active.meta.run_id,
          plan_epoch: nextEpoch, request: recompileRequest.successor_request, plan: newPlan,
          manifests: compiled.manifests, executor_packets: executorPackets,
          rebind_packets: rebindPackets, plan_diff: planDiff,
          task_migration: recompileRequest.task_migration,
          treatment: recompileRequest.mode === 'seam_split'
            ? recompileRequest.seam_split : recompileRequest.intentional_serial,
          phase_revision_digest: null, phase_revision_commit_receipt: null,
          predecessor_bundle_digest: active.bundle.bundle_digest };
        bundleBody.bundle_digest = digestArtifact(bundleBody);
        const treatment = recompileRequest.mode === 'seam_split'
          ? recompileRequest.seam_split : recompileRequest.intentional_serial;
        const treatmentFinding = await readBoundedJson(path.join(runDir, 'findings',
          `${treatment.finding_digest}.json`), 'runtime finding');
        if (!validateRuntimeFindingRecord(treatmentFinding)
          || treatmentFinding.run_id !== active.meta.run_id
          || treatmentFinding.plan_epoch !== active.pointer.plan_epoch
          || treatmentFinding.finding_digest !== treatment.finding_digest) {
          throw new ManagedRuntimeError(treatmentFinding?.plan_epoch !== active.pointer.plan_epoch
            ? 'STALE_FINDING' : 'FINDING_UNRESOLVED', 'treatment findingがactive epochへbindしない');
        }
        if (treatment.finding_digest !== holdEvent.payload?.finding?.finding_digest
          || canonicalizeArtifact(treatmentFinding.finding.todo_ids)
            !== canonicalizeArtifact(treatment.todo_ids ?? treatment.predecessor_task_ids)) {
          throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST', 'treatmentがhold finding/todo集合と一致しない');
        }
        if (recompileRequest.mode === 'intentional_serial') {
          // **path競合には資源idが無い。** finding契約はpath形の`resource_id`をnullと定めており、
          // path由来の資源idはmanifestの`resources`にも載らない（載るのは宣言したbare資源だけ）。
          // それでもrouteConflictTreatmentはpath競合を直列化レーンへ振る——請求項7の
          // 「一方を停止し、他方を確定し、停止した方を再開する」がその経路だからである。
          //
          // よってpath findingの時は、係争pathからfront-endと同じ形で資源idを導出して照合する。
          // 導出値との一致を要求するので、資源idを捏造できないという元の保証は保たれる
          // ——照合先がfindingそのものへ固定されるため、manifest所属を見る必要が無い。
          const expectedResource = treatmentFinding.finding.path === null
            ? treatmentFinding.finding.resource_id
            : ownedPathResourceId(treatmentFinding.finding.path);
          if (expectedResource !== treatment.resource_id) {
            throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST', 'serial resourceがfinding resourceと一致しない');
          }
          // 宣言済み資源の競合は、従来どおり実ownershipから再導出できることまで要求する。
          if (treatmentFinding.finding.path === null
            && !treatment.todo_ids.every((todoId) => {
              const manifest = active.bundle.manifests[todoId];
              return manifest?.resources?.includes(treatment.resource_id)
                || manifest?.state_effects?.some((effect) => effect.resource_id === treatment.resource_id);
            })) {
            throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST', 'serial resourceをfresh ownershipから再導出できない');
          }
        }
        if (recompileRequest.mode === 'seam_split') {
          // **宣言された面の所有も数える。** `resources`／`state_effects`だけを見ていた間、
          // path所有はbefore/afterのどちらにも現れず、seam splitが述べる`added`は常に空の
          // 導出値と突き合わされていた——path競合を切るsplitは原理的に一致しなかった。
          // 資源idの合成形は`verifySeamSplitSuccessor`と同じ`own-<kind>-<sha16>`にする。
          const ownership = (manifests) => Object.entries(manifests).flatMap(([todoId, manifest]) => [
            ...(manifest.owns ?? []).map((own) => ({
              resource_id: ownedResourceId(own.kind, own.target),
              owner_todo_id: todoId, access_kind: 'own' })),
            ...manifest.resources.map((resourceId) => ({ resource_id: resourceId,
              owner_todo_id: todoId, access_kind: 'own' })),
            ...manifest.state_effects.map((effect) => ({ resource_id: effect.resource_id,
              owner_todo_id: todoId, access_kind: 'write' })),
          ]).sort((left, right) => canonicalizeArtifact(left).localeCompare(canonicalizeArtifact(right)));
          const edges = (planValue) => [
            ...planValue.precedence.map((edge) => ({ from_todo_id: edge.from_todo_id,
              to_todo_id: edge.to_todo_id, kind: 'hard_dependency' })),
            ...planValue.conflicts.map((edge) => ({ from_todo_id: edge.todo_ids[0],
              to_todo_id: edge.todo_ids[1], kind: 'conflict' })),
          ].sort((left, right) => canonicalizeArtifact(left).localeCompare(canonicalizeArtifact(right)));
          const difference = (left, right) => left.filter((entry) => !right.some((other) =>
            canonicalizeArtifact(entry) === canonicalizeArtifact(other)));
          // **比較の起点は、観測へ合わせた後の宣言である。**
          //
          // 実行時に見つかった競合は、片方がその資源を所有していないから起きる。変換はその
          // 宣言を観測へ合わせてから導出されるので（翻訳段）、splitが述べる遷移も合わせた後の
          // 状態からのものになる。ここで記録のままのpredecessorと比べると、実行時に見つかった
          // 競合から作ったsplitは永久に一致しない——請求項8が実行時に届かなくなる。
          //
          // 合わせる材料はfindingそのものであり、宣言でも入力でもない。再導出なので、
          // 呼び出し側が何を主張しても結果は変わらない。
          const contestedResource = treatmentFinding.finding.path === null
            ? treatmentFinding.finding.resource_id
            : ownedPathResourceId(treatmentFinding.finding.path);
          const observedTodoIds = [...treatmentFinding.finding.todo_ids].sort();
          const reconciledOwnership = [...ownership(active.bundle.manifests)];
          for (const todoId of observedTodoIds) {
            const entry = { resource_id: contestedResource, owner_todo_id: todoId, access_kind: 'own' };
            if (!reconciledOwnership.some((other) => canonicalizeArtifact(other) === canonicalizeArtifact(entry))) {
              reconciledOwnership.push(entry);
            }
          }
          const reconciledEdges = [...edges(active.bundle.plan)];
          for (let left = 0; left < observedTodoIds.length; left += 1) {
            for (let right = left + 1; right < observedTodoIds.length; right += 1) {
              const edge = { from_todo_id: observedTodoIds[left], to_todo_id: observedTodoIds[right],
                kind: 'conflict' };
              if (!reconciledEdges.some((other) => canonicalizeArtifact(other) === canonicalizeArtifact(edge))) {
                reconciledEdges.push(edge);
              }
            }
          }
          const sortEntries = (entries) => [...entries]
            .sort((left, right) => canonicalizeArtifact(left).localeCompare(canonicalizeArtifact(right)));
          const beforeOwnership = sortEntries(reconciledOwnership);
          const afterOwnership = ownership(compiled.manifests);
          const beforeEdges = sortEntries(reconciledEdges);
          const afterEdges = edges(newPlan);
          const derivedOwnership = { added: difference(afterOwnership, beforeOwnership),
            removed: difference(beforeOwnership, afterOwnership) };
          const derivedEdges = { added: difference(afterEdges, beforeEdges),
            removed: difference(beforeEdges, afterEdges) };
          if (canonicalizeArtifact(derivedOwnership.added)
              !== canonicalizeArtifact(treatment.ownership_diff.added)
            || canonicalizeArtifact(derivedOwnership.removed)
              !== canonicalizeArtifact(treatment.ownership_diff.removed)
            || canonicalizeArtifact(derivedEdges.added)
              !== canonicalizeArtifact(treatment.edge_diff.added)
            || canonicalizeArtifact(derivedEdges.removed)
              !== canonicalizeArtifact(treatment.edge_diff.removed)) {
            throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST',
              'seam ownership/edge diffをfresh predecessor/successorから再導出できない');
          }
          const findingPath = treatmentFinding.finding.path;
          if (findingPath !== null) {
            const coversPath = (manifest) => manifest.writes.some((declared) =>
              declared === findingPath || (declared.endsWith('/') && findingPath.startsWith(declared)));
            const overlappingBefore = Object.values(active.bundle.manifests)
              .filter(coversPath).length;
            const overlappingAfter = Object.values(compiled.manifests)
              .filter(coversPath).length;
            if (overlappingAfter > 1) {
              throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST',
                'seam successorでfinding pathがsingle ownerへ収束していない');
            }
          } else {
            const findingResource = treatmentFinding.finding.resource_id;
            const resourceOwners = (manifests) => Object.values(manifests).filter((manifest) =>
              manifest.resources.includes(findingResource)
              || manifest.state_effects.some((effect) => effect.resource_id === findingResource)).length;
            if (resourceOwners(compiled.manifests) > 1) {
              throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST',
                'seam successorでresourceがsingle ownerへ収束していない');
            }
          }
          const findingConflictResource = treatmentFinding.finding.resource_id ?? treatmentFinding.finding.path;
          if (newPlan.conflicts.some((conflict) => conflict.resource_id === findingConflictResource
            && treatmentFinding.finding.todo_ids.every((todoId) => conflict.todo_ids.includes(todoId)))) {
            throw new ManagedRuntimeError('INVALID_RECOMPILE_REQUEST',
              'seam successorにfinding conflict edgeが残存している');
          }
        }
        const validateCompiledSuccessor = (candidate, context) => validateRuntimeEpochBundle(candidate)
          && candidate.predecessor_bundle_digest === context.predecessor.bundle_digest
          && candidate.plan_epoch === context.pointer.plan_epoch + 1
          && candidate.request.request_digest === recompileRequest.successor_request.request_digest
          && candidate.task_migration.migration_digest === recompileRequest.task_migration.migration_digest
          && canonicalizeArtifact(candidate.treatment) === canonicalizeArtifact(treatment)
          && canonicalizeArtifact(candidate.plan) === canonicalizeArtifact(newPlan)
          && canonicalizeArtifact(candidate.manifests) === canonicalizeArtifact(compiled.manifests)
          && canonicalizeArtifact(candidate.executor_packets) === canonicalizeArtifact(executorPackets)
          && (recompileRequest.mode !== 'intentional_serial'
            || candidate.plan.conflicts.some((entry) => canonicalizeArtifact(entry.todo_ids)
              === canonicalizeArtifact(recompileRequest.intentional_serial.todo_ids)
              && entry.resource_id === recompileRequest.intentional_serial.resource_id));
        const staged = await stageSuccessorEpoch({ runDir,
          transactionId: recompileRequest.request_id, bundle: bundleBody, recompileRequest,
          validateSuccessor: validateCompiledSuccessor, validatePhaseRevision, commitPhaseRevision });
        if (typeof crashInjector === 'function') await crashInjector('after_successor_stage', {
          request_id: controlRequest.request_id, bundle_digest: staged.bundle_digest,
        });
        const queue = await readBoundedJson(path.join(runDir, 'queued-events.json'),
          'runtime queue').catch((error) => {
          if (error instanceof CliContractError && error.code === 'INPUT_UNREADABLE') return null;
          throw error;
        });
        let queuedReplayCommit = null;
        if (queue !== null) {
          if (!validateRuntimeQueue(queue, active.meta.run_id, active.pointer.plan_epoch)
            || queue.queue_digest !== controlRequest.payload.expected_queue_digest) {
            throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED', 'queued event prefix binding不正');
          }
          const head = queue.entries[0];
          if (head !== undefined && (!['finding', 'conflict_found'].includes(head.kind)
            || head.artifact_digest !== treatment.finding_digest)) {
            throw new ManagedRuntimeError('QUEUED_REPLAY_REQUIRED', 'queue headを同一stagingへ順序通りreplayする必要がある');
          }
          const remaining = head === undefined ? [] : queue.entries.slice(1);
          if (remaining.length > 0) throw new ManagedRuntimeError('QUEUED_REPLAY_REQUIRED',
            'successor activation前にqueue全entryの順序replayが必要');
          const cleared = { schema: 'lattice.runtime_queue.v1', run_id: active.meta.run_id,
            frozen_epoch: active.pointer.plan_epoch, entries: remaining, queue_digest: '' };
          cleared.queue_digest = selfDigest(cleared, 'queue_digest');
          queuedReplayCommit = cleared;
        }

        // treatment/finding、fresh successor、stage、queue headを全検証した後にだけ
        // public run event batchをpublishする。
        events = await publishRuntimeEventBatch({ runDir,
          transactionId: recompileRequest.request_id, phase: 'recompile', planEpoch: nextEpoch,
          bindingDigest: digestArtifact({ successor_epoch: nextEpoch,
            successor_plan_digest: newPlan.plan_digest,
            recompile_request_digest: recompileRequest.request_digest }),
          currentEvents: predecessorEvents, proposedBatch: proposedCoreBatch, crashInjector });

        const controllerActivations = [activation, ...additionalActivations];
        const sortedSuccessorIds = newPlan.nodes.map((node) => node.todo_id).sort();
        const controllerForTodo = (todoId) => controllerActivations[
          Math.max(0, sortedSuccessorIds.indexOf(todoId)) % controllerActivations.length];
        const nonceDigest = digestArtifact(sessionNonce);
        const issuedControlDigest = controlEvents.at(-1).event_digest;
        const activationTransaction = {
          schema: 'lattice.runtime_epoch_activation_transaction.v1',
          request_id: controlRequest.request_id,
          request_digest: controlRequest.request_digest,
          logical_intent_digest: controlIntentDigest(controlRequest),
          recompile_request_digest: recompileRequest.request_digest,
          predecessor_pointer_digest: active.pointer.pointer_digest,
          predecessor_bundle_digest: active.bundle.bundle_digest,
          successor_bundle_digest: staged.bundle_digest,
          successor_epoch: nextEpoch,
          queue_head_digest: controlRequest.payload.expected_queue_digest,
          queue_replay_commit: queuedReplayCommit,
          state: 'prepared', committed_pointer_digest: null, gate_digest: null,
          recovered_todo_ids: [],
          recovery_error: null,
          transaction_digest: '',
        };
        activationTransaction.transaction_digest = selfDigest(activationTransaction, 'transaction_digest');
        await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', activationTransaction);
        const stagedLease = (todoId, packetDigest, owner) => {
          const lease = { schema: 'lattice.runtime_write_lease.v1',
            lease_id: `lease-${recompileRequest.request_id}-${todoId}`, run_id: active.meta.run_id,
            todo_id: todoId, plan_epoch: nextEpoch, packet_digest: packetDigest,
            controller_registration_digest: owner.registration.registration_digest,
            supervisor_session_nonce_digest: nonceDigest, state: 'staged',
            ttl_ms: owner.controllerDescriptor.heartbeat.ttl_ms,
            issued_control_digest: issuedControlDigest, lease_digest: '' };
          lease.lease_digest = selfDigest(lease, 'lease_digest');
          return lease;
        };
        const preparedSuccessors = new Set();
        for (const todoId of core.planDiff.redispatched) {
          const successors = recompileRequest.task_migration.entries
            .find((entry) => entry.predecessor_task_id === todoId)?.successor_task_ids ?? [];
          for (const successorId of successors) {
            const packet = executorPackets[successorId];
            const owner = controllerForTodo(successorId);
            if (packet !== undefined) await managedSupervisor.prepareController({
              controllerId: owner.controllerDescriptor.controller_id,
              executorPacket: packet, stagedLease: stagedLease(successorId, packet.packet_digest, owner) });
            if (packet !== undefined) preparedSuccessors.add(successorId);
          }
        }
        const acceptedCheckpointDigests = new Set(planDiff.accepted_checkpoints);
        const acceptedTodoIds = new Set(projectRuntimeState({ events }).receipts
          .filter((receipt) => receipt.accepted_sequence !== null
            && acceptedCheckpointDigests.has(receipt.payload?.checkpoint_digest))
          .map((receipt) => receipt.todo_id));
        const carriedTodoIds = new Set(planDiff.carried_over);
        const expectedLiveTodoIds = newPlan.nodes.map((node) => node.todo_id)
          .filter((todoId) => !acceptedTodoIds.has(todoId) && !carriedTodoIds.has(todoId)).sort();
        const activatedTodoIds = [...preparedSuccessors].sort();
        if (canonicalizeArtifact(expectedLiveTodoIds) !== canonicalizeArtifact(activatedTodoIds)) {
          throw new ManagedRuntimeError('EPOCH_REBIND_INCOMPLETE', 'successor live taskのrebind/prepare集合が完全でない');
        }
        controlEvents = await eventStore.readEvents();
        const committed = await commitStagedSuccessorEpoch({ runDir,
          transactionId: staged.transaction_id,
          activationRunEventDigest: events.at(-1).event_digest,
          activationControlEventDigest: controlEvents.at(-1).event_digest,
          readActivationControlEvents: () => eventStore.readEvents() });
        if (typeof crashInjector === 'function') await crashInjector('after_successor_pointer_rename', {
          request_id: controlRequest.request_id, pointer_digest: committed.pointer.pointer_digest,
        });
        activationTransaction.state = 'pointer_committed';
        activationTransaction.committed_pointer_digest = committed.pointer.pointer_digest;
        activationTransaction.transaction_digest = selfDigest(activationTransaction, 'transaction_digest');
        await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', activationTransaction);
        if (typeof crashInjector === 'function') await crashInjector('after_successor_pointer_commit', {
          request_id: controlRequest.request_id, pointer_digest: committed.pointer.pointer_digest,
        });
        const activationDigest = digestArtifact({ pointer_digest: committed.pointer.pointer_digest,
          staged_bundle_digest: staged.bundle_digest });
        const activated = await managedSupervisor.commitWriteGate({ planEpoch: nextEpoch,
          committedEpochDigest: committed.pointer.pointer_digest, activationDigest,
          commitReleaseBarrier: (barrier) => commitReleaseEpochBarrier({ runDir, barrier }),
          afterControllerRelease: async (released) => {
            if (released.release_index === 1 && typeof crashInjector === 'function') {
              await crashInjector('after_first_controller_release', released);
            }
          },
          committedAt: canonicalNow() });
        if (queuedReplayCommit !== null) {
          await replaceCanonicalJsonAtomically(runDir, 'queued-events.json', queuedReplayCommit);
        }
        activationTransaction.state = 'gate_committed';
        activationTransaction.gate_digest = activated.gate.gate_digest;
        activationTransaction.transaction_digest = selfDigest(activationTransaction, 'transaction_digest');
        await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', activationTransaction);
        events.push(buildNextRunEvent({ events, runId: active.meta.run_id, kind: 'intake_resumed',
          planEpoch: nextEpoch, subject: { kind: 'runtime_plan', ref: newPlan.plan_ref },
          payload: { plan_diff_digest: planDiff.diff_digest,
            write_gate_digest: activated.gate.gate_digest }, recordedAt: canonicalNow() }));
        await replaceEventsAtomically(runDir, events);
        if (typeof crashInjector === 'function') await crashInjector('after_successor_intake_resume', {
          request_id: controlRequest.request_id, gate_digest: activated.gate.gate_digest,
          event_digest: events.at(-1).event_digest,
        });
        if (recompileRequest.mode === 'intentional_serial'
          && isHostDrivenEpochActivation(activation)) {
          epochDriveActive = true;
          try {
            events = await driveScriptedManagedEpoch({
              runDir,
              repoRoot,
              request: committed.bundle.request,
              committed,
              activation,
              managedSupervisor,
              initialEvents: events,
              controlEvents: () => controlEvents,
              sentinel,
              preDispatchBindings,
              drainEscalations: drainPendingEscalations,
              escalateTerminalConflict,
              preactivated: activated,
            });
          } finally {
            epochDriveActive = false;
          }
        }
        const result = buildControlResult({ operation: 'recompile', outcome: 'recompiled',
          eventHeadDigest: events.at(-1).event_digest,
          controlHeadDigest: (await eventStore.readEvents()).at(-1).event_digest,
          activeEpoch: nextEpoch, stagedEpoch: null });
        return buildControlResponse(controlRequest, 'completed', result, result.control_head_digest);
      }
      if (controlRequest.operation === 'reprocess') {
        const active = await readCommittedEpochStore(runDir);
        const queue = await readBoundedJson(path.join(runDir, 'queued-events.json'), 'runtime queue');
        if (!validateRuntimeQueue(queue, active.meta.run_id, active.pointer.plan_epoch)
          || queue.queue_digest !== controlRequest.payload.expected_queue_digest) {
          throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED', 'reprocess queue binding不正');
        }
        const pending = await readBoundedJson(path.join(runDir, 'pending-recompile.json'),
          'pending recompile').catch(() => null);
        if (pending?.schema !== 'lattice.runtime_pending_recompile.v1'
          || pending.pending_digest !== selfDigest(pending, 'pending_digest')
          || pending.predecessor_epoch !== active.pointer.plan_epoch) {
          throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED', 'same staging recompile binding不足');
        }
        const recompileRequest = pending.recompile_request;
        const treatment = recompileRequest.mode === 'seam_split'
          ? recompileRequest.seam_split : recompileRequest.intentional_serial;
        if (queue.entries.some((entry, index) => entry.sequence !== index + 1
          || !['finding', 'conflict_found'].includes(entry.kind)
          || entry.artifact_digest !== treatment.finding_digest)) {
          throw new ManagedRuntimeError('QUEUED_CONFLICT_REMAINS', 'queue headをpending treatmentで解決できない');
        }
        pending.reprocess_request_id = controlRequest.request_id;
        pending.reprocess_queue_digest = queue.queue_digest;
        pending.pending_digest = selfDigest(pending, 'pending_digest');
        await replaceCanonicalJsonAtomically(runDir, 'pending-recompile.json', pending);
        const resumeRequest = createRuntimeControlRequest({
          requestId: pending.control_request_id, runId: active.meta.run_id,
          operation: 'recompile', sessionNonce, payload: controlOperationPayload({
            operation: 'recompile', runRef: controlRequest.payload.run_ref,
            artifact: recompileRequest, artifactDigest: digestArtifact(recompileRequest),
            checkpointDigest: null, expectedEpoch: active.pointer.plan_epoch,
            expectedQueueDigest: queue.queue_digest, shutdownReason: null,
          }),
        });
        const resumed = await executeControl(resumeRequest);
        if (resumed.outcome !== 'completed') {
          throw new ManagedRuntimeError(resumed.result?.unmet?.[0] ?? 'RUN_RECOVERY_REQUIRED',
            resumed.result?.unmet?.[1] ?? 'same staging recompile再開失敗');
        }
        const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        const nowActive = await readCommittedEpochStore(runDir);
        const resumedControlHead = (await eventStore.readEvents()).at(-1).event_digest;
        const result = buildControlResult({ operation: 'reprocess', outcome: 'reprocessed',
          eventHeadDigest: events.at(-1).event_digest,
          controlHeadDigest: resumedControlHead,
          activeEpoch: nowActive.pointer.plan_epoch, stagedEpoch: null });
        return buildControlResponse(controlRequest, 'completed', result,
          resumedControlHead);
      }
      if (['close', 'abandon'].includes(controlRequest.operation)) {
        let events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
        const active = await readCommittedEpochStore(runDir);
        const state = projectRuntimeState({ events });
        const shutdownReason = controlRequest.payload.shutdown_reason;
        if (controlRequest.operation === 'abandon' && !validRuntimeAbandonReason(shutdownReason)) {
          throw new ManagedRuntimeError('INVALID_ABANDON_REASON', 'abandon reasonが監査文字列規律を満たさない');
        }
        if (controlRequest.operation === 'close'
          && (typeof shutdownReason !== 'string' || shutdownReason.length === 0)) {
          throw new ManagedRuntimeError('MANAGED_SHUTDOWN_INCOMPLETE', 'shutdown reason不足');
        }
        let proposed;
        if (controlRequest.operation === 'close') {
          proposed = closeRunAbandoningRemaining({ runId: request.request_id, plan: active.bundle.plan,
            events, recordedAt: canonicalNow() });
        }
        const shutdown = await managedSupervisor.shutdownManaged({ mode: controlRequest.operation,
          reason: shutdownReason, barrierId: `shutdown-${randomUUID()}`,
          frozenEventDigest: events.at(-1).event_digest, recordedAt: canonicalNow() });
        if (controlRequest.operation === 'close') events = proposed.events;
        else {
          events = [...events, buildNextRunEvent({ events, runId: request.request_id, kind: 'run_closed',
            planEpoch: active.pointer.plan_epoch,
            subject: { kind: 'runtime_plan', ref: active.bundle.plan.plan_ref },
            payload: { outcome: 'abandoned', reason: shutdownReason, accepted: state.accepted },
            recordedAt: canonicalNow() })];
        }
        await replaceEventsAtomically(runDir, events);
        // **abandonは成果を捨てる決定である。** worker processの終了はcleanupではなく
        // その決定の一部なので、誰を止めたかを記録へ残す。完走したcloseでは何もしない。
        // u03 C18: 未完了TODOを放棄して閉じるcloseはworkerも止める。作業木はrunの成果なので残す。
        // SIGKILLは停止中(SIGSTOP)のworkerにも届く。
        const stopsWorkers = controlRequest.operation === 'abandon'
          || proposed?.abandoned_todo_ids.length > 0;
        if (stopsWorkers) {
          const reaped = await reapRunWorkerProcesses({ events }).catch(() => null)
            ?? { reaped: [], skipped: [], unavailable: [] };
          // R2k: a killed worker's tree loses a stale index.lock and names unobserved writes.
          const keptWorktrees = await recoverKeptWorktrees({ events });
          if (reaped.reaped.length > 0 || reaped.skipped.length > 0
            || reaped.unavailable.length > 0 || keptWorktrees.length > 0) {
            await appendControl({ run_id: request.request_id, kind: 'worker_processes_terminated',
              session_nonce_digest: digestArtifact(sessionNonce), payload: {
                reason: shutdownReason,
                terminated_pids: [...reaped.reaped].sort((left, right) => left - right),
                skipped_count: reaped.skipped.length,
                ...(reaped.unavailable.length > 0
                  ? { signal_unavailable_pids: [...reaped.unavailable].sort((left, right) => left - right) } : {}),
                ...(keptWorktrees.length > 0 ? { kept_worktrees: keptWorktrees } : {}),
              } });
          }
        }
        if (controlRequest.operation === 'abandon') {
          // 木も畳む。closeでは畳まない——木そのものがrunの成果であり、着地させる前に
          // 消したら受理した内容が残らない。
          await removeScriptedWorktrees({ repoRoot, runDir }).catch(() => null);
        }
        await appendControl({ run_id: request.request_id, kind: 'supervisor_stopped',
          session_nonce_digest: digestArtifact(sessionNonce),
          payload: { shutdown_result_digest: shutdown.result_digest } });
        const result = buildControlResult({ operation: controlRequest.operation,
          outcome: controlRequest.operation === 'close' ? 'closed' : 'abandoned',
          eventHeadDigest: events.at(-1).event_digest,
          controlHeadDigest: controlEvents.at(-1).event_digest,
          activeEpoch: active.pointer.plan_epoch });
        setTimeout(() => {
          server?.close(() => {
            resolveActiveRuntimePaths({ runDir }).then((active) => Promise.all([
              rm(socketPath, { force: true }), rm(active.sessionPath, { force: true }),
              rm(path.join(supervisorDir, 'session'), { force: true }),
            ])).catch(() => {});
          });
        }, 200);
        return buildControlResponse(controlRequest, 'completed', result, controlEvents.at(-1).event_digest);
      }
      throw new ManagedRuntimeError('RUN_NOT_MANAGED', `未知のmanaged operation: ${controlRequest.operation}`);
    } catch (error) {
      const code = error?.code ?? 'ADAPTER_CONTROLLER_UNAVAILABLE';
      let events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events').catch(() => []);
      const result = buildControlResult({ operation: controlRequest.operation, outcome: 'rejected',
        eventHeadDigest: events.at(-1)?.event_digest ?? null,
        controlHeadDigest: controlEvents.at(-1)?.event_digest ?? null, activeEpoch: 1,
        unmet: [code, String(error?.message ?? error)] });
      if (controlRequest.operation === 'activate' && !activationCommitted) {
        setTimeout(() => {
          server?.close(() => {
            Promise.all([
              activation?.disposeController?.(),
              candidateDir ? rm(candidateDir, { recursive: true, force: true }) : Promise.resolve(),
              candidateControllerDir ? rm(candidateControllerDir, { recursive: true, force: true }) : Promise.resolve(),
              rm(socketPath, { force: true }),
              restarting ? Promise.resolve() : rm(path.join(runDir, 'control-request-ledger.json'), { force: true }),
              restarting ? Promise.resolve() : rm(supervisorDir, { recursive: true, force: true }),
            ]).catch(() => {});
          });
        }, 200);
      }
      return buildControlResponse(controlRequest, 'rejected', result, controlEvents.at(-1)?.event_digest ?? null);
    }
  };
  const handler = async (controlRequest) => {
    let known = await requestStore.readRequest(controlRequest);
    let sessionRecoveryResponse = null;
    if (known?.state === 'completed'
      && ['recompile', 'reprocess'].includes(controlRequest.operation)) {
      const recoveryEvents = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
      const recoveryCommitted = await readCommittedEpochStore(runDir);
      const expectedSuccessor = controlRequest.payload.expected_epoch + 1;
      if (recoveryCommitted?.pointer.plan_epoch === expectedSuccessor
        && !(await isActiveSupervisorGateCommitted(runDir, recoveryEvents, expectedSuccessor))) {
        sessionRecoveryResponse = known.response;
        known = { ...known, state: 'in_progress', response: null };
      }
    }
    // 初回activateがsocket timeoutを超えても、同一request_idの再照会を二重activateとして
    // 実行しない。初回daemon（run_meta.v1）に残るin_progressは、activation代入前後のどちらでも
    // 同じ処理がまだ走っている状態なのでunknownを返す。daemon再起動後（run_meta.v2）の
    // in_progressだけは、直後のrecovery分岐がdurable ledgerから処理を再開する。
    if (known?.state === 'in_progress' && controlRequest.operation === 'activate'
      && !restarting) {
      const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events').catch(() => []);
      const journal = await eventStore.readEvents();
      const result = buildControlResult({ operation: controlRequest.operation, outcome: 'unknown',
        eventHeadDigest: events.at(-1)?.event_digest ?? null,
        controlHeadDigest: journal.at(-1)?.event_digest ?? null, activeEpoch: 1,
        unmet: ['RUN_OUTCOME_UNKNOWN', '同一request_idのactivateはまだ処理中'] });
      return buildControlResponse(controlRequest, 'unknown', result,
        journal.at(-1)?.event_digest ?? null);
    }
    // 初回daemonにはrestart candidate pointerが無い。完了後に元socketの応答だけを失った
    // 同一requestをpointer recoveryへ流すと、既存activationをもう一度executeしてRUN_BUSYになる。
    // ledgerのexact request digestへ束縛されたcompleted responseをそのまま返す。
    if (known?.state === 'completed' && controlRequest.operation === 'activate'
      && !restarting) {
      if (known.request_digest !== controlRequest.request_digest) {
        throw new ManagedRuntimeError('REQUEST_ID_CONFLICT',
          '同一activate request_idへ異なるrequest digest');
      }
      return known.response;
    }
    if (known !== null && controlRequest.operation === 'activate') {
      const active = await resolveActiveRuntimePaths({ runDir }).catch(() => null);
      if (active?.pointer?.activation_request_id === controlRequest.request_id
        && active.pointer.activation_intent_digest === controlIntentDigest(controlRequest)) {
        const priorResponse = await readBoundedJson(path.join(path.dirname(active.descriptorPath),
          'activation-response.json'), 'activation response');
        if (!validateRuntimeControlResponse(priorResponse, controlRequest.operation)
          || priorResponse.response_digest !== active.pointer.activation_response_digest) {
          throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED', 'committed activation response binding不正');
        }
        const currentActivation = active.pointer.activation_request_digest
            === controlRequest.request_digest
          && active.pointer.session_nonce_digest === digestArtifact(sessionNonce)
          && known.request_digest === controlRequest.request_digest
          && managedSupervisor !== null;
        if (currentActivation) {
          if (known.state === 'completed') {
            if (known.response.response_digest !== priorResponse.response_digest) {
              throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED',
                'current activation ledger/pointer response binding不正');
            }
            return known.response;
          }
          return requestStore.replaceCompletedActivationRequest(controlRequest, priorResponse);
        }
      }
      let activationLock;
      try {
        activationLock = await acquireRuntimeLifecycleLock({ runDir,
          sessionNonceDigest: digestArtifact(sessionNonce), operation: controlRequest.operation,
          requestId: controlRequest.request_id, timeoutMs: 0 });
        const freshResponse = await executeControl(controlRequest);
        if (freshResponse.outcome !== 'completed') return freshResponse;
        return requestStore.replaceCompletedActivationRequest(controlRequest, freshResponse);
      } finally {
        await activationLock?.release();
      }
    }
    if (known?.state === 'completed') return known.response;
    if (known?.state === 'in_progress' && controlRequest.operation === 'reprocess'
      && sessionRecoveryResponse === null) {
      const recovered = await readBoundedJson(path.join(runDir,
        `reprocess-operation-response-${controlRequest.request_id}.json`),
      'reprocess operation response').catch(() => null);
      if (validateRuntimeControlResponse(recovered, 'reprocess')
        && recovered.request_id === controlRequest.request_id) {
        return requestStore.completeRequest(controlRequest, recovered);
      }
    }
    const staleInProgress = known?.state === 'in_progress'
      && known.request_digest !== controlRequest.request_digest;
    if (controlRequest.run_id !== request.request_id
      || controlRequest.session_nonce !== sessionNonce || staleInProgress
      || sessionRecoveryResponse !== null) {
      let events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events').catch(() => []);
      const active = await resolveActiveRuntimePaths({ runDir }).catch(() => null);
      const journal = active === null ? []
        : await readBoundedJson(active.controlEventsPath, 'runtime control events').catch(() => []);
      let outcome = 'rejected';
      let operationOutcome = 'rejected';
      let unmet = ['RUN_RECOVERY_REQUIRED', '旧session requestはdurable side effectを導出できない'];
      if (known?.state === 'in_progress') {
        let holdReceipt = controlRequest.operation === 'hold'
          ? await readBoundedJson(path.join(runDir, 'hold-operation-receipt.json'),
            'hold operation receipt').catch(() => null)
          : null;
        if (controlRequest.operation === 'hold' && holdReceipt === null) {
          const reconstructed = reconstructHoldResultFromJournal({ journal,
            runId: request.request_id, requestId: controlRequest.request_id,
            intentDigest: controlIntentDigest(controlRequest) });
          if (reconstructed !== null) {
            await replaceCanonicalJsonAtomically(runDir, 'hold-result.json', reconstructed);
            holdReceipt = {
              schema: 'lattice.runtime_control_operation_receipt.v1',
              request_id: controlRequest.request_id,
              logical_intent_digest: controlIntentDigest(controlRequest),
              operation: 'hold', outcome: 'held', effect_digest: reconstructed.result_digest,
              receipt_digest: '',
            };
            holdReceipt.receipt_digest = selfDigest(holdReceipt, 'receipt_digest');
            await replaceCanonicalJsonAtomically(runDir, 'hold-operation-receipt.json', holdReceipt);
          }
        }
        const held = holdReceipt?.schema === 'lattice.runtime_control_operation_receipt.v1'
          && holdReceipt.request_id === controlRequest.request_id
          && holdReceipt.logical_intent_digest === controlIntentDigest(controlRequest)
          && holdReceipt.operation === 'hold' && holdReceipt.outcome === 'held'
          && holdReceipt.receipt_digest === selfDigest(holdReceipt, 'receipt_digest');
        if (held && !events.some((event) => event.kind === 'hold_decided'
          && event.payload?.finding?.finding_digest
            === journal.find((event) => event.kind === 'hold_prepared'
              && event.payload.request_id === controlRequest.request_id)?.payload.finding_digest)) {
          const heldResult = await readBoundedJson(path.join(runDir, 'hold-result.json'),
            'hold result');
          const evidenceEvents = journal.filter((event) => event.kind === 'executor_quiesced'
            && heldResult.quiescence_ack_digests.includes(event.payload?.ack?.ack_digest));
          for (const evidence of evidenceEvents) {
            if (events.some((event) => event.kind === 'checkpoint_observed'
              && event.payload?.barrier_evidence_digest === evidence.payload.evidence_digest)) continue;
            events.push(buildNextRunEvent({ events, runId: request.request_id,
              kind: 'checkpoint_observed', planEpoch: controlRequest.payload.expected_epoch,
              subject: { kind: 'todo', ref: evidence.payload.todo_id },
              payload: { ...structuredClone(evidence.payload.direct_observation.checkpoint),
                barrier_final: true, barrier_evidence_digest: evidence.payload.evidence_digest },
              recordedAt: canonicalNow() }));
          }
          const activeEpoch = await readCommittedEpochStore(runDir);
          const decided = decideHoldAndCarryOver({ runId: request.request_id,
            request: activeEpoch.bundle.request, plan: activeEpoch.bundle.plan,
            manifests: activeEpoch.bundle.manifests, packets: activeEpoch.bundle.executor_packets,
            events, recordedAt: canonicalNow() });
          events = decided.events;
          await replaceEventsAtomically(runDir, events);
        }
        const found = controlRequest.operation === 'conflict'
          && events.some((event) => event.kind === 'conflict_found'
            && event.payload?.finding_digest === controlRequest.payload.artifact_digest);
        let recordedFinding = null;
        if (controlRequest.operation === 'finding_record') {
          const names = await readdir(path.join(runDir, 'findings')).catch(() => []);
          for (const name of names.filter((entry) => /^[0-9a-f]{64}\.json$/u.test(entry))) {
            const candidate = await readBoundedJson(path.join(runDir, 'findings', name),
              'runtime finding').catch(() => null);
            const input = controlRequest.payload.artifact;
            if (validateRuntimeFindingRecord(candidate)
              && candidate.source_checkpoint_digest === controlRequest.payload.checkpoint_digest
              && candidate.finding.kind === input.proposed_kind
              && canonicalizeArtifact(candidate.finding.todo_ids) === canonicalizeArtifact(input.todo_ids)
              && candidate.finding.path === input.path
              && candidate.finding.resource_id === input.resource_id
              && input.evidence_digests.every((digest) => candidate.finding.evidence_digests.includes(digest))
              && candidate.finding.evidence_digests.includes(controlRequest.payload.checkpoint_digest)) {
              recordedFinding = candidate; break;
            }
          }
        }
        let committed = await readCommittedEpochStore(runDir).catch(() => null);
        let prePointerRecovered = false;
        if (controlRequest.operation === 'recompile'
          && committed?.pointer.plan_epoch === controlRequest.payload.expected_epoch
          && controlRequest.payload.artifact?.predecessor_epoch === committed.pointer.plan_epoch) {
          const recoveredResponse = await executeControl(controlRequest);
          if (recoveredResponse.outcome === 'completed') {
            events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
            prePointerRecovered = true;
          }
        }
        let recompiled = controlRequest.operation === 'recompile'
          && (prePointerRecovered || (committed?.pointer.plan_epoch === controlRequest.payload.expected_epoch + 1
          && committed.bundle.request.request_digest
            === controlRequest.payload.artifact?.successor_request?.request_digest
          && !staleInProgress && managedSupervisor.frozen === false
          && !(await isManagedRunFrozen(runDir, events))));
        if (controlRequest.operation === 'recompile' && committed !== null
          && committed.pointer.plan_epoch === controlRequest.payload.expected_epoch + 1
          && committed.bundle.request.request_digest
            === controlRequest.payload.artifact?.successor_request?.request_digest
          && (staleInProgress || managedSupervisor.frozen
            || await isManagedRunFrozen(runDir, events))) {
          const transaction = await readBoundedJson(path.join(runDir,
            'epoch-activation-transaction.json'), 'epoch activation transaction').catch(() => null);
          if (transaction?.schema !== 'lattice.runtime_epoch_activation_transaction.v1'
            || transaction.request_id !== controlRequest.request_id
            || transaction.logical_intent_digest !== controlIntentDigest(controlRequest)
            || transaction.successor_bundle_digest !== committed.bundle.bundle_digest
            || !([null, committed.pointer.pointer_digest].includes(transaction.committed_pointer_digest))
            || (transaction.committed_pointer_digest === null
              && (transaction.state !== 'prepared'
                || transaction.predecessor_bundle_digest !== committed.bundle.predecessor_bundle_digest))
            || transaction.transaction_digest !== selfDigest(transaction, 'transaction_digest')) {
            throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED', 'activation transaction binding不正');
          }
          if (transaction.committed_pointer_digest === null) {
            transaction.state = 'pointer_committed';
            transaction.committed_pointer_digest = committed.pointer.pointer_digest;
            transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
            await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
          }
          const recoveryControllers = [activation, ...additionalActivations];
          const recoveryTodoIds = committed.bundle.plan.nodes.map((node) => node.todo_id).sort();
          const recoveryControllerForTodo = (todoId) => recoveryControllers[
            Math.max(0, recoveryTodoIds.indexOf(todoId)) % recoveryControllers.length];
          const nonceDigest = digestArtifact(sessionNonce);
          const issuedControlDigest = journal.at(-1)?.event_digest;
          transaction.state = 'recovery_preparing';
          transaction.recovered_todo_ids = [];
          transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
          await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
          const recoveryLease = (todoId, packetDigest, owner) => {
            const lease = { schema: 'lattice.runtime_write_lease.v1',
              lease_id: `lease-recovery-${controlRequest.request_id}-${todoId}`,
              run_id: committed.meta.run_id, todo_id: todoId,
              plan_epoch: committed.pointer.plan_epoch, packet_digest: packetDigest,
              controller_registration_digest: owner.registration.registration_digest,
              supervisor_session_nonce_digest: nonceDigest, state: 'staged',
              ttl_ms: owner.controllerDescriptor.heartbeat.ttl_ms,
              issued_control_digest: issuedControlDigest, lease_digest: '' };
            lease.lease_digest = selfDigest(lease, 'lease_digest');
            return lease;
          };
          const predecessorBundle = await readBoundedJson(path.join(runDir, 'epochs',
            String(committed.pointer.plan_epoch - 1).padStart(8, '0'), 'epoch-bundle.json'),
          'predecessor epoch bundle');
          const recoveryRebindEvidence = new Map();
          for (const [todoId, rebindPacket] of Object.entries(committed.bundle.rebind_packets)) {
            const owner = recoveryControllerForTodo(todoId);
            const dispatch = projectRuntimeState({ events }).dispatches[todoId];
            if (dispatch === undefined) throw new ManagedRuntimeError('RUN_RECOVERY_REQUIRED',
              `carry rebind predecessor dispatch不足: ${todoId}`);
            const evidence = await managedSupervisor.rebindController({ controllerId: owner.controllerDescriptor.controller_id, rebindPacket,
              stagedLease: recoveryLease(todoId, rebindPacket.packet_digest, owner), expected: {
                todo_id: todoId, executor_handle: dispatch.payload.executor_handle,
                worktree_id: dispatch.payload.worktree_id,
                predecessor_packet_digest: predecessorBundle.executor_packets[todoId]?.packet_digest
                  ?? rebindPacket.packet_digest,
                rebind_packet_digest: rebindPacket.packet_digest,
              } });
            recoveryRebindEvidence.set(todoId, { ...evidence,
              controller_registration_digest: owner.registration.registration_digest });
            transaction.recovered_todo_ids.push(todoId);
            transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
            await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
          }
          for (const predecessorId of committed.bundle.plan_diff.redispatched) {
            const successors = committed.bundle.task_migration.entries
              .find((entry) => entry.predecessor_task_id === predecessorId)?.successor_task_ids ?? [];
            for (const todoId of successors) {
              if (Object.hasOwn(committed.bundle.rebind_packets, todoId)) continue;
              const packet = committed.bundle.executor_packets[todoId];
              if (packet === undefined) continue;
              const owner = recoveryControllerForTodo(todoId);
              try {
                await managedSupervisor.prepareController({ controllerId: owner.controllerDescriptor.controller_id,
                  executorPacket: packet, stagedLease: recoveryLease(todoId, packet.packet_digest, owner) });
              } catch (error) {
                transaction.recovery_error = `${error?.code ?? 'ERROR'}:${error?.message ?? error}`;
                transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
                await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
                throw error;
              }
              transaction.recovered_todo_ids.push(todoId);
              transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
              await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
            }
          }
          const recoveryReboundAt = canonicalNow();
          const recoveryReboundBatch = [];
          let recoveryReboundEvents = [...events];
          for (const [todoId, rebindPacket] of Object.entries(committed.bundle.rebind_packets)
            .sort(([left], [right]) => left.localeCompare(right))) {
            const evidence = recoveryRebindEvidence.get(todoId);
            const event = buildNextRunEvent({ events: recoveryReboundEvents,
              runId: committed.meta.run_id, kind: 'epoch_rebound',
              planEpoch: committed.pointer.plan_epoch,
              subject: { kind: 'todo', ref: todoId }, payload: { ...rebindPacket,
                rebind_ack_digest: evidence.ack.ack_digest,
                control_event_digest: evidence.control_event_digest,
                controller_registration_digest: evidence.controller_registration_digest },
              recordedAt: recoveryReboundAt });
            recoveryReboundEvents.push(event);
            recoveryReboundBatch.push(event);
          }
          events = await publishRuntimeEventBatch({ runDir,
            transactionId: transaction.request_id,
            phase: `epoch_rebound_recovery_${nonceDigest}`,
            planEpoch: committed.pointer.plan_epoch,
            bindingDigest: digestArtifact({ successor_bundle_digest: committed.bundle.bundle_digest,
              supervisor_session_nonce_digest: nonceDigest,
              ordered_rebind_packet_digests: Object.entries(committed.bundle.rebind_packets)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([, packet]) => packet.packet_digest) }),
            currentEvents: events, proposedBatch: recoveryReboundBatch, crashInjector });
          transaction.state = 'recovery_ready';
          transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
          await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
          const activationDigest = digestArtifact({ pointer_digest: committed.pointer.pointer_digest,
            staged_bundle_digest: committed.bundle.bundle_digest });
          let activated;
          try {
            activated = await managedSupervisor.commitWriteGate({
              planEpoch: committed.pointer.plan_epoch,
              committedEpochDigest: committed.pointer.pointer_digest, activationDigest,
              commitReleaseBarrier: (barrier) => commitReleaseEpochBarrier({ runDir, barrier }),
              afterControllerRelease: async (released) => {
                if (released.release_index === 1 && typeof crashInjector === 'function') {
                  await crashInjector('after_first_controller_release', released);
                }
              },
              committedAt: canonicalNow(),
            });
          } catch (error) {
            transaction.recovery_error = `${error?.code ?? 'ERROR'}:${error?.message ?? error}`;
            transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
            await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
            throw error;
          }
          if (transaction.queue_replay_commit !== null) {
            await replaceCanonicalJsonAtomically(runDir, 'queued-events.json',
              transaction.queue_replay_commit);
          }
          if (!events.some((event) => event.kind === 'intake_resumed'
            && event.plan_epoch === committed.pointer.plan_epoch
            && event.payload?.write_gate_digest === activated.gate.gate_digest)) {
            events.push(buildNextRunEvent({ events, runId: committed.meta.run_id,
              kind: 'intake_resumed', planEpoch: committed.pointer.plan_epoch,
              subject: { kind: 'runtime_plan', ref: committed.bundle.plan.plan_ref },
              payload: { plan_diff_digest: committed.bundle.plan_diff.diff_digest,
                write_gate_digest: activated.gate.gate_digest }, recordedAt: canonicalNow() }));
            await replaceEventsAtomically(runDir, events);
          }
          transaction.state = 'gate_committed';
          transaction.gate_digest = activated.gate.gate_digest;
          transaction.transaction_digest = selfDigest(transaction, 'transaction_digest');
          await replaceCanonicalJsonAtomically(runDir, 'epoch-activation-transaction.json', transaction);
          if (typeof crashInjector === 'function') await crashInjector('after_successor_intake_resume', {
            request_id: controlRequest.request_id, gate_digest: activated.gate.gate_digest,
            event_digest: events.at(-1).event_digest,
          });
          recompiled = true;
        }
        const queue = controlRequest.operation === 'reprocess'
          ? await readBoundedJson(path.join(runDir, 'queued-events.json'), 'runtime queue').catch(() => null)
          : null;
        let resumedReprocess = false;
        if (controlRequest.operation === 'reprocess' && committed !== null
          && committed.pointer.plan_epoch >= controlRequest.payload.expected_epoch) {
          const pending = await readBoundedJson(path.join(runDir, 'pending-recompile.json'),
            'pending recompile').catch(() => null);
          if (pending?.schema === 'lattice.runtime_pending_recompile.v1'
            && pending.pending_digest === selfDigest(pending, 'pending_digest')) {
            const resumeRequest = createRuntimeControlRequest({
              requestId: pending.control_request_id, runId: committed.meta.run_id,
              operation: 'recompile', sessionNonce, payload: controlOperationPayload({
                operation: 'recompile', runRef: controlRequest.payload.run_ref,
                artifact: pending.recompile_request,
                artifactDigest: digestArtifact(pending.recompile_request), checkpointDigest: null,
                expectedEpoch: pending.predecessor_epoch,
                expectedQueueDigest: pending.reprocess_queue_digest, shutdownReason: null,
              }),
            });
            let resumed;
            if (committed.pointer.plan_epoch === pending.predecessor_epoch) {
              resumed = await executeControl(resumeRequest);
            } else {
              try {
                resumed = await handler(resumeRequest);
              } catch (error) {
                pending.recovery_response_outcome = `nested_error:${error?.code ?? 'ERROR'}:${error?.message ?? error}`;
                pending.pending_digest = selfDigest(pending, 'pending_digest');
                await replaceCanonicalJsonAtomically(runDir, 'pending-recompile.json', pending);
                throw error;
              }
            }
            pending.recovery_response_outcome = resumed.outcome;
            pending.pending_digest = selfDigest(pending, 'pending_digest');
            await replaceCanonicalJsonAtomically(runDir, 'pending-recompile.json', pending);
            if (resumed.outcome === 'completed') {
              events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events');
              committed = await readCommittedEpochStore(runDir);
              resumedReprocess = true;
              const currentJournal = await eventStore.readEvents();
              const outerResult = buildControlResult({ operation: 'reprocess',
                outcome: 'reprocessed', eventHeadDigest: events.at(-1)?.event_digest ?? null,
                controlHeadDigest: currentJournal.at(-1)?.event_digest ?? null,
                activeEpoch: committed.pointer.plan_epoch, stagedEpoch: null });
              const outerResponse = buildControlResponse(controlRequest, 'completed', outerResult,
                currentJournal.at(-1)?.event_digest ?? null);
              await replaceCanonicalJsonAtomically(runDir,
                `reprocess-operation-response-${controlRequest.request_id}.json`, outerResponse);
              if (sessionRecoveryResponse?.outcome === 'completed') return sessionRecoveryResponse;
              return sessionRecoveryResponse?.outcome === 'rejected'
                ? requestStore.recoverCompletedRequest(controlRequest, outerResponse)
                : requestStore.completeRequest(controlRequest, outerResponse);
            }
          }
        }
        const reprocessed = controlRequest.operation === 'reprocess'
          && (resumedReprocess || (committed?.pointer.plan_epoch === controlRequest.payload.expected_epoch + 1
            && managedSupervisor.frozen === false
            && !(await isManagedRunFrozen(runDir, events))));
        const closed = events.findLast((event) => event.kind === 'run_closed');
        const terminal = held || found || recordedFinding !== null || recompiled || reprocessed
          || (controlRequest.operation === 'close' && closed?.payload?.outcome === 'completed')
          || (controlRequest.operation === 'abandon' && closed?.payload?.outcome === 'abandoned');
        if (terminal) {
          outcome = 'completed';
          operationOutcome = held ? 'held' : found ? 'frozen'
            : recordedFinding !== null ? 'recorded'
              : recompiled ? 'recompiled' : reprocessed ? 'reprocessed'
            : controlRequest.operation === 'close' ? 'closed' : 'abandoned';
          unmet = [];
        }
      }
      const result = buildControlResult({ operation: controlRequest.operation,
        outcome: operationOutcome, eventHeadDigest: events.at(-1)?.event_digest ?? null,
        controlHeadDigest: journal.at(-1)?.event_digest ?? null,
        activeEpoch: (await readCommittedEpochStore(runDir).catch(() => null))?.pointer.plan_epoch ?? 1,
        unmet });
      if (operationOutcome === 'recorded') {
        const names = await readdir(path.join(runDir, 'findings')).catch(() => []);
        const recovered = await Promise.all(names.filter((entry) => /^[0-9a-f]{64}\.json$/u.test(entry))
          .map((entry) => readBoundedJson(path.join(runDir, 'findings', entry), 'runtime finding').catch(() => null)));
        const candidate = recovered.find((entry) => validateRuntimeFindingRecord(entry)
          && entry.source_checkpoint_digest === controlRequest.payload.checkpoint_digest);
        if (candidate !== undefined) {
          result.finding_digest = candidate.finding_digest;
          const body = { ...result }; delete body.result_digest;
          result.result_digest = digestArtifact(body);
        }
      }
      const response = buildControlResponse(controlRequest, outcome, result,
        journal.at(-1)?.event_digest ?? null);
      if (sessionRecoveryResponse !== null) {
        if (outcome !== 'completed') return response;
        return sessionRecoveryResponse.outcome === 'completed' ? sessionRecoveryResponse
          : requestStore.recoverCompletedRequest(controlRequest, response);
      }
      return known?.state === 'in_progress'
        ? requestStore.completeRequest(controlRequest, response)
        : response;
    }
    if (known?.state === 'in_progress') {
      const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events').catch(() => []);
      const journal = await eventStore.readEvents();
      const result = buildControlResult({ operation: controlRequest.operation, outcome: 'unknown',
        eventHeadDigest: events.at(-1)?.event_digest ?? null,
        controlHeadDigest: journal.at(-1)?.event_digest ?? null, activeEpoch: 1,
        unmet: ['RUN_OUTCOME_UNKNOWN', '同一request_idの処理結果はまだ確定していない'] });
      return buildControlResponse(controlRequest, 'unknown', result,
        journal.at(-1)?.event_digest ?? null);
    }
    let lock;
    try {
      lock = await acquireRuntimeLifecycleLock({ runDir,
        sessionNonceDigest: digestArtifact(sessionNonce), operation: controlRequest.operation,
        requestId: controlRequest.request_id, timeoutMs: 0 });
    } catch (error) {
      const code = error?.code ?? 'RUN_BUSY';
      const events = await readBoundedJson(path.join(runDir, 'events.json'), 'run events').catch(() => []);
      const journal = await eventStore.readEvents().catch(() => []);
      const result = buildControlResult({ operation: controlRequest.operation, outcome: 'rejected',
        eventHeadDigest: events.at(-1)?.event_digest ?? null,
        controlHeadDigest: journal.at(-1)?.event_digest ?? null, activeEpoch: 1,
        unmet: [code, String(error?.message ?? error)] });
      return buildControlResponse(controlRequest, 'rejected', result,
        journal.at(-1)?.event_digest ?? null);
    }
    try {
      const begun = await requestStore.beginRequest(controlRequest);
      if (begun.disposition === 'completed') return begun.response;
      if (begun.disposition === 'in_progress') {
        throw new ManagedRuntimeError('RUN_OUTCOME_UNKNOWN', '同一request_idが処理中');
      }
      const response = await executeControl(controlRequest);
      return requestStore.completeRequest(controlRequest, response);
    } finally {
      await lock.release();
    }
  };
  server = await serveRuntimeControlSocket({ socketPath, handler });
  registerDaemonCleanup(async (signal) => {
    // 監視fdを残さない。取り残すとtest fixtureの後片付けが重くなる。
    sentinel?.close();
    sentinel = null;
    // **これは事故処理であって、正しい閉じ方ではない。** 正規の終了はabandon（破棄の決定）か
    // hold後の再開であり、そのどちらも通らずdaemonが落ちる時だけここへ来る。停止した
    // workerは自分では終われないので、記録から辿って道連れにする。
    await readBoundedJson(path.join(runDir, 'events.json'), 'run events')
      .then((events) => reapRunWorkerProcesses({ events })).catch(() => null);
    if (activationCommitted && activation !== null) {
      await appendControl({ run_id: request.request_id, kind: 'supervisor_stopped',
        session_nonce_digest: digestArtifact(sessionNonce), payload: { signal } });
    }
    await activation?.disposeController?.();
    await Promise.all(additionalActivations.map((entry) => entry.disposeController?.()));
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
    const active = await resolveActiveRuntimePaths({ runDir }).catch(() => null);
    if (active !== null) await rm(active.sessionPath, { force: true });
    await rm(path.join(supervisorDir, 'session'), { force: true });
  });
  onReady(socketPath);
  await new Promise((resolve) => server.once('close', resolve));
}

async function eventVerify({ runDir, stdout }) {
  const { events, compileArtifact } = await readRunStore(runDir);
  const chain = verifyRunEventChain({ events });
  const checks = [...chain.checks.map(({ id, passed }) => ({ id: `chain:${id}`, passed }))];
  // dispatch replay（保存planのepochのdecisionのみ。多epoch runは各epoch planを要する）。
  events.forEach((event, index) => {
    if (event.kind !== 'dispatch_decided') return;
    if (event.plan_epoch !== compileArtifact.plan.plan_epoch) return;
    const recomputed = computeReadyFrontier({
      plan: compileArtifact.plan,
      events: events.slice(0, index),
    });
    checks.push({
      id: `dispatch_replay:seq${event.sequence}`,
      passed: JSON.stringify(event.payload.dispatchable) === JSON.stringify(recomputed.dispatchable),
    });
  });
  const receiptCheck = recomputeReceiptDecisions({ plan: compileArtifact.plan, events });
  const acceptedFromEvents = projectRuntimeState({ events }).accepted;
  checks.push({
    id: 'receipt_replay',
    passed: receiptCheck.decisions
      .filter(({ decision }) => decision === 'accepted')
      .every(({ todo_id: todoId }) => acceptedFromEvents.includes(todoId)),
  });
  const failed = checks.filter(({ passed }) => !passed).map(({ id }) => id);
  const output = {
    schema: 'lattice.event_verification.v1',
    valid: failed.length === 0,
    checks_total: checks.length,
    failed_conditions: failed,
    events_digest: digestArtifact(events.map(({ event_digest: digest }) => digest)),
  };
  output.result_digest = digestArtifact(output);
  stdout.write(`${JSON.stringify(output)}\n`);
  if (failed.length > 0) {
    // ADR 0052 Decision 1: failed_conditionsはstdoutのevent_verification.v1が既に持つ＝detailで二重化しない。
    throw new CliContractError('EVENT_VERIFICATION_FAILED', 'event検証が失敗');
  }
  return 0;
}

/**
 * `--version`以外の全argvを受け、exit codeを返す（`doctor --json`はADR 0052で退役済み）。
 * exact argument contract: 位置・順序・件数の完全一致だけを受理する。
 */
export async function runRuntimeCli({ argv, cwd, stdout, stderr }) {
  if (!Array.isArray(argv) || typeof cwd !== 'string'
    || typeof stdout?.write !== 'function' || typeof stderr?.write !== 'function') {
    throw new TypeError('runRuntimeCli optionsが不正');
  }
  let requestIdOverride = null;
  if (argv.length >= 2 && argv.at(-2) === '--request-id') {
    if (!/^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/u.test(argv.at(-1) ?? '')) {
      return typedFailure(stderr, 'INVALID_REQUEST_ID', 'request-idは128文字以下の識別子でなければならない');
    }
    requestIdOverride = argv.at(-1);
    argv = argv.slice(0, -2);
    if (argv[0] !== 'run' || !['activate', 'close', 'abandon', 'conflict', 'hold', 'recompile', 'reprocess'].includes(argv[1])
      && !(argv[0] === 'run' && argv[1] === 'finding' && argv[2] === 'record')) {
      return typedFailure(stderr, 'INVALID_REQUEST_ID', '--request-idはrun mutationだけで指定できる');
    }
  }
  let action = null;
  if (argv.length === 4
    && argv[0] === 'plan' && argv[1] === 'compile'
    && argv[2] === '--schema' && argv[3] === '--json') {
    action = () => runRequestSchema({ stdout });
  } else if (argv.length === 5
    && argv[0] === 'run' && argv[1] === 'adapter' && argv[2] === 'register'
    && argv[3] === '--schema' && argv[4] === '--json') {
    action = () => runAdapterRegisterSchema({ stdout });
  } else if (argv.length === 9
    && argv[0] === 'run' && argv[1] === 'request' && argv[2] === 'synthesize'
    && argv[3] === '--witness' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--base-sha' && typeof argv[6] === 'string' && argv[6].length > 0
    && argv[7] === '--id' && typeof argv[8] === 'string' && argv[8].length > 0) {
    action = () => runRequestSynthesize({
      cwd, witnessPath: argv[4], baseSha: argv[6], requestId: argv[8], stdout,
    });
  } else if (argv.length === 5
    && argv[0] === 'run' && argv[1] === 'adapter' && argv[2] === 'register'
    && argv[3] === '--input' && typeof argv[4] === 'string' && argv[4].length > 0) {
    action = () => runAdapterRegister({
      cwd,
      inputPath: path.resolve(cwd, argv[4]),
      stdout,
    });
  } else if (argv.length === 4
    && argv[0] === 'run' && argv[1] === 'adapter' && argv[2] === 'list'
    && argv[3] === '--json') {
    action = () => runAdapterList({ cwd, stdout });
  } else if (argv.length === 4
    && argv[0] === 'run' && argv[1] === 'start'
    && argv[2] === '--schema' && argv[3] === '--json') {
    action = () => runRequestSchema({ stdout });
  } else if (argv.length === 4
    && argv[0] === 'plan' && argv[1] === 'compile' && argv[2] === '--request'
    && typeof argv[3] === 'string' && argv[3].length > 0) {
    action = () => planCompile({ requestPath: path.resolve(cwd, argv[3]), cwd, stdout });
  } else if (argv.length === 6
    && argv[0] === 'plan' && argv[1] === 'verify'
    && argv[2] === '--request' && typeof argv[3] === 'string' && argv[3].length > 0
    && argv[4] === '--plan' && typeof argv[5] === 'string' && argv[5].length > 0) {
    action = () => planVerify({
      requestPath: path.resolve(cwd, argv[3]),
      planPath: path.resolve(cwd, argv[5]),
      cwd,
      stdout,
    });
  } else if (argv.length === 6
    && argv[0] === 'run' && argv[1] === 'start'
    && argv[2] === '--request' && typeof argv[3] === 'string' && argv[3].length > 0
    && argv[4] === '--executor' && typeof argv[5] === 'string' && argv[5].length > 0) {
    action = () => runStart({
      requestPath: path.resolve(cwd, argv[3]),
      executorAdapter: argv[5],
      cwd,
      stdout,
    });
  } else if (argv.length === 10
    && argv[0] === 'run' && argv[1] === 'start'
    && argv[2] === '--selection' && argv[3] === 'pull'
    && argv[4] === '--id' && typeof argv[5] === 'string' && argv[5].length > 0
    && argv[6] === '--plan' && typeof argv[7] === 'string' && argv[7].length > 0
    && argv[8] === '--equipment' && argv[9] === 'detached-worktree') {
    action = () => runPullStart({
      runId: argv[5], planKey: argv[7], equipment: argv[9], cwd, stdout,
    });
  } else if (argv.length === 6
    && argv[0] === 'run' && argv[1] === 'intake'
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0
    && argv[4] === '--task' && typeof argv[5] === 'string' && argv[5].length > 0) {
    action = async () => {
      const { repoRoot, runDir } = await resolveRunStore(cwd, argv[3]);
      const output = await intakePullTask({ repoRoot, runDir, taskId: argv[5] });
      stdout.write(`${JSON.stringify(output)}\n`); return 0;
    };
  } else if (argv.length === 7
    && argv[0] === 'run' && argv[1] === 'intake' && argv[2] === 'accept'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--task' && typeof argv[6] === 'string' && argv[6].length > 0) {
    action = async () => {
      const { repoRoot, runDir } = await resolveRunStore(cwd, argv[4]);
      const output = await acceptPullTask({ repoRoot, runDir, taskId: argv[6] });
      stdout.write(`${JSON.stringify(output)}\n`); return 0;
    };
  } else if (argv.length === 7
    && argv[0] === 'run' && argv[1] === 'intake' && argv[2] === 'release'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--task' && typeof argv[6] === 'string' && argv[6].length > 0) {
    action = async () => {
      const { runDir } = await resolveRunStore(cwd, argv[4]);
      const output = await releasePullTask({ runDir, taskId: argv[6] });
      stdout.write(`${JSON.stringify(output)}\n`); return 0;
    };
  } else if (argv.length === 7
    && argv[0] === 'run' && argv[1] === 'intake' && argv[2] === 'detach'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--task' && typeof argv[6] === 'string' && argv[6].length > 0) {
    action = async () => {
      const { runDir } = await resolveRunStore(cwd, argv[4]);
      const output = await detachPullWorker({ runDir, taskId: argv[6] });
      stdout.write(`${JSON.stringify(output)}\n`); return 0;
    };
  } else if (argv.length === 9
    && argv[0] === 'run' && argv[1] === 'intake' && argv[2] === 'attach'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--task' && typeof argv[6] === 'string' && argv[6].length > 0
    && argv[7] === '--input' && typeof argv[8] === 'string' && argv[8].length > 0) {
    action = async () => {
      const { runDir } = await resolveRunStore(cwd, argv[4]);
      const input = await readBoundedJson(path.resolve(cwd, argv[8]), 'pull worker attach input');
      const output = await attachPullWorker({ runDir, taskId: argv[6], input });
      stdout.write(`${JSON.stringify(output)}\n`); return 0;
    };
  } else if (argv.length === 7
    && argv[0] === 'run' && argv[1] === 'intake' && argv[2] === 'intervention'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--task' && typeof argv[6] === 'string' && argv[6].length > 0) {
    action = async () => {
      const { runDir } = await resolveRunStore(cwd, argv[4]);
      const output = await interventionPullTask(runDir, argv[6]);
      stdout.write(`${JSON.stringify(output)}\n`); return 0;
    };
  } else if (argv.length === 4
    && argv[0] === 'run' && argv[1] === 'activate'
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0) {
    action = async () => {
      if (process.platform === 'win32') {
        return typedFailure(
          stderr,
          'PLATFORM_UNSUPPORTED',
          'Lattice managed runtime v1 is POSIX-only; use WSL2 on Windows',
        );
      }
      const { repoRoot, runDir, runRef } = await resolveRunStore(cwd, argv[3]);
      await requireLegacyRunMode(runDir, 'activate');
      return runActivate({ runDir, runRef, repoRoot, stdout, requestId: requestIdOverride });
    };
  } else if (argv.length === 4
    && argv[0] === 'run' && ['observe', 'status', 'resume', 'landing', 'close'].includes(argv[1])
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0) {
    action = async () => {
      const { repoRoot, runDir } = await resolveRunStore(cwd, argv[3]);
      if (argv[1] === 'observe') return runObserve({ runDir, stdout });
      if (argv[1] === 'status') return runStatus({ runDir, stdout });
      if (argv[1] === 'resume') {
        if ((await inspectRunMode(runDir)).mode === 'pull') {
          throw new PullRunError('RUN_MODE_MISMATCH', 'pull runはresumeでleaseを再認可しない');
        }
        return runResume({ runDir, repoRoot, stdout });
      }
      if (argv[1] === 'landing') return runLanding({ runDir, repoRoot, stdout });
      return runClose({ runDir, repoRoot, stdout, requestId: requestIdOverride });
    };
  } else if (argv.length === 6
    && argv[0] === 'run' && argv[1] === 'abandon'
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0
    && argv[4] === '--reason' && typeof argv[5] === 'string') {
    action = async () => {
      const { runDir } = await resolveRunStore(cwd, argv[3]);
      await requireLegacyRunMode(runDir, 'abandon');
      return runAbandon({ runDir, runRef: argv[3], reason: argv[5], stdout,
        requestId: requestIdOverride });
    };
  } else if (argv.length === 6
    && argv[0] === 'run' && argv[1] === 'conflict'
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0
    && argv[4] === '--finding' && /^[0-9a-f]{64}$/u.test(argv[5])) {
    action = async () => {
      const { runDir, runRef } = await resolveRunStore(cwd, argv[3]);
      await requireLegacyRunMode(runDir, 'conflict');
      return runManagedControl({
        runDir, runRef, operation: 'conflict', artifactDigest: argv[5], stdout,
        requestId: requestIdOverride,
      });
    };
  } else if (argv.length === 9
    && argv[0] === 'run' && argv[1] === 'seam' && argv[2] === 'profile'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--finding' && /^[0-9a-f]{64}$/u.test(argv[6])
    && argv[7] === '--input' && typeof argv[8] === 'string' && argv[8].length > 0) {
    action = async () => {
      const { repoRoot, runDir } = await resolveRunStore(cwd, argv[4]);
      await requireLegacyRunMode(runDir, 'seam profile');
      return runSeamProfile({ runDir, repoRoot, findingDigest: argv[6],
        inputPath: path.resolve(cwd, argv[8]), stdout });
    };
  } else if (argv.length === 9
    && argv[0] === 'run' && argv[1] === 'seam' && argv[2] === 'resolve'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--finding' && /^[0-9a-f]{64}$/u.test(argv[6])
    && argv[7] === '--input' && typeof argv[8] === 'string' && argv[8].length > 0) {
    action = async () => {
      const { repoRoot, runDir } = await resolveRunStore(cwd, argv[4]);
      await requireLegacyRunMode(runDir, 'seam resolve');
      return runSeamResolve({ runDir, repoRoot, findingDigest: argv[6],
        requestPath: path.resolve(cwd, argv[8]), stdout });
    };
  } else if (argv.length === 8
    && argv[0] === 'run' && argv[1] === 'finding' && argv[2] === 'record'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--checkpoint' && /^[0-9a-f]{64}$/u.test(argv[6])
    && argv[7] === '--input') {
    // exact argvにはinput valueが必要なため、この8要素形は必ずusage拒否される。
    action = null;
  } else if (argv.length === 9
    && argv[0] === 'run' && argv[1] === 'finding' && argv[2] === 'record'
    && argv[3] === '--run' && typeof argv[4] === 'string' && argv[4].length > 0
    && argv[5] === '--checkpoint' && /^[0-9a-f]{64}$/u.test(argv[6])
    && argv[7] === '--input' && typeof argv[8] === 'string' && argv[8].length > 0) {
    action = async () => {
      const { runDir, runRef } = await resolveRunStore(cwd, argv[4]);
      await requireLegacyRunMode(runDir, 'finding record');
      if (await readCommittedEpochStore(runDir) === null) {
        throw new CliContractError('RUN_NOT_MANAGED', 'runがmanaged storeへactivateされていない');
      }
      const artifact = await readBoundedJson(path.resolve(cwd, argv[8]), 'runtime finding candidate');
      return runManagedControl({ runDir, runRef, operation: 'finding_record', artifact,
        artifactDigest: digestArtifact(artifact), checkpointDigest: argv[6], stdout,
        requestId: requestIdOverride });
    };
  } else if (argv.length === 6
    && argv[0] === 'run' && argv[1] === 'recompile'
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0
    && argv[4] === '--input' && typeof argv[5] === 'string' && argv[5].length > 0) {
    action = async () => {
      const { runDir, runRef } = await resolveRunStore(cwd, argv[3]);
      await requireLegacyRunMode(runDir, 'recompile');
      if (await readCommittedEpochStore(runDir) === null) {
        throw new CliContractError('RUN_NOT_MANAGED', 'runがmanaged storeへactivateされていない');
      }
      const artifact = await readBoundedJson(path.resolve(cwd, argv[5]), 'runtime recompile request');
      return runManagedControl({ runDir, runRef, operation: 'recompile', artifact,
        artifactDigest: digestArtifact(artifact), stdout, requestId: requestIdOverride });
    };
  } else if (argv.length === 4
    && argv[0] === 'run' && ['hold', 'reprocess'].includes(argv[1])
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0) {
    action = async () => {
      const { runDir, runRef } = await resolveRunStore(cwd, argv[3]);
      await requireLegacyRunMode(runDir, argv[1]);
      return runManagedControl({
        runDir, runRef, operation: argv[1], artifactDigest: null, stdout,
        requestId: requestIdOverride,
      });
    };
  } else if (argv.length === 3
    && argv[0] === 'run' && argv[1] === 'list' && argv[2] === '--json') {
    action = () => runList({ cwd, stdout });
  } else if (argv.length === 4
    && argv[0] === 'event' && argv[1] === 'verify'
    && argv[2] === '--run' && typeof argv[3] === 'string' && argv[3].length > 0) {
    action = async () => {
      const { runDir } = await resolveRunStore(cwd, argv[3]);
      await requireLegacyRunMode(runDir, 'event verify');
      return eventVerify({ runDir, stdout });
    };
  }
  if (action === null) return usageFailure(stderr, argv);
  try {
    return await action();
  } catch (error) {
    if (error instanceof CliContractError) {
      return typedFailure(stderr, error.code, error.message, error.detail);
    }
    if (error instanceof TypeError) {
      return typedFailure(stderr, 'CONTRACT_VIOLATION', error.message);
    }
    if (error instanceof RuntimeEpochStoreError) {
      return typedFailure(stderr, error.code, error.message, error.detail);
    }
    if (error instanceof AdapterRegistryError) {
      return typedFailure(stderr, error.code, error.message, error.detail);
    }
    if (error instanceof ManagedRuntimeError) {
      return typedFailure(stderr, error.code, error.message);
    }
    if (error instanceof PullRunError || error instanceof TodoStoreError
      || error instanceof RuntimeDriverStateError
      || error instanceof RuntimeLifecycleLockError) {
      return typedFailure(stderr, error.code, error.message, error.detail);
    }
    throw error;
  }
}
