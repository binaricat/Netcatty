import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  FLOW_HIGH_WATER_MARK,
  FLOW_CHAR_COUNT_ACK_SIZE,
  FLOW_LOW_WATER_MARK,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
  XTERM_WRITE_CALLBACK_BATCH_BYTES,
} from "./terminalFlowConstants.ts";
import {
  attachSessionToTerminal,
  getFlowController,
  notePendingOutputScrollIfEnabled,
  resolveAttachSnapshot,
  tryAttachSessionToTerminal,
  writeSessionData,
} from "./terminalSessionAttachment.ts";
import { getVisibleTerminalLineTimestampRows } from "./terminalLineTimestamps.ts";
import { noteTerminalOutputPressureData } from "./terminalOutputPressure.ts";

import {
  clearTerminalSessionFlowAck,
  flushTerminalSessionFlowAck,
} from "./terminalFlowAckBuffer.ts";
import {
  flushTerminalWriteCoalescer,
  resetTerminalWriteCoalescer,
} from "./terminalWriteCoalescer.ts";
import {
  cancelScheduledUnfocusedRepaint,
  flushPendingTerminalWritesBeforeHibernate,
  flushPendingTerminalWritesOnResume,
} from "./terminalUnfocusedRepaint.ts";
import {
  clearDeferredTerminalWriteAck,
  getDeferredTerminalWriteAckBytes,
} from "./terminalWriteAckDeferral.ts";
import { flushTerminalWriteQueueBypassingTimers } from "./terminalWriteQueue.ts";
import { prioritizeTerminalInput } from "./terminalOutputPipeline";
import {
  createPromptLineBreakState,
  markTerminalCommandCompletionPending,
} from "./promptLineBreak";

test("resolveAttachSnapshot keeps an authoritative empty final snapshot", () => {
  assert.equal(resolveAttachSnapshot("", "stale fallback"), "");
  assert.equal(resolveAttachSnapshot("fresh", "stale fallback"), "fresh");
  assert.equal(resolveAttachSnapshot(undefined, "fallback"), "fallback");
});

const createFakeTerm = (activeType = "normal") => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  let cursorLine = 0;
  const active: {
    type: string;
    viewportY: number;
    cursorX: number;
    baseY: number;
    cursorY: number;
    length: number;
    getLine: () => { isWrapped: boolean };
  } = {
    type: activeType,
    viewportY: 0,
    cursorX: 0,
    baseY: 0,
    get cursorY() {
      return cursorLine;
    },
    set cursorY(value: number) {
      cursorLine = Math.max(0, value);
    },
    get length() {
      return cursorLine + 1;
    },
    getLine: () => ({ isWrapped: false }),
  };
  const term = {
    rows: 24,
    cols: 80,
    options: { scrollback: 1000 },
    buffer: {
      active,
    },
    write(data: string, callback?: () => void) {
      writes.push(data);
      if (data.includes("\x1b[?1049h") || data.includes("\x1b[?47h") || data.includes("\x1b[?1047h")) {
        active.type = "alternate";
      }
      if (data.includes("\x1b[?1049l") || data.includes("\x1b[?47l") || data.includes("\x1b[?1047l")) {
        active.type = "normal";
      }
      for (const char of data) {
        if (char === "\n") {
          cursorLine += 1;
        }
      }
      callback?.();
    },
    registerMarker(offset: number) {
      const line = cursorLine + offset;
      markerLines.push(line);
      const marker = {
        line,
        isDisposed: false,
        dispose() {
          marker.isDisposed = true;
          disposedMarkerLines.push(line);
        },
      };
      return marker;
    },
    scrollToBottom() {},
  } as unknown as XTerm;

  return { term, writes, markerLines, disposedMarkerLines };
};

const createContext = (showLineTimestamps: boolean, host: Record<string, unknown> = {}) => {
  // Production gates markers on host.showLineTimestamps; keep the first arg as
  // the host default unless the test overrides host explicitly.
  const liveHost = { showLineTimestamps, ...host };
  return {
    host: liveHost,
    // Mirror Terminal.tsx: write path reads hostRef.current for live toggles.
    hostRef: { current: liveHost },
    terminalSettingsRef: {
      current: {
        showLineTimestamps,
        scrollOnOutput: false,
        forcePromptNewLine: false,
      },
    },
    terminalSettings: {
      showLineTimestamps,
      scrollOnOutput: false,
      forcePromptNewLine: false,
    },
    terminalBackend: {},
    sessionRef: { current: "session-1" },
    promptLineBreakStateRef: { current: undefined },
  };
};

test("terminal output publishes one completion for each pending command at the next prompt", () => {
  const { term } = createFakeTerm();
  Object.assign(term.buffer.active, {
    cursorX: 2,
    cursorY: 0,
    baseY: 0,
    getLine(line: number) {
      if (line !== 0) return undefined;
      return {
        isWrapped: false,
        translateToString() { return "$ "; },
      };
    },
  });
  const state = createPromptLineBreakState();
  const stateRef = { current: state };
  markTerminalCommandCompletionPending(stateRef);
  markTerminalCommandCompletionPending(stateRef);
  let completions = 0;
  const ctx = {
    ...createContext(false),
    promptLineBreakStateRef: stateRef,
    onCommandCompleted() { completions += 1; },
  };

  writeSessionData(ctx as never, term, "$ ");

  assert.equal(completions, 2);
  assert.equal(state.pendingCommandCompletions, 0);
});

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

type WriteScheduleQueue = {
  frames: Array<FrameRequestCallback>;
  microtasks: Array<() => void>;
  scheduledCount: () => number;
  flushScheduled: () => void;
};

const withAnimationFrameQueue = (run: (schedule: WriteScheduleQueue) => void) => {
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;
  const frames: Array<FrameRequestCallback> = [];
  const microtasks: Array<() => void> = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => {},
  });
  globalThis.queueMicrotask = (callback: () => void) => {
    microtasks.push(callback);
  };
  const flushScheduled = () => {
    while (microtasks.length > 0 || frames.length > 0) {
      const pendingMicrotasks = microtasks.splice(0);
      for (const task of pendingMicrotasks) {
        task();
      }
      const pendingFrames = frames.splice(0);
      for (const frame of pendingFrames) {
        frame(0);
      }
    }
  };
  try {
    run({
      frames,
      microtasks,
      scheduledCount: () => frames.length + microtasks.length,
      flushScheduled,
    });
  } finally {
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRequest) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRequest);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
};

test("notePendingOutputScrollIfEnabled leaves hidden output unmarked when scroll-on-output is disabled", () => {
  const pendingOutputScrollRef = { current: false };

  notePendingOutputScrollIfEnabled({
    terminalSettingsRef: { current: { scrollOnOutput: false } },
    pendingOutputScrollRef,
  } as never);

  assert.equal(pendingOutputScrollRef.current, false);
});

test("notePendingOutputScrollIfEnabled marks hidden output when scroll-on-output is enabled", () => {
  const pendingOutputScrollRef = { current: false };

  notePendingOutputScrollIfEnabled({
    terminalSettingsRef: { current: { scrollOnOutput: true } },
    pendingOutputScrollRef,
  } as never);

  assert.equal(pendingOutputScrollRef.current, true);
});

