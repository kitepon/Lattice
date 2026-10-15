# 専用Windows fixture: ソース/期待結果/隔離手順（未実行）

通常Lattice inventoryへ追加しない。今回はWindows/CIで実行しない。下記は次工程が許可された場合だけ。
専用非管理者のjob-local新規directory、reviewed source/binary/hash固定、対象fixture以外のprocessへattachしない。別の無関係sentinel processを監視対象外として用意する検査も、将来の明示許可が要る。host-wide trace/設定変更へ自動拡張しない。既存job/nested jobは変更しない。

helperの引数は固定case/order/output絶対path/fixture絶対path/mode。fixture build/runをproduct runとして扱わない。出力fileはmodeごとの新規path、stdout/stderrは既存pipe。cleanupはそのdirectoryとown jobだけ。失敗時も同modeを無根拠に反復せず原本とpartialを残す。

|fixture mode|期待結果（現在のstackは常にunavailable）|
|---|---|
|normal|status0、stdout/stderr固定byte一致、root loader1回処理、fault無し|
|exit1|status1全32bit、fault無し|
|exit-av|status0xC0000005全32bit、faultObserved=false（例外とexit値を分離）|
|read/write/execute|second-chance AV、access0/1/8、faultIP/module、status0xC0000005。executeはanonymous/non-executable targetのためmodule欠測を許容してpartial|
|handled|first-chance AVをNOT_HANDLEDでSEHへ渡す。status0、fault無し|
|thread|初期thread以外のAV。対応するprivate duplicate context取得。root/子プロセス数は増えない|
|child|childのloaderも独立判定、child AVを記録、outerの同exit値転送と区別、全child終了|
|child-delay|outer0の後にもchildが250ms存続。outer EXITだけでhelperが完了しない。両EXIT/pipeEOFまで待つ|
|breakpoint|loader以外のDebugBreakをNOT_HANDLED。second-chance breakpointをAVへ数えない|

まだ専用sourceが必要な負例/検査: args空/空白/quote/連続末尾backslash・cwd/env完全一致（固定heap項目だけ差）、nested job成立/assign拒否、collector死亡/親timeout、job/output handle非継承、stdio alias/pipeEOF、writer失敗、debug API failure、process/thread/module上限、GetThreadContext失敗、loader ntDll hFile無し/未知address、non-Node descendant fault、stack symbol探索canary、sentinel秘密不出力。portable policy検査はその一部の状態遷移だけで、実APIの証明ではない。

専用fixtureのsourceは任意argv/envを出力しない。stdout/stderrはnormal modeの固定文だけ。dump/stack bytes/署名/URL等は無し。通常caseのtimeout/skip/root/docs先行順/標準pool4forkには触らない。
