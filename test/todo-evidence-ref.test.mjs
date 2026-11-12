// evidence-ref: evidence blobs Lattice writes are anchored under refs/lattice/evidence/<oid>, so gc keeps them;
// anchored is not committed, and `todo evidence anchor` protects evidence recorded before anchoring.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function success(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function unbornStore(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-evidence-ref-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: ['P', 'Q'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })),
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  const anchors = () => git('for-each-ref', '--format=%(refname)', 'refs/lattice/evidence/').split('\n').filter(Boolean);
  const prune = () => git('-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'gc', '--quiet', '--prune=now');
  return { root, git, anchors, prune };
}

test('message evidence is anchored on write, survives gc --prune=now, and still reads uncommitted', async (context) => {
  const { root, git, anchors, prune } = await unbornStore(context);
  for (const id of ['P', 'Q']) {
    success(root, ['todo', 'start', '--plan', 'dev', '--task', id]);
    success(root, ['todo', 'done', '--plan', 'dev', '--task', id, '--message', `done ${id}`]);
  }
  success(root, ['todo', 'phase', 'review', '--plan', 'dev', '--phase', 'p', '--reason', 'audit']);
  const accepted = success(root, ['todo', 'phase', 'accept', '--plan', 'dev', '--phase', 'p', '--message', 'Audited.']);
  assert.equal(accepted.decision_evidence_state, 'uncommitted');
  assert.equal(anchors().length, 3);
  prune();
  for (const ref of anchors()) git('cat-file', '-e', ref.slice('refs/lattice/evidence/'.length));
  const verified = success(root, ['todo', 'verify', '--json']);
  assert.deepEqual(verified.uncommitted_evidence.map(({ task_id: task, phase_id: phase, anchored }) => [task ?? phase, anchored]),
    [['P', true], ['Q', true], ['p', true]]);
  assert.match(verified.uncommitted_evidence[0].next_action, /^Commit /u);
  const [phase] = success(root, ['todo', 'phase', 'status', '--plan', 'dev', '--json']).phases;
  assert.equal(phase.decision_evidence_state, 'uncommitted');
});

test('todo evidence anchor protects older unanchored evidence and names evidence gc already pruned', async (context) => {
  const { root, git, anchors, prune } = await unbornStore(context);
  for (const id of ['P', 'Q']) {
    success(root, ['todo', 'start', '--plan', 'dev', '--task', id]);
    success(root, ['todo', 'done', '--plan', 'dev', '--task', id, '--message', `done ${id}`]);
  }
  // Evidence written before anchoring: drop both anchors; Q's blob is then pruned for good.
  const [first, second] = anchors();
  for (const ref of [first, second]) git('update-ref', '-d', ref);
  const items = success(root, ['todo', 'verify', '--json']).uncommitted_evidence;
  assert.deepEqual(items.map(({ anchored }) => anchored), [false, false]);
  assert.match(items[0].next_action, /lattice todo evidence anchor --json/u);
  const qOid = success(root, ['todo', 'show', '--plan', 'dev', '--task', 'Q', '--json']).state.evidence.git_blob_oid;
  const pOid = success(root, ['todo', 'show', '--plan', 'dev', '--task', 'P', '--json']).state.evidence.git_blob_oid;
  git('update-ref', `refs/lattice/evidence/${pOid}`, pOid);
  prune();
  git('update-ref', '-d', `refs/lattice/evidence/${pOid}`);
  const result = success(root, ['todo', 'evidence', 'anchor', '--json']);
  assert.equal(result.schema, 'lattice.todo_evidence_anchor_result.v1');
  assert.deepEqual(result.anchored, [{ plan_key: 'dev', task_id: 'P', git_blob_oid: pOid }]);
  assert.deepEqual(result.missing, [{ plan_key: 'dev', task_id: 'Q', git_blob_oid: qOid }]);
  const again = success(root, ['todo', 'evidence', 'anchor', '--json']);
  assert.deepEqual([again.anchored, again.already, again.missing.length], [[], 1, 1]);
});
