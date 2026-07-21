import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getInitialTerminalStatus,
  shouldSuppressHostStartupCommandOnReconnect,
  shouldStartTerminalBackend,
} from "./restoredSessionGate.ts";

test("restored disconnected sessions initialize as connecting", () => {
  assert.equal(
    getInitialTerminalStatus(),
    "connecting",
  );
});

test("normal sessions initialize as connecting", () => {
  assert.equal(getInitialTerminalStatus(), "connecting");
});

test("restored disconnected sessions start terminal backend", () => {
  assert.equal(shouldStartTerminalBackend(), true);
});

test("host startup command policy distinguishes restored and automatic reconnects", () => {
  assert.equal(shouldSuppressHostStartupCommandOnReconnect("restored"), false);
  assert.equal(shouldSuppressHostStartupCommandOnReconnect("manual"), false);
  assert.equal(shouldSuppressHostStartupCommandOnReconnect("automatic"), true);
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
  const staleWakeDisposeIndex = source.indexOf("disposeRuntimeOnly();", staleWakeGuardIndex);
  const missingTermReturnIndex = source.indexOf("if (!termRef.current) return;", reconnectIndex);

  assert.notEqual(wakePromiseRefIndex, -1);
  assert.notEqual(wakeGuardRefIndex, -1);
  assert.notEqual(wakeTokenRefIndex, -1);
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
  assert.notEqual(staleWakeDisposeIndex, -1);
  assert.notEqual(missingTermReturnIndex, -1);
  assert.ok(
    hibernatedBranchIndex < missingTermReturnIndex && wakeCallIndex < missingTermReturnIndex,
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
    staleWakeGuardIndex < staleWakeDisposeIndex,
    "an invalidated hibernated wake must dispose any runtime created after unmount cleanup",
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
