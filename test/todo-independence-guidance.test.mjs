import assert from 'node:assert/strict';
import test from 'node:test';

import * as guidanceModule from '../src/todo-independence-guidance.mjs';

import {
  SEAM_PROPOSAL_GUIDANCE_CODES,
  TODO_INDEPENDENCE_GUIDANCE_CODES,
  TODO_INDEPENDENCE_WORKFLOW,
  selectIndependenceGuidance,
  selectSeamProposalGuidance,
  scopeExpansionRecommendations,
  todoIndependenceGuidance,
  selectWitnessScaffoldGuidance,
} from '../src/todo-independence-guidance.mjs';

// ADR 0130。案内の単一正本。事実と次の一歩だけを述べ、指示しない。

const ALL_CODES = [...TODO_INDEPENDENCE_GUIDANCE_CODES, ...SEAM_PROPOSAL_GUIDANCE_CODES];

test('全codeが説明と次の一歩を持つ', () => {
  for (const code of ALL_CODES) {
    const guidance = todoIndependenceGuidance(code);
    assert.equal(guidance.code, code);
    assert.ok(guidance.message.length > 0, `${code} has no message`);
    assert.ok(guidance.next_action.length > 0, `${code} has no next_action`);
  }
});

test('未知のcodeは黙って通さない', () => {
  assert.throws(() => todoIndependenceGuidance('probably_fine'), TypeError);
});

test('記録がある未検証も助言のままで、start拒否の入口はもう無い（u03 B1-B6）', () => {
  assert.equal(guidanceModule.independenceStartRefusal, undefined);
  assert.equal(guidanceModule.INDEPENDENCE_START_REFUSAL_CODES, undefined);
  // 旧拒否の5 codeは助言として残り、本文は「startは拒否する」と言わない。
  for (const code of [
    'independence_task_undeclared', 'independence_stale_for_task', 'independence_superseded',
    'independence_contract_superseded', 'independence_verdicts_absent',
  ]) {
    assert.ok(TODO_INDEPENDENCE_GUIDANCE_CODES.includes(code), code);
    assert.doesNotMatch(todoIndependenceGuidance(code).message, /拒否/u, code);
  }
});

test('宣言膨張は既知の回数だけを分割検討の助言へ写す', () => {
  const recommendations = scopeExpansionRecommendations([
    {
      task_id: 'tip-z', growth_events: 1, first_seen_path_count: 2,
      path_count: 3, gate_shape: false,
    },
    {
      task_id: 'tip-gate', growth_events: 2, first_seen_path_count: 1,
      path_count: 4, gate_shape: true,
    },
    {
      task_id: 'tip-first', growth_events: 0, first_seen_path_count: 2,
      path_count: 2, gate_shape: false,
    },
    {
      task_id: 'tip-unknown', growth_events: null, first_seen_path_count: null,
      path_count: 5, gate_shape: true,
    },
  ]);

  assert.deepEqual(recommendations.map(({ task_id: taskId }) => taskId), ['tip-gate', 'tip-z']);
  assert.deepEqual(recommendations[0], {
    code: 'scope_expanded_consider_split',
    task_id: 'tip-gate',
    growth_events: 2,
    first_seen_path_count: 1,
    path_count: 4,
    gate_shape: true,
    message: '宣言が2回膨張している。このtaskは依存の合流点であり、内側にgateのリストが生えているなら、A1..Anと残余A\'への分割を検討できる。',
    next_action: 'consider_todo_split',
  });
  assert.match(recommendations[1].message, /宣言が1回膨張/u);
  assert.throws(() => scopeExpansionRecommendations(null), TypeError);
});

test('案内は命令形にならない（判断はhostが所有する）', () => {
  for (const code of ALL_CODES) {
    const { message } = todoIndependenceGuidance(code);
    // 「〜すべき」「〜しなさい」「〜してください」はLatticeがdispatchを統制する言い方になる。
    assert.doesNotMatch(message, /すべき|しなさい|してください|must|should/u,
      `${code} reads as an instruction: ${message}`);
  }
});

test('conflictの案内は切断可能性で言い換えが変わる', () => {
  const seam = todoIndependenceGuidance('independence_conflict_with_active', {
    severability: 'code_seam',
  });
  const serial = todoIndependenceGuidance('independence_conflict_with_active', {
    severability: 'serial',
  });
  assert.match(seam.message, /refactorで並列化しうる/u);
  assert.match(serial.message, /分割では切り離せない/u);
  assert.notEqual(seam.message, serial.message);
  // 同じ状況なのでcodeとnext_actionは共有する。
  assert.equal(seam.code, serial.code);
  assert.equal(seam.next_action, serial.next_action);
});

