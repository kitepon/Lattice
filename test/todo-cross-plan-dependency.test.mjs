import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runTodoCli } from '../src/todo-cli.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
  rebindTodoCrossPlanDependencies,
  applyPhaseTodoRevision, buildTodoPlan,
  projectTodoCrossPlanDependencies,
  readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { phaseTodoRevisionPlanVersion } from '../src/todo-revision.mjs';

const NOW = '2026-08-09T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });

async function workspace(context, { consumerTasks = ['C'], phaseProducer = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-cross-plan-dependency-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# evidence\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });

  const plan = (planKey, taskId) => ({
    schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: planKey,
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: (Array.isArray(taskId) ? taskId : [taskId]).map(task), hard_dependencies: [], joins: [],
  });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: phaseProducer ? { ...plan('producer', 'P'), schema: 'lattice.todo_plan.v7',
        tasks: [{ ...task('P'), narrative_anchor: null, parent_task_id: null, design_memo: 'NO_PLAN', phase_id: 'phase' }],
        phases: [{ phase_id: 'phase', title: 'Phase', gate_policy: 'heavy',
          predecessor_phase_ids: [], required_evidence_slots: ['gate'] }], phase_accept_dependencies: [],
      } : plan('producer', 'P'), genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('consumer', consumerTasks), genesis: { actor: ACTOR, recorded_at: NOW } },
    ],
    now: NOW,
  });

  const read = () => readTodoStore({ repoRoot: root, now: NOW });
  const ref = async (planKey, taskId) => {
    const store = await read();
    const member = store.members.find(({ plan: value }) => value.plan_key === planKey);
    return {
      project_id: store.project_id, plan_key: planKey, task_id: taskId,
      expected_topology_digest: member.plan.topology_digest,
    };
  };
  const connect = async ({
    fromPlan = 'producer', fromTask = 'P', toPlan = 'consumer', toTask = 'C', reason = '入力を待つ',
  } = {}) => appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: toPlan, now: NOW,
    event: {
      kind: 'cross_plan_dependency', actor: ACTOR, recorded_at: NOW,
      payload: {
        from: await ref(fromPlan, fromTask),
        to: await ref(toPlan, toTask),
        reason,
      },
    },
  });
  const evidence = {
    evidence_id: 'fixture', repo_id: 'self', path: 'evidence.md',
    git_blob_oid: execFileSync('git', ['rev-parse', 'HEAD:evidence.md'], { cwd: root, encoding: 'utf8' }).trim(),
    content_digest: createHash('sha256').update(await readFile(path.join(root, 'evidence.md'))).digest('hex'),
    media_type: 'text/markdown', anchor_digest: null,
  };
  return { root, read, ref, connect, evidence };
}

test('発見時接続をconsumer planのappend-only chainへ記録する', async (context) => {
  const { read, connect } = await workspace(context);
  const before = await read();
  const consumerBefore = before.members.find(({ plan }) => plan.plan_key === 'consumer');

  const { event } = await connect();
  assert.equal(event.kind, 'cross_plan_dependency');
  assert.equal(event.plan_key, 'consumer');
  assert.equal(event.task_id, null);
  assert.equal(event.phase_id, null);
  assert.equal(event.payload.from.plan_key, 'producer');
  assert.equal(event.payload.to.plan_key, 'consumer');

  const after = await read();
  const consumerAfter = after.members.find(({ plan }) => plan.plan_key === 'consumer');
  assert.equal(consumerAfter.journal.activeBytes.length, consumerBefore.journal.activeBytes.length,
    'lifecycle journalは動かさない');
  assert.deepEqual(consumerAfter.journal.events.map(({ kind }) => kind),
    consumerBefore.journal.events.map(({ kind }) => kind));
  assert.equal(consumerAfter.plan_scoped.events.at(-1).event_digest, event.event_digest);
  assert.deepEqual(projectTodoCrossPlanDependencies(after.members), [{
    from: event.payload.from,
    to: event.payload.to,
    reason: '入力を待つ',
    connected_by: ACTOR,
    connected_at: NOW,
    event_digest: event.event_digest,
  }]);
});

