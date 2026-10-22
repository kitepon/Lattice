# 機能逆算の導線・公開・導入後確認

`Latticeで工程作って`を受けたClaude・Codex・Cursorの製品hookは、sensor索引の有無と既読状態に左右されず、逆算工程の正規入口を案内する。`test/hooks-cli.test.mjs`の対応host試験で確認した。

PR [#21](https://github.com/kitepon/Lattice/pull/21)はmainへマージ済み（merge commit `d21da1dc5cd83e745f717d1051f69a21d273a7eb`）。最終head `416da577fdbd0fa9e3ce8590cd4f144a17d0d0e6`の[製品CI](https://github.com/kitepon/Lattice/actions/runs/39861976551)はmacOS native・Linux workstation・Windows nativeすべて成功した。

[npm公開workflow](https://github.com/kitepon/Lattice/actions/runs/39863819228)は製品検査、配布物だけの導入確認、OIDC公開をすべて成功した。公開直後にnpm registryの明示版とlatestが`0.79.0`を示した。このMacへregistryから`@quolu/lattice@0.79.0`をglobal installし、`lattice --version`で同版を確認した。`lattice setup status --json`ではClaude・Codex・CursorのMCPとhookがverified、Grokのhookだけが既存契約どおりunsupportedだった。

導入済みCLIだけを使う一時Git projectで、機能逆算による工程作成、着手時の全体目的、完了証拠、ゴール変更後の完了保持、`todo show`、Codex hook案内、`todo verify`を確認した。smoke結果は`{"version":"0.79.0","first":"create","revised":"revise","task_state":"done","hook_guided":true,"verified":true}`。一時projectは試験後に削除した。

Lattice bridgeの実行版は`0.79.0`でruntime driftなし、heartbeat accepted、公開projectページはHTTP 200で本planを掲載した。`lattice status --json`は`hub_delivered`を返した。

main checkoutの文書gateが別のlinked Git worktreeへ再帰して失敗する欠陥も修理した。[PR #22](https://github.com/kitepon/Lattice/pull/22)をmainへマージし、[3環境CI](https://github.com/kitepon/Lattice/actions/runs/39865964963)と[npm公開workflow](https://github.com/kitepon/Lattice/actions/runs/39867390626)が成功した。`0.79.1`はregistryの明示版・latestの双方で取得可能。global install後の実利用smokeは`{"version":"0.79.1","first":"create","revised":"revise","task_state":"done","hook_guided":true,"verified":true}`。別worktreeが残るmainで`npm run check:docs`が成功した。
bridge実行版も`0.79.1`へ自動更新され、runtime drift無し・reachable・heartbeat accepted。公開projectページはHTTP 200で本planを掲載した。

検査中に見つけた別の実欠陥も同じrelease内で修理した。隔離checkoutの`npm test`がsensor build不在で失敗する問題は製品test入口で準備する形へ直した。WindowsのHub試験が固定ポートを使う問題は空きポートの実bindへ直した。Mac CIの高負荷でworker介入・故障報告が時間競合する問題は同時suite数を最大4本にし、失敗した3 suiteの4並列と最終macOS CIで確認した。