test("writeSessionData clears renderer backlog while deferring IPC ack", () => {
  const term = {
    buffer: { active: { type: "normal" } },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const ctx = createContext(false);
  const ingressPerWrite = 100;
  const writeCount = Math.floor((XTERM_WRITE_CALLBACK_BATCH_BYTES - 1) / ingressPerWrite);

  for (let index = 0; index < writeCount; index += 1) {
    writeSessionData(ctx as never, term, "x".repeat(ingressPerWrite));
  }
  flushTerminalWriteCoalescer(term);
  for (let guard = 0; guard < 1000 && flushTerminalWriteQueueBypassingTimers(term); guard += 1) {
    // A busy full-suite run can cross the queue's turn budget and defer the
    // next synchronous fake write. Drain those intentional timer yields before
    // asserting the completed-backlog state.
  }

  const flow = getFlowController(ctx as never, term);
  assert.equal(flow.pendingBytes(), 0);
  assert.ok(getDeferredTerminalWriteAckBytes(term) > 0);
  clearDeferredTerminalWriteAck(term);
});

test("writeSessionData keeps hidden-page xterm parsing asynchronous", () => {
  clearTerminalSessionFlowAck("session-1");
  const payload = "x".repeat(FLOW_CHAR_COUNT_ACK_SIZE + 1);
  const writes: string[] = [];
  const pendingCallbacks: Array<() => void> = [];
  const writeBuffer = {
    flushSync() {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()?.();
      }
    },
  };
  const term = {
    buffer: { active: { type: "normal" } },
    _core: { _writeBuffer: writeBuffer },
    write(data: string, callback?: () => void) {
      writes.push(data);
      if (callback) pendingCallbacks.push(callback);
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  withDocumentVisibility("hidden", () => {
    writeSessionData(ctx as never, term, payload);
  });
  assert.equal(pendingCallbacks.length, 1);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), payload.length);
  pendingCallbacks.shift()?.();
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), payload);
  // Hidden-page output starts promptly, but xterm owns async parser completion.
  assert.deepEqual(writes.map((write) => write.length), [payload.length]);
  assert.equal(pendingCallbacks.length, 0);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData batches while unfocused-but-visible then drains on idle flush", async () => {
  clearTerminalSessionFlowAck("session-1");
  const payload = "x".repeat(FLOW_CHAR_COUNT_ACK_SIZE + 1);
  const writes: string[] = [];
  const pendingCallbacks: Array<() => void> = [];
  const writeBuffer = {
    flushSync() {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()?.();
      }
    },
  };
  const term = {
    buffer: { active: { type: "normal" } },
    _core: { _writeBuffer: writeBuffer },
    write(data: string, callback?: () => void) {
      writes.push(data);
      if (callback) pendingCallbacks.push(callback);
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  withDocumentVisibility("visible", () => {
    writeSessionData(ctx as never, term, payload);
  }, { hasFocus: false });

  // Unfocused-but-visible no longer force-flushes every chunk (preserves
  // batching / alt-screen frames). Microtask/idle/unfocused timers drain it.
  await new Promise((resolve) => { setTimeout(resolve, 90); });
  flushTerminalWriteCoalescer(term);
  flushTerminalWriteQueueBypassingTimers(term);
  while (pendingCallbacks.length > 0) {
    pendingCallbacks.shift()?.();
  }
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), payload);
  assert.equal(pendingCallbacks.length, 0);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  cancelScheduledUnfocusedRepaint(term);
  resetTerminalWriteCoalescer(term);
  clearTerminalSessionFlowAck("session-1");
});

test("continuous visible output cannot postpone the first idle drain deadline", () => {
  clearTerminalSessionFlowAck("session-1");
  const { term } = createFakeTerm();
  const ctx = createContext(false);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, {
    callback: () => void;
    delay: number;
    due: number;
  }>();
  const advanceBy = (elapsedMs: number) => {
    const target = now + elapsedMs;
    while (true) {
      const next = [...timers.entries()]
        // Keep zero-delay queue yields paused. The visible idle deadline is the
        // independent safety wake-up under test.
        .filter(([, timer]) => timer.delay > 0 && timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.due;
      timer.callback();
    }
    now = target;
  };

  globalThis.setTimeout = ((callback, delay = 0, ...args) => {
    const id = nextTimerId;
    nextTimerId += 1;
    const normalizedDelay = Number(delay) || 0;
    timers.set(id, {
      callback: () => callback(...args),
      delay: normalizedDelay,
      due: now + normalizedDelay,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer) => {
    timers.delete(Number(timer));
  }) as typeof clearTimeout;

  try {
    withAnimationFrameQueue((schedule) => {
      writeSessionData(
        ctx as never,
        term,
        "x".repeat(MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES + 1024),
      );
      schedule.flushScheduled();
      assert.ok(getFlowController(ctx as never, term).pendingBytes() > 0);

      for (let index = 0; index < 4; index += 1) {
        advanceBy(5);
        writeSessionData(ctx as never, term, "stream");
        schedule.flushScheduled();
      }

      // The first 24 ms deadline must still fire even though chunks arrived at
      // 5, 10, 15, and 20 ms. A debounce would postpone it to 44 ms.
      advanceBy(4);
      assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
    });
  } finally {
    advanceBy(100);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    resetTerminalWriteCoalescer(term);
    clearTerminalSessionFlowAck("session-1");
  }
});

test("a settled visible batch does not lend its idle deadline to the next frame", () => {
  clearTerminalSessionFlowAck("session-1");
  const { term, writes } = createFakeTerm("alternate");
  const ctx = createContext(false);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, {
    callback: () => void;
    delay: number;
    due: number;
  }>();
  const advanceBy = (elapsedMs: number) => {
    const target = now + elapsedMs;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.delay > 0 && timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.due;
      timer.callback();
    }
    now = target;
  };

  globalThis.setTimeout = ((callback, delay = 0, ...args) => {
    const id = nextTimerId;
    nextTimerId += 1;
    const normalizedDelay = Number(delay) || 0;
    timers.set(id, {
      callback: () => callback(...args),
      delay: normalizedDelay,
      due: now + normalizedDelay,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer) => {
    timers.delete(Number(timer));
  }) as typeof clearTimeout;

  try {
    withAnimationFrameQueue((schedule) => {
      writeSessionData(ctx as never, term, "frame-one");
      advanceBy(16);
      schedule.flushScheduled();
      assert.deepEqual(writes, ["frame-one"]);

      advanceBy(4);
      writeSessionData(ctx as never, term, "frame-two");

      // The first batch settled at 16 ms. Its old 24 ms safety deadline must
      // not flush this new frame before the next animation frame at 32 ms.
      advanceBy(4);
      assert.deepEqual(writes, ["frame-one"]);

      advanceBy(8);
      schedule.flushScheduled();
      assert.deepEqual(writes, ["frame-one", "frame-two"]);
    });
  } finally {
    advanceBy(100);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    resetTerminalWriteCoalescer(term);
    clearTerminalSessionFlowAck("session-1");
  }
});

test("Herdr-style frames complete on xterm's normal async path in every visibility state", async (t) => {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm") as {
    Terminal: new (options: Record<string, unknown>) => XTerm;
  };
  const churn = Array.from(
    { length: 7_000 },
    (_, index) => `\x1b[${(index % 24) + 1};1Hframe-${String(index).padStart(4, "0")}`,
  ).join("");
  const finalRows = Array.from(
    { length: 24 },
    (_, index) => `\x1b[${index + 1};1HHerdr row ${String(index + 1).padStart(2, "0")}`,
  ).join("");
  const payload = `\x1b[?2026h\x1b[2J\x1b[H${churn}\x1b[2J${finalRows}\x1b[?2026l`;
  assert.ok(payload.length > XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES);

  const scenarios = [
    { name: "visible pane", documentVisibility: "visible" as const, paneVisible: true },
    { name: "hidden pane", documentVisibility: "visible" as const, paneVisible: false },
    { name: "hidden page", documentVisibility: "hidden" as const, paneVisible: true },
    {
      name: "hidden pane revealed during write",
      documentVisibility: "visible" as const,
      paneVisible: false,
      revealBeforeAck: true,
    },
    {
      name: "hidden page restored during write",
      documentVisibility: "hidden" as const,
      paneVisible: true,
      revealBeforeAck: true,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const sessionId = `session-${scenario.name.replaceAll(" ", "-")}`;
      clearTerminalSessionFlowAck(sessionId);
      const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
      const writeBuffer = (term as unknown as {
        _core: { _writeBuffer: { flushSync: () => void } };
      })._core._writeBuffer;
      const originalFlushSync = writeBuffer.flushSync.bind(writeBuffer);
      let flushSyncCalls = 0;
      writeBuffer.flushSync = () => {
        flushSyncCalls += 1;
        originalFlushSync();
      };

      let ackedBytes = 0;
      let expectedAckBytes = payload.length;
      let resolveAck: (() => void) | undefined;
      const waitForAck = () => new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        resolveAck = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        if (ackedBytes >= expectedAckBytes) {
          resolveAck();
          return;
        }
        timer = setTimeout(() => {
          resolveAck = undefined;
          reject(new Error(`timed out waiting for ${scenario.name}`));
        }, 3_000);
      });
      const ctx = {
        ...createContext(false),
        isVisibleRef: { current: true },
        isPaneVisibleRef: { current: scenario.paneVisible },
        sessionRef: { current: sessionId },
        terminalBackend: {
          ackSessionFlow: (_sessionId: string, bytes: number) => {
            ackedBytes += bytes;
            if (ackedBytes >= expectedAckBytes) resolveAck?.();
          },
        },
      };

      try {
        withDocumentVisibility(scenario.documentVisibility, () => {
          writeSessionData(ctx as never, term, payload);
        }, { hasFocus: scenario.documentVisibility === "visible" });
        if (scenario.revealBeforeAck) {
          ctx.isPaneVisibleRef.current = true;
          withDocumentVisibility("visible", () => {
            flushPendingTerminalWritesOnResume(term);
          }, { hasFocus: true });
        }
        await waitForAck();

        const followUp = "\x1b[24;1H\x1b[2Kafter-input";
        expectedAckBytes += followUp.length;
        withDocumentVisibility(scenario.documentVisibility, () => {
          writeSessionData(ctx as never, term, followUp);
        }, { hasFocus: scenario.documentVisibility === "visible" });
        await waitForAck();

        assert.equal(flushSyncCalls, 0);
        assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "Herdr row 01");
        assert.equal(term.buffer.active.getLine(22)?.translateToString(true), "Herdr row 23");
        assert.equal(term.buffer.active.getLine(23)?.translateToString(true), "after-input");
        assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
        assert.equal(ackedBytes, expectedAckBytes);
      } finally {
        resetTerminalWriteCoalescer(term);
        clearTerminalSessionFlowAck(sessionId);
        term.dispose();
      }
    });
  }
});

