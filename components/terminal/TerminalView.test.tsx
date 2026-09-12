import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatTerminalHostInfoBarTitle,
  formatTerminalHostInfoBarTooltip,
  formatTerminalTitleConnectionAddress,
  focusTerminalFromDisconnectedNotice,
  getLineTimestampToggleHostUpdate,
  resolveNetworkDeviceTipRightInset,
  resolveTerminalRightInset,
  resolveTerminalTopOffsets,
  shouldBlockTerminalReconnectForTarget,
  shouldEnableStatusBarDisconnect,
  shouldEnableStatusBarReconnect,
  shouldReconnectTerminalOnEnterKey,
  shouldShowSelectionAIOverlay,
  shouldShowLineTimestampToolbarToggle,
  shouldShowStatusBarConnectionControls,
  TerminalDisconnectedNotice,
  resolveTerminalDisconnectedNoticeMessage,
} from "./TerminalView.tsx";

test("terminal disconnected notice keeps the reason and reconnect hint on one compact row", () => {
  const markup = renderToStaticMarkup(React.createElement(TerminalDisconnectedNotice, {
    message: "Connection timed out.",
    reconnectHint: "Press Enter to reconnect",
    bottom: 4,
    left: 4,
    right: 4,
  }));

  assert.match(markup, /data-terminal-disconnected-notice="true"/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /Connection timed out\./);
  assert.match(markup, /Press Enter to reconnect/);
  assert.match(markup, /h-7/);
  assert.doesNotMatch(markup, /pointer-events-none/);
});

test("clicking the disconnected notice preserves terminal keyboard focus", () => {
  let prevented = false;
  let focused = false;

  focusTerminalFromDisconnectedNotice(
    { preventDefault: () => { prevented = true; } },
    () => { focused = true; },
  );

  assert.equal(prevented, true);
  assert.equal(focused, true);
});

test("automatic reconnect notice uses explicit lifecycle copy instead of a stale log line", () => {
  assert.equal(
    resolveTerminalDisconnectedNoticeMessage({
      status: "connecting",
      error: null,
      reconnectMessage: "Auto reconnect attempt 2...",
      disconnectedLabel: "Disconnected",
    }),
    "Auto reconnect attempt 2...",
  );
  assert.equal(
    resolveTerminalDisconnectedNoticeMessage({
      status: "disconnected",
      error: "Connection timed out.",
      reconnectMessage: "Waiting for host key confirmation",
      disconnectedLabel: "Disconnected",
    }),
    "Connection timed out.",
  );
  assert.equal(
    resolveTerminalDisconnectedNoticeMessage({
      status: "disconnected",
      error: "Connection timed out.",
      reconnectMessage: "Reconnecting...",
      disconnectedLabel: "Disconnected",
      isReconnectActive: true,
    }),
    "Reconnecting...",
  );
});

test("automatic reconnect switches to attempt copy before waking a hibernated terminal", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const startReconnect = source.indexOf('const startReconnect = async');
  const updateNotice = source.indexOf('setReconnectNoticeMessage(reconnectAttemptMessage)', startReconnect);
  const wakeHibernated = source.indexOf('if (!termRef.current && hibernatedRef.current)', startReconnect);

  assert.ok(startReconnect >= 0);
  assert.ok(updateNotice > startReconnect);
  assert.ok(wakeHibernated > updateNotice);
});

test("hibernated manual reconnect can continue after its runtime wakes", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const startReconnect = source.indexOf("const startReconnect = async");
  const markManualReconnect = source.indexOf(
    'setManualReconnectActive(mode === "manual")',
    startReconnect,
  );
  const initialGuard = source.slice(startReconnect, markManualReconnect);
  const clearWakeInFlight = source.indexOf(
    "reconnectWakeInFlightRef.current = false",
    markManualReconnect,
  );
  const continueReconnect = source.indexOf("startReconnectRef.current?.(mode)", clearWakeInFlight);

  assert.ok(startReconnect >= 0);
  assert.ok(markManualReconnect > startReconnect);
  assert.match(initialGuard, /reconnectPreparationTokenRef\.current !== null/);
  assert.match(initialGuard, /reconnectWakeInFlightRef\.current/);
  assert.doesNotMatch(initialGuard, /manualReconnectActive/);
  assert.ok(clearWakeInFlight > markManualReconnect);
  assert.ok(continueReconnect > clearWakeInFlight);
});

