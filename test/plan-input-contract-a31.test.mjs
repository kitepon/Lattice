// a31: the seat's plan input matches the seat contract (0.85.2 walkthrough items 3-6).
// scope-review accepts the v5 template and computes both digests; plan revise takes the same
// plan as plan create; a revise of an unknown plan_key points at plan create; goal/title
// refusals say where the plan's purpose lives.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lattice.mjs', import.meta.url));

async function workspace(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'lattice-a31-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const env = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_CONFIG_DIR: path.join(base, 'cfg') };
  delete env.FORCE_COLOR;
  const cli = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env });
  const write = async (name, value) => {
    await writeFile(path.join(root, name), `${JSON.stringify(value)}\n`);
    return name;
  };
  const printed = JSON.parse(cli(['plan', 'create', '--template', '--json']).stdout);
  // The template's memos are blank; the author writes them (memo-no-fabrication).
  const template = { ...printed, tasks: printed.tasks.map((task) => ({ ...task, design_memo: 'NO_PLAN' })) };
  await write('tpl.json', template);
  return { cli, write, template };
}

const refusal = (result) => JSON.parse(result.stderr);
const assessment = (taskId) => ({ task_id: taskId, work_spec_ids: ['W1'], judgment: 'required', reason: 'r' });

test('scope-reviewはv5のtemplateを受け、digestを機械が計算する（3）', async (t) => {
  const { cli, write, template } = await workspace(t);
  const review = {
    schema: 'lattice.plan_scope_review.v1',
    work_specs: [{ work_spec_id: 'W1', requirement: 'Do it.', acceptance: 'It works.' }],
    task_assessments: template.tasks.map(({ task_id: id }) => assessment(id)),
    verdict: 'scope_preserved',
  };
  const accepted = cli(['plan', 'scope-review', '--plan-input', 'tpl.json',
    '--review', await write('review.json', review), '--json']);
  assert.equal(accepted.status, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.authoring_schema, 'lattice.plan_create_input.v5');
  assert.equal(result.accepted, true);

  const wrong = refusal(cli(['plan', 'scope-review', '--plan-input',
    await write('tpl-digest.json', { ...template, input_digest: '0'.repeat(64) }), '--review', 'review.json', '--json']));
  assert.equal(wrong.detail.reason, 'authoring_digest_mismatch');
  assert.match(wrong.detail.expected, /^[0-9a-f]{64}$/u);
});

test('plan reviseはplan createと同じ形を受け、包みの形と無いplanを案内する（4・5）', async (t) => {
  const { cli, write, template } = await workspace(t);
  assert.equal(cli(['plan', 'create', '--input', 'tpl.json']).status, 0);
  const bare = await write('rev.json', {
    ...template, tasks: [...template.tasks, { task_id: 't4', title: 'Fourth', phase_id: 'p2', design_memo: 'NO_PLAN' }],
  });
  const revised = cli(['plan', 'revise', '--input', bare]);
  assert.equal(revised.status, 0, revised.stderr);
  assert.ok(JSON.parse(cli(['plan', 'show', 'repo', '--json']).stdout).tasks.some(({ task_id: id }) => id === 't4'));

  const wrapper = refusal(cli(['plan', 'revise', '--input', await write('w.json', { schema: 'x', desired: {} })]));
  assert.match(wrapper.detail.next_action, /same shape as `lattice plan create`.*"desired"/u);
  assert.match(cli(['plan', 'revise', '--help']).stdout, /"desired":<that plan>/u);

  const unknown = refusal(cli(['plan', 'revise', '--input', await write('new.json', { ...template, plan_key: 'newplan' })]));
  assert.equal(unknown.detail.reason, 'plan_not_active');
  assert.equal(unknown.detail.plan_key, 'newplan');
  assert.equal(unknown.detail.pointer, '/plan_key');
  assert.match(unknown.detail.next_action, /lattice plan create --input <file>/u);
});

test('plan createのgoal・titleの断りは、計画の目的を書く場所を言う（6）', async (t) => {
  const { cli, write, template } = await workspace(t);
  const refused = refusal(cli(['plan', 'create', '--input',
    await write('g.json', { ...template, title: 'T', goal: {} })]));
  assert.deepEqual(refused.detail.unexpected_keys, ['goal', 'title']);
  assert.match(refused.detail.next_action, /`goal` of `lattice plan backchain`/u);
});
