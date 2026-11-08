import net from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalizeArtifact, digestArtifact } from './artifact-contracts.mjs';
import { selfDigest } from './runtime-contracts.mjs';
import { captureWorktreeDiff } from './runtime-diff-observer.mjs';
import { pidsOwningSocketPath, socketPathsOwnedByPid } from './runtime-socket-owner.mjs';
import { createDirectOsProcessObserver as createDirectOsProcessObserverV2 } from './runtime-direct-os-observer.mjs';
import { observeExecutablePath, observeStartIdentityRaw, osObservationEnvironment } from './runtime-os-observation.mjs';
import {
  armStagedWriteLease,
  createControllerBootstrap,
  createControllerRequest,
  createWriteGate,
  validateArmedWriteLease,
  validateAdapterLaunchDescriptor,
  validateAdapterRegistry,
  validateControllerDescriptor,
  validateControllerError,
  validateControllerHeartbeat,
  validateControllerRegistration,
  validateControllerResponse,
  validateControllerHandshakeResponse,
  validateEpochRebindAck,
  validateProcessStartIdentity,
  validateQuiescenceAck,
  validateReleaseAck,
  validateRuntimeControlRequest,
  validateRuntimeControlResponse,
  validateStagedWriteLease,
  verifyCentralWriteGate,
} from './runtime-controller-protocol.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/;

export class ManagedRuntimeError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'ManagedRuntimeError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail) { throw new ManagedRuntimeError(code, detail); }
function digest(value) { return typeof value === 'string' && SHA256.test(value); }
function identifier(value) { return typeof value === 'string' && ID.test(value); }
function monotonicDefault() { return Number(process.hrtime.bigint() / 1_000_000n); }
function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const execFileAsync = promisify(execFile);

export async function observeManagedProcessStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    fail('ADAPTER_CONTROLLER_UNAVAILABLE', `process start identity観測失敗: ${pid}`);
  }
  let startedIdentity;
  try {
    startedIdentity = await observeStartIdentityRaw(pid);
  } catch (error) {
    const cause = String(error?.stderr ?? '').trim() || error?.message || 'unknown';
    fail('ADAPTER_CONTROLLER_UNAVAILABLE', `process start identity観測失敗: pid=${pid}, 観測コマンドの失敗=${cause}`);
  }
  if (!startedIdentity) fail('ADAPTER_CONTROLLER_UNAVAILABLE', `process不在: ${pid}`);
  const identity = { schema: 'lattice.process_start_identity.v1', platform: process.platform, pid, started_identity: startedIdentity, identity_digest: '' };
  identity.identity_digest = selfDigest(identity, 'identity_digest');
  return identity;
}

export async function observeMacosBinaryIdentity(binaryPath) {
  if (process.platform !== 'darwin') fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'macOS codesign identityはdarwin専用');
  let output;
  try {
    const observed = await execFileAsync('/usr/bin/codesign',
      ['-d', '--verbose=4', '--requirements', '-', binaryPath], { encoding: 'utf8' });
    output = `${observed.stdout ?? ''}\n${observed.stderr ?? ''}`;
  } catch (error) {
    output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
    if (!output.trim()) fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'codesign identity観測失敗');
  }
  const field = (name) => output.match(new RegExp(`(?:^|\\n)${name}=([^\\n]+)`, 'u'))?.[1]?.trim() ?? '';
  const requirement = output.match(/(?:^|\n)#?\s*designated => ([^\n]+)/u)?.[1]?.trim() ?? '';
  const rawCdhash = (output.match(/(?:^|\n)CandidateCDHashFull sha256=([0-9a-f]+)/u)?.[1]
    ?? field('CDHash')).toLowerCase();
  if (!/^[0-9a-f]+$/u.test(rawCdhash) || !field('Identifier') || !requirement) {
    fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'codesign出力の必須identity不足');
  }
  const identity = {
    schema: 'lattice.macos_binary_identity.v1', kind: 'macos_codesign',
    cdhash: rawCdhash, signing_identifier: field('Identifier'),
    team_identifier: field('TeamIdentifier'),
    designated_requirement_digest: sha256Bytes(Buffer.from(requirement)), identity_digest: '',
  };
  identity.identity_digest = selfDigest(identity, 'identity_digest');
  return identity;
}

/**
 * 起動済みprocessが実際に実行しているimageのcanonical pathをOSから観測する。
 * bytesの同一性はcallerがlaunch descriptorのSHA-256と照合する。
 */
export async function observeProcessExecutablePath(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'exec後image PID不正');
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    fail('ADAPTER_BINARY_IDENTITY_MISMATCH', `exec後image path観測未対応platform: ${process.platform}`);
  }
  return observeExecutablePath(pid);
}

/** storeが解決したimmutable bindingからprocess/worktree/checkpointをDirect OSで再観測する。 */
/**
 * 本repositoryの現在状態を1つのdigestへ畳む。
 *
 * HEAD・作業ツリー状態（untracked／ignoredを含む）・全refを見る。workerがworktreeの外へ
 * 書いてもworktreeのdiffには映らないので、ここだけが本repositoryへの書き込みを捕まえる。
 */
export async function canonicalRepositoryFingerprint(repoRoot) {
  const parts = [];
  for (const args of [
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'],
    ['for-each-ref', '--format=%(refname) %(objectname)'],
  ]) {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    parts.push(stdout);
  }
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

export function createDirectOsProcessObserver({ resolveObservationBinding }) {
  if (typeof resolveObservationBinding !== 'function') fail('SUPERVISOR_CONFIGURATION_INVALID', 'observation binding resolverなし');
  return async ({ kind, binding, ack }) => {
    if (!['quiescence', 'rebind'].includes(kind)) fail('HOLD_ACKS_INCOMPLETE', '未知のDirect OS observation kind');
    const resolved = await resolveObservationBinding({ binding: structuredClone(binding), ack: structuredClone(ack) });
    if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)
      || !Number.isSafeInteger(resolved.process_pid) || resolved.process_pid < 1
      || !Number.isSafeInteger(resolved.process_group_id) || resolved.process_group_id < 1
      || typeof resolved.worktree_path !== 'string' || !path.isAbsolute(resolved.worktree_path)
      || typeof resolved.base_sha !== 'string' || !/^[0-9a-f]{40}$/.test(resolved.base_sha)
      || !validateProcessStartIdentity(resolved.process_start_identity)
      || resolved.process_start_identity.pid !== resolved.process_pid) fail('HOLD_ACKS_INCOMPLETE', 'observation binding不正');
    // 本repositoryを見る材料は対で渡す。片方だけでは照合できず、片方だけを受けると
    // 「検査した」と読める記録が検査なしで作れてしまう。
    const canonicalRoot = resolved.canonical_root ?? null;
    const canonicalBaseline = resolved.canonical_fingerprint_digest ?? null;
    if ((canonicalRoot === null) !== (canonicalBaseline === null)
      || (canonicalRoot !== null && !path.isAbsolute(canonicalRoot))
      || (canonicalBaseline !== null && !/^[0-9a-f]{64}$/u.test(canonicalBaseline))) {
      fail('HOLD_ACKS_INCOMPLETE', 'canonical repository観測bindingが不正');
    }
    let processState = 'exited';
    let observedIdentity = resolved.process_start_identity;
    let processGroupId = resolved.process_group_id;
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=,pgid=,state=', '-p', String(resolved.process_pid)], { encoding: 'utf8', env: osObservationEnvironment() });
      const line = stdout.trim();
      if (line) {
        const match = line.match(/^(.*\d{4})\s+(\d+)\s+(\S+)$/);
        if (!match) fail('HOLD_ACKS_INCOMPLETE', 'process observation parse失敗');
        observedIdentity = { schema: 'lattice.process_start_identity.v1', platform: process.platform, pid: resolved.process_pid, started_identity: match[1].trim(), identity_digest: '' };
        observedIdentity.identity_digest = selfDigest(observedIdentity, 'identity_digest');
        if (observedIdentity.identity_digest !== resolved.process_start_identity.identity_digest) fail('HOLD_ACKS_INCOMPLETE', 'PID再利用又はstart identity差替え');
        processGroupId = Number(match[2]);
        if (processGroupId !== resolved.process_group_id) fail('HOLD_ACKS_INCOMPLETE', 'process group差替え');
        processState = match[3].startsWith('T') ? 'stopped' : 'running';
      }
    } catch (error) {
      if (error instanceof ManagedRuntimeError) throw error;
      processState = 'exited';
    }
    if (!['stopped', 'exited'].includes(processState)) fail('HOLD_ACKS_INCOMPLETE', 'executor processがquiescedでない');
    try {
      const { stdout: groupStdout } = await execFileAsync('/bin/ps', ['-o', 'pid=,state=', '-g', String(resolved.process_group_id)], { encoding: 'utf8', env: osObservationEnvironment() });
      for (const line of groupStdout.trim().split('\n').filter(Boolean)) {
        const match = line.trim().match(/^(\d+)\s+(\S+)$/);
        if (!match || (!match[2].startsWith('T') && !match[2].startsWith('Z'))) fail('HOLD_ACKS_INCOMPLETE', 'process group childがquiescedでない');
      }
    } catch (error) {
      if (error instanceof ManagedRuntimeError) throw error;
      if (!(error?.code === 1 && String(error?.stdout ?? '').trim() === '')) {
        fail('HOLD_ACKS_INCOMPLETE', 'process group直接観測失敗');
      }
      // exit 1かつ出力空だけをgroup消滅済みと解釈する。
    }
    const worktreeInfo = await lstat(resolved.worktree_path);
    if (!worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink()) fail('HOLD_ACKS_INCOMPLETE', 'worktreeがreal directoryでない');
    const worktreeRealpath = await realpath(resolved.worktree_path);
    if (worktreeRealpath !== resolved.worktree_path) fail('HOLD_ACKS_INCOMPLETE', 'worktree path差替え');
    const checkpoint = await captureWorktreeDiff({ worktreePath: worktreeRealpath, baseSha: resolved.base_sha });
    const processObservation = { schema: 'lattice.direct_process_observation.v1', pid: resolved.process_pid, process_start_identity_digest: observedIdentity.identity_digest, process_group_id: processGroupId, state: processState };
    const processObservationDigest = digestArtifact(processObservation);
    // worktreeの外——本repository——への書き込みは、worktreeのdiffにはまったく映らない。
    // 見ていないことを「変更が無かった」と読ませないため、検査したかどうかを記録へ残す
    // （ADR 0140）。渡されていなければ`null`＝未検査であり、無変更の主張ではない。
    let canonicalDigest = null;
    if (canonicalRoot !== null) {
      canonicalDigest = await canonicalRepositoryFingerprint(canonicalRoot);
      if (canonicalDigest !== canonicalBaseline) {
        fail('HOLD_ACKS_INCOMPLETE', 'canonical repositoryがworker実行中に変化した');
      }
    }
    const worktreeFingerprint = { schema: 'lattice.direct_worktree_fingerprint.v2', worktree_id: binding?.worktree_id ?? ack.worktree_id, worktree_realpath: worktreeRealpath, checkpoint_digest: checkpoint.checkpoint_digest, canonical_fingerprint_digest: canonicalDigest };
    const worktreeFingerprintDigest = digestArtifact(worktreeFingerprint);
    return {
      quiesced: true,
      process_observation_digest: processObservationDigest,
      worktree_fingerprint_digest: worktreeFingerprintDigest,
      final_checkpoint_digest: checkpoint.checkpoint_digest,
      observation: processObservation,
      worktree_fingerprint: worktreeFingerprint,
      checkpoint,
      write_enabled: false,
    };
  };
}

