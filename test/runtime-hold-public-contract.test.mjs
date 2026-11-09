import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeTest from 'node:test';

const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

import { RUN_EVENT_KINDS, selfDigest } from '../src/runtime-contracts.mjs';
import {
  buildCarryOverWitness,
  decideHoldAndCarryOver,
  recompileNextEpochPlan,
  routeConflictTreatment,
  validateRuntimeTaskMigration,
} from '../src/runtime-hold-recompile.mjs';
import { projectRuntimeState } from '../src/runtime-projection.mjs';
import { invokeSensorCli } from '../src/sensor-runtime.mjs';
import {
  TODO_EVENT_KINDS, digestTodoArtifact, todoSelfDigest, validateTodoEvent,
  validateTodoPlan, validateTodoSnapshot,
} from '../src/todo-contracts.mjs';
import { phaseTodoRevisionPlanVersion, validatePhaseTodoRevision } from '../src/todo-revision.mjs';
import {
  applyPhaseTodoRevision,
  buildTodoPlan,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';

// ADR 0064の実装前characterization。公開bridge実装時は未来surfaceのusage拒否を
// success／typed failureへ反転する。既存CLI互換、core存在、TODO所有境界、managed
// protocolの因果条件は実装後も不変の安全網として残す。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const RUN_ID = 'runtime-hold-contract-fixture';
const RUN_REF = path.join('.lattice', 'runs', RUN_ID);
const DIGEST = 'd'.repeat(64);

let temporaryRoot;
let fixtureRoot;
let requestPath;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function runCli(args, cwd = fixtureRoot) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined);
  return result;
}

function witness() {
  return {
    owns: [{ kind: 'symbol', target: 'alpha' }, { kind: 'path', target: 'src/alpha.mjs' }],
    reads: [],
    writes: ['src/alpha.mjs'],
    resources: [],
    state_effects: [],
    sensor_provenance: {
      queries: [
        { query_id: 'q-alpha', expect: { kind: 'symbol', name: 'alpha', path: 'src/alpha.mjs' } },
        { query_id: 'q-alpha-aff', expect: { kind: 'affected', path: 'src/alpha.mjs' } },
      ],
    },
    affected_tests: ['test/alpha.test.mjs'],
    unknowns: [],
  };
}

if (process.platform !== 'win32') nodeTest.before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'lattice-runtime-hold-contract-'));
  fixtureRoot = path.join(temporaryRoot, 'repo');
  await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  await mkdir(path.join(fixtureRoot, 'test'), { recursive: true });
  await writeFile(path.join(fixtureRoot, '.gitignore'), '.lattice/runs/\n');
  await writeFile(path.join(fixtureRoot, 'src', 'alpha.mjs'), 'export const alpha = 1;\n');
  await writeFile(path.join(fixtureRoot, 'test', 'alpha.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { alpha } from '../src/alpha.mjs';",
    "test('alpha', () => assert.equal(alpha, 1));",
    '',
  ].join('\n'));
  run('git', ['init', '--quiet', '--initial-branch=main'], fixtureRoot);
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'add', '.'], fixtureRoot);
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'commit', '--quiet', '-m', 'base'], fixtureRoot);
  const baseSha = run('git', ['rev-parse', 'HEAD'], fixtureRoot).trim();
  invokeSensorCli(run, ['init', '.'], fixtureRoot);

  const request = {
    schema: 'lattice.run_request.v1',
    request_id: RUN_ID,
    repo: { base_sha: baseSha, root_kind: 'git-worktree' },
    capacity: { executors: 1 },
    todos: [{ todo_id: 'T1' }],
    manual_witness: { T1: witness() },
    sensor_query_set: {
      queries: [
        { id: 'q-status', operation: 'status' },
        { id: 'q-alpha', operation: 'query', target: 'alpha' },
        { id: 'q-alpha-aff', operation: 'affected', target: 'src/alpha.mjs' },
      ],
    },
    executor_capability: { adapters: ['scripted'] },
    claim_mode: 'exact_minimum',
  };
  request.request_digest = selfDigest(request, 'request_digest');
  requestPath = path.join(temporaryRoot, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);

  const started = runCli(['run', 'start', '--request', requestPath, '--executor', 'scripted']);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).schema, 'lattice.run_start_result.v1');
});

if (process.platform !== 'win32') nodeTest.after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

function assertUsageRejected(args) {
  const result = runCli(args);
  const received = args.join(' ');
  assert.equal(result.status, 2, received);
  assert.equal(result.stdout, '', received);
  if (args[0] === 'todo') {
    const error = JSON.parse(result.stderr);
    assert.ok(['INVALID_ARGUMENTS', 'UNKNOWN_SUBCOMMAND', 'INPUT_OUTSIDE_REPOSITORY']
      .includes(error.code), received);
  } else {
    assert.equal(JSON.parse(result.stderr).message, `unsupported command or arguments: ${received}`);
  }
}

async function snapshotRegularFiles(root, relative = '') {
  const result = {};
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshotRegularFiles(root, child));
    else if (entry.isFile()) result[child] = await readFile(path.join(root, child));
  }
  return result;
}

test('valid run storeで既存observe・status・resume wireとread-only性を維持する', async () => {
  const runStore = path.join(fixtureRoot, RUN_REF);
  const before = await snapshotRegularFiles(runStore);

  const observe = runCli(['run', 'observe', '--run', RUN_REF]);
  assert.equal(observe.status, 0, observe.stderr);
  assert.equal(JSON.parse(observe.stdout).schema, 'lattice.run_observation.v1');

  const status = runCli(['run', 'status', '--run', RUN_REF]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).schema, 'lattice.run_status.v1');
  assert.deepEqual(JSON.parse(status.stdout).dispatchable, ['T1']);

  const resume = runCli(['run', 'resume', '--run', RUN_REF]);
  assert.equal(resume.status, 0, resume.stderr);
  const resumeOutput = JSON.parse(resume.stdout);
  assert.equal(resumeOutput.schema, 'lattice.run_resume_result.v1');
  assert.equal(resumeOutput.outcome, 'resumable');
  assert.deepEqual(Object.keys(resumeOutput).sort(), [
    'accepted', 'dispatchable', 'event_count', 'executor_adapter', 'outcome',
    'result_digest', 'run_id', 'running', 'schema',
  ]);

  assert.deepEqual(await snapshotRegularFiles(runStore), before);
});

test('LPG028 managed verbは公開しexternal ack形だけを公開しない', async () => {
  const runStore = path.join(fixtureRoot, RUN_REF);
  const before = await snapshotRegularFiles(runStore);
  const publicSurface = [
    ['run', 'finding', 'record', '--run', RUN_REF, '--checkpoint', DIGEST,
      '--input', 'finding-candidate.json'],
    ['run', 'recompile', '--run', RUN_REF, '--input', 'recompile-request.json'],
  ];
  for (const args of publicSurface) {
    const result = runCli(args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).code, 'RUN_NOT_MANAGED');
  }
  assert.deepEqual(await snapshotRegularFiles(runStore), before);

  const futureSurface = [
    ['todo', 'runtime', 'bind', '--plan', 'main', '--task', 'T1', '--run', RUN_REF,
      '--runtime-task', 'T1', '--evidence', 'binding-evidence.json'],
    ['todo', 'runtime', 'unbind', '--plan', 'main', '--task', 'T1', '--reason', 'run-finished'],
  ];
  for (const args of futureSurface) assertUsageRejected(args);

  for (const forbiddenAckSurface of [
    ['run', 'hold', 'ack', '--run', RUN_REF, '--input', 'hold-ack.json'],
    ['run', 'hold', '--run', RUN_REF, '--input', 'hold-ack.json'],
  ]) assertUsageRejected(forbiddenAckSurface);
});

test('公開済みmanaged mutationはunmanaged runをtyped拒否しstoreを変更しない', async () => {
  const runStore = path.join(fixtureRoot, RUN_REF);
  const before = await snapshotRegularFiles(runStore);
  for (const args of [
    ['run', 'conflict', '--run', RUN_REF, '--finding', DIGEST],
    ['run', 'hold', '--run', RUN_REF],
    ['run', 'reprocess', '--run', RUN_REF],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'RUN_NOT_MANAGED');
  }
  assert.deepEqual(await snapshotRegularFiles(runStore), before);
});

test('activateは未登録adapterをtyped拒否しrun store bytesを維持する', async () => {
  const runStore = path.join(fixtureRoot, RUN_REF);
  const before = await snapshotRegularFiles(runStore);
  const result = runCli(['run', 'activate', '--run', RUN_REF]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).code, 'ADAPTER_NOT_REGISTERED', result.stderr);
  assert.deepEqual(await snapshotRegularFiles(runStore), before);
});

test('selective hold・carry-over・epoch recompileのproducer coreは既に存在する', () => {
  assert.equal(typeof buildCarryOverWitness, 'function');
  assert.equal(typeof decideHoldAndCarryOver, 'function');
  assert.equal(typeof recompileNextEpochPlan, 'function');
  assert.equal(typeof routeConflictTreatment, 'function');

  const treatment = [{ treatment_id: 'split-shared-seam', covered_paths: ['src/shared.mjs'] }];
  assert.equal(routeConflictTreatment({
    finding: {
      kind: 'observed_write_conflict', todo_ids: ['T1', 'T2'], path: 'src/shared.mjs',
    },
    predeclaredTreatments: treatment,
  }).lane, 'seam_transform');
  assert.equal(routeConflictTreatment({
    finding: {
      kind: 'semantic_conflict_unknown', todo_ids: ['T1', 'T2'], resource_id: 'shared-state',
    },
    predeclaredTreatments: treatment,
  }).lane, 'intentional_serial');
});

const DESCRIPTOR_KEYS = [
  'adapter_kind', 'capabilities', 'controller_id', 'controller_session_nonce_digest',
  'descriptor_digest', 'heartbeat', 'pid', 'process_start_identity', 'schema', 'socket_ref',
].sort();

class AdapterRegistryFake {
  constructor() {
    this.registryPath = '.lattice/runtime/adapter-registry/registry.json';
    this.registry = { schema: 'lattice.runtime_adapter_registry.v1', entries: [{
      adapter_kind: 'fake-managed',
      launch_descriptor_ref: '.lattice/runtime/adapter-registry/descriptors/fake-managed.json',
      launch_descriptor_digest: '7'.repeat(64),
    }], registry_digest: '8'.repeat(64) };
    this.descriptor = { schema: 'lattice.runtime_adapter_launch_descriptor.v1',
      adapter_kind: 'fake-managed', launch_kind: 'host_binary', binary_path: '/usr/bin/fake-managed',
      binary_digest: '1'.repeat(64), binary_identity: { schema: 'lattice.macos_binary_identity.v1',
        kind: 'macos_codesign', cdhash: 'cdhash-1', signing_identifier: 'dev.lattice.fake-managed',
        team_identifier: null, designated_requirement_digest: '2'.repeat(64),
        identity_digest: '4'.repeat(64) },
      argv: ['--control-host'], config_ref: '.lattice/runtime/adapter-registry/fake-managed.json',
      config_digest: '9'.repeat(64), endpoint: null, capabilities_digest: '3'.repeat(64),
      descriptor_digest: '7'.repeat(64) };
  }

  resolve(adapterKind) {
    assert.deepEqual(Object.keys(this.registry).sort(), ['entries', 'registry_digest', 'schema']);
    assert.deepEqual(Object.keys(this.registry.entries[0]).sort(), [
      'adapter_kind', 'launch_descriptor_digest', 'launch_descriptor_ref',
    ]);
    assert.deepEqual(Object.keys(this.descriptor).sort(), [
      'adapter_kind', 'argv', 'binary_digest', 'binary_identity', 'binary_path', 'capabilities_digest', 'config_digest',
      'config_ref', 'descriptor_digest', 'endpoint', 'launch_kind', 'schema',
    ]);
    assert.deepEqual(Object.keys(this.descriptor.binary_identity).sort(), [
      'cdhash', 'designated_requirement_digest', 'identity_digest', 'kind', 'schema',
      'signing_identifier', 'team_identifier',
    ]);
    if (adapterKind !== this.registry.entries[0].adapter_kind) throw new Error('ADAPTER_NOT_REGISTERED');
    assert.equal(this.descriptor.descriptor_digest,
      this.registry.entries[0].launch_descriptor_digest);
    return this.descriptor;
  }

