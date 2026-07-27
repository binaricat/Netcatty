import assert from "node:assert/strict";
import test from "node:test";

import {
  countVaultImportDuplicates,
  ensureVaultImportPersisted,
  rollbackVaultImportedHosts,
  waitForVaultImportProgressPaint,
} from "./vaultImportProgress.ts";

test("vault import rollback preserves unrelated concurrent host changes", () => {
  const baseline = [{
    id: "existing",
    label: "Existing",
    hostname: "existing.test",
    username: "root",
    port: 22,
    group: "Original",
    tags: [],
    os: "linux" as const,
  }];
  const applied = [
    { ...baseline[0], group: "Managed", managedSourceId: "source-1" },
    {
      ...baseline[0],
      id: "imported",
      label: "Imported",
      hostname: "imported.test",
    },
  ];
  const concurrent = {
    ...baseline[0],
    id: "concurrent",
    label: "Concurrent",
    hostname: "concurrent.test",
  };

  const rolledBack = rollbackVaultImportedHosts({
    baselineHosts: baseline,
    appliedHosts: applied,
    currentHosts: [
      { ...applied[0], notes: "changed while importing" },
      applied[1],
      concurrent,
    ],
  });

  assert.deepEqual(rolledBack, [
    { ...baseline[0], notes: "changed while importing" },
    concurrent,
  ]);
});

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
