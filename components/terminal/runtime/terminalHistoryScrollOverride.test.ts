import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_PREVIEW_OVERLAY_ATTR,
  HISTORY_PREVIEW_WRAP_ATTR,
  encodeHistoryPreviewWrapFlags,
  getHistoryPreviewLines,
  getHistoryPreviewRows,
  getHistoryPreviewSelectionText,
  forcedHistoryScrollLinesForWheel,
  forcedHistoryScrollPageToLines,
  forcedHistoryScrollPagesForKey,
  forcedHistoryScrollWheelListenerOptions,
  isHistoryPreviewContextMenuTarget,
  isHistoryPreviewDismissClick,
  joinHistoryPreviewSelectionText,
  nextHistoryPreviewTop,
  shouldHideHistoryPreviewOnMouseDown,
  shouldKeepHistoryPreviewOnKey,
} from "./terminalHistoryScrollOverride.ts";

const wheel = (
  over: Partial<Parameters<typeof forcedHistoryScrollLinesForWheel>[0]> = {},
) => ({
  altKey: false,
  ctrlKey: false,
  deltaMode: 0,
  deltaY: -100,
  metaKey: false,
  shiftKey: true,
  ...over,
});

const key = (
  over: Partial<Parameters<typeof forcedHistoryScrollPagesForKey>[0]> = {},
) => ({
  altKey: false,
  ctrlKey: false,
  key: "PageUp",
  metaKey: false,
  shiftKey: true,
  type: "keydown",
  ...over,
});

test("Shift+wheel maps to explicit history scrolling before mouse tracking can consume it", () => {
  assert.equal(forcedHistoryScrollLinesForWheel(wheel({ deltaY: -100 })), -3);
  assert.equal(forcedHistoryScrollLinesForWheel(wheel({ deltaY: 100 })), 3);
});

test("forced history wheel listener can run before xterm mouse tracking and cancel scrolling", () => {
  assert.equal(forcedHistoryScrollWheelListenerOptions.capture, true);
  assert.equal(forcedHistoryScrollWheelListenerOptions.passive, false);
});

test("Shift+PageUp and Shift+PageDown map to one-page history scrolling", () => {
  assert.equal(forcedHistoryScrollPagesForKey(key({ key: "PageUp" })), -1);
  assert.equal(forcedHistoryScrollPagesForKey(key({ key: "PageDown" })), 1);
});

test("history scroll override stays out of unmodified TUI mouse and paging input", () => {
  assert.equal(forcedHistoryScrollLinesForWheel(wheel({ shiftKey: false })), null);
  assert.equal(forcedHistoryScrollPagesForKey(key({ shiftKey: false })), null);
});

test("history scroll override does not steal existing modified shortcuts", () => {
  assert.equal(forcedHistoryScrollLinesForWheel(wheel({ ctrlKey: true })), null);
  assert.equal(forcedHistoryScrollLinesForWheel(wheel({ metaKey: true })), null);
  assert.equal(forcedHistoryScrollLinesForWheel(wheel({ altKey: true })), null);

  assert.equal(forcedHistoryScrollPagesForKey(key({ ctrlKey: true })), null);
  assert.equal(forcedHistoryScrollPagesForKey(key({ metaKey: true })), null);
  assert.equal(forcedHistoryScrollPagesForKey(key({ altKey: true })), null);
});

test("PageUp/PageDown history preview uses xterm's page size", () => {
  assert.equal(forcedHistoryScrollPageToLines(-1, 24), -23);
  assert.equal(forcedHistoryScrollPageToLines(1, 24), 23);
  assert.equal(forcedHistoryScrollPageToLines(-1, 1), -1);
});

test("alternate-screen history preview reads normal-buffer history", () => {
  const normalLines = ["old 1", "old 2", "prompt before codex", "bottom"];
  const normalBuffer = {
    baseY: 2,
    length: normalLines.length,
    type: "normal" as const,
    viewportY: 2,
    getLine(y: number) {
      const text = normalLines[y];
      if (text === undefined) return undefined;
      return {
        translateToString() {
          return text;
        },
      };
    },
  };
  const alternateBuffer = {
    baseY: 0,
    length: 2,
    type: "alternate" as const,
    viewportY: 0,
    getLine(y: number) {
      return {
        translateToString() {
          return `codex frame ${y}`;
        },
      };
    },
  };

  const top = nextHistoryPreviewTop({
    buffer: normalBuffer,
    currentTop: null,
    lines: -2,
  });

  assert.equal(top, 0);
  assert.deepEqual(getHistoryPreviewLines({ buffer: normalBuffer, rows: 3, top }), [
    "old 1",
    "old 2",
    "prompt before codex",
  ]);
  assert.notDeepEqual(getHistoryPreviewLines({ buffer: normalBuffer, rows: 2, top }), [
    alternateBuffer.getLine(0)?.translateToString(),
    alternateBuffer.getLine(1)?.translateToString(),
  ]);
});