  verifyHostBinary(stage, observed) {
    assert.ok(['before-spawn', 'after-exec'].includes(stage));
    if (observed.path !== this.descriptor.binary_path
      || observed.digest !== this.descriptor.binary_digest
      || observed.identity_digest !== this.descriptor.binary_identity.identity_digest) {
      throw new Error('ADAPTER_BINARY_IDENTITY_MISMATCH');
    }
    return true;
  }
}

const CONTROLLER_PROTOCOL = Object.freeze({
  dispatch: {
    requestSchema: 'lattice.adapter_dispatch_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'packet', 'write_lease', 'request_digest'],
    responseSchema: 'lattice.adapter_dispatch_response.v1',
    responseKeys: ['schema', 'request_id', 'executor_handle', 'worktree_id', 'packet_digest', 'lease_digest', 'response_digest'],
  },
  observe: {
    requestSchema: 'lattice.adapter_observe_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'executor_handle', 'expected_epoch', 'expected_lease_digest', 'request_digest'],
    responseSchema: 'lattice.adapter_observe_response.v1',
    responseKeys: ['schema', 'request_id', 'observation', 'observation_digest', 'response_digest'],
  },
  inventory: {
    requestSchema: 'lattice.adapter_running_inventory_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'frozen_event_digest', 'request_digest'],
    responseSchema: 'lattice.adapter_running_inventory_response.v1',
    responseKeys: ['schema', 'request_id', 'running_bindings', 'inventory_digest', 'response_digest'],
  },
  barrier: {
    requestSchema: 'lattice.adapter_barrier_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'barrier_id', 'reason', 'running_bindings', 'frozen_event_digest', 'barrier_control_digest', 'request_digest'],
    responseSchema: 'lattice.adapter_barrier_response.v1',
    responseKeys: ['schema', 'request_id', 'barrier_id', 'quiescence_acks', 'response_digest'],
  },
  rebind: {
    requestSchema: 'lattice.adapter_rebind_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'rebind_packet', 'staged_lease', 'request_digest'],
    responseSchema: 'lattice.adapter_rebind_response.v1',
    responseKeys: ['schema', 'request_id', 'rebind_ack', 'staged_lease_digest', 'response_digest'],
  },
  prepare: {
    requestSchema: 'lattice.adapter_prepare_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'executor_packet', 'staged_lease', 'request_digest'],
    responseSchema: 'lattice.adapter_prepare_response.v1',
    responseKeys: ['schema', 'request_id', 'prepare_ack', 'staged_lease_digest', 'response_digest'],
  },
  activate: {
    requestSchema: 'lattice.adapter_activate_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'committed_epoch_digest', 'activation_digest', 'staged_lease_digests', 'request_digest'],
    responseSchema: 'lattice.adapter_activate_response.v1',
    responseKeys: ['schema', 'request_id', 'ready_ack', 'observed_pointer_digest', 'response_digest'],
  },
  release: {
    requestSchema: 'lattice.adapter_release_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'release_barrier_digest', 'activation_digest', 'gate_generation', 'staged_lease_digests', 'request_digest'],
    responseSchema: 'lattice.adapter_release_response.v1',
    responseKeys: ['schema', 'request_id', 'release_ack', 'armed_lease_digests', 'observed_gate_generation', 'response_digest'],
  },
  revoke: {
    requestSchema: 'lattice.adapter_revoke_request.v1',
    requestKeys: ['schema', 'request_id', 'registration_digest', 'reason', 'lease_digests', 'request_digest'],
    responseSchema: 'lattice.adapter_revoke_response.v1',
    responseKeys: ['schema', 'request_id', 'revoked_lease_digests', 'residual_processes', 'response_digest'],
  },
});

class ControllerProtocolFake {
  exchange(operation) {
    const contract = CONTROLLER_PROTOCOL[operation];
    if (contract === undefined) throw new Error('UNKNOWN_CONTROLLER_OPERATION');
    const request = Object.fromEntries(contract.requestKeys.map((key) => [key, key === 'schema'
      ? contract.requestSchema : `${operation}-${key}`]));
    const response = Object.fromEntries(contract.responseKeys.map((key) => [key, key === 'schema'
      ? contract.responseSchema : `${operation}-${key}`]));
    assert.deepEqual(Object.keys(request).sort(), [...contract.requestKeys].sort());
    assert.deepEqual(Object.keys(response).sort(), [...contract.responseKeys].sort());
    return { request, response };
  }
}

class AdapterControllerFake {
  constructor(id = 'controller-1') {
    this.descriptor = {
      schema: 'lattice.runtime_adapter_controller_descriptor.v1',
      controller_id: id,
      adapter_kind: 'fake-managed',
      pid: 4242,
      process_start_identity: { schema: 'lattice.process_start_identity.v1', platform: 'fake',
        pid: 4242, started_identity: 'boot-1:tick-42', identity_digest: '1'.repeat(64) },
      socket_ref: `supervisor/controllers/${id}.sock`,
      controller_session_nonce_digest: '2'.repeat(64),
      capabilities: { schema: 'lattice.runtime_adapter_capabilities.v1',
        operations: ['activate', 'barrier', 'dispatch', 'observe', 'prepare', 'rebind', 'release', 'revoke'],
        process_observation: true, worktree_fingerprint: true, staged_write_lease: true,
        durable_dispatch: true, capabilities_digest: '3'.repeat(64) },
      heartbeat: { schema: 'lattice.runtime_heartbeat_policy.v1', interval_ms: 100,
        ttl_ms: 500, disconnect_revokes_immediately: true, policy_digest: '4'.repeat(64) },
      descriptor_digest: '',
    };
    this.descriptor.descriptor_digest = selfDigest(this.descriptor, 'descriptor_digest');
    this.supervisorNonce = null;
    this.connected = false;
    this.heartbeatFresh = false;
    this.running = new Map();
    this.leases = new Map();
    this.stagedBindings = new Map();
    this.trace = [];
  }

  register(supervisorNonce) {
    assert.deepEqual(Object.keys(this.descriptor).sort(), DESCRIPTOR_KEYS);
    assert.deepEqual(Object.keys(this.descriptor.process_start_identity).sort(), [
      'identity_digest', 'pid', 'platform', 'schema', 'started_identity',
    ]);
    assert.deepEqual(Object.keys(this.descriptor.capabilities).sort(), [
      'capabilities_digest', 'durable_dispatch', 'operations', 'process_observation',
      'schema', 'staged_write_lease', 'worktree_fingerprint',
    ]);
    assert.deepEqual(Object.keys(this.descriptor.heartbeat).sort(), [
      'disconnect_revokes_immediately', 'interval_ms', 'policy_digest', 'schema', 'ttl_ms',
    ]);
    this.supervisorNonce = supervisorNonce;
    this.connected = true;
    this.heartbeatFresh = true;
    this.trace.push('registered');
    this.registration = { schema: 'lattice.runtime_adapter_registration.v1',
      registration_id: `reg-${this.descriptor.controller_id}`, run_id: RUN_ID,
      supervisor_session_nonce_digest: supervisorNonce,
      controller_descriptor_digest: this.descriptor.descriptor_digest,
      registered_operations: [...this.descriptor.capabilities.operations],
      registered_at: '2026-07-21T00:00:00.000Z', registration_digest: '' };
    this.registration.registration_digest = selfDigest(this.registration, 'registration_digest');
    this.registrationDigest = this.registration.registration_digest;
    return this.registration;
  }

  assertChannel(nonce) {
    assert.equal(this.connected, true, 'controller socket断');
    assert.equal(this.heartbeatFresh, true, 'controller heartbeat期限切れ');
    assert.equal(nonce, this.supervisorNonce, 'stale supervisor session nonce');
  }

  dispatch(binding, nonce) {
    this.assertChannel(nonce);
    this.running.set(binding.todo_id, { ...binding, write_enabled: true });
    this.leases.set(binding.todo_id, { id: binding.write_lease_id, state: 'active' });
    this.trace.push(`dispatch:${binding.todo_id}`);
    return { executor_handle: `exec-${binding.todo_id}`, worktree_id: `wt-${binding.todo_id}` };
  }

  observe(todoId, nonce) {
    this.assertChannel(nonce);
    this.trace.push(`observe:${todoId}`);
    return { todo_id: todoId, write_enabled: this.running.get(todoId)?.write_enabled ?? false };
  }

  barrierAll(nonce, kind = 'hold') {
    this.assertChannel(nonce);
    const acks = [];
    for (const [todoId, state] of this.running) {
      state.write_enabled = false;
      const lease = this.leases.get(todoId);
      if (lease) lease.state = 'revoked';
      acks.push({ todo_id: todoId, plan_epoch: state.plan_epoch,
        packet_digest: state.packet_digest, write_lease_id: state.write_lease_id,
        supervisor_session_nonce_digest: nonce, source: 'adapter-control-socket' });
    }
    this.trace.push(`barrier:${kind}`);
    return acks;
  }

  prepare(binding, nonce) {
    this.assertChannel(nonce);
    assert.equal(this.running.get(binding.todo_id)?.write_enabled, false, 'quiescence前prepare');
    const stagedLease = { schema: 'lattice.runtime_write_lease.v1',
      lease_id: binding.new_write_lease_id, run_id: RUN_ID, todo_id: binding.todo_id,
      plan_epoch: binding.successor_epoch, packet_digest: binding.packet_digest,
      controller_registration_digest: this.registrationDigest,
      supervisor_session_nonce_digest: nonce, state: 'staged', ttl_ms: 500,
      issued_control_digest: '8'.repeat(64), lease_digest: '' };
    stagedLease.lease_digest = selfDigest(stagedLease, 'lease_digest');
    this.leases.set(binding.todo_id, stagedLease);
    this.stagedBindings.set(binding.todo_id, { ...binding });
    this.trace.push(`staged:${binding.todo_id}`);
    return { todo_id: binding.todo_id, successor_epoch: binding.successor_epoch,
      packet_digest: binding.packet_digest, staged_lease_id: binding.new_write_lease_id,
      supervisor_session_nonce_digest: nonce, source: 'adapter-control-socket' };
  }

  readyAll(activationDigest, nonce) {
    this.assertChannel(nonce);
    assert.equal(typeof activationDigest, 'string');
    assert.equal([...this.leases.values()].filter(({ state }) => state === 'active').length, 0);
    this.trace.push('activation_ready');
    return { activation_digest: activationDigest, source: 'adapter-control-socket' };
  }

  releaseAll(releaseDigest, nonce) {
    this.assertChannel(nonce);
    assert.equal(typeof releaseDigest, 'string');
    for (const [todoId, lease] of this.leases) {
      if (lease.state !== 'staged') continue;
      const armedLease = gateLease(lease.lease_id, lease.controller_registration_digest, {
        todo_id: lease.todo_id, packet_digest: lease.packet_digest,
        supervisor_session_nonce_digest: lease.supervisor_session_nonce_digest,
        ttl_ms: lease.ttl_ms, issued_control_digest: lease.issued_control_digest,
        release_barrier_digest: releaseDigest,
      });
      this.leases.set(todoId, armedLease);
      const state = this.running.get(todoId);
      const staged = this.stagedBindings.get(todoId);
      if (state && staged) {
        state.plan_epoch = staged.successor_epoch;
        state.packet_digest = staged.packet_digest;
        state.write_lease_id = staged.new_write_lease_id;
        state.write_enabled = false;
      }
    }
    this.trace.push('release_barrier');
    this.lastReleaseAck = releaseAck(this.descriptor.controller_id, this.registrationDigest,
      [...this.leases.values()], { supervisor_session_nonce_digest: nonce });
    return { release_ack: this.lastReleaseAck,
      armed_lease_digests: this.lastReleaseAck.armed_lease_digests,
      observed_gate_generation: 0 };
  }

  writeAuthorized(todoId, centralGate, allLeases = [...this.leases.values()],
    releaseAcks = [this.lastReleaseAck], registrations = [this.registration],
    controllerDescriptors = [this.descriptor]) {
    try {
      verifyCentralGate(centralGate, { leases: allLeases, releaseAcks, registrations,
        controllerDescriptors });
      return this.leases.get(todoId)?.state === 'armed'
        && centralGate.armed_lease_digests.includes(this.leases.get(todoId).lease_digest);
    } catch { return false; }
  }

