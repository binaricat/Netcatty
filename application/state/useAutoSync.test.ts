import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("auto-sync establishes the initial data baseline before debouncing edits", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const baselineCommentIndex = source.indexOf("Establish the initial baseline immediately");
  const initializationGuardIndex = source.indexOf("if (!isInitializedRef.current)", baselineCommentIndex);
  const initializedAssignmentIndex = source.indexOf("isInitializedRef.current = true;", initializationGuardIndex);
  const hashReadIndex = source.indexOf("const currentHash = await getDataHash();", initializationGuardIndex);
  const debounceCommentIndex = source.indexOf("Debounce first, then build the expensive full-data hash", initializationGuardIndex);
  const debounceTimerIndex = source.indexOf("syncTimeoutRef.current = setTimeout", debounceCommentIndex);

  assert.notEqual(baselineCommentIndex, -1);
  assert.notEqual(initializationGuardIndex, -1);
  assert.notEqual(initializedAssignmentIndex, -1);
  assert.notEqual(hashReadIndex, -1);
  assert.notEqual(debounceCommentIndex, -1);
  assert.notEqual(debounceTimerIndex, -1);
  assert.ok(
    initializedAssignmentIndex < hashReadIndex,
    "initialization must be marked synchronously before reading the baseline hash",
  );
  assert.ok(
    initializationGuardIndex < debounceTimerIndex,
    "the first baseline hash must be captured before scheduling the debounced auto-sync timer",
  );
});

test("auto-sync skips only the exact remote-applied data hash", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const helperIndex = source.indexOf("const getSyncPayloadDataHash = (payload: SyncPayload): string");
  const skipRefIndex = source.indexOf("const skipNextSyncHashRef = useRef<string | null>(null)");
  const assignmentIndex = source.indexOf("skipNextSyncHashRef.current = getSyncPayloadDataHash(remotePayload)");
  const debounceTimerIndex = source.indexOf("syncTimeoutRef.current = setTimeout", assignmentIndex);
  const skipHashIndex = source.indexOf("const skipHash = skipNextSyncHashRef.current", debounceTimerIndex);
  const decisionIndex = source.indexOf("resolveAutoSyncHashDecision({", skipHashIndex);
  const appliedSkipIndex = source.indexOf("appliedSkipHash: skipHash", decisionIndex);
  const syncingGuardIndex = source.indexOf("if (sync.isSyncing || isSyncRunningRef.current)", decisionIndex);
  const restoreGuardIndex = source.indexOf("if (isRestoreInProgress())", decisionIndex);
  const interruptedGuardIndex = source.indexOf("if (readInterruptedVaultApply())", decisionIndex);
  const syncNowIndex = source.indexOf("const didSync = await syncNow();", interruptedGuardIndex);
  const didSyncGuardIndex = source.indexOf("if (didSync && skipHash !== null", syncNowIndex);
  const clearAfterSyncIndex = source.indexOf("skipNextSyncHashRef.current = null;", didSyncGuardIndex);
  const booleanSkipIndex = source.indexOf("skipNextSyncRef");

  assert.notEqual(helperIndex, -1);
  assert.notEqual(skipRefIndex, -1);
  assert.notEqual(assignmentIndex, -1);
  assert.notEqual(debounceTimerIndex, -1);
  assert.notEqual(skipHashIndex, -1);
  assert.notEqual(decisionIndex, -1);
  assert.notEqual(appliedSkipIndex, -1);
  assert.notEqual(syncingGuardIndex, -1);
  assert.notEqual(restoreGuardIndex, -1);
  assert.notEqual(interruptedGuardIndex, -1);
  assert.notEqual(syncNowIndex, -1);
  assert.notEqual(didSyncGuardIndex, -1);
  assert.notEqual(clearAfterSyncIndex, -1);
  assert.equal(booleanSkipIndex, -1);
  assert.ok(
    skipHashIndex < decisionIndex,
    "remote-apply skip must pass through the hash decision helper before suppressing a sync",
  );
  assert.ok(
    interruptedGuardIndex < syncNowIndex && syncNowIndex < clearAfterSyncIndex,
    "remote-apply skip hash must survive temporary sync blockers and clear only after a successful sync",
  );
});
