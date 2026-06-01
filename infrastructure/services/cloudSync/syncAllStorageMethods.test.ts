import test from "node:test";
import assert from "node:assert/strict";

import { EncryptionService } from "../EncryptionService.ts";
import { commitRemoteInspectionImpl } from "./authMethods.ts";
import { saveSyncBaseImpl, syncAllProvidersImpl } from "./syncAllStorageMethods.ts";
import type { CloudProvider, SyncedFile, SyncPayload } from "../../../domain/sync.ts";

function payload(hostId: string): SyncPayload {
  return {
    hosts: [{
      id: hostId,
      label: hostId,
      hostname: `${hostId}.example.com`,
      port: 22,
      username: "root",
      tags: [],
      os: "linux",
    }],
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
    assert.equal(uploaded[0].payload, githubPayload);
    assert.deepEqual(committed, []);
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
