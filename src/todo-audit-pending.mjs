/**
 * 監査待ちPhaseの定義（ADR 0147／0148）。
 *
 * 「監査待ち」は同じ3状態の集合として、gantt scopeのfold判定・dashboardの表示判定へ
 * 別々に書かれていた。status面にも同じ判定が要るので、定義をここへ一本化する——
 * 集合が三重になれば、片方だけ更新された時に「図には出るがstatusには出ない」形の
 * ずれが生まれる。ADR 0147が塞ごうとした事故と外形が同じになる。
 *
 * このmoduleが持つのは監査待ちの**定義**だけである。各消費者の方針
 * （ganttのfold対象をどのplan世代へ限るか等）はここへ持ち込まない。
 */

/**
 * 監査の判断がまだ着いていないPhase状態。
 *
 * - `gate_ready`: 所属ToDoが全てdoneで、監査待ち。
 * - `reviewing`: 監査中（reviewは出たが、acceptもrejectも出ていない）。
 * - `rejected`: 監査が通らず、要フォロー。
 *
 * `accepted`と`closed_unaudited`は含めない。どちらも判断が着いた終端状態で、
 * 待っているものが無い（ADR 0148裁定4）。`active`も含めない——まだpending taskが
 * 残っており、監査の地点へ到達していない。
 */
export const AUDIT_PENDING_PHASE_STATUSES = new Set(['gate_ready', 'reviewing', 'rejected']);

/** そのPhase状態が監査待ちか。null／undefined／未知の値はfalse。 */
export function isAuditPendingPhaseStatus(status) {
  return AUDIT_PENDING_PHASE_STATUSES.has(status ?? null);
}

/**
 * その監査待ち状態から実際に打てるコマンド。
 *
 * `src/todo-store.mjs`の遷移guardと一致させる——gate_readyからいきなりacceptはできず
 * （`phase_gate_not_ready`）、reviewing以外からのrejectもできない（`phase_reject_binding_invalid`）。
 * 実行すれば必ず弾かれる遷移を「次の一歩」として案内しない。
 *
 * 監査待ちでない状態を渡すのは呼び出し側の誤りなので、空配列へ丸めずに投げる。
 * 呼ぶ前に`isAuditPendingPhaseStatus`で絞ること。
 *
 * `slotCount`は必須evidence slotの数。1つなら`--evidence`で足り、複数なら`--input`が要る。
 * `auditRequired`（`phaseAuditRequired`）ならclose-unauditedを案内しない（ADR 0200 gate 5が断る）。
 *
 * @returns {string[]} 実行可能なコマンド行（1つ以上）
 */
export function auditPendingNextCommands(planKey, phaseId, status, slotCount = 1, { auditRequired = false } = {}) {
  const target = `--plan ${planKey} --phase ${phaseId}`;
  if (status === 'gate_ready') {
    return [
      `lattice todo phase review ${target} --reason <text>`,
      // ADR 0200 gate 5 refuses close-unaudited here, so it is not offered.
      ...(auditRequired ? [] : [`lattice todo phase close-unaudited ${target} --reason <text>`]),
    ];
  }
  if (status === 'reviewing') {
    return [
      // a36: --evidence fills the decision from one committed file; several slots need --input.
      `lattice todo phase accept ${target} ${slotCount === 1 ? '--evidence <file>' : '--input <file>'}`,
      `lattice todo phase reject ${target} --reason <text> --evidence <file>`,
    ];
  }
  if (status === 'rejected') {
    return [`lattice todo phase reopen ${target} --reason <text>`];
  }
  const error = new Error(`phase status is not audit pending: ${status}`);
  error.code = 'AUDIT_PENDING_STATUS_INVALID';
  throw error;
}

/** ADR 0200 gate 5: an `enforced` plan keeps the audit its author required for a `heavy` phase. */
export function phaseAuditRequired(member, gatePolicy) {
  return member?.coordination?.mode === 'enforced' && gatePolicy === 'heavy';
}

/**
 * store read model(`lattice.todo_store_read.v1`)の中の監査待ちPhaseを列挙する。
 *
 * `member.phases`はstoreが常に埋める導出ビューで、phase無しplanの暗黙terminal-audit Phaseも
 * 同じ形で入っている(ADR 0147)。planの世代で分岐しないのはそのためである。
 *
 * 返すのは`plan_key`・`phase_id`・`status`だけにする。消費者ごとに要る付随情報
 * (evidence slot、次コマンド、implicitかどうか)は形が違うので、ここで先回りして
 * 詰め込まない。並び順はplan_key→phase_idで固定する——同じstoreからは同じ列が出る。
 *
 * @returns {Array<{plan_key: string, phase_id: string, status: string}>}
 */
export function auditPendingPhasesOf(readModel) {
  const entries = [];
  for (const member of readModel?.members ?? []) {
    if (!Array.isArray(member?.phases)) continue;
    for (const phase of member.phases) {
      if (!isAuditPendingPhaseStatus(phase?.status)) continue;
      entries.push({
        plan_key: member.plan.plan_key, phase_id: phase.phase_id, status: phase.status,
      });
    }
  }
  return entries.sort((left, right) => (
    left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1
      : left.phase_id < right.phase_id ? -1 : left.phase_id > right.phase_id ? 1 : 0));
}
