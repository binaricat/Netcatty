import test from "node:test";
import assert from "node:assert/strict";

import type { SyncPayload } from "../domain/sync.ts";
import type { KnownHost } from "../domain/models.ts";
import type { SyncableVaultData } from "./syncPayload.ts";

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function installLocalStorage(): LocalStorageMock {
  const store = new Map<string, string>();
  const localStorage: LocalStorageMock = {
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  return localStorage;
}

const localStorage = installLocalStorage();
const {
  applyLocalVaultPayload,
  applySyncPayload,
  buildLocalVaultPayload,
  buildSyncPayload,
  hasMeaningfulCloudSyncData,
} = await import("./syncPayload.ts");

const knownHost = (id = "kh-1"): KnownHost => ({
  id,
  hostname: `${id}.example.com`,
  port: 22,
  keyType: "ssh-ed25519",
  fingerprint: `SHA256:${id}`,
});

const vault = (knownHosts: KnownHost[] = [knownHost()]): SyncableVaultData => ({
  hosts: [],
  keys: [],
  identities: [],
  snippets: [],
  customGroups: [],
  snippetPackages: [],
  knownHosts,
  groupConfigs: [],
});

test.beforeEach(() => {
  localStorage.clear();
});

test("buildSyncPayload treats known hosts as local-only data", () => {
  const payload = buildSyncPayload(vault([knownHost("kh-cloud")]));

  assert.equal("knownHosts" in payload, false);
});

test("hasMeaningfulCloudSyncData ignores legacy cloud known hosts", () => {
  assert.equal(
    hasMeaningfulCloudSyncData({
      hosts: [],
      keys: [],
      identities: [],
      snippets: [],
      customGroups: [],
      knownHosts: [knownHost("kh-only")],
      syncedAt: 1,
    }),
    false,
  );
});

test("buildLocalVaultPayload preserves known hosts for local backups", () => {
  const payload = buildLocalVaultPayload(vault([knownHost("kh-local")]));

  assert.deepEqual(payload.knownHosts, [knownHost("kh-local")]);
});

test("applySyncPayload ignores legacy cloud known hosts", () => {
  let imported: Record<string, unknown> | null = null;
  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    knownHosts: [knownHost("kh-legacy")],
    syncedAt: 1,
  };

  applySyncPayload(payload, {
    importVaultData: (json) => {
      imported = JSON.parse(json);
    },
  });

  assert.ok(imported);
  assert.equal("knownHosts" in imported, false);
});

test("applyLocalVaultPayload restores known hosts from local backups", () => {
  let imported: Record<string, unknown> | null = null;
  const payload: SyncPayload = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    knownHosts: [knownHost("kh-backup")],
    syncedAt: 1,
  };

  applyLocalVaultPayload(payload, {
    importVaultData: (json) => {
      imported = JSON.parse(json);
    },
  });

  assert.ok(imported);
  assert.deepEqual(imported.knownHosts, [knownHost("kh-backup")]);
});
