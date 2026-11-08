import assert from 'node:assert/strict';
import test from 'node:test';

import { digestArtifact } from '../src/artifact-contracts.mjs';

// RC3-B characterization（ADR 0044 Decision 4〜7）。RC3-Bではexpected-redとして
// 固定し、RC3-Cの実装でgreenへ変わった。RC3-Cの異provider reviewで採用した
// receipt帰属照合（Decision 7.4）とwitness実証（Decision 7.2）に合わせ、event
// fixtureへdispatch binding／witness documentを加算した（semantic assertionは
// RC3-B固定時から不変）。本fileはproducer非依存に再計算されるruntime意味論
// （ready frontier、conflict分類、hold／continue、receipt受理、carry-over witness）
// だけを固定する。schema envelope／digestの完全検証はruntime-contracts.mjsが担う。
const DECISION_VERIFIER_MODULE = '../src/runtime-decision-verifier.mjs';
const EVENT_STORE_MODULE = '../src/runtime-event-store.mjs';

const RUN_ID = 'run-rc3b-characterization';

function placeholderDigest(character) {
  return character.repeat(64);
}

function runtimePlan({
  nodes = ['T1', 'T2', 'T3'],
  precedence = [],
  conflicts = [],
  capacity = { executors: 2 },
  planEpoch = 1,
} = {}) {
  return {
    schema: 'lattice.runtime_plan.v1',
    plan_ref: `rc3b-plan-v${planEpoch}`,
    plan_epoch: planEpoch,
    request_digest: placeholderDigest('1'),
    base_sha: 'b'.repeat(40),
    nodes: nodes.map((todoId) => ({ todo_id: todoId })),
    precedence,
    conflicts,
    capacity,
    manifest_digests: Object.fromEntries(nodes.map((todoId) => [todoId, placeholderDigest('2')])),
    claim: { mode: 'exact_minimum' },
    predecessor_refs: [],
    plan_digest: placeholderDigest('3'),
  };
}

function boundaryManifest({ todoId, writes = [], reads = [], resources = [] }) {
  return {
    schema: 'lattice.boundary_manifest.v2',
    todo_id: todoId,
    owns: writes.map((path) => ({ kind: 'path', target: path })),
    reads,
    writes,
    resources,
    state_effects: resources.map((resourceId) => ({
      resource_id: resourceId,
      kind: 'state',
    })),
    unknowns: [],
    affected_tests: [],
    graph_evidence: [],
    witness_provenance: 'manual_state_effect',
    manifest_digest: placeholderDigest('2'),
  };
}

/**
 * digestRunEvent（自己digest規則）でsequence／previous_digest／event_digestを
 * 連結した正規のevent chainを組み立てる。
 */
async function chain(specs) {
  const { digestRunEvent } = await import(EVENT_STORE_MODULE);
  const events = [];
  let previousDigest = null;
  for (const [index, spec] of specs.entries()) {
    const event = {
      schema: 'lattice.run_event.v1',
      run_id: RUN_ID,
      sequence: index,
      previous_digest: previousDigest,
      kind: spec.kind,
      actor: spec.actor ?? 'lattice-runtime',
      plan_epoch: spec.plan_epoch ?? 1,
      subject: spec.subject ?? { kind: 'run', ref: RUN_ID },
      payload: spec.payload ?? {},
      recorded_at: '2026-07-17T00:00:00.000Z',
    };
    event.event_digest = digestRunEvent(event);
    events.push(event);
    previousDigest = event.event_digest;
  }
  return events;
}

function todoSubject(todoId) {
  return { kind: 'todo', ref: todoId };
}

const BASE_SHA = 'b'.repeat(40);

function executorBinding(todoId) {
  return {
    executor_handle: `scripted-exec-${todoId}`,
    worktree_id: `wt-${todoId}`,
    packet_digest: digestArtifact({ packet_for: todoId }),
  };
}

function dispatchedSpec(todoId) {
  return {
    kind: 'executor_dispatched',
    subject: todoSubject(todoId),
    payload: executorBinding(todoId),
  };
}

function receiptSpec(todoId, receiptId, { planEpoch = 1 } = {}) {
  return {
    kind: 'receipt_recorded',
    subject: todoSubject(todoId),
    plan_epoch: planEpoch,
    payload: {
      receipt_id: receiptId,
      ...executorBinding(todoId),
      base_sha: BASE_SHA,
      checkpoint_digest: placeholderDigest('c'),
    },
  };
}

