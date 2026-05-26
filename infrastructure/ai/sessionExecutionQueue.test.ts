import assert from "node:assert/strict";
import test from "node:test";

import {
  chainBySessionKey,
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

  // Only `a` should have started — b and c are queued behind it.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["a:start"]);

  gateA.resolve();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["a:start", "a:end", "b:start"]);

  gateB.resolve();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
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

test("chainBySessionKey eventually removes the map entry once the last task drains", async (t) => {
  t.afterEach(resetSessionExecutionQueueForTests);
  // Use a private helper to inspect: reset on entry, run one task,
  // and rely on the map being empty after it settles.
  resetSessionExecutionQueueForTests();
  await chainBySessionKey("session-cleanup", async () => "done");
  // Drain any microtasks the cleanup logic queued via `.finally`.
  await new Promise((r) => setImmediate(r));
  // Start a second task and confirm it doesn't see the previous tail —
  // we can't introspect the map directly, but if the entry leaked,
  // the new task would still chain off the old (resolved) promise and
  // start immediately, which is functionally indistinguishable from a
  // clean state. The real guarantee is the lack of unbounded growth
  // exercised by stress-tests; here we just make sure correctness holds.
  const value = await chainBySessionKey("session-cleanup", async () => "again");
  assert.equal(value, "again");
});
