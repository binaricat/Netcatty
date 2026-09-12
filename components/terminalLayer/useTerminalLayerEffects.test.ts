import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clearTerminalSessionRuntimeState,
  pruneTerminalTabMemoryState,
  pruneTerminalSessionRuntimeState,
} from "./useTerminalLayerEffects";

const source = readFileSync(new URL("./useTerminalLayerEffects.ts", import.meta.url), "utf8");

test("theme preview DOM effects were removed in favor of ThemeRuntime injection", () => {
  assert.doesNotMatch(source, /themePreview/);
  assert.doesNotMatch(source, /applyTerminalPreviewVars/);
  assert.doesNotMatch(source, /clearHostTreePreviewVars/);
  assert.doesNotMatch(source, /applyTopTabsPreviewVars/);
  assert.doesNotMatch(source, /themeCommitTimerRef/);
});

test("terminal activity filter stays in sync before notification guards", () => {
  const subscriptionIndex = source.indexOf("return onSessionData(session.id, (chunk) => {");
  const filterIndex = source.indexOf("const hasNotifiableOutput = hasNotifiableTerminalOutput(filter, chunk);", subscriptionIndex);
  const visibleGuardIndex = source.indexOf("if (!shouldMarkSessionActivity(activeTabIdRef.current, session))", subscriptionIndex);
  const alreadyActiveGuardIndex = source.indexOf("if (sessionActivityStore.getSnapshot()[session.id])", subscriptionIndex);

  assert.notEqual(subscriptionIndex, -1);
  assert.notEqual(filterIndex, -1);
  assert.notEqual(visibleGuardIndex, -1);
  assert.notEqual(alreadyActiveGuardIndex, -1);
  assert.ok(filterIndex < visibleGuardIndex);
  assert.ok(filterIndex < alreadyActiveGuardIndex);
});

test("side panel layout changes remeasure workspace before paint", () => {
  assert.match(source, /import \{ useCallback, useEffect, useLayoutEffect, useRef \} from 'react';/);

  const commentIndex = source.indexOf("Discrete layout changes (side panel toggle");
  const layoutEffectIndex = source.indexOf("useLayoutEffect(() => {", commentIndex);
  const shellWidthDependencyIndex = source.indexOf("sidePanelShellWidth,", layoutEffectIndex);

  assert.notEqual(commentIndex, -1);
  assert.notEqual(layoutEffectIndex, -1);
  assert.notEqual(shellWidthDependencyIndex, -1);
  assert.ok(commentIndex < layoutEffectIndex);
});

test("transfer navigation helper is used for open-target and resume routing", () => {
  assert.match(source, /resolveSftpTransferNavigationTarget/);
  assert.match(source, /resolveSftpTransferNavigationPath/);
  assert.match(source, /pickHostForTransferNavigation/);
  assert.match(source, /isTransferNavigationTerminalTabId/);
  assert.match(source, /navigation\.kind === 'local-copy-panel'/);
  assert.match(source, /navigation\.kind === 'local-path'/);
  // No terminal tab → connect host then open SFTP at target path.
  assert.match(source, /onConnectToHost/);
  assert.match(source, /openHostThenSftp/);
  assert.match(source, /allowLiveUploadFallback/);
});

const createSessionRuntimeState = () => ({
  terminalRendererCwdBySessionRef: {
    current: new Map([
      ["closed", "/closed"],
      ["live", "/live"],
    ]),
  },
  terminalRendererCwdSourceBySessionRef: {
    current: new Map([
      ["closed", "backend" as const],
      ["live", "osc7" as const],
    ]),
  },
  terminalOsc7SignalBySessionRef: {
    current: new Map([
      ["closed", 4],
      ["live", 7],
    ]),
  },
  cwdProbeGenerationRef: {
    current: new Map([
      ["closed", 2],
      ["live", 3],
    ]),
  },
  cwdProbeCancelersRef: {
    current: new Map<string, () => void>(),
  },
});

test("closing a terminal session cancels its probe and deletes only its runtime state", () => {
  const state = createSessionRuntimeState();
  let closedCancelCount = 0;
  let liveCancelCount = 0;
  state.cwdProbeCancelersRef.current.set("closed", () => { closedCancelCount += 1; });
  state.cwdProbeCancelersRef.current.set("live", () => { liveCancelCount += 1; });

  clearTerminalSessionRuntimeState(state, "closed");

  assert.equal(closedCancelCount, 1);
  assert.equal(liveCancelCount, 0);
  for (const runtimeMap of [
    state.terminalRendererCwdBySessionRef.current,
    state.terminalRendererCwdSourceBySessionRef.current,
    state.terminalOsc7SignalBySessionRef.current,
    state.cwdProbeGenerationRef.current,
    state.cwdProbeCancelersRef.current,
  ]) {
    assert.equal(runtimeMap.has("closed"), false);
    assert.equal(runtimeMap.has("live"), true);
  }

  clearTerminalSessionRuntimeState(state, "closed");
  assert.equal(closedCancelCount, 1, "repeated cleanup must not cancel the same probe twice");
});

test("session pruning preserves reconnecting sessions and unmount cleanup removes the rest", () => {
  const state = createSessionRuntimeState();
  let closedCancelCount = 0;
  let liveCancelCount = 0;
  state.cwdProbeCancelersRef.current.set("closed", () => { closedCancelCount += 1; });
  state.cwdProbeCancelersRef.current.set("live", () => { liveCancelCount += 1; });

  pruneTerminalSessionRuntimeState(state, new Set(["live"]));
  assert.equal(closedCancelCount, 1);
  assert.equal(liveCancelCount, 0);
  assert.equal(state.cwdProbeGenerationRef.current.has("live"), true);

  pruneTerminalSessionRuntimeState(state, new Set());
  assert.equal(liveCancelCount, 1);
  for (const runtimeMap of [
    state.terminalRendererCwdBySessionRef.current,
    state.terminalRendererCwdSourceBySessionRef.current,
    state.terminalOsc7SignalBySessionRef.current,
    state.cwdProbeGenerationRef.current,
    state.cwdProbeCancelersRef.current,
  ]) {
    assert.equal(runtimeMap.size, 0);
  }
});

test("tab memory pruning releases side-panel and SFTP paths for closed sessions", () => {
  const state = {
    lastSidePanelTabRef: { current: new Map([["closed", "sftp"], ["live", "scripts"]]) },
    notesReturnTabRef: { current: new Map([["closed", "notes"], ["live", "sftp"]]) },
    sftpLastPathForSourceRef: {
      current: new Map([
        ["closed", { hostId: "host-1", connectionKey: "closed", path: "/old" }],
        ["live", { hostId: "host-2", connectionKey: "live", path: "/current" }],
      ]),
    },
  };

  pruneTerminalTabMemoryState(state, new Set(["live"]));

  for (const memoryMap of [
    state.lastSidePanelTabRef.current,
    state.notesReturnTabRef.current,
    state.sftpLastPathForSourceRef.current,
  ]) {
    assert.equal(memoryMap.has("closed"), false);
    assert.equal(memoryMap.has("live"), true);
  }
});