test("revealing and resizing waits until a Herdr-style frame has completed", async () => {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm") as {
    Terminal: new (options: Record<string, unknown>) => XTerm;
  };
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  const writeBuffer = (term as unknown as {
    _core: { _writeBuffer: { flushSync: () => void } };
  })._core._writeBuffer;
  const originalFlushSync = writeBuffer.flushSync.bind(writeBuffer);
  let flushSyncCalls = 0;
  writeBuffer.flushSync = () => {
    flushSyncCalls += 1;
    originalFlushSync();
  };
  const payload = `\x1b[?2026h\x1b[2J\x1b[H${"Herdr resize frame".repeat(5_000)}\x1b[?2026l`;
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
    sessionRef: { current: "session-resize" },
  };

  try {
    writeSessionData(ctx as never, term, payload);
    ctx.isPaneVisibleRef.current = true;
    flushPendingTerminalWritesOnResume(term);

    const settled = await flushPendingTerminalWritesBeforeHibernate(term);

    assert.equal(settled, true);
    assert.equal(flushSyncCalls, 0);
    assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
    term.resize(100, 30);
    assert.equal(flushSyncCalls, 1);
  } finally {
    resetTerminalWriteCoalescer(term);
    clearTerminalSessionFlowAck("session-resize");
    term.dispose();
  }
});

test("writeSessionData flushes pending coalesced output with the background fast path", async () => {
  clearTerminalSessionFlowAck("session-1");
  const pendingPayload = "pending output\n";
  const currentPayload = "current\n";
  const writes: string[] = [];
  const pendingCallbacks: Array<() => void> = [];
  const writeBuffer = {
    flushSync() {
      while (pendingCallbacks.length > 0) {
        pendingCallbacks.shift()?.();
      }
    },
  };
  const term = {
    buffer: { active: { type: "normal" } },
    _core: { _writeBuffer: writeBuffer },
    write(data: string, callback?: () => void) {
      writes.push(data);
      if (callback) pendingCallbacks.push(callback);
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const expectedAckBytes = pendingPayload.length + currentPayload.length;
  let resolveAck: (() => void) | undefined;
  const ackDone = new Promise<void>((resolve) => { resolveAck = resolve; });
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
        if (acked.reduce((total, value) => total + value, 0) >= expectedAckBytes) {
          resolveAck?.();
        }
      },
    },
  };

  withAnimationFrameQueue((schedule) => {
    withDocumentVisibility("visible", () => {
      writeSessionData(ctx as never, term, pendingPayload);
    });
    assert.ok(schedule.scheduledCount() >= 1);
    assert.deepEqual(writes, []);

    withDocumentVisibility("hidden", () => {
      writeSessionData(ctx as never, term, currentPayload);
    });
  });
  while (pendingCallbacks.length > 0) {
    pendingCallbacks.shift()?.();
  }
  await Promise.race([
    ackDone,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for background ACK")), 3_000);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    }),
  ]);

  assert.equal(writes.join(""), `${pendingPayload}${currentPayload}`);
  assert.deepEqual(
    writes.map((write) => write.length),
    [
      pendingPayload.length,
      currentPayload.length,
    ],
  );
  assert.equal(pendingCallbacks.length, 0);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 0);
  assert.equal(
    acked.reduce((total, bytes) => total + bytes, 0),
    pendingPayload.length + currentPayload.length,
  );
  clearTerminalSessionFlowAck("session-1");
});

test("hidden tab output is written completely while the tab remains hidden", async () => {
  clearTerminalSessionFlowAck("session-1");
  const lines: string[] = [];
  let payloadLength = 0;
  while (payloadLength <= MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES) {
    const lineNumber = lines.length + 1;
    const line = `${String(lineNumber).padStart(5)}  echo history-${lineNumber}\r\n`;
    lines.push(line);
    payloadLength += line.length;
  }
  const payload = lines.join("");
  assert.ok(payload.length > MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES);
  const writes: string[] = [];
  const term = {
    buffer: { active: { type: "normal" } },
    _core: { _writeBuffer: { flushSync() {} } },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: false },
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  withAnimationFrameQueue(() => {
    writeSessionData(ctx as never, term, payload);
  });
  assert.deepEqual(writes, []);

  await new Promise((resolve) => { setTimeout(resolve, 190); });
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), payload);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  clearTerminalSessionFlowAck("session-1");
});

test("frequent hidden log lines are drained in one complete terminal write", async () => {
  const { term, writes, markerLines } = createFakeTerm();
  const ctx = {
    ...createContext(false),
    // The renderer stays active when hidden-tab hibernation is disabled, but
    // the pane itself is not visible. This is the normal multi-tab runtime.
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
  };
  const chunks = Array.from(
    { length: 8 },
    (_, index) => `line-${String(index + 1).padStart(2, "0")}\r\n`,
  );

  for (const chunk of chunks) {
    writeSessionData(ctx as never, term, chunk);
  }

  assert.deepEqual(writes, []);

  await new Promise((resolve) => { setTimeout(resolve, 190); });

  assert.deepEqual(writes, [chunks.join("")]);
  // Host timestamps off still records the per-second ledger; sparse anchors
  // only (≤1/sec), never per-line markers for 8 short lines.
  assert.ok(markerLines.length <= 1);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  resetTerminalWriteCoalescer(term);
});

