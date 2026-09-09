# Lattice 製品契約

## Product outcome

入力されたproduct outcome、codebase、実行capabilityから、証拠付きの並列TODO graphを生成する。
境界競合がcritical chainを作る場合は、隔離されたseam-refactorを実行し、検証後のcodebaseから
新しいplan versionを再生成できる。

## 初期公開面

工程操作から公開工程表への配信結果は[bridge配信契約](bridge-setup.md)が所有する。
工程結果のstdoutは維持し、`lattice status --json`とToDo保存操作はstderrへ
`lattice.dashboard_delivery.v1`を返す。公開未設定、配信失敗、hub経由の実配信を区別する。
設定済みbridgeの常駐復旧は同じ入口で実施し、配信故障を工程保存の拒否理由にはしない。

初回vertical sliceでは次のversioned JSONを所有する。

- `lattice.plan_input.v1`: project、plan version、TODO候補、手動state／effect evidence。
- `lattice.boundary_manifest.v1`: graph evidence、owns／reads／writes、hard needs、conflicts、unknowns、tests。
- `lattice.boundary_verdict.v1`: `parallel_ready | seam_candidate | intentional_serial | unknown_requires_evidence`。
- `lattice.plan_graph.v1`: immutable node、typed edge、capacity、join、source manifest digest。
- `lattice.transform_artifact.v1`: candidate、source、bounded patch、verifier receipt、post snapshot、cleanup、accept／reject。
- `lattice.plan_diff.v1`: old／new version、code transformation artifact、失効context、node／edge差分。

schemaはexact key、bounded collection、canonical serialization、digestを持つ。未知field、欠落、過大入力、
不正pathをfail closedにし、空の成功や暗黙fallbackへ丸めない。

## Boundary evidence

Lattice内蔵sensor由来のsymbol／edge／impact／affected testと、Lattice本体が補うschema、state、transaction、generated
artifact、config、external effect、H、runtime traceを区別して保持する。構造sensorだけで独立性を宣言しない。

`boundary_manifest.graph_evidence[].result_digest`は環境依存のraw CLI outputでなく、versioned portable outcome projectionの
canonical digestを指す。raw telemetryは診断receiptとして別に保持し、project／index absolute path、index時刻、DB byte size、
node更新時刻をplan identityへ混ぜない。除外fieldはprojection versionで列挙し、未知fieldをsafe defaultで捨てない。

## Orchestration run面（ADR 0044・0060）

現役run storeは対象Git rootの`.lattice/runs/<run-id>/`だけに置き、target repoが`.lattice/runs/`を
git ignoreしていることを作成前に検証する。run refはrepo相対の同形式だけを受理し、旧実験rootや任意pathへfallbackしない。

公開CLIは`run start`、`list --json`、`observe`、`status`、`resume`、`close`、`abandon`、`activate`、
`conflict`、`hold`、`recompile`、`reprocess`、`finding record`、`seam resolve`、`seam profile`と
`event verify`を持つ。

実dispatchへ到達する経路も公開面で閉じている（ADR 0125・0126）。executor adapterの登録は
`run adapter register --input <file>`／`run adapter list --json`であり、入力schemaは
`run adapter register --schema --json`で取得する。digestは利用者に手計算させず、
binary／config／capabilities／自己digestはCLIが導出する。
決定論的な参照controllerを`lattice-scripted-adapter`として配布し、公開CLIと配布binだけで
`run activate`から実write・receipt受理・`resume`／`close`まで到達できる。
初回駆動は配布binをlaunch argvへ明示したmanaged runだけに効く。実dispatchの所有者はhostである。
`resume`と正常`close`は保存requestのbase SHAへbindし、stale baseを拒否する。`abandon`だけがstale runを
明示退役でき、理由を`run_closed` eventへ記録する。lifecycle writeは排他・atomicである。
runtimeのtimestampは実在する暦日のcanonical UTC millisecondsだけを受理する。

## 実行時競合とseam処置面（ADR 0138・0143〜0146・0158）

計画時の`owns`／`reads`／`writes`／`creates`は並列配置の予測であり、workerの変更許可一覧ではない。
新規fileは`creates: true`や事前のexact path宣言なしで作成でき、既存fileを予測外に変更したことだけで
成果を棄却しない。実行中はsupervisorがorigin-bound worktreeの実変更を独立観測する。実変更が同時稼働した
別attemptの予測read/write又は実変更と重なった時だけ実行時競合にする。単独の予測超過は観測として残すが
freezeしない（ADR 0144・0158）。1 taskしか名指さないfindingをconflict操作へ渡した場合は
`FINDING_NOT_A_CONFLICT`で拒否する。

conflictの処置は2系統である。直列化（一方をholdし他方の確定後に再開）と、変換
（双方を止め、`run seam resolve`で観測由来のseam変換を隔離worktree・受入五条件で通し、
phase revisionの`runtime_seam_split`で再コンパイルして双方を再開する）。振り分けの材料として
statusの投影は`treatment_advice`（finding digest・severability・transform可否）を機械可読で返す。
`run seam resolve`は宣言witnessを観測へ整合させる翻訳段（`reconciled`）を持ち、観測に裏づけの
ない拡幅は`observation_unbacked`系のtyped理由で拒否する。

競合時の物理barrier、context invalidation、後継dispatchは対象作業群だけへ適用する。閉包外workerは
同じprocess・dispatch・lease・origin epochのまま継続し、そのorigin bindingとcarry-over witnessが保たれる
receiptを後継epochで受理する。全体barrierはstartup、shutdown、明示的全体停止、外部process状態を
再構成できないrecoveryだけに使う。terminalではreceipt裁定前にsupervisorの最終diffを独立eventとして残し、
I/O sentinelを無効にしても同じ競合判定へ到達する。

