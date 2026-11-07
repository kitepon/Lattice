import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { todoSelfDigest } from '../src/todo-contracts.mjs';
import { phaseTodoRevisionPlanVersion } from '../src/todo-revision.mjs';
import {
  TodoStoreError, applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter,
  initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

const taskV4 = (taskId, phaseId) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, narrative_anchor: null,
  compile_binding: null, parent_task_id: null, phase_id: phaseId,
});

function writeEvidence(root, evidenceId) {
  const bytes = Buffer.from(`${evidenceId} evidence\n`);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: bytes, encoding: 'utf8',
  }).trim();
  return { evidence_id: evidenceId, repo_id: 'self', path: 'evidence.txt', git_blob_oid: oid,
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
}

/**
 * A store whose T1 is `done` only because a plan revision carried it forward.
 * The successor plan version opens a fresh journal, so T1's completion lives in
 * the `plan_genesis` state migration and there is no `done` event to bind to.
 * T2 stays pending in the same phase so the phase does not reach `gate_ready`.
 */
async function carriedDoneFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-carried-reopen-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });

  const phase = { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
    predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const plan = buildTodoPlan({ schema: 'lattice.todo_plan.v4', project_id: 'project-1',
    plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [taskV4('T1', 'phase-1'), taskV4('T2', 'phase-1')], phases: [phase],
    hard_dependencies: [], joins: [] });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW });

  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { evidence: writeEvidence(root, 'carried-done') } } });

  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const predecessor = { plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version };
  const taskMigration = [
    { from_task_id: 'T1', to_task_id: 'T1', state_policy: 'carry' },
    { from_task_id: 'T2', to_task_id: 'T2', state_policy: 'reset_pending' },
  ];
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  const desiredInput = structuredClone(member.plan);
  delete desiredInput.topology_digest; delete desiredInput.plan_digest;
  desiredInput.predecessor_plan_digest = predecessor.plan_digest;
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1',
    planKey: 'main', predecessor, desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  const revision = { schema: 'lattice.phase_todo_revision.v1', project_id: 'project-1',
    plan_key: 'main', predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    phase_migration: phaseMigration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR,
    recordedAt: NOW, now: NOW });
  return { root, writer };
}

test('revisionでcarryされたdoneは後継journalにdoneイベントを持たない', async (t) => {
  const { root } = await carriedDoneFixture(t);
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'done');
  assert.equal(member.journal.events.some(({ kind, task_id }) => kind === 'done' && task_id === 'T1'),
    false, 'carried done must not carry a done event into the successor journal');
  assert.equal(member.journal.events[0].kind, 'plan_genesis');
});

test('carried doneなtaskをreopenできる', async (t) => {
  const { root, writer } = await carriedDoneFixture(t);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'reopen', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'carried done must be reopenable', override_reason: null } } });
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  assert.equal(member.tasks.find(({ task_id }) => task_id === 'T1').status, 'in-progress');
});

test('reopenのtarget_done_digestはgenesisのcarryへ束縛される', async (t) => {
  const { root, writer } = await carriedDoneFixture(t);
  const before = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const genesisDigest = before.journal.events[0].event_digest;
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'reopen', task_id: 'T1', actor: ACTOR, recorded_at: NOW,
      payload: { reason: 'binds to the carrying genesis', override_reason: null } } });
  const member = (await readTodoStore({ repoRoot: root, now: NOW })).members[0];
  const reopen = member.journal.events.at(-1);
  assert.equal(reopen.kind, 'reopen');
  assert.equal(reopen.payload.target_done_digest, genesisDigest);
});

test('doneでないtaskのreopenはinvalid_reopen_bindingのまま', async (t) => {
  const { root, writer } = await carriedDoneFixture(t);
  await assert.rejects(
    appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
      event: { kind: 'reopen', task_id: 'T2', actor: ACTOR, recorded_at: NOW,
        payload: { reason: 'T2 was never done', override_reason: null } } }),
    (error) => error instanceof TodoStoreError && error.code === 'STORE_INCONSISTENT'
      && error.detail.reason === 'invalid_reopen_binding',
  );
});