test('重なった状況からは最も行動を要する1つを選ぶ', () => {
  // 記録が無い状態でも、activeとの衝突が分かっているならそちらを先に告げる。
  const conflict = selectIndependenceGuidance({
    coverage: 'verified', taskDeclared: true, taskStale: false,
    conflictWithActive: 'code_seam',
  });
  assert.equal(conflict.code, 'independence_conflict_with_active');

  const undeclared = selectIndependenceGuidance({
    coverage: 'verified', taskDeclared: false, taskStale: false,
  });
  assert.equal(undeclared.code, 'independence_task_undeclared');

  const stale = selectIndependenceGuidance({
    coverage: 'stale', taskDeclared: true, taskStale: true,
  });
  assert.equal(stale.code, 'independence_stale_for_task');

  // 宣言境界に触れていないstaleは、そのtaskについては検証済みのまま。
  const untouched = selectIndependenceGuidance({
    coverage: 'stale', taskDeclared: true, taskStale: false,
  });
  assert.equal(untouched.code, 'independence_verified');

  const missing = selectIndependenceGuidance({
    coverage: 'missing', taskDeclared: false, taskStale: false,
  });
  assert.equal(missing.code, 'independence_unrecorded');

  const superseded = selectIndependenceGuidance({
    coverage: 'superseded', taskDeclared: true, taskStale: false,
  });
  assert.equal(superseded.code, 'independence_superseded');
});

test('verdictが1つも無い記録を、検証済みとして述べない', () => {
  const absent = selectIndependenceGuidance({
    coverage: 'verified', taskDeclared: true, taskStale: false, readyCount: 3,
    verdictsAbsent: true,
  });
  assert.equal(absent.code, 'independence_verdicts_absent');
  assert.equal(absent.next_action, 'resolve_unknowns_then_recompile');
  // 「干渉しない」ではなく「まだ判定していない」と述べる。不在を証拠にしない。
  assert.match(absent.message, /証拠にならない/u);

  // より具体的な状況があるならそちらが上。判定不能はその次に来る。
  assert.equal(selectIndependenceGuidance({
    coverage: 'verified', taskDeclared: true, taskStale: false, readyCount: 3,
    verdictsAbsent: true, conflictBetweenReady: 'code_seam',
  }).code, 'independence_conflict_between_ready');
  assert.equal(selectIndependenceGuidance({
    coverage: 'stale', taskDeclared: true, taskStale: true, verdictsAbsent: true,
  }).code, 'independence_stale_for_task');
});

test('着手候補が無いとき、空虚に検証済みへ倒れない', () => {
  // ready集合が空だとunknown listも空になり、`.every()`が空虚に真、`.some()`が偽になる。
  // readyCountを見ないと「記録が古いのに検証済み」という嘘を返す（0.13.0のsmokeで実際に出た）。
  const noReady = selectIndependenceGuidance({
    coverage: 'stale', taskDeclared: true, taskStale: false, readyCount: 0,
  });
  assert.equal(noReady.code, 'independence_no_ready_frontier');
  assert.equal(noReady.next_action, 'none');

  // 記録が無い場合も同じ——述べる対象が無いことのほうが precise。
  assert.equal(selectIndependenceGuidance({
    coverage: 'missing', taskDeclared: false, taskStale: false, readyCount: 0,
  }).code, 'independence_no_ready_frontier');

  // readyがあれば従来どおり状況を述べる。
  assert.equal(selectIndependenceGuidance({
    coverage: 'verified', taskDeclared: true, taskStale: false, readyCount: 2,
  }).code, 'independence_verified');

  // readyCount未指定（着手時advisory）は対象taskが確定しているので影響を受けない。
  assert.equal(selectIndependenceGuidance({
    coverage: 'stale', taskDeclared: true, taskStale: true,
  }).code, 'independence_stale_for_task');
});

test('束縛できなかったseam提案は、次の一歩を持つ案内を返す', () => {
  const missing = selectSeamProposalGuidance({
    coverage: 'verified', unknownKinds: ['semantic_owner_binding_missing'],
  });
  assert.equal(missing.code, 'seam_proposal_binding_missing');
  assert.equal(missing.next_action, 'declare_concern_anchors_then_recompile');
  // 宣言を直しただけでは提案は変わらない。そこまで述べないと同じunknownで止まる。
  assert.match(missing.message, /independence compile.*seam-proposal compile/u);

  // 束縛失敗が無ければ、記録が現在と一致している事実だけを述べる。
  assert.equal(selectSeamProposalGuidance({ coverage: 'verified' }).code,
    'seam_proposal_verified');
});

test('束縛失敗のunknownは種別ごとに別の次の一歩へ分かれる', () => {
  const codeFor = (kind) => selectSeamProposalGuidance({
    coverage: 'verified', unknownKinds: [kind],
  }).code;
  assert.equal(codeFor('concern_anchor_overlap'), 'seam_proposal_binding_overlap');
  assert.equal(codeFor('concern_anchor_outside_resource'),
    'seam_proposal_binding_outside_resource');
  assert.equal(codeFor('concern_anchor_unresolved'), 'seam_proposal_binding_symbol_unresolved');
  assert.equal(codeFor('concern_anchor_resource_unresolved'),
    'seam_proposal_binding_resource_unresolved');
  assert.equal(codeFor('semantic_owner_binding_ambiguous'), 'seam_proposal_binding_ambiguous');
});

