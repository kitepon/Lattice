// ob06: 工程の義務を機械が持つ面のE2E。
//
// v7・plan note・調整方式の宣言・逐次判定は互いに絡む。面ごとの単体greenだけでは
// 「statusとnote listと独立性投影が同じ答えを指す」が守れない（前campaign ap06と同じ理屈）。
//
// 本testが固定するのは:
// (a) plan note書込 → statusの`plan_notes` → `note list`の3面一致
// (b) 調整方式が未宣言 → 宣言 → 表出とguidanceの変化
// (c) 逐次判定: 候補提示（未判定）→ 判定の反映 → 残候補
// (d) **上記すべての操作でdispatchが動かない**（next_ready・dispatch_frontier・frontier_digest）
// (e) v9契約: 上位キーexact 15・result_digestの自証・旧形の拒否
//
// 実storeを実CLI（bin/lattice.mjs）で駆動する。publish前なのでinstalled CLIでは
// plan note（note chain v2）も調整方式（plan-scoped chain）も読めない——検証はrepo buildで行う。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { TODO_INDEPENDENCE_SCHEMA } from '../src/todo-independence-contracts.mjs';
import { validateTodoStatusResult } from '../src/todo-status.mjs';
import { readTodoStore, writeTodoIndependenceArtifact } from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR_ENV = {
  LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
  LATTICE_TODO_ACTOR_AGENT: 'agent-1',
};

function run(root, args, env = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', ...env };
  delete childEnv.FORCE_COLOR;
  const execution = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: childEnv });
  return execution;
}

function json(root, args, env = {}) {
  const execution = run(root, args, env);
  assert.equal(execution.status, 0, `${args.join(' ')}\n${execution.stdout}${execution.stderr}`);
  return JSON.parse(execution.stdout);
}

/** dispatchへ出る面だけを取り出す。(d)の不変はこの塊のbyte一致で見る。 */
const dispatchFacing = (status) => JSON.stringify({
  active_set: status.active_set, next_ready: status.next_ready,
  blocked: status.blocked, dispatch_frontier: status.dispatch_frontier,
});

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-obligations-e2e-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await mkdir(path.join(root, '.lattice'));
  // 判定記録が在るとstatusは鮮度判定にHEADを要求する。commitが1つも無いrepoでは
  // `git_head_unresolved`で落ちるので、fixtureは最初にcommitを1つ持つ。
  await writeFile(path.join(root, 'README.md'), '# obligations e2e\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e',
    'commit', '--quiet', '-m', 'init'], { cwd: root });

  const task = (taskId, title) => ({
    task_id: taskId, title, lane: 'main', design_memo: `${title}を実装し検証可能に記録する。`,
    narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null,
    phase_id: 'phase-1',
  });
  const input = {
    schema: 'lattice.plan_create_input.v4', project_id: 'obligations-project', plan_key: 'main',
    plan_version: 'v1', actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: [task('T1', '最初の仕事'), task('T2', '次の仕事')],
    phases: [{ phase_id: 'phase-1', title: '実装', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '',
  };
  input.input_digest = todoSelfDigest(input, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'plan.json'), `${canonicalizeTodoArtifact(input)}\n`);
  assert.equal(run(root, ['plan', 'create', '--input', '.lattice/plan.json']).status, 0);
  return root;
}

/** 実際にcompileされた記録と同じ形。判定の反映を、実sensorを引かずに作る。 */
async function recordJudgement(root, { conflicts = [], conflictResources = [] } = {}) {
  const store = await readTodoStore({ repoRoot: root });
  const { plan } = store.members[0];
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: plan.project_id, plan_key: plan.plan_key, plan_version: plan.plan_version,
    // 記録の鮮度は実HEADで判定される。固定SHAだとstale扱いになり、判定済みでも
    // 候補に残り続ける（＝「判定が入ると候補から消える」が検証できない）。
    topology_digest: plan.topology_digest,
    base_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    witness_set_digest: 'd'.repeat(64), compiled_at: '2026-07-26T00:00:00.000Z',
    task_ids: ['T1', 'T2'],
    task_boundaries: [{ task_id: 'T1', paths: ['src/t1.mjs'] }, { task_id: 'T2', paths: ['src/t2.mjs'] }],
    conflict_resources: conflictResources, conflicts, precedences: [], unknowns: [],
    wave_plan: { waves: [{ task_ids: ['T1', 'T2'] }], minimum_feasible_waves: 1 },
    outcome: 'compiled', result_digest: '',
  };
  artifact.scope_expanded = artifact.scope_expanded ?? (artifact.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact });
  return artifact;
}

