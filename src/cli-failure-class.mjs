/**
 * typed契約の外へ漏れた例外を、取消・通信の失敗・それ以外に分ける（ADR 0196）。
 *
 * runtime error記録の入口が使う。取消は故障として記録しない。通信の失敗が漏れたものは、内部故障とは
 * 別の記録にする——原因が通信でも、型つきの答えにできず落ちたのは製品の対処不良で、直すのは回線ではなく
 * その面の通信失敗の受け方である。
 */

// Nodeとundiciが通信の失敗に付けるcode。端末内のportの取り合い（EADDRINUSE）と、子processとのpipeでも
// 起きるEPIPEは、通信の失敗に数えない。
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH',
  'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'ENOTCONN',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_SOCKET_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);
const CAUSE_DEPTH = 4;

/** 例外と、その`cause`の連なり。`fetch failed`（TypeError）は、通信のcodeを`cause`の側に持つ。 */
export function failureCauseChain(error) {
  const chain = [];
  for (let current = error; current !== null && typeof current === 'object' && chain.length < CAUSE_DEPTH;
    current = current.cause) chain.push(current);
  return chain;
}

/** `cancelled`（利用者や呼び出し元の取消）・`transport`（通信の失敗）・`internal`（それ以外）。 */
export function cliFailureClass(error) {
  const chain = failureCauseChain(error);
  if (chain.some((entry) => entry.name === 'AbortError' || entry.code === 'ABORT_ERR')) return 'cancelled';
  // `AbortSignal.timeout`の時間切れは`TimeoutError`で届く。
  if (chain.some((entry) => entry.name === 'TimeoutError' || TRANSPORT_CODES.has(entry.code))) return 'transport';
  return 'internal';
}