test("manual reconnect publishes preparation without starting the connection timeout", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const startReconnect = source.indexOf("const startReconnect = async");
  const publishPreparation = source.indexOf(
    "terminalReconnectRegistry.setActive(sessionId, true)",
    startReconnect,
  );
  const cleanupSession = source.indexOf(
    "await cleanupSession({ retainOwnership: true })",
    startReconnect,
  );
  const restoreDisconnected = source.indexOf(
    'updateStatus("disconnected")',
    startReconnect,
  );

  assert.ok(startReconnect >= 0);
  assert.ok(publishPreparation > startReconnect);
  assert.ok(cleanupSession > publishPreparation);
  assert.equal(
    source.indexOf('if (mode === "manual") updateStatus("connecting")', startReconnect),
    -1,
  );
  assert.ok(restoreDisconnected > startReconnect);
  assert.ok(restoreDisconnected < cleanupSession);
});

test("programmatic input during hibernated reconnect does not clear reconnect presentation", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const scrollStart = source.indexOf("const scrollToBottomAfterProgrammaticInput");
  const scrollEnd = source.indexOf("useEffect(() =>", scrollStart);
  const scrollBody = source.slice(scrollStart, scrollEnd);

  assert.notEqual(scrollStart, -1);
  assert.notEqual(scrollEnd, -1);
  assert.doesNotMatch(scrollBody, /manualReconnectActiveRef|setReconnectNoticeMessage/);
});

test("line timestamp toggle creates a persistent host update", () => {
  const host = {
    id: "host-1",
    label: "Host",
    showLineTimestamps: false,
    theme: "default",
  };

  assert.deepEqual(getLineTimestampToggleHostUpdate(host), {
    id: "host-1",
    showLineTimestamps: true,
  });
  assert.deepEqual(getLineTimestampToggleHostUpdate({ ...host, showLineTimestamps: true }), {
    id: "host-1",
    showLineTimestamps: false,
  });
});

test("line timestamp toolbar toggle is hidden when timestamps are unavailable", () => {
  assert.equal(shouldShowLineTimestampToolbarToggle(false, () => {}), false);
  assert.equal(shouldShowLineTimestampToolbarToggle(true, () => {}), true);
  assert.equal(shouldShowLineTimestampToolbarToggle(undefined, () => {}), true);
  assert.equal(shouldShowLineTimestampToolbarToggle(true, undefined), false);
});

test("selection AI overlay honors the visibility preference", () => {
  const overlayPosition = { left: 120, top: 80 };
  const addSelection = () => {};

  assert.equal(
    shouldShowSelectionAIOverlay({
      hasSelection: true,
      selectionOverlayPosition: overlayPosition,
      onAddSelectionToAI: addSelection,
    }),
    true,
  );
  assert.equal(
    shouldShowSelectionAIOverlay({
      hasSelection: true,
      selectionOverlayPosition: overlayPosition,
      onAddSelectionToAI: addSelection,
      showSelectionAIAction: true,
    }),
    true,
  );
  assert.equal(
    shouldShowSelectionAIOverlay({
      hasSelection: true,
      selectionOverlayPosition: overlayPosition,
      onAddSelectionToAI: addSelection,
      showSelectionAIAction: false,
    }),
    false,
  );
});

test("disconnected terminal reconnects on plain Enter when input is not claimed elsewhere", () => {
  assert.equal(
    shouldReconnectTerminalOnEnterKey({
      key: "Enter",
      status: "disconnected",
      hasRetryHandler: true,
      isComposeBarOpen: false,
      needsAuth: false,
      needsHostKeyVerification: false,
      hasBlockingOverlay: false,
    }),
    true,
  );
});

test("terminal enter reconnect ignores active controls and non-disconnected states", () => {
  const base = {
    key: "Enter",
    status: "disconnected" as const,
    hasRetryHandler: true,
    isComposeBarOpen: false,
    needsAuth: false,
    needsHostKeyVerification: false,
    hasBlockingOverlay: false,
  };

  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, status: "connected" }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, key: "a" }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, hasRetryHandler: false }), false);
  // Open search must not globally suppress Enter reconnect / the hint (#2546).
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base }), true);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, isComposeBarOpen: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, needsAuth: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, needsHostKeyVerification: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, hasBlockingOverlay: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, isReconnectActive: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, altKey: true }), false);
});

