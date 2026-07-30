import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  enqueueTerminalWrite,
  setTerminalWriteQueueDropHandler,
  WRITE_QUEUE_STALL_TIMEOUT_MS,
} from "./terminalWriteQueue";

/**
 * Recovery from a lost xterm write callback.
 *
 * A queue item completes only when its `write` closure calls the `done` it is
 * handed, and that `done` is wired to xterm's `term.write(data, cb)` callback.
 * If xterm accepts the write, parses it (its buffer drains to empty), yet never
 * invokes `cb` — observed against a full-screen DEC 2026 TUI — the item never
 * completes: `queue.active` stays set, `queue.writing` stays true, and every
 * item behind it is stranded. Nothing reschedules it, because the queue is
 * waiting on a callback that will never arrive.
 *
 * Downstream this is a permanent freeze: the completion callback is where
 * `flow.written()` and the IPC ack live (terminalSessionAttachment), so the
 * renderer backlog never drains, the main process pauses the PTY at the high
 * watermark, and a TUI's own writes then block — its render loop stalls and its
 * keyboard goes dead.
 *
 * The queue must not depend solely on xterm's callback. A stall watchdog
 * force-completes an active item that has made no progress and has nothing
 * scheduled to make any, acknowledging its bytes so flow control recovers.
 */

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const makeTerm = (): XTerm => ({}) as XTerm;

test("a write whose callback never fires does not wedge the queue forever", async () => {
  const term = makeTerm();
  const ran: number[] = [];
  const dropped: number[] = [];
  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));

  // The first write simulates a lost xterm callback: it runs, but its `done`
  // is never called.
  enqueueTerminalWrite(term, 4096, () => { ran.push(0); });

  // Ordinary writes queued behind the stalled one.
  for (let i = 1; i <= 5; i += 1) {
    enqueueTerminalWrite(term, 4096, (done) => {
      ran.push(i);
      setTimeout(done, 0);
    });
  }

  // Before the watchdog: only the stalled write has run; the rest are stuck.
  await settle(50);
  assert.deepEqual(ran, [0], "writes behind a stalled one must not run yet");

  // After the watchdog fires: the queue recovers and drains the rest in order.
  await settle(WRITE_QUEUE_STALL_TIMEOUT_MS + 300);
  assert.deepEqual(
    ran, [0, 1, 2, 3, 4, 5],
    "queue must recover and drain the stranded writes"
  );
  assert.ok(
    dropped.reduce((a, b) => a + b, 0) > 0,
    "the stalled item's bytes must be acknowledged so flow control resumes"
  );
});

test("the watchdog leaves a healthy queue untouched", async () => {
  const term = makeTerm();
  const ran: number[] = [];
  const dropped: number[] = [];
  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));

  // Every write completes normally, some slowly but well within the timeout.
  for (let i = 0; i < 8; i += 1) {
    enqueueTerminalWrite(term, 4096, (done) => {
      ran.push(i);
      setTimeout(done, 5);
    }, { yieldAfter: i % 2 === 0 });
  }

  await settle(WRITE_QUEUE_STALL_TIMEOUT_MS + 300);
  assert.deepEqual(ran, [0, 1, 2, 3, 4, 5, 6, 7], "all writes ran");
  assert.equal(
    dropped.reduce((a, b) => a + b, 0), 0,
    "nothing must be dropped when the queue is healthy"
  );
});

test("a late callback after a watchdog recovery does not double-advance", async () => {
  const term = makeTerm();
  const ran: number[] = [];
  let stalledDone: (() => void) | undefined;

  // First write captures its done without calling it, then fires it LATE —
  // after the watchdog has already force-completed the item.
  enqueueTerminalWrite(term, 4096, (done) => { ran.push(0); stalledDone = done; });
  for (let i = 1; i <= 3; i += 1) {
    enqueueTerminalWrite(term, 4096, (done) => {
      ran.push(i);
      setTimeout(done, 0);
    });
  }

  await settle(WRITE_QUEUE_STALL_TIMEOUT_MS + 300);
  const afterRecovery = [...ran];
  // The real callback finally arrives; it must be a harmless no-op.
  stalledDone?.();
  await settle(100);

  assert.deepEqual(afterRecovery, [0, 1, 2, 3], "queue recovered before the late callback");
  assert.deepEqual(ran, [0, 1, 2, 3], "a late callback must not re-run or duplicate writes");
});
