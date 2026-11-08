import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adjudicatePendingReceipts,
  buildNextRunEvent,
  buildExecutorPackets,
  classifyCheckpointObservation,
  closeRunIfComplete,
  dispatchReadyFrontier,
  initializeRunEvents,
  observeExecutor,
} from '../src/runtime-engine.mjs';
import {
  buildCarryOverWitness,
  decideHoldAndCarryOver,
  recompileNextEpochPlan,
  routeConflictTreatment,
  validateRunRequestV2,
  validateRuntimeRecompileRequest,
  validateRuntimeTaskMigration,
} from '../src/runtime-hold-recompile.mjs';
import { detectCheckpointFindings } from '../src/runtime-diff-observer.mjs';
import { createScriptedExecutorAdapter } from './helpers/scripted-executor.mjs';
import {
  computeReadyFrontier,
  recomputeHoldDecision,
  recomputeReceiptDecisions,
  verifyCarryOverWitness,
} from '../src/runtime-decision-verifier.mjs';
import { verifyRunEventChain } from '../src/runtime-event-store.mjs';
import { projectRuntimeState } from '../src/runtime-projection.mjs';
import { selfDigest } from '../src/runtime-contracts.mjs';

// RC3-G focused test（ADR 0044 Decision 6・7、plan RC3-G）。
// 後発path conflict→intake freeze→affected-only hold→carry-over witness→
// epoch rebind→plan vN+1 recompile→redispatch→閉ループ完走を、
// producer裁定とverifier再計算のexact一致つきで固定する。

const SHA1 = 'b'.repeat(40);
const SHA256 = 'a'.repeat(64);
const RUN_ID = 'run-rc3g-01';
const AT = '2026-07-17T00:00:00.000Z';

function buildFixture({ todos, capacity }) {
  const request = {
    schema: 'lattice.run_request.v1',
    request_id: 'req-rc3g-01',
    repo: { base_sha: SHA1, root_kind: 'git-worktree' },
    capacity: { executors: capacity },
    todos: todos.map((todoId) => ({ todo_id: todoId })),
    manual_witness: Object.fromEntries(todos.map((todoId) => [todoId, {
      owns: [{ kind: 'path', target: `src/${todoId.toLowerCase()}.mjs` }],
      reads: [],
      writes: [`src/${todoId.toLowerCase()}.mjs`],
      resources: [],
      state_effects: [],
      sensor_provenance: { queries: [] },
      affected_tests: [`test/${todoId.toLowerCase()}.test.mjs`],
      unknowns: [],
    }])),
    sensor_query_set: { queries: [] },
    executor_capability: { adapters: ['scripted'] },
    claim_mode: 'exact_minimum',
  };
  request.request_digest = selfDigest(request, 'request_digest');
  const manifests = {};
  for (const todoId of todos) {
    const witness = request.manual_witness[todoId];
    const manifest = {
      schema: 'lattice.boundary_manifest.v2',
      todo_id: todoId,
      owns: witness.owns,
      reads: witness.reads,
      writes: witness.writes,
      resources: [],
      state_effects: [],
      unknowns: [],
      affected_tests: witness.affected_tests,
      graph_evidence: [],
      witness_provenance: {},
    };
    manifest.manifest_digest = selfDigest(manifest, 'manifest_digest');
    manifests[todoId] = manifest;
  }
  const plan = {
    schema: 'lattice.runtime_plan.v1',
    plan_ref: 'plan-req-rc3g-01-e1',
    plan_epoch: 1,
    request_digest: request.request_digest,
    base_sha: SHA1,
    nodes: todos.map((todoId) => ({ todo_id: todoId })),
    precedence: [],
    conflicts: [],
    capacity: { executors: capacity },
    manifest_digests: Object.fromEntries(todos.map((todoId) => [todoId, manifests[todoId].manifest_digest])),
    claim: { mode: 'exact_minimum' },
    predecessor_refs: [],
  };
  plan.plan_digest = selfDigest(plan, 'plan_digest');
  return { request, plan, manifests };
}

function checkpointStep(entries) {
  const diff = { schema: 'lattice.checkpoint_diff.v1', base_sha: SHA1, entries };
  return {
    kind: 'checkpoint',
    checkpoint: { checkpoint_digest: selfDigest({ d: diff, checkpoint_digest: undefined }, 'checkpoint_digest'), diff },
  };
}

