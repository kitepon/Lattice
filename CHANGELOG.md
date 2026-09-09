# Changelog

## 0.69.0 — 2026-09-10

### 追加

- `lattice setup`でClaude・Codex・Grok・CursorのMCP登録と対応する製品hookの準備を一括実行する。
  設定の読戻しと実MCPの接続確認まで行い、`lattice setup status`で機能別に診断できる。
- 初回・再実行・更新で既存の追加引数、環境変数、他製品の登録、設定コメントを保持する。
  JSONCとTOMLの構文を解析し、変更前の設定を保存して対象項目だけ更新する。
- Windowsの製品hookとGrokの製品hookは機能別のtypedな未対応として返す。
  対応するMCP登録は続行し、未対応が残る結果は非0で返す。

### 修正

- ClaudeとCodexの設定先指定をMCP登録と既存hook installerで共通化する。

## 0.68.3 — 2026-09-06

### 修正

- 配信一覧の一時ファイルをディスクへ同期してから置き換える。停電前に内容の確定を要求しない共通保存処理を修正。
- Windowsの再設定で、再起動前の終了済みPIDが残っていると復旧できない不具合を修正。
  英語のtaskkillメッセージによる判定を撤去し、プロセスの存在を確認する。

## 0.68.2 — 2026-09-06

### 修正

- 最長依存経路に含まれる工程を退役させると、工程表全体がHTTP 500になる不具合を修正。
  経路計算と描画を同じ正規化済み工程集合から導出する。別途渡していた経路入力と重複照合を撤去し、
  退役した工程へのフェーズ依存も着手判定から除外する。Windows・macOS・Linux共通の修正。

## 0.68.1 — 2026-09-05

### 変更

- npm公開をGitHub ActionsのTrusted Publishingへ移す。mainの製品検査後にOIDCで公開し、
  毎回の本人認証と長期有効なnpm tokenを公開手順から外す。

### 修正

- dashboardのMarkdown表示に必要な3ライブラリを配布時の依存へ移す。global install後に
  `unified`を読み込めずdashboardが起動しない不具合を修正した。
  公開前にnpm配布物だけを導入してdashboard入口の読込を確認する。

## 0.68.0 — 2026-09-05

### 修正

- 工程登録が成功しても公開配信の欠落が見えなかった。`status`とToDo保存操作は、既存の工程結果を
  保持し、stderrの`lattice.dashboard_delivery.v1`で端末内のみ・hub配信成功・配信失敗を返す。
- 設定済みbridgeの常駐欠落・実行体のずれを工程入口で復旧する。公開先の設定自体が失われている場合は
  未設定を明示し、公開先を推測して有効化しない。
- hub付き`bridge setup`／`reconfigure`はdashboard起動と、hubの登録・一覧掲載・工程HTMLの中継までを
  確認する。配信できない時は設定保存を成功報告の代わりにせず、設定を保持したまま非0を返す。
- 配信確認は全OS共通とし、常駐の復旧には各OSの既存入口を使う。版だけのずれは既存の自動更新に任せる。
  bridgeのstdoutは既存のv4を維持し、配信結果はstderrへ返す。
- Windowsで文書検査が`spawnSync npm.cmd EINVAL`となる呼出しを、npmが渡す公式JS入口の直接実行へ修正した。
- npm 12で変わった`npm pack --json`のobject形式を文書検査が読めず停止する不具合を修正した。
  npm 11の配列形式も引き続き扱い、不正な応答は検査エラーにする。
- Windowsで工程ファイルの並行読取中にatomic renameが一時的な`EPERM`で失敗する現象を修正した。
  同じ差し替え操作を短く待って再実行し、恒久的な拒否は元のエラーで返す。
- Windowsのprocess観測2か所をPowerShell 7の`pwsh.exe`へ揃えた。旧`powershell.exe`がPATHにない環境でも
  process identityを取得できる。MacとLinuxの観測経路は変更しない。
- hub用端末IDの同時生成で書込み途中のJSONを読み得た。完成済みファイルを既存IDを上書きせず公開し、
  競合した呼出しは同じIDを読む。全OS共通の初回生成処理を修正した。

## 0.67.6 — 2026-08-30

### 変更

- 完了、撤回、置換済みの文書を`docs/archive/`へ移し、固定参照が残る旧pathだけを
  履歴参照stubとして維持する。現行文書は`docs/README.md`から辿り、archive／evidenceを
  通常の作業文脈へ混ぜない。
- 製品所有の文書gateをCIへ追加した。全製品Markdownの相対link、現行文書の索引、履歴stub、
  npm tarball内Markdownの相対link／image閉包を検査し、Markdownだけの変更でも実行する。
- Windows nativeの製品CI commandをPowerShell 7へ統一し、Git Bashへの依存を撤去した。
- npm tarballに同梱されない文書や画像へのREADMEリンクを、製品repositoryの正規URLへ揃えた。

### 修正

- ADR 0189で撤去済みのgitignore対象観測を旧integration testと計画文書が要求し続け、
  全CI環境を赤にしていた。ignored fileをruntime diffへ混ぜない現行契約へ期待値と説明を揃えた。
- evidence／import source blobの1件上限を子processの`maxBuffer`打切りへ暗黙依存していたため、
  Linuxでは読み取りtimingやbatch件数により上限超過blobが検証済みへ昇格することがあった。
  取得後の実byte数で上限を判定し、OSやNodeのprocess buffer挙動に依存せず未検証として扱う。

## 0.64.4 — 2026-08-25

### 修正

- source inventoryの行digestがcheckout後の行末CRを意味差として扱い、LFで作ったplanを
  Windows CRLF checkoutで`todo verify`すると`source_digest_mismatch`になっていた。
  source line境界だけでLF／CRLFを同一内容として照合し、本文差分は従来どおり拒否する。
  source cutoverとreceiptも同じ照合契約を使い、実ファイルへは元のEOLを保持する。

## 0.64.3 — 2026-08-25

### 修正

- 0.64.2の`repair-eol`はCRLF artifactをLFへ戻した後、unrelated dirty fileを持つrepoでは
  `git add --refresh`がstat cacheを揃えず、store全体を内容差分ゼロの`M`表示で残して失敗していた。
  staged entry（blob＋mode）＝HEADを先に実証した対象だけ`git update-index --refresh`へ渡し、CRLFが既に消えた
  0.64.2の部分実行状態もcommand再実行だけで回復する。利用者のdirty／staged内容は変更しない。
- 全product suiteをCPU並列するharness内で、複数のintegration fixtureがsensor parse workerをさらに
  最大8本ずつprewarmし、Windowsの子processを`0xC0000005`で落としていた。製品runtimeは変えず、
  product test childだけsingle-workerへ固定した。sensor自身の並列契約は独立`test:sensor` gateが維持する。

## 0.64.2 — 2026-08-25

### 修正

- `.lattice/.gitattributes`導入前に作られたToDo storeが、Windowsの`core.autocrlf=true` checkoutで
  CRLF化され、`lattice status --json`を原因不明の`STORE_INCONSISTENT`で停止させていた。
  CRLF artifactは原因pathと`lattice todo repair-eol --json`を案内する。修復commandはCR除去後の
  byte列が同じpathのHEAD blobと完全一致するfileだけをatomicにLFへ戻し、`* -text`保護を追加する。
  実編集・staged変更・非純粋な破損・untracked artifactは変更せず、store rootからartifactまでの
  symlink／junctionも拒否してrepo外を辿らない。Git indexのstat cacheは内容をstageしない
  `git add --refresh`で対象pathだけ更新し、内容差分ゼロの大量変更表示を残さない（ADR 0185）。
- Windowsでsensor testを全並列実行した時、所有handleをclose済みでもSQLite fixture directoryの削除が
  一時的な`EPERM`を返し、750msのcleanup上限を超えてCIを不安定化させていた。Node標準のEPERM線形backoffを
  2.75秒上限へ合わせ、runtimeへ再試行を足さずtest harnessの外部filesystem境界だけを安定化した。

## 0.64.1 — 2026-08-24

### 修正

- native Windowsで`hooks install|uninstall|emit`がtyped
  `HOST_PLATFORM_UNSUPPORTED`を返す一方、`hooks status`だけが
  `lattice.hooks_status_result.v1 / state=unreadable`を返していた不整合を修正した。
  native Windowsの全hooks commandは`lattice.hooks_error.v1 / HOST_PLATFORM_UNSUPPORTED`、
  exit 1で揃い、設定やstateへ触れない。

## 0.64.0 — 2026-08-24

### 追加

- `lattice hooks` に `--host cursor` を足した。設定先は `~/.cursor/hooks.json` の
  `beforeSubmitPrompt` で、Throughline / Caveat と同じ flat `{command, timeout: 5}` を
  冪等マージする。Claude / Codex の入れ子 `UserPromptSubmit` は変えない。
  emit は Cursor の `conversation_id` / `workspace_roots` を読み、
  `{"additional_context": ...}` を返す。工場の sessionStart hook は残す。

## 0.63.10 — 2026-08-24

### 変更

- 挙動不変の内部リファクタ（harness用語統一campaignのOS層分離規約）: 14ファイルへ複製されていた
  win32ガード付きdirectory fsync実装を新設`src/fs-dir-sync.mjs`の`fsyncDirectory()`へ一本化した
  （名前付きローカル関数9件＋inline 6件）。共通実装はPOSIXで`O_DIRECTORY`を併用し、directory以外を
  fail-loudにする（全呼び出し箇所はdirectoryだけを渡すため成功経路は不変）。公開API・schema・CLIは不変。

## 0.63.9 — 2026-08-23

### 修正

- `lattice.todo_extraction.v3/v4`の公開schemaはlocal dependencyにも任意の`reason`を許す一方、
  migration runtimeだけが`reason`付きlocal edgeを`hard_dependencies_invalid`として拒否していた。
  schemaどおり受理し、cross-plan edgeでは従来どおり非空`reason`を必須とする。

## 0.63.8 — 2026-08-23

### 修正

- `todo done`／`todo evidence promote`がevidence fileのworktree bytesをclean filterなしで
  `hash-object`していた。WindowsのCRLF worktreeではcommitがLF blobへ正規化されるため、
  descriptorだけがrefsから到達不能なCRLF blobを指し続け、commit後も`todo verify`を
  `evidence_unverified`で停止させた。evidence pathを指定してGitのclean filterを通し、
  descriptorのdigestも正規化後のblob bytesから作る。`--message`はblobだけでなく
  content-addressed evidence fileをstore内へ保存し、`--commit-store`の同一commitへ含める。

## 0.63.7 — 2026-08-23

### 修正

- `todo verify`がauthored doneや完了時刻ありのimported doneを`evidence_unverified`と判定しても、
  `todo evidence promote`がhistorical unknown done専用だったため正規に修復できなかった。
  最新doneへ監査可能な追記eventを束縛し、完了時刻とimported属性を維持したまま証拠を再束縛する。
  対象taskの過去不達だけを置換対象にし、新しい証拠と他taskはhard検証を維持する。修復後の通常
  mutationと、promote済みimported doneのrevision carryも旧証拠へ逆戻りせず成立する（ADR 0183）。
- MCP child試験の後始末が即SIGKILLしてWindowsでcwd／SQLite handle解放を遅らせていたため、
  stdin EOFによる正常終了を待ち、応答しないchildだけをbounded SIGKILLする。

## 0.63.6 — 2026-08-22

### 修正

- 0.63.5 が直した宣言境界の照合に、runtime-diff-observer 側の複製述語 `coveredBy` が
  残っており、accept 直叩き経路（detectCheckpointFindings）では同じ誤 hold を踏み直した。
  被覆判定を `coveredBy` 1本へ統合し、decision-verifier は import して使う。

## 0.63.5 — 2026-08-22

### 修正

- 宣言境界の照合（`declaredWriteCovers` / `pathTouches`）が、末尾 `/` 付きの宣言だけを
  ディレクトリ prefix として扱っていた。witness の writes は `templates` のような素の
  ディレクトリ名を普通に持つため、境界内で作った配下ファイルが全部 `undeclared_write` と
  誤判定され、`run intake accept` のたびに runtime_conflict hold → worker SIGSTOP で
  卓が凍った（2026-08-22 実測: 連続2 task で被弾）。宣言は `<dir>/` 境界での prefix
  照合に正し、`templatesX` のような同名 prefix の別 path は従来どおり検出する。

## 0.63.4 — 2026-08-22

### 変更

- OS process 観測（/bin/ps・PowerShell・/proc）を `runtime-os-observation.mjs` へ集約し、
  locale 固定・trim・書式の規約を1モジュールの所有にした（挙動不変。観測規約の
  部分適用による再発を防ぐ構造対処）。

### 修正

- process identity のOS観測（`/bin/ps` の `lstart=` / `command=` / `pgid=` の全8箇所）が
  observer の locale に依存していた。非ASCII argv のエスケープ有無は LC_CTYPE で変わる
  ため、席fileの記録者（C 相当）と `LC_CTYPE=UTF-8` の席から打った `run intake attach` で
  digest が割れ、`WORKER_IDENTITY_MISMATCH` が必発だった（2026-08-22 に円卓運用で実測・
  再現済み）。lstart の日付書式も LC_TIME で変わり同型の割れ方をする（原理を実測で確認。
  今回の実障害の原因は argv 側）。観測 process の環境を `LC_ALL=C` へ固定した。
  既知の限界: Linux の `LC_ALL=C` は非ASCII バイトを `?` へ非可逆に潰すため、非ASCII
  部分だけが違う argv の識別力が Linux では落ちる（観測者間の一致は保たれる）。
- attach 済み worker への signal 前再認証が argv digest と pgid（どちらも process 自身が
  書き換えられる可変量）まで照合していた。TUI worker がプロセスタイトルを書き換えると
  生きている正当な worker へ signal できなくなり、detach / release / hold の全経路が
  恒久停止し得る構造だった（コード上の確認。実測の発生記録は無い）。再認証を不変量
  （pid + lstart）だけに絞る。無関係な process へ signal を送らない安全性は lstart 照合で
  変わらず保たれる。
- attach 済み worker が終了（または pid 再利用）した後の detach が、死んだ process の
  resume を要求して `WORKER_IDENTITY_MISMATCH` で恒久に失敗した。不在（ESRCH）と
  pid 再利用は「配達先なし」として signal を skip し、detach を通す。worker_stopped /
  worker_resumed イベントは実際に signal が配達された時だけ刻む。
- `observeManagedProcessStartIdentity` が観測失敗時に原因を握りつぶし、対象 pid だけを
  返していた。sandbox 内から `ps` が失敗した時に「存在しない pid を渡した」ように読め、
  誤診を誘発した。失敗した観測コマンドの stderr / message を detail に載せる。

## 0.63.1 — 2026-08-22

### 修正

- file を取る引数（`todo note --input` / `todo done --evidence` など）に本文をそのまま渡すと
  `INPUT_UNREADABLE / input_missing` だけを返し、file を取ることも `--message` があることも
  案内しなかった。渡された値が本文に見える時は `--message <text>` を、path に見える時は
  repo 内の存在する path を案内する。`--message` を持たない入口では存在しない flag を案内しない。
- repo 外の path を渡した時の `input_path_outside_repo` に、repo 内へ写してから渡すことと
  `repo_root` を添える。どちらも回避策を探す前に次の一手が読める。
- `plan create` の入力違反が `pointer: "/"` と `validation: failed` しか返さず、
  「報告された pointer を直せ」と言いながらどこが違うか指していなかった。原因は
  巨大な `||` 連鎖と `catch { return false }` が理由を捨てていたこと。tasks・phases・
  actor・整列・phase_id 参照の違反を、落ちた最初の一件として pointer 付きで名指しする。
- `plan create --schema --json` が `input_digest` の算出方法と `gate_policy` の性質を
  書いていなかった。`input_digest` は空文字を置けば CLI が算出して埋めること、
  `gate_policy` は製品が分岐しない自由ラベルであることを schema の description に載せ、
  整列要求（JSON Schema では表現できない）も tasks・phases の description に書く。
- `plan create` の usage 違反が、受け取った引数を返さず固定文言 `plan create` を返していた。
  `plan create --input`（値の欠落）でも何を打って弾かれたか読めなかった。他 surface と同じ
  「受け取った引数をそのまま返す」契約へ戻す。0.63.0 の `npm run ci` はこれで赤かった。
## 0.63.0 — 2026-08-21

### 変更

- 記録があるのに対象工程が未宣言・失効なら `todo start` は `INDEPENDENCE_UNVERIFIED` で拒否する。
  競合の同時起動は助言のまま。記録が無い plan の start は従来どおり助言だけ（ADR 0182）。
- `independence compile` は `next_ready` が witness に無いとき `INDEPENDENCE_READY_UNDECLARED` で拒否する。

## 0.62.3 — 2026-08-20

### 修正

- hold 中の未 accept intake に worker が残っていると、同じ席の次の intake へ
  `WORKER_ALREADY_ATTACHED` で attach できなかった。hold の古い binding は
  次の attach で外す。granted な未 accept 同士は従来どおり拒否する。

## 0.62.2 — 2026-08-20

### 修正

- `intake accept` 後も、accepted task だけが相手の `runtime_conflict` hold が残っていた。
  残 findings が空なら hold を解き worker を resume する。

## 0.62.1 — 2026-08-20

### 修正

- `intake accept` が `runtime_conflict` hold 中の task を観測モデルから外し、
  nodes が空になって `pull observation planを構成できない` で止まっていた。
  accept 対象は hold 中でも観測集合へ残す。

## 0.62.0 — 2026-08-20

### 変更

- authoring入口は下書きを受理する（ADR 0181）。pretty-print・digest未計算・repo内絶対pathは
  機械が直す。flagの順は契約ではない。actor欠落はdefaultする。
  `todo done`はtaskを閉じ、dashboard／structure realization／証拠本文で止めない。
  `--evidence`はdescriptorでも本文でもよく、`--message`は本文からblobを書く。
  `concern_anchors.within`はownsまたはwrites。seam-proposal compileはdirty worktreeを拒否しない。
  空の設計メモは拒否したまま。`NO_PLAN`は明示申告だけ受理する。

## 0.61.3 — 2026-08-20

### 修正

- pull の checkpoint が gitignore 済みの `obj/` / `bin/` / `node_modules` 等を
  展開し、`dotnet test` の生成物を `undeclared_write` として `RUNTIME_CONFLICT_HOLD`
  にしていた。ignored なコンパイラ出力は観測から外し、ignored なソース相当は残す。
- `runtime_conflict` hold 中の `intake accept` は即 `TASK_HELD` せず、checkpoint を
  撮り直す。findings が空なら hold を解いて accept する。

## 0.61.2 — 2026-08-20

### 修正

- pull の attach worker へ `SIGSTOP`/`SIGCONT` を送ると Windows で `WORKER_SIGNAL_FAILED`
  （`kill EINVAL`）になり `intake accept` が完了しなかった。Windows に job control は無いので
  カーネル停止はせず、hold／resume は store の記録だけにする。`SIGTERM`/`SIGKILL` は送る。

## 0.61.1 — 2026-08-20

### 修正

- pull `intake attach` が Windows で `/bin/ps` を spawn して `ENOENT` になっていた。
  Win32_Process で pid / CommandLine / CreationDate を観測し、process group は pid 自身とする。
  started_identity は peertable 0.4.11 と同じ ISO（`/Date(ms)/` を含む）。

## 0.61.0 — 2026-08-20

### 変更

- 往復強制のdispatch gateを廃止した（ADR 0180）。複数readyのplain `todo start`、
  直列理由の正規表現審査、`--serial-confirmed`／`--serialization-reviewed`による再実行条件は
  門ではない。`dispatch_frontier`と`dispatch_shape`は案内・観測として残る。
  旧flagは互換のため受理する。`--parallel-frontier`が用法誤りになるのは対象がreadyでないときだけ。

## 0.60.8 — 2026-08-19

### 修正

- pull `intake accept` の done 束縛が intake actor と同一の done event だけを見ていた。
  監査担当が `todo done` したあとに実装席が accept できなかった。
  accept の実行者は従来どおり intake actor。done 記録者は同一 plan version の
  literal done であれば別 actor でよい。

## 0.60.7 — 2026-08-19

### 修正

- `lattice bridge reconfigure`が`BRIDGE_LAUNCHCTL_BOOTSTRAP_FAILED`を返すのに
  processは起きている状態を直した。`launchctl bootout`のexit 0はunload受付だけで、
  `print`がまだ0のあいだに`bootstrap`するとlaunchdが`5 Input/output error`を返す。
  labelがdomainから消える（`print` 113）まで待ってから載せる。失敗時はlaunchctlの
  exit codeとstderrを`detail`へ残す。

## 0.60.6 — 2026-08-19

### 変更

- 公開dashboardの鮮度窓を2時間から1週間へ伸ばした。`TODO_DASHBOARD_STALE_MS`。
  last_seen が1週間以内、または active run／監査待ちがある project を配信する。
  heartbeat の90秒 TTL と、ADR 0165 の「配信実体だけを名乗る」は変えていない。

## 0.60.5 — 2026-08-15

### 修正

