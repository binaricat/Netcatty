import assert from "node:assert/strict";
import test from "node:test";

import {
  chainBySessionKey,
  getSessionExecutionQueueSizeForTests,
  reserveSessionSlot,
  resetSessionExecutionQueueForTests,
} from "./shared/sessionExecutionQueue";

function defer<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drain pending microtasks and immediates so cleanup `.finally`s have run.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

test("chainBySessionKey serializes calls sharing the same key in dispatch order", async (t) => {
  t.afterEach(resetSessionExecutionQueueForTests);
  const events: string[] = [];
  const gateA = defer();
  const gateB = defer();
  const gateC = defer();

  const a = chainBySessionKey("session-1", async () => {
    events.push("a:start");
    await gateA.promise;
    events.push("a:end");
    return "a";
  });
  const b = chainBySessionKey("session-1", async () => {
    events.push("b:start");
    await gateB.promise;
    events.push("b:end");
    return "b";
  });
  const c = chainBySessionKey("session-1", async () => {
    events.push("c:start");
    await gateC.promise;
    events.push("c:end");
    return "c";
  });

  await flushMicrotasks();
  assert.deepEqual(events, ["a:start"]);

  gateA.resolve();
  await flushMicrotasks();
  assert.deepEqual(events, ["a:start", "a:end", "b:start"]);

  gateB.resolve();
  await flushMicrotasks();
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end", "c:start"]);

  gateC.resolve();
  assert.equal(await a, "a");
  assert.equal(await b, "b");
  assert.equal(await c, "c");
});

test("chainBySessionKey does not let one task's rejection poison the next", async (t) => {
  t.afterEach(resetSessionExecutionQueueForTests);
  const a = chainBySessionKey("session-2", async () => {
    throw new Error("a boom");
  });
  const b = chainBySessionKey("session-2", async () => "b ok");

  await assert.rejects(a, /a boom/);
  assert.equal(await b, "b ok");
});

test("chainBySessionKey isolates work across keys (different sessions run in parallel)", async (t) => {
  t.afterEach(resetSessionExecutionQueueForTests);
  const gateA = defer();
  const gateB = defer();

  const a = chainBySessionKey("session-a", async () => {
    await gateA.promise;
    return "a";
  });
  const b = chainBySessionKey("session-b", async () => {
    await gateB.promise;
    return "b";
  });

  // Resolve B first; it should finish even though A is still blocked.
  gateB.resolve();
  assert.equal(await b, "b");
  gateA.resolve();
  assert.equal(await a, "a");
});

test("queue Map drops the entry once the last task drains", async (t) => {
  t.afterEach(resetSessionExecutionQueueForTests);
  resetSessionExecutionQueueForTests();
  assert.equal(getSessionExecutionQueueSizeForTests(), 0);
  await chainBySessionKey("session-cleanup", async () => "done");
  await flushMicrotasks();
  // Without the cleanup `finally`, the resolved tail would stay parked
  // in the map; this is the regression guard that the previous version
  // of this test was missing.
  assert.equal(getSessionExecutionQueueSizeForTests(), 0);
});

test("reserveSessionSlot fixes order at reservation time regardless of pre-work duration", async (t) => {
  t.afterEach(resetSessionExecutionQueueForTests);
  const events: string[] = [];

  // Simulate three tool_use calls firing in parallel where each has
  // some pre-work (e.g. an approval prompt) of varying length. The
  // serialized work order must still match the slot-reservation order.
  async function run(name: string, prework: Promise<void>) {
    const slot = reserveSessionSlot("session-order");
    try {
      events.push(`${name}:reserved`);
      await prework;
      events.push(`${name}:prework-done`);
      await slot.ready;
      events.push(`${name}:serial-start`);
      // Trivial serial work, just so we can observe the start order.
      await new Promise((r) => setImmediate(r));
      events.push(`${name}:serial-end`);
      return name;
    } finally {
      slot.release();
    }
  }

  const gateA = defer();
  const gateB = defer();
  const gateC = defer();
  const a = run("A", gateA.promise);
  const b = run("B", gateB.promise);
  const c = run("C", gateC.promise);

  // Approvals land in reverse order — C first, then B, then A.
  await flushMicrotasks();
  gateC.resolve();
  await flushMicrotasks();
  gateB.resolve();
  await flushMicrotasks();
  gateA.resolve();
  await flushMicrotasks();
  assert.deepEqual(await Promise.all([a, b, c]), ["A", "B", "C"]);

  const serialStarts = events.filter((e) => e.endsWith(":serial-start"));
  assert.deepEqual(
    serialStarts,
    ["A:serial-start", "B:serial-start", "C:serial-start"],
    `serial work ran in reservation order, not approval order; got: ${events.join(", ")}`,
  );
});

test("reserveSessionSlot lets later slots proceed once an early slot releases without serialized work", async (t) => {
  t.afterEach(resetSessionExecutionQueueForTests);
  const events: string[] = [];

  async function maybeRun(name: string, run: boolean) {
    const slot = reserveSessionSlot("session-skip");
    try {
      events.push(`${name}:reserved`);
      if (!run) return `${name}:skipped`;
      await slot.ready;
      events.push(`${name}:ran`);
      return `${name}:ran`;
    } finally {
      slot.release();
    }
  }

  // Slot A reserves but skips serial work (mimics user denying approval
  // or aborting). Slot B should still proceed.
  const a = maybeRun("A", false);
  const b = maybeRun("B", true);
  assert.equal(await a, "A:skipped");
  assert.equal(await b, "B:ran");
});
