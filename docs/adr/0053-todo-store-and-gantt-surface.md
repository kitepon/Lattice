# ADR 0053: 工程store（todo_store.v1族）とガント出力面の契約

- Status: accepted
- Date: 2026-07-18
- 位置づけ: Phase LG（dotagents親裁定 2026-07-18・queue 23）のG1契約裁定。
  [実装計画](../plan_lattice_gantt.md)の論点①〜⑦を閉じ、G2以降の実装契約を確定する
- 前提: [ADR 0044](0044-rc3-runtime-contract.md)（CLI surface規約・exact-key規律・in-place拡張禁止）、
  [ADR 0052](0052-cli-error-v2-and-doctor-retirement.md)（`cli_error.v2`）、
  [00_product-contract.md](../00_product-contract.md)（versioned JSON・fail closed）、
  [Codex監査5レーンevidence](../evidence/2026-07-18-lg-codex-audit.md)（決定文案の一次出典。
  以下「監査#N-M」はレーンN指摘Mを指す）
- 反証: `fable`スポット諮問・`fable`×high refuter・クロスprovider Codex opinion（sol×xhigh）各1回。
  指摘と反映は末尾「反証記録」節
- 同日追補（2026-07-18・G2-W4）: G2設計調書への独立反証を受け、error taxonomy、
  `lattice.todo_chain.v1` wire、`todo verify`／`todo snapshot`成功resultとtodo CLI exit境界を精密化した。
  既存のAccepted裁定とscopeは変更しない
- 同日追補（2026-07-18・G4-W7）: G4移行tool実装で判明した、既存storeへのplan追加と
  完了済みtaskの履歴取込の契約欠落を補い、migration wave限定のhistorical importと後日の
  evidence昇格を裁定した。journal唯一正本、closedな遷移6 kind、単一writer運用は変更しない

## Context

オーナー裁定（2026-07-18）: AIの規律ではToDoの順序・チェック消化を維持できないため、工程を
機械管理する。散文はMarkdown正本のまま、工程は構造化storeを正本とし、書込はCLI経由に限定、
閲覧はブラウザのガントを主とする。Codex監査5レーンが、既存契約との整合・store設計・wave計画・
schema破損経路・レンダラ実現性を検証済み（P0裁定9系統）。本ADRはその決定文案を裁定として確定する。

前提事実の訂正（監査#1-8・#2）: 現行producerはhard dependencyを生成しない（`plan_input.v1`に
依存fieldがなく、conflict edge＋`joins: []`固定）。`plan_graph.v2`・`runtime_plan.v1`もAccepted
公開契約。よって「既存graphを読むだけでガント化できる」は成立せず、工程依存はstoreが所有する。

### 既存plan familyとの互換表（G1論点①の確定）

| 既存schema | 役割 | 依存表現 | todo storeとの関係 |
|---|---|---|---|
| `plan_input.v1` | ToDo候補＋手動evidenceの入口 | なし（依存field自体が無い） | G4一回きりadapterの参照入力。常設読替なし |
| `plan_graph.v1` | boundary compileの成果graph | conflict edgeのみ・`joins: []`固定 | 読替対象外（工程依存を持たない） |
| `plan_graph.v2` | RC2以降のcompile成果 | 同上系統 | 読替対象外 |
| `runtime_plan.v1` | dispatch用実行plan（1〜8 node・exact minimum） | precedence（現行producerは`[]`） | source変更taskの`compile_binding`照合先 |

Ganttが読むcanonical directed graphは**todo storeのhard dependency＋join**のみ（下記Decision 1）。

## Decision

### 1. 新契約族`todo_store`の採用（既存系列の拡張は却下）

- 既存`plan_input/plan_graph/runtime_plan`系列へのstatus・依存のin-place追加は**却下**。
  既存graph系は不変のdispatch用compile結果であり、status churnがdigest identityを壊し、
  exact-key規律（ADR 0044 Decision 2）とも矛盾する（監査#2）。
- 新schema族（すべてexact key・bounded・canonical serialization・fail closed）:
  - `lattice.todo_manifest.v1` — project単位のstore一覧（Decision 4）
  - `lattice.todo_plan.v1` — 1計画のtopology（task・hard dependency・join・lane・散文ref）
  - `lattice.todo_plan.v2` — v1 topology＋taskごとのimmutableなMarkdown行anchor（Decision 2b）
  - `lattice.todo_event.v1` — 遷移journalの1行（Decision 2）
  - `lattice.todo_snapshot.v1` — materialized projection（Decision 2）
  - `lattice.todo_chain.v1` — 最長依存鎖projection（Decision 7）
  - `lattice.todo_gantt_result.v1`ほかCLI result族（Decision 6）
- **joinの意味論**: todo_plan.v1/v2のjoinは既存planJoinと同形の`{id, after[], before}`・
  **all-of barrier**（`after`の全taskがdoneで充足）とする。start可否・最長依存鎖・閉包検査は
  この意味論で判定する。
- **source変更taskのoptional `compile_binding`**: boundary_manifest digest・compiled plan digest・
  topology digest・base SHAを持ち、dispatch時に照合する。工程storeは並列安全性を主張せず、
  boundary evidence契約を代替しない（監査#2の契約境界どおり）。`done`はbindingを無効化せず、
  依存変更は必ず無効化する。
- 既存plan familyからの取込はversioned adapter（G4移行tool）経由の一回きり変換とし、
  常設の読替えを作らない。

### 2. store正本規律（journal唯一正本・closed状態機械）

