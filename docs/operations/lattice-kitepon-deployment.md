# lattice.kitepon.dev 配備記録

2026-07-21 に、Lattice dashboardを既存のDocker Caddyとremote-managed Cloudflare Tunnel経由で公開した。
2026-07-26に、経路の最後の1hopをMac発の逆トンネルへ置き換えた。
Cloudflare管理APIの資格情報はリポジトリへ置かず、operator共通の
`~/.config/cloudflare-api.env`（mode 0600）から読み込む。Tunnel実行tokenを設定APIには使用しない。

## 配備構成

```
Cloudflare Tunnel → Docker Caddy → ssh逆トンネル → Mac loopbackのbridge
```

- Public hostname: `lattice.kitepon.dev`
- Tunnel origin: `https://caddy:443`（Origin requestで`Match SNI to Host`を有効化）
- Docker/Caddy host: `192.168.1.2`
- Caddy upstream: `172.18.0.1:53939` 固定。`172.18.0.1`は`license-server_default`
  networkのgatewayで、Caddy container自身から見た到達先である。
- Mac bridge: `127.0.0.1:53939`。LANへは一切bindしない。

MacからDocker/Caddy hostへ`ssh -R 172.18.0.1:53939:127.0.0.1:53939`を常駐させ、Mac側が接続しに行く。
**MacのLAN addressはこの経路のどこにも現れない**ため、DHCPのlease変更でreverse proxyのリテラルが
陳腐化する余地がない。有線USB LANとWi-Fiのどちらで繋がっていても、経路が1つあれば成立する。

以前はCaddyがMacのLAN addressをリテラルで持ち、`lattice bridge register`がlease変更のたびに
Caddyfileを書き換えて追従していた。現構成ではその追従自体が不要になったため、registrarは配線しない
（bridgeのLaunchAgentから`LATTICE_BRIDGE_REGISTRAR_*`を外してある）。registrar機能は製品側に残っており、
逆トンネルを張れない配備では引き続き使える。

### この構成に必要な設定

| 場所 | 設定 | 理由 |
| --- | --- | --- |
| Docker/Caddy host `sshd_config` | `GatewayPorts clientspecified` | 既定の`no`では`ssh -R`が`127.0.0.1`にしかbindできず、container から届かない。`yes`と違い、clientが明示したaddressだけにbindするのでLANへは晒さない。 |
| Docker/Caddy host `ufw` | `allow in on br-<network id> to 172.18.0.1 port 53939 proto tcp` | INPUT policyがDROPのため、container からhost gatewayへの接続が落ちる。 |
| Mac LaunchAgent | `dev.kitepon.lattice.bridge-tunnel` | `KeepAlive`で常駐。`ExitOnForwardFailure=yes`により、転送口を開けない時は転送なしで生き続けず、落ちて張り直す。 |

既存TunnelのIngressは保持し、catch-all 404の直前へLattice用ruleだけを追加してある。DNSは同じTunnelを指す
proxied CNAME。

## 受入結果

次のgateを順番に確認した。

1. Docker/Caddy hostから`http://172.18.0.1:53939/projects/`が許可Host付きでHTTP 200。
2. Caddy container内から同じendpointがHTTP 200。ufw許可前はここだけがtimeoutした。
3. Cloudflare公開HTTPSを別hostの通常DNS resolverから取得し、project一覧がHTTP 200。
4. `/projects/lattice/`がHTTP 200で、HTML titleが`Lattice — Lattice 依存工程図`。
5. `/projects/lattice/events`が接続直後に`event: state`と現在の`head_digest`を返す。
6. 逆トンネルのsshを`kill -9`した後、LaunchAgentが張り直し、公開URLがHTTP 200へ復帰する。

公開URLは `https://lattice.kitepon.dev/projects/lattice/`。

## 2026-07-30 v0.35.0・ブランド404反映

`@quolu/lattice@0.35.0`のglobal install後も、常駐bridgeは起動時に読み込んだ旧moduleを保持していた。
配備経路や設定を変更せず、次の正規入口でbridgeだけを再起動した。

```bash
launchctl kickstart -k "gui/$(id -u)/dev.kitepon.lattice.bridge"
```

再起動直後の最初のlocalhost probeはlisten前で接続に失敗し、その後のhealth確認で起動完了を確認した。
ssh逆トンネル、Caddy、Cloudflare Tunnel、LaunchAgent plist、portは変更していない。

反映後に次を確認した。

