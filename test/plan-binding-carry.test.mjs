import assert from 'node:assert/strict';
import test from 'node:test';

import { carriedDependencyPayload, validateBindingCarry } from '../src/plan-binding-carry.mjs';

const OLD = 'b'.repeat(64);
const NEW = 'a'.repeat(64);
const OWNER_TOPOLOGY = 'f'.repeat(64);
const ref = (plan_key, task_id, expected_topology_digest) => ({
  project_id: 'p', plan_key, task_id, expected_topology_digest,
});
function store({ policy = 'carry_reconciled_metadata', ownerTopology = OWNER_TOPOLOGY } = {}) {
  return { members: [
    { plan: { project_id: 'p', plan_key: 'source', plan_version: 'rev-2', topology_digest: NEW,
      tasks: [{ task_id: 'w1' }, { task_id: 'w5' }] },
      revision: { predecessor: { plan_version: 'v1', plan_digest: 'd1' },
        desired_plan: { topology_digest: NEW },
        task_migration: [{ from_task_id: 'w1', to_task_id: 'w1', state_policy: policy },
          { from_task_id: 'w5', to_task_id: 'w5', state_policy: 'carry' }] } },
    { plan: { project_id: 'p', plan_key: 'owner', plan_version: 'rev-1', topology_digest: ownerTopology,
      tasks: [{ task_id: 't03' }, { task_id: 't05' }] }, revision: null },
  ] };
}
const source = { project_id: 'p', plan_key: 'source',
  predecessor: { plan_version: 'v1', plan_digest: 'd1', topology_digest: OLD } };
const dependencies = [
  { from: ref('source', 'w1', OLD), to: ref('owner', 't03', OWNER_TOPOLOGY), reason: 'r1', event_digest: 'e1' },
  { from: ref('source', 'w5', OLD), to: ref('owner', 't05', OWNER_TOPOLOGY), reason: 'r2', event_digest: 'e2' },
];

test('identity carry of both live connections is accepted and only the source digest moves', () => {
  const result = validateBindingCarry({ store: store(), source, dependencies });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.detail.successor_topology_digest, NEW);
  assert.deepEqual(result.detail.rebound.map(({ event_digest }) => event_digest), ['e1', 'e2']);
  const payload = carriedDependencyPayload(dependencies[0], NEW);
  assert.deepEqual(payload, { from: ref('source', 'w1', NEW), to: ref('owner', 't03', OWNER_TOPOLOGY), reason: 'r1' });
  assert.equal(dependencies[0].from.expected_topology_digest, OLD, 'input is not mutated');
});

test('reset, renamed or missing source tasks, changed targets and unlinked hops are refused', () => {
  const code = (args) => validateBindingCarry(args).code;
  assert.equal(code({ store: store({ policy: 'reset_pending' }), source, dependencies }), 'binding_carry_task_not_carried');
  assert.equal(code({ store: store({ ownerTopology: '0'.repeat(64) }), source, dependencies }), 'binding_carry_target_changed');
  assert.equal(code({ store: store(), source: { ...source, predecessor: { ...source.predecessor, plan_digest: 'other' } },
    dependencies }), 'binding_carry_hop_unlinked');
  assert.equal(code({ store: store(), source,
    dependencies: [{ ...dependencies[0], from: ref('source', 'w1', NEW) }] }), 'binding_carry_predecessor_mismatch');
  assert.equal(code({ store: store(), source, dependencies: [dependencies[0], dependencies[0]] }), 'binding_carry_duplicate');
  assert.equal(code({ store: store(), source,
    dependencies: [{ ...dependencies[0], to: ref('owner', 'nope', OWNER_TOPOLOGY) }] }), 'binding_carry_target_missing');
});
