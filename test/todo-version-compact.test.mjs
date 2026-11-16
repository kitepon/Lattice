// b10-plan-copy-per-add: a superseded plan version keeps only its difference from its successor (compact.json), the rest of
// its history is rebuilt exactly, and a store written before the change is compacted by `todo compact`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gunzipSync, gzipSync } from 'node:zlib';

import { canonicalizeTodoArtifact } from '../src/todo-contracts.mjs';
import { readRetainedVersion, readTodoStore } from '../src/todo-store.mjs';
import {
  applyJsonPatch, buildVersionCompact, diffJson, readVersionCompact, reconstructPlan, validateVersionCompact,
} from '../src/todo-version-compact.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

test('diffJson/applyJsonPatch round-trip objects, scalars and spliced arrays', () => {
  const cases = [
    [{ a: 1, b: [1, 2, 3, 4], c: { d: 'x', e: [] } }, { a: 2, b: [1, 2, 9, 3, 4], c: { d: 'x', f: null } }],
    [{ list: [{ id: 1 }, { id: 2 }] }, { list: [{ id: 1 }] }],
    [{ list: [] }, { list: [{ id: 1 }, { id: 2 }] }],
    [{ v: 'a' }, { v: ['a'] }],
    [{ k: { n: 1 } }, { k: 3 }],
  ];
  for (const [from, to] of cases) {
    assert.equal(canonicalizeTodoArtifact(applyJsonPatch(from, diffJson(from, to))), canonicalizeTodoArtifact(to));
  }
  // one added list item is a one-element splice, not a copy of the list
  const patch = diffJson({ tasks: Array.from({ length: 500 }, (_, id) => ({ id })) },
    { tasks: [...Array.from({ length: 500 }, (_, id) => ({ id })), { id: 500 }] });
  assert.ok(JSON.stringify(patch).length < 80, JSON.stringify(patch));
});

test('a compact record refuses a tampered digest and a plan that is not the anchor\'s predecessor', () => {
  const retained = { project_id: 'p', plan_key: 'k', plan_version: 'rev-a', plan_digest: 'a'.repeat(64),
    predecessor_plan_digest: null, topology_digest: 'b'.repeat(64), tasks: [{ task_id: 't' }] };
  const anchor = { ...retained, plan_version: 'rev-b', plan_digest: 'c'.repeat(64), predecessor_plan_digest: retained.plan_digest,
    tasks: [{ task_id: 't' }, { task_id: 'u' }] };
  const record = buildVersionCompact({ retained, anchor, revision: null });
  assert.equal(validateVersionCompact(record), true);
  assert.deepEqual(reconstructPlan(record, anchor), retained);
  assert.equal(validateVersionCompact({ ...record, plan_digest: 'd'.repeat(64) }), false);
  assert.equal(buildVersionCompact({ retained, anchor: { ...anchor, predecessor_plan_digest: 'e'.repeat(64) }, revision: null }), null);
  assert.throws(() => reconstructPlan(record, { ...anchor, plan_digest: 'f'.repeat(64) }), /compact_anchor_mismatch/u);
});

