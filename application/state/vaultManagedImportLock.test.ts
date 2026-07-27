import assert from "node:assert/strict";
import test from "node:test";

import {
  isVaultImportLockHeld,
  withVaultImportLock,
} from "./vaultManagedImportLock.ts";

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

test("Vault import lock re-enters in the same window without deadlock", async () => {
  const events: string[] = [];
  await withVaultImportLock("reenter", async () => {
    events.push("outer");
    assert.equal(isVaultImportLockHeld("reenter"), true);
    await withVaultImportLock("reenter", async () => {
      events.push("inner");
      assert.equal(isVaultImportLockHeld("reenter"), true);
    }, null);
    events.push("after-inner");
  }, null);
  assert.equal(isVaultImportLockHeld("reenter"), false);
  assert.deepEqual(events, ["outer", "inner", "after-inner"]);
});

test("Vault imports fail safely in a window without shared locking", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  try {
    await assert.rejects(
      () => withVaultImportLock("shared", async () => undefined, null),
      /Cross-window Vault import locking is unavailable/,
    );
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});
