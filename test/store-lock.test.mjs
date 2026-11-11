import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { LOCK_STALE_MS, StoreLockError, withStoreLock } from '../src/store-lock.mjs';
import { observeStartIdentityRaw } from '../src/runtime-os-observation.mjs';

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
    assert.match(owner.host, /^(linux|darwin|win32):[0-9a-f]{64}$/u);
    assert.equal(owner.process_start.platform, process.platform);
    assert.ok(owner.process_start.identity.length > 0);
    throw new Error('callback failure');
  }), /callback failure/u);
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});

test('an operator-removed lock counts as released without changing a committed result', async (t) => {
  const { root, lockPath } = await fixture(t);
  const result = await withStoreLock({ lockPath }, async () => {
    await rm(lockPath);
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.deepEqual(await readdir(root), []);
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

test('a PID reused by a process this account cannot open is judged by its real start identity', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows handle access denial');
  const { stdout } = await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-Process | Where-Object { $_.Id -gt 4 -and $(try { $null -eq $_.StartTime } catch { $true }) } | Select-Object -First 1 -ExpandProperty Id']);
  const pid = Number(stdout.trim());
  if (!pid) return t.skip('this account can open every process');
  // The pre-repair fallback: an occupied PID that denies access looked alive for its whole lifetime.
  assert.throws(() => process.kill(pid, 0), { code: 'EPERM' });
  const { lockPath } = await fixture(t);
  let owner;
  await withStoreLock({ lockPath }, async () => { owner = JSON.parse(await readFile(lockPath, 'utf8')); });
  const live = JSON.stringify({ ...owner, pid,
    process_start: { platform: 'win32', identity: await observeStartIdentityRaw(pid) } });
  await writeFile(lockPath, live);
  await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('live owner reclaimed')), busy('store_locked'));
  assert.equal(await readFile(lockPath, 'utf8'), live);
  await writeFile(lockPath, JSON.stringify({ ...owner, pid,
    process_start: { platform: 'win32', identity: 'dead-owner-start' } }));
  assert.equal(await withStoreLock({ lockPath }, () => 'recovered'), 'recovered');
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
  owner.host = `${owner.host}-foreign`;
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

test('unidentified recovery claims have a named manual exit and are never deleted', async (t) => {
  const { lockPath } = await fixture(t);
  await crashOwner(lockPath);
  const claimsPath = `${lockPath}.recovery`;
  await mkdir(path.join(claimsPath, 'legacy-unidentified'), { recursive: true });
  await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('unidentified claim deleted')),
    (error) => busy('store_locked')(error) && error.detail.recovery_claims_path === claimsPath
      && error.detail.next_action.includes(claimsPath));
  assert.deepEqual(await readdir(claimsPath), ['legacy-unidentified']);
});

function runWithLoader(lockPath, specifier, replacement, body) {
  const replacementUrl = `data:text/javascript,${encodeURIComponent(replacement)}`;
  const loader = `export async function resolve(specifier,context,next){
    if(specifier===${JSON.stringify(specifier)}&&context.parentURL?.endsWith('/store-lock.mjs'))
      return {url:${JSON.stringify(replacementUrl)},shortCircuit:true};
    return next(specifier,context);
  }`;
  return execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import {register} from 'node:module';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});
    const {withStoreLock,StoreLockError}=await import(${JSON.stringify(moduleUrl)});
    ${body}
  `]);
}

test('unavailable own identity publishes a weak owner and still acquires', async (t) => {
  const { root, lockPath } = await fixture(t);
  const result = await runWithLoader(lockPath, './runtime-os-observation.mjs',
    `export async function observeStartIdentityRaw(){throw new Error('observer unavailable')}
     export async function observeProcessHostIdentityRaw(){return 'host-domain'}`, `
    import {readFile} from 'node:fs/promises';
    await withStoreLock({lockPath:${JSON.stringify(lockPath)}},async()=>{
      process.stdout.write(await readFile(${JSON.stringify(lockPath)},'utf8'));
    });`);
  const owner = JSON.parse(result.stdout);
  assert.equal(typeof owner.pid, 'number');
  assert.deepEqual(owner.process_start, { platform: process.platform, identity: 'unobserved' });
  assert.equal(owner.host, 'unobserved');
  assert.deepEqual(await readdir(root), []);
});

test('unsupported hard links publish the owner in place and still release cleanly', async (t) => {
  const { root, lockPath } = await fixture(t);
  const result = await runWithLoader(lockPath, 'node:fs/promises',
    `export {lstat,mkdir,open,readFile,readdir,readlink,rename,rm,rmdir,utimes} from 'node:fs/promises';
     export async function link(){throw Object.assign(new Error('unsupported'),{code:'ENOTSUP'})}`, `
    import {readFile} from 'node:fs/promises';
    await withStoreLock({lockPath:${JSON.stringify(lockPath)}},async()=>{
      process.stdout.write(await readFile(${JSON.stringify(lockPath)},'utf8'));
    });`);
  assert.equal(typeof JSON.parse(result.stdout).pid, 'number');
  assert.deepEqual(await readdir(root), []);
});

test('assertHeld resolves while the lock is still ours', async (t) => {
  const { root, lockPath } = await fixture(t);
  const result = await withStoreLock({ lockPath }, async (assertHeld) => {
    await assertHeld();
    return 'held';
  });
  assert.equal(result, 'held');
  assert.deepEqual(await readdir(root), []);
});

test('assertHeld rejects with lock_lost after a replacement and release leaves the foreign lock', async (t) => {
  const { lockPath } = await fixture(t);
  const foreign = '{"pid":1,"foreign":true}\n';
  await withStoreLock({ lockPath }, async (assertHeld) => {
    await rm(lockPath);
    await writeFile(lockPath, foreign);
    await assert.rejects(assertHeld(), (error) => busy('store_locked')(error)
      && error.detail.cause === 'lock_lost' && error.detail.next_action.includes(lockPath));
  });
  assert.equal(await readFile(lockPath, 'utf8'), foreign);
});

test('unidentified lock is recovered only after its mtime exceeds LOCK_STALE_MS', async (t) => {
  const { root, lockPath } = await fixture(t);
  await writeFile(lockPath, '');
  await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('fresh unidentified lock entered')),
    busy('lock_owner_unidentified'));
  const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
  await utimes(lockPath, old, old);
  let ran = false;
  await withStoreLock({ lockPath }, () => { ran = true; });
  assert.ok(ran);
  assert.deepEqual(await readdir(root), []);
});

// BellTeam seats share one store: a writer waits out another live process instead of refusing.
test('waitMs waits out a live owner in another process; re-entry and waitMs 0 still refuse at once', async (t) => {
  const { lockPath } = await fixture(t);
  const holder = execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import {withStoreLock} from ${JSON.stringify(moduleUrl)};
    await withStoreLock({lockPath:${JSON.stringify(lockPath)}}, async () => {
      process.stdout.write('held\\n'); await new Promise((r) => setTimeout(r, 400));
    });
  `]);
  for (let i = 0; i < 200; i += 1) {
    if (await readFile(lockPath).then(() => true, () => false)) break;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  await assert.rejects(withStoreLock({ lockPath }, () => assert.fail('entered a live lock')), busy('store_locked'));
  assert.equal(await withStoreLock({ lockPath, waitMs: 10_000 }, async () => {
    const started = Date.now();
    await assert.rejects(withStoreLock({ lockPath, waitMs: 10_000 }, () => assert.fail('re-entered')),
      busy('store_locked'));
    assert.ok(Date.now() - started < 1_000, 're-entry must not wait on itself');
    return 'acquired';
  }), 'acquired');
  assert.match((await holder).stdout, /held/u);
});
