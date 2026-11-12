// anchor-says-uninitialized: a project with no Store yet answers "uninitialized" like `status`, never
// STORE_INCONSISTENT/artifact_missing, which invites repair or deletion. A Store that exists but lost its
// manifest still answers STORE_INCONSISTENT.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { todoSelfDigest } from '../src/todo-contracts.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const CREATE = 'lattice plan create --template --json';

function run(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
  return { status: result.status, stdout: result.stdout, error: result.stderr ? JSON.parse(result.stderr) : null };
}

async function gitRoot(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-store-uninit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  return root;
}

const READS = [
  ['todo', 'show', '--plan', 'dev', '--task', 'P', '--json'],
  ['todo', 'verify', '--json'],
  ['todo', 'notice', 'list', '--json'],
  ['todo', 'start', '--plan', 'dev', '--task', 'P'],
];

test('no Store yet: anchor is a no-op success and every other todo command says uninitialized', async (context) => {
  const root = await gitRoot(context);
  for (const layout of ['absent', 'empty directory']) {
    if (layout === 'empty directory') await mkdir(path.join(root, '.lattice', 'todo'), { recursive: true });
    const anchor = run(root, ['todo', 'evidence', 'anchor', '--json']);
    assert.equal(anchor.status, 0, layout);
    const result = JSON.parse(anchor.stdout);
    assert.deepEqual({ ...result, result_digest: null }, {
      schema: 'lattice.todo_evidence_anchor_uninitialized.v1', anchored: [], already: 0, missing: [],
      next_actions: [CREATE, 'lattice plan create --input <file>'], result_digest: null,
    }, layout);
    assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));
    for (const args of READS) {
      const refused = run(root, args);
      assert.notEqual(refused.status, 0, args.join(' '));
      assert.equal(refused.error.code, 'STORE_UNINITIALIZED', `${layout}: ${args.join(' ')}`);
      assert.equal(refused.error.detail.next_action, CREATE, args.join(' '));
    }
    // display-says-uninitialized: display read stays a state (unavailable) and source an observation (exit 0).
    const source = run(root, ['todo', 'display', 'source', '--json']);
    assert.equal(source.status, 0, layout);
    assert.deepEqual({ ...JSON.parse(source.stdout), repository_identity: null }, {
      schema: 'lattice.todo_store_display_source.v1', repository_identity: null, project_id: null,
      manifest_digest: null, members: [],
      diagnostics: [{ plan_key: null, field: 'manifest', code: 'STORE_UNINITIALIZED', reason: 'store_uninitialized' }],
    }, layout);
    const read = run(root, ['todo', 'display', 'read', '--json']);
    assert.equal(read.status, 0, layout);
    const display = JSON.parse(read.stdout);
    assert.equal(display.state, 'unavailable', layout);
    assert.deepEqual(display.inconsistency, { code: 'STORE_UNINITIALIZED',
      detail: { reason: 'store_uninitialized', ref: '.lattice/todo', next_action: CREATE } }, layout);
    if (layout === 'absent') await assert.rejects(lstat(path.join(root, '.lattice')), { code: 'ENOENT' });
  }
});

test('a Store that exists but lost its manifest stays STORE_INCONSISTENT/artifact_missing', async (context) => {
  const root = await gitRoot(context);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: [{ task_id: 'P', title: 'P', phase_id: 'p', design_memo: 'NO_PLAN' }],
  }));
  assert.equal(run(root, ['plan', 'create', '--input', 'plan.json']).status, 0);
  await rm(path.join(root, '.lattice', 'todo', 'manifest.json'));
  for (const args of [['todo', 'evidence', 'anchor', '--json'], ...READS]) {
    const refused = run(root, args);
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.equal(refused.error.code, 'STORE_INCONSISTENT', args.join(' '));
    assert.equal(refused.error.detail.reason, 'artifact_missing', args.join(' '));
    assert.equal(refused.error.detail.ref, '.lattice/todo/manifest.json', args.join(' '));
  }
  const source = run(root, ['todo', 'display', 'source', '--json']);
  assert.equal(source.status, 1);
  assert.deepEqual([source.error.code, source.error.detail.reason], ['STORE_INCONSISTENT', 'artifact_missing']);
  const display = JSON.parse(run(root, ['todo', 'display', 'read', '--json']).stdout);
  assert.equal(display.state, 'unavailable');
  assert.deepEqual([display.inconsistency.code, display.inconsistency.detail.reason], ['STORE_INCONSISTENT', 'artifact_missing']);
});
