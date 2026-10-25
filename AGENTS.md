# AGENTS.md

Latticeで働く全AIエージェント共通のプロジェクト規約。上位のグローバル規約に加え、本書を優先する。

## 製品の役割

Latticeは、要求とcodebaseから並列開発可能なTODO graphを作るschedulability compilerである。
Lattice所有の内蔵sensorを構造sensorとして使い、TODO候補の境界競合を検出し、必要ならcode architectureへ
seam-refactorを施し、再解析後に全planを新versionへコンパイルする。

製品目標と優先順位は本repoの[PLAN.md](PLAN.md)と
[docs/00_product-contract.md](docs/00_product-contract.md)だけを正本とする。特許出願の表示は
[README.md](README.md)と[LICENSE](LICENSE)が持つ。外部repoや特定端末の絶対pathを、製品目標、
工程、診断、releaseの成立条件にしない。

- 製品思想の正本: [PLAN.md](PLAN.md)
- 公開契約: [docs/00_product-contract.md](docs/00_product-contract.md)
- 生きた工程状態: 本repoの`.lattice/todo/`。入口は`lattice status --json`と
  `lattice todo status --json`
- 不変Decision: `docs/adr/`
- 調査証拠: `rag/`。RAGはDecisionやTODOの正本ではない。

## 文書の寿命と単独運用

- 現行文書、進行中plan、履歴、証拠の地図は[docs/README.md](docs/README.md)を正とする。
- 完了、撤回、置換済みのplanは全文を`docs/archive/`へ移す。immutableなstore・ADR・証拠が旧pathを
  参照する場合だけ、旧pathに履歴stubを残す。stubとarchive本文を現行契約として読まない。
- 同じ意味の現行文書を増やさない。恒久契約は既存の製品契約、統合契約、設計仕様へ統合してから
  計画文書をarchiveへ移す。
- Latticeのsource、install、設定、state、schema、migration、診断、復旧、更新、releaseは
  このrepoだけを正本とする。dotagentsは任意の工場統合、host配線、互換性確認を統括するが、
  Latticeの制御者でも実行条件でもない。

## 先端研究の姿勢

- 前例不足、未実証、一般的な保守論、既知ingredientの存在、監査役の`worth_it`判断をblockerにしない。
- blockerを主張する側は、破られる要求／不変条件、因果経路、再現証拠、隔離やrollbackでも回避不能な理由、
  未充足条件を示す。立証できない懸念は実験仮説または観測項目へ落とし、開発を続ける。
- 監査findingとして採るのは、実コードで再現する欠陥、明白な論理破綻、一次資料の誤読、実験による反証、
  具体的な安全事故経路である。監査役に製品scopeを縮小する権限を与えない。
- Latticeをread-only推薦器で完了扱いしない。隔離worktree内の実変換、再index、再compileまで製品scopeである。

## TODO境界compile

- source変更TODOをdispatchableにする前に、Lattice sensorでowned symbol／path、caller／callee、impact、affected
  testを確認し、state／effect／dynamic unknownを補ったboundary manifestを作る。
- 調べた境界は会話で消費せず記録する。`.lattice/todo/witness/<plan_key>.json`へwitness setを宣言して
  `lattice todo independence compile --plan <key> --input <ref>`を通し、`lattice todo independence --plan <key>`で
  読む（ADR 0127）。読み出しはsensorを引かないので、参照のたびに調べ直さない。
  依存線が無いことを並列可の根拠にしない。未宣言taskと、宣言境界に触れるdiffで失効した記録は未検査として扱う。
- 着手時は`todo start`が返す`advisory`を読む（ADR 0128）。`conflicts_with_active`は進行中ToDoとの競合、
  `severability`は`code_seam`（分割で並列化しうる）か`serial`（共有状態ゆえ直列必須）かを示す。
  競合の同時起動は助言であり、どの ready を取るかは host が決める。記録があるのに対象工程が
  未宣言・失効なら`todo start`は`INDEPENDENCE_UNVERIFIED`で拒否する（ADR 0182）。
  `coverage`が`missing`の時は「競合なし」ではなく「まだ判定していない」。
  remaining A を witness に含めて compile する。現在の ready だけを compile すると次の frontier の start が止まる。
