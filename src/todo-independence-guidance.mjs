/**
 * 並列可否の案内（ADR 0130）。
 *
 * 状況から`{code, message, next_action}`を引く単一正本。advisory・投影・typed error・helpは
 * すべてここから引く。面ごとに文言を書けば必ずずれ、同じ状況に別の説明が付く。
 *
 * 文は事実と次の一歩だけを述べ、指示しない。どのreadyを取るかはhostが所有する
 * （ADR 0063 Decision 5）。命令形にするとLatticeがagentを統制する面へ滑る。
 * 未検証の工程も start は拒否しない（u03 B1–B6、ADR 0182 を置き換える）。助言として返す。
 * next_actionは実在するコマンドか'none'だけ（a19）。planKeyを渡すと`<key>`が置き換わる。
 */

export const TODO_INDEPENDENCE_GUIDANCE_CODES = Object.freeze([
  'independence_no_ready_frontier',
  // ob03: 調整方式の宣言に関する案内。witnessが全planの暗黙義務だった時、未compileの督促は
  // 誰の受入条件でもない作業を指しており、正確なまま素通りされた。まず「どちらで行くか」を
  // 選ばせ、選択の後にだけ督促する。
  'coordination_mode_undeclared',
  'coordination_conversation',
  'independence_unrecorded',
  'independence_task_undeclared',
  'independence_contract_superseded',
  'independence_superseded',
  'independence_stale_for_task',
  'independence_conflict_with_active',
  'independence_conflict_between_ready',
  'independence_verdicts_absent',
  'independence_verified',
]);

export const SEAM_PROPOSAL_GUIDANCE_CODES = Object.freeze([
  'seam_proposal_unrecorded',
  'seam_proposal_superseded',
  'seam_proposal_stale',
  'seam_proposal_binding_overlap',
  'seam_proposal_binding_outside_resource',
  'seam_proposal_binding_symbol_unresolved',
  'seam_proposal_binding_resource_unresolved',
  'seam_proposal_binding_ambiguous',
  'seam_proposal_binding_missing',
  'seam_proposal_verified',
]);

/**
 * 束縛失敗のunknown種別から案内codeを引く表。並びは優先順で、先頭ほど次の一歩が具体的である。
 *
 * 宣言が壊れている状況を、宣言が無い状況より上に置く。壊れている方は直す対象が
 * 一意に決まるのに対し、無い方は何をどう宣言するかから決めることになるからである。
 */
const SEAM_PROPOSAL_BINDING_GUIDANCE = Object.freeze([
  Object.freeze(['concern_anchor_overlap', 'seam_proposal_binding_overlap']),
  Object.freeze(['concern_anchor_outside_resource', 'seam_proposal_binding_outside_resource']),
  Object.freeze(['concern_anchor_unresolved', 'seam_proposal_binding_symbol_unresolved']),
  Object.freeze(['concern_anchor_resource_unresolved', 'seam_proposal_binding_resource_unresolved']),
  Object.freeze(['semantic_owner_binding_ambiguous', 'seam_proposal_binding_ambiguous']),
  Object.freeze(['semantic_owner_binding_missing', 'seam_proposal_binding_missing']),
]);

/**
 * 束縛の案内へ共通で添える、記録が更新される条件。
 *
 * concern_anchorsはwitness setにあり、seam提案はindependence記録のwitness_set_digestと
 * 一致する宣言しか読まない。宣言を直しただけでは提案は変わらないので、そこまで述べないと
 * 「直したのに同じunknownが出る」で止まる。
 */
const BINDING_RECOMPILE_HINT = '宣言はwitness setにあり、independence compileとseam-proposal compileを通し直すまで提案へ写らない。';