test("terminal enter reconnect ignores interactive controls outside xterm only", () => {
  assert.equal(
    shouldBlockTerminalReconnectForTarget({
      isWithinXterm: false,
      hasInteractiveAncestor: true,
    }),
    true,
  );
  assert.equal(
    shouldBlockTerminalReconnectForTarget({
      isWithinXterm: true,
      hasInteractiveAncestor: true,
    }),
    false,
  );
  assert.equal(
    shouldBlockTerminalReconnectForTarget({
      isWithinXterm: false,
      hasInteractiveAncestor: false,
    }),
    false,
  );
  // An open terminal search input is interactive, but disconnected Enter must
  // still reconnect rather than find-next (#2546).
  assert.equal(
    shouldBlockTerminalReconnectForTarget({
      isWithinXterm: false,
      hasInteractiveAncestor: true,
      isTerminalSearchInput: true,
    }),
    false,
  );
});

test("terminal title formats the connection address for remote sessions", () => {
  assert.equal(
    formatTerminalTitleConnectionAddress({
      protocol: "ssh",
      username: "root",
      hostname: "10.1.2.34",
      port: 2222,
    }),
    "root@10.1.2.34:2222",
  );
  assert.equal(formatTerminalTitleConnectionAddress({ protocol: "local", hostname: "localhost" }), null);
  assert.equal(formatTerminalTitleConnectionAddress({
    protocol: "plugin:com.example.transport.connection",
    hostname: "com.example.transport.connection",
    port: 22,
  }), null);
});

test("host info bar title follows address or label mode", () => {
  assert.equal(
    formatTerminalHostInfoBarTitle({
      serverName: "prod-web",
      connectionAddress: "root@10.1.2.34:2222",
      mode: "address",
    }),
    "root@10.1.2.34:2222",
  );
  assert.equal(
    formatTerminalHostInfoBarTitle({
      serverName: "prod-web",
      connectionAddress: "root@10.1.2.34:2222",
      mode: "label",
    }),
    "prod-web",
  );
  assert.equal(
    formatTerminalHostInfoBarTitle({
      serverName: "  prod-web  ",
      connectionAddress: " root@10.1.2.34:2222 ",
      mode: "label",
    }),
    "prod-web",
  );
  assert.equal(
    formatTerminalHostInfoBarTitle({
      serverName: "",
      connectionAddress: "root@10.1.2.34:2222",
      mode: "label",
    }),
    "root@10.1.2.34:2222",
  );
  assert.equal(
    formatTerminalHostInfoBarTitle({
      serverName: "Local Terminal",
      connectionAddress: null,
      mode: "address",
    }),
    "Local Terminal",
  );
  assert.equal(
    formatTerminalHostInfoBarTooltip({
      serverName: "prod-web",
      connectionAddress: "root@10.1.2.34:2222",
    }),
    "prod-web · root@10.1.2.34:2222",
  );
});

test("terminal title row does not render a status dot beside the address", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");
  const titleStart = source.indexOf("data-terminal-detach-drag-handle");
  const titleEnd = source.indexOf("shouldShowLineTimestampToolbarToggle", titleStart);
  assert.notEqual(titleStart, -1);
  assert.notEqual(titleEnd, -1);

  assert.doesNotMatch(source.slice(titleStart, titleEnd), /statusDotTone/);
});

test("terminal title keeps the copy host action beside the address", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");
  const titleStart = source.indexOf("data-terminal-detach-drag-handle");
  const copyAction = source.indexOf('aria-label={t("terminal.statusbar.copyHostname.label")}', titleStart);
  const timestampToggle = source.indexOf("shouldShowLineTimestampToolbarToggle", titleStart);

  assert.notEqual(titleStart, -1);
  assert.notEqual(copyAction, -1);
  assert.notEqual(timestampToggle, -1);
  assert.ok(copyAction < timestampToggle);
});

