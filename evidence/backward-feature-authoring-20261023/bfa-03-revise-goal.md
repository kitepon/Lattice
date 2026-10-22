# ゴール変更と工程再編の証拠

`plan backchain`は同じplan keyへの新しいゴール・機能契約・authoring入力を受け、旧版を残して`lattice.phase_todo_revision.v4`の後継版を作る。この契約はLatticeの機能定義を工程の正本とするため、従来のMarkdown行source inventoryとcutoverを通常変更へ要求しない。

変更されない工程の状態と証拠は保持し、機能契約又は工程入力が変わったものは既定でpendingへ戻し、不要な工程は後継版から外す。AIは`continuity`に理由を書き、既存の成果が変更後の条件を満たすと判断した場合にcarryを明示できる。作業中の工程をcarryした後は、同じ公開入口で新plan versionへstart束縛を付け直す。同じ入力の再実行は無意味な版や再束縛eventを増やさない。

隔離Git projectで、初回作成、一工程完了、新機能・ToDoの追加、ゴール変更、無関係な完了の保持、変更した受入条件のreset、理由付きcarry、不要なToDoの退役、作業中ToDoの再束縛、同一入力の再試行、`todo verify`を公開CLIから確認した。

検証: `test/plan-backchain-revise.test.mjs`は5件成功。既存の`todo-phase-revision-v3`、`todo-revision-writer`、`todo-revision`を合わせた関連testは成功。`npm run check`、`npm run check:docs`、`git diff --check`は成功。

着手eventより実装を先に行った順序違反は、このToDoのnoteへ時刻付きで記録した。
