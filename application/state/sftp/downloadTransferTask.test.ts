import assert from "node:assert/strict";
import test from "node:test";

import {
  createDirectDownloadTransferTask,
  resolveDirectDirectoryDownloadFinalStatus,
} from "./downloadTransferTask";

test("download tasks retain the remote host needed for reconnecting after the original SSH session closes", () => {
  const task = createDirectDownloadTransferTask({
    id: "download-1",
    fileName: "archive.bin",
    sourcePath: "/remote/archive.bin",
    targetPath: "/local/archive.bin",
    expectedLocalTarget: {
      parentRealPath: "/local",
      parentIdentity: "1:2",
      parentBirthtimeNs: "100",
      targetIdentity: "1:3",
      targetBirthtimeNs: "200",
      targetCtimeNs: "201",
      targetMtimeNs: "202",
    },
    sourceConnectionId: "connection-1",
    sourceHostId: "host-1",
    sourceHostLabel: "Production",
    totalBytes: 128,
    isDirectory: false,
  });

  assert.equal(task.sourceHostId, "host-1");
  assert.equal(task.sourceHostLabel, "Production");
  assert.equal(task.targetConnectionId, "local");
  assert.equal(task.resumable, true);
  assert.equal(task.status, "queued");
  assert.equal(task.expectedLocalTarget?.targetIdentity, "1:3");
  assert.equal(task.requireOriginalSourceForResume, true);
  assert.equal(task.phase, undefined);
});

test("directory download final status stays cancelled when parent was cancelled mid-tree", () => {
  // transferDirectory counts cancelled children as errors; parent cancel must win.
  const resolved = resolveDirectDirectoryDownloadFinalStatus({
    parentCancelled: true,
    childFailureCount: 3,
  });
  assert.equal(resolved.status, "cancelled");
  assert.equal(resolved.error, undefined);
});

test("directory download final status is failed only when parent was not cancelled", () => {
  const resolved = resolveDirectDirectoryDownloadFinalStatus({
    parentCancelled: false,
    childFailureCount: 2,
  });
  assert.equal(resolved.status, "failed");
  assert.equal(resolved.error, "Some files failed to transfer");
});

test("directory download final status is completed when no child failures", () => {
  const resolved = resolveDirectDirectoryDownloadFinalStatus({
    parentCancelled: false,
    childFailureCount: 0,
  });
  assert.equal(resolved.status, "completed");
  assert.equal(resolved.error, undefined);
});

test("cancel wins even when child error count is zero (late cancel race)", () => {
  // Snapshot may have been non-cancelled; re-check still forces cancelled.
  const resolved = resolveDirectDirectoryDownloadFinalStatus({
    parentCancelled: true,
    childFailureCount: 0,
  });
  assert.equal(resolved.status, "cancelled");
});