- store読みのevidence blob・import source検証を、objectごとのgit子起動からstore読み単位の
  `cat-file --batch`一括prefetchへ集約した。evidenceが育ったstoreの`lattice status`が
  Windows実測で6.5秒→1.6秒（git起動96回→23回）。改版genesisの`state_migration`搬送evidenceも
  収集対象に含め、status JSONは修理前後でbyte一致（挙動不変）。

## 0.60.4 — 2026-08-13

### 修正

- native Windows非対応のPOSIX hooks suiteをWindows CIで実行せず、それ以外のWindows製品試験が完走するようにした。

## 0.60.3 — 2026-08-13

### 修正

- bridge heartbeat試験が旧の依存注入名を使い、開発端末の常駐dashboardに依存していた問題を修正した。

## 0.60.2 — 2026-08-13

### 修正

- Node 22の`node:sqlite`警告抑止を子process再起動から読込時の対象警告filterへ変更し、
  daemonの信号処理とCLI実行速度を維持した。

## 0.60.1 — 2026-08-13

### 修正

- Node 22で`node:sqlite`の`ExperimentalWarning`がCLIのJSON出力に混入する問題を修正した。
  `node:sqlite`を読み込む前に警告抑止付きでCLI全体を再起動する。

## 0.60.0 — 2026-08-13

### 新機能

- `lattice todo migrate`で、既存planのtaskを別planの先行条件へ接続できるようにした。
  `lattice.todo_extraction.v4`は新規taskを伴わない接続だけの入力も受理し、同じ入力の再実行と
  crash後の復旧を一つのtransactionとして完了する。
- ToDo構造artifactが壊れた時、`todo status`と`todo verify`が破損箇所をtypedに示し、
  元のplanned structure入力から同一内容を復旧できるようにした。

### 修正

- companion接続の並行復旧で、先行processのcrash後に複数processが同じ復旧mutexを奪い合う競合を修正した。
- `lattice.todo_extraction.v4`の公開schemaをnpm配布物へ含めた。

## 0.59.1 — 2026-08-13

### 修正

- Outcome compilerがオーナーの作業仕様と受入条件を保存し、要求外の製品目的を工程へ追加しない契約を復元。
  完成済み工程表を全件照合する`lattice plan scope-review`を追加した。
- runtime executor packetからLattice独自の禁止操作を撤去。`forbidden_operations`は互換fieldとして空配列を返し、
  操作権限をhostとオーナー依頼へ委ねる。

## 0.59.0 — 2026-08-13

### 新機能

- `lattice todo done`へ任意の`--test-result <markdown-file>`を追加。作業者の最終試験結果を
  evidenceと同じdone eventへ保存し、後工程は`lattice todo show --json`の`state.test_result`から読める。
- 未記録の既存ToDoは`test_result: null`として読み、旧journalと旧snapshotのbytesを維持する。
  結果を持つsnapshotは`v3`（Phaseなし）／`v4`（Phase付き）となり、revision carryとreopenにも対応する。

## 0.58.4 — 2026-08-12

### 新機能

- 構造付き工程の完了記録を機械化。実装が計画どおりなら`todo structure realize ... --planned`、
  差異がある場合は実体構造transformだけを`--realized <file>`で渡せば、identity、現在HEAD、commit、
  sequence、previous／supersedes、actor、時刻、digestをLatticeが生成する。
- `--commit`省略時はHEADを使用し、複数commitの工程は反復指定できる。既存のfull realization
  `--input`は移送・再生用の互換入口として維持する。commit／anchor検証とdone／finalization gateは変更しない。

## 0.58.3 — 2026-08-12

### 新機能

- 構造機能が有効なplanの`lattice todo start`が、対象taskのcanonical planned構造、structure set identity、
  compile freshness、realizationの次操作を`structure_context`として直接返すようにした。着手するAIは
  別コマンドやsource file探索なしにinput／operation／output／contract／code anchorを受け取れる。
- start mutation resultを`lattice.todo_mutation_result.v5`へ更新。構造機能未適用planは従来どおり着手でき、
  `structure_context.status=not_enabled`を明示する。graph対象taskのrealization-before-doneと、plan終端の
  fresh consistent finalization gateは変更しない。

## 0.58.2 — 2026-08-12

### 修正

- 既存planへの途中適用で、`structure input --dry-run`が未完了taskだけを正しく要求した後に、
  `structure compile`が完了済みtaskまで再要求して`STRUCTURE_COVERAGE_MISSING`にする不一致を修正。
  compileへplan全taskの状態を渡し、topology-onlyな完了済みtaskだけをcoverage対象外とする。
  pending／in-progress／blocked taskの漏れと未登録taskは従来どおり拒否する。

## 0.58.1 — 2026-08-12

### 修正

- ToDo構造compileが管理worktreeの未コミット変更で停止しないよう、現在のHEADからcleanな一時観測scopeを
  作り、SensorとGit来歴をそこで収集するよう修正。管理中の未コミットcodeを権威sourceへ混ぜない。
- planned `after_task` anchorを実装前のpostconditionとして扱い、進行中taskへrealizationを先取り要求する
  循環を解消。task完了後のfinalizationでは同じanchorを実際のpostconditionとして検査する。

## 0.58.0 — 2026-08-12

### 新機能

- code planだけが明示的に有効化できるToDo構造グラフ検査を追加。task間のdataflow、code anchor、
  external contract、commit provenanceを既存Lattice Sensor graphと結合し、`consistent`／
  `inconsistent`／`unknown`を証拠付きで返す。
- planned structure、append-only realization、全task完了後のfinalizationを公開CLIとJSON Schemaへ追加。
  有効化済みplanではfresh realizationをtask完了条件、fresh consistent finalizationを終端受理条件にする。
- dashboardへ工程依存図とは独立した「構造検査」面を追加。planned／realized／effective差分、finding、
  freshness、task／data／code／external／commit nodeを保存artifactだけから表示する。

### 互換性

- 構造検査はplan単位のopt-inであり、未適用planの既存lifecycle、dispatch、dashboard表示は変更しない。

### 依存更新

- Lattice Sensorの本番依存`picomatch`を4.0.5へ更新し、4.0.3までのReDoS脆弱性を解消。

## 0.57.3 — 2026-08-11

### 修正

- carry判定で削除対象taskに接続する辺だけを除外し、非削除辺の変更は従来どおり拒否するよう修正（ADR 0167）。join残差・空join・phase v3のacquire_phaseを含む受入回帰を追加。

## 0.57.2 — 2026-08-11

### 修正

- **常駐設定が半端に壊れると、直すためのcommandがその状態に拒否されて詰む欠陥を直した（ADR 0166）。**
  Windowsの常駐はStartup folderのlauncherと`%LOCALAPPDATA%`のdescriptorの2つで表され、
  片方だけが残った状態で`lattice bridge reconfigure`——**その状態を直すために存在するcommand**——が
  `BRIDGE_STARTUP_FOLDER_STATE_INVALID`で停止した。snapshotが「片方だけ在る」をthrowで拒否しており、
  それはsetup／reconfigure／disableが必ず最初に通る一点だったためである。復旧できたのは、人が
  Startup folderのfileを手で削除してからreconfigureを打ち直した時だった。

  異常の検出は読み手（status）が行い、両fileの唯一の書き手であるinstallが上書きで畳む形へ変えた。
  snapshotは分裂をthrowせず事実として返し、rollbackは分裂を忠実に戻すだけで起動しない
  （操作前に無かった健全さを発明しない）。同型のthrowはmacOS側（launchdにloadされているのにplistが無い）
  にもあったので、両platformを揃えて直した。
- **分裂状態は`lattice bridge status`が名指しする。** `persistence.error`へ
  `BRIDGE_PERSISTENCE_STATE_SPLIT`が入り、既存の`remedy`がそのまま`reconfigure`を出す。
  **0.57.2以降、手でfileを消す必要は無い。**
- **hub heartbeatの重複抑止が毎周期リセットされ、同じ結果をstderrへ書き続けていたのを直した。**
  指紋を捨てる代入を判定より前に置いていたため比較相手が毎回nullになり、実測で1端末が6秒間に23行、
  同一内容のpartial結果を書いていた（hub側で1件だけ拒否されている定常状態は解消しないので延々と続く）。
  指紋を捨てるのは健全な状態へ戻った時だけにした。stderrの消費者が居ない常駐
  （WindowsのStartup launcher、macOSのLaunchAgent）では、この書込みが積み上がること自体が
  常駐を不安定にする。

## 0.57.1 — 2026-08-11

### 修正

- **端末を2時間触らないだけで、公開面から全projectが消える欠陥を直した。** `lattice.kitepon.dev`の
  公開一覧が全projectオフラインになった。中身は生きていた——dashboard daemonは3件を配信中、
  bridgeもLISTENして応答し、hub自身も200を返していた。それでも端末ごと消えた。

  「この端末が公開しているproject」を2箇所が別々の基準で数えていたのが原因である。配信する側
  （`readVisibleTodoDashboardProjects`）は「2時間以内 **または** active run有り」で数え、hubへ
  名乗る側（`readActiveTodoDashboardProjects`）は「2時間以内だけ」で数えていた。`last_seen_at`は
  store書込みのCLIを叩いた時にしか更新されないので、一晩触らなければ全件が2時間を超え、
  heartbeatは`skipped_no_projects`として送信ごと省く。hubは90秒のTTLでofflineへ落とす。
  配信できるのに名乗らないという消え方なので、外からは障害と区別がつかない。

  heartbeatが名乗る集合を、配信しているdashboard daemon自身の`/__lattice/health`が返す
  `project_ids`にした。配信の実体を唯一の情報源にし、名乗る側が二次的に数え直さない（ADR 0165）。
  `TODO_DASHBOARD_STALE_MS`（2時間）は登録簿の掃除にだけ使い、公開面の露出判定へは使わない。
- **「daemonが居ない」と「0件を配信している」を混ぜないようにした。** descriptor不在・health無応答・
  descriptorとhealthのpid／port不一致は`skipped_no_dashboard`、配信0件は`skipped_no_projects`として
  `lattice bridge status`の`runtime.last_heartbeat`まで届く。前者は配線の故障、後者は正常な静止で、
  運用者が取る手が違う。

## 0.57.0 — 2026-08-10

独立した2件の欠陥報告への対応。どちらも**失敗が沈黙し、正規APIに復旧経路が無い**という
同じ性質を持っていた。

### 修正

- **解けないholdに入ったshared pull runが、退役も席の解放もできなくなる欠陥を直した。**
  扉が3つとも閉まっていた——`run close`は未受理intakeが残ると`RUN_NOT_COMPLETE`、
  `run intake release`はworker attach済みで`INTAKE_WORKER_ATTACHED`、`run abandon`は
  legacy専用で`RUN_MODE_MISMATCH`。しかもreleaseのnext_actionは「detachできる正規経路」を
  名指ししていたのに、その操作は存在しなかった。席はSIGSTOPで凍ったまま残った。
  `lattice run intake detach`を新設し、detach → release → close の経路を開通させた。
  authorizationはactorではなくprocess identity（lstart/argv/pgidの再認証）にしている——
  復旧するのは凍った席ではなく別のoperatorであり、席自身のidentityを要求すると
  「凍った席だけが自分を解放できる」という同じ罠に戻るため。
- **hub登録でproject_id衝突が1件あると、その端末の全projectが一括で拒否される欠陥を直した。**
  heartbeatはactive project全件を1 requestで送るため、同じrepoを複数マシンにcloneしている
  環境では、片方で`lattice status`を1回叩いただけでその端末の無関係な全projectが2時間
  登録できなくなった。衝突を所有端末の生死で二分する——offline（TTL超え）なら主張してきた
  端末へ差し替え、onlineならそのidだけ弾いて残りを受理する。無条件に新しい方へ渡すと
  両端末が生きている間30秒ごとに配信元が入れ替わるため、生死で分けている。
  結果schemaは`lattice.bridge_hub_registration_result.v2`（`rejected`と
  `reclaimed_from_offline`を追加）。
- **hubの拒否が完全に沈黙していたのを直した。** 拒否はdaemonのstderrへ出るだけで、bridgeの
  LaunchAgentは`StandardErrorPath`を持たない。利用者に見えるのは「新規projectが公開工程表に
  いつまでも出ない」だけだった。`lattice bridge status`の`runtime.last_heartbeat`から
  state・時刻・拒否されたproject_idが読めるようにし、拒否があれば`remedy`も出す。
- **読み取り目的のtodo commandがproject所有を主張しないようにした。** activeであることは
  localな都合ではなく、hubが公開dashboardの配信元を決める根拠である。cloneを1回覗いた
  `todo status`がその主張をして、本当に配信している端末と衝突していた。判定をdenylistから
  allowlistへ反転し、storeを書くcommandだけがactive化する。

### 新機能

- `run intake intervention`が、席がSIGSTOPで止まっている時に`recovery`へ脱出コマンドを返す。
  これまで返していたのは「holdの解き方」だけで、holdが解けない場合の出口は示していなかった。

## 0.56.0 — 2026-08-10

### 新機能

- **hubの公開面（`lattice.kitepon.dev`）を製品紹介ページへ作り替えた（ADR 0164）。** これまでの
  公開一覧は端末ホスト名を主見出しにしたリンク集で、ルートサイトから「工程表で見る」で入ってきた
  人にLatticeが何なのかを何も伝えていなかった。ヒーロー（製品コピー＋公開/特許出願済み）、
  仕組み3カードとインラインSVG図、ライブ工程一覧、GitHub/kitepon.devへのCTAを持つ1ページにし、
  一覧はそのページの一部として残した——**この一覧自体が動作デモである**という位置づけを明示した。
  意匠はkitepon.devのブランド正典（Discovery Orange・Motion Cobalt・Paper）へ合わせ、
  矢印グリフとlink装飾を廃し、外部fontも外部画像も読まない（CSPは`default-src 'none'`のまま）。
- **`/`と`/projects/`が同じlandingを返すようになった。** `/`→`/projects/`の301は廃止した。
  ルートサイトの2導線（バナーとAbout）が別々のpathを指していても同じ製品面へ着地する。
- **英語面を`/en/`・`/en/projects/`として追加した。** ルートサイトと同じパス分離方式。
  `Accept-Language`による自動振り分けはしない（`/`の応答が非決定的になり、受入curlと
  byte比較testが壊れるため）。`/en`は`/en/`へ、`/en/projects/<id>`は`/projects/<id>`へ301する。
- **公開一覧の可視性と表示名をhub運用者の裁量にした。** hub runtime dirの
  `public-visibility.json`（`lattice.bridge_hub_public_visibility.v1`）で、公開一覧から外す
  project／terminalと、project_idに対する表示名を宣言する。リクエスト毎に読むのでhubの再起動は要らない。
  **一覧から隠すことは非公開化ではない**——`/projects/<id>/`の中継は生かしたままにする（smoke testの
  自己アクセスと運用者の直URLを殺さないため）。壊れたファイルは黙って無フィルタにせず
  `BRIDGE_HUB_VISIBILITY_FILE_INVALID`で500にする。端末登録protocolは変更していない。
- **一覧カードの主従を入れ替えた。** 主見出しがproject（表示名があればそれ）、従がホスト名。
  これまでは`os.hostname()`が主見出しで、公開面に`KaitonoMacBook-Air.local`のような端末名が並んでいた。

### 修正

- **公開ページから`noindex, nofollow`を撤去した（ADR 0164）。** 紹介を目的とするサイトが
  検索を拒否しているのは矛盾である、というオーナー裁定。hub landingと各端末の工程ページの両方が対象。
- `todo migrate`の鮮度検査が、object数の多いrepositoryで必ず
  `source_reachability_unreadable`になっていた。`git rev-list --objects --all`の出力がNode既定の
  maxBuffer 1 MiBを超え、ENOBUFSが握られて「読めない」へ変換されていた（本repoの実測は1.06 MB）。
  隣接する`git show`と同じくmaxBufferを明示する。

## 0.55.1 — 2026-08-10

### 修正

- **`docs/bridge-setup.md`（配布物に含まれる）へ、`reconfigure`直後に`runtime.state`が
  一時的に`unattested`を返しうることを追記した。** identity確認requestは400msで打ち切られるため
  daemonの起動直後と競合する。0.55.0の実機配備で実測した。知らないと誤った警報になる。
- CI（ubuntu／macos／windowsのos matrix）をmacOSで赤くしていたtestの欠陥を2件直した。どちらも
  testだけの問題で、testは配布物に含まれないため製品の挙動は変わらない。
  - hubの明示listen address検証が`127.0.0.2`固定だった。Linuxは`127.0.0.0/8`全体がloopbackへ
    応答するがmacOSの`lo0`は`127.0.0.1`しか持たずEADDRNOTAVAILになる。実在するnon-internal IPv4を
    選ぶよう変更し、platform skipもos分岐も持たせていない。
  - managed runtime daemonのtest 9件が毎回`cancelledByParent`になっていた。SIGTERMを握り潰す子の
    exitを待つ最終awaitで、`detached`+`unref`した子のhandleがevent loopを生かさないため、
    reapが外から殺した後に'exit'が届く前へ入るとloopが空になりprocessごと降りていた。これらは
    macOS専用のtestなので、CIで実際に走る唯一の面が常に落ちていたことになる。待つ間だけ`ref()`へ戻す。

## 0.55.0 — 2026-08-10

### 修正

- **bridgeの常駐設定がNode更新で沈黙死する欠陥を直した（ADR 0163）。** LaunchAgent plistと
  WindowsのStartup launcherへ、版付きのNode実体path（homebrewの`Cellar/node/<version>/bin/node`）を
  焼き込んでいた。`process.execPath`はlibuvが既にrealpath解決するため、`/opt/homebrew/bin/node`
  経由で起動しても版付きpathになる。`brew upgrade node`で旧versionのディレクトリが消えると
  launchdの実行対象が消滅し、KeepAliveが起動できないprocessを回し続ける。エラー面が無いため、
  症状は「公開viewerから端末が消えた」だけだった（2026-08-08・2026-08-10に2度被弾）。
  同じbinaryを指すとrealpathで検証できた安定alias（`/opt/homebrew/bin/node`、nvm-windowsなら
  `C:\Program Files\nodejs\node.exe`）を焼くよう変更した。実体binaryの所有者・mode検査は従来どおり。
  shim方式（asdf・volta）は検証が一致しないので版付きpathのままとし、その場合の防御は下記statusが持つ。
  **既存の常駐設定は自動移行しない。更新後に各端末で`lattice bridge reconfigure --json`を1回打つ。**

### 新機能

- **`lattice bridge status`が常駐設定と実走processの乖離を報告するようになった。**
  結果schemaは`lattice.bridge_cli_result.v4`（v3からの差分は下記4フィールドの追加）。
  - `persistence` — 常駐設定が実際に起動する対象（Node実体・bridge script）と、その実在。
    読めなかった場合は`unreadable`とtyped codeで返し、正常へ丸めない。
  - `runtime` — 応答しているprocess自身が名乗る識別（pid・Lattice版・Node実体・Node版・bridge
    script）。attested health応答にだけ載せ、無認証の可用性probeへは出さない。
  - `runtime_drift` — `bridge_path`（別treeのcodeが走っている）／`node_path`（realpath比較）／
    `version`（npm更新後の版持ち）。
  - `remedy` — 自己解消しない状態にだけ`lattice bridge reconfigure --json`を出す。版差だけの時は
    daemonが自ら降りて新codeで起動し直すので出さない。
- **`setup`／`reconfigure`が開発treeからの常駐化を警告するようになった。** node_modules配下でない
  実体を常駐させると、npm更新を追従せずtreeを動かせば二度と起動しない。結果の`warnings`へ
  `BRIDGE_PERSISTED_FROM_DEVELOPMENT_TREE`を入れる（拒否はしない）。

## 0.54.0 — 2026-08-10

### 新機能

- **Mac側bridgeがhub登録へ自動移行するようになった。** 旧ssh逆トンネル構成
  （`LATTICE_BRIDGE_REGISTRAR_*`）を検出したdaemonが、registrar応答から得た
  hub_urlを使ってLAN address + hub登録へ自ら切り替え、旧逆トンネルLaunchAgentを
  退役させる。運用者は`npm install`で更新するだけでよく、手動reconfigureや
  launchctl bootoutは復旧用fallbackへ格下げされた（bh1のADR 0162契約——address
  は接続元導出のみ——には触れない）。
- daemonの版持ち対策を追加した。起動中のdaemonがon-disk package.jsonとの版差分を
  検出すると自ら終了し、supervising機構（launchd KeepAlive／Windows常駐
  supervisor）が新versionのcodeで再起動する。

### 修正

- **公開URLの玄関（root `/`）が404していた欠陥を直した。** hubが`/projects/*`
  しかrouteを持たず、公開URLの直接アクセスがBRIDGE_HUB_ROUTE_NOT_FOUNDに
  なっていた。`/`を`/projects/`へ301 redirectする。
- **`readTodoStoreStable`が恒久的なstore不整合を汎用STORE_BUSYへ丸めていた
  欠陥を直した。** 書込中の一時的な不整合と恒久的な不整合を区別せず同じ
  リトライ扱いにしていたため、後者でも本来のSTORE_INCONSISTENT reasonが
  失われ、復旧に必要な情報が読めなくなっていた。
