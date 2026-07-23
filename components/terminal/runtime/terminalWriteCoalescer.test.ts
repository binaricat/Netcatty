import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  abortTerminalWriteCoalescer,
  enqueueCoalescedTerminalWrite,
  flushTerminalWriteCoalescer,
  getAltScreenProbeScanCountForTests,
  resetAltScreenProbeScanCountForTests,
  resetTerminalWriteCoalescer,
  resolveFloodCoalescerByteCap,
  setTerminalWriteCoalescerByteCapResolver,
  setTerminalWriteCoalescerFlushGate,
  shouldPreserveTerminalWriteFrameBatch,
  type CoalescedTerminalWriteOptions,
} from "./terminalWriteCoalescer.ts";
import {
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
} from "./terminalFlowConstants.ts";
import {
  createPromptLineBreakState,
  findTerminalPromptSourceChunkVisibleStarts,
  prepareTerminalDataForPromptLineBreak,
} from "./promptLineBreak.ts";

const createFakeTerm = () => ({}) as XTerm;
const withAnimationFrameQueue = (run: () => void) => {
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => {},
  });
  try {
    run();
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

const withQueuedAnimationFrame = (run: (frames: Array<FrameRequestCallback>) => void) => {
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

test("splits a single flood-sized terminal batch before it reaches xterm", () => {
  const term = createFakeTerm();
  const writes: Array<{ data: string; ingressBytes: number }> = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 8);
  enqueueCoalescedTerminalWrite(
    term,
    "x".repeat(20),
    (data, ingressBytes) => {
      writes.push({ data, ingressBytes });
    },
    30,
  );

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [8, 8, 4],
  );
  assert.deepEqual(
    writes.map((write) => write.ingressBytes),
    [12, 12, 6],
  );

  resetTerminalWriteCoalescer(term);
});