1. `/`、`/projects/`、`/projects/lattice/`が公開HTTPSで200。
2. 未知URLへ`Accept: text/html`を付けると、HTTP 404、`Content-Type: text/html`、
   `kitepon.dev / Lattice`の帰属、`noindex, nofollow`、一覧とkitepon.devへの戻り先を返す。
3. 同じURLへ`Accept: application/json`を付けると、HTTP 404と既存の
   `lattice.todo_gantt_http_error.v1` JSONを返す。
4. npm latest、GitHub Release、source tagがすべて`v0.35.0`へ揃う。

GitHub Releaseは
[`v0.35.0`](https://github.com/kitepon/Lattice/releases/tag/v0.35.0)。

## 2026-08-10 v0.53.0・bridge hub配備（サーバー側手順1〜6）

`docs/plan_bridge-hub.md`の設計どおり、配信元を単一Mac固定から複数端末を集約するhubへ切り替える
配備を開始した。本節はサーバー側手順（1〜6、bellがH操作として実行）の記録。Mac側手順（7〜8、
逆トンネル退役とbridge reconfigure）はオーナー実施待ちで別途追記する。

### 変更後の配備構成（サーバー側のみ完了、Mac側は移行中）

```
Cloudflare Tunnel → Docker Caddy → hub（192.168.1.2常駐、systemd）→ 各端末のbridge
```

- hub: `192.168.1.2`にsystemd unit `lattice-hub.service`として常駐（`User=kite`、
  `Restart=on-failure`）。`@quolu/lattice@0.53.0`の`bin/lattice-hub.mjs`。
- **listen port: `53943`。** 申請時の想定`53940`は同一host `172.18.0.1`で稼働中の別サービス
  （spotter dashboard）と衝突するため、配備直前の偵察で発見し変更した。今後この構成に触れる時は
  `53943`を正とする（room内の初期申請に残る`53940`は訂正済みの旧案）。
- `LATTICE_HUB_LISTEN=172.18.0.1`（Docker bridge gateway。Caddy containerからは`127.0.0.1`へ
  直接到達できないため、既存bridgeと同じgateway経由の構成）。
- `LATTICE_HUB_ALLOWED_HOSTS=lattice.kitepon.dev`。
- ufw: `172.18.0.1:53943`へのcontainer→host許可を追加（既存`53939`ルールと対）。
- Caddy upstream: `172.18.0.1:53939` → `172.18.0.1:53943`へ差替（後述の是正を経て反映）。

### 受入結果（サーバー側6手順）

1. `172.18.0.1:53943/projects/`へHost付きcurlがHTTP 200（Docker/Caddy host上）。
2. Caddy container内から同endpointがHTTP 200。
3. `https://lattice.kitepon.dev/`が公開HTTPSでHTTP 200。
4. `https://lattice.kitepon.dev/projects/`がHTTP 200、端末が未登録のため空一覧
   （fail-closed設計どおり——黙って旧配信元を出し続けない）。

### 誤報と是正: Caddy差替が実は反映されていなかった

手順⑥「Caddy差替→validate→reload」は当初完了と報告されたが、誤報だった。host側Caddyfileは
containerへbind mountされており、差替に使った`sed -i`がinodeを新規作成物へ差し替えたため、
すでにmount済みのcontainerからは旧inode（＝旧`53939`設定）が見え続けていた。`caddy validate`と
`caddy reload`はどちらも「読める設定として正しいか」しか見ないため、読んでいる中身が
差し替え前のまま生きているかどうかは検証しない——status codeも`https://lattice.kitepon.dev/`が
200を返し続けたため、配信元がMac側のままであることに気づけなかった。オーナーが公開面に
Mac側の工程が出続けている事実から発覚し、`docker restart caddy`でmountを再解決したところ、
配信内容が実際にhubのページ（title「登録済みプロジェクト — Lattice hub」）へ切り替わった
ことを確認した。

教訓（既知の罠への追補）:

- **bind mountされたfileへの`sed -i`は禁物。** atomic renameと同じ理由でinodeが差し替わり、
  container側は旧inodeを見続ける（`docs/bridge-setup.md`が警告するCaddyfile単一file bind mount
  の罠と同型——原因コマンドが`sed -i`でも同じ穴に落ちる）。in-place書き換え（inodeを維持する
  形での上書き）を使うか、差替後に`docker restart`で強制的にmountを再解決する。
- **切替の検証はHTTP status codeだけでなく配信内容の同一性で行う。** `caddy validate`/
  `caddy reload`の成功と、`curl`の200は「設定ファイルとして正しい」「サーバーが応答している」
  ことしか示さず、「意図した設定が実際に効いているか」は別に確認しないと分からない。
- **H申請の事前確認漏れ**: 対象portの実況（既存listenerとの衝突）確認をH操作申請の手順へ
  含めていなかった。今後192.168.1.2上へ新規サービスを追加するH操作では、対象portが
  空いていることを申請段階で確認する手順を含める。
- Mac側手順（7: hub登録への切替、8: 逆トンネルLaunchAgent `dev.kitepon.lattice.bridge-tunnel`の
  退役）は**完了済み**（2026-08-10確認）。bh5のauto-migrationが両方を実施しており、手作業の
  reconfigureは不要だった。実測: `~/Library/LaunchAgents`に残るLatticeのplistは
  `dev.kitepon.lattice.bridge.plist`だけで、`dev.kitepon.lattice.bridge-tunnel`はfile・load状態とも
  存在しない。`lattice bridge status --json`の`hub`は`http://192.168.1.2:53943/`を返す。
- Windows端末（ChromeBlocker）のbridge常駐はbh6の範囲。WSL2はLANから到達不能なため、
  bridgeはWindows native側で常駐させる必要がある（plan既知の罠「Windows端末の常駐」）。

## 2026-08-10 v0.56.0・公開面の製品ページ化

`docs/plan_bridge-hub-landing.md`とADR 0164に従い、hubの公開面を製品紹介ページへ作り替えた。
配線（Cloudflare Tunnel → Caddy → hub → 各端末bridge）は変更していない。

- 対象commit `46a93bf`（`origin/main`の祖先）。npm `@quolu/lattice@0.56.0`。
- 反映: 192.168.1.2で`npm install -g @quolu/lattice@0.56.0` →
  `~/.lattice/hub/public-visibility.json`（mode 0600）を新規作成 →
  `sudo systemctl restart lattice-hub.service`。journalに
  `{"schema":"lattice.hub_daemon_started.v1","port":53943,...}`を確認。
- Mac端末（工程ページの配信元）は`npm install -g @quolu/lattice@0.56.0`と
  `launchctl kickstart -k "gui/$(id -u)/dev.kitepon.lattice.bridge"`で更新した。

### 受入結果（配信内容で判定・status codeでは判定しない）

| URL | 判定 |
| --- | --- |
| `/`・`/projects/` | JA landing（`特許出願済み`を含む）。301は消えた |
| `/en/`・`/en/projects/` | EN landing（`PATENT PENDING`を含む） |
| `/projects/lattice/` | 200・従来の依存工程図。`name="robots"`は0件 |
| 公開一覧 | `["ChromeBlocker","iine","lattice","root-site-promotion"]`。`smoketest-probe`は不在 |
| 表示名 | `lattice→Lattice`、`root-site-promotion→kitepon.dev`がカード主見出しへ反映 |
| `/projects/smoketest-probe/` | 一覧から隠れていても中継は生存（503＝配信元オフライン、404ではない） |

### 可視性ファイル

```
~/.lattice/hub/public-visibility.json   # mode 0600、hubの再起動なしで反映される
{ "schema": "lattice.bridge_hub_public_visibility.v1",
  "hidden_project_ids": ["smoketest-probe"],
  "hidden_terminal_ids": ["smoketest0000000000000000000001"],
  "display_names": { "lattice": "Lattice", "root-site-promotion": "kitepon.dev" } }
```

0.78.0から、公開一覧の「配信元」は端末の自己申告の名前ではなく、hubが端末の識別子から導いたlabel
（`terminal-`と16進12桁）になる（ADR 0197）。人が読める名前にするなら、同じfileへ任意のキー
`terminal_display_names`を足す。キーは公開一覧に出ているlabel、値は公開してよい名前である。

```
  "terminal_display_names": { "terminal-0a1b2c3d4e5f": "build-mac" }
```

### 既知の残り

- Windows端末（FOX）が配る`/projects/ChromeBlocker/`だけ、まだ`name="robots"`が残る。
  この端末の`@quolu/lattice`はregistry installではなく**ローカルcheckoutへのnpm link**
  （`Documents\Program\Lattice`）なので、registry版へ差し替えるとオーナーの開発構成を
  変えてしまう。更新はオーナーがそのcheckoutを更新した時に自然に反映される。

### publish時の罠

main worktreeがdirtyだと`prepublishOnly`（`verify-release-commit.mjs`）が通らない。
並行作業でdirtyな時は対象commitのclean worktreeから出す。その際`sensor/node_modules`は
**symlinkでなく実ディレクトリとしてcopyする**——`.gitignore`の`node_modules/`は末尾スラッシュ
のためディレクトリにしか当たらず、symlinkはuntracked扱いになってgateを塞ぐ（実測）。

ただし、外側の`node_modules` symlinkを実dir化するためにtree全体へ`cp -R -L`してはいけない。
2026-08-12の0.58.1公開で、内部の`node_modules/.bin/tsc`まで通常fileへ展開され、元の
`../typescript/bin/tsc`というsymlink相対参照を失って`Cannot find module '../lib/tsc.js'`になった。
正しいcopyは、外側symlinkの参照先だけを`realpath`で解き、その**参照先directoryを`cp -R`する**形である。
これならpublish worktree上の最上位は実directoryになり、内部の`.bin/*` symlinkは保持される。

## 2026-08-12 v0.58.1・ToDo構造HEAD観測修理

- 対象commit `50f559e472687b4ee726150f3e7ad88941fef81a`（`origin/main`の祖先）。
- npm `@quolu/lattice@0.58.1`、dist SHA-1
  `8f7f1965e1747cf3b2aeff5d7c41e8796749f527`。事前packとregistryで一致した。
- Mac global CLI、dashboard health、bridge runtimeを0.58.1へ更新。bridge heartbeatはaccepted。
- 公開`/projects/lattice/`はHTTP 200で、構造検査presentationを含む。
- 公開版CLIでPeertableの保存projectionをfresh consistentと確認し、HEAD 103fbfb7の一時再現環境でも
  compileがconsistent／finding 0になった。元Peertable WIPは変更していない。
- rollbackはMacを0.58.0へ戻してdashboard／bridgeを再起動する。npm unpublishと履歴巻き戻しは行わない。


## 2026-08-11 v0.57.1・端末が名乗る集合の是正とFOX復旧

`lattice.kitepon.dev`の公開一覧が全projectオフラインになった事故への対応。原因は
ADR 0165（端末は配信している集合をそのまま名乗る）と CHANGELOG 0.57.1 が持つ。
配線（Cloudflare Tunnel → Caddy → hub → 各端末bridge）は変更していない。

- 対象commit `81dfce2`（`origin/main`の祖先）。npm `@quolu/lattice@0.57.1`。
- hub（192.168.1.2）は**更新していない**。0.57.1は端末側だけの修正で、登録protocolは
  v2のまま変わらない。hubを触らない方がrelease時の停止面が小さい。

### 端末ごとの反映

| 端末 | 反映方法 | 結果 |
| --- | --- | --- |
| Mac（KaitonoMacBook-Air） | `npm install -g @quolu/lattice@0.57.1` → `launchctl kickstart -k` | `heartbeat: accepted`・`runtime_drift: []`・iine／kikoeru／latticeがオンライン |
| FOX（Windows） | checkoutを`git pull --rebase`（installはこのcheckoutへのjunction） | heartbeat再開・ChromeBlockerはオンライン表示まで回復。inbound到達性は未解決（下記） |
| FOX（WSL2） | `npm install -g @quolu/lattice@0.57.1` | CLIは0.57.1。常駐dashboard daemonは0.57.0のまま——置換は`ensureTodoDashboardActivity`を通るstore書込みcommandでだけ起きる（`dashboard adopt`では起きない）。WSL2はbridgeを持たないので公開面への影響は無い |

### FOXで実際に踏んだもの

1. **Startup launcherとdescriptorの状態が食い違い、`reconfigure`自体が拒否された**
   （`BRIDGE_STARTUP_FOLDER_STATE_INVALID`）。`Startup\LatticeBridge.vbs`は在るのに
   `%LOCALAPPDATA%\Lattice\bridge-startup\descriptor.json`が消えていた。片方だけ在る状態は
   moduleが自力で直せない。**orphanになったlauncherを退避して消してから`reconfigure`**すると
   両方が揃って`persistence: installed`へ戻る。
2. **checkoutにunpushedのローカルcommitが1本あった。** installがcheckoutへのjunctionである
   以上、更新は`git pull`であり、他端末の作業commitを踏む可能性が常にある。`--rebase`で
   載せ替えること。NTFS上ではrebase中に`index.lock`のPermission deniedで停止することがあり、
   その時は`git commit -C <元のsha>`してから`git rebase --continue`で閉じる（実測）。
3. **SSH越しに起動したbridgeは、そのSSH sessionが閉じた瞬間に道連れで死ぬ。** Windowsでは
   `wscript`でStartupのlauncherを叩いても、起動元sessionの終了で落ちる（3回再現）。

## 2026-08-11 v0.57.3・配備記録

- 対象commit: `8bfd0023`（`origin/main`の祖先）。npm `@quolu/lattice@0.57.3`、dist shasumは
  `510e7ab8e75d501c8227063eff3085d555041430`。
- Mac: global install後、`lattice --version`は`0.57.3`。常駐bridgeは自動入替え後に
  `runtime.version=0.57.3`、`runtime_drift=[]`、heartbeat `accepted`、`remedy=null`。
- FOX/WSL2: `ssh fox-wsl`経由で`npm install -g @quolu/lattice@0.57.3`を実施し、
  `/home/kite/.npm-global/bin/lattice --version`は`0.57.3`。WSL2側はbridge未設定のため、
  常駐bridgeと公開面は測定対象外。FOXの対話logon依存はcarry overとする。
- 公開面: `https://lattice.kitepon.dev/projects/lattice/`はHTTP 200。

### 今回の罠

インストール版CLIのPATHが端末ごとに異なるため、SSH経由のWSL2では`lattice`の裸コマンドが
見つからない場合がある。`npm prefix -g`でglobal prefixを確認し、今回のFOXでは
`/home/kite/.npm-global/bin/lattice`を絶対パスで実測した。配備結果を「コマンドが無い」と
誤って未実施扱いせず、インストール成否とPATH設定を分けて記録する。
   session中は`netstat`にLISTENINGが出るので、**同じsession内では生きて見え、次の接続では
   消えている**。常駐させられるのはオーナーの対話logon sessionだけで、それを行うのが
   Startup folderのlauncherである。遠隔からできるのは常駐設定の修復までとする。

### 到達性を測るなら、listenerが生きている同じ窓の中で測る（誤診の記録）

この復旧作業中、`bridge status`の`listener_not_accepting`と自ホストからの
`Test-NetConnection`失敗を根拠に「inbound firewallが閉じている」と誤って結論した。
実際には**測定した時点でbridge processが既に死んでいた**（上記3の通り、前のSSH sessionと
一緒に落ちていた）。listenerを生かしたまま同一session内で測り直すと、結果は逆になる。

| 測り方 | 結果 |
| --- | --- |
| 自ホスト`Test-NetConnection 192.168.1.11:61578`（listener生存中） | `TcpTestSucceeded = True` |
| hub（192.168.1.2）から`http://192.168.1.11:61578/projects/ChromeBlocker/` | 200 |
| 公開面`https://lattice.kitepon.dev/projects/ChromeBlocker/` | 200 |

FOXのinbound TCP 61578は最初から通っていて、firewall ruleの追加は不要だった。
**「繋がらない」を観測したら、まず対象processが今この瞬間生きているかを同じ窓で確認する。**
死んだlistenerへの接続失敗は、経路の遮断と同じ症状を出す。

### heartbeatと配信は別経路である

heartbeatはoutbound、配信はinboundなので、**一覧の「オンライン」はそのページが開けることを
意味しない**。受入は必ず`/projects/<id>/`の実応答で判定する。

## 2026-08-20 v0.62.0・authoring入口受理

- 対象commit `cedd2c3d`（`origin/main`の祖先）。npm `@quolu/lattice@0.62.0`。
- Mac: `npm install -g @quolu/lattice@0.62.0 --prefer-online`。CLI 0.62.0。
  bridge runtime 0.62.0、heartbeat accepted、reachable。
- 公開面: `https://lattice.kitepon.dev/projects/` と `/projects/lattice/` が HTTP 200。
- 配線（Cloudflare Tunnel → Caddy → hub）は変更していない。
- 証跡: [2026-08-20-v0.62.0-authoring-entry-release.md](../evidence/2026-08-20-v0.62.0-authoring-entry-release.md)。

## 2026-08-20 v0.61.1・dispatch往復廃止

- 対象commit `3f106a05`（`origin/main`の祖先）。npm `@quolu/lattice@0.61.1`。
- Mac: `npm install -g @quolu/lattice@0.61.1 --prefer-online`。CLI 0.61.1。
  bridge runtime 0.61.1、heartbeat accepted、reachable。
- 公開面: `https://lattice.kitepon.dev/projects/` と `/projects/lattice/` が HTTP 200。
- 配線（Cloudflare Tunnel → Caddy → hub）は変更していない。
- 証跡: [2026-08-20-v0.61.1-dispatch-gate-release.md](../evidence/2026-08-20-v0.61.1-dispatch-gate-release.md)。
