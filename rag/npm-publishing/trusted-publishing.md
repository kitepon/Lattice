# npm公開時の本人認証を繰り返さない運用

取得日: 2026-09-05。確度: npm公式仕様。設定・公開の実測は別途証拠へ記録する。
出典: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)・
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。
[原文抜粋](raw/trusted-publishing-excerpt.md)。

npmは、指定したGitHub repositoryのworkflowからOIDCで認証して公開する仕組みを提供する。
公開のたびに本人が指紋認証したり、長期有効なnpm tokenをGitHubへ置いたりする必要がない。
初回の信頼設定には所有者の認証が必要になり得る。

GitHub提供runnerを使い、公開jobへ`id-token: write`を与える。self-hosted runnerは非対応。
直接公開には信頼設定の`--allow-publish`が必要。stage-only設定は承認時の本人認証が残るため、
今回の「毎回の認証をなくす」という目的を満たさない。
`npm publish --dry-run`や`npm whoami`はOIDC公開認証の成立を証明しない。実公開で確認する。

Latticeの公開入口は[workflow](../../.github/workflows/publish.yml)。mainへのpushでCIが成功すると
自動起動し、試験済みの同じ木を、既存のrelease commit検査（`prepublishOnly`）を通して公開する（製品検査は
CIが済ませており再実行しない。[流れ](../../docs/architecture/dfd-release-publish.md)）。
手動の再試行は`gh workflow run publish.yml --ref main`（main先頭のCI成功が前提）。
工場のOS別CIとは別の公開jobであり、未実行の工場CIを成功扱いするものではない。
設定の取消はnpmの該当Trusted Publisherの削除とworkflowの停止で行う。

2026-09-05に初回設定を完了し、[GitHub workflow](https://github.com/kitepon/Lattice/actions/runs/33970191336)から
0.68.1を追加の本人認証なしで公開した。registryのprovenanceも確認済み。
詳細は[修理・公開の証拠](../../docs/evidence/2026-09-05-dashboard-delivery-repair.md)を参照する。