  revokeAll(reason) {
    for (const lease of this.leases.values()) lease.state = 'revoked';
    for (const state of this.running.values()) state.write_enabled = false;
    this.trace.push(`revoke:${reason}`);
  }

  disconnect() {
    this.connected = false;
    this.revokeAll('socket-disconnect');
  }

  expireHeartbeat() {
    this.heartbeatFresh = false;
    this.revokeAll('heartbeat-expired');
  }
}

function gateLease(leaseId, controllerDigest, overrides = {}) {
  const lease = { schema: 'lattice.runtime_write_lease.v2', lease_id: leaseId,
    run_id: RUN_ID, todo_id: leaseId, plan_epoch: 2, packet_digest: '9'.repeat(64),
    controller_registration_digest: controllerDigest,
    supervisor_session_nonce_digest: 'a'.repeat(64), state: 'armed', ttl_ms: 500,
    issued_control_digest: '8'.repeat(64), release_barrier_digest: 'e'.repeat(64),
    gate_generation: 1, lease_digest: '', ...overrides };
  lease.lease_digest = selfDigest(lease, 'lease_digest');
  return lease;
}

function defaultGateIdentities() {
  return ['controller-a', 'controller-b'].map((id) => {
    const controller = new AdapterControllerFake(id);
    const registration = controller.register('a'.repeat(64));
    return { descriptor: controller.descriptor, registration };
  });
}

const defaultGateRegistrations = () => defaultGateIdentities().map(({ registration }) => registration);
const defaultGateDescriptors = () => defaultGateIdentities().map(({ descriptor }) => descriptor);
const defaultGateLeases = () => defaultGateRegistrations().map((registration, index) => (
  gateLease(`lease-T${index + 1}-2`, registration.registration_digest)
));

function releaseAck(controllerId, registrationDigest, leases, overrides = {}) {
  const ack = { schema: 'lattice.adapter_release_ack.v1', ack_id: `ack-${controllerId}`,
    registration_digest: registrationDigest, controller_id: controllerId, run_id: RUN_ID,
    plan_epoch: 2, release_barrier_digest: 'e'.repeat(64), gate_generation: 1,
    armed_lease_digests: leases.map(({ lease_digest: digest }) => digest).sort(),
    supervisor_session_nonce_digest: 'a'.repeat(64), ack_digest: '', ...overrides };
  ack.ack_digest = selfDigest(ack, 'ack_digest');
  return ack;
}

function defaultGateAcks() {
  const leases = defaultGateLeases();
  const registrations = defaultGateRegistrations();
  const descriptors = defaultGateDescriptors();
  return registrations.map((registration, index) => releaseAck(
    descriptors[index].controller_id, registration.registration_digest, [leases[index]],
  ));
}

function centralGateDocument(overrides = {}) {
  const gate = { schema: 'lattice.supervisor_write_gate.v1', run_id: RUN_ID,
    plan_epoch: 2, gate_generation: 1, release_barrier_digest: 'e'.repeat(64),
    controller_release_ack_digests: defaultGateAcks().map(({ ack_digest: digest }) => digest).sort(),
    armed_lease_digests: defaultGateLeases().map(({ lease_digest: digest }) => digest).sort(),
    previous_gate_digest: '0'.repeat(64), committed_at: '2026-07-21T00:00:00.000Z',
    gate_digest: '', ...overrides };
  gate.gate_digest = selfDigest(gate, 'gate_digest');
  return gate;
}

function verifyCentralGate(gate, { expectedRunId = RUN_ID, expectedEpoch = 2,
  expectedGeneration = 1, expectedPreviousGateDigest = '0'.repeat(64),
  expectedReleaseBarrierDigest = 'e'.repeat(64), leases = defaultGateLeases(),
  releaseAcks = defaultGateAcks(), registrations = defaultGateRegistrations(),
  controllerDescriptors = defaultGateDescriptors(),
  expectedSupervisorSessionNonceDigest = 'a'.repeat(64) } = {}) {
  assert.deepEqual(Object.keys(gate).sort(), [
    'armed_lease_digests', 'committed_at', 'controller_release_ack_digests', 'gate_digest',
    'gate_generation', 'plan_epoch', 'previous_gate_digest', 'release_barrier_digest',
    'run_id', 'schema',
  ]);
  assert.equal(gate.gate_digest, selfDigest(gate, 'gate_digest'), 'gate self digest不一致');
  assert.equal(gate.run_id, expectedRunId, 'gate run不一致');
  assert.equal(gate.plan_epoch, expectedEpoch, 'gate epoch不一致');
  assert.equal(gate.gate_generation, expectedGeneration, 'stale gate generation');
  assert.equal(gate.previous_gate_digest, expectedPreviousGateDigest, 'gate chain不一致');
  assert.equal(gate.release_barrier_digest, expectedReleaseBarrierDigest, 'release barrier不一致');
  const expectedLeases = leases.map((lease) => {
    assert.deepEqual(Object.keys(lease).sort(), [
      'controller_registration_digest', 'gate_generation', 'issued_control_digest',
      'lease_digest', 'lease_id', 'packet_digest', 'plan_epoch', 'release_barrier_digest',
      'run_id', 'schema', 'state', 'supervisor_session_nonce_digest', 'todo_id', 'ttl_ms',
    ]);
    assert.equal(lease.schema, 'lattice.runtime_write_lease.v2');
    assert.equal(lease.lease_digest, selfDigest(lease, 'lease_digest'), 'lease self digest不一致');
    assert.equal(lease.run_id, expectedRunId, 'lease run membership不一致');
    assert.equal(lease.plan_epoch, expectedEpoch, 'lease epoch membership不一致');
    assert.equal(lease.release_barrier_digest, expectedReleaseBarrierDigest,
      'lease release barrier membership不一致');
    assert.equal(lease.state, 'armed', 'lease state membership不一致');
    assert.equal(lease.gate_generation, expectedGeneration, 'lease gate generation不一致');
    assert.equal(lease.supervisor_session_nonce_digest,
      expectedSupervisorSessionNonceDigest, 'lease session nonce不一致');
    assert.equal(typeof lease.controller_registration_digest, 'string');
    return lease.lease_digest;
  }).sort();
  assert.deepEqual(gate.armed_lease_digests, expectedLeases, 'armed lease集合不一致');
  assert.equal(controllerDescriptors.length, registrations.length, 'descriptor/registration数不一致');
  const descriptorByDigest = new Map();
  for (const descriptor of controllerDescriptors) {
    assert.deepEqual(Object.keys(descriptor).sort(), DESCRIPTOR_KEYS);
    assert.equal(descriptor.descriptor_digest,
      selfDigest(descriptor, 'descriptor_digest'), 'controller descriptor self digest不一致');
    assert.equal(descriptorByDigest.has(descriptor.descriptor_digest), false, 'descriptor重複');
    descriptorByDigest.set(descriptor.descriptor_digest, descriptor);
  }
  const registrationByDigest = new Map();
  const registeredControllerIds = new Set();
  for (const registration of registrations) {
    assert.deepEqual(Object.keys(registration).sort(), [
      'controller_descriptor_digest', 'registered_at', 'registered_operations',
      'registration_digest', 'registration_id', 'run_id', 'schema',
      'supervisor_session_nonce_digest',
    ]);
    assert.equal(registration.schema, 'lattice.runtime_adapter_registration.v1');
    assert.equal(registration.registration_digest,
      selfDigest(registration, 'registration_digest'), 'registration self digest不一致');
    assert.equal(registration.run_id, expectedRunId, 'registration run不一致');
    assert.equal(registration.supervisor_session_nonce_digest,
      expectedSupervisorSessionNonceDigest, 'registration session nonce不一致');
    const descriptor = descriptorByDigest.get(registration.controller_descriptor_digest);
    assert.ok(descriptor, 'registration descriptor digest不一致');
    assert.equal(registeredControllerIds.has(descriptor.controller_id), false,
      'registration controller重複');
    registeredControllerIds.add(descriptor.controller_id);
    assert.equal(registrationByDigest.has(registration.registration_digest), false,
      'registration digest重複');
    registrationByDigest.set(registration.registration_digest, { registration, descriptor });
  }
  for (const lease of leases) {
    const identity = registrationByDigest.get(lease.controller_registration_digest);
    assert.ok(identity, 'lease owning registration不一致');
    assert.equal(lease.supervisor_session_nonce_digest,
      identity.registration.supervisor_session_nonce_digest,
      'lease/registration session nonce不一致');
  }
  assert.equal(releaseAcks.length, registrations.length, 'release ack数不一致');
  const ackControllers = new Set();
  const ackLeaseDigests = [];
  for (const ack of releaseAcks) {
    assert.deepEqual(Object.keys(ack).sort(), [
      'ack_digest', 'ack_id', 'armed_lease_digests', 'controller_id', 'gate_generation',
      'plan_epoch', 'registration_digest', 'release_barrier_digest', 'run_id', 'schema',
      'supervisor_session_nonce_digest',
    ]);
    assert.equal(ack.schema, 'lattice.adapter_release_ack.v1');
    assert.equal(ack.ack_digest, selfDigest(ack, 'ack_digest'), 'release ack self digest不一致');
    assert.equal(ack.run_id, expectedRunId, 'release ack run不一致');
    assert.equal(ack.plan_epoch, expectedEpoch, 'release ack epoch不一致');
    assert.equal(ack.release_barrier_digest, expectedReleaseBarrierDigest,
      'release ack barrier不一致');
    assert.equal(ack.gate_generation, expectedGeneration, 'release ack generation不一致');
    assert.equal(ack.supervisor_session_nonce_digest,
      expectedSupervisorSessionNonceDigest, 'release ack session nonce不一致');
    const identity = registrationByDigest.get(ack.registration_digest);
    assert.ok(identity, 'release ack registration不一致');
    assert.equal(identity.descriptor.controller_id, ack.controller_id,
      'release ack descriptor/controller不一致');
    assert.equal(ackControllers.has(ack.controller_id), false, 'release ack controller重複');
    ackControllers.add(ack.controller_id);
    const owned = leases.filter(({ controller_registration_digest: digest }) => (
      digest === ack.registration_digest)).map(({ lease_digest: digest }) => digest).sort();
    assert.deepEqual(ack.armed_lease_digests, owned, 'release ack lease ownership不一致');
    ackLeaseDigests.push(...ack.armed_lease_digests);
  }
  assert.deepEqual([...ackLeaseDigests].sort(), expectedLeases, 'release ack lease union不一致');
  assert.deepEqual(gate.controller_release_ack_digests,
    releaseAcks.map(({ ack_digest: digest }) => digest).sort(), 'release ack digest集合不一致');
  return true;
}

class ManagedSupervisorFake {
  constructor(controller) {
    this.controller = controller;
    this.sessionNonceDigest = 'a'.repeat(64);
    this.registration = controller.register(this.sessionNonceDigest);
    this.expected = new Set();
    this.prepared = new Map();
    this.queue = [];
    this.committedEpoch = 1;
    this.activeEpoch = 1;
    this.fullyActivated = true;
    this.centralGate = { schema: 'lattice.supervisor_write_gate.v1', gate_generation: 0 };
    this.frozen = false;
    this.closed = false;
    this.trace = [];
  }

  dispatch(binding) {
    if (this.frozen || (this.committedEpoch > this.activeEpoch && !this.fullyActivated)) {
      throw new Error('RUN_FROZEN');
    }
    const result = this.controller.dispatch(binding, this.sessionNonceDigest);
    this.expected.add(binding.todo_id);
    this.trace.push(`dispatch_routed:${binding.todo_id}`);
    return result;
  }

  observe(todoId) {
    const result = this.controller.observe(todoId, this.sessionNonceDigest);
    this.trace.push(`observation_routed:${todoId}`);
    return result;
  }

  holdAll() {
    this.frozen = true;
    const acks = this.controller.barrierAll(this.sessionNonceDigest);
    assert.deepEqual(new Set(acks.map(({ todo_id: todoId }) => todoId)), this.expected);
    this.trace.push('all_running_quiesced');
    return acks;
  }

  prepareEpoch(bindings) {
    for (const binding of bindings) {
      this.prepared.set(binding.todo_id, this.controller.prepare(binding, this.sessionNonceDigest));
      this.trace.push(`staged_ack:${binding.todo_id}`);
    }
  }

