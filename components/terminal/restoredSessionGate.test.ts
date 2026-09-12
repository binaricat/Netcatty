import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolveRestoreCwdIntent } from "../../domain/sessionRestore.ts";

import {
  getInitialTerminalStatus,
  resolveTerminalVaultInitialized,
  shouldResetConnectAutomationOnReconnect,
  shouldSuppressHostStartupCommandOnReconnect,
  shouldStartTerminalBackend,
} from "./restoredSessionGate.ts";
import { setVaultInitialized } from "../../application/state/vaultInitStore.ts";

test("Terminal restore preparation honors fresh login while preserving ordinary and local cwd restore", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const prepareRestoredReconnect = useCallback");
  const end = source.indexOf("// Set only once the inherited", start);
  assert.ok(start >= 0 && end > start);
  for (const protocol of ["ssh", undefined, "local"] as const) {
    for (const requireFreshConnection of [false, true]) {
      const restoreCwdIntentRef: { current: { command: string } | null } = { current: null };
      runInNewContext(`${source.slice(start, end)}\nprepareRestoredReconnect();`, {
        useCallback: (fn: () => void) => fn,
        shouldSuppressHostStartupCommandOnReconnect,
        resolveRestoreCwdIntent,
        suppressHostStartupCommandRef: { current: false },
        restoreCwdIntentRef,
        restoreState: "restored-disconnected",
        restoreTerminalCwd: true,
        host: { protocol },
        shellType: "posix",
        lastCwd: "/srv/old-target",
        isNetworkDevice: false,
        requireFreshConnection,
      });
      if (requireFreshConnection && protocol !== "local") assert.equal(restoreCwdIntentRef.current, null);
      else assert.equal(restoreCwdIntentRef.current?.command, "cd -- '/srv/old-target'");
    }
  }
});

test("restored disconnected sessions initialize as connecting", () => {
  assert.equal(
    getInitialTerminalStatus(),
    "connecting",
  );
});

test("normal sessions initialize as connecting", () => {
  assert.equal(getInitialTerminalStatus(), "connecting");
});

test("restored disconnected sessions start terminal backend only after vault hydration", () => {
  setVaultInitialized(false);
  assert.equal(shouldStartTerminalBackend(), false);
  setVaultInitialized(true);
  assert.equal(shouldStartTerminalBackend(), true);
});

test("terminal boot waits for vaultInitialized before creating a backend session", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(!attachExistingSession && !vaultInitialized\) \{\s*\n\s*return;/,
    "boot effect must wait for vault hydration before creating xterm/backend",
  );
  assert.match(
    source,
    /vaultInitialized,/,
    "vaultInitialized must be in the boot effect dependency list",
  );
});

test("terminal popup can supply its own completed vault hydration state", () => {
  const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const popupSource = readFileSync(new URL("../TerminalPopupPage.tsx", import.meta.url), "utf8");

  assert.match(
    terminalSource,
    /const vaultInitialized = resolveTerminalVaultInitialized\(\s*sharedVaultInitialized,\s*vaultInitializedOverride,\s*\);/,
  );
  assert.match(popupSource, /vaultInitializedOverride=\{vaultInitialized\}/);
  assert.equal(resolveTerminalVaultInitialized(false, true), true);
  assert.equal(resolveTerminalVaultInitialized(false), false);
  assert.equal(resolveTerminalVaultInitialized(true, false), false);
});

test("host startup command policy distinguishes restored and automatic reconnects", () => {
  assert.equal(shouldSuppressHostStartupCommandOnReconnect("restored"), false);
  assert.equal(shouldSuppressHostStartupCommandOnReconnect("manual"), false);
  assert.equal(shouldSuppressHostStartupCommandOnReconnect("automatic"), true);
});

test("connect automation reset policy distinguishes manual and automatic reconnects", () => {
  assert.equal(shouldResetConnectAutomationOnReconnect("manual"), true);
  assert.equal(shouldResetConnectAutomationOnReconnect("restored"), true);
  assert.equal(shouldResetConnectAutomationOnReconnect("automatic"), false);
});

