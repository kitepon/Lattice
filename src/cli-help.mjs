import { TODO_INDEPENDENCE_WORKFLOW } from './todo-independence-guidance.mjs';

const ROOT_HELP = `Usage: lattice <command> [options]

Commands:
  status --json                 Discover the current project and next action
  session-context --json        Session開始時の現在地を1プロセスで返す（工程状態＋並列可否）
  plan <command>                Create, compile, or verify plans
  run <command>                 Start or observe compiled runs
  event verify                  Verify a runtime event log
  todo <command>                Read and update the canonical TODO store
  sensor <command>              Initialize or synchronize the bundled sensor
  factory-diagnostics --json    Check native factory integration
  runtime-errors <command>      Inspect the local runtime error store
  bridge <command>              Configure the optional network bridge
  hooks <command>               Install and run sensor-awareness hooks
  setup [status]                AI別のMCP登録・製品hook準備・接続確認

Options:
  -h, --help                    Show help
  --version                     Show the installed version
`;

const NAMESPACE_HELP = Object.freeze({
  plan: `Usage: lattice plan <command> [options]

Commands:
  create --input <file> [--serialization-reviewed]
      # 結果へdispatch_shapeを載せる。--serialization-reviewedは互換のため受理するだけで門ではない
  create --schema --json             # 既定は最新版（v4）のJSON Schemaを返す
  create --schema-version <1|2|3|4> --json
  show <plan_key> --json             # task・依存・phase・状態をplan本体から1コマンドで投影する
  compile --request <request.json>
  compile --schema --json            # lattice.run_request.v1 の JSON Schema を出す
  verify --request <request.json> --plan <plan.json>
`,
  run: `Usage: lattice run <command> [options]

Commands:
  start --request <request.json> --executor <adapter>
  start --selection pull --id <id> --plan <key> --equipment detached-worktree
  start --schema --json              # lattice.run_request.v1 の JSON Schema を出す
  intake --run .lattice/runs/<id> --task <task_id>
  intake release --run .lattice/runs/<id> --task <task_id>
  intake attach --run .lattice/runs/<id> --task <task_id> --input <worker.json>
  intake detach --run .lattice/runs/<id> --task <task_id>
  intake intervention --run .lattice/runs/<id> --task <task_id>
  intake accept --run .lattice/runs/<id> --task <task_id>
  adapter register --input <descriptor.json>
  adapter register --schema --json   # 登録入力の JSON Schema を出す
  adapter list --json
  activate --run .lattice/runs/<id>
      # 全waveが完了するまで戻らないforeground driver。別processのobserve/statusは
      # driver_stateとwaiting_onで、駆動中か・何を待っているかを投影する。
  observe --run .lattice/runs/<id>
  status --run .lattice/runs/<id>
  landing --run .lattice/runs/<id>
  resume --run .lattice/runs/<id>
  close --run .lattice/runs/<id>
  abandon --run .lattice/runs/<id> --reason <reason>
  list --json
  seam profile --run .lattice/runs/<id> --finding <digest> --input <symbols.json>
      # 記録済みfindingの切断コスト内訳を投影する（read-only）。変換を試す前の安い観測で、
      # 入力は {"concern_symbols": {"T1": ["symbol"], ...}}。閾値も可否判定も返さない。
  seam resolve --run .lattice/runs/<id> --finding <digest> --input <request.json>
      # 記録済み競合を隔離worktreeで実際に変換し、五条件を通ればseam splitと後継baseを返す。
      # 入力(lattice.runtime_seam_request.v1)へ書くのは、係争fileの中で各TODOが触るsymbolと
      # 新しい面の名前だけ。branchは動かさないので、後継baseへ進めるかは呼び出し側が決める。
`,
  event: `Usage: lattice event verify --run .lattice/runs/<id>
`,
  todo: `Usage: lattice todo <command> [options]

Read commands:
  status [--json]
  show --plan <key> --task <id> --json  # 個別ToDoと最新bounded note contextを追加操作なしで返す
  note list --plan <key> [--task <id>] --json  # note全履歴の診断面（通常read/startでは不要）
  bindings [--plan <key>] [--json]   # compile_binding付きTaskをTODO identityつきで投影する
  independence [--plan <key>] [--json]  # readyを検証済み並列・要直列・未検査へ分けて投影する
  structure --schema --json  # plan定義後に入力する論理dataflow契約をstore非依存で返す
  structure [--plan <key>] --json  # 保存済み構造をsensor再実行なしでfreshness・finding付き投影する
  seam-profile --plan <key> --file <path> [--json]  # 係争fileの切断コスト内訳を投影する（read-only）
  seam-proposal [--plan <key>] [--json]  # 記録済みseam提案をsensor無しで投影する
  verify [--plan <key>] [--json]
  snapshot --rebuild --plan <key>
  gantt serve --port <port> [--scope live|all]  # 動的表示。opt-in済みplanは工程図と別の構造検査面を持つ
  phase status --plan <key>

Write commands:
  repair-eol --json  # Git checkoutでCRLF化された既存storeをcanonical LFへ戻し、EOL保護を追加する
  dashboard adopt --json  # 衝突したproject_idの配信元rootを現在repoへ明示的に移す
  dashboard ensure --json  # daemon生存保証の冪等入口（launchd等の周期実行向け）
  dashboard remove <project_id> --json  # 登録簿から1件外す（対象repoの外からも叩ける）
  note --plan <key> [--task <id>] (--message <text>|--input <file>)
      # ToDoへ作業継続に必要な方針・調査結果・注意をappend-onlyで追記する
  migrate --input <extraction.json> [--serialization-reviewed] [--json]
  migrate --input <extraction.json> --dry-run --json [--serialization-reviewed]
      # 既存storeへplanを追加する（plan createは空store初期化専用）。
      # pretty-print・digest未計算・repo内絶対pathは機械が直す。空の設計メモは拒否する。
      # 結果へdispatch_shapeを載せる。--serialization-reviewedは互換のため受理するだけで門ではない
  start --plan <key> --task <id> [--parallel-frontier|--override-reason <text> [--serial-confirmed]]
        # readyならflagなしで着手する。flagの順は問わない。
        # --parallel-frontierと--override-reasonは方針・理由の記録。
        # --serial-confirmedは互換のため受理する。いずれも門ではない
  block --plan <key> --task <id> --reason <text>
  unblock --plan <key> --task <id>
  retire --plan <key> --task <id> --reason <text>
  done --plan <key> --task <id> (--evidence <file>|--message <text>)
        # taskを閉じる。--evidenceはdescriptor JSONでも証拠本文でもよい。repo内なら絶対path可。
        # 監査と構造finalizationは残作業であり、doneの門ではない
  reopen --plan <key> --task <id> --reason <text> [--override-reason <text>]
  evidence promote --plan <key> --task <id> --evidence <file>
      # done状態と完了時刻を維持し、最新doneへ追記eventで証拠を再束縛する
  start --plan <key> --task <id> --rebind --reason <text>  # 改訂でcarryされたin-progressへ現版のstart束縛を積み直す（ADR 0191）
  dependency connect --from-plan <key> --from-task <id> --to-plan <key> --to-task <id> --reason <text>
  dependency disconnect --from-plan <key> --from-task <id> --to-plan <key> --to-task <id> --reason <text>
      # 開発中に発見した依存を明示接続する（同一plan内・plan跨ぎとも）。依存の自動推定は行わない
  independence compile --plan <key> --input <file>  # witness setとsensorから並列可否を記録する
  independence witness migrate --plan <key>  # revision後の宣言をtask migrationで写す
  independence witness scaffold --plan <key> --input <draft>  # 下書きとfresh観測から宣言を書き出す
  structure input --plan <key> --input <file> --dry-run --json
      # plan identity・topology・unfinished task coverage・baseline祖先を無変更で検査する
  structure input --plan <key> --input <file>
      # 検査済みplanned sourceをcanonical refへ保存する。compile成功までは有効化しない
  structure compile --plan <key> --input <file>
      # source graph・Git provenance・ToDo DAGを結合する。consistent時だけplanへimmutableに有効化する
  structure realize --plan <key> --task <id> (--planned|--realized <actual-structure.json>) [--commit <HEAD|sha>]...
      # AIはplannedどおりか実体構造だけを判断する。identity・HEAD・履歴鎖・digest・actor・時刻は機械生成する
  structure realize --plan <key> --task <id> --input <file>
      # 完全なrealization envelopeを移送・再生する互換入口
  structure finalize --plan <key> --json
      # 全対象task完了後、最終HEADと全realizationを再結合する。fresh consistentだけterminal受理へ進む
  seam-proposal compile --plan <key>  # 並列可否記録と実sensorからseam提案を記録する
  seam-proposal apply --plan <key>  # 記録済み提案を隔離worktreeで適用し五条件で採否を決める
  seam-proposal land --plan <key> --names <file>  # 採用された変換を本ツリーへ着地させる
  split --plan <key> --input <file>  # in-progress ToDoを抽出群とpending残差へrevisionする
  revise --plan <key> --input <file>
  revise-phase --plan <key> --input <file>
  revise-set --input <file>
  <revise|revise-phase|revise-set|migrate|structure> --schema --json
      # 実際に受理する最新契約のJSON Schemaを返す（storeを読まない）。
      # 入力が契約に合わないときは、違反フィールドのpathがerror detailへ載る
  phase review --plan <key> --phase <id> --reason <text>
  phase <accept|reject> --plan <key> --phase <id> --input <file>
  phase reopen --plan <key> --phase <id> --reason <text> [--override-reason <text>]
  phase close-unaudited --plan <key> --phase <id> --reason <text>
      # 監査せず「監査なしで閉じた」として明示的に閉じる(ADR 0148)。前提はgate_readyで、
      # acceptedへは化けない(phase_accept_dependenciesを解錠しない)
  phase baseline --reason <text> [--except <plan_key>]...
      # 現在gate_readyかつphase eventを1つも持たないPhaseを一括でclosed_unauditedへ宣言する。
      # 自動実行はしない(明示コマンドのみ)。--exceptで指定したplanは対象から除外する

Write commandsはLATTICE_TODO_ACTOR_HOST / SESSION / AGENTを受理する。
欠落はhost／session／agentのdefaultを使う。渡した値がidentifierとして不正なら拒否する。

storeだけを書き換えるcommandの末尾へ--commit-storeを付けると、共有Git lockを取得し、
生じた.lattice/todoの変更だけをcommitしてreceiptを返す。
dirtyなsourceとstore外の既存stageは保持し、store自身がdirtyなら拒否する。
ignoredな再生成artifactだけを作るindependence/seam-proposal compileは対象外。

並列可否（依存線の不在は、書き込み境界が干渉しないことを意味しない）:
${TODO_INDEPENDENCE_WORKFLOW.join('\n')}

判定していない工程は「競合が無い」ではなく「未検査」として扱われ、
todo startのadvisoryとtodo independenceの投影が、その状況と次の一歩を返す。
記録があるのに対象工程が未宣言・失効なら todo start は拒否する。
next_ready が witness に無い independence compile も拒否する。
競合の同時起動は助言のまま。並列既定はstatusのdispatch_frontierとnext_actionが案内する。
`,
  sensor: `Usage: lattice sensor <init|sync> [path] --json
       lattice sensor diff <rootA> <rootB> [options] --json

diff options:
  --subtree-a <rel>     # A側をこの部分木だけに絞り、prefixを剥がしてから突き合わせる
  --subtree-b <rel>     # B側の同上（例: Latticeのsensor/とupstreamのrootを揃える）
  --map-a <from>=<to>   # A側のpath改名写像。繰り返し可（最長prefix一致で1回だけ適用）
  --map-b <from>=<to>   # B側の同上
  --limit <n>           # 明細1覧あたりの上限（既定200・0で無制限）。切った量はtruncationへ出る

突き合わせは行番号を含まない自然キー（kind|path|qualified_name|name）で行う。node idは
行番号を含むので、idで比べると数行のズレが全て偽の追加＋削除になる。辺も端点を自然キーへ
解決してから比べる。比較できなかった辺（端点がsubtree外・index不整合）はexcludedへ件数で出る。
両側のextraction versionが違う時はcomparability.statusがdegradedになる——その差分は
codeの変化だけを意味しない。
`,
  'factory-diagnostics': `Usage: lattice factory-diagnostics --json
`,
  'runtime-errors': `Usage: lattice runtime-errors <command> --json

Commands:
  snapshot [--after-cursor <n>] [--limit <n>]
  ack <cursor>
  diagnostics
  resolve <fingerprint>
  reopen <fingerprint>
  compact
`,
  bridge: `Usage: lattice bridge <command> [options] --json

Commands:
  setup --listen <IP> [--port <49152..65535|auto>] [--dashboard|--upstream <URL>] [--hub <URL>|none] [--allow-host <host>...]
  reconfigure [--listen <IP>] [--port <49152..65535|auto>] [--dashboard|--upstream <URL>] [--hub <URL>|none] [--allow-host <host>...]
  status
  disable
  register    # 現在のlisten portをreverse proxy hostへ自己登録する

registerはLATTICE_BRIDGE_REGISTRAR_SSH_HOSTとLATTICE_BRIDGE_REGISTRAR_SCRIPTが
両方設定されている時だけ動く。アドレスは送らず、remote側がssh送信元から決める。
`,
  setup: `Usage: lattice setup [status] [--host <claude|codex|grok|cursor|all>] [--json]

host省略時は既存AI設定を検出する。明示hostは初回設定を作成する。
setupは登録・hook準備・MCP接続確認まで実行する。更新後も同じコマンドを使う。
statusは設定変更をせず登録とMCP接続を診断する。
結果は機能別のverified／unsupported／disabled／failed。readyだけexit 0、partial／failedはexit 1。
Windows製品hookとGrok製品hookは未対応として返し、MCPは独立して実行する。
`,
  hooks: `Usage: lattice hooks <install|status|uninstall|emit> --host <claude|codex|cursor>
`,
});