test('every revision after the first keeps only a compact record; history rebuilds exactly; todo compact finishes a legacy store', { timeout: 240000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-version-compact-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  const run = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26,
      env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
        LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr.slice(0, 600)}\n${result.stdout.slice(0, 600)}`);
    return JSON.parse(result.stdout);
  };
  const ids = Array.from({ length: 120 }, (_, index) => `t${String(index).padStart(3, '0')}`);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'big', phases: [{ phase_id: 'ph', title: 'phase' }],
    tasks: ids.map((id) => ({ task_id: id, title: id, phase_id: 'ph', lane: 'bot-c', design_memo: `NO_PLAN ${'m'.repeat(200)}` })),
    hard_dependencies: ids.slice(1).map((id, index) => ({ from: { task_id: ids[index] }, to: { task_id: id } })), joins: [],
  }));
  run(['plan', 'create', '--input', 'plan.json']);
  run(['todo', 'note', '--plan', 'big', '--task', 't000', '--message', 'written in the first version']);
  const planDirectory = path.join(root, '.lattice/todo/plans/big');
  const originals = new Map(); // version -> every file as first written
  const capture = async () => {
    const [member] = (await readTodoStore({ repoRoot: root })).members;
    const directory = path.join(planDirectory, member.plan.plan_version);
    const files = {};
    for (const name of ['plan.json', 'snapshot.json', 'revision.json', 'journal/active.jsonl']) {
      files[name] = await readFile(path.join(directory, name)).catch(() => null);
    }
    originals.set(member.plan.plan_version, { plan: member.plan, files });
    return member.plan.plan_version;
  };
  const first = await capture();
  for (let index = 0; index < 4; index += 1) {
    run(['todo', 'add', '--plan', 'big', '--task', `extra${index}`, '--title', `extra ${index}`, '--phase', 'ph', '--lane', 'bot-c',
      '--after', 't119', '--design-memo', 'NO_PLAN']);
    await capture();
  }
  const [member] = (await readTodoStore({ repoRoot: root })).members;
  assert.equal(member.plan.tasks.length, 124);
  const retained = (await readdir(planDirectory)).filter((version) => version !== member.plan.plan_version);
  assert.equal(retained.length, 4);

  // Each superseded version holds a compact record and a packed journal, nothing else.
  const planBytes = (await stat(path.join(root, member.descriptor.plan_ref))).size;
  for (const version of retained) {
    const names = (await readdir(path.join(planDirectory, version), { recursive: true })).sort();
    assert.deepEqual(names, ['compact.json.gz', 'journal', path.join('journal', 'active.jsonl.gz')], version);
    assert.ok((await stat(path.join(planDirectory, version, 'compact.json.gz'))).size < planBytes / 4, version);
  }

  // History is exact: plan, revision and journal of every retained version come back byte for byte.
  const verifyHistory = async (label) => {
    for (const version of retained) {
      const original = originals.get(version);
      const rebuilt = await readRetainedVersion(root, '.lattice/todo/plans/big', version, member.plan);
      assert.equal(canonicalizeTodoArtifact(rebuilt.plan), canonicalizeTodoArtifact(original.plan), `${label} plan ${version}`);
      if (version !== first) {
        const expected = JSON.parse(original.files['revision.json'].toString('utf8'));
        assert.ok(expected.task_migration.length > 0);
        assert.equal(canonicalizeTodoArtifact(rebuilt.revision), canonicalizeTodoArtifact(expected), `${label} revision ${version}`);
      }
    }
    for (const version of retained) {
      const packed = await readFile(path.join(planDirectory, version, 'journal', 'active.jsonl.gz'));
      assert.ok(gunzipSync(packed).equals(originals.get(version).files['journal/active.jsonl']), `${label} journal ${version}`);
    }
    // a note written in the first version still reaches the task through every compacted revision (note migrations)
    const shown = run(['todo', 'show', '--plan', 'big', '--task', 't000', '--json']);
    assert.ok(shown.note_context.notes.some(({ body }) => body === 'written in the first version'), `${label} note`);
    assert.equal(run(['todo', 'verify', '--json']).schema, 'lattice.todo_verify_result.v4');
  };
  await verifyHistory('hook');

  // A store written before this change: put every superseded version's own files back, drop the records, sweep.
  for (const version of retained) {
    const directory = path.join(planDirectory, version);
    await rm(path.join(directory, 'compact.json.gz'));
    await rm(path.join(directory, 'journal', 'active.jsonl.gz'));
    for (const [name, bytes] of Object.entries(originals.get(version).files)) if (bytes !== null) await writeFile(path.join(directory, name), bytes);
  }
  assert.equal(run(['todo', 'verify', '--json']).schema, 'lattice.todo_verify_result.v4');
  const swept = run(['todo', 'compact', '--json']);
  assert.deepEqual(swept.plans, [{ plan_key: 'big', compacted: 4, stopped: null, next_version: null }]);
  assert.deepEqual(run(['todo', 'compact', '--json']).plans, [{ plan_key: 'big', compacted: 0, stopped: null, next_version: null }]);
  await verifyHistory('sweep');

  // Bounded sweep: --limit stops early and a rerun finishes.
  for (const version of retained) {
    const directory = path.join(planDirectory, version);
    await rm(path.join(directory, 'compact.json.gz'));
    await rm(path.join(directory, 'journal', 'active.jsonl.gz'));
    for (const [name, bytes] of Object.entries(originals.get(version).files)) if (bytes !== null) await writeFile(path.join(directory, name), bytes);
  }
  const part = run(['todo', 'compact', '--limit', '2', '--json']).plans[0];
  assert.deepEqual([part.compacted, part.stopped], [2, 'limit']);
  assert.deepEqual(run(['todo', 'compact', '--json']).plans[0].compacted, 2);
  await verifyHistory('limited sweep');

  // A cut-short compaction (record written, files not yet removed) is finished, not refused.
  const [version] = retained.filter((candidate) => candidate !== first);
  await writeFile(path.join(planDirectory, version, 'plan.json'), originals.get(version).files['plan.json']);
  assert.equal(run(['todo', 'compact', '--json']).plans[0].stopped, null);
  assert.deepEqual(await readdir(path.join(planDirectory, version)), ['compact.json.gz', 'journal']);
});

// w1-store-write-slow (ADR 0204 k4): a read of a retained version checks the record's shape only; writers and `todo verify` check all.
test('readVersionCompact: a read skips the canonical and digest checks, the default keeps them', async (context) => {
  const retained = { project_id: 'p', plan_key: 'k', plan_version: 'rev-a', plan_digest: 'a'.repeat(64),
    predecessor_plan_digest: null, topology_digest: 'b'.repeat(64), tasks: [{ task_id: 't' }] };
  const anchor = { ...retained, plan_version: 'rev-b', plan_digest: 'c'.repeat(64), predecessor_plan_digest: retained.plan_digest,
    tasks: [{ task_id: 't' }, { task_id: 'u' }] };
  const record = buildVersionCompact({ retained, anchor, revision: null });
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-compact-read-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const write = async (name, text) => {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'compact.json.gz'), gzipSync(Buffer.from(text, 'utf8')));
    return path.join(root, name);
  };
  const canonical = await write('canonical', `${canonicalizeTodoArtifact(record)}\n`);
  assert.deepEqual(await readVersionCompact(canonical), record);
  assert.deepEqual(await readVersionCompact(canonical, undefined, { verify: false }), record);
  // Same record, spaced JSON: not canonical.
  const spaced = await write('spaced', `${JSON.stringify(record, null, 1)}\n`);
  await assert.rejects(readVersionCompact(spaced), /compact_record_invalid/u);
  assert.deepEqual(await readVersionCompact(spaced, undefined, { verify: false }), record);
  // Wrong self digest: only the strict mode sees it. A wrong shape is refused in both.
  const tampered = await write('tampered', `${canonicalizeTodoArtifact({ ...record, plan_digest: 'd'.repeat(64) })}\n`);
  await assert.rejects(readVersionCompact(tampered), /compact_record_invalid/u);
  assert.equal((await readVersionCompact(tampered, undefined, { verify: false })).plan_digest, 'd'.repeat(64));
  const shapeless = await write('shapeless', `${canonicalizeTodoArtifact({ ...record, extra: 1 })}\n`);
  await assert.rejects(readVersionCompact(shapeless, undefined, { verify: false }), /compact_record_invalid/u);
  assert.equal(await readVersionCompact(path.join(root, 'absent')), null);
});