test("manual reconnect resets connect automation before opening a new session", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const reconnectIndex = source.indexOf("const startReconnect = ");
  const cancelBatchIndex = source.indexOf(
    "await cancelConnectAutomationBatch(connectAutomationBatch)",
    reconnectIndex,
  );
  const manualBranchIndex = source.indexOf(
    'if (mode === "manual") {\n      clearAutoReconnect',
    cancelBatchIndex,
  );
  const stopFailureRetryIndex = source.indexOf(
    'if (mode === "auto" && retryTokenStillCurrent())',
    cancelBatchIndex,
  );
  const stopFailureDisconnectedIndex = source.indexOf(
    'updateStatus("disconnected")',
    stopFailureRetryIndex,
  );
  const resetConsumedIndex = source.indexOf(
    "connectScriptsConsumedRef.current = false",
    manualBranchIndex,
  );
  const resetCompletedIndex = source.indexOf(
    "connectScriptsCompletedIdsRef.current = new Set()",
    manualBranchIndex,
  );
  const resetInFlightIndex = source.indexOf(
    "connectScriptsInFlightRef.current = false",
    manualBranchIndex,
  );
  const connectingIndex = source.indexOf('updateStatus("connecting")', manualBranchIndex);
  const autoElseIndex = source.indexOf("} else {", manualBranchIndex);
  const autoSuppressIndex = source.indexOf(
    'shouldSuppressHostStartupCommandOnReconnect("automatic")',
    autoElseIndex,
  );

  assert.notEqual(reconnectIndex, -1);
  assert.notEqual(cancelBatchIndex, -1);
  assert.notEqual(manualBranchIndex, -1);
  assert.notEqual(stopFailureRetryIndex, -1);
  assert.notEqual(stopFailureDisconnectedIndex, -1);
  assert.notEqual(resetConsumedIndex, -1);
  assert.notEqual(resetCompletedIndex, -1);
  assert.notEqual(resetInFlightIndex, -1);
  assert.notEqual(connectingIndex, -1);
  assert.notEqual(autoElseIndex, -1);
  assert.notEqual(autoSuppressIndex, -1);
  assert.ok(
    cancelBatchIndex < manualBranchIndex
      && cancelBatchIndex < resetConsumedIndex
      && cancelBatchIndex < resetCompletedIndex
      && cancelBatchIndex < resetInFlightIndex,
    "every reconnect must await onConnect cancellation before manual guards are cleared",
  );
  assert.ok(
    stopFailureRetryIndex < stopFailureDisconnectedIndex
      && stopFailureDisconnectedIndex < manualBranchIndex,
    "automatic reconnect must return to disconnected when stopping the old batch fails",
  );
  assert.ok(
    resetConsumedIndex < connectingIndex && resetCompletedIndex < connectingIndex,
    "manual reconnect must clear connect-automation consumption before the new session boot continues",
  );
  assert.ok(
    autoElseIndex < autoSuppressIndex && autoSuppressIndex < connectingIndex,
    "automatic reconnect must keep the existing connect-automation consumption decision",
  );
  assert.ok(
    !source.slice(autoElseIndex, connectingIndex).includes("connectScriptsConsumedRef.current = false"),
    "automatic reconnect must not reset connect-automation refs",
  );
  assert.match(
    source.slice(autoElseIndex, connectingIndex),
    /connectScriptsConsumedRef\.current = true/,
    "automatic reconnect must stop the old batch without queuing it again",
  );
});
test("restored disconnected sessions still create a terminal runtime before backend startup", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  const runtimeIndex = source.indexOf("const runtime = createXTermRuntime");
  const backendGateIndex = source.indexOf("if (!shouldStartTerminalBackend())");

  assert.notEqual(runtimeIndex, -1);
  assert.notEqual(backendGateIndex, -1);
  assert.ok(
    runtimeIndex < backendGateIndex,
    "restored sessions need an xterm runtime before the backend starts",
  );
});

