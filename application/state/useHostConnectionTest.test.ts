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
