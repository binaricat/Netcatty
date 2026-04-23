import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areCustomKeyBindingsEqual,
  nextCustomKeyBindingsSyncVersion,
  parseCustomKeyBindingsStorageRecord,
  resetCustomKeyBinding,
  serializeCustomKeyBindingsStorageRecord,
  shouldApplyIncomingCustomKeyBindingsRecord,
  updateCustomKeyBinding,
} from './customKeyBindings.ts';

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
