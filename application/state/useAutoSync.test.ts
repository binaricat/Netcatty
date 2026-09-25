import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("auto-sync establishes the initial data baseline before debouncing edits", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const baselineCommentIndex = source.indexOf("Establish the initial baseline immediately");
  const baselineHelperIndex = source.indexOf("const establishInitialBaseline = () =>", baselineCommentIndex);
  const initializedAssignmentIndex = source.indexOf("isInitializedRef.current = true;", baselineHelperIndex);
  const hashReadIndex = source.indexOf("const currentHash = await getDataHash();", baselineHelperIndex);
  const initializationGuardIndex = source.indexOf("if (!isInitializedRef.current)", baselineCommentIndex);
  const baselineCallIndex = source.indexOf("establishInitialBaseline();", initializationGuardIndex);
  const debounceCommentIndex = source.indexOf("Debounce first, then build the expensive full-data hash", initializationGuardIndex);
  const debounceTimerIndex = source.indexOf("syncTimeoutRef.current = setTimeout", debounceCommentIndex);

  assert.notEqual(baselineCommentIndex, -1);
  assert.notEqual(baselineHelperIndex, -1);
  assert.notEqual(initializationGuardIndex, -1);
  assert.notEqual(initializedAssignmentIndex, -1);
  assert.notEqual(hashReadIndex, -1);
  assert.notEqual(baselineCallIndex, -1);
  assert.notEqual(debounceCommentIndex, -1);
  assert.notEqual(debounceTimerIndex, -1);
  assert.ok(
    initializedAssignmentIndex < hashReadIndex,
    "initialization must be marked synchronously before reading the baseline hash",
  );
  assert.ok(
    baselineCallIndex < debounceTimerIndex,
    "the first baseline hash must be captured before scheduling the debounced auto-sync timer",
  );
});

test("paused convergent sync captures a baseline before returning", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const effectIndex = source.indexOf("// Debounced auto-sync when data changes");
  const pausedGuardIndex = source.indexOf("if (convergentSyncPaused)", effectIndex);
  const initializationGuardIndex = source.indexOf("if (!isInitializedRef.current)", pausedGuardIndex);
  const baselineCallIndex = source.indexOf("establishInitialBaseline();", initializationGuardIndex);
  const pausedReturnIndex = source.indexOf("return () =>", baselineCallIndex);

  assert.notEqual(pausedGuardIndex, -1);
  assert.notEqual(initializationGuardIndex, -1);
  assert.notEqual(baselineCallIndex, -1);
  assert.notEqual(pausedReturnIndex, -1);
  assert.ok(
    pausedGuardIndex < initializationGuardIndex
      && initializationGuardIndex < baselineCallIndex
      && baselineCallIndex < pausedReturnIndex,
    "paused mode must preserve the pre-edit baseline before suppressing network sync",
  );
});

test("an unchanged remote check cannot absorb an existing paused-edit baseline", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const baselineSnapshotIndex = source.indexOf("const hadInitialBaseline = isInitializedRef.current");
  const remoteChangeIndex = source.indexOf("inspectedRemoteChange = true", baselineSnapshotIndex);
  const guardedUpdateIndex = source.indexOf(
    "if (markCurrentDataSynced && (!hadInitialBaseline || inspectedRemoteChange))",
    remoteChangeIndex,
  );

  assert.notEqual(baselineSnapshotIndex, -1);
  assert.notEqual(remoteChangeIndex, -1);
  assert.notEqual(guardedUpdateIndex, -1);
  assert.ok(
    baselineSnapshotIndex < remoteChangeIndex && remoteChangeIndex < guardedUpdateIndex,
    "remote inspection must preserve an existing baseline unless it reconciled changed cloud data",
  );
});

