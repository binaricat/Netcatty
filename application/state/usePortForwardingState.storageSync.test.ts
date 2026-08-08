import test from "node:test";
import assert from "node:assert/strict";

import type { Host, PortForwardingRule } from "../../domain/models.ts";
import { toPersistedPortForwardingRules } from "../../domain/portForwardingPersistence.ts";
import { STORAGE_KEY_PORT_FORWARDING } from "../../infrastructure/config/storageKeys.ts";
import {
  startPortForward,
  stopAndCleanupRuleAndWait,
} from "../../infrastructure/services/portForwardingService.ts";
import {
  applyPortForwardingRuntimeStatus,
  createPortForwardingStorageSyncHandlers,
  havePortForwardingRuntimeStatesChanged,
  hasPortForwardingRuntimePresenceChanged,
  normalizeRulesWithConnections,
} from "./usePortForwardingState.ts";

const rule: PortForwardingRule = {
  id: "startup-rule",
  label: "Startup tunnel",
  type: "local",
  localPort: 18080,
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  hostId: "host-1",
  autoStart: true,
  createdAt: 1,
  status: "inactive",
  bindAddress: "127.0.0.1",
};

const host: Host = {
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
};

function installEnvironment() {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const backing = new Map<string, string>();
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;

  const storage: Storage = {
    get length() { return backing.size; },
    clear() { backing.clear(); },
    getItem(key) { return backing.get(key) ?? null; },
    key(index) { return Array.from(backing.keys())[index] ?? null; },
    removeItem(key) { backing.delete(key); },
    setItem(key, value) { backing.set(key, value); },
  };

  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      },
    },
  });

  return {
    storage,
    emitStatus(status: PortForwardingRule["status"]) {
      statusListener?.(status);
    },
    restore() {
      if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

test("runtime status updates refresh the visible rule without writing storage", async (t) => {
  const env = installEnvironment();
  t.after(async () => {
    await stopAndCleanupRuleAndWait(rule.id);
    env.restore();
  });

  env.storage.setItem(
    STORAGE_KEY_PORT_FORWARDING,
    JSON.stringify(toPersistedPortForwardingRules([rule])),
  );
  await startPortForward(rule, host, [host], [], [], () => undefined, true);
  env.emitStatus("active");
  applyPortForwardingRuntimeStatus(rule.id, "active");

  const stored = JSON.parse(env.storage.getItem(STORAGE_KEY_PORT_FORWARDING) || "[]") as PortForwardingRule[];
  assert.equal(stored[0]?.status, "inactive");
  assert.equal(stored[0]?.error, undefined);
});

test("legacy cross-window active status is migrated away on config sync", (t) => {
  const env = installEnvironment();
  t.after(() => env.restore());

  env.storage.setItem(STORAGE_KEY_PORT_FORWARDING, JSON.stringify([{
    ...rule,
    id: "other-window-rule",
    status: "active",
  }]));
  const snapshots: PortForwardingRule[][] = [];
  const handlers = createPortForwardingStorageSyncHandlers({
    onRules: (rules) => snapshots.push(rules),
  });

  handlers.handleBrowserStorage({
    type: "storage",
    key: STORAGE_KEY_PORT_FORWARDING,
  } as StorageEvent);

  assert.equal(snapshots.length, 1);
  // Runtime is no longer trusted from storage. Before an authoritative snapshot
  // succeeds, the projection must be unknown — never a false inactive.
  assert.equal(snapshots[0]?.[0]?.status, "unknown");
});

test("normalizeRulesWithConnections stays inactive only after authority succeeds", () => {
  const normalized = normalizeRulesWithConnections([{
    ...rule,
    id: "authority-ok-rule",
    status: "active",
  }], {
    snapshotAvailable: true,
  });
  assert.equal(normalized[0]?.status, "inactive");
});

test("cross-window stale status cannot override a known live tunnel", async (t) => {
  const env = installEnvironment();
  const liveRule = { ...rule, id: "known-live-rule" };
  t.after(async () => {
    await stopAndCleanupRuleAndWait(liveRule.id);
    env.restore();
  });

  await startPortForward(liveRule, host, [host], [], [], () => undefined, true);
  env.emitStatus("active");
  env.storage.setItem(STORAGE_KEY_PORT_FORWARDING, JSON.stringify([{
    ...liveRule,
    status: "inactive",
  }]));
  const snapshots: PortForwardingRule[][] = [];
  const handlers = createPortForwardingStorageSyncHandlers({
    onRules: (rules) => snapshots.push(rules),
  });

  handlers.handleBrowserStorage({
    type: "storage",
    key: STORAGE_KEY_PORT_FORWARDING,
  } as StorageEvent);

  assert.equal(snapshots[0]?.[0]?.status, "active");
});

test("same-window synchronization preserves an error without a runtime tunnel", (t) => {
  const env = installEnvironment();
  t.after(() => env.restore());
  env.storage.setItem(STORAGE_KEY_PORT_FORWARDING, JSON.stringify([{
    ...rule,
    id: "failed-start-rule",
    status: "error",
    error: "Host not found",
  }]));
  // Authority already confirmed — diagnostic error may remain without a tunnel.
  const normalized = normalizeRulesWithConnections([{
    ...rule,
    id: "failed-start-rule",
    status: "error",
    error: "Host not found",
  }], { snapshotAvailable: true });
  assert.equal(normalized[0]?.status, "error");
  assert.equal(normalized[0]?.error, "Host not found");

  const snapshots: PortForwardingRule[][] = [];
  const handlers = createPortForwardingStorageSyncHandlers({
    onRules: (rules) => snapshots.push(rules),
  });

  handlers.handleAdapterChange({
    type: "netcatty:local-storage-adapter-changed",
    detail: { key: STORAGE_KEY_PORT_FORWARDING },
  } as unknown as CustomEvent<{ key: string }>);

  // Without a successful snapshot in this module, storage sync projects unknown.
  assert.equal(snapshots[0]?.[0]?.status, "unknown");
});

test("heartbeat normalization preserves an error without a runtime tunnel", () => {
  const normalized = normalizeRulesWithConnections([{
    ...rule,
    id: "heartbeat-error-rule",
    status: "error",
    error: "Authentication failed",
  }], { snapshotAvailable: true });

  assert.equal(normalized[0]?.status, "error");
  assert.equal(normalized[0]?.error, "Authentication failed");
});

test("heartbeat normalization clears an error for a reconciled-away tunnel", () => {
  const normalized = normalizeRulesWithConnections([{
    ...rule,
    id: "cleanup-error-rule",
    status: "error",
    error: "Failed to stop tunnel",
  }], {
    reconciledGoneRuleIds: new Set(["cleanup-error-rule"]),
    snapshotAvailable: true,
  });

  assert.equal(normalized[0]?.status, "inactive");
  assert.equal(normalized[0]?.error, undefined);
});

test("snapshot failure projects unknown instead of inactive", () => {
  const normalized = normalizeRulesWithConnections([{
    ...rule,
    id: "stale-rule",
    status: "inactive",
  }], {
    snapshotAvailable: false,
  });

  assert.equal(normalized[0]?.status, "unknown");
});

test("heartbeat writes only when a visible runtime state changes", () => {
  const current = [{ ...rule, status: "inactive" as const }];
  const unchanged = [{ ...rule, status: "inactive" as const }];
  const repaired = [{ ...rule, status: "active" as const }];

  assert.equal(havePortForwardingRuntimeStatesChanged(current, unchanged), false);
  assert.equal(havePortForwardingRuntimeStatesChanged(current, repaired), true);
});

test("heartbeat notifies when only runtime tunnel presence changes", () => {
  assert.equal(hasPortForwardingRuntimePresenceChanged({
    gone: [],
    appeared: ["cleanup-error-rule"],
  }), true);
  assert.equal(hasPortForwardingRuntimePresenceChanged({
    gone: [],
    appeared: [],
  }), false);
});
