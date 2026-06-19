import test from 'node:test';
import assert from 'node:assert/strict';

import {
  XTERM_UNLIMITED_SCROLLBACK_CAP,
  resolveXTermScrollback,
} from './xtermPerformance';

test('resolveXTermScrollback maps the unlimited sentinel to a 50000 row cap', () => {
  assert.equal(XTERM_UNLIMITED_SCROLLBACK_CAP, 50000);
  assert.equal(resolveXTermScrollback(0), 50000);
});

test('resolveXTermScrollback preserves explicit positive scrollback values', () => {
  assert.equal(resolveXTermScrollback(10000), 10000);
  assert.equal(resolveXTermScrollback(50000), 50000);
});