- plan revisionでtask_idが変わったら`lattice todo independence witness migrate --plan <key>`で宣言を写し、
  commitしてから再compileする。移行はid写像だけを行い、宣言内容が改訂後も妥当かは主張しない。
- 初回scaffoldだけはindexがまだ存在しないためbootstrap例外とする。bootstrap sourceを作った直後、
  初期環境commitより前に`lattice sensor init . --json`を実行し、以後のsource TODOへ例外を持ち越さない。
- sensor結果は構造証拠であり、semantic independenceやbehavior preservationの単独証明ではない。
- **計画段階で完全な分断は原理的に得られない。** 動的dispatch、実行時に決まるpath、reflection、
  外部状態は、宣言と構造観測をどこまで詰めても残る。埋め合わせは実行段階の境界検知が持つ——
  実際に変更された資源を観測し、宣言scopeの外への変更と、他の実行中作業のscopeとの重なりを
  実行時競合として捕まえる。二段構えが設計であって、静的側の不備ではない。
- **計画時は今ある材料の工夫で判断し、解決不能問題へ突入しない。** 判定の厳密さを上げる方向で
  次を追わない: 意味的同等性の証明、依存閉包の完全性の証明、動的dispatchの完全解決、
  unknownを無くすこと。どれも計画段階では決定不能であり、追えば製品が止まる。
  代わりに、持っている材料——宣言、構造観測、実行した検査、変換前後の再compile——を組み合わせて
  「今の材料で言えること」を述べ、言えない分はunknownとして残し、実行段階へ渡す。
- `lattice_sensor_status`のcomplete／pending changes 0だけで新規fileのindex収載を仮定しない。`lattice_sensor_files`でcoverageを照合し、
  欠落時は明示`lattice sensor sync . --json`後にsearch／caller／callee／impactを取り直す。
- sensorのsymbol lookupは、存在しない要求名を近い別symbolへfuzzy解決する場合がある。返却されたsymbol名とpathのexact一致を
  照合し、不一致をplanned symbolのcaller／callee／impact証拠へ使わない。不一致や空結果はunknown／absentとして記録する。
- conflictに切断可能なseamがあれば、直列化だけで済ませず、純並列便益を目的とするrefactorを候補化する。
- 係争資源しか宣言していないToDoは固有anchorを持たず束縛できない。その時はwitnessの`concern_anchors`へ
  「その資源の中で自分が触るsymbol」を実態のまま宣言する（ADR 0133）。宣言は並列可否の判定へ写らないので
  conflictを作ることも消すこともできず、効くのは切断候補の束縛だけである。機械が解決できないからと
  いって実際に触るsymbolを宣言から落とさない。落とせば宣言が実態からずれ、判定の前提が壊れる。
- active plan versionのtopologyを追記で変えない。code変換後は旧plan／旧agent context／途中patchを失効し、
  accepted artifactをpredecessorにした新versionへ全affected TODOを再コンパイルする。

## 実装と検証

- Node.js ESM。対応runtimeは `package.json` の `engines` を正本とし、Node 25.xとRealm寿命欠陥の影響版24.2〜24.21・26.0〜26.9を除く。runtime dependencyは必要性を説明して追加する。
- 外部挙動不変のrefactorと挙動修正を分ける。安全網を先に置き、失敗をfallbackで隠さない。
- `npm test`を局所／標準test、`npm run check`をsyntax／静的検査、`npm run ci`を完全gateの正規入口にする。
- 実Lattice sensor、実repo、隔離worktreeを使うintegration testはunit testと分け、未実行をgreenへ丸めない。
- **常駐processの生死を1枚のfileで持たない（ADR 0157）。** そのfileから漏れたprocessは二度と観測されず、
  生きたまま不死になる。2026-08-03に2度踏んだ——sensorのdaemon登録簿が掃除されず978件（うち死亡967件）、
  dashboardがdescriptorから外れた旧daemonを取り残して2重起動。直し方も同じで、pidごとの記録を
  process自身に書かせ、**全processが必ず通る一点**（登録または起動）で死んだ記録を掃除する。掃除を
  「人がコマンドを叩いた時」に置かない——誰も叩かないので永久に積み上がる。停止のsignalは、その場で
  再認証を通った相手だけへ送る（応答しないpidへ送ると、pid再利用で無関係のprocessを殺す）。
