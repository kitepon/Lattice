# 機能逆算工程の終端監査

判定: 受入。対象planは`backward-feature-authoring-20261023`のv1、全4 ToDoは完了している。

| 成功条件 | 確認結果 |
| --- | --- |
| 最終成果から機能を再帰的に宣言する | `lattice.plan_backchain.v1`がゴール、機能の前提と提供元、工程の必要・提供機能を保持する。到達性・循環・孤立を検査する。`bfa-01-contract.md`と`test/plan-backchain.test.mjs`で確認。 |
| 既知の機能の接続欠落を登録前に検出する | 提供元、工程の提供宣言、先決依存を検査し、欠落した関係を理由付きで拒否する。`bfa-01-contract.md`と`bfa-02-create-context.md`で確認。 |
| 未知を理由と問い付きで扱う | 未知の提供元を保持して登録でき、担当者の文脈に問いを載せる。`bfa-01-contract.md`とfocused testで確認。 |
| 担当者へ全体目的と後続用途を渡す | `todo show/start`の`feature_context`と設計メモで確認。隔離Git projectのCLI試験は`bfa-02-create-context.md`に記録。 |
| ゴール変更時に工程と状態を修正する | 後継版を作り、無関係な完了結果を保持する。意味の変わった工程は再実行対象にし、理由付きcarryと退役を扱う。`bfa-03-revise-goal.md`に実CLI試験を記録。 |
| 自然文依頼から正規入口を案内する | Claude・Codex・Cursorのhook試験で「Latticeで工程作って」の案内を確認。`bfa-04-entry-release.md`に記録。 |
| 配布版を利用面で確認する | 3環境CI、npm公開workflow、global install後の工程作成・変更・store検証、bridgeの版と公開ページを`bfa-04-entry-release.md`に記録。修理版`0.79.1`まで確認済み。 |

監査時の`lattice todo verify --json`は`verified_members`に本planを含み、`snapshot_stale: false`を返した。`registered_unreconciled`はsource inventoryの状態であり、工程の完了や公開利用を塞がない。宣言した機能の意味的十分性までは機械検査の主張に含めない。開発中に未知が解けたりゴールが変わったりした場合は、操作AIが新しい契約を作って後継版に反映する。
