import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_WRITE_QUEUE_ITEMS,
  abortTerminalWriteQueue,
  enqueueTerminalWrite,
  flushTerminalWriteQueueBypassingTimers,
  getTerminalWriteQueueDepth,
  isTerminalWriteQueueInFloodMode,
  setTerminalWriteQueueDropHandler,
} from "./terminalWriteQueue.ts";

const createFakeTerm = () => ({}) as XTerm;
const waitForQueuedWriteYield = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};
const waitForQueuedWrites = async (count: number) => {
  for (let index = 0; index < count; index += 1) {
    await waitForQueuedWriteYield();
  }
};

test("enqueueTerminalWrite serializes writes in order", () => {
  const term = createFakeTerm();
  const order: number[] = [];

  enqueueTerminalWrite(term, 1, (done) => {
    order.push(1);
    done();
  });
  enqueueTerminalWrite(term, 1, (done) => {
    order.push(2);
    done();
  });

  assert.deepEqual(order, [1, 2]);
});

test("deferStart queues a write until the next task", async () => {
  const term = createFakeTerm();
  const order: number[] = [];

  enqueueTerminalWrite(term, 1, (done) => {
    order.push(1);
    done();
  }, { deferStart: true });

  assert.deepEqual(order, []);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.deepEqual(order, [1]);
});

test("yieldAfter lets the event loop run between queued write chunks", async () => {
  const term = createFakeTerm();
  const order: number[] = [];

  enqueueTerminalWrite(term, 1, (done) => {
    order.push(1);
    done();
  }, { deferStart: true, yieldAfter: true });
  enqueueTerminalWrite(term, 1, (done) => {
    order.push(2);
    done();
  });

  await waitForQueuedWriteYield();
  assert.deepEqual(order, [1]);
  await waitForQueuedWriteYield();
  assert.deepEqual(order, [1, 2]);
});

test("flushTerminalWriteQueueBypassingTimers drains deferred queue steps immediately", () => {
  const term = createFakeTerm();
  const order: number[] = [];

  enqueueTerminalWrite(term, 1, (done) => {
    order.push(1);
    done();
  }, { deferStart: true, yieldAfter: true });
  enqueueTerminalWrite(term, 1, (done) => {
    order.push(2);
    done();
  });

  assert.deepEqual(order, []);
  assert.equal(flushTerminalWriteQueueBypassingTimers(term), true);
  assert.deepEqual(order, [1, 2]);
  assert.equal(flushTerminalWriteQueueBypassingTimers(term), false);
});

test("marks flood mode and coalesces queued writes when item cap is exceeded", async () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { onDropped: (bytes) => dropped.push(bytes) },
    );
  }

  assert.deepEqual(dropped, []);
  assert.equal(isTerminalWriteQueueInFloodMode(term), true);
  assert.equal(getTerminalWriteQueueDepth(term), 1);
  releaseFirst?.();
  await waitForQueuedWrites(MAX_WRITE_QUEUE_ITEMS + 1);
  assert.deepEqual(order, Array.from({ length: MAX_WRITE_QUEUE_ITEMS + 1 }, (_, index) => index));
});

test("setTerminalWriteQueueDropHandler only reports explicit queue aborts", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  let completed = 0;
  let releaseFirst: (() => void) | null = null;

  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));
  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(term, 10, (done) => {
      completed += 1;
      done();
    });
  }

  assert.deepEqual(dropped, []);
  assert.equal(isTerminalWriteQueueInFloodMode(term), true);
  abortTerminalWriteQueue(term);
  assert.deepEqual(dropped, [MAX_WRITE_QUEUE_ITEMS * 10 + 10]);
  releaseFirst?.();
  assert.equal(completed, 0);
});

test("abortTerminalWriteQueue cancels remaining merged writes while one is in flight", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        if (index === 0) {
          abortTerminalWriteQueue(term, (bytes) => dropped.push(bytes));
        }
        done();
      },
    );
  }

  releaseFirst?.();

  assert.deepEqual(order, [0]);
  assert.deepEqual(dropped, [MAX_WRITE_QUEUE_ITEMS * 10]);
});

