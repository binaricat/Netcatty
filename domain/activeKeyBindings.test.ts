import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findActiveSystemShortcutConflict,
  listActiveSystemBindings,
} from './activeKeyBindings.ts';
import { DEFAULT_KEY_BINDINGS, type KeyBinding } from './models/keyBindings.ts';

const withBindingOverride = (
  id: string,
  override: Partial<Pick<KeyBinding, 'mac' | 'pc'>>,
): KeyBinding[] => (
  DEFAULT_KEY_BINDINGS.map((binding) => (
    binding.id === id ? { ...binding, ...override } : binding
  ))
);

test('disabled scheme exposes no active system bindings', () => {
  assert.deepEqual(listActiveSystemBindings('disabled', DEFAULT_KEY_BINDINGS), []);
});

test('disabled scheme does not treat default tab or broadcast keys as occupied', () => {
  assert.equal(
    findActiveSystemShortcutConflict('Ctrl + 1', 'disabled', DEFAULT_KEY_BINDINGS),
    null,
  );
  assert.equal(
    findActiveSystemShortcutConflict('Ctrl + B', 'disabled', DEFAULT_KEY_BINDINGS),
    null,
  );
  assert.equal(
    findActiveSystemShortcutConflict('⌘ + 1', 'disabled', DEFAULT_KEY_BINDINGS),
    null,
  );
});

test('pc scheme reports the tab-switch binding for Ctrl+1', () => {
  const conflict = findActiveSystemShortcutConflict('Ctrl + 1', 'pc', DEFAULT_KEY_BINDINGS);

  assert.equal(conflict?.id, 'switch-tab-1-9');
});

test('pc scheme reports the broadcast binding for Ctrl+B', () => {
  const conflict = findActiveSystemShortcutConflict('Ctrl + B', 'pc', DEFAULT_KEY_BINDINGS);

  assert.equal(conflict?.id, 'broadcast');
});

test('mac scheme does not treat Ctrl+1 as a tab shortcut', () => {
  assert.equal(
    findActiveSystemShortcutConflict('Ctrl + 1', 'mac', DEFAULT_KEY_BINDINGS),
    null,
  );
});

test('mac scheme reports the tab-switch binding for Cmd+1', () => {
  const conflict = findActiveSystemShortcutConflict('⌘ + 1', 'mac', DEFAULT_KEY_BINDINGS);

  assert.equal(conflict?.id, 'switch-tab-1-9');
});

test('a Disabled individual binding is not a conflict', () => {
  const bindings = withBindingOverride('switch-tab-1-9', { pc: 'Disabled' });

  assert.equal(findActiveSystemShortcutConflict('Ctrl + 1', 'pc', bindings), null);
  assert.equal(findActiveSystemShortcutConflict('Ctrl + B', 'pc', bindings)?.id, 'broadcast');
});