test("focus mode and temporary pane magnification use separate toolbar actions", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");
  const focusAction = source.indexOf("onClick={onExpandToFocus}");
  const magnifyAction = source.indexOf("onClick={onTogglePaneMagnification}");

  assert.notEqual(focusAction, -1);
  assert.notEqual(magnifyAction, -1);
  assert.ok(focusAction < magnifyAction);
  assert.match(source.slice(focusAction, magnifyAction), /terminal\.toolbar\.focusMode/);
  assert.match(source.slice(magnifyAction), /terminal\.paneMagnification\.(restore|magnify)/);
});

test("popup terminals disable line timestamp controls", () => {
  const source = readFileSync(new URL("../TerminalPopupPage.tsx", import.meta.url), "utf8");

  assert.match(source, /lineTimestampsAvailable=\{false\}/);
});

test("terminal body keeps a slight inset from the surrounding chrome", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");

  assert.match(source, /const terminalBodyInset = 4/);
  assert.match(source, /left: activeLineTimestampGutterWidth \+ terminalBodyInset/);
  assert.match(source, /right: terminalRightInset/);
  assert.match(source, /const terminalBottomInset = terminalBodyInset \+ \(showDisconnectedTerminalNotice \? 28 : 0\)/);
  assert.match(source, /bottom: terminalBottomInset/);
  assert.match(source, /left=\{terminalBodyInset\}/);
  assert.match(source, /bottom=\{terminalBottomInset\}/);
});

test("hidden host information bar gives its vertical space back to the terminal", () => {
  assert.deepEqual(
    resolveTerminalTopOffsets({ showHostInfoBar: false, isSearchOpen: false }),
    { toolbarOffset: 0, contentTop: "4px" },
  );
  assert.deepEqual(
    resolveTerminalTopOffsets({ showHostInfoBar: true, isSearchOpen: false }),
    { toolbarOffset: 30, contentTop: "34px" },
  );
});

test("terminal search keeps enough space when host information is hidden", () => {
  assert.deepEqual(
    resolveTerminalTopOffsets({ showHostInfoBar: false, isSearchOpen: true }),
    { toolbarOffset: 64, contentTop: "68px" },
  );
});

test("network device tip reserves extra top space below the toolbar", () => {
  // Tip stacks below the toolbar: content shifts down by the tip height, but
  // the toolbar offset itself is unchanged.
  assert.deepEqual(
    resolveTerminalTopOffsets({ showHostInfoBar: true, isSearchOpen: false, networkDeviceTipHeight: 28 }),
    { toolbarOffset: 30, contentTop: "62px" },
  );
  assert.deepEqual(
    resolveTerminalTopOffsets({ showHostInfoBar: false, isSearchOpen: false, networkDeviceTipHeight: 28 }),
    { toolbarOffset: 0, contentTop: "32px" },
  );
});

test("network device tip clears the compact speed-dial toggle only when it is present", () => {
  // Speed dial only renders when host info is hidden and search is closed;
  // reserve right-side room there so the tip cannot cover its click target.
  assert.equal(resolveNetworkDeviceTipRightInset({ showHostInfoBar: false, isSearchOpen: false }), 40);
  assert.equal(resolveNetworkDeviceTipRightInset({ showHostInfoBar: true, isSearchOpen: false }), 0);
  assert.equal(resolveNetworkDeviceTipRightInset({ showHostInfoBar: false, isSearchOpen: true }), 0);
});

test("hidden host information does not reserve a side gutter for its floating action button", () => {
  // Speed-dial overlays the terminal; scrollbar stays at the pane edge.
  assert.equal(resolveTerminalRightInset({ showHostInfoBar: false, isSearchOpen: false }), 4);
  assert.equal(resolveTerminalRightInset({ showHostInfoBar: true, isSearchOpen: false }), 4);
  assert.equal(resolveTerminalRightInset({ showHostInfoBar: false, isSearchOpen: true }), 4);
});

