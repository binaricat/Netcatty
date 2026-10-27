import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { JSDOM } from "jsdom";
import { installBrowserLockFixture } from "../testSupport/browserLockFixture";
import { STORAGE_KEY_SHELL_HISTORY } from "../../infrastructure/config/storageKeys";

test("shell history append yields the input turn and persists merged entries", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  const globals = ["window", "localStorage", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT", "navigator"];
  const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    localStorage: { value: dom.window.localStorage, configurable: true },
    CustomEvent: { value: dom.window.CustomEvent, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  installBrowserLockFixture();
  const { useVaultState } = await import("./useVaultState");
  let state: ReturnType<typeof useVaultState>;
  let renderer: ReactTestRenderer | undefined;
  const Probe = () => { state = useVaultState({ syncConnectionLogTerminalData: false }); return null; };
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    for (let attempt = 0; !state!.isInitialized && attempt < 50; attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    assert.equal(state!.isInitialized, true);
    const entry = { command: " echo hello ", hostId: "local", hostLabel: "Local", sessionId: "one" };
    act(() => {
      state!.addShellHistoryEntry(entry);
      state!.addShellHistoryEntry({ ...entry, sessionId: "two" });
      assert.equal(dom.window.localStorage.getItem(STORAGE_KEY_SHELL_HISTORY), null);
      assert.equal(state!.shellHistory.length, 0);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const saved = JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_SHELL_HISTORY)!);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].command, "echo hello");
    assert.equal(saved[0].sessionId, "two");
    assert.deepEqual(state!.shellHistory, saved);

    for (const clear of [() => state!.clearShellHistory(), () => state!.clearAllCommandHistory()]) {
      act(() => {
        state!.addShellHistoryEntry(entry);
        state!.addShellHistoryEntry({ ...entry, command: "another command" });
        clear();
      });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      assert.deepEqual(state!.shellHistory, []);
      assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_SHELL_HISTORY)!), []);
    }
  } finally {
    await act(async () => { renderer?.unmount(); });
    dom.window.close();
    for (const key of globals) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