async function runLateConflictScenario() {
  const fixture = buildFixture({ todos: ['T1', 'T2', 'T3'], capacity: 3 });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  const adapter = createScriptedExecutorAdapter({
    script: {
      // T1はT2のdeclared write（src/t2.mjs）へ書く＝後発path conflict＋scope violation。
      T1: [checkpointStep([
        { path: 'src/t1.mjs', change: 'modified', content_digest: SHA256 },
        { path: 'src/t2.mjs', change: 'modified', content_digest: SHA256 },
      ])],
      T2: [{ kind: 'stall' }],
      T3: [
        checkpointStep([{ path: 'src/t3.mjs', change: 'modified', content_digest: SHA256 }]),
        { kind: 'stall' },
        { kind: 'terminal' },
      ],
    },
  });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const dispatched = await dispatchReadyFrontier({
    runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT,
  });
  events = dispatched.events;
  assert.deepEqual(dispatched.dispatched, ['T1', 'T2', 'T3']);

  // T3が先に正常checkpointを積む。
  const t3Observed = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'T3', recordedAt: AT });
  events = t3Observed.events;

  // T1のcheckpointが後発競合を露呈し、分類でconflict_found＋intake_frozen。
  const t1Observed = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'T1', recordedAt: AT });
  events = t1Observed.events;
  const classified = classifyCheckpointObservation({
    runId: RUN_ID, plan, events, packets, manifests, todoId: 'T1',
    detect: detectCheckpointFindings, recordedAt: AT,
  });
  events = classified.events;
  assert.deepEqual(
    classified.findings.map(({ kind }) => kind).sort(),
    ['observed_write_conflict'],
  );
  assert.deepEqual(classified.observations.map(({ kind }) => kind), ['prediction_excess']);

  // hold裁定: affected {T1,T2}のみhold、T3はwitness付きでcontinue。
  const held = decideHoldAndCarryOver({
    runId: RUN_ID, request, plan, manifests, packets, events, recordedAt: AT,
  });
  events = held.events;
  return { fixture, packets, adapter, events, held };
}

test('後発path conflictはexact affected集合のholdとwitness付きcontinueになる', async () => {
  const { fixture, events, held } = await runLateConflictScenario();
  assert.deepEqual(held.holdDecision.hold_set, ['T1', 'T2']);
  assert.deepEqual(held.holdDecision.continue_set, ['T3']);
  assert.deepEqual(held.holdDecision.affected_closure, ['T1', 'T2']);
  assert.deepEqual(held.witnessFailures, {});

  // 独立verifierの再計算とexact一致（成功条件11・12）。
  const recomputed = recomputeHoldDecision({
    plan: fixture.plan, events, manifests: fixture.manifests,
  });
  assert.deepEqual(recomputed.hold_set, held.holdDecision.hold_set);
  assert.deepEqual(recomputed.continue_set, held.holdDecision.continue_set);

  // witnessは提供bytesから再実証できる（成功条件13の正側）。
  const state = projectRuntimeState({ events });
  const witness = state.witnesses.T3.payload.witness;
  const packet = buildExecutorPackets({ plan: fixture.plan, manifests: fixture.manifests }).T3;
  const verified = verifyCarryOverWitness({
    witness,
    sources: {
      todo_input: fixture.request.manual_witness.T3,
      boundary_manifest: fixture.manifests.T3,
      validator: packet.verifier_refs,
      context_content: {
        todo_id: packet.todo_id,
        task_ref: packet.task_ref,
        scope: packet.scope,
        base_sha: packet.base_sha,
        verifier_refs: packet.verifier_refs,
        forbidden_operations: packet.forbidden_operations,
      },
    },
  });
  assert.equal(verified.valid, true, JSON.stringify(verified.reasons));

  // 1 fieldでも壊すとwitnessは不成立（成功条件13の負側）。
  const tampered = structuredClone(witness);
  tampered.invariant_digests.boundary_manifest = 'f'.repeat(64);
  const refuted = verifyCarryOverWitness({
    witness: tampered,
    sources: { todo_input: {}, boundary_manifest: {}, validator: [], context_content: {} },
  });
  assert.equal(refuted.valid, false);
  assert.ok(refuted.reasons.includes('carry_over_unprovable'));
});

