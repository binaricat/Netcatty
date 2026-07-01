import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  forceTerminalRepaintBypassingAnimationFrame,
} from "./terminalUnfocusedRepaint.ts";

test("isTerminalWindowUnfocusedButVisible checks visible page without focus", () => {
  const source = readFileSync(
    new URL("./terminalUnfocusedRepaint.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /document\.visibilityState === "visible"/);
  assert.match(source, /!document\.hasFocus\(\)/);
});

test("forceTerminalRepaintBypassingAnimationFrame refreshes alternate-screen viewports", () => {
  let refreshed: [number, number] | null = null;
  let renderRowsCalled = false;
  const term = {
    rows: 24,
    buffer: { active: { type: "alternate" } },
    refresh: (start: number, end: number) => {
      refreshed = [start, end];
    },
    _core: {
      _renderService: {
        _renderRows: () => {
          renderRowsCalled = true;
        },
      },
    },
  };

  forceTerminalRepaintBypassingAnimationFrame(term as never);
  assert.deepEqual(refreshed, [0, 23]);
  assert.equal(renderRowsCalled, true);
});

test("maybeFlushTerminalWriteCoalescerWhenUnfocused throttles coalescer flushes", () => {
  const source = readFileSync(
    new URL("./terminalUnfocusedRepaint.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /flushTerminalWriteCoalescer\(term\)/);
  assert.match(source, /unfocusedFlushTimers/);
});

test("scheduleTerminalRepaintWhenUnfocused debounces repaint scheduling", () => {
  const source = readFileSync(
    new URL("./terminalUnfocusedRepaint.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(unfocusedRepaintTimers\.has\(term\)\) return;/);
  assert.match(source, /UNFOCUSED_REPAINT_DEBOUNCE_MS/);
});

test("writeSessionData schedules a throttled coalescer flush when unfocused", () => {
  const source = readFileSync(
    new URL("./terminalSessionAttachment.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /maybeFlushTerminalWriteCoalescerWhenUnfocused\(\s*term,\s*ctx\.isVisibleRef\?\.current !== false,\s*\)/,
  );
});

test("writeSessionDataImmediate schedules unfocused repaint only for visible panes", () => {
  const source = readFileSync(
    new URL("./terminalSessionAttachment.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(ctx\.isVisibleRef\?\.current !== false\) \{\s*scheduleTerminalRepaintWhenUnfocused\(term\)/);
});

test("window focus cancels pending unfocused repaint before layout recovery", () => {
  const source = readFileSync(
    new URL("../useTerminalEffects.ts", import.meta.url),
    "utf8",
  );
  const handlerIndex = source.indexOf("const handleWindowFocus = () => {");
  assert.notEqual(handlerIndex, -1);
  const handlerEnd = source.indexOf("document.addEventListener('visibilitychange'", handlerIndex);
  assert.notEqual(handlerEnd, -1);
  const handlerSource = source.slice(handlerIndex, handlerEnd);
  const cancelIndex = handlerSource.indexOf("cancelScheduledUnfocusedRepaint(term)");
  const recoveryIndex = handlerSource.indexOf("recoverWebglRendererOnAppResume()");
  assert.notEqual(cancelIndex, -1);
  assert.ok(cancelIndex < recoveryIndex);
});
