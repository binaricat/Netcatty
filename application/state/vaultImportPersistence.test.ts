import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_KEY_GROUPS,
  STORAGE_KEY_HOSTS,
  STORAGE_KEY_MANAGED_SOURCES,
} from "../../infrastructure/config/storageKeys.ts";
import {
  persistVaultImportMetadata,
  readStoredArray,
} from "./vaultImportPersistence.ts";

const createStorage = (
  initial: Record<string, string>,
  failKey?: string,
  failRestore = false,
) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read<T>(key: string): T | null {
      const value = values.get(key);
      return value === undefined ? null : JSON.parse(value) as T;
    },
    readString: (key: string) => values.get(key) ?? null,
    write<T>(key: string, value: T) {
      if (key === failKey) return false;
      values.set(key, JSON.stringify(value));
      return true;
    },
    writeString(key: string, value: string) {
      if (failRestore) return false;
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

test("Vault import metadata transaction restores groups when sources cannot be saved", () => {
  const originalGroups = JSON.stringify(["Existing"]);
  const storage = createStorage({
    [STORAGE_KEY_GROUPS]: originalGroups,
    [STORAGE_KEY_HOSTS]: JSON.stringify(["old-host"]),
    [STORAGE_KEY_MANAGED_SOURCES]: JSON.stringify([]),
  }, STORAGE_KEY_MANAGED_SOURCES);
  assert.throws(() => persistVaultImportMetadata(
    storage,
    (groups) => [...groups, "Imported"],
    (sources) => sources,
    [[STORAGE_KEY_HOSTS, ["new-host"]]],
  ), /rejected importer transaction/);

  assert.equal(storage.readString(STORAGE_KEY_GROUPS), originalGroups);
  assert.deepEqual(storage.read(STORAGE_KEY_HOSTS), ["old-host"]);
});

test("Vault import metadata reports when its rollback cannot be saved", () => {
  const storage = createStorage({
    [STORAGE_KEY_GROUPS]: JSON.stringify(["Existing"]),
    [STORAGE_KEY_MANAGED_SOURCES]: JSON.stringify([]),
  }, STORAGE_KEY_MANAGED_SOURCES, true);

  assert.throws(() => persistVaultImportMetadata(
    storage,
    (groups) => [...groups, "Imported"],
    (sources) => sources,
  ), /rollback failed/);
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