function carryOverWitnessDoc(todoId, receiptBindings = []) {
  const witness = {
    schema: 'lattice.carry_over_witness.v1',
    witness_id: `rc3b-witness-${todoId}`,
    todo_id: todoId,
    predecessor_epoch: 1,
    successor_epoch: 2,
    invariant_digests: {
      todo_input: placeholderDigest('1'),
      boundary_manifest: placeholderDigest('2'),
      validator: placeholderDigest('3'),
      context_content: placeholderDigest('4'),
    },
    non_overlap_evidence: ['hold-decision-rc3b'],
    receipt_bindings: receiptBindings,
  };
  witness.witness_digest = digestArtifact(witness);
  return witness;
}

function witnessSpec(todoId, receiptBindings = []) {
  const witness = carryOverWitnessDoc(todoId, receiptBindings);
  return {
    kind: 'carry_over_witnessed',
    subject: todoSubject(todoId),
    payload: { witness_digest: witness.witness_digest, witness },
  };
}

const RUN_PREAMBLE = Object.freeze([
  { kind: 'run_initialized' },
  { kind: 'plan_compiled' },
  { kind: 'plan_verified' },
]);

test('ready frontierはwave completionを待たずhard predecessor充足nodeをunlockする', async () => {
  const { computeReadyFrontier } = await import(DECISION_VERIFIER_MODULE);
  // ADR 0044 Decision 4 expected example: precedence T1→T3のみ、conflictなし、
  // capacity 2、minimum waves 2。T1 acceptedの時点でT2がrunningでも、T3は
  // dispatch可能でなければならない。T2完了を待つwave barrier実装はここでredになる。
  const plan = runtimePlan({ precedence: [{ from_todo_id: 'T1', to_todo_id: 'T3' }] });
  const events = await chain([
    ...RUN_PREAMBLE,
    { kind: 'dispatch_decided', payload: { dispatched: ['T1', 'T2'] } },
    dispatchedSpec('T1'),
    dispatchedSpec('T2'),
    receiptSpec('T1', 'T1-r1'),
    { kind: 'receipt_accepted', subject: todoSubject('T1') },
  ]);

  const frontier = computeReadyFrontier({ plan, events });
  assert.deepEqual(frontier.dispatchable, ['T3']);
});

test('capacity飽和中のnodeはhard predecessor充足でもdispatch不可である', async () => {
  const { computeReadyFrontier } = await import(DECISION_VERIFIER_MODULE);
  // 同じtopologyでcapacity 1なら、T2がrunningの間はT3をdispatchできない。
  // barrierでなくcapacityだけが理由のblockであることをexpected setで固定する。
  const plan = runtimePlan({
    precedence: [{ from_todo_id: 'T1', to_todo_id: 'T3' }],
    capacity: { executors: 1 },
  });
  const events = await chain([
    ...RUN_PREAMBLE,
    { kind: 'dispatch_decided', payload: { dispatched: ['T1'] } },
    dispatchedSpec('T1'),
    receiptSpec('T1', 'T1-r1'),
    { kind: 'receipt_accepted', subject: todoSubject('T1') },
    { kind: 'dispatch_decided', payload: { dispatched: ['T2'] } },
    dispatchedSpec('T2'),
  ]);

  const frontier = computeReadyFrontier({ plan, events });
  assert.deepEqual(frontier.dispatchable, []);
});

test('宣言外writeと運転中overlapはundeclared writeとobserved write conflictの別findingになる', async () => {
  const { classifyObservedDiff } = await import(DECISION_VERIFIER_MODULE);
  // ADR 0044 Decision 5.3 expected example: T1がsrc/a.mjs（declared）と
  // src/c.mjs（undeclared）を変更し、src/c.mjsがT2のdeclared writeである場合、
  // undeclared_write（T1）とobserved_write_conflict（T1×T2）を別findingで保存し、
  // silent mergeしない。
  const plan = runtimePlan({ nodes: ['T1', 'T2'] });
  const manifests = {
    T1: boundaryManifest({ todoId: 'T1', writes: ['src/a.mjs'] }),
    T2: boundaryManifest({ todoId: 'T2', writes: ['src/c.mjs'] }),
  };
  const observations = [
    { todo_id: 'T1', paths: ['src/a.mjs', 'src/c.mjs'] },
    { todo_id: 'T2', paths: ['src/c.mjs'] },
  ];

  const { findings } = classifyObservedDiff({ plan, manifests, observations });
  assert.ok(findings.some((finding) => (
    finding.kind === 'undeclared_write'
    && finding.todo_ids.includes('T1')
    && finding.path === 'src/c.mjs'
  )), JSON.stringify(findings));
  assert.ok(findings.some((finding) => (
    finding.kind === 'observed_write_conflict'
    && [...finding.todo_ids].sort().join(',') === 'T1,T2'
    && finding.path === 'src/c.mjs'
  )), JSON.stringify(findings));
});