test('同一plan・重複・stale binding・cycleをtyped拒否する', async (context) => {
  const { root, ref, connect } = await workspace(context);

  await assert.rejects(() => connect({ fromPlan: 'producer', fromTask: 'P', toPlan: 'producer', toTask: 'P' }),
    (error) => error.code === 'DEPENDENCY_INVALID' && error.detail.reason === 'dependency_self_reference');

  await connect();
  await assert.rejects(() => connect(),
    (error) => error.code === 'DEPENDENCY_EXISTS' && error.detail.reason === 'cross_plan_dependency_duplicate');

  const stale = await ref('producer', 'P');
  stale.expected_topology_digest = '0'.repeat(64);
  const target = await ref('consumer', 'C');
  await assert.rejects(() => appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: 'consumer', now: NOW,
    event: {
      kind: 'cross_plan_dependency', actor: ACTOR, recorded_at: NOW,
      payload: {
        from: stale,
        to: target,
        reason: 'staleを拒否する',
      },
    },
  }), (error) => error.code === 'DEPENDENCY_STALE' && error.detail.reason === 'dependency_topology_stale');

  await assert.rejects(() => connect({
    fromPlan: 'consumer', fromTask: 'C', toPlan: 'producer', toTask: 'P', reason: '逆向き',
  }), (error) => error.code === 'DEPENDENCY_CYCLE' && error.detail.reason === 'cross_plan_dependency_cycle');
});

test('完了済みsourceは既に満たされた前提として後付けし、完了済みconsumerは拒否する', async (context) => {
  const { root, connect, evidence } = await workspace(context);
  const mutate = (planKey, taskId, kind, payload) => appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey, now: NOW,
    event: { kind, task_id: taskId, actor: ACTOR, recorded_at: NOW, payload },
  });
  await mutate('producer', 'P', 'start', { override_reason: null });
  await mutate('producer', 'P', 'done', { done_mode: 'authored', imported: false, evidence });
  const connected = await connect();
  assert.equal(connected.event.kind, 'cross_plan_dependency');
  const connectedStore = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(connectedStore.members.find(({ plan }) => plan.plan_key === 'consumer')
    .tasks.find(({ task_id: taskId }) => taskId === 'C').status, 'pending');

  const second = await workspace(context);
  const mutateSecond = (planKey, taskId, kind, payload) => appendTodoEvent({
    repoRoot: second.root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey, now: NOW,
    event: { kind, task_id: taskId, actor: ACTOR, recorded_at: NOW, payload },
  });
  await mutateSecond('consumer', 'C', 'start', { override_reason: null });
  await mutateSecond('consumer', 'C', 'done', {
    done_mode: 'authored', imported: false, evidence: second.evidence,
  });
  await assert.rejects(() => second.connect(),
    (error) => error.code === 'DEPENDENCY_INVALID' && error.detail.reason === 'dependency_target_terminal');
});

test('公開CLIはtask identityをtopologyへ束縛してresultを返す', async (context) => {
  const { root } = await workspace(context);
  let out = '';
  let err = '';
  const exit = await runTodoCli({
    argv: ['dependency', 'connect', '--from-plan', 'producer', '--from-task', 'P',
      '--to-plan', 'consumer', '--to-task', 'C', '--reason', '実装中に発見'],
    cwd: root,
    stdout: { write: (chunk) => { out += chunk; } },
    stderr: { write: (chunk) => { err += chunk; } },
    env: {
      ...process.env,
      LATTICE_TODO_ACTOR_HOST: 'host-1',
      LATTICE_TODO_ACTOR_SESSION: 'session-1',
      LATTICE_TODO_ACTOR_AGENT: 'agent-1',
      LATTICE_DASHBOARD_AUTOSTART: '0',
    },
  });
  assert.equal(exit, 0, err);
  const result = JSON.parse(out);
  assert.equal(result.schema, 'lattice.todo_dependency_connect_result.v1');
  assert.equal(result.from.plan_key, 'producer');
  assert.equal(result.to.plan_key, 'consumer');
  assert.match(result.from.expected_topology_digest, /^[0-9a-f]{64}$/u);
  assert.match(result.event_digest, /^[0-9a-f]{64}$/u);
});

