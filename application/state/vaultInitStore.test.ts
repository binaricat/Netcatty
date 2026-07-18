import assert from "node:assert/strict";
import test from "node:test";

import {
  beginVaultInitialization,
  completeVaultInitialization,
  failVaultInitialization,
  isVaultInitialized,
  releaseVaultInitialization,
  setVaultInitializationFailed,
  setVaultInitialized,
  waitForVaultInitialized,
} from "./vaultInitStore";

test("vault readiness waits for asynchronous credential decryption", async () => {
  setVaultInitialized(false);
  let resolved = false;
  const ready = waitForVaultInitialized().then(() => { resolved = true; });

  await Promise.resolve();
  assert.equal(resolved, false);

  setVaultInitialized(true);
  await ready;
  assert.equal(resolved, true);
});

test("vault readiness reports permanent credential decryption failure", async () => {
  setVaultInitialized(false);
  const ready = waitForVaultInitialized();
  setVaultInitializationFailed(new Error("safeStorage failed"));

  await assert.rejects(ready, /safeStorage failed/);
  setVaultInitialized(false);
});

test("a remounted sole vault consumer resets stale readiness until initialization completes", async () => {
  const first = beginVaultInitialization();
  completeVaultInitialization(first);
  assert.equal(isVaultInitialized(), true);
  releaseVaultInitialization(first);

  const remount = beginVaultInitialization();
  assert.equal(isVaultInitialized(), false);
  let resolved = false;
  const ready = waitForVaultInitialized().then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);

  completeVaultInitialization(remount);
  await ready;
  assert.equal(resolved, true);
  releaseVaultInitialization(remount);
});

test("a remount initialization failure rejects waiters instead of exposing stale readiness", async () => {
  const first = beginVaultInitialization();
  completeVaultInitialization(first);
  releaseVaultInitialization(first);

  const remount = beginVaultInitialization();
  const ready = waitForVaultInitialized();
  failVaultInitialization(remount, new Error("remount decrypt failed"));
  await assert.rejects(ready, /remount decrypt failed/);
  assert.equal(isVaultInitialized(), false);
  releaseVaultInitialization(remount);
});

test("an initialized concurrent vault consumer remains authoritative during another remount", async () => {
  const authoritative = beginVaultInitialization();
  completeVaultInitialization(authoritative);
  const remount = beginVaultInitialization();

  assert.equal(isVaultInitialized(), true);
  await waitForVaultInitialized();

  failVaultInitialization(remount, new Error("secondary decrypt failed"));
  assert.equal(isVaultInitialized(), true);
  await waitForVaultInitialized();

  releaseVaultInitialization(remount);
  releaseVaultInitialization(authoritative);
});