const SUBCOMMAND_USAGE = Object.freeze({
  'setup status': 'setup status [--host <claude|codex|grok|cursor|all>] [--json]',
  status: 'status --json',
  'session-context': 'session-context --json',
  'plan create': 'plan create --input <file> [--serialization-reviewed] | --schema --json | --schema-version <1|2|3|4> --json',
  'plan show': 'plan show <plan_key> --json',
  'plan scope-review': 'plan scope-review --plan-input <plan-create-or-extraction.json> --review <scope-review.json> --json | --schema --json',
  'plan compile': 'plan compile --request <request.json> | --schema --json',
  'plan verify': 'plan verify --request <request.json> --plan <plan.json>',
  'run start': 'run start --request <request.json> --executor <adapter>'
    + ' | --selection pull --id <id> --plan <key> --equipment detached-worktree | --schema --json',
  'run intake': 'run intake --run .lattice/runs/<id> --task <task_id>',
  'run intake release': 'run intake release --run .lattice/runs/<id> --task <task_id>',
  'run intake attach': 'run intake attach --run .lattice/runs/<id> --task <task_id> --input <worker.json>',
  'run intake detach': 'run intake detach --run .lattice/runs/<id> --task <task_id>',
  'run intake intervention': 'run intake intervention --run .lattice/runs/<id> --task <task_id>',
  'run intake accept': 'run intake accept --run .lattice/runs/<id> --task <task_id>',
  'run adapter register': 'run adapter register --input <descriptor.json> | --schema --json',
  'run adapter list': 'run adapter list --json',
  'run observe': 'run observe --run .lattice/runs/<id>',
  'run status': 'run status --run .lattice/runs/<id>',
  'run resume': 'run resume --run .lattice/runs/<id>',
  'run landing': 'run landing --run .lattice/runs/<id>',
  'run close': 'run close --run .lattice/runs/<id>',
  'run abandon': 'run abandon --run .lattice/runs/<id> --reason <reason>',
  'run list': 'run list --json',
  'run activate': 'run activate --run .lattice/runs/<id>\n\n'
    + '全waveが完了するまで戻らないforeground driver。別processのrun observe/statusは\n'
    + 'driver_stateとwaiting_onで、駆動中か・何を待っているかを投影する。',
  'run conflict': 'run conflict --run .lattice/runs/<id> --finding <digest>',
  'run hold': 'run hold --run .lattice/runs/<id> --finding <digest>',
  'run recompile': 'run recompile --run .lattice/runs/<id> --input <recompile-request.json>',
  'run reprocess': 'run reprocess --run .lattice/runs/<id>',
  'run finding record': 'run finding record --run .lattice/runs/<id> --checkpoint <digest> --input <candidate.json>',
  'run seam profile': 'run seam profile --run .lattice/runs/<id> --finding <digest> --input <symbols.json>',
  'run seam resolve': 'run seam resolve --run .lattice/runs/<id> --finding <digest> --input <seam-request.json>',
  'event verify': 'event verify --run .lattice/runs/<id>',
  'todo status': 'todo status [--json]',
  'todo show': 'todo show --plan <key> --task <id> --json',
  'todo note': 'todo note --plan <key> [--task <id>] (--message <text>|--input <file>) | list --plan <key> [--task <id>] --json',
  'todo note list': 'todo note list --plan <key> [--task <id>] --json',
  'todo bindings': 'todo bindings [--plan <key>] [--json]',
  'todo independence': 'todo independence [--plan <key>] [--json] | compile --plan <key> --input <file> | witness migrate --plan <key>',
  'todo structure': 'todo structure --schema --json | [--plan <key>] --json | input --plan <key> --input <file> [--dry-run --json] | compile --plan <key> --input <file> | realize --plan <key> --task <id> (--planned|--realized <actual-structure.json>) [--commit <HEAD|sha>]... | realize --plan <key> --task <id> --input <full-realization.json> | finalize --plan <key> --json',
  'todo seam-profile': 'todo seam-profile --plan <key> --file <path> [--json]',
  'todo seam-proposal': 'todo seam-proposal [--plan <key>] [--json] | compile --plan <key>',
  'todo verify': 'todo verify [--plan <key>] [--json]',
  'todo repair-eol': 'todo repair-eol --json',
  'todo snapshot': 'todo snapshot --rebuild --plan <key>',
  'todo gantt': 'todo gantt serve --port <port> [--scope live|all]  # 動的表示のみ。静的HTML生成は廃止',
  'todo gantt serve': 'todo gantt serve --port <0..65535> [--scope live|all]  # loopback動的viewer',
  'todo dashboard': 'todo dashboard adopt --json | ensure --json | remove <project_id> --json'
    + '  # 配信元rootの衝突を明示的に解消／登録簿から1件外す',
  'todo dashboard adopt': 'todo dashboard adopt --json  # 現在repoをproject_idの配信元として明示採用',
  'todo dashboard remove': 'todo dashboard remove <project_id> --json  # 登録簿から1件外す（対象repo不在でも可）',
  'todo phase': 'todo phase <status|review|accept|reject|reopen|close-unaudited> --plan <key> [options]'
    + ' | baseline --reason <text> [--except <plan_key>]...',
  'todo phase status': 'todo phase status --plan <key>',
  'todo phase review': 'todo phase review --plan <key> --phase <id> --reason <text>',
  'todo phase accept': 'todo phase accept --plan <key> --phase <id> --input <file>',
  'todo phase reject': 'todo phase reject --plan <key> --phase <id> --input <file>',
  'todo phase reopen': 'todo phase reopen --plan <key> --phase <id> --reason <text> [--override-reason <text>]',
  'todo phase close-unaudited': 'todo phase close-unaudited --plan <key> --phase <id> --reason <text>',
  'todo phase baseline': 'todo phase baseline --reason <text> [--except <plan_key>]...',
  'todo start': 'todo start --plan <key> --task <id> [--parallel-frontier|--override-reason <text>]',
  'todo retract': 'todo retract --plan <key> --task <id> --reason <text>',
  'todo block': 'todo block --plan <key> --task <id> --reason <text>',
  'todo unblock': 'todo unblock --plan <key> --task <id>',
  'todo retire': 'todo retire --plan <key> --task <id> --reason <text>',
  'todo done': 'todo done --plan <key> --task <id> (--evidence <file>|--message <text>) [--test-result <markdown-file>]',
  'todo reopen': 'todo reopen --plan <key> --task <id> --reason <text> [--override-reason <text>]',
  'todo evidence': 'todo evidence promote --plan <key> --task <id> --evidence <file>',
  'todo evidence promote': 'todo evidence promote --plan <key> --task <id> --evidence <file>',
  'todo dependency': 'todo dependency connect --from-plan <key> --from-task <id> --to-plan <key> --to-task <id> --reason <text>',
  'todo dependency connect': 'todo dependency connect --from-plan <key> --from-task <id> --to-plan <key> --to-task <id> --reason <text>',
  'todo dependency disconnect': 'todo dependency disconnect --from-plan <key> --from-task <id> --to-plan <key> --to-task <id> --reason <text>',
  'todo split': 'todo split --plan <key> --input <file>',
  'todo revise': 'todo revise --plan <key> --input <file> | --schema --json',
  'todo revise-phase': 'todo revise-phase --plan <key> --input <file> | --schema --json',
  'todo revise-set': 'todo revise-set --input <file> | --schema --json',
  'todo migrate': 'todo migrate --input <extraction.json> [--serialization-reviewed] [--json] | --input <extraction.json> --dry-run --json [--serialization-reviewed] | --schema --json',
  'sensor init': 'sensor init [path] --json',
  'sensor sync': 'sensor sync [path] --json',
  'sensor diff': 'sensor diff <rootA> <rootB> [--subtree-a <rel>] [--subtree-b <rel>]'
    + ' [--map-a <from>=<to>] [--map-b <from>=<to>] [--limit <n>] --json',
  'runtime-errors snapshot': 'runtime-errors snapshot [--after-cursor <n>] [--limit <n>] --json',
  'runtime-errors ack': 'runtime-errors ack <cursor> --json',
  'runtime-errors diagnostics': 'runtime-errors diagnostics --json',
  'runtime-errors resolve': 'runtime-errors resolve <fingerprint> --json',
  'runtime-errors reopen': 'runtime-errors reopen <fingerprint> --json',
  'runtime-errors compact': 'runtime-errors compact --json',
  'bridge setup': 'bridge setup --listen <IP> [--port <49152..65535|auto>] [--dashboard|--upstream <URL>] [--hub <URL>|none] [--allow-host <host>...] --json',
  'bridge reconfigure': 'bridge reconfigure [--listen <IP>] [--port <49152..65535|auto>] [--dashboard|--upstream <URL>] [--hub <URL>|none] [--allow-host <host>...] --json',
  'bridge status': 'bridge status --json',
  'bridge disable': 'bridge disable --json',
  'bridge register': 'bridge register --json',
  'hooks install': 'hooks install --host <claude|codex|cursor>',
  'hooks status': 'hooks status --host <claude|codex|cursor>',
  'hooks uninstall': 'hooks uninstall --host <claude|codex|cursor>',
  'hooks emit': 'hooks emit --host <claude|codex|cursor>',
});