- **常駐設定へ実行体のpathを焼く時は`stableNodePath`を通す（ADR 0163）。** `process.execPath`は
  libuvがrealpath解決済みなので、そのまま焼くと版付き実体（homebrewのCellar、nvm-windowsの版
  ディレクトリ）が入り、版更新でその実体が消えた瞬間にsupervisorが起動できないprocessを回し続ける。
  エラー面が無いので、症状は「公開面から端末が消えた」だけになる（2026-08-08・2026-08-10に2度被弾）。
  新しいplatformの常駐面を足す時も同じ助走を通し、焼いた対象の実在は`lattice bridge status`の
  `persistence`が観測できる形にする。
- **macOS LaunchAgentのbootoutは`launchctl print`が113になるまで完了しない（ADR 0179）。**
  `bootout`のexit 0はunload受付だけである。labelが残ったまま`bootstrap`するとlaunchdは
  `5 Input/output error`を返す（0.58.3・0.58.4・0.60.6で同じ形）。socket停止確認だけでは足りない。
  Windows Startup folderへこの待ちを写さない。
- 実daemon・実processを起動するtestは、後片付けをtestごとに手書きせず共通のfixture helperへ焼き込む。
  停止対象はdescriptorのpidでなくargvがfixtureのtemp pathを指すprocessとし、SIGTERMからSIGKILLへ上げて
  死を確認してからfixtureを消し、最後に生き残りゼロをassertする。取り残しは機械を重くして、時間予算を
  見るtestを偽陽性で落とす。既に常駐している分は`node scripts/reap-orphan-test-daemons.mjs`で一覧し、
  `--reap`で停める（既定は一覧のみ、fixture不在のものだけが対象）。
- commitは独立revert可能な単位にし、並行作業中はpathspecを明示する。
- **Latticeの成果は利用面まで届ける。** 関連gateを通過した成果は、通常push、必要なSemVer version bump、
  public npm publish、global install、Lattice所有dashboard／bridgeの再起動、公開後smokeまでを一連の完遂として
  実施する。操作権限はその時点のオーナー依頼と実行環境が与える権限だけに従い、Lattice独自の承認区分や
  追加の許可条件を設けない。
- npm公開の正規入口は`gh workflow run publish.yml --repo kitepon/Lattice --ref main`とする。
  製品所有の`publish.yml`がGitHub提供runnerで検査・配布物の導入確認・OIDC公開を行う。
  通常のreleaseで端末から`npm publish`を実行して本人認証を求めない。
  npmの信頼設定を変更する場合だけ、所有者による初回認証が必要になり得る。
- 新しい工程群をLattice storeへ入れる時は`todo migrate`で新planを起こす。初期化済みprojectでは
  `can_create_plan`がfalseになり`plan create`は使えず、既存planへのtask追加はphase revision v3の
  full desired-state全置換（runtime task migration・source inventory・cutover batchの全整合）を要求するため、
  別campaignの追加には見合わない。散文はdocs/のplan Markdownが持ち、状態と依存はstoreだけが持つ。

## 所有境界

- Latticeはgoal decomposition、boundary manifest、conflict model、seam transformation、plan compile、
  version barrier、実験記録を所有する。
- **装置の境界にAIを含める。** Latticeを操作するのはAIであり、そのAIは装置の外に居るのではなく
  装置の一部である。したがってLatticeが供給するのは、AIが自分で作れないもの——構造観測、契約、
  検証、記録、版の境界——に限る。推定、判断、文章生成をLatticeの中へ実装しない。それは操作している
  AIが既に行っている。