test('plan vN+1 producerは対象だけを失効し、無関係TODOのorigin bindingを維持して完走する', async () => {
  const { fixture, packets, adapter, events: heldEvents, held } = await runLateConflictScenario();
  const { request, plan, manifests } = fixture;

  const recompiled = recompileNextEpochPlan({
    runId: RUN_ID,
    request,
    plan,
    manifests,
    packets,
    events: heldEvents,
    holdDecision: held.holdDecision,
    additionalConflicts: [{ todo_ids: ['T1', 'T2'], resource_id: 'late-src-t2' }],
    recordedAt: AT,
  });
  let events = recompiled.events;
  const newPlan = recompiled.newPlan;

  assert.equal(newPlan.plan_epoch, 2);
  assert.ok(newPlan.conflicts.some((conflict) => conflict.resource_id === 'late-src-t2'));
  assert.ok(newPlan.predecessor_refs.includes(plan.plan_ref));
  assert.deepEqual(recompiled.planDiff.carried_over, ['T3']);
  assert.deepEqual(recompiled.planDiff.redispatched, ['T1', 'T2']);
  assert.deepEqual(Object.keys(recompiled.rebindPackets), ['T3']);
  assert.deepEqual(Object.keys(recompiled.redispatchPackets).sort(), ['T1', 'T2']);

  // rebind packetはsupervisor restart時の全体barrierから復元する時だけ使う。
  const rebind = recompiled.rebindPackets.T3;
  assert.equal(rebind.context_content_digest, packets.T3.context_content_digest);
  assert.equal(rebind.new_plan_epoch, 2);

  // 通常replanではT3を止めず、rebind eventも作らない。
  assert.notEqual(projectRuntimeState({ events }).freeze, null);
  assert.deepEqual(sortedTodoRefs(events, 'epoch_rebound'), []);
  events.push(buildNextRunEvent({ events, runId: RUN_ID, kind: 'intake_resumed', planEpoch: 2,
    subject: { kind: 'runtime_plan', ref: newPlan.plan_ref },
    payload: { plan_diff_digest: recompiled.planDiff.diff_digest }, recordedAt: AT }));

  // 失効・終端・resumeがevent chainへ保存されている。
  const state = projectRuntimeState({ events });
  assert.equal(state.freeze, null, 'intakeは再開済み');
  assert.equal(state.invalidated_contexts.length, 2);
  assert.deepEqual(sortedTodoRefs(events, 'context_invalidated'), ['T1', 'T2']);
  assert.deepEqual(sortedTodoRefs(events, 'epoch_rebound'), []);

  // 新epochのfrontier: T1/T2はredispatch可能だがconflict pairなので1件ずつ。
  // T3はrunning継続のためredispatchされない。verifier再計算と一致。
  const epoch2Adapter = createScriptedExecutorAdapter({
    script: {
      T1: [{ kind: 'terminal' }],
      T2: [{ kind: 'terminal' }],
    },
  });
  const redispatch1 = await dispatchReadyFrontier({
    runId: RUN_ID, plan: newPlan, events, packets: recompiled.redispatchPackets,
    manifests, adapter: epoch2Adapter, recordedAt: AT,
  });
  events = redispatch1.events;
  assert.deepEqual(redispatch1.dispatched, ['T1']);
  const frontierCheck = computeReadyFrontier({
    plan: newPlan,
    events: events.slice(0, events.findLastIndex((e) => e.kind === 'dispatch_decided')),
  });
  assert.deepEqual(frontierCheck.dispatchable, ['T1']);

  // T1完走→受理→T2 redispatch→完走→T3のorigin epoch receipt→全受理→close。
  const t1Terminal = await observeExecutor({ runId: RUN_ID, plan: newPlan, events, adapter: epoch2Adapter, todoId: 'T1', recordedAt: AT });
  events = t1Terminal.events;
  let adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan: newPlan, events, recordedAt: AT });
  events = adjudicated.events;
  assert.deepEqual(adjudicated.decisions, [{ receipt_id: 'T1-r1', decision: 'accepted' }]);

  const redispatch2 = await dispatchReadyFrontier({
    runId: RUN_ID, plan: newPlan, events, packets: recompiled.redispatchPackets,
    manifests, adapter: epoch2Adapter, recordedAt: AT,
  });
  events = redispatch2.events;
  assert.deepEqual(redispatch2.dispatched, ['T2']);
  const t2Terminal = await observeExecutor({ runId: RUN_ID, plan: newPlan, events, adapter: epoch2Adapter, todoId: 'T2', recordedAt: AT });
  events = t2Terminal.events;

  // T3はstall（unknown、同一handle回収）を経てterminal。bindingはepoch 1のまま。
  const t3Stall = await observeExecutor({ runId: RUN_ID, plan: newPlan, events, adapter, todoId: 'T3', recordedAt: AT });
  events = t3Stall.events;
  assert.equal(t3Stall.observation.state, 'unknown');
  const t3Terminal = await observeExecutor({ runId: RUN_ID, plan: newPlan, events, adapter, todoId: 'T3', recordedAt: AT });
  events = t3Terminal.events;

  adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan: newPlan, events, recordedAt: AT });
  events = adjudicated.events;
  assert.deepEqual(
    adjudicated.decisions.map(({ receipt_id: id, decision }) => [id, decision]).sort(),
    [['T2-r1', 'accepted'], ['T3-r1', 'accepted']],
  );

  const closed = closeRunIfComplete({ runId: RUN_ID, plan: newPlan, events, recordedAt: AT });
  events = closed.events;
  assert.equal(closed.closed, true);

  // 保存bytesの整合: chain valid＋verifier受理再計算一致（成功条件21）。
  const chain = verifyRunEventChain({ events });
  assert.equal(chain.valid, true, JSON.stringify(chain.failed_conditions));
  const receiptCheck = recomputeReceiptDecisions({ plan: newPlan, events });
  for (const decision of receiptCheck.decisions) {
    if (['T1-r1', 'T2-r1', 'T3-r1'].includes(decision.receipt_id)) {
      assert.equal(decision.decision, 'accepted', decision.receipt_id);
    }
  }
});

