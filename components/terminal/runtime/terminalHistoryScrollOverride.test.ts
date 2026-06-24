import assert from "node:assert/strict";
import test from "node:test";

import {
  getHistoryPreviewLines,
  forcedHistoryScrollLinesForWheel,
  forcedHistoryScrollPageToLines,
  forcedHistoryScrollPagesForKey,
  forcedHistoryScrollWheelListenerOptions,
  nextHistoryPreviewTop,
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