test('実writeは同時attemptの予測readとも競合し、非同時TODOへは広げない', async () => {
  const { classifyObservedDiff } = await import(DECISION_VERIFIER_MODULE);
  const plan = runtimePlan({ nodes: ['T1', 'T2', 'T3'] });
  const manifests = {
    T1: boundaryManifest({ todoId: 'T1', writes: ['src/shared.mjs'] }),
    T2: boundaryManifest({ todoId: 'T2', reads: ['src/shared.mjs'] }),
    T3: boundaryManifest({ todoId: 'T3', reads: ['src/shared.mjs'] }),
  };
  const { findings } = classifyObservedDiff({ plan, manifests,
    observations: [{ todo_id: 'T1', paths: ['src/shared.mjs'] }],
    relevantTodoIds: ['T1', 'T2'] });
  assert.ok(findings.some((finding) => finding.kind === 'observed_write_conflict'
    && finding.todo_ids.join(',') === 'T1,T2' && finding.path === 'src/shared.mjs'));
  assert.equal(findings.some((finding) => finding.todo_ids.includes('T3')), false);
});

test('予測境界が空でも同時attemptのactual同士が重なれば競合になる', async () => {
  const { classifyObservedDiff } = await import(DECISION_VERIFIER_MODULE);
  const plan = runtimePlan({ nodes: ['T1', 'T2'] });
  const manifests = {
    T1: boundaryManifest({ todoId: 'T1' }),
    T2: boundaryManifest({ todoId: 'T2' }),
  };
  const { findings } = classifyObservedDiff({ plan, manifests, observations: [
    { todo_id: 'T1', paths: ['src/new-shared.mjs'] },
    { todo_id: 'T2', paths: ['src/new-shared.mjs'] },
  ], relevantTodoIds: ['T1', 'T2'] });
  assert.ok(findings.some((finding) => finding.kind === 'observed_write_conflict'
    && finding.todo_ids.join(',') === 'T1,T2' && finding.path === 'src/new-shared.mjs'));
});

test('別pathでも同一state witnessへ到達するwriteはsemantic conflict unknownになる', async () => {
  const { classifyObservedDiff } = await import(DECISION_VERIFIER_MODULE);
  // ADR 0044 Decision 5: 観測不能なsemantic conflictを安全と推測しない。
  // path非交差でも共有resource witnessがあればunknown findingとして保存する。
  const plan = runtimePlan({ nodes: ['T1', 'T2'] });
  const manifests = {
    T1: boundaryManifest({
      todoId: 'T1',
      writes: ['src/a.mjs'],
      resources: ['delivery-policy-shared-state'],
    }),
    T2: boundaryManifest({
      todoId: 'T2',
      writes: ['src/b.mjs'],
      resources: ['delivery-policy-shared-state'],
    }),
  };
  const observations = [
    { todo_id: 'T1', paths: ['src/a.mjs'] },
    { todo_id: 'T2', paths: ['src/b.mjs'] },
  ];

  const { findings } = classifyObservedDiff({ plan, manifests, observations });
  assert.ok(findings.some((finding) => (
    finding.kind === 'semantic_conflict_unknown'
    && [...finding.todo_ids].sort().join(',') === 'T1,T2'
    && finding.resource_id === 'delivery-policy-shared-state'
  )), JSON.stringify(findings));
  assert.equal(findings.some((finding) => finding.kind === 'observed_write_conflict'), false);
});