  enqueueFinding(digest) {
    this.queue.push(digest);
    this.trace.push(`queued:${digest.slice(0, 4)}`);
  }

  commitAndReady() {
    assert.equal(this.prepared.size, this.expected.size, '全staged lease ack前のcommitは禁止');
    assert.equal(this.queue.length, 0, 'queued conflict clear前のcommitは禁止');
    this.committedEpoch = 2;
    this.fullyActivated = false;
    this.trace.push('pointer_commit');
    const readyAck = this.controller.readyAll('9'.repeat(64), this.sessionNonceDigest);
    this.trace.push('all_activation_ready');
    assert.equal([...this.controller.leases.values()].filter(({ state }) => state === 'active').length, 0);
    return readyAck;
  }

  releaseEpoch() {
    assert.equal(this.committedEpoch, 2, 'commit前のreleaseは禁止');
    assert.equal(this.fullyActivated, false, 'release済みepochの再releaseは禁止');
    this.trace.push('release_barrier_commit');
    const releaseAck = this.controller.releaseAll('e'.repeat(64), this.sessionNonceDigest);
    this.trace.push('all_release_acknowledged');
    assert.equal([...this.controller.leases.keys()].every((todoId) => (
      !this.controller.writeAuthorized(todoId, this.centralGate))), true);
    this.centralGate = centralGateDocument({
      controller_release_ack_digests: [releaseAck.release_ack.ack_digest],
      armed_lease_digests: [...this.controller.leases.values()]
        .map(({ lease_digest: digest }) => digest).sort(),
    });
    this.trace.push('central_write_gate_commit');
    this.activeEpoch = 2;
    this.fullyActivated = true;
    this.frozen = false;
    this.trace.push('intake_resumed');
    return releaseAck;
  }

  commitAndActivate() {
    const readyAck = this.commitAndReady();
    const releaseAck = this.releaseEpoch();
    return { readyAck, releaseAck };
  }

  reprocess({ conflictRemains }) {
    if (conflictRemains) throw new Error('QUEUED_CONFLICT_REMAINS');
    this.queue = [];
    this.trace.push('queue_clear');
    return this.commitAndActivate();
  }

  legacyResumeWire() {
    return { schema: 'lattice.run_resume_result.v1', outcome: 'resumable', run_id: RUN_ID,
      executor_adapter: 'fake-managed', dispatchable: this.frozen || !this.fullyActivated ? [] : ['next'],
      running: [...this.expected].sort(), accepted: [], event_count: 1, result_digest: 'd'.repeat(64) };
  }

  epochState() {
    return { schema: 'lattice.managed_epoch_state.v1', run_id: RUN_ID,
      committed_epoch: this.committedEpoch, active_epoch: this.activeEpoch,
      fully_activated: this.fullyActivated, committed_pointer_digest: '9'.repeat(64),
      release_barrier_digest: this.fullyActivated ? 'e'.repeat(64) : null,
      state_digest: 'f'.repeat(64) };
  }

  restart() {
    const oldNonce = this.sessionNonceDigest;
    this.controller.revokeAll('supervisor-restart');
    this.sessionNonceDigest = 'b'.repeat(64);
    this.registration = this.controller.register(this.sessionNonceDigest);
    this.frozen = true;
    this.controller.barrierAll(this.sessionNonceDigest, 'recovery');
    this.trace.push('restart_all_running_barrier');
    return oldNonce;
  }

  shutdown(outcome) {
    this.controller.barrierAll(this.sessionNonceDigest, outcome);
    this.controller.revokeAll(outcome);
    this.closed = true;
    this.trace.push(`managed_${outcome}`);
  }
}

function managedFixture() {
  const registry = new AdapterRegistryFake();
  const launch = registry.resolve('fake-managed');
  const controller = new AdapterControllerFake();
  assert.equal(launch.capabilities_digest, controller.descriptor.capabilities.capabilities_digest);
  const supervisor = new ManagedSupervisorFake(controller);
  supervisor.dispatch({ todo_id: 'affected', plan_epoch: 1, packet_digest: '1'.repeat(64),
    write_lease_id: 'lease-a' });
  supervisor.dispatch({ todo_id: 'carry', plan_epoch: 1, packet_digest: '2'.repeat(64),
    write_lease_id: 'lease-c' });
  return { controller, launch, registry, supervisor };
}

test('durable adapter registryだけからlaunch descriptorを解決し未登録adapterを拒否する', () => {
  const registry = new AdapterRegistryFake();
  const descriptor = registry.resolve('fake-managed');
  assert.equal(registry.registryPath, '.lattice/runtime/adapter-registry/registry.json');
  assert.equal(descriptor.schema, 'lattice.runtime_adapter_launch_descriptor.v1');
  const observed = { path: descriptor.binary_path, digest: descriptor.binary_digest,
    identity_digest: descriptor.binary_identity.identity_digest };
  assert.equal(registry.verifyHostBinary('before-spawn', observed), true);
  assert.equal(registry.verifyHostBinary('after-exec', observed), true);
  assert.throws(() => registry.verifyHostBinary('after-exec', { ...observed,
    digest: '0'.repeat(64) }), /ADAPTER_BINARY_IDENTITY_MISMATCH/u);
  assert.throws(() => registry.resolve('scripted'), /ADAPTER_NOT_REGISTERED/u);
});

test('controller protocolはdispatchからreleaseまでoperation別exact request／responseを使う', () => {
  const protocol = new ControllerProtocolFake();
  for (const operation of Object.keys(CONTROLLER_PROTOCOL)) {
    const { request, response } = protocol.exchange(operation);
    assert.equal(request.schema, CONTROLLER_PROTOCOL[operation].requestSchema);
    assert.equal(response.schema, CONTROLLER_PROTOCOL[operation].responseSchema);
  }
  assert.throws(() => protocol.exchange('generic-payload'), /UNKNOWN_CONTROLLER_OPERATION/u);
});

test('controller host登録後だけmanaged dispatch・observeを同じ経路へrouteする', () => {
  const { controller, supervisor } = managedFixture();
  assert.equal(supervisor.registration.schema, 'lattice.runtime_adapter_registration.v1');
  assert.equal(supervisor.registration.controller_descriptor_digest,
    controller.descriptor.descriptor_digest);
  assert.deepEqual(Object.keys(supervisor.registration).sort(), [
    'controller_descriptor_digest', 'registered_at', 'registered_operations',
    'registration_digest', 'registration_id', 'run_id', 'schema',
    'supervisor_session_nonce_digest',
  ]);
  assert.equal(supervisor.observe('affected').write_enabled, true);
  assert.deepEqual(supervisor.trace.slice(0, 3), [
    'dispatch_routed:affected', 'dispatch_routed:carry', 'observation_routed:affected',
  ]);
});

test('全running barrier後もstaged leaseをpointer commit前に有効化しない', () => {
  const { controller, supervisor } = managedFixture();
  const acks = supervisor.holdAll();
  assert.equal(supervisor.acceptExternalAck, undefined);
  assert.deepEqual(acks.map(({ todo_id: todoId }) => todoId), ['affected', 'carry']);
  assert.equal([...controller.running.values()].every(({ write_enabled: enabled }) => !enabled), true);

  supervisor.prepareEpoch([
    { todo_id: 'affected', successor_epoch: 2, packet_digest: '3'.repeat(64),
      new_write_lease_id: 'lease-a2' },
  ]);
  assert.throws(() => supervisor.commitAndActivate(), /全staged lease ack前/u);
  supervisor.prepareEpoch([
    { todo_id: 'carry', successor_epoch: 2, packet_digest: '4'.repeat(64),
      new_write_lease_id: 'lease-c2' },
  ]);
  assert.equal([...controller.leases.values()].filter(({ state }) => state === 'active').length, 0);

  supervisor.enqueueFinding('f'.repeat(64));
  assert.throws(() => supervisor.commitAndActivate(), /queued conflict clear前/u);
  assert.throws(() => supervisor.reprocess({ conflictRemains: true }), /QUEUED_CONFLICT_REMAINS/u);
  supervisor.reprocess({ conflictRemains: false });
  assert.equal(supervisor.committedEpoch, 2);
  assert.equal(supervisor.activeEpoch, 2);
  assert.equal(supervisor.fullyActivated, true);
  assert.equal(supervisor.trace.indexOf('pointer_commit')
    < supervisor.trace.indexOf('all_activation_ready'), true);
  assert.equal(supervisor.trace.indexOf('all_activation_ready')
    < supervisor.trace.indexOf('release_barrier_commit'), true);
  assert.equal(supervisor.trace.indexOf('all_release_acknowledged')
    < supervisor.trace.indexOf('central_write_gate_commit'), true);
  assert.equal(supervisor.trace.indexOf('central_write_gate_commit')
    < supervisor.trace.indexOf('intake_resumed'), true);
  assert.equal([...controller.leases.values()].every(({ state }) => state === 'armed'), true);
  assert.equal([...controller.leases.keys()].every((todoId) => (
    controller.writeAuthorized(todoId, supervisor.centralGate))), true);
});

test('committed epochとactive epochを分離し全release ack後も中央gate commitまでwrite不可にする', () => {
  const { controller, supervisor } = managedFixture();
  supervisor.holdAll();
  supervisor.prepareEpoch([
    { todo_id: 'affected', successor_epoch: 2, packet_digest: '3'.repeat(64),
      new_write_lease_id: 'lease-a2' },
    { todo_id: 'carry', successor_epoch: 2, packet_digest: '4'.repeat(64),
      new_write_lease_id: 'lease-c2' },
  ]);
  supervisor.commitAndReady();
  assert.equal(supervisor.committedEpoch, 2);
  assert.equal(supervisor.activeEpoch, 1);
  assert.equal(supervisor.fullyActivated, false);
  assert.equal([...controller.leases.values()].every(({ state }) => state === 'staged'), true);
  assert.equal([...controller.running.values()].every(({ write_enabled: enabled }) => !enabled), true);
  const committedState = supervisor.epochState();
  assert.deepEqual(Object.keys(committedState).sort(), [
    'active_epoch', 'committed_epoch', 'committed_pointer_digest', 'fully_activated',
    'release_barrier_digest', 'run_id', 'schema', 'state_digest',
  ]);
  assert.equal(committedState.committed_epoch, 2);
  assert.equal(committedState.active_epoch, 1);
  assert.equal(committedState.fully_activated, false);
  assert.equal(committedState.release_barrier_digest, null);
  assert.throws(() => supervisor.dispatch({ todo_id: 'new', plan_epoch: 2,
    packet_digest: '7'.repeat(64), write_lease_id: 'lease-new' }), /RUN_FROZEN/u);
  const compatibilityWire = supervisor.legacyResumeWire();
  assert.equal(compatibilityWire.outcome, 'resumable');
  assert.deepEqual(compatibilityWire.dispatchable, []);
  assert.deepEqual(Object.keys(compatibilityWire).sort(), [
    'accepted', 'dispatchable', 'event_count', 'executor_adapter', 'outcome',
    'result_digest', 'run_id', 'running', 'schema',
  ]);

  supervisor.releaseEpoch();
  assert.equal(supervisor.activeEpoch, 2);
  assert.equal(supervisor.fullyActivated, true);
  assert.equal(supervisor.epochState().release_barrier_digest, 'e'.repeat(64));
  assert.equal([...controller.running.values()].every(({ plan_epoch: epoch }) => epoch === 2), true);
});

