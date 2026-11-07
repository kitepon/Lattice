import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  appendAuthoredTodoPlan, appendImportedPlan, buildTodoPlan, createTodoStoreWriter,
  initializeAuthoredTodoStore, isUninitializedTodoStore, readTodoStore, rebuildTodoSnapshot,
} from '../src/todo-store.mjs';
import { appendTodoNote } from '../src/todo-note-store.mjs';
import { withStoreLock } from '../src/store-lock.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const actor = { host: 'host', session: 'session', agent: 'test' };
const recorded_at = '2026-08-01T00:00:00.000Z';
const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
const line = (value) => `${canonicalizeTodoArtifact(value)}\n`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const lockModule = new URL('../src/store-lock.mjs', import.meta.url).href;

function plan(planKey = 'main', extra = {}) {
  return buildTodoPlan({
    schema: 'lattice.todo_plan.v7', project_id: 'project', plan_key: planKey,
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [{ task_id: 'task', title: 'Task', lane: 'main', narrative_ref: null,
      narrative_anchor: null, compile_binding: null, parent_task_id: null,
      design_memo: 'NO_PLAN', phase_id: 'phase' }],
    phases: [{ phase_id: 'phase', title: 'Phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['gate'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], ...extra,
  });
}

function request(repoRoot, extra = {}) {
  return { repoRoot, writer, plan: plan('second'), genesis: { actor, recorded_at }, ...extra };
}

function initial(repoRoot, extra = {}) {
  return { repoRoot, writer, projectId: 'project', repositories: [{ repo_id: 'self', path: '.' }],
    plan: plan(), genesis: { actor, recorded_at }, ...extra };
}

async function fixture(t, initialized = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-authored-membership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  if (initialized) await initializeAuthoredTodoStore(initial(root));
  return root;
}

const reason = (code, value) => (error) => error.code === code && error.detail.reason === value;

async function deadOwner(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {withStoreLock} from ${JSON.stringify(lockModule)};
    await withStoreLock({lockPath:${JSON.stringify(lockPath)}},()=>process.exit(0));
  `], { timeout: 15_000 });
  return JSON.parse(await readFile(lockPath, 'utf8'));
}

test('authored membership preserves active members/repositories and supplies ordinary phases/backchain', async (t) => {
  const root = await fixture(t);
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main',
    event: { kind: 'start', task_id: 'task', actor, recorded_at, payload: { override_reason: null } } });
  const current = await readTodoStore({ repoRoot: root });
  const refs = Object.values(current.members[0].descriptor).filter((value) => typeof value === 'string'
    && value.startsWith('.lattice/'));
  const bytes = await Promise.all(refs.map((ref) => readFile(path.join(root, ref))));
  const nextPlan = plan('second');
  const featureChain = { schema: 'lattice.plan_backchain.v1', authoring_ref: 'input.json',
    project_id: 'project', plan_key: 'second', plan_version: 'v1',
    goal: { purpose: 'Purpose', outcome: 'Outcome', acceptance: 'Acceptance', required_feature_ids: ['feature'] },
    features: [{ feature_id: 'feature', capability: 'Capability', acceptance: 'Acceptance',
      requires_feature_ids: [], provider: { kind: 'task', task_id: 'task' } }],
    tasks: [{ task_id: 'task', requires_feature_ids: [], provides_feature_ids: ['feature'] }], chain_digest: '' };
  featureChain.chain_digest = todoSelfDigest(featureChain, 'chain_digest');
  const result = await appendAuthoredTodoPlan(request(root, { plan: nextPlan, featureChain }));
  assert.equal(result.schema, 'lattice.todo_store_read.v1');
  assert.deepEqual(result.manifest.repositories, current.manifest.repositories);
  assert.equal(result.manifest.schema, current.manifest.schema);
  assert.deepEqual(await Promise.all(refs.map((ref) => readFile(path.join(root, ref)))), bytes);
  assert.deepEqual(result.members.find(({ plan: value }) => value.plan_key === 'main'), current.members[0]);
  const added = result.members.find(({ plan: value }) => value.plan_key === 'second');
  assert.equal(added.journal.events.length, 1);
  assert.equal(added.journal.events[0].schema, 'lattice.todo_event.v3');
  assert.equal(added.journal.events[0].payload.historical_import, undefined);
  assert.equal(added.tasks[0].status, 'pending');
  assert.deepEqual(added.phases, added.snapshot.phases);
  const binding = JSON.parse(await readFile(path.join(root, '.lattice/todo/plans/second/v1/backchain.json')));
  assert.equal(binding.plan_digest, nextPlan.plan_digest);
  assert.deepEqual(binding.chain, featureChain);
});

test('authored addition keeps manifest v2 and refuses duplicate/project/writer/import inputs unchanged', async (t) => {
  const root = await fixture(t);
  const manifestRef = path.join(root, '.lattice/todo/manifest.json');
  const manifest = JSON.parse(await readFile(manifestRef));
  manifest.schema = 'lattice.todo_manifest.v2';
  manifest.members[0].active_revision_digest = plan().plan_digest;
  manifest.repositories.push({ repo_id: 'z', path: 'other' });
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  await writeFile(manifestRef, line(manifest));
  const result = await appendAuthoredTodoPlan(request(root));
  assert.equal(result.manifest.schema, 'lattice.todo_manifest.v2');
  assert.deepEqual(result.manifest.repositories, manifest.repositories);
  assert.equal(result.members[1].descriptor.active_revision_digest, plan('second').plan_digest);
  const before = await readFile(manifestRef);
  await assert.rejects(appendAuthoredTodoPlan(request(root)), reason('STORE_WRITE_CONFLICT', 'plan_key_already_exists'));
  await assert.rejects(appendAuthoredTodoPlan(request(root, { plan: plan('foreign', { project_id: 'other' }) })),
    (error) => reason('STORE_WRITE_CONFLICT', 'project_id_mismatch')(error)
      && error.detail.expected === 'project' && error.detail.actual === 'other');
  await assert.rejects(appendAuthoredTodoPlan(request(root, { writer: createTodoStoreWriter({ caller: 'g4-migration' }) })), TypeError);
  await assert.rejects(appendAuthoredTodoPlan(request(root, { genesis: { actor, recorded_at, historical_import: true } })), TypeError);
  await assert.rejects(appendAuthoredTodoPlan(request(root, { initializeIfMissing: {} })), TypeError);
  assert.deepEqual(await readFile(manifestRef), before);
});

test('authored graph validation and live lock refusal happen before publication', async (t) => {
  const root = await fixture(t);
  const invalid = plan('second', { hard_dependencies: [{
    from: { project_id: 'project', plan_key: 'absent', task_id: 'task' },
    to: { project_id: 'project', plan_key: 'second', task_id: 'task' },
  }] });
  await assert.rejects(appendAuthoredTodoPlan(request(root, { plan: invalid })),
    (error) => error.code === 'STORE_INCONSISTENT');
  const lockPath = path.join(root, '.lattice/todo/.write.lock');
  await withStoreLock({ lockPath }, async () => {
    const before = await readFile(lockPath);
    await assert.rejects(appendAuthoredTodoPlan(request(root)), reason('STORE_WRITE_CONFLICT', 'store_locked'));
    assert.deepEqual(await readFile(lockPath), before);
  });
  assert.equal((await readTodoStore({ repoRoot: root })).members.length, 1);
});

for (const stage of ['staging_fsynced', 'pre_activation_renamed', 'manifest_activated']) {
  test(`authored publication crash/reopen/retry: ${stage}`, async (t) => {
    const root = await fixture(t);
    await assert.rejects(appendAuthoredTodoPlan(request(root, {
      onProtocolStage(value) { if (value === stage) throw new Error('crash'); },
    })), /crash/u);
    const reopened = await readTodoStore({ repoRoot: root });
    assert.equal(reopened.members.length, stage === 'manifest_activated' ? 2 : 1);
    if (stage === 'manifest_activated') {
      await assert.rejects(appendAuthoredTodoPlan(request(root)), reason('STORE_WRITE_CONFLICT', 'plan_key_already_exists'));
    } else assert.equal((await appendAuthoredTodoPlan(request(root))).members.length, 2);
  });
}

for (const imported of [false, true]) {
  for (const stage of ['staging_fsynced', 'pre_activation_renamed']) {
    test(`${imported ? 'imported' : 'authored'} unknown unpublished bytes are preserved: ${stage}`, async (t) => {
      const root = await fixture(t);
      const append = imported ? appendImportedPlan : appendAuthoredTodoPlan;
      const input = request(root, imported ? { writer: createTodoStoreWriter({ caller: 'g4-migration' }) } : {});
      await assert.rejects(append({ ...input,
        onProtocolStage(value) { if (value === stage) throw new Error('crash'); },
      }), /crash/u);
      const directory = stage === 'staging_fsynced' ? 'transactions/second-v1' : 'plans/second/v1';
      const unknown = path.join(root, '.lattice/todo', directory, 'operator-data.txt');
      await writeFile(unknown, 'keep');
      await assert.rejects(append(input), (error) => reason('REVISION_CONFLICT', 'revision_bytes_conflict')(error)
        && error.detail.next_action.includes(path.dirname(unknown)));
      assert.equal(await readFile(unknown, 'utf8'), 'keep');
      assert.equal((await readTodoStore({ repoRoot: root })).members.length, 1);
    });
  }
}

test('absent mutation/note targets remain absent and an empty orphan root initializes', async (t) => {
  const root = await fixture(t, false);
  await assert.rejects(rebuildTodoSnapshot({ repoRoot: root, planKey: 'main' }), reason('STORE_INCONSISTENT', 'artifact_missing'));
  await assert.rejects(appendTodoNote({ repoRoot: root, projectId: 'project', planKey: 'main', planVersion: 'v1',
    taskId: 'task', actor, recordedAt: recorded_at, body: 'note', supersedes: null, eligibleSupersedes: [] }),
  reason('NOTE_WRITE_CONFLICT', 'note_store_locked'));
  await assert.rejects(lstat(path.join(root, '.lattice')), { code: 'ENOENT' });
  assert.equal(await isUninitializedTodoStore({ repoRoot: root }), true);
  await mkdir(path.join(root, '.lattice/todo'), { recursive: true });
  assert.equal(await isUninitializedTodoStore({ repoRoot: root }), true);
  await initializeAuthoredTodoStore(initial(root));
  assert.equal(await isUninitializedTodoStore({ repoRoot: root }), false);
  assert.deepEqual(await readdir(path.join(root, '.lattice/todo/notes')), []);
});

test('dead identified todo/note lock, temporary and empty claim residue recover before initial rename', async (t) => {
  const root = await fixture(t, false);
  for (const relative of ['.lattice/todo', '.lattice/todo/notes']) {
    const lockPath = path.join(root, relative, '.write.lock');
    const owner = await deadOwner(lockPath);
    const name = `${hash(owner.host)}-${owner.pid}-${hash(`${owner.process_start.platform}:${owner.process_start.identity}`)}-${'a'.repeat(16)}`;
    await writeFile(`${lockPath}.${name}.tmp`, 'abandoned');
    await mkdir(path.join(`${lockPath}.recovery`, name), { recursive: true });
  }
  assert.equal(await isUninitializedTodoStore({ repoRoot: root }), true);
  const result = await initializeAuthoredTodoStore(initial(root));
  assert.equal(result.members.length, 1);
  assert.equal((await readdir(path.join(root, '.lattice/todo'), { recursive: true }))
    .some((name) => name.includes('.write.lock')), false);
});

test('legacy/live transient owners stay intact, and unknown/note data are never classified as residue', async (t) => {
  const root = await fixture(t, false);
  const storeRoot = path.join(root, '.lattice/todo');
  await mkdir(storeRoot, { recursive: true });
  const lockPath = path.join(storeRoot, '.write.lock');
  await writeFile(lockPath, '');
  await assert.rejects(initializeAuthoredTodoStore(initial(root)), reason('STORE_WRITE_CONFLICT', 'lock_owner_unidentified'));
  assert.equal(await readFile(lockPath, 'utf8'), '');
  await rm(lockPath);
  await withStoreLock({ lockPath }, async () => {
    const before = await readFile(lockPath);
    await assert.rejects(initializeAuthoredTodoStore(initial(root)), reason('STORE_WRITE_CONFLICT', 'store_locked'));
    assert.deepEqual(await readFile(lockPath), before);
  });
  for (const relative of ['unknown.txt', 'notes/main/active.jsonl']) {
    const ref = path.join(storeRoot, relative);
    await mkdir(path.dirname(ref), { recursive: true });
    await writeFile(ref, 'existing bytes');
    assert.equal(await isUninitializedTodoStore({ repoRoot: root }), false);
    await assert.rejects(initializeAuthoredTodoStore(initial(root)), reason('STORE_WRITE_CONFLICT', 'store_already_exists'));
    assert.equal(await readFile(ref, 'utf8'), 'existing bytes');
    await rm(ref);
  }
});

test('initial residue disappearance re-enters absent publication and replacement data remain untouched', async (t) => {
  const root = await fixture(t, false);
  const storeRoot = path.join(root, '.lattice/todo');
  await mkdir(storeRoot, { recursive: true });
  await initializeAuthoredTodoStore(initial(root, { onProtocolStage: async (stage) => {
    if (stage === 'authoring_residue_released') await rmdir(storeRoot);
  } }));
  assert.equal((await readTodoStore({ repoRoot: root })).members.length, 1);
  const other = await fixture(t, false);
  const otherStore = path.join(other, '.lattice/todo');
  await mkdir(otherStore, { recursive: true });
  await assert.rejects(initializeAuthoredTodoStore(initial(other, { onProtocolStage: async (stage) => {
    if (stage !== 'authoring_residue_released') return;
    await rename(otherStore, `${otherStore}-original`);
    await mkdir(otherStore);
    await writeFile(path.join(otherStore, 'operator.txt'), 'keep');
  } })), (error) => error.code === 'STORE_WRITE_CONFLICT');
  assert.equal(await readFile(path.join(otherStore, 'operator.txt'), 'utf8'), 'keep');
});

test('initial publication holds both locks until verification/rollback; concurrent initializers keep one winner', async (t) => {
  const root = await fixture(t, false);
  await assert.rejects(initializeAuthoredTodoStore(initial(root, { onProtocolStage: async (stage) => {
    if (stage !== 'authoring_renamed') return;
    await assert.rejects(appendAuthoredTodoPlan(request(root)), reason('STORE_WRITE_CONFLICT', 'store_locked'));
    await assert.rejects(appendTodoNote({ repoRoot: root, projectId: 'project', planKey: 'main', planVersion: 'v1',
      taskId: 'task', actor, recordedAt: recorded_at, body: 'note', supersedes: null, eligibleSupersedes: [] }),
    reason('NOTE_WRITE_CONFLICT', 'note_store_locked'));
    throw new Error('rollback');
  } })), /rollback/u);
  await assert.rejects(lstat(path.join(root, '.lattice/todo')), { code: 'ENOENT' });
  const storeModule = new URL('../src/todo-store.mjs', import.meta.url).href;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.rename.bind(fs), root=${JSON.stringify(root)};
    let arrivals=0, releaseSecond, releaseFirst, nativeCollision;
    const secondArrived=new Promise(resolve=>{releaseSecond=resolve});
    const firstRenamed=new Promise(resolve=>{releaseFirst=resolve});
    fs.rename=async(from,to)=>{
      if(path.dirname(from)===root && to===path.join(root,'.lattice/todo')){
        if(++arrivals===1){
          await secondArrived; await rename(from,to); releaseFirst(); return;
        }
        releaseSecond(); await firstRenamed;
        try{return await rename(from,to)}catch(error){
          nativeCollision={code:error.code,syscall:error.syscall,path:error.path,dest:error.dest};
          throw error;
        }
      }
      return rename(from,to);
    };
    syncBuiltinESMExports();
    const {initializeAuthoredTodoStore}=await import(${JSON.stringify(storeModule)});
    const input=${JSON.stringify(initial(root))};
    const results=await Promise.allSettled([initializeAuthoredTodoStore(input),initializeAuthoredTodoStore(input)]);
    const loser=results.find(result=>result.status==='rejected')?.reason;
    console.log(JSON.stringify({winners:results.filter(result=>result.status==='fulfilled').length,
      loser:loser&&{code:loser.code,detail:loser.detail,stack:loser.stack,syscall:loser.syscall,
        path:loser.path,dest:loser.dest},nativeCollision}));
  `], { timeout: 15_000, encoding: 'utf8' }));
  const diagnostic = JSON.stringify(result, null, 2);
  assert.equal(result.winners, 1, diagnostic);
  assert.equal(result.loser.code, 'STORE_WRITE_CONFLICT', diagnostic);
  assert.equal(result.loser.detail.reason, 'store_bootstrap_raced', diagnostic);
  assert.equal(result.nativeCollision.syscall, 'rename', diagnostic);
  t.diagnostic(`native directory collision: ${result.nativeCollision.code} via ${result.nativeCollision.syscall}`);
  assert.equal((await readTodoStore({ repoRoot: root })).members.length, 1);
});

