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

export function cliCommandKind(argv, surfaces = RUNTIME_SURFACES) {
  if (!Array.isArray(argv)) return 'other';
  const [surface, subcommand] = argv;
  if (typeof surface !== 'string' || !Object.hasOwn(surfaces, surface)) return 'other';
  return surfaces[surface].includes(subcommand) ? `${surface}.${subcommand}` : surface;
}
