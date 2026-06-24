import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from "./localStorageAdapter.ts";

class TestCustomEvent<T = unknown> extends Event implements CustomEvent<T> {
  readonly detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }

  initCustomEvent(): void {
    // Deprecated browser API required by the CustomEvent interface.
  }
}

const waitForAdapterEvents = () => new Promise((resolve) => {
  setTimeout(resolve, 5);
});

function installLocalStorageEnvironment() {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
  const previousDispatchEvent = Object.getOwnPropertyDescriptor(globalThis, "dispatchEvent");
  const backing = new Map<string, string>();
  const events: string[] = [];
  let setCalls = 0;
  let removeCalls = 0;

  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key: string) {
      return backing.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    removeItem(key: string) {
      removeCalls += 1;
      backing.delete(key);
    },
    setItem(key: string, value: string) {
      setCalls += 1;
      backing.set(key, value);
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    value: TestCustomEvent,
    configurable: true,
  });
  Object.defineProperty(globalThis, "dispatchEvent", {
    value: (event: Event): boolean => {
      if (event.type === LOCAL_STORAGE_ADAPTER_CHANGED_EVENT) {
        events.push((event as CustomEvent<{ key: string }>).detail.key);
      }
      return true;
    },
    configurable: true,
  });

  const restoreDescriptor = (property: "localStorage" | "CustomEvent" | "dispatchEvent", descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Object.defineProperty(globalThis, property, descriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, property);
  };

  return {
    events,
    get setCalls() {
      return setCalls;
    },
    get removeCalls() {
      return removeCalls;
    },
    restore() {
      restoreDescriptor("localStorage", previousLocalStorage);
      restoreDescriptor("CustomEvent", previousCustomEvent);
      restoreDescriptor("dispatchEvent", previousDispatchEvent);
    },
  };
}

test("localStorageAdapter skips unchanged writes and notifications", async (t) => {
  const env = installLocalStorageEnvironment();
  t.after(() => env.restore());

  assert.equal(localStorageAdapter.writeString("netcatty:test", "one"), true);
  await waitForAdapterEvents();

  assert.deepEqual(env.events, ["netcatty:test"]);
  assert.equal(env.setCalls, 1);

  assert.equal(localStorageAdapter.writeString("netcatty:test", "one"), true);
  await waitForAdapterEvents();

  assert.deepEqual(env.events, ["netcatty:test"]);
  assert.equal(env.setCalls, 1);

  assert.equal(localStorageAdapter.write("netcatty:json", { ok: true }), true);
  await waitForAdapterEvents();

  assert.equal(localStorageAdapter.write("netcatty:json", { ok: true }), true);
  await waitForAdapterEvents();

  assert.deepEqual(env.events, ["netcatty:test", "netcatty:json"]);
  assert.equal(env.setCalls, 2);
});

test("localStorageAdapter skips missing removes and notifications", async (t) => {
  const env = installLocalStorageEnvironment();
  t.after(() => env.restore());

  localStorageAdapter.remove("netcatty:missing");
  await waitForAdapterEvents();

  assert.deepEqual(env.events, []);
  assert.equal(env.removeCalls, 0);

  assert.equal(localStorageAdapter.writeString("netcatty:test", "one"), true);
  await waitForAdapterEvents();
  localStorageAdapter.remove("netcatty:test");
  await waitForAdapterEvents();

  assert.deepEqual(env.events, ["netcatty:test", "netcatty:test"]);
  assert.equal(env.removeCalls, 1);
});