test("large hidden bursts yield between terminal write slices", () => {
  type FakeTimer = {
    active: boolean;
    callback: () => void;
    delay: number;
    unref: () => void;
  };

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalDateNow = Date.now;
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
    const timer: FakeTimer = {
      active: true,
      callback: () => callback(...args),
      delay: Number(delay),
      unref() {},
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: FakeTimer | undefined) => {
    if (timer) timer.active = false;
  }) as unknown as typeof clearTimeout;

  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
  };
  const chunks = Array.from({ length: 96 }, () => "x".repeat(4096));
  const nextSecondChunk = "y";
  const payload = `${chunks.join("")}${nextSecondChunk}`;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    for (const chunk of chunks) {
      writeSessionData(ctx as never, term, chunk);
    }
    fakeNow += 1_000;
    writeSessionData(ctx as never, term, nextSecondChunk);
    assert.deepEqual(writes, []);

    const hiddenDrain = timers.find((timer) => timer.active && timer.delay === 160);
    assert.ok(hiddenDrain);
    hiddenDrain.active = false;
    hiddenDrain.callback();

    assert.deepEqual(writes, []);
    const firstQueueDrain = timers.find((timer) => timer.active && timer.delay === 0);
    assert.ok(firstQueueDrain);
    firstQueueDrain.active = false;
    firstQueueDrain.callback();

    assert.equal(writes.length, 1);
    assert.ok(writes[0]!.length <= MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES);
    assert.ok(writes.join("").length < payload.length);
    assert.ok(timers.some((timer) => timer.active && timer.delay === 0));

    flushPendingTerminalWritesOnResume(term);
    assert.equal(writes.join(""), payload);

    const followupDrain = timers.find((timer) => timer.active && timer.delay === 160);
    if (followupDrain) {
      followupDrain.active = false;
      followupDrain.callback();
    }
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    resetTerminalWriteCoalescer(term);
  }
});

test("hidden output keeps its arrival second when a batch crosses a clock boundary", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    writeSessionData(ctx as never, term, "first\r\n");
    fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
    writeSessionData(ctx as never, term, "second\r\n");
    flushPendingTerminalWritesOnResume(term);

    assert.deepEqual(writes, ["first\r\n", "second\r\n"]);
    // Paint only through real content lines (not the empty cursor row after \n).
    assert.deepEqual(getVisibleTerminalLineTimestampRows(term), [
      { row: 0, label: "12:00:59" },
      { row: 1, label: "12:01:00" },
    ]);
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("visible pressure-batched output keeps its arrival second across a clock boundary", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: true },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    withAnimationFrameQueue((schedule) => {
      noteTerminalOutputPressureData(term, "x".repeat(20_000));
      writeSessionData(ctx as never, term, "first\r\n");
      assert.ok(schedule.scheduledCount() >= 1);
      assert.deepEqual(writes, []);

      fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
      writeSessionData(ctx as never, term, "second\r\n");
      schedule.flushScheduled();

      assert.deepEqual(writes, ["first\r\n", "second\r\n"]);
      assert.deepEqual(getVisibleTerminalLineTimestampRows(term), [
        { row: 0, label: "12:00:59" },
        { row: 1, label: "12:01:00" },
      ]);
    });
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("visible alternate-screen output stays frame-batched across a clock boundary", () => {
  const { term, writes } = createFakeTerm("alternate");
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: true },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    withAnimationFrameQueue((schedule) => {
      writeSessionData(ctx as never, term, "frame-a");
      assert.ok(schedule.scheduledCount() >= 1);
      assert.deepEqual(writes, []);

      fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
      writeSessionData(ctx as never, term, "frame-b");
      assert.deepEqual(writes, []);

      schedule.flushScheduled();
      assert.equal(writes.join(""), "frame-aframe-b");
    });
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("normal output before an alternate-screen frame keeps its earlier timestamp", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: true },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    withAnimationFrameQueue((schedule) => {
      writeSessionData(ctx as never, term, "before\r\n\x1b[?1049hframe-a");
      assert.deepEqual(writes, ["before\r\n"]);

      fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
      writeSessionData(ctx as never, term, "frame-b\x1b[?1049lafter");
      schedule.flushScheduled();

      assert.equal(
        writes.join(""),
        "before\r\n\x1b[?1049hframe-aframe-b\x1b[?1049lafter",
      );
      // before @ :59; after leave alt "after" @ :00 (same buffer line count).
      assert.deepEqual(getVisibleTerminalLineTimestampRows(term), [
        { row: 0, label: "12:00:59" },
        { row: 1, label: "12:01:00" },
      ]);
    });
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("normal output after an alternate-screen frame keeps its earlier timestamp", () => {
  const { term, writes } = createFakeTerm("alternate");
  const activeBuffer = term.buffer.active as { type: string };
  const originalWrite = term.write.bind(term);
  term.write = (data: string | Uint8Array, callback?: () => void) => {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    if (text.includes("\x1b[?1049l")) {
      activeBuffer.type = "normal";
    }
    originalWrite(data, callback);
  };
  const ctx = {
    ...createContext(true),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    writeSessionData(ctx as never, term, "\x1b[?1049lafter\r\n");
    fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
    writeSessionData(ctx as never, term, "next\r\n");
    flushPendingTerminalWritesOnResume(term);

    assert.equal(writes.join(""), "\x1b[?1049lafter\r\nnext\r\n");
    assert.deepEqual(getVisibleTerminalLineTimestampRows(term), [
      { row: 0, label: "12:00:59" },
      { row: 1, label: "12:01:00" },
    ]);
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("hiding a pane preserves the arrival second of already queued output", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: true },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    withAnimationFrameQueue(() => {
      writeSessionData(ctx as never, term, "first\r\n");
      assert.deepEqual(writes, []);

      ctx.isPaneVisibleRef.current = false;
      fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
      writeSessionData(ctx as never, term, "second\r\n");
      flushPendingTerminalWritesOnResume(term);

      assert.deepEqual(writes, ["first\r\n", "second\r\n"]);
      assert.deepEqual(getVisibleTerminalLineTimestampRows(term), [
        { row: 0, label: "12:00:59" },
        { row: 1, label: "12:01:00" },
      ]);
    });
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("hiding the page preserves the arrival second of already queued output", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: true },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    withAnimationFrameQueue(() => {
      withDocumentVisibility("visible", () => {
        writeSessionData(ctx as never, term, "first\r\n");
      });
      assert.deepEqual(writes, []);

      fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
      withDocumentVisibility("hidden", () => {
        writeSessionData(ctx as never, term, "second\r\n");
      });
      flushPendingTerminalWritesOnResume(term);

      assert.deepEqual(writes, ["first\r\n", "second\r\n"]);
      assert.deepEqual(getVisibleTerminalLineTimestampRows(term), [
        { row: 0, label: "12:00:59" },
        { row: 1, label: "12:01:00" },
      ]);
    });
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("showing a pane preserves the background arrival second still queued with visible output", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(true),
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
  };
  const originalDateNow = Date.now;
  let fakeNow = new Date(2026, 0, 1, 12, 0, 59, 800).getTime();
  Date.now = () => fakeNow;

  try {
    withAnimationFrameQueue(() => {
      writeSessionData(ctx as never, term, "hidden\r\n");
      ctx.isPaneVisibleRef.current = true;
      writeSessionData(ctx as never, term, "visible-same-second\r\n");

      fakeNow = new Date(2026, 0, 1, 12, 1, 0, 20).getTime();
      writeSessionData(ctx as never, term, "visible-next-second\r\n");
      flushPendingTerminalWritesOnResume(term);

      assert.deepEqual(writes, [
        "hidden\r\nvisible-same-second\r\n",
        "visible-next-second\r\n",
      ]);
      // Per-second ledger + fill-forward through content only (no empty cursor row).
      assert.deepEqual(getVisibleTerminalLineTimestampRows(term), [
        { row: 0, label: "12:00:59" },
        { row: 1, label: "12:00:59" },
        { row: 2, label: "12:01:00" },
      ]);
    });
  } finally {
    Date.now = originalDateNow;
    resetTerminalWriteCoalescer(term);
  }
});

test("hidden prompt formatting preserves PTY chunk boundaries", async () => {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm") as {
    Terminal: new (options: Record<string, unknown>) => XTerm;
  };
  const term = new Terminal({ cols: 80, rows: 5, scrollback: 20, allowProposedApi: true });
  const originalWrite = term.write.bind(term);
  let writeCalls = 0;
  term.write = ((data: string | Uint8Array, callback?: () => void) => {
    writeCalls += 1;
    return originalWrite(data, callback);
  }) as XTerm["write"];
  const promptState = createPromptLineBreakState();
  promptState.lastPromptText = "$ ";
  promptState.pendingCommand = true;
  const settings = {
    showLineTimestamps: false,
    scrollOnOutput: false,
    forcePromptNewLine: true,
  };
  const ctx = {
    ...createContext(false),
    terminalSettingsRef: { current: settings },
    terminalSettings: settings,
    promptLineBreakStateRef: { current: promptState },
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
  };

  try {
    withAnimationFrameQueue(() => {
      writeSessionData(ctx as never, term, "foo");
      writeSessionData(ctx as never, term, "$ ");
      writeSessionData(ctx as never, term, "notice\r\n");
      writeSessionData(ctx as never, term, "bar");
      writeSessionData(ctx as never, term, "$ ");
      flushPendingTerminalWritesOnResume(term);
    });
    await flushPendingTerminalWritesBeforeHibernate(term);

    assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "foo");
    assert.equal(term.buffer.active.getLine(1)?.translateToString(true), "$ notice");
    assert.equal(term.buffer.active.getLine(2)?.translateToString(true), "bar");
    assert.equal(term.buffer.active.getLine(3)?.translateToString(true), "$");
    assert.equal(term.buffer.active.cursorX, 2);
    assert.equal(writeCalls, 1);
  } finally {
    resetTerminalWriteCoalescer(term);
    term.dispose();
  }
});

test("hidden prompt formatting respects cursor movement before a bare line feed", async () => {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm") as {
    Terminal: new (options: Record<string, unknown>) => XTerm;
  };
  const scenarios: Array<{
    convertEol: boolean;
    output: string;
    promptRow: number;
    promptLine?: string;
    setup?: string;
  }> = [
    { convertEol: false, output: "foo\n", promptRow: 2 },
    { convertEol: true, output: "foo\n", promptRow: 1 },
    { convertEol: false, output: "\x1b[10C\n", promptRow: 2 },
    { convertEol: false, output: "foo\x1b[1G\n", promptRow: 1 },
    { convertEol: false, output: "你好\r\n", promptRow: 1 },
    { convertEol: false, output: "你好\n", promptRow: 2 },
    { convertEol: false, output: "foo\x1b[20h\n", promptRow: 1 },
    { convertEol: true, output: "foo\x1b[20l\n", promptRow: 2 },
    { convertEol: false, output: "foo\x1b[E", promptRow: 1 },
    { convertEol: false, output: "foo\x1b[L\n", promptRow: 1, promptLine: "$ o" },
    { convertEol: false, output: "foo\x1b[M\n", promptRow: 1 },
    {
      convertEol: false,
      setup: "\x1b[3g\x1b[6G\x1bH\x1b[1G",
      output: "\x1b[I\n",
      promptRow: 2,
    },
  ];
  for (const scenario of scenarios) {
    const term = new Terminal({
      cols: 80,
      rows: 5,
      scrollback: 20,
      allowProposedApi: true,
      convertEol: scenario.convertEol,
    });
    const promptState = createPromptLineBreakState();
    promptState.lastPromptText = "$ ";
    promptState.pendingCommand = true;
    const settings = {
      showLineTimestamps: false,
      scrollOnOutput: false,
      forcePromptNewLine: true,
    };
    const ctx = {
      ...createContext(false),
      terminalSettingsRef: { current: settings },
      terminalSettings: settings,
      promptLineBreakStateRef: { current: promptState },
      isVisibleRef: { current: true },
      isPaneVisibleRef: { current: false },
    };

    try {
      if (scenario.setup) {
        term.write(scenario.setup);
        await flushPendingTerminalWritesBeforeHibernate(term);
      }
      withAnimationFrameQueue(() => {
        writeSessionData(ctx as never, term, scenario.output);
        writeSessionData(ctx as never, term, "$ ");
        flushPendingTerminalWritesOnResume(term);
      });
      await flushPendingTerminalWritesBeforeHibernate(term);

      assert.equal(
        term.buffer.active.getLine(scenario.promptRow)?.translateToString(true),
        scenario.promptLine ?? "$",
        JSON.stringify(scenario),
      );
      assert.equal(term.buffer.active.cursorX, 2);
    } finally {
      resetTerminalWriteCoalescer(term);
      term.dispose();
    }
  }
});