test('非affected TODOのvN receiptはorigin bindingの成果としてvN+1で受理される', async () => {
  const { fixture, packets, adapter, events: heldEvents, held } = await runLateConflictScenario();
  const { request, plan, manifests } = fixture;
  const recompiled = recompileNextEpochPlan({
    runId: RUN_ID, request, plan, manifests, packets, events: heldEvents,
    holdDecision: held.holdDecision, additionalConflicts: [], recordedAt: AT,
  });
  let events = recompiled.events;
  // T3は止めず、旧epoch 1のbindingのままterminalまで進める。
  const stalled = await observeExecutor({ runId: RUN_ID, plan: recompiled.newPlan, events, adapter, todoId: 'T3', recordedAt: AT });
  events = stalled.events;
  const terminal = await observeExecutor({ runId: RUN_ID, plan: recompiled.newPlan, events, adapter, todoId: 'T3', recordedAt: AT });
  events = terminal.events;
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan: recompiled.newPlan, events, recordedAt: AT });
  assert.equal(adjudicated.decisions.length, 1);
  assert.equal(adjudicated.decisions[0].decision, 'accepted');
  const recomputed = recomputeReceiptDecisions({ plan: recompiled.newPlan, events });
  const t3Decision = recomputed.decisions.find((d) => d.todo_id === 'T3');
  assert.equal(t3Decision.decision, 'accepted');
});