async function readCanonicalRegular(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) fail('ADAPTER_LAUNCH_INVALID', `regular fileでない: ${filePath}`);
  const bytes = await readFile(filePath);
  let value;
  try { value = JSON.parse(bytes); } catch { fail('ADAPTER_LAUNCH_INVALID', `JSON不正: ${filePath}`); }
  if (bytes.toString('utf8') !== `${canonicalizeArtifact(value)}\n`) fail('ADAPTER_LAUNCH_INVALID', `canonical bytesでない: ${filePath}`);
  return { value, bytes };
}

function validateRunningBinding(value) {
  const fields = ['todo_id', 'executor_handle', 'worktree_id', 'plan_epoch', 'packet_digest', 'write_lease_id', 'controller_registration_digest'];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === fields.sort().join('\0')
    && identifier(value.todo_id) && identifier(value.executor_handle) && identifier(value.worktree_id)
    && Number.isSafeInteger(value.plan_epoch) && value.plan_epoch > 0
    && digest(value.packet_digest) && identifier(value.write_lease_id)
    && digest(value.controller_registration_digest);
}

/**
 * ADR 0064のcontrol plane本体。永続化はcallerが渡すjournal/gateWriterへ明示委譲し、
 * controller transportとOS再観測なしには停止・再認可を成功扱いしない。
 */
export class RuntimeManagedSupervisor {
  #runId;
  #sessionNonceDigest;
  #clock;
  #processObserver;
  #runningBindingResolver;
  #journal;
  #gateWriter;
  #shutdownFinalizer;
  #controllers = new Map();
  #registrationToController = new Map();
  #leases = new Map();
  #gate = null;
  #previousGate = null;
  #releaseAcks = [];
  #gateRecords = new Map();
  #frozen = false;
  #gateGeneration = 0;

  constructor({ runId, sessionNonceDigest, clock = monotonicDefault, processObserver, runningBindingResolver, journal, gateWriter, shutdownFinalizer = async () => {} }) {
    if (!identifier(runId) || !digest(sessionNonceDigest) || typeof clock !== 'function'
      || typeof processObserver !== 'function' || typeof runningBindingResolver !== 'function'
      || typeof journal?.append !== 'function'
      || typeof gateWriter?.commit !== 'function' || typeof shutdownFinalizer !== 'function') fail('SUPERVISOR_CONFIGURATION_INVALID', 'durable dependencyが不足');
    this.#runId = runId;
    this.#sessionNonceDigest = sessionNonceDigest;
    this.#clock = clock;
    this.#processObserver = processObserver;
    this.#runningBindingResolver = runningBindingResolver;
    this.#journal = journal;
    this.#gateWriter = gateWriter;
    this.#shutdownFinalizer = shutdownFinalizer;
  }