test("hidden host information keeps terminal actions rendered", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");
  const hostInfoStart = source.indexOf("{showHostInfoBar && <div");
  const hostInfoEnd = source.indexOf("</div>}", hostInfoStart);
  const copyAction = source.indexOf('aria-label={t("terminal.statusbar.copyHostname.label")}');
  const timestampAction = source.indexOf("shouldShowLineTimestampToolbarToggle", copyAction);
  const systemAction = source.indexOf('aria-label={t("terminal.layer.system")}', timestampAction);
  const disconnectAction = source.indexOf('aria-label={t("terminal.statusbar.disconnect.label")}', systemAction);
  const reconnectAction = source.indexOf('aria-label={t("terminal.statusbar.reconnect.label")}', disconnectAction);
  const actionsStart = source.indexOf('className="flex items-center gap-0.5 flex-shrink-0"');
  const controls = source.indexOf("{renderControls({ showClose: inWorkspace, restorePaneLayout: isPaneMagnified })}");
  const compactDragHandle = source.indexOf('data-terminal-detach-drag-handle="true"');

  assert.notEqual(hostInfoStart, -1);
  assert.notEqual(hostInfoEnd, -1);
  assert.notEqual(copyAction, -1);
  assert.notEqual(timestampAction, -1);
  assert.notEqual(systemAction, -1);
  assert.notEqual(disconnectAction, -1);
  assert.notEqual(reconnectAction, -1);
  assert.notEqual(actionsStart, -1);
  assert.notEqual(controls, -1);
  assert.notEqual(compactDragHandle, -1);
  // Compact drag handle uses GripVertical, not the old radial-dot “chessboard”.
  assert.match(source, /GripVertical/);
  assert.ok(!source.includes("backgroundSize: '4px 4px'"));
  assert.ok(hostInfoStart < hostInfoEnd);
  assert.ok(hostInfoEnd < copyAction);
  assert.ok(copyAction < timestampAction);
  assert.ok(timestampAction < systemAction);
  assert.ok(systemAction < disconnectAction);
  assert.ok(disconnectAction < reconnectAction);
  assert.ok(reconnectAction < actionsStart);
  assert.ok(actionsStart < controls);
  assert.ok(compactDragHandle < hostInfoStart);
});

test("status bar disconnect stays enabled while connected or connecting", () => {
  assert.equal(shouldEnableStatusBarDisconnect("connected"), true);
  assert.equal(shouldEnableStatusBarDisconnect("connecting"), true);
  assert.equal(shouldEnableStatusBarDisconnect("disconnected"), false);
  assert.equal(shouldEnableStatusBarDisconnect(undefined), false);
});

test("status bar reconnect matches tab-menu reconnect gating", () => {
  assert.equal(shouldEnableStatusBarReconnect("connected"), true);
  assert.equal(shouldEnableStatusBarReconnect("disconnected"), true);
  assert.equal(shouldEnableStatusBarReconnect("connecting"), false);
  assert.equal(shouldEnableStatusBarReconnect(undefined), false);
});

test("status bar connection controls require an owned session surface", () => {
  assert.equal(
    shouldShowStatusBarConnectionControls({
      showConnectionControls: true,
      hasDisconnectHandler: true,
      hasReconnectHandler: true,
    }),
    true,
  );
  assert.equal(
    shouldShowStatusBarConnectionControls({
      showConnectionControls: false,
      hasDisconnectHandler: true,
      hasReconnectHandler: true,
    }),
    false,
  );
  assert.equal(
    shouldShowStatusBarConnectionControls({
      showConnectionControls: true,
      hasDisconnectHandler: false,
      hasReconnectHandler: false,
    }),
    false,
  );
});

