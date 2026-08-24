import assert from 'node:assert/strict';
import test from 'node:test';

import { keyEventToString, keyStringToKeyboardEvent, matchesKeyBinding, tabShortcutDigitFromEvent } from './models.ts';

const keyboardEvent = (
  key: string,
  code: string,
  modifiers: Partial<KeyboardEvent> = {},
): KeyboardEvent => ({
  key,
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...modifiers,
}) as KeyboardEvent;

test('shortcut matching falls back to physical keys for non-Latin layouts', () => {
  const event = keyboardEvent('\u0446', 'KeyW', { ctrlKey: true });

  assert.equal(matchesKeyBinding(event, 'Ctrl + W', false), true);
  assert.equal(keyEventToString(event, false), 'Ctrl + W');
});

test('shortcut matching respects Latin characters from non-QWERTY layouts', () => {
  const event = keyboardEvent('w', 'Comma', { ctrlKey: true });

  assert.equal(matchesKeyBinding(event, 'Ctrl + W', false), true);
  assert.equal(matchesKeyBinding(event, 'Ctrl + ,', false), false);
  assert.equal(keyEventToString(event, false), 'Ctrl + W');
});

test('shortcut matching respects non-ASCII Latin layout characters', () => {
  const event = keyboardEvent('ß', 'Minus', { ctrlKey: true });

  assert.equal(matchesKeyBinding(event, 'Ctrl + ß', false), true);
  assert.equal(matchesKeyBinding(event, 'Ctrl + -', false), false);
  assert.equal(keyEventToString(event, false), 'Ctrl + ß');
});

test('shortcut matching respects punctuation characters from non-QWERTY layouts', () => {
  const event = keyboardEvent(',', 'KeyW', { ctrlKey: true });

  assert.equal(matchesKeyBinding(event, 'Ctrl + ,', false), true);
  assert.equal(matchesKeyBinding(event, 'Ctrl + W', false), false);
  assert.equal(keyEventToString(event, false), 'Ctrl + ,');
});

test('shortcut matching keeps physical digit ranges layout-independent', () => {
  const event = keyboardEvent('&', 'Digit1', { ctrlKey: true });

  assert.equal(matchesKeyBinding(event, 'Ctrl + [1...9]', false), true);
  assert.equal(keyEventToString(event, false), 'Ctrl + &');
});

test('shortcut matching preserves shifted number-row symbols', () => {
  const event = keyboardEvent('!', 'Digit1', { ctrlKey: true, shiftKey: true });

  assert.equal(matchesKeyBinding(event, 'Ctrl + Shift + !', false), true);
  assert.equal(matchesKeyBinding(event, 'Ctrl + Shift + 1', false), false);
  assert.equal(keyEventToString(event, false), 'Ctrl + Shift + !');
});

test('shifted digit ranges still match via physical Digit code', () => {
  const event = keyboardEvent('!', 'Digit1', { ctrlKey: true, shiftKey: true });

  assert.equal(matchesKeyBinding(event, 'Ctrl + Shift + [1...9]', false), true);
  assert.equal(tabShortcutDigitFromEvent(event), 1);
});

test('tab shortcut digit falls back to e.key when code is missing', () => {
  assert.equal(tabShortcutDigitFromEvent({ key: '3', code: '' }), 3);
  assert.equal(tabShortcutDigitFromEvent({ key: '!', code: '' }), null);
});

test('stored shortcut strings rebuild matching keyboard events', () => {
  const event = keyStringToKeyboardEvent('Ctrl + 1');
  assert.ok(event);
  assert.equal(event.key, '1');
  assert.equal(event.ctrlKey, true);
  assert.equal(matchesKeyBinding(event, 'Ctrl + [1...9]', false), true);

  const macEvent = keyStringToKeyboardEvent('⌘ + B');
  assert.ok(macEvent);
  assert.equal(macEvent.key, 'b');
  assert.equal(macEvent.metaKey, true);
  assert.equal(matchesKeyBinding(macEvent, '⌘ + B', true), true);
});
