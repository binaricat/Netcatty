import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_MANAGED_SOURCES,
} from "../../infrastructure/config/storageKeys.ts";
import {
  persistVaultImportMetadata,
  readStoredArray,
} from "./vaultImportPersistence.ts";

const createStorage = (initial: Record<string, string>, failKey?: string) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    readString: (key: string) => values.get(key) ?? null,
    write<T>(key: string, value: T) {
      if (key === failKey) return false;
      values.set(key, JSON.stringify(value));
      return true;
    },
    writeString(key: string, value: string) {
      values.set(key, value);
      return true;
    },
    remove(key: string) {
      values.delete(key);
    },
  };
};

test("Vault import metadata keeps current groups and sources", () => {
  const storage = createStorage({
    [STORAGE_KEY_GROUPS]: JSON.stringify(["Existing"]),
    [STORAGE_KEY_MANAGED_SOURCES]: JSON.stringify([]),
  });
  const result = persistVaultImportMetadata(
    storage,
    (groups) => [...groups, "Imported"],
    (sources) => [...sources, {
      id: "source-1",
      type: "ssh_config",
      filePath: "/tmp/config",
      groupName: "Imported",
      lastSyncedAt: 1,
    }],
  );

  assert.equal(result.persisted, true);
  assert.deepEqual(result.groups, ["Existing", "Imported"]);
  assert.equal(result.sources.length, 1);
});

test("Vault import metadata restores groups when sources cannot be saved", () => {
  const originalGroups = JSON.stringify(["Existing"]);
  const storage = createStorage({
    [STORAGE_KEY_GROUPS]: originalGroups,
    [STORAGE_KEY_MANAGED_SOURCES]: JSON.stringify([]),
  }, STORAGE_KEY_MANAGED_SOURCES);
  const result = persistVaultImportMetadata(
    storage,
    (groups) => [...groups, "Imported"],
    (sources) => sources,
  );

  assert.equal(result.persisted, false);
  assert.equal(storage.readString(STORAGE_KEY_GROUPS), originalGroups);
});

test("Vault import persistence rejects unreadable existing arrays", () => {
  assert.throws(
    () => readStoredArray(STORAGE_KEY_GROUPS, "{broken"),
    /unreadable/,
  );
  assert.throws(
    () => readStoredArray(STORAGE_KEY_GROUPS, JSON.stringify({ group: "wrong" })),
    /unreadable/,
  );
});
