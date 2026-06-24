import test from "node:test";
import assert from "node:assert/strict";

import {
  createStoredStringSyncHandlers,
  readStoredStringValue,
  resolveStoredStringUpdate,
} from "./useStoredString.ts";

type TestMode = "edit" | "preview";

const isTestMode = (value: string | null): value is TestMode =>
  value === "edit" || value === "preview";

function installLocalStorage() {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const backing = new Map<string, string>();
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
      backing.delete(key);
    },
    setItem(key: string, value: string) {
      backing.set(key, value);
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });

  return {
    storage,
    restore() {
      if (previousLocalStorage) {
        Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
        return;
      }
      Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

test("stored string sync handlers refresh from same-window and browser storage events", (t) => {
  const env = installLocalStorage();
  t.after(() => env.restore());

  const storageKey = "netcatty:test-mode";
  const syncedValues: TestMode[] = [];
  const handlers = createStoredStringSyncHandlers<TestMode>({
    storageKey,
    fallback: "edit",
    isAllowedValue: isTestMode,
    onValue: (value) => syncedValues.push(value),
  });

  env.storage.setItem(storageKey, "preview");
  handlers.handleAdapterChange({ detail: { key: storageKey } } as CustomEvent<{ key: string }>);
  assert.deepEqual(syncedValues, ["preview"]);

  env.storage.setItem(storageKey, "invalid");
  handlers.handleBrowserStorage({ type: "storage", key: storageKey } as StorageEvent);
  assert.deepEqual(syncedValues, ["preview", "edit"]);

  env.storage.setItem(storageKey, "preview");
  handlers.handleAdapterChange({ detail: { key: "other-key" } } as CustomEvent<{ key: string }>);
  assert.deepEqual(syncedValues, ["preview", "edit"]);
});

test("stored string helpers read fallback and resolve updater-style toggles", (t) => {
  const env = installLocalStorage();
  t.after(() => env.restore());

  const storageKey = "netcatty:test-mode";
  assert.equal(readStoredStringValue(storageKey, "edit", isTestMode), "edit");

  env.storage.setItem(storageKey, "preview");
  assert.equal(readStoredStringValue(storageKey, "edit", isTestMode), "preview");

  env.storage.setItem(storageKey, "invalid");
  assert.equal(readStoredStringValue(storageKey, "edit", isTestMode), "edit");

  assert.equal(resolveStoredStringUpdate<TestMode>("edit", "preview"), "preview");
  assert.equal(
    resolveStoredStringUpdate<TestMode>("preview", (currentValue) => (
      currentValue === "edit" ? "preview" : "edit"
    )),
    "edit",
  );
});
