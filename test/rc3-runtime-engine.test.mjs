import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adjudicatePendingReceipts,
  buildExecutorPackets,
  buildNextRunEvent,
  classifyCheckpointObservation,
  closeRunIfComplete,
  dispatchReadyFrontier,
  initializeRunEvents,
  observeExecutor,
} from '../src/runtime-engine.mjs';
import { createScriptedExecutorAdapter } from './helpers/scripted-executor.mjs';
import {
  computeReadyFrontier,
  recomputeReceiptDecisions,
} from '../src/runtime-decision-verifier.mjs';
import { verifyRunEventChain } from '../src/runtime-event-store.mjs';
import { projectRuntimeState } from '../src/runtime-projection.mjs';
import { selfDigest } from '../src/runtime-contracts.mjs';

// RC3-E focused test（ADR 0044 Decision 4・7.4・9、plan RC3-E）。
// producer（engine）とverifierが独立実装のまま、保存bytesだけから
// 全dispatch decisionとreceipt裁定を一致再計算できることを固定する。

const SHA1 = 'b'.repeat(40);
const SHA256 = 'a'.repeat(64);
const RUN_ID = 'run-rc3e-01';
const AT = '2026-07-17T00:00:00.000Z';

function manualWitness(todoId) {
  return {
    owns: [{ kind: 'path', target: `src/${todoId.toLowerCase()}.mjs` }],
    reads: [],
    writes: [`src/${todoId.toLowerCase()}.mjs`],
    resources: [],
    state_effects: [],
    sensor_provenance: { queries: [] },
    affected_tests: [`test/${todoId.toLowerCase()}.test.mjs`],
    unknowns: [],
  };
}

function buildFixture({ todos, capacity, conflicts = [], precedence = [] }) {
  const request = {
    schema: 'lattice.run_request.v1',
    request_id: 'req-rc3e-01',
    repo: { base_sha: SHA1, root_kind: 'git-worktree' },
    capacity: { executors: capacity },
    todos: todos.map((todoId) => ({ todo_id: todoId })),
    manual_witness: Object.fromEntries(todos.map((todoId) => [todoId, manualWitness(todoId)])),
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
    plan_ref: 'plan-rc3e-v1',
    plan_epoch: 1,
    request_digest: request.request_digest,
    base_sha: SHA1,
    nodes: todos.map((todoId) => ({ todo_id: todoId })),
    precedence,
    conflicts,
    capacity: { executors: capacity },
    manifest_digests: Object.fromEntries(todos.map((todoId) => [todoId, manifests[todoId].manifest_digest])),
    claim: { mode: 'exact_minimum' },
    predecessor_refs: [],
  };
  plan.plan_digest = selfDigest(plan, 'plan_digest');
  return { request, plan, manifests };
}

function defaultScript(todos) {
  return Object.fromEntries(todos.map((todoId) => [todoId, [
    { kind: 'checkpoint', checkpoint: { checkpoint_digest: SHA256, observed_diff: [] } },
    { kind: 'terminal' },
  ]]));
}

/**
 * closed loopまでengineを回す決定論的driver。
 * 1周= dispatch → 全running observe → adjudicate → close試行。
 */
async function driveToCompletion({ fixture, adapter, maxRounds = 12 }) {
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  for (let round = 0; round < maxRounds; round += 1) {
    const dispatched = await dispatchReadyFrontier({
      runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT,
    });
    events = dispatched.events;
    // 1周につき各running executorを1回だけ観測する（最遅TODOの完走を待つ
    // barrierを作らないため。進捗はround間で交互に進む）。
    const state = projectRuntimeState({ events });
    for (const todoId of state.running) {
      const observed = await observeExecutor({
        runId: RUN_ID, plan, events, adapter, todoId, recordedAt: AT,
      });
      events = observed.events;
    }
    const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan, events, recordedAt: AT });
    events = adjudicated.events;
    const closed = closeRunIfComplete({ runId: RUN_ID, plan, events, recordedAt: AT });
    events = closed.events;
    if (closed.closed) return events;
  }
  return events;
}

/** dispatch_decided全prefixをverifierで再計算し、payloadとexact一致を要求する。 */
function assertDispatchReplay(plan, events) {
  events.forEach((event, index) => {
    if (event.kind !== 'dispatch_decided') return;
    const prefix = events.slice(0, index);
    const recomputed = computeReadyFrontier({ plan, events: prefix });
    assert.deepEqual(
      event.payload.dispatchable,
      recomputed.dispatchable,
      `sequence ${event.sequence}のdispatch decisionがverifier再計算と一致しない`,
    );
  });
}