test("aborted yield timers do not clear a replacement write queue", async () => {
  const term = createFakeTerm();
  const order: string[] = [];
  let releaseReplacement: (() => void) | null = null;

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(`old-${index}`);
        done();
      },
      { deferStart: true, yieldAfter: true },
    );
  }

  await waitForQueuedWriteYield();
  assert.deepEqual(order, ["old-0"]);
  abortTerminalWriteQueue(term);

  enqueueTerminalWrite(term, 10, (done) => {
    order.push("replacement-active");
    releaseReplacement = done;
  });
  await waitForQueuedWriteYield();
  enqueueTerminalWrite(term, 10, (done) => {
    order.push("replacement-pending");
    done();
  });

  assert.deepEqual(order, ["old-0", "replacement-active"]);
  releaseReplacement?.();
  assert.deepEqual(order, ["old-0", "replacement-active", "replacement-pending"]);
});

test("merges passive flood backlog items without dropping output", async () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  enqueueTerminalWrite(term, 10, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 10; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { onDropped: (bytes) => dropped.push(bytes) },
    );
  }

  assert.equal(getTerminalWriteQueueDepth(term) < MAX_WRITE_QUEUE_ITEMS + 10, true);
  assert.deepEqual(dropped, []);
  releaseFirst?.();
  await waitForQueuedWrites(MAX_WRITE_QUEUE_ITEMS + 10);
  assert.deepEqual(order, Array.from({ length: MAX_WRITE_QUEUE_ITEMS + 10 }, (_, index) => index));
});

test("merged flood backlog still yields between synchronous write steps", async () => {
  const term = createFakeTerm();
  const order: number[] = [];

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { deferStart: true, yieldAfter: true },
    );
  }

  assert.equal(getTerminalWriteQueueDepth(term), 1);
  await waitForQueuedWriteYield();
  assert.deepEqual(order, [0]);
  await waitForQueuedWriteYield();
  assert.deepEqual(order, [0, 1]);
});

test("merged flood of many tiny sync steps does not blow the call stack", async () => {
  const term = createFakeTerm();
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;
  const stepCount = 10_000;

  enqueueTerminalWrite(term, 1, (done) => {
    releaseFirst = done;
  });
  for (let index = 0; index < stepCount; index += 1) {
    enqueueTerminalWrite(term, 1, (done) => {
      order.push(index);
      done();
    });
  }

  assert.equal(isTerminalWriteQueueInFloodMode(term), true);
  assert.doesNotThrow(() => {
    releaseFirst?.();
  });
  // Cooperative yields every 32 sync hops — drain with timer flushes.
  for (let guard = 0; guard < 500 && order.length < stepCount; guard += 1) {
    await waitForQueuedWriteYield();
  }
  assert.equal(order.length, stepCount);
  assert.equal(order[0], 0);
  assert.equal(order[stepCount - 1], stepCount - 1);
});

test("merged flood backlog honors per-step yieldAfter, not every shard", async () => {
  const term = createFakeTerm();
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  // Hold the first write so later shards merge into one flood item.
  enqueueTerminalWrite(term, 1, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    // Only every 4th step asks to yield — merge must preserve that, not force
    // a timer after each shard (writeLargeTerminalBatch drain-budget pacing).
    const yieldAfter = index % 4 === 3;
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { yieldAfter },
    );
  }

  assert.equal(getTerminalWriteQueueDepth(term), 1);
  assert.equal(isTerminalWriteQueueInFloodMode(term), true);
  assert.deepEqual(order, []);

  releaseFirst?.();
  // First four shards run in one turn (yieldAfter only on index 3).
  assert.deepEqual(order, [0, 1, 2, 3]);
  await waitForQueuedWriteYield();
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("flushTerminalWriteQueueBypassingTimers drains merged flood backlog without timer yields", () => {
  const term = createFakeTerm();
  const order: number[] = [];

  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS + 1; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { deferStart: true, yieldAfter: true },
    );
  }

  assert.equal(getTerminalWriteQueueDepth(term), 1);
  assert.equal(flushTerminalWriteQueueBypassingTimers(term), true);
  assert.deepEqual(order, Array.from({ length: MAX_WRITE_QUEUE_ITEMS + 1 }, (_, index) => index));
});