test('2 controllerの片方release遅延中は中央gate generationを進めず一件もwrite-enableしない', () => {
  const nonce = 'a'.repeat(64);
  const controllers = [new AdapterControllerFake('controller-a'), new AdapterControllerFake('controller-b')];
  let centralGate = { schema: 'lattice.supervisor_write_gate.v1', gate_generation: 0 };
  controllers.forEach((controller, index) => {
    controller.register(nonce);
    const todoId = `T${index + 1}`;
    controller.dispatch({ todo_id: todoId, plan_epoch: 1, packet_digest: `${index + 1}`.repeat(64),
      write_lease_id: `lease-${todoId}-1` }, nonce);
    controller.barrierAll(nonce);
    controller.prepare({ todo_id: todoId, successor_epoch: 2,
      packet_digest: `${index + 3}`.repeat(64), new_write_lease_id: `lease-${todoId}-2` }, nonce);
    controller.readyAll('9'.repeat(64), nonce);
  });

  controllers[0].releaseAll('e'.repeat(64), nonce);
  const allLeases = () => controllers.flatMap((controller) => [...controller.leases.values()]);
  const allAcks = () => controllers.map(({ lastReleaseAck }) => lastReleaseAck).filter(Boolean);
  const registrations = controllers.map(({ registration }) => registration);
  const descriptors = controllers.map(({ descriptor }) => descriptor);
  assert.equal(controllers[0].writeAuthorized('T1', centralGate,
    allLeases(), allAcks(), registrations, descriptors), false);
  assert.equal(controllers[1].writeAuthorized('T2', centralGate,
    allLeases(), allAcks(), registrations, descriptors), false);
  assert.equal(centralGate.gate_generation, 0, '一方のrelease ackだけで中央gateを進めない');

  controllers[1].releaseAll('e'.repeat(64), nonce);
  assert.equal(controllers.every((controller, index) => (
    !controller.writeAuthorized(`T${index + 1}`, centralGate,
      allLeases(), allAcks(), registrations, descriptors))), true);
  centralGate = centralGateDocument({
    armed_lease_digests: allLeases().map(({ lease_digest: digest }) => digest).sort(),
    controller_release_ack_digests: allAcks().map(({ ack_digest: digest }) => digest).sort(),
  });
  assert.equal(verifyCentralGate(centralGate, { leases: allLeases(),
    releaseAcks: allAcks(), registrations, controllerDescriptors: descriptors }), true);
  assert.equal(controllers.every((controller, index) => (
    controller.writeAuthorized(`T${index + 1}`, centralGate,
      allLeases(), allAcks(), registrations, descriptors))), true);
  assert.equal(controllers[0].writeAuthorized('T1', { ...centralGate,
    gate_digest: '0'.repeat(64) }, allLeases(), allAcks(), registrations, descriptors), false);
});

test('中央gate verifierはgeneration・run/epoch・barrier・lease集合・digest chainをfail closed検証する', () => {
  const valid = centralGateDocument();
  assert.equal(verifyCentralGate(valid), true);
  const variant = (changes) => centralGateDocument(changes);
  assert.throws(() => verifyCentralGate(variant({ gate_generation: 0 })), /stale gate generation/u);
  assert.throws(() => verifyCentralGate(variant({ run_id: 'other-run' })), /gate run不一致/u);
  assert.throws(() => verifyCentralGate(variant({ plan_epoch: 3 })), /gate epoch不一致/u);
  assert.throws(() => verifyCentralGate(variant({ release_barrier_digest: '1'.repeat(64) })),
    /release barrier不一致/u);
  assert.throws(() => verifyCentralGate(variant({
    armed_lease_digests: [defaultGateLeases()[0].lease_digest],
  })),
    /armed lease集合不一致/u);
  assert.throws(() => verifyCentralGate(variant({ previous_gate_digest: '1'.repeat(64) })),
    /gate chain不一致/u);
  assert.throws(() => verifyCentralGate({ ...valid, gate_digest: 'f'.repeat(64) }),
    /gate self digest不一致/u);
  assert.throws(() => verifyCentralGate(valid, { leases: [
    gateLease('lease-T1-2', 'a'.repeat(64), { run_id: 'other-run' }),
    defaultGateLeases()[1],
  ] }), /lease run membership不一致/u);
  assert.throws(() => verifyCentralGate(valid, { leases: [
    gateLease('lease-T1-2', 'a'.repeat(64), { release_barrier_digest: '1'.repeat(64) }),
    defaultGateLeases()[1],
  ] }), /lease release barrier membership不一致/u);
  const acks = defaultGateAcks();
  const registrations = defaultGateRegistrations();
  const descriptors = defaultGateDescriptors();
  const leases = defaultGateLeases();
  assert.throws(() => verifyCentralGate(valid, { releaseAcks: [acks[0]], registrations,
    controllerDescriptors: descriptors }),
    /release ack数不一致/u);
  assert.throws(() => verifyCentralGate(valid, { releaseAcks: [...acks,
    releaseAck('controller-c', 'c'.repeat(64), [])], registrations,
  controllerDescriptors: descriptors }), /release ack数不一致/u);
  const duplicateController = releaseAck('controller-a', registrations[1].registration_digest,
    [leases[1]]);
  assert.throws(() => verifyCentralGate(valid, {
    releaseAcks: [acks[0], duplicateController], registrations, controllerDescriptors: descriptors,
  }), /descriptor\/controller不一致|controller重複/u);
  const wrongController = releaseAck('controller-x', registrations[1].registration_digest, [leases[1]]);
  assert.throws(() => verifyCentralGate(valid, {
    releaseAcks: [acks[0], wrongController], registrations, controllerDescriptors: descriptors,
  }), /descriptor\/controller不一致/u);
  const staleNonceAck = releaseAck('controller-a', registrations[0].registration_digest,
    [leases[0]], { supervisor_session_nonce_digest: 'f'.repeat(64) });
  assert.throws(() => verifyCentralGate(valid, { releaseAcks: [staleNonceAck, acks[1]],
    registrations, controllerDescriptors: descriptors }), /release ack session nonce不一致/u);
  const staleNonceLease = gateLease('lease-T1-2', registrations[0].registration_digest,
    { supervisor_session_nonce_digest: 'f'.repeat(64) });
  const staleLeaseSet = [staleNonceLease, leases[1]];
  const staleLeaseAcks = [releaseAck('controller-a', registrations[0].registration_digest,
    [staleNonceLease]), acks[1]];
  const staleLeaseGate = centralGateDocument({
    armed_lease_digests: staleLeaseSet.map(({ lease_digest: digest }) => digest).sort(),
    controller_release_ack_digests: staleLeaseAcks.map(({ ack_digest: digest }) => digest).sort(),
  });
  assert.throws(() => verifyCentralGate(staleLeaseGate, { leases: staleLeaseSet,
    releaseAcks: staleLeaseAcks, registrations, controllerDescriptors: descriptors }),
  /lease session nonce不一致/u);
  assert.throws(() => verifyCentralGate(valid, { registrations: [
    { ...registrations[0], registration_digest: 'f'.repeat(64) }, registrations[1]],
  controllerDescriptors: descriptors }), /registration self digest不一致/u);
  const swappedDescriptor = structuredClone(descriptors[0]);
  swappedDescriptor.controller_id = 'controller-x';
  swappedDescriptor.descriptor_digest = selfDigest(swappedDescriptor, 'descriptor_digest');
  assert.throws(() => verifyCentralGate(valid, { registrations,
    controllerDescriptors: [swappedDescriptor, descriptors[1]] }),
  /registration descriptor digest不一致/u);
});

test('既存runtime projectionでも中央gate commit前にintake_resumedを投影せずdispatch窓を作らない', () => {
  const beforeGate = [
    { sequence: 1, kind: 'conflict_found', subject: { kind: 'run', ref: RUN_ID }, payload: {} },
    { sequence: 2, kind: 'intake_frozen', subject: { kind: 'run', ref: RUN_ID },
      payload: { frozen_prefix_digest: '1'.repeat(64) } },
    { sequence: 3, kind: 'plan_recompiled', subject: { kind: 'run', ref: RUN_ID }, payload: {} },
    { sequence: 4, kind: 'epoch_rebound', subject: { kind: 'todo', ref: 'T1' }, payload: {} },
  ];
  const frozenProjection = projectRuntimeState({ events: beforeGate });
  assert.equal(frozenProjection.freeze?.sequence, 2);
  assert.equal(frozenProjection.freeze_history.length, 0);
  assert.equal(beforeGate.some(({ kind }) => kind === 'intake_resumed'), false);

  const afterCentralGate = [...beforeGate,
    { sequence: 5, kind: 'intake_resumed', subject: { kind: 'run', ref: RUN_ID },
      payload: { write_gate_digest: 'f'.repeat(64) } }];
  const activeProjection = projectRuntimeState({ events: afterCentralGate });
  assert.equal(activeProjection.freeze, null);
  assert.equal(activeProjection.freeze_history[0].resumed_sequence, 5);
});

test('socket断・heartbeat TTL・stale nonceはleaseをfail closedに失効する', () => {
  const disconnected = managedFixture();
  disconnected.controller.disconnect();
  assert.equal([...disconnected.controller.leases.values()].every(({ state }) => state === 'revoked'), true);
  assert.throws(() => disconnected.supervisor.observe('affected'), /socket断/u);

  const expired = managedFixture();
  expired.controller.expireHeartbeat();
  assert.equal([...expired.controller.leases.values()].every(({ state }) => state === 'revoked'), true);
  assert.throws(() => expired.supervisor.observe('affected'), /heartbeat期限切れ/u);

  const restarted = managedFixture();
  const oldNonce = restarted.supervisor.restart();
  assert.equal(restarted.supervisor.frozen, true);
  assert.equal(restarted.supervisor.trace.includes('restart_all_running_barrier'), true);
  assert.throws(() => restarted.controller.observe('affected', oldNonce), /stale supervisor session nonce/u);
});

test('managed close・abandonはsupervisor経由で全leaseをrevokeする', () => {
  for (const outcome of ['close', 'abandon']) {
    const { controller, supervisor } = managedFixture();
    supervisor.shutdown(outcome);
    assert.equal(supervisor.closed, true);
    assert.equal(supervisor.trace.includes(`managed_${outcome}`), true);
    assert.equal([...controller.leases.values()].every(({ state }) => state === 'revoked'), true);
    assert.equal([...controller.running.values()].every(({ write_enabled: enabled }) => !enabled), true);
  }

  const unavailable = managedFixture();
  unavailable.controller.disconnect();
  assert.throws(() => unavailable.supervisor.shutdown('abandon'), /socket断/u);
  assert.equal(unavailable.supervisor.closed, false);
});

test('intentional serialもfull migrationとfinding conflict維持を要求する', () => {
  const validate = (input) => {
    assert.deepEqual(Object.keys(input).sort(), [
      'finding_digest', 'mode', 'stay_todo_id', 'task_migration', 'todo_ids',
    ]);
    assert.equal(input.mode, 'intentional_serial');
    assert.equal(input.todo_ids.includes(input.stay_todo_id), true);
    assert.deepEqual(Object.keys(input.task_migration).sort(), ['entries', 'migration_digest', 'schema']);
    assert.equal(input.task_migration.schema, 'lattice.runtime_task_migration.v1');
    for (const entry of input.task_migration.entries) assert.deepEqual(Object.keys(entry).sort(), [
      'disposition', 'evidence_digests', 'predecessor_task_id', 'reason', 'successor_task_ids',
    ]);
    assert.deepEqual(input.task_migration.entries.map(({ predecessor_task_id: id }) => id).sort(),
      [...input.todo_ids].sort());
    assert.equal(input.task_migration.entries.find(({ disposition }) => disposition === 'stay')
      ?.predecessor_task_id, input.stay_todo_id);
  };
  validate({ mode: 'intentional_serial', finding_digest: 'f'.repeat(64),
    todo_ids: ['T1', 'T2'], stay_todo_id: 'T1', task_migration: {
      schema: 'lattice.runtime_task_migration.v1', entries: [
        { predecessor_task_id: 'T1', disposition: 'stay', successor_task_ids: ['T1'],
          reason: 'seam-cost', evidence_digests: ['a'.repeat(64)] },
        { predecessor_task_id: 'T2', disposition: 'carry', successor_task_ids: ['T2'],
          reason: 'serial-peer', evidence_digests: ['b'.repeat(64)] },
      ], migration_digest: 'c'.repeat(64),
    } });
  assert.throws(() => validate({ mode: 'intentional_serial', finding_digest: 'f'.repeat(64),
    todo_ids: ['T1', 'T2'], stay_todo_id: 'T1', task_migration: {
      schema: 'lattice.runtime_task_migration.v1', entries: [
        { predecessor_task_id: 'T1', disposition: 'stay', successor_task_ids: ['T1'],
          reason: 'seam-cost', evidence_digests: ['a'.repeat(64)] },
      ], migration_digest: 'c'.repeat(64),
    } }));
});

