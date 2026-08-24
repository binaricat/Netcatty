import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_KEY_BINDINGS, matchesKeyBinding } from './models/keyBindings.ts';
import { getTerminalPassthroughActions } from '../application/state/useGlobalHotkeys.ts';

test('default shortcuts include terminal font size controls', () => {
  const byAction = new Map(DEFAULT_KEY_BINDINGS.map((binding) => [binding.action, binding]));

  assert.equal(byAction.get('increaseTerminalFontSize')?.pc, 'Ctrl + =');
  assert.equal(byAction.get('decreaseTerminalFontSize')?.pc, 'Ctrl + -');
  assert.equal(byAction.get('resetTerminalFontSize')?.pc, 'Ctrl + 0');
  assert.equal(byAction.get('increaseTerminalFontSize')?.category, 'terminal');
  assert.equal(byAction.get('decreaseTerminalFontSize')?.category, 'terminal');
  assert.equal(byAction.get('resetTerminalFontSize')?.category, 'terminal');
});

test('terminal font size shortcuts are handled inside xterm', () => {
  const actions = getTerminalPassthroughActions();

  assert.equal(actions.has('increaseTerminalFontSize'), true);
  assert.equal(actions.has('decreaseTerminalFontSize'), true);
  assert.equal(actions.has('resetTerminalFontSize'), true);
});

test('pane magnification uses Alt+M without colliding with existing defaults', () => {
  const binding = DEFAULT_KEY_BINDINGS.find((entry) => entry.id === 'toggle-pane-zoom');

  assert.equal(binding?.mac, '⌥ + M');
  assert.equal(binding?.pc, 'Alt + M');
  assert.equal(matchesKeyBinding({
    key: 'µ',
    code: 'KeyM',
    metaKey: false,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
  } as KeyboardEvent, binding?.mac ?? '', true), true);

  const duplicatePcShortcuts = DEFAULT_KEY_BINDINGS.filter((entry) => entry.pc === binding?.pc);
  const duplicateMacShortcuts = DEFAULT_KEY_BINDINGS.filter((entry) => entry.mac === binding?.mac);
  assert.deepEqual(duplicatePcShortcuts.map((entry) => entry.id), ['toggle-pane-zoom']);
  assert.deepEqual(duplicateMacShortcuts.map((entry) => entry.id), ['toggle-pane-zoom']);
});