test("writeSessionData keeps the current perf trace when hidden output is flushed", () => {
  const payload = "hidden current output\n";
  const writes: string[] = [];
  const logs: string[] = [];
  const originalInfo = console.info;
  const term = {
    buffer: { active: { type: "normal" } },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    sessionRef: { current: "session-1" },
    terminalBackend: {},
  };

  console.info = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    withAnimationFrameQueue(() => {
      withDocumentVisibility("hidden", () => {
        writeSessionData(ctx as never, term, payload, payload.length, {
          terminalPerf: {
            id: "hidden-current",
            emittedAt: Date.now(),
            chars: payload.length,
            lineFeeds: 1,
          },
        });
      });
      // Hidden/background path force-flushes the coalescer (writes land now).
      assert.deepEqual(writes, [payload]);
    });
  } finally {
    console.info = originalInfo;
  }

  assert.deepEqual(writes, [payload]);
  assert.equal(logs.some((log) => log.includes('"event":"renderer-receive"') && log.includes('"id":"hidden-current"')), true);
  assert.equal(logs.some((log) => log.includes('"event":"renderer-write-done"') && log.includes('"id":"hidden-current"')), true);
});

test("writeSessionData drains output after the pane hides before the scheduled frame", async () => {
  clearTerminalSessionFlowAck("session-1");
  const payload = "x".repeat(XTERM_WRITE_CALLBACK_BATCH_BYTES);
  const writes: string[] = [];
  const term = {
    buffer: { active: { type: "normal" } },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow() {},
    },
  };
  let queuedBeforeHide = 0;

  withAnimationFrameQueue((schedule) => {
    withDocumentVisibility("visible", () => {
      writeSessionData(ctx as never, term, payload);
    });
    queuedBeforeHide = schedule.scheduledCount();
    ctx.isVisibleRef.current = false;
    // Hidden-pane drain path should take over before the scheduled tick fires.
    schedule.flushScheduled();
  });

  await new Promise((resolve) => { setTimeout(resolve, 90); });

  assert.ok(queuedBeforeHide >= 1);
  assert.equal(writes.join(""), payload);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData drains hidden pane output without waiting for reveal", async () => {
  clearTerminalSessionFlowAck("session-1");
  const payload = "x".repeat(XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES + 1);
  const writes: string[] = [];
  const term = {
    buffer: { active: { type: "normal" } },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: false },
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  writeSessionData(ctx as never, term, payload);
  assert.deepEqual(writes, []);

  await new Promise((resolve) => { setTimeout(resolve, 190); });
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), payload);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData keeps the hidden flush gate after coalescer reset and flushes on reveal", () => {
  clearTerminalSessionFlowAck("session-1");
  const payload = "x".repeat(XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES + 1);
  const writes: string[] = [];
  const term = {
    buffer: { active: { type: "normal" } },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  getFlowController(ctx as never, term);
  resetTerminalWriteCoalescer(term);
  withAnimationFrameQueue((schedule) => {
    withDocumentVisibility("visible", () => {
      writeSessionData(ctx as never, term, payload);
    });
    assert.ok(schedule.scheduledCount() >= 1);

    ctx.isVisibleRef.current = false;
    // Gate prevents flush while hidden; cancel/run scheduled tick without writing.
    schedule.microtasks.length = 0;
    schedule.frames.length = 0;
    assert.deepEqual(writes, []);

    ctx.isVisibleRef.current = true;
    flushPendingTerminalWritesOnResume(term);
  });
  flushTerminalSessionFlowAck("session-1");

  assert.deepEqual(writes, [payload]);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  clearTerminalSessionFlowAck("session-1");
});

test("hidden tab output marks pending scroll without scrolling immediately", async () => {
  const writes: string[] = [];
  let scrollCalls = 0;
  const term = {
    buffer: { active: { type: "normal" } },
    _core: { _writeBuffer: { flushSync() {} } },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  } as unknown as XTerm;
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: false },
    pendingOutputScrollRef: { current: false },
    terminalSettingsRef: {
      current: {
        showLineTimestamps: false,
        scrollOnOutput: true,
        forcePromptNewLine: false,
      },
    },
    terminalSettings: {
      showLineTimestamps: false,
      scrollOnOutput: true,
      forcePromptNewLine: false,
    },
  };

  writeSessionData(ctx as never, term, "fresh output");

  assert.equal(writes.join(""), "");
  assert.equal(ctx.pendingOutputScrollRef.current, false);
  await new Promise((resolve) => { setTimeout(resolve, 190); });

  assert.equal(writes.join(""), "fresh output");
  assert.equal(ctx.pendingOutputScrollRef.current, true);
  assert.equal(scrollCalls, 0);
});

