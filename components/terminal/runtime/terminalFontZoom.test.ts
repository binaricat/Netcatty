import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nextTerminalFontSizeForAction,
  nextTerminalFontSizeForWheel,
  shouldHandleTerminalFontSizeAction,
  terminalFontSizeWheelListenerOptions,
} from './terminalFontZoom.ts';

test('terminal font size actions step and reset within bounds', () => {
  assert.equal(nextTerminalFontSizeForAction('increaseTerminalFontSize', 14), 15);
  assert.equal(nextTerminalFontSizeForAction('decreaseTerminalFontSize', 14), 13);
  assert.equal(nextTerminalFontSizeForAction('resetTerminalFontSize', 18), 14);
  assert.equal(nextTerminalFontSizeForAction('increaseTerminalFontSize', 32), 32);
  assert.equal(nextTerminalFontSizeForAction('decreaseTerminalFontSize', 10), 10);
  assert.equal(nextTerminalFontSizeForAction('copy', 14), null);
});

test('terminal font size actions return null when terminal font zoom is disabled', () => {
  assert.equal(nextTerminalFontSizeForAction('increaseTerminalFontSize', 14, true), null);
  assert.equal(nextTerminalFontSizeForAction('decreaseTerminalFontSize', 14, true), null);
  assert.equal(nextTerminalFontSizeForAction('resetTerminalFontSize', 18, true), null);
});

test('terminal font size actions are not handled when terminal font zoom is disabled', () => {
  assert.equal(shouldHandleTerminalFontSizeAction('increaseTerminalFontSize', false), true);
  assert.equal(shouldHandleTerminalFontSizeAction('decreaseTerminalFontSize', false), true);
  assert.equal(shouldHandleTerminalFontSizeAction('resetTerminalFontSize', false), true);
  assert.equal(shouldHandleTerminalFontSizeAction('increaseTerminalFontSize', true), false);
  assert.equal(shouldHandleTerminalFontSizeAction('copy', true), false);
});

test('wheel adjusts terminal font size with the platform modifier only', () => {
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, metaKey: false, deltaY: -1 }, 14, false), 15);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, metaKey: false, deltaY: 1 }, 14, false), 13);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, metaKey: true, deltaY: -1 }, 14, true), 15);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, metaKey: true, deltaY: 1 }, 14, true), 13);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, metaKey: true, deltaY: -1 }, 14, false), null);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, metaKey: false, deltaY: -1 }, 14, true), null);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, metaKey: false, deltaY: -1 }, 14, false), null);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, metaKey: false, deltaY: 0 }, 14, false), null);
});

test('wheel zoom returns null when terminal font zoom is disabled', () => {
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: true, metaKey: false, deltaY: -1 }, 14, false, true), null);
  assert.equal(nextTerminalFontSizeForWheel({ ctrlKey: false, metaKey: true, deltaY: -1 }, 14, true, true), null);
});

test('wheel font-size listener runs before xterm consumes terminal scrolling', () => {
  assert.equal(terminalFontSizeWheelListenerOptions.capture, true);
  assert.equal(terminalFontSizeWheelListenerOptions.passive, false);
});
