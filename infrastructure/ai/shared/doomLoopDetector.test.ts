import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoomLoopState,
  recordDoomLoopResult,
  resetDoomLoopState,
  stableStringify,
} from './doomLoopDetector.ts';

test('stableStringify normalizes object key order', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
});

test('recordDoomLoopResult triggers after repeated identical failures', () => {
  const state = createDoomLoopState();
  const args = { sessionId: 's1', command: 'bad-command' };
  const failure = { error: 'command not found: bad-command' };

  assert.equal(recordDoomLoopResult(state, 'terminal_execute', args, failure).triggered, false);
  assert.equal(recordDoomLoopResult(state, 'terminal_execute', args, failure).triggered, false);
  const third = recordDoomLoopResult(state, 'terminal_execute', { command: 'bad-command', sessionId: 's1' }, failure);
  assert.equal(third.triggered, true);
  assert.equal(third.repeatCount, 3);
});

test('resetDoomLoopState clears paused streak', () => {
  const state = createDoomLoopState();
  recordDoomLoopResult(state, 'tool', {}, { error: 'nope' });
  state.paused = true;
  resetDoomLoopState(state);
  assert.equal(state.repeatCount, 0);
  assert.equal(state.paused, false);
});