  async hydrateCommittedGate() {
    if (typeof this.#gateWriter.read !== 'function') return null;
    const committed = await this.#gateWriter.read();
    if (committed === null) return null;
    if (committed.gate.run_id !== this.#runId
      || !Number.isSafeInteger(committed.gate.gate_generation)
      || committed.gate.gate_generation < 1) {
      fail('EPOCH_ACTIVATION_INCOMPLETE', 'persisted gate generation binding不正');
    }
    this.#gate = structuredClone(committed.gate);
    this.#gateGeneration = committed.gate.gate_generation;
    return structuredClone(committed.gate);
  }

  get runId() { return this.#runId; }
  get frozen() { return this.#frozen; }
  get gate() { return this.#gate === null ? null : structuredClone(this.#gate); }

  async registerController({ descriptor, registration, transport }) {
    if (!validateControllerDescriptor(descriptor) || !validateControllerRegistration(registration)
      || registration.run_id !== this.#runId
      || registration.supervisor_session_nonce_digest !== this.#sessionNonceDigest
      || registration.controller_descriptor_digest !== descriptor.descriptor_digest
      || typeof transport?.request !== 'function') fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'controller registration binding不正');
    if (this.#controllers.has(descriptor.controller_id)
      || this.#registrationToController.has(registration.registration_digest)) fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'controller二重登録');
    const now = this.#clock();
    const record = { descriptor: structuredClone(descriptor), registration: structuredClone(registration),
      transport, lastHeartbeat: now, lastHeartbeatSequence: 0,
      lastRecordedLeaseSetDigest: null, connected: true, revoked: false };
    this.#controllers.set(descriptor.controller_id, record);
    this.#registrationToController.set(registration.registration_digest, descriptor.controller_id);
    await this.#append('controller_registered', { controller_id: descriptor.controller_id, registration_digest: registration.registration_digest });
    return structuredClone(registration);
  }

  async heartbeat({ controllerId, registrationDigest, sequence, leaseSetDigest, sessionNonceDigest }) {
    const record = this.#requireController(controllerId);
    if (!record.connected || sessionNonceDigest !== this.#sessionNonceDigest
      || registrationDigest !== record.registration.registration_digest
      || !Number.isSafeInteger(sequence) || sequence <= record.lastHeartbeatSequence || !digest(leaseSetDigest)) {
      await this.#failClosed(record, 'CONTROLLER_HEARTBEAT_EXPIRED', 'heartbeat binding不正');
    }
    // prepare/release応答とsupervisor投影の間には短い非同期窓がある。heartbeatは
    // livenessだけを担い、lease集合はwrite認可時のcentral gate full-chainで照合する。
    record.lastHeartbeat = this.#clock();
    record.lastHeartbeatSequence = sequence;
    // heartbeatはlivenessの更新であり、同じlease集合のtickを全件journalへ積む必要はない。
    // 初回とlease集合の変化だけを耐久記録し、壁時計に比例するjournal成長を止める。
    if (record.lastRecordedLeaseSetDigest !== leaseSetDigest) {
      await this.#append('controller_heartbeat', { controller_id: controllerId,
        registration_digest: registrationDigest, sequence, lease_set_digest: leaseSetDigest });
      record.lastRecordedLeaseSetDigest = leaseSetDigest;
    }
  }

  async disconnect(controllerId) {
    const record = this.#requireController(controllerId);
    record.connected = false;
    await this.#failClosed(record, 'CONTROLLER_HEARTBEAT_EXPIRED', 'controller socket disconnected');
  }

  async assertControllerHealth() {
    for (const record of this.#controllers.values()) {
      const age = this.#clock() - record.lastHeartbeat;
      if (!record.connected || age < 0 || age > record.descriptor.heartbeat.ttl_ms) {
        await this.#failClosed(record, 'CONTROLLER_HEARTBEAT_EXPIRED', 'heartbeat TTL超過');
      }
    }
  }

  async route(operation, controllerId, fields) {
    await this.assertControllerHealth();
    if (this.#frozen && ['dispatch', 'observe'].includes(operation)) fail('RUN_FROZEN', 'freeze中のroute');
    const record = this.#requireController(controllerId);
    const request = createControllerRequest(operation, {
      request_id: fields.request_id ?? randomUUID(),
      registration_digest: record.registration.registration_digest,
      ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['request_id', 'registration_digest'].includes(key))),
    });
    const response = await record.transport.request(operation, structuredClone(request));
    if (!validateControllerResponse(operation, response, request.request_id)) {
      await this.#failClosed(record, 'ADAPTER_CONTROLLER_UNAVAILABLE', `${operation} response不正`);
    }
    // running pollは状態遷移ではない。全tickを耐久化すると長寿命workerほどcontrol journalを
    // 膨らませ、artifact document上限でsupervisor自身を落とす。dispatchと非running観測だけを残す。
    if (operation === 'dispatch' || response.observation?.state !== 'running') {
      await this.#append(operation === 'dispatch' ? 'dispatch_routed' : 'observation_routed', {
        controller_id: controllerId, request_digest: request.request_digest,
        response_digest: response.response_digest,
      });
    }
    return structuredClone(response);
  }

  /** 全running bindingを一件も省略せずbarrierし、controller ackと独立OS観測を照合する。 */
  async barrierAll({ barrierId, reason, frozenEventDigest }) {
    return this.#barrier({ barrierId, reason, frozenEventDigest, targetTodoIds: null });
  }

  /** findingの影響群だけを静止し、無関係なrunning bindingはそのまま通す。 */
  async barrierSelected({ barrierId, reason, frozenEventDigest, todoIds }) {
    if (!Array.isArray(todoIds) || todoIds.length === 0
      || todoIds.some((todoId) => !identifier(todoId))
      || new Set(todoIds).size !== todoIds.length) {
      fail('HOLD_ACKS_INCOMPLETE', '対象barrierのTODO集合が不正');
    }
    return this.#barrier({ barrierId, reason, frozenEventDigest,
      targetTodoIds: new Set(todoIds) });
  }

  async #barrier({ barrierId, reason, frozenEventDigest, targetTodoIds }) {
    const durableBindings = await this.#runningBindingResolver({ runId: this.#runId, frozenEventDigest });
    if (!identifier(barrierId) || typeof reason !== 'string' || reason.length === 0
      || !digest(frozenEventDigest) || !Array.isArray(durableBindings)
      || !durableBindings.every(validateRunningBinding)) fail('HOLD_ACKS_INCOMPLETE', 'durable running binding不正');
    await this.assertControllerHealth();
    this.#frozen = true;
    const allRunningBindings = await this.#resolveRunningUnion({ durableBindings, frozenEventDigest });
    const runningBindings = targetTodoIds === null ? allRunningBindings
      : allRunningBindings.filter((binding) => targetTodoIds.has(binding.todo_id));
    const unique = new Set(runningBindings.map((binding) => binding.todo_id));
    if (unique.size !== runningBindings.length) fail('HOLD_ACKS_INCOMPLETE', 'running TODO重複');
    const barrierControlDigest = await this.#append('barrier_requested', { barrier_id: barrierId,
      reason, running_count: runningBindings.length,
      running_todo_ids: runningBindings.map((binding) => binding.todo_id).sort(),
      frozen_event_digest: frozenEventDigest });
    if (!digest(barrierControlDigest)) fail('HOLD_ACKS_INCOMPLETE', 'barrier control event未耐久化');
    const acknowledgements = [];
    for (const record of this.#controllers.values()) {
      const owned = runningBindings.filter((binding) => binding.controller_registration_digest === record.registration.registration_digest);
      if (owned.length === 0) continue;
      const response = await this.routeWhileFrozen('barrier', record, {
        request_id: randomUUID(), barrier_id: barrierId, reason,
        running_bindings: owned, frozen_event_digest: frozenEventDigest,
        barrier_control_digest: barrierControlDigest,
      });
      if (response.barrier_id !== barrierId || !Array.isArray(response.quiescence_acks)
        || response.quiescence_acks.length !== owned.length) fail('HOLD_ACKS_INCOMPLETE', 'barrier ack件数不一致');
      for (const binding of owned) {
        const ack = response.quiescence_acks.find((candidate) => candidate.todo_id === binding.todo_id);
        if (!validateQuiescenceAck(ack) || ack.run_id !== this.#runId
          || ack.executor_handle !== binding.executor_handle || ack.worktree_id !== binding.worktree_id
          || ack.plan_epoch !== binding.plan_epoch || ack.packet_digest !== binding.packet_digest
          || ack.write_lease_id !== binding.write_lease_id
          || ack.barrier_control_digest !== barrierControlDigest
          || ack.supervisor_session_nonce_digest !== this.#sessionNonceDigest) fail('HOLD_ACKS_INCOMPLETE', `ack binding不一致: ${binding.todo_id}`);
        const observed = await this.#processObserver({ kind: 'quiescence', binding: structuredClone(binding), ack: structuredClone(ack), descriptor: structuredClone(record.descriptor) });
        if (observed?.process_observation_digest !== ack.process_observation_digest
          || observed?.worktree_fingerprint_digest !== ack.worktree_fingerprint_digest
          || observed?.final_checkpoint_digest !== ack.final_checkpoint_digest
          || observed?.quiesced !== true) fail('HOLD_ACKS_INCOMPLETE', `直接再観測不一致: ${binding.todo_id}`);
        acknowledgements.push(ack);
        const directObservation = structuredClone(observed);
        await this.#append('executor_quiesced', { barrier_id: barrierId,
          barrier_control_digest: barrierControlDigest, todo_id: binding.todo_id,
          ack: structuredClone(ack), direct_observation: directObservation,
          evidence_digest: digestArtifact({ ack, direct_observation: directObservation }) });
      }
    }
    if (acknowledgements.length !== runningBindings.length) fail('HOLD_ACKS_INCOMPLETE', '未登録controller所有bindingあり');
    const observedAfterBarrier = await this.#collectControllerRunning({ frozenEventDigest });
    const residualBindings = targetTodoIds === null ? observedAfterBarrier
      : observedAfterBarrier.filter((binding) => targetTodoIds.has(binding.todo_id));
    if (residualBindings.length !== 0) {
      fail('HOLD_ACKS_INCOMPLETE', `barrier後もrunning executor残存: ${residualBindings.map((binding) => binding.todo_id).join(',')}`);
    }
    return acknowledgements.map((ack) => structuredClone(ack));
  }

  /** durable storeと全controllerの直接inventoryをexact binding単位で和集合にする。 */
  async #resolveRunningUnion({ durableBindings, frozenEventDigest }) {
    const observedBindings = await this.#collectControllerRunning({ frozenEventDigest });
    const union = new Map();
    const executorOwners = new Map();
    for (const binding of [...durableBindings, ...observedBindings]) {
      const controllerId = this.#registrationToController.get(binding.controller_registration_digest);
      if (controllerId === undefined) fail('HOLD_ACKS_INCOMPLETE', `未登録controller binding: ${binding.todo_id}`);
      const canonical = canonicalizeArtifact(binding);
      const prior = union.get(binding.todo_id);
      if (prior !== undefined && prior.canonical !== canonical) {
        fail('HOLD_ACKS_INCOMPLETE', `durable/controller running binding不一致: ${binding.todo_id}`);
      }
      const executorOwner = executorOwners.get(binding.executor_handle);
      if (executorOwner !== undefined && executorOwner !== binding.todo_id) {
        fail('HOLD_ACKS_INCOMPLETE', `executor handle重複: ${binding.executor_handle}`);
      }
      union.set(binding.todo_id, { canonical, binding: structuredClone(binding) });
      executorOwners.set(binding.executor_handle, binding.todo_id);
    }
    return [...union.values()].map(({ binding }) => binding)
      .sort((left, right) => left.todo_id < right.todo_id ? -1 : left.todo_id > right.todo_id ? 1 : 0);
  }

  async #collectControllerRunning({ frozenEventDigest }) {
    const observed = [];
    for (const record of this.#controllers.values()) {
      const response = await this.routeWhileFrozen('inventory', record, {
        request_id: randomUUID(), frozen_event_digest: frozenEventDigest,
      });
      if (response.inventory_digest !== digestArtifact(response.running_bindings)
        || response.running_bindings.some((binding) => (
          binding.controller_registration_digest !== record.registration.registration_digest))) {
        fail('HOLD_ACKS_INCOMPLETE', `controller inventory binding不一致: ${record.descriptor.controller_id}`);
      }
      observed.push(...response.running_bindings.map((binding) => structuredClone(binding)));
    }
    return observed;
  }

  /** finding/store永続化後に呼ぶtyped hold閉路。対象群のquiescence完了後だけheldを返す。 */
  async holdConflict({ findingDigest, frozenEventDigest, barrierId, reason, recordedAt,
    todoIds = null }) {
    if (!digest(findingDigest) || typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) fail('FINDING_UNRESOLVED', 'hold finding binding不正');
    const acknowledgements = todoIds === null
      ? await this.barrierAll({ barrierId, reason, frozenEventDigest })
      : await this.barrierSelected({ barrierId, reason, frozenEventDigest,
        todoIds });
    const result = {
      schema: 'lattice.runtime_hold_result.v1', run_id: this.#runId,
      finding_digest: findingDigest, barrier_id: barrierId,
      quiescence_ack_digests: acknowledgements.map((ack) => ack.ack_digest).sort(),
      outcome: 'held', recorded_at: recordedAt, result_digest: '',
    };
    result.result_digest = selfDigest(result, 'result_digest');
    return result;
  }

  async shutdownManaged({ mode, reason, barrierId, frozenEventDigest, recordedAt }) {
    if (!['close', 'abandon'].includes(mode) || typeof reason !== 'string' || reason.length === 0
      || typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) fail('MANAGED_SHUTDOWN_INCOMPLETE', 'shutdown入力不正');
    const acknowledgements = await this.barrierAll({ barrierId, reason: `managed_${mode}:${reason}`, frozenEventDigest });
    for (const record of this.#controllers.values()) {
      const owned = [...this.#leases.values()].filter((entry) => entry.controllerId === record.descriptor.controller_id && !entry.revoked);
      const leaseDigests = owned.map((entry) => entry.lease.lease_digest).sort();
      const response = await this.routeWhileFrozen('revoke', record, { request_id: randomUUID(), reason, lease_digests: leaseDigests });
      if (JSON.stringify(response.revoked_lease_digests) !== JSON.stringify(leaseDigests)
        || response.residual_processes.length !== 0) fail('MANAGED_SHUTDOWN_INCOMPLETE', 'controller revoke不完全');
      for (const entry of owned) entry.revoked = true;
      await this.#append('lease_revoked', { controller_id: record.descriptor.controller_id, reason });
    }
    await this.#shutdownFinalizer();
    const result = { schema: 'lattice.runtime_shutdown_result.v1', run_id: this.#runId, mode, outcome: 'quiesced', quiescence_ack_digests: acknowledgements.map((ack) => ack.ack_digest).sort(), recorded_at: recordedAt, result_digest: '' };
    result.result_digest = selfDigest(result, 'result_digest');
    return result;
  }

  async rebindController({ controllerId, rebindPacket, stagedLease, expected }) {
    const record = this.#requireController(controllerId);
    if (!this.#frozen) fail('EPOCH_REBIND_INCOMPLETE', 'freeze外rebind');
    const response = await this.routeWhileFrozen('rebind', record, {
      request_id: randomUUID(), rebind_packet: rebindPacket, staged_lease: stagedLease,
    });
    if (response.staged_lease_digest !== stagedLease.lease_digest) fail('EPOCH_REBIND_INCOMPLETE', 'staged lease response不一致');
    const controlEventDigest = await this.#acceptRebindAck({ controllerId,
      ack: response.rebind_ack, stagedLease, expected });
    return { ack: structuredClone(response.rebind_ack), control_event_digest: controlEventDigest };
  }

  /** affected successorを実行不能なstaged leaseのままprepareする。 */
  async prepareController({ controllerId, executorPacket, stagedLease }) {
    const record = this.#requireController(controllerId);
    if (!this.#frozen || !validateStagedWriteLease(stagedLease)
      || stagedLease.run_id !== this.#runId || stagedLease.state !== 'staged'
      || stagedLease.todo_id !== executorPacket?.todo_id
      || stagedLease.packet_digest !== executorPacket?.packet_digest
      || stagedLease.controller_registration_digest !== record.registration.registration_digest) {
      fail('EPOCH_REBIND_INCOMPLETE', 'prepare staged binding不正');
    }
    const response = await this.routeWhileFrozen('prepare', record, {
      request_id: randomUUID(), executor_packet: executorPacket, staged_lease: stagedLease,
    });
    const ack = response.prepare_ack;
    if (response.staged_lease_digest !== stagedLease.lease_digest
      || ack.run_id !== this.#runId || ack.todo_id !== executorPacket.todo_id
      || ack.plan_epoch !== executorPacket.plan_epoch
      || ack.packet_digest !== executorPacket.packet_digest
      || ack.staged_lease_digest !== stagedLease.lease_digest
      || ack.registration_digest !== record.registration.registration_digest
      || ack.controller_id !== controllerId
      || ack.supervisor_session_nonce_digest !== this.#sessionNonceDigest) {
      fail('EPOCH_REBIND_INCOMPLETE', 'direct prepare ack不一致');
    }
    this.#leases.set(stagedLease.lease_digest, { lease: structuredClone(stagedLease),
      controllerId, issuedAt: this.#clock(), revoked: false });
    return structuredClone(ack);
  }

  async #acceptRebindAck({ controllerId, ack, stagedLease, expected }) {
    const record = this.#requireController(controllerId);
    if (!this.#frozen || !validateEpochRebindAck(ack) || !validateStagedWriteLease(stagedLease)
      || ack.run_id !== this.#runId || ack.supervisor_session_nonce_digest !== this.#sessionNonceDigest
      || stagedLease.run_id !== this.#runId || stagedLease.state !== 'staged'
      || stagedLease.controller_registration_digest !== record.registration.registration_digest
      || ack.new_write_lease_id !== stagedLease.lease_id
      || ack.todo_id !== expected.todo_id || ack.executor_handle !== expected.executor_handle
      || ack.worktree_id !== expected.worktree_id || ack.predecessor_packet_digest !== expected.predecessor_packet_digest
      || ack.rebind_packet_digest !== expected.rebind_packet_digest) fail('EPOCH_REBIND_INCOMPLETE', 'direct rebind ack不一致');
    const observed = await this.#processObserver({ kind: 'rebind', ack: structuredClone(ack), stagedLease: structuredClone(stagedLease), descriptor: structuredClone(record.descriptor) });
    if (observed?.write_enabled !== false) fail('EPOCH_REBIND_INCOMPLETE', 'rebind直接再観測不一致');
    this.#leases.set(stagedLease.lease_digest, { lease: structuredClone(stagedLease), controllerId, issuedAt: this.#clock(), revoked: false });
    return this.#append('epoch_rebind_acknowledged', { todo_id: ack.todo_id,
      ack_digest: ack.ack_digest, staged_lease_digest: stagedLease.lease_digest });
  }

  /** 全release ackを回収した後だけ、中央gateを一回commitしてstaged v1→armed v2を有効化する。 */
  async commitWriteGate({ planEpoch, committedEpochDigest, activationDigest,
    releaseBarrierDigest = null, commitReleaseBarrier = null,
    afterControllerRelease = null, committedAt }) {
    await this.assertControllerHealth();
    if (!this.#frozen || !Number.isSafeInteger(planEpoch) || planEpoch < 1
      || !(releaseBarrierDigest === null || digest(releaseBarrierDigest))
      || !digest(committedEpochDigest) || !digest(activationDigest)) fail('EPOCH_ACTIVATION_INCOMPLETE', 'gate入力不正');
    const staged = [...this.#leases.values()].filter((entry) => !entry.revoked && entry.lease.plan_epoch === planEpoch && validateStagedWriteLease(entry.lease));
    const nextGeneration = this.#gateGeneration + 1;
    const readyAcks = [];
    let releaseIndex = 0;
    for (const record of this.#controllers.values()) {
      const ownedStaged = staged.filter((entry) => entry.lease.controller_registration_digest === record.registration.registration_digest).map((entry) => entry.lease.lease_digest).sort();
      const ready = await this.routeWhileFrozen('activate', record, {
        request_id: randomUUID(), committed_epoch_digest: committedEpochDigest,
        activation_digest: activationDigest, staged_lease_digests: ownedStaged,
      });
      if (ready.observed_pointer_digest !== committedEpochDigest
        || ready.ready_ack.registration_digest !== record.registration.registration_digest
        || ready.ready_ack.controller_id !== record.descriptor.controller_id
        || ready.ready_ack.run_id !== this.#runId || ready.ready_ack.plan_epoch !== planEpoch
        || ready.ready_ack.activation_digest !== activationDigest
        || ready.ready_ack.supervisor_session_nonce_digest !== this.#sessionNonceDigest
        || JSON.stringify(ready.ready_ack.staged_lease_digests) !== JSON.stringify(ownedStaged)) fail('EPOCH_ACTIVATION_INCOMPLETE', 'ready pointer/binding不一致');
      readyAcks.push(ready.ready_ack);
    }
    if (typeof commitReleaseBarrier === 'function') {
      const barrier = { schema: 'lattice.release_epoch_barrier.v1', run_id: this.#runId,
        committed_epoch_pointer_digest: committedEpochDigest, plan_epoch: planEpoch,
        activation_digest: activationDigest,
        controller_ready_ack_digests: readyAcks.map((ack) => ack.ack_digest).sort(),
        staged_lease_digests: staged.map((entry) => entry.lease.lease_digest).sort(),
        gate_generation: nextGeneration, release_digest: '' };
      barrier.release_digest = selfDigest(barrier, 'release_digest');
      const receipt = await commitReleaseBarrier(structuredClone(barrier));
      if (receipt?.release_digest !== barrier.release_digest) fail('EPOCH_ACTIVATION_INCOMPLETE', 'release barrier commit不一致');
      releaseBarrierDigest = barrier.release_digest;
    }
    if (!digest(releaseBarrierDigest)) fail('EPOCH_ACTIVATION_INCOMPLETE', 'release barrier未commit');
    const armed = staged.map((entry) => armStagedWriteLease(entry.lease, { releaseBarrierDigest, gateGeneration: nextGeneration }));
    const releaseAcks = [];
    for (const record of this.#controllers.values()) {
      const ownedStaged = staged.filter((entry) => entry.lease.controller_registration_digest === record.registration.registration_digest).map((entry) => entry.lease.lease_digest).sort();
      const released = await this.routeWhileFrozen('release', record, {
        request_id: randomUUID(), release_barrier_digest: releaseBarrierDigest,
        activation_digest: activationDigest, gate_generation: nextGeneration,
        staged_lease_digests: ownedStaged,
      });
      const ownedArmed = armed.filter((lease) => lease.controller_registration_digest === record.registration.registration_digest).map((lease) => lease.lease_digest).sort();
      if (released.observed_gate_generation !== nextGeneration
        || JSON.stringify(released.armed_lease_digests) !== JSON.stringify(ownedArmed)
        || !validateReleaseAck(released.release_ack)) fail('EPOCH_ACTIVATION_INCOMPLETE', 'direct release ack不一致');
      releaseAcks.push(released.release_ack);
      releaseIndex += 1;
      if (typeof afterControllerRelease === 'function') await afterControllerRelease({
        release_index: releaseIndex, controller_id: record.descriptor.controller_id,
        release_ack_digest: released.release_ack.ack_digest,
      });
    }
    const registrations = [...this.#controllers.values()].map((entry) => entry.registration);
    const controllers = [...this.#controllers.values()].map((entry) => entry.descriptor);
    const gate = createWriteGate({ runId: this.#runId, planEpoch, gateGeneration: nextGeneration, releaseBarrierDigest, releaseAcks, armedLeases: armed, previousGateDigest: this.#gate?.gate_digest ?? null, committedAt });
    const verified = verifyCentralWriteGate({ gate, runId: this.#runId, planEpoch, releaseBarrierDigest, sessionNonceDigest: this.#sessionNonceDigest, registrations, controllers, releaseAcks, armedLeases: armed, previousGate: this.#gate });
    if (!verified.valid) fail('EPOCH_ACTIVATION_INCOMPLETE', verified.reason);
    const atomicActivation = {
      gate: structuredClone(gate),
      control_events: [
        { kind: 'write_gate_committed', payload: { gate_digest: gate.gate_digest, gate_generation: nextGeneration } },
        { kind: 'epoch_activated', payload: { plan_epoch: planEpoch, gate_digest: gate.gate_digest } },
        { kind: 'intake_resumed', payload: { plan_epoch: planEpoch, gate_digest: gate.gate_digest } },
      ],
    };
    const commitReceipt = await this.#gateWriter.commit(atomicActivation);
    if (!digest(commitReceipt?.control_head_digest) || commitReceipt.gate_digest !== gate.gate_digest) fail('EPOCH_ACTIVATION_INCOMPLETE', 'gate/event atomic commit証拠不正');
    // Durable central commit成功後にだけlocal projectionをarmedへ置換する。
    for (const armedLease of armed) {
      const old = staged.find((entry) => entry.lease.lease_id === armedLease.lease_id);
      this.#leases.delete(old.lease.lease_digest);
      this.#leases.set(armedLease.lease_digest, { ...old, lease: armedLease, issuedAt: this.#clock() });
    }
    this.#previousGate = this.#gate;
    this.#gate = gate;
    this.#releaseAcks = releaseAcks.map((ack) => structuredClone(ack));
    this.#gateRecords.set(gate.gate_generation, {
      gate: structuredClone(gate),
      releaseAcks: releaseAcks.map((ack) => structuredClone(ack)),
    });
    this.#gateGeneration = nextGeneration;
    this.#frozen = false;
    return { gate: structuredClone(gate), armedLeases: armed.map((lease) => structuredClone(lease)) };
  }

  /** write/process開始の度にfull chainを再検証する。generationだけのshort pathは持たない。 */
  async authorizeWrite({ leaseDigest }) {
    await this.assertControllerHealth();
    const entry = this.#leases.get(leaseDigest);
    if (this.#frozen || !entry || entry.revoked || !validateArmedWriteLease(entry.lease)) fail('RUN_FROZEN', '有効なarmed leaseなし');
    const gateRecord = this.#gateRecords.get(entry.lease.gate_generation);
    const gate = gateRecord?.gate ?? (this.#gate?.gate_generation === entry.lease.gate_generation
      ? this.#gate : null);
    const releaseAcks = gateRecord?.releaseAcks ?? (gate === this.#gate ? this.#releaseAcks : []);
    if (gate === null) fail('RUN_FROZEN', 'leaseのorigin gateが無い');
    const previousGate = this.#gateRecords.get(gate.gate_generation - 1)?.gate
      ?? (gate === this.#gate ? this.#previousGate : null);
    const gateLeases = [...this.#leases.values()]
      .filter((item) => !item.revoked && validateArmedWriteLease(item.lease)
        && item.lease.gate_generation === gate.gate_generation)
      .map((item) => item.lease);
    const verified = verifyCentralWriteGate({
      gate, runId: this.#runId, planEpoch: entry.lease.plan_epoch,
      releaseBarrierDigest: entry.lease.release_barrier_digest, sessionNonceDigest: this.#sessionNonceDigest,
      registrations: [...this.#controllers.values()].map((record) => record.registration),
      controllers: [...this.#controllers.values()].map((record) => record.descriptor),
      releaseAcks, armedLeases: gateLeases,
      previousGate,
    });
    // gate commit時にarmした後続frontierのleaseを壁時計で失効させると、正しく直列待ちした
    // taskほどdispatch不能になる。freshnessはactive gate chainとrevokeで決める。
    if (!verified.valid) {
      entry.revoked = true;
      this.#frozen = true;
      fail('RUN_FROZEN', verified.reason);
    }
    return structuredClone(entry.lease);
  }

  /** restart後は旧nonce leaseを無効化し、観測集合の和を全件barrierする。 */
  async recoveryBarrier({ barrierId, frozenEventDigest }) {
    this.#frozen = true;
    for (const entry of this.#leases.values()) entry.revoked = true;
    await this.#append('supervisor_recovery_barrier', { barrier_id: barrierId });
    return this.barrierAll({ barrierId, reason: 'supervisor_restart', frozenEventDigest });
  }

  async routeWhileFrozen(operation, record, fields) {
    const request = createControllerRequest(operation, { request_id: fields.request_id ?? randomUUID(), registration_digest: record.registration.registration_digest, ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['request_id', 'registration_digest'].includes(key))) });
    const response = await record.transport.request(operation, structuredClone(request));
    if (!validateControllerResponse(operation, response, request.request_id)) fail('ADAPTER_CONTROLLER_UNAVAILABLE', `${operation} response不正`);
    return response;
  }

  #requireController(controllerId) {
    const record = this.#controllers.get(controllerId);
    if (!record) fail('ADAPTER_CONTROLLER_UNAVAILABLE', `unknown controller: ${controllerId}`);
    return record;
  }

  async #failClosed(record, code, detail) {
    this.#frozen = true;
    record.revoked = true;
    for (const entry of this.#leases.values()) {
      if (entry.controllerId === record.descriptor.controller_id) entry.revoked = true;
    }
    const leaseDigests = [...this.#leases.values()].filter((entry) => entry.controllerId === record.descriptor.controller_id).map((entry) => entry.lease.lease_digest).sort();
    if (record.connected) {
      let response;
      try { response = await this.routeWhileFrozen('revoke', record, { request_id: randomUUID(), reason: detail, lease_digests: leaseDigests }); }
      catch { fail(code, `${detail}; controller revoke未確認`); }
      if (JSON.stringify(response.revoked_lease_digests) !== JSON.stringify(leaseDigests)
        || response.residual_processes.length !== 0) fail(code, `${detail}; controller revoke不完全`);
      await this.#append('lease_revoked', { controller_id: record.descriptor.controller_id, reason: detail, response_digest: response.response_digest });
    }
    fail(code, detail);
  }

  async #append(kind, payload) {
    return this.#journal.append({ run_id: this.#runId, kind, session_nonce_digest: this.#sessionNonceDigest, payload });
  }
}

async function exchangeControllerHandshake({ socketPath, runId, supervisorSessionNonce,
  controllerSocketRef, timeoutMs }) {
  const requestId = randomUUID();
  const challenge = randomBytes(32).toString('hex');
  const request = { schema: 'lattice.adapter_controller_handshake_request.v1', request_id: requestId,
    run_id: runId, supervisor_session_nonce: supervisorSessionNonce,
    controller_socket_ref: controllerSocketRef, challenge, request_digest: '' };
  request.request_digest = selfDigest(request, 'request_digest');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE', 'controller handshake timeout')); }, timeoutMs);
    const done = (error, value) => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value); };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${canonicalizeArtifact(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        if (buffer.slice(newline + 1).length !== 0) throw new Error('multiple documents');
        const response = JSON.parse(buffer.slice(0, newline));
        if (!validateControllerHandshakeResponse(response, { requestId, challenge, runId })) throw new Error('handshake binding不正');
        done(null, response);
      } catch (error) { done(new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE', error.message)); }
    });
    socket.once('error', (error) => done(new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE', error.message)));
  });
}

function createControllerSocketTransport(
  socketPath,
  timeoutMs,
  dispatchLivenessTimeoutMs = timeoutMs,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(dispatchLivenessTimeoutMs) || dispatchLivenessTimeoutMs < 1) {
    fail('SUPERVISOR_CONFIGURATION_INVALID', 'controller transport timeout不正');
  }
  const socket = net.createConnection({ path: socketPath });
  const pending = new Map();
  let buffer = '';
  let connected = false;
  let heartbeatHandler = null;
  let disconnectHandler = null;
  const ready = new Promise((resolve, reject) => {
    socket.once('connect', () => { connected = true; resolve(); });
    socket.once('error', reject);
  });
  socket.setEncoding('utf8');
  const armRequestTimer = (requestId, entry) => {
    clearTimeout(entry.timer);
    const waitMs = entry.operation === 'dispatch' ? dispatchLivenessTimeoutMs : timeoutMs;
    entry.timer = setTimeout(() => {
      pending.delete(requestId);
      entry.reject(new ManagedRuntimeError(
        'ADAPTER_CONTROLLER_UNAVAILABLE',
        `${entry.operation} timeout`,
      ));
    }, waitMs);
  };
  const refreshDispatchLiveness = () => {
    for (const [requestId, entry] of pending.entries()) {
      if (entry.operation === 'dispatch') armRequestTimer(requestId, entry);
    }
  };
  const failPending = (detail) => {
    connected = false;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE', detail)); }
    pending.clear();
    Promise.resolve(disconnectHandler?.()).catch(() => {});
  };
  socket.on('close', () => failPending('controller persistent socket disconnected'));
  socket.on('error', (error) => failPending(error.message));
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let document;
      try { document = JSON.parse(line); } catch { failPending('controller document JSON不正'); socket.destroy(); return; }
      const errorEntry = pending.get(document?.request_id);
      if (errorEntry && validateControllerError(document, document.request_id)) {
        pending.delete(document.request_id);
        clearTimeout(errorEntry.timer);
        const detail = Object.keys(document.detail).length === 0
          ? ''
          : `: ${canonicalizeArtifact(document.detail)}`;
        errorEntry.reject(new ManagedRuntimeError(
          'ADAPTER_CONTROLLER_UNAVAILABLE',
          `${document.code}: ${document.message}${detail}`,
        ));
        socket.destroy();
        return;
      }
      if (validateControllerHeartbeat(document)) {
        if (heartbeatHandler === null) {
          socket.destroy();
          continue;
        }
        Promise.resolve()
          .then(() => heartbeatHandler(structuredClone(document)))
          .then(() => refreshDispatchLiveness())
          .catch(() => socket.destroy());
        continue;
      }
      const entry = pending.get(document.request_id);
      if (!entry || !validateControllerResponse(entry.operation, document, document.request_id)) { failPending('unsolicited/invalid controller response'); socket.destroy(); return; }
      pending.delete(document.request_id); clearTimeout(entry.timer); entry.resolve(document);
    }
  });
  return Object.freeze({
    async ensureConnected() { await ready; if (!connected) fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'persistent controller socket不達'); },
    setHeartbeatHandler(handler) { heartbeatHandler = handler; },
    setDisconnectHandler(handler) { disconnectHandler = handler; },
    close() { disconnectHandler = null; socket.destroy(); },
    async request(operation, request) {
      await ready;
      if (!connected) fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'controller persistent socket不達');
      return new Promise((resolve, reject) => {
        const entry = { operation, resolve, reject, timer: null };
        pending.set(request.request_id, entry);
        armRequestTimer(request.request_id, entry);
        socket.write(`${canonicalizeArtifact(request)}\n`);
      });
    },
  });
}

export const runtimeManagedSupervisorInternal = Object.freeze({
  createControllerSocketTransport,
});

/**
 * durable registryをpreflightし、実controller hostとのnonce challenge後にだけactivation証拠を返す。
 * callerは成功返却前にrun storeへ何もpublishしてはならない。
 */
async function activateManagedSupervisorController({ repoRoot, runDir, runId, adapterKind, supervisorSessionNonce, timeoutMs = 5_000, binaryIdentityObserver = observeMacosBinaryIdentity }) {
  if (!path.isAbsolute(repoRoot) || !path.isAbsolute(runDir) || !identifier(runId) || !identifier(adapterKind)
    || typeof supervisorSessionNonce !== 'string' || supervisorSessionNonce.length < 32) fail('SUPERVISOR_CONFIGURATION_INVALID', 'activation入力不正');
  const canonicalRepo = await realpath(repoRoot);
  const registryPath = path.join(canonicalRepo, '.lattice/runtime/adapter-registry/registry.json');
  let registryArtifact;
  try { registryArtifact = await readCanonicalRegular(registryPath); } catch (error) {
    if (error?.code === 'ENOENT') fail('ADAPTER_NOT_REGISTERED', adapterKind);
    throw error;
  }
  if (!validateAdapterRegistry(registryArtifact.value)) fail('ADAPTER_LAUNCH_INVALID', 'registry不正');
  const entry = registryArtifact.value.entries.find((candidate) => candidate.adapter_kind === adapterKind);
  if (!entry) fail('ADAPTER_NOT_REGISTERED', adapterKind);
  const descriptorPath = path.join(canonicalRepo, entry.launch_descriptor_ref);
  if (!descriptorPath.startsWith(`${canonicalRepo}${path.sep}`)) fail('ADAPTER_LAUNCH_INVALID', 'descriptor repo外');
  const launchArtifact = await readCanonicalRegular(descriptorPath);
  const launch = launchArtifact.value;
  if (!validateAdapterLaunchDescriptor(launch) || launch.adapter_kind !== adapterKind
    || launch.descriptor_digest !== entry.launch_descriptor_digest) fail('ADAPTER_LAUNCH_INVALID', 'launch descriptor binding不正');
  const supervisorDir = path.join(runDir, 'supervisor');
  const controllerDir = path.join(supervisorDir, 'controllers');
  const controllerId = `${adapterKind}-${randomUUID()}`;
  const controllerSocketRef = `supervisor/controllers/${controllerId}.sock`;
  const controllerSocketPath = path.join(runDir, controllerSocketRef);
  const supervisorSocketRef = 'supervisor/control.sock';
  let child = null;
  let childStderr = '';
  try {
    await mkdir(controllerDir, { recursive: true, mode: 0o700 });
    let handshakeSocket = launch.endpoint;
    let handshakeConnectPath = launch.endpoint;
    let endpointOwnerPids = null;
    if (launch.launch_kind === 'host_binary') {
      const binaryInfo = await lstat(launch.binary_path);
      if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() || (binaryInfo.mode & 0o111) === 0) fail('ADAPTER_LAUNCH_INVALID', 'binaryが実行可能regular fileでない');
      const binaryReal = await realpath(launch.binary_path);
      if (binaryReal !== launch.binary_path || sha256Bytes(await readFile(binaryReal)) !== launch.binary_digest) fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'binary pre-exec identity不一致');
      if (launch.binary_identity !== null) {
        if (typeof binaryIdentityObserver !== 'function'
          || canonicalizeArtifact(await binaryIdentityObserver(binaryReal)) !== canonicalizeArtifact(launch.binary_identity)) fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'macOS identity不一致');
      }
      const configPath = path.resolve(canonicalRepo, launch.config_ref);
      if (!configPath.startsWith(`${canonicalRepo}${path.sep}`)) fail('ADAPTER_LAUNCH_INVALID', 'config repo外');
      const config = await lstat(configPath);
      if (!config.isFile() || config.isSymbolicLink() || sha256Bytes(await readFile(configPath)) !== launch.config_digest) fail('ADAPTER_LAUNCH_INVALID', 'config digest不一致');
      const bootstrap = createControllerBootstrap({ requestId: randomUUID(), runId, controllerSocketRef, supervisorSocketRef, supervisorSessionNonce });
      // controller hostのcwdはrun store。bootstrapの固定relative socket refを任意absolute pathへ拡張しない。
      child = spawn(binaryReal, launch.argv, {
        cwd: runDir,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        childStderr = `${childStderr}${chunk}`.slice(-8_192);
      });
      child.stdio[3].write(`${canonicalizeArtifact(bootstrap)}\n`);
      child.stdio[3].end();
      handshakeSocket = controllerSocketPath;
      handshakeConnectPath = controllerSocketRef;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { if ((await lstat(handshakeSocket)).isSocket()) break; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (child.exitCode !== null) {
          fail(
            'ADAPTER_CONTROLLER_UNAVAILABLE',
            `controller exited: ${child.exitCode}${childStderr ? `: ${childStderr.trim()}` : ''}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let socketInfo;
      try {
        socketInfo = await lstat(handshakeSocket);
      } catch {
        fail(
          'ADAPTER_CONTROLLER_UNAVAILABLE',
          `controller socket未生成${childStderr ? `: ${childStderr.trim()}` : ''}`,
        );
      }
      if (!socketInfo.isSocket()) fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'controller endpointがsocketでない');
      // exec後にも同じ実行image bytesを再検証する。PID生存も同時に要求する。
      try { process.kill(child.pid, 0); } catch { fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'controller process不達'); }
      // u03 C25: 観測できない時はpre-exec検証だけで進む。観測できて食い違う時だけ止める。
      const executedImage = await observeProcessExecutablePath(child.pid).catch(() => null);
      if (executedImage !== null) {
        if (executedImage !== binaryReal || sha256Bytes(await readFile(executedImage)) !== launch.binary_digest) {
          fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'exec後image path/bytes不一致');
        }
        if (launch.binary_identity !== null
          && canonicalizeArtifact(await binaryIdentityObserver(executedImage)) !== canonicalizeArtifact(launch.binary_identity)) {
          fail('ADAPTER_BINARY_IDENTITY_MISMATCH', 'exec後macOS identity不一致');
        }
      }
    } else {
      if (!path.isAbsolute(handshakeSocket) || await realpath(path.dirname(handshakeSocket)) !== path.dirname(handshakeSocket)) {
        fail('ADAPTER_LAUNCH_INVALID', 'existing endpoint pathがcanonical absoluteでない');
      }
      const endpointInfo = await lstat(handshakeSocket);
      if (!endpointInfo.isSocket() || endpointInfo.isSymbolicLink()) fail('ADAPTER_LAUNCH_INVALID', 'existing endpointがsocketでない');
      let ownerPids;
      try { ownerPids = await pidsOwningSocketPath(handshakeSocket); }
      catch { fail('ADAPTER_LAUNCH_INVALID', 'existing endpoint ownerを観測できない'); }
      endpointOwnerPids = new Set(ownerPids);
      if (endpointOwnerPids.size !== 1 || [...endpointOwnerPids].some((pid) => !Number.isSafeInteger(pid) || pid < 1)) {
        fail('ADAPTER_LAUNCH_INVALID', 'existing endpoint ownerが一意でない');
      }
    }
    // socket fileの出現はbindの証拠でありlistenの証拠ではない。負荷下ではcontrollerが
    // bindとlistenの間でpreemptされ、fileを見て接続した一回だけECONNREFUSEDになる
    // （2026-08-22 CI負荷下で実被弾）。起動したchildに限り、listen受理までを起動待ちに
    // 含めてdeadline内はECONNREFUSEDだけを待ち直す。死んだcontrollerはexitCode検査が、
    // 起動しないcontrollerはdeadlineが従来どおり落とす。既存endpoint（child無し）は
    // owner検証済みのlistener前提なので単発のまま。
    const handshakeDeadline = Date.now() + timeoutMs;
    let handshake;
    for (;;) {
      try {
        handshake = await exchangeControllerHandshake({ socketPath: handshakeConnectPath, runId,
          supervisorSessionNonce, controllerSocketRef, timeoutMs });
        break;
      } catch (error) {
        const listenPending = child !== null && error instanceof ManagedRuntimeError
          && ['ECONNREFUSED', 'ENOENT'].some((code) => String(error.message).includes(code))
          && Date.now() < handshakeDeadline;
        if (!listenPending) throw error;
        if (child.exitCode !== null) {
          fail(
            'ADAPTER_CONTROLLER_UNAVAILABLE',
            `controller exited: ${child.exitCode}${childStderr ? `: ${childStderr.trim()}` : ''}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const controllerDescriptor = handshake.descriptor;
    if (controllerDescriptor.adapter_kind !== adapterKind || controllerDescriptor.socket_ref !== controllerSocketRef
      || controllerDescriptor.capabilities.capabilities_digest !== launch.capabilities_digest
      || (child !== null && controllerDescriptor.pid !== child.pid)) fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'controller descriptor launch binding不一致');
    if (endpointOwnerPids !== null) {
      if (!endpointOwnerPids.has(controllerDescriptor.pid)) {
        fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'existing endpoint inode ownerとdescriptor PID不一致');
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { if ((await lstat(controllerSocketPath)).isSocket()) break; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let controllerOwnerPids;
      try { controllerOwnerPids = await pidsOwningSocketPath(controllerSocketPath); }
      catch { fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'existing controller socket ownerを観測できない'); }
      const persistentOwners = new Set(controllerOwnerPids);
      if (persistentOwners.size !== 1 || !persistentOwners.has(controllerDescriptor.pid)) {
        fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'persistent controller socket ownerとdescriptor PID不一致');
      }
      handshakeConnectPath = controllerSocketRef;
    }
    const observedControllerIdentity = await observeManagedProcessStartIdentity(controllerDescriptor.pid);
    if (canonicalizeArtifact(observedControllerIdentity) !== canonicalizeArtifact(controllerDescriptor.process_start_identity)) fail('ADAPTER_CONTROLLER_UNAVAILABLE', `controller process start identity不一致: expected=${controllerDescriptor.process_start_identity.identity_digest} observed=${observedControllerIdentity.identity_digest}`);
    const sessionNonceDigest = digestArtifact(supervisorSessionNonce);
    const registration = {
      schema: 'lattice.runtime_adapter_registration.v1', registration_id: `registration-${controllerId}`,
      run_id: runId, supervisor_session_nonce_digest: sessionNonceDigest,
      controller_descriptor_digest: controllerDescriptor.descriptor_digest,
      registered_operations: [...controllerDescriptor.capabilities.operations],
      registered_at: new Date().toISOString(), registration_digest: '',
    };
    registration.registration_digest = selfDigest(registration, 'registration_digest');
    if (!validateControllerRegistration(registration)) fail('ADAPTER_CONTROLLER_UNAVAILABLE', 'registration生成不正');
    const processIdentity = await observeManagedProcessStartIdentity(process.pid);
    const supervisorDescriptor = { schema: 'lattice.runtime_supervisor_descriptor.v1', run_id: runId, pid: process.pid, process_start_identity: processIdentity, socket_ref: supervisorSocketRef, session_nonce_digest: sessionNonceDigest, protocol_version: 'v1', activated_at: new Date().toISOString(), descriptor_digest: '' };
    supervisorDescriptor.descriptor_digest = selfDigest(supervisorDescriptor, 'descriptor_digest');
    const activationControlEvent = { schema: 'lattice.runtime_control_event.v1', run_id: runId, sequence: 1, previous_digest: null, kind: 'supervisor_activated', session_nonce_digest: sessionNonceDigest, payload: { supervisor_descriptor_digest: supervisorDescriptor.descriptor_digest, controller_descriptor_digest: controllerDescriptor.descriptor_digest, registration_digest: registration.registration_digest }, recorded_at: supervisorDescriptor.activated_at, event_digest: '' };
    activationControlEvent.event_digest = selfDigest(activationControlEvent, 'event_digest');
    const controllerTransport = createControllerSocketTransport(
      handshakeConnectPath,
      timeoutMs,
      controllerDescriptor.heartbeat.ttl_ms,
    );
    let disposed = false;
    const disposeController = async () => {
      if (disposed) return;
      disposed = true;
      controllerTransport.close();
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          try { process.kill(child.pid, 0); } catch { break; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        try { process.kill(child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch { /* reaped */ }
      }
      await rm(controllerSocketPath, { force: true }).catch(() => {});
    };
    const registerWithManagedSupervisor = async (managedSupervisor) => {
      await controllerTransport.ensureConnected();
      await managedSupervisor.registerController({ descriptor: controllerDescriptor, registration, transport: controllerTransport });
      controllerTransport.setHeartbeatHandler(async (heartbeat) => {
        if (digestArtifact(heartbeat.supervisor_session_nonce) !== sessionNonceDigest
          || heartbeat.controller_id !== controllerDescriptor.controller_id) {
          await managedSupervisor.disconnect(controllerDescriptor.controller_id);
          return;
        }
        await managedSupervisor.heartbeat({
          controllerId: heartbeat.controller_id,
          registrationDigest: heartbeat.registration_digest,
          sequence: heartbeat.sequence,
          leaseSetDigest: heartbeat.lease_set_digest,
          sessionNonceDigest,
        });
      });
      controllerTransport.setDisconnectHandler(() => managedSupervisor.disconnect(controllerDescriptor.controller_id));
    };
    const createManagedSupervisor = async ({ clock, resolveObservationBinding, resolveRunningBindings, processObserver = null, allowTestObserver = false, journal, gateWriter }) => {
      if (processObserver !== null && allowTestObserver !== true) fail('SUPERVISOR_CONFIGURATION_INVALID', 'production observer差替え禁止');
      const directObserver = processObserver ?? createDirectOsProcessObserverV2({ resolveObservationBinding });
      const managedSupervisor = new RuntimeManagedSupervisor({ runId, sessionNonceDigest, clock, processObserver: directObserver, runningBindingResolver: resolveRunningBindings, journal, gateWriter, shutdownFinalizer: disposeController });
      await managedSupervisor.hydrateCommittedGate();
      await registerWithManagedSupervisor(managedSupervisor);
      return managedSupervisor;
    };
    return {
      supervisorDescriptor,
      activationControlEvent,
      controllerDescriptor,
      registration,
      launchDescriptor: structuredClone(launch),
      sessionNonce: supervisorSessionNonce,
      childPid: child?.pid ?? controllerDescriptor.pid,
      createManagedSupervisor,
      registerWithManagedSupervisor,
      disposeController,
    };
  } catch (error) {
    if (child?.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ } }
    await rm(controllerSocketPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** CLI→durable supervisorのUnix socket client。nonceはrequest内だけ、stdoutへ返さない。 */
export async function sendRuntimeControlRequest({ socketPath, request, timeoutMs = 5_000 }) {
  if (typeof socketPath !== 'string' || socketPath.length === 0 || !validateRuntimeControlRequest(request)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('RUN_NOT_MANAGED', 'control request不正');
  const absoluteSocket = path.resolve(socketPath);
  const runDir = path.dirname(path.dirname(absoluteSocket));
  const socketRef = path.relative(runDir, absoluteSocket);
  const runInfo = await lstat(runDir).catch(() => null);
  const supervisorInfo = await lstat(path.join(runDir, 'supervisor')).catch(() => null);
  const socketInfo = await lstat(absoluteSocket).catch(() => null);
  if (socketRef !== 'supervisor/control.sock' || runInfo === null || !runInfo.isDirectory() || runInfo.isSymbolicLink()
    || supervisorInfo === null || !supervisorInfo.isDirectory() || supervisorInfo.isSymbolicLink()
    || socketInfo === null || !socketInfo.isSocket() || socketInfo.isSymbolicLink()
    || await realpath(runDir) !== runDir) fail('RUN_NOT_MANAGED', 'control socket cwd anchor不正');
  const activePaths = await resolveActiveRuntimePaths({ runDir });
  const descriptorArtifact = await readCanonicalRegular(activePaths.descriptorPath).catch(() => null);
  const descriptor = descriptorArtifact?.value;
  const descriptorFields = ['schema', 'run_id', 'pid', 'process_start_identity', 'socket_ref', 'session_nonce_digest', 'protocol_version', 'activated_at', 'descriptor_digest'];
  if (descriptor === undefined || descriptor.schema !== 'lattice.runtime_supervisor_descriptor.v1'
    || Object.keys(descriptor).sort().join('\0') !== descriptorFields.sort().join('\0')
    || descriptor.run_id !== request.run_id || descriptor.socket_ref !== socketRef
    || descriptor.session_nonce_digest !== digestArtifact(request.session_nonce)
    || (activePaths.pointer !== null
      && (descriptor.descriptor_digest !== activePaths.pointer.descriptor_digest
        || descriptor.session_nonce_digest !== activePaths.pointer.session_nonce_digest))
    || descriptor.descriptor_digest !== selfDigest(descriptor, 'descriptor_digest')) fail('RUN_NOT_MANAGED', 'supervisor descriptor/session binding不正');
  let observedSupervisor;
  try { observedSupervisor = await observeManagedProcessStartIdentity(descriptor.pid); }
  catch { fail('RUN_NOT_MANAGED', 'supervisor process不在'); }
  if (canonicalizeArtifact(observedSupervisor) !== canonicalizeArtifact(descriptor.process_start_identity)) fail('RUN_NOT_MANAGED', 'supervisor PID/start identity不一致');
  let ownedSocketPaths;
  try { ownedSocketPaths = await socketPathsOwnedByPid(descriptor.pid); }
  catch { fail('RUN_NOT_MANAGED', 'supervisor socket owner観測失敗'); }
  const ownsExactSocket = ownedSocketPaths
    .some((name) => name === absoluteSocket || name === socketRef);
  if (!ownsExactSocket) fail('RUN_NOT_MANAGED', 'supervisor PIDがcontrol socket inodeを所有しない');
  return new Promise((resolve, reject) => {
    let originalCwd;
    let socket;
    try {
      originalCwd = process.cwd();
      process.chdir(runDir);
      if (process.cwd() !== runDir) throw new Error('run cwd identity不一致');
      socket = net.createConnection({ path: socketRef });
    } catch (error) {
      if (originalCwd) process.chdir(originalCwd);
      return reject(new ManagedRuntimeError('RUN_NOT_MANAGED', error.message));
    }
    let buffer = '';
    let settled = false;
    let sent = false;
    let cwdRestored = false;
    const restoreCwd = () => { if (!cwdRestored) { cwdRestored = true; process.chdir(originalCwd); } };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      restoreCwd();
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new ManagedRuntimeError('RUN_OUTCOME_UNKNOWN',
      'control timeout。同一request_idで再照会が必要')));
    socket.on('connect', () => { restoreCwd(); sent = true; socket.write(`${canonicalizeArtifact(request)}\n`); });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 1_048_576) return finish(new ManagedRuntimeError('RUN_NOT_MANAGED', 'control response過大'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (buffer.slice(newline + 1).length !== 0) return finish(new ManagedRuntimeError('RUN_NOT_MANAGED', 'control response複数document'));
      try {
        const value = JSON.parse(buffer.slice(0, newline));
        if (!validateRuntimeControlResponse(value, request.operation) || value.request_id !== request.request_id || value.run_id !== request.run_id) return finish(new ManagedRuntimeError('RUN_NOT_MANAGED', 'control response binding不正'));
        finish(null, value);
      } catch (error) { finish(error instanceof ManagedRuntimeError ? error : new ManagedRuntimeError('RUN_NOT_MANAGED', 'control response JSON不正')); }
    });
    socket.on('error', (error) => finish(new ManagedRuntimeError(sent ? 'RUN_OUTCOME_UNKNOWN' : 'RUN_NOT_MANAGED', error.message)));
    socket.on('end', () => { if (!settled) finish(new ManagedRuntimeError(sent ? 'RUN_OUTCOME_UNKNOWN' : 'RUN_NOT_MANAGED', 'control socket早期切断')); });
  });
}

/** 初回activate専用。descriptor未公開のためIPCで得たPID＋nonceとsocket ownerを直接bindする。 */
export async function sendRuntimeActivationRequest({ socketPath, request, expectedPid, expectedProcessStartIdentity, timeoutMs = 5_000 }) {
  if (!validateRuntimeControlRequest(request) || request.operation !== 'activate'
    || !Number.isSafeInteger(expectedPid) || expectedPid < 1
    || !validateProcessStartIdentity(expectedProcessStartIdentity)
    || expectedProcessStartIdentity.pid !== expectedPid) fail('RUN_NOT_MANAGED', 'activation bootstrap入力不正');
  const absoluteSocket = path.resolve(socketPath);
  const runDir = path.dirname(path.dirname(absoluteSocket));
  const socketRef = path.relative(runDir, absoluteSocket);
  const socketInfo = await lstat(absoluteSocket).catch(() => null);
  if (socketRef !== 'supervisor/control.sock' || socketInfo === null || !socketInfo.isSocket() || socketInfo.isSymbolicLink()
    || await realpath(runDir) !== runDir) fail('RUN_NOT_MANAGED', 'activation socket anchor不正');
  let observedBootstrapIdentity;
  try { observedBootstrapIdentity = await observeManagedProcessStartIdentity(expectedPid); }
  catch { fail('RUN_NOT_MANAGED', 'activation bootstrap process不在'); }
  if (canonicalizeArtifact(observedBootstrapIdentity) !== canonicalizeArtifact(expectedProcessStartIdentity)) fail('RUN_NOT_MANAGED', 'activation bootstrap PID/start identity不一致');
  let bootstrapSocketPaths;
  try { bootstrapSocketPaths = await socketPathsOwnedByPid(expectedPid); }
  catch { fail('RUN_NOT_MANAGED', 'activation socket owner観測失敗'); }
  if (!bootstrapSocketPaths
    .some((name) => name === absoluteSocket || name === socketRef)) fail('RUN_NOT_MANAGED', 'bootstrap PIDがcontrol socketを所有しない');
  const originalCwd = process.cwd();
  process.chdir(runDir);
  let socket;
  try { socket = net.createConnection({ path: socketRef }); } catch (error) { process.chdir(originalCwd); fail('RUN_NOT_MANAGED', error.message); }
  return new Promise((resolve, reject) => {
    let restored = false; const restore = () => { if (!restored) { restored = true; process.chdir(originalCwd); } };
    let buffer = ''; let settled = false; let sent = false;
    const finish = (error, value) => { if (settled) return; settled = true; restore(); socket.destroy(); if (error) reject(error); else resolve(value); };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new ManagedRuntimeError('RUN_OUTCOME_UNKNOWN',
      'activation timeout。同一request_idで再照会が必要')));
    socket.on('connect', () => { restore(); sent = true; socket.write(`${canonicalizeArtifact(request)}\n`); });
    socket.on('data', (chunk) => {
      buffer += chunk; const newline = buffer.indexOf('\n'); if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (buffer.slice(newline + 1).length !== 0 || !validateRuntimeControlResponse(response, request.operation)
          || response.request_id !== request.request_id || response.run_id !== request.run_id) throw new Error('activation response binding不正');
        finish(null, response);
      } catch (error) { finish(new ManagedRuntimeError('RUN_NOT_MANAGED', error.message)); }
    });
    socket.on('error', (error) => finish(new ManagedRuntimeError(sent ? 'RUN_OUTCOME_UNKNOWN' : 'RUN_NOT_MANAGED', error.message)));
    socket.on('end', () => { if (!settled) finish(new ManagedRuntimeError(sent ? 'RUN_OUTCOME_UNKNOWN' : 'RUN_NOT_MANAGED', 'activation socket早期切断')); });
  });
}

