import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getLineTimestampToggleHostUpdate,
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

  assert.match(source, /term\.options\.theme = \{/);
  assert.match(source, /forceSyncRenderAfterResize\(term\)/);
});
