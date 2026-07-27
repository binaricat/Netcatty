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

test("vault import treats an explicit persistence failure as an import failure", async () => {
  let committed = 0;
  let rolledBack = 0;
  await assert.doesNotReject(() => ensureVaultImportPersisted(
    undefined,
    "not saved",
    () => { committed++; },
  ));
  await assert.rejects(
    ensureVaultImportPersisted(
      false,
      "not saved",
      () => { committed++; },
      () => { rolledBack++; },
    ),
    /not saved/,
  );
  assert.equal(committed, 1);
  assert.equal(rolledBack, 1);
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
