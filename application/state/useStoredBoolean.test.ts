import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useStoredBoolean } from "./useStoredBoolean.ts";

const STORAGE_KEY = "netcatty:test:stored-boolean";

test("functional updates stay pure when another consumer shares the storage key", async () => {
  const values = new Map<string, string>([[STORAGE_KEY, "false"]]);
  const fakeStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const fakeWindow = new EventTarget();
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    localStorage?: typeof fakeStorage;
    window?: typeof fakeWindow;
  };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDispatchEvent = Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent");
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
  let renderer: ReactTestRenderer | null = null;
  let toggle: (() => void) | null = null;
  let parentValue = false;
  let childValue = false;
  const errors: string[] = [];
  const originalConsoleError = console.error;

  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  Object.defineProperty(globalThis, "dispatchEvent", {
    value: fakeWindow.dispatchEvent.bind(fakeWindow),
    configurable: true,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    value: class TestCustomEvent<T> extends Event implements CustomEvent<T> {
      readonly detail: T;

      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }

      initCustomEvent(): void {
        // Deprecated browser API required by the CustomEvent interface.
      }
    },
    configurable: true,
  });
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  const Parent = () => {
    [parentValue] = useStoredBoolean(STORAGE_KEY);
    return React.createElement(Child);
  };
  const Child = () => {
    const [value, setValue] = useStoredBoolean(STORAGE_KEY);
    childValue = value;
    toggle = () => setValue((previous) => !previous);
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(React.StrictMode, null, React.createElement(Parent)));
    });
    await act(async () => {
      toggle?.();
    });

    assert.equal(parentValue, true);
    assert.equal(childValue, true);
    assert.equal(values.get(STORAGE_KEY), "true");
    assert.equal(
      errors.some((message) => message.includes("Cannot update a component")
        && message.includes("while rendering a different component")),
      false,
    );
  } finally {
    console.error = originalConsoleError;
    await act(async () => {
      renderer?.unmount();
    });
    globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else delete globals.localStorage;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globals.window;
    if (previousDispatchEvent) Object.defineProperty(globalThis, "dispatchEvent", previousDispatchEvent);
    else delete (globalThis as typeof globalThis & { dispatchEvent?: unknown }).dispatchEvent;
    if (previousCustomEvent) Object.defineProperty(globalThis, "CustomEvent", previousCustomEvent);
    else delete (globalThis as typeof globalThis & { CustomEvent?: unknown }).CustomEvent;
  }
});