test('公開helpは発見時接続のexact argvを案内する', () => {
  const bin = fileURLToPath(new URL('../bin/lattice.mjs', import.meta.url));
  const help = execFileSync(process.execPath, [bin, 'todo', 'dependency', 'connect', '--help'], {
    encoding: 'utf8',
  });
  assert.match(help, /todo dependency connect \[--from-project <id>\] --from-plan <key> --from-task <id>/u);
  assert.match(help, /--to-plan <key> --to-task <id> --reason <text>/u);
});

test('同一plan内の後追い接続を受理し、plan辺重複・循環はtyped拒否する', async (context) => {
  // 2026-08-25 オーナー裁定: 「工程の線を誤ったので足す」をplan改訂トランザクションへ
  // 格上げしていた dependency_must_cross_plans 門を撤去した。跨ぎと同じ台帳・同じ検査で受ける。
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-same-plan-dependency-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# evidence\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const edge = (fromTask, toTask) => ({
    from: { project_id: 'project-1', plan_key: 'solo', task_id: fromTask },
    to: { project_id: 'project-1', plan_key: 'solo', task_id: toTask },
  });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'solo',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [task('A'), task('B'), task('C')], hard_dependencies: [edge('A', 'B')], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  const read = () => readTodoStore({ repoRoot: root, now: NOW });
  const ref = async (taskId) => {
    const store = await read();
    const member = store.members.find(({ plan: value }) => value.plan_key === 'solo');
    return {
      project_id: 'project-1', plan_key: 'solo', task_id: taskId,
      expected_topology_digest: member.plan.topology_digest,
    };
  };
  const connect = async (fromTask, toTask, reason = '線の修理') => appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'solo', now: NOW,
    event: {
      kind: 'cross_plan_dependency', actor: ACTOR, recorded_at: NOW,
      payload: { from: await ref(fromTask), to: await ref(toTask), reason },
    },
  });

  // 成立: B→C を後追いで張れる
  const { event } = await connect('B', 'C');
  assert.equal(event.payload.from.plan_key, 'solo');
  assert.equal(event.payload.to.plan_key, 'solo');
  const after = await read();
  assert.deepEqual(
    projectTodoCrossPlanDependencies(after.members).map(({ from, to }) => [from.task_id, to.task_id]),
    [['B', 'C']],
  );

  // plan本体のhard依存と同じ辺は二重記録しない
  await assert.rejects(() => connect('A', 'B'),
    (error) => error.code === 'DEPENDENCY_EXISTS' && error.detail.reason === 'dependency_already_in_plan');

  // plan辺A→B＋後追いB→Cと合わせて循環になる接続は拒否する
  await assert.rejects(() => connect('C', 'A'),
    (error) => error.code === 'DEPENDENCY_CYCLE' && error.detail.reason === 'cross_plan_dependency_cycle');
});

test('dependency disconnectは誤接続をtombstoneで消し、二重除去と不在を拒否する', async (context) => {
  const { root } = await workspace(context);
  const run = async (argv) => {
    let out = '';
    let err = '';
    const code = await runTodoCli({
      argv, cwd: root,
      stdout: { write: (chunk) => { out += chunk; } },
      stderr: { write: (chunk) => { err += chunk; } },
      env: { ...process.env, LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
        LATTICE_TODO_ACTOR_AGENT: 'agent-1', LATTICE_DASHBOARD_AUTOSTART: '0' },
    });
    return { code, out, err };
  };
  const edge = ['--from-plan', 'producer', '--from-task', 'P', '--to-plan', 'consumer', '--to-task', 'C'];
  const connect = await run(['dependency', 'connect', ...edge, '--reason', '誤接続の再現']);
  assert.equal(connect.code, 0, connect.err);
  let store = await readTodoStore({ repoRoot: root });
  assert.equal(projectTodoCrossPlanDependencies(store.members).length, 1);
  const disconnect = await run(['dependency', 'disconnect', ...edge, '--reason', '方向を誤ったため除去']);
  assert.equal(disconnect.code, 0, disconnect.err);
  assert.equal(JSON.parse(disconnect.out).schema, 'lattice.todo_dependency_disconnect_result.v1');
  store = await readTodoStore({ repoRoot: root });
  assert.equal(projectTodoCrossPlanDependencies(store.members).length, 0, '線が消える');
  const again = await run(['dependency', 'disconnect', ...edge, '--reason', '二重除去']);
  assert.notEqual(again.code, 0, '既に消えた線の再除去は拒否');
  const reconnect = await run(['dependency', 'connect', ...edge, '--reason', '張り直し']);
  assert.equal(reconnect.code, 0, '除去後の張り直しは重複でない');
  store = await readTodoStore({ repoRoot: root });
  assert.equal(projectTodoCrossPlanDependencies(store.members).length, 1);
});