test('束縛失敗が重なったら、直す対象が一意に決まる方を先に述べる', () => {
  // 壊れた宣言は直す対象が決まる。宣言が無い方は何をどう宣言するかから決めることになる。
  assert.equal(selectSeamProposalGuidance({
    coverage: 'verified',
    unknownKinds: ['semantic_owner_binding_missing', 'concern_anchor_overlap'],
  }).code, 'seam_proposal_binding_overlap');
});

test('記録が古い間は、束縛失敗より先に鮮度を述べる', () => {
  // staleな記録に載るunknownは現在のcodeについての事実ではない。先に再compileが要る。
  for (const coverage of ['stale', 'superseded', 'missing']) {
    const guidance = selectSeamProposalGuidance({
      coverage, unknownKinds: ['concern_anchor_overlap'],
    });
    assert.match(guidance.code, /^seam_proposal_(stale|superseded|unrecorded)$/u);
    assert.equal(guidance.next_action, 'compile_seam_proposal');
  }
});

test('束縛失敗に対応しないunknownは、案内を検証済みから動かさない', () => {
  // 切断候補の探索が尽きていない等は別系統の状況で、concern_anchorsでは解けない。
  assert.equal(selectSeamProposalGuidance({
    coverage: 'verified', unknownKinds: ['candidate_exploration_incomplete'],
  }).code, 'seam_proposal_verified');
});

test('作業手順は宣言からcompileを経て読むまでを順に述べる', () => {
  const numbered = TODO_INDEPENDENCE_WORKFLOW.filter((line) => /^\d\. /u.test(line));
  assert.equal(numbered.length, 5);
  assert.match(numbered[0], /witness/u);
  assert.match(numbered[1], /independence compile/u);
  assert.match(numbered[2], /todo independence --plan/u);
  assert.match(numbered[3], /witness migrate/u);
  assert.match(numbered[4], /todo start は止まらず/u);
});

test('宣言の手順はconcern_anchorsを宣言できる欄として挙げる', () => {
  const declareAt = TODO_INDEPENDENCE_WORKFLOW.findIndex((line) => line.startsWith('1. '));
  const anchorAt = TODO_INDEPENDENCE_WORKFLOW.findIndex((line) => line.includes('concern_anchors'));
  // 宣言の段（1.）に属する。判定や追従の段へ置くと、書く時点が過ぎてから読まれる。
  assert.ok(anchorAt > declareAt);
  assert.ok(!/^\d\. /u.test(TODO_INDEPENDENCE_WORKFLOW[anchorAt]));
  // 誰が書くべきかの条件を述べる。条件が無いと全ToDoが書く欄だと読まれる。
  assert.match(TODO_INDEPENDENCE_WORKFLOW[anchorAt], /係争資源/u);
  // 判定へ写らないことまで述べる。並列可否の入力と誤読されると、宣言が判定を動かすと思われる。
  assert.match(TODO_INDEPENDENCE_WORKFLOW[anchorAt], /判定には写らず/u);
});

test('下書きが受理されない時、理由ごとに具体的な次の一手を返す', () => {
  assert.equal(selectWitnessScaffoldGuidance(['draft_invalid']).next_action,
    'fix_draft_schema_then_retry');
  assert.equal(selectWitnessScaffoldGuidance(['anchor_outside_owned:T1:src/x.mjs']).next_action,
    'align_anchor_with_owns_or_writes');
});

test('理由が重なったら、形の壊れている側を先に述べる', () => {
  // 並べると読み手はどれから手を付けるか決められない。1つだけ選ぶ。
  const guidance = selectWitnessScaffoldGuidance([
    'anchor_outside_owned:T1:src/x.mjs', 'draft_invalid',
  ]);
  assert.equal(guidance.code, 'draft_invalid');
});

test('知らない理由でも汎用の案内へ落とし、投げない', () => {
  const guidance = selectWitnessScaffoldGuidance(['something_new:x']);
  assert.equal(guidance.next_action, 'resolve_declaration_then_retry');
});

test('scaffold案内はすべてmessageとnext_actionを持つ', () => {
  // 案内の口が空だと、機械が黙っているのと同じである（ADR 0130）。
  for (const reason of ['draft_invalid', 'anchor_outside_owned:T1:src/x.mjs']) {
    const guidance = selectWitnessScaffoldGuidance([reason]);
    assert.equal(typeof guidance.message, 'string', reason);
    assert.notEqual(guidance.message.length, 0, reason);
    assert.notEqual(guidance.next_action, 'resolve_declaration_then_retry', reason);
  }
});