- **journalが唯一の正本**。snapshotは破棄可能なmaterialized projection。**journal破損と
  snapshot不整合は別扱いにする**（Codex opinion#1、2026-07-18 G2-W4追補）:
  - `STORE_CORRUPT`: 現segment／sealed segmentのraw bytes、行canonicality、schema、上限、genesis、
    sequence／digest link、segment連結のいずれかが不正で、journal正本を検証・replayできない状態。
    snapshotの状態によらずreader・writer・render・verifyを全拒否する。
  - `STORE_INCONSISTENT`: **journal自体は健全だが、その投影を信頼できない整合性違反に限定する**。
    manifest／planのraw bytes・schema・self-digest不正、active plan／genesis binding／topology digestの不一致、
    欠落・余剰・重複active version、dangling／self edge、join closure違反、merge後cycle、
    cross-plan topology binding不一致を含む。
    `binding_stale`は独立したtop-level error codeではなく、この最後の違反を表す`cli_error.v2.detail.reason`
    の値とする。一件でもあれば部分投影を返さずreader・writer・render・verifyを全拒否する。
  - `snapshot_stale`: journalが健全で、snapshotだけが欠落、旧head、projection/digest/body不一致、または
    **snapshot単独のbyte異常**（invalid UTF-8、BOM、CR、duplicate key、trailing bytes、merge marker、
    truncated write、schema混在、non-canonical bytes、snapshot上限超過を含む）で採用不能な状態。
    error codeではなく成功resultのbooleanである。**readerは検証済みjournalからのread-only投影で
    読み続け**、`snapshot_stale: true`を返す。暗黙のsnapshot書換えはせず、修復は明示的・決定的な
    `lattice todo snapshot --rebuild`（journal replayのみを根拠）だけが行う。writerはsnapshot再整合まで
    新規mutationを拒否する。expected pathがsymlink、repo外、非regular fileである場合は
    `snapshot_stale`へ丸めず、下記path containment規律によりhard rejectする。
  - snapshotは`projection_version`・`through_sequence`・`journal_head_digest`・`snapshot_digest`を
    必須とし、健全時のreaderはreplay結果とのcanonical exact一致を要求する（監査#4-1）。
  - **commit point**: 既存memberへのmutationの耐久化はjournal segmentのfsync＋atomic rename完了時点と
    定義する。snapshot・manifestの更新はその後段で、クラッシュしても正本は失われない（crash matrixを
    G2 fixtureで固定する）。まだmemberでないplanを追加するhistorical importだけは、staged plan／journalを
    manifest memberとして可視化するmanifest CASを外部可視性のcommit pointとする（Decision 2a）。
- **遷移kindはclosed集合6種**: `plan_genesis | start | block | unblock | done | reopen`。
  G4 historical importとG5 evidence昇格もこの集合を増やさず、`start`／`done`のclosed payload variantとして
  表現する（Decision 2a）。
  各eventは`sequence`・`previous_digest`・`actor`・timestamp・optional `provenance`を持つ。
  - `plan_genesis`: **journalの第0 event**。plan_version・（successorの場合）旧version digest＋
    task移行map・対応するtodo_plan.v1/v2のdigestを持ち、successorでは`previous_digest`を旧journal
    head digestへbindする。
  - `start`: authored startはpendingのみ受理。依存（hard dependency・join）未充足なら拒否。強行は
    `override_reason`必須field付きでのみ許す。migration専用の輸入startはDecision 2aの
    discriminator・writer・受理条件をすべて満たす場合だけのclosed例外である。
  - `block`: in-progressのみ受理（未start・done後・blocked中の重複blockは拒否）。`reason`必須。
  - `unblock`: blockedのみ受理。**復帰先はin-progress**（blockはstart済みが前提のため）。
  - `done`: 通常のauthored completionはin-progressのみ受理（blocked中は拒否＝unblock先行必須）。
    **依存充足をdone時にも再検査**し、evidence descriptor必須（Decision 5）。通常の重複doneは拒否。
    migration専用のpending→doneと、statusを変えないdone→doneのevidence昇格はDecision 2aの
    discriminator・writer・受理条件をすべて満たす場合だけのclosed例外であり、authored受理条件を
    緩めない。
  - `reopen`: doneのみ受理。`reason`必須・**`target_done_digest`必須**（取り消すdone eventへの
    束縛）。元doneのevidenceはjournalに残り、statusはin-progressへ戻る。**当該doneを依存根拠に
    start済みの後続taskが存在する場合は拒否**し、強行は`override_reason`型でのみ許す
    （fable諮問判断3・Codex opinion#2。AIの誤doneは高頻度に起きる前提で、訂正を軽い前方遷移として
    提供しないと誤doneが正史に残る）。
  - **status投影は関数**: pending（startも有効なhistorical import doneも無し）／in-progress
    （start済み・未done・非blocked）／blocked（start済み・block未解除）／done。historical import doneは
    latentなstarted状態を含むdoneとして投影し、evidence昇格はstatusを変えない。これによりimported doneを
    `reopen`した場合も従来どおりin-progressへ戻り、偽のstart event／開始時刻は作らない。
    historical import startは通常startと同じin-progressへ投影するが、開始時刻unknownを現在時刻で埋めない。
    blocked未start・done∧blocked・同一import dispositionでのin-progress∧done/blockedは遷移表上構成不能。
- `started_at`/`done_at`は表示・監査用のlocal-untrusted値で、順序・有効性の根拠にしない。
  todo族のtimestampはstrict round-trip parser（`YYYY-MM-DDTHH:mm:ss.sssZ`・実在暦日）で検証し、
  clock reversal・過大future skewはtyped anomalyとして拒否する（監査#4-11）。**適用はtodo族限定**。
  既存契約の`2026-02-30`受理欠陥はG2で影響範囲を確認し、既存schemaの受理集合を変える場合は
  ADR改訂を経る。
- **actorの値空間**: `{host, session, agent}`のexact-key構造体（それぞれbounded string）。
  Stop hook WARN・override監査はこのactorへ相関する。
- **provenance**: optional `{source_commit, source_event_digest}`。reconcile再発行（Decision 4）が
  元履歴への参照をここへ載せる。
- **topologyはimmutable**: 1つの`plan_version`に属するtask・依存・join・laneは不変。topology変更
  （task追加・削除・依存変更）の唯一の入口は**`lattice todo revise`**で、1回の呼び出しが変更batchを
  受けてsuccessor plan versionを1回発行する（軽いCRUDに見せない。Codex opinion#7）。削除taskは
  移行mapで明示的に`removed`と宣言し、残存taskの依存が削除taskを指す場合はfail closed。
  **書込順序契約**: successor発行は①新todo_plan.v1/v2書込→②新journal（plan_genesis）書込→
  ③manifest更新（activation）の順。readerはmanifestが指すgenesis/plan欠落を全拒否＝途中クラッシュは
  「新version未発行」へ倒れる。**activation gateで全inbound cross-plan refを検査**し、破れがあれば
  activationを拒否する（Codex opinion#3）。
