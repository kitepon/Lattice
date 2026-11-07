# ADR 0058: project discoveryと初期authoringをclosed CLI面にする

- Status: Accepted
- Date: 2026-07-20

## Context

CLIが導入済みでも、repo内にTODO storeがなければagentはLatticeの利用可否を機械判定できなかった。
`.lattice/`の有無は他機能の状態も含むため接続markerではなく、初回planを作る公開入口も存在しなかった。
その結果、利用可能なLatticeを未導入と誤判定し、工程状態をMarkdownへ戻す経路が生じた。

## Decision

1. どのrepoでも最初に使うdiscoveryを`lattice status --json`へ一本化する。
2. 結果は`lattice.project_status.v1`で、CLI version、git project、canonical store、active
   plan/run、`uninitialized | ready | active_run | invalid`、`can_create_plan`、次commandを返す。
3. Git repoだがstoreがない状態は`uninitialized`、exit 0とする。`.lattice/`の存在だけでは判定しない。
4. 不正storeは`invalid`、exit 1とし、Markdownへ暗黙fallbackしない。
5. 初回authoringは`lattice plan create --input <ref>`とする。入力はrepo内canonical
   `lattice.plan_create_input.v1`で、full desired-state planを受ける。
6. 初期storeは全artifactをstagingへ完成させ、`.lattice/todo`のdirectory renameをactivation
   pointにする。stage／parent inodeをrename前後で照合し、rename後にprepared manifest、descriptor、
   plan、genesis、snapshotとのcanonical完全一致を再検証する。失敗時は自身のinodeだけをrollbackし、
   foreign inodeを削除しない。
7. Markdown履歴移行専用の`todo migrate`は初回authoringへ流用しない。

Node.jsの公開filesystem APIにはdirectory descriptor相対の`renameat`相当がない。v1が保証するのは
通常の並行Lattice writerと偶発的namespace競合の検出・fail closedである。同一OS accountがsyscall間に
stageや`.lattice`を意図的に交換し続ける攻撃は脅威model外とし、その場合も成功を返さずforeign inodeを
削除しない。より強い敵対的local writer隔離が必要なhostではOS sandboxを境界にする。

## Consequences

- agentはdirectory推測をせず、typed結果だけで工程正本を選べる。
- 未初期化は故障でなく、実行可能な次commandを伴う正常状態になる。
- 初回planはschema、canonical bytes、digest、graph制約を満たす必要がある。
- 既存storeへのtopology変更は従来どおり`todo revise`を使い、`plan create`は初期化時だけ許す。

## Supplement — 2026-11-07 (w1/w5)

`plan create`は同じv4 authoring入力で、初期作成に加えて有効な既存Storeへの新plan追加を
受け付ける。既存keyの置換・revisionは行わない。Storeのg5追加入口が通常genesisと
phase/backchainを保存し、lock下のfresh rereadとmanifest最後の公開を所有する。
G4のhistorical import、Markdown移行、過去状態の持越しは流用しない。

`lattice.project_status.v1`のJSON field形は維持し、can_create_planの能力をready/active_runにも
拡張する（invalidはfalse）。next_actionの優先順とkey集合は変えず、この意味変更を公開契約と
release noteへ記録する。manifestとplan memberが無い既知host-local transient-onlyのlayoutは
uninitializedへ写す。Storeが判定・dead transient回収・同一空dirのrmdirを所有し、決定6の
directory rename activationを維持する。live ownerの終了後は次の初期操作が自力で再試行する。

共通plan検証は成功null、失敗時だけreason/pathを返し、boolean APIの可否を維持する。
create/migrateは既存error codeと、入力または派生planのどのfieldのどの規則が失敗したかを
返す。並び替えはADR0181の入力正規化には含めない。