test("manual disconnect keeps the session pane for reconnect", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const disconnectStart = source.indexOf("const handleDisconnect = () => {");
  const disconnectEnd = source.indexOf("const handleDismissDisconnectedDialog", disconnectStart);
  assert.notEqual(disconnectStart, -1);
  assert.notEqual(disconnectEnd, -1);
  const body = source.slice(disconnectStart, disconnectEnd);
  assert.match(body, /clearAutoReconnect\(\{ stopLoop: true \}\)/);
  assert.match(body, /reconnectWakeTokenRef\.current = null/);
  assert.match(body, /reconnectWakeInFlightRef\.current = false/);
  assert.match(body, /netcatty:terminal-session-disconnected/);
  assert.match(body, /invalidateBootEpochForClose\(\)/);
  assert.match(body, /isBootActiveRef\.current = false/);
  assert.match(body, /setIsCancelling\(true\)/);
  assert.match(body, /updateStatus\("disconnected"\)/);
  assert.match(body, /void cleanupSession\(\{ retainOwnership: true \}\)/);
  assert.match(source, /trackSessionCleanup/);
  assert.doesNotMatch(body, /onCloseSession/);
  assert.match(source, /handleDisconnect: \(attachExistingSession \|\| compactToolbar\) \? undefined : handleDisconnect/);
  assert.match(source, /showConnectionControls: !attachExistingSession && !compactToolbar/);
  assert.match(source, /setTerminalBootEpoch/);

  const startersSource = readFileSync(
    new URL("./runtime/createTerminalSessionStarters.ts", import.meta.url),
    "utf8",
  );
  assert.match(startersSource, /createBootAttemptGuard\(ctx\)/);
  assert.match(startersSource, /setTerminalBootEpoch\(ctx\.sessionId, bootEpoch\)/);

  const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  assert.match(
    effectsSource,
    /!isBootActiveRef\.current[\s\S]*statusRef\.current === "disconnected"[\s\S]*bootEpochMismatch/,
  );
  assert.match(
    effectsSource,
    /respondHostKeyVerification\?\.\(request\.requestId, false\)/,
  );
  assert.match(effectsSource, /request\.bootEpoch/);
  assert.match(
    startersSource,
    /if \(!isCurrentAttempt\(\)\) return;/,
  );
  assert.match(startersSource, /bootEpoch,/);
});

test("cancel connect invalidates the boot epoch like disconnect", () => {
  const source = readFileSync(new URL("../Terminal.tsx", import.meta.url), "utf8");
  const cancelStart = source.indexOf("const handleCancelConnect = () => {");
  const cancelEnd = source.indexOf("const handleDisconnect = () => {", cancelStart);
  assert.notEqual(cancelStart, -1);
  assert.notEqual(cancelEnd, -1);
  const body = source.slice(cancelStart, cancelEnd);

  assert.match(body, /invalidateBootEpochForClose\(\)/);
  assert.match(body, /isBootActiveRef\.current = false/);
  // Both must land before cleanupSession so the close targets the pre-bump epoch.
  assert.ok(
    body.indexOf("invalidateBootEpochForClose()") < body.indexOf("void cleanupSession()"),
    "cancel must invalidate the boot epoch before cleanupSession",
  );
  assert.ok(
    body.indexOf("isBootActiveRef.current = false") < body.indexOf("void cleanupSession()"),
    "cancel must clear boot-active before cleanupSession",
  );
});