受入五条件（ADR 0138）の`behavior_equivalent`は公開export面の保存に加えて切断参照の網
（ADR 0145）を含む——移した先が残余面のsymbolへ束縛なしで言及していれば不認定にする。網は
受入の一点だけで過程を監視せず、失敗は理由と次の一歩を返す不認定であって、回数・失敗を誰にも
記録しない。

機械変換は確実にできる内容だけ行う。前提の正典は`SEAM_GATE_PRECONDITIONS`で、resolutionの
`gate`が拒否理由を`fix_declaration`（宣言修正で機械再試行可）と`hand_to_ai`（機械の変換能力の
外＝操作AIが変換すべき）へ分類する。未知の理由は確実側へ丸めず安全側の手渡しにする（ADR 0146）。

切断コストの内訳は投影であって記録ではない。`run seam profile`（run-time）と
`todo seam-profile --plan <key> --file <path>`（plan-time）が、数えられる事実——相互参照、
read/write区別つき共有module状態、共有関数、共有import、循環、symbol行数、深さ別影響——を
盲点のconfidence申告つきで返す。閾値・採点・履歴台帳を持たず、digest済みartifactへ焼き込まない。

## Transformation boundary

- 初期版からdisposableな隔離worktreeで実refactorを実行対象にする。
- canonical branch、commit、外部effect、H操作は親受入または明示承認なしに行わない。
- transform前baseline、変更scope、verifier、rollback、再index query set、version barrierを必須にする。
- known mechanical refactorだけに固定しない。生成変換もbounded effectと複数verifierで研究する。

## Blocker contract

blockerは、破られる要求／不変条件、因果経路、再現証拠、隔離／rollbackでも回避不能な理由、未充足条件を
持つ。満たさない意見はrisk／hypothesis／experimentへ分類し、製品scopeを縮めない。

## Bootstrap exception

空repoにはsensor indexが存在しないため、最初のscaffoldだけboundary manifestを免除する。
bootstrap source作成直後、初期環境commitより前に`lattice sensor init . --json`を実行し、それ以後のsource TODOは通常契約へ従う。

## MCP面（session code intelligence・ADR 0049）

