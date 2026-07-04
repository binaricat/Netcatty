import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  formatTerminalTitleConnectionAddress,
  getLineTimestampToggleHostUpdate,
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
  assert.match(source, /right: terminalBodyInset/);
  assert.match(source, /bottom: terminalBodyInset/);
  assert.match(source, /left=\{terminalBodyInset\}/);
  assert.match(source, /bottom=\{terminalBodyInset\}/);
});

test("terminal theme updates force xterm renderer to repaint immediately", () => {
  const source = readFileSync(new URL("./useTerminalEffects.ts", import.meta.url), "utf8");
  const schedulerSource = readFileSync(new URL("./terminalThemeScheduler.ts", import.meta.url), "utf8");

  assert.match(source, /applyTerminalThemeSync\(term, effectiveTheme\)/);
  assert.match(schedulerSource, /term\.options\.theme = \{/);
  assert.match(schedulerSource, /forceSyncRenderAfterResize\(term\)/);
});
