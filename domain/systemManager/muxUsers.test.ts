import assert from 'node:assert/strict';
import test from 'node:test';
import { multiplexerScopeNeedsSudo, sortMultiplexerUsers } from './muxUsers';
import type { MultiplexerUser } from './types';

const user = (name: string, uid: number, hasTmuxSockets = false): MultiplexerUser => ({
  name,
  uid,
  hasTmuxSockets,
});

test('sortMultiplexerUsers puts the current user first, then socket owners, then alphabetical', () => {
  const sorted = sortMultiplexerUsers(
    [user('zeta', 1003), user('alice', 1000, true), user('deploy', 1001), user('bob', 1002, true)],
    'deploy',
  );
  assert.deepEqual(sorted.map((u) => u.name), ['deploy', 'alice', 'bob', 'zeta']);
});

test('sortMultiplexerUsers does not mutate the input array', () => {
  const input = [user('b', 2), user('a', 1)];
  sortMultiplexerUsers(input, '');
  assert.deepEqual(input.map((u) => u.name), ['b', 'a']);
});

test('multiplexerScopeNeedsSudo only for a different non-empty user', () => {
  assert.equal(multiplexerScopeNeedsSudo('alice', 'deploy'), true);
  assert.equal(multiplexerScopeNeedsSudo('deploy', 'deploy'), false);
  assert.equal(multiplexerScopeNeedsSudo('', 'deploy'), false);
});
