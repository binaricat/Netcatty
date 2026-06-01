import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextTerminalFontSizeForAction,
  nextTerminalFontSizeForWheel,
} from './terminalFontZoom.ts';

test('terminal font size actions step and reset within bounds', () => {
  assert.equal(nextTerminalFontSizeForAction('increaseTerminalFontSize', 14), 15);
  assert.equal(nextTerminalFontSizeForAction('decreaseTerminalFontSize', 14), 13);
  assert.equal(nextTerminalFontSizeForAction('resetTerminalFontSize', 18), 14);
  assert.equal(nextTerminalFontSizeForAction('increaseTerminalFontSize', 32), 32);
  assert.equal(nextTerminalFontSizeForAction('decreaseTerminalFontSize', 10), 10);
  assert.equal(nextTerminalFontSizeForAction('copy', 14), null);
});

test('ctrl wheel adjusts terminal font size without hijacking plain scroll', () => {
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, deltaY: -1 }, 14), 15);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, deltaY: 1 }, 14), 13);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, deltaY: -1 }, 14), null);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, deltaY: 0 }, 14), null);
});
