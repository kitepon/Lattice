// ADR 0200: a plan declared `enforced` stops undeclared/stale/conflicting starts, untraceable done and unaudited heavy
// phase closes; each refusal has a self-exit, and other plans keep warnings only.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function refusal(root, args) {
  const result = run(root, args);
  assert.notEqual(result.status, 0, `${args.join(' ')} should refuse\n${result.stdout}`);
  return JSON.parse(result.stderr.trim().split('\n').at(-1));
}

async function fixture(context, mode = 'enforced') {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-adr0200-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  git('init', '--quiet');
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.lattice/\nplan.json\n');
  await mkdir(path.join(root, 'src'));
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(root, 'src', `${name}.js`), `export const ${name} = 1;\n`);
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev',
    phases: [{ phase_id: 'p', title: 'phase' }, { phase_id: 'q', title: 'light', gate_policy: 'light' }],
    tasks: [{ task_id: 'P', title: 'P', phase_id: 'p', design_memo: 'NO_PLAN' },
      { task_id: 'Q', title: 'Q', phase_id: 'p', design_memo: 'NO_PLAN' },
      { task_id: 'L', title: 'L', phase_id: 'q', design_memo: 'NO_PLAN' }],
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  success(root, ['todo', 'independence', 'mode', '--plan', 'dev', '--set', mode, '--reason', 'adr0200']);
  const commit = async (file) => {
    await appendFile(path.join(root, file), '// change\n');
    git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-am', `change ${file}`);
    return git('rev-parse', 'HEAD').trim();
  };
  return { root, commit };
}
const declare = (taskId, ...flags) => ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', taskId, ...flags];
const start = (taskId, ...flags) => ['todo', 'start', '--plan', 'dev', '--task', taskId, ...flags];

test('gate 1: an undeclared task does not start; declaring it is the way out', async (context) => {
  const { root } = await fixture(context);
  const refused = refusal(root, start('P'));
  assert.deepEqual([refused.code, refused.message], ['TODO_TRANSITION_REFUSED', 'enforced_witness_undeclared']);
  assert.match(refused.detail.next_action, /witness declare --plan dev --task P/u);
  success(root, declare('P', '--owns', 'src/a.js'));
  success(root, declare('Q', '--owns', 'src/b.js'));
  success(root, declare('L', '--owns', 'src/c.js'));
  assert.equal(success(root, start('P')).advisory.coverage, 'verified');
});

test('gate 2: a conflict with in-progress work stops start unless a reason is recorded', async (context) => {
  const { root } = await fixture(context);
  success(root, declare('P', '--owns', 'src/a.js'));
  success(root, declare('Q', '--owns', 'src/b.js', '--writes', 'src/a.js'));
  success(root, declare('L', '--owns', 'src/c.js'));
  success(root, start('P'));
  const refused = refusal(root, start('Q'));
  assert.equal(refused.message, 'enforced_conflict_with_active');
  assert.match(refused.detail.next_action, /dependency connect --from-plan dev --from-task P/u);
  success(root, start('Q', '--override-reason', 'pairing on a.js with P'));
});

test('gate 3: main moving under the declared files stops start until redeclared', async (context) => {
  const { root, commit } = await fixture(context);
  success(root, declare('P', '--owns', 'src/a.js'));
  success(root, declare('Q', '--owns', 'src/b.js'));
  success(root, declare('L', '--owns', 'src/c.js'));
  await commit('src/a.js');
  assert.equal(refusal(root, start('P')).message, 'enforced_witness_stale');
  success(root, declare('P', '--owns', 'src/a.js'));
  success(root, start('P'));
});

test('gate 4: done names the change (URL or a commit in HEAD)', async (context) => {
  const { root, commit } = await fixture(context);
  for (const [id, file] of [['P', 'src/a.js'], ['Q', 'src/b.js'], ['L', 'src/c.js']]) success(root, declare(id, '--owns', file));
  success(root, start('P'));
  const done = (...flags) => ['todo', 'done', '--plan', 'dev', '--task', 'P', ...flags];
  assert.equal(refusal(root, done()).message, 'enforced_done_reference_missing');
  assert.equal(refusal(root, done('--message', 'finished, see deadbeef1')).message, 'enforced_done_reference_missing');
  const sha = await commit('src/a.js'); // P's own file; Q's record stays fresh
  success(root, done('--message', `merged ${sha.slice(0, 8)}`));
  // A repeated done is unchanged, not re-gated.
  assert.equal(success(root, done()).unchanged, true);
  success(root, start('Q'));
  success(root, ['todo', 'done', '--plan', 'dev', '--task', 'Q', '--message', 'https://github.com/example/repo/pull/1']);
});

test('gate 5: a heavy phase is not closed unaudited; a light one is', async (context) => {
  const { root } = await fixture(context);
  for (const [id, file] of [['P', 'src/a.js'], ['Q', 'src/b.js'], ['L', 'src/c.js']]) success(root, declare(id, '--owns', file));
  for (const id of ['P', 'Q', 'L']) {
    success(root, start(id));
    success(root, ['todo', 'done', '--plan', 'dev', '--task', id, '--message', 'https://example.invalid/pr/1']);
  }
  // The guidance does not offer the close the gate refuses: only the heavy phase drops it.
  const pending = Object.fromEntries(success(root, ['todo', 'status', '--json']).audit_pending
    .map(({ phase_id: id, next_commands: commands }) => [id, commands.some((line) => line.includes('close-unaudited'))]));
  assert.deepEqual(pending, { p: false, q: true });
  const guidance = Object.fromEntries(success(root, ['todo', 'phase', 'status', '--plan', 'dev', '--json']).phases
    .map(({ phase_id: id, guidance: text }) => [id, text.includes('close-unaudited')]));
  assert.deepEqual(guidance, { p: false, q: true });
  assert.match(success(root, ['status', '--json']).next_action.command, /^lattice todo phase review --plan dev --phase p /u);
  const close = (phase) => ['todo', 'phase', 'close-unaudited', '--plan', 'dev', '--phase', phase, '--reason', 'skip'];
  assert.equal(refusal(root, close('p')).message, 'enforced_heavy_phase_unaudited');
  success(root, close('q'));
});

test('witness and conversation plans keep warnings only', async (context) => {
  for (const mode of ['witness', 'conversation']) {
    const { root } = await fixture(context, mode);
    success(root, start('P'));
    success(root, ['todo', 'done', '--plan', 'dev', '--task', 'P']);
  }
});

test('pull intake readiness accepts an enforced plan like a witness plan', async () => {
  const { pullIntakeReadinessGuidance } = await import('../src/todo-independence-guidance.mjs');
  const { coordination_mode: mode, ...enforced } = pullIntakeReadinessGuidance({ coordinationMode: 'enforced', ready: true });
  const { coordination_mode: _, ...witness } = pullIntakeReadinessGuidance({ coordinationMode: 'witness', ready: true });
  assert.equal(mode, 'enforced');
  assert.deepEqual(enforced, witness);
});