- **journal file layoutと書込protocol**: journalはUTF-8・LF終端JSONL。一行一event、各行は
  `canonicalizeArtifact(event) + LF`とbyte-exact一致。**headの正本はactive segmentの最終行**で、
  専用head fileは持たない。書込はstore scoped lock下で①active segment全読・検証②CAS照合
  （`expected_head_sequence`/`expected_head_digest`は**lock内で内部取得**しCLI引数に持たない。
  不一致は`STORE_WRITE_CONFLICT`で無変更終了・自動retryなし）③temp fileへ全文書込→fsync→
  atomic renameでsegment全置換。event digestはschema・store identity・plan bindingを含む
  typed preimage、segment digestはexact file bytes（監査#4-4, 9）。
- **snapshot serialization契約**: 単一canonical JSON value＋LF・self-digest規則・collectionの
  並び順はfieldごとにschemaで規定する（監査#4-4後半）。
- **todo族のper-schema上限**（既存`canonicalizeArtifact`系の256 item/1 MiB既定を無変更再利用せず
  自前裁定。監査#1-7）: 1planあたりtask 512・edge 2,048・join 128（**ADR 0201で件数上限は撤廃**、大きさはbyte上限が守る）。journal segmentは1 MiB到達で
  rotation。snapshotは8 MiB。散文1節は256 KiB。超過はfail closed。
- **compactionはseal/rotationのみ**: 過去segmentは開始/終了sequence・前segment head digest・
  segment digestを持つimmutable fileとして残す。prefix破棄・真正な履歴削除はv1で禁止
  （別schema・別ADR。監査#4-5）。
- **journal側byte-level fail closed**: 現segment／sealed segment raw bytesのfatal UTF-8 decode・
  BOM/CR/duplicate key/trailing bytes/merge marker/truncated write/schema version混在/genesis欠落/
  上限超過は`STORE_CORRUPT`で全拒否する。この全拒否規則をsnapshot単独byte異常へは適用せず、
  上記`snapshot_stale`として隔離する。全artifactのpath検査はlstat/realpathでsymlink・repo外・
  非regular fileを拒否する（監査#4-14、2026-07-18 G2-W4追補）。

### 2a. G4 migration wave限定historical import（2026-07-18・G4-W7同日追補）

- **入口と一回きり性**: historical importは`g4-migration` writerだけが呼べる内部writer operation
  `appendImportedPlan`であり、公開の常設authoring CLIではない。入力Markdownを解釈してよいのはこの
  migration waveの変換時だけで、wave完了後は入口を退役させる。Markdownからjournalを継続同期する
  読替え・watcher・再取込pipelineは
  作らない。import用`plan_genesis`は`historical_import: true`を必須markとして持ち、これをplan単位の
  import完了印とする。plan単位の完了後は同じ`plan_key`の再importを、入力digestが同じ場合も成功扱いにせず
  `STORE_WRITE_CONFLICT`（`detail.reason: plan_key_already_imported`）で無変更拒否する。import由来でない
  同一`plan_key`が既にあれば`detail.reason: plan_key_already_exists`で同じく無変更拒否する。
- **既存storeへの原子的plan追加**: store scoped lock内で、①現manifestのraw bytes・schema・self-digestと
  全memberを検証、②`plan_key`が既存memberに無いことを確認、③todo_planと第0 `plan_genesis`から始まる
  journalを非memberのtransaction staging領域へ書いてfsync、④lock内で取得したmanifest digestを
  expected valueとして再照合、⑤plan／journalを確定pathへrenameしてから、旧member全件＋新member1件を
  含むmanifestをtemp書込・fsync・atomic renameする。⑤のmanifest renameだけが新planの可視化commit pointで、
  readerは旧manifestまたは新manifestの全体だけを見る。CAS不一致は`STORE_WRITE_CONFLICT`でmanifestを
  変更せず、staging artifactはmemberとして扱わない。クラッシュ回復はmanifestに未掲載のtransaction
  staging artifactまたはtransaction所有のpre-activation確定pathをmemberとして読まず、破棄して
  再実行できる。manifest掲載後は再実行を上記冪等拒否とする。同一
  `plan_key`の既存plan（import由来か否か）への上書き・merge・successor化もこの入口では拒否する。
- **`done` payloadのclosed union**: `done`は共通event envelopeに加え、`done_mode`で次の3 variantを
  discriminator付きexact-key unionとして持つ。`imported`はprojectionにも保存し、authored completionと
  import由来completionを機械判別できる。
  - `done_mode: authored`: `imported: false`とDecision 5の正規`evidence`を持つ。受理matrixは従来どおり
    in-progress→doneだけで、Decision 5のwrite時hard検証を一切緩めない。
  - `done_mode: historical_import`: `imported: true`、literal `status: done`、`completed_at`、`evidence`を持つ。
    `completed_at`はtodo族のstrict timestampまたはliteral `unknown_requires_evidence`だけを受理する。
    `evidence`は下記`lattice.todo_import_source.v1`でなければならない。`g4-migration` writerが新planを
    原子的追加する同一transaction内でのみpending→doneを受理し、通常writer、既存member、import完了後の
    journal headでは拒否する。依存未充足の歴史状態を現在の順序規律へ捏造しないため、このvariantは
    start／依存充足を要求しないが、その例外は`imported: true`の履歴に固定され、後続taskの通常start／doneは
    import後のprojectionに対して従来どおり依存を検査する。genesis直後は全task pendingであり、移行元で
    完了済みのtaskごとにこのeventをappendしてdoneへ投影する。輸入startもdoneもないtaskはpendingのまま残す。
  - `done_mode: evidence_promotion`: `imported: true`、`target_done_digest`、Decision 5の正規`evidence`を
    持つ。対象が最新有効completionである`historical_import` done、かつその`completed_at`が
    `unknown_requires_evidence`である場合だけdone→doneを受理する。statusと元の`completed_at`は変えず、
    projection上のevidenceを昇格先へ更新する。元eventと移行元descriptorはjournalに残す。
