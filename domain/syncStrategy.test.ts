import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CLOUD_SYNC_STRATEGY,
  normalizeCloudSyncStrategy,
  resolveCloudSyncConflictAction,
} from "./syncStrategy.ts";

test("normalizeCloudSyncStrategy falls back to smart merge for unknown values", () => {
  assert.equal(normalizeCloudSyncStrategy("preferCloud"), "preferCloud");
  assert.equal(normalizeCloudSyncStrategy("preferLocal"), "preferLocal");
  assert.equal(normalizeCloudSyncStrategy("smartMerge"), "smartMerge");
  assert.equal(normalizeCloudSyncStrategy("downloadOnly"), DEFAULT_CLOUD_SYNC_STRATEGY);
  assert.equal(normalizeCloudSyncStrategy(undefined), DEFAULT_CLOUD_SYNC_STRATEGY);
});

test("resolveCloudSyncConflictAction keeps current merge behavior by default", () => {
  assert.equal(
    resolveCloudSyncConflictAction("smartMerge", {
      hasConflict: true,
      hasRemoteFile: true,
    }),
    "smart-merge",
  );
});

test("resolveCloudSyncConflictAction lets cloud data win when requested", () => {
  assert.equal(
    resolveCloudSyncConflictAction("preferCloud", {
      hasConflict: true,
      hasRemoteFile: true,
    }),
    "download-remote",
  );
});

test("resolveCloudSyncConflictAction lets local data win when requested", () => {
  assert.equal(
    resolveCloudSyncConflictAction("preferLocal", {
      hasConflict: true,
      hasRemoteFile: true,
    }),
    "upload-local",
  );
});

test("resolveCloudSyncConflictAction uploads normally when no remote conflict exists", () => {
  assert.equal(
    resolveCloudSyncConflictAction("preferCloud", {
      hasConflict: false,
      hasRemoteFile: true,
    }),
    "upload-local",
  );
});