/** 外部workerの完了を含む初回activationは、同じbootstrap接続で最終結果まで待つ。 */
export function sendRuntimeActivationRequestUntilSettled(args) {
  return sendRuntimeActivationRequest({ ...args, timeoutMs: 0 });
}

/** stopped/crashed supervisorの同一run明示再起動前処理。live/foreign socketは削除しない。 */
export async function prepareManagedSupervisorRestart({ runDir }) {
  if (!path.isAbsolute(runDir) || await realpath(runDir) !== runDir) fail('RUN_NOT_MANAGED', 'restart runDir不正');
  const activePaths = await resolveActiveRuntimePaths({ runDir });
  const descriptorArtifact = await readCanonicalRegular(activePaths.descriptorPath).catch(() => null);
  const descriptor = descriptorArtifact?.value;
  if (descriptor?.schema !== 'lattice.runtime_supervisor_descriptor.v1'
    || descriptor.descriptor_digest !== selfDigest(descriptor, 'descriptor_digest')
    || !validateProcessStartIdentity(descriptor.process_start_identity)
    || descriptor.process_start_identity.pid !== descriptor.pid
    || (activePaths.pointer !== null
      && (descriptor.descriptor_digest !== activePaths.pointer.descriptor_digest
        || descriptor.session_nonce_digest !== activePaths.pointer.session_nonce_digest))) fail('RUN_NOT_MANAGED', 'restart descriptor不正');
  try {
    const observed = await observeManagedProcessStartIdentity(descriptor.pid);
    if (canonicalizeArtifact(observed) === canonicalizeArtifact(descriptor.process_start_identity)) fail('RUN_BUSY', 'supervisorは既にlive');
  } catch (error) {
    if (error instanceof ManagedRuntimeError && error.code === 'RUN_BUSY') throw error;
    // process absentだけを許容。PID再利用は旧supervisorではない。
  }
  const socketPath = path.join(runDir, descriptor.socket_ref);
  const socketInfo = await lstat(socketPath).catch(() => null);
  if (socketInfo !== null) {
    if (!socketInfo.isSocket() || socketInfo.isSymbolicLink()) fail('RUN_NOT_MANAGED', 'stale socket path差替え');
    // 所有者が居るなら消さない。観測できなければ「誰も居ない」へ丸めず観測失敗として止める
    // （lsofはヒット無しでexit 1を返すので、この2つを区別する必要がある）。
    let staleOwners;
    try { staleOwners = await pidsOwningSocketPath(socketPath); }
    catch (error) {
      if (error instanceof ManagedRuntimeError) throw error;
      fail('RUN_NOT_MANAGED', 'stale socket owner観測失敗');
    }
    if (staleOwners.length > 0) fail('RUN_BUSY', 'control socketは別processが所有中');
    await rm(socketPath, { force: true });
  }
  return { previousDescriptorDigest: descriptor.descriptor_digest };
}

