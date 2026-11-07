import { selfDigest, validateExecutorPacket } from '../../src/runtime-contracts.mjs';

/**
 * RC3-E 決定論的scripted executor adapter（ADR 0044 Decision 9）。
 *
 * provider非依存adapter interfaceのprimary実装。挙動はscript（TODOごとのstep列）
 * だけで決まり、wall-clock・乱数・環境に依存しない。scripted campaign（RC3-H）が
 * 既知の正解集合を持つ条件注入に使う。
 *
 * adapter interface（provider非依存契約）:
 *   dispatch({ packet })            → { executor_handle, worktree_id }
 *   observe({ executor_handle })    → { state: 'running' }
 *                                    | { state: 'unknown' }                    … timeout相当
 *                                    | { state: 'checkpoint_ready', checkpoint }
 *                                    | { state: 'terminal', receipt }
 *
 * - 同一taskの重複dispatchはtyped rejectする（Decision 9.4）。
 * - `unknown`はfailureではない。同一handleでの再observeだけが正規の回収経路で、
 *   scriptは`stall`stepでこの経路を決定論的に再現する。
 * - terminal receiptはdispatch済みpacketへ帰属し（handle・worktree・packet digest）、
 *   scriptのoverridesで帰属破壊・stale epoch等の敵対条件を注入できる。
 */

const STEP_KINDS = new Set(['checkpoint', 'stall', 'hold_request', 'terminal']);

function fail(reason) {
  throw new TypeError(`scripted executor契約違反: ${reason}`);
}

function plainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateScript(script) {
  if (!plainRecord(script)) fail('scriptがplain objectではない');
  for (const [todoId, steps] of Object.entries(script)) {
    if (!Array.isArray(steps) || steps.length === 0) fail(`script.${todoId}がstep配列ではない`);
    for (const step of steps) {
      if (!plainRecord(step) || !STEP_KINDS.has(step.kind)) {
        fail(`script.${todoId}に未知のstepがある: ${String(step?.kind)}`);
      }
    }
    if (steps.filter((step) => step.kind === 'terminal').length > 1) {
      fail(`script.${todoId}のterminal stepは1つまで`);
    }
  }
}

/**
 * script駆動のexecutor adapterを作る。
 */
export function createScriptedExecutorAdapter(options = {}) {
  if (!plainRecord(options) || !plainRecord(options.script)) {
    fail('createScriptedExecutorAdapter optionsが不正');
  }
  validateScript(options.script);
  const script = structuredClone(options.script);

  // handle → { packet, steps, cursor, terminalReported }
  const active = new Map();
  // 重複拒否はtodo_id単位（task_refの付け替えによる同一TODOの二重起動と、
  // 決定論的handleの衝突・上書きを塞ぐ。review P1採用）。redispatchは
  // RC3-Gの新context契約が新しいadapter instanceで行う。
  const dispatchedTodoIds = new Set();

  function buildReceipt(handleState, step) {
    const { packet } = handleState;
    const overrides = plainRecord(step.receipt_overrides) ? step.receipt_overrides : {};
    const receipt = {
      schema: 'lattice.executor_receipt.v1',
      receipt_id: `${packet.todo_id}-r1`,
      executor_handle: handleState.executorHandle,
      worktree_id: handleState.worktreeId,
      base_sha: packet.base_sha,
      plan_epoch: packet.plan_epoch,
      packet_digest: packet.packet_digest,
      todo_id: packet.todo_id,
      checkpoint_digest: typeof step.checkpoint_digest === 'string'
        ? step.checkpoint_digest
        : (handleState.lastCheckpointDigest ?? 'c'.repeat(64)),
      observed_diff: Array.isArray(step.observed_diff)
        ? structuredClone(step.observed_diff)
        : packet.scope.writes.map((path) => ({ path, change: 'modified' })),
      ...structuredClone(overrides),
    };
    receipt.receipt_digest = selfDigest(receipt, 'receipt_digest');
    return receipt;
  }

  return {
    kind: 'scripted',

    async dispatch({ packet } = {}) {
      if (!validateExecutorPacket(packet)) fail('dispatchにはexecutor_packet.v1が必要');
      const steps = script[packet.todo_id];
      if (steps === undefined) fail(`scriptに存在しないTODOをdispatchできない: ${packet.todo_id}`);
      if (dispatchedTodoIds.has(packet.todo_id)) {
        fail(`同一TODOの重複dispatchを拒否する: ${packet.todo_id}`);
      }
      dispatchedTodoIds.add(packet.todo_id);
      const executorHandle = `scripted-${packet.todo_id}-h1`;
      const worktreeId = `wt-${packet.todo_id}`;
      active.set(executorHandle, {
        packet: structuredClone(packet),
        executorHandle,
        worktreeId,
        steps: structuredClone(steps),
        cursor: 0,
        terminalReported: false,
        lastCheckpointDigest: null,
      });
      return { executor_handle: executorHandle, worktree_id: worktreeId };
    },

    /**
     * epoch rebind（Decision 7.3）: content不変のままplan epochだけを更新する。
     * 以後のterminal receiptは新epochを名乗る（packet_digestはdispatch時の
     * ものを保持＝dispatch記録への帰属は不変）。
     */
    async rebind({ executor_handle: executorHandle, rebind } = {}) {
      const handleState = active.get(executorHandle);
      if (handleState === undefined) fail(`未知のhandleをrebindできない: ${String(executorHandle)}`);
      if (!plainRecord(rebind) || rebind.schema !== 'lattice.epoch_rebind_packet.v1'
        || rebind.todo_id !== handleState.packet.todo_id) {
        fail(`rebind packetが不正: ${String(executorHandle)}`);
      }
      handleState.packet.plan_epoch = rebind.new_plan_epoch;
      return { executor_handle: executorHandle, plan_epoch: rebind.new_plan_epoch };
    },

    async observe({ executor_handle: executorHandle } = {}) {
      const handleState = active.get(executorHandle);
      if (handleState === undefined) fail(`未知のhandleを観測できない: ${String(executorHandle)}`);
      if (handleState.terminalReported) {
        fail(`terminal報告済みhandleの再観測: ${executorHandle}`);
      }
      if (handleState.cursor >= handleState.steps.length) {
        return { state: 'running' };
      }
      const step = handleState.steps[handleState.cursor];
      handleState.cursor += 1;
      if (step.kind === 'stall') {
        return { state: 'unknown' };
      }
      if (step.kind === 'checkpoint') {
        if (!plainRecord(step.checkpoint)) fail('checkpoint stepにcheckpoint payloadが必要');
        if (typeof step.checkpoint.checkpoint_digest === 'string') {
          handleState.lastCheckpointDigest = step.checkpoint.checkpoint_digest;
        }
        return { state: 'checkpoint_ready', checkpoint: structuredClone(step.checkpoint) };
      }
      if (step.kind === 'hold_request') {
        if (!plainRecord(step.finding)) fail('hold_request stepにfinding payloadが必要');
        return { state: 'hold_requested', finding: structuredClone(step.finding) };
      }
      handleState.terminalReported = true;
      return { state: 'terminal', receipt: buildReceipt(handleState, step) };
    },
  };
}
