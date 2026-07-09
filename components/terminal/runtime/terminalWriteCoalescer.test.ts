import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  abortTerminalWriteCoalescer,
  enqueueCoalescedTerminalWrite,
  flushTerminalWriteCoalescer,
  resetTerminalWriteCoalescer,
  resolveFloodCoalescerByteCap,
  setTerminalWriteCoalescerByteCapResolver,
  setTerminalWriteCoalescerFlushGate,
  type CoalescedTerminalWriteOptions,
} from "./terminalWriteCoalescer.ts";
import {
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
} from "./terminalFlowConstants.ts";

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

test("cap-triggered coalescer flushes wait until a hidden pane is visible", () => {
  const term = createFakeTerm();
  const writes: string[] = [];
  let isPaneVisible = false;

  setTerminalWriteCoalescerByteCapResolver(term, () => 10);
  setTerminalWriteCoalescerFlushGate(term, () => isPaneVisible);
  withQueuedAnimationFrame((frames) => {
    enqueueCoalescedTerminalWrite(
      term,
      "123456",
      () => {},
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

    assert.deepEqual(writes, []);

    isPaneVisible = true;
    flushTerminalWriteCoalescer(term);
  });

  assert.equal(writes.join(""), "123456abcdef");
  assert.deepEqual(writes.map((write) => write.length), [10, 2]);

  resetTerminalWriteCoalescer(term);
});

test("oversized coalesced output waits while hidden instead of writing directly", () => {
  const term = createFakeTerm();
  const writes: string[] = [];
  let isPaneVisible = false;

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

    assert.deepEqual(writes, []);

    isPaneVisible = true;
    flushTerminalWriteCoalescer(term);
  });

  assert.deepEqual(writes.join(""), "oversized");

  resetTerminalWriteCoalescer(term);
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
  assert.deepEqual(
    writes.map((write) => write.options),
    [
      { deferStart: true, yieldAfter: true },
      { deferStart: true, yieldAfter: true },
      { deferStart: true, yieldAfter: true },
    ],
  );

  resetTerminalWriteCoalescer(term);
});

test("splits long unbroken plain terminal output more conservatively", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = "x".repeat(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES * 2 + 11);

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
      11,
    ],
  );
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  assert.equal(writes.every((write) => write.options?.yieldAfter === true), true);

  resetTerminalWriteCoalescer(term);
});

test("splits newline-terminated long plain output more conservatively", () => {
  const term = createFakeTerm();
  const writes: Array<{
    data: string;
    ingressBytes: number;
    options?: CoalescedTerminalWriteOptions;
  }> = [];
  const payload = `${"x".repeat(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES * 2)}\n`;

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
      1,
    ],
  );
  assert.equal(writes.map((write) => write.data).join(""), payload);
  assert.deepEqual(writes.map((write) => write.ingressBytes), writes.map((write) => write.data.length));
  assert.equal(writes.every((write) => write.options?.yieldAfter === true), true);

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
