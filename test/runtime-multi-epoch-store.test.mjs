import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalizeArtifact, digestArtifact } from '../src/artifact-contracts.mjs';
import { selfDigest } from '../src/runtime-contracts.mjs';
import { buildExecutorPackets, buildNextRunEvent } from '../src/runtime-engine.mjs';
import { createRuntimeControlStore } from '../src/runtime-control-store.mjs';
import {
  RuntimeEpochStoreError,
  activateEpochOneStore,
  commitStagedSuccessorEpoch,
  readCommittedEpochStore,
  stageSuccessorEpoch,
} from '../src/runtime-multi-epoch-store.mjs';
import { invokeSensorCli } from '../src/sensor-runtime.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');

function command(commandName, args, cwd) {
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${commandName}: ${result.stderr}`);
  return result.stdout;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-multi-epoch-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'test'), { recursive: true });
  await writeFile(path.join(repo, '.gitignore'), '.lattice/runs/\n');
  await writeFile(path.join(repo, 'src', 'alpha.mjs'), 'export const alpha = 1;\n');
  await writeFile(path.join(repo, 'test', 'alpha.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { alpha } from '../src/alpha.mjs';",
    "test('alpha', () => assert.equal(alpha, 1));",
    '',
  ].join('\n'));
  command('git', ['init', '--quiet', '--initial-branch=main'], repo);
  command('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'add', '.'], repo);
  command('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'commit', '--quiet', '-m', 'base'], repo);
  const baseSha = command('git', ['rev-parse', 'HEAD'], repo).trim();
  invokeSensorCli(command, ['init', '.'], repo);
  const request = {
    schema: 'lattice.run_request.v1',
    request_id: 'multi-epoch-fixture',
    repo: { base_sha: baseSha, root_kind: 'git-worktree' },
    capacity: { executors: 1 },
    todos: [{ todo_id: 'T1' }],
    manual_witness: { T1: {
      owns: [{ kind: 'symbol', target: 'alpha' }, { kind: 'path', target: 'src/alpha.mjs' }],
      reads: [], writes: ['src/alpha.mjs'], resources: [], state_effects: [],
      sensor_provenance: { queries: [
        { query_id: 'q-alpha', expect: { kind: 'symbol', name: 'alpha', path: 'src/alpha.mjs' } },
        { query_id: 'q-affected', expect: { kind: 'affected', path: 'src/alpha.mjs' } },
      ] },
      affected_tests: ['test/alpha.test.mjs'], unknowns: [],
    } },
    sensor_query_set: { queries: [
      { id: 'q-status', operation: 'status' },
      { id: 'q-alpha', operation: 'query', target: 'alpha' },
      { id: 'q-affected', operation: 'affected', target: 'src/alpha.mjs' },
    ] },
    executor_capability: { adapters: ['scripted'] }, claim_mode: 'exact_minimum',
  };
  request.request_digest = selfDigest(request, 'request_digest');
  const requestPath = path.join(root, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);
  command(process.execPath, [CLI, 'run', 'start', '--request', requestPath,
    '--executor', 'scripted'], repo);
  return { root, repo, runDir: path.join(repo, '.lattice', 'runs', request.request_id) };
}

async function activationEvidence(runDir) {
  const runEvents = JSON.parse(await readFile(path.join(runDir, 'events.json')));
  const control = createRuntimeControlStore({ runDir, runId: 'multi-epoch-fixture',
    clock: () => '2026-07-21T00:00:00.000Z' });
  const controlDigest = await control.append({ run_id: 'multi-epoch-fixture',
    kind: 'supervisor_activated', session_nonce_digest: 'c'.repeat(64),
    payload: { supervisor_descriptor_digest: 'd'.repeat(64),
      controller_descriptor_digest: 'e'.repeat(64), registration_digest: 'f'.repeat(64) } });
  return {
    activationRunEventDigest: runEvents.at(-1).event_digest,
    activationControlEventDigest: controlDigest,
  };
}

function successorBundle(active) {
  const migration = { schema: 'lattice.runtime_task_migration.v1', entries: [{
    predecessor_task_id: 'T1', disposition: 'stay', successor_task_ids: ['T1'],
    reason: 'intentional serial', evidence_digests: ['1'.repeat(64)],
  }], migration_digest: '' };
  migration.migration_digest = selfDigest(migration, 'migration_digest');
  const request = { ...active.bundle.request, schema: 'lattice.run_request.v2',
    predecessor_request_digest: active.bundle.request.request_digest,
    task_migration_digest: migration.migration_digest, request_digest: '' };
  request.request_digest = selfDigest(request, 'request_digest');
  const plan = { ...active.bundle.plan, plan_ref: 'plan-multi-epoch-fixture-e2', plan_epoch: 2,
    request_digest: request.request_digest, predecessor_refs: [active.bundle.plan.plan_ref],
    plan_digest: '' };
  plan.plan_digest = selfDigest(plan, 'plan_digest');
  const bundle = { schema: 'lattice.runtime_epoch_bundle.v1', run_id: active.bundle.run_id,
    plan_epoch: 2, request, plan, manifests: active.bundle.manifests,
    executor_packets: buildExecutorPackets({ plan, manifests: active.bundle.manifests }),
    rebind_packets: {}, plan_diff: {}, task_migration: migration,
    treatment: { schema: 'test.intentional_serial.v1' }, phase_revision_digest: null,
    phase_revision_commit_receipt: null, predecessor_bundle_digest: active.bundle.bundle_digest,
    bundle_digest: '' };
  bundle.bundle_digest = selfDigest(bundle, 'bundle_digest');
  return bundle;
}

async function stagedFixture(t) {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  const legacyMeta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  const active = await activateEpochOneStore({ runDir: value.runDir, request,
    compileArtifact, legacyMeta, ...evidence });
  const bundle = successorBundle(active);
  await stageSuccessorEpoch({ runDir: value.runDir, transactionId: 'successor-2',
    bundle, validateSuccessor: () => true });
  return { ...value, evidence, bundle };
}

test('heartbeat追加後もsnapshot activation digestは耐久prefixとしてcommitできる', async (t) => {
  const value = await stagedFixture(t);
  const control = createRuntimeControlStore({ runDir: value.runDir,
    runId: value.bundle.run_id, clock: () => '2026-07-21T00:00:01.000Z' });
  const committed = await commitStagedSuccessorEpoch({ runDir: value.runDir,
    transactionId: 'successor-2', ...value.evidence,
    readActivationControlEvents: async () => {
      await control.append({ run_id: value.bundle.run_id, kind: 'controller_heartbeat',
        session_nonce_digest: 'c'.repeat(64), payload: { controller_id: 'controller-a',
          registration_digest: 'f'.repeat(64), sequence: 1, lease_set_digest: 'a'.repeat(64) } });
      const events = await control.readEvents();
      t.diagnostic(JSON.stringify({ control: {
        expected_tail: value.evidence.activationControlEventDigest,
        actual_tail: events.at(-1).event_digest,
        expected_in_chain: events.some((e) => e.event_digest === value.evidence.activationControlEventDigest),
      } }));
      return events;
    } });
  assert.equal(committed.pointer.plan_epoch, 2);
  assert.equal(committed.pointer.activation_control_event_digest,
    value.evidence.activationControlEventDigest);
  t.diagnostic(JSON.stringify(committed.activation_evidence));
  assert.equal(committed.activation_evidence.run.expected_in_chain, true);
  assert.equal(committed.activation_evidence.control.expected_in_chain, true);
  assert.notEqual(committed.activation_evidence.control.expected_tail,
    committed.activation_evidence.control.actual_tail);
});

test('run/controlの両tailが進んでも、同じactivation prefixをcommitする', async (t) => {
  const value = await stagedFixture(t);
  const runPath = path.join(value.runDir, 'events.json');
  const runEvents = JSON.parse(await readFile(runPath));
  runEvents.push(buildNextRunEvent({ events: runEvents, runId: value.bundle.run_id,
    kind: 'checkpoint_observed', planEpoch: 1, subject: { kind: 'todo', ref: 'T1' },
    payload: { checkpoint_digest: 'a'.repeat(64) }, recordedAt: '2026-07-21T00:00:01.000Z' }));
  await writeFile(runPath, `${JSON.stringify(runEvents)}\n`);
  const control = createRuntimeControlStore({ runDir: value.runDir,
    runId: value.bundle.run_id, clock: () => '2026-07-21T00:00:01.000Z' });
  const committed = await commitStagedSuccessorEpoch({ runDir: value.runDir,
    transactionId: 'successor-2', ...value.evidence,
    readActivationControlEvents: async () => {
      await control.append({ run_id: value.bundle.run_id, kind: 'controller_heartbeat',
        session_nonce_digest: 'c'.repeat(64), payload: { controller_id: 'controller-a',
          registration_digest: 'f'.repeat(64), sequence: 1, lease_set_digest: 'a'.repeat(64) } });
      return control.readEvents();
    } });
  t.diagnostic(JSON.stringify(committed.activation_evidence));
  for (const evidence of Object.values(committed.activation_evidence)) {
    assert.equal(evidence.expected_in_chain, true);
    assert.equal(evidence.chain_valid, true);
    assert.notEqual(evidence.expected_tail, evidence.actual_tail);
  }
  assert.equal(committed.pointer.plan_epoch, 2);
});

test('欠落・壊れたchain・後続の矛盾はpointerを変えず、証拠を直せば同transactionで回復する', async (t) => {
  const value = await stagedFixture(t);
  const runPath = path.join(value.runDir, 'events.json');
  const controlPath = path.join(value.runDir, 'control-events.json');
  const originalRun = JSON.parse(await readFile(runPath));
  const originalControl = JSON.parse(await readFile(controlPath));
  const commit = (evidence = value.evidence) => commitStagedSuccessorEpoch({
    runDir: value.runDir, transactionId: 'successor-2', ...evidence });
  const refused = (stream, predicate) => (error) => {
    assert.equal(error.code, 'EPOCH_ACTIVATION_INCOMPLETE');
    assert.equal(predicate(error.detail[stream]), true);
    assert.ok(error.message.includes('expected_in_chain'));
    return true;
  };
  for (const [stream, field] of [['run', 'activationRunEventDigest'], ['control', 'activationControlEventDigest']]) {
    await assert.rejects(commit({ ...value.evidence, [field]: '0'.repeat(64) }),
      refused(stream, (e) => !e.expected_in_chain));
  }
  const broken = structuredClone(originalControl);
  broken[0].payload.registration_digest = '0'.repeat(64);
  await writeFile(controlPath, JSON.stringify(broken));
  await assert.rejects(commit(), refused('control', (e) => !e.chain_valid));
  await writeFile(controlPath, `${canonicalizeArtifact(originalControl)}\n`);
  const control = createRuntimeControlStore({ runDir: value.runDir, runId: value.bundle.run_id });
  for (const [kind, payload] of [
    ['epoch_activated', { plan_epoch: 2, gate_digest: 'b'.repeat(64) }],
    ['intake_resumed', { plan_epoch: 2, gate_digest: 'b'.repeat(64) }],
    ['write_gate_committed', { gate_generation: 2, gate_digest: 'b'.repeat(64) }],
    ['supervisor_stopped', { signal: 'SIGTERM' }],
    ['supervisor_recovery_barrier', { barrier_id: 'barrier-b' }],
  ]) {
    await control.append({ run_id: value.bundle.run_id, kind,
      session_nonce_digest: 'c'.repeat(64), payload });
    await assert.rejects(commit(), refused('control', (e) => e.conflicting_event_digest !== null));
    await writeFile(controlPath, `${canonicalizeArtifact(originalControl)}\n`);
  }
  const foreign = buildNextRunEvent({ events: [], runId: 'different-run', kind: 'run_initialized',
    planEpoch: 1, subject: { kind: 'run_request', ref: 'request.json' },
    payload: {}, recordedAt: '2026-07-21T00:00:01.000Z' });
  await writeFile(runPath, JSON.stringify([foreign]));
  await assert.rejects(commit({ ...value.evidence, activationRunEventDigest: foreign.event_digest }),
    refused('run', (e) => e.expected_in_chain && !e.chain_valid));
  await writeFile(runPath, JSON.stringify(originalRun));
  for (const [kind, planEpoch, payload] of [
    ['plan_recompiled', 2, { new_plan_digest: '0'.repeat(64) }],
    ['intake_frozen', 1, { reason_kind: 'observed_write_conflict' }],
    ['intake_resumed', 2, { plan_diff_digest: '0'.repeat(64) }],
    ['run_closed', 1, { outcome: 'completed' }],
    ['checkpoint_observed', 3, { checkpoint_digest: '0'.repeat(64) }],
  ]) {
    const contradictoryRun = [...originalRun, buildNextRunEvent({ events: originalRun,
      runId: value.bundle.run_id, kind, planEpoch,
      subject: { kind: 'runtime_plan', ref: 'different-plan' },
      payload, recordedAt: '2026-07-21T00:00:01.000Z' })];
    await writeFile(runPath, JSON.stringify(contradictoryRun));
    await assert.rejects(commit(), refused('run', (e) => e.conflicting_event_digest !== null));
  }
  assert.equal((await readCommittedEpochStore(value.runDir)).pointer.plan_epoch, 1);
  await writeFile(runPath, JSON.stringify(originalRun));
  assert.equal((await commit()).pointer.plan_epoch, 2);
});

test('初回activationも心拍後のtailではなくsupervisor activation prefixへbindする', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  const legacyMeta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  const control = createRuntimeControlStore({ runDir: value.runDir, runId: request.request_id });
  await control.append({ run_id: request.request_id, kind: 'controller_heartbeat',
    session_nonce_digest: 'c'.repeat(64), payload: { controller_id: 'controller-a',
      registration_digest: 'f'.repeat(64), sequence: 1, lease_set_digest: 'a'.repeat(64) } });
  const committed = await activateEpochOneStore({ runDir: value.runDir, request,
    compileArtifact, legacyMeta, ...evidence });
  assert.equal(committed.pointer.activation_control_event_digest, evidence.activationControlEventDigest);
  assert.equal(committed.activation_evidence.control.expected_in_chain, true);
});

test('v1 alias bytesを変えずepoch 1 bundleとpointerを最後にcommitする', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const requestPath = path.join(value.runDir, 'request.json');
  const compilePath = path.join(value.runDir, 'plan-compile-result.json');
  const requestBytes = await readFile(requestPath);
  const compileBytes = await readFile(compilePath);
  const request = JSON.parse(requestBytes);
  const compileArtifact = JSON.parse(compileBytes);
  const legacyMeta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  const activated = await activateEpochOneStore({
    runDir: value.runDir, request, compileArtifact, legacyMeta,
    ...evidence,
  });
  assert.equal(activated.bundle.plan_epoch, 1);
  assert.equal(activated.pointer.bundle_digest, activated.bundle.bundle_digest);
  assert.deepEqual(await readFile(requestPath), requestBytes);
  assert.deepEqual(await readFile(compilePath), compileBytes);
  const reopened = await readCommittedEpochStore(value.runDir);
  assert.equal(reopened.pointer.plan_epoch, 1);
  assert.equal(reopened.meta.schema, 'lattice.run_meta.v2');
});

test('同digest activation retryはv2 metaから回復し、directory最大値を採用しない', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  let meta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  const options = { runDir: value.runDir, request, compileArtifact, legacyMeta: meta,
    ...evidence };
  const first = await activateEpochOneStore(options);
  meta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const second = await activateEpochOneStore({ ...options, legacyMeta: meta });
  assert.equal(second.pointer.pointer_digest, first.pointer.pointer_digest);
  await mkdir(path.join(value.runDir, 'epochs', '99999999'));
  await writeFile(path.join(value.runDir, 'epochs', '99999999', 'epoch-bundle.json'), '{}\n');
  assert.equal((await readCommittedEpochStore(value.runDir)).pointer.plan_epoch, 1);
});

test('pointerとbundleの不一致はfallbackせずfail closedにする', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  const legacyMeta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  await activateEpochOneStore({ runDir: value.runDir, request, compileArtifact, legacyMeta,
    ...evidence });
  const pointerPath = path.join(value.runDir, 'committed-epoch.json');
  const pointer = JSON.parse(await readFile(pointerPath));
  pointer.bundle_digest = 'f'.repeat(64);
  await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);
  await assert.rejects(readCommittedEpochStore(value.runDir), (error) => (
    error instanceof RuntimeEpochStoreError && error.code === 'INVALID_RUN_STORE'
  ));
});

test('run_request.v2 verifier未指定のsuccessorはstore無変更で拒否する', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  const legacyMeta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  const active = await activateEpochOneStore({ runDir: value.runDir, request, compileArtifact, legacyMeta, ...evidence });
  await assert.rejects(stageSuccessorEpoch({
    runDir: value.runDir,
    transactionId: 'successor-2',
    bundle: { ...active.bundle, plan_epoch: 2 },
  }), (error) => error.code === 'UNSUPPORTED_SUCCESSOR_SCHEMA');
  await assert.rejects(readFile(path.join(value.runDir, 'staging', 'successor-2', 'epoch-bundle.json')),
    (error) => error.code === 'ENOENT');
});

test('epoch bundle/meta後pointer前crashはsame activation digestだけroll-forwardする', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  const legacyMeta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  const first = await activateEpochOneStore({ runDir: value.runDir, request, compileArtifact, legacyMeta, ...evidence });
  await unlink(path.join(value.runDir, 'committed-epoch.json'));
  const v2Meta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const recovered = await activateEpochOneStore({ runDir: value.runDir, request, compileArtifact,
    legacyMeta: v2Meta, ...evidence });
  assert.equal(recovered.pointer.pointer_digest, first.pointer.pointer_digest);
  assert.equal((await readCommittedEpochStore(value.runDir)).pointer.pointer_digest, first.pointer.pointer_digest);
  await unlink(path.join(value.runDir, 'committed-epoch.json'));
  await assert.rejects(activateEpochOneStore({ runDir: value.runDir, request, compileArtifact,
    legacyMeta: v2Meta, ...evidence, activationControlEventDigest: 'f'.repeat(64) }),
  (error) => error.code === 'INVALID_RUN_STORE');
  await assert.rejects(readFile(path.join(value.runDir, 'committed-epoch.json')),
    (error) => error.code === 'ENOENT');
});

test('successor directory rename後pointer前crashはsame transactionだけroll-forwardする', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  const legacyMeta = JSON.parse(await readFile(path.join(value.runDir, 'run-meta.json')));
  const evidence = await activationEvidence(value.runDir);
  const active = await activateEpochOneStore({ runDir: value.runDir, request, compileArtifact,
    legacyMeta, ...evidence });
  const bundle = successorBundle(active);
  await stageSuccessorEpoch({ runDir: value.runDir, transactionId: 'successor-2', bundle,
    validateSuccessor: () => true });
  await rename(path.join(value.runDir, 'staging', 'successor-2'),
    path.join(value.runDir, 'epochs', '00000002'));
  const committed = await commitStagedSuccessorEpoch({ runDir: value.runDir,
    transactionId: 'successor-2', ...evidence });
  assert.equal(committed.pointer.plan_epoch, 2);
  const retried = await commitStagedSuccessorEpoch({ runDir: value.runDir,
    transactionId: 'successor-2', ...evidence });
  assert.equal(retried.pointer.pointer_digest, committed.pointer.pointer_digest);
});

// 活性化はpointer→metaの順で書く。逆順だとmeta v2だけが見える窓ができ、並行する
// readerがINVALID_RUN_STORE（committed epoch pointerを読めない）で落ちる
// （2026-08-22 CI負荷下で実被弾: run observeのpolling中に落ちた）。この順での
// 途中crash盤面（pointerあり・metaはv1のまま）はlegacyへfallbackし、再活性化で回復する。
test('pointer書込み後meta書込み前のcrash盤面はlegacy fallbackし再活性化で回復する', async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const request = JSON.parse(await readFile(path.join(value.runDir, 'request.json')));
  const compileArtifact = JSON.parse(await readFile(path.join(value.runDir, 'plan-compile-result.json')));
  const legacyMetaBytes = await readFile(path.join(value.runDir, 'run-meta.json'));
  const legacyMeta = JSON.parse(legacyMetaBytes);
  const evidence = await activationEvidence(value.runDir);
  const options = { runDir: value.runDir, request, compileArtifact, legacyMeta, ...evidence };
  const first = await activateEpochOneStore(options);
  // pointerだけが耐久化されmetaがv1のままの盤面（新しい書込み順の唯一の途中状態）を作る。
  await writeFile(path.join(value.runDir, 'run-meta.json'), legacyMetaBytes);
  assert.equal(await readCommittedEpochStore(value.runDir), null,
    'meta v1のままならmulti-epochとして読まずlegacyへfallbackする');
  const recovered = await activateEpochOneStore(options);
  assert.equal(recovered.pointer.pointer_digest, first.pointer.pointer_digest);
  assert.equal((await readCommittedEpochStore(value.runDir)).pointer.plan_epoch, 1);
});
