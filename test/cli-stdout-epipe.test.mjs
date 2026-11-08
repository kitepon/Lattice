import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { installPipeCloseGuard } from '../src/cli-stdio.mjs';
import { createTodoStoreWriter, initializeTodoStore } from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });

async function storeWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-cli-epipe-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{ plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
      plan_version: 'v1', predecessor_plan_digest: null, tasks: [task('T1'), task('T2')],
      hard_dependencies: [], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW } }] });
  return root;
}

/** Run the CLI with the stdout consumer closed before it can read anything. */
function runWithClosedStdout(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.destroy();
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function runCollected(cwd, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('consumerが先にpipeを閉じてもCLIは静かに終了する', async (t) => {
  const root = await storeWorkspace(t);
  const { code, stderr } = await runWithClosedStdout(root, ['todo', 'status', '--json']);
  assert.equal(stderr.includes('EPIPE'), false, `unexpected EPIPE report: ${stderr}`);
  assert.equal(code, 0);
});

test('通常実行のJSON出力とexit codeは変わらない', async (t) => {
  const root = await storeWorkspace(t);
  const { code, stdout } = await runCollected(root, ['todo', 'status', '--json']);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.schema, 'lattice.todo_status_result.v9');
  assert.equal(result.project_id, 'project-1');
});

test('storeが無い作業ディレクトリの失敗は握り潰されない', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-cli-epipe-bare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const { code } = await runCollected(root, ['todo', 'status', '--json']);
  assert.notEqual(code, 0);
});

test('guardはEPIPE以外のstream errorを素通しする', () => {
  const exits = [];
  const listeners = [];
  const stream = {
    on(event, listener) { listeners.push({ event, listener }); },
    off() {},
  };
  const remove = installPipeCloseGuard({ streams: [stream], exit: (code) => exits.push(code) });
  const [{ event, listener }] = listeners;
  assert.equal(event, 'error');
  listener({ code: 'EPIPE' });
  assert.deepEqual(exits, [0]);
  assert.throws(() => listener({ code: 'EACCES' }), (error) => error.code === 'EACCES');
  remove();
});
