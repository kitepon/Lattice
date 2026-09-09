#!/usr/bin/env node
/**
 * CLI表面の機能確認gate。
 *
 * 「実装した」と「利用者から届く」は別である。実際、実行時変換レーンは中身が動いていたのに
 * 実運転から到達する道が無く、runは緑のまま欠落が表に出なかった。同じことを表面全体で防ぐ。
 *
 * 各コマンドについて2つを確かめる:
 *
 * 1. **説明が届くか** — `lattice <command> --help`が本文を返す。返らないコマンドは、
 *    存在するのに使い方を知る手段が無い。
 * 2. **実行が確かめられているか** — CLI入口（実binary、またはargvを受けるrun*Cli関数）を通る
 *    testが、そのtoken列を実際に渡している。内部moduleを直接呼ぶだけのtestは、引数解析も
 *    exit契約も出力形も通らないので数えない。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { renderCliHelp } from '../src/cli-help.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 出荷しているコマンドの正本。parserの分岐から手で起こす。
 * 新しいコマンドを足したらここへ足す——足し忘れるとgateが黙って縮む、という失敗を
 * check-syntaxの手書き列挙で既に踏んでいるので、ここは意図的に短く保つ。
 */
const COMMANDS = [
  ['setup'], ['setup', 'status'],
  ['status'], ['session-context'], ['factory-diagnostics'],
  ['plan', 'create'], ['plan', 'show'], ['plan', 'compile'], ['plan', 'verify'],
  ['run', 'start'], ['run', 'adapter', 'register'], ['run', 'adapter', 'list'],
  ['run', 'observe'], ['run', 'status'], ['run', 'resume'], ['run', 'close'],
  ['run', 'abandon'], ['run', 'list'], ['run', 'activate'], ['run', 'conflict'],
  ['run', 'hold'], ['run', 'recompile'], ['run', 'reprocess'],
  ['run', 'finding', 'record'], ['run', 'seam', 'resolve'], ['run', 'seam', 'profile'],
  ['event', 'verify'],
  ['todo', 'status'], ['todo', 'bindings'], ['todo', 'independence'],
  ['todo', 'structure'],
  ['todo', 'seam-proposal'], ['todo', 'seam-profile'], ['todo', 'verify'], ['todo', 'snapshot'],
  ['todo', 'gantt'], ['todo', 'gantt', 'serve'],
  ['todo', 'dashboard'], ['todo', 'dashboard', 'adopt'],
  ['todo', 'phase'], ['todo', 'phase', 'close-unaudited'], ['todo', 'phase', 'baseline'],
  ['todo', 'start'], ['todo', 'block'], ['todo', 'unblock'],
  ['todo', 'done'], ['todo', 'reopen'], ['todo', 'evidence'], ['todo', 'revise'],
  ['todo', 'revise-phase'], ['todo', 'revise-set'], ['todo', 'migrate'],
  ['sensor', 'init'], ['sensor', 'sync'], ['sensor', 'diff'],
  ['runtime-errors', 'snapshot'], ['runtime-errors', 'ack'], ['runtime-errors', 'diagnostics'],
  ['runtime-errors', 'resolve'], ['runtime-errors', 'reopen'], ['runtime-errors', 'compact'],
  ['bridge', 'setup'], ['bridge', 'reconfigure'], ['bridge', 'status'],
  ['bridge', 'disable'], ['bridge', 'register'],
  ['hooks', 'install'], ['hooks', 'status'], ['hooks', 'uninstall'], ['hooks', 'emit'],
];

/** argvを受けるCLI入口。ここを通らないtestは、引数解析とexit契約を確かめていない。 */
const CLI_ENTRY = /lattice\.mjs|invokeSensorCli|LATTICE_BIN|latticeBin|run(?:Todo|Runtime|Bridge|Project|Sensor|Setup)Cli|renderCliHelp/u;

/**
 * group CLIの入口関数は、group tokenを落としたargvを受ける（`runBridgeCli(['status','--json'])`）。
 * 完全なtoken列だけを探すと、実際には確かめているコマンドを未確認と誤判定する。
 */
const GROUP_ENTRY = Object.freeze({
  setup: /runSetupCli/u,
  bridge: /runBridgeCli/u,
  hooks: /runHooksCli/u,
  todo: /runTodoCli/u,
  run: /runRuntimeCli/u,
  plan: /runRuntimeCli/u,
  event: /runRuntimeCli/u,
  sensor: /invokeSensorCli/u,
});

/** CLI入口を通るtestだけを、実行到達の証拠として集める。 */
async function spawningTestSources() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  }
  await walk(path.join(ROOT, 'test'));
  const sources = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (!CLI_ENTRY.test(text)) continue;
    sources.push({ file: path.relative(ROOT, file), text });
  }
  return sources;
}

/** token列がargvとして連続して現れるか。`'run', 'seam', 'resolve'`のような並びを探す。 */
function invokesCommand(text, tokens) {
  const pattern = tokens
    // uフラグでは`\-`が不正escapeになるので、文字クラス外で意味を持つ記号だけを逃がす。
    .map((token) => `['"\`]${token.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"\`]`)
    .join(',\\s*');
  return new RegExp(pattern, 'u').test(text);
}

const sources = await spawningTestSources();
const undocumented = [];
const unexercised = [];
for (const tokens of COMMANDS) {
  if (renderCliHelp([...tokens, '--help']) === null) undocumented.push(tokens.join(' '));
  const groupEntry = GROUP_ENTRY[tokens[0]];
  const exercised = sources.some(({ text }) => invokesCommand(text, tokens)
    || (tokens.length > 1 && groupEntry !== undefined && groupEntry.test(text)
      && invokesCommand(text, tokens.slice(1))));
  if (!exercised) unexercised.push(tokens.join(' '));
}

const report = {
  schema: 'lattice.cli_surface_report.v1',
  commands: COMMANDS.length,
  spawning_test_files: sources.length,
  undocumented,
  unexercised,
};
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
if (undocumented.length > 0 || unexercised.length > 0) {
  process.stderr.write(`cli surface incomplete: ${undocumented.length} undocumented,`
    + ` ${unexercised.length} unexercised\n`);
  process.exit(1);
}
process.stdout.write(`cli surface verified: ${COMMANDS.length} commands\n`);