test("terminal boot is cancelable and closes eagerly on cleanup", () => {
  const effectsSource = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  const startersSource = readFileSync(
    new URL("./runtime/createTerminalSessionStarters.ts", import.meta.url),
    "utf8",
  );

  assert.match(effectsSource, /const bootAbort = new AbortController\(\)/);
  assert.match(effectsSource, /const bootStartOptions = \{ signal: bootAbort\.signal \}/);
  assert.match(
    effectsSource,
    /queueMicrotask\(\(\) => \{\s*\n\s*if \(disposed\) return;\s*\n\s*void boot\(\);/,
    "backend boot must defer past StrictMode's synchronous re-invoke",
  );
  for (const starter of [
    "startPluginConnection",
    "startSerial",
    "startLocal",
    "startTelnet",
    "startMosh",
    "startEt",
    "startSSH",
  ]) {
    assert.match(
      effectsSource,
      new RegExp(`sessionStarters\\.${starter}\\(term, bootStartOptions\\)`),
      `${starter} must receive the boot abort signal`,
    );
  }

  // Cleanup order: abort, then eager close + sync dispose for never-connected
  // boots (StrictMode remount), else the async capture/teardown path.
  const cleanupStart = effectsSource.indexOf("      disposed = true;");
  assert.notEqual(cleanupStart, -1);
  const cleanup = effectsSource.slice(cleanupStart);
  const abortAt = cleanup.indexOf("bootAbort.abort()");
  const neverConnectedAt = cleanup.indexOf("if (!hasConnectedRef.current)");
  assert.ok(abortAt !== -1 && neverConnectedAt !== -1);
  assert.ok(abortAt < neverConnectedAt, "cleanup must abort before the never-connected close branch");
  const neverConnectedBranch = cleanup.slice(
    neverConnectedAt,
    cleanup.indexOf("const persistCloseCapture", neverConnectedAt),
  );
  const closeAt = neverConnectedBranch.indexOf("terminalBackend.closeSession(");
  const syncDisposeAt = neverConnectedBranch.indexOf("disposeOwnedRuntime();");
  const earlyReturnAt = neverConnectedBranch.indexOf("return;");
  assert.ok(closeAt !== -1 && syncDisposeAt !== -1 && earlyReturnAt !== -1);
  assert.ok(closeAt < syncDisposeAt, "eager close must run before sync runtime dispose");
  assert.ok(
    syncDisposeAt < earlyReturnAt,
    "never-connected boots must sync-dispose before leaving cleanup",
  );
  // Owner panes close the pending backend; attach popups only dispose xterm.
  assert.match(neverConnectedBranch, /if \(!attachExistingSession\)/);
  assert.match(effectsSource, /let ownedRuntime:/);
  assert.match(
    cleanup,
    /void completeClose\(\)/,
    "connected boots still use the async capture path",
  );

  // An aborted boot must stop counting as the current attempt so the existing
  // orphan-close / attach-refusal guards cover cancellation too.
  assert.match(
    startersSource,
    /options\?\.signal\?\.aborted !== true && isBootEpochCurrent\(\)/,
  );
  for (const starter of [
    "startSSH",
    "startTelnet",
    "startMosh",
    "startEt",
    "startPluginConnection",
    "startLocal",
    "startSerial",
  ]) {
    assert.match(
      startersSource,
      new RegExp(
        `const ${starter} = async \\(term: XTerm, options\\?: TerminalSessionStartOptions\\)`,
      ),
      `${starter} must accept an abort signal`,
    );
  }
  // The plugin path holds its own in-flight request controller; the boot abort
  // has to reach it or the extension request outlives the pane.
  assert.match(startersSource, /options\?\.signal\?\.addEventListener\("abort", onBootAborted/);
  assert.match(startersSource, /options\?\.signal\?\.removeEventListener\("abort", onBootAborted\)/);
});

test("hidden host information reveals actions without permanently covering terminal content", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-label=\{t\("terminal\.toolbar\.showActions"\)\}/);
  assert.match(source, /aria-expanded=\{compactActionsOpen\}/);
  assert.match(source, /aria-controls=\{`terminal-actions-\$\{sessionId\}`\}/);
  assert.match(source, /id=\{`terminal-actions-\$\{sessionId\}`\}/);
  assert.match(source, /onClick=\{\(\) => setCompactActionsOpen/);
  assert.match(source, /right: terminalRightInset/);
  // Compact mode is a circular speed-dial: tray springs left via 0fr→1fr grid
  // (must not use .terminal-topbar — container-type collapses content width).
  assert.match(source, /flex flex-row-reverse items-center/);
  assert.match(source, /rounded-full/);
  assert.match(source, /grid-cols-\[1fr\]/);
  assert.match(source, /grid-cols-\[0fr\]/);
  assert.match(source, /ChevronsLeft/);
  assert.match(source, /h-7/);
  assert.match(source, /Do NOT use `\.terminal-topbar`|container-type:inline-size|container-type collapses/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown\)/);
  assert.match(source, /closest\('\[data-radix-popper-content-wrapper\]'\)/);
  assert.match(source, /event\.key !== "Escape"/);
  assert.match(source, /compactActionsButtonRef\.current\?\.focus\(\)/);
});

test("compact action toggle preserves terminal focus like the visible toolbar", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");
  const overlayStart = source.indexOf('ref={compactActionsRef}');
  const toggleStart = source.indexOf('ref={compactActionsButtonRef}', overlayStart);

  assert.notEqual(overlayStart, -1);
  assert.notEqual(toggleStart, -1);
  assert.ok(overlayStart < toggleStart);
  assert.match(source.slice(overlayStart, toggleStart), /onMouseDownCapture=\{handleTopOverlayMouseDownCapture\}/);
});

test("terminal theme updates force xterm renderer to repaint immediately", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  const schedulerSource = readFileSync(new URL("./terminalThemeScheduler.ts", import.meta.url), "utf8");

  assert.match(source, /applyTerminalThemeSync\(term, effectiveTheme\)/);
  assert.match(schedulerSource, /term\.options\.theme = \{/);
  assert.match(schedulerSource, /forceSyncRenderAfterResize\(term\)/);
});
