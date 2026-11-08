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

The three matrix jobs use the organization self-hosted runners with fail-fast
disabled. The caller triggers on main pushes, pull requests targeting main, and
explicit workflow dispatch. A new push to a pull request cancels that PR's
superseded run (`concurrency`, grouped by PR ref, `cancel-in-progress` only for
`pull_request`), so the single runner per environment is not spent on heads that
can no longer be accepted. Main pushes and dispatches are grouped by their own run
id and are never cancelled or replaced, so main keeps per-commit evidence. Job
timeouts stay near twice the normal duration so a hang does not stay
`in_progress`. Cancellation is not a consumer-lifetime guarantee.

## 各jobのNode

| job | Nodeの出どころ | Latticeが持つもの | Latticeが持たないもの |
| --- | --- | --- | --- |
| `full (macos-native)` | 工場のhost copy `/usr/local/libexec/dotagents/factory-node-runtime.sh <version> <sha256>`（契約: dotagents `docs/feature-map/mac-node-runtime.md`）。step `macos_runtime`が受領JSONをlogへ出し、`directory=`/`node=`を`GITHUB_OUTPUT`へ書く | 版とSHA-256（`publish.yml`の`node-version`と同じ版）、`steps.macos_runtime.outputs.directory`の`bin`をPATHの先頭に置くこと | 置き場の選択（`/Users/Shared/factory-node/...`）、世代の作成・退役、ESETの許可。baseは渡さず、runner homeへは入れない |
| `full (linux-workstation)` | `scripts/ci-linux-node-runtime.sh`がjob専有の一時folderへ公式archiveを入れる | 取得・SHA照合・展開 | — |
| `full (windows-native)` | `scripts/ci-windows-node-runtime.ps1`がjob専有の一時folderへ入れる | 取得・SHA照合・展開 | — |

macOSで工場のスクリプトが失敗すると、そのjobだけが失敗する。次の通常jobは工場の状態から選び直す。