- **輸入`start` payloadのclosed variant**: `start_mode: historical_import`、`imported: true`、literal
  `status: in-progress`、`started_at`、`evidence`をexact keysで持つ。`started_at`はtodo族のstrict
  timestampまたはliteral `unknown_requires_evidence`だけを受理し、後者をeventの`recorded_at`や現在時刻で
  埋めない。`evidence`は下記`lattice.todo_import_source.v1`に限る。`g4-migration` writerが新planを
  原子的追加する同一transaction内でのみpending→in-progressを受理し、通常writer、既存member、
  import完了後のjournal headでは拒否する。歴史状態保存のため輸入時の依存充足は要求しないが、import後の
  authored doneには通常どおり依存充足を要求する。同一taskを輸入startとhistorical doneの双方へ指定する、
  または`status: blocked`を指定する入力はactivation前に無変更拒否する。projectionはstrict timestampなら
  その値を`started_at`へ、unknownなら`null`を置き、いずれも通常の`in-progress`として`todo status`の
  `active_set`およびganttへ渡す。
- **extraction schema version**: ADR 0044の「field追加・意味変更はschema versionを上げ、v1への
  in-place拡張を禁止」に従い、公開済み`lattice.todo_extraction.v1`は受理集合を変更しない。
  `lattice.todo_extraction.v2`はv1のtop-level exact keysを継承し、taskへ必須`start` keyを追加する。
  `register_in_progress`だけがexact payload `{start_mode: historical_import, status: in-progress,
  started_at: <strict timestamp | unknown_requires_evidence>}`と`completion: null`を持つ。
  `register_done`は`start: null`、その他のdispositionは`start/completion`ともnullとし、in-progressと
  done/blockedの重ね合わせをschemaで構成不能にする。migration CLIは既存v1とv2をschema dispatchで読み、
  v1 artifactの暗黙upgradeや書換えをしない。
- **移行元descriptor**: `lattice.todo_import_source.v1`のexact keysは`schema, origin_plan_ref,
  origin_line, source_commit`。`schema`は同名literal、`origin_plan_ref`はstoreのproject repoを基準とする
  移行元plan Markdownの正規化済みrepo相対path、`origin_line`はGit blobをLFで区切った1始まりの
  safe integer、`source_commit`は移行時に固定した
  完全長lowercase Git commit object id（省略形は禁止）とする。import時はcommit objectの存在、
  当該commitでpathがblobに解決すること、lineがblobの行範囲内であることをhard検証する。descriptorは
  移行元の開始／完了記載を指す監査出典で
  あって、Decision 5のcompletion evidenceへ暗黙変換しない。
- **G5 evidence昇格**: `lattice todo evidence promote --plan <key> --task <id> --evidence
  <descriptor.json path>`をG5 authoring CLIに追加し、成功resultは`todo_mutation_result.v1`とする。
  writerはlock内で対象import doneを解決し、そのdigestを`target_done_digest`へ記録して、正規evidenceを
  Decision 5どおりhard検証した後に`evidence_promotion` eventをappendする。対象不一致、既昇格、authored
  done、strict timestampを持つimport doneへの適用は無変更拒否する。昇格は常に新eventであり、segment・
  snapshot・元eventの履歴改変ではない。
- **verify規律**: `todo verify`はimported startと未昇格のimported doneについて、移行元descriptorのcanonical schema、
  pinned commit、commit時点のpath→blob、line範囲の整合までをhard検証し、Markdown文言の再解釈や
  Decision 5 descriptorの後付け推測をしない。authored doneは従来どおりDecision 5をhard検証する。
  昇格済みimported doneは移行元descriptorの整合に加え、promotion eventの正規evidenceをauthored doneと
  同じ強度でhard検証する。いずれもjournal eventとして通常のsequence、previous digest、event digest、
  canonical bytes、segment chain、rotation、CAS規律に完全に従う。

### 2b. `todo_plan.v2` narrative anchor（2026-07-18・G4-R11追補）

- **wireと正本境界**: `lattice.todo_plan.v2`を新設し、top-level exact keysとtask以外の意味論は
  v1を継承する。v2 taskのexact keysは`task_id, title, lane, narrative_ref, narrative_anchor,
  compile_binding`。`narrative_anchor`は`null`またはexact keys `origin_plan_ref, origin_line,
  source_commit, source_line_digest`で、refは正規repo相対path、lineは1始まりsafe integer、commitは
  lowercase完全長40/64桁object ID、line digestはlowercase 64桁SHA-256とする。非null時は
  `narrative_ref === origin_plan_ref`を必須とする。anchorはtask配列とともにtopology/plan digestの
  preimageへ入り、statusの正本は従来どおりjournalだけである。
- **immutable version規律とv1互換**: readerはv1/v2をschema dispatchで読み、active v1 planを暗黙に
  v2へ書換えない。v1はanchor無しのrenderer fallbackとして読み続け、anchor化はowner指示による
  successorまたは一回きりreimportだけで行う。anchorの追加・変更・task間移動はtopology変更であり
  successor versionを必須とする。v2からv1へのschema退行は禁止する。既に検証済みの同一task・同一anchorを
  successorが保持する場合はpinned objectの再取得を要求せず、新規または変更anchorだけを発行時にhard検証する。
- **migration materialization**: `lattice.todo_extraction.v1`は変更せず、v2も同じsource contractを継承する。
  G4 import transaction内で
  registered taskの`source.origin_plan_ref/origin_line/source_commit/checkbox_state`を使い、pinned
  `source_commit:origin_plan_ref` blobの固定行をLF byte `0x0a`で区切って取得する。行末LFを含まないexact
  line bytesのSHA-256を`source_line_digest`とし、UTF-8 Markdown checkbox list itemで、extractionの
  checked/unchecked stateと一致し、かつtaskの`narrative_ref`とpathが一致する場合だけanchorを作る。
  commit/path/lineを取得できない、非checkbox、state矛盾、path不一致、checkbox absent/ambiguousは
  importを推測で埋めず`narrative_anchor: null`として登録する。title・heading・近傍文・同文検索・offset
  修復はすべて禁止する。historical doneのDecision 2a evidence hard検証はこのfallbackで緩和しない。
- **発行時検証と読取後のobject欠落**: import/initialize/successor writerが新しい非null anchorを発行する
  ときは、source commitがcommit、pathがblob、固定行がcheckbox item、exact line digestが宣言値と一致する
  ことをactivation前にhard検証し、不一致は`STORE_INCONSISTENT`・`narrative_anchor_unverified`で無変更拒否する。
  activation後にshallow/prune等でpinned Git objectが取得不能になってもplan/journalの読取を拒否しない。
