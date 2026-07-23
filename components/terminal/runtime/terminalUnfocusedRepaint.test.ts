import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  cancelScheduledUnfocusedRepaint,
  flushPendingTerminalWritesBeforeHibernate,
  flushTerminalWriteBufferBypassingTimers,
  forceTerminalRepaintBypassingAnimationFrame,
  hasPendingTerminalWrites,
  repaintTerminalAfterReveal,
  scheduleTerminalRepaintWhenUnfocused,
  shouldFlushTerminalWritesForBackgroundOutput,
  writeLocalTerminalDataInOrder,
} from "./terminalUnfocusedRepaint.ts";
import { enqueueCoalescedTerminalWrite } from "./terminalWriteCoalescer.ts";
import { enqueueTerminalWrite } from "./terminalWriteQueue.ts";

const withDocumentVisibility = (
  visibilityState: "visible" | "hidden",
  run: () => void,
  options: { hasFocus?: boolean } = {},
) => {
  const hasFocus = options.hasFocus ?? visibilityState === "visible";
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState,
      hasFocus: () => hasFocus,
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

const withDocumentVisibilityAsync = async (
  visibilityState: "visible" | "hidden",
  run: () => Promise<void>,
  options: { hasFocus?: boolean } = {},
) => {
  const hasFocus = options.hasFocus ?? visibilityState === "visible";
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState,
      hasFocus: () => hasFocus,
    },
  });
  try {
    await run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "document", original);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
};