test("enabled convergent remote checks use the CRDT runtime before legacy inspection", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const checkIndex = source.indexOf("const checkRemoteVersion = useCallback");
  const convergentGuardIndex = source.indexOf(
    "if (currentConvergentConfig.initialized && currentConvergentConfig.enabled)",
    checkIndex,
  );
  const convergentSyncIndex = source.indexOf(
    "syncNowRef.current({ notifyOnFailure, allowEmptyConvergentSync })",
    convergentGuardIndex,
  );
  const legacyInspectionIndex = source.indexOf(
    "manager.inspectProviderRemote(connectedProvider)",
    convergentSyncIndex,
  );

  assert.notEqual(checkIndex, -1);
  assert.notEqual(convergentGuardIndex, -1);
  assert.notEqual(convergentSyncIndex, -1);
  assert.notEqual(legacyInspectionIndex, -1);
  assert.ok(
    convergentGuardIndex < convergentSyncIndex && convergentSyncIndex < legacyInspectionIndex,
    "v2 checks must return through the CRDT runtime before the legacy snapshot inspector",
  );
});

test("enabled convergent startup checks preview empty-vault recovery before syncing", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const convergentGuardIndex = source.indexOf(
    "if (currentConvergentConfig.initialized && currentConvergentConfig.enabled)",
  );
  const previewIndex = source.indexOf("manager.previewConvergentRecovery()", convergentGuardIndex);
  const recoveryPromptIndex = source.indexOf(
    "requestEmptyVaultRecovery(recoveryPayload)",
    previewIndex,
  );
  const cloudWinsIndex = source.indexOf(
    "conflictActionOverride: 'download-remote'",
    recoveryPromptIndex,
  );
  const manualTriggerIndex = source.indexOf("trigger: 'manual'", recoveryPromptIndex);
  const normalSyncIndex = source.indexOf(
    "syncNowRef.current({ notifyOnFailure, allowEmptyConvergentSync })",
    cloudWinsIndex,
  );

  assert.notEqual(convergentGuardIndex, -1);
  assert.notEqual(previewIndex, -1);
  assert.notEqual(recoveryPromptIndex, -1);
  assert.notEqual(cloudWinsIndex, -1);
  assert.notEqual(manualTriggerIndex, -1);
  assert.notEqual(normalSyncIndex, -1);
  assert.ok(
    convergentGuardIndex < previewIndex
      && previewIndex < recoveryPromptIndex
      && recoveryPromptIndex < manualTriggerIndex
      && manualTriggerIndex < cloudWinsIndex
      && cloudWinsIndex < normalSyncIndex,
    "v2 startup must offer recovery and use cloud-wins before the normal CRDT sync path",
  );
});

test("empty-vault recovery restore bypasses the auto-sync preference gate", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const recoveryPromptIndex = source.indexOf("requestEmptyVaultRecovery(recoveryPayload)");
  const restoreCallIndex = source.indexOf("syncNowRef.current({", recoveryPromptIndex);
  const triggerIndex = source.indexOf("trigger: 'manual'", restoreCallIndex);
  const conflictIndex = source.indexOf(
    "conflictActionOverride: 'download-remote'",
    restoreCallIndex,
  );
  const callEndIndex = source.indexOf("});", conflictIndex);

  assert.notEqual(recoveryPromptIndex, -1);
  assert.notEqual(restoreCallIndex, -1);
  assert.notEqual(triggerIndex, -1);
  assert.notEqual(conflictIndex, -1);
  assert.ok(
    restoreCallIndex < triggerIndex
      && triggerIndex < conflictIndex
      && conflictIndex < callEndIndex,
    "recovery Restore must pass trigger:manual so disabled auto-sync cannot block it",
  );
});