- **表示時fail closed（renderer実装の受入契約）**: current worktreeのsafeな`narrative_ref`をLF正規化せず
  fixed lineで取り出し、line digest一致、Markdown AST `listItem.position.start.line`一致、checkbox node、
  同一document内のline claim一意性をすべて満たす場合だけstatus markを元行内へ埋め込む。anchor欠落、
  path不一致、line欠落、digest不一致、非checkbox、duplicate claim、AST location欠落では行内化を一切せず、
  Markdown本文を無変更で表示してdocument先頭のWARN＋末尾の別置きtask stateへ落とす。current text driftは
  store破損ではないため`STORE_INCONSISTENT`にせず、structured warning reasonとsorted outcomeをganttの
  narrative binding/result digestへ束縛する。別行探索・title fuzzy match・候補選択による再配置は禁止する。

### 3. 配置・git・coverage分離

- store正本は**`.lattice/todo/`配下・git tracked**（gitignore不可。「GitHubが真実」の親運用に乗せる）。
  生成物（ガントHTML等）は**`.lattice/generated/`配下・gitignored**。両rootを混在させない。
- storeはCodegraph coverage・source snapshotから除外し、store digestはgantt result identityへ
  別途束縛する（監査#1-5）。coverage分離のintegration testをG2で先行させる。

### 4. 複数plan統合・並行書込・真実性

- **task identityは`{project_id, plan_key, task_id}`のstructured tuple**（表示・logical identity）。
  **cross-plan依存のbindingはこれに加えて`expected_topology_digest`を必須とする**——参照先planが
  successor versionへ進んだとき、bindingが旧topologyを指したままなら統合readerは当該edgeを
  `binding_stale`としてfail closedし、`todo revise`での再bindを要求する。activation gate
  （Decision 2）が全inbound refを検査する（Codex opinion#3。merged graphの意味の暗黙変更を禁止）。
- `project_id`と`plan_key`は`todo_manifest.v1`で一意に宣言。**manifestはself-digest付きで、
  sorted member一覧・active plan version・各store head digest・plan topology digestを列挙する**
  （監査#4-7決定文案を全量採用。遷移ごとのmanifest更新は単一小file・同一lock内で許容）。
  統合readerは全memberをexactにロードし、欠落・余剰・重複active version・dangling/self edge・
  join欠落・merge後cycleを検査、一件でもあれば部分graphを返さない。glob discoveryは行わない。
- **laneの正本はtodo_plan.v1/v2**（topologyの一部・immutable）。manifestはlaneを宣言せず、表示順の
  並べ替えのみ生成時オプションで許す。laneはpresentation-only projectionで、edge・最長依存鎖・
  capacityを生成しない。global capacity schedulingはv1非対象（監査#4-8）。
- **Git分岐はfast-forward onlyで受理**: merge commit・複数head・sequence renumber・digest手動
  resealをCIとreaderが拒否。競合は専用`lattice todo reconcile`で再発行し、元commit・元event
  digestをevent `provenance`に残す。fork解消前はrender・status・追加writeを全停止し、
  **reconcileだけがfork状態で許される唯一のmutation**。
- **並行可用性の限界を明文化**（Codex opinion#4）: 本規律が提供するのは「競合安全な直列化」であり
  複数端末の並行可用性ではない。**v1は事実上の単一writer運用を前提とする**。canonical branchは
  repoのdefault branch・upstreamは`origin`とし、writerは書込時に観測upstream commitをevent
  provenanceへ記録できる。offline時の書込はlocal直列化のみ保証され、push拒否＝fork検出時は
  reconcileまで追加writeを停止する。rebase/squash/mergeによるstore履歴の書換えは受理しない。
  reconcileはidempotent（同一resolution再適用で重複eventを作らない）を契約とする。
- **真実性3段階**: `unattested`（未commit、または未検証checkout）→ commit → CI `todo verify`
  通過=accepted。生成HTML・CLIはlocalで`todo verify`を再実行した結果として`local-verified`までを
  主張でき、`accepted`はCIだけが宣言する（HTMLはsource commit idと検証状態を表示する）。
  digestはcorruption検出でありactor真正性を証明しない。accepted truthはcanonical branch上で
  CI verifierを通過したcommitと定義する（監査#4-13）。enforcementの実体はCI/`todo verify`であり、
  「CLI経由のみ」はファイル権限では強制されない（監査#2落とし穴5）。

### 5. evidence descriptor

- completion evidenceはbare path/stringを禁止し、`{evidence_id, repo_id, path, git_blob_oid,
  content_digest, media_type, anchor_digest|null}`のtyped descriptorとする。**`git_blob_oid`
  （pinned object）が歴史的検証の正本**で、pathは表示・現在地案内用（Codex opinion#9）。
- `repo_id`→実repoの対応は`todo_manifest.v1`が宣言する。**done成立時（write時）はhard検証**
  （blob存在＋content digest一致。検証不能ならdoneを成立させない）。**read時**にpinned oidが
  解決不能（repo checkout不在・shallow等）な場合はstore全体を拒否せず、当該doneへ
  `evidence_unverified`注釈を付けて表示する（journal構造破損とevidence一時取得不能を同じ
  失敗へ潰さない）。説明用Markdown linkとdone evidenceは別field（監査#4-12）。

### 6. CLI面 — 新namespace `lattice todo`

- 新公開面は**`lattice todo <subcommand>`**へ統一。計画の仮称`lattice plan gantt`は
  **`lattice todo gantt`へ確定**——既存`plan compile/verify`はdispatch系であり同居させない。
  `todo verify`と`plan verify`の誤打鍵はusage診断で相互に案内せず黙って他面へ流さない（G2 fixture）。
- **subcommand契約表**（exact argv。共通規則: store rootはcwdのgit toplevel配下`.lattice/todo/`
  固定で探索しない。stdout=result schema 1行・stderr診断・exit 0/1/2・`cli_error.v2`・
  **exit 1/2時のstore bytes不変**）:

