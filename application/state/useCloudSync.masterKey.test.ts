import test from "node:test";
import assert from "node:assert/strict";

import { SYNC_STORAGE_KEYS } from "../../domain/sync.ts";
import { EncryptionService } from "../../infrastructure/services/EncryptionService.ts";
import { handleStorageEventImpl } from "../../infrastructure/services/cloudSync/stateAndSecurityMethods.ts";

test("master key replacement from another window locks the current window and clears the old password", async () => {
  const oldConfig = await EncryptionService.createMasterKeyConfig("old-master-password");
  const newConfig = await EncryptionService.createMasterKeyConfig("new-master-password");
  const fakeStorage = {};
  const originalWindow = globalThis.window;
  let notifyCount = 0;
  let stopAutoSyncCount = 0;
  let syncSecurityGenerationCount = 0;

  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: fakeStorage,
  };

  const manager = {
    state: {
      masterKeyConfig: oldConfig,
      securityState: "UNLOCKED",
      unlockedKey: await EncryptionService.unlockMasterKey("old-master-password", oldConfig),
    },
    masterPassword: "old-master-password",
    safeJsonParse: (value: string | null) => (value ? JSON.parse(value) : null),
    stopAutoSync: () => {
      stopAutoSyncCount += 1;
    },
    bumpSyncSecurityGeneration: () => {
      syncSecurityGenerationCount += 1;
    },
    notifyStateChange: () => {
      notifyCount += 1;
    },
  };

  try {
    handleStorageEventImpl.call(manager, {
      storageArea: fakeStorage,
      key: SYNC_STORAGE_KEYS.MASTER_KEY_CONFIG,
      newValue: JSON.stringify(newConfig),
    } as StorageEvent);
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.equal(manager.state.masterKeyConfig.verificationHash, newConfig.verificationHash);
  assert.equal(manager.state.securityState, "LOCKED");
  assert.equal(manager.state.unlockedKey, null);
  assert.equal(manager.masterPassword, null);
  assert.equal(stopAutoSyncCount, 1);
  assert.equal(syncSecurityGenerationCount, 1);
  assert.equal(notifyCount, 1);
});
