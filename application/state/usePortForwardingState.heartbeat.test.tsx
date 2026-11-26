import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  resetPortForwardingStateForTests,
  shouldRunPortForwardingHeartbeat,
  usePortForwardingState,
  type UsePortForwardingStateResult,
} from "./usePortForwardingState";

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

  const visibilityListeners = new Set<() => void>();
  let visibilityState: DocumentVisibilityState = "visible";

  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("localStorage", storage);
  setGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  });
  setGlobal("document", {
    get visibilityState() { return visibilityState; },
    get hidden() { return visibilityState === "hidden"; },
    addEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") visibilityListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") visibilityListeners.delete(listener);
    },
  });

  return {
    visibilityListeners,
    async setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      await act(async () => {
        for (const listener of [...visibilityListeners]) listener();
      });
    },
    restore() {
      for (const [key, desc] of previous.entries()) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("usePortForwardingState disarms heartbeat with 0 rules, arms dynamically on rule add, pauses when hidden, and reconciles on visible", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const env = installDomGlobals();
  resetPortForwardingStateForTests();

  let listCalls = 0;
  let failList = false;

  t.mock.method(netcattyBridge, "get", () => ({
    listPortForwards: async () => {
      listCalls += 1;
      if (failList) throw new Error("backend unavailable");
      return [];
    },
    subscribePortForwardRuntime: async () => ({ epoch: "e1", revision: 0, tunnels: [] }),
    onPortForwardRuntime: () => () => undefined,
    unsubscribePortForwardRuntime: async () => undefined,
    stopPortForwardByRuleId: async () => ({ stopped: 0, failed: 0, errors: [] }),
  }));

  let api!: UsePortForwardingStateResult;
  function Probe() {
    api = usePortForwardingState();
    return null;
  }

  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(React.createElement(Probe));
    });

    // Startup init + runtime subscription run initial syncs, after which
    // snapshotAvailable is true and globalRules is empty -> heartbeat disarms.
    const baselineCalls = listCalls;
    assert.equal(shouldRunPortForwardingHeartbeat(), false);

    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(listCalls, baselineCalls, "0 rules + healthy snapshot must not run 4s heartbeat");

    // Dynamically adding a rule arms the 4s heartbeat without remounting.
    let createdId = "";
    await act(async () => {
      const created = api.addRule({
        label: "Web",
        type: "local",
        localPort: 8080,
        remoteHost: "127.0.0.1",
        remotePort: 80,
        hostId: "host-1",
        bindAddress: "127.0.0.1",
      });
      createdId = created.id;
    });
    assert.equal(shouldRunPortForwardingHeartbeat(), true);

    await act(async () => t.mock.timers.tick(4_000));
    assert.equal(listCalls, baselineCalls + 1, "heartbeat should fire after rule is added");

    // Hiding the document pauses the 4s heartbeat.
    await env.setVisibility("hidden");
    assert.equal(shouldRunPortForwardingHeartbeat(), false);
    const hiddenCalls = listCalls;
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(listCalls, hiddenCalls, "hidden document must not fire heartbeat ticks");

    // Returning to visible triggers immediate reconcileWithBackend() and resumes 4s ticks.
    await env.setVisibility("visible");
    assert.equal(listCalls, hiddenCalls + 1, "returning to visible must immediately reconcile");
    await act(async () => t.mock.timers.tick(4_000));
    assert.equal(listCalls, hiddenCalls + 2, "4s heartbeat must resume after returning to visible");

    // Deleting the last rule dynamically disarms the heartbeat again.
    await act(async () => {
      api.deleteRule(createdId);
    });
    assert.equal(shouldRunPortForwardingHeartbeat(), false);
    const afterDeleteCalls = listCalls;
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(listCalls, afterDeleteCalls, "deleting last rule must disarm heartbeat");

    // Snapshot unavailable keeps heartbeat armed even with 0 rules until recovery.
    await act(async () => { root?.unmount(); });
    resetPortForwardingStateForTests();
    failList = true;
    listCalls = 0;

    await act(async () => {
      root = create(React.createElement(Probe));
    });
    assert.equal(shouldRunPortForwardingHeartbeat(), true, "unavailable snapshot must keep heartbeat armed");
    const unavailableBaseline = listCalls;

    failList = false;
    await act(async () => t.mock.timers.tick(4_000));
    assert.equal(listCalls, unavailableBaseline + 1, "recovery heartbeat tick must fire when snapshot was unavailable");
    assert.equal(shouldRunPortForwardingHeartbeat(), false, "heartbeat must disarm once snapshot recovers with 0 rules");
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(listCalls, unavailableBaseline + 1);
  } finally {
    await act(async () => { root?.unmount(); });
    assert.equal(env.visibilityListeners.size, 0, "visibility listener must detach on unmount");
    resetPortForwardingStateForTests();
    env.restore();
    t.mock.timers.reset();
  }
});
