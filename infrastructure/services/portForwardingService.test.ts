import test from "node:test";
import assert from "node:assert/strict";

import type { Host, PortForwardingRule, SSHKey } from "../../domain/models.ts";
import { STORAGE_KEY_PF_RECONNECT_CANCEL } from "../config/storageKeys.ts";
import {
  getActiveConnection,
  hasActivePortForwardRuntime,
  reconcileWithBackend,
  resetReconnectAttempts,
  setReconnectCallback,
  startAllPortForwards,
  startPortForward,
  stopAllActivePortForwards,
  stopAllPortForwards,
  stopAndCleanupRule,
  stopAndCleanupRuleAndWait,
  stopPortForward,
  syncWithBackend,
} from "./portForwardingService.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

const rule = (overrides: Partial<PortForwardingRule> = {}): PortForwardingRule => ({
  id: "rule-1",
  name: "Rule",
  type: "local",
  localPort: 18080,
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  enabled: true,
  status: "inactive",
  ...overrides,
});

const installBridgeStub = () => {
  let started = false;
  let capturedOptions: Record<string, unknown> | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: Record<string, unknown>) => {
          started = true;
          capturedOptions = options;
          return { success: true };
        },
        onPortForwardStatus: () => undefined,
      },
    },
  });
  return {
    wasStarted: () => started,
    getOptions: () => capturedOptions,
  };
};

test("stopAndCleanupRuleAndWait stops backend tunnels without a renderer connection", async () => {
  let stoppedRuleId: string | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async (ruleId: string) => {
          stoppedRuleId = ruleId;
          return { stopped: 1 };
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("backend-only-rule");

  assert.equal(result.success, true);
  assert.equal(stoppedRuleId, "backend-only-rule");
});

test("syncWithBackend binds backend tunnels by explicit rule id", async () => {
  let stoppedTunnelId: string | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [{
          ruleId: "imported-rule-id",
          tunnelId: "opaque-backend-tunnel-id",
          type: "local",
          status: "active",
        }],
        stopPortForward: async (tunnelId: string) => {
          stoppedTunnelId = tunnelId;
          return { tunnelId, success: true };
        },
      },
    },
  });

  await syncWithBackend();
  const statuses: string[] = [];
  const result = await stopPortForward("imported-rule-id", (status) => statuses.push(status));

  assert.equal(result.success, true);
  assert.equal(stoppedTunnelId, "opaque-backend-tunnel-id");
  assert.deepEqual(statuses, ["inactive"]);
});

test("reconcileWithBackend reports an unavailable snapshot on query failure", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => {
          throw new Error("backend temporarily unavailable");
        },
      },
    },
  });

  assert.deepEqual(await reconcileWithBackend(), {
    snapshotAvailable: false,
    epoch: undefined,
    revision: undefined,
    gone: [],
    appeared: [],
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [],
      },
    },
  });
  assert.equal((await reconcileWithBackend()).snapshotAvailable, true);
});

test("syncWithBackend subscribes adopted auto-start tunnels for reconnect", async (t) => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  const subscribedTunnelIds: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [{
          ruleId: "synced-auto-start-rule",
          tunnelId: "synced-auto-start-tunnel",
          type: "local",
          status: "active",
        }],
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        subscribePortForward: async (tunnelId: string) => {
          subscribedTunnelIds.push(tunnelId);
          return { tunnelId, status: "active" };
        },
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  const statuses: Array<{ status: PortForwardingRule["status"]; error?: string }> = [];
  setReconnectCallback(async () => ({ success: true }));
  t.after(async () => {
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait("synced-auto-start-rule");
  });

  await syncWithBackend({
    shouldReconnect: () => true,
    onStatusChange: (_ruleId, status, error) => statuses.push({ status, error }),
  });
  assert.deepEqual(subscribedTunnelIds, ["synced-auto-start-tunnel"]);
  statusListener?.("error", "connection lost");

  const connection = getActiveConnection("synced-auto-start-rule");
  assert.ok(connection?.reconnectTimerCallback);
  assert.equal(connection.status, "connecting");
  assert.deepEqual(statuses, [{
    status: "connecting",
    error: "Reconnecting (1/5)...",
  }]);

  statusListener?.("inactive");
  assert.equal(getActiveConnection("synced-auto-start-rule"), connection);
  assert.ok(connection.reconnectTimerCallback);
});

test("heartbeat subscribes newly discovered auto-start tunnels for reconnect", async (t) => {
  const statuses: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [],
      },
    },
  });
  await syncWithBackend({
    shouldReconnect: () => true,
    onStatusChange: (_ruleId, status) => statuses.push(status),
  });

  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  const subscribedTunnelIds: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [{
          ruleId: "heartbeat-auto-start-rule",
          tunnelId: "heartbeat-auto-start-tunnel",
          type: "local",
          status: "active",
        }],
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        subscribePortForward: async (tunnelId: string) => {
          subscribedTunnelIds.push(tunnelId);
          return { tunnelId, status: "active" };
        },
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  setReconnectCallback(async () => ({ success: true }));
  t.after(async () => {
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait("heartbeat-auto-start-rule");
  });

  const reconciliation = await reconcileWithBackend();
  assert.deepEqual(reconciliation.appeared, ["heartbeat-auto-start-rule"]);
  assert.deepEqual(subscribedTunnelIds, ["heartbeat-auto-start-tunnel"]);

  statusListener?.("inactive");
  const connection = getActiveConnection("heartbeat-auto-start-rule");
  assert.ok(connection?.reconnectTimerCallback);
  assert.equal(connection.status, "connecting");
  assert.deepEqual(statuses, ["connecting"]);
});

