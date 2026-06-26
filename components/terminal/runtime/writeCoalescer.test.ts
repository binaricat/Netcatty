import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  createWriteCoalescer,
  MAX_PENDING_WRITE_COALESCE_BYTES,
} from "./writeCoalescer.ts";

type ScheduledCallback = () => void;

let frameCallbacks: Map<number, ScheduledCallback>;
let timerCallbacks: Map<number, ScheduledCallback>;
let nextId: number;

const createTestCoalescer = (
  write: (data: string) => void,
  options: { maxFlushBytes?: number } = {},
) =>
  createWriteCoalescer(write, {
    maxFlushBytes: options.maxFlushBytes,
    scheduleFrame(callback) {
      const id = nextId;
      nextId += 1;
      frameCallbacks.set(id, callback);
      return () => {
        frameCallbacks.delete(id);
      };
    },
    scheduleTimer(callback) {
      const id = nextId;
      nextId += 1;
      timerCallbacks.set(id, callback);
      return () => {
        timerCallbacks.delete(id);
      };
    },
  });

const fireFrame = (): void => {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of callbacks) {
    callback();
  }
};

const fireTimer = (): void => {
  const callbacks = [...timerCallbacks.values()];
  timerCallbacks.clear();
  for (const callback of callbacks) {
    callback();
  }
};

beforeEach(() => {
  frameCallbacks = new Map();
  timerCallbacks = new Map();
  nextId = 1;
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
  fireTimer();
  assert.deepEqual(writes, ["pending"]);
});

test("flushes synchronously when pending bytes exceed the cap", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));
  const chunk = "x".repeat(MAX_PENDING_WRITE_COALESCE_BYTES);

  coalescer.push(chunk);
  coalescer.push("y");
  // Over the hard ceiling it flushes synchronously (no frame needed) and, since
  // the backlog far exceeds the per-write slice, drains the oversized chunk and
  // the tail as separate writes rather than one giant batch.
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.length, MAX_PENDING_WRITE_COALESCE_BYTES);
  assert.equal(writes[1], "y");
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

test("drains a backlog in bounded slices, never splitting a chunk", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data), {
    maxFlushBytes: 10,
  });

  coalescer.push("aaaa");
  coalescer.push("bbbb");
  coalescer.push("cccc");
  coalescer.push("dddd");
  fireFrame();

  // Batched on chunk boundaries without exceeding the 10-byte slice cap.
  assert.deepEqual(writes, ["aaaabbbb", "ccccdddd"]);
  assert.equal(writes.join(""), "aaaabbbbccccdddd");
});

test("emits an oversized single chunk whole rather than splitting it", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data), {
    maxFlushBytes: 10,
  });

  const big = "x".repeat(25);
  coalescer.push(big);
  coalescer.push("y");
  fireFrame();

  assert.deepEqual(writes, [big, "y"]);
});

test("timer flushes the backlog when the frame never fires (hidden window)", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));

  coalescer.push("background");
  // rAF stays throttled (no fireFrame) — the timer fallback must still drain.
  fireTimer();
  assert.deepEqual(writes, ["background"]);

  // The frame that lost the race was cancelled, so it cannot double-write.
  fireFrame();
  assert.deepEqual(writes, ["background"]);
});

test("a winning frame cancels the pending fallback timer", () => {
  const writes: string[] = [];
  const coalescer = createTestCoalescer((data) => writes.push(data));

  coalescer.push("once");
  fireFrame();
  fireTimer();

  assert.deepEqual(writes, ["once"]);
});
