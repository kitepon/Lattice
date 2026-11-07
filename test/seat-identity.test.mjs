import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveSeatIdentity, seatIdentityFields } from '../src/seat-identity.mjs';

test('未設定の席は無名で、状態は ~/.lattice', () => {
  assert.deepEqual(resolveSeatIdentity({}), { seat_id: null, state_dir: path.join(homedir(), '.lattice') });
  assert.deepEqual(seatIdentityFields({}), {});
});

test('席IDがあれば状態は席ごとの置き場に分かれる', () => {
  const identity = resolveSeatIdentity({ LATTICE_SEAT_ID: 'bot-fc291ae4' });
  assert.equal(identity.seat_id, 'bot-fc291ae4');
  assert.equal(identity.state_dir, path.join(homedir(), '.lattice', 'seats', 'bot-fc291ae4'));
  assert.deepEqual(seatIdentityFields({ LATTICE_SEAT_ID: 'bot-fc291ae4' }), { seat_id: 'bot-fc291ae4' });
});

test('不正な席IDは拒否せず無名に落ちる', () => {
  for (const bad of ['', ' x', 'a/b', '.hidden', 'x'.repeat(65)]) {
    assert.equal(resolveSeatIdentity({ LATTICE_SEAT_ID: bad }).seat_id, null, JSON.stringify(bad));
  }
});

test('LATTICE_CONFIG_DIR は席IDより優先する（既存の挙動を保つ）', () => {
  const root = path.resolve('/tmp/lattice-x');
  assert.equal(resolveSeatIdentity({ LATTICE_SEAT_ID: 'a', LATTICE_CONFIG_DIR: root }).state_dir, root);
});
