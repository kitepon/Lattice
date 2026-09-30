// phase accept/rejectの入力を、commit済みの監査fileから機械が組み立てる入口（ADR 0181の下書き受理を
// phase判断へ広げたもの）。実CLIで、手計算の記述子や自己digestを一切書かずに監査を閉じられること、
// review前・複数slot・形違いの`--input`では次の一手を名指しして止まることを固定する。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendTodoEvent, buildTodoPlan, createTodoStoreWriter, initializeTodoStore,
} from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ACTOR_ENV = {
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
};

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null });

function run(root, args) {
  const env = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', ...ACTOR_ENV };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env });
}

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

function failed(result) {
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stderr.trim().split('\n').at(-1));
}

function git(root, ...args) {
  execFileSync('git', ['-c', 'user.email=a@example.invalid', '-c', 'user.name=a', ...args], { cwd: root });
}

/** 1 task・phase無しplan。taskをdoneにして暗黙terminal-audit Phaseをgate_readyにする。 */
async function gateReady(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-phase-evidence-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(path.join(root, '.lattice'), { recursive: true });
  const plan = buildTodoPlan({
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'audited', plan_version: 'v1',
    predecessor_plan_digest: null, tasks: [task('A')], hard_dependencies: [], joins: [],
  });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'work.md'), 'work evidence\n');
  await writeFile(path.join(root, 'docs', 'audit.md'), '# terminal audit\n\nverified.\n');
  git(root, 'add', 'docs');
  git(root, 'commit', '--quiet', '-m', 'evidence');
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
    event: { kind: 'start', task_id: 'A', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  ok(run(root, ['todo', 'done', '--plan', 'audited', '--task', 'A', '--evidence', 'docs/work.md']));
  return root;
}

test('commit済みの監査fileだけでterminal-auditをacceptできる', async (context) => {
  const root = await gateReady(context);
  ok(run(root, ['todo', 'phase', 'review', '--plan', 'audited', '--phase', 'terminal-audit', '--reason', 'review']));
  const accepted = ok(run(root, ['todo', 'phase', 'accept', '--plan', 'audited', '--phase', 'terminal-audit',
    '--evidence', 'docs/audit.md']));
  assert.equal(accepted.kind, 'phase_accept');
  assert.equal(accepted.status, 'accepted');
  const phases = ok(run(root, ['todo', 'phase', 'status', '--plan', 'audited']));
  const serialized = JSON.stringify(phases);
  assert.match(serialized, /"accepted"/u);
  assert.match(serialized, /docs\/audit\.md/u);
});

test('rejectも--reasonと監査fileで記録できる', async (context) => {
  const root = await gateReady(context);
  ok(run(root, ['todo', 'phase', 'review', '--plan', 'audited', '--phase', 'terminal-audit', '--reason', 'review']));
  const rejected = ok(run(root, ['todo', 'phase', 'reject', '--plan', 'audited', '--phase', 'terminal-audit',
    '--reason', 'needs rework', '--evidence', 'docs/audit.md']));
  assert.equal(rejected.status, 'rejected');
});

test('review前の--evidenceはreviewを次の一手として名指しする', async (context) => {
  const root = await gateReady(context);
  const error = failed(run(root, ['todo', 'phase', 'accept', '--plan', 'audited', '--phase', 'terminal-audit',
    '--evidence', 'docs/audit.md']));
  assert.equal(error.code, 'PHASE_DECISION_INVALID');
  assert.equal(error.detail.reason, 'phase_not_reviewing');
  assert.match(error.detail.next_action, /todo phase review --plan audited --phase terminal-audit/u);
});

test('形の合わない--inputは期待形と--evidenceの案内を返す', async (context) => {
  const root = await gateReady(context);
  ok(run(root, ['todo', 'phase', 'review', '--plan', 'audited', '--phase', 'terminal-audit', '--reason', 'review']));
  await writeFile(path.join(root, '.lattice', 'accept.json'), '{ "schema": "lattice.phase_accept_input.v1" }\n');
  const error = failed(run(root, ['todo', 'phase', 'accept', '--plan', 'audited', '--phase', 'terminal-audit',
    '--input', '.lattice/accept.json']));
  assert.equal(error.code, 'PHASE_DECISION_INVALID');
  assert.match(error.detail.expected, /lattice\.phase_accept_input\.v1/u);
  assert.match(error.detail.next_action, /--evidence/u);
});

test('--inputと--evidenceの同時指定と、acceptへの--reasonはusage違反', async (context) => {
  const root = await gateReady(context);
  for (const args of [
    ['--input', 'x.json', '--evidence', 'docs/audit.md'],
    ['--reason', 'r', '--evidence', 'docs/audit.md'],
  ]) {
    const result = run(root, ['todo', 'phase', 'accept', '--plan', 'audited', '--phase', 'terminal-audit', ...args]);
    assert.notEqual(result.status, 0);
  }
});