- **dashboard daemonのstore cacheをstat fingerprintからcontent digest方式へ
  変更した。** mtime粒度の粗いfilesystem（WSL/DrvFs等）では、近接して書かれた
  異なる内容のmanifestが同じstat fingerprintに丸まりcache hitと誤判定され
  得る欠陥があった。manifest.jsonの実byteをsha256で比較する方式に変更した。

## 0.53.1 — 2026-08-10

### 新機能

- **Windows端末のbridge常駐機構を追加した。** Task SchedulerのONLOGONトリガーは非elevated
  では作成できないため、昇格不要なStartup folderへNode製supervisor（`bin/lattice-bridge-supervisor.mjs`、
  spawn→exit待ち→再spawn）を組み合わせて実現した。`lattice bridge setup`は
  `process.platform`でmacOSのLaunchAgentとWindowsのStartup folderを自動的に切り替える。
- registrar応答（`lattice.bridge_registration.v2`）から`hub_url`を抽出する
  `deriveBridgeHubUrlFromRegistration`を追加した。

### 修正

- **hubの`/projects/`合成一覧ページの意匠を旧公開landingへ揃えた。** hub導入（0.53.0）で
  この一覧が無style・裸テキストへ退行していた。旧公開面（LIVE DEVELOPMENT・カード型一覧・
  kitepon.dev/GitHub誘導）と同じ意匠を再現し、online/offlineを既存の色語彙で表示する。
- **Windowsでbridge configの読み戻し時0600権限bit検証が常に失敗しbridgeが起動できない
  欠陥を修理した。** `src/bridge-config.mjs`・`src/bridge-daemon.mjs`・`src/bridge-server.mjs`の
  読み戻しガードにcross-platform欠陥3件があり、Windows実機検証で発見した。

## 0.53.0 — 2026-08-10

### 新機能

- **公開工程表の多端末化へ向けたbridge hub（bh1〜bh5段階①）を追加した。** 現行の
  `Cloudflare Tunnel → Caddy → ssh逆トンネル → Macのloopback bridge`という1端末固定構成を、
  `Cloudflare Tunnel → Caddy → hub（複数端末を集約する新コンポーネント）→ 各端末のbridge`へ
  置き換えるための土台。
  - 端末→hub登録プロトコル契約（登録・heartbeat・失効・project_id衝突）を純粋関数として
    `src/bridge-hub-protocol.mjs`へ固定した（ADR 0162）。
  - hub HTTPサーバー本体`src/bridge-hub-server.mjs`: 端末登録簿・合成`/projects/`一覧・
    project別逆プロキシ（SSE安全なstreaming中継）・Host allow-list検査。
  - 端末側`lattice bridge`へhub登録・heartbeatを追加（`src/bridge-hub-heartbeat.mjs`、
    `bridge setup/reconfigure --hub <URL>|none`）。hub到達不能は端末自身のdashboard配信を
    止めない（fail-open）。
  - hub + 疑似端末2台の統合test（複数端末混在時のonline/offline投影・SSE再接続・
    process停止時の502劣化）でPhase gate「hub単体」を閉じた。
  - hub常駐用のsystemd起動entry point`bin/lattice-hub.mjs`を追加（環境変数のみで設定、
    listen addressをDocker Caddyのgateway向けに注入可能）。
  - 192.168.1.2への実配備・Caddy差替・逆トンネル退役（多端末実証）は本releaseの後続作業。

### 修正

- **`readEvidenceBlob`のcache key構築に混入していた生NULバイトをescapeした。** 0.52.4の
  git起動集約（f3b3b5c）でcache keyの区切り文字が誤って生U+0000バイトのままsourceへ入り、
  構文検査のNULバイト検出・`git diff`のbinary誤判定・`grep`のfile skipを引き起こしていた。
  生成される文字列はbyte単位で同一のためruntime挙動は不変。

## 0.52.4 — 2026-08-10

### 修正

- **Windowsでgit子起動が可視コンソールを雪崩式に開く問題を根治した。** GUI起点のprocessから
  spawnされたconsoleアプリはWindowsで新しいコンソールセッションを作り、既定ターミナルが
  Windows Terminalだと毎回可視ウィンドウが開く（gantt serve --scope allで40枚/分・ホスト操作不能の
  実害）。製品経路のgit起動を新設の共通入口`src/git-process.mjs`へ集約し、`windowsHide: true`を
  全経路（todo-store・todo-cli・project-cli・runtime-cli）に焼き込んだ。
- **object 1個ごとのgit子起動をやめ、`cat-file --batch`のまとめ読みへ置き換えた。**
  pinned source検証はcommit型検査+blob読みの3起動が1起動に、evidence検証は型検査+blob読みの
  2起動が1起動になり、blobは内容アドレス不変を利用したprocess内キャッシュで再読ゼロ
  （gantt serveのstore再読で同じevidenceを毎回読み直さない）。起動コスト削減で走査も速くなる。
  retiredなrc*リサーチ資産（不変replay）は対象外。

## 0.52.3 — 2026-08-10

### 修正

- **store生成時にEOL保護を消費者repoへ同梱するようにした。** 0.52.1の`.gitattributes -text`は
  Lattice自身のrepoしか守っておらず、storeを作った先のrepoはWindows autocrlf checkoutで
  store全滅の危険が残っていた。plan create／todo migrateのstore bootstrapが
  `.lattice/.gitattributes`（`* -text`）を生成する。既存の同名fileは上書きしない。
  既存storeのrepoには手動で同内容を敷くこと。
- **`status --json`の`project.root`をOS nativeパスへ正規化した。** gitがWindowsでも
  forward slashを返すため、`store.absolute_path`と区切りが食い違っていた。
  runtime-cliと同じ`path.resolve`規律に揃え、末尾空白などnewline以外は改変しない。

### テスト

- POSIX exec意味論（shebang shim）とWindowsが許さないパス（末尾空白dir）に依存する2 fixtureへ
  理由付きwin32 skipを与え、Windowsでproduct testが判定可能になった。

## 0.52.2 — 2026-08-10

### 診断・観測

- **`--evidence`入力の失敗に、期待するJSON記述子の形と作り方を同梱した。** 記述子でないファイル
  （証拠本体のMarkdown等）を渡した`json_parse_failed`と、schema不一致の`INVALID_EVIDENCE`の両方で、
  `detail.expected`に形（evidence_id／repo_id／path／git_blob_oid／content_digest／media_type／
  anchor_digest）と手順（commit後に`git rev-parse HEAD:<path>`でblob oid、blob bytesのsha256）を返す。
  可否判定は不変で、診断だけを追加した（ADR 0130の案内規律）。

### 修正

- **product test runnerがWindowsで動かなかったのを直した。** `URL.pathname`由来のrepo root解決が
  `C:\C:\...`を作っていたため、`fileURLToPath`での変換に置き換えた。POSIXでは同一パスに解決される。

## 0.52.1 — 2026-08-09

### 修正

- **Windowsで`plan create`が必ず失敗するfsyncバグを直した。** directory fsyncがWindowsでは
  `EPERM`／`EISDIR`になるため許容し、file fsyncの規律は維持した。
- **git同期したstoreが改行変換で壊れるのを防いだ。** Lattice repo自身に`.lattice/** -text`の
  `.gitattributes`を敷いた（消費者repoへの同梱は0.52.3で対応）。あわせてrelease gateを塞いでいた
  `.mjs`の見かけdirty（EOL差分）を全OS LF固定で解消した。

## 0.52.0 — 2026-08-09

### 追加

- **開発中に発見した別plan間の依存を、その場で工程へ接続できるようにした。**
  `todo dependency connect --from-plan ... --from-task ... --to-plan ... --to-task ... --reason ...`で
  task参照とtopology digestを固定し、重複・stale参照・cycle・完了済み端点はtyped errorで拒否する。
  接続後はconsumerを直ちにready／frontierから外し、active席数と公開Ganttのplan跨ぎ線・待機表示へ
  同じ依存を反映する。producer完了後はconsumerが再び実行可能になり、live工程表も追従する。
- **宣言scopeが膨張したtaskへ、分割検討を公開CLIから案内する。**
  `todo independence compile`の結果を`lattice.todo_independence_compile_result.v2`へ上げ、
  `scope_expansion_recommendations`を追加した。`todo start`の`advisory`にも同じtask固有の推薦を載せる。
  recommendationは助言であって開始gateではなく、膨張が無いtaskと未判定taskでは空配列になる。

### 文書

- **Peertableによる実消費を製品契約へ追記した。** 従来の4面を、境界付きready／着手助言、claim後の
  実行設備と介入、結果／証跡／着地の束縛、監査状態と公開観測へ束ね直し、任意`external_pane`は
  identity書込例外として記録した。新しい面やPeertable固有コードの追加ではなく、実戦投入で確認した
  既存の汎用面と所有境界の記録である。

## 0.51.0 — 2026-08-09

### 追加

- **席がclaim済みtaskを持ち込むpull型managed runを追加した。** intake、process attach、lease／hold、
  accept、close、receipt単位のlandingを公開し、隔離worktreeの実変更を宣言境界と突き合わせる。
  task選択・席選定・worker起動は行わず、AIが選んだ作業へ設備と介入だけを供給する。
- **親taskの内側へ子taskの依存工程図を描くようにした。** `parent_task_id`を持つ子のDAGを再帰的な
  nested panelとして表示し、親なしplanのlayout／SVGは従来とbyte-identicalに保つ。
- **`todo split`でactive plan revisionを原子的に切り替えられるようにした。** 元taskをresidualとして残し、
  successor taskと依存線、witness宣言を新revisionへ移す。途中失敗は旧active revisionを不変に保つ。
- **ToDo store mutationをGit commitまで原子的に着地する`--commit-store`を追加した。** 共有lock内で
  mutationとstore 3path限定commitを閉じ、cleanup失敗時も元の原因またはcommit receiptを失わない。
- **開始済みtaskの明示撤回を追加した。** start actor本人だけが未doneのstartをretractでき、履歴を
  append-only eventとして残す。

### 診断・観測

- runtime storeの将来schemaを期待versionと更新手順を含むtyped errorとして診断し、前景driverの
  待機状態を別processから観測できるようにした。
- independence artifactをv5へ上げ、scope expansionと線資源を境界compilerから実行時検証へ伝播する。

## 0.50.1 — 2026-08-08

### 修正

- **公開工程表が接続の沈黙を検出して復帰するようにした。** SSEは最新の`head_digest`を積んだ
  名前付き`event: ping`を25秒ごとに送り、ブラウザは62.5秒受信が途絶した接続を12.5秒周期の
  watchdogで張り直す。接続が生きたまま更新通知だけを取りこぼした場合も、心拍のhead差分から
  再読み込みする。描画部品`renderTodoGanttHtml`と自己完結契約は変えず、配信層だけで閉じている。

## 0.50.0 — 2026-08-08

### 追加

- **projectごとに外部ペインを1枚差せるようにした。** `.lattice/project.json`の任意欄
  `external_pane { title, url, probe_url }`を読み、設定があるprojectの公開工程表の右ペインへ、
  タブ（`title`を表示・「概要」の左）とiframeを**配信層だけで**注入する。既定タブは生存probeが
  非空の一覧を返した時だけ外部ペインになり、probeの失敗・非200・空一覧はすべて概要へ落ちる。
  欄が無いprojectは従来どおり概要だけで、タブもCSP追記も出ない。**Latticeは差された先が何の
  サービスかを知らない**——題名・埋め込み先URL・生存probe URLの3つだけを受け取る。設定は配信の
  たびに読むので、差すのも外すのもdaemon再起動なしに反映される。常設dashboardだけでなく
  `lattice todo gantt serve`でも同じタブが出るので、手元で確かめられる。描画部品`renderTodoGanttHtml`は
  不変で、自己完結契約（外部参照ゼロ）も保たれる。CSPへは設定があるprojectだけ`frame-src`と
  `connect-src`が加わる。`external_pane`が壊れている時は`PROJECT_IDENTITY_INVALID`で落とし、
  黙って無視しない。

### 破壊的変更（host統合者向け）

- **note本文の公開面除外を廃止した。** `renderPublicTodoGanttForProject` export と
  `renderTodoGanttForProject`の`includeNotes`オプションを削除し、工程表HTMLを描くすべての面が
  append-only作業記録を載せる。ADR 0153 Decision 2は「そこへ通す面が生えるまで入口を残す」と
  していたが、実際に生えた面（repo外から読む工程表）に対するオーナー裁定は**記録込みが正**だった。
  使われないまま残った入口は、次に面を作る者へ誤った既定を教えるので消す。
  `includeNotes`を渡していた呼び出しはオプションごと外せばよい（既定の挙動が同じになる）。
  note artifactは従来どおりgit trackedであり、秘密をnoteへ書かない運用規律は変わらない。

## 0.49.0 — 2026-08-08

### 追加

- **`lattice todo dashboard remove <project_id> --json`。** dashboard登録簿から1件を明示的に外す。
  結果は`lattice.todo_dashboard_remove_result.v1`（`project_id`・`removed`・`result_digest`）。
  該当が無い時は`PROJECT_NOT_REGISTERED`で拒否し、暗黙の成功にしない。**対象projectのrepoが
  既に消えていても叩ける**——repoRoot解決・store読取・dashboard daemon起動を経由しないためで、
  「消したいrepoがもう無いから消せない」を作らない。結果とerrorへlocal絶対pathは載せない。

### 修正

- **dashboard登録簿の自己掃除。** activity登録のたびに、repo_rootのdirectoryが既に消えている
  entryを落とす。登録は全sessionが必ず通る一点であり、掃除を人のコマンドに預けると誰も叩かず
  死んだ登録が永久に積み上がる（実測: 消滅済みtmp rootを指す登録が6件残っていた）。
  判定はdirectoryの存在だけで、`.lattice`の有無は見ない——storeを持たないだけの生きたrepoを
  消さないため。`registerTodoDashboardActivity`の戻り値へ`pruned`（除去したproject_idの配列）が
  加わる（登録簿のbytesには書かない）。

## 0.48.0 — 2026-08-08

### 破壊的変更（host統合者向け）

- **`lattice todo status --json`のwire schemaを`lattice.todo_status_result.v5`から`v6`へ上げた
  （ADR 0160）。** 上位キーへ`plan_notes`・`coordination`・`parallel_candidates`がこの順で加わる
  （`audit_pending`と`member_heads`の間）。上位キーはexact 12キーになる。
  **exact key検証をしている消費者は追従が必要**で、追従前は`version_mismatch`として拒否される。
  「知っているkeyだけを読む」消費者は影響を受けない。`lattice session-context --json`の
  `todo`フィールドも同じくv6になる。
- **noteのwire schemaを上げた。** `todo_note_event.v2`（plan scope）・`todo_note_context.v2`
  （`scope`とplan chainのhead digest）・`todo_note_append_result.v2`・`todo_note_list_result.v2`。
  plan単位noteは**task noteと別のchain file**（`plan-active.jsonl`）へ積むので、旧CLIは存在に
  気づかず従来どおり動く。**ただし旧CLIではplan単位noteが届かない**——`todo start`の`note_context`は
  v1のままで、plan scopeのentryを持たない。

### 互換性（storeは壊れない）

**plan単位noteも調整方式の宣言も、旧CLIのstore読みを壊さない。** どちらも専用のchain file
（`plan-active.jsonl`・`plan-scoped.jsonl`）へ積み、既存のlifecycle journalとtask note chainのbyteを
1つも動かさないためである。0.47.0のCLIで宣言済みstoreを読んでも`todo status`／`lattice status`／
`todo verify`／`todo start`は従来どおり通る（実測）。**ただし旧CLIからは、plan noteも調整方式の宣言も
存在ごと見えない**——壊れないことと届くことは別で、この欠落は版が上がるまで解けない。

### 追加

- **plan単位note**（`lattice todo note --plan <key>`。`--task`を省略するとplan scope）。
  taskに属さない工程の義務——順序制約、一度きりの観測、運用条件——の置き場である。
  そのplanの全taskの`todo start`／`todo show`の`note_context`へ`scope: 'plan'`で届く。
- **`todo status`の`plan_notes`欄。** まだ誰も着手していない工程の義務を、次アクション面が出す。
  entryは`{plan_key, plan_note_head_digest, count, latest, next_commands}`で、**note本文は載せない**
  （consumer capture limitを踏まないため。中身は`next_commands`が指す`note list`が持つ）。
- **調整方式の宣言**（`lattice todo independence mode --plan <key> --set witness|conversation
  --reason <text>`）。witness検証で並列するか会話で調整するかをplan単位で選び、eventのactorが
  「誰が選んだか」の帰属になる。`todo status`の`coordination`欄は宣言済みのplanだけを列挙する。
  `todo migrate`の結果は未宣言planへ宣言commandを案内する。
- **`todo status`の`parallel_candidates`欄。** readyかつ独立性が未判定の組を並列候補として提示し、
  「この組を判定するには」の次コマンドまで案内する。判定済みの組は結果（並列可／直列化が要る対）を
  返す。**新しい判定ロジックは足していない**——既存のindependence投影を候補視点で並べ直すだけである。

### 不変（Protected behavior・ADR 0160）

- **未判定はdispatchを塞がない。** independence記録の有無も、宣言された競合も、
  `next_ready`／`active_set`／`dispatch_frontier`（`frontier_digest`を含む）を変えない。
  plan noteの有無・件数も同様に変えない。

## 0.47.0 — 2026-08-08

### 破壊的変更（host統合者向け）

- **`lattice todo status --json`のwire schemaを`lattice.todo_status_result.v4`から`v5`へ上げた
  （ADR 0159）。** 上位キーへ`audit_pending`が加わる（`blocked`と`member_heads`の間）。
  **exact key検証をしている消費者は追従が必要**で、追従前は`version_mismatch`として拒否される。
  「知っているkeyだけを読む」消費者は影響を受けない。`lattice session-context --json`の
  `todo`フィールドも同じくv5になる。

### 追加

- **監査待ちPhaseを次アクション面へ表出した（ADR 0159）。** 終端監査gateはADR 0147/0148で
  実装済みだったが、AIが「次は何をするか」を問い合わせる面が監査待ちを一切返しておらず、
  全taskがdoneになると`lattice status`が`no_ready_task`＝残作業なしと答えていた。機械がそう答える
  以上、AIは正しくそれを信じて完了報告する。これを直す。
  - `todo status`の`audit_pending`欄が、監査待ち（`gate_ready`／`reviewing`／`rejected`）のPhaseを
    `{plan_key, phase_id, phase_status, implicit, required_evidence_slots, next_commands}`で列挙する。
    `accepted`／`closed_unaudited`は出さない。
  - `lattice status`の`next_action.reason`が`no_ready_task`ではなく`audit_pending`になり、
    読み取り専用の`todo phase status --plan <key>`を案内する。`state`は`ready`のまま変わらない
    （`project_status.v1`のbumpは無い）。優先順位は`active_run`＞`next_ready`＞`audit_pending`＞なし。
  - 工程図／dashboardのヘッダへ監査待ちの札が出る。
  - `next_ready`・`dispatch_frontier`・`frontier_digest`は監査状態で動かない。dispatchは変えていない。

## 0.46.2 — 2026-08-04

### 修正

- **Claude CodeのhookがHomebrew更新後に起動不能になる欠陥を直した。** hook installerが
  `process.execPath`をそのまま永続化し、`/opt/homebrew/Cellar/node/<version>/bin/node`という
  更新時に削除される版付きパスを`~/.claude/settings.json`へ書いていた。同じNode実体を指すことを
  確認できる場合だけ`/opt/homebrew/bin/node`または`/usr/local/bin/node`へ正規化し、別実体なら
  元の実行パスを維持する。これによりNodeのpatch更新で`UserPromptSubmit` hookが壊れない。

## 0.46.1 — 2026-08-04

### ドキュメント

- **dashboard daemonの生死管理を保証として明文化した。** 公開契約とREADMEは「版数が食い違えば
  置き換える」までしか書いておらず、descriptorから外れたdaemonが観測不能になる面が抜けていた。
  0.46.0でその面を塞いだので、契約として書く——生死をdescriptor 1枚に依存させない、同一runtime dirへ
  配信daemonを2本残さない、descriptorだけを失った場合は2本目を建てず引き取る、signalはその場で
  再認証を通った相手だけへ送る、停止に応じない孤児は`DASHBOARD_ORPHAN_STOP_FAILED`で報せる。
  コードの変更はない。

## 0.46.0 — 2026-08-03

### 修正

- **dashboard daemonが観測不能なまま生き残る欠陥を直した（ADR 0157）。** 生死を持つのは
  `daemon.json`（descriptor）1枚だけで、引き継ぎはそこに書かれたpidしか認証しない。
  したがってdescriptorから一度外れたdaemonは、生きていても二度と誰にも観測されない。
  v0.45.1のinstall直後に実際に起きた——旧daemonへSIGTERMを送る前に起動側が死に、
  旧daemonが取り残された（実測: dashboard 2本が同時稼働）。
  daemonごとの記録`daemons/<pid>.json`をdaemon自身に書かせ、全daemonが必ず通る起動時に
  死んだ記録を掃除し、descriptorが指さない生存daemonを再認証のうえ停止する。
  descriptorだけが失われた場合は2本目を建てず、登録簿の生存daemonを引き取る。
  signalを送るのは、その場で再認証を通った相手だけとする（応答しないpidへ送れば、
  pid再利用で無関係のprocessを殺しうる）。停止に応じない孤児は
  `DASHBOARD_ORPHAN_STOP_FAILED`で報せ、黙って諦めない。
  なお、**この修正より前に取り残されている孤児は記録を持たないので発見できない。**
  防ぐのは以後の発生であり、過去の孤児の遡及救済ではない。

