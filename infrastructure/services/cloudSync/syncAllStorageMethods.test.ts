import test from "node:test";
import assert from "node:assert/strict";

import { EncryptionService } from "../EncryptionService.ts";
import {
  clearProviderMergeStateImpl,
  commitRemoteInspectionImpl,
} from "./authMethods.ts";
import { syncToProviderImpl, uploadToProviderImpl } from "./providerSyncMethods.ts";
import {
  clearSyncBaseImpl,
  loadSyncSnapshotsImpl,
  saveSyncBaseImpl,
  syncAllProvidersImpl,
} from "./syncAllStorageMethods.ts";
import type { CloudProvider, SyncedFile, SyncPayload } from "../../../domain/sync.ts";

function payload(hostId: string): SyncPayload {
  return payloadWithHosts([hostId]);
}

function payloadWithHosts(hostIds: string[]): SyncPayload {
  return {
    hosts: hostIds.map((hostId) => ({
      id: hostId,
      label: hostId,
      hostname: `${hostId}.example.com`,
      port: 22,
      username: "root",
      tags: [],
      os: "linux",
    })),
    keys: [],
    identities: [],
    proxyProfiles: [],
    snippets: [],
    customGroups: [],
    snippetPackages: [],
    portForwardingRules: [],
    groupConfigs: [],
    settings: undefined,
    syncedAt: 0,
  };
}

function remoteFile(provider: CloudProvider, version: number, updatedAt: number): SyncedFile {
  return {
    meta: {
      version,
      updatedAt,
      deviceId: `${provider}-device`,
      deviceName: provider,
      appVersion: "0.0.0",
      iv: "",
      salt: "",
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      kdfIterations: 1,
    },
    payload: provider,
  };
}

test("provider identity changes clear v1 base, v2 baseline, and remote anchor together", () => {
  const removed: string[] = [];
  const manager = {
    syncBaseKey: (provider: CloudProvider) => `base:${provider}`,
    convergentProviderBaselineKey: (provider: CloudProvider) => `convergent:${provider}`,
    removeFromStorage: (key: string) => removed.push(key),
    clearSyncAnchor: (provider: CloudProvider) => removed.push(`anchor:${provider}`),
  };

  clearProviderMergeStateImpl.call(manager, "github");

  assert.deepEqual(removed, ["base:github", "convergent:github", "anchor:github"]);
});

test("clearing all merge bases also removes every convergent provider baseline", () => {
  const removed = new Set<string>();
  const providers: CloudProvider[] = ["github", "google", "onedrive", "webdav", "s3"];
  const manager = {
    removeFromStorage: (key: string) => removed.add(key),
    syncBaseKey: (provider?: CloudProvider) => `base:${provider ?? "default"}`,
    syncSnapshotsKey: (provider?: CloudProvider) => `snapshots:${provider ?? "default"}`,
    convergentProviderBaselineKey: (provider: CloudProvider) => `convergent:${provider}`,
    clearSyncAnchor: () => {},
  };

  clearSyncBaseImpl.call(manager);

  for (const provider of providers) {
    assert.equal(removed.has(`convergent:${provider}`), true);
  }
});

