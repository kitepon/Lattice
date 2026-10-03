# ADR 0194: runtime error storeをWindowsでも本人だけが触れる形で置く

- Status: accepted
- Date: 2026-10-03
- Supersedes: [ADR 0193](0193-product-owned-runtime-error-reporting.md) の Decision 9
  （Windowsは収集に対応しない）と、`src/runtime-errors.mjs`冒頭の「POSIX専用」

## Context

runtime error storeは、本人だけが触れる形でしか使わない。POSIXではフォルダが0700、fileが0600、所有者が
本人であることを確かめ、確かめられなければ`store_unsafe`で止める。Windowsにはmodeもuidも無く、
確かめる方法を持たなかったので、Windowsでは記録を1件も作らなかった（0.73.0からは`unsupported`と答える）。
オーナーの端末にはWindowsが1台あり、そこで起きたLatticeの故障は誰にも届かなかった。オーナーはこれを
残っている不具合として扱うと裁定した。

Windowsで権限を表すのはDACL（誰に何を許すかの一覧）である。実機（Windows 11）で確かめたこと:

- `icacls <path> /save <file>`は、DACLをSDDLで書き出す。SDDLは表示言語に依らない。
  `icacls <path>`の画面表示は、accountの名前が表示言語で変わる。
- `whoami /user /fo csv /nh`は、自分のSIDを返す。
- 既定の`%LOCALAPPDATA%`の下に作ったフォルダは、親の権限を継ぐ。確かめた端末では、親が別のローカル
  accountへ読み取りを継承で許していた。置くだけでは本人だけにならない。
- フォルダの継承を切って本人・SYSTEM・Administratorsだけに絞ると、中に作るfileは同じ権限を引き継ぎ、
  renameで置き換えた後も保たれる。後から他のaccountへ権限を足すと、SDDLに現れる。
- どちらのcommandも20ms前後で返る。PowerShellの`Get-Acl`は400ms前後かかり、起動のしかたによっては失敗した。

## Decision

1. Windowsを収集の対象にする。`diagnostics.collection`は、Windowsでも設定に従って`enabled`か`disabled`を
   返す。`unsupported`は、storeを本人だけに絞る方法を持たないOS（macOS・Linux・Windows以外）の答えとして残す。
2. Windowsの「本人だけ」は、**DACLが本人・SYSTEM・Administratorsへの許可だけで出来ていること**とする。
   SYSTEMとAdministratorsは、その端末のどのfileも読める立場なので、数に入れる。拒否・条件つき・object用の
   ACE、DACLの無い形、SDDLとして読めない出力は、意味を確かめずにすべて通さない。
3. DACLは`icacls /save`で、自分のSIDは`whoami /user`で読む。どちらも`%SystemRoot%\System32`の実物を
   絶対pathで呼ぶ。`icacls`はfileへしか書き出せないので、出力はstoreのフォルダへ置いてすぐ消す。
   他のaccountが書ける場所（利用者の一時フォルダ等）へは置かない。
4. storeは`%LOCALAPPDATA%\Lattice\runtime-errors\`という専用のフォルダへ置く。`%LOCALAPPDATA%\Lattice`には
   他の機能のfileがあり、フォルダごと絞れない。
   - フォルダは、継承を切り、本人・SYSTEM・Administratorsだけに絞る。空のフォルダ（作った直後）を絞る時は、
     所有者も本人にする。
   - 他のaccountが触れる形なのに中身があるフォルダは、絞らずに`store_unsafe`で止める。中身を信用できない。
   - 絞った後に、誰かがフォルダやfileへ権限を足した時も`store_unsafe`で止める。Latticeは足された権限を消さない。
   - 確認は、POSIXと同じく読む時と書く時の毎回行う。
5. 設定は`%LOCALAPPDATA%\Lattice\runtime-error-reporting.json`、合鍵はBugHubの契約どおり
   `%LOCALAPPDATA%\bughub\product-credentials\lattice.json`から読む。`XDG_CONFIG_HOME`・`XDG_STATE_HOME`を
   明示した時は、どのOSでもそちらを使う。
6. 合鍵のfileも同じ判定で確かめる。他のaccountが読める形なら`credential_unsafe`（理由`acl_not_owner_only`）、
   確かめる場所（storeのフォルダ）を用意できなければ理由`acl_unverifiable`を返す。合鍵のフォルダへは何も書かない。
7. Windowsで収集を有効にするのは、Lattice自身の送信設定（`runtime-errors reporting enable`）である。
   工場の設定は`${XDG_CONFIG_HOME:-~/.config}/dotagents/factory-reporter.json`だけを読み、dotagentsが
   Windowsで使う置き場（`%LOCALAPPDATA%\dotagents\factory-reporter\config.json`）は読まない。
   エラーを上げるのは製品の責務（ADR 0193）なので、工場の設定への依存を新しく足さない。
8. 自動送信の判定は、送るものがあるかを先に見て、合鍵は最後に確かめる。Windowsでは合鍵の確認が
   外のprogramを起こすので、送るものが無い時のCLI実行に載せない。

## Consequences

- **所有者は確かめない。** `icacls`は所有者を返さない。所有者は、DACLが本人だけでも、後から自分へ権限を
  足せる。これが効くのは、別のaccountが`%LOCALAPPDATA%\Lattice`へ書けて、storeのフォルダを先に作れる
  端末だけである。そういう端末では、同じaccountがその利用者のprogramを差し替えられるので、所有者を
  確かめても守れるものが増えない。足された権限は、次の確認で`store_unsafe`になる。
- storeのfileが在る端末では、送信を有効にしている間、送るものが無い時でもCLIの実行ごとに`icacls`が2回と
  `whoami`が1回走る（確かめた端末で合わせて50ms前後）。故障を1件も記録していない端末では走らない。
- `icacls`か`whoami`が無い・失敗する端末では`store_unsafe`になり、記録を作らない。`diagnostics`は
  `status: unavailable`を返す。本人のSIDがSDDLで別名（組み込みのAdministratorの`LA`等）で書かれる
  accountも、本人と見分けられないので同じ扱いになる。
- 0.73.0で`unsupported`を返していたWindowsの端末は、送信を有効にするまで`disabled`を返す。
  受け側（dotagents）は3値とも受ける。
- 「CLIが契約の外で落ちると記録される」試験は、Windowsでは走らない。試験が使う入力（`.lattice`がfile）は、
  Windowsでは`lstat`がENOENTを返し、契約内のerrorで返る。記録・置き場・権限は、Windowsの実機の試験が確かめる。

## Acceptance

Windowsの実機（CIの`windows-native`）で確かめる。

- 他のaccountへ継承で読み取りを許すフォルダの下で記録すると、storeのフォルダは継承を切られ、
  フォルダもfileも本人・SYSTEM・Administratorsだけになる。記録は読め、置き換えの後も権限が保たれる。
- storeのfileかフォルダへ他のaccountの権限を足すと、読むのも書くのも`store_unsafe`で止まる。
- 親の権限を継いだままの空のフォルダは絞って使い、中身のあるものは使わない。
- 合鍵へ他のaccountの読み取りを足すと`credential_unsafe`（`acl_not_owner_only`）になり、送らない。
- 既定の置き場（`%LOCALAPPDATA%`）で、CLIから送信を有効にし、記録を読み、解決にできる。
- 送信を有効にした端末で記録が出来ると、次のCLI実行の後に子processが届け、ackが進む。
- SDDLの判定は、どのOSでも走る試験で固定する（`test/windows-owner-only.test.mjs`）。
