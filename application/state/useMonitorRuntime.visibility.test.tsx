import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  AppSettingsRuntimeContext,
  AppVaultRuntimeContext,
  type AppSettingsRuntime,
  type AppVaultContextValue,
} from "./appRuntimeBridge";
import { useMonitorRuntime } from "./useMonitorRuntime";

const MOCK_VAULT_CONTEXT = {
  hosts: [],
  keys: [],
  identities: [],
  groupConfigs: [],
  proxyProfiles: [],
  knownHosts: [],
  isInitialized: true,
} as unknown as AppVaultContextValue;

const MOCK_SETTINGS_CONTEXT = {
  terminalSettings: { verifyHostKeys: true, keepaliveInterval: 30, keepaliveCountMax: 10 },
} as unknown as AppSettingsRuntime;

function wrapWithProviders(node: React.ReactElement) {
  return React.createElement(
    AppVaultRuntimeContext.Provider,
    { value: MOCK_VAULT_CONTEXT },
    React.createElement(
      AppSettingsRuntimeContext.Provider,
      { value: MOCK_SETTINGS_CONTEXT },
      node,
    ),
  );
}

function installDomGlobals(initialVisibility: DocumentVisibilityState = "visible") {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  const visibilityListeners = new Set<() => void>();
  const windowListeners = new Map<string, Set<() => void>>();
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() { return backing.size; },
    clear() { backing.clear(); },
    getItem(key) { return backing.get(key) ?? null; },
    key(index) { return Array.from(backing.keys())[index] ?? null; },
    removeItem(key) { backing.delete(key); },
    setItem(key, value) { backing.set(key, value); },
  };
  let visibilityState: DocumentVisibilityState = initialVisibility;

  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("localStorage", storage);
  setGlobal("window", {
    addEventListener(type: string, listener: () => void) {
      let set = windowListeners.get(type);
      if (!set) {
        set = new Set();
        windowListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      windowListeners.get(type)?.delete(listener);
    },
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

test("useMonitorRuntime pauses monitorSnapshot polling when hidden and catches up immediately on visible", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const env = installDomGlobals("visible");

  let snapshotCalls = 0;
  let updateCalls = 0;

  t.mock.method(netcattyBridge, "get", () => ({
    monitorUpdate: async () => {
      updateCalls += 1;
      return { epoch: 1, runtimeId: "rt-1", panels: {}, hosts: {}, history: {} };
    },
    monitorSnapshot: async () => {
      snapshotCalls += 1;
      return { epoch: 1, runtimeId: "rt-1", panels: {}, hosts: {}, history: {} };
    },
    monitorStopAll: async () => undefined,
  }));

  function Probe() {
    useMonitorRuntime();
    return null;
  }

  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(wrapWithProviders(React.createElement(Probe)));
    });
    assert.equal(snapshotCalls, 1, "initial visible poll should run on mount");
    const initialUpdateCalls = updateCalls;

    // Idle polling interval is 10s while visible
    await act(async () => t.mock.timers.tick(10_000));
    assert.equal(snapshotCalls, 2);

    // Hide document: renderer polling pauses, main-process demand is untouched
    await env.setVisibility("hidden");
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(snapshotCalls, 2, "hidden document must not poll monitorSnapshot");
    assert.equal(updateCalls, initialUpdateCalls, "main-process monitorUpdate must stay untouched");

    // Return to visible: immediate catch-up poll + resumes 10s timer
    await env.setVisibility("visible");
    assert.equal(snapshotCalls, 3, "returning to visible must immediately poll monitorSnapshot");

    await act(async () => t.mock.timers.tick(10_000));
    assert.equal(snapshotCalls, 4, "polling must resume after returning to visible");
  } finally {
    await act(async () => { root?.unmount(); });
    assert.equal(env.visibilityListeners.size, 0, "visibility listener must detach on unmount");
    env.restore();
    t.mock.timers.reset();
  }
});

test("useMonitorRuntime mounted while hidden waits until visible to poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const env = installDomGlobals("hidden");

  let snapshotCalls = 0;

  t.mock.method(netcattyBridge, "get", () => ({
    monitorUpdate: async () => ({ epoch: 1, runtimeId: "rt-1", panels: {}, hosts: {}, history: {} }),
    monitorSnapshot: async () => {
      snapshotCalls += 1;
      return { epoch: 1, runtimeId: "rt-1", panels: {}, hosts: {}, history: {} };
    },
    monitorStopAll: async () => undefined,
  }));

  function Probe() {
    useMonitorRuntime();
    return null;
  }

  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(wrapWithProviders(React.createElement(Probe)));
    });
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(snapshotCalls, 0, "mounted while hidden must not poll monitorSnapshot");

    await env.setVisibility("visible");
    assert.equal(snapshotCalls, 1, "becoming visible must trigger catch-up poll");
  } finally {
    await act(async () => { root?.unmount(); });
    env.restore();
    t.mock.timers.reset();
  }
});
