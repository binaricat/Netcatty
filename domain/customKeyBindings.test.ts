import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areCustomKeyBindingsEqual,
  nextCustomKeyBindingsSyncVersion,
  parseCustomKeyBindingsStorageRecord,
  resetCustomKeyBinding,
  resolveKeyBindings,
  serializeCustomKeyBindingsStorageRecord,
  shouldApplyIncomingCustomKeyBindingsRecord,
  updateCustomKeyBinding,
} from './customKeyBindings.ts';
import { DEFAULT_KEY_BINDINGS, keyStringToKeyboardEvent } from './models/keyBindings.ts';
import { checkAppShortcut } from '../application/state/useGlobalHotkeys.ts';

function shortcut(key: string, bindings = DEFAULT_KEY_BINDINGS, isMac = false) {
  const event = keyStringToKeyboardEvent(key);
  assert.ok(event);
  return checkAppShortcut(event, bindings, isMac)?.action ?? null;
}

test('resolving defaults preserves reopen, new tab, and local terminal shortcuts', () => {
  const bindings = resolveKeyBindings(DEFAULT_KEY_BINDINGS, {});

  assert.deepEqual(bindings, DEFAULT_KEY_BINDINGS);
  assert.equal(shortcut('Ctrl + Shift + T', bindings), 'reopenClosedTab');
  assert.equal(shortcut('\u2318 + Shift + T', bindings, true), 'reopenClosedTab');
  assert.equal(shortcut('Ctrl + T', bindings), 'newTab');
  assert.equal(shortcut('\u2318 + L', bindings, true), 'openLocal');
});

test('custom PC open-local evicts the conflicting reopen default only on PC', () => {
  const bindings = resolveKeyBindings(DEFAULT_KEY_BINDINGS, {
    'open-local': { pc: 'Ctrl + Shift + T' },
  });

  assert.equal(bindings.find(binding => binding.id === 'open-local')?.pc, 'Ctrl + Shift + T');
  assert.equal(bindings.find(binding => binding.id === 'reopen-closed-tab')?.pc, 'Disabled');
  assert.equal(shortcut('Ctrl + Shift + T', bindings), 'openLocal');
  assert.equal(shortcut('\u2318 + Shift + T', bindings, true), 'reopenClosedTab');
});

test('custom macOS open-local evicts the conflicting reopen default only on macOS', () => {
  const bindings = resolveKeyBindings(DEFAULT_KEY_BINDINGS, {
    'open-local': { mac: '\u2318 + Shift + T' },
  });

  assert.equal(bindings.find(binding => binding.id === 'open-local')?.mac, '\u2318 + Shift + T');
  assert.equal(bindings.find(binding => binding.id === 'reopen-closed-tab')?.mac, 'Disabled');
  assert.equal(shortcut('\u2318 + Shift + T', bindings, true), 'openLocal');
  assert.equal(bindings.find(binding => binding.id === 'reopen-closed-tab')?.pc, 'Ctrl + Shift + T');
  assert.equal(shortcut('Ctrl + Shift + T', bindings), 'reopenClosedTab');
});

test('unrelated custom shortcuts leave reopen defaults intact', () => {
  const bindings = resolveKeyBindings(DEFAULT_KEY_BINDINGS, {
    'open-local': { pc: 'Ctrl + L' },
  });

  assert.equal(shortcut('Ctrl + L', bindings), 'openLocal');
  assert.equal(shortcut('Ctrl + Shift + T', bindings), 'reopenClosedTab');
  assert.equal(shortcut('\u2318 + Shift + T', bindings, true), 'reopenClosedTab');
});

test('conflicting custom shortcuts remain while uncustomized defaults are evicted', () => {
  const bindings = resolveKeyBindings(DEFAULT_KEY_BINDINGS, {
    'open-local': { pc: 'Ctrl + Shift + T' },
    'open-hosts': { pc: 'Ctrl + Shift + T' },
  });

  assert.equal(bindings.find(binding => binding.id === 'open-local')?.pc, 'Ctrl + Shift + T');
  assert.equal(bindings.find(binding => binding.id === 'open-hosts')?.pc, 'Ctrl + Shift + T');
  assert.equal(bindings.find(binding => binding.id === 'reopen-closed-tab')?.pc, 'Disabled');
});

test('an explicitly customized reopen binding retains its conflicting chord', () => {
  const bindings = resolveKeyBindings(DEFAULT_KEY_BINDINGS, {
    'open-local': { pc: 'Ctrl + Shift + T' },
    'reopen-closed-tab': { pc: 'Ctrl + Shift + T' },
  });

  assert.equal(bindings.find(binding => binding.id === 'open-local')?.pc, 'Ctrl + Shift + T');
  assert.equal(bindings.find(binding => binding.id === 'reopen-closed-tab')?.pc, 'Ctrl + Shift + T');
});