test('runtime packetは操作権限をhostへ委ね、禁止操作を配らない', () => {
  const { plan, manifests } = buildFixture({ todos: ['TA'], capacity: 1 });
  const packets = buildExecutorPackets({ plan, manifests });
  assert.deepEqual(packets.TA.forbidden_operations, []);
});

test('terminalの独立checkpointはreceipt記録より先に置かれ、受理境界になる', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  const packet = packets.TA;
  const receipt = {
    schema: 'lattice.executor_receipt.v1', receipt_id: 'TA-terminal',
    executor_handle: 'exec-TA', worktree_id: 'wt-TA', base_sha: packet.base_sha,
    plan_epoch: packet.plan_epoch, packet_digest: packet.packet_digest, todo_id: 'TA',
    checkpoint_digest: SHA256, observed_diff: [], receipt_digest: '',
  };
  receipt.receipt_digest = selfDigest(receipt, 'receipt_digest');
  const adapter = {
    dispatch: async () => ({ executor_handle: 'exec-TA', worktree_id: 'wt-TA' }),
    observe: async () => ({ state: 'terminal', receipt,
      checkpoint: { checkpoint_digest: SHA256, diff: { entries: [] },
        observed_by: 'supervisor_terminal' } }),
  };
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  events = (await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets,
    manifests, adapter, recordedAt: AT })).events;
  events = (await observeExecutor({ runId: RUN_ID, plan, events, adapter,
    todoId: 'TA', recordedAt: AT })).events;
  const checkpoint = events.findIndex((event) => event.kind === 'checkpoint_observed');
  const recorded = events.findIndex((event) => event.kind === 'receipt_recorded');
  assert.ok(checkpoint >= 0 && checkpoint < recorded);
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan, events, recordedAt: AT });
  assert.deepEqual(adjudicated.decisions, [{ receipt_id: 'TA-terminal', decision: 'accepted' }]);
});

test('非交差3 TODO・capacity 2はwave barrierなしで完走しverifier再計算と一致する', async () => {
  const fixture = buildFixture({ todos: ['TA', 'TB', 'TC'], capacity: 2 });
  const adapter = createScriptedExecutorAdapter({
    script: {
      // TAは長走（checkpoint 2回）、TB/TCは短走。TB完了後、TA稼働中のままTCが
      // dispatchされること（＝最遅TODOを待つbarrierがないこと）を検査する。
      TA: [
        { kind: 'checkpoint', checkpoint: { checkpoint_digest: SHA256, observed_diff: [] } },
        { kind: 'checkpoint', checkpoint: { checkpoint_digest: SHA256, observed_diff: [] } },
        { kind: 'checkpoint', checkpoint: { checkpoint_digest: SHA256, observed_diff: [] } },
        { kind: 'terminal' },
      ],
      TB: [{ kind: 'terminal' }],
      TC: [{ kind: 'terminal' }],
    },
  });
  const events = await driveToCompletion({ fixture, adapter });

  const chain = verifyRunEventChain({ events });
  assert.equal(chain.valid, true, JSON.stringify(chain.failed_conditions));
  const state = projectRuntimeState({ events });
  assert.equal(state.closed, true);
  assert.deepEqual(state.accepted, ['TA', 'TB', 'TC']);
  assertDispatchReplay(fixture.plan, events);

  // barrier不在の直接証拠: TCのdispatch時点でTAがまだrunning（terminal未到達）。
  const tcDispatch = events.find((event) => (
    event.kind === 'executor_dispatched' && event.subject.ref === 'TC'
  ));
  const taTerminal = events.find((event) => (
    event.kind === 'executor_terminal' && event.subject.ref === 'TA'
  ));
  assert.ok(tcDispatch.sequence < taTerminal.sequence);

  // 受理裁定もverifierと一致する。
  const decisions = recomputeReceiptDecisions({ plan: fixture.plan, events });
  assert.deepEqual(
    decisions.decisions.map(({ todo_id: todoId, decision }) => [todoId, decision]).sort(),
    [['TA', 'accepted'], ['TB', 'accepted'], ['TC', 'accepted']],
  );
});