AIへの製品登録は`lattice setup [--host claude|codex|grok|cursor|all] --json`が所有する。
MCP登録、対応製品hookの準備、設定読戻し、MCP初期化と公開toolの確認を一回で完了する。
初回・再実行・更新は同じ入口を使い、診断は`lattice setup status --json`とする。
Windows hookとGrok hookの未対応は機能単位で返し、対応MCPを継続する。
全体partialを成功へ丸めず、利用者設定と他登録を保持する。機能表・結果・保存契約は
[導入契約](01_integration-package.md#製品所有のai導入入口)を正本とする。
工場の工程案内`lattice-gantt` hookは製品sensor hookと分離したまま維持する。

CLI 6面とは別種の公開面として、sensorのMCP server（entrypoint `bin/lattice-mcp`）を提供する。
plan／witness契約が消費するevidenceはCLI面・portable projectionのみであり、MCP tool出力は
根拠にしない——graph系evidenceは`plan verify`の独立再計算＋canonical digest一致が機械的に強制し、
手動evidence fieldへ入ったMCP由来テキストは人間入力と同格の未検証assertionとして扱う。

MCP serverはhost sessionのstdio子プロセス（session寿命）、共有sensor daemonはclient refcount＋
idle timeoutで自動終了するcache工程であり、どちらも自律的なdispatch・製品状態への書込を行わない
（書込はLattice sensorのproject cacheへのwatcher再indexとLattice固有のglobal管理領域・socket
rendezvous nodeに限る）。廃止済みcache/dataは入力またはfallbackとして読まない。「常駐サービス化はしない」非目標はorchestration面の規定であり、
MCP server提供と矛盾しない。MCP面は外部networkへ一切通信しない（v1受入条件）。
runtimeは配布物内の`./sensor/dist`だけを起動し、PATH上の独立CLI、npx、外部SDKを解決しない。
MCP toolは`lattice_sensor_*`だけを公開し、提供者と所有者を`lattice`として機械表示する。
未索引projectでは、AI hostが現在または予定作業の反復Read／Grep削減効果と一回限りの索引費用を比較し、
workspace書込とshell実行が許可されていれば対象projectを明示して`lattice sensor init <path> --json`を
自律実行してよい。権限またはshell面がなければbuilt-in toolで継続し、正規init commandをユーザーへ示す。
「索引はユーザーだけが判断・実行する」というMCP guidanceは禁止する。
CLIの`lattice sensor sync`を未初期化projectで実行した場合は`LATTICE_SENSOR_NOT_INITIALIZED`を返し、
`detail.next_action`へ同じpathの正規`lattice sensor init ... --json`を示す。その他のsensor失敗も
exit code、signal、最大16 KiBのstderrをtyped detailへ保持し、原因を汎用messageへ隠さない。

sensorの各file rowはcontent hashと抽出契約版を持つ。通常のsync／watcherは、content hashが同じでも
抽出契約版が実行中engineより古いfileを再抽出する。migration前のrowは旧版として扱い、手動DB再構築を
要求しない。index全fileが現行抽出契約版へ達した時だけglobal extraction stampを前進させ、途中の
部分syncを全体完了として扱わない。

## TODO工程store面（ADR 0053・0055・0056・0058）

CLIの発見入口は`lattice --help`／`lattice help`、公開namespaceとsubcommandの発見入口は
`lattice <namespace> [<subcommand>] --help`／`lattice help <namespace> [<subcommand>]`とする。helpはstoreやnetworkを読まず、
決定的なplain textをstdoutへ返してexit 0とする。未知namespaceは従来どおりusage違反exit 2で拒否する。

project discoveryの唯一の正規入口は`lattice status --json`である。CLI version、git project、
canonical store ref、active plan、active run、`uninitialized | ready | active_run | invalid`、
`can_create_plan`、次の正規commandを`lattice.project_status.v1`として返す。未初期化はexit 0の
正常状態であり、`.lattice/`の存在を接続判定へ使わない。`invalid`はexit 1のtyped状態とし、
Markdownへ暗黙fallbackしない。

未初期化projectの初期authoring入口は
`lattice plan create --input <lattice.plan_create_input.v4>`である。入力はrepo内のJSON
（pretty-print・digest未計算・repo内絶対pathを含む）を機械がcanonicalizeして受理し、
`lattice.todo_plan.v7`と同じPhase／task／topology制約を満たすfull desired stateを
一回のtransactionでstoreへ登録する。空の設計メモは拒否する（`NO_PLAN`は明示申告だけ）。
移行専用の`todo migrate`を新規authoringへ流用しない。
旧v1〜v3は`--schema-version`で取得できるだけの歴史契約であり、create入力としては
`plan_create_schema_retired`で拒否する。

初期工程表の意味上の入力は、オーナーが与えた作業仕様と受入条件である。操作AIは作業仕様を
dispatchableなToDoへ分割・統合・並列配置できるが、工程全体が実現する製品目的を増やしてはならない。
工程表を完成させた後、storeへ登録する前に`lattice plan scope-review --plan-input <authoring.json>
--review <lattice.plan_scope_review.v1> --json`を実行する。reviewは元の作業仕様、登録対象の全taskに対する
対応先と必要性の判断、全体verdictを持ち、authoring artifactのdigestへ束縛する。Latticeは全taskが一度ずつ
評価されたこと、参照先、未充足の作業仕様、verdictの整合を検証する。作業仕様とtaskの意味上の対応判断は
装置の一部である操作AIが行い、Lattice内部へ別の推論器を実装しない。`scope_mismatch`なら余計なtaskを
工程から外すか、要求追加としてオーナーへ提案し、`scope_preserved`になるまで登録へ進まない。

`.lattice/todo/`のcanonical journalを工程状態の唯一正本とし、snapshotは再生成可能な投影として扱う。
工程表HTMLはfileへ生成せず、動的viewerがstoreから応答時に描画する。読取CLIは
`lattice todo status / show / note list / bindings / independence / seam-profile / seam-proposal /
verify / snapshot --rebuild / gantt serve / phase status`、
一回きりの移行入口は`todo migrate`である。`todo bindings [--plan <key>] --json`は`compile_binding`が設定された
Taskだけを`project_id`／`plan_key`／`plan_version`／`task_id`つきで投影し
（`lattice.todo_binding_projection.v1`・ADR 0124）、TODO工程とruntime実行を結ぶ唯一の公開読み取り面とする。
`compiled_plan_digest`から`runtime_plan.v1`→`executor_packet.v1`→`executor_receipt.v1`まで辿れる。
`todo_status_result`は変更せず、加算の別面とする。

executor packetは操作AIの権限を決めない。`forbidden_operations`はv1互換fieldとして空配列を持ち、
実行可能な操作はhostとオーナー依頼が決める。Latticeは実行後のHEAD・diff・receiptを観測し、工程と
観測の前提が成立しているかだけを判定する（ADR 0178）。

ToDoの作業記憶はlifecycle journal／snapshotと分離したtask-scoped append-only note chainが正本である
（ADR 0149）。追記は`todo note --plan <key> --task <id> (--message <text>|--input <file>)`、全履歴の
診断面は`todo note list --plan <key> [--task <id>] --json`とする。ただし、操作AIがこの診断commandを
知っていることを通常経路の前提にしない。`todo show --plan <key> --task <id> --json`と、成功する
`todo start`は、最新bounded note群、元plan version／元task、訂正状態、note head digest、overflow、
全履歴commandを`note_context`として必ず自動同梱する。note chainを読めない時は空配列へ丸めず、
`todo start`はlifecycle event追記前にfail closedする。revisionを跨ぐ投影は`task_migration`だけを根拠にし、
removed taskのnoteはarchived束へ分離する。

**工程に属する義務はplan単位noteが持つ**（ADR 0160）。`todo note --plan <key>`（`--task`省略）で書き、
そのplanの全taskの`note_context`へ`scope: 'plan'`として届く。plan単位noteはtask noteと**別のchain file**へ
積むので、旧CLIはその存在に気づかずtask noteだけを従来どおり返す。まだ誰も着手していない工程の義務は
`note_context`では届かないため、`todo_status_result`の`plan_notes`欄が**存在・件数・帰属・全履歴command**を
出す。**note本文はstatusへ載せない**——自由記述Markdownを載せるとconsumer capture limitをplan数との積で
超え、記録するほどstatusが落ちる面ができる。在ることは常に届き、中身は`note list`へ取りに行く。

`todo_status_result`の`coordination`欄は、調整方式（`witness`／`conversation`）を宣言したplanだけを
宣言者と理由つきで列挙する（ADR 0160）。未宣言は`member_heads`との差で引ける。宣言はdispatchを変えない。

`parallel_candidates`欄は、readyかつ独立性が未判定・判定済みの組を候補視点で並べ直し、次に打つ
compile commandまで案内する（ADR 0160）。**新しい判定はここで行わない**——既存のindependence投影の
並べ替えである。判定する対象が無いplanはentryごと出さない。

個別ToDo右ペインの「作業記録」は同じbounded contextを表示する。**note本文はHTMLを描くすべての面へ
含める**——`gantt serve`も常設dashboardも、repo外へ出るHTMLも区別しない。除外の入口は持たない。

依存edgeの不在は順序制約の無申告であって、書き込み境界の非干渉ではない。両者を公開面で区別するため、
`todo independence compile --plan <key> --input <witness_set>`が`lattice.todo_witness_set.v5`（旧v1〜v4も受理）の宣言と
実sensor観測から並列可否を判定し、`lattice.todo_independence.v3`をplan versionディレクトリへ並置記録する
（ADR 0127・0132）。conflictは`conflict_resources`のresource idを参照し、kindと衝突した実体
（symbolまたはrepo相対path）を辞書側で一度だけ保持する。既知の旧契約で書かれた記録は`superseded`として
再compileを案内し、壊れた記録とは区別する。記録は`(plan_version, topology_digest, base_sha)`へ束縛し、
dirty worktreeでは記録しない。
記録はwitness setから再生成できるhost localの投影として扱い、git追跡するのは入力のwitness setだけとする。
witness setは`concern_anchors`を任意で持てる。`within`は`owns`または`writes`が指す資源に限る。
これは係争資源の内側で自分が触るsymbolをToDoごとに
名前で宣言する束縛専用の入力であり、並列可否の判定へは写らない——判定入力へ合成する時点で落とすので、
宣言が誤っていてもconflictを作ることも消すこともできない。concern anchorを持たない
`lattice.todo_witness_set.v1`の宣言もそのまま受理し、書き換えを要求しない。
v5は`lines`を任意で持ち、pathを共有しないTODO間でも、同じprotocol・stream・schemaを読む側と
書く側を`line_id`とpath/symbol anchorで結ぶ。旧版はlines無しのまま受理し、旧版へlinesを足した入力は
版を曖昧にせずtyped rejectする。
`todo independence [--plan <key>] --json`はready frontierを検証済み並列グループ・要直列の組・未検査へ
分けて投影し（`lattice.todo_independence_projection.v2`）、参照時にsensorを引かない。
記録の鮮度は`coverage`が`verified`／`stale`／`superseded`／`missing`で示し、現在のコード状態を
指していない記録をverified独立として読ませない。`dispatch_frontier`の
`all_ready_parallel_by_default`は変更せず、independenceはhostがsubsetを選ぶ根拠を与える別面とする。

**ToDoの論理dataflow検査はplan定義後の明示opt-inである**（ADR 0168）。成功したplanned compileが
plan version専用のimmutable structure bindingを発行したplanだけ、既存source graph、commit来歴、
in-progress／pending／blocked ToDoを結ぶstructure overlayを持つ。判定は`consistent`／`inconsistent`／
`unknown`を区別し、並列性判定と`next_ready`／`active_set`／`dispatch_frontier`を変えない。通常読取と
dashboardは保存artifactを投影し、live sensorを引くのはclean worktreeでのauthoritative compileだけとする。

有効化済みplanのgraph taskはfresh realization無しに`todo done`できない。全task done後にplanを閉じる
`phase_accept`／`phase_close_unaudited`は、全realizationと最終HEADを再結合したfreshかつ`consistent`な
finalizationを必要とする。bindingを持たないplanのcreate／migrate／read／lifecycle／Phase操作は変えない。
planned、append-only realized、effectiveを分離し、plannedを実装結果で上書きしない。

公開入口は次の5操作と2読取で閉じる。

- `todo structure --schema --json`: `lattice.todo_structure_set.v1`をstore非依存で返す。
- `todo structure input --plan <key> --input <file> [--dry-run --json]`: plan identity、全task coverage、
  topology、baseline祖先を検証し、planned sourceだけを保存する。この時点では有効化しない。
- `todo structure compile --plan <key> --input <file>`: clean worktreeの既存source graph、Git provenance、
  ToDo DAGを結合し、三値verdictを返す。`consistent`時だけimmutable bindingを発行する。
- `todo structure [--plan <key>] --json`: 保存artifactのmissing／fresh／stale／supersededとfindingを
  sensor再実行なしで返す。
- `todo structure realize --plan <key> --task <id> --planned [--commit <HEAD|sha>]...`: 実装後も
  planned構造どおりであることだけをAIが明示し、identity、HEAD、履歴鎖、actor、時刻、digestは機械生成する。
- `todo structure realize --plan <key> --task <id> --realized <file> [--commit <HEAD|sha>]...`:
  plannedと異なる実体構造transformだけを受け取り、同じ機械生成envelopeへ格納する。`--commit`省略時はHEAD。
- `todo structure realize --plan <key> --task <id> --input <file>`: 完全な
  `lattice.todo_structure_realization.v1`を移送・再生する互換入口。どの入口もcommit reachability、他taskとの
  重複claim、mutating anchor、current HEADを検証してappend-onlyで記録し、訂正は最新recordをsupersedeする。
- `todo structure finalize --plan <key> --json`: 全task完了後のeffective構造を最終HEADで再compileする。
- 動的Gantt／dashboardの独立した「構造検査」面: task／data／code／external／commit provenance、
  planned／realized／effective、finding、unknown、freshness、次の一手を保存artifactから表示する。

JSON Schemaの公開正本は`lattice.todo_structure_set.v1`、`lattice.todo_structure_realization.v1`、
`lattice.todo_structure_binding.v1`である。packageはこの3 schemaと、それらを消費する`src/` moduleを含む。
工程依存SVGとdataflow graphは別の表示面であり、同じedgeとして描かない。findingから問題node／edgeへ
移動でき、script無効時もfinding一覧を読める。dashboard描画はsensor ownershipを取得しない。

readyが複数ある状態での着手は、`--parallel-frontier`も`--override-reason`も必須ではない。
plain startは通る。`--override-reason`は直列理由の記録であり、文言を審査しない。
`--serial-confirmed`と`--serialization-reviewed`は互換のため受理するだけで、門ではない。
`--parallel-frontier`が用法誤りになるのは、対象taskが`next_ready`に無いときだけである
（`PARALLEL_DISPATCH_INVALID`）。並列既定は`todo status`の`dispatch_frontier`と
`lattice status`の`next_action`が案内する。着手を拒まない（ADR 0180）。

`plan create`と`todo migrate`は依存グラフから`dispatch_shape`（`task_count`／
`critical_path_length`／`max_frontier_width`／`serialization_ratio`）を計算して結果へ載せる。
直列度が閾値を超えても作成を拒まない。観測は残し、進行は止めない。

切断可能と分類されたconflictについて、`todo seam-proposal compile --plan <key>`が独立性記録と実sensorから
`lattice.seam_proposal.v2`を生成し、`todo seam-proposal [--plan <key>] --json`がsensorを引かずに
`lattice.seam_proposal_projection.v1`として投影する（ADR 0132）。提案の単位はconflict pairではなく
conflict componentとし、`seam_candidate`／`intentional_serial`／`unknown_requires_evidence`のsum typeで
全conflictを覆う。提案が持つのは切断の手順ではなく変更前後のsurfaceとその所有者であり、
seam候補は提案後ownershipで残余conflictが0になるものだけとする。ToDoへの割り当てをcaller／callee／impactの
edgeから導出せず、witnessのtask固有anchorが束縛できない場合はtyped unknownを返す。
witnessの`concern_anchors`は、当たったskeletonでは粗いanchorに優先する束縛根拠になり、pathのconflictでは
宣言そのものが切断候補（`declared_partition`）になる。componentの全taskが同じpath内でsymbolを名指しした
場合だけ候補にし、片側の宣言から他方の担当を補完しない。宣言symbolはsensorのexact一致・資源内包含・
task間排他で検証し、破れた宣言は候補にせずkindの異なるtyped unknownで返す（ADR 0133）。投影の`guidance`は
記録の鮮度が`verified`の時、載っている束縛失敗のうち直す対象が一意に決まるものを選んで種別と次の一歩を述べ、
束縛できなかったcomponentを「記録は一致している」で終わらせない（ADR 0130）。提案は構造証拠であって
意味的独立やbehavior preservationの証明ではなく、実変換は本面に含まれない。記録はindependence記録と同じく
plan versionディレクトリへ並置し、再生成できるhost localの投影として扱う。

session開始時にhostが必要とする現在地は`lattice session-context --json`が
**1プロセス・1回のstore読み**で返す（`lattice.session_context.v1`、ADR 0131）。
`status`フィールドは`project_status.v1`、`todo`フィールドは`todo_status_result.v6`をそのまま埋め、
`independence`はreadyのあるplanだけの並列可否要約を持つ。既存2面は不変で、これはその合成である。
この面はdashboard活動を登録しない読み取り専用面とする。消費者へexact key検証を要求せず、
知っているkeyだけを読んでよい——Lattice側は既存keyの意味を変えるときだけschema版を上げる。

topologyとsource reconciliationの変更はfull desired-state successorを
発行する`todo revise`／`todo revise-phase`だけが所有し、Markdown fallback、部分CRUD、独立`todo reconcile`を持たない。
通常revision inputは`lattice.todo_revision.v1/v2`、Phase revisionは
`lattice.phase_todo_revision.v1/v2/v3`とする。入口はpretty-printとdigest未計算を機械が直す。
storeへ書くbytesはcanonical。設計メモを持つdesired planは通常revision v2のv6と
Phase revision v3のv7が所有する。
cross-plan successorは`todo revise-set`で一括公開し、
`lattice.todo_revision_set.v3`はPhase revisionを必須として通常revisionとの混在を許す。全desired graphと
predecessorを検査し、artifactをdurable化した後、一つのmanifest activationで全planを同時に切り替える。
Phase v3のactive source移転は、同じrevisionの`source_cutover_batch`が旧refとdigestを明示し、その操作から
決定されるarchive refとdigestをdesired source inventoryが所有する場合だけ受理する。対応するcutover証拠のない
predecessor source消失は`predecessor_source_silently_dropped`として拒否する。
成功は単体通常revisionが`lattice.todo_revise_result.v1`（revision入力がv2なら
`lattice.todo_revise_result.v2`）、revision setが
`lattice.todo_revision_set_result.v1`、statusはreconciliation identityを含む
`lattice.todo_status_result.v6`、verifyはsource inventoryを再検査する`lattice.todo_verify_result.v3`を返す。
verify v3の各memberは`reconciliation_guidance`を持ち、`registered_unreconciled`がsource inventoryの
検証状態であってlifecycle操作とdashboard表示を塞がないこと、および正規のrevision schema取得・適用commandを示す。
status v6の`dispatch_frontier`は`next_ready`全件を既定の同時dispatch集合とし、推奨同時数、
frontier digest、subset選択時の理由要否を機械表示する。readyが複数でも最初の`todo start`は
flagなしで通る。`--parallel-frontier`と`--override-reason`は方針・理由の記録であり門ではない
（ADR 0180）。これはPhase、監査回数、task DAGを増やさない。
`--parallel-frontier`は開始時のdispatch方針記録であり、LatticeがAI hostのagentを直接生成する契約ではない。
実dispatchはhostが所有し、Latticeは`active_set`と残存`next_ready`から実状態を投影する。

**監査の既定は「有り」であり、無しは表現できない**（ADR 0147）。phaseを持たないplan
（`todo_plan.v1/v2/v3`）は予約Phase `terminal-audit`を暗黙に1つ持ち、所属taskはそのplanの全taskとする。
状態機械は既存のPhase gateと同一で、全task doneは`gate_ready`＝監査待ちであって完走ではない。
予約id以外のphase eventは`event_phase_missing`で拒否する。工程図のlive scopeは監査未了
（`gate_ready`／`reviewing`／`rejected`）のplanのToDoを畳まない——完走扱いで図から消えることが
「閉じた」の可視表現であり、監査の記録なしにそこへ行かせない。作成は拒否せず通知に留め、
`todo migrate`と`plan create`の結果、および最後のpending taskがdoneになった`todo done`のadvisoryへ
`terminal_audit_required`を載せる。`todo phase status`はphase無しplanでも暗黙Phaseを返し、
`implicit`で機械可読に示す。**終端監査はToDoのdispatch可否へ影響しない**——ADR 0062の
「Phase監査順とToDo schedulingの分離」を継承し、`next_ready`／`active_set`／`dispatch_frontier`は
暗黙Phaseの状態遷移で不変である。Latticeは監査の中身を採点せず、accept記録の存在だけを見る。

**監査待ちが在る限り、次アクション面は「残作業なし」と答えない**（ADR 0159）。`todo status`は
監査待ち（`gate_ready`／`reviewing`／`rejected`）のPhaseを`audit_pending`欄へ
`{plan_key, phase_id, phase_status, implicit, required_evidence_slots, next_commands}`として列挙し、
`accepted`／`closed_unaudited`は出さない。`lattice status`は`state`を`ready`のまま変えず、
`next_action.reason`を`no_ready_task`ではなく`audit_pending`とし、読み取り専用の
`todo phase status --plan <key>`を案内する。優先順位は`active_run`＞`next_ready`＞`audit_pending`＞なしで、
ready frontierが在る間はADR 0063の並列開始コマンドが勝つ。これはgateの追加ではなく可視性の修正であり、
dispatchも状態機械も変えない。

**監査していない歴史は「監査なしで閉じた」として閉じる**（ADR 0148）。Phaseは`accepted`／`rejected`に
加えて`closed_unaudited`を持つ。過去の工程は監査できない——監査対象のコードが既に変化しているため、
監査を要求すれば誤検出か中身を見ない`accept`のどちらかを誘発する。`closed_unaudited`は専用event kind
`phase_close_unaudited`で理由つきに記録し、前提は`gate_ready`とする。**`accepted`へ化けない**——
`phase_accept_dependencies`は`accepted`の厳密一致だけで解錠し、`closed_unaudited`では解錠しない。
工程図では畳むので監査待ちの札が外れ、`phase_reopen`でやり直せる。
一括入口`todo phase baseline --reason <text> [--except <plan_key>]...`は、現在`gate_ready`かつ
phase eventを一度も持たないPhaseをまとめて宣言し、除外・対象外・失敗を区別して返す。
**自動実行しない**——どれを監査しどれを歴史として畳むかは人／AIが決め、装置は宣言を受け取って
記録するだけとする。「変化したか」の機械判定と時間ベースの推定は持たない。監査待ちを返す面は、
何が起きたかと次に打つコマンドをtyped guidanceへ載せる。

phase無しで作ったplanへ後からPhaseを被せる救済経路は、`revise-phase`の
`state_policy: acquire_phase`が所有する。未割当（`phase_id`なし）→割当の向きだけを許し、
既にphaseを持つtaskの付け替えは拒否する。設計メモをまだ持たないlegacy taskが初めて
`design_memo`を獲得する時だけ通常`carry`を許す。一度メモを持ったtaskの本文変更は、通常`carry`だけでなく
互換入力された`acquire_phase`でも拒否し、
明示`carry_reconciled_metadata`だけがstateを保持して変更できる。そのpolicyは後継genesisの
`state_migration`へ記録する。v6／v7から設計メモを持たないschemaへの後退は、単体・Phase・revision setの
全activation入口で拒否する。
journal eventのschema列は、v1 genesisのjournalへ`phase_*` eventだけをv3 tailとして混在許可する
（既存eventのbytesとdigest計算は不変、v3のtask eventは従来どおり拒否）。

authoring契約のJSON Schemaは各入口から取得できる。`plan create --schema --json`の既定は最新版
（現在v4）で、`--schema-version <1|2|3|4> --json`が版を明示する。`todo revise`／`revise-set`／
`revise-phase`／`migrate`も`--schema --json`を持ち、実際に受理する最新契約を返す（storeを読まない
決定的出力）。schema違反は`detail`へ互換fieldの`violation_reason`／`violation_path`と、構造化した
`violation_kind`／JSON `pointer`／`expected`／`actual`／`task_id`／`next_action`を載せる。
`todo migrate --input <ref> --dry-run --json`はstoreとdashboard registryを変更せず、独立した違反を
上限付き配列でまとめて返す。digest不一致は期待digest、ソート違反はsort key、未来時刻は現在時刻と
許容5分窓を返す。循環等のtopology違反とstore／I/O障害を混同せず、除外taskを登録taskのparent・
dependency・joinから参照する入力はcompile前にpointer付きで拒否する。未知subcommand、不正引数、
repo外inputはそれぞれ`UNKNOWN_SUBCOMMAND`、
`INVALID_ARGUMENTS`、`INPUT_UNREADABLE`へ分ける。repo内なら絶対pathを受理する。`lattice plan show <plan_key> --json`は`lattice.plan_show_result.v1`として
plan本体（phase定義と状態・task一覧と状態・依存本数・topology要約）を投影する——
`todo bindings`が`compile_binding`付きtaskだけを投影することによる「planが空」という誤読を塞ぐ面である。

通常の状態遷移は`todo start / block / unblock / done / evidence promote / reopen`のclosed面で行う。
mutation callerは`LATTICE_TODO_ACTOR_HOST`, `LATTICE_TODO_ACTOR_SESSION`,
`LATTICE_TODO_ACTOR_AGENT`をtodo identifierとして受理する。欠落はhost／`session`／USERから
sanitizeしたdefaultを使う。渡した値がidentifierとして不正なら`ACTOR_UNRESOLVED`で書き込まない。
`done`はtaskを閉じる。evidenceはrepo内のdescriptor JSONでも証拠本文でもよく、`--message`は
本文からblob descriptorを書く。dashboard故障とstructure realizationはdoneの門ではない。
`evidence promote`は現在doneのtaskへ最新done digestで束縛した追記eventを積み、authored／importedを
問わずevidenceだけを再束縛する。done_atとimportedはlock内の現状態を維持し、対象taskの過去evidence
不達だけを新eventのhard検証で置き換える。以後のreplayは最新の証拠束縛だけを検証し、importedは
完了来歴として維持したまま通常evidenceを後続revisionへcarryできる。他taskの不達と新evidence不正はstore bytes不変で拒否する
（ADR 0183）。
監査と構造finalizationはstatusの残作業である（ADR 0159・0181）。成功は
`lattice.todo_mutation_result.v2`一行（`note_context`を同梱する成功は
`lattice.todo_mutation_result.v5`）、失敗とusage違反は`lattice.cli_error.v2`一行で、
失敗時のstore bytesは不変とする。`advisory`は`todo start`だけが非nullで返し、着手対象と
進行中ToDoの競合・切断可能性・未検査の内訳を機械可読で載せる（ADR 0128）。
どの ready を取るかは host の所有のまま変えない。記録があるのに対象工程が未宣言・失効なら
`todo start`は`INDEPENDENCE_UNVERIFIED`で拒否する（ADR 0182）。
`independence compile`は`next_ready`が witness に無いとき`INDEPENDENCE_READY_UNDECLARED`で拒否する。
記録があるのに鮮度を判定できない場合は、助言なしで通さずjournal書込前に失敗させる。`todo start`はさらに`structure_context`を
必ず返す。構造機能が有効なら対象taskのcanonical planned構造、structure set identity、compile freshness、
realizationの次操作を同梱し、未適用なら`status=not_enabled`、破損なら`status=unreadable`を明示する。
note chainが壊れていてもstartは通り、`note_context`はunreadableを返す。実装者へ別コマンドやsource file探索を
要求しない（ADR 0172・0181）。

PhaseはToDoの直列化groupではなく重監査の制御境界である。現行`todo_plan.v7`は各ToDoの`phase_id`、
gate policy、前段Phase、required evidence slotを所有するが、通常ToDoのstart/done readinessはToDo DAGだけで決める。
前段Phaseは監査のreview/accept順だけを制御する。特定ToDoがPhase受理を必要とする時だけ
`phase_accept_dependencies`へPhase ref→task refを明示し、task・Phase gateを合わせたmerged graphでcycleと
cross-plan topology bindingを検査する。所属ToDoが全てdoneでも`gate_ready`までしか進まず、
`phase_review`とimmutable evidence付き`phase_accept`を同じjournalへ記録して監査判断を残す。
この契約はPhase数、監査回数、required evidence slotを自動的に増やさない。旧v4／v5は互換読取契約として
維持し、v4だけはPhase acceptまで後続ToDoを暗黙に閉じる。旧plan versionやjournal headを
下流eventの永続依存先にはしない。revisionではPhase定義と所属ToDo集合が同じ時だけDecision stateをcarryし、
意味が変わればresetを必須にする。Phase revisionと通常revisionはrevision set v3で同時公開できる。
reject/reopenはDecisionへ束縛し、開始済み後続を持つreopenは明示overrideなしに拒否する。

工程図の既定scope`live`は、後続に作業中・未着手が残っていない完了ToDoを図から除く。まとめnodeや
placeholderを代わりに置かず、生きたToDoとその直接の前提ToDoは必ず描く。除いたToDoは凡例の件数、
右ペインの全工程一覧、各ToDoの詳細から辿れ、詳細の前提・後続は除外前のグラフから表示する。総数・進捗・
最長依存鎖・ready frontierは除外前の全工程で数える。件数バッジは展開の入口を兼ね、押すと同梱した全工程の
図へ切り替わる。`--scope all`は何も除かない。表示規約は[ADR 0066](adr/0066-gantt-live-scope-drops-finished-work.md)が正。
依存線はカードとカードの間の列境界を通り、図の右端の外へ迂回せず、カードの矩形の内部を通らない。真下へ
繋ぐ線は折れずに一直線で降りる。依存edgeを持たないToDoのブロックは接続済みToDoの上へ置き、接続済み
ToDoが段の最下行になる。配線規約は[ADR 0068](adr/0068-gantt-routes-run-between-the-columns.md)が正
（ADR 0066 Decision 7を置き換える）。
右ペインはToDo storeを見せる面であり、ToDo本体へ束縛した初期設計メモと追記noteを区別して表示する。
元plan Markdown本文を暗黙に再読込しない。全工程一覧は、動いているplanを
最終活動の新しい順で上、全ToDoが図から外れた完走planを古い順で下へ並べ、plan内は登録順を保つ。
初期設計メモはローカル／公開の動的viewerへ表示する。追記note本文だけは公開面から除外し、
「公開なので設計メモも空にする」という縮退を許さない。
右ペインの規約は[ADR 0067](adr/0067-right-pane-shows-the-store-and-orders-by-activity.md)が正。

工程表はstoreを都度読む動的viewerだけを運用表示面とする。`todo gantt serve --port <0..65535>`はloopback-onlyの
foreground read-only viewerで、stable store readとSSEにより更新を反映し、mixed viewを最新として表示しない。
live result v3は`project_id`、project scope、選択scope、起動時点で含むplan key群、HTML media type、
動的表示であること、`/projects/<project_id>/`のproject固有URL、同じnamespace配下の`events_url`を返す。
各projectのforeground sessionは独立portで同時起動でき、project間でHTML、SSE、store stateを共有しない。
共有dashboardの配信判定は、登録簿の`last_seen_at`が`TODO_DASHBOARD_STALE_MS`（1週間）以内、
またはstoreの非空`active_set`、または監査待ちPhase（`gate_ready`／`reviewing`／`rejected`）の
いずれかがあることとする。期限切れかつactive runも監査待ちも無いprojectは一覧から外す。
heartbeatは配信集合を二次計算せず、dashboard daemonが実際に配信しているidをそのまま名乗る
（[ADR 0165](adr/0165-terminals-advertise-exactly-what-they-serve.md)）。
dashboard daemonは起動時に読み込んだ版数をhealthで名乗り、installされた版と食い違うdaemonは新版へ
置き換える。publishとinstallを終えた版が、古いdaemonの生存を理由に配信面へ届かないままになることを
許さない。置き換えの待ち時間は固定秒数で打ち切らず、spawnした子が生きている間は待ち、子の死で即座に
`DASHBOARD_DAEMON_UNAVAILABLE`を返す。
daemonの生死をdescriptor 1枚に依存させない。daemonはpidごとの記録を自分で書き、起動のたびに
死んだ記録を掃除する。descriptorから外れた生存daemonは再認証のうえ停止し、同一runtime dirへ
配信daemonを2本残さない。descriptorだけを失った場合は2本目を建てず、記録にある配信中のdaemonを
引き取る。signalを送るのはその場で再認証を通った相手だけとし、応答しないpidへは送らない
（pid再利用で無関係のprocessを停止しうる）。停止に応じない孤児は`DASHBOARD_ORPHAN_STOP_FAILED`で
報せ、黙って見送らない。規約は[ADR 0157](adr/0157-dashboard-daemons-are-discoverable-by-record.md)が正。
project登録簿も同じ形で掃除する。activity登録のたびに`repo_root`が消えたentryを落とし（storeを
持たないだけの生きたrepoは消さない）、実在するが不要になった登録は`todo dashboard remove
<project_id> --json`だけが明示的に外す。removeは対象repoの解決・store読取・daemon起動を経由せず
対象projectの外から叩け、該当が無い時は`PROJECT_NOT_REGISTERED`で拒否して暗黙成功にしない。
公開viewerの未知GETで`Accept`が`text/html`を含む場合は、HTTP 404のままLatticeのブランド、
`noindex, nofollow`、`/projects/`と`https://kitepon.dev/`への戻り先を持つHTMLを返す。
HTMLを要求しないclientには、従来の`lattice.todo_gantt_http_error.v1` JSON 404を維持する。
content negotiationは表示面だけの加算であり、未知URLを200へ丸めず、他methodや他errorの契約を
暗黙に変更しない。
`todo gantt`と`todo gantt status`は`STATIC_GANTT_RETIRED`で拒否する。project別HTMLとsidecarを
運用正本として生成せず、AIへ再生成やstale確認を要求しない。
dashboard registryは同じ`project_id`を別canonical rootから自動登録しようとすると
`PROJECT_ROOT_CONFLICT`でregistry bytesを不変に保つ。配信元を動かす唯一の例外は、actorを明示した
`lattice todo dashboard adopt --json`である。結果と公開画面へローカル絶対pathを露出しない。

## 消費者としてのPeertable（外部consumer contract）

Peertable（MIT・npm `peertable`）はLatticeの外部消費者である。公開CLIとversioned JSONだけを読み書きし、
`.lattice/`のstore fileを直読み・直書きしない。本節は既存面がどう消費されているかの記録であり、
新しい保証・非目標・schema・面を増やさない。Latticeはこの消費者のために面を足さない。

消費される面は4つである。計画層だけだった旧記録へ実行層の実態を足すが、面を増やすのではなく、
同じ責務ごとに入口を束ね直す。

- **境界付きready／着手助言**: `todo status --json`の`next_ready`／`blocked`／`active_set`／
  `dispatch_frontier`、`todo independence compile`／`todo independence`、`todo start`の`advisory`、
  `todo split`、`todo verify`。Peertableの各memberはreadyから次の仕事を自分で選び、claim後に自分の変更境界を
  witnessとして持ち込んで、競合・unknown・scope expansionを読む。宣言が膨張した時は元taskを残したまま
  子taskへ分割し、active plan revisionを切り替える。助言は選択材料であって着手許可ではなく、Latticeは
  taskも席も選ばない。
- **claim後の実行設備と介入**: `todo start`のlifecycle journal（`sequence`、
  `actor{agent,host,session}`、`previous_digest`連鎖）、
  `run start --selection pull --id <id> --plan <key> --equipment detached-worktree`、`run intake`、process attach、
  lease／hold／resume。席自身が先にclaim／`todo start`したtaskだけをintakeし、隔離worktreeと競合介入を
  設備として受け取る。bridgeはrun進行と介入のread-only中継に限る。eventのactorは操作主体の記録であり、
  taskへassigneeを持たせて消費者側のclaimと二重正本にしない。
- **結果・証跡・着地の束縛**: `todo done --evidence <descriptor> [--test-result <markdown-file>]`は、
  repo内descriptorとpinned Git objectをhard検証し、任意の非空Markdown `test_result`を同じdone eventへ保存する
  （公開契約`lattice.todo_test_result.v1`）。未記録の既存ToDoは`todo show`で`test_result: null`として読み、
  evidenceの代替・自動生成・採点には使わない。`run intake accept`、`run close`、`run landing`まで束縛し、
  accept後もcanonical統合とremote既定branchへのlandingが確認できるまで完走へ丸めない。
- **監査状態と公開観測**: `todo status`の`audit_pending`、`todo phase status`、`lattice status`の
  `next_action.reason`、常設dashboardと`todo gantt serve`の公開工程表。全task doneが`gate_ready`であって
  完走でないこと（ADR 0147・0159）が、消費者側の解散判断の早さを機械的に抑える。公開工程表は監査状態、
  親子工程、runの進行を人とAIが同じ画面で観測する面であり、判断そのものは行わない。

唯一の書込例外は`.lattice/project.json`の任意`external_pane {title,url,probe_url}`である。Peertableは
identity文書の公開された任意欄へroomの表示先を差すが、journal／snapshotを直書きしない。Latticeは
題名・URL・probeだけを扱い、差されたサービスがPeertableであることを知らない。この例外は上の4面へ
新しい実行契約を足すものではなく、公開観測面の参照先をidentityへ設定するだけである。

Latticeが所有しないものは、会話の正本、参加者の規範、宣言ベースのclaim、task／席の選択、判断そのものである。
これらは消費者側の社会契約であり、機械の真実だけを供給し判断と会話を実装しないという所有境界の外に置く。
この消費者がLattice無しで動く形（standalone mode）も同じ理由で契約の外であり、Latticeの非目標を増やさない。

対応する消費者側の正本はPeertable repoの`docs/plan.md`「§12 Lattice consumer contract」である。
