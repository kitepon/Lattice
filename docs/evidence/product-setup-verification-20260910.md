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

Linux main-serverとWindows nativeへのAiterm SSHログインを確認。WindowsはPowerShell 7.6.5。
公開版の導入はまだ行っていない。WSL既存SSH先は2回タイムアウト。このMacのlocalhost:22は
接続拒否であり、Mac向けSSH先はオーナーへ照会中。ローカル試験をSSH実機受入へ代用しない。
同時進行の他製品との共有AI設定導入調整も照会中。

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

修正前の完全gateは成功：製品1908成功・5skip、sensor2308成功・183skip。
native kernel未構築による既存skipを実行済みに数えない。Grok修正後のfocused試験は14件成功。
最終release gateと公開npm版の導入smokeは継続中。
