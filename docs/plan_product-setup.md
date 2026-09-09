# 製品所有のAI導入入口

## 依頼と境界

MCP登録と製品sensor hookの準備・読戻しを一回の製品入口にまとめる。変更先はLattice repoと
製品が所有する導入設定に限る。dotagentsのlattice-gantt hook、別製品、既存Lattice工程は変更しない。
Windows hookの全面移植は対象外とし、機能単位のtyped未対応を返し、対応MCPの導入を継続する。

## 実装と受入

既存hooks installerを再利用し、共通の導入制御とOS／AI別の設定アダプターを分離する。
Claude・Codex・Grok・CursorのMCPと、既存対応hookを維持する。初回、再実行、公開版更新で
利用者設定と他登録を保持し、登録読戻しとMCP実接続を確認する。

1. fetch、dirty、製品正典、既存配線、focused baselineを確認する。
2. setup／診断、機能別結果、設定保存を実装しfocused試験を通す。
3. 別ベンダー反証、全ドキュメント点検、関連gate、製品release gateを通す。
4. main統合、commit・push、製品publish workflow、公開npm版の導入・実機smokeを行う。

受入が連鎖し別ベンダー裁定証拠を必要とするため統括レーンとする。公開契約・設定保存・公開操作は
親が担当する。実装は同一設定を扱うため単独writerとし、反証はread-only別ベンダーへ委譲する。
Lattice plan管理は今回導入しない。本書が本campaignの計画正本である。

## 既知の条件と検証

開始時HEADは4bd31beb、fetch後origin/mainは0baa3613。元worktreeのbridge-hub-landingの
コード・試験とbrand-landing-refresh ADRは既存dirtyとして保持する。専用worktreeはorigin/main起点。
既存hook試験52件が成功。hookはPOSIXのClaude・Codex・Cursor対応、Windowsは
HOST_PLATFORM_UNSUPPORTED。Grokの製品hookは未実装でありMCPとは独立して扱う。

実端末への導入はAiterm永続PTYからSSHログインし、そのセッションで公式npm install、setup、
実動作確認を行う。WindowsはPowerShell 7 native。共有AI設定への導入は端末ごとに直列実行する。
失敗は成功へ丸めず、未実施は実機一覧に残す。公開はmain上のcommitに限定する。

## 現在地

0.69.0をmainへ統合して公開済み。Linux／Windowsの公開版導入と隔離設定での実機smokeは成功。
共有AI設定への反映は他製品との調整待ち、Mac／WSLのSSH導入は接続条件待ち。
Windows bridgeの常駐復旧は確認したが既存hub配信はpartialが残る。
実測と未完了条件は[検証記録](evidence/product-setup-verification-20260910.md)に記載する。