function runtimeToTodoMigration(runtimeMigration) {
  return runtimeMigration.entries.map((entry) => {
    if (['carry', 'stay'].includes(entry.disposition)) {
      assert.deepEqual(entry.successor_task_ids, [entry.predecessor_task_id]);
      return { from_task_id: entry.predecessor_task_id,
        to_task_id: entry.predecessor_task_id, state_policy: 'carry' };
    }
    if (entry.disposition === 'retire') {
      assert.deepEqual(entry.successor_task_ids, []);
      return { from_task_id: entry.predecessor_task_id,
        to_task_id: 'removed', state_policy: 'removed' };
    }
    assert.ok(['replace', 'split'].includes(entry.disposition));
    assert.ok(entry.successor_task_ids.length > 0);
    return { from_task_id: entry.predecessor_task_id,
      to_task_id: entry.successor_task_ids[0], state_policy: 'reset_pending' };
  }).sort((a, b) => a.from_task_id.localeCompare(b.from_task_id));
}

function todoMigrationDigest(taskMigration) {
  return todoSelfDigest({ task_migration: taskMigration, task_migration_digest: '' },
    'task_migration_digest');
}

test('runtime splitは先頭successorを明示primaryとして保持し、残りだけを決定的順序にする', () => {
  const migration = { schema: 'lattice.runtime_task_migration.v1', entries: [{
    predecessor_task_id: 'T2', disposition: 'split',
    successor_task_ids: ['T2', 'T0', 'T3'],
    reason: 'T2 identity remains primary while the seam creates T0 and T3',
    evidence_digests: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
  }], migration_digest: '' };
  migration.migration_digest = selfDigest(migration, 'migration_digest');
  assert.equal(validateRuntimeTaskMigration(migration, {
    predecessorTaskIds: ['T2'], successorTaskIds: ['T0', 'T2', 'T3'],
  }), true);

  const unsortedTail = structuredClone(migration);
  unsortedTail.entries[0].successor_task_ids = ['T2', 'T3', 'T0'];
  unsortedTail.migration_digest = selfDigest(unsortedTail, 'migration_digest');
  assert.equal(validateRuntimeTaskMigration(unsortedTail), false);
});

function validatePhaseRevisionV3Contract(revision) {
  if (revision?.schema !== 'lattice.phase_todo_revision.v3') return false;
  try {
    assert.deepEqual(Object.keys(revision).sort(), [
      'desired_plan', 'phase_migration', 'plan_key', 'predecessor', 'project_id',
      'reconciliation', 'revision_digest', 'runtime_task_migration', 'schema',
      'source_cutover_batch', 'source_inventory', 'task_migration',
    ]);
    assert.equal(validateTodoPlan(revision.desired_plan), true);
    assert.equal(revision.desired_plan.schema, 'lattice.todo_plan.v5');
    assert.equal(revision.desired_plan.project_id, revision.project_id);
    assert.equal(revision.desired_plan.plan_key, revision.plan_key);
    assert.equal(revision.desired_plan.predecessor_plan_digest, revision.predecessor.plan_digest);
    assert.equal(revision.desired_plan.plan_version, phaseTodoRevisionPlanVersion({
      projectId: revision.project_id, planKey: revision.plan_key,
      predecessor: revision.predecessor, desiredPlan: revision.desired_plan,
      taskMigration: revision.task_migration, phaseMigration: revision.phase_migration,
    }));
    assert.ok(Array.isArray(revision.phase_migration) && revision.phase_migration.length > 0);
    for (const entry of revision.phase_migration) assert.deepEqual(Object.keys(entry).sort(), [
      'from_phase_id', 'state_policy', 'to_phase_id',
    ]);
    assert.equal(revision.runtime_task_migration.migration_digest,
      selfDigest(revision.runtime_task_migration, 'migration_digest'));
    assert.deepEqual(revision.task_migration,
      runtimeToTodoMigration(revision.runtime_task_migration));
    for (const entry of revision.task_migration) assert.deepEqual(Object.keys(entry).sort(), [
      'from_task_id', 'state_policy', 'to_task_id',
    ]);
    assert.deepEqual(Object.keys(revision.source_inventory).sort(), ['active', 'excluded_tombstones']);
    assert.ok(revision.source_inventory.active.length > 0);
    for (const entry of revision.source_inventory.active) assert.deepEqual(Object.keys(entry).sort(), [
      'source_digest', 'source_ref', 'task_id',
    ]);
    assert.deepEqual(Object.keys(revision.source_cutover_batch).sort(), [
      'archive_ref', 'batch_digest', 'batch_id', 'operations',
    ]);
    assert.ok(revision.source_cutover_batch.operations.length > 0);
    for (const [index, operation] of revision.source_cutover_batch.operations.entries()) {
      assert.deepEqual(Object.keys(operation).sort(), [
        'disposition', 'live_replacement', 'source_digest', 'source_ref', 'task_id',
      ]);
      const inventory = revision.source_inventory.active.find(({ task_id: id }) => id === operation.task_id);
      assert.equal(inventory.source_ref,
        `${revision.source_cutover_batch.archive_ref}#L${index + 6}`);
      assert.equal(inventory.source_digest, operation.source_digest);
      assert.equal(revision.desired_plan.tasks.find(({ task_id: id }) => id === operation.task_id)
        .narrative_ref, inventory.source_ref);
    }
    assert.equal(revision.source_cutover_batch.batch_digest,
      todoSelfDigest(revision.source_cutover_batch, 'batch_digest'));
    assert.equal(revision.reconciliation.source_inventory_digest,
      digestTodoArtifact(revision.source_inventory));
    assert.deepEqual(Object.keys(revision.reconciliation).sort(), [
      'desired_plan_digest', 'phase_migration_digest', 'predecessor_reconciliation_digest',
      'reconciliation_digest', 'runtime_task_migration_digest', 'source_cutover_batch_digest',
      'source_inventory_digest', 'task_migration_digest',
    ]);
    assert.equal(revision.reconciliation.desired_plan_digest, revision.desired_plan.plan_digest);
    assert.equal(revision.reconciliation.runtime_task_migration_digest,
      revision.runtime_task_migration.migration_digest);
    assert.equal(revision.reconciliation.task_migration_digest,
      todoMigrationDigest(revision.task_migration));
    assert.equal(revision.reconciliation.phase_migration_digest,
      digestTodoArtifact(revision.phase_migration));
    assert.equal(revision.reconciliation.source_cutover_batch_digest,
      revision.source_cutover_batch.batch_digest);
    assert.equal(revision.reconciliation.reconciliation_digest,
      todoSelfDigest(revision.reconciliation, 'reconciliation_digest'));
    assert.equal(revision.revision_digest, todoSelfDigest(revision, 'revision_digest'));
    return true;
  } catch { return false; }
}

class PhaseRevisionV3Fake {
  constructor() {
    this.activeRevisionDigest = '0'.repeat(64);
    this.staging = null;
    this.cutoverPublished = false;
  }

  validate(revision) {
    assert.deepEqual(Object.keys(revision).sort(), [
      'desired_plan', 'phase_migration', 'plan_key', 'predecessor', 'project_id',
      'reconciliation', 'revision_digest', 'runtime_task_migration', 'schema',
      'source_cutover_batch', 'source_inventory', 'task_migration',
    ]);
    assert.equal(revision.schema, 'lattice.phase_todo_revision.v3');
    assert.equal(validatePhaseRevisionV3Contract(revision), true);
    assert.equal(revision.runtime_task_migration.schema, 'lattice.runtime_task_migration.v1');
    assert.deepEqual(revision.task_migration,
      runtimeToTodoMigration(revision.runtime_task_migration));
    for (const entry of revision.task_migration) assert.deepEqual(Object.keys(entry).sort(), [
      'from_task_id', 'state_policy', 'to_task_id',
    ]);
    assert.deepEqual(Object.keys(revision.source_inventory).sort(), ['active', 'excluded_tombstones']);
    assert.deepEqual(Object.keys(revision.reconciliation).sort(), [
      'desired_plan_digest', 'phase_migration_digest', 'predecessor_reconciliation_digest',
      'reconciliation_digest', 'runtime_task_migration_digest', 'source_cutover_batch_digest',
      'source_inventory_digest', 'task_migration_digest',
    ]);
    assert.equal(revision.reconciliation.runtime_task_migration_digest,
      revision.runtime_task_migration.migration_digest);
    assert.equal(revision.reconciliation.task_migration_digest,
      todoMigrationDigest(revision.task_migration));
  }

  apply(revision, crashAt = null) {
    this.validate(revision);
    this.staging = revision.revision_digest;
    if (crashAt === 'barrier') throw new Error('CRASH_AFTER_CUTOVER_BARRIER');
    this.cutoverPublished = true;
    if (crashAt === 'source') throw new Error('CRASH_AFTER_SOURCE_PUBLISH');
    this.activeRevisionDigest = revision.revision_digest;
    this.staging = null;
    const receipt = { schema: 'lattice.phase_revision_commit_receipt.v1', project_id: revision.project_id,
      plan_key: revision.plan_key, plan_version: revision.desired_plan.plan_version,
      revision_digest: revision.revision_digest, committed_member_digest: 'a'.repeat(64),
      active_plan_digest: revision.reconciliation.desired_plan_digest,
      journal_genesis_digest: 'c'.repeat(64),
      reconciliation_digest: revision.reconciliation.reconciliation_digest,
      source_cutover_receipt_digest: 'b'.repeat(64),
      committed_at: '2026-07-21T00:00:00.000Z', receipt_digest: '' };
    receipt.receipt_digest = todoSelfDigest(receipt, 'receipt_digest');
    return receipt;
  }

  recover(revision) {
    assert.equal(revision.revision_digest, this.staging, '別revisionでのrecoveryは禁止');
    return this.apply(revision);
  }
}