test("heartbeat replaces subscriptions when a rule gets a new backend tunnel", async (t) => {
  let tunnelId = "replacement-old-tunnel";
  const listeners = new Map<string, (status: PortForwardingRule["status"]) => void>();
  const unsubscribedTunnelIds: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [{
          ruleId: "replacement-rule",
          tunnelId,
          type: "local",
          status: "active",
        }],
        onPortForwardStatus: (
          subscribedTunnelId: string,
          listener: (status: PortForwardingRule["status"]) => void,
        ) => {
          listeners.set(subscribedTunnelId, listener);
          return () => unsubscribedTunnelIds.push(subscribedTunnelId);
        },
        subscribePortForward: async (subscribedTunnelId: string) => ({
          tunnelId: subscribedTunnelId,
          status: "active",
        }),
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  t.after(async () => {
    await stopAndCleanupRuleAndWait("replacement-rule");
  });

  await syncWithBackend({ shouldReconnect: () => false });
  const oldListener = listeners.get("replacement-old-tunnel");
  assert.ok(oldListener);

  tunnelId = "replacement-new-tunnel";
  const reconciliation = await reconcileWithBackend();
  assert.deepEqual(reconciliation.appeared, ["replacement-rule"]);
  assert.deepEqual(unsubscribedTunnelIds, ["replacement-old-tunnel"]);
  assert.ok(listeners.get("replacement-new-tunnel"));
  assert.equal(getActiveConnection("replacement-rule")?.tunnelId, "replacement-new-tunnel");

  oldListener("inactive");
  assert.equal(getActiveConnection("replacement-rule")?.tunnelId, "replacement-new-tunnel");
});

test("syncWithBackend registers adopted tunnels without a status callback", async (t) => {
  const subscribedTunnelIds: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [{
          ruleId: "plain-synced-rule",
          tunnelId: "plain-synced-tunnel",
          type: "local",
          status: "active",
        }],
        onPortForwardStatus: () => () => undefined,
        subscribePortForward: async (tunnelId: string) => {
          subscribedTunnelIds.push(tunnelId);
          return { tunnelId, status: "active" };
        },
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  t.after(async () => {
    await stopAndCleanupRuleAndWait("plain-synced-rule");
  });

  await syncWithBackend();

  assert.deepEqual(subscribedTunnelIds, ["plain-synced-tunnel"]);
  assert.equal(getActiveConnection("plain-synced-rule")?.status, "active");
});

test("synced auto-start tunnels reconnect after an unexpected inactive event", async (t) => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [{
          ruleId: "inactive-reconnect-rule",
          tunnelId: "inactive-reconnect-tunnel",
          type: "local",
          status: "active",
        }],
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        subscribePortForward: async (tunnelId: string) => ({ tunnelId, status: "active" }),
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  const statuses: string[] = [];
  setReconnectCallback(async () => ({ success: true }));
  t.after(async () => {
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait("inactive-reconnect-rule");
  });

  await syncWithBackend({
    shouldReconnect: () => true,
    onStatusChange: (_ruleId, status) => statuses.push(status),
  });
  statusListener?.("inactive");

  const connection = getActiveConnection("inactive-reconnect-rule");
  assert.ok(connection?.reconnectTimerCallback);
  assert.equal(connection.status, "connecting");
  assert.deepEqual(statuses, ["connecting"]);
});

test("manual stop of a synced tunnel does not schedule reconnect", async () => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        listPortForwards: async () => [{
          ruleId: "manual-synced-stop-rule",
          tunnelId: "manual-synced-stop-tunnel",
          type: "local",
          status: "active",
        }],
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        subscribePortForward: async (tunnelId: string) => ({ tunnelId, status: "active" }),
        stopPortForwardByRuleId: async () => {
          statusListener?.("inactive");
          return { stopped: 1, failed: 0, errors: [] };
        },
      },
    },
  });
  const statuses: string[] = [];
  setReconnectCallback(async () => ({ success: true }));

  await syncWithBackend({
    shouldReconnect: () => true,
    onStatusChange: (_ruleId, status) => statuses.push(status),
  });
  const result = await stopPortForward(
    "manual-synced-stop-rule",
    (status) => statuses.push(status),
  );
  setReconnectCallback(null);

  assert.equal(result.success, true);
  assert.equal(getActiveConnection("manual-synced-stop-rule"), undefined);
  assert.deepEqual(statuses, ["inactive", "inactive"]);
});

test("stopPortForward asks the backend to stop a rule even without local tracking", async () => {
  let stoppedRuleId: string | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async (ruleId: string) => {
          stoppedRuleId = ruleId;
          return { stopped: 1, failed: 0, errors: [] };
        },
      },
    },
  });

  const statuses: string[] = [];
  const result = await stopPortForward("backend-only-stop-rule", (status) => statuses.push(status));

  assert.equal(result.success, true);
  assert.equal(stoppedRuleId, "backend-only-stop-rule");
  assert.deepEqual(statuses, ["inactive"]);
});

test("stopPortForward preserves an untracked backend tunnel after cleanup fails", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => ({
          stopped: 0,
          failed: 1,
          errors: ["backend tunnel is still running"],
        }),
      },
    },
  });

  const statuses: string[] = [];
  const result = await stopPortForward(
    "untracked-failed-stop-rule",
    (status) => statuses.push(status),
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /still running/);
  assert.equal(getActiveConnection("untracked-failed-stop-rule")?.status, "error");
  assert.deepEqual(statuses, ["error"]);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  await stopAndCleanupRuleAndWait("untracked-failed-stop-rule");
});

test("stopPortForward preserves an untracked backend tunnel when cleanup rejects", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          throw new Error("backend stop request rejected");
        },
      },
    },
  });

  const statuses: string[] = [];
  const result = await stopPortForward(
    "untracked-rejected-stop-rule",
    (status) => statuses.push(status),
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /request rejected/);
  assert.equal(getActiveConnection("untracked-rejected-stop-rule")?.status, "error");
  assert.deepEqual(statuses, ["error"]);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  await stopAndCleanupRuleAndWait("untracked-rejected-stop-rule");
});

test("stopPortForward cancels reconnects scheduled in other windows", async (t) => {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const writes: Array<[string, string]> = [];
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push([key, value]);
        backing.set(key, value);
      },
      removeItem: (key: string) => backing.delete(key),
    },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });

  const result = await stopPortForward("cross-window-reconnect-rule", () => undefined);

  assert.equal(result.success, true);
  assert.deepEqual(writes, [[STORAGE_KEY_PF_RECONNECT_CANCEL, "cross-window-reconnect-rule"]]);
});

