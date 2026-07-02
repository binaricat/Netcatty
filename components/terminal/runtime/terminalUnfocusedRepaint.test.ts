import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  flushTerminalWriteBufferBypassingTimers,
  forceTerminalRepaintBypassingAnimationFrame,
  shouldFlushTerminalWritesForHiddenPage,
} from "./terminalUnfocusedRepaint.ts";

const withDocumentVisibility = (visibilityState: "visible" | "hidden", run: () => void) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState,
      hasFocus: () => visibilityState === "visible",
    },
  });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "document", original);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
};

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

test("shouldFlushTerminalWritesForHiddenPage only flushes visible panes on hidden pages", () => {
  withDocumentVisibility("hidden", () => {
    assert.equal(shouldFlushTerminalWritesForHiddenPage(true), true);
    assert.equal(shouldFlushTerminalWritesForHiddenPage(false), false);
  });
  withDocumentVisibility("visible", () => {
    assert.equal(shouldFlushTerminalWritesForHiddenPage(true), false);
  });
});

test("flushTerminalWriteBufferBypassingTimers drains xterm's internal write buffer", () => {
  let flushed = false;
  const writeBuffer = {
    flushSync() {
      flushed = this === writeBuffer;
    },
  };
  const term = {
    _core: {
      _writeBuffer: writeBuffer,
    },
  };

  flushTerminalWriteBufferBypassingTimers(term as never);

  assert.equal(flushed, true);
});

test("flushTerminalWriteBufferBypassingTimers skips already parsed xterm chunks", () => {
  const processed: string[] = [];
  let oldCallbackCalled = false;
  let pendingCallbackCalled = false;
  const writeBuffer = {
    _bufferOffset: 1,
    _callbacks: [
      () => { oldCallbackCalled = true; },
      () => { pendingCallbackCalled = true; },
    ] as Array<() => void>,
    _pendingData: "pending".length,
    _writeBuffer: ["already-parsed", "pending"],
    flushSync() {
      while (this._writeBuffer.length > 0) {
        processed.push(this._writeBuffer.shift()!);
        this._callbacks.shift()?.();
      }
      this._pendingData = 0;
      this._bufferOffset = 0;
    },
  };
  const term = {
    _core: {
      _writeBuffer: writeBuffer,
    },
  };

  flushTerminalWriteBufferBypassingTimers(term as never);

  assert.deepEqual(processed, ["pending"]);
  assert.equal(oldCallbackCalled, false);
  assert.equal(pendingCallbackCalled, true);
  assert.equal(writeBuffer._pendingData, 0);
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
    /maybeFlushTerminalWriteCoalescerWhenUnfocused\(\s*term,\s*isPaneVisible,\s*\)/,
  );
});

test("writeSessionData bypasses animation-frame coalescing on hidden pages", () => {
  const source = readFileSync(
    new URL("./terminalSessionAttachment.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /shouldFlushTerminalWritesForHiddenPage\(isPaneVisible\)/);
  assert.match(source, /flushTerminalWriteCoalescer\(term, writeHiddenPageData\)/);
  assert.match(source, /enqueueCoalescedTerminalWrite\(term, data, writeHiddenPageData, ingressBytes\)/);
  assert.match(source, /flushTerminalWriteQueueBypassingTimers\(term\)/);
  assert.match(source, /const deferFlowAck = !writeOptions\.flushXtermWriteBuffer/);
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
