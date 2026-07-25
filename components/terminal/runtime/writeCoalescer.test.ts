import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  createWriteCoalescer,
  MAX_PENDING_WRITE_COALESCE_BYTES,
  type WriteCoalescerOptions,
} from "./writeCoalescer.ts";

type FrameCallback = (time: number) => void;

let frameCallbacks: Map<number, FrameCallback>;
let timeoutCallbacks: Map<number, () => void>;
let nextFrameId: number;

const createTestCoalescer = (
  write: (data: string) => void,
  options: Omit<WriteCoalescerOptions, "scheduleFrame" | "scheduleTimeout"> = {},
) =>
  createWriteCoalescer(write, {
    ...options,
    scheduleFrame(callback) {
      const id = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(id, callback);
      return () => {
        frameCallbacks.delete(id);
      };
    },
    scheduleTimeout(callback) {
      const id = nextFrameId;
      nextFrameId += 1;
      timeoutCallbacks.set(id, callback);
      return () => {
        timeoutCallbacks.delete(id);
      };
    },
  });

const fireFrame = (): void => {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of callbacks) {
    callback(performance.now());
  }
};

const fireTimeout = (): void => {
  const callbacks = [...timeoutCallbacks.values()];
  timeoutCallbacks.clear();
  for (const callback of callbacks) {
    callback();
  }
};

beforeEach(() => {
  frameCallbacks = new Map();
  timeoutCallbacks = new Map();
  nextFrameId = 1;
});

test("coalesces chunks in the same frame into one write", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));

  coalescer.push("foo");
  coalescer.push("bar");
  coalescer.push("baz");
  assert.equal(writes.length, 0);

  fireFrame();
  assert.deepEqual(writes, ["foobarbaz"]);
});

test("microtask schedule mode flushes after the current turn without rAF", async () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data), {
    resolveScheduleMode: () => "microtask",
  });

  coalescer.push("a");
  coalescer.push("b");
  assert.equal(writes.length, 0);

  await Promise.resolve();
  assert.deepEqual(writes, ["ab"]);
  coalescer.dispose();
});

test("upgrades a pending microtask schedule to rAF when a later chunk requests it", () => {
  const writes: string[] = [];
  const microtasks: Array<() => void> = [];
  const frames: Array<() => void> = [];
  let modeForChunk = "microtask" as "microtask" | "raf";

  const originalMicrotask = globalThis.queueMicrotask;
  const originalRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  globalThis.queueMicrotask = (callback: () => void) => {
    microtasks.push(callback);
  };
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.push(() => callback(0));
      return frames.length;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => {},
  });

  try {
    const coalescer = createWriteCoalescer((data) => writes.push(data), {
      resolveScheduleMode: () => modeForChunk,
    });
    coalescer.push("shell");
    assert.equal(microtasks.length, 1);
    assert.equal(frames.length, 0);

    modeForChunk = "raf";
    coalescer.push("\x1b[?1049hTUI");
    // Microtask cancelled; rAF armed for the combined batch.
    assert.equal(frames.length, 1);
    assert.deepEqual(writes, []);

    // Cancelled microtask must not flush.
    for (const task of microtasks.splice(0)) task();
    assert.deepEqual(writes, []);

    frames[0]!();
    assert.deepEqual(writes, ["shell\x1b[?1049hTUI"]);
    coalescer.dispose();
  } finally {
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

test("coalesces a large TUI repaint until the scheduled frame", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));
  const chunk = "x".repeat(4 * 1024);

  for (let index = 0; index < 20; index += 1) {
    coalescer.push(chunk);
  }

  assert.equal(writes.length, 0);

  fireFrame();
  assert.deepEqual(writes.map((write) => write.length), [80 * 1024]);
});

test("schedules a new frame for data arriving after a flush", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));

  coalescer.push("first");
  fireFrame();
  coalescer.push("second");
  fireFrame();

  assert.deepEqual(writes, ["first", "second"]);
});

test("flushSync writes pending bytes immediately and cancels the scheduled frame", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));

  coalescer.push("pending");
  coalescer.flushSync();
  assert.deepEqual(writes, ["pending"]);

  fireFrame();
  assert.deepEqual(writes, ["pending"]);
});

test("flushes synchronously when pending bytes exceed the cap", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));
  const chunk = "x".repeat(MAX_PENDING_WRITE_COALESCE_BYTES);

  coalescer.push(chunk);
  coalescer.push("y");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.length, MAX_PENDING_WRITE_COALESCE_BYTES + 1);
});

