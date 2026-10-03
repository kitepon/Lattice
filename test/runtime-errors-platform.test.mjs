import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  recordRuntimeError,
  runtimeErrorReportingConfigPath,
  runtimeErrorsDiagnostics,
  runtimeErrorsSnapshot,
  runtimeErrorsStatePath,
} from '../src/runtime-errors.mjs';
import { productCredentialPath } from '../src/runtime-error-reporting.mjs';
import { daclIsOwnerOnly, readWindowsDacl, windowsSelfSid } from '../src/windows-owner-only.mjs';

// このOSで実際に起きることを確かめる試験。storeを本人だけに絞る方法がOSごとに違う（POSIXはmode、
// WindowsはDACL）ので、Windowsの実機でしか走らない試験をここへ置く。
const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lattice.mjs');
const windows = process.platform === 'win32';
const windowsTest = windows ? test : test.skip;
const CLI_FAILED = 'LATTICE.CLI_INTERNAL_FAILED';
const USERS_SID = 'S-1-5-32-545';
const VALID_CONFIG = {
  schema_version: '1.0',
  host: { id: 'test-host', profile: windows ? 'windows-native' : 'linux' },
  collection: { enabled: true },
  reporting: { enabled: false },
};

async function runJson(args, env) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'runtime-errors', ...args, '--json'], { env });
  return JSON.parse(stdout.trim());
}

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-platform-'));
  const configPath = path.join(root, 'config', 'factory-reporter.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(VALID_CONFIG));
  // Windowsでは、他のaccount（Users）へ継承で読み取りを許すフォルダの下へstoreを置く——既定の
  // `%LOCALAPPDATA%`が別のaccountへ継承で許している端末と同じ形を、どの端末の試験でも作る。
  const parent = path.join(root, 'shared');
  await mkdir(parent);
  if (windows) icacls(parent, '/grant', `*${USERS_SID}:(OI)(CI)R`);
  const storePath = path.join(parent, 'state', 'runtime-errors.json');
  return { root, parent, storePath, storeDir: path.dirname(storePath),
    options: { configPath, storePath, reportingConfigPath: path.join(root, 'config', 'runtime-error-reporting.json'), version: '0.75.0' } };
}

const icacls = (...args) => assert.equal(spawnSync('icacls', args, { windowsHide: true }).status, 0, args.join(' '));

