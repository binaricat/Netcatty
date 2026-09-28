import test from "node:test";
import assert from "node:assert/strict";

import { EncryptionService } from "../EncryptionService.ts";
import { withSyncReliabilityMeta } from "../../../domain/syncReliability.ts";
import {
  clearProviderMergeStateImpl,
  commitRemoteInspectionImpl,
  saveSyncAnchorImpl,
} from "./authMethods.ts";
import {
  selectConvergentSyncToProviderResult,
  syncToProviderImpl,
  uploadToProviderImpl,
} from "./providerSyncMethods.ts";
import {
  clearSyncBaseImpl,
  loadSyncSnapshotsImpl,
  saveSyncBaseImpl,
  syncAllProvidersImpl,
} from "./syncAllStorageMethods.ts";
import type {
  CloudProvider,
  SyncedFile,
  SyncPayload,
  SyncResult,
} from "../../../domain/sync.ts";
import { setConvergentSyncLocalConfig } from "../convergentSyncConfig.ts";
import { saveProviderConnectionImpl } from "./stateAndSecurityMethods.ts";

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
    assert.deepEqual(results.get("github")?.mergedPayload, githubPayload);
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

test("guarded provider saves cannot recreate state cleared during an await", async () => {
  const stored = new Map<string, unknown>();
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
  );
  let providerChanged = false;
  const assertProviderUnchanged = () => {
    if (providerChanged) throw new Error("provider changed");
  };
  const manager = {
    state: { unlockedKey: { derivedKey: key }, providers: { github: { resourceId: "old" } } },
    syncBaseKey: () => "base:github",
    syncSnapshotsKey: () => "snapshots:github",
    syncAnchorKey: () => "anchor:github",
    loadFromStorage: (storageKey: string) => stored.get(storageKey) ?? null,
    saveToStorage: (storageKey: string, value: unknown) => {
      stored.set(storageKey, value);
      return true;
    },
    createSyncedFileSignature: () => new Promise<string>((resolve) => {
      setImmediate(() => resolve("signature"));
    }),
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await saveSyncBaseImpl.call(manager, payload("old"), "github");
    const baseSave = saveSyncBaseImpl.call(manager, payload("new"), "github", assertProviderUnchanged);
    queueMicrotask(() => {
      providerChanged = true;
      stored.delete("base:github");
      stored.delete("snapshots:github");
    });
    await assert.rejects(baseSave, /provider changed/);
    assert.equal(stored.has("base:github"), false);
    assert.equal(stored.has("snapshots:github"), false);

    providerChanged = false;
    const anchorSave = saveSyncAnchorImpl.call(
      manager, "github", remoteFile("github", 7, 700), "old", assertProviderUnchanged,
    );
    queueMicrotask(() => { providerChanged = true; });
    await assert.rejects(anchorSave, /provider changed/);
    assert.equal(stored.has("anchor:github"), false);

    providerChanged = false;
    const connectionManager = {
      providerWriteSeq: { github: 0 },
      saveToStorage: (storageKey: string, value: unknown) => {
        stored.set(storageKey, value);
      },
    };
    const connectionSave = saveProviderConnectionImpl.call(connectionManager,
      "github", {
        provider: "github",
        status: "connected",
        tokens: { accessToken: "old" },
      }, undefined, assertProviderUnchanged);
    queueMicrotask(() => { providerChanged = true; });
    await assert.rejects(connectionSave, /provider changed/);
    assert.equal(stored.size, 0);

    providerChanged = false;
    const latestConnection = {
      provider: "github" as const,
      status: "connected" as const,
      tokens: { accessToken: "fresh" },
      resourceId: "resource-7",
    };
    const metadataManager = {
      providerWriteSeq: { github: 0 },
      loadProviderConnection: () => latestConnection,
      saveToStorage: (_storageKey: string, value: typeof latestConnection) => {
        stored.set("connection", value);
      },
    };
    await saveProviderConnectionImpl.call(metadataManager, "github", {
      ...latestConnection,
      tokens: { accessToken: "old" },
      lastSyncVersion: 7,
    }, undefined, assertProviderUnchanged, true);
    const savedConnection = stored.get("connection") as typeof latestConnection;
    assert.equal(savedConnection.tokens.accessToken, "fresh");
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

test("syncAllProviders upload-local override overwrites remote without decrypting when password differs", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const checkedRemote = remoteFile("github", 5, 500);
  const localPayload = payload("local-after-reinstall");
  const uploaded: Array<{ provider: CloudProvider; payload: SyncPayload }> = [];
  const encryptBaseVersions: number[] = [];
  let decryptCalls = 0;

  EncryptionService.decryptPayload = async () => {
    decryptCalls += 1;
    throw new Error("OperationError: unable to authenticate data");
  };
  EncryptionService.encryptPayload = async (
    outgoing: SyncPayload,
    _password: string,
    _deviceId: string,
    _deviceName: string,
    _appVersion: string,
    existingVersion?: number,
  ) => {
    encryptBaseVersions.push(existingVersion ?? 0);
    return {
      ...remoteFile("github", (existingVersion ?? 0) + 1, 600),
      payload: JSON.stringify(outgoing),
    };
  };

  try {
    const manager = {
      masterPassword: "new-master-password",
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
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: true, remoteFile: checkedRemote }),
      loadSyncBase: async () => null,
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown, _file: SyncedFile, outgoing: SyncPayload) => {
        uploaded.push({ provider, payload: outgoing });
        return { success: true, provider, action: "upload" as const, version: 6 };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const conflicted = await syncAllProvidersImpl.call(manager, localPayload);
    assert.equal(conflicted.get("github")?.success, false);
    assert.equal(conflicted.get("github")?.conflictDetected, true);
    assert.equal(conflicted.get("github")?.error, undefined);
    assert.equal(uploaded.length, 0);

    const forced = await syncAllProvidersImpl.call(manager, localPayload, {
      conflictActionOverride: "upload-local",
      overrideShrink: true,
    });
    assert.equal(forced.get("github")?.success, true);
    assert.equal(forced.get("github")?.action, "upload");
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0]?.payload.hosts[0]?.id, "local-after-reinstall");
    // Keep-local under smartMerge must base on the conflicting remote version
    // (v5 → encrypted as v6), matching single-provider upload-local.
    assert.deepEqual(encryptBaseVersions, [5]);
    // Shrink-guard may attempt decrypt and ignore failure; merge path must not run.
    assert.ok(decryptCalls >= 1);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("an initialized but paused v2 replica cannot fall through to legacy provider writes", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  try {
    setConvergentSyncLocalConfig({ enabled: false, initialized: true });
    let adapterRequested = false;
    const manager = {
      state: {
        providers: {
          github: { provider: "github", status: "connected" },
        },
      },
      getConnectedAdapter: async () => {
        adapterRequested = true;
        throw new Error("legacy path must not run");
      },
    };

    const all = await syncAllProvidersImpl.call(manager, payload("local"));
    const one = await syncToProviderImpl.call(manager, "github", payload("local"));

    assert.equal(all.get("github")?.success, false);
    assert.match(all.get("github")?.error ?? "", /paused/i);
    assert.equal(one.success, false);
    assert.match(one.error ?? "", /paused/i);
    assert.equal(adapterRequested, false);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("syncToProvider preserves a merged payload discovered by a non-target provider", () => {
  const mergedPayload = payload("remote-merged");
  const results = new Map<CloudProvider, SyncResult>([
    ["github", {
      success: false,
      provider: "github",
      action: "none",
      error: "github unavailable",
    }],
    ["google", {
      success: true,
      provider: "google",
      action: "merge",
      mergedPayload,
    }],
  ]);

  const selected = selectConvergentSyncToProviderResult("github", results);

  assert.equal(selected.success, false);
  assert.equal(selected.provider, "github");
  assert.equal(selected.error, "github unavailable");
  assert.equal(selected.mergedPayload, mergedPayload);
  assert.equal(selected.remoteFile, undefined);
});

test("syncAllProviders smart-merge strips device-bound enc:v1 secrets before upload", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const completeBlob = Buffer.alloc(31, 0);
  Buffer.from("v10", "utf8").copy(completeBlob, 0);
  const ENC = `enc:v1:${completeBlob.toString("base64")}`;
  const checkedRemote = remoteFile("github", 5, 500);
  const localPayload = {
    ...payload("shared"),
    hosts: [{
      ...payload("shared").hosts[0]!,
      password: "kept-secret",
    }],
  };
  const remotePoisoned: SyncPayload = {
    ...payload("shared"),
    hosts: [
      {
        ...payload("shared").hosts[0]!,
        label: "remote-label",
        password: ENC,
      },
    ],
  };
  const uploaded: SyncPayload[] = [];

  EncryptionService.decryptPayload = async () => remotePoisoned;
  EncryptionService.encryptPayload = async (outgoing: SyncPayload) => ({
    ...remoteFile("github", 6, 600),
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
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: true, remoteFile: checkedRemote }),
      loadSyncBase: async () => ({
        ...payload("shared"),
        hosts: [{
          ...payload("shared").hosts[0]!,
          password: "kept-secret",
        }],
      }),
      uploadToProvider: async (
        _provider: CloudProvider,
        _adapter: unknown,
        _file: SyncedFile,
        outgoing: SyncPayload,
      ) => {
        uploaded.push(outgoing);
        return { success: true, provider: "github" as const, action: "upload" as const, version: 6 };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const results = await syncAllProvidersImpl.call(manager, localPayload);
    assert.equal(results.get("github")?.success, true);
    assert.equal(uploaded.length, 1);
    const sharedHost = uploaded[0]?.hosts.find((host) => host.id === "shared");
    assert.ok(sharedHost);
    // Local/base usable secret must survive; remote non-secret edits can still apply.
    assert.equal(sharedHost?.password, "kept-secret");
    assert.equal(sharedHost?.label, "remote-label");
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("syncAllProviders skips the upload when the payload already matches the provider remote", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const checkedRemote = remoteFile("github", 7, 700);
  const localPayload = payload("local");
  let storedBase = payload("local");
  let checkedRemotePayload = storedBase;
  let uploads = 0;
  let encryptCalls = 0;
  const encryptedPayloads: SyncPayload[] = [];
  const savedBases: SyncPayload[] = [];
  const anchored: SyncedFile[] = [];
  const connections: CloudProvider[] = [];

  EncryptionService.decryptPayload = async (file: SyncedFile) => {
    assert.equal(file, checkedRemote);
    return checkedRemotePayload;
  };
  EncryptionService.encryptPayload = async (outgoing: SyncPayload, _password: string,
    _deviceId: string, _deviceName: string, _appVersion: string, baseVersion: number) => {
    assert.equal(baseVersion, 7);
    encryptCalls += 1;
    encryptedPayloads.push(outgoing);
    return remoteFile("github", 8, 800);
  };

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 4 },
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
        localVersion: 3,
        remoteVersion: 3,
        remoteUpdatedAt: 700,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider, resourceId: "resource-7" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
      loadSyncBase: async () => storedBase,
      saveSyncBase: async (incoming: SyncPayload) => {
        savedBases.push(incoming);
        storedBase = incoming;
      },
      saveSyncAnchor: async (_provider: CloudProvider, file: SyncedFile) => {
        anchored.push(file);
      },
      saveProviderConnection: async (provider: CloudProvider) => {
        connections.push(provider);
      },
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const, version: 8 };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const results = await syncAllProvidersImpl.call(manager, localPayload);

    assert.equal(results.get("github")?.success, true);
    assert.equal(results.get("github")?.action, "none");
    assert.equal(results.get("github")?.version, 7);
    assert.equal(uploads, 0);
    assert.equal(encryptCalls, 0);
    // Base and anchor are already current; the anchor still advances so the
    // observation stays committed.
    assert.deepEqual(savedBases, []);
    assert.deepEqual(anchored, [checkedRemote]);
    assert.deepEqual(connections, ["github"]);
    assert.equal(manager.state.syncState, "IDLE");
    assert.equal(Reflect.get(manager.state.providers.github, "lastSyncVersion"), 7);
    assert.equal(Reflect.get(manager.state.providers.github, "resourceId"), "resource-7");
    assert.equal(manager.providerDecryptSeq.github, 5);
    assert.equal(manager.state.localVersion, 7);

    // A remote learned a deletion elsewhere while this device's base still
    // has the same materialized data. Its newer base must be kept locally.
    checkedRemotePayload = withSyncReliabilityMeta(
      storedBase,
      payloadWithHosts(["local", "deleted"]),
      { deviceId: "other-device", now: 800 },
    );
    const metadataOnlyResult = await syncAllProvidersImpl.call(manager, localPayload);
    assert.equal(metadataOnlyResult.get("github")?.action, "none");
    assert.deepEqual(savedBases, [checkedRemotePayload]);
    assert.equal(uploads, 0);

    const editedPayload = payloadWithHosts(["local", "new"]);
    const editedResult = await syncAllProvidersImpl.call(manager, editedPayload);
    assert.equal(editedResult.get("github")?.action, "upload");
    assert.deepEqual(
      encryptedPayloads[0]?.syncMeta?.deletions.map(({ entityType, id }) => [entityType, id]),
      [["hosts", "deleted"]],
    );
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("manual provider sync accepts identical remote and an identical merge without uploading", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const checkedRemote = remoteFile("github", 7, 700);
  const base = payload("local");
  let remote = base;
  let conflict = false;
  let uploads = 0;
  let encrypts = 0;
  const notifiedStates: string[] = [];
  EncryptionService.decryptPayload = async () => remote;
  EncryptionService.encryptPayload = async () => {
    encrypts += 1;
    return remoteFile("github", 8, 800);
  };
  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: { github: { enabled: true, connected: true, status: "connected" } },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 6,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict, remoteFile: checkedRemote }),
      loadSyncBase: async () => base,
      saveSyncBase: async () => {},
      saveSyncAnchor: async () => {},
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => { notifiedStates.push(manager.state.syncState); },
    };
    const unchanged = await syncToProviderImpl.call(manager, "github", base);
    assert.equal(unchanged.action, "none");
    assert.equal(unchanged.version, 7);
    assert.equal(notifiedStates.at(-1), "IDLE");

    conflict = true;
    remote = payloadWithHosts(["local", "remote-only"]);
    const merged = await syncToProviderImpl.call(manager, "github", base);
    assert.equal(merged.action, "merge");
    assert.equal(merged.version, 7);
    assert.deepEqual(merged.mergedPayload?.hosts.map((host) => host.id), ["local", "remote-only"]);
    assert.equal(uploads, 0);
    assert.equal(encrypts, 0);
    assert.equal(notifiedStates.at(-1), "IDLE");
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("no-op sync snapshots provider identity after startup secrets finish decrypting", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const localPayload = payload("local");
  EncryptionService.decryptPayload = async () => localPayload;
  try {
    let uploads = 0;
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: { enabled: true, connected: true, status: "connected", config: { token: "sealed" } },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 7,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => {
        manager.state.providers.github.config.token = "plain";
        return { provider: "github" };
      },
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: remoteFile("github", 7, 700) }),
      loadSyncBase: async () => localPayload,
      saveSyncBase: async () => {},
      saveSyncAnchor: async () => {},
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };
    const result = (await syncAllProvidersImpl.call(manager, localPayload)).get("github");
    assert.equal(result?.success, true);
    assert.equal(result?.action, "none");
    assert.equal(uploads, 0);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
  }
});

