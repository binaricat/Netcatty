import test from "node:test";
import assert from "node:assert/strict";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  FLOW_HIGH_WATER_MARK,
  FLOW_CHAR_COUNT_ACK_SIZE,
  FLOW_LOW_WATER_MARK,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  XTERM_WRITE_CALLBACK_BATCH_BYTES,
} from "./terminalFlowConstants.ts";
import {
  attachSessionToTerminal,
  getFlowController,
  notePendingOutputScrollIfEnabled,
  tryAttachSessionToTerminal,
  writeSessionData,
} from "./terminalSessionAttachment.ts";
import {
  clearTerminalSessionFlowAck,
  flushTerminalSessionFlowAck,
} from "./terminalFlowAckBuffer.ts";
import { flushTerminalWriteCoalescer } from "./terminalWriteCoalescer.ts";
import {
  clearDeferredTerminalWriteAck,
  getDeferredTerminalWriteAckBytes,
} from "./terminalWriteAckDeferral.ts";
import { flushTerminalWriteQueueBypassingTimers } from "./terminalWriteQueue.ts";
import { prioritizeTerminalInput } from "./terminalOutputPipeline";

const createFakeTerm = (activeType = "normal") => {
  const writes: string[] = [];
  const markerLines: number[] = [];
  const disposedMarkerLines: number[] = [];
  let cursorLine = 0;
  const term = {
    buffer: {
      active: { type: activeType },
    },
    write(data: string, callback?: () => void) {
      writes.push(data);
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

const createContext = (showLineTimestamps: boolean, host: Record<string, unknown> = {}) => ({
  host,
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

const withAnimationFrameQueue = (run: (frames: Array<FrameRequestCallback>) => void) => {
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const frames: Array<FrameRequestCallback> = [];
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
  try {
    run(frames);
  } finally {
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

  const flow = getFlowController(ctx as never, term);
  assert.equal(flow.pendingBytes(), 0);
  assert.ok(getDeferredTerminalWriteAckBytes(term) > 0);
  clearDeferredTerminalWriteAck(term);
});

test("writeSessionData flushes xterm writes while the page is hidden", () => {
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
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), payload);
  assert.deepEqual(writes.map((write) => write.length), [FLOW_CHAR_COUNT_ACK_SIZE, 1]);
  assert.equal(pendingCallbacks.length, 0);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData flushes xterm writes while the window is unfocused but visible", () => {
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
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), payload);
  assert.equal(pendingCallbacks.length, 0);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(getDeferredTerminalWriteAckBytes(term), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  clearTerminalSessionFlowAck("session-1");
});

test("writeSessionData flushes pending coalesced output with the background fast path", () => {
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

  withAnimationFrameQueue((frames) => {
    withDocumentVisibility("visible", () => {
      writeSessionData(ctx as never, term, pendingPayload);
    });
    assert.equal(frames.length, 1);
    assert.deepEqual(writes, []);

    withDocumentVisibility("hidden", () => {
      writeSessionData(ctx as never, term, currentPayload);
    });
  });
  flushTerminalSessionFlowAck("session-1");

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

test("hidden tab output is written completely while the tab remains hidden", () => {
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
  flushTerminalSessionFlowAck("session-1");

  assert.equal(writes.join(""), payload);
  assert.equal(getFlowController(ctx as never, term).pendingBytes(), 0);
  assert.equal(acked.reduce((total, bytes) => total + bytes, 0), payload.length);
  clearTerminalSessionFlowAck("session-1");
});

test("hidden tab output marks pending scroll without scrolling immediately", () => {
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

  assert.equal(writes.join(""), "fresh output");
  assert.equal(ctx.pendingOutputScrollRef.current, true);
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
  assert.deepEqual(markerLines, [0, 1]);
});

test("writeSessionData keeps timestamp metadata when the host gutter is disabled", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(true, { showLineTimestamps: false }) as never, term, "hello");

  assert.deepEqual(writes, ["hello"]);
  assert.deepEqual(markerLines, [0]);
});

test("writeSessionData records timestamps for hosts with timestamps enabled", () => {
  const { term, writes, markerLines } = createFakeTerm();
  writeSessionData(createContext(false, { showLineTimestamps: true }) as never, term, "hello");

  assert.equal(writes.join(""), "hello");
  assert.deepEqual(markerLines, [0]);
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
  assert.deepEqual(markerLines, [0]);
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

test("writeSessionData preserves timestamps across host gutter visibility changes", () => {
  const { term, writes, markerLines, disposedMarkerLines } = createFakeTerm();
  const ctx = createContext(false, { showLineTimestamps: false });

  writeSessionData(ctx as never, term, "before\r\n");
  ctx.host = { showLineTimestamps: true };
  writeSessionData(ctx as never, term, "enabled\r\n");
  ctx.host = { showLineTimestamps: false };
  writeSessionData(ctx as never, term, "disabled");

  assert.equal(writes.join(""), "before\r\nenabled\r\ndisabled");
  assert.deepEqual(markerLines, [0, 1, 2]);
  assert.deepEqual(disposedMarkerLines, []);
});

test("writeSessionData batches timestamp bookkeeping for bulk line output", () => {
  const { term, writes, markerLines } = createFakeTerm();
  const payload = `${Array.from({ length: 2000 }, () => "x".repeat(1023)).join("\n")}\n`;

  writeSessionData(createContext(false, { showLineTimestamps: false }) as never, term, payload, payload.length);
  flushTerminalWriteCoalescer(term);
  for (let guard = 0; guard < 1000 && flushTerminalWriteQueueBypassingTimers(term); guard += 1) {
    // Drain cooperative bulk-output timers so the assertion observes the full write plan.
  }

  assert.equal(writes.join(""), payload);
  assert.equal(markerLines.length, 2000);
  assert.ok(
    writes.length <= Math.ceil(payload.length / MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES) + 1,
    `expected bulk output to write in chunks, got ${writes.length} writes`,
  );
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
