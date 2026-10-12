# ADR 0197: journalと公開面へOSのhost名を出さず、端末の識別子から導いたlabelを出す

- Status: accepted
- Date: 2026-10-12
- Amends: [ADR 0056](0056-todo-authoring-transitions.md)（名乗りの無い操作のhostの既定）、
  [ADR 0162](0162-bridge-hub-registration-protocol.md)（Decision 2: 端末のdisplay_nameの中身）、
  [ADR 0164](0164-hub-landing-is-the-public-product-face.md)（Decision 3: 公開の表示名はhub運用者の裁量）

## Context

LatticeはOSのhost名を2か所で外へ出していた。

1. **Todo journal。** `LATTICE_TODO_ACTOR_HOST`の無い操作は、OSのhost名を識別子の字種へ丸めて
   `actor.host`へ書いていた。journalはrepositoryへcommitされるので、公開repositoryでは誰でも読める。
2. **hubの公開一覧。** 端末はheartbeatの`display_name`にOSのhost名を入れ、hubはそれを公開landing
   （HTMLとJSON）へそのまま出していた。ログイン無しで読める。

OSのhost名は、OSか持ち主が決めた自由文である。初期設定のままの端末では持ち主の名前が入る。Latticeは
その中身を選べないのに、公開される2つの面へ運んでいた。2026-10-12のセキュリティ監査（SEC-009）で、
実際に持ち主の名前を含むhost名が、公開repositoryのjournalと公開landingに出ていると分かった。

端末を見分ける働きは要る。journalでは、startした席だけがそのstartをretractできる照合に
`actor.host`を使う。公開landingでは、どの端末がそのprojectを配信しているかを示す。

## Decision

1. **Latticeの製品コードはOSのhost名を読まない。** `src/`に`node:os`の`hostname`を置かない。
   見張りの試験（`test/terminal-identity.test.mjs`）で固定する。
2. **端末は、識別子から導いたlabelで名乗る。** 識別子は端末ごとの乱数で、設定の置き場の
   `bridge-hub-terminal.json`に一度だけ作る（ADR 0162のbridge-hub用の識別子と同じfile、同じ値）。
   labelは`terminal-`に、識別子のSHA-256（領域の接頭辞つき）の先頭12桁を続けたものである。
   - 同じ端末は、journalでも公開landingでも同じlabelになる。
   - 一方向である。labelから識別子は戻せない。識別子はhubが登録の照合に使う鍵なので、外へ出さない。
   - host名の変換（切り詰め、hash）は使わない。host名のhashは、名前を推測した者がそれを確かめる
     手段になる。乱数の識別子には、確かめる対象が無い。
3. **名乗りの無いTodo操作のhostは、このlabelにする。** 識別子を読めず作れない端末（置き場に書けない、
   fileが不正）では`host`にする。操作は止めない。明示の`LATTICE_TODO_ACTOR_HOST`は今までどおり優先する。
4. **端末がhubへ送る`display_name`は、このlabelにする。** 登録の通信契約（キーの集合、値の型）は
   変えない（ADR 0164 Decision 4）。
5. **hubの公開一覧は、端末の自己申告の名前を出さない。** 公開の`display_name`は、hub運用者が
   `public-visibility.json`の`terminal_display_names`（labelをキーにした対応表）へ書いた名前があれば
   それ、無ければhubが識別子から導いたlabelにする。
   - 古いLatticeで動く端末がhost名を送ってきても、hubは公開しない。offlineのまま残った古い登録も同じ。
   - `terminal_display_names`は任意のキーである。無い旧fileはそのまま読める。空文字や前後に空白の
     ある名前は、fileの不正として型つきの500にする（黙って別の名前を出さない）。
   - 公開の名前を人が読める語にするのは、hub運用者の作業である。端末は自分の公開名を決められない。

## Consequences

- 過去の記録は変わらない。既存のjournalに書かれたhost名、hubのregistryに残る自己申告の名前は、
  この変更では消えない。registryは公開されない。
- 版を上げた端末では、名乗りの無い操作のhostが変わる。旧い既定のhostで行ったstartを、新しい既定の
  hostではretractできない（`start_actor_mismatch`）。retractするなら、その時だけ
  `LATTICE_TODO_ACTOR_HOST`に旧い値を渡す（その値がjournalへもう一度書かれる）。`done`はactorを
  照合しないので影響を受けない。
- 名乗りの無いTodo操作が、設定の置き場に識別子のfileを作るようになる。試験の実行役
  （`scripts/run-product-tests.mjs`）は、runごとの一時の置き場を`LATTICE_CONFIG_DIR`で渡し、利用者の
  本物の`~/.lattice`へ作らせない。
- labelは48bitである。数台から数百台の端末で衝突する見込みは無視できる。衝突しても混ざるのは表示と
  retractの照合だけで、hubの経路は識別子そのもので決まるので壊れない。
- 端末が自分のlabelを表示するCLIの面は、この変更では足していない。labelは公開landingの「配信元」と、
  その端末が書いたjournalで読める。

## 対象外

- 名乗りの無い操作の`agent`は、今もOSの利用者名（`USER`／`LOGNAME`）から作る。利用者名にも名前が
  入りうるが、この決定の対象はhost名である。別に扱う。
- self-hosted runnerのActionsのログに出る端末名は、GitHubのrunnerが出すもので、Latticeの出力ではない。