| subcommand | argv | result schema | wave |
|---|---|---|---|
| `todo migrate` | `--input <extraction.json path>` | `lattice.todo_migrate_result.v1`（store未存在時は抽出`project_id`＋self repositoryで完全storeをstagingし、import成功時だけ`.lattice/todo`へdirectory rename。失敗時は初期化を含め無変更） | G4 |
| `todo start` | `--plan <key> --task <id> [--override-reason <text>]` | `todo_mutation_result.v1` | G5 |
| `todo block` | `--plan <key> --task <id> --reason <text>` | 同上 | G5 |
| `todo unblock` | `--plan <key> --task <id>` | 同上 | G5 |
| `todo done` | `--plan <key> --task <id> --evidence <descriptor.json path>` | 同上 | G5 |
| `todo evidence promote` | `--plan <key> --task <id> --evidence <descriptor.json path>` | 同上（imported doneの正規evidence昇格） | G5 |
| `todo reopen` | `--plan <key> --task <id> --reason <text> [--override-reason <text>]` | 同上（`target_done_digest`は内部で最新doneへ解決しeventへ記録） | G5 |
| `todo revise` | `--plan <key> --input <revision.json path>` | `todo_revise_result.v1`（successor version発行の唯一入口） | G5 |
| `todo verify` | `[--plan <key>]`（既定=全member） | `lattice.todo_verify_result.v1`（bytes・chain・遷移・evidence hard検証のlocal検証まで所有。CI attestationはCIの領分） | G2 |
| `todo snapshot` | `--rebuild --plan <key>` | `lattice.todo_snapshot_result.v1` | G2 |
| `todo gantt` | `[--out <repo相対ref>]`（既定`.lattice/generated/gantt.html`） | `todo_gantt_result.v1` | G3 |
| `todo gantt status` | `[--out <repo相対ref>]`（既定`.lattice/generated/gantt.html`） | `todo_gantt_status_result.v1` | G3 |
| `todo reconcile` | `--input <resolution.json path>` | `todo_reconcile_result.v1`（手順詳細はG5着手時の追補で固定） | G5 |

- CAS期待値は引数に持たない（lock内内部取得。Decision 2）。mutation系はdry-runを持たない
  （fail closedが既定で、成功以外はstoreへ触れないため）。
- **G2成功result wire（2026-07-18 G2-W4追補）**: 以下はすべてexact-key objectで、digestは
  lowercase 64桁SHA-256、sequenceはnon-negative safe integer、refはrepo相対、member配列は
  `plan_key`の後述text順、`project_id`／`plan_key`はtodo族のbounded identifierとする。
  各`schema` fieldは項目名と同じ完全修飾literal、`result_digest`は同fieldを除くobjectの
  canonical digestである。
  - `lattice.todo_verify_result.v1`のexact keysは`schema, project_id, requested_plan_key,
    verified_members, snapshot_stale, result_digest`。`requested_plan_key`は全member検証時`null`、
    `--plan`指定時はそのbounded identifier。`verified_members[]`のexact keysは`plan_key,
    topology_digest, journal_head_digest, through_sequence, snapshot_stale`。top-level
    `snapshot_stale`はmember値の論理OR（空memberは許さない）で、stale memberがあってもjournal replayに
    よる検証成功ならexit 0とする。
  - `lattice.todo_snapshot_result.v1`のexact keysは`schema, project_id, plan_key, snapshot_ref,
    through_sequence, journal_head_digest, snapshot_digest, result_digest`。成功時の`snapshot_ref`は
    `.lattice/todo/`配下の再構築済みsnapshotを指し、`snapshot_digest`は実際に確定したcanonical bytesへ
    束縛する。current snapshotの再構築も同じbytes・同じresultを返す。
- **todo CLIだけのexit wire（2026-07-18 G2-W4追補）**: ADR 0044 Decision 8を継承し、exit 0は
  stdoutへ成功result JSON一行、exit 1はstdout空・stderrへ`lattice.cli_error.v2` JSON一行、exit 2は
  usage違反としてstdout空・stderrへ人間向け診断一行を返す。`cli_error.v2`は**`lattice todo`面では
  exit 1に限定**し、exit 2へJSON envelopeを出さない。exit 1/2はいずれもstore bytes不変とする。
- `todo gantt`のstdoutは**repo相対`output_ref`**＋input束縛digest群。絶対file://パスをportable
  resultへ入れない（解決はstderr診断またはdotagents hook側。監査#1-2）。result digestは単数でなく、
  sorted member manifest・各store head・active topology・evidence／埋込散文content digest・
  projection／renderer versionを含むversioned preimageへ束縛する（監査#4補記）。
- 既存面matrix（CLI 6面・runtime-errors・`--version`・`factory-diagnostics`・MCP）へ`todo`面を
  追加し、routing非回帰testを置く。`src/runtime-cli.mjs`のstale docstring（v1表記）もG2で追従修正
  （監査#1-9）。

### 7. 最長依存鎖projection（旧称を廃す）

- 監査#5-5のとおり、無duration DAGのhard_need最長鎖を実時間の律速経路と呼ぶことはできない。v1は監査二択の
  どちらでもない**第三案**を採る: 全taskをunit-durationとみなし、**hard dependency＋join制約のみ**を
  辺集合とするlongest path構造を導出する。conflict系edgeは無向で経路に載らず（監査#1-3）、
  capacityはv1非目標のため辺集合に含めない。
- 名称は日本語**「最長依存鎖」**・英語**`longest dependency chain`**とする。実時間律速や
  資源制約込みを意味する既存の工程管理術語は使わない（Goldratt CCPM由来の誤読も輸入しない。
  fable諮問判断2・Codex opinion#6）。UI・受入文言も「最長依存鎖」を使い、表示には
  「unit-weightの構造深さであり実時間・資源律速ではない」旨を常時明記する。
- `todo_chain.v1`は**非列挙projection**とする（Codex opinion#5。最長鎖の全列挙は2,000 task内でも
  `2^1000`級に爆発する）: 内容は①最大依存深さ②いずれかの最長鎖に属するnode/edgeの和集合
  ③最長鎖本数（上限付きcount＋overflow flag）④deterministicな代表鎖を最大8本。
  `assumptions`固定literal field（`unit_duration: true`・`capacity_ignored: true`・
  `conflict_ignored: true`）を必須で持つ。