test("empty v2 startup checks allow a validated empty sync to open the gate", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const convergentGuardIndex = source.indexOf(
    "if (currentConvergentConfig.initialized && currentConvergentConfig.enabled)",
  );
  const replicaIndex = source.indexOf("manager.loadConvergentReplica()", convergentGuardIndex);
  const emptyDecisionIndex = source.indexOf("allowEmptyConvergentSync = (", replicaIndex);
  const syncIndex = source.indexOf(
    "syncNowRef.current({ notifyOnFailure, allowEmptyConvergentSync })",
    emptyDecisionIndex,
  );
  const guardIndex = source.indexOf(
    "options?.allowEmptyConvergentSync !== true",
    source.indexOf("const syncNow = useCallback"),
  );

  assert.notEqual(replicaIndex, -1);
  assert.notEqual(emptyDecisionIndex, -1);
  assert.notEqual(syncIndex, -1);
  assert.notEqual(guardIndex, -1);
  assert.ok(replicaIndex < emptyDecisionIndex && emptyDecisionIndex < syncIndex);
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

test("auto syncNow and debounce re-check manager autoSyncEnabled before pushing", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const helperIndex = source.indexOf("function isPersistedAutoSyncEnabled");
  const syncNowIndex = source.indexOf("const syncNow = useCallback");
  const autoGateIndex = source.indexOf(
    "if (trigger === 'auto' && !isPersistedAutoSyncEnabled(manager.getState().autoSyncEnabled))",
    syncNowIndex,
  );
  const debounceIndex = source.indexOf("// Debounced auto-sync when data changes");
  const fireTimeGateIndex = source.indexOf(
    "if (!isPersistedAutoSyncEnabled(manager.getState().autoSyncEnabled))",
    debounceIndex,
  );
  const clearTimerIndex = source.indexOf(
    "if (syncTimeoutRef.current) {\n        clearTimeout(syncTimeoutRef.current);\n        syncTimeoutRef.current = null;\n      }\n      return;",
    debounceIndex,
  );

  assert.notEqual(helperIndex, -1);
  assert.notEqual(syncNowIndex, -1);
  assert.notEqual(autoGateIndex, -1);
  assert.notEqual(fireTimeGateIndex, -1);
  assert.notEqual(clearTimerIndex, -1);
  assert.ok(
    helperIndex < syncNowIndex
      && syncNowIndex < autoGateIndex
      && debounceIndex < fireTimeGateIndex
      && debounceIndex < clearTimerIndex,
    "auto-sync off must gate both syncNow(auto) and the debounced timer path",
  );
});

test("startup local-wins and merge round-trips refuse device-bound credential placeholders", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const uploadLocalIndex = source.indexOf("if (conflictAction === 'upload-local')");
  const uploadGuardIndex = source.indexOf(
    "findSyncPayloadEncryptedCredentialPaths(localPayload)",
    uploadLocalIndex,
  );
  const uploadPushIndex = source.indexOf("manager.syncAllProviders(localPayload)", uploadGuardIndex);
  const mergeRoundTripBlockIndex = source.indexOf(
    "stripSyncPayloadEncryptedCredentials(mergeResult.payload)",
  );
  const mergeLocalHealIndex = source.indexOf(
    "healPoisonedSecretsForMerge(localPayload, remoteRaw, base)",
  );
  const mergeRemoteHealIndex = source.indexOf(
    "healPoisonedSecretsForMerge(remoteRaw, localPayload, base)",
  );
  const mergePushIndex = source.indexOf(
    "manager.syncAllProviders(portableMerge)",
    mergeRoundTripBlockIndex,
  );
  const stripRemoteIndex = source.indexOf(
    "stripSyncPayloadEncryptedCredentials(remoteRaw)",
  );

  assert.notEqual(uploadLocalIndex, -1);
  assert.notEqual(uploadGuardIndex, -1);
  assert.notEqual(uploadPushIndex, -1);
  assert.notEqual(mergeLocalHealIndex, -1);
  assert.notEqual(mergeRemoteHealIndex, -1);
  assert.notEqual(mergeRoundTripBlockIndex, -1);
  assert.notEqual(mergePushIndex, -1);
  assert.notEqual(stripRemoteIndex, -1);
  assert.ok(
    uploadGuardIndex < uploadPushIndex,
    "startup local-wins must guard placeholders before syncAllProviders",
  );
  assert.ok(
    mergeLocalHealIndex < mergeRoundTripBlockIndex
      && mergeRemoteHealIndex < mergeRoundTripBlockIndex
      && mergeRoundTripBlockIndex < mergePushIndex,
    "startup merge must heal local+remote secrets, then strip, then upload",
  );
});