test("history preview stays up for pointer selection and copy chords", () => {
  const overlay = { contains: (node: unknown) => node === "inside" };

  assert.equal(shouldHideHistoryPreviewOnMouseDown("inside", overlay), false);
  assert.equal(shouldHideHistoryPreviewOnMouseDown("outside", overlay), true);
  assert.equal(shouldHideHistoryPreviewOnMouseDown("inside", null), false);

  assert.equal(shouldKeepHistoryPreviewOnKey(key({ key: "Shift" })), true);
  assert.equal(shouldKeepHistoryPreviewOnKey(key({ key: "Meta" })), true);
  assert.equal(
    shouldKeepHistoryPreviewOnKey(key({ key: "c", metaKey: true, shiftKey: false }), {
      hasPreviewSelection: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepHistoryPreviewOnKey(key({ key: "c", ctrlKey: true, shiftKey: false }), {
      action: "copy",
      hasPreviewSelection: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepHistoryPreviewOnKey(key({ key: "c", ctrlKey: true, shiftKey: false }), {
      action: "copy",
    }),
    false,
  );
  assert.equal(
    shouldKeepHistoryPreviewOnKey(key({ key: "a", metaKey: true, shiftKey: false }), {
      action: "selectAll",
      overlayVisible: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepHistoryPreviewOnKey(key({ key: "a", metaKey: true, shiftKey: false }), {
      overlayVisible: true,
    }),
    false,
  );
  assert.equal(
    shouldKeepHistoryPreviewOnKey(key({ key: "j", shiftKey: false })),
    false,
  );
});

test("history preview copy uses only overlay-owned DOM selection", () => {
  const overlay = {
    contains(node: unknown) {
      return node === "preview";
    },
  };

  assert.equal(
    getHistoryPreviewSelectionText(overlay, {
      rangeCount: 1,
      anchorNode: "preview",
      focusNode: "preview",
      toString: () => "old prompt output",
    }),
    "old prompt output",
  );
  assert.equal(
    getHistoryPreviewSelectionText(overlay, {
      rangeCount: 1,
      anchorNode: "xterm",
      focusNode: "xterm",
      toString: () => "vim buffer",
    }),
    "",
  );
  assert.equal(
    getHistoryPreviewSelectionText(overlay, {
      rangeCount: 1,
      isCollapsed: true,
      anchorNode: "preview",
      focusNode: "preview",
      toString: () => "old prompt output",
    }),
    "",
  );
});

test("history preview click dismisses and a drag keeps the overlay", () => {
  assert.equal(
    isHistoryPreviewDismissClick(
      { clientX: 10, clientY: 10 },
      { button: 0, clientX: 11, clientY: 12 },
    ),
    true,
  );
  assert.equal(
    isHistoryPreviewDismissClick(
      { clientX: 10, clientY: 10 },
      { button: 0, clientX: 40, clientY: 30 },
    ),
    false,
  );
  assert.equal(
    isHistoryPreviewDismissClick(
      { clientX: 10, clientY: 10 },
      { button: 2, clientX: 10, clientY: 10 },
    ),
    false,
  );
});

test("select-all overlay ranges still join soft-wrapped preview rows", () => {
  const text = "ssh host long-command-name\n --flag";
  const overlay = {
    firstChild: "text",
    textContent: text,
    contains() {
      return true;
    },
    getAttribute(name: string) {
      return name === HISTORY_PREVIEW_WRAP_ATTR ? "01" : null;
    },
  };
  const copied = getHistoryPreviewSelectionText(overlay, {
    rangeCount: 1,
    anchorNode: overlay,
    focusNode: overlay,
    anchorOffset: 0,
    focusOffset: 1,
    toString: () => text,
  });
  assert.equal(copied.includes("\n"), false);
  assert.match(copied, /long-command-name\s*--flag/);
});

test("history preview copy keeps a selected hard line break", () => {
  assert.equal(
    joinHistoryPreviewSelectionText({
      text: "abc\ndef",
      startOffset: 0,
      endOffset: 4,
      wrapFlags: [false, false],
    }),
    "abc\n",
  );
  assert.equal(
    joinHistoryPreviewSelectionText({
      text: "abc\ndef",
      startOffset: 3,
      endOffset: 4,
      wrapFlags: [false, false],
    }),
    "\n",
  );
  assert.equal(
    joinHistoryPreviewSelectionText({
      text: "abc\ndef",
      startOffset: 0,
      endOffset: 4,
      wrapFlags: [false, true],
    }),
    "abc",
  );
});

test("history preview copy joins soft-wrapped buffer rows", () => {
  const text = "ssh user@host tail -f /var/log/very-long-name.log\n | grep error";
  const joined = joinHistoryPreviewSelectionText({
    text,
    startOffset: 0,
    endOffset: text.length,
    wrapFlags: [false, true],
  });
  assert.equal(joined.includes("\n"), false);
  assert.match(joined, /very-long-name\.log\s*\| grep error/);

  const rows = getHistoryPreviewRows({
    buffer: {
      baseY: 1,
      length: 2,
      type: "normal",
      viewportY: 1,
      getLine(y: number) {
        if (y === 0) {
          return {
            isWrapped: false,
            translateToString() {
              return "ssh user@host tail -f /var/log/very-long-name.log";
            },
          };
        }
        return {
          isWrapped: true,
          translateToString() {
            return " | grep error";
          },
        };
      },
    },
    rows: 2,
    top: 0,
  });
  assert.equal(encodeHistoryPreviewWrapFlags(rows), "01");
});

test("history preview right-click is recognized as an app-menu target", () => {
  assert.equal(
    isHistoryPreviewContextMenuTarget({
      closest: (selector: string) => selector === `[${HISTORY_PREVIEW_OVERLAY_ATTR}]` ? {} as Element : null,
    }),
    true,
  );
  assert.equal(
    isHistoryPreviewContextMenuTarget({
      closest: () => null,
    }),
    false,
  );
});
