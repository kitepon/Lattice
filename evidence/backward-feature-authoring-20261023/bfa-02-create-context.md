# 機能逆算による初回工程登録と作業文脈の証拠

`lattice plan backchain --input <file> --json`は、機能関係を検査した後、空storeでは`plan create`、既存storeでは`todo migrate`を一回の公開入口から実行する。契約はplan versionの保存領域へplan digest付きで置き、ToDoの設計メモにも全体目的、必要・提供機能、後続用途を加える。契約を持つToDoの`todo show`と`todo start`は構造化した`feature_context`を返す。旧planの出力は維持する。

隔離Git projectで、初回作成、欠けた工程依存の登録前拒否、既存storeへのplan追加、`todo show`、`todo start`を公開CLIから確認した。

検証: `test/plan-backchain-cli.test.mjs`は3件成功。関連する`project-cli`、`todo-migration-companion`、`todo-note-auto-context`を合わせて実行して成功。`npm run check`、`npm run check:cli-surface`、`npm run check:docs`、`git diff --check`は成功。

ゴール変更後の後継版とAI prompt導線は後続工程が持つ。