test("visible output does not request another scroll when already at the bottom", () => {
  let scrollCalls = 0;
  const term = {
    buffer: {
      active: {
        type: "normal",
        baseY: 10_000,
        viewportY: 10_000,
      },
    },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  } as unknown as XTerm;
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    terminalSettingsRef: {
      current: {
        showLineTimestamps: false,
        scrollOnOutput: true,
        forcePromptNewLine: false,
      },
    },
  };

  writeSessionData(ctx as never, term, "fresh output");

  assert.equal(scrollCalls, 0);
});

test("visible output scrolls when the user is viewing earlier output", () => {
  let scrollCalls = 0;
  const term = {
    buffer: {
      active: {
        type: "normal",
        baseY: 10_000,
        viewportY: 9_900,
      },
    },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  } as unknown as XTerm;
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
    terminalSettingsRef: {
      current: {
        showLineTimestamps: false,
        scrollOnOutput: true,
        forcePromptNewLine: false,
      },
    },
  };

  writeSessionData(ctx as never, term, "fresh output");

  assert.equal(scrollCalls, 1);
});

test("visible output does not scroll when output auto-scroll is disabled", () => {
  let scrollCalls = 0;
  const term = {
    buffer: {
      active: {
        type: "normal",
        baseY: 10_000,
        viewportY: 9_900,
      },
    },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  } as unknown as XTerm;
  const ctx = {
    ...createContext(false),
    isVisibleRef: { current: true },
  };

  writeSessionData(ctx as never, term, "fresh output");

  assert.equal(scrollCalls, 0);
});

test("writeSessionData flushes deferred IPC acks before small output can leave the source paused", async () => {
  clearTerminalSessionFlowAck("session-1");
  const term = {
    buffer: { active: { type: "normal" } },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  let mainUnackedBytes = 0;
  let mainPaused = false;
  const ctx = {
    ...createContext(false),
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        mainUnackedBytes = Math.max(0, mainUnackedBytes - bytes);
        if (mainPaused && mainUnackedBytes <= FLOW_LOW_WATER_MARK) {
          mainPaused = false;
        }
      },
    },
  };
  // Deferred acks flush every time they reach XTERM_WRITE_CALLBACK_BATCH_BYTES,
  // which sits far below FLOW_HIGH_WATER_MARK (issue #1961 raised the watermark
  // to 1MB), so deferral alone can never push the main process into a pause.
  assert.ok(XTERM_WRITE_CALLBACK_BATCH_BYTES < FLOW_HIGH_WATER_MARK);
  const chunk = "x".repeat(512);
  const chunksPerThresholdFlush = Math.ceil(XTERM_WRITE_CALLBACK_BATCH_BYTES / chunk.length);
  const residueChunks = 7;
  const writeCount = chunksPerThresholdFlush * 2 + residueChunks;
  const expectedDeferredBytes = residueChunks * chunk.length;
  assert.ok(expectedDeferredBytes > 0);
  assert.ok(expectedDeferredBytes < XTERM_WRITE_CALLBACK_BATCH_BYTES);

  for (let index = 0; index < writeCount; index += 1) {
    mainUnackedBytes += chunk.length;
    if (mainUnackedBytes >= FLOW_HIGH_WATER_MARK) {
      mainPaused = true;
    }
    writeSessionData(ctx as never, term, chunk);
  }
  flushTerminalWriteCoalescer(term);

  assert.equal(mainPaused, false);
  assert.equal(mainUnackedBytes, expectedDeferredBytes);
  assert.equal(getDeferredTerminalWriteAckBytes(term), expectedDeferredBytes);

  await new Promise((resolve) => { setTimeout(resolve, 25); });

  assert.equal(mainPaused, false);
  assert.equal(mainUnackedBytes, 0);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 0);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData acks ingress bytes to match main-process trackEmitted", () => {
  clearTerminalSessionFlowAck("session-1");
  const { term } = createFakeTerm();
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  writeSessionData(ctx as never, term, "hello");
  flushTerminalWriteCoalescer(term);
  const deferred = clearDeferredTerminalWriteAck(term);
  if (deferred > 0) {
    ctx.terminalBackend.ackSessionFlow!("session-1", deferred);
  }
  flushTerminalSessionFlowAck("session-1");

  assert.deepEqual(acked, [5]);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData acks original ingress bytes when display data is expanded", () => {
  clearTerminalSessionFlowAck("session-1");
  const term = {
    buffer: { active: { type: "normal" } },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  writeSessionData(ctx as never, term, "a\nb", 2);
  flushTerminalWriteCoalescer(term);
  const deferred = clearDeferredTerminalWriteAck(term);
  if (deferred > 0) {
    ctx.terminalBackend.ackSessionFlow!("session-1", deferred);
  }
  flushTerminalSessionFlowAck("session-1");

  assert.deepEqual(acked, [2]);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData batches IPC acks using the VS Code ack size", () => {
  clearTerminalSessionFlowAck("session-1");
  const term = {
    buffer: { active: { type: "normal" } },
    write(_data: string, callback?: () => void) {
      callback?.();
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const acked: number[] = [];
  const ctx = {
    ...createContext(false),
    sessionRef: { current: "session-1" },
    terminalBackend: {
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
    },
  };

  writeSessionData(ctx as never, term, `${"x".repeat(FLOW_CHAR_COUNT_ACK_SIZE)}\n`);
  flushTerminalWriteCoalescer(term);
  flushTerminalSessionFlowAck("session-1");

  assert.deepEqual(acked, [FLOW_CHAR_COUNT_ACK_SIZE, 1]);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData records terminal output timestamps without changing output bytes", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "hello\r\nnext");

  assert.equal(writes.join(""), "hello\r\nnext");
  assert.equal((writes.join("").match(/\[\d{2}:\d{2}:\d{2}\]/g) ?? []).length, 0);
  // Per-second sparse reflow anchor (not per output line).
  assert.equal(markerLines.length, 1);
});

test("writeSessionData uses sparse reflow anchors not per-line markers", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(true, { showLineTimestamps: false }) as never, term, "hello\r\nnext");
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "more\r\n");

  assert.ok(writes.join("").includes("hello"));
  // At most one anchor per stamped wall-clock second across both writes.
  assert.ok(markerLines.length <= 2);
  assert.ok(markerLines.length >= 1);
});

test("writeSessionData records timestamps for hosts with timestamps enabled", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "hello");

  assert.equal(writes.join(""), "hello");
  assert.equal(markerLines.length, 1);
  assert.ok(getVisibleTerminalLineTimestampRows(term).length >= 1);
});

test("writeSessionData skips timestamps on the alternate screen", () => {
  const { term, writes, markerLines } = createFakeTerm("alternate");
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "vim screen");

  assert.deepEqual(writes, ["vim screen"]);
  assert.deepEqual(markerLines, []);
});

test("writeSessionData does not timestamp output that enters alternate screen in the same chunk", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "\x1b[?1049hvim screen");

  assert.deepEqual(writes, ["\x1b[?1049hvim screen"]);
  assert.deepEqual(markerLines, []);
});

test("writeSessionData resumes timestamps after leaving alternate screen in the same chunk", () => {
  const { term, writes, markerLines } = createFakeTerm("alternate");
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "\x1b[?1049lprompt");

  assert.equal(writes.join(""), "\x1b[?1049lprompt");
  assert.equal(markerLines.length, 1);
  assert.ok(getVisibleTerminalLineTimestampRows(term).length >= 1);
});