test('builder forwards common diagnosis while keeping its TypeError/message and optional field absence', () => {
  const seed = plan();
  seed.tasks[0].phase_id = 'missing';
  assert.throws(() => buildTodoPlan(seed), (error) => error instanceof TypeError
    && error.message === 'todo plan input violates its declared schema'
    && error.detail.violation_kind === 'unknown_phase_reference'
    && error.detail.pointer === '/tasks/0/phase_id'
    && !Object.hasOwn(error.detail, 'expected') && !Object.hasOwn(error.detail, 'actual'));
});

test('callback ENOENT stays unchanged, while missing publication primitives map to retryable lock contention', async (t) => {
  const root = await fixture(t);
  const missing = Object.assign(new Error('callback file disappeared'), { code: 'ENOENT' });
  await assert.rejects(appendAuthoredTodoPlan(request(root, { onProtocolStage(stage) {
    if (stage === 'manifest_validated') throw missing;
  } })), (error) => error === missing);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    fs.link = async () => { throw Object.assign(new Error('parent vanished'),{code:'ENOENT'}); };
    syncBuiltinESMExports();
    const {withStoreLock}=await import(${JSON.stringify(lockModule)});
    await assert.rejects(withStoreLock({lockPath:${JSON.stringify(path.join(root, '.lattice/todo/.write.lock'))},
      createParent:false},()=>assert.fail('entered')),
      error=>error.reason==='store_locked' && error.detail.cause==='lock_parent_missing'
        && error.detail.next_action.includes('initialization'));
  `], { timeout: 15_000 });
});

test('a new live lock after residue release refuses rmdir without deleting its owner', async (t) => {
  const root = await fixture(t, false);
  const lockPath = path.join(root, '.lattice/todo/.write.lock');
  let owner;
  await withStoreLock({ lockPath }, async () => { owner = await readFile(lockPath); });
  await assert.rejects(initializeAuthoredTodoStore(initial(root, { onProtocolStage: async (stage) => {
    if (stage === 'authoring_residue_released') await writeFile(lockPath, owner);
  } })), reason('STORE_WRITE_CONFLICT', 'store_locked'));
  assert.deepEqual(await readFile(lockPath), owner);
});

test('a replaced private staging directory is preserved during failed initialization cleanup', async (t) => {
  const root = await fixture(t, false);
  const storeModule = new URL('../src/todo-store.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.rename.bind(fs);
    let replaced;
    fs.rename=async(from,to)=>{
      if(path.dirname(from)===${JSON.stringify(root)} && path.basename(from).startsWith('.lattice-todo-authoring-')){
        await rename(from,from+'-saved'); await fs.mkdir(from);
        await fs.writeFile(path.join(from,'operator.txt'),'preserve'); replaced=from;
        throw new Error('stage_replaced');
      }
      return rename(from,to);
    };
    syncBuiltinESMExports();
    const {initializeAuthoredTodoStore}=await import(${JSON.stringify(storeModule)});
    await assert.rejects(initializeAuthoredTodoStore(${JSON.stringify(initial(root))}),/stage_replaced/);
    assert.equal(await fs.readFile(path.join(replaced,'operator.txt'),'utf8'),'preserve');
  `], { timeout: 15_000 });
});