test("syncAllProviders uses the newest cloud payload without merging other remotes when cloud wins", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;

  const githubRemote = remoteFile("github", 3, 300);
  const googleRemote = remoteFile("google", 2, 200);
  const githubPayload = payload("github-winner");
  const localPayload = payload("local");
  const uploaded: Array<{ provider: CloudProvider; payload: SyncPayload }> = [];
  const committed: CloudProvider[] = [];

  EncryptionService.decryptPayload = async (file: SyncedFile) => {
    if (file === githubRemote) return githubPayload;
    return payload("google-loser");
  };
  EncryptionService.encryptPayload = async (outgoing: SyncPayload) => ({
    ...remoteFile("github", 4, 400),
    payload: JSON.stringify(outgoing),
  });

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: { enabled: true, connected: true, status: "connected" },
          google: { enabled: true, connected: true, status: "connected" },
          onedrive: { enabled: false, connected: false, status: "disconnected" },
          webdav: { enabled: false, connected: false, status: "disconnected" },
          s3: { enabled: false, connected: false, status: "disconnected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "preferCloud",
        localVersion: 1,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async (provider: CloudProvider) => ({
        conflict: true,
        remoteFile: provider === "github" ? githubRemote : googleRemote,
      }),
      loadSyncBase: async () => payload("base"),
      commitRemoteInspection: async (provider: CloudProvider) => {
        committed.push(provider);
      },
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown, _file: SyncedFile, outgoing: SyncPayload) => {
        uploaded.push({ provider, payload: outgoing });
        return { success: true, provider, action: "upload" as const, version: 4 };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const results = await syncAllProvidersImpl.call(manager, localPayload);

    assert.equal(results.get("github")?.action, "download");
    assert.equal(results.get("github")?.mergedPayload, githubPayload);
    assert.equal(results.get("github")?.remoteFile, githubRemote);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].provider, "google");
    assert.equal(uploaded[0].payload.hosts[0]?.id, "github-winner");
    assert.equal(uploaded[0].payload.syncMeta?.schemaVersion, 1);
    assert.deepEqual(committed, []);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("syncToProvider uses the checked remote as metadata base when no stored base exists", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const checkedRemote = remoteFile("github", 3, 300);
  const remotePayload = payloadWithHosts(["kept", "deleted-on-local"]);
  const localPayload = payload("kept");
  let uploadedPayload: SyncPayload | undefined;

  EncryptionService.decryptPayload = async (file: SyncedFile) => {
    assert.equal(file, checkedRemote);
    return remotePayload;
  };
  EncryptionService.encryptPayload = async (outgoing: SyncPayload) => ({
    ...remoteFile("github", 4, 400),
    payload: JSON.stringify(outgoing),
  });

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: { enabled: true, connected: true, status: "connected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 1,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
      loadSyncBase: async () => null,
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown, _file: SyncedFile, outgoing: SyncPayload) => {
        uploadedPayload = outgoing;
        return { success: true, provider, action: "upload" as const, version: 4 };
      },
      exitBlockedState: () => {},
    };

    const result = await syncToProviderImpl.call(manager, "github", localPayload);

    assert.equal(result.success, true);
    assert.deepEqual(uploadedPayload?.syncMeta?.deletions, [{
      entityType: "hosts",
      id: "deleted-on-local",
      deletedAt: uploadedPayload?.syncMeta?.generatedAt,
      deviceId: "local-device",
    }]);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("syncToProvider refuses to downgrade a checked convergent remote", async () => {
  const checkedRemote = remoteFile("github", 3, 300);
  checkedRemote.meta.syncSchemaVersion = 2;
  let encrypted = false;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  EncryptionService.encryptPayload = async () => {
    encrypted = true;
    return checkedRemote;
  };
  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      state: {
        securityState: "UNLOCKED",
        providers: { github: { status: "connected" } },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 1,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
      addSyncHistoryEntry: () => {},
    };

    const result = await syncToProviderImpl.call(manager, "github", payload("local"));

    assert.equal(result.success, false);
    assert.equal(encrypted, false);
    assert.match(result.error ?? "", /Enable or migrate convergent sync/);
  } finally {
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("syncToProvider aborts an upload when the master key changes after encryption", async () => {
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const localPayload = payload("local");
  let generation = 0;
  let uploaded = false;

  EncryptionService.encryptPayload = async (outgoing: SyncPayload) => {
    generation += 1;
    return {
      ...remoteFile("github", 2, 200),
      payload: JSON.stringify(outgoing),
    };
  };

  try {
    const manager = {
      masterPassword: "old-master-password",
      adapters: new Map(),
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: { enabled: true, connected: true, status: "connected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 1,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getSyncSecurityGeneration: () => 0,
      assertSyncSecurityGeneration: (expected: number) => {
        if (generation !== expected) {
          throw new Error("Sync cancelled because master key changed");
        }
      },
      getConnectedAdapter: async () => ({ provider: "github" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false }),
      loadSyncBase: async () => null,
      uploadToProvider: async (provider: CloudProvider) => {
        uploaded = true;
        return { success: true, provider, action: "upload" as const, version: 2 };
      },
      exitBlockedState: () => {},
      addSyncHistoryEntry: () => {},
    };

    const result = await syncToProviderImpl.call(manager, "github", localPayload);

    assert.equal(uploaded, false);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /master key changed/);
  } finally {
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("uploadToProvider skips local commits when the master key changes during upload", async () => {
  let generation = 0;
  let savedAnchor = false;
  let savedBase = false;
  let savedProvider = false;
  const file = remoteFile("github", 2, 200);

  const manager = {
    providerDecryptSeq: { github: 0 },
    state: {
      providers: {
        github: { enabled: true, connected: true, status: "syncing" },
      },
      lastError: null,
      syncState: "SYNCING",
      localVersion: 1,
      localUpdatedAt: 100,
      remoteVersion: 1,
      remoteUpdatedAt: 100,
      deviceName: "Local",
    },
    assertSyncSecurityGeneration: (expected: number) => {
      if (generation !== expected) {
        throw new Error("Sync cancelled because master key changed");
      }
    },
    saveSyncConfig: () => {},
    saveSyncBase: async () => {
      savedBase = true;
    },
    saveSyncAnchor: async () => {
      savedAnchor = true;
    },
    saveProviderConnection: async () => {
      savedProvider = true;
    },
    notifyStateChange: () => {},
    addSyncHistoryEntry: () => {},
    updateProviderStatus: () => {},
    emit: () => {},
  };

  const adapter = {
    upload: async () => {
      generation += 1;
      return "resource-id";
    },
  };

  const result = await uploadToProviderImpl.call(
    manager,
    "github",
    adapter,
    file,
    payload("local"),
    0,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /master key changed/);
  assert.equal(savedBase, false);
  assert.equal(savedAnchor, false);
  assert.equal(savedProvider, false);
});

test("syncAllProviders uses the checked remote as metadata base when provider base is missing", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const checkedRemote = remoteFile("github", 3, 300);
  const remotePayload = payloadWithHosts(["kept", "deleted-on-local"]);
  const localPayload = payload("kept");
  let uploadedPayload: SyncPayload | undefined;

  EncryptionService.decryptPayload = async (file: SyncedFile) => {
    assert.equal(file, checkedRemote);
    return remotePayload;
  };
  EncryptionService.encryptPayload = async (outgoing: SyncPayload) => ({
    ...remoteFile("github", 4, 400),
    payload: JSON.stringify(outgoing),
  });

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: { enabled: true, connected: true, status: "connected" },
          google: { enabled: false, connected: false, status: "disconnected" },
          onedrive: { enabled: false, connected: false, status: "disconnected" },
          webdav: { enabled: false, connected: false, status: "disconnected" },
          s3: { enabled: false, connected: false, status: "disconnected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 1,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
      loadSyncBase: async () => null,
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown, _file: SyncedFile, outgoing: SyncPayload) => {
        uploadedPayload = outgoing;
        return { success: true, provider, action: "upload" as const, version: 4 };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const results = await syncAllProvidersImpl.call(manager, localPayload);

    assert.equal(results.get("github")?.success, true);
    assert.deepEqual(uploadedPayload?.syncMeta?.deletions, [{
      entityType: "hosts",
      id: "deleted-on-local",
      deletedAt: uploadedPayload?.syncMeta?.generatedAt,
      deviceId: "local-device",
    }]);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("commitRemoteInspection saves the comparison base before advancing the remote anchor", async () => {
  const calls: string[] = [];
  const file = remoteFile("github", 5, 500);
  const incoming = payload("cloud");
  const manager = {
    providerDecryptSeq: { github: 0 },
    state: {
      providers: {
        github: { resourceId: "old", lastSync: 0, lastSyncVersion: 0 },
      },
      localVersion: 0,
      localUpdatedAt: 0,
      remoteVersion: 0,
      remoteUpdatedAt: 0,
    },
    getConnectedAdapter: async () => ({ resourceId: "remote-resource" }),
    saveSyncConfig: () => calls.push("config"),
    saveSyncBase: async () => calls.push("base"),
    saveSyncAnchor: async () => calls.push("anchor"),
    saveProviderConnection: async () => calls.push("connection"),
    addSyncHistoryEntry: () => calls.push("history"),
    notifyStateChange: () => calls.push("notify"),
  };

  await commitRemoteInspectionImpl.call(manager, "github", file, incoming, {
    recordDownload: true,
  });

  assert.deepEqual(calls, ["base", "config", "anchor", "connection", "history", "notify"]);
});

test("commitRemoteInspection does not advance the remote anchor when saving the base fails", async () => {
  const calls: string[] = [];
  const manager = {
    providerDecryptSeq: { github: 0 },
    state: {
      providers: {
        github: { resourceId: "remote-resource", lastSync: 0, lastSyncVersion: 0 },
      },
      localVersion: 0,
      localUpdatedAt: 0,
      remoteVersion: 0,
      remoteUpdatedAt: 0,
    },
    getConnectedAdapter: async () => ({ resourceId: "remote-resource" }),
    saveSyncConfig: () => calls.push("config"),
    saveSyncBase: async () => {
      calls.push("base");
      throw new Error("base failed");
    },
    saveSyncAnchor: async () => calls.push("anchor"),
    saveProviderConnection: async () => calls.push("connection"),
    addSyncHistoryEntry: () => calls.push("history"),
    notifyStateChange: () => calls.push("notify"),
  };

  await assert.rejects(
    () => commitRemoteInspectionImpl.call(manager, "github", remoteFile("github", 5, 500), payload("cloud")),
    /base failed/,
  );

  assert.deepEqual(calls, ["base"]);
});

test("saveSyncBase reports storage failures so callers do not advance anchors", async () => {
  const originalWarn = console.warn;
  const manager = {
    state: {
      unlockedKey: {
        derivedKey: await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        ),
      },
    },
    syncBaseKey: () => "sync-base",
    saveToStorage: () => {
      throw new Error("storage full");
    },
  };

  console.warn = () => {};
  try {
    await assert.rejects(
      () => saveSyncBaseImpl.call(manager, payload("cloud"), "github"),
      /storage full/,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("saveSyncBase reports a missing local encryption key", async () => {
  const manager = {
    state: { unlockedKey: null },
    syncBaseKey: () => "sync-base",
    saveToStorage: () => {},
  };

  await assert.rejects(
    () => saveSyncBaseImpl.call(manager, payload("cloud"), "github"),
    /Sync base encryption key is unavailable/,
  );
});

test("saveSyncBase keeps a bounded encrypted snapshot history before replacing the base", async () => {
  const stored = new Map<string, string>();
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const manager = {
    state: { unlockedKey: { derivedKey: key } },
    syncBaseKey: (provider?: CloudProvider) => `base-${provider ?? "default"}`,
    syncSnapshotsKey: (provider?: CloudProvider) => `snapshots-${provider ?? "default"}`,
    saveToStorage: (storageKey: string, value: string) => stored.set(storageKey, value),
    loadFromStorage: (storageKey: string) => stored.get(storageKey),
  };

  await saveSyncBaseImpl.call(manager, payload("base-0"), "github");
  for (let i = 1; i <= 7; i += 1) {
    await saveSyncBaseImpl.call(manager, payload(`base-${i}`), "github");
  }

  const snapshots = await loadSyncSnapshotsImpl.call(manager, "github");

  assert.equal(snapshots.length, 5);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.payload.hosts[0]?.id),
    ["base-6", "base-5", "base-4", "base-3", "base-2"],
  );
});

test("syncAllProviders builds provider-specific sync metadata from each provider base", async () => {
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const uploaded: Array<{ provider: CloudProvider; payload: SyncPayload }> = [];
  const baseByProvider = {
    github: payload("shared"),
    google: payload("deleted-on-local"),
  } as Partial<Record<CloudProvider, SyncPayload>>;
  const localPayload = payload("shared");

  EncryptionService.encryptPayload = async (outgoing: SyncPayload) => ({
    ...remoteFile("github", 4, 400),
    payload: JSON.stringify(outgoing),
  });

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: { enabled: true, connected: true, status: "connected" },
          google: { enabled: true, connected: true, status: "connected" },
          onedrive: { enabled: false, connected: false, status: "disconnected" },
          webdav: { enabled: false, connected: false, status: "disconnected" },
          s3: { enabled: false, connected: false, status: "disconnected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 1,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: null }),
      loadSyncBase: async (provider: CloudProvider) => baseByProvider[provider] ?? null,
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown, _file: SyncedFile, outgoing: SyncPayload) => {
        uploaded.push({ provider, payload: outgoing });
        return { success: true, provider, action: "upload" as const, version: 4 };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    await syncAllProvidersImpl.call(manager, localPayload);

    assert.equal(uploaded.length, 2);
    assert.deepEqual(uploaded.find((entry) => entry.provider === "github")?.payload.syncMeta?.deletions, []);
    assert.deepEqual(uploaded.find((entry) => entry.provider === "google")?.payload.syncMeta?.deletions, [{
      entityType: "hosts",
      id: "deleted-on-local",
      deletedAt: uploaded.find((entry) => entry.provider === "google")?.payload.syncMeta?.generatedAt,
      deviceId: "local-device",
    }]);
  } finally {
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});