test("writeSessionData inserts erase-scrollback immediately after normal full clear", () => {
  const { term, writes } = createFakeTerm();
  writeSessionData(createContext(false) as never, term, "\x1b[H\x1b[2Jfresh output");

  assert.equal(writes.join(""), "\x1b[H\x1b[2J\x1b[3Jfresh output");
});

test("writeSessionData preserves scrollback after normal full clear when disabled", () => {
  const { term, writes } = createFakeTerm();
  const ctx = createContext(false);
  ctx.terminalSettingsRef.current.clearWipesScrollback = false;
  ctx.terminalSettings.clearWipesScrollback = false;

  writeSessionData(ctx as never, term, "\x1b[H\x1b[2Jfresh output");

  assert.equal(writes.join(""), "\x1b[H\x1b[2Jfresh output");
});

test("writeSessionData does not duplicate existing erase-scrollback after full clear", () => {
  const { term, writes } = createFakeTerm();
  writeSessionData(createContext(false) as never, term, "\x1b[H\x1b[2J\x1b[3Jfresh output");

  assert.equal(writes.join(""), "\x1b[H\x1b[2J\x1b[3Jfresh output");
});

test("writeSessionData does not add erase-scrollback inside synchronized output", () => {
  const { term, writes } = createFakeTerm();
  writeSessionData(createContext(false) as never, term, "\x1b[?2026h\x1b[H\x1b[2Jframe\x1b[?2026l");

  assert.equal(writes.join(""), "\x1b[?2026h\x1b[H\x1b[2Jframe\x1b[?2026l");
});

test("writeSessionData does not wipe scrollback for delayed sync clears after returning to bottom", () => {
  const writes: string[] = [];
  const active = { type: "normal" as const, viewportY: 0, baseY: 5 };
  const term = {
    buffer: { active },
    write(data: string, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
    registerMarker() {
      return { line: 0, isDisposed: false, dispose() {} };
    },
    scrollToBottom() {},
  } as unknown as XTerm;
  const ctx = createContext(false);
  ctx.terminalSettingsRef.current.clearWipesScrollback = true;
  ctx.terminalSettings.clearWipesScrollback = true;

  // Prior chunk opens the sync block while the user is reading scrollback.
  writeSessionData(ctx as never, term, "\x1b[?2026h\x1b[H");
  // Delayed clear arrives after the user returns to the live bottom.
  active.viewportY = 5;
  active.baseY = 5;
  writeSessionData(ctx as never, term, "\x1b[2Jframe\x1b[?2026l");

  const output = writes.join("");
  assert.equal(output.includes("\x1b[3J"), false, output);
  assert.equal(output.includes("\x1b[H\x1b[2Jframe"), true, output);
});

test("writeSessionData always uses ledger recording regardless of gutter toggle", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const ctx = createContext(false, { showLineTimestamps: false });

  writeSessionData(ctx as never, term, "before\r\n");
  // Per-second sparse reflow anchors (not per-line markers).
  assert.equal(markerLines.length, 1);

  ctx.host = { showLineTimestamps: true };
  ctx.hostRef.current = ctx.host;
  writeSessionData(ctx as never, term, "enabled\r\n");
  // Same wall-clock second in real runs may still be one stamp; here two writes
  // share one second unless Date.now advances — allow ≤2 sparse anchors total.
  assert.ok(markerLines.length <= 2, `expected sparse anchors, got ${markerLines.length}`);

  ctx.host = { showLineTimestamps: false };
  ctx.hostRef.current = ctx.host;
  writeSessionData(ctx as never, term, "disabled");

  assert.equal(writes.join(""), "before\r\nenabled\r\ndisabled");
  // Ledger still has stamps for paint when gutter is shown.
  assert.ok(getVisibleTerminalLineTimestampRows(term).length >= 1);
});

test("writeSessionData follows live hostRef toggles without replacing boot host snapshot", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const bootHost = { showLineTimestamps: false as boolean };
  const hostRef = { current: bootHost };
  const ctx = {
    ...createContext(false),
    host: bootHost,
    hostRef,
  };

  writeSessionData(ctx as never, term, "boot-off\r\n");
  assert.ok(markerLines.length <= 1);

  hostRef.current = { showLineTimestamps: true };
  assert.equal(bootHost.showLineTimestamps, false);
  assert.equal(ctx.host.showLineTimestamps, false);

  writeSessionData(ctx as never, term, "live-on\r\n");
  assert.equal(writes.join(""), "boot-off\r\nlive-on\r\n");
  // Sparse anchors only (≤1 per stamped second).
  assert.ok(markerLines.length <= 2);
  assert.ok(getVisibleTerminalLineTimestampRows(term).length >= 1);

  hostRef.current = { showLineTimestamps: false };
  writeSessionData(ctx as never, term, "live-off");
  assert.equal(writes.join(""), "boot-off\r\nlive-on\r\nlive-off");
});

test("writeSessionData batches timestamp bookkeeping for bulk line output", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const payload = `${Array.from({ length: 40 }, () => "x".repeat(80)).join("\n")}\n`;

  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, payload, payload.length);
  flushTerminalWriteCoalescer(term);
  for (let guard = 0; guard < 1000 && flushTerminalWriteQueueBypassingTimers(term); guard += 1) {
    // Drain cooperative bulk-output timers so the assertion observes the full write plan.
  }

  assert.equal(writes.join(""), payload);
  // One wall-clock second → one ledger stamp + one sparse reflow anchor.
  assert.equal(markerLines.length, 1);
  const painted = getVisibleTerminalLineTimestampRows(term);
  assert.ok(painted.length >= 1);
  assert.ok(painted.every((row) => row.label.length > 0));
  assert.ok(writes.length >= 1);
});

test("writeSessionData skips timestamp markers under large-output pressure", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const payload = `${Array.from({ length: 2000 }, () => "x".repeat(1023)).join("\n")}\n`;

  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, payload, payload.length);
  flushTerminalWriteCoalescer(term);
  for (let guard = 0; guard < 1000 && flushTerminalWriteQueueBypassingTimers(term); guard += 1) {
    // Drain cooperative bulk-output timers.
  }

  assert.equal(writes.join(""), payload);
  assert.equal(markerLines.length, 0);
});

