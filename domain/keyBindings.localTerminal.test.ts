import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_KEY_BINDINGS, keyStringToKeyboardEvent } from './models/keyBindings.ts';
import { checkAppShortcut } from '../application/state/useGlobalHotkeys.ts';

function shortcut(key: string, isMac = false, bindings = DEFAULT_KEY_BINDINGS) {
  const event = keyStringToKeyboardEvent(key);
  assert.ok(event);
  return checkAppShortcut(event, bindings, isMac)?.action ?? null;
}

test('default shortcuts leave Ctrl+L available to the terminal on both schemes', () => {
  assert.equal(shortcut('Ctrl + L'), null);
  assert.equal(shortcut('Ctrl + L', true), null);
});

test('local terminal remains available through New Local Tab and the macOS shortcut', () => {
  assert.equal(shortcut('Ctrl + T'), 'newTab');
  assert.equal(shortcut('⌘ + T', true), 'newTab');
  assert.equal(shortcut('⌘ + L', true), 'openLocal');
});

test('an explicitly configured Ctrl+L still opens a local terminal', () => {
  const customBindings = DEFAULT_KEY_BINDINGS.map(binding => binding.id === 'open-local'
    ? { ...binding, pc: 'Ctrl + L' }
    : binding);
  assert.equal(shortcut('Ctrl + L', false, customBindings), 'openLocal');
});