test("stopPortForward keeps the live status when backend cleanup fails", async (t) => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        stopPortForwardByRuleId: async () => {
          statusListener?.("error", "listener close failed");
          return {
            stopped: 0,
            failed: 1,
            errors: ["listener close failed"],
          };
        },
      },
    },
  });

  const liveRule = rule({ id: "stop-failure-rule" });
  const runtimeStatuses: string[] = [];
  setReconnectCallback(async () => ({ success: true }));
  await startPortForward(
    liveRule,
    host(),
    [],
    [],
    [],
    (status) => runtimeStatuses.push(status),
    true,
  );
  statusListener?.("active");
  t.after(async () => {
    setReconnectCallback(null);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        netcatty: {
          stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        },
      },
    });
    await stopAndCleanupRuleAndWait(liveRule.id);
  });

  const statuses: string[] = [];
  const result = await stopPortForward(liveRule.id, (status) => statuses.push(status));

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /listener close failed/);
  assert.equal(runtimeStatuses.at(-1), "connecting");
  assert.equal(getActiveConnection(liveRule.id)?.status, "error");
  assert.equal(getActiveConnection(liveRule.id)?.reconnectTimeoutId, undefined);
  assert.deepEqual(statuses, ["error"]);
});

test("stopAndCleanupRuleAndWait reports backend stop failures", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          throw new Error("backend stop failed");
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("failing-rule");

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /backend stop failed/);
});

test("stopAndCleanupRuleAndWait reports partial backend stop failures", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => ({
          stopped: 1,
          failed: 1,
          errors: ["tunnel close failed"],
        }),
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("partial-failure-rule");

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /tunnel close failed/);
});

test("stopAndCleanupRuleAndWait preserves a pending reconnect after stop failure", async () => {
  installBridgeStub();
  await startPortForward(
    rule({ id: "retrying-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
    true,
  );
  const connection = getActiveConnection("retrying-rule");
  assert.ok(connection);
  let reconnectAttempts = 0;
  const reconnectTimerCallback = () => {
    reconnectAttempts++;
  };
  const reconnectTimeoutId = setTimeout(reconnectTimerCallback, 10);
  connection.reconnectTimeoutId = reconnectTimeoutId;
  connection.reconnectDueAt = Date.now() + 10;
  connection.reconnectTimerCallback = reconnectTimerCallback;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return {
            stopped: 0,
            failed: 1,
            errors: ["backend stop failed"],
          };
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("retrying-rule");

  assert.equal(result.success, false);
  assert.equal(reconnectAttempts, 0);
  assert.ok(getActiveConnection("retrying-rule")?.reconnectTimeoutId);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(reconnectAttempts, 1);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          throw new Error("cleanup failure");
        },
      },
    },
  });
  stopAndCleanupRule("retrying-rule");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getActiveConnection("retrying-rule"), undefined);
});

test("stopAndCleanupRuleAndWait blocks a pending reconnect while stop succeeds", async () => {
  installBridgeStub();
  await startPortForward(
    rule({ id: "stopping-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
    true,
  );
  const connection = getActiveConnection("stopping-rule");
  assert.ok(connection);
  let reconnectAttempts = 0;
  const reconnectTimerCallback = () => {
    reconnectAttempts++;
  };
  connection.reconnectTimeoutId = setTimeout(reconnectTimerCallback, 10);
  connection.reconnectDueAt = Date.now() + 10;
  connection.reconnectTimerCallback = reconnectTimerCallback;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return { stopped: 1, failed: 0, errors: [] };
        },
      },
    },
  });

  const result = await stopAndCleanupRuleAndWait("stopping-rule");

  assert.equal(result.success, true);
  assert.equal(reconnectAttempts, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(reconnectAttempts, 0);
  assert.equal(getActiveConnection("stopping-rule"), undefined);
});

test("stopAndCleanupRuleAndWait coalesces overlapping cleanup calls", async () => {
  let stopCalls = 0;
  let resolveStop: ((value: { stopped: number; failed: number; errors: string[] }) => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          stopCalls += 1;
          return new Promise<{ stopped: number; failed: number; errors: string[] }>((resolve) => {
            resolveStop = resolve;
          });
        },
      },
    },
  });

  const first = stopAndCleanupRuleAndWait("overlapping-rule");
  const second = stopAndCleanupRuleAndWait("overlapping-rule");

  assert.equal(first, second);
  assert.equal(stopCalls, 1);
  resolveStop?.({ stopped: 1, failed: 0, errors: [] });
  assert.deepEqual(await first, { success: true });
  assert.deepEqual(await second, { success: true });
});

test("startPortForward rejects starts while the rule is pending cleanup", async () => {
  let resolveStop: ((value: { stopped: number; failed: number; errors: string[] }) => void) | undefined;
  let startCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => (
          new Promise<{ stopped: number; failed: number; errors: string[] }>((resolve) => {
            resolveStop = resolve;
          })
        ),
        startPortForward: async () => {
          startCalls += 1;
          return { success: true };
        },
        onPortForwardStatus: () => undefined,
      },
    },
  });
  const stopping = stopAndCleanupRuleAndWait("start-during-stop-rule");

  const blocked = await startPortForward(
    rule({ id: "start-during-stop-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
  );

  assert.equal(blocked.success, false);
  assert.match(blocked.error ?? "", /currently being stopped/i);
  assert.equal(startCalls, 0);
  resolveStop?.({ stopped: 0, failed: 1, errors: ["stop failed"] });
  assert.equal((await stopping).success, false);

  const allowed = await startPortForward(
    rule({ id: "start-during-stop-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
  );
  assert.equal(allowed.success, true);
  assert.equal(startCalls, 1);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });
  stopAndCleanupRule("start-during-stop-rule");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("startPortForward treats repeated active starts as idempotent", async () => {
  let startCalls = 0;
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => {
          startCalls += 1;
          return { success: true };
        },
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      },
    },
  });
  const repeatedRule = rule({ id: "repeated-rule" });

  const first = await startPortForward(repeatedRule, host(), [], [], [], () => undefined);
  statusListener?.("active");
  const repeatedStatuses: string[] = [];
  const second = await startPortForward(
    repeatedRule,
    host(),
    [],
    [],
    [],
    (status) => repeatedStatuses.push(status),
  );

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(startCalls, 1);
  assert.ok(getActiveConnection("repeated-rule"));
  assert.deepEqual(repeatedStatuses, ["active"]);
  stopAndCleanupRule("repeated-rule");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("inactive backend events remove the runtime tunnel immediately", async () => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      },
    },
  });
  const disconnectedRule = rule({ id: "inactive-event-rule" });

  await startPortForward(disconnectedRule, host(), [], [], [], () => undefined);
  assert.ok(getActiveConnection(disconnectedRule.id));

  statusListener?.("inactive");

  assert.equal(getActiveConnection(disconnectedRule.id), undefined);
});