test("attachSessionToTerminal resets timestamp state for a reused terminal", () => {
  const { term, writes } = createFakeTerm();
  const ctx = {
    ...createContext(false, { showLineTimestamps: true }),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    terminalBackend: {
      onSessionData: () => () => {},
      onSessionExit: () => () => {},
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  writeSessionData(ctx as never, term, "unfinished");
  attachSessionToTerminal(ctx as never, term, "session-2");
  writeSessionData(ctx as never, term, "fresh");

  assert.equal(writes.length, 2);
  assert.equal(writes[1], "fresh");
});

test("attachSessionToTerminal clears the backend id before reporting exit", () => {
  const { term } = createFakeTerm();
  let onExit: ((evt: { reason?: string }) => void) | null = null;
  let sessionIdSeenByConsumer: string | null | undefined = "not-called";
  const sessionRef = { current: null as string | null };
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef,
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    terminalBackend: {
      onSessionData: () => () => {},
      onSessionExit: (_id: string, callback: (evt: { reason?: string }) => void) => {
        onExit = callback;
        return () => {};
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {
      sessionIdSeenByConsumer = sessionRef.current;
    },
  };

  attachSessionToTerminal(ctx as never, term, "session-1");
  assert.equal(sessionRef.current, "session-1");
  onExit?.({ reason: "closed" });

  assert.equal(sessionRef.current, null);
  assert.equal(sessionIdSeenByConsumer, null);
});

test("attachSessionToTerminal drains hidden final output before exit capture", () => {
  const { term, writes } = createFakeTerm();
  let onData: ((data: string) => void) | null = null;
  let onExit: ((evt: { reason?: string }) => void) | null = null;
  let captured = "";
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null as string | null },
    isVisibleRef: { current: true },
    isPaneVisibleRef: { current: false },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: { serialize: () => writes.join("") } },
    pendingAuthRef: { current: null },
    terminalBackend: {
      onSessionData: (_id: string, callback: (data: string) => void) => {
        onData = callback;
        return () => {};
      },
      onSessionExit: (_id: string, callback: (evt: { reason?: string }) => void) => {
        onExit = callback;
        return () => {};
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onTerminalDataCapture: (_sessionId: string, data: string) => {
      captured = data;
    },
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1");
  onData?.("final output\r\n");
  assert.deepEqual(writes, []);

  onExit?.({ reason: "closed" });

  const expected = "final output\r\n\r\n[session closed]\r\n";
  assert.equal(writes.join(""), expected);
  assert.equal(captured, expected);
  resetTerminalWriteCoalescer(term);
});

test("attachSessionToTerminal keeps interrupt-time output visible", () => {
  clearTerminalSessionFlowAck("session-1");
  const { term, writes } = createFakeTerm();
  const acked: number[] = [];
  const output: string[] = [];
  const logs: string[] = [];
  let onData: ((data: string) => void) | null = null;
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    onTerminalOutput: (chunk: string) => output.push(chunk),
    onTerminalLogData: (chunk: string) => logs.push(chunk),
    terminalBackend: {
      onSessionData: (_id: string, cb: (data: string) => void) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      ackSessionFlow: (_sessionId: string, bytes: number) => {
        acked.push(bytes);
      },
      setSessionFlowPaused: () => {},
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1");
  const flow = getFlowController(ctx as never, term);
  flow.received(FLOW_LOW_WATER_MARK);
  prioritizeTerminalInput(
    term,
    "session-1",
    flow,
    ctx.terminalBackend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: false,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  onData?.("old output");
  flushTerminalWriteCoalescer(term);

  assert.equal(writes.join(""), "old output");
  assert.equal(output.join(""), "old output");
  assert.equal(logs.join(""), "old output");
  assert.deepEqual(acked, []);

  onData?.("^");
  flushTerminalWriteCoalescer(term);

  assert.equal(writes.join(""), "old output^");
  assert.equal(output.join(""), "old output^");
  assert.equal(logs.join(""), "old output^");
  assert.deepEqual(acked, []);

  onData?.("C\r\n$ ");
  flushTerminalWriteCoalescer(term);
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), "old output^C\r\n$ ");
  assert.equal(output.join(""), "old output^C\r\n$ ");
  assert.equal(logs.join(""), "old output^C\r\n$ ");
  assert.deepEqual(acked, []);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 16);
  clearDeferredTerminalWriteAck(term);
  clearTerminalSessionFlowAck("session-1");
});

test("attachSessionToTerminal hints for sudo password prompts and fills on confirm", () => {
  const { term, writes } = createFakeTerm();
  const sent: Array<{ id: string; data: string; automated?: boolean }> = [];
  const hints: boolean[] = [];
  let onData: ((data: string) => void) | null = null;
  const sudoAutofillRef = { current: null };
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    sudoAutofillRef,
    onSudoHint: (active: boolean) => hints.push(active),
    terminalBackend: {
      onSessionData: (_id: string, cb: (data: string) => void) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      writeToSession: (id: string, data: string, options?: { automated?: boolean }) => {
        sent.push({ id, data, automated: options?.automated });
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1", {
    sudoAutofillPassword: "secret",
  });
  sudoAutofillRef.current?.armForCommand("sudo whoami");
  onData?.("sudo whoami\r\n");
  onData?.("[sudo] password for alice: ");

  // Confirm-to-fill model: detecting the prompt raises a hint but never sends
  // the password on its own.
  assert.deepEqual(hints, [true]);
  assert.deepEqual(sent, []);
  assert.equal(writes[0], "sudo whoami\r\n");
  assert.equal(writes[1], "[sudo] password for alice: ");

  // The password is only written once the user confirms (presses Enter).
  sudoAutofillRef.current?.confirmFill();
  assert.deepEqual(sent, [{ id: "session-1", data: "secret\n", automated: true }]);
});

test("attachSessionToTerminal does not auto-fill unarmed sudo-looking output", () => {
  const { term } = createFakeTerm();
  const sent: string[] = [];
  let onData: ((data: string) => void) | null = null;
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    sudoAutofillRef: { current: null },
    terminalBackend: {
      onSessionData: (_id: string, cb: (data: string) => void) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      writeToSession: (_id: string, data: string) => {
        sent.push(data);
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1", {
    sudoAutofillPassword: "secret",
  });
  onData?.("[sudo] password for alice: ");

  assert.deepEqual(sent, []);
});

test("attachSessionToTerminal leaves sudo prompts alone without an autofill password", () => {
  const { term } = createFakeTerm();
  const sent: string[] = [];
  let onData: ((data: string) => void) | null = null;
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: true },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    terminalBackend: {
      onSessionData: (_id: string, cb: (data: string) => void) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      writeToSession: (_id: string, data: string) => {
        sent.push(data);
      },
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1");
  onData?.("[sudo] password for alice: ");

  assert.deepEqual(sent, []);
});

test("tryAttachSessionToTerminal closes orphan sessions after unmount", () => {
  const { term } = createFakeTerm();
  const closed: string[] = [];
  let dataSubscribed = false;
  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null },
    hasConnectedRef: { current: false },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null },
    disposeExitRef: { current: null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    isBootActiveRef: { current: false },
    terminalBackend: {
      closeSession: (id: string) => {
        closed.push(id);
      },
      onSessionData: () => {
        dataSubscribed = true;
        return () => {};
      },
      onSessionExit: () => () => {},
    },
    updateStatus: () => {},
    setError: () => {},
    onSessionExit: () => {},
  };

  const attached = tryAttachSessionToTerminal(ctx as never, term, "backend-session");

  assert.equal(attached, false);
  assert.deepEqual(closed, ["backend-session"]);
  assert.equal(dataSubscribed, false);
  assert.equal(ctx.sessionRef.current, null);
});

test("attachSessionToTerminal marks connected on metadata-only or visible first output", () => {
  const { term } = createFakeTerm();
  const statuses: string[] = [];
  const output: Array<{ data: string; sensitive: boolean }> = [];
  let onData: ((data: string, meta?: {
    moshHandshake?: boolean;
    pluginPipelineIngressBytes?: number;
    pluginPipelineSensitiveInput?: boolean;
  }) => void) | null = null;

  const ctx = {
    ...createContext(false),
    sessionId: "session-1",
    sessionRef: { current: null as string | null },
    hasConnectedRef: { current: false },
    hasRunStartupCommandRef: { current: false },
    disposeDataRef: { current: null as (() => void) | null },
    disposeExitRef: { current: null as (() => void) | null },
    fitAddonRef: { current: null },
    serializeAddonRef: { current: null },
    pendingAuthRef: { current: null },
    onTerminalOutput: (data: string, meta?: { pluginPipelineSensitiveInput?: boolean }) => {
      output.push({ data, sensitive: meta?.pluginPipelineSensitiveInput === true });
    },
    terminalBackend: {
      onSessionData: (
        _id: string,
        cb: (data: string, meta?: {
          moshHandshake?: boolean;
          pluginPipelineIngressBytes?: number;
          pluginPipelineSensitiveInput?: boolean;
        }) => void,
      ) => {
        onData = cb;
        return () => {};
      },
      onSessionExit: () => () => {},
      writeToSession: () => {},
      resizeSession: () => {},
      setSessionFlowPaused: () => {},
      ackSessionFlow: () => {},
    },
    updateStatus: (status: string) => {
      statuses.push(status);
      if (status === "connected") ctx.hasConnectedRef.current = true;
    },
    setError: () => {},
    onSessionExit: () => {},
  };

  attachSessionToTerminal(ctx as never, term, "session-1");
  // A plugin may suppress the first banner while still consuming host ingress.
  onData?.("", { pluginPipelineIngressBytes: 12, pluginPipelineSensitiveInput: true });
  assert.deepEqual(statuses, ["connected"]);
  assert.equal(ctx.hasConnectedRef.current, true);
  assert.deepEqual(output, [{ data: "", sensitive: true }]);
  // Handshake output must dismiss the overlay so interactive prompts are reachable.
  onData?.("ssh handshake banner\r\n", { moshHandshake: true });
  assert.deepEqual(statuses, ["connected"]);
  assert.equal(ctx.hasConnectedRef.current, true);
});