test('resolving conflicts does not mutate defaults or custom overrides', () => {
  const defaults = structuredClone(DEFAULT_KEY_BINDINGS);
  const custom = { 'open-local': { pc: 'Ctrl + Shift + T', mac: 'Disabled' } };
  const originalCustom = structuredClone(custom);

  const bindings = resolveKeyBindings(defaults, custom);

  assert.equal(bindings.find(binding => binding.id === 'open-local')?.mac, 'Disabled');
  assert.deepEqual(defaults, DEFAULT_KEY_BINDINGS);
  assert.deepEqual(custom, originalCustom);
});

test('parses legacy stored custom key bindings without sync metadata', () => {
  const parsed = parseCustomKeyBindingsStorageRecord('{"open":{"mac":"Cmd+K"}}');

  assert.deepEqual(parsed, {
    version: 0,
    origin: 'legacy',
    bindings: {
      open: { mac: 'Cmd+K' },
    },
  });
});

test('round-trips versioned stored custom key bindings', () => {
  const raw = serializeCustomKeyBindingsStorageRecord({
    version: 42,
    origin: 'window-b',
    bindings: {
      open: { pc: 'Ctrl+K' },
    },
  });

  assert.deepEqual(parseCustomKeyBindingsStorageRecord(raw), {
    version: 42,
    origin: 'window-b',
    bindings: {
      open: { pc: 'Ctrl+K' },
    },
  });
});

test('parses plain IPC custom key binding sync payloads', () => {
  const parsed = parseCustomKeyBindingsStorageRecord({
    version: 7,
    origin: 'window-a',
    bindings: {
      open: { pc: 'Ctrl+K' },
    },
  });

  assert.deepEqual(parsed, {
    version: 7,
    origin: 'window-a',
    bindings: {
      open: { pc: 'Ctrl+K' },
    },
  });
});

test('next sync version is monotonic even within the same millisecond', () => {
  assert.equal(nextCustomKeyBindingsSyncVersion(100, 90), 101);
  assert.equal(nextCustomKeyBindingsSyncVersion(100, 150), 150);
});

test('newer incoming records apply and older ones are ignored', () => {
  assert.equal(
    shouldApplyIncomingCustomKeyBindingsRecord(
      { version: 10, origin: 'window-a' },
      { version: 11, origin: 'window-b' },
    ),
    true,
  );
  assert.equal(
    shouldApplyIncomingCustomKeyBindingsRecord(
      { version: 10, origin: 'window-a' },
      { version: 10, origin: 'window-a' },
    ),
    false,
  );
  assert.equal(
    shouldApplyIncomingCustomKeyBindingsRecord(
      { version: 10, origin: 'window-b' },
      { version: 10, origin: 'window-a' },
    ),
    false,
  );
});

test('same-version updates converge by origin tie-breaker', () => {
  assert.equal(
    shouldApplyIncomingCustomKeyBindingsRecord(
      { version: 10, origin: 'window-a' },
      { version: 10, origin: 'window-b' },
    ),
    true,
  );
});

test('update custom key binding keeps other bindings intact', () => {
  const prev = {
    open: { mac: 'Cmd+K' },
    close: { pc: 'Ctrl+W' },
  };

  const next = updateCustomKeyBinding(prev, 'open', 'pc', 'Ctrl+K');

  assert.deepEqual(next, {
    open: { mac: 'Cmd+K', pc: 'Ctrl+K' },
    close: { pc: 'Ctrl+W' },
  });
  assert.equal(areCustomKeyBindingsEqual(prev, {
    open: { mac: 'Cmd+K' },
    close: { pc: 'Ctrl+W' },
  }), true);
});

test('resetting one side of a shortcut does not mutate the previous bindings', () => {
  const prev = {
    open: { mac: 'Cmd+K', pc: 'Ctrl+K' },
  };

  const next = resetCustomKeyBinding(prev, 'open', 'mac');

  assert.deepEqual(next, {
    open: { pc: 'Ctrl+K' },
  });
  assert.deepEqual(prev, {
    open: { mac: 'Cmd+K', pc: 'Ctrl+K' },
  });
});

test('resetting the last side removes the binding entry entirely', () => {
  const next = resetCustomKeyBinding({
    open: { mac: 'Cmd+K' },
  }, 'open', 'mac');

  assert.deepEqual(next, {});
});
