import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptFindings } from '../src/runtime-pull-intake.mjs';

test('予定より増えた自分の書き込みは完了サインを止めない', () => {
  const result = acceptFindings('hmer-003', [
    { kind: 'undeclared_write', todo_ids: ['hmer-003'], path: 'rag/INDEX.md' },
    { kind: 'undeclared_write', todo_ids: ['hmer-003'], path: 'docs/document-registry.json' },
    { kind: 'undeclared_write', todo_ids: ['hmer-003'], path: 'rag/INDEX.md' },
  ]);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.added_paths, [
    'docs/document-registry.json',
    'rag/INDEX.md',
  ]);
});

test('他タスクとの書き込み衝突は完了サインを止める', () => {
  const conflict = {
    kind: 'observed_write_conflict',
    todo_ids: ['hmer-003', 'hmer-004'],
    path: 'lib/orchestrate/model-candidates.json',
  };
  const result = acceptFindings('hmer-003', [
    { kind: 'undeclared_write', todo_ids: ['hmer-003'], path: 'docs/plan.md' },
    conflict,
  ]);
  assert.deepEqual(result.blocking, [conflict]);
  assert.deepEqual(result.added_paths, ['docs/plan.md']);
});
