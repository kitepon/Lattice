# CI契約

Latticeの工場CIが検証する実行環境は、macOS native、Linux native、Windows nativeである。
WSL2の工場環境はオーナー確認により廃止済みで、CIの対象外とする。Linuxの旧label `linux-native`も
退役済みで、Linuxのフル試験は工場契約（dotagents `lib/factory/deployment-contract.mjs`）の
full CI席`linux-workstation`へ割り当てる。`factory-linux-main`（`linux-server`）は運用workflow専用で、通常CIを受けない。
CIは3環境で同じフル試験を同時実行し、製品契約がどの対応環境でも成立することを確認する。

| job | 証明すること | 実行内容 |
| --- | --- | --- |
| `full (macos-native)` | macOSで全製品契約が成立すること | `factory-macos-m5`でフル試験 |
| `full (linux-workstation)` | Linuxで全製品契約が成立すること | `factory-linux-rabbit`でフル試験 |
| `full (windows-native)` | Windowsで全製品契約が成立すること | `factory-windows-fox`でフル試験 |

各jobは現行製品suite全件、sensor全件、静的check、ToDo store検証を実行する。
`npm run test:profile -- --profile=<name>`のOS別profileは、実装中のfocused確認用として維持する。
通常の新規suiteは自動的に`core`へ入り、3環境すべてのCI対象になる。

3 matrix jobはOrganization self-hosted runnerで同時に開始する。1環境の失敗で残りを中止しない。
外部forkのコードを自宅LAN内のrunnerへ
自動投入しないため、triggerは全branchのpushと手動実行だけにする。同一branchの古いrunは
新しいpushでcancelする。tag pushは同じcommitのbranch CIを再実行しない。timeoutは通常所要時間の
約2倍に留め、hangを長時間の`in_progress`として保持しない。
