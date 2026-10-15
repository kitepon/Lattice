# SEC002 helper実装準備（Windows未実行）

2026-10-16。所有者・保存先は OWNERSHIP.md。元設計は自席 docs/factory-runner-user/2026-10-15/av-fault-candidate/proposal.md。

## 現在の範囲と未了

今回のsourceは独立したhelper候補と専用fixture、build recipe。製品hook/callerは変更しない。元2case/orderだけを入口で受け、DEBUG_PROCESSの子孫を追う。Windows compiler/SDKが手元に無く、helper/fixtureのWin32 compile・PE/import検査・実行は未了。binaryは無い。Linux検査はportable policyと静的source契約だけ。

**stack実装は未了。** 現sourceはfault exception/IP/アクセス区分/module identity/CodeView GUID+ageとcontext取得の成否まで。SymInitialize/SymLoadModule/StackWalkを一切呼ばず、stackAvailable=false/stackComplete=false/frames=[]/stackStop=not_implementedを必ず記録する。32frameは将来の上限で、現在32frameが得られるとは主張しない。元設計のsymbol handlerを使うunwind経路は、安全境界の確認まで候補codeへ有効化しない。したがって本候補はdispatch用完成品ではない。

## loader breakpointの固定規則

PIDごとにCREATE_PROCESSでfirstException=true/loaderSeen=falseと初期TIDを保存する。次を全て満たす場合だけDBG_CONTINUEする。

1. そのPIDでCREATE_PROCESS後に受け取った最初の例外。
2. first-chance EXCEPTION_BREAKPOINT。
3. event TIDがCREATE_PROCESSの初期TIDと一致。
4. ExceptionAddressが、LOAD_DLL hFileから確認したSystem32のntdll.dllと完全path一致するAMD64 PEのexecutable section内。
5. 停止中ReadProcessMemoryで該当addressの1byteが0xCC。

pathは同定の内部処理だけで、出力しない。実ファイルpathはGetFinalPathNameByHandleのDOS形式で比較する。取得不能/ntdll hFile無し/一致しない/先に別例外ならNOT_HANDLED、coverage=false、以後loader扱いへ緩めない。再exec子ごとに独立した状態を持つ。2回目以降のbreakpointは常にNOT_HANDLED。これはloader startup条件を絞る規則で、Windows fixture未確認。将来OS/Nodeで条件を満たさなければunavailable/partialとして止め、任意breakpointを握りつぶして通さない。

first-chance AV/その他例外もNOT_HANDLED。second-chance AVは記録後もNOT_HANDLED。CREATE/EXIT/LOAD/UNLOAD/DEBUG_STRINGはCONTINUE（文字列は読まない）、RIPはcoverage=falseでCONTINUE。単にExitProcess(0xC0000005)した場合はfaultObserved=false。

## symbol探索の安全境界