test("no-op sync stops when the vault locks during persistence", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const localPayload = payload("local");
  const checkedRemotePayload = withSyncReliabilityMeta(
    localPayload,
    payloadWithHosts(["local", "deleted"]),
    { deviceId: "remote-device", now: 700 },
  );
  const checkedRemote = remoteFile("github", 7, 700);
  EncryptionService.decryptPayload = async () => checkedRemotePayload;

  try {
    for (const lockDuring of ["base", "anchor", "connection"] as const) {
      let generation = 0;
      let uploads = 0;
      const completed: string[] = [];
      const connected: string[] = [];
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
          localVersion: 2,
          remoteVersion: 2,
          deviceId: "local-device",
          deviceName: "Local",
        },
        getSyncSecurityGeneration: () => generation,
        assertSyncSecurityGeneration: (expected: number) => {
          if (generation !== expected) throw new Error("Sync cancelled because master key changed");
        },
        getConnectedAdapter: async () => ({ provider: "github" }),
        updateProviderStatus: (_provider: CloudProvider, status: string) => {
          if (status === "connected") connected.push(status);
        },
        emit: (event: { type: string }) => {
          if (event.type === "SYNC_COMPLETED") completed.push(event.type);
        },
        checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
        loadSyncBase: async () => localPayload,
        saveSyncBase: async () => {
          if (lockDuring === "base") {
            generation += 1;
            manager.state.securityState = "LOCKED";
          }
        },
        saveSyncAnchor: async () => {
          if (lockDuring === "anchor") {
            generation += 1;
            manager.state.securityState = "LOCKED";
          }
        },
        saveProviderConnection: async () => {
          if (lockDuring === "connection") {
            generation += 1;
            manager.state.securityState = "LOCKED";
          }
        },
        saveSyncConfig: () => {},
        uploadToProvider: async () => {
          uploads += 1;
          return { success: true, provider: "github" as const, action: "upload" as const };
        },
        exitBlockedState: () => {},
        notifyStateChange: () => {},
      };

      await assert.rejects(
        () => syncAllProvidersImpl.call(manager, localPayload),
        /master key changed/,
      );
      assert.equal(manager.state.localVersion, 2, lockDuring);
      assert.equal(manager.state.remoteVersion, 2, lockDuring);
      assert.equal(uploads, 0, lockDuring);
      assert.deepEqual(completed, [], lockDuring);
      assert.deepEqual(connected, [], lockDuring);
    }
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
  }
});