async function bindingRecoveryFixture(context) {
  const fixture = await workspace(context, { consumerTasks: ['C', 'D'], phaseProducer: true });
  const { root, connect, evidence } = fixture;
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const mutate = (planKey, taskId, kind, payload) => appendTodoEvent({ repoRoot: root, writer,
    planKey, now: NOW, event: { kind, task_id: taskId, actor: ACTOR, recorded_at: NOW, payload } });
  await mutate('producer', 'P', 'start', { override_reason: null });
  await mutate('producer', 'P', 'done', { done_mode: 'authored', imported: false, evidence });
  await connect();
  await connect({ toTask: 'D' });
  await mutate('consumer', 'C', 'start', { override_reason: null });
  await mutate('consumer', 'C', 'done', { done_mode: 'authored', imported: false, evidence });
  const connected = await fixture.read();
  const consumer = connected.members.find(({ plan }) => plan.plan_key === 'consumer');
  const chainPath = path.join(root, consumer.plan_scoped.ref);
  const events = consumer.plan_scoped.events;
  const originalBytes = await readFile(chainPath);
  const previous = connected.members.find(({ plan }) => plan.plan_key === 'producer');
  const predecessor = { plan_version: previous.plan.plan_version, plan_digest: previous.plan.plan_digest,
    journal_head_digest: previous.journal.events.at(-1).event_digest };
  const task_migration = [{ from_task_id: 'P', to_task_id: 'P', state_policy: 'carry' }];
  const phase_migration = [{ from_phase_id: 'phase', to_phase_id: 'phase', state_policy: 'reset' }];
  const desired = { ...previous.plan, plan_version: 'pending', predecessor_plan_digest: previous.plan.plan_digest,
    tasks: [...previous.plan.tasks, { ...previous.plan.tasks[0], task_id: 'Q', title: 'Q' }] };
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project-1', planKey: 'producer',
    predecessor, desiredPlan: desired, taskMigration: task_migration, phaseMigration: phase_migration });
  const revision = { schema: 'lattice.phase_todo_revision.v5', project_id: 'project-1', plan_key: 'producer',
    predecessor, desired_plan: buildTodoPlan(desired), task_migration, phase_migration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  // Restore the old live chain after publication to emulate the previous writer's omission.
  await rm(chainPath);
  await applyPhaseTodoRevision({ repoRoot: root, writer, revision, actor: ACTOR, recordedAt: NOW, now: NOW });
  const clean = await fixture.read();
  await writeFile(chainPath, originalBytes);
  const options = { repoRoot: root, writer, planKey: 'consumer', sourcePlanKey: 'producer',
    expectedManifestDigest: clean.manifest.manifest_digest,
    expectedPlanScopedHeadDigest: events.at(-1).event_digest,
    eventDigests: events.map(({ event_digest: digest }) => digest),
    actor: ACTOR, recordedAt: NOW, now: NOW, reason: 'Preserve carried source bindings',
    validateBindingCarry: () => ({ ok: true }) };
  return { ...fixture, chainPath, originalBytes, options, events, clean };
}

