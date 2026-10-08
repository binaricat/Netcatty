import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SCRIPTS_VIEW_MODE_STORAGE_KEY, useScriptsViewMode } from "./useScriptsViewMode.ts";

test("script view changes follow native storage events from another window", async (t) => {
  const windowA = new EventTarget();
  const windowB = new EventTarget();
  let activeWindow = windowA;
  const data = new Map<string, string>();
  const values = {
    localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } },
    addEventListener: (type: string, listener: EventListener) => activeWindow.addEventListener(type, listener),
    removeEventListener: (type: string, listener: EventListener) => activeWindow.removeEventListener(type, listener),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let a!: ReturnType<typeof useScriptsViewMode>;
  let b!: ReturnType<typeof useScriptsViewMode>;
  function FirstWindow() { a = useScriptsViewMode(); return null; }
  function SecondWindow() { b = useScriptsViewMode(); return null; }
  let first!: ReactTestRenderer;
  let second!: ReactTestRenderer;
  t.after(async () => {
    activeWindow = windowA; await act(async () => first?.unmount());
    activeWindow = windowB; await act(async () => second?.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  activeWindow = windowA; await act(async () => { first = create(React.createElement(FirstWindow)); });
  activeWindow = windowB; await act(async () => { second = create(React.createElement(SecondWindow)); });
  assert.equal(a[0], "list"); assert.equal(b[0], "list");
  // BrowserWindow A writes shared storage. Electron emits the native event
  // in B, not an adapter CustomEvent from A's independent JS environment.
  activeWindow = windowA; await act(async () => a[1]("stacked"));
  assert.equal(data.get(SCRIPTS_VIEW_MODE_STORAGE_KEY), "stacked");
  assert.equal(b[0], "list");
  const notify = async (target: EventTarget, key = SCRIPTS_VIEW_MODE_STORAGE_KEY) => {
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: key });
    await act(async () => { target.dispatchEvent(event); });
  };
  activeWindow = windowB; await notify(windowB);
  assert.equal(b[0], "stacked");
  await act(async () => b[1]("list"));
  assert.equal(a[0], "stacked");
  activeWindow = windowA; await notify(windowA);
  assert.equal(a[0], "list");
  data.set(SCRIPTS_VIEW_MODE_STORAGE_KEY, "stacked");
  await notify(windowA, "unrelated");
  assert.equal(a[0], "list", "unrelated preferences must not trigger an update");
});