test('(a) plan note書込・statusのplan_notes・note listの3面が同じ答えを指す', async (context) => {
  const root = await workspace(context);

  const before = json(root, ['todo', 'status', '--json']);
  assert.deepEqual(before.plan_notes, [], 'noteが1件も無いplanは欄ごと出ない');

  await writeFile(path.join(root, 'note.md'), '工程の申し送り: 実storeへは publish 後まで書かない。\n');
  const appended = json(root, ['todo', 'note', '--plan', 'main', '--input', 'note.md'], ACTOR_ENV);
  assert.equal(appended.scope, 'plan');

  const status = json(root, ['todo', 'status', '--json']);
  const listed = json(root, ['todo', 'note', 'list', '--plan', 'main', '--json']);

  assert.equal(status.plan_notes.length, 1);
  const [entry] = status.plan_notes;
  assert.equal(entry.plan_key, 'main');
  assert.equal(entry.count, 1);
  // 3面一致の芯: statusのheadと、note listのheadと、書込結果のdigestが同じ1件を指す。
  assert.equal(entry.plan_note_head_digest, listed.plan_note_head_digest);
  assert.equal(entry.latest[0].event_digest, entry.plan_note_head_digest);
  assert.equal(entry.latest[0].actor_agent, 'agent-1');
  // 本文はstatusへ載せない（capture limitを踏まないための設計）。取りに行く先が案内される。
  assert.ok(!JSON.stringify(status.plan_notes).includes('publish 後まで書かない'));
  assert.ok(entry.next_commands.some((command) => command.includes('note list --plan main')));
  // note list側は本文を持つ。案内されたコマンドが実際に本文へ辿り着く。
  assert.ok(listed.notes.some((note) => note.scope === 'plan' && note.body.includes('publish 後まで書かない')));
});

test('(b) 調整方式は未宣言から宣言へ動き、statusとguidanceが同時に変わる', async (context) => {
  const root = await workspace(context);

  const before = json(root, ['todo', 'status', '--json']);
  assert.deepEqual(before.coordination, [], '未宣言のplanは欄へ出ない（member_headsに居て、ここに居ない）');
  const beforeStart = json(root, ['todo', 'start', '--plan', 'main', '--task', 'T1', '--parallel-frontier'], ACTOR_ENV);
  assert.equal(beforeStart.advisory.guidance.code, 'coordination_mode_undeclared');
  assert.equal(beforeStart.advisory.guidance.next_action,
    'lattice todo independence mode --plan main --set <witness|conversation> --reason <text>');

  const declared = json(root, ['todo', 'independence', 'mode', '--plan', 'main',
    '--set', 'conversation', '--reason', '卓の会話で調整する'], ACTOR_ENV);
  assert.equal(declared.mode, 'conversation');

  const after = json(root, ['todo', 'status', '--json']);
  assert.equal(after.coordination.length, 1);
  assert.equal(after.coordination[0].mode, 'conversation');
  assert.equal(after.coordination[0].declared_by.agent, 'agent-1');
  assert.equal(after.coordination[0].reason, '卓の会話で調整する');

  // 案内も同時に変わる。選択を尊重して、witnessの督促を出さない。
  const afterStart = json(root, ['todo', 'start', '--plan', 'main', '--task', 'T2'], ACTOR_ENV);
  assert.equal(afterStart.advisory.guidance.code, 'coordination_conversation');
  assert.equal(afterStart.advisory.guidance.next_action, 'none');
});

test('(c) 逐次判定: 未判定が候補として出て、判定が入ると候補から消える', async (context) => {
  const root = await workspace(context);

  const unjudged = json(root, ['todo', 'status', '--json']);
  assert.equal(unjudged.parallel_candidates.length, 1);
  const [candidate] = unjudged.parallel_candidates;
  assert.equal(candidate.plan_key, 'main');
  assert.equal(candidate.coverage, 'missing');
  // 記録が無いplanこそこの欄が最も要る。飛ばすと「まだ誰も判定していない」が
  // 「判定する対象が無い」と同じ顔になる。
  assert.deepEqual(candidate.unjudged_task_ids, ['T1', 'T2']);
  assert.deepEqual(candidate.verified_parallel_groups, []);
  assert.ok(candidate.next_commands.length > 0);
  assert.ok(candidate.next_commands.some((command) => command.includes('independence compile')));

  await recordJudgement(root);

  const judged = json(root, ['todo', 'status', '--json']);
  const [after] = judged.parallel_candidates;
  assert.notEqual(after.coverage, 'missing', '記録が入れば未判定ではない');
  assert.deepEqual(after.unjudged_task_ids, [], '判定が入った分は候補から消える');
  assert.deepEqual(after.verified_parallel_groups, [{ task_ids: ['T1', 'T2'] }]);
});