test("write queue yields when a drain reaches its byte budget", async () => {
  const term = createFakeTerm();
  const order: number[] = [];
  let releaseFirst: (() => void) | null = null;

  enqueueTerminalWrite(term, 0, (done) => {
    releaseFirst = done;
  });

  for (let index = 0; index < 4; index += 1) {
    enqueueTerminalWrite(
      term,
      10,
      (done) => {
        order.push(index);
        done();
      },
      { maxDrainBytes: 20 },
    );
  }

  assert.deepEqual(order, []);
  releaseFirst?.();
  assert.deepEqual(order, [0, 1]);
  await waitForQueuedWriteYield();
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("abortTerminalWriteQueue drops pending bytes and reports dropped count", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];
  let started = false;

  enqueueTerminalWrite(term, 40, () => {
    started = true;
  });
  enqueueTerminalWrite(term, 60, () => {}, { onDropped: (bytes) => dropped.push(bytes) });
  abortTerminalWriteQueue(term, (bytes) => dropped.push(bytes));

  assert.equal(started, true);
  assert.deepEqual(dropped, [60]);
});

test("abortTerminalWriteQueue reports ingress accounting instead of display scheduling bytes", () => {
  const term = createFakeTerm();
  const dropped: number[] = [];

  enqueueTerminalWrite(term, 10, () => {});
  enqueueTerminalWrite(term, 3, () => {}, {
    dropBytes: 80,
    onDropped: (bytes) => dropped.push(bytes),
  });
  abortTerminalWriteQueue(term);

  assert.deepEqual(dropped, [80]);
});

test("replacePendingKey keeps only the newest pending frame and reports ingress bytes", () => {
  const term = createFakeTerm();
  const order: string[] = [];
  const dropped: number[] = [];
  let releaseActive: (() => void) | null = null;

  enqueueTerminalWrite(term, 1, (done) => {
    order.push("active");
    releaseActive = done;
  });
  enqueueTerminalWrite(term, 10, (done) => {
    order.push("old-frame");
    done();
  }, {
    dropBytes: 100,
    replacePendingKey: "tui-frame",
    onDropped: (bytes) => dropped.push(bytes),
  });
  enqueueTerminalWrite(term, 2, (done) => {
    order.push("ordinary-output");
    done();
  });
  enqueueTerminalWrite(term, 20, (done) => {
    order.push("new-frame");
    done();
  }, {
    dropBytes: 200,
    replacePendingKey: "tui-frame",
  });

  assert.deepEqual(order, ["active"]);
  assert.deepEqual(dropped, [100]);
  releaseActive?.();
  assert.deepEqual(order, ["active", "ordinary-output", "new-frame"]);
});

test("replacePendingKey removes superseded steps from a merged flood item", async () => {
  const term = createFakeTerm();
  const order: string[] = [];
  const dropped: number[] = [];
  let releaseActive: (() => void) | null = null;

  enqueueTerminalWrite(term, 1, (done) => {
    releaseActive = done;
  });
  enqueueTerminalWrite(term, 10, (done) => {
    order.push("old-frame");
    done();
  }, {
    dropBytes: 75,
    replacePendingKey: "tui-frame",
    onDropped: (bytes) => dropped.push(bytes),
  });
  for (let index = 0; index < MAX_WRITE_QUEUE_ITEMS; index += 1) {
    enqueueTerminalWrite(term, 1, (done) => {
      order.push(`ordinary-${index}`);
      done();
    });
  }
  assert.equal(isTerminalWriteQueueInFloodMode(term), true);
  assert.equal(getTerminalWriteQueueDepth(term), 1);

  enqueueTerminalWrite(term, 20, (done) => {
    order.push("new-frame");
    done();
  }, {
    dropBytes: 125,
    replacePendingKey: "tui-frame",
  });

  assert.deepEqual(dropped, [75]);
  releaseActive?.();
  for (let guard = 0; guard < 10 && order.length < MAX_WRITE_QUEUE_ITEMS + 1; guard += 1) {
    await waitForQueuedWriteYield();
  }
  assert.equal(order.includes("old-frame"), false);
  assert.equal(order.filter((entry) => entry.startsWith("ordinary-")).length, MAX_WRITE_QUEUE_ITEMS);
  assert.equal(order.at(-1), "new-frame");
});