test("auto reconnect prepares restored session state before clearing the restore marker", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  const prepareIndex = source.indexOf("prepareRestoredReconnect?.()");
  const updateConnectingIndex = source.indexOf('updateStatus("connecting")', prepareIndex);

  assert.notEqual(prepareIndex, -1);
  assert.notEqual(updateConnectingIndex, -1);
  assert.ok(
    prepareIndex < updateConnectingIndex,
    "auto reconnect must capture restore details before the restored marker is cleared",
  );
});

test("manual reconnect captures restore cwd intent before clearing restored state", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const importIndex = source.indexOf("resolveRestoreCwdIntent");
  const refIndex = source.indexOf("const restoreCwdIntentRef = useRef");
  const contextIndex = source.indexOf("restoreCwdIntentRef,");
  const prepareDefinitionIndex = source.indexOf("const prepareRestoredReconnect = useCallback");
  const captureAssignIndex = source.indexOf("restoreCwdIntentRef.current =", prepareDefinitionIndex);
  const captureCallIndex = source.indexOf("resolveRestoreCwdIntent", captureAssignIndex);
  const reconnectIndex = source.indexOf("const startReconnect = ");
  const manualBranchIndex = source.indexOf('if (mode === "manual")', reconnectIndex);
  const manualPrepareIndex = source.indexOf("prepareRestoredReconnect();", manualBranchIndex);
  const bootActiveIndex = source.indexOf("isBootActiveRef.current = true", manualPrepareIndex);
  const connectingIndex = source.indexOf('updateStatus("connecting")', manualPrepareIndex);
  const startNewSessionIndex = source.indexOf("const startNewSession = () =>", connectingIndex);

  assert.notEqual(importIndex, -1);
  assert.notEqual(refIndex, -1);
  assert.notEqual(contextIndex, -1);
  assert.notEqual(prepareDefinitionIndex, -1);
  assert.notEqual(captureCallIndex, -1);
  assert.notEqual(captureAssignIndex, -1);
  assert.notEqual(reconnectIndex, -1);
  assert.notEqual(manualBranchIndex, -1);
  assert.notEqual(manualPrepareIndex, -1);
  assert.notEqual(bootActiveIndex, -1);
  assert.notEqual(connectingIndex, -1);
  assert.notEqual(startNewSessionIndex, -1);
  assert.ok(
    captureAssignIndex < captureCallIndex && manualPrepareIndex < connectingIndex,
    "manual retry must capture cwd intent while restoreState is still available",
  );
  assert.ok(
    bootActiveIndex < startNewSessionIndex,
    "manual retry must reactivate the boot guard before opening a backend session",
  );
});

test("manual reconnect re-arms inherited cwd intent after a failed first connection", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const reconnectIndex = source.indexOf("const startReconnect = ");
  const manualBranchIndex = source.indexOf('if (mode === "manual")', reconnectIndex);
  const manualPrepareIndex = source.indexOf("prepareRestoredReconnect();", manualBranchIndex);
  const rearmIndex = source.indexOf("prepareInitialCwdIntent();", manualPrepareIndex);
  const connectingIndex = source.indexOf('updateStatus("connecting")', manualPrepareIndex);

  assert.notEqual(reconnectIndex, -1);
  assert.notEqual(manualBranchIndex, -1);
  assert.notEqual(manualPrepareIndex, -1);
  assert.notEqual(rearmIndex, -1);
  assert.notEqual(connectingIndex, -1);
  assert.ok(
    manualPrepareIndex < rearmIndex && rearmIndex < connectingIndex,
    "a clone whose first connection fails must re-arm the inherited cwd on manual retry",
  );
});

test("auto reconnect connected history ref is initialized after status state exists", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const statusStateIndex = source.indexOf('const [status, setStatus] = useState<TerminalSession["status"]>');
  const hasEverConnectedIndex = source.indexOf("const hasEverConnectedRef = useRef");

  assert.notEqual(statusStateIndex, -1);
  assert.notEqual(hasEverConnectedIndex, -1);
  assert.ok(
    statusStateIndex < hasEverConnectedIndex,
    "auto reconnect refs must not read status before the status state is initialized",
  );
});