test('conflict pairは同時にrunningへ入らずserial化される', async () => {
  const fixture = buildFixture({
    todos: ['TA', 'TB', 'TC'],
    capacity: 3,
    conflicts: [{ todo_ids: ['TB', 'TC'], resource_id: 'shared-state' }],
  });
  const adapter = createScriptedExecutorAdapter({ script: defaultScript(['TA', 'TB', 'TC']) });
  const events = await driveToCompletion({ fixture, adapter });

  const state = projectRuntimeState({ events });
  assert.equal(state.closed, true);
  assertDispatchReplay(fixture.plan, events);
  const tbDispatch = events.find((e) => e.kind === 'executor_dispatched' && e.subject.ref === 'TB');
  const tbAccepted = events.find((e) => e.kind === 'receipt_accepted' && e.subject.ref === 'TB');
  const tcDispatch = events.find((e) => e.kind === 'executor_dispatched' && e.subject.ref === 'TC');
  assert.ok(tbDispatch.sequence < tcDispatch.sequence);
  assert.ok(tbAccepted.sequence < tcDispatch.sequence, 'TCはTB受理前にdispatchされてはならない');
});

test('単独の予測超過はcheckpointに残すがconflictやfreezeにしない', () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const packets = buildExecutorPackets({ plan: fixture.plan, manifests: fixture.manifests });
  let events = initializeRunEvents({
    runId: RUN_ID, request: fixture.request, plan: fixture.plan,
    manifests: fixture.manifests, recordedAt: AT,
  });
  const dispatch = buildNextRunEvent({
    events, runId: RUN_ID, kind: 'executor_dispatched', planEpoch: 1,
    subject: { kind: 'todo', ref: 'TA' },
    payload: {
      executor_handle: 'exec-ta', worktree_id: 'worktree-ta',
      packet_digest: packets.TA.packet_digest,
    }, recordedAt: AT,
  });
  events = [...events, dispatch];
  const checkpoint = {
    checkpoint_digest: SHA256,
    observed_diff: [{ path: 'src/unpredicted.mjs', operation: 'write' }],
  };
  events = [...events, buildNextRunEvent({
    events, runId: RUN_ID, kind: 'checkpoint_observed', planEpoch: 1,
    subject: { kind: 'todo', ref: 'TA' }, payload: checkpoint, recordedAt: AT,
  })];
  const result = classifyCheckpointObservation({
    runId: RUN_ID, plan: fixture.plan, events, packets, manifests: fixture.manifests,
    todoId: 'TA', recordedAt: AT,
    detect: () => ({ findings: [{ kind: 'undeclared_write', todo_ids: ['TA'], path: 'src/unpredicted.mjs' }] }),
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.observations[0].kind, 'prediction_excess');
  assert.deepEqual(result.scope_expanded, [{
    task_id: 'TA',
    compared_witness_digest: null,
    first_seen_path_count: 1,
    path_count: 2,
    added_paths: ['src/unpredicted.mjs'],
    removed_paths: [],
    growth_events: 1,
    gate_shape: false,
  }]);
  assert.equal(result.events.some(({ kind }) => kind === 'conflict_found'), false);
  assert.equal(result.events.some(({ kind }) => kind === 'intake_frozen'), false);
});

test('hard precedenceはaccepted前のdispatchを塞ぐ', async () => {
  const fixture = buildFixture({
    todos: ['TA', 'TB'],
    capacity: 2,
    precedence: [{ from_todo_id: 'TA', to_todo_id: 'TB' }],
  });
  const adapter = createScriptedExecutorAdapter({ script: defaultScript(['TA', 'TB']) });
  const events = await driveToCompletion({ fixture, adapter });
  const state = projectRuntimeState({ events });
  assert.equal(state.closed, true);
  assertDispatchReplay(fixture.plan, events);
  const taAccepted = events.find((e) => e.kind === 'receipt_accepted' && e.subject.ref === 'TA');
  const tbDispatch = events.find((e) => e.kind === 'executor_dispatched' && e.subject.ref === 'TB');
  assert.ok(taAccepted.sequence < tbDispatch.sequence);
});

test('timeoutはunknownとして同一handleで回収され、重複dispatchが拒否される', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const adapter = createScriptedExecutorAdapter({
    script: { TA: [{ kind: 'stall' }, { kind: 'terminal' }] },
  });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const first = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = first.events;
  assert.deepEqual(first.dispatched, ['TA']);

  // timeout（unknown）: eventは増えず、handleは残る。
  const before = events.length;
  const stalled = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA', recordedAt: AT });
  events = stalled.events;
  assert.equal(stalled.observation.state, 'unknown');
  assert.equal(events.length, before);

  // 稼働中の再dispatchはfrontierから除外される（重複起動なし）。
  const second = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = second.events;
  assert.deepEqual(second.dispatched, []);

  // 同一handleの再観測で回収される。
  const recovered = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA', recordedAt: AT });
  events = recovered.events;
  assert.equal(recovered.observation.state, 'terminal');
  const dispatchCount = events.filter((e) => e.kind === 'executor_dispatched').length;
  assert.equal(dispatchCount, 1);

  // adapter直接の重複dispatchもtyped rejectされる。
  await assert.rejects(adapter.dispatch({ packet: packets.TA }), TypeError);
});