test('binding recovery atomically preserves both connections including a done target', async (context) => {
  const fixture = await bindingRecoveryFixture(context);
  const { root, options, clean, events, chainPath, originalBytes } = fixture;
  const preserved = new Map();
  for (const member of clean.members) for (const ref of [member.descriptor.plan_ref,
    member.descriptor.journal_ref, member.descriptor.snapshot_ref]) {
    preserved.set(ref, await readFile(path.join(root, ref)));
  }
  preserved.set('.lattice/todo/manifest.json', await readFile(path.join(root, '.lattice/todo/manifest.json')));
  let calls = 0;
  const result = await rebindTodoCrossPlanDependencies({ ...options,
    validateBindingCarry: async ({ store, source, dependencies, predecessor }) => {
      calls += 1;
      assert.equal(source.plan.plan_key, 'producer');
      assert.equal(predecessor.plan_version, 'v1');
      assert.equal(predecessor.topology_digest, events[0].payload.from.expected_topology_digest);
      assert.equal(dependencies.length, 2);
      assert.equal(store.members.find(({ plan }) => plan.plan_key === 'consumer').tasks[0].status, 'done');
      await assert.rejects(appendTodoEvent({ repoRoot: root, writer: options.writer,
        planKey: 'consumer', event: {} }), (error) => error.detail.reason === 'store_locked');
      return { ok: true };
    } });
  assert.equal(calls, 1);
  assert.equal(result.replacements.length, 2);
  const after = await fixture.read();
  const connections = projectTodoCrossPlanDependencies(after.members);
  assert.equal(connections.length, 2);
  const endpoints = (members) => projectTodoCrossPlanDependencies(members)
    .map(({ from, to, reason }) => ({ from, to, reason }));
  assert.deepEqual(endpoints(after.members), events.map(({ payload }) => ({ ...payload,
    from: { ...payload.from, expected_topology_digest: result.source_topology_digest } })));
  const consumer = after.members.find(({ plan }) => plan.plan_key === 'consumer');
  assert.deepEqual(consumer.tasks.map(({ status }) => status), ['done', 'pending']);
  assert.deepEqual(consumer.plan_scoped.events.slice(0, 2), events);
  assert.deepEqual((await readFile(chainPath)).subarray(0, originalBytes.length), originalBytes);
  for (const [ref, bytes] of preserved) assert.deepEqual(await readFile(path.join(root, ref)), bytes);
});

test('binding recovery refuses CAS changes, wrong originals and missing carry without publication', async (context) => {
  const { options, chainPath, originalBytes } = await bindingRecoveryFixture(context);
  for (const [override, reason] of [
    [{ expectedManifestDigest: 'f'.repeat(64) }, 'dependency_rebind_binding_changed'],
    [{ expectedPlanScopedHeadDigest: 'f'.repeat(64) }, 'dependency_rebind_binding_changed'],
    [{ eventDigests: ['f'.repeat(64)] }, 'dependency_rebind_original_mismatch'],
    [{ validateBindingCarry: () => ({ ok: false, code: 'REVISION_INVALID', detail: { reason: 'carry_not_proven', task_id: 'P' } }) }, 'carry_not_proven'],
  ]) {
    await assert.rejects(rebindTodoCrossPlanDependencies({ ...options, ...override }),
      (error) => error.detail.reason === reason);
    assert.deepEqual(await readFile(chainPath), originalBytes);
  }
  for (const override of [{ validateBindingCarry: undefined },
    { validateBindingCarry: () => ({ ok: false }) }, { validateBindingCarry: () => null },
    { eventDigests: [options.eventDigests[0], options.eventDigests[0]] }]) {
    await assert.rejects(rebindTodoCrossPlanDependencies({ ...options, ...override }), TypeError);
    assert.deepEqual(await readFile(chainPath), originalBytes);
  }
  // An unselected stale binding is no longer a refusal; it stays a finding.
  const partial = await rebindTodoCrossPlanDependencies({ ...options,
    eventDigests: options.eventDigests.slice(0, 1) });
  assert.equal(partial.replacements.length, 1);
  const after = await readTodoStore({ repoRoot: options.repoRoot });
  assert.deepEqual(after.cross_plan_findings.map(({ event_digest: digest, reason }) => [digest, reason]),
    [[options.eventDigests[1], 'binding_stale']]);
});

test('binding recovery publication has no disconnect-only crash state', async (context) => {
  const fixture = await bindingRecoveryFixture(context);
  const { options, chainPath, originalBytes } = fixture;
  await assert.rejects(rebindTodoCrossPlanDependencies({ ...options,
    onProtocolStage(stage) { if (stage === 'dependency_rebind_validated') throw new Error('before'); },
  }), /before/u);
  assert.deepEqual(await readFile(chainPath), originalBytes);
  const stale = await fixture.read();
  assert.deepEqual(stale.cross_plan_findings.map(({ event_digest: digest, side, reason }) => [digest, side, reason]).sort(),
    options.eventDigests.map((digest) => [digest, 'from', 'binding_stale']).sort());
  await assert.rejects(rebindTodoCrossPlanDependencies({ ...options,
    onProtocolStage(stage) { if (stage === 'dependency_rebind_published') throw new Error('after'); },
  }), /after/u);
  assert.equal(projectTodoCrossPlanDependencies((await fixture.read()).members).length, 2);
  const published = await readFile(chainPath);
  await assert.rejects(rebindTodoCrossPlanDependencies(options),
    (error) => error.detail.reason === 'dependency_rebind_binding_changed');
  assert.deepEqual(await readFile(chainPath), published);
});