test("post-merge round-trip is gated behind cloudSyncPayloadsEqual", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const importIndex = source.indexOf("cloudSyncPayloadsEqual");
  const mergeResultGuard = source.indexOf("if (mergeResult.payload)", importIndex);
  const equalityCheckIndex = source.indexOf(
    "cloudSyncPayloadsEqual(portableMerge, remotePayload)",
    mergeResultGuard,
  );
  const hasLocalGuardIndex = source.indexOf(
    "if (hasLocalChangesToUpload)",
    equalityCheckIndex,
  );
  const syncAllIndex = source.indexOf(
    "manager.syncAllProviders(portableMerge)",
    hasLocalGuardIndex,
  );
  const elseIndex = source.indexOf(
    "// No local-only additions",
    syncAllIndex,
  );
  const markSyncedIndex = source.indexOf(
    "markCurrentDataSynced = true;",
    elseIndex,
  );

  assert.notEqual(importIndex, -1, "cloudSyncPayloadsEqual must be imported");
  assert.notEqual(equalityCheckIndex, -1, "equality check must exist after merge guard");
  assert.notEqual(hasLocalGuardIndex, -1, "hasLocalChangesToUpload guard must exist");
  assert.notEqual(syncAllIndex, -1, "syncAllProviders must be called inside the guard");
  assert.notEqual(elseIndex, -1, "else branch must skip upload when payloads match");
  assert.notEqual(markSyncedIndex, -1, "else branch must mark data as synced");
  assert.ok(
    equalityCheckIndex < hasLocalGuardIndex
      && hasLocalGuardIndex < syncAllIndex
      && syncAllIndex < elseIndex
      && elseIndex < markSyncedIndex,
    "post-merge upload must be skipped when merged payload equals remote payload",
  );
});

test("download-remote round-trip is skipped for single-provider setups", () => {
  const source = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const downloadRemoteIndex = source.indexOf("if (conflictAction === 'download-remote')");
  const readyProvidersIndex = source.indexOf(
    "readyProviders.length > 1",
    downloadRemoteIndex,
  );
  const syncAllIndex = source.indexOf(
    "manager.syncAllProviders(remotePayload",
    readyProvidersIndex,
  );
  const singleProviderElse = source.indexOf(
    "// Single provider: no need to round-trip",
    syncAllIndex,
  );

  assert.notEqual(downloadRemoteIndex, -1);
  assert.notEqual(readyProvidersIndex, -1, "must check provider count before round-trip");
  assert.notEqual(syncAllIndex, -1, "syncAllProviders must be inside multi-provider guard");
  assert.notEqual(singleProviderElse, -1, "single-provider path must skip upload");
  assert.ok(
    downloadRemoteIndex < readyProvidersIndex
      && readyProvidersIndex < syncAllIndex
      && syncAllIndex < singleProviderElse,
    "download-remote must gate round-trip behind provider count",
  );
});

test("applySyncableSettings guards versioned writes with change detection", () => {
  const source = readFileSync(
    new URL("../syncPayload.ts", import.meta.url),
    "utf8",
  );

  // customAccent: must compare colors before writing
  const accentGuardIndex = source.indexOf("if (incomingColor !== existing.color)");
  assert.notEqual(accentGuardIndex, -1, "customAccent must check color equality before write");

  // terminalFontSize: must compare fontSize before writing
  const fontSizeGuardIndex = source.indexOf("if (settings.terminalFontSize !== existing.fontSize)");
  assert.notEqual(fontSizeGuardIndex, -1, "terminalFontSize must check fontSize equality before write");

  // customKeyBindings: must compare serialized bindings before writing
  const bindingsGuardIndex = source.indexOf("if (incomingBindings !== existingBindings)");
  assert.notEqual(bindingsGuardIndex, -1, "customKeyBindings must check bindings equality before write");

  assert.ok(
    accentGuardIndex < fontSizeGuardIndex && fontSizeGuardIndex < bindingsGuardIndex,
    "all three versioned setting writes must be guarded with change detection",
  );
});