## 0.45.1 — 2026-08-03

### 修正

- **daemon登録簿が無限に育つ漏れを止めた。** 死んだ記録を落とす掃除は`listDaemons`が
  持っていたが、それを呼ぶのは人が`daemon list`／`stop`を叩いた時だけで、daemonの
  ライフサイクルからは一度も呼ばれていなかった。記録はproject rootごとに1ファイルで、
  integration testの一時repoはそれぞれ別rootなので、test 1回ごとに記録が増え、
  一時ディレクトリが消えても記録だけが残る。実測で978件・うち死亡967件・最古17日前。
  全daemonが必ず通る「登録」の時点で掃除するようにしたので、登録簿は「生きているdaemon＋
  前回登録以降に死んだ分」までしか育たない。誰の操作にも依存しない。

## 0.45.0 — 2026-08-03

### 追加

- **`lattice sensor diff <rootA> <rootB> --json` を新設した（ADR 0156）。** 2つのtreeの構造グラフを
  突き合わせ、node・辺・fileの差分を機械列挙する。upstream追従で「54コミットでどのsymbolのグラフが
  変わったか」を人のgrepで数えていた面を置き換える。突き合わせは行番号を含まない自然キー
  （`kind|path|qualified_name|name`）で行い、辺も端点を自然キーへ解決してから比べる——node idは
  行番号を含むので、idで比べると数行のズレが差分を埋め尽くす。行だけの移動は`moved`へ落ちる。
  `--subtree-a/-b`と`--map-a/-b`が2つのtreeの階層と改名を吸収する（`sensor/UPSTREAM.json`の
  `path_map`をそのまま写せる）。実装はLattice本体側にあり、`sensor/`は変更していない。
- **差分が信じられない条件を、差分と一緒に返す。** 両側のschema versionの違い、同じfileが違う
  extraction versionで抽出されている件数、抽出errorを記録したfileの件数を`comparability`が
  `degraded`として名指しする。比較から外した辺（端点がsubtree外・index不整合）は`excluded`へ
  種別ごとに、明細を切った量は`truncation`へ出る。件数summaryは切らない。
  必要な列を欠く古いindex、写像が2つのfileを同じpathへ潰す指定、片側の未索引は、いずれも
  typed errorで止まる——勝手に索引せず、片方を黙って捨てない。

### 修正

- **古いengineが新しいindexを書き戻す欠陥を修正した。** 抽出版のheal判定が「版が違えば
  再抽出」（`!=`）だったため、healが双方向になっていた。結果、upgrade前のコードを抱えた
  常駐processが、`sync`で揃えたindexを自分の古い版へ書き戻し続け、indexが永久に収束しない。
  判定を「自分より古い時だけ」（`<`）へ直し、内容未変更かつ新しい版で書かれた行は触らない。
  global stampも、自分より新しい行が残っている間は進めない（進めると、起きていない
  downgradeを宣言して実態を隠す）。この欠陥は新設した`lattice sensor diff`が
  `comparability: degraded`を出したことで見つかった。
- **`lattice sensor status`が「engineがindexより古い」を報告するようになった。** 逆向き
  （indexがengineより古い）は前から再indexを勧めていたが、こちら向きは無言だった。
  無言だと、収束しないindexの理由が誰にも見えない。JSONは`index.engineBehindIndexFiles`で、
  boundary compilerが読むstatus契約（`src/sensor-adapter.mjs`）の必須欄でもある——欄が
  欠けたstatusはreadyへ丸めず未解決として扱う。
- **一括改名で取り残された索引pathの参照を直した。** `sensor/scripts/dump-graph.mjs`は
  存在しない`.lattice-sensor/lattice-sensor.db`を開こうとし、kernel parityの走査は
  `.lattice`を除外できず、agent-eval一式は「索引が無い」と誤判定して全部止まっていた。
  正本は`.lattice/sensor/sensor.db`である。
- **効かないenv varに頼っていたtestを直した。** `LATTICE_SENSOR_DIR`はどこからも読まれて
  いないのに、integration testが索引の隔離に使っていた（隔離は実際にはworktreeが担っていた）。
  それを事実として書いていたコメントも訂正した。

## 0.44.0 — 2026-08-03

### 変更

- **sensorをupstream（吸収元）の54コミット分へ追従させた（04ab45c→49c11fc）。** 抽出・解決の
  改善——availableParallelismベースのworker数、adaptive resolver pool、staleファイル警告、
  watchdogログのタイムスタンプ化、macOS署名キャッシュ起因のSIGKILL回避（kernelビルド）など——を
  取り込んだ。EXTRACTION_VERSIONは26へ（両側が独立に25を名乗っていたため、初めて一意な値になる）。
  既存indexは次回syncで増分再抽出される。
- **native kernelが7言語から20言語になった。** upstreamの12言語port（C/C++・C#・Dart・Kotlin・
  Lua/Luau・PHP・R・Ruby・Rust・Scala・Swift）を取り込み、Lattice独自の索引——装飾込み開始行、
  import束縛metadata、動的import/require、spawn系invokes辺、value-ref書き込み区別——を全言語へ
  追従させた。kernel parity 13ファイル・143テストでnative＝wasmの一致を固定。ABIはv3
  （upstreamのv2とレイアウトが異なるため番号を跨いで進めた。loaderは版違いをwasmへ落とす）。
- **解決済みimport辺のmetadataからbinding/importedNameが消えていた欠落を修正。** upstreamの
  keyset読取（バッチ解決が実際に使う読取）がLatticeのv10列より古く、mapperが2列を写して
  いなかった。書込み側・他の全読取は正しく、読み手の1箇所だけが落としていた。
- **upstream追従が仕組みになった。** `sensor/UPSTREAM.json`（同期点・path写像・衝突方針の正本）、
  `npm run upstream:sync`（3-way merge、実行bit保存、symlink/削除は報告で停止、`--mark-synced`で
  手動解決を完了宣言）、`npm run upstream:check`（週次Actionsでも実行。新しいkernel言語・
  extractorを名指しで報告し、force-push検知で誤報を止める）。hermetic test 10経路で固定。

## 0.43.0 — 2026-08-03

### 修正

- **native kernelがwasm側の索引契約へ追従していなかった穴を埋めた（ADR 0154）。** 7月末から8月初めに
  TypeScript側へ入った5つの索引が、Rust側へ一度も書かれていなかった——装飾込みの開始行
  （`extentStartLine`、schema v11）、import束縛の形（`bindingForm`）と元の名前（`importedName`）、
  動的`import()`／`require()`のspecifier定数畳み込み、child_process spawn系の`invokes`辺。
  この状態でnativeを使うと、装飾やimportの形や動的依存が欠けたグラフになる。native kernelは
  開発機にだけ置かれ配布物には載らないため、npmから入れた利用者の索引結果は元から正しい。
- **`kernel-tsjs-parity`の26件が常時赤で、gateとして機能していなかった。** 上の欠落はその赤に
  紛れていた。赤を無視しない運用へ戻すため、native側へ5つすべてを実装して`npm run ci`をgreenにした。

### 変更

- **kernel ABIを1から2へ上げた。** ref rowを40→48 bytesへ広げ、node rowと同じ`extraJson`の逃げ道を
  足した。import束縛の形をrefへ載せるための拡張で、Rust側とTypeScript側のlayout・decodeを同時に
  更新している。loaderは知らない版を拒んでwasmへ落ちるので、古いprebuildが混ざっても結果は壊れない。

## 0.42.1 — 2026-08-02

### 変更

- **作業記録の時刻を閲覧者の現地時刻で表示するようにした。** HTMLを生成する側は閲覧者の地域を
  知らないので、`<time datetime>`へUTCを保持したまま、ブラウザ側のcontrollerが`toLocaleString`で
  差し替える。title属性にもUTC原文を残し、scriptが動かない環境では埋め込んだUTCがそのまま読める。

## 0.42.0 — 2026-08-02

### 変更

- **loopbackの工程表が作業記録を表示するようにした（ADR 0153）。** `todo gantt serve`と常駐dashboardは
  作業者本人が読むloopback面なので、append-only noteをbounded contextのまま右ペインへ描く。ADR 0149
  Decision 8の除外は、repo外へHTMLを出す公開配信面だけに残る。除外入口は将来のために維持する。
  表示の有無ではなく配線を守るため、実サーバを起こしてHTMLを取得するtestで固定した。
- **並列可否を完了工程以外では必ず述べるようにした。** 独立性の記録が無いplanでは欄ごと消えており、
  消えた欄が「競合なし」と読まれていた。記録が無い・失効・旧versionの時は「未検査」とその理由、
  判定へ進むcompile commandを示す。着手済の工程は自分が塞いでいる着手候補を、まだ候補でない工程は
  判定前であることを述べる。
- **前提工程・後続工程へ相手の状態を添えた。** 未着手／作業中／完了／ブロック中を相手ごとにstoreから
  引いて表示する。選択中の工程の状態を流用しない。

## 0.41.1 — 2026-08-02

### 変更

- **`run start`の事前拒否gateを全面撤回した（オーナー裁定）。** 境界は予測であって制約ではない
  （ADR 0144）。競合は実行時処置面（ADR 0138・0143〜0146）が所有し、入口での事前拒否は製品哲学と
  矛盾する。0.41.0で入れたgateを取り消す。撤回は公開済み0.41.0を超える版で出す。

## 0.41.0 — 2026-08-02

### 変更

- **`run start`へTODO plan束縛と検証済み並列グループのgateを追加した。**
  0.41.1で全面撤回済み。この版を使わない。

## 0.40.1 — 2026-08-01

### 修正

- **note投影を非参照スタブrevisionに対して堅牢化した。** 移行中断が残すplan.json欠落・manifest非参照の
  ディレクトリを、note／start／show／note list／Gantt文脈の共通loaderがスキップする。参照先の破損は
  従来どおりfail closed、origin-version検査も維持する。dotagents factory-masterの実被弾を再現し、
  focused 6例で固定した。

## 0.40.0 — 2026-08-01

### 変更

- **Claude CodeとCodexへsensor気づかせhookを安全に配線できるようにした。**
  `lattice hooks install|status|uninstall|emit --host <claude|codex>`を追加し、絶対argvのreceipt完全一致だけを
  Lattice所有entryとして扱う。foreign entryとmetadataを保持し、Codexのtimeout keyは`timeout`を使う。
- **端末設定の更新をcrash・競合・復元失敗へ耐えるtransactionにした。** 0600 backup、pending→committed
  receipt、preimageとinodeの再検証、no-clobber commit、fsync、read-back、復元を実装した。
  commit後の復元失敗ではbackupとdisplaced preimageを保持し、手動復旧pathをtyped errorへ返す。
- **通知をPOSIX owner／mode検証済みstateとsession×repoの7日窓へ閉じた。** git repoに`.lattice/sensor/`がある時だけ
  Claudeのplain INFOまたはCodexの`hookSpecificOutput`を出し、`LATTICE_HOOKS=off`ではstateを作らない。
  CLI・transaction・通知・実shell往復を46件のhermetic testで固定した。

## 0.39.3 — 2026-08-01

### 修正

- **revision公開schemaとruntime validatorの`acquire_phase`契約を一致させた。**
  `todo revise`、`revise-set`、`revise-phase`が配布する3つのJSON Schemaへruntime受理値を列挙し、
  AIがschemaを正しく読んだ時だけこの正規policyを生成できない状態を解消した。3面の一致を回帰試験で固定した。
- **初回activate完了後にsocket応答だけを失った同一requestを二重実行しない。**
  restart pointerが無い初回daemonでは、durable ledgerのexact completed responseを返す。
  5.5秒遅延回帰の環境値も対象processだけへ閉じ、並行suiteへ漏らさない。

## 0.39.2 — 2026-08-01

### 修正

- **通常revisionへ互換入力された`acquire_phase`でも、既存設計メモの黙った置換を拒否する。**
  `carry`と同じ意味論比較に既存`design_memo`を含め、本文を変える場合は
  `carry_reconciled_metadata`の明示とjournal記録を必須にした。独立終端再監査が見つけた
  v0.39.1の残存経路であり、回帰試験を追加してpatch releaseした。
- **長い初回activateの同一request再照会を二重実行しない。** 5秒のsocket timeout後も
  durable ledgerの`in_progress`を`unknown`として待ち、同じdaemonへ二重activateして
  `RUN_BUSY`にする負荷時競合を解消した。5.5秒の決定的回帰で固定した。

## 0.39.1 — 2026-08-01

### 修正

- **全ToDoがdoneでも、終端監査が未受理のplanとprojectを動的工程表へ残す。** 明示Phaseと暗黙
  `terminal-audit`の`gate_ready`／`reviewing`／`rejected`をderived stateから表示し、TTL切れでも
  dashboard一覧から消さない。畳んだ工程は同じページの件数バッジから展開する。
- **AIが失敗から自力復旧できるCLI診断へ揃えた。** `PROJECT_ROOT_CONFLICT`は
  `todo dashboard adopt`を保持し、plan createとmigrateは設計メモのtype／blank／too_large／controlを
  本文非露出のpointer付きで返す。`dashboard adopt`と`gantt serve`の個別helpもsurface gateへ加えた。
- **静的Gantt退役を副作用なしにした。** 廃止コマンドはdashboardを起動せず動的viewerだけを案内し、
  `gantt serve`の不正portは`STATIC_GANTT_RETIRED`へ誤分類せず`INVALID_ARGUMENTS`で拒否する。
- **設計メモ改訂のstate carryを明示契約化した。** legacy taskへの初回memo追加は通常carryできる。
  既存memoの変更は通常carryで拒否し、`carry_reconciled_metadata`を明示した時だけpolicyをjournalへ残して
  lifecycleを保持する。単体・Phase・revision setの全入口でmemo無しschemaへの後退を拒否する。
- **migrate dry-runと移行参照をfail closedにした。** 循環時のnull参照を除き、topologyとstore／I/O障害を
  分離した。登録taskから除外taskへのparent／dependency／join参照はcompile前に位置付きで拒否する。
- 実daemon integration testの後始末を共通fixture helperへ統一し、停止中workerも起こして
  SIGTERMからSIGKILLへ上げ、fixture配下の孤児processがゼロであることを各test終了時に検証する。
- schema、製品契約、現行extraction文書を16,384文字・UTF-8 16,384 bytes、v3、`NO_PLAN`、
  動的viewer一本化へ統一した。誤って受理した旧終端監査証拠は撤回済みとして保持する。

## 0.39.0 — 2026-08-01

### 変更

- **新しいToDoへ初期設計メモを必須化した。** `plan create`、`todo migrate`、通常／Phase revisionの
  各authoring契約が非空Markdownの`design_memo`を受理し、空欄やファイル参照だけの本文を拒否する。
  本当に方針が無い場合だけ正確なsentinel `NO_PLAN`を許可し、authoring guidanceは
  「あなたがこのToDoに対して、何も考えていないならば、設計メモに `NO_PLAN` と書いてください」と問い返す。
- **通常詳細と着手結果へ初期設計メモを自動同梱した。** `todo show`と成功する`todo start`は
  append-only noteとは別に、ToDo本体へ束縛された設計メモを返す。revision後もtask migrationに従って運ぶ。
- **ローカル／公開の動的工程表右ペインへ設計メモを表示した。** 公開面から除くのは作業開始後の
  append-only note本文だけであり、初期設計メモは公開viewerでも読める。Markdownは既存の安全なrendererで描画する。
- **静的工程表生成を退役させた。** `todo gantt`、`todo gantt status`、`--out`は
  `STATIC_GANTT_RETIRED`で動的dashboardを案内する。project別HTMLやsidecarの生成・再生成は不要である。
- **AI authoringをfail closedかつ診断可能にした。** 最新schema、`todo migrate --dry-run`、bounded diagnostics、
  typed argument error、Phase guidance、reconciliation自己記述、`todo verify` v3を揃えた。
- **dashboard registryのproject root競合を自動上書きしなくした。** 同じproject IDの別rootは
  `PROJECT_ROOT_CONFLICT`で拒否し、明示actorを伴う`todo dashboard adopt`だけが配信元を切り替える。
- **native sensorでも小文字の共有値をseam閉包へ含めるようにした。** `counter`や`cache`を大文字名だけの
  gateで落としていたnative TS/JS／Go／Python／Java経路をWASM契約へ揃え、変換後の切断参照誤検出を防ぐ。

### アップグレード注意

新規authoringへ旧schemaを送ると拒否される。既存storeの読取互換は維持する。新規planは
`lattice plan create --schema-version 4 --json`、既存資料からの移行は
`lattice todo migrate --schema --json`で最新契約を取得し、各ToDoへ`design_memo`または正確な`NO_PLAN`を入れる。
個別HTMLを再生成せず、動的dashboardを使う。

## 0.38.1 — 2026-08-01

### 変更

- **valueRefのread/write判定をGo／Python／Javaへ広げた。** 代入、複合代入、member／subscript mutation、
  updateを`metadata.write`へ出し、先にreadして後でwriteするscopeもwriteを失わない。
- **WASMとnative kernelのmirrorを同じfixtureで固定した。** TS/JSを含むRust kernel 4実装も
  write metadataを出し、Go／Python／JavaのWASM結果とbyte-equivalentにする。
- **Pythonのmember assignmentをlocal shadowと誤認しないようにした。** `CONFIG["x"] = ...`は
  bindingの再宣言ではなく値のmutationとして残す。
- **native kernelのwire contract driftを修復した。** `EDGE_KINDS`へ既存の`invokes`をappendし、
  ビルド済みkernelがloaderの契約検査で全拒否される状態を解消した。
- `seam profile`の`confidence.write_distinction`は対応範囲を
  `ts-js-arkts-go-python-java-all-routes`として申告する。その他のvalueRef対応言語は引き続き
  `metadata.write`未配線であり、absenceをread-onlyとは扱わない。

## 0.38.0 — 2026-08-01

### 変更

- **ToDoへ作業記憶を追記できるようにした。** 方針、調査結果、採用／棄却理由、注意、未解決事項を
  task-scopedなappend-only note chainへ保存する。lifecycle journal／snapshotとは分離し、note追記が
  工程状態を変えない。
- **別の読取commandを要求せず、通常詳細と着手結果へnoteを自動同梱する。** `todo show`と成功する
  `todo start`が、最新bounded note群、元plan version／元task、訂正状態、head digest、overflow、
  全履歴commandを`note_context`として返す。note chain破損時は空へ丸めず、`todo start`はevent追記前に止まる。
- **plan revisionを跨いだ来歴を保つ。** `task_migration`だけを根拠に旧版noteを現行ToDoへ投影し、
  removed taskはarchived束として読める。raw task IDの偶然の一致では継承しない。
- **ローカルGantt右ペインへ「作業記録」を追加した。** Markdownは安全に描画し、来歴・overflow・読取不能も
  区別する。公開serve／常設dashboardは共通public rendererでnote本文を除外する。
- **CLI発見面を揃えた。** `lattice todo --help`と個別helpから`todo show`、note追記、`note list`へ到達できる。

### 導入時の注意

`npm install -g`は既に動いているLaunchAgentを載せ替えない。global install後はbridgeを再起動し、
ローカルbridgeと公開dashboardの双方をsmokeする。

```bash
launchctl kickstart -k "gui/$(id -u)/dev.kitepon.lattice.bridge"
```

## 0.37.0 — 2026-07-30

### アップグレード注意（0.36.0 / 0.36.1 から上げる場合は必ず読む）

0.36.0 で入れた終端監査 gate は、**過去に終わった工程まで「監査待ち」にしてしまう欠陥**を
持っていた。アップグレードすると、phase を持たない完了済み plan が工程図で畳まれなくなり、
過去の完了分が図に残る（実測: Lattice 自身が 23 plan／104 ToDo）。0.37.0 はこれを直す。

**過去は監査できない。監査対象のコードが既に変化しているからである。** それでも監査を要求すると、
今のコードを見て「問題がある」と言い出す（実際には後の意図的な変更である）か、中身を見ずに
`accept` を押すかのどちらかを誘発する。どちらも gate が原因の事故になる。

対処は次のどちらかを、plan ごとに選ぶ。

```bash
# 1) 今から監査する（コードが生きている最近の工程はこちら）
lattice todo phase review --plan <key> --phase terminal-audit --reason <text>
lattice todo phase accept --plan <key> --phase terminal-audit --input <file>

# 2) 監査しないまま閉じる（対象が変化してしまった歴史はこちら）
lattice todo phase close-unaudited --plan <key> --phase terminal-audit --reason <text>

# 2 を一括で（除外を指定できる。監査したい plan は --except で残す）
lattice todo phase baseline --reason <text> --except <残したい plan_key>
```

### 変更

