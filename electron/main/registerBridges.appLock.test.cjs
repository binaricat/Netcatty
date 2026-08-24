"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCloudSyncSessionPasswordReader,
} = require("./registerBridges.cjs");

test("cloud sync session password is hidden while the app is locked", async () => {
  let persistedReads = 0;
  const readPassword = createCloudSyncSessionPasswordReader({
    getAppLockController: () => ({
      getRuntimeState: () => ({ locked: true }),
    }),
    getCachedPassword: () => "cached-secret",
    setCachedPassword: () => {
      throw new Error("locked reads must not update the cache");
    },
    readPersistedPassword: () => {
      persistedReads += 1;
      return "persisted-secret";
    },
  });

  assert.equal(await readPassword(), null);
  assert.equal(persistedReads, 0);
});

test("cloud sync session password remains available after unlock", async () => {
  let cachedPassword = null;
  const readPassword = createCloudSyncSessionPasswordReader({
    getAppLockController: () => ({
      getRuntimeState: () => ({ locked: false }),
    }),
    getCachedPassword: () => cachedPassword,
    setCachedPassword: (password) => {
      cachedPassword = password;
    },
    readPersistedPassword: () => "persisted-secret",
  });

  assert.equal(await readPassword(), "persisted-secret");
  assert.equal(cachedPassword, "persisted-secret");
});
