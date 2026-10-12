import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readOrCreateBridgeHubTerminalId } from '../src/bridge-hub-heartbeat.mjs';
import {
  readOrCreateTerminalIdSync, terminalIdentityPath, terminalPublicLabel,
} from '../src/terminal-identity.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-terminal-identity-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { LATTICE_CONFIG_DIR: root } };
}

test('公開labelは端末idから決定的に導かれ、idを含まず、端末ごとに違う', () => {
  const first = terminalPublicLabel('0123456789abcdef0123456789abcdef');
  assert.match(first, /^terminal-[0-9a-f]{12}$/u);
  assert.equal(first, terminalPublicLabel('0123456789abcdef0123456789abcdef'));
  assert.notEqual(first, terminalPublicLabel('0123456789abcdef0123456789abcdee'));
  assert.ok(!first.includes('0123456789ab'));
  // 導出の式はjournalと公開面の両方に効く。変えると同じ端末のlabelが変わるので値で固定する。
  assert.equal(terminalPublicLabel('terminal-1'), 'terminal-23cf1deadb4e');
  for (const invalid of ['', ' a', 'a b', '-a', 'a'.repeat(129), null, undefined, 7]) {
    assert.throws(() => terminalPublicLabel(invalid), TypeError);
  }
});

test('同期の読み取りは識別子を一度だけ作り、bridgeのheartbeatと同じfile・同じidを使う', async (context) => {
  const { root, env } = await fixture(context);
  const created = readOrCreateTerminalIdSync({ env });
  assert.match(created, /^[0-9a-f]{32}$/u);
  assert.equal(readOrCreateTerminalIdSync({ env }), created);
  assert.equal(await readOrCreateBridgeHubTerminalId({ env }), created);
  assert.deepEqual(await readdir(root), ['bridge-hub-terminal.json']);
  assert.equal(terminalIdentityPath(env), path.join(root, 'bridge-hub-terminal.json'));
  const stored = JSON.parse(await readFile(path.join(root, 'bridge-hub-terminal.json'), 'utf8'));
  assert.deepEqual(stored, { schema: 'lattice.bridge_hub_terminal_identity.v1', terminal_id: created });
});

test('bridgeが先に作った識別子を同期の読み取りが上書きしない', async (context) => {
  const { env } = await fixture(context);
  const fromBridge = await readOrCreateBridgeHubTerminalId({ env });
  assert.equal(readOrCreateTerminalIdSync({ env }), fromBridge);
});

test('識別子を読めず作れない時はnullを返し、保てないidをその場で作らない', async (context) => {
  const { root, env } = await fixture(context);
  // 不正なfile: 上書きせずnull。
  await writeFile(path.join(root, 'bridge-hub-terminal.json'), '{"schema":"other","terminal_id":"x"}\n');
  assert.equal(readOrCreateTerminalIdSync({ env }), null);
  assert.equal(await readFile(path.join(root, 'bridge-hub-terminal.json'), 'utf8'),
    '{"schema":"other","terminal_id":"x"}\n');
  // 置き場がfile: 作れない。
  const blocked = path.join(root, 'blocked');
  await writeFile(blocked, 'x');
  assert.equal(readOrCreateTerminalIdSync({ env: { LATTICE_CONFIG_DIR: blocked } }), null);
  // 相対pathの置き場: 設定の誤りでもTodo操作を止めない。
  assert.equal(readOrCreateTerminalIdSync({ env: { LATTICE_CONFIG_DIR: 'relative/dir' } }), null);
  // 書けない置き場（rootとWindowsではmodeが効かないので対象外）。
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const dir = await mkdtemp(path.join(root, 'ro-'));
    await chmod(dir, 0o500);
    try {
      assert.equal(readOrCreateTerminalIdSync({ env: { LATTICE_CONFIG_DIR: dir } }), null);
    } finally {
      await chmod(dir, 0o700);
    }
  }
});

test('srcはOSのhost名を読まない（journalと公開面へ持ち主の名前を出さない見張り、ADR 0197）', async () => {
  const offenders = [];
  for (const name of (await readdir(SRC)).filter((entry) => entry.endsWith('.mjs'))) {
    const source = await readFile(path.join(SRC, name), 'utf8');
    // `node:os`のhostnameのimportと、名前空間越しの呼び出しの両方を見る。URLの`.hostname`は別物。
    const importsHostname = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:os'/gu)]
      .some((match) => match[1].split(',').some((part) => part.trim().split(/\s+as\s+/u)[0] === 'hostname'));
    if (importsHostname || /\bos\.hostname\s*\(/u.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
