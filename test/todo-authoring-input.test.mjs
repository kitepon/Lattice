import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  matchFlagCommand,
  parseAuthoringJson,
  readAuthoringJsonFile,
  repairAuthoringArtifact,
  resolveAuthoringInputPath,
} from '../src/todo-authoring-input.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';

test('flag parserは順不同を受理し、未知flagと位置引数を拒否する', () => {
  const matched = matchFlagCommand(
    ['done', '--task', 'T1', '--plan', 'main', '--evidence', 'ev.json'],
    ['done'],
    { known: ['plan', 'task', 'evidence'], required: ['plan', 'task', 'evidence'] },
  );
  assert.equal(matched.task, 'T1');
  assert.equal(matched.plan, 'main');
  assert.equal(matched.evidence, 'ev.json');
  assert.equal(matchFlagCommand(
    ['done', '--plan', 'main', '--task', 'T1', 'extra'],
    ['done'],
    { known: ['plan', 'task'], required: ['plan', 'task'] },
  ), null);
  assert.equal(matchFlagCommand(
    ['done', '--plan', 'main', '--task', 'T1', '--unknown', 'x'],
    ['done'],
    { known: ['plan', 'task'], required: ['plan', 'task'] },
  ), null);
});

test('flag parser accepts bare json independently and preserves json-like prose values', () => {
  const matched = matchFlagCommand(
    ['note', '--message', 'literal --json prose', '--json'],
    ['note'],
    { known: ['message'] },
  );
  assert.equal(matched.message, 'literal --json prose');
  assert.equal(matched.json, true);
  assert.equal(matchFlagCommand(
    ['note', '--message', 'text', '--json', 'false'],
    ['note'],
    { known: ['message'] },
  ), null);
});

test('pretty-print JSONとdigest欠落を直し、設計メモは空のままにする', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-authoring-input-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const draft = {
    schema: 'lattice.plan_create_input.v4',
    project_id: 'p1',
    plan_key: 'main',
    plan_version: 'v1',
    actor: { host: 'h', session: 's', agent: 'a' },
    recorded_at: '2026-08-20T00:00:00.000Z',
    tasks: [],
    hard_dependencies: [],
    joins: [],
    phases: [],
    phase_accept_dependencies: [],
    input_digest: '',
  };
  await writeFile(path.join(root, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`);
  const parsed = await readAuthoringJsonFile(root, 'draft.json');
  assert.equal(parsed.input_digest, todoSelfDigest({ ...draft, input_digest: '' }, 'input_digest'));
  assert.equal(repairAuthoringArtifact({ hello: 'world' }).hello, 'world');
  const memo = { schema: 'lattice.todo_extraction.v4', tasks: [{ design_memo: '' }] };
  assert.equal(repairAuthoringArtifact(memo).tasks[0].design_memo, '');
});

test('BOMとCRLFのJSONはparseし、commentは拒否する', () => {
  const value = parseAuthoringJson('\uFEFF{"a":1}\r\n');
  assert.deepEqual(value, { a: 1 });
  assert.throws(() => parseAuthoringJson('{"a":1,}'), { code: 'INVALID_JSON' });
  assert.throws(() => parseAuthoringJson('{"a":1 /* c */}'), { code: 'INVALID_JSON' });
});

test('file引数に本文を渡した時は「fileを取る／文章なら--message」と案内する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-authoring-guidance-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  const prose = 'MS-A2 に bluez 5.85 を導入。hci0 が UP RUNNING。受入を満たす。';
  const proseError = await resolveAuthoringInputPath(root, prose, { inlineFlag: '--message' })
    .then(() => null, (error) => error);
  assert.equal(proseError.code, 'INPUT_UNREADABLE');
  assert.equal(proseError.detail.reason, 'input_missing');
  assert.match(proseError.detail.next_action, /--message <text>/u);
  assert.equal(typeof proseError.detail.repo_root, 'string');

  // --message を持たない入口では、存在しないflagを案内しない
  const noInline = await resolveAuthoringInputPath(root, prose)
    .then(() => null, (error) => error);
  assert.doesNotMatch(noInline.detail.next_action, /--message/u);
  assert.match(noInline.detail.next_action, /file/u);

  // pathらしい値の欠落は「repo内のfile pathを渡す」案内にする
  const missing = await resolveAuthoringInputPath(root, 'docs/nope.md', { inlineFlag: '--message' })
    .then(() => null, (error) => error);
  assert.equal(missing.detail.reason, 'input_missing');
  assert.doesNotMatch(missing.detail.next_action, /--message/u);
});

test('repo外pathは写してから渡すよう案内する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-authoring-outside-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'lattice-authoring-elsewhere-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const stray = path.join(outside, 'evidence.md');
  await writeFile(stray, 'ok\n');

  const error = await resolveAuthoringInputPath(root, stray).then(() => null, (e) => e);
  assert.equal(error.code, 'INPUT_UNREADABLE');
  assert.equal(error.detail.reason, 'input_path_outside_repo');
  assert.match(error.detail.next_action, /repo内へ写して/u);
  assert.equal(typeof error.detail.repo_root, 'string');
});
