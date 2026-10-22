# 隔離checkoutの製品testが内蔵sensor build不在で失敗した記録

新しいworktreeでroot依存だけを導入し、`npm run ci`を実行した。`npm test`内の実Lattice fixtureが`LATTICE_SENSOR_UNAVAILABLE`を返し、原因は配布用`./sensor/dist/bin/lattice-sensor.js`の不在だった。`npm test`は製品test runnerだけを起動していた。一方、GitHubの製品CIとnpm公開workflowは`npm run ci`の前にsensor依存導入とbuildを手作業で並べていた。

製品testの正規入口がsensor依存導入とbuildを行うよう変更し、GitHub側の重複した準備を除いた。root依存の`npm ci`は通常のproject setupとして維持する。

修正後、`npm test -- --profile=macos`はsensor依存とbuildを作成して57件成功・1件OS限定skip。元の失敗を起こした`test/todo-structure-realization.test.mjs`は9件すべて成功した。完全gateの最終結果はrelease前に別途確認する。
