import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { useServerStats } from './useServerStats';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

for (const scenario of ['retry', 'pause', 'manual'] as const) {
  test(`server stats ${scenario} after three failures`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
    const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
    let calls = 0;
    t.mock.method(netcattyBridge, 'get', () => ({
      getServerStats: async () => {
        calls++;
        return calls <= 3 ? { success: false, error: 'temporary failure' }
          : { success: true, stats: { cpu: 42 } };
      },
    }));
    let current: ReturnType<typeof useServerStats>;
    function Probe({ enabled = true }: { enabled?: boolean }) {
      current = useServerStats({ sessionId: `recovery-${scenario}`, enabled,
        refreshInterval: 5, isSupportedOs: true, isConnected: true });
      return null;
    }
    let root: ReactTestRenderer;
    try {
      await act(async () => { root = create(React.createElement(Probe)); });
      await act(async () => t.mock.timers.tick(2000));
      await act(async () => t.mock.timers.tick(3000));
      await act(async () => t.mock.timers.tick(5000));
      assert.equal(calls, 3);
      assert.equal(current!.error, 'temporary failure');
      if (scenario === 'pause') {
        await act(async () => root!.update(React.createElement(Probe, { enabled: false })));
        await act(async () => t.mock.timers.tick(60_000));
        assert.equal(calls, 3, 'disabled clients must not retry');
        await act(async () => root!.update(React.createElement(Probe)));
        await act(async () => t.mock.timers.tick(1));
      } else if (scenario === 'manual') {
        await act(async () => current!.refresh());
      } else {
        await act(async () => t.mock.timers.tick(29_999));
        assert.equal(calls, 3);
        await act(async () => t.mock.timers.tick(1));
        await act(async () => t.mock.timers.tick(1));
      }
      assert.equal(calls, 4);
      assert.equal(current!.stats.cpu, 42);
      assert.equal(current!.error, null);
      await act(async () => t.mock.timers.tick(5000));
      assert.equal(calls, 5, 'successful recovery must resume normal polling');
    } finally {
      await act(async () => root?.unmount());
      if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      t.mock.timers.reset();
    }
  });
}

test('stats reply after disabling cannot publish or schedule recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
  const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let finish: (result: unknown) => void;
  let calls = 0;
  t.mock.method(netcattyBridge, 'get', () => ({ getServerStats: () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } }));
  let current: ReturnType<typeof useServerStats>;
  function Probe({ enabled }: { enabled: boolean }) {
    current = useServerStats({ sessionId: 'late-disabled', enabled,
      refreshInterval: 5, isSupportedOs: true, isConnected: true });
    return null;
  }
  let root: ReactTestRenderer;
  try {
    await act(async () => { root = create(React.createElement(Probe, { enabled: true })); });
    await act(async () => t.mock.timers.tick(2000));
    assert.equal(calls, 1);
    await act(async () => root!.update(React.createElement(Probe, { enabled: false })));
    await act(async () => finish!({ success: true, stats: { cpu: 99 } }));
    assert.equal(current!.stats.lastUpdated, null);
    assert.equal(current!.isLoading, false);
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(calls, 1);
  } finally {
    await act(async () => root?.unmount());
    if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    t.mock.timers.reset();
  }
});

test('server stats pauses while document is hidden, preserves cached stats, and catches up on visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
  const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

  const visibilityListeners = new Set<() => void>();
  let visibilityState: DocumentVisibilityState = 'visible';
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get visibilityState() { return visibilityState; },
      get hidden() { return visibilityState === 'hidden'; },
      addEventListener(type: string, listener: () => void) {
        if (type === 'visibilitychange') visibilityListeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        if (type === 'visibilitychange') visibilityListeners.delete(listener);
      },
    },
  });

  const setVisibility = async (next: DocumentVisibilityState) => {
    visibilityState = next;
    await act(async () => {
      for (const listener of [...visibilityListeners]) listener();
    });
  };

  let calls = 0;
  t.mock.method(netcattyBridge, 'get', () => ({
    getServerStats: async () => {
      calls += 1;
      return { success: true, stats: { cpu: 20 + calls } };
    },
  }));

  let current: ReturnType<typeof useServerStats>;
  function Probe() {
    current = useServerStats({
      sessionId: 'visibility-pause',
      enabled: true,
      refreshInterval: 5,
      isSupportedOs: true,
      isConnected: true,
    });
    return null;
  }

  let root: ReactTestRenderer;
  try {
    await act(async () => { root = create(React.createElement(Probe)); });
    assert.equal(visibilityListeners.size, 1);

    // Warmup initial fetch at 2000ms
    await act(async () => t.mock.timers.tick(2000));
    assert.equal(calls, 1);
    assert.equal(current!.stats.cpu, 21);

    // Transition to hidden: polling pauses and cached stats stay intact
    await setVisibility('hidden');
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(calls, 1, 'hidden window must not poll server stats');
    assert.equal(current!.stats.cpu, 21, 'cached stats must be preserved while hidden');

    // Return to visible: immediate catch-up fetch (0ms) + resumes 5s polling
    await setVisibility('visible');
    await act(async () => t.mock.timers.tick(0));
    assert.equal(calls, 2, 'returning to visible must trigger immediate catch-up fetch');
    assert.equal(current!.stats.cpu, 22);

    await act(async () => t.mock.timers.tick(5000));
    assert.equal(calls, 3, 'periodic polling must resume after returning to visible');
    assert.equal(current!.stats.cpu, 23);
  } finally {
    await act(async () => root?.unmount());
    assert.equal(visibilityListeners.size, 0, 'visibility listener must detach when all sessions unmount');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    t.mock.timers.reset();
  }
});