function conflictScenarioSpecs(extraSpecs = []) {
  return [
    ...RUN_PREAMBLE,
    { kind: 'dispatch_decided', payload: { dispatched: ['T1', 'T2', 'T3'] } },
    dispatchedSpec('T1'),
    dispatchedSpec('T2'),
    dispatchedSpec('T3'),
    { kind: 'checkpoint_observed', subject: todoSubject('T3'), payload: { checkpoint_digest: placeholderDigest('c') } },
    {
      kind: 'conflict_found',
      payload: {
        finding_kind: 'observed_write_conflict',
        todo_ids: ['T1', 'T2'],
        path: 'src/c.mjs',
      },
    },
    { kind: 'intake_frozen', payload: { frozen_prefix_digest: placeholderDigest('d') } },
    ...extraSpecs,
  ];
}

test('u03 C43: carry-over witnessを欠く無関係TODOもholdへ足さず継続する', async () => {
  const { recomputeHoldDecision } = await import(DECISION_VERIFIER_MODULE);
  // 請求項10: 止めるのは影響群だけ。witnessは証明できた時の記録であり、継続の条件ではない。
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const events = await chain(conflictScenarioSpecs());

  const decision = recomputeHoldDecision({ plan, events });
  assert.deepEqual([...decision.hold_set].sort(), ['T1', 'T2']);
  assert.deepEqual(decision.continue_set, ['T3']);
});

test('carry-over witnessが保存された無関係TODOだけがcontinueできる', async () => {
  const { recomputeHoldDecision } = await import(DECISION_VERIFIER_MODULE);
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const events = await chain(conflictScenarioSpecs([witnessSpec('T3')]));

  const decision = recomputeHoldDecision({ plan, events });
  assert.deepEqual([...decision.hold_set].sort(), ['T1', 'T2']);
  assert.deepEqual(decision.continue_set, ['T3']);
});

test('freeze後の旧epoch receiptはwitness bindingの有無によらずstale contextでrejectされる', async () => {
  const { recomputeReceiptDecisions } = await import(DECISION_VERIFIER_MODULE);
  // ADR 0044 Decision 7.4／7.5 post-freeze-stale-receipt: 「rebind前」はevent
  // sequenceで判定し、frozen prefix外のvN epoch receiptは到着順・生成主張に
  // よらずtyped rejectする。accepted outputへ数えない。
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const events = await chain(conflictScenarioSpecs([
    witnessSpec('T3'),
    receiptSpec('T3', 'T3-r2'),
  ]));

  const { decisions } = recomputeReceiptDecisions({ plan, events });
  const stale = decisions.find((decision) => decision.receipt_id === 'T3-r2');
  assert.equal(stale.decision, 'rejected');
  assert.equal(stale.reason, 'stale_context');
  assert.equal(decisions.filter((decision) => decision.decision === 'accepted').length, 0);
});

test('frozen prefix内の旧epoch receiptはwitness bindingがある場合だけ受理される', async () => {
  const { recomputeReceiptDecisions } = await import(DECISION_VERIFIER_MODULE);
  // ADR 0044 Decision 7.5 carry-over-accept: freeze前にrecordされたvN receiptは、
  // carry-over witnessのreceipt_bindingsが当該receiptをbindする場合だけ有効になる。
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const boundSpecs = [
    ...RUN_PREAMBLE,
    { kind: 'dispatch_decided', payload: { dispatched: ['T1', 'T2', 'T3'] } },
    dispatchedSpec('T1'),
    dispatchedSpec('T2'),
    dispatchedSpec('T3'),
    receiptSpec('T3', 'T3-r1'),
    {
      kind: 'conflict_found',
      payload: {
        finding_kind: 'observed_write_conflict',
        todo_ids: ['T1', 'T2'],
        path: 'src/c.mjs',
      },
    },
    { kind: 'intake_frozen', payload: { frozen_prefix_digest: placeholderDigest('d') } },
  ];
  const boundReceiptSequence = 7;

  const withBinding = await chain([
    ...boundSpecs,
    witnessSpec('T3', [{
      receipt_id: 'T3-r1',
      checkpoint_digest: placeholderDigest('c'),
      recorded_sequence: boundReceiptSequence,
      within_frozen_prefix: true,
    }]),
  ]);
  const bound = recomputeReceiptDecisions({ plan, events: withBinding });
  const acceptedReceipt = bound.decisions.find((decision) => decision.receipt_id === 'T3-r1');
  assert.equal(acceptedReceipt.decision, 'accepted');

  const withoutBinding = await chain([
    ...boundSpecs,
    witnessSpec('T3', []),
  ]);
  const unbound = recomputeReceiptDecisions({ plan, events: withoutBinding });
  const rejectedReceipt = unbound.decisions.find((decision) => decision.receipt_id === 'T3-r1');
  assert.equal(rejectedReceipt.decision, 'rejected');
  assert.equal(rejectedReceipt.reason, 'stale_context');
});