test("no-op sync does not persist stale credentials after a concurrent provider write", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const localPayload = payload("local");
  const checkedRemote = remoteFile("github", 7, 700);
  EncryptionService.decryptPayload = async () => localPayload;

  try {
    for (const raceAt of ["stored", "storedResource", "storage", "anchor", "connection"] as const) {
      let saveCalls = 0;
      let anchorWrites = 0;
      let uploads = 0;
      let storedToken = raceAt === "stored" ? "fresh" : "old";
      const storedResourceId = raceAt === "storedResource" ? "resource-new" : "resource-old";
      const manager = {
        masterPassword: "pw",
        adapters: new Map(),
        providerDecryptSeq: { github: 0 },
        providerWriteSeq: { github: raceAt === "stored" ? 1 : 0 },
        state: {
          securityState: "UNLOCKED",
          providers: {
            github: {
              enabled: true, connected: true, status: "connected",
              tokens: { accessToken: "old" },
              resourceId: "resource-old",
            },
          },
          lastError: null,
          syncState: "IDLE",
          syncStrategy: "smartMerge",
          localVersion: 7,
          deviceId: "local-device",
          deviceName: "Local",
        },
        getConnectedAdapter: async () => ({ provider: "github" }),
        updateProviderStatus: () => {},
        emit: () => {},
        checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
        loadProviderConnection: () => ({
          ...manager.state.providers.github,
          tokens: { accessToken: storedToken },
          resourceId: storedResourceId,
        }),
        loadSyncBase: async () => localPayload,
        saveSyncBase: async () => {},
        saveSyncAnchor: async (_provider: CloudProvider, _file: SyncedFile,
          _resourceId: string | null, assertCanPersist?: () => void) => {
          if (raceAt === "storage") storedToken = "fresh";
          if (raceAt === "anchor") {
            manager.providerWriteSeq.github += 1;
            manager.providerDecryptSeq.github += 1;
          }
          assertCanPersist?.();
          anchorWrites += 1;
        },
        saveProviderConnection: async (_provider: CloudProvider, _connection: unknown,
          _authAttemptId?: number, assertCanPersist?: () => void,
          preserveStoredSecrets?: boolean) => {
          assert.equal(preserveStoredSecrets, true);
          saveCalls += 1;
          manager.providerWriteSeq.github += 1;
          assertCanPersist?.();
          if (raceAt === "connection") {
            manager.providerWriteSeq.github += 1;
            manager.providerDecryptSeq.github += 1;
            manager.state.providers.github.tokens = { accessToken: "fresh" };
          }
        },
        saveSyncConfig: () => {},
        uploadToProvider: async () => {
          uploads += 1;
          return { success: true, provider: "github" as const, action: "upload" as const };
        },
        exitBlockedState: () => {},
        notifyStateChange: () => {},
      };

      const result = (await syncAllProvidersImpl.call(manager, localPayload)).get("github");
      const sameResourceTokenRefresh = raceAt === "storage";
      assert.equal(result?.success, sameResourceTokenRefresh, `${raceAt}: ${result?.error ?? "no error"}`);
      if (sameResourceTokenRefresh) {
        assert.equal(result?.action, "none");
        assert.equal(storedToken, "fresh");
      } else {
        assert.match(result?.error ?? "", /Provider connection changed/, raceAt);
      }
      assert.equal(saveCalls, raceAt === "connection" || sameResourceTokenRefresh ? 1 : 0, raceAt);
      assert.equal(anchorWrites, raceAt === "connection" || sameResourceTokenRefresh ? 1 : 0, raceAt);
      assert.equal(uploads, 0, raceAt);
      assert.equal(manager.state.providers.github.status,
        sameResourceTokenRefresh ? "connected" : "error", raceAt);
      assert.equal(manager.providerDecryptSeq.github,
        raceAt === "connection" ? 2 : raceAt === "anchor" || sameResourceTokenRefresh ? 1 : 0,
        raceAt);
      if (raceAt === "connection") {
        assert.equal(manager.state.providers.github.tokens.accessToken, "fresh");
      }
    }
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
  }
});