test("auto-start rules reconnect after an unexpected inactive event", async (t) => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
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
  const reconnectRule = rule({ id: "inactive-event-reconnect-rule" });
  setReconnectCallback(async () => ({ success: true }));
  t.after(async () => {
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait(reconnectRule.id);
  });

  await startPortForward(reconnectRule, host(), [], [], [], () => undefined, true);
  statusListener?.("inactive");

  const connection = getActiveConnection(reconnectRule.id);
  assert.ok(connection?.reconnectTimerCallback);
  assert.equal(connection.status, "connecting");
});

for (const disableDuringDelay of [false, true]) {
  test(`inactive reconnect respects auto-start disabled ${disableDuringDelay ? "during delay" : "before disconnect"}`, async (t) => {
    let statusListener: ((status: PortForwardingRule["status"]) => void) | undefined;
    let autoStart = true;
    let reconnects = 0;
    const statuses: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        netcatty: {
          startPortForward: async () => ({ success: true }),
          stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
          onPortForwardStatus: (_id: string, listener: typeof statusListener) => {
            statusListener = listener;
            return () => undefined;
          },
        },
      },
    });
    const reconnectRule = rule({ id: `disabled-inactive-${disableDuringDelay}`, autoStart: true });
    setReconnectCallback(async () => {
      reconnects += 1;
      return { success: true };
    }, () => autoStart);
    t.after(async () => {
      setReconnectCallback(null);
      await stopAndCleanupRuleAndWait(reconnectRule.id);
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await startPortForward(reconnectRule, host(), [], [], [], (status) => statuses.push(status), true);
    if (!disableDuringDelay) autoStart = false;
    statusListener?.("inactive");
    if (disableDuringDelay) {
      assert.ok(getActiveConnection(reconnectRule.id)?.reconnectTimerCallback);
      autoStart = false;
    }
    t.mock.timers.tick(3000);
    assert.equal(reconnects, 0);
    assert.equal(getActiveConnection(reconnectRule.id), undefined);
    assert.equal(statuses.at(-1), "inactive");
  });
}

for (const autoStartAfterReplacement of [false, true]) {
  test(`stale reconnect leaves a replacement tunnel intact with auto-start ${autoStartAfterReplacement}`, async (t) => {
    let statusListener: ((status: PortForwardingRule["status"]) => void) | undefined;
    let autoStart = true;
    let reconnects = 0;
    const reconnectRule = rule({ id: `replaced-inactive-${autoStartAfterReplacement}`, autoStart: true });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { netcatty: {
        startPortForward: async () => ({ success: true }),
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        onPortForwardStatus: (_id: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        listPortForwards: async () => [{ ruleId: reconnectRule.id, tunnelId: "replacement", status: "active", type: "local" }],
      } },
    });
    setReconnectCallback(async () => { reconnects += 1; return { success: true }; }, () => autoStart);
    t.after(async () => {
      setReconnectCallback(null);
      await stopAndCleanupRuleAndWait(reconnectRule.id);
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const statuses: string[] = [];
    await startPortForward(reconnectRule, host(), [], [], [], (status) => statuses.push(status), true);
    statusListener?.("inactive");
    assert.ok(getActiveConnection(reconnectRule.id)?.reconnectTimerCallback);
    await reconcileWithBackend();
    const replacement = getActiveConnection(reconnectRule.id);
    assert.equal(replacement?.tunnelId, "replacement");
    const previousStatuses = [...statuses];
    autoStart = autoStartAfterReplacement;
    t.mock.timers.tick(3000);
    assert.equal(getActiveConnection(reconnectRule.id), replacement);
    assert.equal(reconnects, 0);
    assert.deepEqual(statuses, previousStatuses);
    statusListener?.("active");
    assert.equal(getActiveConnection(reconnectRule.id)?.status, "active");
  });
}

test("final retry error followed by inactive preserves exhaustion until explicit recovery", async (t) => {
  let statusListener: ((status: PortForwardingRule["status"]) => void) | undefined;
  let reconnects = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: {
      startPortForward: async () => ({ success: true }),
      stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      onPortForwardStatus: (_id: string, listener: typeof statusListener) => {
        statusListener = listener;
        return () => undefined;
      },
    } },
  });
  const reconnectRule = rule({ id: "exhausted-inactive-rule", autoStart: true });
  setReconnectCallback(async () => { reconnects += 1; return { success: true }; });
  t.after(async () => {
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait(reconnectRule.id);
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await startPortForward(reconnectRule, host(), [], [], [], () => undefined, true);
  const connection = getActiveConnection(reconnectRule.id)!;
  connection.reconnectAttempts = 5;
  statusListener?.("error");
  statusListener?.("inactive");
  t.mock.timers.tick(3000);
  assert.equal(reconnects, 0);
  assert.equal(getActiveConnection(reconnectRule.id), undefined);
  assert.equal(resetReconnectAttempts(reconnectRule.id), true);
  await startPortForward(reconnectRule, host(), [], [], [], () => undefined, true);
  statusListener?.("inactive");
  t.mock.timers.tick(3000);
  assert.equal(reconnects, 1);
});