/** restart commit pointerがあればcandidate namespaceを正本として解決する。固定pathは初回互換cache。 */
export async function resolveActiveRuntimePaths({ runDir }) {
  const fixed = {
    descriptorPath: path.join(runDir, 'supervisor/descriptor.json'),
    sessionPath: path.join(runDir, 'supervisor/session'),
    controlEventsPath: path.join(runDir, 'control-events.json'),
    pointer: null,
  };
  const artifact = await readCanonicalRegular(path.join(runDir, 'supervisor/active-runtime.json')).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (artifact === null) return fixed;
  const pointer = artifact.value;
  const fields = ['schema', 'run_id', 'candidate_ref', 'activation_request_id',
    'activation_request_digest', 'activation_intent_digest', 'activation_response_digest', 'descriptor_digest',
    'session_nonce_digest', 'control_head_digest', 'control_head_sequence',
    'committed_at', 'pointer_digest'];
  if (pointer?.schema !== 'lattice.runtime_active_pointer.v1'
    || Object.keys(pointer).sort().join('\0') !== fields.sort().join('\0')
    || !identifier(pointer.run_id) || !digest(pointer.descriptor_digest)
    || !identifier(pointer.activation_request_id) || !digest(pointer.activation_request_digest)
    || !digest(pointer.activation_intent_digest)
    || !digest(pointer.activation_response_digest)
    || !Number.isSafeInteger(pointer.control_head_sequence) || pointer.control_head_sequence < 1
    || !digest(pointer.session_nonce_digest) || !digest(pointer.control_head_digest)
    || typeof pointer.committed_at !== 'string' || Number.isNaN(Date.parse(pointer.committed_at))
    || pointer.pointer_digest !== selfDigest(pointer, 'pointer_digest')
    || !/^supervisor\/restart-candidates\/[0-9a-f]{64}$/u.test(pointer.candidate_ref)) {
    fail('RUN_NOT_MANAGED', 'active runtime pointer不正');
  }
  const candidateDir = path.join(runDir, pointer.candidate_ref);
  if (!candidateDir.startsWith(`${path.join(runDir, 'supervisor/restart-candidates')}${path.sep}`)) {
    fail('RUN_NOT_MANAGED', 'active runtime pointerがcandidate外');
  }
  const descriptorPath = path.join(candidateDir, 'descriptor.json');
  const sessionPath = path.join(candidateDir, 'session');
  const controlEventsPath = path.join(candidateDir, 'control-events.json');
  const descriptor = (await readCanonicalRegular(descriptorPath)).value;
  const sessionNonce = (await readFile(sessionPath, 'utf8')).trim();
  const controlEvents = (await readCanonicalRegular(controlEventsPath)).value;
  const validControlChain = Array.isArray(controlEvents) && controlEvents.every((event, index) => (
    event?.schema === 'lattice.runtime_control_event.v1'
    && event.run_id === pointer.run_id && event.sequence === index + 1
    && event.previous_digest === (index === 0 ? null : controlEvents[index - 1].event_digest)
    && event.event_digest === selfDigest(event, 'event_digest')
  ));
  if (descriptor?.descriptor_digest !== pointer.descriptor_digest
    || digestArtifact(sessionNonce) !== pointer.session_nonce_digest
    || !validControlChain
    || controlEvents[pointer.control_head_sequence - 1]?.event_digest !== pointer.control_head_digest) {
    fail('RUN_NOT_MANAGED', 'active runtime candidate digest binding不正');
  }
  return {
    descriptorPath, sessionPath, controlEventsPath,
    pointer: structuredClone(pointer),
  };
}