test("reconnect wakes a hibernated terminal before requiring a terminal instance", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const wakePromiseRefIndex = source.indexOf("const wakePromiseRef = useRef<Promise<boolean> | null>(null)");
  const wakeGuardRefIndex = source.indexOf("const reconnectWakeInFlightRef = useRef(false)");
  const wakeTokenRefIndex = source.indexOf("const reconnectWakeTokenRef = useRef<symbol | null>(null)");
  const wakeInvalidateModeIndex = source.indexOf('const reconnectWakeInvalidateModeRef = useRef<"dispose" | "keep">("dispose")');
  const wakeTokenCleanupIndex = source.indexOf("reconnectWakeTokenRef.current = null", wakeTokenRefIndex);
  const reconnectIndex = source.indexOf("const startReconnect = ");
  const hibernatedBranchIndex = source.indexOf('!termRef.current && hibernatedRef.current', reconnectIndex);
  const duplicateWakeGuardIndex = source.indexOf("if (reconnectWakeInFlightRef.current) return", hibernatedBranchIndex);
  const markWakeInFlightIndex = source.indexOf("reconnectWakeInFlightRef.current = true", duplicateWakeGuardIndex);
  const connectingIndex = source.indexOf('updateStatus("connecting")', markWakeInFlightIndex);
  const wakeCallIndex = source.indexOf("wakeHibernatedRuntimeForReconnectRef.current", hibernatedBranchIndex);
  const wakeInvocationIndex = source.indexOf("void wakeForReconnect()", wakeCallIndex);
  const wakeJoinIndex = source.indexOf("return wakePromiseRef.current ?? false", source.indexOf("const wakeFromHibernateRuntime"));
  const wakeTokenIndex = source.indexOf("const wakeToken = Symbol()", hibernatedBranchIndex);
  const staleWakeGuardIndex = source.indexOf("reconnectWakeTokenRef.current !== wakeToken", wakeInvocationIndex);
  const staleWakeDisposeGuardIndex = source.indexOf('reconnectWakeInvalidateModeRef.current === "dispose"', staleWakeGuardIndex);
  const staleWakeDisposeIndex = source.indexOf("disposeRuntimeOnly();", staleWakeDisposeGuardIndex);
  const disconnectKeepModeIndex = source.indexOf('reconnectWakeInvalidateModeRef.current = "keep"', source.indexOf("const handleDisconnect"));
  const missingTermGuardIndex = source.indexOf("if (!termRef.current) {", reconnectIndex);
  const missingTermReturnIndex = source.indexOf("return;", missingTermGuardIndex);

  assert.notEqual(wakePromiseRefIndex, -1);
  assert.notEqual(wakeGuardRefIndex, -1);
  assert.notEqual(wakeTokenRefIndex, -1);
  assert.notEqual(wakeInvalidateModeIndex, -1);
  assert.notEqual(wakeTokenCleanupIndex, -1);
  assert.ok(wakeTokenCleanupIndex < reconnectIndex);
  assert.notEqual(reconnectIndex, -1);
  assert.notEqual(hibernatedBranchIndex, -1);
  assert.notEqual(duplicateWakeGuardIndex, -1);
  assert.notEqual(markWakeInFlightIndex, -1);
  assert.notEqual(connectingIndex, -1);
  assert.notEqual(wakeCallIndex, -1);
  assert.notEqual(wakeInvocationIndex, -1);
  assert.notEqual(wakeJoinIndex, -1);
  assert.notEqual(wakeTokenIndex, -1);
  assert.notEqual(staleWakeGuardIndex, -1);
  assert.notEqual(staleWakeDisposeGuardIndex, -1);
  assert.notEqual(staleWakeDisposeIndex, -1);
  assert.notEqual(disconnectKeepModeIndex, -1);
  assert.notEqual(missingTermGuardIndex, -1);
  assert.notEqual(missingTermReturnIndex, -1);
  assert.ok(
    hibernatedBranchIndex < missingTermGuardIndex && wakeCallIndex < missingTermGuardIndex,
    "manual and auto reconnect must wake fully hibernated sessions before the terminal guard can stop the retry",
  );
  assert.ok(
    duplicateWakeGuardIndex < markWakeInFlightIndex && markWakeInFlightIndex < connectingIndex,
    "hibernated reconnect must block duplicate requests before beginning an asynchronous wake",
  );
  assert.ok(
    wakeTokenIndex < wakeInvocationIndex && wakeInvocationIndex < staleWakeGuardIndex,
    "closing a terminal must be able to invalidate a pending hibernated reconnect",
  );
  assert.ok(
    staleWakeGuardIndex < staleWakeDisposeGuardIndex && staleWakeDisposeGuardIndex < staleWakeDisposeIndex,
    "an invalidated hibernated wake must dispose any runtime created after unmount cleanup",
  );
  assert.ok(
    disconnectKeepModeIndex !== -1,
    "disconnect must keep a woken runtime so later reconnect still has a terminal instance",
  );
});