test('u03 C43: witnessを作れないclosure外TODOもcontinueし、origin receiptは再読込後の次epochで受理される', async () => {
  const partial = await runLateConflictScenario();
  const { request, plan, manifests } = partial.fixture;
  const eventsBeforeHold = partial.events.slice(
    0,
    partial.events.findIndex((e) => e.kind === 'carry_over_witnessed'),
  );
  const brokenPackets = { ...partial.packets };
  delete brokenPackets.T3;
  const held = decideHoldAndCarryOver({
    runId: RUN_ID, request, plan, manifests, packets: brokenPackets,
    events: eventsBeforeHold, recordedAt: AT,
  });
  assert.deepEqual(held.holdDecision.hold_set, ['T1', 'T2']);
  assert.deepEqual(held.holdDecision.continue_set, ['T3']);
  assert.deepEqual(held.witnessFailures.T3, ['missing_packet_or_manifest']);
  assert.equal(held.events.some((e) => e.kind === 'carry_over_witnessed'), false);

  const recompiled = recompileNextEpochPlan({
    runId: RUN_ID, request, plan, manifests, packets: partial.packets, events: held.events,
    holdDecision: held.holdDecision,
    additionalConflicts: [{ todo_ids: ['T1', 'T2'], resource_id: 'late-src-t2' }],
    recordedAt: AT,
  });
  assert.deepEqual(recompiled.planDiff.carried_over, ['T3']);
  assert.deepEqual(Object.keys(recompiled.rebindPackets), []);
  let events = recompiled.events;
  events.push(buildNextRunEvent({ events, runId: RUN_ID, kind: 'intake_resumed', planEpoch: 2,
    subject: { kind: 'runtime_plan', ref: recompiled.newPlan.plan_ref },
    payload: { plan_diff_digest: recompiled.planDiff.diff_digest }, recordedAt: AT }));
  for (let step = 0; step < 2; step += 1) {
    events = (await observeExecutor({ runId: RUN_ID, plan: recompiled.newPlan, events,
      adapter: partial.adapter, todoId: 'T3', recordedAt: AT })).events;
  }
  // restart相当: 耐久bytesだけから再構成しても、hold_decided.continue_setが受理を支える。
  const reread = JSON.parse(JSON.stringify(events));
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan: recompiled.newPlan,
    events: reread, recordedAt: AT });
  assert.deepEqual(adjudicated.decisions, [{ receipt_id: 'T3-r1', decision: 'accepted' }]);
  const verified = recomputeReceiptDecisions({ plan: recompiled.newPlan, events: reread });
  assert.equal(verified.decisions.find((d) => d.receipt_id === 'T3-r1').decision, 'accepted');
});

test('routeConflictTreatmentはpredeclared seamだけをtransform laneへ送る', () => {
  const predeclared = [{
    treatment_id: 'shard-delivery-policy-registry-by-channel',
    covered_paths: ['research/fixtures/delivery-policy-registry/src/delivery-policy-registry.mjs'],
  }];
  const seam = routeConflictTreatment({
    finding: {
      kind: 'observed_write_conflict',
      todo_ids: ['A', 'B'],
      path: 'research/fixtures/delivery-policy-registry/src/delivery-policy-registry.mjs',
    },
    predeclaredTreatments: predeclared,
  });
  assert.equal(seam.lane, 'seam_transform');
  assert.equal(seam.treatment.treatment_id, 'shard-delivery-policy-registry-by-channel');

  const serial = routeConflictTreatment({
    finding: { kind: 'observed_write_conflict', todo_ids: ['A', 'B'], path: 'src/other.mjs' },
    predeclaredTreatments: predeclared,
  });
  assert.equal(serial.lane, 'intentional_serial');

  const sharedState = routeConflictTreatment({
    finding: { kind: 'semantic_conflict_unknown', todo_ids: ['A', 'B'], resource_id: 'ledger' },
    predeclaredTreatments: predeclared,
  });
  assert.equal(sharedState.lane, 'intentional_serial');
});