const CATALOG = Object.freeze({
  independence_no_ready_frontier: Object.freeze({
    message: '着手候補が無いため、並列可否を述べる対象が無い。',
    next_action: 'none',
  }),
  coordination_mode_undeclared: Object.freeze({
    message: 'このplanは調整方式をまだ選んでいない。witness検証で並列するか、会話で調整するかが決まっていない。',
    next_action: 'lattice todo independence mode --plan <key> --set <witness|conversation> --reason <text>',
  }),
  coordination_conversation: Object.freeze({
    message: 'このplanは会話調整を選んでいる。並列可否は宣言と判定ではなく、卓の合意が持つ。',
    next_action: 'none',
  }),
  independence_unrecorded: Object.freeze({
    message: 'このplanの並列可否はまだ判定していない。競合が無いのではなく、記録が存在しない。',
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  independence_task_undeclared: Object.freeze({
    message: 'この工程はwitness setで宣言されていないため、記録には含まれていない。',
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  independence_contract_superseded: Object.freeze({
    message: '記録は旧契約versionで書かれており、現在の並列可否の判定としては読めない。現在の契約での再compileが次の一歩になる。',
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  independence_superseded: Object.freeze({
    message: 'planが改訂され、記録は別のtopologyについての判定になっている。',
    next_action: 'lattice todo independence witness migrate --plan <key>',
  }),
  independence_stale_for_task: Object.freeze({
    message: '記録後にこの工程の宣言境界が変更されたため、記録時点の判定は現在のcodeを指していない。',
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  independence_conflict_with_active: Object.freeze({
    message: '作業中の工程と同じ資源を書く記録がある。並行すると衝突する。',
    next_action: 'lattice todo dependency connect --from-plan <key> --from-task <id> --to-plan <key> --to-task <id> --reason <text>',
  }),
  independence_conflict_between_ready: Object.freeze({
    message: '他のready工程と同じ資源を書く記録がある。同時に着手すると衝突する。',
    next_action: 'lattice todo dependency connect --from-plan <key> --from-task <id> --to-plan <key> --to-task <id> --reason <text>',
  }),
  independence_verdicts_absent: Object.freeze({
    message: '判定が途中で止まっており、記録はどの組についてもverdictを持たない。自分にunknownが無いことは、他と干渉しない証拠にならない。',
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  independence_verified: Object.freeze({
    message: '記録時点の宣言境界では、他のready工程と干渉しない。',
    next_action: 'none',
  }),
  seam_proposal_unrecorded: Object.freeze({
    message: 'このplanのseam提案はまだ生成していない。提案対象が無いのではなく、記録が存在しない。',
    next_action: 'lattice todo seam-proposal compile --plan <key>',
  }),
  seam_proposal_superseded: Object.freeze({
    message: '参照元のplanまたは並列可否記録が更新され、このseam提案は現在の競合についての記録ではない。',
    next_action: 'lattice todo seam-proposal compile --plan <key>',
  }),
  seam_proposal_stale: Object.freeze({
    message: 'seam提案の生成後にHEADが進み、記録時点の構造証拠は現在のcodeを指していない。',
    next_action: 'lattice todo seam-proposal compile --plan <key>',
  }),
  seam_proposal_binding_overlap: Object.freeze({
    message: `同じ資源について、複数のToDoが同じsymbolを自分の担当として宣言している。どちら側へ切るか決まらないため、切断候補を束縛できない。${BINDING_RECOMPILE_HINT}`,
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  seam_proposal_binding_outside_resource: Object.freeze({
    message: `concern_anchorsが挙げたsymbolが、withinで指した資源の外にある。その資源の分割を説明しないので束縛へ使えない。${BINDING_RECOMPILE_HINT}`,
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  seam_proposal_binding_symbol_unresolved: Object.freeze({
    message: `concern_anchorsが挙げたsymbolを、sensorが同名同pathで解決できなかった。近い別symbolへは寄せないため、束縛は成立していない。${BINDING_RECOMPILE_HINT}`,
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  seam_proposal_binding_resource_unresolved: Object.freeze({
    message: `concern_anchorsのwithinが指す資源をsensorで解決できなかった。宣言がどの資源についてのものか確定しない。${BINDING_RECOMPILE_HINT}`,
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  seam_proposal_binding_ambiguous: Object.freeze({
    message: `宣言したsymbolが切断候補の複数側へ当たるため、どのToDoがどちらを所有するか一意に決まらない。${BINDING_RECOMPILE_HINT}`,
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  seam_proposal_binding_missing: Object.freeze({
    message: `係争資源の中でどのToDoが何を触るかが宣言されていないため、切断候補を所有者へ束縛できない。依存線でも呼び出し辺でも所有は決まらない。${BINDING_RECOMPILE_HINT}`,
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  seam_proposal_verified: Object.freeze({
    message: 'seam提案の記録は現在のplan、並列可否記録、HEADと一致している。',
    next_action: 'none',
  }),
});

const PULL_INTAKE_READINESS = Object.freeze({
  required: Object.freeze({
    code: 'pull_independence_required',
    message: 'pull設備のintakeには有効なindependence artifactが必須である。conversation調整はwitness督促を消すが、この実行前提は満たさない。',
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  }),
  ready: Object.freeze({
    code: 'pull_independence_ready',
    message: 'pull設備が読むplan-level independence bindingは有効である。task固有境界とruntime競合はintake時に検査する。',
    next_action: 'none',
  }),
});

/** 切断可能性の言い換え。conflictの案内へ添える。 */
const SEVERABILITY_HINT = Object.freeze({
  code_seam: 'symbol／pathの衝突なので、境界を分けるrefactorで並列化しうる。記録済みの競合からseam-proposal compileを検討できる。',
  serial: '共有stateまたはeffectの衝突なので、分割では切り離せない。',
});

const withPlanKey = (command, planKey) => (planKey === null ? command : command.replaceAll('<key>', () => planKey));

export function todoIndependenceGuidance(code, { severability = null, planKey = null } = {}) {
  const entry = CATALOG[code];
  if (entry === undefined) {
    throw new TypeError(`unknown independence guidance code: ${code}`);
  }
  const hint = severability === null ? null : SEVERABILITY_HINT[severability] ?? null;
  return {
    code,
    message: hint === null ? entry.message : `${entry.message}${hint}`,
    next_action: withPlanKey(entry.next_action, planKey),
  };
}

export function pullIntakeReadinessGuidance({ coordinationMode = null, ready, planKey = null }) {
  if (![null, 'witness', 'conversation'].includes(coordinationMode)
    || typeof ready !== 'boolean') {
    throw new TypeError('pull intake readiness input is invalid');
  }
  const readiness = ready ? PULL_INTAKE_READINESS.ready : PULL_INTAKE_READINESS.required;
  return {
    ...readiness,
    next_action: withPlanKey(readiness.next_action, planKey),
    plan_binding_ready: ready,
    coordination_mode: coordinationMode,
  };
}

/**
 * 記録済みの宣言膨張を、AIが分割を検討するための助言へ写す。
 *
 * 判断はしない。膨張回数が既知かつ1回以上という事実だけを入口にし、gate形なら
 * 依存の合流点という構造事実を強い材料として添える。subset gapで累計がnullのtaskや
 * 初回宣言は、回数を主張できないので助言を出さない。
 */
export function scopeExpansionRecommendations(scopeExpanded) {
  if (!Array.isArray(scopeExpanded)) {
    throw new TypeError('scope_expanded must be an array');
  }
  return scopeExpanded
    .filter((entry) => Number.isSafeInteger(entry?.growth_events)
      && entry.growth_events > 0)
    .map((entry) => ({
      code: 'scope_expanded_consider_split',
      task_id: entry.task_id,
      growth_events: entry.growth_events,
      first_seen_path_count: entry.first_seen_path_count,
      path_count: entry.path_count,
      gate_shape: entry.gate_shape,
      message: `宣言が${entry.growth_events}回膨張している。${entry.gate_shape
        ? 'このtaskは依存の合流点であり、'
        : ''}内側にgateのリストが生えているなら、A1..Anと残余A'への分割を検討できる。`,
      next_action: 'consider_todo_split',
    }))
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
}

/**
 * advisoryや投影の状態から、最も行動を要する案内を1つ選ぶ。
 *
 * 複数の状況が重なることはあるが、案内を並べると読み手はどれから手を付けるか決められない。
 * 「記録が無い」より「記録が古い」より「衝突している」を上に置く——後者ほど
 * 次の一歩が具体的だからである。
 */
export function selectIndependenceGuidance({
  coverage, taskDeclared, taskStale, conflictWithActive = null, conflictBetweenReady = null,
  contractSuperseded = false, readyCount = null, verdictsAbsent = false,
  coordinationMode = 'witness', planKey = null,
}) {
  // 着手候補が無いなら述べる対象が無い。ここを通さないと、readyが空のとき
  // 「未検査taskが1件も無い」が空虚に真になり、記録が古くても検証済みへ倒れる。
  if (readyCount === 0) return todoIndependenceGuidance('independence_no_ready_frontier', { planKey });
  if (conflictWithActive !== null) {
    return todoIndependenceGuidance('independence_conflict_with_active', {
      severability: conflictWithActive, planKey,
    });
  }
  if (conflictBetweenReady !== null) {
    return todoIndependenceGuidance('independence_conflict_between_ready', {
      severability: conflictBetweenReady, planKey,
    });
  }
  if (contractSuperseded) {
    return todoIndependenceGuidance('independence_contract_superseded', { planKey });
  }
  // 記録が無い時に何を言うかは、planがどちらの方式を選んだかで変わる（ob03・裁定C①）。
  // 会話調整を選んだplanへ未compileを督促するのは、選択を尊重しないことになる。未宣言の
  // planへ督促するのは、誰の受入条件でもない作業を指すことになる——それが8件で素通りされた
  // 当のものである。督促が一級で出るのはwitnessを選んだplanだけとする。
  // 既定を`witness`にしてあるのは、宣言を渡さない既存の呼び出し側の挙動を変えないためである。
  if (coverage === 'missing') {
    if (coordinationMode === 'conversation') return todoIndependenceGuidance('coordination_conversation', { planKey });
    if (coordinationMode === null) return todoIndependenceGuidance('coordination_mode_undeclared', { planKey });
    return todoIndependenceGuidance('independence_unrecorded', { planKey });
  }
  if (coverage === 'superseded') return todoIndependenceGuidance('independence_superseded', { planKey });
  if (!taskDeclared) return todoIndependenceGuidance('independence_task_undeclared', { planKey });
  if (taskStale) return todoIndependenceGuidance('independence_stale_for_task', { planKey });
  // 記録は新しく、この工程自身にも問題が無い。それでもverdictが1つも無いなら、
  // 述べられるのは「干渉しない」ではなく「まだ何も判定していない」である。
  if (verdictsAbsent) return todoIndependenceGuidance('independence_verdicts_absent', { planKey });
  return todoIndependenceGuidance('independence_verified', { planKey });
}

/**
 * seam提案の状況から案内codeを引く。投影の生成側と契約の検査側が同じ規則を読むための正本。
 *
 * 鮮度（coverage）を束縛失敗より先に見る。記録が古い・別topologyについてのものである時、
 * そこに載っているunknownは現在のcodeについての事実ではないため、先に再compileが要る。
 * 記録が現在と一致している時だけ、束縛失敗が「今直せる状況」になる。
 */
export function seamProposalGuidanceCode({ coverage, unknownKinds = [] }) {
  if (coverage === 'missing') return 'seam_proposal_unrecorded';
  if (coverage === 'superseded') return 'seam_proposal_superseded';
  if (coverage === 'stale') return 'seam_proposal_stale';
  if (coverage !== 'verified') throw new TypeError(`unknown seam proposal coverage: ${coverage}`);
  const kinds = new Set(unknownKinds);
  const binding = SEAM_PROPOSAL_BINDING_GUIDANCE.find(([kind]) => kinds.has(kind));
  return binding === undefined ? 'seam_proposal_verified' : binding[1];
}

export function selectSeamProposalGuidance({ coverage, unknownKinds = [], planKey = null }) {
  return todoIndependenceGuidance(seamProposalGuidanceCode({ coverage, unknownKinds }), { planKey });
}

/**
 * 宣言からcompileを経て読むまでの順序。helpとMCP instructionsが同じ手順を語るための正本。
 * 面ごとに手順を書き直すと、片方だけが古くなる。
 *
 * 宣言できる欄を挙げる面はここだけなので、witness契約へ欄を足したらここへも足す。
 * 足さないと、能力はあるのに機械が黙る面が残る（ADR 0130）。
 */
export const TODO_INDEPENDENCE_WORKFLOW = Object.freeze([
  '1. 宣言する: .lattice/todo/witness/<plan_key>.json へ、ToDoごとのowns／reads／writes／affected_testsを書く',
  '   係争資源しか所有していないToDoは、ownsまたはwritesの内側で自分が触るsymbolをconcern_anchorsへ宣言できる（witness set v2）。並列可否の判定には写らず、切断候補の束縛だけに効く',
  '   remaining の A 工程（まだ done でない ready / blocked）も同じ witness に含める。現在の ready だけを compile すると、次の frontier の start の助言が未検証（independence_task_undeclared）になる',
  '2. 判定する: lattice todo independence compile --plan <key> --input <ref>（実sensorを引く。pretty-printやdigest未計算の下書きは機械が直す）。next_ready が witness に無い compile は拒否する',
  '3. 読む: lattice todo independence --plan <key> --json（sensorを引かず、記録とHEAD照合だけで返る）',
  '4. 追従する: plan改訂後は lattice todo independence witness migrate --plan <key> で宣言を写してから再compileする',
  '5. 記録があるのに対象工程が未宣言・失効でも todo start は止まらず、助言として返る。競合の同時起動も助言のまま',
]);

/**
 * 宣言の下書きが受理されなかった時の案内（`witness scaffold`）。
 *
 * 理由コードは具体的なのに次の一手が「宣言を直して再実行」のままだと、何をどう直すのかが
 * 伝わらない。一番必要な瞬間——機械が「作れませんでした」と言った瞬間——に解決法を知らせない
 * のは、ADR 0130が禁じたものそのものである。
 */
const SCAFFOLD_CATALOG = Object.freeze({
  anchor_outside_owned: {
    message: 'concern_anchorのwithinが、ownsにもwritesにも無い。触ると宣言した面の内側にだけ担当を書ける。',
    next_action: 'align_anchor_with_owns_or_writes',
  },
  draft_invalid: {
    message: '下書きがlattice.todo_witness_draft契約を満たしていない。',
    next_action: 'fix_draft_schema_then_retry',
  },
});

/**
 * 理由の集合から、最も行動を要する案内を1つ選ぶ。
 *
 * 並べると読み手はどれから手を付けるか決められない。「形が壊れている」を最優先にし、
 * 以下、宣言の直し方が具体的なものほど上へ置く。
 */
export function selectWitnessScaffoldGuidance(reasons = []) {
  const codes = reasons.map((reason) => String(reason).split(':')[0]);
  const order = [
    'draft_invalid', 'anchor_outside_owned',
  ];
  const code = order.find((candidate) => codes.includes(candidate));
  if (code === undefined) {
    return { code: 'witness_scaffold_incomplete', message: '下書きから宣言を組めなかった。', next_action: 'resolve_declaration_then_retry' };
  }
  return { code, ...SCAFFOLD_CATALOG[code] };
}