test("no-op sync accepts its own token refresh during the remote check", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const localPayload = payload("local");
  const checkedRemote = remoteFile("github", 7, 700);
  let storedConnection = {
    provider: "github" as const,
    status: "connected" as const,
    tokens: { accessToken: "old" },
    resourceId: "resource-7",
  };
  let uploads = 0;
  EncryptionService.decryptPayload = async () => localPayload;

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 0 },
      providerWriteSeq: { github: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: {
            enabled: true, connected: true, ...storedConnection,
          },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 7,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github", resourceId: "resource-7" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => {
        manager.state.providers.github.tokens = { accessToken: "fresh" };
        void manager.saveProviderConnection("github", manager.state.providers.github);
        return { conflict: false, remoteFile: checkedRemote };
      },
      loadProviderConnection: () => storedConnection,
      saveToStorage: (_key: string, connection: typeof storedConnection) => {
        storedConnection = connection;
        return true;
      },
      saveProviderConnection: async (provider: CloudProvider,
        connection: typeof storedConnection, _authAttemptId?: number,
        assertCanPersist?: () => void) => saveProviderConnectionImpl.call(
          manager, provider, connection, undefined, assertCanPersist,
        ),
      loadSyncBase: async () => localPayload,
      saveSyncBase: async () => {},
      saveSyncAnchor: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const result = (await syncAllProvidersImpl.call(manager, localPayload)).get("github");
    assert.equal(result?.success, true);
    assert.equal(result?.action, "none");
    assert.equal(uploads, 0);
    assert.equal(storedConnection.tokens.accessToken, "fresh");
    assert.equal(manager.state.providers.github.tokens.accessToken, "fresh");
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
  }
});