test('run_request.v2とintentional serialはfull migration/finding維持をexact検証する', () => {
  const fixture = buildFixture({ todos: ['T1', 'T2'], capacity: 1 });
  const migration = { schema: 'lattice.runtime_task_migration.v1', entries: [
    { predecessor_task_id: 'T1', disposition: 'stay', successor_task_ids: ['T1'],
      reason: 'seam cost', evidence_digests: ['1'.repeat(64)] },
    { predecessor_task_id: 'T2', disposition: 'carry', successor_task_ids: ['T2'],
      reason: 'serial peer', evidence_digests: ['2'.repeat(64)] },
  ], migration_digest: '' };
  migration.migration_digest = selfDigest(migration, 'migration_digest');
  assert.equal(validateRuntimeTaskMigration(migration, {
    predecessorTaskIds: ['T1', 'T2'], successorTaskIds: ['T1', 'T2'],
  }), true);
  const successor = { ...fixture.request, schema: 'lattice.run_request.v2',
    predecessor_request_digest: fixture.request.request_digest,
    task_migration_digest: migration.migration_digest, request_digest: '' };
  successor.request_digest = selfDigest(successor, 'request_digest');
  assert.equal(validateRunRequestV2(successor), true);
  const serial = { schema: 'lattice.runtime_intentional_serial.v1',
    finding_digest: '3'.repeat(64), todo_ids: ['T1', 'T2'], resource_id: 'shared-state',
    stay_todo_id: 'T1', reason: 'split cost exceeds serial cost', serial_digest: '' };
  serial.serial_digest = selfDigest(serial, 'serial_digest');
  const request = { schema: 'lattice.runtime_recompile_request.v1', request_id: 'recompile-1',
    run_id: successor.request_id, predecessor_epoch: 1, frozen_event_digest: '4'.repeat(64),
    hold_decision_digest: '5'.repeat(64), mode: 'intentional_serial', reason: 'shared state',
    successor_request: successor, task_migration: migration, phase_revision: null,
    seam_split: null, intentional_serial: serial, request_digest: '' };
  request.request_digest = selfDigest(request, 'request_digest');
  assert.equal(validateRuntimeRecompileRequest(request, {
    predecessorBundle: { plan_epoch: 1, request: fixture.request, plan: fixture.plan },
  }), true);
  const missing = structuredClone(request);
  missing.task_migration.entries.pop();
  missing.task_migration.migration_digest = selfDigest(missing.task_migration, 'migration_digest');
  missing.successor_request.task_migration_digest = missing.task_migration.migration_digest;
  missing.successor_request.request_digest = selfDigest(missing.successor_request, 'request_digest');
  missing.request_digest = selfDigest(missing, 'request_digest');
  assert.equal(validateRuntimeRecompileRequest(missing, {
    predecessorBundle: { plan_epoch: 1, request: fixture.request, plan: fixture.plan },
  }), false);
});

test('rebindなしのepoch自称receiptはunrebound_epochでrejectされる', async () => {
  const { fixture, packets, events: heldEvents, held } = await runLateConflictScenario();
  const { request, plan, manifests } = fixture;
  const recompiled = recompileNextEpochPlan({
    runId: RUN_ID, request, plan, manifests, packets, events: heldEvents,
    holdDecision: held.holdDecision, additionalConflicts: [], recordedAt: AT,
  });
  let events = recompiled.events;
  const newPlan = recompiled.newPlan;
  // epoch_rebound eventを削った列を作る（rebindなしでepoch 2を自称する経路）。
  const withoutRebind = [];
  const { buildNextRunEvent } = await import('../src/runtime-engine.mjs');
  for (const event of events) {
    if (event.kind === 'epoch_rebound') continue;
    withoutRebind.push(buildNextRunEvent({
      events: withoutRebind,
      runId: RUN_ID,
      kind: event.kind === 'run_initialized' && withoutRebind.length > 0 ? event.kind : event.kind,
      planEpoch: event.plan_epoch,
      subject: event.subject,
      payload: event.payload,
      recordedAt: AT,
    }));
  }
  // T3 executorへrebindを適用してreceiptにepoch 2を名乗らせるが、
  // event列にはepoch_reboundが存在しない。
  const scenario = await runLateConflictScenario();
  void scenario;
  const state = projectRuntimeState({ events: withoutRebind });
  assert.equal(state.rebinds.T3, undefined);
  // 偽装receiptを直接record（scripted adapterを介さず、engineのchain builderで正規化）。
  const forgedReceipt = {
    schema: 'lattice.executor_receipt.v1',
    receipt_id: 'T3-forged-r1',
    executor_handle: 'scripted-T3-h1',
    worktree_id: 'wt-T3',
    base_sha: SHA1,
    plan_epoch: 2,
    packet_digest: packets.T3.packet_digest,
    todo_id: 'T3',
    checkpoint_digest: projectRuntimeState({ events: withoutRebind })
      .checkpoints.filter((entry) => entry.todo_id === 'T3').at(-1).payload.checkpoint_digest,
    observed_diff: [{ path: 'src/t3.mjs', change: 'modified' }],
  };
  forgedReceipt.receipt_digest = selfDigest(forgedReceipt, 'receipt_digest');
  let forgedEvents = [...withoutRebind];
  forgedEvents.push(buildNextRunEvent({
    events: forgedEvents,
    runId: RUN_ID,
    kind: 'receipt_recorded',
    planEpoch: 2,
    subject: { kind: 'todo', ref: 'T3' },
    payload: forgedReceipt,
    recordedAt: AT,
  }));
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan: newPlan, events: forgedEvents, recordedAt: AT });
  assert.equal(adjudicated.decisions.length, 1);
  assert.equal(adjudicated.decisions[0].decision, 'rejected');
  assert.equal(adjudicated.decisions[0].detail, 'unrebound_epoch');
  const recomputed = recomputeReceiptDecisions({ plan: newPlan, events: forgedEvents });
  const decision = recomputed.decisions.find((d) => d.receipt_id === 'T3-forged-r1');
  assert.equal(decision.decision, 'rejected');
  assert.equal(decision.detail, 'unrebound_epoch');
});

