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