test("dismissing the disconnected dialog returns focus to the terminal for enter reconnect", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const dismissIndex = source.indexOf("const handleDismissDisconnectedDialog = () =>");
  const dismissedIndex = source.indexOf("setIsDisconnectedDialogDismissed(true)", dismissIndex);
  const focusIndex = source.indexOf("queueMicrotask(() => termRef.current?.focus())", dismissIndex);
  const closeSessionIndex = source.indexOf("const handleCloseDisconnectedSession = () =>", dismissIndex);

  assert.notEqual(dismissIndex, -1);
  assert.notEqual(dismissedIndex, -1);
  assert.notEqual(focusIndex, -1);
  assert.notEqual(closeSessionIndex, -1);
  assert.ok(
    dismissedIndex < focusIndex && focusIndex < closeSessionIndex,
    "dismissing the disconnected dialog should leave Enter routed back through the terminal",
  );
});

test("disconnected connection dialog keeps an Enter-reconnect focus sink", () => {
  const source = readFileSync(new URL("./TerminalConnectionDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /canEnterReconnectFromDialog/);
  assert.match(source, /data-terminal-disconnected-dialog/);
  assert.match(source, /shouldReconnectDisconnectedDialogOnEnterKey/);
  assert.match(source, /shouldClaimDisconnectedDialogFocus/);
  assert.match(source, /shouldRestoreDisconnectedDialogTerminalFocus/);
  assert.match(source, /restoreTerminalFocusFromDisconnectedDialog/);
  assert.match(source, /dialogFocusRef\.current\?\.focus/);
  // Focus claim must key only on enter-reconnect mode, not showLogs/error,
  // or toggling "Show logs" steals keyboard focus off the button.
  const claimEffectIdx = source.indexOf("Claim focus only when Enter-reconnect mode turns on");
  // Restore must run on overlay unmount — not when Enter-reconnect ends into
  // auth/host-key while the dialog stays mounted.
  const restoreEffectIdx = source.indexOf("Restore xterm focus only when this overlay unmounts");
  assert.notEqual(claimEffectIdx, -1);
  assert.notEqual(restoreEffectIdx, -1);
  const claimDeps = source.indexOf("}, [canEnterReconnectFromDialog, isFocusedPane]);", claimEffectIdx);
  const restoreDeps = source.indexOf("}, []);", restoreEffectIdx);
  assert.notEqual(claimDeps, -1);
  assert.notEqual(restoreDeps, -1);
  assert.ok(claimDeps < restoreEffectIdx);
  // Claim deps must not re-run on showLogs/error/status; restore is unmount-only.
  assert.match(source.slice(claimDeps, claimDeps + 60), /^\}, \[canEnterReconnectFromDialog, isFocusedPane\]\);/);
  assert.match(source.slice(restoreDeps, restoreDeps + 10), /^\}, \[\]\);/);
  assert.equal(source.includes("}, [canEnterReconnectFromDialog, status, error, showLogs]"), false);
  // Split unfocused panes pass isFocusedPane so document blur cannot steal focus.
  assert.match(source, /isFocusedPane/);
  assert.match(source, /shouldClaimDisconnectedDialogFocus\(\{[\s\S]*isFocusedPane/);
  // Unmount restore must also honor isFocusedPane when focus lands on body/html.
  assert.match(source, /restoreTerminalFocusFromDisconnectedDialog\(\{[\s\S]*isFocusedPane/);
});

test("open terminal search does not globally gate enter reconnect", () => {
  const viewSource = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");
  const gateIndex = viewSource.indexOf("export function shouldReconnectTerminalOnEnterKey");
  const bodyEnd = viewSource.indexOf("export function shouldBlockTerminalReconnectForTarget", gateIndex);
  const gateBody = viewSource.slice(gateIndex, bodyEnd);
  assert.equal(gateBody.includes("!isSearchOpen"), false);
  assert.match(viewSource, /isTerminalSearchInput/);
  assert.match(
    readFileSync(new URL("./TerminalSearchBar.tsx", import.meta.url), "utf8"),
    /data-terminal-search-input/,
  );
});

test("terminal view receives the effective compose bar state for enter reconnect gating", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const effectiveDefinitionIndex = source.indexOf("const effectiveComposeBarOpen =");
  const viewIndex = source.indexOf("<TerminalView ctx={{");
  const passEffectiveIndex = source.indexOf("isComposeBarOpen: effectiveComposeBarOpen", viewIndex);

  assert.notEqual(effectiveDefinitionIndex, -1);
  assert.notEqual(viewIndex, -1);
  assert.notEqual(passEffectiveIndex, -1);
  assert.ok(
    effectiveDefinitionIndex < passEffectiveIndex,
    "TerminalView must use the visible workspace compose state before deciding whether Enter can reconnect",
  );
});

test("startup and attach cwd cache clears preserve restore cwd metadata", () => {
  const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");

  const clearDefinitionIndex = terminalSource.indexOf("const clearTerminalCwd = useCallback");
  const clearNotifyIndex = terminalSource.indexOf("onTerminalCwdChange?.(sessionId, null)", clearDefinitionIndex);
  const persistGuardIndex = terminalSource.indexOf("persistRestoreMetadata", clearDefinitionIndex);
  const attachIndex = terminalSource.indexOf("onSessionAttached: (id: string) =>");
  const attachClearIndex = terminalSource.indexOf("clearTerminalCwd({ persistRestoreMetadata: false })", attachIndex);
  const startupClearIndex = effectsSource.indexOf("clearTerminalCwd({ persistRestoreMetadata: false })");

  assert.notEqual(clearDefinitionIndex, -1);
  assert.notEqual(clearNotifyIndex, -1);
  assert.notEqual(persistGuardIndex, -1);
  assert.notEqual(attachIndex, -1);
  assert.notEqual(attachClearIndex, -1);
  assert.notEqual(startupClearIndex, -1);
  assert.ok(
    persistGuardIndex < clearNotifyIndex,
    "clearTerminalCwd must gate persisted restore metadata updates",
  );
});

test("restored cwd intent marks known cwd before initial backend pwd probe can persist home", () => {
  const terminalSource = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");

  const callbackIndex = terminalSource.indexOf("onRestoreCwdIntentConsumed:");
  const knownAssignIndex = terminalSource.indexOf("knownCwdRef.current = cwd", callbackIndex);
  const backendProbeGuardIndex = effectsSource.indexOf("knownCwdRef.current");
  const backendPwdWriteIndex = effectsSource.indexOf("onPluginRuntimeCwdChange(result.cwd)", backendProbeGuardIndex);

  assert.notEqual(callbackIndex, -1);
  assert.notEqual(knownAssignIndex, -1);
  assert.notEqual(backendProbeGuardIndex, -1);
  assert.notEqual(backendPwdWriteIndex, -1);
  assert.ok(
    knownAssignIndex > callbackIndex,
    "Terminal must preserve the restore target as a known cwd when the restore command is sent",
  );
  assert.ok(
    backendProbeGuardIndex < backendPwdWriteIndex,
    "initial backend pwd probe must remain guarded by knownCwdRef before it publishes the probed cwd",
  );
});