test("marks merged coalesced output as not preserving single-chunk perf metadata", () => {
  const term = createFakeTerm();
  const writes: Array<{ data: string; options?: CoalescedTerminalWriteOptions }> = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 100);
  withAnimationFrameQueue(() => {
    enqueueCoalescedTerminalWrite(
      term,
      "first",
      () => {},
      "first".length,
    );
    enqueueCoalescedTerminalWrite(
      term,
      "second",
      (data, _ingressBytes, options) => {
        writes.push({ data, options });
      },
      "second".length,
    );
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(writes, [{
    data: "firstsecond",
    options: { preservePerfTrace: false },
  }]);

  resetTerminalWriteCoalescer(term);
});

test("keeps a prompt source chunk intact when slicing merged output", () => {
  const term = {
    buffer: { active: { type: "normal", cursorX: 1 } },
  } as unknown as XTerm;
  const writes: Array<{ data: string; options?: CoalescedTerminalWriteOptions }> = [];
  const promptState = createPromptLineBreakState();
  promptState.lastPromptText = "$ ";
  promptState.pendingCommand = true;

  setTerminalWriteCoalescerByteCapResolver(term, () => 4);
  setTerminalWriteCoalescerFlushGate(term, () => false);
  withAnimationFrameQueue(() => {
    const captureWrite = (data: string, _ingressBytes?: number, options?: CoalescedTerminalWriteOptions) => {
      const promptStarts = findTerminalPromptSourceChunkVisibleStarts(
        data,
        promptState.lastPromptText,
        options?.sourceChunkBoundaries,
      );
      writes.push({
        data: prepareTerminalDataForPromptLineBreak(
          term,
          data,
          promptState,
          true,
          promptStarts,
        ),
        options,
      });
    };
    enqueueCoalescedTerminalWrite(
      term,
      "abc",
      captureWrite,
      "abc".length,
      { preserveSourceChunkBoundaries: true },
    );
    enqueueCoalescedTerminalWrite(
      term,
      "$ ",
      captureWrite,
      "$ ".length,
      { preserveSourceChunkBoundaries: true },
    );
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(
    writes.map((write) => write.data),
    ["abc", "\r\n$ "],
  );

  resetTerminalWriteCoalescer(term);
});

test("extends a real-sized slice to preserve a nearby prompt boundary", () => {
  const term = {
    buffer: { active: { type: "normal", cursorX: 1 } },
  } as unknown as XTerm;
  const prompt = "(base) user@host:~$ ";
  const firstChunk = `${"a".repeat((128 * 1024) - prompt.length + 1)}${prompt}`;
  const writes: Array<{ data: string; promptStarts: number[] }> = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 1024 * 1024);
  setTerminalWriteCoalescerFlushGate(term, () => false);
  withAnimationFrameQueue(() => {
    enqueueCoalescedTerminalWrite(
      term,
      firstChunk,
      () => {},
      firstChunk.length,
      { preserveSourceChunkBoundaries: true },
    );
    enqueueCoalescedTerminalWrite(term, "later output", (data, _ingressBytes, options) => {
      writes.push({
        data,
        promptStarts: findTerminalPromptSourceChunkVisibleStarts(
          data,
          prompt,
          options?.sourceChunkBoundaries,
        ),
      });
    }, "later output".length, { preserveSourceChunkBoundaries: true });
    flushTerminalWriteCoalescer(term);
  });

  assert.equal(writes[0]?.data, firstChunk);
  assert.deepEqual(writes[0]?.promptStarts, [firstChunk.length - prompt.length]);

  resetTerminalWriteCoalescer(term);
});

test("preserves prompt line breaks after a coalesced bare line feed", () => {
  const term = {
    buffer: { active: { type: "normal", cursorX: 0 } },
  } as unknown as XTerm;
  const writes: string[] = [];
  const promptState = createPromptLineBreakState();
  promptState.lastPromptText = "$ ";
  promptState.pendingCommand = true;

  setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
  setTerminalWriteCoalescerFlushGate(term, () => false);
  withAnimationFrameQueue(() => {
    enqueueCoalescedTerminalWrite(
      term,
      "foo\n",
      () => {},
      "foo\n".length,
      { preserveSourceChunkBoundaries: true },
    );
    enqueueCoalescedTerminalWrite(term, "$ ", (data, _ingressBytes, options) => {
      const promptStarts = findTerminalPromptSourceChunkVisibleStarts(
        data,
        promptState.lastPromptText,
        options?.sourceChunkBoundaries,
      );
      writes.push(prepareTerminalDataForPromptLineBreak(
        term,
        data,
        promptState,
        true,
        promptStarts,
      ));
    }, "$ ".length, { preserveSourceChunkBoundaries: true });
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(writes, ["foo\n\r\n$ "]);

  resetTerminalWriteCoalescer(term);
});

test("uses the pending writer when a new chunk forces an old single chunk flush", () => {
  const term = createFakeTerm();
  const firstWriter: string[] = [];
  const secondWriter: string[] = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 10);
  withAnimationFrameQueue(() => {
    enqueueCoalescedTerminalWrite(
      term,
      "old",
      (data) => {
        firstWriter.push(data);
      },
      "old".length,
    );
    enqueueCoalescedTerminalWrite(
      term,
      "new-data",
      (data) => {
        secondWriter.push(data);
      },
      "new-data".length,
    );
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(firstWriter, ["old"]);
  assert.deepEqual(secondWriter, ["new-data"]);

  resetTerminalWriteCoalescer(term);
});

test("aborting pending coalesced output clears merge bookkeeping for the next write", () => {
  const term = createFakeTerm();
  const writes: Array<{ data: string; options?: CoalescedTerminalWriteOptions }> = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 100);
  withAnimationFrameQueue(() => {
    enqueueCoalescedTerminalWrite(term, "dropped", () => {}, "dropped".length);
    enqueueCoalescedTerminalWrite(term, " output", () => {}, " output".length);
    abortTerminalWriteCoalescer(term);
    enqueueCoalescedTerminalWrite(
      term,
      "next",
      (data, _ingressBytes, options) => {
        writes.push({ data, options });
      },
      "next".length,
    );
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(writes, [{ data: "next", options: undefined }]);

  resetTerminalWriteCoalescer(term);
});

test("pending output skipped while hidden can be flushed after the pane is shown", () => {
  const term = createFakeTerm();
  const writes: string[] = [];
  let isPaneVisible = true;

  setTerminalWriteCoalescerByteCapResolver(term, () => 100);
  setTerminalWriteCoalescerFlushGate(term, () => isPaneVisible);
  withQueuedAnimationFrame((frames) => {
    enqueueCoalescedTerminalWrite(
      term,
      "hidden output",
      (data) => {
        writes.push(data);
      },
      "hidden output".length,
    );

    isPaneVisible = false;
    frames.shift()?.(0);
    assert.deepEqual(writes, []);

    isPaneVisible = true;
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(writes, ["hidden output"]);

  resetTerminalWriteCoalescer(term);
});

test("cap-triggered coalescer flushes while a pane is still hidden", () => {
  const term = createFakeTerm();
  const writes: string[] = [];
  const isPaneVisible = false;

  setTerminalWriteCoalescerByteCapResolver(term, () => 10);
  setTerminalWriteCoalescerFlushGate(term, () => isPaneVisible);
  withQueuedAnimationFrame((frames) => {
    enqueueCoalescedTerminalWrite(
      term,
      "123456",
      (data) => {
        writes.push(data);
      },
      "123456".length,
    );
    enqueueCoalescedTerminalWrite(
      term,
      "abcdef",
      (data) => {
        writes.push(data);
      },
      "abcdef".length,
    );
    frames.splice(0).forEach((frame) => frame(0));
    // First chunk flushed on cap pressure while still hidden; second may wait
    // under the gate if it alone is within the cap.
    assert.equal(writes.join(""), "123456");
    flushTerminalWriteCoalescer(term);
  });

  assert.equal(writes.join(""), "123456abcdef");

  resetTerminalWriteCoalescer(term);
});

test("oversized coalesced output drains while hidden instead of unbounded hold", () => {
  const term = createFakeTerm();
  const writes: string[] = [];
  const isPaneVisible = false;

  setTerminalWriteCoalescerByteCapResolver(term, () => 4);
  setTerminalWriteCoalescerFlushGate(term, () => isPaneVisible);
  withQueuedAnimationFrame((frames) => {
    enqueueCoalescedTerminalWrite(
      term,
      "oversized",
      (data) => {
        writes.push(data);
      },
      "oversized".length,
    );
    frames.splice(0).forEach((frame) => frame(0));
  });

  assert.equal(writes.join(""), "oversized");
  assert.ok(writes.length >= 1);

  resetTerminalWriteCoalescer(term);
});

test("abort clears alt-screen latch even when no coalescer was created", () => {
  const term = {
    buffer: { active: { type: "normal" as string } },
  } as unknown as XTerm;
  const writes: string[] = [];
  const frames: Array<FrameRequestCallback> = [];
  const microtasks: Array<() => void> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;

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

  try {
    // Cap below the enter-alt payload so the direct oversized path probes latch
    // without creating a coalescer.
    setTerminalWriteCoalescerByteCapResolver(term, () => 4);
    enqueueCoalescedTerminalWrite(term, "\x1b[?1049hframe", (data) => {
      writes.push(data);
    });
    // Drop before xterm would parse — latch must not stick for later shell output.
    abortTerminalWriteCoalescer(term);
    writes.length = 0;
    frames.length = 0;
    microtasks.length = 0;

    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    enqueueCoalescedTerminalWrite(term, "shell", (data) => {
      writes.push(data);
    });
    assert.equal(frames.length, 0, "abort must clear enter-alt latch");
    assert.equal(microtasks.length, 1, "normal-screen follow-up should use microtask");
    microtasks[0]!();
    assert.deepEqual(writes, ["shell"]);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("hidden oversized enter-alt still latches rAF for follow-up after reveal", () => {
  const term = {
    buffer: { active: { type: "normal" as string } },
  } as unknown as XTerm;
  const writes: string[] = [];
  let isPaneVisible = false;
  const frames: Array<FrameRequestCallback> = [];
  const microtasks: Array<() => void> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;

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

  try {
    // Cap below enter-alt payload: size cap drains while hidden, but enter-alt
    // probing must still latch rAF for later under-cap repaints.
    setTerminalWriteCoalescerByteCapResolver(term, () => 4);
    setTerminalWriteCoalescerFlushGate(term, () => isPaneVisible);

    enqueueCoalescedTerminalWrite(term, "\x1b[?1049hframe", (data) => {
      writes.push(data);
    });
    frames.splice(0).forEach((frame) => frame(0));
    microtasks.splice(0).forEach((task) => task());
    assert.equal(writes.join(""), "\x1b[?1049hframe");
    writes.length = 0;
    frames.length = 0;
    microtasks.length = 0;

    isPaneVisible = true;
    // Buffer still reports normal until xterm parses; latch must force rAF.
    // Raise the cap so the follow-up uses normal scheduling (not cap flush).
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    enqueueCoalescedTerminalWrite(term, "\x1b[Hrepaint", (data) => {
      writes.push(data);
    });
    assert.equal(frames.length, 1, "follow-up after hidden enter-alt must use rAF");
    assert.equal(microtasks.length, 0, "must not fall back to microtask after enter-alt latch");
    frames[0]!(0);
    assert.deepEqual(writes, ["\x1b[Hrepaint"]);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("splits large plain terminal output into cooperative chunks", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = `${Array.from(
    { length: Math.ceil((MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES * 2 + 5000) / 1001) },
    () => "x".repeat(1000),
  ).join("\n")}\n12345`;

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, ingressBytes, options) => {
      writes.push({ data, ingressBytes, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [
      MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
      payload.length - (MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES * 2),
    ],
  );
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  // Plain multi-line shards yield after every intermediate slice so seq/log
  // floods leave the event loop (Tabby ~128KB cadence).
  assert.deepEqual(
    writes.map((write) => write.options),
    [
      { yieldAfter: true },
      { yieldAfter: true },
      undefined,
    ],
  );

  resetTerminalWriteCoalescer(term);
});

test("splits long unbroken plain terminal output into Tabby-sized shards with per-slice yield", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = "x".repeat(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES * 4 + 11);

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, ingressBytes, options) => {
      writes.push({ data, ingressBytes, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      11,
    ],
  );
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  assert.equal(writes.map((write) => write.data).join(""), payload);
  // Plain output yields after every intermediate shard for UI responsiveness.
  assert.deepEqual(
    writes.map((write) => write.options?.yieldAfter === true),
    [true, true, true, true, false],
  );

  resetTerminalWriteCoalescer(term);
});

test("splits newline-terminated long plain output into Tabby-sized shards with per-slice yield", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = `${"x".repeat(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES * 4)}\n`;

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, ingressBytes, options) => {
      writes.push({ data, ingressBytes, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(
    writes.map((write) => write.data.length),
    [
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
      1,
    ],
  );
  assert.equal(writes.map((write) => write.data).join(""), payload);
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  assert.deepEqual(
    writes.map((write) => write.options?.yieldAfter === true),
    [true, true, true, true, false],
  );

  resetTerminalWriteCoalescer(term);
});

test("keeps control-sequence terminal batches intact up to the coalescing cap", () => {
  const term = createFakeTerm();
  const writes: Array<{ data: string; options?: CoalescedTerminalWriteOptions }> = [];
  const payload = `\x1b[?2026h${"x".repeat(MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES * 2)}\x1b[?2026l`;

  setTerminalWriteCoalescerByteCapResolver(term, () => payload.length + 100);
  enqueueCoalescedTerminalWrite(
    term,
    payload,
    (data, _ingressBytes, options) => {
      writes.push({ data, options });
    },
    payload.length,
  );
  flushTerminalWriteCoalescer(term);

  assert.deepEqual(writes.map((write) => write.data.length), [payload.length]);
  assert.deepEqual(writes.map((write) => write.options), [undefined]);

  resetTerminalWriteCoalescer(term);
});

test("uses the latest coalesced writer when pending output is flushed", () => {
  const term = createFakeTerm();
  const firstWriter: string[] = [];
  const secondWriter: string[] = [];

  setTerminalWriteCoalescerByteCapResolver(term, () => 100);
  withAnimationFrameQueue(() => {
    enqueueCoalescedTerminalWrite(
      term,
      "pending",
      (data) => {
        firstWriter.push(data);
      },
      "pending".length,
    );
    enqueueCoalescedTerminalWrite(
      term,
      " output",
      (data) => {
        secondWriter.push(data);
      },
      " output".length,
    );
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(firstWriter, []);
  assert.deepEqual(secondWriter, ["pending output"]);

  resetTerminalWriteCoalescer(term);
});

test("retains incomplete alt-screen CSI across coalescer flushes", () => {
  const term = {
    buffer: { active: { type: "normal" } },
  } as unknown as XTerm;
  const writes: string[] = [];
  const frames: Array<FrameRequestCallback> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;
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

  try {
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    enqueueCoalescedTerminalWrite(term, "\x1b[?104", (data) => {
      writes.push(data);
    });
    assert.equal(frames.length, 1);
    frames[0]!(0);
    assert.deepEqual(writes, ["\x1b[?104"]);
    frames.length = 0;
    microtasks.length = 0;

    // After flush, the incomplete CSI tail must still force rAF for the suffix.
    enqueueCoalescedTerminalWrite(term, "9hframe", (data) => {
      writes.push(data);
    });
    assert.equal(frames.length, 1);
    assert.equal(microtasks.length, 0);
    frames[0]!(0);
    assert.deepEqual(writes, ["\x1b[?104", "9hframe"]);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("upgrades to rAF when alternate-screen CSI is split across PTY chunks", () => {
  const term = {
    buffer: { active: { type: "normal" } },
  } as unknown as XTerm;
  const writes: string[] = [];
  const frames: Array<FrameRequestCallback> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;
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

  try {
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    // Incomplete CSI private mode — should already prefer rAF (pending tail).
    enqueueCoalescedTerminalWrite(term, "\x1b[?104", (data) => {
      writes.push(data);
    });
    assert.equal(frames.length, 1);
    assert.equal(microtasks.length, 0);
    assert.equal(shouldPreserveTerminalWriteFrameBatch(term), true);

    enqueueCoalescedTerminalWrite(term, "9hframe", (data) => {
      writes.push(data);
    });
    assert.equal(frames.length, 1);
    assert.equal(shouldPreserveTerminalWriteFrameBatch(term), true);
    frames[0]!(0);
    assert.deepEqual(writes, ["\x1b[?1049hframe"]);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("leave-alt CSI clears latch even while buffer still reports alternate", () => {
  const term = {
    buffer: { active: { type: "alternate" as string } },
  } as unknown as XTerm;
  const frames: Array<FrameRequestCallback> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;
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

  try {
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    // Simulate prior enter latch while already on alternate buffer.
    enqueueCoalescedTerminalWrite(term, "\x1b[?1049h", () => {});
    frames[0]!(0);
    frames.length = 0;
    microtasks.length = 0;

    enqueueCoalescedTerminalWrite(term, "\x1b[?1049l", () => {});
    frames[0]!(0);
    frames.length = 0;
    microtasks.length = 0;

    // Buffer flips to normal after leave is written; latch must be gone.
    (term.buffer.active as { type: string }).type = "normal";
    enqueueCoalescedTerminalWrite(term, "shell after tui", () => {});
    assert.equal(microtasks.length, 1);
    assert.equal(frames.length, 0);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("enter-then-leave in one chunk does not latch rAF forever", () => {
  const term = {
    buffer: { active: { type: "normal" as string } },
  } as unknown as XTerm;
  const frames: Array<FrameRequestCallback> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;
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

  try {
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    enqueueCoalescedTerminalWrite(term, "\x1b[?1049hframe\x1b[?1049l", () => {});
    // Final transition is leave → no pending latch; schedule may be microtask.
    if (frames.length > 0) {
      frames[0]!(0);
    } else {
      assert.ok(microtasks.length >= 1);
      for (const task of microtasks.splice(0)) task();
    }
    frames.length = 0;
    microtasks.length = 0;

    enqueueCoalescedTerminalWrite(term, "ordinary shell output", () => {});
    assert.equal(microtasks.length, 1);
    assert.equal(frames.length, 0);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("keeps rAF latched after enter-alt CSI until buffer flips", () => {
  const term = {
    buffer: { active: { type: "normal" as string } },
  } as unknown as XTerm;
  const writes: string[] = [];
  const frames: Array<FrameRequestCallback> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;
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

  try {
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    enqueueCoalescedTerminalWrite(term, "\x1b[?1049h", (data) => {
      writes.push(data);
    });
    frames[0]!(0);
    frames.length = 0;
    microtasks.length = 0;

    // xterm still reports normal until deferred parse; repaint must stay on rAF.
    enqueueCoalescedTerminalWrite(term, "\x1b[Hrepaint", (data) => {
      writes.push(data);
    });
    assert.equal(frames.length, 1);
    assert.equal(microtasks.length, 0);
    frames[0]!(0);
    assert.deepEqual(writes, ["\x1b[?1049h", "\x1b[Hrepaint"]);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("schedules rAF for 8-bit C1 CSI alternate-screen entry", () => {
  const term = {
    buffer: { active: { type: "normal" } },
  } as unknown as XTerm;
  const writes: string[] = [];
  const frames: Array<FrameRequestCallback> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;
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

  try {
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    enqueueCoalescedTerminalWrite(
      term,
      "\x9b?1049hframe",
      (data) => {
        writes.push(data);
      },
    );
    assert.equal(frames.length, 1);
    assert.equal(microtasks.length, 0);
    frames[0]!(0);
    assert.deepEqual(writes, ["\x9b?1049hframe"]);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("schedules rAF for chunks that enter the alternate screen from the normal buffer", () => {
  const term = {
    buffer: { active: { type: "normal" } },
  } as unknown as XTerm;
  const writes: string[] = [];
  const frames: Array<FrameRequestCallback> = [];
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const originalMicrotask = globalThis.queueMicrotask;

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
  // Keep microtask available so normal-mode would choose it; alt enter must
  // still force rAF.
  globalThis.queueMicrotask = originalMicrotask;

  try {
    setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
    enqueueCoalescedTerminalWrite(
      term,
      "\x1b[?1049h\x1b[H\x1b[2Jframe",
      (data) => {
        writes.push(data);
      },
    );
    assert.equal(frames.length, 1);
    assert.deepEqual(writes, []);
    frames[0]!(0);
    assert.deepEqual(writes, ["\x1b[?1049h\x1b[H\x1b[2Jframe"]);
  } finally {
    resetTerminalWriteCoalescer(term);
    globalThis.queueMicrotask = originalMicrotask;
    if (originalRaf) {
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    }
    if (originalCancel) {
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    } else {
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  }
});

test("resolveFloodCoalescerByteCap keeps bulk batches while flow is paused (#1961)", () => {
  // Paused drain must not shrink to tiny flood shards — that multiplies
  // pause/resume RTTs on WAN SSH for `tail -2000f` style dumps.
  assert.equal(
    resolveFloodCoalescerByteCap(true, false),
    MAX_PENDING_WRITE_COALESCE_BYTES,
  );
  assert.equal(
    resolveFloodCoalescerByteCap(true, true),
    MAX_PENDING_WRITE_COALESCE_BYTES,
  );
  assert.equal(
    resolveFloodCoalescerByteCap(false, true),
    MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  );
  assert.equal(
    resolveFloodCoalescerByteCap(false, false),
    MAX_PENDING_WRITE_COALESCE_BYTES,
  );
  assert.ok(MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD >= 64 * 1024);
  assert.ok(MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD < MAX_PENDING_WRITE_COALESCE_BYTES);
});

test("enqueue performs one alt-screen CSI scan per chunk", () => {
  const term = createFakeTerm();
  resetAltScreenProbeScanCountForTests();
  setTerminalWriteCoalescerByteCapResolver(term, () => 64 * 1024);
  withAnimationFrameQueue(() => {
    enqueueCoalescedTerminalWrite(
      term,
      "\x1b[?1049hframe",
      () => {},
      "\x1b[?1049hframe".length,
    );
    flushTerminalWriteCoalescer(term);
  });

  assert.equal(
    getAltScreenProbeScanCountForTests(),
    1,
    "frame split + schedule latch must share one probe pass",
  );
  resetTerminalWriteCoalescer(term);
  resetAltScreenProbeScanCountForTests();
});