function requestedNamespace(argv) {
  if (argv.length === 2 && ['-h', '--help'].includes(argv[1])) return argv[0];
  if (argv.length === 2 && argv[0] === 'help') return argv[1];
  return null;
}

function requestedSubcommand(argv) {
  if (argv.length >= 3 && ['-h', '--help'].includes(argv.at(-1))) {
    return argv.slice(0, -1).join(' ');
  }
  if (argv.length >= 3 && argv[0] === 'help') return argv.slice(1).join(' ');
  return null;
}

export function renderCliHelp(argv) {
  if (argv.length === 1 && ['-h', '--help', 'help'].includes(argv[0])) return ROOT_HELP;
  const subcommand = requestedSubcommand(argv);
  if (subcommand !== null) {
    const usage = SUBCOMMAND_USAGE[subcommand];
    return usage === undefined ? null : `Usage: lattice ${usage}\n`;
  }
  const namespace = requestedNamespace(argv);
  if (namespace === null) return null;
  // namespaceを持たない1語コマンド（status等）は、SUBCOMMAND_USAGEへ落ちる。
  // 落とさないと「存在するのに使い方を知る手段が無い」コマンドになる。
  if (NAMESPACE_HELP[namespace] !== undefined) return NAMESPACE_HELP[namespace];
  const usage = SUBCOMMAND_USAGE[namespace];
  return usage === undefined ? null : `Usage: lattice ${usage}\n`;
}