test('carry-over witnessは1 fieldのdigest破壊でも継続不可としてrejectされる', async () => {
  const { verifyCarryOverWitness } = await import(DECISION_VERIFIER_MODULE);
  const { digestArtifact } = await import('../src/artifact-contracts.mjs');
  // ADR 0044 Decision 7.5 witness-single-field-corruption: invariant digestの
  // どれか一つでも保存bytesの再計算と一致しなければcarry-over不成立とし、
  // 理由kind carry_over_unprovableでholdへ戻す。
  const sources = {
    todo_input: { todo_id: 'T3', request: 'rc3b-request' },
    boundary_manifest: boundaryManifest({ todoId: 'T3', writes: ['src/t3.mjs'] }),
    validator: { id: 'rc3b-validator', command: 'node', args: ['--test'] },
    context_content: {
      todo_id: 'T3',
      task_ref: 'rc3b-task-T3',
      scope: { writes: ['src/t3.mjs'] },
      base_sha: 'b'.repeat(40),
      verifier_refs: ['rc3b-validator'],
      forbidden_operations: ['commit', 'push'],
    },
  };
  const witness = {
    schema: 'lattice.carry_over_witness.v1',
    witness_id: 'rc3b-witness-T3',
    todo_id: 'T3',
    predecessor_epoch: 1,
    successor_epoch: 2,
    invariant_digests: {
      todo_input: digestArtifact(sources.todo_input),
      boundary_manifest: digestArtifact(sources.boundary_manifest),
      validator: digestArtifact(sources.validator),
      context_content: digestArtifact(sources.context_content),
    },
    non_overlap_evidence: ['hold-decision-rc3b'],
    receipt_bindings: [],
  };
  witness.witness_digest = digestArtifact(witness);

  const intact = verifyCarryOverWitness({ witness, sources });
  assert.equal(intact.valid, true, JSON.stringify(intact.reasons));

  const corrupted = structuredClone(witness);
  corrupted.invariant_digests.validator = placeholderDigest('f');
  const result = verifyCarryOverWitness({ witness: corrupted, sources });
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('carry_over_unprovable'), JSON.stringify(result.reasons));
});

// ここから下は、RC3-C実装の異provider review（codex-sidecar `review`、
// gpt-5.6-sol×high）で採用したfindingを固定する敵対ケース。

test('binding fieldを欠くreceiptはfreezeがなくてもtyped rejectされる', async () => {
  const { recomputeReceiptDecisions } = await import(DECISION_VERIFIER_MODULE);
  // ADR 0044 Decision 7.4: receiptはhandle・worktree・base・packet・checkpointの
  // bindingを必須とし、欠落をtyped rejectする。
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const events = await chain([
    ...RUN_PREAMBLE,
    { kind: 'dispatch_decided', payload: { dispatched: ['T1'] } },
    dispatchedSpec('T1'),
    {
      kind: 'receipt_recorded',
      subject: todoSubject('T1'),
      plan_epoch: 1,
      payload: { receipt_id: 'T1-r1' },
    },
  ]);

  const { decisions } = recomputeReceiptDecisions({ plan, events });
  const decision = decisions.find((entry) => entry.receipt_id === 'T1-r1');
  assert.equal(decision.decision, 'rejected');
  assert.equal(decision.reason, 'stale_context');
});

test('intake resume後もfreeze後の旧epoch receiptはstaleのままである', async () => {
  const { recomputeReceiptDecisions } = await import(DECISION_VERIFIER_MODULE);
  // freezeはresumeで消えない永続境界であり、resume後の旧epoch receiptを
  // 受理へ反転させない（ADR 0044 Decision 7.4）。
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const events = await chain(conflictScenarioSpecs([
    witnessSpec('T3'),
    { kind: 'intake_resumed', payload: { queued_events: 0 } },
    receiptSpec('T3', 'T3-r2'),
  ]));

  const { decisions } = recomputeReceiptDecisions({ plan, events });
  const stale = decisions.find((entry) => entry.receipt_id === 'T3-r2');
  assert.equal(stale.decision, 'rejected');
  assert.equal(stale.reason, 'stale_context');
});

