import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { Host } from "../../domain/models.ts";
import { useHostConnectionTest } from "./useHostConnectionTest.ts";

type HookApi = ReturnType<typeof useHostConnectionTest>;

const targetHost: Host = {
  id: "host-1",
  label: "Target",
  hostname: "target.example.test",
  port: 22,
  username: "alice",
  password: "secret",
  tags: [],
  os: "linux",
  protocol: "ssh",
  // Shorter than the fixed 15s test auth timeout sent to the bridge.
  sshAuthReadyTimeoutSeconds: 5,
};

test("connection test countdown follows the probe timeouts and invalidates the attempt on timeout", async (t) => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

  let resolveProbe: (value: unknown) => void = () => {};
  const cancelled: string[] = [];
  const startedSessionIds: string[] = [];
  const bridge = {
    testConnection: (options: { sessionId: string }) => {
      startedSessionIds.push(options.sessionId);
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    },
    cancelTestConnection: async (sessionId: string) => {
      cancelled.push(sessionId);
      return { success: true };
    },
    onChainProgress: () => () => {},
    onHostKeyVerification: () => () => {},
    respondHostKeyVerification: async () => ({ success: true }),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { netcatty: bridge },
  });

  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let api: HookApi | null = null;
  let renderer: ReactTestRenderer | null = null;
  const Probe = () => {
    api = useHostConnectionTest({ host: targetHost, hosts: [targetHost], keys: [] });
    return null;
  };
  const current = () => {
    assert.ok(api);
    return api;
  };

  t.after(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    mock.timers.reset();
    if (previousWindowDescriptor) Object.defineProperty(globalThis, "window", previousWindowDescriptor);
    else delete (globalThis as { window?: unknown }).window;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  await act(async () => {
    void current().startTest();
  });
  assert.equal(current().state.status, "connecting");
  // 8s TCP + 15s auth sent to the bridge, plus a 2s grace.
  assert.equal(current().state.timeLeft, 25);

  // The host's own 5s auth timeout must not end the test early.
  await act(async () => {
    mock.timers.tick(6000);
  });
  assert.equal(current().state.status, "connecting");
  assert.deepEqual(cancelled, []);

  await act(async () => {
    mock.timers.tick(19_000);
  });
  assert.equal(current().state.status, "disconnected");
  assert.equal(current().state.error, "Connection timed out. Please try again.");
  assert.deepEqual(cancelled, startedSessionIds, "timeout must cancel the in-flight probe");

  // A late success from the cancelled probe must not overwrite the timeout.
  await act(async () => {
    resolveProbe({ sessionId: startedSessionIds[0], testResult: "connected" });
    await Promise.resolve();
  });
  assert.equal(current().state.status, "disconnected");
  assert.equal(current().state.error, "Connection timed out. Please try again.");
});

test("connection test seeds the bastion address and tracks the final host label", async (t) => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let listener: Parameters<NonNullable<NetcattyBridge["onChainProgress"]>>[0] = () => {};
  let sessionId = "";
  const bridge = {
    testConnection: (options: { sessionId: string; hostLabel?: string }) => {
      sessionId = options.sessionId;
      assert.equal(options.hostLabel, "Prod DB");
      return new Promise(() => {});
    },
    cancelTestConnection: async () => ({ success: true }),
    onChainProgress: (cb: typeof listener) => { listener = cb; return () => {}; },
    onHostKeyVerification: () => () => {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true, writable: true, value: { netcatty: bridge },
  });
  const target: Host = {
    ...targetHost, label: "Prod DB", hostname: "192.168.1.10", hostChain: { hostIds: ["jump-1"] },
  };
  const bastion: Host = {
    ...targetHost, id: "jump-1", label: "Bastion", hostname: "bastion.example.com", port: 2222,
  };
  let api: HookApi | null = null;
  let renderer: ReactTestRenderer | null = null;
  const Probe = () => {
    api = useHostConnectionTest({ host: target, hosts: [target, bastion], keys: [] });
    return null;
  };
  const current = () => { assert.ok(api); return api; };
  t.after(async () => {
    await act(async () => { renderer?.unmount(); });
    if (previousWindowDescriptor) Object.defineProperty(globalThis, "window", previousWindowDescriptor);
    else delete (globalThis as { window?: unknown }).window;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });
  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { void current().startTest(); });
  const firstHop = {
    currentHop: 1, totalHops: 2, currentHostLabel: "Bastion",
    currentHostname: "bastion.example.com", currentPort: 2222, connectionPhase: "connecting",
  };
  assert.deepEqual(current().state.chainProgress, firstHop);
  await act(async () => {
    listener(sessionId, 1, 2, "Bastion", "connecting", undefined,
      { hostname: "bastion.example.com", port: 2222 });
  });
  assert.deepEqual(current().state.chainProgress, firstHop);
  await act(async () => {
    listener(sessionId, 2, 2, "Prod DB", "connecting", undefined,
      { hostname: "192.168.1.10", port: 22 });
  });
  assert.deepEqual(current().state.chainProgress, {
    currentHop: 2, totalHops: 2, currentHostLabel: "Prod DB",
    currentHostname: "192.168.1.10", currentPort: 22, connectionPhase: "connecting",
  });
  assert.ok(current().state.progressLogs.includes("[2/2] Connecting to Prod DB..."));
  assert.equal(current().state.progressLogs.includes("[2/2] Connecting to 192.168.1.10..."), false);
  await act(async () => { listener(sessionId, 2, 2, "Prod DB", "authenticating"); });
  assert.equal(current().state.chainProgress?.currentHostname, undefined);
  assert.equal(current().state.chainProgress?.currentPort, undefined);
});