test("peer no-op metadata updates do not fail an identical provider sync", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const localPayload = payload("local");
  let storedConnection = {
    provider: "github" as const,
    status: "connected" as const,
    tokens: { accessToken: "same" },
    resourceId: "resource-7",
    lastSyncVersion: 7,
  };
  let saves = 0;
  let uploads = 0;
  EncryptionService.decryptPayload = async () => localPayload;

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 0 },
      providerWriteSeq: { github: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: { github: { enabled: true, connected: true, ...storedConnection } },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 7,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github", resourceId: "resource-7" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({
        conflict: false,
        remoteFile: remoteFile("github", 7, 700),
      }),
      loadProviderConnection: () => storedConnection,
      loadSyncBase: async () => localPayload,
      saveSyncBase: async () => {},
      saveSyncAnchor: async () => {
        storedConnection = { ...storedConnection, lastSyncVersion: 8 };
      },
      saveProviderConnection: async () => {
        saves += 1;
        manager.providerWriteSeq.github += 1;
      },
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const result = (await syncAllProvidersImpl.call(manager, localPayload)).get("github");
    assert.equal(result?.success, true);
    assert.equal(result?.action, "none");
    assert.equal(saves, 1);
    assert.equal(uploads, 0);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
  }
});

test("no-op sync does not upload when saving a newer remote base fails", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const localPayload = payload("local");
  const checkedRemotePayload = withSyncReliabilityMeta(
    localPayload,
    payloadWithHosts(["local", "deleted"]),
    { deviceId: "remote-device", now: 700 },
  );
  const checkedRemote = remoteFile("github", 7, 700);
  let uploads = 0;
  EncryptionService.decryptPayload = async () => checkedRemotePayload;
  EncryptionService.encryptPayload = async () => remoteFile("github", 8, 800);

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: { github: { enabled: true, connected: true, status: "connected" } },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 7,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
      loadSyncBase: async () => localPayload,
      saveSyncBase: async () => { throw new Error("storage full"); },
      saveSyncAnchor: async () => {},
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const results = await syncAllProvidersImpl.call(manager, localPayload);
    assert.equal(uploads, 0);
    assert.equal(results.get("github")?.success, false);
    assert.match(results.get("github")?.error ?? "", /storage full/);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("syncAllProviders uploads missing deletion records, then skips once the remote has them", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const localPayload = payload("kept");
  const oldBase = payloadWithHosts(["kept", "deleted"]);
  let checkedRemote = remoteFile("github", 7, 700);
  let checkedRemotePayload = payload("kept");
  let uploads = 0;

  EncryptionService.decryptPayload = async () => checkedRemotePayload;
  EncryptionService.encryptPayload = async (outgoing: SyncPayload, _password: string,
    _deviceId: string, _deviceName: string, _appVersion: string, baseVersion: number) => {
    checkedRemotePayload = outgoing;
    checkedRemote = remoteFile("github", baseVersion + 1, 800);
    return checkedRemote;
  };

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
        localVersion: 7,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async () => ({ provider: "github" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
      loadSyncBase: async () => oldBase,
      saveSyncBase: async () => {},
      saveSyncAnchor: async () => {},
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const first = await syncAllProvidersImpl.call(manager, localPayload);
    assert.equal(first.get("github")?.action, "upload");
    assert.deepEqual(
      checkedRemotePayload.syncMeta?.deletions.map(({ entityType, id }) => [entityType, id]),
      [["hosts", "deleted"]],
    );
    assert.equal(uploads, 1);

    const second = await syncAllProvidersImpl.call(manager, localPayload);
    assert.equal(second.get("github")?.action, "none");
    assert.equal(uploads, 1);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("syncAllProviders skips an identical remote even when its version is behind another provider", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const checkedRemote = remoteFile("github", 3, 300);
  const localPayload = payload("local");
  let uploads = 0;

  EncryptionService.decryptPayload = async () => payload("local");
  EncryptionService.encryptPayload = async (outgoing: SyncPayload) => ({
    ...remoteFile("github", 11, 1100),
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
          google: { enabled: false, connected: false, status: "disconnected" },
          onedrive: { enabled: false, connected: false, status: "disconnected" },
          webdav: { enabled: false, connected: false, status: "disconnected" },
          s3: { enabled: false, connected: false, status: "disconnected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 10,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({ conflict: false, remoteFile: checkedRemote }),
      loadSyncBase: async () => payload("local"),
      saveSyncBase: async () => {},
      saveSyncAnchor: async () => {},
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async () => {
        uploads += 1;
        return { success: true, provider: "github" as const, action: "upload" as const, version: 11 };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const results = await syncAllProvidersImpl.call(manager, localPayload);

    assert.equal(uploads, 0);
    assert.equal(results.get("github")?.action, "none");
    assert.equal(results.get("github")?.version, 3);
    assert.equal(manager.state.localVersion, 10);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("download-remote round trip skips its source but updates a stale peer", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const downloadedPayload = payload("downloaded");
  const remotes = {
    onedrive: remoteFile("onedrive", 4, 400),
    google: remoteFile("google", 3, 300),
  };
  const uploads: CloudProvider[] = [];
  const anchors: CloudProvider[] = [];

  EncryptionService.decryptPayload = async (file: SyncedFile) =>
    file === remotes.onedrive ? downloadedPayload : payload("old-peer");
  EncryptionService.encryptPayload = async (_outgoing: SyncPayload, _password: string,
    _deviceId: string, _deviceName: string, _appVersion: string, baseVersion: number) =>
    remoteFile("google", baseVersion + 1, 500);

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { onedrive: 0, google: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: {
          onedrive: { enabled: true, connected: true, status: "connected" },
          google: { enabled: true, connected: true, status: "connected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 4,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async (provider: "onedrive" | "google") => ({
        conflict: false,
        remoteFile: remotes[provider],
      }),
      loadSyncBase: async () => downloadedPayload,
      saveSyncBase: async () => {},
      saveSyncAnchor: async (provider: CloudProvider) => { anchors.push(provider); },
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown, file: SyncedFile) => {
        uploads.push(provider);
        return { success: true, provider, action: "upload" as const, version: file.meta.version };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    // useAutoSync has just downloaded and committed the OneDrive file, then
    // calls this ordinary provider sync with upload-local to update its peers.
    const results = await syncAllProvidersImpl.call(manager, downloadedPayload, {
      conflictActionOverride: "upload-local",
    });

    assert.equal(results.get("onedrive")?.action, "none");
    assert.equal(results.get("google")?.action, "upload");
    assert.deepEqual(uploads, ["google"]);
    assert.deepEqual(anchors, ["onedrive"]);
    assert.equal(results.get("google")?.version, 5);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("syncAllProviders leaves two converged providers idle across repeated cycles", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const localPayload = payload("local");
  const remotes = {
    github: remoteFile("github", 10, 1000),
    google: remoteFile("google", 7, 700),
  };
  let uploads = 0;

  EncryptionService.decryptPayload = async (file: SyncedFile) =>
    file === remotes.github ? localPayload : payload("old-google");
  EncryptionService.encryptPayload = async (_outgoing: SyncPayload, _password: string,
    _deviceId: string, _deviceName: string, _appVersion: string, baseVersion: number) =>
    remoteFile("google", baseVersion + 1, 1100);

  try {
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { github: 0, google: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: {
          github: { enabled: true, connected: true, status: "connected" },
          google: { enabled: true, connected: true, status: "connected" },
        },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 10,
        deviceId: "local-device",
        deviceName: "Local",
      },
      getConnectedAdapter: async (provider: CloudProvider) => ({ provider }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async (provider: "github" | "google") => ({
        conflict: false,
        remoteFile: remotes[provider],
      }),
      loadSyncBase: async () => localPayload,
      saveSyncBase: async () => {},
      saveSyncAnchor: async () => {},
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown, file: SyncedFile) => {
        uploads += 1;
        remotes[provider as "github" | "google"] = file;
        manager.state.localVersion = file.meta.version;
        return { success: true, provider, action: "upload" as const, version: file.meta.version };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };

    const first = await syncAllProvidersImpl.call(manager, localPayload);
    assert.equal(first.get("github")?.action, "none");
    assert.equal(first.get("google")?.action, "upload");
    assert.equal(uploads, 1);
    assert.equal(manager.state.localVersion, 11);

    EncryptionService.decryptPayload = async () => localPayload;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const result = await syncAllProvidersImpl.call(manager, localPayload);
      assert.equal(result.get("github")?.action, "none");
      assert.equal(result.get("google")?.action, "none");
    }
    assert.equal(uploads, 1);
    assert.equal(manager.state.localVersion, 11);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});

test("two devices sharing one remote stop exchanging idle revisions and still propagate edits", async () => {
  const originalDecryptPayload = EncryptionService.decryptPayload;
  const originalEncryptPayload = EncryptionService.encryptPayload;
  const initialPayload = payload("shared");
  let cloudFile = { ...remoteFile("onedrive", 3, 300), payload: JSON.stringify(initialPayload) };
  const uploads: string[] = [];

  EncryptionService.decryptPayload = async (file: SyncedFile) => JSON.parse(file.payload) as SyncPayload;
  EncryptionService.encryptPayload = async (outgoing: SyncPayload, _password: string,
    deviceId: string, _deviceName: string, _appVersion: string, baseVersion: number) => ({
    ...remoteFile("onedrive", baseVersion + 1, (baseVersion + 1) * 100),
    payload: JSON.stringify(outgoing),
    meta: {
      ...remoteFile("onedrive", baseVersion + 1, (baseVersion + 1) * 100).meta,
      deviceId,
    },
  });

  const createDevice = (deviceId: string) => {
    let localPayload = initialPayload;
    let storedBase = initialPayload;
    let anchoredVersion = 3;
    const manager = {
      masterPassword: "pw",
      adapters: new Map(),
      providerDecryptSeq: { onedrive: 0 },
      state: {
        securityState: "UNLOCKED",
        providers: { onedrive: { enabled: true, connected: true, status: "connected" } },
        lastError: null,
        syncState: "IDLE",
        syncStrategy: "smartMerge",
        localVersion: 3,
        deviceId,
        deviceName: deviceId,
      },
      getConnectedAdapter: async () => ({ provider: "onedrive" }),
      updateProviderStatus: () => {},
      emit: () => {},
      checkProviderConflict: async () => ({
        conflict: cloudFile.meta.version !== anchoredVersion,
        remoteFile: cloudFile,
      }),
      loadSyncBase: async () => storedBase,
      saveSyncBase: async (incoming: SyncPayload) => { storedBase = incoming; },
      saveSyncAnchor: async (_provider: CloudProvider, file: SyncedFile) => {
        anchoredVersion = file.meta.version;
      },
      saveProviderConnection: async () => {},
      saveSyncConfig: () => {},
      uploadToProvider: async (provider: CloudProvider, _adapter: unknown,
        file: SyncedFile, outgoing: SyncPayload) => {
        uploads.push(deviceId);
        cloudFile = file;
        storedBase = outgoing;
        anchoredVersion = file.meta.version;
        manager.state.localVersion = file.meta.version;
        return { success: true, provider, action: "upload" as const, version: file.meta.version };
      },
      exitBlockedState: () => {},
      notifyStateChange: () => {},
    };
    return {
      setPayload: (incoming: SyncPayload) => { localPayload = incoming; },
      payload: () => localPayload,
      sync: async () => {
        const result = (await syncAllProvidersImpl.call(manager, localPayload)).get("onedrive");
        assert.equal(result?.success, true);
        if (result?.mergedPayload) localPayload = result.mergedPayload;
        return result;
      },
    };
  };

  try {
    const deviceA = createDevice("device-A");
    const deviceB = createDevice("device-B");

    deviceA.setPayload(payloadWithHosts(["shared", "from-A"]));
    assert.equal((await deviceA.sync())?.action, "upload");
    assert.equal(cloudFile.meta.version, 4);
    assert.equal((await deviceB.sync())?.action, "merge");
    assert.deepEqual(deviceB.payload().hosts.map(({ id }) => id), ["shared", "from-A"]);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      assert.equal((await deviceA.sync())?.action, "none");
      assert.equal((await deviceB.sync())?.action, "none");
    }
    assert.deepEqual(uploads, ["device-A"]);
    assert.equal(cloudFile.meta.version, 4);

    deviceB.setPayload(payloadWithHosts(["shared", "from-A", "from-B"]));
    assert.equal((await deviceB.sync())?.action, "upload");
    assert.equal((await deviceA.sync())?.action, "merge");
    assert.deepEqual(deviceA.payload().hosts.map(({ id }) => id), ["shared", "from-A", "from-B"]);
    assert.equal((await deviceB.sync())?.action, "none");
    assert.equal((await deviceA.sync())?.action, "none");
    assert.deepEqual(uploads, ["device-A", "device-B"]);
    assert.equal(cloudFile.meta.version, 5);
  } finally {
    EncryptionService.decryptPayload = originalDecryptPayload;
    EncryptionService.encryptPayload = originalEncryptPayload;
  }
});