test('u03 C43: 破損したwitness documentでもclosure外TODOはholdへ足さない', async () => {
  const { recomputeHoldDecision } = await import(DECISION_VERIFIER_MODULE);
  // 破損witnessは不成立のまま（frozen prefix receiptはwitness_unproven）だが、holdは広げない。
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const corrupted = carryOverWitnessDoc('T3');
  corrupted.witness_digest = placeholderDigest('f');
  const events = await chain(conflictScenarioSpecs([
    {
      kind: 'carry_over_witnessed',
      subject: todoSubject('T3'),
      payload: { witness_digest: corrupted.witness_digest, witness: corrupted },
    },
  ]));

  const decision = recomputeHoldDecision({ plan, events });
  assert.deepEqual([...decision.hold_set].sort(), ['T1', 'T2']);
  assert.deepEqual(decision.continue_set, ['T3']);
  assert.equal(decision.reasons.T3, undefined);
});

test('conflict pairは同一ready frontierへ同時に載らない', async () => {
  const { computeReadyFrontier } = await import(DECISION_VERIFIER_MODULE);
  // 各nodeがrunning集合とだけ照合されると、capacityに空きがある場合に
  // conflict pairを同時dispatchしてしまう。frontier内部の非交差も要求する。
  const plan = runtimePlan({
    nodes: ['T1', 'T2'],
    conflicts: [{ todo_ids: ['T1', 'T2'], resource_id: 'shared-resource' }],
  });
  const events = await chain([...RUN_PREAMBLE]);

  const frontier = computeReadyFrontier({ plan, events });
  assert.deepEqual(frontier.dispatchable, ['T1']);
});

test('unknownを持つTODOのpairはpath非交差でもsemantic conflict unknownになる', async () => {
  const { classifyObservedDiff } = await import(DECISION_VERIFIER_MODULE);
  // dynamic unknownを「依存なし」へ丸めない（ADR 0044 Decision 1.5・5.1）。
  const plan = runtimePlan({ nodes: ['T1', 'T2'] });
  const manifests = {
    T1: {
      ...boundaryManifest({ todoId: 'T1', writes: ['src/a.mjs'] }),
      unknowns: [{ kind: 'dynamic-dispatch', ref: 'src/a.mjs#handler' }],
    },
    T2: boundaryManifest({ todoId: 'T2', writes: ['src/b.mjs'] }),
  };
  const observations = [
    { todo_id: 'T1', paths: ['src/a.mjs'] },
    { todo_id: 'T2', paths: ['src/b.mjs'] },
  ];

  const { findings } = classifyObservedDiff({ plan, manifests, observations });
  assert.ok(findings.some((finding) => (
    finding.kind === 'semantic_conflict_unknown'
    && [...finding.todo_ids].sort().join(',') === 'T1,T2'
    && finding.resource_id === null
  )), JSON.stringify(findings));
});

test('manifests付きaffected closureは同一resource witness到達TODOを含む', async () => {
  const { recomputeHoldDecision } = await import(DECISION_VERIFIER_MODULE);
  // ADR 0044 Decision 6.3の第三要素: finding起点と同一resource witnessへ到達する
  // TODOは、witnessがあってもcontinueできずclosureとしてholdされる。
  const plan = runtimePlan({ capacity: { executors: 3 } });
  const manifests = {
    T1: boundaryManifest({ todoId: 'T1', writes: ['src/a.mjs'], resources: ['policy-state'] }),
    T2: boundaryManifest({ todoId: 'T2', writes: ['src/c.mjs'] }),
    T3: boundaryManifest({ todoId: 'T3', writes: ['src/t3.mjs'], resources: ['policy-state'] }),
  };
  const events = await chain(conflictScenarioSpecs([witnessSpec('T3')]));

  const decision = recomputeHoldDecision({ plan, events, manifests });
  assert.deepEqual([...decision.hold_set].sort(), ['T1', 'T2', 'T3']);
  assert.deepEqual(decision.continue_set, []);
  assert.equal(decision.reasons.T3, 'affected_closure');
});
