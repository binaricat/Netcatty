import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getInitialTerminalStatus,
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
  const manualRetryIndex = source.indexOf("const handleRetry = () =>");
  const manualPrepareIndex = source.indexOf("prepareRestoredReconnect();", manualRetryIndex);
  const bootActiveIndex = source.indexOf("isBootActiveRef.current = true", manualPrepareIndex);
  const connectingIndex = source.indexOf('updateStatus("connecting")');
  const startNewSessionIndex = source.indexOf("const startNewSession = () =>", connectingIndex);

  assert.notEqual(importIndex, -1);
  assert.notEqual(refIndex, -1);
  assert.notEqual(contextIndex, -1);
  assert.notEqual(prepareDefinitionIndex, -1);
  assert.notEqual(captureCallIndex, -1);
  assert.notEqual(captureAssignIndex, -1);
  assert.notEqual(manualRetryIndex, -1);
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
  const backendPwdWriteIndex = effectsSource.indexOf("onTerminalCwdChange?.(sessionId, cwd ?? null)", backendProbeGuardIndex);

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
    "initial backend pwd probe must remain guarded by knownCwdRef before it writes restore metadata",
  );
});