for (const rejects of [false, true]) {
  test(`inactive during failed startup schedules only one retry (${rejects ? "throw" : "reply"})`, async (t) => {
    let statusListener: ((status: PortForwardingRule["status"]) => void) | undefined;
    const reconnectRule = rule({ id: `inactive-start-failed-${rejects}`, autoStart: true });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { netcatty: {
        startPortForward: async () => {
          getActiveConnection(reconnectRule.id)!.reconnectAttempts = 4;
          statusListener?.("inactive");
          if (rejects) throw new Error("SSH connection closed before ready");
          return { success: false, error: "SSH connection closed before ready" };
        },
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        onPortForwardStatus: (_id: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      } },
    });
    let reconnects = 0;
    setReconnectCallback(async () => { reconnects += 1; return { success: true }; });
    t.after(async () => {
      setReconnectCallback(null);
      await stopAndCleanupRuleAndWait(reconnectRule.id);
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await startPortForward(reconnectRule, host(), [], [], [], () => undefined, true);
    assert.equal(getActiveConnection(reconnectRule.id)?.reconnectAttempts, 5);
    t.mock.timers.tick(3000);
    assert.equal(reconnects, 1);
  });
}

test("inactive close events preserve an already scheduled reconnect", async (t) => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        listPortForwards: async () => [],
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      },
    },
  });
  const reconnectRule = rule({ id: "error-close-reconnect-rule" });
  setReconnectCallback(async () => ({ success: true }));
  t.after(async () => {
    setReconnectCallback(null);
    await stopAndCleanupRuleAndWait(reconnectRule.id);
  });

  await startPortForward(reconnectRule, host(), [], [], [], () => undefined, true);
  statusListener?.("error", "connection failed");
  const scheduled = getActiveConnection(reconnectRule.id);
  assert.ok(scheduled?.reconnectTimerCallback);
  assert.equal(scheduled.status, "connecting");

  const pendingRetry = scheduled.reconnectTimerCallback;
  statusListener?.("error", "connection closed");
  assert.equal(scheduled.status, "connecting");
  assert.equal(scheduled.error, "Reconnecting (1/5)...");
  assert.equal(scheduled.reconnectTimerCallback, pendingRetry);
  assert.deepEqual((await reconcileWithBackend()).gone, []);
  assert.equal(getActiveConnection(reconnectRule.id), scheduled);

  statusListener?.("inactive");

  assert.equal(getActiveConnection(reconnectRule.id), scheduled);
  assert.ok(scheduled.reconnectTimerCallback);
  assert.equal(scheduled.status, "connecting");

  await syncWithBackend();

  assert.equal(getActiveConnection(reconnectRule.id), scheduled);
  assert.ok(scheduled.reconnectTimerCallback);
});

test("startPortForward adopts a tunnel reused by the backend", async () => {
  let unsubscribed = false;
  const statusListeners = new Map<string, (status: PortForwardingRule["status"], error?: string | null) => void>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({
          success: true,
          tunnelId: "existing-backend-tunnel",
          reused: true,
          status: "active",
        }),
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        getPortForwardStatus: async () => ({
          tunnelId: "existing-backend-tunnel",
          status: "active",
        }),
        onPortForwardStatus: (tunnelId: string, listener: (status: PortForwardingRule["status"], error?: string | null) => void) => {
          statusListeners.set(tunnelId, listener);
          return () => {
            unsubscribed = true;
            statusListeners.delete(tunnelId);
          };
        },
      },
    },
  });
  const statuses: string[] = [];
  const reusedRule = rule({ id: "backend-reused-rule" });

  const result = await startPortForward(
    reusedRule,
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
  );

  assert.equal(result.success, true);
  assert.equal(unsubscribed, true);
  assert.equal(getActiveConnection(reusedRule.id)?.tunnelId, "existing-backend-tunnel");
  assert.equal(getActiveConnection(reusedRule.id)?.status, "active");
  assert.deepEqual(statuses, ["connecting", "active"]);
  statusListeners.get("existing-backend-tunnel")?.("error", "connection lost");
  assert.equal(getActiveConnection(reusedRule.id)?.status, "error");
  assert.deepEqual(statuses, ["connecting", "active", "error"]);
  await stopAndCleanupRuleAndWait(reusedRule.id);
});

test("startPortForward does not keep an adopted tunnel that stopped before subscription", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({
          success: true,
          tunnelId: "already-stopped-tunnel",
          reused: true,
          status: "connecting",
        }),
        getPortForwardStatus: async () => ({
          tunnelId: "already-stopped-tunnel",
          status: "inactive",
        }),
        onPortForwardStatus: () => () => undefined,
      },
    },
  });
  const statuses: string[] = [];
  const stoppedRule = rule({ id: "stopped-before-adoption-rule" });

  const result = await startPortForward(
    stoppedRule,
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
  );

  assert.equal(result.success, false);
  assert.equal(getActiveConnection(stoppedRule.id), undefined);
  assert.deepEqual(statuses, ["connecting", "inactive"]);
});

test("startPortForward does not revive an adopted tunnel stopped during its snapshot", async () => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  let resolveSnapshot!: (snapshot: {
    tunnelId: string;
    status: PortForwardingRule["status"];
  }) => void;
  let markSnapshotRequested!: () => void;
  const snapshotRequested = new Promise<void>((resolve) => {
    markSnapshotRequested = resolve;
  });
  const snapshot = new Promise<{
    tunnelId: string;
    status: PortForwardingRule["status"];
  }>((resolve) => {
    resolveSnapshot = resolve;
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({
          success: true,
          tunnelId: "stopped-during-snapshot-tunnel",
          reused: true,
          status: "active",
        }),
        getPortForwardStatus: () => {
          markSnapshotRequested();
          return snapshot;
        },
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
      },
    },
  });
  const statuses: string[] = [];
  const stoppedRule = rule({ id: "stopped-during-snapshot-rule" });

  const resultPromise = startPortForward(
    stoppedRule,
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
  );
  await snapshotRequested;
  statusListener?.("inactive");
  resolveSnapshot({
    tunnelId: "stopped-during-snapshot-tunnel",
    status: "active",
  });
  const result = await resultPromise;

  assert.equal(result.success, false);
  assert.equal(getActiveConnection(stoppedRule.id), undefined);
  assert.deepEqual(statuses, ["connecting", "inactive"]);
});

test("startPortForward keeps cleanup-blocked backend tunnels in an error state", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({
          success: false,
          tunnelId: "cleanup-blocked-tunnel",
          blockedByCleanup: true,
          error: "cleanup still required",
        }),
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        onPortForwardStatus: () => () => undefined,
      },
    },
  });
  const statuses: string[] = [];
  const blockedRule = rule({ id: "cleanup-blocked-rule" });

  const result = await startPortForward(
    blockedRule,
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
    true,
  );

  assert.equal(result.success, false);
  assert.equal(getActiveConnection(blockedRule.id)?.tunnelId, "cleanup-blocked-tunnel");
  assert.equal(getActiveConnection(blockedRule.id)?.status, "error");
  assert.equal(getActiveConnection(blockedRule.id)?.reconnectTimeoutId, undefined);
  assert.deepEqual(statuses, ["connecting", "error"]);
  await stopAndCleanupRuleAndWait(blockedRule.id);
});

test("stopAndCleanupRule still clears local reconnect state after backend stop failures", async () => {
  installBridgeStub();
  await startPortForward(
    rule({ id: "background-cleanup-rule" }),
    host(),
    [],
    [],
    [],
    () => undefined,
    true,
  );
  assert.ok(getActiveConnection("background-cleanup-rule"));

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        stopPortForwardByRuleId: async () => {
          throw new Error("backend stop failed");
        },
      },
    },
  });

  stopAndCleanupRule("background-cleanup-rule");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(getActiveConnection("background-cleanup-rule"), undefined);
});

