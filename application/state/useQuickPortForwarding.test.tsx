import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import { normalizeTerminalSettings } from '../../domain/models/terminal.ts';
import type { Host, PortForwardingRule } from '../../domain/models.ts';
import type { ListeningPortInfo } from '../../domain/systemManager/types.ts';
import { STORAGE_KEY_PORT_FORWARDING } from '../../infrastructure/config/storageKeys.ts';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge.ts';
import { stopAllPortForwards } from '../../infrastructure/services/portForwardingService.ts';
import type { TerminalSession } from '../../types.ts';
import { resetPortForwardingStateForTests } from './usePortForwardingState.ts';
import {
  resetEphemeralQuickForwardsForTests,
  useQuickPortForwarding,
  type QuickPortForwardingContext,
} from './useQuickPortForwarding.ts';

function installDomGlobals() {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() { return backing.size; },
    clear() { backing.clear(); },
    getItem(key) { return backing.get(key) ?? null; },
    key(index) { return Array.from(backing.keys())[index] ?? null; },
    removeItem(key) { backing.delete(key); },
    setItem(key, value) { backing.set(key, value); },
  };

  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('localStorage', storage);
  setGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  });
  setGlobal('document', {
    visibilityState: 'visible',
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  });

  return {
    backing,
    restore() {
      for (const [key, desc] of previous.entries()) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const savedHost: Host = {
  id: 'host-saved',
  label: 'Prod API',
  hostname: '10.0.0.10',
  port: 22,
  username: 'ubuntu',
  tags: [],
  os: 'linux',
};

const sshSession: TerminalSession = {
  id: 'session-1',
  hostId: savedHost.id,
  hostLabel: savedHost.label,
  username: savedHost.username,
  hostname: savedHost.hostname,
  status: 'connected',
  protocol: 'ssh',
};

const listeningPort: ListeningPortInfo = {
  id: 'tcp|*|5432|100',
  protocol: 'tcp',
  address: '*',
  port: 5432,
  pid: 100,
  processName: 'postgres',
};

function makeContext(overrides: Partial<QuickPortForwardingContext> = {}): QuickPortForwardingContext {
  return {
    session: sshSession,
    sessionHost: savedHost,
    vaultHosts: [savedHost],
    effectiveHosts: [savedHost],
    keys: [],
    identities: [],
    knownHosts: [],
    terminalSettings: normalizeTerminalSettings(),
    ...overrides,
  };
}

test('useQuickPortForwarding creates, reuses, stops, and rolls back failed new rules for saved hosts', async (t) => {
  const env = installDomGlobals();
  resetPortForwardingStateForTests();
  resetEphemeralQuickForwardsForTests();

  const statusHandlers = new Map<string, (status: PortForwardingRule['status'], error?: string | null) => void>();
  let failNextStart: string | null = null;
  const startedPayloads: Array<Record<string, unknown>> = [];
  const stoppedRuleIds: string[] = [];

  t.mock.method(netcattyBridge, 'get', () => ({
    getPortForwardSnapshot: async () => ({ epoch: 'e1', revision: 0, records: [] }),
    subscribePortForwardRuntime: async () => ({ epoch: 'e1', revision: 0, records: [] }),
    onPortForwardRuntime: () => () => undefined,
    unsubscribePortForwardRuntime: async () => undefined,
    onPortForwardStatus: (tunnelId: string, cb: (status: PortForwardingRule['status'], error?: string | null) => void) => {
      statusHandlers.set(tunnelId, cb);
      return () => { statusHandlers.delete(tunnelId); };
    },
    startPortForward: async (options: Record<string, unknown>) => {
      startedPayloads.push(options);
      if (failNextStart) {
        return { success: false, error: failNextStart };
      }
      const tunnelId = String(options.tunnelId);
      statusHandlers.get(tunnelId)?.('active');
      return { success: true, tunnelId, localPort: options.localPort };
    },
    stopPortForwardByRuleId: async (ruleId: string) => {
      stoppedRuleIds.push(ruleId);
      return { stopped: 1, failed: 0, errors: [] };
    },
    stopAllPortForwards: async () => ({ success: true }),
  }));

  let api!: ReturnType<typeof useQuickPortForwarding>;
  const ctx = makeContext();
  function Probe() {
    api = useQuickPortForwarding(ctx);
    return null;
  }

  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(<Probe />);
    });

    assert.equal(api.canForward, true);

    // 1. Failed start of a brand-new rule rolls it back so Vault stays clean.
    failNextStart = 'listen EADDRINUSE: address already in use 127.0.0.1:5432';
    let failedResult!: Awaited<ReturnType<typeof api.startQuickForward>>;
    await act(async () => {
      failedResult = await api.startQuickForward({
        port: listeningPort,
        localPort: 5432,
        bindAddress: '127.0.0.1',
      });
    });
    assert.equal(failedResult.success, false);
    assert.match(failedResult.error ?? '', /EADDRINUSE/);
    assert.equal(api.allRules.length, 0);

    // 2. Successful start persists a local rule and marks it active.
    failNextStart = null;
    let startedResult!: Awaited<ReturnType<typeof api.startQuickForward>>;
    await act(async () => {
      startedResult = await api.startQuickForward({
        port: listeningPort,
        localPort: 15432,
        bindAddress: '127.0.0.1',
      });
    });
    assert.equal(startedResult.success, true);
    assert.equal(api.allRules.length, 1);
    const createdRuleId = startedResult.rule!.id;
    assert.equal(api.allRules[0].status, 'active');
    assert.equal(api.allRules[0].localPort, 15432);
    assert.equal(api.allRules[0].remoteHost, '127.0.0.1');
    assert.equal(api.allRules[0].remotePort, 5432);
    assert.equal(startedPayloads[1]?.reuseTransport, true);
    assert.ok(env.backing.get(STORAGE_KEY_PORT_FORWARDING)?.includes(createdRuleId));

    // 3. Stop transitions rule back to inactive.
    await act(async () => {
      const stopRes = await api.stopQuickForward(api.allRules[0]);
      assert.equal(stopRes.success, true);
    });
    assert.ok(stoppedRuleIds.includes(createdRuleId));
    assert.equal(api.allRules[0].status, 'inactive');

    // 4. Starting again with the same localPort + bindAddress reuses the rule without duplicates.
    let restartedResult!: Awaited<ReturnType<typeof api.startQuickForward>>;
    await act(async () => {
      restartedResult = await api.startQuickForward({
        port: listeningPort,
        localPort: 15432,
        bindAddress: '127.0.0.1',
      });
    });
    assert.equal(restartedResult.success, true);
    assert.equal(restartedResult.rule?.id, createdRuleId);
    assert.equal(api.allRules.length, 1);

    // 5. Failure on a reused pre-existing rule must NOT delete it.
    await act(async () => {
      await api.stopQuickForward(api.allRules[0]);
    });
    failNextStart = 'listen EADDRINUSE';
    await act(async () => {
      const res = await api.startQuickForward({
        port: listeningPort,
        localPort: 15432,
        bindAddress: '127.0.0.1',
      });
      assert.equal(res.success, false);
    });
    assert.equal(api.allRules.length, 1);
    assert.equal(api.allRules[0].id, createdRuleId);
  } finally {
    await stopAllPortForwards();
    await act(async () => {
      root?.unmount();
    });
    resetPortForwardingStateForTests();
    resetEphemeralQuickForwardsForTests();
    env.restore();
  }
});

