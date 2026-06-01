import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_KEY_BINDINGS } from './models/keyBindings.ts';
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
