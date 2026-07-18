import assert from "node:assert/strict";
import test from "node:test";

import {
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