test('帰属破壊receiptとstale epoch receiptはengine・verifier双方でrejectされる', async () => {
  for (const [label, overrides, expectedDetail] of [
    ['worktree改竄', { worktree_id: 'wt-forged' }, 'binding_mismatch'],
    ['stale epoch', { plan_epoch: 99 }, 'epoch_mismatch'],
    ['base差替え', { base_sha: 'd'.repeat(40) }, 'base_mismatch'],
  ]) {
    const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
    const adapter = createScriptedExecutorAdapter({
      script: { TA: [{ kind: 'terminal', receipt_overrides: overrides }] },
    });
    const { request, plan, manifests } = fixture;
    const packets = buildExecutorPackets({ plan, manifests });
    let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
    const dispatched = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
    events = dispatched.events;
    const observed = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA', recordedAt: AT });
    events = observed.events;
    const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan, events, recordedAt: AT });
    events = adjudicated.events;

    assert.equal(adjudicated.decisions.length, 1, label);
    assert.equal(adjudicated.decisions[0].decision, 'rejected', label);
    assert.equal(adjudicated.decisions[0].detail, expectedDetail, label);
    const rejectedEvent = events.find((e) => e.kind === 'receipt_rejected');
    assert.equal(rejectedEvent.payload.reason, 'stale_context', label);

    const recomputed = recomputeReceiptDecisions({ plan, events });
    assert.equal(recomputed.decisions[0].decision, 'rejected', label);
    assert.equal(recomputed.decisions[0].reason, 'stale_context', label);

    // accepted output 0（成功条件15/16系）: run_closedは発行されない。
    const closed = closeRunIfComplete({ runId: RUN_ID, plan, events, recordedAt: AT });
    assert.equal(closed.closed, false, label);
  }
});

test('terminal・rejected後のTODOはengine/verifier双方でfrontierへ戻らない', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const adapter = createScriptedExecutorAdapter({
    script: { TA: [{ kind: 'terminal', receipt_overrides: { plan_epoch: 99 } }] },
  });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const first = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = first.events;
  const observed = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA', recordedAt: AT });
  events = observed.events;
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan, events, recordedAt: AT });
  events = adjudicated.events;
  assert.equal(adjudicated.decisions[0].decision, 'rejected');

  // 再dispatch裁定: engineは[]を選び、verifier再計算も[]（redispatchはRC3-G所有）。
  const again = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = again.events;
  assert.deepEqual(again.dispatched, []);
  assertDispatchReplay(plan, events);

  // terminal報告済みTODOの再観測はfail closed。
  await assert.rejects(observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA', recordedAt: AT }), TypeError);
});

test('freeze後のreceiptはengine/verifier双方がpost_freezeでrejectする', async () => {
  const fixture = buildFixture({ todos: ['TA', 'TB'], capacity: 2 });
  const adapter = createScriptedExecutorAdapter({
    script: {
      TA: [
        { kind: 'hold_request', finding: { kind: 'semantic_conflict_unknown', todo_ids: ['TA'] } },
        { kind: 'terminal' },
      ],
      TB: [{ kind: 'terminal' }],
    },
  });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const dispatched = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = dispatched.events;
  assert.deepEqual(dispatched.dispatched, ['TA', 'TB']);

  // TAのhold request → conflict_found＋intake_frozen。
  const held = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA', recordedAt: AT });
  events = held.events;
  assert.equal(events.filter((e) => e.kind === 'intake_frozen').length, 1);

  // freeze中のdispatchはengine/verifier双方で0件。
  const frozenDispatch = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = frozenDispatch.events;
  assert.deepEqual(frozenDispatch.dispatched, []);
  assertDispatchReplay(plan, events);

  // freeze後に届いたTBのterminal receiptは、engineもverifierもpost_freezeでreject。
  const tbObserved = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TB', recordedAt: AT });
  events = tbObserved.events;
  // 独立検証の比較単位: engineが裁定する前のprefixに対して、verifierが同じ結論を
  // 返すこと（裁定後のprefixではrecorded_rejectionが正しい報告になる）。
  const recomputed = recomputeReceiptDecisions({ plan, events });
  const tbDecision = recomputed.decisions.find((d) => d.todo_id === 'TB');
  assert.equal(tbDecision.decision, 'rejected');
  assert.equal(tbDecision.detail, 'post_freeze');
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan, events, recordedAt: AT });
  events = adjudicated.events;
  assert.equal(adjudicated.decisions.length, 1);
  assert.equal(adjudicated.decisions[0].decision, 'rejected');
  assert.equal(adjudicated.decisions[0].detail, 'post_freeze');
});

