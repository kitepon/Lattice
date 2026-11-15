import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_PENDING_PHASE_STATUSES, auditPendingNextCommands, auditPendingPhasesOf,
  isAuditPendingPhaseStatus,
} from '../src/todo-audit-pending.mjs';

const member = (planKey, phases) => ({
  plan: { project_id: 'project-1', plan_key: planKey, tasks: [] },
  tasks: [],
  ...(phases === undefined ? {} : { phases: phases.map(([phase_id, status]) => ({ phase_id, status })) }),
});

test('監査前はgate_ready・reviewing・rejectedの3状態だけ', () => {
  assert.deepEqual([...AUDIT_PENDING_PHASE_STATUSES].sort(),
    ['gate_ready', 'rejected', 'reviewing']);
});

test('判断が着いた終端状態と未到達の状態は監査前ではない', () => {
  for (const status of ['gate_ready', 'reviewing', 'rejected']) {
    assert.equal(isAuditPendingPhaseStatus(status), true, status);
  }
  // ADR 0148裁定4: closed_unauditedはacceptedと同じく判断の着いた終端状態。
  for (const status of ['accepted', 'closed_unaudited', 'active', 'locked']) {
    assert.equal(isAuditPendingPhaseStatus(status), false, status);
  }
});

test('状態を持たない入力は監査前に数えない', () => {
  assert.equal(isAuditPendingPhaseStatus(null), false);
  assert.equal(isAuditPendingPhaseStatus(undefined), false);
});

test('次コマンドはstoreの遷移guardが受理するものだけを案内する', () => {
  assert.deepEqual(auditPendingNextCommands('p', 'terminal-audit', 'gate_ready'), [
    'lattice todo phase review --plan p --phase terminal-audit --reason <text>',
    'lattice todo phase close-unaudited --plan p --phase terminal-audit --reason <text>',
  ]);
  assert.deepEqual(auditPendingNextCommands('p', 'terminal-audit', 'reviewing'), [
    'lattice todo phase accept --plan p --phase terminal-audit [--message <text>]',
    'lattice todo phase reject --plan p --phase terminal-audit --reason <text> [--message <text>]',
  ]);
  assert.deepEqual(auditPendingNextCommands('p', 'terminal-audit', 'rejected'), [
    'lattice todo phase reopen --plan p --phase terminal-audit --reason <text>',
  ]);
});

test('監査前でない状態は空配列へ丸めず投げる', () => {
  assert.throws(() => auditPendingNextCommands('p', 'terminal-audit', 'accepted'),
    (error) => error.code === 'AUDIT_PENDING_STATUS_INVALID');
});

test('read modelからは監査前Phaseだけがplan_key→phase_id順で出る', () => {
  assert.deepEqual(auditPendingPhasesOf({
    schema: 'lattice.todo_store_read.v1',
    project_id: 'project-1',
    members: [
      member('zeta', [['terminal-audit', 'reviewing']]),
      member('alpha', [['p2', 'rejected'], ['p1', 'gate_ready'], ['p0', 'accepted']]),
    ],
  }), [
    { plan_key: 'alpha', phase_id: 'p1', status: 'gate_ready' },
    { plan_key: 'alpha', phase_id: 'p2', status: 'rejected' },
    { plan_key: 'zeta', phase_id: 'terminal-audit', status: 'reviewing' },
  ]);
});

test('phasesを持たないmemberと空storeは空配列になる', () => {
  assert.deepEqual(auditPendingPhasesOf({ members: [member('main')] }), []);
  assert.deepEqual(auditPendingPhasesOf({ members: [] }), []);
});