test('CLIは、設定が無ければdisabled、有効ならenabledと答える（どのOSでも同じ形）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-platform-'));
  try {
    const env = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_STATE_HOME: path.join(root, 'xdg-state') };

    const bare = await runJson(['snapshot'], env);
    assert.deepEqual(bare.diagnostics,
      { collection: 'disabled', status: 'not_applicable', total_count: 0, pending_count: 0, truncated: false });
    assert.equal((await runJson(['diagnostics'], env)).collection, 'disabled');
    assert.equal(existsSync(path.join(root, 'xdg-state', 'lattice')), false);

    await mkdir(path.join(root, 'xdg-config', 'dotagents'), { recursive: true });
    await writeFile(path.join(root, 'xdg-config', 'dotagents', 'factory-reporter.json'), JSON.stringify(VALID_CONFIG));
    const configured = await runJson(['snapshot'], env);
    assert.deepEqual(configured.diagnostics,
      { collection: 'enabled', status: 'ready', total_count: 0, pending_count: 0, truncated: false });
    assert.deepEqual(configured.cursor, { high_watermark: 0, acknowledged_through: 0, next: 0 });
    assert.deepEqual(configured.runtime_errors, []);
    assert.deepEqual(configured.resolutions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('置き場: Windowsは%LOCALAPPDATA%の下、ほかはXDGの場所。XDGの変数はどのOSでも優先する', () => {
  const env = { HOME: '/home/u', USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const local = path.join(env.LOCALAPPDATA, 'Lattice');
  assert.equal(runtimeErrorsStatePath(env, 'win32'), path.join(local, 'runtime-errors', 'runtime-errors.json'));
  assert.equal(runtimeErrorReportingConfigPath(env, 'win32'), path.join(local, 'runtime-error-reporting.json'));
  assert.equal(productCredentialPath(env, 'win32'), path.join(env.LOCALAPPDATA, 'bughub', 'product-credentials', 'lattice.json'));
  // `LOCALAPPDATA`が無い時は、利用者のフォルダから組む。
  assert.equal(runtimeErrorsStatePath({ USERPROFILE: env.USERPROFILE }, 'win32'),
    path.join(env.USERPROFILE, 'AppData', 'Local', 'Lattice', 'runtime-errors', 'runtime-errors.json'));

  assert.equal(runtimeErrorsStatePath(env, 'linux'), path.join('/home/u', '.local', 'state', 'lattice', 'runtime-errors.json'));
  assert.equal(runtimeErrorReportingConfigPath(env, 'darwin'), path.join('/home/u', '.config', 'lattice', 'runtime-error-reporting.json'));
  assert.equal(productCredentialPath(env, 'linux'), path.join('/home/u', '.config', 'bughub', 'product-credentials', 'lattice.json'));

  for (const platform of ['win32', 'linux']) {
    const xdg = { ...env, XDG_STATE_HOME: path.join('x', 'state'), XDG_CONFIG_HOME: path.join('x', 'config') };
    assert.equal(runtimeErrorsStatePath(xdg, platform), path.join('x', 'state', 'lattice', 'runtime-errors.json'));
    assert.equal(runtimeErrorReportingConfigPath(xdg, platform), path.join('x', 'config', 'lattice', 'runtime-error-reporting.json'));
  }
});

windowsTest('Windows: storeのフォルダを本人・SYSTEM・Administratorsだけに絞り、中のfileも同じ権限になる', async () => {
  const workspace = await makeWorkspace();
  try {
    const sid = windowsSelfSid();
    // 同じ親の下に作っただけのフォルダは、親の権限を継ぎ、他のaccountが読める。
    const plain = path.join(workspace.parent, 'plain');
    await mkdir(plain);
    assert.equal(daclIsOwnerOnly(readWindowsDacl(plain, plain), sid), false);

    const recorded = recordRuntimeError(CLI_FAILED, workspace.options);
    assert.equal(recorded.status, 'recorded');
    const dirSddl = readWindowsDacl(workspace.storeDir, workspace.storeDir);
    assert.equal(daclIsOwnerOnly(dirSddl, sid), true, dirSddl);
    // 継承を切ってある（`P`）。親の権限が後から変わっても、storeへは降りてこない。
    assert.match(dirSddl, /^D:P/);
    assert.equal(daclIsOwnerOnly(readWindowsDacl(workspace.storePath, workspace.storeDir), sid), true);

    // 記録は読めて、OSは`win32`で残る。置き換え（rename）の後も権限は保たれる。
    recordRuntimeError(CLI_FAILED, workspace.options);
    const snapshot = runtimeErrorsSnapshot(0, 256, workspace.options);
    assert.deepEqual([snapshot.diagnostics.collection, snapshot.diagnostics.status, snapshot.runtime_errors[0].occurrence_count],
      ['enabled', 'ready', 2]);
    assert.equal(daclIsOwnerOnly(readWindowsDacl(workspace.storePath, workspace.storeDir), sid), true);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

windowsTest('Windows: 他のaccountが触れる形になったstoreは使わない', async () => {
  const workspace = await makeWorkspace();
  try {
    recordRuntimeError(CLI_FAILED, workspace.options);

    // fileへ他のaccount（Users）の読み取りを足す。読むのも書くのも止める。
    icacls(workspace.storePath, '/grant', `*${USERS_SID}:R`);
    assert.throws(() => runtimeErrorsSnapshot(0, 256, workspace.options), /store_unsafe/);
    assert.throws(() => recordRuntimeError(CLI_FAILED, workspace.options), /store_unsafe/);
    assert.equal(runtimeErrorsDiagnostics(workspace.options).status, 'unavailable');
    icacls(workspace.storePath, '/remove', `*${USERS_SID}`);
    assert.equal(runtimeErrorsDiagnostics(workspace.options).status, 'ready');

    // フォルダへ直接足した時: 中身があるフォルダは絞り直さない（中身を信用できない）。
    icacls(workspace.storeDir, '/grant', `*${USERS_SID}:(OI)(CI)R`);
    assert.throws(() => recordRuntimeError(CLI_FAILED, workspace.options), /store_unsafe/);
    assert.throws(() => runtimeErrorsSnapshot(0, 256, workspace.options), /store_unsafe/);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

windowsTest('Windows: 先に在る空のフォルダは絞って使い、中身のある絞られていないフォルダは使わない', async () => {
  const empty = await makeWorkspace();
  const occupied = await makeWorkspace();
  try {
    const sid = windowsSelfSid();
    // 親の権限を継いだままの空のフォルダ（作った直後に止まった時の形）。
    await mkdir(empty.storeDir);
    assert.equal(daclIsOwnerOnly(readWindowsDacl(empty.storeDir, empty.storeDir), sid), false);
    assert.equal(recordRuntimeError(CLI_FAILED, empty.options).status, 'recorded');
    assert.equal(daclIsOwnerOnly(readWindowsDacl(empty.storeDir, empty.storeDir), sid), true);

    await mkdir(occupied.storeDir);
    await writeFile(path.join(occupied.storeDir, 'someone-elses.txt'), 'x');
    assert.throws(() => recordRuntimeError(CLI_FAILED, occupied.options), /store_unsafe/);
    assert.equal(existsSync(occupied.storePath), false);
  } finally {
    await rm(empty.root, { recursive: true, force: true });
    await rm(occupied.root, { recursive: true, force: true });
  }
});

windowsTest('Windows: CLIは既定の置き場（%LOCALAPPDATA%\\Lattice）へ設定とstoreを置き、storeだけを絞る', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-platform-'));
  try {
    const localAppData = path.join(root, 'AppData', 'Local');
    const env = { ...process.env, USERPROFILE: root, LOCALAPPDATA: localAppData };
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'LATTICE_RUNTIME_ERROR_REPORTING']) delete env[name];
    const lattice = path.join(localAppData, 'Lattice');
    const storeDir = path.join(lattice, 'runtime-errors');

    // 既定では無効で、何も作らない。Windowsはdotagentsの設定を読まず、Lattice自身の送信設定だけで有効になる。
    assert.equal((await runJson(['diagnostics'], env)).collection, 'disabled');
    assert.equal(existsSync(lattice), false);

    const enabled = await runJson(['reporting', 'enable'], env);
    assert.deepEqual([enabled.reporting, enabled.collection, enabled.store_status, enabled.credential],
      ['enabled', 'enabled', 'ready', 'missing']);
    assert.equal(existsSync(path.join(lattice, 'runtime-error-reporting.json')), true);

    const recorded = recordRuntimeError(CLI_FAILED, { env, version: '0.75.0' });
    assert.equal(recorded.status, 'recorded');
    assert.equal(existsSync(path.join(storeDir, 'runtime-errors.json')), true);
    const sid = windowsSelfSid();
    assert.equal(daclIsOwnerOnly(readWindowsDacl(storeDir, storeDir), sid), true);

    const snapshot = await runJson(['snapshot'], env);
    assert.deepEqual([snapshot.diagnostics.collection, snapshot.diagnostics.status, snapshot.runtime_errors.length],
      ['enabled', 'ready', 1]);
    const resolved = await runJson(['resolve', recorded.fingerprint], env);
    assert.deepEqual([resolved.runtime_errors.length, resolved.resolutions.length], [0, 1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