test('binding recovery closes stale bindings before ordinary snapshot recovery', async (context) => {
  const fixture = await bindingRecoveryFixture(context);
  const consumer = fixture.clean.members.find(({ plan }) => plan.plan_key === 'consumer');
  const snapshot = path.join(fixture.root, consumer.descriptor.snapshot_ref);
  await rm(snapshot);
  await rebindTodoCrossPlanDependencies(fixture.options);
  const after = await fixture.read();
  assert.equal(after.snapshot_stale, false);
  assert.equal(projectTodoCrossPlanDependencies(after.members).length, 2);
  assert.equal(JSON.parse(await readFile(snapshot, 'utf8')).tasks[0].status, 'done');
});


test('binding recovery keeps duplicate-edge validation inside Store', async (context) => {
  const fixture = await bindingRecoveryFixture(context);
  const events = structuredClone(fixture.events);
  const duplicate = structuredClone(events[0]);
  duplicate.sequence = events.at(-1).sequence + 1;
  duplicate.previous_digest = events.at(-1).event_digest;
  duplicate.event_digest = todoSelfDigest(duplicate, 'event_digest');
  events.push(duplicate);
  const bytes = Buffer.from(events.map((event) => `${canonicalizeTodoArtifact(event)}\n`).join(''));
  await writeFile(fixture.chainPath, bytes);
  await assert.rejects(rebindTodoCrossPlanDependencies({ ...fixture.options,
    expectedPlanScopedHeadDigest: duplicate.event_digest,
    eventDigests: events.map(({ event_digest: digest }) => digest),
  }), (error) => error.detail.reason === 'cross_plan_dependency_duplicate');
  assert.deepEqual(await readFile(fixture.chainPath), bytes);
});

test('binding recovery refuses a non-stale original and a wrong owner', async (context) => {
  const fixture = await bindingRecoveryFixture(context);
  await assert.rejects(rebindTodoCrossPlanDependencies({ ...fixture.options,
    planKey: 'producer', sourcePlanKey: 'consumer',
  }), (error) => error.detail.reason === 'dependency_rebind_binding_changed');
  const events = structuredClone(fixture.events);
  events[0].payload.from.expected_topology_digest = fixture.clean.members
    .find(({ plan }) => plan.plan_key === 'producer').plan.topology_digest;
  for (const [index, event] of events.entries()) {
    event.previous_digest = index === 0 ? null : events[index - 1].event_digest;
    event.event_digest = todoSelfDigest(event, 'event_digest');
  }
  const bytes = Buffer.from(events.map((event) => `${canonicalizeTodoArtifact(event)}\n`).join(''));
  await writeFile(fixture.chainPath, bytes);
  await assert.rejects(rebindTodoCrossPlanDependencies({ ...fixture.options,
    eventDigests: events.map(({ event_digest: digest }) => digest),
    expectedPlanScopedHeadDigest: events.at(-1).event_digest,
  }), (error) => error.detail.reason === 'dependency_rebind_original_mismatch');
  assert.deepEqual(await readFile(fixture.chainPath), bytes);
});

test('binding recovery authenticates retained predecessor artifact identity', async (context) => {
  const fixture = await bindingRecoveryFixture(context);
  const consumer = fixture.clean.members.find(({ plan }) => plan.plan_key === 'consumer');
  await writeFile(path.join(fixture.root, '.lattice/todo/plans/producer/v1/plan.json'),
    await readFile(path.join(fixture.root, consumer.descriptor.plan_ref)));
  await assert.rejects(rebindTodoCrossPlanDependencies(fixture.options),
    (error) => error.detail.reason === 'dependency_rebind_predecessor_mismatch');
  assert.deepEqual(await readFile(fixture.chainPath), fixture.originalBytes);
});