const createBufferedFakeTerm = () => {
  const writes: string[] = [];
  const writeBuffer = {
    _bufferOffset: 0,
    _callbacks: [] as Array<(() => void) | undefined>,
    _pendingData: 0,
    _writeBuffer: [] as string[],
    flushSync() {
      const offset = Math.min(this._bufferOffset, this._writeBuffer.length);
      const chunks = this._writeBuffer.slice(offset);
      const callbacks = this._callbacks.slice(offset);
      this._bufferOffset = 0;
      this._callbacks = [];
      this._pendingData = 0;
      this._writeBuffer = [];
      for (let index = 0; index < chunks.length; index += 1) {
        writes.push(chunks[index]!);
        callbacks[index]?.();
      }
    },
  };
  const term = {
    buffer: { active: { type: "normal" } },
    _core: { _writeBuffer: writeBuffer },
    write(data: string, callback?: () => void) {
      writeBuffer._writeBuffer.push(data);
      writeBuffer._callbacks.push(callback);
      writeBuffer._pendingData += data.length;
    },
    scrollToBottom() {},
  } as unknown as XTerm;

  return { term, writes };
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

test("repaintTerminalAfterReveal repaints again after the reveal reaches a browser frame", () => {
  const scheduledFrames: Array<() => void> = [];
  let compositorReady = false;
  let visibleTail = "stale-history-line";
  const term = {
    rows: 24,
    buffer: { active: { type: "normal" } },
    _core: {
      _renderService: {
        _renderRows: () => {
          if (compositorReady) {
            visibleTail = "__END_1000__";
          }
        },
      },
    },
  } as unknown as XTerm;

  repaintTerminalAfterReveal(
    term,
    () => true,
    (callback) => {
      scheduledFrames.push(callback);
    },
  );

  assert.equal(visibleTail, "stale-history-line");
  assert.equal(scheduledFrames.length, 1);

  compositorReady = true;
  scheduledFrames.shift()?.();

  assert.equal(visibleTail, "__END_1000__");
});

test("shouldFlushTerminalWritesForBackgroundOutput flushes hidden panes and page-hidden docs", () => {
  withDocumentVisibility("visible", () => {
    assert.equal(shouldFlushTerminalWritesForBackgroundOutput(false), true);
  }, { hasFocus: true });
  withDocumentVisibility("hidden", () => {
    assert.equal(shouldFlushTerminalWritesForBackgroundOutput(true), true);
    assert.equal(shouldFlushTerminalWritesForBackgroundOutput(false), true);
  });
  // Unfocused-but-visible keeps normal batching; maybeFlush throttles instead.
  withDocumentVisibility("visible", () => {
    assert.equal(shouldFlushTerminalWritesForBackgroundOutput(true), false);
    assert.equal(shouldFlushTerminalWritesForBackgroundOutput(false), true);
  }, { hasFocus: false });
  withDocumentVisibility("visible", () => {
    assert.equal(shouldFlushTerminalWritesForBackgroundOutput(true), false);
  }, { hasFocus: true });
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

test("flushPendingTerminalWritesOnResume drains coalescer, queue, and xterm write buffer", () => {
  const source = readFileSync(
    new URL("./terminalUnfocusedRepaint.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /flushTerminalWriteCoalescer\(term\)/);
  assert.match(source, /flushTerminalWriteQueueBypassingTimers\(term\)/);
  assert.match(source, /flushTerminalWriteBufferBypassingTimers\(term\)/);
});

test("direct local writes stay ordered after pending hidden output", () => {
  const { term, writes } = createBufferedFakeTerm();
  const captured: string[] = [];

  enqueueCoalescedTerminalWrite(term, "remote-before", (data) => {
    captured.push(data);
    term.write(data);
  });
  writeLocalTerminalDataInOrder(term, "local-after", (data) => captured.push(data));
  flushTerminalWriteBufferBypassingTimers(term);

  assert.deepEqual(writes, ["remote-before", "local-after"]);
  assert.deepEqual(captured, ["remote-before", "local-after"]);
});

test("repeated local writes stay queued without forcing parser flushes", async () => {
  const { term, writes } = createBufferedFakeTerm();
  const captured: string[] = [];
  const localWrites = Array.from({ length: 100 }, (_, index) => String(index % 10));

  for (const data of localWrites) {
    writeLocalTerminalDataInOrder(term, data, (capturedData) => captured.push(capturedData));
  }

  assert.deepEqual(writes, []);
  assert.equal(hasPendingTerminalWrites(term), true);

  const flushed = await flushPendingTerminalWritesBeforeHibernate(term);

  assert.equal(flushed, true);
  assert.equal(writes.join(""), localWrites.join(""));
  assert.deepEqual(captured, localWrites);
});

test("full close-style flush drains more than the synchronous resume pass limit", async () => {
  const { term, writes } = createBufferedFakeTerm();
  const chunks = Array.from({ length: 80 }, (_, index) => String(index % 10));

  for (const chunk of chunks) {
    enqueueTerminalWrite(term, chunk.length, (done) => {
      term.write(chunk, done);
    }, { deferStart: true, yieldAfter: true });
  }

  const flushed = await flushPendingTerminalWritesBeforeHibernate(term);

  assert.equal(flushed, true);
  assert.equal(hasPendingTerminalWrites(term), false);
  assert.equal(writes.join(""), chunks.join(""));
});

test("flushPendingTerminalWritesBeforeHibernate drains pending xterm output completely", async () => {
  const { term, writes } = createBufferedFakeTerm();
  const payload = "x".repeat(300000);

  term.write(payload);

  assert.equal(writes.join("").length, 0);
  assert.equal(hasPendingTerminalWrites(term), true);

  const flushed = await flushPendingTerminalWritesBeforeHibernate(term);

  assert.equal(flushed, true);
  assert.equal(writes.join(""), payload);
  assert.equal(hasPendingTerminalWrites(term), false);
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

test("scheduleTerminalRepaintWhenUnfocused repaints while the window is visible but unfocused", async () => {
  let renderCalls = 0;
  const renderRanges: Array<[number, number]> = [];
  const renderService = {
    _renderRows(start: number, end: number) {
      renderCalls += 1;
      renderRanges.push([start, end]);
    },
  };
  const term = {
    rows: 24,
    buffer: { active: { type: "normal" } },
    _core: {
      _renderService: renderService,
    },
  } as unknown as Parameters<typeof scheduleTerminalRepaintWhenUnfocused>[0];

  await withDocumentVisibilityAsync("visible", async () => {
    scheduleTerminalRepaintWhenUnfocused(term);
    scheduleTerminalRepaintWhenUnfocused(term);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }, { hasFocus: false });

  assert.equal(renderCalls, 1);
  assert.deepEqual(renderRanges, [[0, 23]]);
  cancelScheduledUnfocusedRepaint(term);
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

test("writeSessionData bypasses animation-frame coalescing for background output", () => {
  const source = readFileSync(
    new URL("./terminalSessionAttachment.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /shouldFlushTerminalWritesForBackgroundOutput\(isPaneVisible\)/);
  assert.match(source, /flushTerminalWriteCoalescer\(term, writeBackgroundOutputData\)/);
  assert.match(
    source,
    /enqueueCoalescedTerminalWrite\(\s*term,\s*data,\s*writeBackgroundOutputData,\s*ingressBytes,/,
  );
  assert.match(source, /flushTerminalWriteQueueBypassingTimers\(term\)/);
  assert.match(source, /const deferFlowAck = !writeOptions\.flushXtermWriteBuffer/);
});

test("writeSessionDataImmediate schedules unfocused repaint for visible panes on every path", () => {
  const source = readFileSync(
    new URL("./terminalSessionAttachment.ts", import.meta.url),
    "utf8",
  );
  // Unfocused-but-visible windows have no rAF render loop, so the debounced
  // sync repaint remains required. Hidden tabs use the batched drain instead.
  assert.match(source, /if \(isTerminalPaneVisible\(ctx\)\) \{[^}]*scheduleTerminalRepaintWhenUnfocused\(term\)/);
});

test("app resume recovery flushes pending writes before WebGL recovery", () => {
  const source = readFileSync(
    new URL("../useTerminalEffects.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const recoverTerminalOnAppResume = \(\) => \{/);
  assert.match(source, /flushPendingTerminalWritesOnResume\(term\)/);
  assert.match(source, /recoverWebglRendererOnAppResume\(\)/);
});
