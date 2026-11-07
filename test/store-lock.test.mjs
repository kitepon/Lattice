import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { StoreLockError, withStoreLock } from '../src/store-lock.mjs';

const execFileAsync = promisify(execFile);
const moduleUrl = new URL('../src/store-lock.mjs', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, lockPath: path.join(root, '.write.lock') };
}

// Children exit inside the protocol to leave real crash state; none stay running.
async function crashOwner(lockPath, duringRecovery = false) {
  await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import {withStoreLock} from ${JSON.stringify(moduleUrl)};
    await withStoreLock({lockPath:${JSON.stringify(lockPath)},
      onRecoveryClaim:${duringRecovery ? '()=>process.exit(0)' : 'null'}},
      ()=>process.exit(0));
  `]);
}

const busy = (reason) => (error) => error instanceof StoreLockError && error.reason === reason;

test('ownership is a complete record before the callback and releases on failure', async (t) => {
  const { lockPath } = await fixture(t);
  await assert.rejects(withStoreLock({ lockPath }, async () => {
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.host, hostname());
    assert.equal(owner.process_start.platform, process.platform);
    assert.ok(owner.process_start.identity.length > 0);
    throw new Error('callback failure');
  }), /callback failure/u);
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});

test('dead owner is reclaimed without opt-in and a live owner is preserved byte for byte', async (t) => {
  const { root, lockPath } = await fixture(t);
  await crashOwner(lockPath);
  const dead = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.notEqual(dead.pid, process.pid);
  await withStoreLock({ lockPath }, async () => {
    const before = await readFile(lockPath);
    await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('entered twice')), busy('store_locked'));
    assert.deepEqual(await readFile(lockPath), before);
  });
  assert.deepEqual(await readdir(root), []);
});

test('PID reuse proves original owner death only when the start identity differs', async (t) => {
  const { lockPath } = await fixture(t);
  let owner;
  await withStoreLock({ lockPath }, async () => { owner = JSON.parse(await readFile(lockPath, 'utf8')); });
  owner.process_start.identity = 'different-process-start';
  await writeFile(lockPath, JSON.stringify(owner));
  await withStoreLock({ lockPath }, async () => {
    assert.notEqual(JSON.parse(await readFile(lockPath, 'utf8')).process_start.identity,
      'different-process-start');
  });
});

for (const [name, bytes] of [['empty', ''], ['PID only', '{"pid":99999999}\n']]) {
  test(`legacy ${name} lock stays intact with actionable existing conflict detail`, async (t) => {
    const { lockPath } = await fixture(t);
    await writeFile(lockPath, bytes);
    await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('legacy lock reclaimed')),
      (error) => busy('lock_owner_unidentified')(error)
        && error.detail.lock_path === lockPath && error.detail.next_action.includes(lockPath));
    assert.equal(await readFile(lockPath, 'utf8'), bytes);
  });
}

test('foreign host ownership is preserved even for a locally absent PID', async (t) => {
  const { lockPath } = await fixture(t);
  await crashOwner(lockPath);
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  owner.host = `${hostname()}-foreign`;
  const bytes = JSON.stringify(owner);
  await writeFile(lockPath, bytes);
  await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('foreign lock reclaimed')), busy('store_locked'));
  assert.equal(await readFile(lockPath, 'utf8'), bytes);
});

test('a dead recovery claimant is reclaimed from its name without an owner file', async (t) => {
  const { root, lockPath } = await fixture(t);
  await crashOwner(lockPath);
  await crashOwner(lockPath, true);
  assert.equal((await readdir(`${lockPath}.recovery`)).length, 1);
  await withStoreLock({ lockPath }, () => {});
  assert.deepEqual(await readdir(root), []);
});

test('overlapping recovery preserves the first live claimant and re-reads ownership before unlink', async (t) => {
  const { lockPath } = await fixture(t);
  let liveBytes;
  await withStoreLock({ lockPath }, async () => { liveBytes = await readFile(lockPath); });
  await crashOwner(lockPath);
  await assert.rejects(withStoreLock({ lockPath, onRecoveryClaim: async () => {
    await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('concurrent recovery entered')),
      busy('store_locked'));
    await writeFile(lockPath, liveBytes);
  } }, () => assert.fail('replacement live owner removed')), busy('store_locked'));
  assert.deepEqual(await readFile(lockPath), liveBytes);
});
