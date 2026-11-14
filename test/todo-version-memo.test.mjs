// perf-store: retained-version reads are memoized per process while the files are unchanged.
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { memoByFileIdentity } from '../src/todo-version-memo.mjs';

test('a value is computed once per unchanged file set and again when a file appears, changes or fails', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-version-memo-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = [path.join(root, 'plan.json'), path.join(root, 'revision.json')];
  let calls = 0;
  const read = () => memoByFileIdentity(files, async () => { calls += 1; return calls; });
  await writeFile(files[0], 'a');
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  await writeFile(files[1], 'r');
  assert.equal(await read(), 2);
  await writeFile(`${files[0]}.tmp`, 'a');
  await rename(`${files[0]}.tmp`, files[0]);
  assert.equal(await read(), 3);
  await assert.rejects(memoByFileIdentity([path.join(root, 'x')], async () => { throw new Error('boom'); }), /boom/u);
  assert.equal(await memoByFileIdentity([path.join(root, 'x')], async () => 'ok'), 'ok');
});