test('(d) note書込・方式宣言・判定記録のどれもdispatchを動かさない', async (context) => {
  const root = await workspace(context);
  const baseline = json(root, ['todo', 'status', '--json']);
  assert.deepEqual(baseline.next_ready.map(({ task_id: id }) => id), ['T1', 'T2']);

  await writeFile(path.join(root, 'note.md'), '工程の申し送り。\n');
  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--input', 'note.md'], ACTOR_ENV).status, 0);
  const afterNote = json(root, ['todo', 'status', '--json']);

  assert.equal(run(root, ['todo', 'independence', 'mode', '--plan', 'main',
    '--set', 'witness', '--reason', '宣言して並列する'], ACTOR_ENV).status, 0);
  const afterMode = json(root, ['todo', 'status', '--json']);

  await recordJudgement(root, {
    conflictResources: [{ resource_id: 'src/shared.mjs', kind: 'path', target: 'src/shared.mjs' }],
    conflicts: [{ task_ids: ['T1', 'T2'], resource_id: 'src/shared.mjs' }],
  });
  const afterJudgement = json(root, ['todo', 'status', '--json']);

  // 3つの操作すべてでdispatch面がbyte一致。判定結果が「競合あり」でも塞がらない
  // （ADR 0160のProtected behavior・ob04のanchorと同じ不変を、全操作へ広げる）。
  for (const [name, status] of [['note', afterNote], ['mode', afterMode], ['judgement', afterJudgement]]) {
    assert.equal(dispatchFacing(status), dispatchFacing(baseline), `${name}でdispatchが動いた`);
    assert.equal(status.dispatch_frontier.frontier_digest, baseline.dispatch_frontier.frontier_digest);
  }
  // vacuous対策: 3つの操作が実際に効いていることを、動いた側で確かめる。
  assert.equal(afterNote.plan_notes.length, 1);
  assert.equal(afterMode.coordination.length, 1);
  assert.deepEqual(afterJudgement.parallel_candidates[0].unjudged_task_ids, []);
});

test('(e) v9契約: 上位キーexact 15・result_digestの自証・旧形の拒否', async (context) => {
  const root = await workspace(context);
  const status = json(root, ['todo', 'status', '--json']);

  assert.equal(status.schema, 'lattice.todo_status_result.v9');
  assert.deepEqual(Object.keys(status), [
    'schema', 'project_id', 'active_set', 'next_ready', 'dispatch_frontier',
    'blocked', 'audit_pending', 'structure_finalization_pending', 'plan_notes',
    'coordination', 'parallel_candidates', 'cross_plan_findings',
    'member_heads', 'truncated', 'result_digest',
  ]);
  // 応答が自分で自分を証明する。消費者は再計算で検証できる。
  assert.equal(status.result_digest, todoSelfDigest(status, 'result_digest'));
  assert.equal(validateTodoStatusResult(status), true);

  // v5形（3欄が無い9キー）はexact検証で落ちる。欄の欠落を「無い」と読ませない。
  const v5Shaped = { ...status, schema: 'lattice.todo_status_result.v5' };
  delete v5Shaped.plan_notes; delete v5Shaped.coordination; delete v5Shaped.parallel_candidates;
  v5Shaped.scope_expanded = v5Shaped.scope_expanded ?? (v5Shaped.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  v5Shaped.result_digest = todoSelfDigest(v5Shaped, 'result_digest');
  assert.equal(validateTodoStatusResult(v5Shaped), false, '旧形はv7として受理しない');

  // 欄を1つ落としただけでも落ちる（exactの意味）。
  const missingOne = { ...status };
  delete missingOne.coordination;
  missingOne.scope_expanded = missingOne.scope_expanded ?? (missingOne.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  missingOne.result_digest = todoSelfDigest(missingOne, 'result_digest');
  assert.equal(validateTodoStatusResult(missingOne), false);
});
