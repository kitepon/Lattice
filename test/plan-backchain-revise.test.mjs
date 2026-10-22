import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BIN = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const actor = { host: 'fixture', session: 'fixture', agent: 'fixture' };
const ref = (taskId) => ({ project_id: 'example', plan_key: 'search', task_id: taskId });

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-backchain-revise-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# 索引の受入証拠\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_RUNTIME_ERROR_REPORTING: '0', NO_COLOR: '1',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture',
      LATTICE_TODO_ACTOR_AGENT: 'fixture',
    },
  });
}

function plan({ revised = false } = {}) {
  const tasks = [
    { task_id: 'index', title: '索引', lane: 'implementation', design_memo: '文書を索引に登録する。',
      narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'delivery' },
    { task_id: 'search', title: '検索', lane: 'implementation', design_memo: '結果を表示する。',
      narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'delivery' },
  ];
  if (revised) tasks.unshift({ task_id: 'export', title: '持出し', lane: 'implementation',
    design_memo: '結果を書き出す。', narrative_ref: null, narrative_anchor: null,
    compile_binding: null, parent_task_id: null, phase_id: 'delivery' });
  return {
    schema: 'lattice.plan_create_input.v4', project_id: 'example', plan_key: 'search',
    plan_version: revised ? 'v2' : 'v1', actor, recorded_at: new Date().toISOString(),
    tasks, phases: [{ phase_id: 'delivery', title: '利用可能にする', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [
      { from: ref('index'), to: ref('search') },
      ...(revised ? [{ from: ref('search'), to: ref('export') }] : []),
    ], joins: [], phase_accept_dependencies: [],
  };
}

function chain({ revised = false, continuity = undefined } = {}) {
  return {
    schema: 'lattice.plan_backchain.v1', authoring_ref: revised ? 'plan-v2.json' : 'plan-v1.json',
    project_id: 'example', plan_key: 'search', plan_version: revised ? 'v2' : 'v1',
    goal: { purpose: revised ? '利用者が検索結果を持ち出せるようにする。' : '必要な文書を見つける。',
      outcome: revised ? '結果をファイルに書き出せる。' : '検索結果から文書へ到達する。',
      acceptance: revised ? '検索結果を保存して読める。' : '対象文書を開ける。',
      required_feature_ids: [revised ? 'export' : 'results'] },
    features: [
      { feature_id: 'index', capability: '文書を索引に載せる', acceptance: '検索対象に入る',
        requires_feature_ids: [], provider: { kind: 'task', task_id: 'index' } },
      { feature_id: 'results', capability: '検索結果を示す', acceptance: '文書を開ける',
        requires_feature_ids: ['index'], provider: { kind: 'task', task_id: 'search' } },
      ...(revised ? [{ feature_id: 'export', capability: '結果を保存する', acceptance: '保存した結果を読める',
        requires_feature_ids: ['results'], provider: { kind: 'task', task_id: 'export' } }] : []),
    ],
    tasks: [
      ...(revised ? [{ task_id: 'export', requires_feature_ids: ['results'],
        provides_feature_ids: ['export'] }] : []),
      { task_id: 'index', requires_feature_ids: [], provides_feature_ids: ['index'] },
      { task_id: 'search', requires_feature_ids: ['index'], provides_feature_ids: ['results'] },
    ],
    ...(continuity === undefined ? {} : { continuity }),
  };
}

async function createAndFinishIndex(context, { finish = true } = {}) {
  const root = await fixture(context);
  await writeFile(path.join(root, 'plan-v1.json'), `${JSON.stringify(plan())}\n`);
  await writeFile(path.join(root, 'chain-v1.json'), `${JSON.stringify(chain())}\n`);
  const created = run(root, ['plan', 'backchain', '--input', 'chain-v1.json', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const started = run(root, ['todo', 'start', '--plan', 'search', '--task', 'index']);
  assert.equal(started.status, 0, started.stderr);
  if (finish) {
    const done = run(root, ['todo', 'done', '--plan', 'search', '--task', 'index',
      '--evidence', 'evidence.md']);
    assert.equal(done.status, 0, done.stderr);
  }
  return root;
}

test('ゴール変更で新機能・工程を追加しても無関係な完了を後継版へ残す', async (context) => {
  const root = await createAndFinishIndex(context);
  await writeFile(path.join(root, 'plan-v2.json'), `${JSON.stringify(plan({ revised: true }))}\n`);
  await writeFile(path.join(root, 'chain-v2.json'), `${JSON.stringify(chain({ revised: true }))}\n`);
  const preview = run(root, ['plan', 'backchain', '--input', 'chain-v2.json', '--dry-run', '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  const migration = JSON.parse(preview.stdout).task_migration;
  assert.equal(migration.find(({ from_task_id: id }) => id === 'index').state_policy,
    'carry_reconciled_metadata');
  const revised = run(root, ['plan', 'backchain', '--input', 'chain-v2.json', '--json']);
  assert.equal(revised.status, 0, revised.stderr);
  const result = JSON.parse(revised.stdout);
  assert.equal(result.authoring_result.schema, 'lattice.phase_todo_revise_result.v1');
  assert.match(result.plan_version, /^rev-/u);
  const index = run(root, ['todo', 'show', '--plan', 'search', '--task', 'index', '--json']);
  assert.equal(index.status, 0, index.stderr);
  const indexDetail = JSON.parse(index.stdout);
  assert.equal(indexDetail.state.status, 'done');
  assert.equal(indexDetail.feature_context.goal.purpose, '利用者が検索結果を持ち出せるようにする。');
  const exported = run(root, ['todo', 'show', '--plan', 'search', '--task', 'export', '--json']);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).state.status, 'pending');
  const verified = run(root, ['todo', 'verify', '--plan', 'search', '--json']);
  assert.equal(verified.status, 0, verified.stderr);
});

test('機能定義が変わってもAIの明示理由で完了を保持できる', async (context) => {
  const root = await createAndFinishIndex(context);
  const revised = chain({ revised: true, continuity: [
    { task_id: 'index', policy: 'carry', reason: '既存の索引実装は変更後の受入条件も満たす。' },
  ] });
  revised.features.find(({ feature_id }) => feature_id === 'index').acceptance = '新形式も検索対象に入る';
  await writeFile(path.join(root, 'plan-v2.json'), `${JSON.stringify(plan({ revised: true }))}\n`);
  await writeFile(path.join(root, 'chain-v2.json'), `${JSON.stringify(revised)}\n`);
  const result = run(root, ['plan', 'backchain', '--input', 'chain-v2.json', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const detail = run(root, ['todo', 'show', '--plan', 'search', '--task', 'index', '--json']);
  assert.equal(detail.status, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout).state.status, 'done');
});

test('機能の受入条件が変わり判断を明示しない時は、その工程を再実行対象にする', async (context) => {
  const root = await createAndFinishIndex(context);
  const revised = chain({ revised: true });
  revised.features.find(({ feature_id }) => feature_id === 'index').acceptance = '新形式も検索対象に入る';
  await writeFile(path.join(root, 'plan-v2.json'), `${JSON.stringify(plan({ revised: true }))}\n`);
  await writeFile(path.join(root, 'chain-v2.json'), `${JSON.stringify(revised)}\n`);
  const result = run(root, ['plan', 'backchain', '--input', 'chain-v2.json', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const detail = run(root, ['todo', 'show', '--plan', 'search', '--task', 'index', '--json']);
  assert.equal(detail.status, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout).state.status, 'pending');
});

test('ゴールから不要になった工程を退役させ、残る完了を保つ', async (context) => {
  const root = await createAndFinishIndex(context);
  const updatedPlan = plan();
  updatedPlan.plan_version = 'v2';
  updatedPlan.tasks = updatedPlan.tasks.filter(({ task_id: id }) => id === 'index');
  updatedPlan.hard_dependencies = [];
  const updatedChain = chain();
  updatedChain.plan_version = 'v2';
  updatedChain.authoring_ref = 'plan-v2.json';
  updatedChain.goal = {
    purpose: '文書を検索できる状態に保つ。', outcome: '文書の索引がある。',
    acceptance: '対象文書が索引に登録される。', required_feature_ids: ['index'],
  };
  updatedChain.features = updatedChain.features.filter(({ feature_id: id }) => id === 'index');
  updatedChain.tasks = updatedChain.tasks.filter(({ task_id: id }) => id === 'index');
  await writeFile(path.join(root, 'plan-v2.json'), `${JSON.stringify(updatedPlan)}\n`);
  await writeFile(path.join(root, 'chain-v2.json'), `${JSON.stringify(updatedChain)}\n`);
  const revised = run(root, ['plan', 'backchain', '--input', 'chain-v2.json', '--json']);
  assert.equal(revised.status, 0, revised.stderr);
  const detail = run(root, ['todo', 'show', '--plan', 'search', '--task', 'index', '--json']);
  assert.equal(detail.status, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout).state.status, 'done');
  const active = run(root, ['plan', 'show', 'search', '--json']);
  assert.equal(active.status, 0, active.stderr);
  assert.deepEqual(JSON.parse(active.stdout).tasks.map(({ task_id: id }) => id), ['index']);
  assert.equal(run(root, ['todo', 'verify', '--plan', 'search', '--json']).status, 0);
});

test('作業中にゴールが変わっても着手束縛を新しい版へ移し、再試行で版を増やさない', async (context) => {
  const root = await createAndFinishIndex(context, { finish: false });
  await writeFile(path.join(root, 'plan-v2.json'), `${JSON.stringify(plan({ revised: true }))}\n`);
  await writeFile(path.join(root, 'chain-v2.json'), `${JSON.stringify(chain({ revised: true }))}\n`);
  const revised = run(root, ['plan', 'backchain', '--input', 'chain-v2.json', '--json']);
  assert.equal(revised.status, 0, revised.stderr);
  const first = JSON.parse(revised.stdout);
  assert.deepEqual(first.rebound_task_ids, ['index']);
  const detail = run(root, ['todo', 'show', '--plan', 'search', '--task', 'index', '--json']);
  assert.equal(detail.status, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout).state.status, 'in-progress');
  const retried = run(root, ['plan', 'backchain', '--input', 'chain-v2.json', '--json']);
  assert.equal(retried.status, 0, retried.stderr);
  const second = JSON.parse(retried.stdout);
  assert.equal(second.authoring_result.schema, 'lattice.plan_backchain_unchanged.v1');
  assert.equal(second.plan_version, first.plan_version);
  assert.deepEqual(second.rebound_task_ids, []);
  assert.equal(run(root, ['todo', 'verify', '--plan', 'search', '--json']).status, 0);
});