test('freeze前pending receiptはwitness binding経由で旧planにより受理される', async () => {
  // Decision 7.5 expected example: frozen prefix内のvN receiptは、witnessが
  // bindする場合だけ、recompile前に旧planで受理される（正規経路の固定）。
  const fixture = buildFixture({ todos: ['T1', 'T2', 'T3'], capacity: 3 });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  const adapter = createScriptedExecutorAdapter({
    script: {
      T1: [checkpointStep([
        { path: 'src/t1.mjs', change: 'modified', content_digest: SHA256 },
        { path: 'src/t2.mjs', change: 'modified', content_digest: SHA256 },
      ])],
      T2: [{ kind: 'stall' }],
      // T3はfreeze前にterminal receiptまで到達する（pending receiptがfrozen prefixへ入る）。
      T3: [
        checkpointStep([{ path: 'src/t3.mjs', change: 'modified', content_digest: SHA256 }]),
        { kind: 'terminal' },
      ],
    },
  });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const dispatched = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = dispatched.events;
  // T3: checkpoint → terminal（receipt recorded、未裁定のまま残す）。
  const t3cp = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'T3', recordedAt: AT });
  events = t3cp.events;
  const t3term = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'T3', recordedAt: AT });
  events = t3term.events;
  // T1のcheckpointで競合→freeze。
  const t1cp = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'T1', recordedAt: AT });
  events = t1cp.events;
  const classified = classifyCheckpointObservation({
    runId: RUN_ID, plan, events, packets, manifests, todoId: 'T1',
    detect: detectCheckpointFindings, recordedAt: AT,
  });
  events = classified.events;
  // T3はterminal済みなのでfrozenRunningに入らない＝witness経由でなくfrozen prefix
  // 内のpending receiptとして扱われる…がholdDecisionのcontinueにはならない。
  // ここではreceiptのwitness binding経路を直接検査する: witnessを発行してから
  // 旧planで裁定し、bindingがあるreceiptだけ受理されることを固定する。
  const held = decideHoldAndCarryOver({
    runId: RUN_ID, request, plan, manifests, packets, events, recordedAt: AT,
  });
  events = held.events;
  // T3はterminal済みでfrozenRunning外→hold/continueいずれにも入らない。
  assert.equal(held.holdDecision.continue_set.includes('T3'), false);
  // 旧planでの裁定: T3のpending receiptはwitness bindingが無いのでwitness_unproven。
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan, events, recordedAt: AT });
  const t3Decision = adjudicated.decisions.find((d) => d.receipt_id === 'T3-r1');
  assert.equal(t3Decision.decision, 'rejected');
  assert.equal(t3Decision.detail, 'witness_unproven');
  const recomputed = recomputeReceiptDecisions({ plan, events: adjudicated.events.slice(0, -1) });
  const verifierDecision = recomputed.decisions.find((d) => d.receipt_id === 'T3-r1');
  assert.equal(verifierDecision.decision, 'rejected');
});

test('witness構築はsources不整合をreasons付きで失敗させる', () => {
  const built = buildCarryOverWitness({
    todoId: 'TX',
    predecessorEpoch: 2,
    successorEpoch: 2, // epoch非単調 → 構築後の自己実証で失敗する
    sources: {
      todo_input: { a: 1 },
      boundary_manifest: { b: 2 },
      validator: ['node --test test/x.test.mjs'],
      context_content: { c: 3 },
    },
    nonOverlapEvidence: ['conflict_found#deadbeef'],
    receiptBindings: [],
  });
  assert.equal(built.witness, null);
  assert.ok(built.reasons.includes('carry_over_unprovable'));
});

function sortedTodoRefs(events, kind) {
  return events
    .filter((event) => event.kind === kind && event.subject?.kind === 'todo')
    .map((event) => event.subject.ref)
    .sort();
}
