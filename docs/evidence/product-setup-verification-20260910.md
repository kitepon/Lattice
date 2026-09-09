# 製品setupの検証記録

## 開始条件

元mainは4bd31beb、fetch後origin/mainは0baa3613。既存のlandingコード・試験・ADR差分を保持し、
origin/main起点の専用worktreeで実装した。既存hookのbaselineは52件成功。

## 所有境界と構造

setupの共通制御からAI別path、設定編集、stdio確認を呼び、製品hookは既存installerを再利用する。
sensor索引でrunSetupCli→configureHost→updateMcpConfigと、hostPathsの消費者が
setup／hooksに限られることを確認した。affected testはsetup CLI、setup MCP integration、既存hooks試験。
外部状態はAI設定file、hook receipt、子MCPプロセス。AI設定を書き換える他製品との同時導入は行わない。
別製品コード、工場工程、lattice-gantt hookは書込み対象外。

## 確認済み

- 設定アダプター：初回、再実行、更新、JSONコメント、TOML引用key・dotted key・inline table・
  multiline配列、BOM、他登録、利用者env・無効化・追加project引数の保持。
- 失敗契約：構文破損、重複key、非stdioの同名登録、接続失敗、同一AI setup競合。
- Windows分岐：4 AIのMCP登録を継続し、製品hookをtyped未対応で返す。これは模擬試験であり実機受入とは分離する。
- 実MCP：新しいsetupから初回・再実行・statusの3回、配布sensorのinitializeとtools/listを確認。
- 全文書gate：657件の製品Markdownと934リンク、配布物リンクを検査。READMEの公開npm案内も
  最新AGENTSのOIDC workflow入口に修正した。履歴・不変ADRの過去記述は書き換えない。
- CLI surface gate：setupとsetup statusを追加し70コマンドのhelpとCLI試験到達を確認。

## 工場から置換できる代行

工場ファイルは読み取り専用で確認した。setup-macos-factory.sh／setup-linux-common.shの
ensure_claude_mcp・ensure_codex_mcpによるlattice登録と3 hostの製品hooks install、
apply-grok-config.sh／apply-cursor-config.shのlattice登録、WindowsのEnsure-ClaudeMcp／
Ensure-CodexMcpとInvoke-LatticeHookInstallが今回の製品入口へ置換できる。
WindowsのHOST_PLATFORM_UNSUPPORTEDを警告で成功扱いにする代行は、setupの機能別partialを
そのまま報告する処理へ置換できる。codex-lattice-gantt-hook等の工程案内は維持する。

## 実機受入の現在地

Linux main-serverとWindows nativeにAiterm永続PTYでSSHログインし、公開registryから
`npm install -g @quolu/lattice@0.69.0 --registry https://registry.npmjs.org`を実行した。
WindowsはPowerShell 7.6.5／Node 24.19.0、LinuxはNode 24.14.1。
導入後に公開packageのCLIを実行し、空の設定と既存設定のコピーのそれぞれで初回・再実行・statusを確認。
MCPは実際にinitializeとtools/listへ応答し、既存コピーの他登録・利用者設定・工場hookは保持された。
これは実OS上の公開npm版による確認であり、共有AI設定本体へのsetup反映とは区別する。

| 実行環境 | Claude MCP／hook | Codex MCP／hook | Grok MCP／hook | Cursor MCP／hook |
| --- | --- | --- | --- | --- |
| Linux SSH・公開版 | 確認済み／確認済み | 確認済み／確認済み | 確認済み／typed未対応 | 確認済み／確認済み |
| Windows SSH・公開版 | 確認済み／typed未対応 | 確認済み／typed未対応 | 確認済み／typed未対応 | 確認済み／typed未対応 |
| Mac | ローカル試験のみ | ローカル試験のみ | ローカル試験のみ | ローカル試験のみ |
| WSL | 未実施 | 未実施 | 未実施 | 未実施 |

実機結果：[Linux](product-setup-linux-20260910.json)、[Windows](product-setup-windows-20260910.json)。
全機能がverifiedの場合だけexit 0とし、未対応を含む上記実機結果はpartial／exit 1を期待値として検査した。

Windows bridgeは導入後に`BRIDGE_PERSISTENCE_STATE_SPLIT`を検出。設定のtarバックアップ後、
正規の`lattice bridge reconfigure --json`で常駐設定を復旧した。再診断でinstalled、reachable=true、
runtime=running／0.69.0、drift=[]を確認した。ただしreconfigure自体は既存工程の
`BRIDGE_HUB_DELIVERY_UNCONFIRMED`で非0、その後もhub heartbeatのpartialが残る。
公開面全体の正常化を成功扱いにしない。Linux bridgeは未設定のため新規公開しなかった。

未完了条件：共有AI設定本体へのsetupは他製品との導入調整待ち。Macのlocalhost:22は接続拒否で
SSH先を照会中。WSL既存SSH先は2回タイムアウト。共有設定反映、Mac／WSLの公開版SSH導入、
既存hub配信の確認をローカル試験やCI成功へ置き換えない。

## 別ベンダー反証・公開gate

Grok 4.6 highのread-only反証を回収した。Latticeの一時HOME再現とGrok自身の実行を区別し、
Grok実CLIは反証役が実行していないことを追認した。

- 採用：`GROK_HOME`指定の無視。指定先へ登録する回帰試験が修正前に失敗し、修正後に成功。
- 採用：Grokの`disabled_mcp_servers`だけで無効化した登録をprobeする不一致。
  名前による無効化を保持し、setupとstatusの両方でprobe回数0を確認した。
- 根拠：[Grok公式設定契約](https://docs.x.ai/build/settings)と
  [公式MCPガイド](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md)。
- `npx -y @quolu/lattice`の引数連結は、実MCPが非0となる再現であり、fake probeによるverifiedを
  製品の成功扱いと解釈しない。この入力は複数binを持つ本packageの既存の有効なMCP起動を立証していない。
  実MCPの初期化・tool一覧を使った確認を受入の根拠とする。

最終完全gateは成功：製品1909成功・5skip、sensor2308成功・183skip。
native kernel未構築による既存skipを実行済みに数えない。Grok修正後のfocused試験は14件成功。
公開commitは`2a08f35cfa3ea1f681c398b510577b9d11ee8961`。mainへのfast-forward統合・push、
既定ブランチ祖先検査、release commit gate、
[公開workflow](https://github.com/kitepon/Lattice/actions/runs/34372020598)が成功した。
公開registryの0.69.0とdist.integrityを確認し、上記2端末へ公開npm版を導入した。
通常の[OS別CI](https://github.com/kitepon/Lattice/actions/runs/34371989024)は、確認時点で
macOS nativeとWindows nativeが成功、Linux nativeとWSL2はrunner待ちのqueuedだった。
このqueuedを実行成功へ丸めない。