test("uses a tighter pending-byte cap when getMaxPendingBytes is set", () => {
  const writes: string[] = [];
  const cap = 64;
  const coalescer = createTestCoalescer((data) => writes.push(data), {
    getMaxPendingBytes: () => cap,
  });

  coalescer.push("x".repeat(cap - 1));
  coalescer.push("yy");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.length, cap + 1);
});

test("byte-cap flushes even while scheduled frames are gated", () => {
  const writes: string[] = [];
  let canFlush = false;
  const cap = 8;
  const coalescer = createTestCoalescer((data) => writes.push(data), {
    getMaxPendingBytes: () => cap,
    shouldFlushScheduledFrame: () => canFlush,
  });

  // Under the cap: gated frame holds.
  coalescer.push("x".repeat(cap));
  fireFrame();
  assert.deepEqual(writes, []);

  // Past the cap: drain immediately so hidden log floods stay bounded.
  coalescer.push("y");
  assert.deepEqual(writes, ["x".repeat(cap) + "y"]);
});

test("still resolves schedule mode before gated under-cap frames and cap drains", () => {
  const writes: string[] = [];
  let canFlush = false;
  const probed: string[] = [];
  const cap = 8;
  const coalescer = createTestCoalescer((data) => writes.push(data), {
    getMaxPendingBytes: () => cap,
    shouldFlushScheduledFrame: () => canFlush,
    resolveScheduleMode: ({ nextChunk }) => {
      probed.push(nextChunk);
      return nextChunk.includes("\x1b[?1049h") ? "raf" : "microtask";
    },
  });

  // First chunk arms a gated under-cap frame; second exceeds cap and drains.
  // resolveScheduleMode must still run so enter-alt latches fire.
  coalescer.push("shell");
  coalescer.push(`\x1b[?1049h${"x".repeat(cap)}`);

  assert.deepEqual(probed, ["shell", `\x1b[?1049h${"x".repeat(cap)}`]);
  assert.equal(writes.join("").includes("\x1b[?1049h"), true);
  assert.equal(writes.join("").startsWith("shell"), true);
});

test("dispose flushes remaining bytes and stops accepting new chunks", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));

  coalescer.push("tail");
  coalescer.dispose();
  assert.deepEqual(writes, ["tail"]);

  coalescer.push("ignored");
  fireFrame();
  assert.deepEqual(writes, ["tail"]);
});

test("raf output drains when the animation frame callback never arrives", () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data), {
    scheduleFrame() {
      // Chromium can suppress an already-requested frame while a window is
      // occluded. Keep the callback pending forever to reproduce that edge.
      return () => {};
    },
    scheduleTimeout(callback) {
      timeoutCallbacks.set(1, callback);
      return () => timeoutCallbacks.delete(1);
    },
  });

  coalescer.push("stranded");
  assert.deepEqual(writes, []);

  fireTimeout();
  assert.deepEqual(writes, ["stranded"]);
  coalescer.dispose();
});

test("a gated frame keeps retrying until the terminal becomes visible", () => {
  const writes: string[] = [];
  let canFlush = false;
  const coalescer = createTestCoalescer((data) => writes.push(data), {
    shouldFlushScheduledFrame: () => canFlush,
  });

  coalescer.push("held");
  fireFrame();
  assert.deepEqual(writes, []);
  assert.equal(coalescer.pendingBytes(), 4);

  canFlush = true;
  fireTimeout();
  assert.deepEqual(writes, ["held"]);
  assert.equal(coalescer.pendingBytes(), 0);
  coalescer.dispose();
});

test("continuous sub-deadline chunks cannot postpone the wall-clock drain", () => {
  const writes: string[] = [];
  const coalescer = createWriteCoalescer((data) => writes.push(data), {
    scheduleFrame() {
      return () => {};
    },
    scheduleTimeout(callback) {
      timeoutCallbacks.set(1, callback);
      return () => timeoutCallbacks.delete(1);
    },
  });

  try {
    coalescer.push("a");
    for (let index = 0; index < 8; index += 1) {
      coalescer.push("x");
    }
    assert.equal(timeoutCallbacks.size, 1);
    fireTimeout();
    assert.ok(writes.length > 0, "continuous ingress must drain before it becomes idle");
  } finally {
    coalescer.dispose();
  }
});