function phaseRevisionV3Fixture() {
  const runtimeTaskMigration = { schema: 'lattice.runtime_task_migration.v1', entries: [
    { predecessor_task_id: 'T1', disposition: 'stay', successor_task_ids: ['T1'],
      reason: 'serial-cost', evidence_digests: ['1'.repeat(64)] },
    { predecessor_task_id: 'T2', disposition: 'carry', successor_task_ids: ['T2'],
      reason: 'unaffected-peer', evidence_digests: ['2'.repeat(64)] },
  ], migration_digest: '' };
  runtimeTaskMigration.migration_digest = selfDigest(runtimeTaskMigration, 'migration_digest');
  const taskMigration = runtimeToTodoMigration(runtimeTaskMigration);
  const predecessor = { plan_version: 'v1', plan_digest: '1'.repeat(64),
    journal_head_digest: '2'.repeat(64) };
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredInput = { schema: 'lattice.todo_plan.v5', project_id: 'project-1', plan_key: 'main',
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: [{ task_id: 'T1', title: 'T1', lane: 'main',
      narrative_ref: 'docs/archive/runtime-cutover.md#L6', narrative_anchor: null,
      compile_binding: null, parent_task_id: null, phase_id: 'phase-1' },
    { task_id: 'T2', title: 'T2', lane: 'main',
      narrative_ref: 'docs/archive/runtime-cutover.md#L7', narrative_anchor: null,
      compile_binding: null, parent_task_id: null, phase_id: 'phase-1' }],
    phases: [{ phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  const sourceLines = ['- [ ] T1 runtime ownership\n', '- [ ] T2 runtime peer\n'];
  const sourceDigests = sourceLines.map((line) => createHash('sha256').update(line).digest('hex'));
  const sourceCutoverBatch = { batch_id: 'cutover-1', archive_ref: 'docs/archive/runtime-cutover.md',
    operations: [{ task_id: 'T1', disposition: 'active', source_ref: 'docs/plan.md#L1',
      source_digest: sourceDigests[0], live_replacement: '- Lattice管理: T1' },
    { task_id: 'T2', disposition: 'active', source_ref: 'docs/plan.md#L2',
      source_digest: sourceDigests[1], live_replacement: '- Lattice管理: T2' }], batch_digest: '' };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const sourceInventory = { active: [{ task_id: 'T1',
    source_ref: 'docs/archive/runtime-cutover.md#L6', source_digest: sourceDigests[0] },
  { task_id: 'T2', source_ref: 'docs/archive/runtime-cutover.md#L7', source_digest: sourceDigests[1] }],
    excluded_tombstones: [] };
  const revision = { schema: 'lattice.phase_todo_revision.v3', project_id: 'project-1', plan_key: 'main',
    predecessor, desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration, task_migration: taskMigration,
    phase_migration: phaseMigration, source_inventory: sourceInventory,
    reconciliation: { predecessor_reconciliation_digest: '4'.repeat(64),
      source_inventory_digest: digestTodoArtifact(sourceInventory), desired_plan_digest: desiredPlan.plan_digest,
      runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
      task_migration_digest: todoMigrationDigest(taskMigration),
      phase_migration_digest: digestTodoArtifact(phaseMigration),
      source_cutover_batch_digest: sourceCutoverBatch.batch_digest,
      reconciliation_digest: '' },
    source_cutover_batch: sourceCutoverBatch, revision_digest: '' };
  revision.reconciliation.reconciliation_digest = todoSelfDigest(revision.reconciliation,
    'reconciliation_digest');
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

function recompileRequestFixture(phaseRevision = phaseRevisionV3Fixture()) {
  const request = { schema: 'lattice.runtime_recompile_request.v1', request_id: 'recompile-1',
    run_id: RUN_ID, predecessor_epoch: 1, frozen_event_digest: '1'.repeat(64),
    hold_decision_digest: '2'.repeat(64), mode: 'intentional_serial', reason: 'shared-resource',
    successor_request: { schema: 'lattice.run_request.v2' },
    task_migration: phaseRevision?.runtime_task_migration ?? {
      schema: 'lattice.runtime_task_migration.v1', entries: [], migration_digest: '3'.repeat(64) },
    phase_revision: phaseRevision, seam_split: null,
    intentional_serial: { schema: 'lattice.runtime_intentional_serial.v1' }, request_digest: '' };
  request.request_digest = selfDigest(request, 'request_digest');
  return request;
}

class RecompileCommitPipelineFake {
  constructor() { this.trace = []; }

  compile(request) {
    assert.deepEqual(Object.keys(request).sort(), [
      'frozen_event_digest', 'hold_decision_digest', 'intentional_serial', 'mode',
      'phase_revision', 'predecessor_epoch', 'reason', 'request_digest', 'request_id',
      'run_id', 'schema', 'seam_split', 'successor_request', 'task_migration',
    ]);
    assert.equal(request.request_digest, selfDigest(request, 'request_digest'));
    this.trace.push('request_validated');
    let receipt = null;
    if (request.phase_revision !== null) {
      assert.deepEqual(request.task_migration, request.phase_revision.runtime_task_migration);
      receipt = new PhaseRevisionV3Fake().apply(request.phase_revision);
      assert.deepEqual(Object.keys(receipt).sort(), [
        'active_plan_digest', 'committed_at', 'committed_member_digest',
        'journal_genesis_digest', 'plan_key', 'plan_version', 'project_id',
        'receipt_digest', 'reconciliation_digest', 'revision_digest', 'schema',
        'source_cutover_receipt_digest',
      ]);
      assert.equal(receipt.receipt_digest, todoSelfDigest(receipt, 'receipt_digest'));
      this.trace.push('todo_manifest_committed');
    }
    const bundle = { schema: 'lattice.runtime_epoch_bundle.v1', run_id: request.run_id,
      plan_epoch: request.predecessor_epoch + 1, request, plan: {}, manifests: [],
      executor_packets: [], rebind_packets: [], plan_diff: {},
      task_migration: request.task_migration, treatment: request.intentional_serial,
      phase_revision_digest: request.phase_revision?.revision_digest ?? null,
      phase_revision_commit_receipt: receipt, predecessor_bundle_digest: '4'.repeat(64),
      bundle_digest: '' };
    bundle.bundle_digest = selfDigest(bundle, 'bundle_digest');
    assert.deepEqual(Object.keys(bundle).sort(), [
      'bundle_digest', 'executor_packets', 'manifests', 'phase_revision_commit_receipt',
      'phase_revision_digest', 'plan', 'plan_diff', 'plan_epoch', 'predecessor_bundle_digest',
      'rebind_packets', 'request', 'run_id', 'schema', 'task_migration', 'treatment',
    ]);
    this.trace.push('epoch_bundle_staged');
    return bundle;
  }
}

function validateCarryEdges({ predecessorIncoming, successorIncoming,
  predecessorOutgoing, successorOutgoing }) {
  const sorted = (values) => [...values].sort();
  assert.deepEqual(sorted(successorIncoming), sorted(predecessorIncoming), 'carry incoming exact違反');
  const successorSet = new Set(successorOutgoing);
  assert.equal(predecessorOutgoing.every((edge) => successorSet.has(edge)), true,
    'carry outgoing monotonic superset違反');
}

test('phase_todo_revision.v3 cutoverはmanifest commitまで非activeで同digest crash recoveryする', () => {
  const revision = phaseRevisionV3Fixture();
  const transaction = new PhaseRevisionV3Fake();
  assert.throws(() => transaction.apply(revision, 'source'), /CRASH_AFTER_SOURCE_PUBLISH/u);
  assert.equal(transaction.activeRevisionDigest, '0'.repeat(64));
  assert.equal(transaction.cutoverPublished, true);
  assert.equal(transaction.recover(revision).revision_digest, revision.revision_digest);
  assert.equal(transaction.activeRevisionDigest, revision.revision_digest);

  const wrong = structuredClone(revision);
  wrong.revision_digest = 'b'.repeat(64);
  const crashed = new PhaseRevisionV3Fake();
  assert.throws(() => crashed.apply(revision, 'barrier'), /CRASH_AFTER_CUTOVER_BARRIER/u);
  assert.throws(() => crashed.recover(wrong), /別revision/u);
});

test('recompile requestのnullable phase revisionをTODO commit receipt経由でepoch bundleへbindする', () => {
  const pipeline = new RecompileCommitPipelineFake();
  const request = recompileRequestFixture();
  const bundle = pipeline.compile(request);
  assert.equal(bundle.phase_revision_digest, request.phase_revision.revision_digest);
  assert.equal(bundle.phase_revision_commit_receipt.revision_digest,
    request.phase_revision.revision_digest);
  assert.deepEqual(pipeline.trace,
    ['request_validated', 'todo_manifest_committed', 'epoch_bundle_staged']);

  const noPhasePipeline = new RecompileCommitPipelineFake();
  const noPhaseBundle = noPhasePipeline.compile(recompileRequestFixture(null));
  assert.equal(noPhaseBundle.phase_revision_digest, null);
  assert.equal(noPhaseBundle.phase_revision_commit_receipt, null);
  assert.deepEqual(noPhasePipeline.trace, ['request_validated', 'epoch_bundle_staged']);
});

test('full phase v3をv5 topology・source cutover・durable receiptごと実repoへcommitしてretryする', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-runtime-phase-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '--quiet'], root);
  const template = phaseRevisionV3Fixture();
  const initialInput = structuredClone(template.desired_plan);
  delete initialInput.topology_digest;
  delete initialInput.plan_digest;
  initialInput.plan_version = 'v1';
  initialInput.predecessor_plan_digest = null;
  const initial = buildTodoPlan({ ...initialInput, schema: 'lattice.todo_plan.v5',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    phase_accept_dependencies: [] });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: initial, genesis: { actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
      recorded_at: '2026-07-21T00:00:00.000Z' } }], now: '2026-07-21T00:00:00.000Z' });
  const member = (await readTodoStore({ repoRoot: root, now: '2026-07-21T00:00:00.000Z' })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const revision = structuredClone(template);
  revision.predecessor = predecessor;
  const desiredInput = structuredClone(revision.desired_plan);
  delete desiredInput.topology_digest;
  delete desiredInput.plan_digest;
  desiredInput.predecessor_plan_digest = predecessor.plan_digest;
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'main',
    predecessor, desiredPlan: desiredInput, taskMigration: revision.task_migration,
    phaseMigration: revision.phase_migration });
  revision.desired_plan = buildTodoPlan(desiredInput);
  revision.reconciliation.desired_plan_digest = revision.desired_plan.plan_digest;
  revision.reconciliation.reconciliation_digest = todoSelfDigest(revision.reconciliation,
    'reconciliation_digest');
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  assert.equal(validatePhaseRevisionV3Contract(revision), true);

  const operations = revision.source_cutover_batch.operations;
  const sourceLines = ['- [ ] T1 runtime ownership\n', '- [ ] T2 runtime peer\n'];
  const sourceBytes = sourceLines.join('');
  operations.forEach((operation, index) => assert.equal(
    createHash('sha256').update(sourceLines[index]).digest('hex'), operation.source_digest));
  const sourceAbsolute = path.join(root, 'docs', 'plan.md');
  const stageAbsolute = path.join(root, '.lattice', 'todo', 'transactions', 'phase-v3',
    revision.plan_key, revision.desired_plan.plan_version, 'source-image', 'plan.md');
  await mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await mkdir(path.dirname(stageAbsolute), { recursive: true });
  await writeFile(sourceAbsolute, sourceBytes);
  await writeFile(stageAbsolute, sourceBytes);
  const trace = ['source_staged'];
  const archiveAbsolute = path.join(root, revision.source_cutover_batch.archive_ref);
  await mkdir(path.dirname(archiveAbsolute), { recursive: true });
  const archiveBytes = ['# Runtime source archive', '', 'revision: v3', '', '## Sources',
    ...sourceLines.map((line) => line.trimEnd())].join('\n') + '\n';
  await writeFile(archiveAbsolute, archiveBytes);
  await writeFile(sourceAbsolute, `${operations.map(({ live_replacement: value }) => value).join('\n')}\n`);
  trace.push('source_published');

  const nativeRevision = { schema: 'lattice.phase_todo_revision.v2', project_id: revision.project_id,
    plan_key: revision.plan_key, predecessor: revision.predecessor,
    desired_plan: revision.desired_plan, task_migration: revision.task_migration,
    phase_migration: revision.phase_migration, revision_digest: '' };
  nativeRevision.revision_digest = todoSelfDigest(nativeRevision, 'revision_digest');
  assert.equal(validatePhaseTodoRevision(nativeRevision), true);
  const result = await applyPhaseTodoRevision({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision: nativeRevision,
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recordedAt: '2026-07-21T00:00:01.000Z', now: '2026-07-21T00:00:01.000Z' });
  assert.equal(result.revision_digest, nativeRevision.revision_digest);
  trace.push('v2_lower_primitive_manifest_cas');
  const committedStore = await readTodoStore({ repoRoot: root,
    now: '2026-07-21T00:00:01.000Z' });
  const committed = committedStore.members[0];
  assert.equal(committed.plan.plan_digest, revision.desired_plan.plan_digest);
  assert.equal(committed.journal.events[0].revision_digest, nativeRevision.revision_digest);
  assert.notEqual(nativeRevision.revision_digest, revision.revision_digest,
    'v2 primitive digestをv3 identityと同一視しない');
  assert.equal(await readFile(sourceAbsolute, 'utf8'),
    `${operations.map(({ live_replacement: value }) => value).join('\n')}\n`);
  assert.deepEqual((await readFile(archiveAbsolute, 'utf8')).split('\n').slice(5, 7),
    sourceLines.map((line) => line.trimEnd()));

  await rm(stageAbsolute);
  trace.push('source_cleanup_committed');
  const futureRoot = path.join(root, 'future-v3-store');
  const base = `.lattice/todo/plans/${revision.plan_key}/${revision.desired_plan.plan_version}`;
  const futurePlanDir = path.join(futureRoot, base);
  await mkdir(path.join(futurePlanDir, 'journal'), { recursive: true });
  const genesis = structuredClone(committed.journal.events[0]);
  genesis.revision_digest = revision.revision_digest;
  genesis.event_digest = todoSelfDigest(genesis, 'event_digest');
  assert.equal(genesis.schema, 'lattice.todo_event.v4');
  assert.equal(validateTodoEvent(genesis), true);
  const snapshot = structuredClone(committed.snapshot);
  snapshot.journal_head_digest = genesis.event_digest;
  snapshot.snapshot_digest = todoSelfDigest(snapshot, 'snapshot_digest');
  assert.equal(snapshot.schema, 'lattice.todo_snapshot.v2');
  assert.equal(validateTodoSnapshot(snapshot), true);
  const descriptor = { ...committed.descriptor,
    active_revision_digest: revision.revision_digest,
    journal_head_digest: genesis.event_digest };
  await writeFile(path.join(futurePlanDir, 'revision.json'), `${JSON.stringify(revision)}\n`, { flag: 'wx' });
  await writeFile(path.join(futurePlanDir, 'plan.json'), `${JSON.stringify(revision.desired_plan)}\n`, { flag: 'wx' });
  await writeFile(path.join(futurePlanDir, 'journal', 'active.jsonl'), `${JSON.stringify(genesis)}\n`, { flag: 'wx' });
  await writeFile(path.join(futurePlanDir, 'snapshot.json'), `${JSON.stringify(snapshot)}\n`, { flag: 'wx' });
  const receiptEntries = operations.map((operation, index) => {
    const entry = { operation_index: index, task_id: operation.task_id,
      disposition: operation.disposition, source_ref: operation.source_ref,
      staging_ref: `${path.relative(root, stageAbsolute)}#L${index + 1}`,
      published_ref: operation.source_ref,
      archive_ref: `${revision.source_cutover_batch.archive_ref}#L${index + 6}`,
      replacement: operation.live_replacement,
      staged_source_bytes_digest: createHash('sha256').update(sourceLines[index]).digest('hex'),
      published_source_bytes_digest: createHash('sha256')
        .update(`${operation.live_replacement}\n`).digest('hex'),
      archived_source_bytes_digest: createHash('sha256').update(sourceLines[index]).digest('hex'),
      entry_digest: '' };
    entry.entry_digest = todoSelfDigest(entry, 'entry_digest');
    return entry;
  });
  const archiveRootListDigest = digestTodoArtifact({
    schema: 'lattice.source_cutover_archive_root_list.v1',
    roots: [{ archive_ref: revision.source_cutover_batch.archive_ref,
      entry_digests: receiptEntries.map(({ entry_digest: digest }) => digest) }],
  });
  const sourceReceipt = { schema: 'lattice.source_cutover_receipt.v1',
    project_id: revision.project_id, plan_key: revision.plan_key,
    plan_version: revision.desired_plan.plan_version, revision_digest: revision.revision_digest,
    source_cutover_batch_digest: revision.source_cutover_batch.batch_digest,
    entries: receiptEntries, archive_root_list_digest: archiveRootListDigest,
    published_state: 'source_and_archive_published',
    cleanup_binding_digest: digestTodoArtifact({
      schema: 'lattice.source_cutover_cleanup_binding.v1', revision_digest: revision.revision_digest,
      staging_ref: path.relative(root, stageAbsolute), cleanup_state: 'cleanup_complete' }),
    receipt_digest: '' };
  sourceReceipt.receipt_digest = todoSelfDigest(sourceReceipt, 'receipt_digest');
  const sourceReceiptPath = path.join(futurePlanDir, 'source-cutover-receipt.json');
  await writeFile(sourceReceiptPath, `${JSON.stringify(sourceReceipt)}\n`, { flag: 'wx' });
  const commitReceipt = { schema: 'lattice.phase_revision_commit_receipt.v1',
    project_id: revision.project_id, plan_key: revision.plan_key,
    plan_version: revision.desired_plan.plan_version, revision_digest: revision.revision_digest,
    committed_member_digest: digestTodoArtifact(descriptor),
    active_plan_digest: revision.desired_plan.plan_digest,
    journal_genesis_digest: genesis.event_digest,
    reconciliation_digest: revision.reconciliation.reconciliation_digest,
    source_cutover_receipt_digest: sourceReceipt.receipt_digest,
    committed_at: '2026-07-21T00:00:01.000Z', receipt_digest: '' };
  commitReceipt.receipt_digest = todoSelfDigest(commitReceipt, 'receipt_digest');
  const commitReceiptPath = path.join(futurePlanDir, 'phase-revision-commit-receipt.json');
  await writeFile(commitReceiptPath, `${JSON.stringify(commitReceipt)}\n`, { flag: 'wx' });
  trace.push('v3_store_images_and_receipts_durable');
  const futureManifest = { schema: 'lattice.todo_manifest.v2', project_id: revision.project_id,
    repositories: committedStore.manifest.repositories, members: [descriptor], manifest_digest: '' };
  futureManifest.manifest_digest = todoSelfDigest(futureManifest, 'manifest_digest');
  const manifestPath = path.join(futureRoot, '.lattice', 'todo', 'manifest.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(futureManifest)}\n`, { flag: 'wx' });
  trace.push('v3_manifest_member_cas');
  trace.push('crash_before_runtime_bundle');

  const durableBytes = await readFile(commitReceiptPath);
  const recoveredReceipt = JSON.parse(durableBytes);
  assert.equal(recoveredReceipt.receipt_digest,
    todoSelfDigest(recoveredReceipt, 'receipt_digest'));
  assert.equal(recoveredReceipt.revision_digest, revision.revision_digest);
  assert.equal(genesis.revision_digest, revision.revision_digest);
  assert.equal(descriptor.active_revision_digest, revision.revision_digest);
  const storedRevision = JSON.parse(await readFile(path.join(futurePlanDir, 'revision.json'), 'utf8'));
  const storedPlan = JSON.parse(await readFile(path.join(futurePlanDir, 'plan.json'), 'utf8'));
  const storedGenesis = JSON.parse(await readFile(path.join(futurePlanDir, 'journal', 'active.jsonl'), 'utf8'));
  const storedSnapshot = JSON.parse(await readFile(path.join(futurePlanDir, 'snapshot.json'), 'utf8'));
  const storedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(storedRevision.revision_digest, revision.revision_digest);
  assert.equal(validateTodoPlan(storedPlan), true);
  assert.equal(validateTodoEvent(storedGenesis), true);
  assert.equal(validateTodoSnapshot(storedSnapshot), true);
  assert.equal(storedGenesis.revision_digest, revision.revision_digest);
  assert.equal(storedGenesis.payload.plan_digest, storedPlan.plan_digest);
  assert.equal(storedGenesis.previous_digest, revision.predecessor.journal_head_digest);
  assert.deepEqual(storedGenesis.actor,
    { host: 'host-1', session: 'session-1', agent: 'agent-1' });
  assert.equal(storedGenesis.recorded_at, '2026-07-21T00:00:01.000Z');
  assert.equal(storedSnapshot.journal_head_digest, storedGenesis.event_digest);
  assert.deepEqual(storedGenesis.payload.task_migration, revision.task_migration
    .map(({ from_task_id, to_task_id }) => ({ from_task_id, to_task_id })));
  for (const migration of storedGenesis.state_migration) {
    const projected = storedSnapshot.tasks.find(({ task_id }) => task_id === migration.to_task_id);
    assert.equal(projected.status, migration.state?.status ?? 'pending');
  }
  for (const migration of storedGenesis.phase_state_migration) {
    const projected = storedSnapshot.phases.find(({ phase_id }) => phase_id === migration.phase_id);
    assert.equal(projected.status, migration.state?.status ?? 'active');
  }
  assert.equal(storedManifest.members[0].active_revision_digest, revision.revision_digest);
  assert.deepEqual(Object.keys(storedManifest).sort(),
    ['manifest_digest', 'members', 'project_id', 'repositories', 'schema']);
  assert.deepEqual(Object.keys(storedManifest.members[0]).sort(), [
    'active_plan_version', 'active_revision_digest', 'journal_head_digest', 'journal_ref',
    'plan_key', 'plan_ref', 'snapshot_ref', 'topology_digest',
  ]);
  assert.equal(storedManifest.schema, 'lattice.todo_manifest.v2');
  assert.equal(storedManifest.manifest_digest, todoSelfDigest(storedManifest, 'manifest_digest'));
  const recoveredSourceReceipt = JSON.parse(await readFile(sourceReceiptPath, 'utf8'));
  assert.deepEqual(Object.keys(recoveredSourceReceipt).sort(), [
    'archive_root_list_digest', 'cleanup_binding_digest', 'entries', 'plan_key', 'plan_version',
    'project_id', 'published_state', 'receipt_digest', 'revision_digest', 'schema',
    'source_cutover_batch_digest',
  ]);
  assert.equal(recoveredSourceReceipt.receipt_digest,
    todoSelfDigest(recoveredSourceReceipt, 'receipt_digest'));
  assert.equal(recoveredSourceReceipt.published_state, 'source_and_archive_published');
  assert.equal(recoveredSourceReceipt.entries.length, 2);
  for (const [index, entry] of recoveredSourceReceipt.entries.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'archive_ref', 'archived_source_bytes_digest', 'disposition', 'entry_digest',
      'operation_index', 'published_ref', 'published_source_bytes_digest', 'replacement',
      'source_ref', 'staged_source_bytes_digest', 'staging_ref', 'task_id',
    ]);
    assert.equal(entry.entry_digest, todoSelfDigest(entry, 'entry_digest'));
    assert.equal(entry.operation_index, index);
    assert.equal(entry.source_ref, operations[index].source_ref);
    assert.equal(entry.published_source_bytes_digest, createHash('sha256')
      .update(`${operations[index].live_replacement}\n`).digest('hex'));
    assert.equal(entry.archived_source_bytes_digest,
      createHash('sha256').update(sourceLines[index]).digest('hex'));
  }
  assert.equal(recoveredSourceReceipt.archive_root_list_digest, digestTodoArtifact({
    schema: 'lattice.source_cutover_archive_root_list.v1',
    roots: [{ archive_ref: revision.source_cutover_batch.archive_ref,
      entry_digests: recoveredSourceReceipt.entries.map(({ entry_digest: digest }) => digest) }],
  }));
  assert.equal(recoveredSourceReceipt.cleanup_binding_digest, digestTodoArtifact({
    schema: 'lattice.source_cutover_cleanup_binding.v1', revision_digest: revision.revision_digest,
    staging_ref: path.relative(root, stageAbsolute), cleanup_state: 'cleanup_complete',
  }));
  await assert.rejects(readFile(stageAbsolute));
  trace.push('same_digest_receipt_reread', 'runtime_bundle_staged');
  assert.deepEqual(trace, ['source_staged', 'source_published', 'v2_lower_primitive_manifest_cas',
    'source_cleanup_committed', 'v3_store_images_and_receipts_durable',
    'v3_manifest_member_cas', 'crash_before_runtime_bundle',
    'same_digest_receipt_reread', 'runtime_bundle_staged']);
});