- **`lattice.todo_chain.v1` wire（2026-07-18 G2-W4追補）**: exact keysは`schema,
  maximum_dependency_depth, longest_chain_node_refs, longest_chain_edges, longest_chain_count, limits,
  representative_chains, assumptions`で、`schema`はliteral `lattice.todo_chain.v1`。node refは
  exact keys `project_id, plan_key, task_id`、edgeは
  exact keys `from, to`（両方node ref）、`longest_chain_count`はexact keys `count, overflow`、`limits`は
  exact keys `count_cap, representative_limit`、`assumptions`は上記3 literalだけを持つ。空graphは深さ0、
  count 0／overflow false、3 arrayとも空。非空graphの深さは最長鎖のnode数とする。node unionはnode順、
  edge unionは`from`後`to`のnode順、各代表鎖内はpath順、代表鎖配列は次項のDFS発見順でcanonical化し、
  入力node／edge／join配列の順序に依存させない。深さ、count、`limits`の2値はnon-negative safe integer
  （ただし`count_cap`は次項の正数範囲）とする。
- **比較規則とoptions**: node refのtuple comparatorは`project_id`→`plan_key`→`task_id`の順に、
  最初に異なるfieldで比較する。各textはECMAScriptの抽象関係比較と同じUTF-16 code unit辞書順
  （`left < right`／`left > right`。locale、case folding、Unicode normalizationなし）とする。
  optionsはexact keys `countCap`／`representativeLimit`のみ（各keyは省略可）、既定値はそれぞれ
  1,000,000／8。`countCap`は1以上`Number.MAX_SAFE_INTEGER - 1`以下のsafe integer、
  `representativeLimit`は0以上8以下のsafe integerに限定し、unknown key・範囲外・非整数をfail closedする。
  wireの`limits`には採用した値をsnake_caseで記録する。最大8本というAccepted裁定をoptionで拡張しない。
- **DPと飽和**: hard edgeとjoinの各`after_i -> before`を展開後、同一`(from,to)`を一度だけ数える。
  sourceでは`down[v]=waysDown[v]=1`、それ以外は`down[v]=1+max(down[p])`かつ
  `waysDown[v]=Σ waysDown[p] where down[p]+1===down[v]`。sinkでは`up[v]=waysUp[v]=1`、
  それ以外は`up[v]=1+max(up[s])`かつ`waysUp[v]=Σ waysUp[s] where up[s]+1===up[v]`。
  `D=max(down[v])`、`count=Σ waysDown[v] where down[v]===D`とする。各加算は
  `sat(a,b)=min(countCap+1,a+b)`で即時飽和し、内部値`countCap+1`を唯一のoverflow sentinelとする。
  実装は`a+b`を先にunsafe integer化せず、`a > countCap+1-b`を先に判定してsentinelへ飽和させる。
  wireは`count=min(internalCount,countCap)`、`overflow=(internalCount===countCap+1)`を返す。
  node採用条件は`down[v]+up[v]-1===D`、edge `u -> v`の採用条件は
  `down[u]+up[v]===D`である。
- **代表鎖の決定規則**: 開始nodeは`down[v]===1 && up[v]===D`を満たすものをtuple順に走査する。
  各nodeでは`up[s]+1===up[v]`を満たすsuccessorだけをtuple順にdepth-firstで辿り、sink到達時に
  1本emitする。全開始nodeをまたぐ単一のDFS発見順で`representativeLimit`本に達した直後に打ち切り、
  limit 0なら探索せず空arrayを返す。これにより最長suffixを維持した最長鎖の辞書順先頭N本だけを
  列挙し、残りを生成しない。
- **計算量・必須fixture**: DP自体は`O(V+E)`時間・空間、canonical sortingを含む全体は
  `O((V+E) log(V+E))`時間・`O(V+E)`空間を上限とする。G2 fixtureにはshortcut付きDAG、真のcountが
  capちょうど／cap+1、9本以上の分岐で先頭8本のexact順、hard edgeとjoin展開edgeの重複、
  node／edge／join入力permutation間のcanonical bytes一致を必須追加する。爆発fixtureは
  `S`、幅2の層`L1..L999`、`T`からなり、`S`から`L1`の2node全て、隣接する各幅2層間の完全二部、
  `L999`の2node全てから`T`へ接続するものと固定する（task 2,000、edge 3,996、深さ1,001、
  真のcount `2^999`）。
- 統合graphはmerge後に独立DAG validatorを通してから投影する。「現在地」は単一点でなく
  **active set**（in-progress集合）＋next-ready（依存充足済みpending）＋blocked reasonを
  別視覚要素として描く。

### 8. スケール契約と表示縮退

- merged display graphの上限: **task 2,000・edge 8,000・埋込散文 8 MiB（raw bytes・1節256 KiB）・
  出力HTML 24 MiB**。超過は`TODO_SCALE_EXCEEDED`（cli_error.v2 detail=超過内訳）でfail closedし、
  部分描画しない（集約・分割はエラーメッセージで指示）。
- **上限の意味**: これはparser/renderer安全上限であり**可読性の保証ではない**（Codex opinion#8）。
  可読性は折畳み・段階開示（G3）が担う。
- **根拠と存在証明**: 値は現行dotagents実workload実測の約10倍marginの仮置きで、**上限値ちょうど
  （task 2,000/edge 8,000）のレンダラ性能fixtureがG3 gateでgreenであることを存在証明とする**。
  fixture形状は境界値N-1/N/N+1・長鎖・幅広層・完全二部層・高fan-out・Unicode escape膨張を含める。
  実測不能なら上限を検証済み規模へ引き下げるADR改訂を行う（fable諮問判断4）。
- 既定表示はplan/lane折畳み＋最長依存鎖とactive setを常時展開。表示密度の縮退規則はG3実装細部。

### 9. 散文埋込の安全規律

- MarkdownはHTML文字列として通さず、**AST→allow-list renderer**で埋め込む（raw HTML・画像・
  任意URL無効化。テキスト／属性／SVG／script JSONを別々にescape、`innerHTML`不使用）。
- 出力HTMLは`<head>`先頭のmeta CSP（`default-src 'none'`基調）＋network参照の**allow-list検査**
  （全URL-bearing属性・CSS・protocol-relative含む）。リンクは埋込節へのfragmentのみ許可
  （監査#5-3, 6）。

### 10. 非目標（再固定）

常駐化・外部PM SaaS・Markdown正本との二重管理・duration推定・カレンダー時間軸・
global capacity scheduling・v1での真正な履歴削除・複数端末の並行書込可用性（v1は単一writer運用）・
plan_graph既存schemaのin-place変更（必要ならv2化＋wire級別裁定）。

## Consequences

