import test from "node:test";
import assert from "node:assert/strict";

import { resolveAutoSyncHashDecision } from "./autoSyncHashDecision.ts";

test("remote-applied data is skipped only when the current hash still matches it", () => {
  assert.equal(
    resolveAutoSyncHashDecision({
      currentHash: "remote-applied",
      lastSyncedHash: "old-local",
      appliedSkipHash: "remote-applied",
    }),
    "skip-applied",
  );
});

test("user edits after remote apply still sync even when they match the old baseline", () => {
  assert.equal(
    resolveAutoSyncHashDecision({
      currentHash: "old-local",
      lastSyncedHash: "old-local",
      appliedSkipHash: "remote-applied",
    }),
    "sync",
  );
});

test("unchanged data is skipped only when there is no pending remote-apply hash", () => {
  assert.equal(
    resolveAutoSyncHashDecision({
      currentHash: "same",
      lastSyncedHash: "same",
      appliedSkipHash: null,
    }),
    "unchanged",
  );
});
