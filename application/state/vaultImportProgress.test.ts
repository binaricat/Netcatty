import assert from "node:assert/strict";
import test from "node:test";

import {
  countVaultImportDuplicates,
  ensureVaultImportPersisted,
  waitForVaultImportProgressPaint,
} from "./vaultImportProgress.ts";

test("vault import duplicate count includes hosts that already exist", () => {
  assert.equal(countVaultImportDuplicates({
    importedHostCount: 8000,
    newHostCount: 0,
    fileDuplicateCount: 3,
    managed: false,
  }), 8003);

  assert.equal(countVaultImportDuplicates({
    importedHostCount: 8000,
    newHostCount: 0,
    fileDuplicateCount: 3,
    managed: true,
  }), 3);
});

test("vault import treats an explicit persistence failure as an import failure", () => {
  assert.doesNotThrow(() => ensureVaultImportPersisted(undefined, "not saved"));
  assert.throws(
    () => ensureVaultImportPersisted(false, "not saved"),
    /not saved/,
  );
});

test("vault import keeps moving when animation frames are paused in a background window", async () => {
  let timeoutCallback: (() => void) | undefined;
  let resolved = false;

  const promise = waitForVaultImportProgressPaint({
    requestFrame: () => 1,
    setTimer: (callback) => {
      timeoutCallback = callback;
      return 1;
    },
    clearTimer: () => {},
  }).then(() => {
    resolved = true;
  });

  await Promise.resolve();
  assert.equal(resolved, false);

  timeoutCallback?.();
  await promise;
  assert.equal(resolved, true);
});