/** durable daemon側の一要求一応答server。mutation本体はstore所有handlerだけが行う。 */
export async function serveRuntimeControlSocket({ socketPath, handler }) {
  if (typeof socketPath !== 'string' || socketPath.length === 0 || typeof handler !== 'function') fail('SUPERVISOR_CONFIGURATION_INVALID', 'control server入力不正');
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) fail('RUN_NOT_MANAGED', 'control.sockがsocketでない');
    let liveOwners;
    try { liveOwners = await pidsOwningSocketPath(socketPath); }
    catch (error) {
      if (error instanceof ManagedRuntimeError) throw error;
      fail('RUN_NOT_MANAGED', 'control.sock owner観測失敗');
    }
    if (liveOwners.length > 0) fail('RUN_BUSY', 'control.sockはlive processが所有する');
    await rm(socketPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const absoluteSocket = path.resolve(socketPath);
  const daemonCwd = await realpath(process.cwd());
  const socketRef = path.relative(daemonCwd, absoluteSocket);
  if (socketRef !== 'supervisor/control.sock' || path.resolve(daemonCwd, socketRef) !== absoluteSocket) fail('RUN_NOT_MANAGED', 'daemon control socket cwd binding不正');
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 1_048_576) { handled = true; socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      try {
        if (buffer.slice(newline + 1).length !== 0) throw new Error('multiple documents');
        const request = JSON.parse(buffer.slice(0, newline));
        if (!validateRuntimeControlRequest(request)) throw new Error('invalid request');
        const response = await handler(structuredClone(request));
        if (!validateRuntimeControlResponse(response, request.operation) || response.request_id !== request.request_id || response.run_id !== request.run_id) throw new Error('invalid response');
        socket.end(`${canonicalizeArtifact(response)}\n`);
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketRef, () => { server.off('error', reject); resolve(); });
  });
  await chmod(socketPath, 0o600);
  return server;
}