- **AIが既にできることを、製品コードやサブエージェント呼び出しとして足さない。** 「装置がやる」形へ
  寄せようとして製品内からAIを呼ぶ設計は、AIが操作している場に同じ能力を二重化するだけである。
  設計が「ここでAIに出力させたい」へ向かったら、そこは既に満たされている面であり、要るのは
  能力ではなくAIの出力を受け止める契約と検証である。
- sensorはLatticeが所有し、配布物内の`./sensor/dist`からのみ起動する。PATH上の独立CLI、
  npx配布物、外部SDKへfallbackしない。MIT attributionは`./sensor/LICENSE`と
  `./sensor/NOTICE`で維持する。
- **抽出版のhealは片方向である。** 再抽出するのは自分より**古い**版で書かれた行だけで、
  新しい版で書かれた行には触らない。「版が違えば再抽出」にすると、upgrade前のコードを抱えた
  常駐processが揃えたindexを書き戻し続け、indexが永久に収束しない（2026-08-03に実際に起きた）。
  indexが収束しない時は`lattice sensor status`の`index.engineBehindIndexFiles`を見る——
  非ゼロなら、そのprocessがindexより古い。止めて現行buildで上げ直すのが直し方である。
- **抽出器は二重実装であり、native kernelはwasm側へ追従する（ADR 0154）。** 配布に載るのはwasm経路で、
  Rustのnative kernelは同じ結果を速く出すためだけに在る。node／edge／refのフィールド、新しいnode種別、
  新しい辺をTypeScript側へ足したら、同じ作業のうちにRust側へも足す。`kernel-tsjs-parity`が赤いまま
  他の作業を続けない——赤は「開発機の索引結果が配布物と違う」という意味である。揃える方向は常に
  native→wasmとし、TS側を削って一致させない。ABIを変える時は両側と`KERNEL_ABI_VERSION`を同時に動かす。
- **upstreamから貰えるものが増えたら取り込む（オーナー裁定 2026-08-03）。** 正本は
  `sensor/UPSTREAM.json`、追従は`npm run upstream:sync`（3-way merge・衝突後は解決→commit→
  `--mark-synced`）、検知は週次の`.github/workflows/upstream-check.yml`と`npm run upstream:check`が
  行い、新しいkernel言語・wasm extractorは名指しで報告される。kernelの新言語は「取り込み＋
  Lattice独自機能（extent・動的import等）の追従＋parity green」までが1単位の作業である。
  markerを進めずに同じrefへ`--apply`を再実行しない——解決済みtreeへ衝突マーカーが再注入される。
- **2つのtreeの構造差分は`lattice sensor diff`で取る（ADR 0156）。** 追従では対象refを
  worktreeへ出して`lattice sensor init`し、`lattice sensor diff . <worktree> --subtree-a sensor
  --map-b <upstream名>=<Lattice名> --json`で突き合わせる。手のgrepで数えない——node idは
  行番号を含むので、grepでもidでも行ズレが差分を埋める。突き合わせは行番号を含まない自然キーで
  行われ、行だけの移動は`moved`へ落ちる。`comparability.status`が`degraded`の時、その差分は
  codeの変化だけを意味しない（両側のextraction versionが違う）ので、先に`lattice sensor sync`で
  揃えてから読む。
- **licenseは二層である。** 製品本体は`PolyForm-Noncommercial-1.0.0`（非商用は無償、商用は
  別途許諾）で、`sensor/`はupstream由来のMITのまま。**`sensor/`のlicenseを書き換えない**——
  第三者コードは再ライセンスできず、帰属表示の保持義務がある。製品をOSI承認licenseへ
  変える提案をしない。特許を留保して商用を有償にする方針であり、OSIの定義は利用分野の
  制限を許さないので両立しない（特にApache-2.0は第3条で特許を明示許諾するため意図と逆行する）。
- dotagentsは工場としての導入、host配線、BugHub投影、製品間互換性、工場rollbackだけを所有する。
  Lattice自身の更新、診断、復旧、releaseは本repoが所有し、dotagentsを経由しなくても完結する。
  Latticeの研究思想をdotagentsの工場規則へ直接書き戻さない。
