/**
 * 落ちたCLIの面を、固定の語彙（`<surface>`か`<surface>.<subcommand>`）へ写す。
 *
 * runtime error記録の`safe_context.command_kind`に載る値で、工場reportを通ってBugHubまで運ばれる。
 * 利用者が打った引数の値（run ref・path・plan key等）は載せない——この一覧に在る語だけを返し、
 * 一覧に無い語は面の名前だけ、面も無ければ`other`へ落とす。
 */
const RUNTIME_SURFACES = Object.freeze({
  plan: Object.freeze(['compile', 'verify']),
  run: Object.freeze(['abandon', 'activate', 'adapter', 'close', 'conflict', 'finding', 'hold', 'intake',
    'landing', 'list', 'observe', 'recompile', 'reprocess', 'request', 'resume', 'seam', 'start', 'status']),
  event: Object.freeze(['verify']),
});

/**
 * storeも端末の状態も書き換えないと確かめた面（ADR 0196）。通信の失敗が漏れた記録の重大度を決める時に使う
 * ——ここに在る面は、落ちても失うものが無く、打ち直せば戻る。確かめていない面は載せない。
 */
export const READ_ONLY_COMMAND_KINDS = new Set(['run.list', 'todo.status', 'todo.verify']);

export function cliCommandKind(argv, surfaces = RUNTIME_SURFACES) {
  if (!Array.isArray(argv)) return 'other';
  const [surface, subcommand] = argv;
  if (typeof surface !== 'string' || !Object.hasOwn(surfaces, surface)) return 'other';
  return surfaces[surface].includes(subcommand) ? `${surface}.${subcommand}` : surface;
}