- **第3の終端状態 `closed_unaudited` を足した**（[ADR 0148](docs/adr/0148-history-closes-unaudited-not-audited.md)）。
  「監査なしで閉じた」ことを理由つきで journal へ記録する。**`accepted` へ絶対に化けない**——
  `phase_accept_dependencies`（Phase 受理を必要とする ToDo）は `accepted` の厳密一致だけで解錠され、
  `closed_unaudited` では解錠されない。前提は `gate_ready`（所属 ToDo が全て done）で、
  `phase_reopen` でやり直せる。工程図では畳むので監査待ちの札が外れる。
- **一括入口 `todo phase baseline`**。現在 `gate_ready` かつ phase event を一度も持たない Phase を
  まとめて宣言する。除外・対象外（既に accepted 等）・失敗を区別して返す。**自動実行はしない**——
  どれを監査し、どれを歴史として畳むかは人／AI が決め、装置は宣言を受け取って記録するだけである。
  時間ベースの推定（「N 日以上前だから免除」）も入れない。
- **札が出た理由を画面で言う**。`todo done` の advisory と `todo phase status` の guidance へ、
  何が起きたか（0.36.0 で終端監査の要求が過去の完了分にも及んだ）と、上記2択のコマンドを載せる。
  原因を説明しない gate は、原因を隠すのと同じである。

## 0.36.1 — 2026-07-30

- **配布漏れを直した**。`package.json`の`files`はschemaを個別列挙するため、0.36.0で追加した4件
  （`todo_revision.v2`／`todo_revision_set.v3`／`phase_todo_revision.v3`／`todo_extraction.v2`）が
  配布物へ入らず、global installでは`todo revise-phase --schema --json`等が
  `INTERNAL_FAILURE`になっていた（公開後smokeで検出）。4件を列挙し、**CLIが読むschemaと配布
  リストの一致を強制するtestを足した**（列挙を1件抜くと落ちることを確認済み）——repo内では
  通るのに配布物では落ちる種類の欠陥は、機械で塞がないと再発する。

## 0.36.0 — 2026-07-30

- **重監査を飛ばせなくした**（[ADR 0147](docs/adr/0147-audit-is-on-by-default.md)）。
  phaseを持たないplanは終端に重監査が要る。予約Phase `terminal-audit`を暗黙に1つ持たせ、
  全task doneは`gate_ready`（＝監査待ち）であって完走ではない扱いにする。既存のPhase gate機構
  （review → evidence束縛accept／evidence slot／journal event）をそのまま再利用し、新しい状態機械も
  event型も増やしていない。**閉じたことにさせないteethはgantt live scopeに置く**——監査未了planの
  ToDoは畳まない（完走扱いで図から消えるのが「閉じた」の可視表現だからである）。実測: 本repoの
  同一storeに対し、旧版が154件を完走済みとして畳むのに対し50件へ減り、差の104件が監査待ちとして
  図に残った（本repo自身の23 campaignが終端監査を通っていなかった事実の可視化）。
  作成は拒否せず通知に留める——`todo migrate`／`plan create`の結果と、最後のpending taskが
  doneになったときのadvisoryへ`terminal_audit_required`を載せる。
  **終端監査はToDoのdispatch可否へ影響しない**（ADR 0062の不変を継承。next_ready・active_set・
  dispatch_frontierが暗黙Phaseの状態遷移でバイト同一であることをtestで固定）。
- **doneを保ったままPhaseを獲得できるようにした**。全taskがdoneのplanへ後からPhaseを被せる経路が
  無かった（carryは`phase_id`を意味論比較へ含めるため獲得を拒否し、`reset_pending`はdoneを消す）。
  `state_policy: acquire_phase`を足し、**未割当→割当の向きだけ**を許す。既にphaseを持つtaskの
  付け替えは拒否し、`carry`の意味論比較そのものは緩めていない。
- **authoring CLIの発見可能性を4件直した**（2026-07-29の実運用で踏んだ不足）。
  `plan create --schema --json`の既定を最新v3へ（`--schema-version 1`は互換で継続）。
  `todo revise`／`revise-set`／`revise-phase`／`migrate`へ`--schema --json`を追加し、実際に受理する
  最新契約のJSON Schemaを返す（storeを読まない）。スキーマ違反の`detail`へ`violation_reason`と
  `violation_path`を載せる（ソート違反は`/tasks/1`のようにindexまで名指しする——実運用で最も
  時間を溶かした箇所）。`lattice plan show <key> --json`を新設し、`todo bindings`の空配列を
  「planが空」と誤読する事故を塞ぐ。
- journal eventのschema列は、v1 genesisのjournalへ`phase_*` eventだけをv3 tailとして混在許可した。
  既存eventのbytesとdigest計算は変えず、v3のtask eventは従来どおり拒否する。これが無いと
  phase無しplanへphase eventを一切追加できない。

## 0.35.0 — 2026-07-29

- **公開工程表の未知URLを、ブラウザではLatticeのブランド404として返すようにした。**
  `Accept`が`text/html`を含むrequestには、`kitepon.dev / Lattice`の帰属、一覧と
  kitepon.devへの戻り先、`noindex, nofollow`を持つHTML 404を返す。API利用者などHTMLを
  要求しないclientには、従来の`lattice.todo_gantt_http_error.v1` JSON 404を維持する。
  見た目の改善で機械契約を黙って変えず、content negotiationで両立させた。
- **直列dispatchの申告を一度突き返し、並列を再検討させるようにした。** readyが複数ある時、
  `--override-reason`に理由を書けばそのまま直列で通っていた。実運用で「単一セッションだから
  逐次実行」という、並列にできない根拠になっていない理由で直列化する事例が出たため、既定
  （`all_ready_parallel_by_default`）を規則ではなく機構で守る。直列の申告には
  `PARALLEL_DISPATCH_RECONSIDER`を返し、同じ理由に`--serial-confirmed`を付けた再実行だけを
  受理する。**足止めは一度だけで、再実行すれば直列で進む。** さらに、理由がworker数・
  セッション構成・作業者の都合を述べただけの場合は`PARALLEL_DISPATCH_INVALID`で拒否し、
  `--serial-confirmed`があっても通さない——実行主体が1つしか無いことは並列にできない理由では
  ないため。同一fileへの書込衝突など実際の干渉を書けば再確認を経て通る。
  エラーには`default_policy`と`ready_task_ids`を載せ、既定が全ready同時dispatchであることを
  その場で読めるようにした。
- **計画時点でも、ほぼ一直線な依存グラフを突き返すようにした。** 着手時（`todo start`）だけを
  締めても、planそのものが直列に組まれていれば並列は生まれない。`plan create`と`todo migrate`が
  `dispatch_shape`（`task_count`／`critical_path_length`／`max_frontier_width`／
  `serialization_ratio`）を計算して結果へ載せ、`serialization_ratio`が閾値0.5を超えたら
  `PARALLEL_DISPATCH_RECONSIDER`で一度突き返す。再考した上でなお直列でよいなら
  `--serialization-reviewed`を付けて再実行する。**6 task未満のplanは対象外**——
  3〜5 taskの一直線を突き返しても再考の余地がないため。
  判定はstore書込みの**前**に行うので、拒否された時にstoreへは何も書かれない。
  - 副作用: 循環・自己辺を含む入力は、これまで`initializeAuthoredTodoStore`／`appendImportedPlan`
    内部の`validateMergedGraph`が`STORE_INCONSISTENT`（`merged_cycle`／`self_edge`）で拒否していたが、
    gateがstore書込み前に動くため`DISPATCH_SHAPE_INVALID`で止まるようになった。拒否される点は
    変わらないが、エラーコードが変わる。
  - `serialization_ratio`は固定小数4桁の**文字列**で返す。`todoSelfDigest`のcanonical化が
    safe integer以外の数値を拒否するため、digest対象へ埋め込める形にした。
- **`lattice todo --help`に`migrate`を追加した。** 既存storeへplanを追加する唯一の入口なのに
  Read/Write commandsのどちらにも載っておらず、`plan create`が空store初期化専用であることも
  ヘルプからは読めなかった（`plan create`は既存storeで`store_already_exists`を返す）。

## 0.34.2 — 2026-07-29

- 公開工程表の詳細画面にも`kitepon.dev / Lattice`のブランドヘッダーと一覧へ戻る導線を追加した。
  検索除外metadataを揃え、工程図・工程データ・CLI生成artifactは変更していない。

## 0.34.1 — 2026-07-29

- 公開工程表のトップを`kitepon.dev / Lattice`のブランド接点として整えた。公開面の役割、
  `kitepon.dev`とGitHubへの導線、検索除外metadataを追加し、表示名とproject IDが同じ場合の
  重複表示を解消した。工程データと各projectの工程表は変更していない。

## 0.34.0 — 2026-07-29

- **抽出器の進化をsyncが自動で拾い、staleな抽出を増分healするようにした**（schema v12）。
  filesの各行に、それを書いた抽出器の`extraction_version`を記録し、syncの「変更なし」判定を
  content_hash一致**かつ**版数一致にした。抽出器が進化したら、内容不変のfileも通常の増分経路で
  再抽出される。statusのpending changesも版数staleを数え、全fileが現行版へ達したsyncは
  global stampを自動前進させて`reindexRecommended`を消す——従来は「手動full再indexの推奨」
  止まりで、推奨は誰も実行しない。2026-07-28の実被弾（旧daemonのwatcher更新でtimestampは
  新鮮・意味論は古いDBが恒久化し、束縛・装飾行が「無い」という偽の観測として読まれ続けた）の
  再発防止であり、migrationのDEFAULT 0により導入それ自体が既存indexを初回syncで全快させる。
  実measured: 本repo 678 fileの全快が約9秒。
- **EXTRACTION_VERSIONを25へ遡及bump**。0.33.0の抽出変更（valueRef write区別・名前filter
  緩和・import束縛metadata・装飾込みextent・Rust attribute収集）はいずれも同一textへの
  抽出出力を変えるが、bumpされていなかった。

## 0.33.0 — 2026-07-28

- **変換の検証へ、切断参照の網を張った**（[ADR 0145](docs/adr/0145-the-verification-net-is-a-gate-not-a-cage.md)）。
  移した先のcodeが残余面のsymbol（module変数・非公開関数）へ束縛なしで言及していれば、
  `behavior_equivalent:severed_reference:<file>:<name>`で不認定にする。moduleの読み込みは
  通るのでfocused testが当該経路を通らない限り露見しない——**壊れた変換が「同等」の記録つきで
  採用される穴**を受入の一点で塞ぐ。網は成果物だけを見るので、装置の変換でもAIの変換でも
  同じにかかる。過程は監視せず、失敗は採点されない。

  当初はsensorの`unresolved_refs`の集合差分を予定していたが、**bare参照の切断はそこに記録
  されないことを実測で確認し**、fresh indexのsymbol一覧（新設`lattice-sensor file-nodes`）と
  本文言及の突き合わせへ組み替えた。
- **書き換えの土台をsensorの実データへ置き換えた**（sc-013）。ESM変換のimport面は
  `file-nodes`の新出力`imports`（文の行範囲）と`import_bindings`（AST由来の束縛
  default/named/namespace＋別名）を行番号で束ねて受け取り、export状態はnodeの
  `isExported`（AST事実）で判定する。書き換え経路から正規表現のimport再解析と
  export判定を撤去した（`scanImportStatements`はprofile投影専用として残る）。
  観測が無い・束縛の帰属が曖昧・importが先頭block外のときはtyped理由で不認定し、
  正規表現へfallbackしない。確実の門へ第9条件「import面の観測確定」を追加。
  切断参照の網のimport束縛判定も、生成textの再解析からworktree fresh indexの
  AST観測へ替えた。sensor側: builtin等のresolution失敗で`failed`へparkされた
  import束縛が読めるよう、status非依存の`getImportBindingRefsByFile`を追加
  （束縛は抽出事実でありresolution状態と無関係）。
- **確実の門を正典化した**（[ADR 0146](docs/adr/0146-the-certainty-gate-classifies-handoff.md)）。
  機械変換の前提8条件を `SEAM_GATE_PRECONDITIONS` として一覧化し、拒否理由を
  `fix_declaration`（宣言を直せば機械で通りうる）と `hand_to_ai`（機械の変換能力の外）へ
  分類して `runtime_seam_resolution.v2` の `gate` で返す。未知の理由は確実側へ丸めず
  安全側の手渡しにする。新しい拒否条件は増えていない——既存の fail-closed 挙動の読める面。
- **装飾込みの開始行が取れるようになった**（`extentStartLine`、sensor schema v11）。
  extent は宣言だけを指し、Python の `@decorator` や Rust の `#[derive]` は外の行にある——
  宣言行だけで切り出すと装飾が残余面へ取り残され、挙動が黙って変わる。`startLine` は
  node identity に参加するので動かさず、広い開始行を別 field で持つ。`file-nodes` と
  seam 変換の切り出し（`readSymbolExtents`）が使う。Rust の `attribute_item` は
  兄弟走査の停止条件に含まれておらず struct の `#[derive]` が一度も拾えていなかったので、
  extent 計算に含めた（依存辺の意味論は変えない）。
- **import 束縛の形が resolved edge の metadata に残るようになった**（sensor schema v10）。
  default / named / namespace の区別と、alias が改名した時の source 側の名前
  （`import { renamed as alias }` → `importedName: 'renamed'`）を、抽出器が既に持っていた
  AST 知識から搬送する。従来は3分岐で認識した直後に同じ形へ潰しており、書き換え側は
  import 文の text を正規表現で再解析していた。搬送は unresolved_refs の新カラム
  （`binding_form`/`imported_name`、migration v10）→ 解決 → edge metadata。
- **value-ref 辺の名前フィルタを緩めた。** 従来は大文字か `_` を含む名前だけを辺の対象に
  していたので、全小文字の module 変数（`counter`, `cache`）への参照が辺にならず、
  切断コストの内訳が「共有なし」と偽陰性を返しえた。長さ3以上だけを残して緩和。
  実測（本 repo・667 file）: valueRef 辺 2630→2862（+8.8%）、全辺 +0.35%、
  index 時間・DB サイズは差なし。3文字未満の名前は引き続き辺にせず、confidence が
  `names-under-3-chars-invisible-in-edges` として申告する。
- **module 値への参照が read/write を区別するようになった（TS/JS）。** 再束縛
  （`X = v`）・member mutation（`X.n += 1`）・update（`X++`）を write として
  `references` 辺の metadata に立て、CLI は `valueWrite` で返す。読んだ後に書く形
  （`const n = X; X = n + 1`）も write に数える——最初の読みが後の書きを隠さない。
  共有の重さは「読むだけ／片方が書く／両方書く」でほぼ決まるので、切断コストの内訳
  （`shared_state.written_by`）が誰が書くかまで数えられるようになった。

  **配線は TS/JS 族の wasm 経路だけ**である。kernel 経路（Rust、この host では未 build）は
  未配線で、その索引では書き込みが読みに見える——profile の confidence が
  `ts-js-wasm-pipeline-only` として申告する。kernel と他言語のミラーは Rust toolchain を
  前提に別課題（sc-007）。
- **sensor の callers/callees が辺種別を返すようになった**（`edgeKind`・`valueRef`）。
  traversal は元から `references` 辺を通しており、module 値への参照は結果に混ざって返って
  いたが、JSON が node 情報だけを吐いて辺種別を捨てていた——「この隣接は関数呼び出しか、
  module 値の参照か」を切断コストの内訳が区別するために出す。併せて Lattice 側の
  callers/callees 照会へ `--limit 200` を明示した。CLI 既定の20件では fanout の大きい関数で
  参照が黙って切られる（実測: `explainRunRequest` の callees は23件で、3件が窓の外だった）。

  **破壊的変更**: callees/callers を含む sensor receipt の digest が変わる。host-local の
  independence 記録・seam 提案は再 compile で再生成される（どちらも gitignore 済みの投影）。
- **親・兄弟ディレクトリへ移す変換の import 指定子を直した。** 行き先が元 file の配下で
  ない時に `./<repo相対path>` という解決不能な specifier を生成していた。segment 単位で
  共通 prefix を外し `../` で組み立てる。
- **export面の比較がJS/TS限定であることを明示した。** ESM構文を正規表現で読む検査であり、
  他言語では実質空になる。黙って「検証済み」と言わない。

- **破壊的変更: 予測超過を表すfindingの種別名を改めた。** `scope_violation` →
  `undeclared_write`、`io_scope_warning` → `io_undeclared_write_warning`。
  宣言境界は計画時の**予測**であってworkerを閉じ込める制約ではないので、超えたことは違反では
  ない。code が「違反」と言っていると誤解を再生産する——実際、この改名を起票する過程で
  「違反側の宣言を直す」と書いてしまった。旧名を持つfindingは検証を通らない。

  改名は**製品のfinding種別だけ**である。同じ`scope_violation`という文字列がRC1/RC2の変換拒否
  理由とRC3 campaignの条件名にもあるが、どちらも別空間なので旧名のまま残る。前者は
  `research/campaigns/`の成果物へ、後者はRC3 manifestのdirectory名として凍結されている。
- **請求項8が実runで通った。** 実行時に観測した競合に対して、双方停止→変換→双方再開が
  実daemon・実repository・実sensorで1本に繋がった
  （[受入](test/integration/hold-transform-resume.integration.mjs)）。請求項7との違いは
  再開の形である——請求項7は片方を繋ぎ直し、請求項8は**双方が新しい面を所有して同じ波で動く**。

  そこへ届くまでに、直列に並んだ4つの欠陥を直した。どれも契約もコードもgreenなtestも揃って
  いたが、**一度も実行されていなかった**。1つでも残っていれば実runでは成立しない。

  | 欠陥 | 影響 |
  |---|---|
  | seam splitが再導出digestでfindingを縛っていた | 再計画がfinding recordを読めない |
  | 再計画の比較起点が翻訳前のpredecessorだった | 実行時競合のsplitが永久に不一致 |
  | 所有の導出が`owns`（宣言された面）を数えていなかった | **path競合を切るsplitが原理的に検証不能** |
  | supervisorが`actor`へ文字列を渡していた | phase revisionを一度もcommitできない |
- **実行時にしか現れない形の競合が、請求項8へ届くようになった。** 実行時のpath競合は片方が
  その資源を所有していないから起きるが、変換の宣言（`concern_anchors`）は自分の所有内にしか
  書けない。宣言が原理的に書けず、**変換の中身は動くのに実運転からそこへ行けなかった**。
  観測された実態へ宣言を合わせる翻訳段を入れ、そこから先は既存の請求項7／8へ渡す。
  合わせた内容は`lattice.runtime_seam_resolution.v2`の`reconciled`に残る。

  宣言は裏取りと対で広げる。所有だけ足すと`sensor_unbound`でcompileが非dispatchableへ落ち、
  競合が投影されないので変換の便益が測れない。裏取りに使えるqueryがrunに無ければ広げずに
  理由を返す——証明できない宣言を作らない。
- **請求項8を試せる場面が運転側から見えるようになった。** `routeConflictTreatment`が
  `intentional_serial`を返すのは「変換が不可能」ではなく**事前宣言が無いだけ**であり、
  実行時に見つかった競合は既定だけ見ると請求項8への道が無いように見えた。
  `severability`と`transform_attemptable`を返し、`run status`の`treatment_advice`
  （`lattice.runtime_status_projection.v2`）として出す。拒否ではなく助言である。

  装置が言うのは「切れる種類の資源か」までとする。path／symbolは面を分けられるが、共有state／
  外部effectは分けても同じ資源に触り続ける。**実際の難しさは変換を試して五条件で測る**——
  試すかどうかは費用のかかる判断なので装置が決めない。
- **affected test driftの比較単位をTODOにした。** 束縛ごとに宣言全体とexact比較していたので、
  **affectedの異なる2 pathを所有するTODOは原理的に成立しなかった**——実行時に所有が広がった
  宣言を受け取れない。全affected束縛の観測の**和**と比較する。1面しか持たないTODOでは
  結果が変わらず、緩みも入らない（余分な宣言も足りない宣言もdriftのまま）。
- **単独の予測超過ではrunを止めなくなった。** 誰の領分とも重なっていない宣言外の書き込みは
  競合ではなく、予測が実態より狭かったという情報である。記録は残る。実際にぶつかった
  （他の走行中TODOの宣言scopeへ書いた）時だけholdへ運ぶ。

  `conflict`操作も1者しか名指していないfindingを`FINDING_NOT_A_CONFLICT`で拒否する。
  **hostが投げれば処置できないfreezeを作れた**——処置は2つとも2者を要求するので、
  legalなrecompileが作れないまま止まる。区別しているのは書き込みの善し悪しではなく
  当事者の数である（[ADR 0144](docs/adr/0144-prediction-excess-is-not-a-conflict.md)。
  ADR 0044の「offender＋affected closure hold」を覆す）。
- **請求項7が実runで通った。** 早期警報→probe→finding→conflict→freeze→静止証明→hold→
  後継epochへのrebind→再開まで、走行中のworkerに対して1本で繋がった
  （[ADR 0143](docs/adr/0143-io-sentinel-is-an-early-warning-not-a-finding.md)）。
- **path競合の直列化資源を、係争pathから導出するようにした。** `routeConflictTreatment`は
  path競合を直列化レーンへ振るのに、handlerがfindingの`resource_id`との一致を要求し、
  path findingのそれは必ずnullだった——実行時に観測されるpath競合は再計画できなかった。

