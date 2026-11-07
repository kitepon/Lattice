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

製品jobのNodeはホストのNodeと別に用意する。macOSは`scripts/ci-macos-node-runtime.sh`がNode v24.22.0を`$RUNNER_TOOL_CACHE/lattice-node/v24.22.0`（runner所有、版名固定、mode 700）へ置き、既存のdirectoryは版・uid・modeのassertを通した時だけ再利用し、通らなければstaging directoryで作り直してrenameで据える。pathを固定するのは、Mac runnerのESETが実行ファイルのpath単位でLANの受信を許可するためで、runごとに変わるpathでは許可が保てない。Linux/Windowsはjob専有の一時directoryのまま。

The three matrix jobs use the organization self-hosted runners with fail-fast
disabled. The actual caller triggers on main pushes, pull requests targeting
main, and explicit workflow dispatch. It declares neither workflow concurrency
nor automatic cancellation of superseded runs; those cannot be used as a
consumer-lifetime guarantee. The full job timeout is 30 minutes.

The canonical [macOS runtime function/data/state contract](architecture/dfd-ci-macos-runtime.md)
separates current PR53 behavior from the proposed non-overwriting generations.
No exclusive cache allocation or prior-consumer exit handoff exists, so a tree
another job may run is never replaced, renamed over or deleted: a failed tree is
left in place and a new generation is reserved with `mkdir` and published by a
marker. A verified complete generation is reused by later jobs. The proposed
root is `/Users/Shared/lattice-node` (owner-checked), because the ESET chooser
cannot reach the 0700 runner home.
