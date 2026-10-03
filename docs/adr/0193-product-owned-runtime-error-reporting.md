# ADR 0193: runtime errorの送信をLattice自身が持つ

- Status: accepted（Decision 9 と、Consequences の「Windowsの端末からは送れない」は
  [ADR 0194](0194-runtime-error-store-on-windows.md) が置き換える）
- Date: 2026-10-03
- Supersedes: runtime error storeの「reporting（BugHub送信）はdotagents adapter所有」
  （`docs/01_integration-package.md` 5.5、`src/runtime-errors.mjs`冒頭）

## Context

Latticeのruntime error記録は、工場（dotagents）のfactory reporterが`runtime-errors snapshot`を読み、
工場のreportに載せてBugHubへ運んでいた。Lattice自身は外部へ送らなかった。

オーナーの裁定（2026-10-03）で責務が変わった。エラーを上げるのは各プロダクトの責務で、
工場が持つのは工場の方針と、プロダクト・パッケージの管理だけである。BugHubは、端末に入る
CLI製品が自分の分だけを送る受け口（製品報告）を用意する。この受け口はオーナーの端末だけが使い、
LANの中に置く。LatticeはOSSなので、外の利用者の端末からは送らない。

`AGENTS.md`は、Latticeの設定とstateはこのrepoだけを正本とし、dotagentsは実行条件ではないと定めている。
収集の有効化が工場の設定fileだけに依っている点は、この原則からも外れていた。

## Decision

1. Latticeは、未受領のruntime error記録をBugHubの製品報告の受け口へ自分で送る。
   入口は`lattice runtime-errors report --json`、実装は`src/runtime-error-reporting.mjs`。
2. **既定では通信しない。** 送るのは、端末で`lattice runtime-errors reporting enable --json`を打ち
   （設定は`${XDG_CONFIG_HOME:-~/.config}/lattice/runtime-error-reporting.json`）、かつBugHubの持ち主が
   合鍵のfile（`~/.config/bughub/product-credentials/lattice.json`）を置いた端末だけである。
   どちらかが欠ければnetworkへ触れない。dotagentsの設定は、送信の判断に使わない。
3. 送信設定が有効な端末では、工場の設定が無くても収集を有効にする。工場の設定による収集の有効化は残す
   （工場のreportが運ぶ経路を、移行が済むまで壊さない）。
4. 合鍵のfileは、本人所有・0600・symlinkでない通常fileで、`url`・`key_id`・`secret`の3項目だけを持つ形に限る。
   それ以外は使わず、理由を返す。秘密は通信・結果・記録のどこにも写さない。
5. 秘密は通信に載せない。送ったバイト列のSHA-256と時刻へのHMAC-SHA256署名を`Authorization`に付ける。
   宛先は平文のHTTPで、持ち歩く端末が外のnetworkで同じaddressの別の機器へ送っても、秘密は漏れない。
6. 受領済みにするのは、200・`accepted: true`・`report_id`一致・応答の署名一致がそろった時だけである。
   受領済みの印はstoreの`acknowledged_through`を使う。そろわない時は「届いたか不明」として未受領のまま残し、
   後から新しい`report_id`でその時点の累計を送り直す（BugHubは同じ回数・同じ最終時刻を二重に数えない）。
7. 送る時機はLatticeが決める。故障を記録した直後と、以後のCLI実行の終わりに、切り離した子processで送る。
   CLIの応答は送信を待たない。`hooks`（打鍵ごとに走る）は時機に数えない。自動送信は1分に1回まで、
   同じ中身の送り直しは1時間に1回までとする。手で打つ`report`はこの制限を見ない。
8. 本文に載せるのは、`runtime-errors snapshot`が出す記録の項目だけである。端末名は載せない
   （BugHubが合鍵から解決する）。
9. Windowsは収集に対応しない（`collection: unsupported`）。送信も`unsupported`と答える。

## Consequences

- 工場のreportとLatticeの両方から同じ記録が届く期間がある。BugHubの同一性は端末・製品・fingerprintで、
  二重にはならない。Latticeが送り始めたら、工場のreportからLatticeの分を外す。
- 受領済みの印を工場のackと共有する。どちらのackも「BugHubへ届いた」を意味する。
- Windowsの端末からは送れない。Windowsでstoreを安全に置く方法が決まるまで残る不具合である。
- 試験と自動化は`LATTICE_RUNTIME_ERROR_REPORTING=0`で既定の置き場の送信設定を読まない。CIのrunnerは
  利用者の本物のHOMEで走るので、製品試験の環境はこの値を必ず持つ。

## Acceptance

- 署名と応答の署名が、BugHubの契約の試験値と一致する。
- 送信を有効にしていない端末と、合鍵の無い端末は、受け口へ1回も接続しない。
- 署名の合わない200・別の`report_id`・`accepted: false`・5xx・時間切れでは、storeのackが進まない。
- 送信を有効にした端末で故障を1件起こすと、CLIが返った後に子processが届け、ackが進む。
