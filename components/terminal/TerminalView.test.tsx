import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  formatTerminalTitleConnectionAddress,
  getLineTimestampToggleHostUpdate,
  resolveTerminalRightInset,
  resolveTerminalTopOffsets,
  shouldBlockTerminalReconnectForTarget,
  shouldReconnectTerminalOnEnterKey,
  shouldShowSelectionAIOverlay,
  shouldShowLineTimestampToolbarToggle,
} from "./TerminalView.tsx";

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
      isSearchOpen: false,
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
    isSearchOpen: false,
    isComposeBarOpen: false,
    needsAuth: false,
    needsHostKeyVerification: false,
    hasBlockingOverlay: false,
  };

  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, status: "connected" }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, key: "a" }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, hasRetryHandler: false }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, isSearchOpen: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, isComposeBarOpen: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, needsAuth: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, needsHostKeyVerification: true }), false);
  assert.equal(shouldReconnectTerminalOnEnterKey({ ...base, hasBlockingOverlay: true }), false);
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

test("popup terminals disable line timestamp controls", () => {
  const source = readFileSync(new URL("../TerminalPopupPage.tsx", import.meta.url), "utf8");

  assert.match(source, /lineTimestampsAvailable=\{false\}/);
});

test("terminal body keeps a slight inset from the surrounding chrome", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");

  assert.match(source, /const terminalBodyInset = 4/);
  assert.match(source, /left: activeLineTimestampGutterWidth \+ terminalBodyInset/);
  assert.match(source, /right: terminalRightInset/);
  assert.match(source, /bottom: terminalBodyInset/);
  assert.match(source, /left=\{terminalBodyInset\}/);
  assert.match(source, /bottom=\{terminalBodyInset\}/);
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

test("hidden host information reserves a side gutter for its action button", () => {
  assert.equal(resolveTerminalRightInset({ showHostInfoBar: false, isSearchOpen: false }), 32);
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
  const actionsStart = source.indexOf('className="flex items-center gap-0.5 flex-shrink-0"');
  const controls = source.indexOf("{renderControls({ showClose: inWorkspace })}");
  const compactDragHandle = source.indexOf('data-terminal-detach-drag-handle="true"');

  assert.notEqual(hostInfoStart, -1);
  assert.notEqual(hostInfoEnd, -1);
  assert.notEqual(copyAction, -1);
  assert.notEqual(timestampAction, -1);
  assert.notEqual(systemAction, -1);
  assert.notEqual(actionsStart, -1);
  assert.notEqual(controls, -1);
  assert.notEqual(compactDragHandle, -1);
  assert.ok(hostInfoStart < hostInfoEnd);
  assert.ok(hostInfoEnd < copyAction);
  assert.ok(copyAction < timestampAction);
  assert.ok(timestampAction < systemAction);
  assert.ok(systemAction < actionsStart);
  assert.ok(actionsStart < controls);
  assert.ok(compactDragHandle < hostInfoStart);
});

test("hidden host information reveals actions without permanently covering terminal content", () => {
  const source = readFileSync(new URL("./TerminalView.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-label=\{t\("terminal\.toolbar\.showActions"\)\}/);
  assert.match(source, /aria-expanded=\{compactActionsOpen\}/);
  assert.match(source, /aria-controls=\{`terminal-actions-\$\{sessionId\}`\}/);
  assert.match(source, /id=\{`terminal-actions-\$\{sessionId\}`\}/);
  assert.match(source, /onClick=\{\(\) => setCompactActionsOpen/);
  assert.match(source, /right: terminalRightInset/);
  assert.match(source, /\? "visible opacity-100 translate-y-0 pointer-events-auto"/);
  assert.match(source, /: "invisible opacity-0"/);
  assert.match(source, /aria-hidden=\{!showHostInfoBar && !isSearchOpen && !compactActionsOpen \? true : undefined\}/);
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
