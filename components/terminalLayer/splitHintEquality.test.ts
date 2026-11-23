import assert from 'node:assert/strict';
import test from 'node:test';

import { isSameSplitHint } from './splitHintEquality.ts';

const hint = {
  direction: 'vertical' as const,
  position: 'right' as const,
  targetSessionId: 's1',
  rect: { x: 100, y: 0, w: 100, h: 200 },
};

test('isSameSplitHint compares drop hints by value', () => {
  assert.equal(isSameSplitHint(hint, { ...hint, rect: { ...hint.rect } }), true);
  assert.equal(isSameSplitHint(null, null), true);
  assert.equal(isSameSplitHint(hint, null), false);
  assert.equal(isSameSplitHint(hint, { ...hint, position: 'left' }), false);
  assert.equal(isSameSplitHint(hint, { ...hint, targetSessionId: 's2' }), false);
  assert.equal(isSameSplitHint(hint, { ...hint, rect: { ...hint.rect, w: 99 } }), false);
});