## 0.32.0 — 2026-07-28

- **早期警報からholdまでが実runで通った。** 書き込み観測→probe→finding→conflict→freeze→
  静止証明→holdが、走行中のworkerに対して1本で繋がった
  （[ADR 0143](docs/adr/0143-io-sentinel-is-an-early-warning-not-a-finding.md)・
  [実測](docs/evidence/2026-07-28-io-sentinel-live-run.md)）。

  | 段 | dispatchからの経過 |
  |---|---|
  | 実在警報 | 137 ms |
  | intake freeze | 662 ms |
  | hold | 663 ms |
  | （従来）worker完了まで | 8,000 ms |

  従来値は**workerの実行時間そのもの**であり、装置が決められない値だった。長い作業ほど差が開く。
- **workerを別processへ出した**（`adapter_dispatch_response.v2`）。holdの静止証明は「名指しされた
  processが実際に停止していること」を要求するが、executorがcontroller自身のprocessだと、止めれば
  応答できず止めなければ証明できない——構成として証明不能だった。`detached`で独立process groupへ
  置き、barrierでSIGSTOPして止まった木を読む。**装置はprocessを止めない**——止めるのはexecutorの
  責務で、Latticeが行うのは検証だけである。
- **escalationをepoch駆動の安全点で捌くようにした。** 駆動側はrun eventsをメモリに抱えたまま
  awaitをまたぐので、横から追記すると次の全体置換で消える。lockを取れるようにするだけでは、
  静かに記録を失う方向へ壊れる。
- この配線で、当該経路のholdが一度も実行されていなかったために露出していなかった不整合を5件
  直した（artifact digestの取り違え、barrierが完走を待っていた、`process_children`欠落、
  attestationの形違い2件）。

## 0.31.0 — 2026-07-28

- **実行時競合の早期警報が、実runで初めて発火した**
  （[ADR 0143](docs/adr/0143-io-sentinel-is-an-early-warning-not-a-finding.md)・
  [受入証拠](docs/evidence/2026-07-28-io-sentinel-live-run.md)）。
  実daemon・実worktree・実gitで、宣言scope外への書き込みを**走行中に**観測し、probeが実在と
  裁定するところまで通る。一時fileには`transient`と裁定し、書いて消したもので全workerを止めない。
- **probeは実装以来一度も動いていなかった。** `captureWorktreeDiff`をimportせずに呼んでおり、
  観測失敗を丸めるための`.catch(() => null)`が`ReferenceError`ごと握り潰していた。返る値は常に
  「観測できなかった」という**正常系の値**で、syntax checkもlintも1080件のtestも緑だった。
  握り潰す範囲が広すぎると、壊れていることが正常系と区別できなくなる。
- **workerをTODOごとの実worktreeへ分離し、非同期に走らせるようにした。** 以前は全TODOのbindingが
  同じrepo rootを指し、dispatchの中で作業が終わっていた。前者では書き込みの帰属をrootから
  決められず、後者では走行中のTODOが1つも存在しないので、実行時の観測が原理的に成立しなかった。
  結果として、runはユーザーのtreeを直接書き換えなくなった。
- **probeのcheckpointをreceipt裁定のbinding基準から外した。** probeはexecutorの申告境界ではないので、
  混ぜると走行中に書き続けた正当なreceiptが`checkpoint_mismatch`で落ちる。
- **まだ通っていないこと:** 警報からholdまでは実runで通っていない。`run activate`がepoch全体を
  lifecycle lockを握ったまま同期駆動するため、escalationがlockを取れる頃にはworkerが完了している。
  検出遅延の実測も未了である。切り離しは次の工程が持つ。

## 0.30.1 — 2026-07-28

- **npmのauthorを設定した。** 未設定だったので、公開面に作者が出ていなかった。
  name側に丸括弧を使わない——npmのlegacy author parserが丸括弧をURL記法として
  再解釈し、明示したURLを潰す（aiterm-mcpがv0.20.1で被弾した既知の罠）。
- 0.29.0以前のMIT表示へ、deprecateで訂正を載せた。公開済みversionのmetadataは
  書き換えられないので、非破壊で訂正を届けられる唯一の手段である。

## 0.30.0 — 2026-07-28

- **npmのlicense表記を訂正した。** 0.29.0までの公開版はpackage.jsonが`MIT`のままで、registryは
  この製品をMITとして配っていた。本体のlicenseは`PolyForm-Noncommercial-1.0.0`（非商用は無償、
  商用は別途許諾）である。**既にMIT版を取得した利用者は、そのコピーについてMITの許諾を持ち続ける**
  ——後からの公開で取り消せる性質のものではない。止められるのは以降の取得だけである。
  同梱する`sensor/`はupstream由来のMITのままで、これは変更しない（第三者コードは再ライセンス
  できず、帰属表示の保持義務がある）。
- **workerをTODOごとの実worktreeへ分離した。** 管理daemonのdispatchは全TODOのbindingへ同じ
  repo rootを入れており、書き込みの帰属をrootから決められなかった。supervisorがdispatchの前に
  worktreeを切って監視を張る。結果として、runはユーザーのtreeを直接書き換えなくなった。
- **実行時競合の早期警報を、警報からholdまで繋いだ**（I/O sentinel）。書き込み観測→probeで
  実在確認→既存の`finding_record`→`conflict`→`hold`をdaemon自身が発行する。新しい停止経路は
  作らないので、findingの再導出もepoch束縛も既存handlerがそのまま行う。
- **帰属が立たない構成では警報を出さない。** rootを共有して走っているTODOは監視しない——
  1件の書き込みが両方のwatcherへ配られ、無実のTODOへ「他人のscopeへ書いた」と主張してしまう。
- **probeのcheckpointをreceipt裁定のbinding基準から外した。** probeはexecutorの申告境界では
  ないので、混ぜると走行中に書き続けた正当なreceiptが`checkpoint_mismatch`で落ちる。

## 0.29.0 — 2026-07-27

- **宣言道具が創作境界に対応した**（`lattice.todo_witness_draft.v2`）。ADR 0136の`creates: true`は
  `run_request`と`witness_set`にあったが、**下書き契約に無かった**ため、新規fileを作るToDoの宣言を
  `witness scaffold`で作れなかった。新module・新doc・新testの追加は実開発ToDoのかなりの割合を
  占めるので、道具が使える範囲が実際の作業から外れていた。`owns`の1件を
  `{ "path": "...", "creates": true }`と書けるようにした。
- **自動導出にはしない。** 観測から機械的に創作境界と読むと、pathのtypoが「必ず止まるエラー」から
  「黙って通る創作境界」へ変わる。宣言する欄を足し、道具は**宣言が実態と合っているか**を確かめる
  側を持つ——fresh absentであること、blast radiusが空であること、front endが要求する形
  （`changedFiles`が対象1件）であること。
- **観測の三値を保つようにした。** 不存在は「観測できていない」ではなく「不在と観測できた」で
  あり、fsのlstat結果である。混ぜると創作境界を宣言したToDoが未観測側へ落ちる。
- 不在なのに創作を宣言していないpathへ、`path_absent_declare_creates`で**次の一手を返す**。
  以前は`affected_tests_unobserved`——観測できていないと言っていたが、実際には観測できていた。

## 0.28.0 — 2026-07-27

**Latticeが自分の閉じ作業をLatticeで組んだ版。** 実際に使ったことで、使わなければ出なかった
欠陥が7件出た。うち3件は、それが直るまで**変換が一度も受理されない**ものだった。

- **symbol範囲の取得が既定limitで打ち切られていた。** witness evidenceの共通経路がsensor CLIの
  既定`--limit 10`で名前を引くため、同名symbolが多いprojectでは対象fileの定義が窓の外へ落ちる。
  実測で`GIT_SHA1`は17 fileにあり、**実在するsymbolを「範囲なし」と誤報して正当な変換を棄却して
  いた**。専用経路で明示limitを渡し、打ち切りは`symbol_lookup_truncated`として区別する。
- **隔離worktreeにbuild成果物（`sensor/dist`）が無く**、同梱sensorを起動するfocused testが全部
  ENOENTで落ちていた。`focused_tests_passed`が原理的に満たせない状態だった。存在する時だけmountする。
- **残余面が移動した公開symbolを再exportしていなかった。** 原pathをimportしている全fileが壊れ、
  外部挙動同等性が原理的に満たせなかった。移動先を指すexport文を残余面へ足す。
- **案内の不具合も直した。** verifierの失敗がどのtestのなぜか返らない、入力契約違反が期待する形を
  言わない（`schema_invalid`だけ）、cleanliness拒否が汚染pathを言わない——いずれも「動かない理由を
  追う手段が無い」不具合である。
- **未決25件をすべて裁定した**（ADR 0142）。既に裁定済みなのに印が無いもの7件、いま裁定できるのに
  保留していたもの6件、実データ待ち7件。`npm run check:open-questions`が、発火条件も移譲先も
  裁定先も持たない未決を落とす。
- **seam refの寿命と変換の連鎖**を決めた。refは自動では消さない（受理された変換の実体を辿れる唯一の
  資源である）。同じcandidateへの2回目は、前の変換を含むbaseの上でのみ確定できる。
- **未配線moduleを研究成果物として裁定した。** `npm run check:reachability`が入口から辿れる集合を
  機械的に出し、辿れないものは理由つき宣言だけ通す。製品79 module・研究33 module。
  `boundary-compiler.mjs`など、名前は中核に見えるが製品経路から一度も呼ばれていない5本が出た。

## 0.27.0 — 2026-07-27

- **実行時変換レーンに本番の入口を作った**（`lattice run seam resolve --run <ref> --finding <digest>
  --input <request.json>`）。変換の中身は動くのに、実運転からそこへ行く道が無かった——実運転側が使う
  `routeConflictTreatment`は事前宣言済みtreatmentがpathを覆う時しか`seam_transform`を返さないので、
  **予期しなかった競合は変換にかからず直列へ退化していた**。壊れて止まらず緑のまま進むので、
  欠落が表に出なかった。
- 入力へ書くのは、係争fileの中で各TODOが触るsymbol、新しい面の名前、task migrationのdigestだけ。
  どれもAIが既に持っている情報であり、Latticeは推定しない。実CLI・実sensor・実repositoryで、
  事前宣言のない競合が変換され、返った`successor_base_sha`へworktreeを張ると宣言した面が実在し、
  canonical branchとHEADは動いていないことまで通した。
- **`mode: 'seam_split'`の再計画で、後継baseが本当に変換を含むかを検証する。** これまでは変換を
  含まないbaseを指していても通った。baseが前進し旧baseの子孫であること、splitが消えると述べた
  競合辺が後継planに実際に無いこと、新たに所有すると述べた資源がcreationとして宣言されていない
  ことを見て、満たさなければ`SEAM_SPLIT_UNPROVEN`で止める。
- **CLI表面の機能確認gateを足した**（`npm run check:cli-surface`）。出荷54コマンドについて、
  `--help`が本文を返すかと、CLI入口を通るtestが実際にそのコマンドを走らせているかを見る。初回は
  **未収載10件・未確認5件**。`run activate`／`conflict`／`hold`／`recompile`／`reprocess`／
  `finding record`／`seam resolve`、`todo migrate`、`status`、`session-context`は存在するのに
  使い方を知る手段が無かった。`runtime-errors resolve`／`reopen`／`compact`、`todo bindings`、
  `bridge register`は一度もCLIから走らせていなかった。すべて埋めて54/54 green。
- **sourceの生NULバイトを拒む。** `seam-apply.mjs`と`seam-commit.mjs`が区切り文字として生の
  NULバイトを含み、`git diff`が`Binary files differ`、`grep`がfileを黙ってskipする状態でcommitされて
  いた（実際に到達可能性の監査が誤った結論を出した）。escapeへ直し、`check-syntax`でgateする。
- `recompileNextEpochPlan`の`successorBaseSha`を除去した。管理runtimeでは後継planを実repositoryから
  compileし`repo HEAD`との一致を要求するので、baseを決めるのは後継requestであり、この引数は
  呼び出し元もtestもゼロの死んだ引数だった。

## 0.26.0 — 2026-07-27

- **実行時変換の再開先を実在させた**（ADR 0141）。実行時のseam_transformレーンは、競合を観測し
  隔離worktreeで変換し五条件を通して`runtime_seam_split`を組むところまで動いていたが、その成果を
  **どこにも着地させず**、後継planの`base_sha`も前進させていなかった。splitが「このTODOは
  `src/page-left.mjs`を所有する」と宣言するのに、再開したworkerのworktreeにそのfileが無かった。
- `commitSeamTransform`が、使い捨てworktreeをbaseへ張り、変換後のfileをdetached HEADでcommitし、
  `refs/lattice/seam/<id>`へ繋ぐ。**canonical branchは動かない。** refはGC対策であって、
  branch名前空間へは出さない。変換で1 byteも変わらなければ確定しない。
- `recompileNextEpochPlan`が任意の`successorBaseSha`を受け、後継planのbaseだけを前進させる。
  carry-over側のrebind packetは触らない——content digest不変が要件であり、継続している作業は
  自分のworktreeで走り続けているため。
- **確定できないなら採用しない。** 確定手段が無ければ`committer_absent`、確定に失敗すれば
  `transform_not_committed`で意図的直列へ送る。「変換した」と言いながら再開できない状態を作らない。
- **syntax gateの穴を塞いだ。** `npm run check`は`package.json`へfile名を手で並べる形で、実測で
  src配下108本のうち**53本が未収載**だった。`scripts/check-syntax.mjs`でdirectoryを走査する形へ
  変え、62本 → 119本。fileを足せばgateが自動で広がる。

## 0.25.0 — 2026-07-27

- **宣言を書く道具を足した**（`lattice todo independence witness scaffold --plan <key> --input <draft>`）。
  下書き（`lattice.todo_witness_draft.v1`）に書くのは**何を所有し係争資源の中で何を触るか**だけで、
  道具が供給するのは**AIには作れないもの**——`affected_tests`のfresh観測、`sensor_query_set`と
  `sensor_provenance`の配線、canonical bytesと自己digest——に限る。**推定はしない。**
- この3つは実際の摩擦である。手書きだと`affected_tests`は観測とbinding単位でexact比較されて外れ、
  非canonicalなbytesは独立性判定を通ってseam提案でだけ落ち、観測を取るために使い捨てscriptを書く
  ことになる。実際、このrepoの手書き宣言を道具で再生成したら、**同日追加した2件のtestが
  `affected_tests`から抜け落ちていた**——手書きは既に陳腐化していた。
- 観測できていないpathを空配列へ丸めない。複数pathを所有する宣言は、`affected_tests`が
  binding単位でexact比較される以上いまの契約で表現できないので**書けたことにしない**。
  明示unknownは書き手の欄なので道具が発明も削除もしない。

## 0.24.0 — 2026-07-27

- **再計画で解けていない競合を、非収束としてfail closedにするようにした。** 過去epochのconflictを
  再seedしないguardは在ったが、**新しく観測された同じ競合は毎epoch seedされる**ため、原因が続く限り
  「hold→再計画→再開→また同じ競合」が繰り返せた。epoch上限も無かった。誤帰属でも、scope違反を
  繰り返すworkerでも、変換で解けない競合でも同じことが起きる。
- 性質は**安全性ではなく進行性**である。誤って並列化することはなく常に止める側へ倒れるが、
  進まないまま同じ処置を試み続け、外からは「働いているが進んでいない」状態に見えた。
  請求項10は対象作業群だけを停止して再計画すると述べるが、その再計画が収束する保証は述べていない。
- 判定の鍵は種別・資源・関与task対で、`plan_epoch`で数えるので**同一epoch内の複数回観測は
  繰り返しと数えない**——再計画を1回挟んだ上で再び現れたことだけを繰り返しとする。既定の閾値は3。
- **直列化で誤魔化さない。** 誤帰属が原因なら直列化しても解けず、解けないことを解けたように
  見せることになる。解けていないことをtypedに述べて止める。

## 0.23.0 — 2026-07-27

- **worktree外への書き込みを、検査した範囲として記録するようにした**
  （[ADR 0140](docs/adr/0140-canonical-write-observation-is-recorded-not-assumed.md)）。
  実行時の観測はworktree内しか見ておらず、**実hostのprocessを駆動するmanaged supervisorだけは
  本repositoryの不変検査も無かった**。findingが空であることが「範囲外への書き込みが無かった」と
  読めてしまう状態だった。
- observation bindingが`canonical_root`とその指紋を**対で**渡した場合、観測時に取り直して
  一致しなければfail closedにする。対を要求するのは、片方だけを受けると照合せずに「検査した」と
  読める記録が作れるからである。渡されていなければ記録は`null`＝**未検査**であり、無変更の主張では
  ない。判定していないものを競合が無いと読ませない規律（ADR 0127）を、観測の空白へも適用した。
- 指紋はHEAD・作業ツリー状態（untracked／ignoredを含む）・全refを畳む。gitignore対象を見落とすと
  ignore経由で外から触れてしまう。

worktree外の一般的な書き込み（`/tmp`、home、ネットワーク）は引き続き観測できない。これは速度の
問題ではなく、checkpoint間隔を詰めても永久に見えない。塞ぐならI/O検知かprocess sandboxであり、
実dispatchの所有者はhostなので後者はhostの持ち物である。

## 0.22.0 — 2026-07-27

**実行時に観測した競合を、その場の変換で解消できるようになった。** これまでは事前宣言された
処置が競合pathを覆う場合だけ`seam_transform`レーンへ送り、無ければすべて意図的直列へ倒していた。

- 実行時競合のfindingから変換候補を導出し、隔離worktreeで五条件を通し、再計画が読む
  `lattice.runtime_seam_split.v1`を組む経路を足した。実git repository・実sensorで、
  workerが自分のscope外かつ他者のscope内へ書いた事実をdiff観測から検出し、変換して
  splitを組むところまでを1本で通している（[実行記録](docs/evidence/2026-07-27-xf-003-runtime-transform-loop.md)）。
- 静的側と実行時側で変換の芯を共有し、入力の口だけを分けた。実行時は提案artifactが無いので
  **観測したfindingそのものを出所として縛る**。所有面の名前は与えられなければ候補を作らない——
  製品が名前を発明しない線は実行時でも同じである。
- **実行時だからといって条件を緩めない。** 五条件のうち1つでも欠けたら意図的直列へ送り、欠けた
  条件を残す。緩めると外部挙動を変えうる変更が便益の証明なしに実行中のrunへ入る。
- **自分の隔離worktree内のcommitを許した**（[ADR 0139](docs/adr/0139-worktree-local-commit-is-permitted.md)）。
  commitを一律禁止していたため進行中の成果が未commitのままworktreeにしか存在せず、
  再計画がその変更を含まないsourceに対して行われていた。observerはHEADが`base`の子孫であることを
  確かめ、`base..HEAD`の範囲も観測へ入れる——**commit済みの変更は`git status`へ出ないので、
  範囲を加えないとcommitした瞬間に変更が観測から消える**。checkpoint diffへ`head_sha`を足し、
  生み出した木そのものを記録へ縛れるようにした。
- 隔離の保証は緩めていない。禁じる対象が「HEADが動くこと」から「HEADが`base`の子孫から外れること」
  （reset・branch切替・rebase）へ変わっただけである。

## 0.21.2 — 2026-07-27

- 変換適用時の再indexが、配布物内の自分自身でなく対象project配下の`bin/lattice.mjs`を
  起動しようとしていた。**Lattice自身のrepositoryでしか動かない**欠陥で、消費側projectでは
  `sensor_fresh`が必ず落ちる。実機smokeで見つけた。

## 0.21.1 — 2026-07-27

- 隔離runnerで、mountのために作った親ディレクトリがgit statusへ1エントリで報告されると
  変更として弾かれる欠陥を直した。親ごと除外すると中身に現れた別の変更まで隠れるので、
  展開して子を同じ規律で見る。`.lattice/`全体をgitignoreしているprojectで踏む。

## 0.21.0 — 2026-07-27

**Latticeが初めて、競合を提案でなく実際の変換で解消した。** これまでは「こう切れば競合が
消える」と提案するだけで、提案surfaceはディスク上に存在せず、artifact自身が
`hypothetical_new_surfaces`とラベルしていた。

- **記録済みseam提案を隔離worktreeで適用し、五条件で採否を決める入口**を足した
  （`lattice todo seam-proposal apply --plan <key>`、[ADR 0137](docs/adr/0137-real-transform-acceptance-contract.md)・
  [ADR 0138](docs/adr/0138-transform-acceptance-five-conditions.md)）。五条件は外部挙動同等性・
  focused test通過・再index・重複解消（**対象競合の消滅とplan全体の競合対が増えないこと**）・
  **実行段階数または最長経路の改善**。1つでも欠けたら棄却であり、欠けた条件を名指しする。
- **採用された変換を本ツリーへ着地させる入口**を足した（`seam-proposal land --plan <key> --names <file>`）。
  着地は記録された採用結果を信用せず、五条件をもう一度全部回してから書き込む。
  surface名は呼び出し側が与える——**名前を付けるのは判断なので製品が発明しない**。
