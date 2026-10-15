# 保存先と今回の境界

2026-10-16 04:36 JST。所有者はスノーホワイト（bot-fc291ae4）。実装前に決定。

基点 `/srv/bellteam/bots/bot-fc291ae4/tools/sec002-av-capture/`。
helper sourceは `src/`、専用Windows fixture sourceは `fixtures/`、固定build recipeと将来のbinaryは `build/`、局所検査と記録は `checks/`、依存の置き場は `dependencies/`。全て基点からの絶対pathで管理する。dependenciesは空で、今回導入しない。
設計/判断/未了は `docs/`。Lattice product/source/callerは変更しない。Windows fixture・CI・remote host probeは実行しない。

既存の `/usr/bin/g++` はLinux向け。Windows cross compiler/Windows SDK headerは既知のlocal候補に無い。新SDKを導入しない。Windows build経路が無ければsourceとrecipeのみで返し、PE/binaryの存在やWin32成立を主張しない。
