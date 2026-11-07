import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { usePluginManager } from './usePluginManager';

test('failed manager refresh marks previous enabled state unknown until a successful read', async (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const actPrevious = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  let fail = false;
  const plugin = { id: 'com.example.synthetic', enabled: true } as NetcattyInstalledPlugin;
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, netcatty: {
      async getPluginRuntimeStatus() { return { available: true }; },
      async listPlugins() { if (fail) throw new Error('synthetic status read failed'); return [plugin]; },
    },
  } });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
    if (actPrevious) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actPrevious); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  let state!: ReturnType<typeof usePluginManager>;
  function Probe() { state = usePluginManager(); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Probe)); });
  try {
    assert.equal(state.statusKnown, true);
    assert.equal(state.plugins[0].enabled, true);
    fail = true;
    await act(async () => { await assert.rejects(state.refresh(), /synthetic status read failed/); });
    assert.equal(state.statusKnown, false);
    assert.match(state.error ?? '', /synthetic status read failed/);
    fail = false; plugin.enabled = false;
    await act(async () => { await state.refresh(); });
    assert.equal(state.statusKnown, true);
    assert.equal(state.plugins[0].enabled, false);
  } finally { await act(async () => { renderer.unmount(); }); }
});