[Microsoft SymSetOptions](https://learn.microsoft.com/en-us/windows/win32/api/dbghelp/nf-dbghelp-symsetoptions)で適用範囲を確認した。

|設定|提供する限定効果と不足|
|---|---|
|IGNORE_CVREC|CodeViewのPDB pathを無視。全探索の禁止ではない|
|IGNORE_IMAGEDIR|image directoryを無視。DbgHelp 6.1以前非対応|
|NO_IMAGE_SEARCH|module header読取不能時のimage searchを止める。全ファイル探索の禁止ではない|
|IGNORE_NT_SYMPATH|無効search path時の_NT_SYMBOL_PATH fallbackを止める。別経路も検討が要る|
|DISABLE_SYMSRV_AUTODETECT|store自動検出を止める。6.6以前非対応|
|SECURE/NO_PROMPTS|SymSrv限定/対話抑制。ネットワーク禁止ではない|

将来symbol sessionを実装するなら、System32限定DbgHelpロード、専用の空local directoryを明示したSymInitialize(...,FALSE)、必要flagの設定/readback、明示module登録、serialized callbackを一組にする。flagのechoだけでは版の支持や内部探索停止の証明にしない。不支持/版不明/空専用path不能/callback不能/禁止探索が検出された場合はstack unavailableとし、ambient/server fallbackを行わない。

callbackの通知は全ファイル/networkアクセスを遮断するfirewallではない。CBA_*通知を許可fieldへ畳み、deferred symbol loadの取消可否をAPI仕様通り実装しても、観測されない内部探索まで禁止したとは言えない。現段階ではcallback未実装・symbol session未開始を安全側の決定とした。

必要な将来の隔離fixtureは、埋込PDB path/image dir/_NT_SYMBOL_PATH/_NT_ALTERNATE_SYMBOL_PATHに別々の秘密sentinel/canaryを置き、未許可pathへのopen/接続が0であることを確認する。OSのfile/network観測が別途許可されなければ境界成立の証明は不足するため有効化しない。存在する空pathだけの正例を、禁止pathの負例の代用にしない。次段階でsymbol handlerを使わず自前function-table/module/read callbacksだけを渡す案を検討する余地はあるが、今回は独自unwinderを追加せず未了として残す。

[StackWalk64](https://learn.microsoft.com/en-us/windows/win32/api/dbghelp/nf-dbghelp-stackwalk64)のcallbackとCONTEXT copy/初期PC/SP/FP、JIT tableの欠測は今後の実装検査項目であり、このsourceでは通過していない。

## lifecycle/所有と原本

CreateProcess/Wait/Continue/DebugSetProcessKillOnExitは同じwmain thread。rootをDEBUG_PROCESS|CREATE_SUSPENDEDで作り、専用KILL_ON_JOB_CLOSE jobへassignし、kill-on-debugger-exitをFALSEにしてからresumeする。assign等が失敗したら未開始の自分のrootを終了させる。BREAKAWAY flag/追加resource limit/SeDebugPrivilege/他job変更は無い。nested job失敗を迂回しない。

raw event hProcess/hThreadはOS所有でEXITのContinue後にOSがcloseする。helperが使う分だけDuplicateHandleしてPID/TID表で一度close。hFile、PROCESS_INFORMATION handle、stdioのdupと元のpipe copy、Job/outputは自前所有。Job/output/metadata handleは非継承、STARTUPINFOEX handle listはstdio3本だけ。外側EXIT後もdescendant EXITを待ち、helper自身のstdio copyをlaunch直後に閉じ、pipeEOFを妨げない。WaitForDebugEventは500ms単位で待つが通常targetの待ち上限を追加せず、元execFileSync/親jobのbudgetを維持する。終了後のhandle/job accountingと失敗drainだけ5秒の後始末budgetを持ち、未完了はdrainTimedOut/remainingActiveProcesses/cleanupForcedを記録する。EXIT Continue直後のaccounting競合はprocess handleのsignaledを待ってから確認する。loader/handle alias/parent timeout/collector crashの実機検査は未了。

例外/loop失敗時は自分のjobだけを終了させ、cleanupForced=true/incompleteを記録する。RAIIによるcollector死亡時も専用jobのcloseでtreeだけをreapする設計。API自体の失敗やhard kill時の原本欠測はあり、cleanup完了を無条件に保証しない。親/無関係PIDへのattachやkillは無い。

JSONはCREATE_NEW（既存fileがあれば起動前に125で止め、上書きもNode起動もしない。呼出しごとに別名を用意する）、64KiB/callまで。case/order単位の2pathで最大128KiB。schemaはsec002-av-capture-v1-metadata-only。最初にlaunch_pending、fault時にfault_pending_exit、最後にfinished/incompleteを書き、途中kill/切断/空/欠測を完了としない。fault/coverage/metadata/stackは別判定。finishedはdebug lifecycleの完了だけでstack成功ではない。原Nodeの32bit終了値はExitProcessへ渡すが、outer終了を観測できた場合は観測不完全でもその値を保ち、125はouter終了を観測できなかった場合だけ。Error object identity/heap実状態/元の再現性一致は主張しない。

固定schema以外を出さない。path/argv/env/body/source/PDB path/debug string/stack bytes/register bodyは保存しない。未知module名はhashへ畳む。fault IPがmodule表に無いだけではanonymousと決めない。VirtualQueryExで対象fault processの当該addressだけを確認し、anonymous-private/mapped-image/mapped-nonimage/uncommitted/unknownの固定enumへ分ける。WASM/V8の同定ではない。module同定のためevent hFile pathを内部で読み、RSDSは24byte（署名+GUID+age）のみ読む。OS TIDとNode worker_threads IDは同一視しない。

## build不足と再現可能性

現席はLinux g++のみでWindows SDK/header/cross compiler無し。build-msvc.ps1は将来許可された環境の固定recipeであり、まだ実行されていない。SDK10.0.26100.0、x64 MSVC、compiler/linker/dumpbinの完全pathとSHA256を必須inputにする。未確定のcompiler/SDK内容hashは不足であり、このrecipeだけで同一binaryの再現を保証しない。新SDK導入・remote probe無し。build記録にtool hash、SDK/include/lib manifest、完全command、source SHA、PE/import/architecture/hashを残す工程が必要。

build recipeはtoolset14.44系・compiler/linker/dumpbin hashとSDK/include/lib全fileの相対path/hash manifestを必須にする。/W4 /WXの警告は失敗として残し、自動緩和しない。期待importはKERNEL32.dllだけで、DbgHelp/SymSrv/network DLLは無い。実際のMSVC static CRTが追加importを作れば静的検査で要再reviewとし、未知DLLを自動許可しない。

必要検査は fixtures/EXPECTED.md と checks/ の局所記録に分ける。read-only実装reviewは設計reviewとは別。Windows fixtureは未実行。製品source/callerへの反映と追加CIは、準備完了後も別の明示指示が必要。