test("startPortForward forwards system agent settings", async () => {
  const bridge = installBridgeStub();

  const result = await startPortForward(
    rule({ id: "rule-agent" }),
    host({
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    }),
    [],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    bridge.getOptions() && {
      useSshAgent: bridge.getOptions()?.useSshAgent,
      identityAgent: bridge.getOptions()?.identityAgent,
      identityFilePaths: bridge.getOptions()?.identityFilePaths,
      identitiesOnly: bridge.getOptions()?.identitiesOnly,
      addKeysToAgent: bridge.getOptions()?.addKeysToAgent,
      useKeychain: bridge.getOptions()?.useKeychain,
    },
    {
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
  );
});

test("startPortForward drops stale identity paths for password-only auth", async () => {
  const bridge = installBridgeStub();
  const jumpHost = host({
    id: "jump-1",
    authMethod: "password",
    password: "jump-secret",
    useSshAgent: true,
    identityFilePaths: ["~/.ssh/stale-jump-key"],
  });

  const result = await startPortForward(
    rule({ id: "rule-password-only" }),
    host({
      authMethod: "password",
      password: "secret",
      useSshAgent: true,
      identityFilePaths: ["~/.ssh/stale-key"],
      hostChain: { hostIds: ["jump-1"] },
    }),
    [jumpHost],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.identityFilePaths, undefined);
  assert.equal(bridge.getOptions()?.useSshAgent, false);
  const jumpHosts = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>>;
  assert.equal(jumpHosts[0]?.identityFilePaths, undefined);
  assert.equal(jumpHosts[0]?.useSshAgent, false);
});

test("startPortForward uses the system agent when a synced key cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const key: SSHKey = {
    id: "key-1",
    label: "Synced key",
    type: "ED25519",
    publicKey: "ssh-ed25519 AAAASELECTED",
    privateKey: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
    source: "imported",
    category: "key",
    created: 1,
  };

  const result = await startPortForward(
    rule({ id: "rule-agent-synced-key" }),
    host({
      authMethod: "key",
      identityFileId: "key-1",
      useSshAgent: true,
    }),
    [],
    [key],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.useSshAgent, true);
  assert.deepEqual(bridge.getOptions()?.agentPublicKeys, ["ssh-ed25519 AAAASELECTED"]);
  assert.equal(bridge.getOptions()?.privateKey, undefined);
});

test("startPortForward keeps automatic target discovery available with an unreadable saved password", async () => {
  const bridge = installBridgeStub();
  const result = await startPortForward(
    rule({ id: "rule-auto-unreadable" }),
    host({ authMethod: "auto", password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==" }),
    [],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.authMethod, "auto");
  assert.equal(bridge.getOptions()?.password, undefined);
});

test("startPortForward keeps automatic jump discovery available with an unreadable saved password", async () => {
  const bridge = installBridgeStub();
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    authMethod: "auto",
    password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
  });
  const result = await startPortForward(
    rule({ id: "rule-auto-jump-unreadable" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    () => undefined,
  );

  assert.equal(result.success, true);
  const jumpOptions = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>> | undefined;
  assert.equal(jumpOptions?.[0]?.authMethod, "auto");
  assert.equal(jumpOptions?.[0]?.password, undefined);
});

test("startPortForward forwards target and jump-host timeouts", async () => {
  const bridge = installBridgeStub();
  const jumpHost = host({
    id: "jump-1",
    requiresMfa: true,
    sshTcpConnectTimeoutSeconds: 75,
    sshAuthReadyTimeoutSeconds: 360,
  });

  const result = await startPortForward(
    rule({ id: "rule-timeouts" }),
    host({
      hostChain: { hostIds: ["jump-1"] },
      requiresMfa: true,
      sshTcpConnectTimeoutSeconds: 45,
      sshAuthReadyTimeoutSeconds: 300,
    }),
    [jumpHost],
    [],
    [],
    () => {},
  );

  assert.equal(result.success, true);
  assert.equal(bridge.getOptions()?.sshTcpConnectTimeoutMs, 45_000);
  assert.equal(bridge.getOptions()?.sshAuthReadyTimeoutMs, 300_000);
  assert.equal(bridge.getOptions()?.requiresMfa, true);
  const jumpHosts = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>>;
  assert.equal(jumpHosts[0]?.requiresMfa, true);
  assert.equal(jumpHosts[0]?.sshTcpConnectTimeoutMs, 75_000);
  assert.equal(jumpHosts[0]?.sshAuthReadyTimeoutMs, 360_000);
});

test("startPortForward rejects missing proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule(),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "missing-identity",
      },
    }),
    [],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects missing saved proxy profiles before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-missing-profile" }),
    host({ proxyProfileId: "missing-proxy" }),
    [],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Saved proxy for host "Host" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Saved proxy/);
});

test("startPortForward rejects incomplete proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-incomplete" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects proxy identities with blank usernames even when passwords are encrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-blank-username" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "",
      authMethod: "password",
      password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward resolves target proxy credentials from an identity", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-resolved-target" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, true);
  assert.equal(bridge.wasStarted(), true);
  assert.deepEqual(bridge.getOptions()?.proxy, {
    type: "http",
    host: "proxy.example.com",
    port: 3128,
    username: "proxy-user",
    password: "proxy-secret",
  });
  assert.deepEqual(statuses, ["connecting"]);
});

test("startPortForward rejects target proxy identity passwords that cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-unreadable-target" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy credentials cannot be decrypted/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy credentials/);
});

test("startPortForward rejects missing jump host proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "missing-identity",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-2" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Jump" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects missing saved proxy profiles on jump hosts before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyProfileId: "missing-proxy",
  });

  const result = await startPortForward(
    rule({ id: "rule-missing-jump-profile" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Saved proxy for jump host "Jump" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Saved proxy/);
});

test("startPortForward rejects incomplete jump host proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-jump-incomplete" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "",
      authMethod: "password",
      password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Jump" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward resolves jump host proxy credentials from an identity", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "socks5",
      host: "jump-proxy.example.com",
      port: 1080,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-resolved-jump" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, true);
  assert.equal(bridge.wasStarted(), true);
  const jumpHosts = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>>;
  assert.deepEqual(jumpHosts[0]?.proxy, {
    type: "socks5",
    host: "jump-proxy.example.com",
    port: 1080,
    username: "proxy-user",
    password: "proxy-secret",
  });
  assert.deepEqual(statuses, ["connecting"]);
});

