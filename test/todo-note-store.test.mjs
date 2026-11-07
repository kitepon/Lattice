import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withStoreLock } from '../src/store-lock.mjs';

import {
  TodoNoteStoreError,
  appendTodoNote,
  readTodoNoteEvents,
} from '../src/todo-note-store.mjs';

const ACTOR = { host: 'codex', session: 'note-store', agent: 'bell' };
const WHEN = '2026-08-01T00:00:00.000Z';

async function fixture(t) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-note-store-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const lifecycle = {
    manifest: path.join(repoRoot, '.lattice/todo/manifest.json'),
    journal: path.join(repoRoot, '.lattice/todo/plans/plan-a/v1/journal/active.jsonl'),
    snapshot: path.join(repoRoot, '.lattice/todo/plans/plan-a/v1/snapshot.json'),
  };
  await mkdir(path.dirname(lifecycle.journal), { recursive: true });
  await writeFile(lifecycle.manifest, 'manifest-before\n');
  await writeFile(lifecycle.journal, 'journal-before\n');
  await writeFile(lifecycle.snapshot, 'snapshot-before\n');
  return { repoRoot, lifecycle };
}

function input(repoRoot, overrides = {}) {
  return {
    repoRoot,
    projectId: 'lattice',
    planKey: 'plan-a',
    planVersion: 'v1',
    taskId: 'task-001',
    actor: ACTOR,
    recordedAt: WHEN,
    body: '境界を先に固定する。',
    supersedes: null,
    eligibleSupersedes: [],
    ...overrides,
  };
}

test('note追記は独立chainだけを変更しlifecycle三artifactを一切変更しない', async (t) => {
  const { repoRoot, lifecycle } = await fixture(t);
  const before = await Promise.all(Object.values(lifecycle).map((ref) => readFile(ref)));

  const first = await appendTodoNote(input(repoRoot));
  assert.equal(first.sequence, 1);
  assert.equal(first.previous_digest, null);
  const read = await readTodoNoteEvents({ repoRoot, planKey: 'plan-a' });
  assert.deepEqual(read.events, [first]);
  assert.equal(read.head_digest, first.event_digest);

  const after = await Promise.all(Object.values(lifecycle).map((ref) => readFile(ref)));
  assert.deepEqual(after, before);
});

test('追記はdense sequenceとdigest linkを形成し訂正先を同一taskへ制限する', async (t) => {
  const { repoRoot } = await fixture(t);
  const first = await appendTodoNote(input(repoRoot));
  const correction = await appendTodoNote(input(repoRoot, {
    body: '訂正: store境界を先に固定する。',
    supersedes: first.event_digest,
    eligibleSupersedes: [first.event_digest],
  }));
  assert.equal(correction.sequence, 2);
  assert.equal(correction.previous_digest, first.event_digest);

  await assert.rejects(() => appendTodoNote(input(repoRoot, {
    taskId: 'task-002', supersedes: first.event_digest,
  })), (error) => error instanceof TodoNoteStoreError
    && error.code === 'NOTE_SUPERSEDES_INVALID');

  await assert.rejects(() => appendTodoNote(input(repoRoot, {
    planVersion: 'v2', supersedes: first.event_digest,
  })), (error) => error instanceof TodoNoteStoreError
    && error.code === 'NOTE_SUPERSEDES_INVALID');

  const migratedCorrection = await appendTodoNote(input(repoRoot, {
    taskId: 'task-002', planVersion: 'v2', supersedes: first.event_digest,
    eligibleSupersedes: [first.event_digest],
  }));
  assert.equal(migratedCorrection.supersedes, first.event_digest);
});

test('1 MiBを超える追記は既存active segmentをsealしてchainを継続する', async (t) => {
  const { repoRoot } = await fixture(t);
  for (let index = 0; index < 66; index += 1) {
    await appendTodoNote(input(repoRoot, { body: `${index}:`.padEnd(16_000, 'x') }));
  }
  const sealed = await readdir(path.join(repoRoot, '.lattice/todo/notes/plan-a/sealed'));
  assert.equal(sealed.length, 1);
  assert.match(sealed[0], /^\d{12}-\d{12}-[0-9a-f]{64}-[0-9a-f]{64}\.jsonl$/u);
  const read = await readTodoNoteEvents({ repoRoot, planKey: 'plan-a' });
  assert.equal(read.events.length, 66);
  assert.equal(read.events.at(-1).sequence, 66);
});

test('非canonical bytes・digest切断・壊れたJSONはNOTE_LOG_CORRUPTでfail closedになる', async (t) => {
  const { repoRoot } = await fixture(t);
  await appendTodoNote(input(repoRoot));
  const active = path.join(repoRoot, '.lattice/todo/notes/plan-a/active.jsonl');
  const bytes = await readFile(active, 'utf8');
  await writeFile(active, ` ${bytes}`);

  await assert.rejects(() => readTodoNoteEvents({ repoRoot, planKey: 'plan-a' }),
    (error) => error instanceof TodoNoteStoreError && error.code === 'NOTE_LOG_CORRUPT');
  await assert.rejects(() => appendTodoNote(input(repoRoot)),
    (error) => error instanceof TodoNoteStoreError && error.code === 'NOTE_LOG_CORRUPT');
});

test('dead note owner is recovered before replay; live owner keeps NOTE_WRITE_CONFLICT', async (t) => {
  const { repoRoot, lifecycle } = await fixture(t);
  const first = await appendTodoNote(input(repoRoot));
  const before = await Promise.all(Object.values(lifecycle).map((ref) => readFile(ref)));
  const lockPath = path.join(repoRoot, '.lattice/todo/notes/.write.lock');
  const moduleUrl = new URL('../src/store-lock.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {withStoreLock} from ${JSON.stringify(moduleUrl)};
    await withStoreLock({lockPath:${JSON.stringify(lockPath)}},()=>process.exit(0));
  `]);
  const second = await appendTodoNote(input(repoRoot, { body: 'Recovered append.' }));
  assert.equal(second.previous_digest, first.event_digest);
  assert.deepEqual((await readTodoNoteEvents({ repoRoot, planKey: 'plan-a' })).events, [first, second]);
  await withStoreLock({ lockPath }, async () => {
    const locked = await readFile(lockPath);
    await assert.rejects(appendTodoNote(input(repoRoot)), (error) =>
      error instanceof TodoNoteStoreError && error.code === 'NOTE_WRITE_CONFLICT'
        && error.detail.reason === 'note_store_locked');
    assert.deepEqual(await readFile(lockPath), locked);
  });
  assert.deepEqual(await Promise.all(Object.values(lifecycle).map((ref) => readFile(ref))), before);
});
