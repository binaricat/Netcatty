import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeRuntimeAppLockState,
  selectPreferredRuntimeAppLockState,
} from "./useAppLockRuntime.ts";

test("normalizeRuntimeAppLockState defaults safely", () => {
  assert.deepEqual(normalizeRuntimeAppLockState(null), {
    initialized: false,
    locked: false,
    reason: null,
    version: 0,
    lastLockedAt: null,
    lastUnlockedAt: null,
    lastActivityAt: null,
  });
});

test("normalizeRuntimeAppLockState preserves a valid runtime payload", () => {
  assert.deepEqual(
    normalizeRuntimeAppLockState({
      initialized: true,
      locked: true,
      reason: "startup",
      version: 3,
      lastLockedAt: 123,
      lastUnlockedAt: null,
      lastActivityAt: 456,
    }),
    {
      initialized: true,
      locked: true,
      reason: "startup",
      version: 3,
      lastLockedAt: 123,
      lastUnlockedAt: null,
      lastActivityAt: 456,
    },
  );
});

test("selectPreferredRuntimeAppLockState keeps the newer runtime version", () => {
  const current = normalizeRuntimeAppLockState({
    initialized: true,
    locked: false,
    reason: null,
    version: 4,
    lastLockedAt: 100,
    lastUnlockedAt: 200,
    lastActivityAt: 300,
  });
  const staleIncoming = normalizeRuntimeAppLockState({
    initialized: true,
    locked: true,
    reason: "startup",
    version: 3,
    lastLockedAt: 50,
    lastUnlockedAt: null,
    lastActivityAt: 60,
  });

  assert.deepEqual(
    selectPreferredRuntimeAppLockState(current, staleIncoming),
    current,
  );
});

test("selectPreferredRuntimeAppLockState prefers initialized state when versions tie", () => {
  const current = normalizeRuntimeAppLockState({
    initialized: true,
    locked: false,
    reason: null,
    version: 0,
    lastLockedAt: null,
    lastUnlockedAt: 200,
    lastActivityAt: 300,
  });
  const uninitializedIncoming = normalizeRuntimeAppLockState({
    initialized: false,
    locked: false,
    reason: null,
    version: 0,
    lastLockedAt: null,
    lastUnlockedAt: null,
    lastActivityAt: null,
  });

  assert.deepEqual(
    selectPreferredRuntimeAppLockState(current, uninitializedIncoming),
    current,
  );
});