test('useQuickPortForwarding keeps unsaved quick-connect tunnels in memory without polluting localStorage', async (t) => {
  const env = installDomGlobals();
  resetPortForwardingStateForTests();
  resetEphemeralQuickForwardsForTests();

  const statusHandlers = new Map<string, (status: PortForwardingRule['status'], error?: string | null) => void>();
  t.mock.method(netcattyBridge, 'get', () => ({
    getPortForwardSnapshot: async () => ({ epoch: 'e1', revision: 0, records: [] }),
    subscribePortForwardRuntime: async () => ({ epoch: 'e1', revision: 0, records: [] }),
    onPortForwardRuntime: () => () => undefined,
    unsubscribePortForwardRuntime: async () => undefined,
    onPortForwardStatus: (tunnelId: string, cb: (status: PortForwardingRule['status'], error?: string | null) => void) => {
      statusHandlers.set(tunnelId, cb);
      return () => { statusHandlers.delete(tunnelId); };
    },
    startPortForward: async (options: Record<string, unknown>) => {
      const tunnelId = String(options.tunnelId);
      statusHandlers.get(tunnelId)?.('active');
      return { success: true, tunnelId, localPort: options.localPort };
    },
    stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
    stopAllPortForwards: async () => ({ success: true }),
  }));

  const quickHost: Host = {
    ...savedHost,
    id: 'quick-connect-1',
    ephemeral: true,
  };
  const quickSession: TerminalSession = {
    ...sshSession,
    hostId: quickHost.id,
  };

  let api!: ReturnType<typeof useQuickPortForwarding>;
  const ctx = makeContext({
    session: quickSession,
    sessionHost: quickHost,
    vaultHosts: [],
    effectiveHosts: [],
  });
  function Probe() {
    api = useQuickPortForwarding(ctx);
    return null;
  }

  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(<Probe />);
    });

    assert.equal(api.canForward, true);

    await act(async () => {
      const res = await api.startQuickForward({
        port: listeningPort,
        localPort: 25432,
        bindAddress: '127.0.0.1',
      });
      assert.equal(res.success, true);
    });

    assert.equal(api.allRules.length, 1);
    assert.equal(api.allRules[0].status, 'active');
    assert.equal(env.backing.get(STORAGE_KEY_PORT_FORWARDING), undefined);

    await act(async () => {
      const stopRes = await api.stopQuickForward(api.allRules[0]);
      assert.equal(stopRes.success, true);
    });
    assert.equal(api.allRules.length, 0);
  } finally {
    await stopAllPortForwards();
    await act(async () => {
      root?.unmount();
    });
    resetPortForwardingStateForTests();
    resetEphemeralQuickForwardsForTests();
    env.restore();
  }
});
