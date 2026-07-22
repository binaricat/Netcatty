import test from "node:test";
import assert from "node:assert/strict";

import {
  runPortForwardingAutoStart,
  subscribeToPortForwardingNetworkRecovery,
  getAutoStartRuleBlockReason,
  isAutoStartProxyReady,
  isPortForwardingAutoStartEnabled,
} from "./usePortForwardingAutoStart.ts";
import type { GroupConfig, Host, PortForwardingRule, ProxyProfile } from "../../domain/models.ts";
import { STORAGE_KEY_PORT_FORWARDING } from "../../infrastructure/config/storageKeys.ts";
import {
  getActiveConnection,
  setReconnectCallback,
  startPortForward,
  stopPortForward,
  stopAndCleanupRuleAndWait,
} from "../../infrastructure/services/portForwardingService.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

const proxyProfile = (id: string): ProxyProfile => ({
  id,
  label: "Proxy",
  config: { type: "http", host: "proxy.example.com", port: 3128 },
  createdAt: 1,
});

const rule = (overrides: Partial<PortForwardingRule> = {}): PortForwardingRule => ({
  id: "rule-1",
  label: "Rule",
  type: "local",
  localPort: 8080,
  bindAddress: "127.0.0.1",
  remoteHost: "127.0.0.1",
  remotePort: 80,
  hostId: "host-1",
  autoStart: true,
  status: "inactive",
  createdAt: 1,
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const installStorage = () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() { return backing.size; },
    clear() { backing.clear(); },
    getItem(key) { return backing.get(key) ?? null; },
    key(index) { return Array.from(backing.keys())[index] ?? null; },
    removeItem(key) { backing.delete(key); },
    setItem(key, value) { backing.set(key, value); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return {
    storage,
    restore() {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
};

const autoStartOptions = (hosts: Host[]) => ({
  hosts,
  keys: [],
  identities: [],
  proxyProfiles: [],
  groupConfigs: [],
  knownHosts: [],
  isHostAuthReady: () => true,
  resolveEffectiveHost: (currentHost: Host) => currentHost,
  updateStoredRuleStatus: () => undefined,
});

test("isAutoStartProxyReady waits when a host saved proxy is unresolved", () => {
  assert.equal(
    isAutoStartProxyReady(
      host({ proxyProfileId: "missing-proxy" }),
      [],
      [],
      [],
    ),
    false,
  );
});

test("isAutoStartProxyReady waits when a missing host proxy has a group fallback", () => {
  const groupConfigs: GroupConfig[] = [{ path: "prod", proxyProfileId: "group-proxy" }];
  const currentHost = host({ group: "prod", proxyProfileId: "missing-proxy" });

  assert.equal(
    isAutoStartProxyReady(
      currentHost,
      [currentHost],
      [proxyProfile("group-proxy")],
      groupConfigs,
    ),
    false,
  );
});

test("isAutoStartProxyReady waits when a group saved proxy is unresolved", () => {
  const groupConfigs: GroupConfig[] = [{ path: "prod", proxyProfileId: "missing-proxy" }];
  const currentHost = host({ group: "prod" });

  assert.equal(
    isAutoStartProxyReady(
      currentHost,
      [currentHost],
      [],
      groupConfigs,
    ),
    false,
  );
});

test("isAutoStartProxyReady checks group-inherited jump hosts", () => {
  const currentHost = host({ group: "prod" });
  const jumpHost = host({ id: "jump-1", proxyProfileId: "missing-proxy" });

  assert.equal(
    isAutoStartProxyReady(
      currentHost,
      [currentHost, jumpHost],
      [],
      [{ path: "prod", hostChain: { hostIds: ["jump-1"] } }],
    ),
    false,
  );
});

test("getAutoStartRuleBlockReason only blocks the affected rule", () => {
  const goodHost = host();
  const badHost = host({ id: "host-2", proxyProfileId: "missing-proxy" });
  const hosts = [goodHost, badHost];
  const isHostAuthReady = () => true;

  assert.equal(
    getAutoStartRuleBlockReason(rule({ id: "good", hostId: "host-1" }), hosts, [], [], isHostAuthReady),
    undefined,
  );
  assert.equal(
    getAutoStartRuleBlockReason(rule({ id: "bad", hostId: "host-2" }), hosts, [], [], isHostAuthReady),
    "Proxy or jump host configuration is not ready",
  );
});

test("getAutoStartRuleBlockReason marks rules without a host", () => {
  assert.equal(
    getAutoStartRuleBlockReason(rule({ hostId: undefined }), [], [], [], () => true),
    "Rule host is not configured",
  );
});

test("reconnect eligibility follows the current auto-start setting", () => {
  assert.equal(isPortForwardingAutoStartEnabled([rule({ autoStart: true })], "rule-1"), true);
  assert.equal(isPortForwardingAutoStartEnabled([rule({ autoStart: false })], "rule-1"), false);
  assert.equal(isPortForwardingAutoStartEnabled([], "rule-1"), false);
});

test("network recovery starts an exhausted auto-start rule through the real service path", async (t) => {
  const env = installStorage();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let onlineListener: (() => void) | undefined;
  const startedRuleIds: string[] = [];
  const exhaustedStartResult = deferred<{ success: boolean; error: string }>();
  let preparingExhaustedRule = true;
  const backendSnapshot = deferred<[]>();
  let snapshotCalls = 0;
  const target = {
    addEventListener(type: string, listener: () => void) {
      if (type === "online") onlineListener = listener;
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "online" && onlineListener === listener) onlineListener = undefined;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => {
          snapshotCalls++;
          return backendSnapshot.promise;
        },
        startPortForward: async ({ ruleId }: { ruleId: string }) => {
          startedRuleIds.push(ruleId);
          if (ruleId === "exhausted" && preparingExhaustedRule) {
            return exhaustedStartResult.promise;
          }
          return { success: true };
        },
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  t.after(async () => {
    await Promise.all([
      stopAndCleanupRuleAndWait("exhausted"),
      stopAndCleanupRuleAndWait("already-active"),
    ]);
    setReconnectCallback(null);
    env.restore();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const rules = [
    rule({ id: "exhausted", autoStart: true }),
    rule({ id: "already-active", autoStart: true }),
    rule({ id: "manually-stopped", autoStart: true, status: "inactive" }),
    rule({ id: "manual", autoStart: false }),
  ];
  env.storage.setItem(STORAGE_KEY_PORT_FORWARDING, JSON.stringify(rules));
  setReconnectCallback(async () => ({ success: true }));
  const exhaustedStart = startPortForward(
    rules[0]!,
    host(),
    [host()],
    [],
    [],
    () => undefined,
    true,
  );
  const exhaustedConnection = getActiveConnection("exhausted");
  assert.ok(exhaustedConnection);
  exhaustedConnection.reconnectAttempts = 5;
  exhaustedStartResult.resolve({ success: false, error: "offline socket" });
  await exhaustedStart;
  preparingExhaustedRule = false;

  await startPortForward(
    rules[1]!,
    host(),
    [host()],
    [],
    [],
    () => undefined,
    true,
  );
  startedRuleIds.length = 0;

  const unsubscribe = subscribeToPortForwardingNetworkRecovery(target, (recoveryRuleIds) =>
    runPortForwardingAutoStart({
      ...autoStartOptions([host()]),
      recoveryRuleIds,
    }),
  );

  onlineListener?.();
  onlineListener?.();
  assert.equal(snapshotCalls, 1);
  backendSnapshot.resolve([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(startedRuleIds, ["exhausted"]);

  unsubscribe();
  assert.equal(onlineListener, undefined);
});

test("network recovery refreshes retries for a connecting final attempt", async (t) => {
  const env = installStorage();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const startResult = deferred<{ success: boolean; error: string }>();
  let onlineListener: (() => void) | undefined;
  const target = {
    addEventListener(type: string, listener: () => void) {
      if (type === "online") onlineListener = listener;
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "online" && onlineListener === listener) onlineListener = undefined;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [],
        startPortForward: async () => startResult.promise,
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  const retryingRule = rule({ id: "recovering-final-attempt", autoStart: true });
  env.storage.setItem(STORAGE_KEY_PORT_FORWARDING, JSON.stringify([retryingRule]));
  setReconnectCallback(async () => ({ success: true }));
  const unsubscribe = subscribeToPortForwardingNetworkRecovery(target, (recoveryRuleIds) =>
    runPortForwardingAutoStart({
      ...autoStartOptions([host()]),
      recoveryRuleIds,
    }),
  );
  t.after(async () => {
    unsubscribe();
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait(retryingRule.id);
    env.restore();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const pendingStart = startPortForward(
    retryingRule,
    host(),
    [host()],
    [],
    [],
    () => undefined,
    true,
  );
  const connection = getActiveConnection(retryingRule.id);
  assert.ok(connection);
  connection.reconnectAttempts = 5;

  onlineListener?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(connection.reconnectAttempts, 0);

  startResult.resolve({ success: false, error: "offline socket" });
  await pendingStart;
  assert.equal(connection.reconnectAttempts, 1);
  assert.ok(connection.reconnectTimerCallback);
});

test("manual stop cancels an exhausted recovery while backend sync is pending", async (t) => {
  const env = installStorage();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const exhaustedStartResult = deferred<{ success: boolean; error: string }>();
  const backendSnapshot = deferred<[]>();
  const stopResult = deferred<{ stopped: number; failed: number; errors: string[] }>();
  const startedRuleIds: string[] = [];
  let preparingExhaustedRule = true;
  let onlineListener: (() => void) | undefined;
  const target = {
    addEventListener(type: string, listener: () => void) {
      if (type === "online") onlineListener = listener;
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "online" && onlineListener === listener) onlineListener = undefined;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => backendSnapshot.promise,
        startPortForward: async ({ ruleId }: { ruleId: string }) => {
          startedRuleIds.push(ruleId);
          if (preparingExhaustedRule) return exhaustedStartResult.promise;
          return { success: true };
        },
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async () => stopResult.promise,
      },
    },
  });
  const exhaustedRule = rule({ id: "exhausted-then-stopped", autoStart: true });
  env.storage.setItem(STORAGE_KEY_PORT_FORWARDING, JSON.stringify([exhaustedRule]));
  setReconnectCallback(async () => ({ success: true }));
  const unsubscribe = subscribeToPortForwardingNetworkRecovery(target, (recoveryRuleIds) =>
    runPortForwardingAutoStart({
      ...autoStartOptions([host()]),
      recoveryRuleIds,
    }),
  );
  t.after(async () => {
    unsubscribe();
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait(exhaustedRule.id);
    env.restore();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const exhaustedStart = startPortForward(
    exhaustedRule,
    host(),
    [host()],
    [],
    [],
    () => undefined,
    true,
  );
  const connection = getActiveConnection(exhaustedRule.id);
  assert.ok(connection);
  connection.reconnectAttempts = 5;
  exhaustedStartResult.resolve({ success: false, error: "offline socket" });
  await exhaustedStart;
  preparingExhaustedRule = false;
  startedRuleIds.length = 0;

  onlineListener?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const manualStop = stopPortForward(exhaustedRule.id, () => undefined);
  backendSnapshot.resolve([]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(startedRuleIds, []);
  stopResult.resolve({ stopped: 1, failed: 0, errors: [] });
  await manualStop;
});