/** CLI寿命から独立する同module daemonを起動する。session/descriptor/store昇格はcallerが検証する。 */
export async function launchDurableSupervisor({ runDir, timeoutMs = 5_000 }) {
  if (typeof runDir !== 'string' || runDir.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('SUPERVISOR_CONFIGURATION_INVALID', 'daemon launch入力不正');
  const entryPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entryPath, '--serve-managed-run', runDir], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], cwd: runDir,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already exited */ }
      reject(new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE', 'supervisor daemon起動timeout'));
    }, timeoutMs);
    const failed = (detail) => { clearTimeout(timer); reject(new ManagedRuntimeError('ADAPTER_CONTROLLER_UNAVAILABLE', detail)); };
    child.once('error', (error) => failed(error.message));
    child.once('exit', (code) => failed(`supervisor daemon exited: ${code}`));
    child.once('message', (message) => {
      if (message?.schema === 'lattice.runtime_supervisor_bootstrap_failure.v1'
        && typeof message.code === 'string' && typeof message.detail === 'string') {
        clearTimeout(timer);
        return reject(new ManagedRuntimeError(message.code, message.detail));
      }
      if (message?.schema !== 'lattice.runtime_supervisor_bootstrap_ready.v1'
        || message.pid !== child.pid || typeof message.socketPath !== 'string'
        || typeof message.sessionNonce !== 'string' || message.sessionNonce.length < 32
        || !validateProcessStartIdentity(message.processStartIdentity)
        || message.processStartIdentity.pid !== child.pid) return failed('supervisor bootstrap message不正');
      observeManagedProcessStartIdentity(child.pid).then((observed) => {
        if (canonicalizeArtifact(observed) !== canonicalizeArtifact(message.processStartIdentity)) return failed('supervisor bootstrap PID/start identity不一致');
        clearTimeout(timer);
        child.disconnect();
        child.unref();
        resolve({ pid: child.pid, processStartIdentity: observed, socketPath: message.socketPath, sessionNonce: message.sessionNonce });
      }).catch((error) => failed(error.message));
    });
  });
}