- 適用可能な候補は**所有・共有・残余の三面**をすべて挙げる。宣言symbolを移すだけでは、
  誰も宣言していない依存先が宙に浮き、原fileと新fileが循環importになり、原pathに何が残るかが
  決まらない。依存は「所有→共有」「残余→所有」の一方向に固定し、共有面から所有面へ辺が入る
  候補は棄却する。
- 依存の推移閉包で、**calleeを照会していないsymbolを「calleeが無い」と同一視しない**ようにした。
  同一視すると閉包が黙って浅くなり、移動先で参照だけが宙に浮く——構文は通るので実行するまで
  壊れたと分からない。実データで踏んだ欠陥である。
- 隔離runnerが**mountを所有する**ようにした。verifierへ依存を渡す手段が無く、呼び出し側が
  symlinkを張るとallowed path外の変更として弾かれていた。gitignore対象も含めてsnapshotを取る
  規律は緩めず、runnerが自分で張ったentryだけを外す。`src`／`test`へのmountは拒否する。
- 計画段階の限界と、解決不能問題へ突入しない規律を規約へ書いた。静的側で完全な分断は
  原理的に得られず、埋め合わせは実行段階の境界検知が持つ。**二段構えが設計であって、
  静的側の不備ではない。**

**実測**（[実行記録](docs/evidence/2026-07-27-rt-005-closed-loop-accepted.md)・
[着地](docs/evidence/2026-07-27-rt-006-landed.md)・[競合消滅](docs/evidence/2026-07-27-rt-007-version-barrier.md)）:
このrepoの実conflictで`src/todo-gantt-html.mjs`（626行）が四面へ分かれ、五条件をすべて満たして
着地した。再indexして再compileすると**競合は1件から0件へ**、提案対象そのものが消えた。

## 0.20.1 — 2026-07-27

- 0.20.0で基底run request契約を`lattice.run_request.v2`へ上げたが、その名前は
  [ADR 0064](docs/adr/0064-runtime-hold-public-bridge.md)のepoch後継request——
  `predecessor_request_digest`と`task_migration_digest`を持つ別shape——が既に使っていた。
  同じ名前が2つの意味を持ち、どちらのvalidatorへ聞くかで通る形が変わる状態だったので、
  基底契約を`lattice.run_request.v3`へ改番した。
- 併せて、後継requestの本体検査をv1固定から基底契約へ向け直した。v1固定のままだと、
  創作境界を持つ宣言が再計画を跨げない。

## 0.20.0 — 2026-07-27

- **新規fileだけを作るToDoが並列可否の判定対象になった**
  （`owns[].creates`、[ADR 0136](docs/adr/0136-declared-creation-boundary.md)）。
  まだ存在しないpathの`owns`は`path_state: absent`という決定的な観測——索引の推測ではなく
  fsのlstat結果——を持ちながら判定対象外へ落ちており、新module・新doc・新test追加という
  実開発ToDoのかなりの割合が並列可否を持てなかった。実測では、同じfileを書く2 ToDoと
  新規fileを作る1 ToDoのplanが`conflict_count: 1 / unknown_count: 0`でcompileし、
  実conflictを保ったまま新規fileのToDoが並列グループへ入る。
- 観測から自動導出はしない。**宣言があるpathだけ**を裏付けありとして扱う。機械的に読むと
  pathのtypoが「必ず止まるエラー」から「黙って通る創作境界」へ変わるためで、宣言していない
  absent pathは従来どおり止まる。宣言と観測がずれる側も全部fail closedにした——既に在るpathへの
  創作宣言は`creates_path_present`、fs観測が証拠に無ければ`creates_unverified`。
- `lattice.todo_witness_set` v3・`lattice.run_request` v3・`lattice.boundary_manifest` v3へ
  版を上げた。差分は`owns[].creates`だけで、旧版はすべて読み口として受理する。既存の宣言・
  request・run storeは書き換えを要求されない。
- `BOOTSTRAP_OWNERSHIP_SEAM`の案内が、空seam fileの先行commitより先に`creates`宣言を挙げる
  ようになった。機械が止めた瞬間に最小の解決法から知らせる。

## 0.19.0 — 2026-07-27

- **判定が途中で止まった記録を、無関係な工程の「検証済み並列」として読まなくなった**。
  compileが`BOUNDARY_UNKNOWN`で止まるとpairwise verdictが1つも作られず記録の`conflicts`が
  空になるが、投影はその空をそのまま「ぶつかる記録が無い＝独立」と読んでいた。実測では、
  同じfileを書く2 ToDoが正しく直列と出ていた状態へ**新規fileを作るToDoを1件足すだけで**、
  競合が消えて2 ToDoが検証済み並列として提示され、案内も`independence_verified`を返していた。
  **判定が失われるだけでなく反転する**——不在を証拠へ読み替える、最も危険な向きの誤りである。
  記録全体がverdictを持たない時は、covered readyを全件`plan_verdicts_absent`として未検査へ落とす。
- 案内へ`independence_verdicts_absent`を足した。「干渉しない」ではなく「まだ判定していない」を
  述べ、次の一歩に`resolve_unknowns_then_recompile`を返す。
- ADR 0132のOpen questions 2〜4を再裁定した（[ADR 0135](docs/adr/0135-readjudicating-seam-proposal-open-questions.md)）。
  複数候補のv2は保留を維持しつつ発火条件を明文化、`verification` digestは同型問題を所有する
  実変換campaignへ移し、新規fileだけを作るToDoは判定対象にすると決めた——ただし自動導出でなく
  宣言とする。観測から機械的に創作境界と読むと、pathのtypoが「必ず止まるエラー」から
  「黙って通る創作境界」へ変わるためである。

## 0.18.0 — 2026-07-27

- **同名symbolの曖昧さをreceiptへ残し、宣言した資源で絞れる**ようにした
  （`lattice.seam_proposal.v2`の`candidate_paths`、[ADR 0134](docs/adr/0134-ambiguous-symbol-receipt-narrowed-by-declared-resource.md)）。
  これまでreceiptは`resolved_path`を単数しか持てず、同じ名前が複数fileにあると解決結果は
  `unknown`へ潰れていた。潰れた先に候補が残らないので、宣言の`within`で絞れば一意に決まる
  場合でも絞る材料が記録に無かった。`ambiguous`のreceiptは候補を2つ以上持ち単数pathを持たない、
  という排他を契約が強制する——決まった事実と決まらなかった事実を同じ形にしない。
- graph操作（`callers`／`callees`／`impact`）の曖昧さは従来どおり`unknown`へ潰す。展開の起点が
  一意でなければ観測の意味が定まらないためで、操作ごとに問いが違うから扱いも違う。
- **正直な宣言のまま`seam_candidate`が出るようになった**（[実行記録](docs/evidence/2026-07-27-honest-declaration-first-candidate.md)）。
  0.16.0の初回実行は、機械が解決できない1 symbolを宣言から落とした探りの宣言でしか候補が
  出なかった。宣言を実態からずらして候補を作るのは「宣言の誠実さが判定の上限」という前提を
  壊す行為なので、そこは限界として記録してあった。今回それが解けている。
- 旧`lattice.seam_proposal.v1`の記録は移行しない。independence記録とsensorから再生成できる
  host localの記録であり、古い記録は`recompile_seam_proposal_or_remove_stale_record`で落ちる。

## 0.17.0 — 2026-07-27

- **`concern_anchors`を宣言手順の単一正本へ載せた**（`lattice todo --help`）。0.16.0で欄を足したのに、
  宣言できる欄を挙げる唯一の面へ足していなかった。誰が書く欄か・何を書くか・並列可否の判定には
  写らないことの3つを述べる。ADR 0130の履行漏れの修理である。
- **束縛できなかったseam提案が、種別と次の一歩を述べるようになった**。これまで投影の`guidance`は
  記録の鮮度しか述べず、`concern_anchor_unresolved`や`semantic_owner_binding_missing`が載っていても
  「記録は現在と一致している」で終わっていた——**一番必要な瞬間に機械が黙る**状態だった。
  重なった時は直す対象が一意に決まる方（壊れた宣言）を、決まらない方（宣言が無い）より先に述べる。
- 投影の契約が、案内codeを規則正本へ引き直して照合するようになった。shapeだけを見ていた頃は、
  載っているunknownと噛み合わない案内でも通っていた。

## 0.16.0 — 2026-07-27

- **係争資源の中で自分が触るsymbolをToDoごとに宣言できる**ようにした
  （`lattice.todo_witness_set.v2`の`concern_anchors`、[ADR 0133](docs/adr/0133-concern-anchor-binding.md)）。
  これまで係争中のfileしか宣言していないToDoは固有anchorを持たず、切断候補を束縛できなかった。
  宣言は並列可否の**判定へ写らない**——判定入力へ合成する時点で落とすので、宣言が誤っていても
  conflictを作ることも消すこともできず、効くのは切断候補の束縛だけである。`concern_anchors`を
  持たない`lattice.todo_witness_set.v1`の宣言はそのまま受理する。
- 宣言symbolをsensorのexact一致・資源内包含・task間排他で検証し、破れた宣言は候補にせず
  kindの異なるtyped unknownで返すようにした。解決失敗・資源外・重複を潰さず区別する。
- **pathのconflictでは宣言そのものを切断候補にする**ようにした（`declared_partition`）。pathの競合には
  分割するcall graphが無いが、宣言は所有者ごとのsymbol分割そのものを与える。componentの全taskが
  同じpath内でsymbolを名指しした時だけ候補にし、片側の宣言から他方の担当を補完しない。
- これにより、このrepoの実conflictで**初めて`seam_candidate`が出た**（残余conflict 0、
  [実行記録](docs/evidence/2026-07-27-concern-declaration-first-candidate.md)）。同名symbolが複数fileに
  ある場合は名前だけで解決できず`concern_anchor_unresolved`で止まる限界も併せて記録している。

## 0.15.0 — 2026-07-26

- **切断候補をread-onlyで提案する面**を追加した（`lattice todo seam-proposal compile` と
  `lattice todo seam-proposal`、[ADR 0132](docs/adr/0132-seam-proposal-read-only-surface.md)）。
  これまでconflictは「symbol／path起因なら切断しうる」と分類するだけで、**どこで切るかの情報を
  製品は持っていなかった**。conflict componentを単位に、変更前後のsurfaceとその所有者、提案後の
  残余conflict、sensor証拠、未知を1つのversioned artifactへ記録する。生成はclean worktreeと
  実sensorを要求し、読み出しはsensorを引かない。
- **conflictが争っている実体を記録へ残す**ようにした（`lattice.todo_independence.v3`）。v2の
  conflictは`{task_ids, resource_id, kind}`だけで、`resource_id`は`own-path-<hash>`の合成IDだった。
  **どのsymbol・どのpathが衝突したのか復元できず**、提案生成の入力が存在しなかった。targetは
  conflictへ直書きせず`conflict_resources`辞書へ一度だけ持たせる（conflict最大4,096件×target最大
  4,096 byteに対し保存上限は1 MiB）。
- 既知の旧契約で書かれた独立性記録を`superseded`として再compileへ案内し、**壊れた記録とは区別する**
  ようにした。旧記録が残ったままでも工程表表示とsession-context案内は落ちない。planの改訂と契約の
  陳腐化に別の次の一歩を返す。
- 工程表へseam提案を表示するようにした。実データではほとんどのcomponentが「情報が足りない」に
  なるため、**なぜ提案できないか**（typed unknownのkindと対象ToDo）まで読める見せ方にした。
  争っている資源はhash IDでなくexact targetで出る。
- ToDoへの割り当てをcaller／callee／impactのedgeから導出しない規律を固定した。witnessのtask固有
  anchorが束縛できない場合は`unknown_requires_evidence`を返す。1候補の失敗を`intentional_serial`へ
  昇格させない——探索の不完備は「切れない」ではない。
- 公開契約が独立性artifactを`v1`と記載していたdriftを実装（`v3`）へ揃えた。

## 0.14.0 — 2026-07-26

- **session開始時の現在地を1プロセス・1回のstore読みで返す**入口を追加した
  （`lattice session-context --json`、[ADR 0131](docs/adr/0131-session-context-single-store-read.md)）。
  `lattice status`と`lattice todo status`は同じ`readTodoStore`を別プロセスで二重に払っており、
  hostのSessionStartは両方を呼ぶ。storeが育ったprojectでは実行枠（実測6秒）を超え、
  **現在地の案内が毎回捨てられていた**。実測でdotagents（store 9.7MB／218ファイル）が
  6.5秒から3.2秒へ落ちる。`status`フィールドは`project_status.v1`、`todo`フィールドは
  `todo_status_result.v4`をそのまま埋めるので、hostは既存の検証器を再利用できる。
  既存2面は不変で、これはその合成である。dashboard活動を登録しない読み取り専用面とした。
- **着手候補が無いときに「検証済み」と読める出力**を直した。ready集合が空だと未検査taskの一覧も
  空になり、「未検査が1件も無い」が空虚に真となって、記録が古くても検証済みと答えていた
  （0.13.0のsmokeで露見）。述べる対象が無いことを独立の案内codeにした。
- 独立性投影の消費者へexact key検証を要求しないことを公開契約へ明記した。
  知っているkeyだけを読んでよく、Latticeは既存keyの意味を変えるときだけschema版を上げる。

## 0.13.0 — 2026-07-26

依存線の不在は「順序制約が申告されていない」ことしか意味せず、書き込み境界が干渉しないことは
意味しない。この2つを区別できず、工程表の横並びと`dispatch_frontier`が無申告をそのまま並列可と
提示していた。並列作業可能性を判定・記録・伝達する面を新設した。

**この版から0.12線のpatch運用を離れminorを使う。** `lattice.todo_mutation_result`をv1からv2へ
置換しており、6つのmutationコマンド全部のwireが変わる。v1を読む既存hostは更新が必要になる。
0.12線では公開result schemaの置換をpatchで出していたが（`todo_gantt_artifact` v1→v2、
`bridge_cli_result` v1→v2）、今回は新しい公開CLI面3つと合わせて変更量が大きく、
patchのまま出すと利用側が破壊的変更に気づけない。

- **並列可能性の判定と記録**を追加した（[ADR 0127](docs/adr/0127-todo-independence-projection.md)）。
  `lattice todo independence compile --plan <key> --input <witness_set>`が、ToDoごとの宣言境界
  （`lattice.todo_witness_set.v1`）と実sensor観測から並列可否を判定し、plan versionディレクトリへ
  `lattice.todo_independence.v2`として記録する。`lattice todo independence [--plan <key>] --json`は
  ready frontierを検証済み並列グループ・要直列の組・未検査へ分けて返し、**参照時にsensorを引かない**。
  判定は`(plan_version, topology_digest, base_sha)`へ束縛し、dirty worktreeでは記録しない。
  記録はwitness setから再生成できるhost localの投影として扱い、git追跡するのは入力の宣言だけとする。
- **conflictの切断可能性**を分類するようにした（[ADR 0128](docs/adr/0128-todo-independence-operational-wiring.md)）。
  symbol／path起因の衝突は`code_seam`（コードの分割で並列化しうる）、state／effect共有は`serial`
  （分割では切り離せない）。判定の元になるresource kindはcompile時にartifactへ焼き込む——
  宣言由来のstate resource idは任意文字列で、後から復元できないため。
- **着手時に助言を返す**ようにした。`lattice todo start`の結果が`lattice.todo_mutation_result.v2`となり、
  `advisory`で進行中ToDoとの競合・切断可能性・未検査の内訳を機械可読で返す。従来のgateは
  active taskが1件も無い初回にしか発火せず、**すでに誰かが走っている状態での着手**——最も競合
  しやすい場面——が素通りだった。助言であって拒否ではなく、ready frontier dispatch契約は変えない。
- **記録の鮮度をtask単位の事実として扱う**ようにした。従来は宣言境界と無関係なcommitでも全taskの
  記録が一斉に失効し、運用が進むほど「常に未検査」へ漸近していた。`base_sha..HEAD`のdiffと宣言境界を
  突き合わせ、交差したtaskだけを未検査へ落とす。diffを確定できない場合（rebase等）は全taskを落とす。
- **plan改訂後の宣言移行**に`lattice todo independence witness migrate --plan <key>`を追加した。
  revisionのtask migrationでtask_idを写す。写像だけを担い、宣言内容が改訂後も妥当かは主張しない。
- **工程表で独立性を示す**ようにした（[ADR 0129](docs/adr/0129-gantt-independence-presentation.md)）。
  カード内のバッジ（∥ 独立検証済／⛓ 要直列／? 未検査）と右ペインの内訳。記録があるplanでは
  「ready frontierは全件同時dispatchが既定」という無条件の断定をやめる。カード寸法と配線には
  触れないのでADR 0068の非交差gateへ影響しない。conflictを線で描くのは配線モデルに定義が無いため
  行わない。renderer版数を`v17`へ上げた。live配信の更新検知へ独立性を混ぜ、再compileが画面へ届くようにした。
- **読み方を製品自身が配る**ようにした（[ADR 0130](docs/adr/0130-lattice-describes-its-own-parallelism-surface.md)）。
  状況から`{code, message, next_action}`を引く案内の単一正本を持ち、advisory・投影・CLI helpが
  そこから引く。MCP server instructionsへ「依存線の不在は独立の証拠ではない／判定はCLI面で読める」
  節を足した。MCPへtoolは足していない——案内は構造を変えないが、toolは構造を変えるため。
- 吸収前CodeGraphの残骸（`.codegraph/`）を掃除した。索引は`.lattice/sensor/`へ移っている。

## 0.12.34 — 2026-07-26

- 0.12.31〜0.12.33で入れた配線変更を文書へ追従させた。依存線がカードとカードの間を通ること、真下へ
  繋ぐ線が一直線であること、依存を持たないToDoのブロックが接続済みToDoの上に来ることを、
  [ADR 0068](docs/adr/0068-gantt-routes-run-between-the-columns.md)として確定し、公開契約と表示仕様へ反映した。
  ADR 0066 Decision 7（edgeを持つToDoを段の先頭行に残す）は、それ自体が誤読事故の機構だったため置き換えた。
- dashboard daemonの入れ替えを公開契約へ書いた。publishとinstallを終えた版が、古いdaemonの生存を理由に
  配信面へ届かないままになることを許さない。待ち時間を固定秒数で打ち切らないことと、その帰結
  （登録project数に比例して`lattice status`の応答が伸びる）をREADMEへ明記した。
- 実daemonを起動するtestの後片付け規律を`AGENTS.md`へ規約化し、取り残しを掃除する
  `scripts/reap-orphan-test-daemons.mjs`をREADMEの開発節から辿れるようにした。

## 0.12.33 — 2026-07-26

- 依存の線がカードの下を通って隠れ、別の依存として読める欠陥を修理した（2026-07-25の実被害
  `fm-0640`の真因）。依存を持たない独立ToDoは同じ段の接続済みカードの**下**の行へ折り返していたが、
  接続済みカードの取り付け線は段全体の下にある帯まで垂直に降りるため、同じ列に落ちた独立カードを
  貫いていた。隠れた線の残り半分が「その独立ToDoから出た矢印」に見え、存在しない工程順を伝えていた。
- 独立ToDoのブロックを接続済み行の**上**へ移した。独立ToDoは辺を持たない以上、入辺も持たないので
  必ず最初の段に入る。最初の段へは何も到着しないため、上に置けば貫く線が構造的に存在しなくなる。
  実測で貫通はdotagentsの実store（218辺）663→0、bingo（139辺）2→0。
- 全経路×全カードの矩形非交差testから既知欠陥の除外を外し、例外なしで固定した。

## 0.12.32 — 2026-07-26

- publish済みの新しいcodeへdashboard daemonを入れ替えられず、公開面が古いまま取り残される欠陥を修理した。
  daemonはdescriptorを書く前に登録済み全projectのstoreを読むため、起動時間はproject数とstore規模に
  比例する（実測: 8 projectで約51秒）。入れ替え側の待ち時間は4秒固定だったので、実機では必ず競り負け、
  `DASHBOARD_DAEMON_UNAVAILABLE`で失敗して古いdaemonが残り続けていた。install済みのcodeと配信中の
  codeが恒久的に食い違う。
- 待ち方を、固定秒数の見積りから「spawnした子が生きている間は待ち、死んだら即座に諦める」へ変えた。
  `startupTimeoutMs`は無反応な子に対するbackstopという位置付けに変え、既定を120秒へ広げた。
  死んだreplacementを猶予いっぱい待たないことと、遅い子を待ち切ることを回帰testで固定した。

## 0.12.31 — 2026-07-26

- 工程図で段を跳ぶ依存線が、図全体の右端の外にある回廊まで走ってから縦移動して戻る配線をやめた。
  隣り合うカード同士の1 hopが図の全幅を往復する線として描かれ、どの線がどこへ繋がるか追えなかった。
  カードは全段で同じ列グリッドに載るため列と列の間はどの段でもカードが無い。段跳びの縦移動を、
  両端のカードの間にある列境界のうち最も空いているものへ通す。ギャップ幅は通行量に応じて広げ、
  通行の無い境界は従来の24pxのままにする。右側回廊は撤去した。
  bingo実store（scope all・139辺）で総配線長 981,896→303,596、幅 7044→5988、
  カード右端より外へ出る線分 222→0。
