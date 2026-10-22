# `lattice.todo_extraction.v4`

> 状態: 移行由来の契約だが、既存 store へ plan を足す現行入口である。
> **空 store の初回 authoring だけが `lattice plan create --input <lattice.plan_create_input.v4>`**。
> `plan create` は store 初期化専用で、既に `.lattice/todo` がある project では
> `STORE_WRITE_CONFLICT: store_already_exists` を返す。**既に plan を持つ store へ新しい plan を
> 足す、または既存task同士へ明示cross-plan hard dependencyを一件追加する移行入口は
> `lattice todo migrate --input <extraction JSON>`**。最終成果から機能を逆算して
> 新planを作る入口は`lattice plan backchain --input <file> --json`であり、
> 初回作成・既存storeへの追加・同じplanのゴール変更を同じ契約で扱う。Phase gate を伴う移行planは
> migrate で登録した後に `lattice todo revise-phase` で Phase を与える。

`lattice.todo_extraction.v4` は既存storeへ新planを足す、または既存task同士の一件の理由付き
cross-plan hard dependencyを接続する時にAIが作る現行authoring JSONである。
`todo migrate --schema --json`はこの
[JSON Schema](schemas/lattice.todo_extraction.v4.schema.json)を返す。公開入口が受理するのは
既存のv3と現行v4だけであり、v3の`tasks`非空・理由付きcross-plan edge契約は維持する。
空task接続とcross-plan edge高々一件の制約だけがv4の追加である。exact-key・sort・digest・意味制約は
`validateTodoExtraction` が所有する。`todo migrate` は Markdown を読まず、この JSON の検証と
`appendImportedPlan` による原子的登録または接続だけを行う。

各taskの`design_memo`は必須で、Markdownの設計メモをそのままToDo本体へ保存する。AIが何も考えて
いない場合も空値にはせず、問いかけ
「あなたがこのToDoに対して、何も考えていないならば、設計メモに `NO_PLAN` と書いてください」
への明示回答として`NO_PLAN`を書く。上限は16,384文字かつUTF-8で16,384 bytesであり、本文を
errorへ複製せず、type／blank／too_large／forbidden_controlとJSON pointerで訂正箇所を返す。

## status と fail closed

- `register_pending`: 未完として登録する。`completion` は `null`。
- `register_done`: 履歴完了として登録する。`completion.done_mode` は literal
  `historical_import` だけを許す。履歴時刻が一次証拠で確定しない場合、`completed_at` は
  `unknown_requires_evidence` とし、日付らしい散文・commit・観測日から推定しない。
- `exclude_superseded`: 外部正本へ編入済みで、二重登録を避けるため store task から除外する。
- `exclude_compatibility_record`: TODO 正本でない互換・完了記録を store task から除外する。
- `unknown_requires_evidence`: status、正本性、条件分岐などの裁定が不足している。schema として保持できるが、
  一件でも存在すれば `todo migrate` は store bytes を変えず `MIGRATION_UNRESOLVED` で拒否する。

v4の`tasks`が空の入力は、top-level planをsourceとする理由付きcross-plan hard dependency一件だけを
既存taskへ後付け接続する場合に限って受理する。この形は新planを作らず、target plan-scoped eventへ
そのedgeだけを原子的に追加する。v4ではcross-plan hard dependency自体も高々一件であり、v3を含むlocal dependency
の本数はこの制約で狭めない。それ以外の登録対象taskがない入力（`exclude_*`だけを含む場合を含む）は
`MIGRATION_EMPTY`で無変更終了し、空のtodo planを捏造しない。

裁定後は入力 JSON の該当 `disposition` と、必要なら `completion`／依存を明示的に更新し、
`extraction_digest` を再計算して同じコマンドを再実行する。拒否時は plan が member 化されていないため再実行できる。
登録成功後の同一 `plan_key` 再実行は、同じ入力でも ADR 0053 Decision 2a に従い
`STORE_WRITE_CONFLICT` となる。登録済み `completed_at: unknown_requires_evidence` の正規 evidence 昇格は
履歴を書き換えず、G5 の `todo evidence promote` で新 event として行う。

## 難所情報の保持

各 task の `source` は元 file/commit/line、見出し path、Markdown depth、親 task、checkbox stateを保持する。
`migration_context` は外部正本、carry-over、H 承認、条件、証跡参照、複数 repo／Control や gate の注記を保持する。
散文中の矢印、順序、先決、join は AI が裁定して `hard_dependencies`／`joins` へ明示した場合だけ edge になり、
tool が散文から edge を補うことはない。

## CLI

```text
lattice todo migrate --input <repo-relative-extraction.json>
```

成功時は stdout に `lattice.todo_migrate_result.v4` JSON 一行を返す。通常移送では`companion: null`を常在させ、
cross-plan companion接続を含む移送では接続・frontier・次の操作を同fieldへ返す。Phase無しの移送結果には
`phase_guidance`として`acquire_phase`の正規schema commandと次の一手を返す。typed failure は stdout を空にして
stderr に `lattice.cli_error.v2` 一行を返す。入力 JSON は repo 内に置く
（repo 外 path は `INPUT_OUTSIDE_REPOSITORY`で拒否する）。書込前診断は
`lattice todo migrate --input <ref> --dry-run --json`で行い、`lattice.todo_migrate_dry_run_result.v2`の
planned union（`connection_only: false`の通常planまたは`connection_only: true`の既存task接続）として
複数違反をpointer付きでまとめて返す。
この入口が担うのは**明示的な一回の登録または一件の既存task接続だけ**であり、
Markdown 同期、watch、再取込 pipeline として常設しない。