test('active plan外の自己整合packetはdispatchでrejectされる', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const adapter = createScriptedExecutorAdapter({ script: defaultScript(['TA']) });
  const { request, plan, manifests } = fixture;
  // 正規packetのplan_refだけ差し替えて自己再digestした偽packet（自己整合は保つ）。
  const packets = buildExecutorPackets({ plan, manifests });
  const forged = { ...packets.TA, plan_ref: 'plan-foreign-v1' };
  delete forged.packet_digest;
  forged.packet_digest = selfDigest(forged, 'packet_digest');
  const events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  await assert.rejects(dispatchReadyFrontier({
    runId: RUN_ID, plan, events, packets: { TA: forged }, manifests, adapter, recordedAt: AT,
  }), /active planへ帰属しない/u);
});

test('adapter失敗時は成功済みdispatchの証拠を保持したtyped failureを返す', async () => {
  const fixture = buildFixture({ todos: ['TA', 'TB'], capacity: 2 });
  const inner = createScriptedExecutorAdapter({ script: defaultScript(['TA', 'TB']) });
  const flaky = {
    kind: 'scripted',
    async dispatch({ packet }) {
      if (packet.todo_id === 'TB') throw new TypeError('provider outage');
      return inner.dispatch({ packet });
    },
    observe: (args) => inner.observe(args),
  };
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  const events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const result = await dispatchReadyFrontier({
    runId: RUN_ID, plan, events, packets, manifests, adapter: flaky, recordedAt: AT,
  });
  assert.deepEqual(result.dispatched, ['TA']);
  assert.equal(result.failure.todo_id, 'TB');
  const taDispatch = result.events.find((e) => e.kind === 'executor_dispatched' && e.subject.ref === 'TA');
  assert.ok(taDispatch, '成功済みdispatchのeventは失われない');
  // 再dispatchしてもTAは重複起動されない（frontierから除外済み）。
  const retry = await dispatchReadyFrontier({
    runId: RUN_ID, plan, events: result.events, packets, manifests, adapter: flaky, recordedAt: AT,
  });
  assert.deepEqual(retry.dispatched, []);
  assert.equal(retry.failure.todo_id, 'TB');
});

test('genesis規則違反と別run prefixへの追記はfail closedする', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const adapter = createScriptedExecutorAdapter({ script: defaultScript(['TA']) });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  // 空prefixへのdispatch（genesisがrun_initializedでない）はreject。
  await assert.rejects(dispatchReadyFrontier({
    runId: RUN_ID, plan, events: [], packets, manifests, adapter, recordedAt: AT,
  }), /genesis/u);
  // 別runのprefixへの追記はreject。
  const eventsA = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  await assert.rejects(dispatchReadyFrontier({
    runId: 'run-other', plan, events: eventsA, packets, manifests, adapter, recordedAt: AT,
  }), /別run/u);
});

test('executorのhold requestはconflict_found eventとして証拠化される', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const adapter = createScriptedExecutorAdapter({
    script: {
      TA: [
        {
          kind: 'hold_request',
          finding: { kind: 'semantic_conflict_unknown', todo_ids: ['TA'], detail: 'shared invariant疑い' },
        },
        { kind: 'terminal' },
      ],
    },
  });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const dispatched = await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests, adapter, recordedAt: AT });
  events = dispatched.events;
  const observed = await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA', recordedAt: AT });
  events = observed.events;
  assert.equal(observed.observation.state, 'hold_requested');
  const conflictEvent = events.find((e) => e.kind === 'conflict_found');
  assert.equal(conflictEvent.subject.ref, 'TA');
  assert.equal(conflictEvent.payload.kind, 'semantic_conflict_unknown');
  assert.equal(conflictEvent.payload.reported_by, 'scripted-TA-h1');
  const state = projectRuntimeState({ events });
  assert.equal(state.conflicts.length, 1);
  assert.deepEqual(state.running, ['TA']);
});

