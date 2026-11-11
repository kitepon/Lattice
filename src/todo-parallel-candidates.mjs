/**
 * status面の`parallel_candidates`欄の素材（ob05・オーナー裁定C③）。
 *
 * **判定は1つも行わない。** ここに載るのは`projectIndependenceFrontier`が既に出している結果を
 * 候補の視点で並べ直したものだけである。並列できそうな組を選ぶのはAIの仕事で、機械が持つのは
 * 「まだ判定していないreadyはこれ」「判定済みの結果はこれ」だけ——推定・判断をLatticeの中へ
 * 実装しない（所有境界）。
 *
 * `independenceForGantt`と違い、**記録が無いplanを飛ばさない**。artifactがnullの状態は
 * 「まだ誰も判定していない」であって、この欄が最も要る場面である。飛ばすと沈黙が不在に見える。
 *
 * `todo status`と`lattice status`の両方が使うので、どちらのCLIにも属さない場所へ置く。
 * gitの読みは呼び出し側から渡す（`gitHead`／`changedPathsSince`）——このmoduleがgitの
 * 呼び方を決めると、2つのCLIが持つ既存の作法を上書きすることになる。
 */

import { projectIndependenceFrontier } from './todo-independence.mjs';
import { readTodoIndependenceArtifact } from './todo-store.mjs';
import { TODO_STATUS_DISPATCH_ONLY, computeReadyFrontier, projectTodoStatus } from './todo-status.mjs';

/** 記録が無いplanでは鮮度を見ないので、HEADの代わりに使う。project-cliと同じ作法。 */
const PLACEHOLDER_SHA = '0'.repeat(40);

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export async function readTodoParallelCandidatesForStatus(options = {}) {
  const { repoRoot, store, gitHead, changedPathsSince = () => null } = options;
  const frontier = computeReadyFrontier(store);
  const status = projectTodoStatus(store, TODO_STATUS_DISPATCH_ONLY);
  let currentBaseSha = null;
  const candidates = [];
  for (const member of store.members) {
    const planKey = member.plan.plan_key;
    // ADR 0160 §2: a plan that chose conversation gets no witness prompt (BellTeam 0.85.5 report).
    if (member.coordination?.mode === 'conversation') continue;
    const readyTaskIds = frontier.filter((task) => task.plan_key === planKey)
      .map(({ task_id: taskId }) => taskId);
    let artifact = null;
    let unreadableReason = null;
    try {
      artifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
    } catch (error) {
      // 読めない記録を「記録なし」へ丸めない（ADR 0131）。丸めると「壊れている」が
      // 「まだ判定していない」と同じ形になり、沈黙が不在に見える。理由を載せて先へ進む
      // ——1 planの壊れでstatus面ごと落とすと、他planの候補まで見えなくなる。
      // `summarizeIndependence`（project-cli）と同じ答え方に揃える。
      unreadableReason = error?.code
        ? `${error.code}:${error.detail?.reason ?? error.message}` : 'independence_unreadable';
    }
    // ready taskが1つも無く記録も無いplanは、判定する対象そのものが無い。entryごと出さない。
    if (readyTaskIds.length === 0 && artifact === null && unreadableReason === null) continue;
    // HEADが要るのは鮮度の判定だけである。記録が1つも無いplanでHEADを引くと、commitの無い
    // repo（初期化直後・test fixture）で`git_head_unresolved`に落ちる——判定していない
    // planを見るために、判定に使わない値の解決を要求してはいけない。
    if (artifact !== null && currentBaseSha === null) {
      try {
        currentBaseSha = gitHead(repoRoot);
      } catch (error) {
        // HEADが解決できない（commitが1つも無いrepo等）なら鮮度を判定できない。
        // placeholderで代用すると「判定済みだが古い」と断言することになる——
        // 知らないことを知っていると言わない。1 planの事情で面ごと落とさないのも同じ理由。
        unreadableReason = error?.code
          ? `${error.code}:${error.detail?.reason ?? error.message}` : 'independence_base_unresolved';
      }
    }
    if (unreadableReason !== null) {
      candidates.push({
        plan_key: planKey,
        // 壊れた記録から判定は読めない。coverageは名乗らず、理由を名乗る。
        coverage: null,
        unreadable_reason: unreadableReason,
        unjudged_task_ids: readyTaskIds,
        verified_parallel_groups: [],
        serialize_pairs: [],
        next_commands: [`lattice todo independence compile --plan ${planKey} --input <file>`],
      });
      continue;
    }
    const baseSha = currentBaseSha ?? PLACEHOLDER_SHA;
    const changedPaths = artifact !== null && artifact.base_sha !== null
      && artifact.base_sha !== baseSha
      ? changedPathsSince(repoRoot, artifact.base_sha) : null;
    const projected = projectIndependenceFrontier({
      artifact,
      readyTaskIds,
      activeTaskIds: status.active_set.filter((task) => task.plan_key === planKey)
        .map(({ task_id: taskId }) => taskId),
      plan: member.plan,
      currentBaseSha: baseSha,
      changedPaths,
    });
    const unjudged = projected.frontier.unknown.map(({ task_id: taskId }) => taskId);
    // 1件だけの「並列group」は並列の情報を持たない（1つのtaskは常に自分と並列である）。
    const groups = projected.frontier.parallel_groups
      .filter((group) => group.task_ids.length > 1)
      .map(({ task_ids: taskIds }) => ({ task_ids: taskIds }));
    const pairs = projected.frontier.serialize_pairs.map((pair) => ({
      task_ids: pair.task_ids, type: pair.type, detail: pair.detail,
    }));
    if (unjudged.length === 0 && groups.length === 0 && pairs.length === 0) continue;
    candidates.push({
      plan_key: planKey,
      coverage: projected.coverage,
      unreadable_reason: null,
      unjudged_task_ids: unjudged,
      verified_parallel_groups: groups,
      serialize_pairs: pairs,
      // 欄だけ置いて閉じない。未判定が残るなら宣言してcompile、済んでいるなら読み出し。
      next_commands: unjudged.length > 0
        ? [`lattice todo independence compile --plan ${planKey} --input <file>`]
        : [`lattice todo independence --plan ${planKey} --json`],
    });
  }
  candidates.sort((left, right) => compareText(left.plan_key, right.plan_key));
  return candidates;
}
