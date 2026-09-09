# Lattice文書案内

Latticeの文書は、現行契約、現在の計画・構想、履歴、証拠を分ける。通常作業では現行契約と対象の
計画だけを読み、完了planや過去の証拠を自動的に文脈へ入れない。

工程状態、task、Phase、依存、完了証拠の正本は本repoの`.lattice/todo/`だけである。Markdownへ
工程状態を二重化せず、`lattice status --json`、続いて`lattice todo status --json`で読む。

## 現行契約

- [`../README.md`](../README.md): 単独導入、利用、診断、更新、releaseの入口
- [`../PLAN.md`](../PLAN.md): 製品思想と研究方向
- [`00_product-contract.md`](00_product-contract.md): 公開製品契約
- [`01_integration-package.md`](01_integration-package.md): hostと任意の工場統合へ提供する面
- [`todo-extraction-v1.md`](todo-extraction-v1.md): 現行v4 authoring／migration契約（filenameは互換維持）
- [`06_design-spec.md`](06_design-spec.md): 動的工程表の表示仕様
- [`bridge-setup.md`](bridge-setup.md): optional network bridgeと公開受入
- [`ci-contract.md`](ci-contract.md): 製品CIとrelease gate
- [`operations/lattice-kitepon-deployment.md`](operations/lattice-kitepon-deployment.md):
  `lattice.kitepon.dev`の現行配備構成
- [`adr/`](adr/): 置換されていない不変Decision

## 現在の計画・構想

- [`plan_product-setup.md`](plan_product-setup.md): 製品所有のMCP登録・hook準備入口と公開実機受入

次のMarkdownは目的、判断、非目標を持つ。実際に着手中か、完了したかは本文のcheckboxでなく
Lattice storeで判定する。

- [`plan_backlog.md`](plan_backlog.md): 保守・裁定待ちbacklog
- [`plan_rebuilt-from-minimal-plans-20260813.md`](plan_rebuilt-from-minimal-plans-20260813.md):
  repo storeで唯一activeな`minimal-plan-repairs-20260813`の散文正本

## 履歴

- [`archive/`](archive/): 完了、撤回、置換済みのplan、handoff、authoring、rollout記録の全文
- top-levelの「履歴参照stub」: store、ADR、証拠、CHANGELOGに固定された旧pathを保つ短い案内。
  stubは現行契約でも進行中planでもない
- [`../CHANGELOG.md`](../CHANGELOG.md): release履歴

`archive/`とstub本文の「現行」「TODO」「未実装」は記録時点の語であり、現在の実装へ読み替えない。

## 証拠

- `evidence/`: 実行時点の入力、結果、旧名称を含み得る監査証拠
- `rag/`: external specification、調査、実験のdated snapshot
- `.lattice/`: repo内の工程store、migration入力、生成artifact。工程を読む正規入口はCLIであり、
  JSONを手で状態更新しない

## 所有境界

Latticeのsource、install、設定、state、schema、migration、診断、復旧、更新、releaseはこのrepoが
所有する。dotagentsは任意の工場導入、host配線、互換性確認を統括するだけで、Latticeの工程や製品状態を
制御しない。Latticeを工場から切り離しても、README、本書、repo内storeから単独運用を完結できる状態を
維持する。
