# 機能逆算契約の実装証拠

`lattice.plan_backchain.v1`で最終ゴール、必要な機能、その提供元、工程ごとの必要・提供機能を定義した。提供元は工程、既存機能、理由と次の問いを持つ未知を区別する。

検査は、最終成果からの到達性、循環、孤立した機能、工程に欠けた入力、機能の提供元、提供工程から利用工程への依存を扱う。機能の意味的十分性は主張しない。作業者へ渡す目的・受入条件・後続用途の文面を、宣言したデータから組み立てる関数も追加した。

検証: `node --test test/plan-backchain.test.mjs` は6件成功。`npm run check` は構文検査成功。`git diff --check` 成功。

変更: `src/plan-backchain.mjs`、`src/todo-authoring-input.mjs`、`docs/schemas/lattice.plan_backchain.v1.schema.json`、`test/plan-backchain.test.mjs`。CLIへの接続、工程保存、着手時の同梱は後続工程が持つ。
