#!/usr/bin/env node
//
// upstream追従のあとで、上流(CodeGraph)由来の新しい行へLatticeの命名を当てる。
//
//   node scripts/upstream-rename.mjs <files...>            # 変更件数と残りの上流名を数える
//   node scripts/upstream-rename.mjs --write <files...>    # 書き換える
//   node scripts/upstream-rename.mjs --write --prose <md>  # 文書: 単独の名前を「lattice sensor」へ
//
// 3-way mergeは上流の新しい行を上流名のまま持ち込む（Latticeの改名はbaseからの
// ローカル変更なので、上流が新しく書いた行には当たらない）。src/・__tests__/・
// scripts/・kernel・docs/に上流名を残さない契約（test/lattice-sensor-runtime.test.mjs）
// を保つため、衝突解決の前にこれを通すと、hunkの両側が同じ名前で並んで比べやすい。
//
// 規則は置換であって正解の保証ではない。改名は選択的で文脈に依るので（UPSTREAM.json
// notes）、当てたあとは build・test・文言の目視で直す。codegraph を含む行だけを触る。
import { readFileSync, writeFileSync } from 'node:fs';

const write = process.argv.includes('--write');
const prose = process.argv.includes('--prose');
const files = process.argv.slice(2).filter((a) => a !== '--write' && a !== '--prose');

// 例外（現行 Lattice が別名にしたもの）。長いものから当てる。
const EXACT = [
  ['isCodeGraphDataDir', 'isLatticeStateDir'],
  ['codeGraphDirName', 'latticeSensorRelativeDir'],
  ['codegraphDir', 'sensorDir'],
  ['.codegraph/codegraph.db', '.lattice/sensor/sensor.db'],
  ['codegraph.db', 'sensor.db'],
  ['codegraph.lock', 'sensor.lock'],
  ['mcp__codegraph__', 'mcp__lattice_sensor__'],
  ['codegraph-kernel', 'lattice-sensor-kernel'],
  ['colbymchenry/codegraph', 'kitepon/Lattice'],
  ['.mcpServers.codegraph', '.mcpServers.latticeSensor'],
  ['hello.codegraph', 'hello.sensor'],
  ['dist/bin/codegraph.js', 'dist/bin/lattice-sensor.js'],
  ['bin/codegraph', 'bin/lattice-sensor'],
  ['codegraph.json', 'lattice-sensor.json'],
];
const SUBCOMMANDS = 'init|uninit|sync|index|status|query|upgrade|list|stop|serve|install|uninstall|files|context|affected|callers|callees|impact|explore|node|search|unlock|daemon|telemetry|ui|mcp|watch|where|version|help|doctor';

function renameLine(line) {
  if (!/codegraph/i.test(line)) return line;
  let s = line;
  for (const [a, b] of EXACT) s = s.split(a).join(b);
  s = s.replace(/CODEGRAPH_/g, 'LATTICE_SENSOR_');
  s = s.replace(/(?<![A-Za-z0-9])codegraph_(?=[a-z$])/g, 'lattice_sensor_');
  s = s.split('\\ncodegraph ').join('\\nlattice sensor ');
  s = s.replace(/(?<=[a-z])Codegraph|Codegraph(?=[A-Z])/g, 'LatticeSensor');
  s = s.replace(/\[CodeGraph( MCP| daemon| watchdog)?\]/g, (_, x) => `[LatticeSensor${x ?? ''}]`);
  s = s.replace(/CodeGraph/g, 'LatticeSensor');
  s = s.replace(/(^|[^\w)\]])\.codegraph(?![\w])/g, '$1.lattice/sensor');
  s = s.replace(new RegExp(`\\bcodegraph (${SUBCOMMANDS})\\b`, 'g'), 'lattice sensor $1');
  s = s.replace(/(['"`])codegraph\1/g, '$1lattice-sensor$1');
  s = s.replace(/\bcodegraph-/g, 'lattice-sensor-');
  s = s.replace(/\bCodegraph\b/g, 'Lattice sensor');
  const comment = prose || /^\s*(\/\/|\*|\/\*|#)/.test(s);
  s = s.replace(/\bcodegraph\b/g, comment ? 'lattice sensor' : 'latticeSensor');
  return s;
}

let changed = 0; let left = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const out = src.split('\n').map(renameLine).join('\n');
  if (out !== src) { changed += 1; if (write) writeFileSync(f, out); }
  left += (out.match(/codegraph/gi) ?? []).length;
}
console.log(JSON.stringify({ files: files.length, changed, remaining_mentions: left }));
