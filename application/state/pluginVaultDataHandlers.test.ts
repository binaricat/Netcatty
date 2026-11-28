import test from 'node:test';
import assert from 'node:assert/strict';
import type { Host, PortForwardingRule } from '../../domain/models';
import { STORAGE_KEY_PORT_FORWARDING } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import type { PortForwardingConnection } from '../../infrastructure/services/portForwardingService';
import {
  handlePluginVaultDataRequest,
  type PluginPortForwardRuntimeDeps,
  type PluginVaultDataContext,
} from './pluginVaultDataHandlers';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const previous = (globalThis as Record<string, unknown>).localStorage;
  const mockStorage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.has(key) ? store.get(key)! : null; },
    key(index: number) { return Array.from(store.keys())[index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: previous,
      configurable: true,
      writable: true,
    });
  };
}

const sampleHost: Host = {
  id: 'host-1',
  label: 'Prod Bastion',
  hostname: '10.0.0.10',
  port: 22,
  username: 'ubuntu',
  os: 'linux',
  group: '',
  tags: [],
  protocol: 'ssh',
};

const sampleRules: PortForwardingRule[] = [
  {
    id: 'rule-active',
    label: 'DB Tunnel',
    type: 'local',
    localPort: 15432,
    bindAddress: '127.0.0.1',
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    hostId: 'host-1',
    status: 'inactive',
    createdAt: 1000,
  },
  {
    id: 'rule-err',
    label: 'Redis Tunnel',
    type: 'local',
    localPort: 16379,
    bindAddress: '127.0.0.1',
    remoteHost: '127.0.0.1',
    remotePort: 6379,
    hostId: 'host-1',
    status: 'inactive',
    createdAt: 2000,
  },
];

function makeContext(portForwardRuntime: PluginPortForwardRuntimeDeps): PluginVaultDataContext {
  return {
    getVault: () => ({
      hosts: [sampleHost],
      keys: [],
      identities: [],
      knownHosts: [],
      groupConfigs: [],
      proxyProfiles: [],
      snippets: [],
      customGroups: [],
      updateHosts: () => {},
      updateSnippets: () => {},
      readCurrentHostActionState: () => ({
        hosts: [sampleHost],
        keys: [],
        identities: [],
        knownHosts: [],
        groupConfigs: [],
        proxyProfiles: [],
        snippets: [],
        customGroups: [],
      }),
    }) as never,
    resources: {} as never,
    portForwardRuntime,
  };
}

test('portForward.list overlays live runtime status and error over persisted inactive rules', async () => {
  const restore = installMemoryLocalStorage();
  try {
    localStorageAdapter.write(STORAGE_KEY_PORT_FORWARDING, sampleRules);
    const activeConns = new Map<string, PortForwardingConnection>([
      ['rule-active', { ruleId: 'rule-active', tunnelId: 't-1', status: 'active' }],
    ]);
    const runtimeRules: PortForwardingRule[] = [
      { ...sampleRules[0], status: 'active' },
      { ...sampleRules[1], status: 'error', error: 'EADDRINUSE: port 16379 busy' },
    ];
    const ctx = makeContext({
      getActiveConnection: (id) => activeConns.get(id),
      getRuntimeRules: () => runtimeRules,
    });

    const result = await handlePluginVaultDataRequest('portForward.list', {}, ctx) as {
      rules: Array<{ id: string; status: string; error?: string }>;
    };
    const byId = new Map(result.rules.map((r) => [r.id, r]));
    assert.equal(byId.get('rule-active')?.status, 'active');
    assert.equal(byId.get('rule-active')?.error, undefined);
    assert.equal(byId.get('rule-err')?.status, 'error');
    assert.equal(byId.get('rule-err')?.error, 'EADDRINUSE: port 16379 busy');
  } finally {
    restore();
  }
});

test('portForward.start and portForward.stop return live runtime status instead of stripped storage inactive', async () => {
  const restore = installMemoryLocalStorage();
  try {
    localStorageAdapter.write(STORAGE_KEY_PORT_FORWARDING, [sampleRules[0]]);
    const activeConns = new Map<string, PortForwardingConnection>();
    const appliedStatuses: Array<{ ruleId: string; status: string; error?: string }> = [];
    let runtimeRules: PortForwardingRule[] = [{ ...sampleRules[0], status: 'inactive' }];

    const ctx = makeContext({
      getActiveConnection: (id) => activeConns.get(id),
      getRuntimeRules: () => runtimeRules,
      applyRuntimeStatus: (ruleId, status, error) => {
        appliedStatuses.push({ ruleId, status, error });
        runtimeRules = runtimeRules.map((r) => (r.id === ruleId ? { ...r, status, error } : r));
      },
      startPortForward: async (rule, _host, _hosts, _keys, _ids, onStatusChange) => {
        onStatusChange?.('connecting');
        activeConns.set(rule.id, { ruleId: rule.id, tunnelId: 't-live', status: 'active' });
        onStatusChange?.('active');
        return { success: true };
      },
      stopAndCleanupRule: async (ruleId) => {
        activeConns.delete(ruleId);
        return { success: true };
      },
    });

    const started = await handlePluginVaultDataRequest(
      'portForward.start',
      { ruleId: 'rule-active' },
      ctx,
    ) as { ok: boolean; rule: { id: string; status: string; error?: string } };
    assert.equal(started.ok, true);
    assert.equal(started.rule.status, 'active');
    assert.equal(started.rule.error, undefined);
    assert.ok(appliedStatuses.some((entry) => entry.ruleId === 'rule-active' && entry.status === 'active'));

    // Subsequent list also reports active
    const listed = await handlePluginVaultDataRequest('portForward.list', {}, ctx) as {
      rules: Array<{ id: string; status: string }>;
    };
    assert.equal(listed.rules[0]?.status, 'active');

    // Stop transitions cleanly back to inactive
    const stopped = await handlePluginVaultDataRequest(
      'portForward.stop',
      { ruleId: 'rule-active' },
      ctx,
    ) as { ok: boolean; rule: { id: string; status: string } };
    assert.equal(stopped.ok, true);
    assert.equal(stopped.rule.status, 'inactive');
  } finally {
    restore();
  }
});

test('portForward.start surfaces live error status and message when tunnel start fails', async () => {
  const restore = installMemoryLocalStorage();
  try {
    localStorageAdapter.write(STORAGE_KEY_PORT_FORWARDING, [sampleRules[1]]);
    let runtimeRules: PortForwardingRule[] = [{ ...sampleRules[1], status: 'inactive' }];
    const ctx = makeContext({
      getActiveConnection: () => undefined,
      getRuntimeRules: () => runtimeRules,
      applyRuntimeStatus: (ruleId, status, error) => {
        runtimeRules = runtimeRules.map((r) => (r.id === ruleId ? { ...r, status, error } : r));
      },
      startPortForward: async (_rule, _host, _hosts, _keys, _ids, onStatusChange) => {
        onStatusChange?.('error', 'Connection refused');
        return { success: false, error: 'Connection refused' };
      },
    });

    const started = await handlePluginVaultDataRequest(
      'portForward.start',
      { ruleId: 'rule-err' },
      ctx,
    ) as { ok: boolean; rule: { id: string; status: string; error?: string }; error?: string };
    assert.equal(started.ok, false);
    assert.equal(started.rule.status, 'error');
    assert.equal(started.rule.error, 'Connection refused');
    assert.equal(started.error, 'Connection refused');
  } finally {
    restore();
  }
});