test("startPortForward rejects jump host proxy identity passwords that cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-unreadable-jump" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy credentials for jump host "Jump" cannot be decrypted/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy credentials/);
});

test("startAllPortForwards starts inactive and error rules sequentially and skips busy tunnels", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const startedRuleIds: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: { ruleId: string }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          startedRuleIds.push(options.ruleId);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight -= 1;
          return { success: true };
        },
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        stopAllPortForwards: async () => undefined,
      },
    },
  });

  const busyRule = rule({ id: "bulk-busy", label: "Busy", status: "inactive" });
  await startPortForward(busyRule, host(), [], [], [], () => undefined);
  startedRuleIds.length = 0;
  maxInFlight = 0;

  const inactiveRule = rule({
    id: "bulk-inactive",
    label: "Inactive",
    status: "inactive",
    autoStart: true,
  });
  const errorRule = rule({
    id: "bulk-error",
    label: "Error",
    status: "error",
    autoStart: false,
  });
  const connectingRule = rule({
    id: "bulk-connecting",
    label: "Connecting",
    status: "connecting",
  });

  const result = await startAllPortForwards(
    [busyRule, inactiveRule, errorRule, connectingRule],
    () => host(),
    [host()],
    [],
    [],
    () => undefined,
  );

  assert.equal(maxInFlight, 1);
  assert.deepEqual(startedRuleIds, ["bulk-inactive", "bulk-error"]);
  assert.equal(result.started, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 2);

  stopAndCleanupRule("bulk-busy");
  stopAndCleanupRule("bulk-inactive");
  stopAndCleanupRule("bulk-error");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("startAllPortForwards records a missing host as a failed start", async () => {
  const startedRuleIds: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: { ruleId: string }) => {
          startedRuleIds.push(options.ruleId);
          return { success: true };
        },
        onPortForwardStatus: () => () => undefined,
      },
    },
  });

  const missingHostRule = rule({ id: "bulk-missing-host", label: "Missing", status: "inactive" });
  const statuses: Array<{ ruleId: string; status: string; error?: string }> = [];
  const hostNotFoundMessage = "pf.error.hostNotFound";
  const result = await startAllPortForwards(
    [missingHostRule],
    () => undefined,
    [],
    [],
    [],
    (ruleId, status, error) => statuses.push({ ruleId, status, error }),
    undefined,
    undefined,
    undefined,
    hostNotFoundMessage,
  );

  assert.deepEqual(startedRuleIds, []);
  assert.equal(result.started, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0]?.error, hostNotFoundMessage);
  assert.notEqual(result.errors[0]?.error, "Host not found");
  assert.equal(statuses.at(-1)?.status, "error");
  assert.equal(statuses.at(-1)?.error, hostNotFoundMessage);
});

test("stopAllActivePortForwards stops running rules then calls backend stopAll", async () => {
  const stoppedRuleIds: string[] = [];
  let stopAllCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async (ruleId: string) => {
          stoppedRuleIds.push(ruleId);
          return { stopped: 1, failed: 0, errors: [] };
        },
        stopAllPortForwards: async () => {
          stopAllCalls += 1;
        },
      },
    },
  });

  const first = rule({ id: "bulk-stop-1", label: "One", status: "inactive" });
  const second = rule({ id: "bulk-stop-2", label: "Two", status: "inactive" });
  const idle = rule({ id: "bulk-stop-idle", label: "Idle", status: "inactive" });
  await startPortForward(first, host(), [], [], [], () => undefined);
  await startPortForward(second, host(), [], [], [], () => undefined);

  const statuses: string[] = [];
  const result = await stopAllActivePortForwards(
    [first, second, idle],
    (ruleId, status) => statuses.push(`${ruleId}:${status}`),
  );

  assert.deepEqual(stoppedRuleIds, ["bulk-stop-1", "bulk-stop-2"]);
  assert.equal(stopAllCalls, 1);
  assert.equal(result.stopped, 2);
  assert.equal(result.failed, 0);
  assert.ok(statuses.includes("bulk-stop-1:inactive"));
  assert.ok(statuses.includes("bulk-stop-2:inactive"));
  assert.equal(getActiveConnection("bulk-stop-1"), undefined);
  assert.equal(getActiveConnection("bulk-stop-2"), undefined);
});

test("stopAllActivePortForwards reports a backend safety-net failure", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
        stopAllPortForwards: async () => {
          throw new Error("backend unavailable");
        },
      },
    },
  });

  const target = rule({ id: "bulk-stop-backend-failure" });
  await startPortForward(target, host(), [], [], [], () => undefined);
  const result = await stopAllActivePortForwards([target], () => undefined);

  assert.equal(result.failed, 1);
  assert.equal(result.errors[0]?.error, "backend unavailable");
});

test("stopAllPortForwards preserves a runtime when direct cleanup fails", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: () => () => undefined,
        stopPortForward: async () => ({ success: false, error: "still running" }),
        stopAllPortForwards: async () => undefined,
      },
    },
  });

  const target = rule({ id: "bulk-preserve-failed-stop" });
  await startPortForward(target, host(), [], [], [], () => undefined);
  await stopAllPortForwards();

  assert.equal(hasActivePortForwardRuntime(), true);
  assert.equal(getActiveConnection(target.id)?.status, "error");

  stopAndCleanupRule(target.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("stopAllPortForwards prevents an auto-reconnect after a manual stop", async () => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  let reconnectCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        stopPortForward: async () => {
          statusListener?.("inactive");
          return { success: true };
        },
      },
    },
  });
  setReconnectCallback(async () => {
    reconnectCalls += 1;
    return { success: true };
  });

  const target = rule({ id: "bulk-stop-no-reconnect" });
  await startPortForward(target, host(), [], [], [], () => undefined, true);
  await stopAllPortForwards();
  setReconnectCallback(null);

  assert.equal(getActiveConnection(target.id), undefined);
  assert.equal(reconnectCalls, 0);
});

