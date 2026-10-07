# ADR 0196: 契約の外へ漏れた通信の失敗を内部故障と分け、重大度を落ちた面で決める

- Status: accepted
- Date: 2026-10-07
- Amends: [ADR 0193](0193-product-owned-runtime-error-reporting.md)（記録の入口と重大度の決め方）

## Context

2026-10-07のオーナー指示で、BugHubへ報告する各製品は、通信の失敗の登録条件と重大度の決め方を見直す
（正本: ServerManager `bughub/NETWORK_REPORTING.md`）。要点は3つある。通信環境そのものの不調と、その状態への
製品の対処不良を分ける。正常な取消と、適切に処理した一時的な失敗を、修理対象として自動で登録しない。
重大度はerror codeや回数で固定せず、機能の停止・データの喪失・重複・復帰できるか、を根拠に付ける。

Latticeの現状を確かめた。

- 処理している通信の失敗は、記録していない。hubへの配達は`BRIDGE_HUB_DELIVERY_UNCONFIRMED`のreceiptで返し、
  `start`・`done`を止めない。BugHubへの送信は`unconfirmed`で返し、記録を未受領のまま残して後から送り直す。
  hubのheartbeatと端末内のhealth確認は、失敗を値として受ける。
- 取消は記録していない。SIGINTは終了し、閉じたpipeのEPIPEは静かに終了する。
- 記録の入口は、CLIのtyped契約の外へ漏れた例外（`LATTICE.CLI_INTERNAL_FAILED`）とMCPの起動失敗
  （`LATTICE.MCP_SERVER_FAILED`）の2つ。重大度は表でerror codeごとに`high`へ固定していた。

合っていない点は2つあった。

1. 契約の外へ漏れた例外は、原因を見ずに`LATTICE.CLI_INTERNAL_FAILED`・`high`で記録していた。通信の失敗
   （接続の切断、時間切れ）が漏れた時も、内部故障の`high`になる。重大度の根拠がerror codeだけだった。
   4台の実物のstoreに、この経路で作られた記録は無い。作りとして残っていた。
2. `todo`では、漏れた`fetch failed`（TypeError）を`CONTRACT_VIOLATION`と答えていた。通信の失敗を、
   呼び出し側の契約違反として表示する誤りで、記録にも乗らなかった。

## Decision

1. CLIのtyped契約の外へ漏れた例外を、記録の入口で3つに分ける（`src/cli-failure-class.mjs`）。例外と、
   その`cause`の連なり（4段まで）を見る。
   - 取消: `AbortError`、または`ABORT_ERR`。
   - 通信の失敗: `TimeoutError`（`AbortSignal.timeout`の時間切れ）、またはNode・undiciが通信の失敗に付ける
     code（`ECONNREFUSED`・`ECONNRESET`・`ETIMEDOUT`・`ENOTFOUND`・`EAI_AGAIN`・`UND_ERR_CONNECT_TIMEOUT`等）。
     端末内のportの取り合い（`EADDRINUSE`）と、子processとのpipeでも起きる`EPIPE`は数えない。
   - それ以外: 内部故障。
2. 取消は記録しない。
3. 通信の失敗が漏れたものは、`LATTICE.CLI_TRANSPORT_UNHANDLED`として記録する。内部故障とは別の記録である。
   原因が通信でも、型つきの答えにできず落ちたのは製品の対処不良で、直すのは回線ではなく、その面の通信失敗の
   受け方である。観測したcodeは、今までどおり`safe_context.cause_code`に載る。`cause`の側にあるcodeも拾う。
4. その重大度は、落ちた面で決める。
   - 何も書き換えないと確かめた面（`READ_ONLY_COMMAND_KINDS`: `run.list`・`todo.status`・`todo.verify`）は`warn`。
     その1回が止まっただけで、失うものが無く、通信が戻れば打ち直しで復帰する。
   - 書き換える面と、確かめていない面は`high`。結果が分からず、不整合や重複を否定できない。
     確かめられないことを理由に下げない。
   - 分類と面から決まる値なので、同じfingerprintの記録は必ず同じ重大度になる。storeは、面と合わない重大度の
     記録を読まない。
5. 通信でない内部故障と、MCPの起動失敗は`high`のまま。CLIが契約の外で落ちる、その会話でsensorが使えない、
   という機能の停止が根拠である。MCPが通信するのは端末内のsocketだけなので、分けない。
6. `todo`は、漏れた通信の失敗を`CONTRACT_VIOLATION`と答えず、`INTERNAL_FAILURE`として観測口へ渡す。
7. 処理している通信の失敗と取消を記録しない、という今の条件は変えない。
8. 送る項目は増やさない。BugHubへ届く変化は、error codeの語が1つ増えることと、`severity: warn`が届き得る
   ことの2つ。`safe_context`の3つのキーと形、fingerprintの式は同じ。

## Consequences

- 通信の失敗が漏れた記録は、BugHubで内部故障と別の行になる。何も書き換えない面の分は`warn`なので、
  通知は出ない（通知が出るのは、初めて見た未解決のfatal・high）。未解決の一覧には載る。
- `warn`にする面を増やす時は、その面が何も書き換えないことを実測してから一覧へ足す。今の3つは、
  作業用の複製を作り、実行の前後で全fileのhashと一覧が変わらないことを確かめた（2026-10-07）。
- 取消の判定は例外の名前で行う。内部の時間切れを`AbortController`で作る実装が入ると、その時間切れは
  取消として記録から外れる。時間切れには`AbortSignal.timeout`を使う。
- `todo`の分岐（Decision 6）は、通信の失敗を外から起こす口が無く、単体では確かめていない。分類の関数は、
  本物の`fetch`の失敗で確かめてある。

## Acceptance

- 本物の接続拒否（`fetch failed`）・`AbortSignal.timeout`の時間切れ・socketの接続拒否を通信の失敗、
  `AbortController`の中止を取消、それ以外を内部故障と分ける。
- 漏れた通信の失敗は`LATTICE.CLI_TRANSPORT_UNHANDLED`で記録され、何も書き換えない面は`warn`、
  それ以外は`high`になる。通信でない例外は、どの面でも`LATTICE.CLI_INTERNAL_FAILED`・`high`。
- 取消は1件も記録されない。
- 記録の項目は増えない。面と合わない重大度へ書き換えたstoreは`state_invalid`で読まれない。