- G2はDecision 1〜5・6の`verify`/`snapshot`面・7を実装、G3が`todo gantt`（8・9含む）、G4が
  Decision 2aの一回きり移行＋オーナー受入、G5がauthoring/evidence昇格/reopen/revise/reconcile
  CLI・hook・cutoverを実装する（wave正本は実装計画）。
- dotagents側は受入・配線・憲法規範化のみを所有する（Phase LG対応表どおり）。
- 廃した旧称は実装・実装計画・親計画の受入文言に用いず、「最長依存鎖」へ追従させる。
- open item（G5着手時に追補ADRで固定）: reconcileのresolution.json契約・手順詳細・部分再発行の
  可否。revise input（revision.json）のfield契約。
- 既存timestamp validatorの`2026-02-30`受理はtodo族外の既存欠陥として残る。G2で影響を確認し、
  変更するならADR改訂（本ADRは適用をtodo族に限定）。

## G4-W7追補セルフチェック

| 統括裁定／不変条件 | 契約化した箇所 | 自己矛盾チェック |
|---|---|---|
| 既存storeへの原子的plan追加、manifest CAS、同一`plan_key`拒否 | Decision 2a「入口と一回きり性」「既存storeへの原子的plan追加」 | manifest rename前は非member、rename後だけ全体可視。既存member mutationのjournal commit pointとは対象を分離した |
| import専用done、strict timestampまたは`unknown_requires_evidence`、固定出典、機械判別 | Decision 2a「`done` payloadのclosed union」「移行元descriptor」 | 第7 kindを増やさず`done_mode`でclosed union化。authoredは`imported: false`、移行由来は`true` |
| import専用in-progress、開始時刻unknownの非推定、v1不変 | Decision 2a「輸入`start` payloadのclosed variant」「extraction schema version」 | 第7 kindを増やさず輸入startを識別し、v2だけが`register_in_progress`を表現。status/ganttには通常のactiveとして投影する |
| G5で正規evidenceへ昇格、履歴非改変、verify強度の分離 | Decision 2a「G5 evidence昇格」「verify規律」、Decision 6 CLI表 | 昇格はtarget digest付き新`done` event。authored hard検証は維持し、import緩和は固定出典の整合に限定した |
| migration waveだけの一回きり入口、再import拒否、常設Markdown pipeline禁止 | Decision 2a「入口と一回きり性」 | 同一入力もsuccessへ丸めずtyped conflict。wave後退役を明記した |
| journal唯一正本、taxonomy、単一writer、遷移6 kindを弱めない | Decision 2および2a、Decision 4 | 全import／promotion eventが通常chain・digest・CASに従い、writerは`g4-migration`へさらに限定。既存error codeと6 kind内で表現した |
| historical import後の状態機械 | Decision 2「status投影は関数」、Decision 2aの受理matrix | import doneはlatent startedを持ち、import startはactiveへ直結する。既存`reopen`のdone→in-progressと両立し、後続の通常遷移は従来の依存検査を受ける |

上表の確認により、統括裁定と本追補はすべて本文のnormative ruleへ落ち、未裁定の常設取込面や履歴書換えを
導入していない。

## 反証記録（G1作法の3枚ガードレール＋同日G2／G4追補）

1. **`fable`スポット諮問**: 判断1（todo namespace）支持／判断2（名称）条件付き支持／判断3
   （reopen不在）**反対→採用を覆しreopenを第6 kindとして導入**／判断4（スケール上限）条件付き
   支持→根拠の置き方とfixture整合を反映。見落とし3点（reconcile契約・actor・manifest原子性）反映。
2. **`fable`×high refuter**: P0×3（genesis未定義・書込protocol自己矛盾・状態機械の非関数性）・
   P1×4（join意味論・per-schema上限とsnapshot契約・互換表・反証記録）・P2×9——**全16件を本文へ
   反映**（「Accepted不可」判定の根拠は全て解消）。
3. **クロスprovider Codex opinion（sol×xhigh・aitermレーン。正規入口codex-sidecarが
   `AUTH_LEASE_BUSY`のため一時切替・別欠陥として記録）**: 総合判定「設計方向GO・現版Accepted
   不可・P0解消までG2 HOLD」。P0×5→①snapshot分離とcrash matrix②遷移表の完全化（reopen＋
   `target_done_digest`）③cross-plan refの`expected_topology_digest`束縛④単一writer前提の明文化と
   受理matrix⑤最長依存鎖の非列挙projection——**全て本文へ反映**。P1×3（CLI契約表・名称・evidence
   `git_blob_oid`）も反映。スケール上限の意味論（安全上限≠可読性）を反映。
4. **G2設計調書への独立反証（2026-07-18・G2-W4同日追補）**: 成立した①count recurrence／
   最終集計式不足、②tuple比較・開始node・DFS打切り順不足、③option値域不足、④差分を検出するfixture不足を
   Decision 7へ反映した。`STORE_INCONSISTENT`未裁定とsnapshot byte異常の読取衝突をDecision 2、
   G2成功resultのexact wireとtodo面exit 1/2境界をDecision 6へ反映した。反証不成立だったnode／edge
   採用式、join展開、爆発fixture期待値は変更せず根拠を明文化した。G2 checklist未被覆の指摘は実装未完の
   証拠であってAccepted方針の反証ではないためscope縮小に使わず、Consequences記載どおりG2の実装・fixture・
   focused gate義務として維持する。
5. **G4実装blockからの契約欠落発見（2026-07-18・G4-W7同日追補）**: `g4-migration` writerには
   既存storeへplanを追加するAPIがなく、genesisが全task pending固定のため、移行元の完了537件
   （うち92.4%は完了時刻不明）を正規journalへ表現できず、実装がfail closedで停止した。これは実装上の
   workaround不足ではなく、原子的member追加、historical completion、時刻不明値、出典検証、再登録、
   一回きり性のAccepted契約が欠けていた反証である。Decision 2／2a、Decision 6、Consequencesへ追補し、
   第7 event kindや常設Markdown pipelineを導入せず解消した。

先行3枚は「骨格は支持・細部P0解消が条件」で一致し、同日G2追補の成立findingとG4実装blockで判明した
契約欠落も上記へ反映した。Accepted裁定を維持し、G2実装は追補後wire、G4移行はDecision 2aを受入条件とする。