test("stopAllPortForwards keeps a failed manual stop from auto-reconnecting", async () => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  let reconnectCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        stopPortForward: async () => {
          statusListener?.("error", "still running");
          return { success: false, error: "still running" };
        },
        stopAllPortForwards: async () => {
          statusListener?.("error", "late safety-net error");
          throw new Error("backend safety-net failed");
        },
      },
    },
  });
  setReconnectCallback(async () => {
    reconnectCalls += 1;
    return { success: true };
  });

  const target = rule({ id: "bulk-stop-failed-no-reconnect" });
  await startPortForward(target, host(), [], [], [], () => undefined, true);
  await stopAllPortForwards();
  statusListener?.("error", "late cleanup error");
  await new Promise<void>((resolve) => setImmediate(resolve));
  setReconnectCallback(null);

  const connection = getActiveConnection(target.id);
  assert.equal(connection?.status, "error");
  assert.equal(connection?.reconnectTimerCallback, undefined);
  assert.equal(reconnectCalls, 0);
  stopAndCleanupRule(target.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("stopAllActivePortForwards suppresses reconnects on the legacy stop path", async () => {
  let statusListener: ((status: PortForwardingRule["status"], error?: string | null) => void) | undefined;
  let reconnectCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: (_tunnelId: string, listener: typeof statusListener) => {
          statusListener = listener;
          return () => undefined;
        },
        stopPortForward: async () => {
          statusListener?.("error", "still running");
          return { success: false, error: "still running" };
        },
      },
    },
  });
  setReconnectCallback(async () => {
    reconnectCalls += 1;
    return { success: true };
  });

  const target = rule({ id: "bulk-legacy-stop-no-reconnect" });
  await startPortForward(target, host(), [], [], [], () => undefined, true);
  const result = await stopAllActivePortForwards([target], () => undefined);
  setReconnectCallback(null);

  assert.equal(result.failed, 1);
  assert.equal(reconnectCalls, 0);
  assert.equal(getActiveConnection(target.id)?.status, "error");
  stopAndCleanupRule(target.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("stopAllActivePortForwards reports failed cleanup for an unlisted runtime", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async () => ({ success: true }),
        onPortForwardStatus: () => () => undefined,
        stopPortForward: async () => ({ success: false, error: "orphan still running" }),
      },
    },
  });

  const target = rule({ id: "bulk-unlisted-runtime" });
  await startPortForward(target, host(), [], [], [], () => undefined);
  const result = await stopAllActivePortForwards([], () => undefined);

  assert.equal(result.failed, 1);
  assert.equal(result.errors[0]?.ruleId, target.id);
  assert.equal(result.errors[0]?.error, "orphan still running");
  stopAndCleanupRule(target.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("startAllPortForwards re-reads live rules before each queued start", async () => {
  const started: Array<{ ruleId: string; localPort: number }> = [];
  const liveRules = [
    rule({ id: "bulk-live-1", label: "One", status: "inactive", localPort: 18081 }),
    rule({ id: "bulk-live-2", label: "Two", status: "inactive", localPort: 18082 }),
    rule({ id: "bulk-live-3", label: "Three", status: "inactive", localPort: 18083 }),
  ];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: { ruleId: string; localPort: number }) => {
          started.push({ ruleId: options.ruleId, localPort: options.localPort });
          if (options.ruleId === "bulk-live-1") {
            const removed = liveRules.findIndex((item) => item.id === "bulk-live-2");
            if (removed >= 0) liveRules.splice(removed, 1);
            const edited = liveRules.findIndex((item) => item.id === "bulk-live-3");
            if (edited >= 0) {
              liveRules[edited] = { ...liveRules[edited], localPort: 19083 };
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { success: true };
        },
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async () => ({ stopped: 1, failed: 0, errors: [] }),
      },
    },
  });

  const snapshot = [...liveRules];
  const result = await startAllPortForwards(
    snapshot,
    () => host(),
    [host()],
    [],
    [],
    () => undefined,
    undefined,
    undefined,
    (ruleId) => liveRules.find((item) => item.id === ruleId),
  );

  assert.deepEqual(started, [
    { ruleId: "bulk-live-1", localPort: 18081 },
    { ruleId: "bulk-live-3", localPort: 19083 },
  ]);
  assert.equal(result.started, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 1);

  stopAndCleanupRule("bulk-live-1");
  stopAndCleanupRule("bulk-live-3");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("startAllPortForwards skips tracked error runtimes and stopAll stops them", async () => {
  const startedRuleIds: string[] = [];
  const stoppedRuleIds: string[] = [];
  let failNextStop = true;
  let stopAllCalls = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: { ruleId: string }) => {
          startedRuleIds.push(options.ruleId);
          return { success: true };
        },
        onPortForwardStatus: () => () => undefined,
        stopPortForwardByRuleId: async (ruleId: string) => {
          if (failNextStop) {
            failNextStop = false;
            return { stopped: 0, failed: 1, errors: ["stop failed"] };
          }
          stoppedRuleIds.push(ruleId);
          return { stopped: 1, failed: 0, errors: [] };
        },
        stopAllPortForwards: async () => {
          stopAllCalls += 1;
        },
      },
    },
  });

  const trackedError = rule({ id: "bulk-tracked-error", label: "Tracked", status: "inactive" });
  const idle = rule({ id: "bulk-idle-after-error", label: "Idle", status: "inactive" });
  await startPortForward(trackedError, host(), [], [], [], () => undefined);
  const failedStop = await stopPortForward(trackedError.id, () => undefined);
  assert.equal(failedStop.success, false);
  assert.equal(getActiveConnection("bulk-tracked-error")?.status, "error");

  startedRuleIds.length = 0;
  const startResult = await startAllPortForwards(
    [trackedError, idle],
    () => host(),
    [host()],
    [],
    [],
    () => undefined,
  );

  assert.deepEqual(startedRuleIds, ["bulk-idle-after-error"]);
  assert.equal(startResult.started, 1);
  assert.equal(startResult.skipped, 1);

  const stopResult = await stopAllActivePortForwards(
    [trackedError, idle],
    () => undefined,
  );
  assert.ok(stoppedRuleIds.includes("bulk-tracked-error"));
  assert.ok(stoppedRuleIds.includes("bulk-idle-after-error"));
  assert.equal(stopResult.stopped, 2);
  assert.equal(stopAllCalls, 1);

  stopAndCleanupRule("bulk-tracked-error");
  stopAndCleanupRule("bulk-idle-after-error");
  await new Promise<void>((resolve) => setImmediate(resolve));
});
