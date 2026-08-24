import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_LOCK_TIMEOUT_OPTIONS_MINUTES,
  DEFAULT_APP_LOCK_SETTINGS,
  normalizeAppLockSettings,
  normalizeAppLockTimeoutMinutes,
} from "./appLock.ts";

test("normalizeAppLockTimeoutMinutes accepts only supported timeout options", () => {
  assert.deepEqual(APP_LOCK_TIMEOUT_OPTIONS_MINUTES, [0, 1, 5, 15, 30, 60]);
  assert.equal(normalizeAppLockTimeoutMinutes(0), 0);
  assert.equal(normalizeAppLockTimeoutMinutes(1), 1);
  assert.equal(normalizeAppLockTimeoutMinutes("5"), 5);
  assert.equal(normalizeAppLockTimeoutMinutes(60), 60);
  assert.equal(normalizeAppLockTimeoutMinutes(2), DEFAULT_APP_LOCK_SETTINGS.timeoutMinutes);
  assert.equal(normalizeAppLockTimeoutMinutes(""), DEFAULT_APP_LOCK_SETTINGS.timeoutMinutes);
});

test("normalizeAppLockSettings preserves a valid verifier but clears system unlock when disabled", () => {
  const normalized = normalizeAppLockSettings({
    enabled: false,
    timeoutMinutes: 30,
    systemUnlockEnabled: true,
    systemUnlockAutoPromptEnabled: true,
    passwordVerifier: {
      version: 1,
      algorithm: "PBKDF2-SHA256",
      iterations: 210000,
      salt: Buffer.alloc(16, 1).toString("base64"),
      hash: Buffer.alloc(32, 2).toString("base64"),
    },
  });

  assert.deepEqual(normalized, {
    enabled: false,
    timeoutMinutes: 30,
    systemUnlockEnabled: false,
    systemUnlockAutoPromptEnabled: false,
    passwordVerifier: {
      version: 1,
      algorithm: "PBKDF2-SHA256",
      iterations: 210000,
      salt: Buffer.alloc(16, 1).toString("base64"),
      hash: Buffer.alloc(32, 2).toString("base64"),
    },
  });
});

test("normalizeAppLockSettings refuses enabled state without a valid verifier", () => {
  assert.deepEqual(
    normalizeAppLockSettings({
      enabled: true,
      timeoutMinutes: 5,
      passwordVerifier: {
        version: 1,
        algorithm: "PBKDF2-SHA256",
        iterations: 0,
        salt: "",
        hash: "",
      },
      systemUnlockEnabled: true,
      systemUnlockAutoPromptEnabled: true,
    }),
    {
      enabled: false,
      timeoutMinutes: 5,
      systemUnlockEnabled: false,
      systemUnlockAutoPromptEnabled: false,
      passwordVerifier: null,
    },
  );
});

test("normalizeAppLockSettings defaults system unlock and auto prompt off for older settings", () => {
  const normalized = normalizeAppLockSettings({
    enabled: false,
    timeoutMinutes: 15,
    passwordVerifier: null,
  });

  assert.equal(normalized.systemUnlockEnabled, false);
  assert.equal(normalized.systemUnlockAutoPromptEnabled, false);
});

test("normalizeAppLockSettings disables auto prompt unless system unlock is enabled", () => {
  const normalized = normalizeAppLockSettings({
    enabled: false,
    timeoutMinutes: 15,
    systemUnlockEnabled: false,
    systemUnlockAutoPromptEnabled: true,
    passwordVerifier: {
      version: 1,
      algorithm: "PBKDF2-SHA256",
      iterations: 210000,
      salt: Buffer.alloc(16, 1).toString("base64"),
      hash: Buffer.alloc(32, 2).toString("base64"),
    },
  });

  assert.equal(normalized.systemUnlockEnabled, false);
  assert.equal(normalized.systemUnlockAutoPromptEnabled, false);
});
