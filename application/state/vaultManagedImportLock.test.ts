import assert from "node:assert/strict";
import test from "node:test";

import { withVaultImportLock } from "./vaultManagedImportLock.ts";

test("Vault imports are serialized without Web Locks", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withVaultImportLock("shared", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  }, null);
  const second = withVaultImportLock("shared", async () => {
    events.push("second:start");
    events.push("second:end");
  }, null);

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});