test('将来のstateMigrationFor v3 seamはincoming exactかつ旧outgoing⊆新outgoingだけを許す', () => {
  validateCarryEdges({ predecessorIncoming: ['hard:A>T', 'join:J>T'],
    successorIncoming: ['join:J>T', 'hard:A>T'],
    predecessorOutgoing: ['hard:T>B'],
    successorOutgoing: ['hard:T>B', 'phase:T>P'] });
  assert.throws(() => validateCarryEdges({ predecessorIncoming: ['hard:A>T'],
    successorIncoming: [], predecessorOutgoing: [], successorOutgoing: [] }), /incoming exact/u);
  assert.throws(() => validateCarryEdges({ predecessorIncoming: [], successorIncoming: [],
    predecessorOutgoing: ['hard:T>B', 'hard:T>C'], successorOutgoing: ['hard:T>B'] }),
  /outgoing monotonic superset/u);
});

test('findingとTODO runtime bindingのdurable pathはdigest／plan／taskへ一意に決まる', () => {
  const findingPath = (digest) => path.posix.join(RUN_REF.replaceAll('\\', '/'),
    'findings', `${digest}.json`);
  const bindingJournalPath = (planKey, taskId) => path.posix.join('.lattice', 'todo',
    'runtime-bindings', planKey, taskId, 'journal.jsonl');
  assert.equal(findingPath('f'.repeat(64)),
    `${RUN_REF.replaceAll('\\', '/')}/findings/${'f'.repeat(64)}.json`);
  assert.equal(bindingJournalPath('main', 'T1'),
    '.lattice/todo/runtime-bindings/main/T1/journal.jsonl');
  assert.notEqual(bindingJournalPath('main', 'T1'), bindingJournalPath('main', 'T2'));
});

test('todo blockはruntime holdの停止・epoch・recompileを代用しない', () => {
  assert.equal(TODO_EVENT_KINDS.includes('block'), true);
  assert.equal(TODO_EVENT_KINDS.includes('unblock'), true);
  assert.equal(RUN_EVENT_KINDS.includes('block'), false);
  assert.equal(RUN_EVENT_KINDS.includes('unblock'), false);

  for (const kind of [
    'conflict_found', 'intake_frozen', 'hold_decided', 'carry_over_witnessed',
    'epoch_rebound', 'plan_recompiled',
  ]) assert.equal(TODO_EVENT_KINDS.includes(kind), false, kind);
});
