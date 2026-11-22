import test from "node:test";
import assert from "node:assert/strict";
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
  subscribeTerminalAlternateScreenChanges,
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

type AlternateScreenWatchTerm = {
  buffer: { active: { type: string } };
  onRender: (callback: () => void) => { dispose: () => void };
};

function createAlternateScreenWatchTerm(type: "normal" | "alternate") {
  const renders: Array<() => void> = [];
  let disposed = 0;
  const term: AlternateScreenWatchTerm = {
    buffer: { active: { type } },
    onRender(callback) {
      renders.push(callback);
      return { dispose: () => { disposed += 1; } };
    },
  };
  return {
    term,
    renders,
    disposeCount: () => disposed,
  };
}

test("alternate screen enter and leave drive the timestamp gutter", (t) => {
  const watched = createAlternateScreenWatchTerm("normal");
  const seen: boolean[] = [];
  const stop = subscribeTerminalAlternateScreenChanges(
    () => watched.term,
    (active) => { seen.push(active); },
  );
  t.after(stop);

  assert.deepEqual(seen, [false]);
  watched.term.buffer.active.type = "alternate";
  watched.renders[0]();
  watched.renders[0]();
  watched.term.buffer.active.type = "normal";
  watched.renders[0]();
  assert.deepEqual(seen, [false, true, false]);

  stop();
  assert.equal(watched.disposeCount(), 1);
  watched.term.buffer.active.type = "alternate";
  watched.renders[0]();
  assert.deepEqual(seen, [false, true, false]);
});

test("alternate screen watch attaches after the terminal runtime exists", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watched = createAlternateScreenWatchTerm("alternate");
  let current: AlternateScreenWatchTerm | null = null;
  const seen: boolean[] = [];
  const stop = subscribeTerminalAlternateScreenChanges(
    () => current,
    (active) => { seen.push(active); },
  );
  t.after(() => {
    stop();
    t.mock.timers.reset();
  });

  assert.deepEqual(seen, [false]);
  current = watched.term;
  t.mock.timers.tick(50);
  assert.deepEqual(seen, [false, true]);
  assert.equal(watched.renders.length, 1);
  t.mock.timers.tick(500);
  assert.equal(watched.renders.length, 1);
  assert.deepEqual(seen, [false, true]);
});

test("alternate screen watch follows a replacement terminal runtime", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = createAlternateScreenWatchTerm("alternate");
  const second = createAlternateScreenWatchTerm("normal");
  let current: AlternateScreenWatchTerm = first.term;
  const seen: boolean[] = [];
  const stop = subscribeTerminalAlternateScreenChanges(
    () => current,
    (active) => { seen.push(active); },
  );
  t.after(() => {
    stop();
    t.mock.timers.reset();
  });

  assert.deepEqual(seen, [true]);
  current = second.term;
  t.mock.timers.tick(250);
  assert.deepEqual(seen, [true, false]);
  assert.equal(first.disposeCount(), 1);
  assert.equal(second.renders.length, 1);
  second.term.buffer.active.type = "alternate";
  second.renders[0]();
  assert.deepEqual(seen, [true, false, true]);
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
    needsAuth: false,
    needsHostKeyVerification: false,
    hasBlockingOverlay: false,
  };

  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, status: "connected" }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, key: "a" }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, hasRetryHandler: false }), false);
  // Open search and an open compose bar must not globally suppress Enter
  // reconnect / the hint (#2546 / #3767).
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base }), true);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, needsAuth: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, needsHostKeyVerification: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, hasBlockingOverlay: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, isReconnectActive: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, altKey: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, shiftKey: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, isComposing: true }), false);
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
