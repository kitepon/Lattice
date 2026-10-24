// Explicit healthy-snapshot validation; never count this as a native failure.
import { mkdir, open, readFile, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

export async function verifyOwnedDump(file, expectedPid) {
  const handle = await open(file, 'r');
  async function read(length, position) {
    const data = Buffer.alloc(length);
    const { bytesRead } = await handle.read(data, 0, length, position);
    if (bytesRead !== length) throw new Error(`Truncated dump at ${position}`);
    return data;
  }
  try {
    const header = await read(32, 0);
    if (header.readUInt32LE() !== 0x504d444d) throw new Error('Invalid minidump signature');
    const count = header.readUInt32LE(8), start = header.readUInt32LE(12);
    if (!count || count > 128) throw new Error('Invalid stream count');
    const directory = await read(count * 12, start);
    const result = { pid: null, threads: 0, modules: 0, memory64Ranges: 0,
      flags: header.readBigUInt64LE(24).toString(16), streams: [] };
    for (let i = 0; i < count; i++) {
      const type = directory.readUInt32LE(i * 12), size = directory.readUInt32LE(i * 12 + 4), rva = directory.readUInt32LE(i * 12 + 8);
      result.streams.push({ type, size });
      if (type === 3) result.threads = (await read(4, rva)).readUInt32LE();
      if (type === 4) result.modules = (await read(4, rva)).readUInt32LE();
      if (type === 9) result.memory64Ranges = Number((await read(8, rva)).readBigUInt64LE());
      if (type === 15 && size >= 12) {
        const misc = await read(12, rva);
        if (misc.readUInt32LE(4) & 1) result.pid = misc.readUInt32LE(8);
      }
    }
    if (result.pid !== expectedPid || !result.threads || !result.modules || !result.memory64Ranges) {
      throw new Error(`Snapshot lacks required target/streams: ${JSON.stringify(result)}`);
    }
    return result;
  } finally { await handle.close(); }
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] === script) {
  if (process.argv[2] === '--child') {
    const probe = createRequire(import.meta.url)(path.resolve(process.argv[3]));
    const helper = path.resolve(process.argv[4]), output = path.resolve(process.argv[5]);
    if (probe.configure(helper, output) !== true) throw new Error('Helper prearm failed');
    const status = probe.snapshot();
    await writeFile(path.join(output, 'child.json'), JSON.stringify({ pid: process.pid, status, kind: 'healthy-snapshot' }));
    if (status !== 0) throw new Error(`Owned snapshot helper exited ${status}`);
  } else {
    const addon = path.resolve(process.argv[2]), helper = path.resolve(process.argv[3]), output = path.resolve(process.argv[4]);
    await mkdir(output, { recursive: true });
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (/^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors)$/i.test(key)) env[key] = value;
    Object.assign(env, { HOME: output, USERPROFILE: output, APPDATA: output, LOCALAPPDATA: output, TMP: output, TEMP: output });
    const child = spawnSync(process.execPath, [`--title=lattice-heap-smoke-${randomUUID()}`, script, '--child', addon, helper, output],
      { env, encoding: 'utf8', timeout: 25000, windowsHide: true });
    await writeFile(path.join(output, 'launch.json'), JSON.stringify({ pid: child.pid, status: child.status, signal: child.signal,
      error: child.error?.message, stdout: child.stdout, stderr: child.stderr }, null, 2));
    if (child.status !== 0 || child.error) throw new Error(`Healthy snapshot child failed: ${child.stderr || child.error}`);
    const receipt = JSON.parse(await readFile(path.join(output, `owned-${child.pid}.dmp.json`), 'utf8'));
    if (!receipt.ok || receipt.pid !== child.pid || receipt.mode !== 1) throw new Error('Healthy snapshot receipt mismatch');
    const file = path.join(output, `owned-${child.pid}.dmp`);
    const streams = await verifyOwnedDump(file, child.pid);
    const bytes = await stat(file);
    // This dedicated healthy process is small; retain the original snapshot.
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
    await writeFile(path.join(output, 'verified.json'), JSON.stringify({ kind: 'healthy-snapshot', receipt, streams, bytes: bytes.size, sha256 }, null, 2));
    process.stdout.write(JSON.stringify({ healthySnapshot: 'verified', pid: child.pid, threads: streams.threads, modules: streams.modules, memory64Ranges: streams.memory64Ranges }) + '\n');
  }
}