- 真下の工程へ繋ぐ線が一直線にならず、12pxずれた2本の縦線と短い横棒に見えていた欠陥を修理した。
  同じ列の隣接段を繋ぐ辺は出発と到着が同じ取り付け位置集合を奪い合っていた。両端の縦線は帯の中で
  1点で接するだけなので、この形の辺には枠を1つだけ確保して双方が参照する。
- 全経路×全カードの矩形非交差を回帰testで固定した。併せて、線がカードに隠れる既知欠陥
  （`docs/ui-review-backlog.md`）の原因記録を実測で訂正した。真因は段跳び経路ではなく、
  カード下端から帯へ降りるport stubがwave 0の独立ToDoを貫くことだった。こちらは未消化。

## 0.12.30 — 2026-07-26

- 配布文書`docs/bridge-setup.md`へ、LANへbindせずloopbackだけをssh逆トンネルで公開する構成を追記した。
  reverse proxy hostへsshで到達できる場合、bridge hostのaddressはreverse proxyのどこにも現れなくなるため、
  lease変更への追従も自己登録も不要になる。sshdの`GatewayPorts`、Docker container から見たloopbackの
  別物性、host firewallのINPUT DROPという実測3条件を併記した。
- 設定例から実配備のLAN addressと公開hostnameを外し、例示値へ揃えた。

## 0.12.29 — 2026-07-26

- 稼働中のbridgeが、DHCPのlease変更で待受アドレスを失っても気付かない欠陥を修理した。
  待受アドレスの解決はbridge起動時にしか走らず、reconcileは設定のfingerprintだけを見ていたため、
  設定が変わらないまま生きたsocketが死んだアドレスへ取り残され、公開siteが502を返し続けていた。
  プロセスは健康なのでprocess supervisorは再起動せず、新しいbindingが生まれないので
  reverse proxyへの自己登録も走らなかった。
- reconcileの各passで実効アドレスを解決し直し、活きたbindingがその位置から外れた時だけ
  張り直すようにした。静穏時は同値になるため、bindingの作り直しも再登録も起きない。
- listen IPがDHCPで動く場合の再bind規則とregistrar配線を`docs/bridge-setup.md`へ記載した。

## 0.12.28 — 2026-07-26

- manifest v2 storeへsuccessor revisionを適用した時、memberの
  `active_revision_digest`がpredecessorを指したまま残り、直後のreadが
  `manifest_revision_binding_mismatch`で停止する欠陥を修理した。
- manifest v2への通常revision適用後に新revision digestへ追従することを回帰testで固定した。

## 0.12.27 — 2026-07-25

- manifest v2へhistorical importで新規planを追加する際、memberの`active_revision_digest`を
  plan digestへ結合するようにした。従来はdescriptorから必須fieldが欠落し、
  `lattice todo migrate`が`import activation manifest invalid`で停止していた。
- manifest v2 storeへの追加と再読込を回帰testで固定した。

## 0.12.20 — 2026-07-25

- 右ペイン「全工程」のplan並びを、動いているplanが上、完走したplanが下になるようにした。従来はstoreのmember順で並べていたため両者が混ざり、実storeでは9plan中ただ1つの稼働中planが4番目に埋もれていた。動いているplanは最終活動の新しい順、完走planは古い順で並べ、plan内のToDo順は登録順のまま保つ。
- gantt renderer versionを`v16`にした。

## 0.12.19 — 2026-07-25

- 右ペインtoolbarのラベルを「元Markdown全文」から「全工程一覧」へ直した。2026-07-19のUI意味訂正で中身はstore由来の全工程一覧と裁定されているのに、ラベルだけが旧意味を指し、元Markdown本文の再表示を期待させていた。
- 未使用のMarkdown描画を削除した。renderer v7で右ペインからnarrative documentが外れた際に描画処理だけが残り、以後どこからも読まれないまま、dashboardがstore変更のたびに実行して捨てていた。narrative自体はanchor検証に必要なので読み込みと集約prose上限は維持する。
- 到達不能になったsection単位の上限変換経路も削除した。集約上限`TODO_GANTT_PROSE_MAX_BYTES`は従来どおりfail closedで効く。
- gantt renderer versionを`v15`にした。

## 0.12.18 — 2026-07-25

- 工程図の表示規約を[ADR 0066](docs/adr/0066-gantt-live-scope-drops-finished-work.md)として正典化した。ADR 0053の折畳み前提を採らず、既定表示は完走した工程を図から除き代わりの箱も置かない、という現行実装の決定を根拠つきで記録する。
- 公開契約・README・design仕様・CLI helpを現行の表示規約へ揃えた。CLI helpの「完走した枝を畳む」はまとめnodeを置いていた時代の文言だったので「図から除く（一覧には残る）」へ直した。
- design仕様の右ペイン節を実装どおり（概要・選択工程・全工程の3面）に書き直し、toolbarの「元Markdown全文」boxが全工程一覧を開くというラベルと実体の不一致、および出力へ載らないMarkdown描画を未裁定として明示した。

## 0.12.17 — 2026-07-25

- 段間隔を段ごとの実需で決めるようにした。従来は図全体で最も混雑した配線帯の幅を全段へ一律適用しており、実storeでは第0段の下を通る52本のedgeが要求する636pxが、edge 1本しか通らない47段にもそのまま適用されて、段間隔704pxのうち箱は68px＝縦の90%が空白だった。
- 依存を持たないToDoを段の中で折り返して格子に並べるようにした。前提を持たないToDoは全て第0段へ入るため、依存宣言の少ないstoreでは数百件が横一列に並んでいた（実storeでは781件中567件が依存edgeを1本も持たない）。edgeを持つnodeは経路計算の前提を保つため段の先頭行に残す。
- 実測（dotagents全工程）: 幅 182656 → 14784px、高さ 36004 → 8028px。面積で1/55。
- gantt renderer versionを`v14`にした。

## 0.12.16 — 2026-07-25

- 図から外した工程の件数バッジを、そのまま展開の入口にした。押すと全工程を描いた図へ切り替わり、もう一度押すと戻る。展開図は同じページへ同梱する（生成物はfile://でも開くため、問い合わせ先のあるlive dashboardを前提にできない）。実storeで+1.2MB、render +40ms。外した工程が無い場合は同梱もbuttonも出さない。
- gantt renderer versionを`v13`にした。

## 0.12.15 — 2026-07-25

- 概要パネルの決着済みPhase（accepted・rejected）を閉じたdetailsへまとめ、進行中のPhaseだけを展開するようにした。従来は状態に関係なく全件を展開しており、実storeでは10件すべてが受理済み、つまり進行中が1つも無いのに縦を占領していた。
- gantt renderer versionを`v12`にした。

## 0.12.14 — 2026-07-25

- 完走した工程を図から外し、代わりのまとめnodeも置かないようにした。畳み込みnodeは1個につき1列を占めるため、完走したplanが9つあれば9列が履歴のためだけに残り、図が生きた工程の何倍もの幅に伸びていた。nodeを除くだけでは閉路が生まれないので、縮約に必要だった粒度探索・閉路検査・合成node生成をすべて削除した。
- 上部のlane見出し帯を、図が描いているlaneだけに絞った。全plan全laneのchipを並べていたため、実storeでは82個のchipがSVGを11764pxへ広げ、graph本体1644pxの7倍を空列で占めていた。chipの件数は従来どおり外す前の全ToDoを数える（描画node 606→14、lane chip 82→8、SVG幅 11764→1684px）。
- 外した工程の情報は凡例・右ペイン「全工程」・各工程の詳細が持つ。詳細の前提・後続は外す前の依存から表示する。
- gantt renderer versionを`v11`にした。

## 0.12.13 — 2026-07-25

- 完走した枝の畳み込み粒度をplan単位へ粗くした。連結成分で束ねる従来の粒度は、完了ToDoが互いに依存を宣言していないstoreでは1件1nodeへ空振りし、実storeでは767件が592個の畳み込みnodeになって箱の数がほぼ減らなかった。粗い順にplan、plan+kept段数、plan+waveを試し、縮約が非閉路になる最初の粒度を採る（767件 → 9node、描画node 606 → 23）。
- 畳み込みnodeをクリックで開けるようにした。従来は合成nodeに詳細パネルが無く、図のnodeも一覧の畳み込み済み工程も選択が無反応で、生成済みの詳細パネルへ到達する経路が存在しなかった。畳み込みnodeは構成工程を並べ、各工程からは代表している畳み込みnodeへ戻れる。
- 畳まれた工程の前提・後続を縮約前の依存から表示するようにした。従来はunit内部edgeが捨てられた後のグラフを読んでいたため、依存があるのに「登録済みの前提工程はありません」と表示していた。
- 古い版を配信し続けるdashboard daemonを自動で置換するようにした。daemonは起動時に読み込んだコードを配信し続けるため、新版をinstallしても公開面が古いままになる（実際に公開工程表が9時間前のrendererを返し続けた）。health payloadへ起動時の版数を載せ、`lattice status`が通るたびに版差を検知して入れ替える。
- gantt renderer versionを`v10`にした。

## 0.12.12 — 2026-07-25

- `bridge status`が到達性を報告するようにした。設定したlisten addressがホストに存在するか（`listen_state`）、実際に接続を受け付けるか（`reachable`）を別々に返す。従来は`enabled: true`とだけ答え、公開surfaceが落ちていても健全に見えていた。
- bridgeが同一subnet内の現アドレスへ自動で再bindするようにした。別network・loopbackは自動採用せず、代替が無ければ`BRIDGE_LISTEN_ADDRESS_ABSENT`でtypedに失敗する。
- 新しいbindingを張るたびにreverse proxy hostへupstreamを自己登録するようにした（`lattice bridge register`で手動実行も可能）。`ssh <host> <script> <port>`の固定形だけを実行し、アドレスは送らずremote側がssh送信元から決めるため、呼び出し側は自分自身しか登録できない。`LATTICE_BRIDGE_REGISTRAR_SSH_HOST`と`LATTICE_BRIDGE_REGISTRAR_SCRIPT`の両方が設定された時だけ動く。
- registrar設定をLaunchAgent plistへ引き継ぐようにした。launchdはshell環境を継承しないため、これが無いとdaemonの自己登録が永久に発火しない。

## 0.12.11 — 2026-07-25

- 依存工程図が既定で完走した枝を畳むようにした。生きた工程とその直接の前提工程は必ず展開したまま残し、全件を描くには `todo gantt --scope all` を使う。総数・lane集計・最長依存鎖・ready frontierは畳み込み前の全工程で数える。
- `todo gantt` artifact descriptorを`v2`にしてscopeを記録し、`todo gantt status`がscope違いの生成物を陳腐化と誤判定しないようにした。
- revisionでcarryされた完了時刻不明のimported ToDoへ`evidence promote`できるようにした。reopenと同じくplan_genesisのstate migrationへ束縛する。
- publish前検査がuntrackedファイルも拒否するようにした。従来はtrackedのdirtyしか見ておらず、未commitのファイルが公開tarballへ混入しうる状態だった。ignore済みは従来どおり対象外。

## 0.12.10 — 2026-07-25

- revisionでcarryされた完了ToDoを`todo reopen`できるようにした。後継journalにdoneイベントが無い場合でも、完了を運んだ`plan_genesis`のstate migrationへ束縛する。doneでないtaskのreopenは従来どおり拒否する。
- `todo status --json | head`のように結果を部分的に読んでも、未処理EPIPEでstack traceを出してexit 1になることをやめ、静かにexit 0で終えるようにした。EPIPE以外のstream errorは従来どおり失敗として落とす。

## 0.12.9 — 2026-07-25

- Phaseを持たない先行planからのcarryを、typed `REVISION_INVALID`で拒否するようにした。
- `phase_todo_revision.v1`/`v2`の適用でmanifestの`active_revision_digest`を追従させ、revision後にstoreを読めなくなる欠陥を直した。
- 新規plan authoringの入口の記述を実装どおりに書き直した。
- publish対象commitが既定ブランチの祖先であることを`prepublishOnly`の機械gateで強制するようにした。

## 0.12.8 — 2026-07-23

- Phase v3の後続revisionで、既存active sourceを同じ`source_cutover_batch`の明示操作により新しいarchiveへ移転できるようにした。
- cutover操作・旧ref/digest・移転先inventoryが一致しないsource消失は、従来どおり`predecessor_source_silently_dropped`で拒否する。

## 0.12.7 — 2026-07-23

- 巨大工程図のrender中にhealth応答が500msを超えても、生存中dashboardを死亡扱いして新daemonを孤児化しないようにした。
- dashboardはmanifest file identityが変わらない間のstable store readを再利用し、active projectの毎秒再読みと重複renderによるCPU・メモリの自己増幅を防いだ。
- public bridgeのloopback attestationはPID・port一致を維持したまま、正常なbusy health応答を待てる上限へ更新した。

## 0.12.4 — 2026-07-22

- `run abandon --reason`で日本語・空白・句読点を含む監査可能な説明を受理し、表示を偽装するUnicode制御文字・前後空白・256文字超過をCLIとmanaged control wireの共通validatorでmutation前に拒否するようにした。
- `BOUNDARY_UNKNOWN`へ元witnessを残し、fresh path不存在だけを`BOOTSTRAP_OWNERSHIP_SEAM`、既存path・symbol・未束縛ownershipを`ACQUIRE_OWNERSHIP_EVIDENCE`へ分けて安全な次手を機械可読化した。

## 0.12.3 — 2026-07-22

- activeな`phase_todo_revision.v1/v2`でも履歴上の有効source inventoryを解決し、`todo verify`がsource driftを検出して実件数を返すようにした。
- `phase_todo_revision.v3`適用時はinventory差分より先にpredecessor source実体を検証し、物理driftを`predecessor_source_silently_dropped`へ誤分類しないようにした。
- product suiteの並列数を4へ固定し、sensorのMCP初期化test cleanupへbounded retryを追加して、full gateの資源競合を安定化した。

## 0.12.2 — 2026-07-22

- unpublish済みの0.12.1と同一機能を、再利用可能な新versionとしてprivate registryへ再公開した。
- `publishConfig.access`を`restricted`へ固定し、以後のnpm publishが意図せずpublicへ戻らないようにした。

## 0.12.1 — 2026-07-22

- crash後にstale daemon descriptorだけが残ったbridge再構成を`not_running`へ収束させ、停止receipt timeoutで公開経路を復旧できない問題を修正した。
- actor環境のないsession開始時の`lattice status --json`でもactive projectをdashboardへ登録し、既存セッションのprojectが一覧から欠落する問題を修正した。
- 親環境の`FORCE_COLOR`がCLI JSON-only testへNode警告を混入させないよう、子process環境を明示的に隔離した。

## 0.12.0 — 2026-07-22

- actor付きの通常TODO activityからactive projectを自動登録し、一つのloopback dashboardでproject一覧、project固有工程図、SSE更新を提供するようにした。
- Ganttの依存線を専用channelへ直交routingし、box回避、join connector、交差bridgeを追加した。
- 明示IP bindとHost allowlistを持つopt-in network bridge、daemon自動復旧、reverse proxy向けの配備手順を追加した。
- managed runtimeに保存済み競合のfreeze、全running barrier、successor再compile、epoch再bindを追加し、AIShellの実fixtureで競合回収をend-to-end検証した。
- bundled sensorのaffected結果へ`Tests/`配下および`*Tests.swift`のSwift testを含め、既存の`e2e/`分類も維持した。

## 0.11.3 — 2026-07-21

- TODO mutationのactor解決失敗へrequired／missing／invalid環境キーと正規次操作を追加した。
- OS由来identityへのfallbackとstore変更は行わず、callerが設定不備を機械判定して同じ操作を再試行できるようにした。

## 0.11.2 — 2026-07-21

- bundled sensor失敗時にexit code、signal、bounded stderrを保持し、未初期化をtyped errorへ分類した。
- 未初期化syncへ同一pathの正規`lattice sensor init`次操作を返し、silent initやfallbackを追加せず根因を公開した。

## 0.11.1 — 2026-07-21

- 公開subcommandの`--help`／`help`入口を追加し、`todo reopen`等の正規optionをstore非依存で確認可能にした。
- namespace helpと同じclosed surfaceからusageを返し、未知subcommandは従来どおりusage違反で拒否する。

## 0.10.0 — 2026-07-21

- `todo status` v4へ全readyを同時dispatchする`dispatch_frontier`契約を追加した。
- readyが複数の最初の`todo start`に並列開始宣言または意図的直列化理由を必須化した。
- Ganttのready表示を「依存候補」から「同時dispatch推奨」へ更新した。
- Phase監査境界・監査回数・ToDo DAGは変更せず、Phase groupingによる暗黙直列化を再導入しない。

## 0.9.1 — 2026-07-21

- PhaseをToDoの直列化groupから重監査境界へ分離し、通常ToDoはDAGだけで並列readyを判定するv5契約へ更新した。
- Phase受理が本当に必要なToDoだけを閉じる`phase_accept_dependencies`と、v3 authoring schemaを追加した。
- fresh projectのtyped discoveryがv3 authoring schemaと生成commandを`next_action`で返すよう更新した。
- live GanttをSSEで自動更新し、静的Ganttのdigest付き`current / stale / missing`検証を維持した。
- runtime、project state、設定、環境変数、MCP tool名をLattice Sensorへ完全切替し、旧製品dataを入力・移行元・fallbackとして読まない契約を固定した。
- 新規AIShell cloneで48 files／797 nodes／2078 edgesを構築し、`DevelopmentRuntimeService`のdepth 3 impactが74 nodes／107 edgesになることを現行sensorだけで確認した。
- 製品testと退役済みartifact replayを分離し、公開判定が現行runtime surfaceだけを評価するようにした。

## 0.9.0 — 2026-07-21

- first-class Phase controlを追加し、ToDo完了時の軽量確認とPhase境界の重監査を分離した。
- `todo phase status/review/accept/reject/reopen`、Phase state migration、Decision evidenceを追加した。
- `todo revise-set` v3でPhase revision同士、およびPhase revisionと通常revisionのcross-plan atomic activationに対応した。
- `todo status/verify --json`の互換aliasを復旧し、cross-plan start/done/reopenの判定をmerged storeへ統一した。
- loopback-onlyのlive Ganttを追加し、静的Ganttには`current / stale / missing`を判定するdigest付きstatus面を追加した。
- bounded seamの隔離transform契約を追加し、許可locus外の変更をfail closedにした。
- 外部の旧上流runtime・旧cache/dataへの依存を廃止し、配布物内のLattice sensorだけを正式runtimeとした。
- Phase revisionの全6 durability境界と、通常／Phase混在revision setのcrash retryを検証した。

## 0.8.0 — 2026-07-20

- project-local run storeと`run list/resume/close/abandon`を正式化した。
- runtime/control timestampをcanonical UTC millisecondsへstrict化した。

## 0.7.3 — 2026-07-20

- private Lattice sensor runtimeを配布物へ固定し、公開`codegraph` binを除去した。

## 0.7.0 — 2026-07-20

- 旧上流由来実装をLattice所有sensorへ吸収し、公開入口を`lattice sensor`へ切り替えた。

## 0.6.4 — 2026-07-19

- `readTodoStore`のpinned source検証を1回のread内でcommit・blob単位にmemoizeし、同じsourceを持つhistorical import taskごとの重複`git cat-file`を除去した。
- 653 active tasks / 7 plansのdotagents実storeで`lattice todo status`を8.41秒から0.29秒へ短縮し、Claude/Codex SessionStart hookの内部5秒timeout内へ戻した。

## 0.6.3 — 2026-07-19

- source verifierで`0a. [x]`や`6A. [ ]`など数字＋英字付き番号のcheckboxを正規TODOとして認識するようにした。
- dotagents inventoryとLattice reviseのcheckbox認識を揃え、migrate後のanchor校正が`source_item_not_todo`で停止する不一致を解消した。

## 0.6.2 — 2026-07-19

- `carry_reconciled_metadata`を追加し、実行意味と依存を変えずにsource provenanceと親子関係だけを校正できるようにした。
- metadata校正時も既存task state・evidenceを保存し、title・lane・compile binding・dependency・join変更はfail closedで拒否する。

## 0.6.1 — 2026-07-19

- NPM pack前にsensorを必ずbuildし、gitignoreされた古い`dist`が公開物へ混入する経路を塞いだ。
- `0.6.0`の公開物でNode.js 26を誤って遮断した生成物を、source契約どおりNode.js 25だけを拒否する生成物へ更新した。

## 0.6.0 — 2026-07-19

- `lattice todo revise`で、active planを直接書き換えずsuccessor revisionを原子的に発行できるようにした。
- `lattice.todo_plan.v3`、`lattice.todo_event.v2`、
  `lattice.todo_revision.v1`を追加し、task stateのcarry・reset・removedを
  機械検証する。
- source inventoryとreconciliation digestをrevisionへ固定し、source drift、
  stale predecessor、異なるretry bytesをfail closedにした。
- `lattice todo status`と`lattice todo verify`へrevision・reconciliation状態を
  公開した。
- removed taskのpredecessor journalとevidenceを不変保存し、crash recoveryとexact retryを検証した。
- Node.js 26を正式サポートし、既知の非互換があるNode.js 25だけを拒否するようにした。

## 0.5.0 — 2026-07-18

- 依存工程図renderer v7と、active taskの未達依存を示すstatus v2を追加した。