const isDirectDaemon = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  && process.argv[2] === '--serve-managed-run';
if (isDirectDaemon) {
  const runDir = process.argv[3];
  const sessionNonce = randomBytes(32).toString('hex');
  Promise.all([
    import('./runtime-cli.mjs'),
    import('./todo-revision.mjs'),
    import('./todo-store.mjs'),
  ]).then(async ([{ runManagedSupervisorDaemon }, { validatePhaseTodoRevision },
    { applyPhaseTodoRevision, createTodoStoreWriter }]) => {
      if (typeof runManagedSupervisorDaemon !== 'function') fail('SUPERVISOR_CONFIGURATION_INVALID', 'runtime-cli daemon handlerなし');
      let daemonCleanup = async () => {};
      let shuttingDown = false;
      const stop = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        try { await daemonCleanup(signal); process.exitCode = 0; }
        catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
      };
      process.once('SIGTERM', () => { stop('SIGTERM'); });
      process.once('SIGINT', () => { stop('SIGINT'); });
      await runManagedSupervisorDaemon({
        runDir,
        sessionNonce,
        serveRuntimeControlSocket,
        activateController: (args) => activateManagedSupervisorController({ ...args, runDir, supervisorSessionNonce: sessionNonce }),
        onReady: async (socketPath) => process.send?.({ schema: 'lattice.runtime_supervisor_bootstrap_ready.v1', pid: process.pid, processStartIdentity: await observeManagedProcessStartIdentity(process.pid), socketPath, sessionNonce }),
        registerDaemonCleanup: (handler) => { if (typeof handler !== 'function') fail('SUPERVISOR_CONFIGURATION_INVALID', 'daemon cleanup handler不正'); daemonCleanup = handler; },
        crashInjector: process.env.NODE_ENV === 'test' && process.env.LATTICE_INTERNAL_TEST_CRASH_POINT
          ? async (point) => {
            if (point === process.env.LATTICE_INTERNAL_TEST_CRASH_POINT) process.kill(process.pid, 'SIGKILL');
          }
          : null,
        validatePhaseRevision: validatePhaseTodoRevision,
        commitPhaseRevision: (revision) => applyPhaseTodoRevision({
          repoRoot: path.resolve(runDir, '..', '..', '..'),
          writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision,
          // actorは`{host, session, agent}`のexact recordである（`lattice.todo_event.v4`）。
          // 文字列を渡していた間、seam_splitの再計画はphase revisionをcommitできなかった
          // ——工程storeへ書く直前で必ず落ちるので、請求項8の再開まで一度も届いていない。
          actor: {
            host: 'lattice-runtime',
            session: sessionNonce.slice(0, 32),
            agent: 'lattice-runtime-supervisor',
          },
          recordedAt: new Date().toISOString(),
        }),
      });
    })
    .catch((error) => {
      process.send?.({
        schema: 'lattice.runtime_supervisor_bootstrap_failure.v1',
        code: error instanceof ManagedRuntimeError ? error.code : 'ADAPTER_CONTROLLER_UNAVAILABLE',
        detail: String(error?.message ?? error),
      });
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