test('engineはevent配列を破壊せずchain規則を保つ', async () => {
  const fixture = buildFixture({ todos: ['TA', 'TB'], capacity: 2 });
  const adapter = createScriptedExecutorAdapter({ script: defaultScript(['TA', 'TB']) });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  const genesis = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  const genesisLength = genesis.length;
  const dispatched = await dispatchReadyFrontier({ runId: RUN_ID, plan, events: genesis, packets, manifests, adapter, recordedAt: AT });
  assert.equal(genesis.length, genesisLength, '入力event配列は変更されない');
  const chain = verifyRunEventChain({ events: dispatched.events });
  assert.equal(chain.valid, true, JSON.stringify(chain.failed_conditions));
});

test('packet contractを満たさないdispatchとplan外scriptはTypeErrorでfail closedする', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const adapter = createScriptedExecutorAdapter({ script: defaultScript(['TA']) });
  await assert.rejects(adapter.dispatch({ packet: { schema: 'bogus' } }), TypeError);
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  const events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  await assert.rejects(dispatchReadyFrontier({
    runId: RUN_ID, plan, events, packets: { TA: { schema: 'bogus' } }, manifests, adapter, recordedAt: AT,
  }), TypeError);
});

// ADR 0143。I/O警報のprobeは走行中の任意の一点を撮る。executorの申告境界ではないので、
// receiptのbinding基準に混ぜてはならない——混ぜると、probe後も書き続けた正当なreceiptが
// checkpoint_mismatchで落ちる。証拠としては残し、findingの導出には使う。
test('supervisorのprobe checkpointは、receiptのbinding基準にしない', async () => {
  const fixture = buildFixture({ todos: ['TA'], capacity: 1 });
  const executorCheckpoint = { checkpoint_digest: '1'.repeat(64),
    diff: { entries: [{ path: 'src/ta.mjs', change: 'modified' }] } };
  const adapter = createScriptedExecutorAdapter({
    script: { TA: [{ kind: 'checkpoint', checkpoint: executorCheckpoint }, { kind: 'terminal' }] },
  });
  const { request, plan, manifests } = fixture;
  const packets = buildExecutorPackets({ plan, manifests });
  let events = initializeRunEvents({ runId: RUN_ID, request, plan, manifests, recordedAt: AT });
  events = (await dispatchReadyFrontier({ runId: RUN_ID, plan, events, packets, manifests,
    adapter, recordedAt: AT })).events;
  // executorが申告したcheckpoint。receiptはこれへ縛られる。
  events = (await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA',
    recordedAt: AT })).events;

  // その後、supervisorが警報を確かめるために走行中の一点を撮る。
  const probed = { checkpoint_digest: '2'.repeat(64), observed_by: 'supervisor_probe',
    diff: { entries: [{ path: 'src/ta.mjs', change: 'modified' },
      { path: 'src/other.mjs', change: 'added' }] } };
  events = [...events, buildNextRunEvent({ events, runId: RUN_ID, kind: 'checkpoint_observed',
    planEpoch: plan.plan_epoch, subject: { kind: 'todo', ref: 'TA' }, payload: probed,
    recordedAt: AT })];

  events = (await observeExecutor({ runId: RUN_ID, plan, events, adapter, todoId: 'TA',
    recordedAt: AT })).events;
  const adjudicated = adjudicatePendingReceipts({ runId: RUN_ID, plan, events, recordedAt: AT });
  assert.deepEqual(adjudicated.decisions.map(({ decision }) => decision), ['accepted']);
  // producerとverifierは独立実装だが、同じ規則でなければどちらが正しいか分からなくなる。
  assert.deepEqual(recomputeReceiptDecisions({ plan, events: adjudicated.events })
    .decisions.map(({ decision }) => decision), ['accepted']);

  // probeを印無しで積むと、正当なreceiptがcheckpoint_mismatchで落ちる——それが
  // 印を残す理由である。証拠そのものはeventへ残っている。
  const unmarked = events.map((event) => (event.payload?.observed_by === 'supervisor_probe'
    ? { ...event, payload: { ...event.payload, observed_by: undefined } } : event));
  const poisoned = adjudicatePendingReceipts({ runId: RUN_ID, plan, events: unmarked,
    recordedAt: AT });
  assert.equal(poisoned.decisions[0].detail, 'checkpoint_mismatch');
});
