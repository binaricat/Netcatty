import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  enqueueTerminalWrite,
  isXtermWriteBufferIdle,
  setTerminalWriteQueueDropHandler,
  WRITE_QUEUE_STALL_TIMEOUT_MS,
  type TerminalWriteSignal,
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
 * force-completes an active item that has made no progress, has nothing
 * scheduled, *and* whose xterm write buffer is idle — acknowledging its bytes
 * once so flow control recovers without double-acking a late real callback.
 */

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const makeTerm = (): XTerm => ({}) as XTerm;

type PendingBufferTerm = XTerm & {
  _core: {
    _writeBuffer: {
      _pendingData: number;
      _writeBuffer: Array<string | Uint8Array>;
      _bufferOffset: number;
    };
  };
};

const makeBusyTerm = (pendingData: number): PendingBufferTerm => ({
  _core: {
    _writeBuffer: {
      _pendingData: pendingData,
      _writeBuffer: [],
      _bufferOffset: 0,
    },
  },
}) as PendingBufferTerm;

test("a write whose callback never fires does not wedge the queue forever", async () => {
  const term = makeTerm();
  const ran: number[] = [];
  const dropped: number[] = [];
  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));

  // The first write simulates a lost xterm callback: it runs, but its `done`
  // is never called. Term has no write buffer → treated as idle.
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

test("late callback after watchdog cannot re-claim flow ack (no double-ack)", async () => {
  const term = makeTerm();
  const dropped: number[] = [];
  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));

  let signal: TerminalWriteSignal | undefined;
  let stalledDone: (() => void) | undefined;
  enqueueTerminalWrite(term, 4096, (done, sig) => {
    signal = sig;
    stalledDone = done;
  }, { dropBytes: 4096 });

  enqueueTerminalWrite(term, 10, (done) => { done(); });

  await settle(WRITE_QUEUE_STALL_TIMEOUT_MS + 300);
  assert.deepEqual(dropped, [4096], "watchdog claims and acks once");
  assert.equal(signal?.isCancelled(), true);
  assert.equal(
    signal?.tryClaimFlowAck(), false,
    "late path must not re-claim after watchdog"
  );

  // Late real callback still calls done; queue must ignore it.
  stalledDone?.();
  await settle(50);
  assert.deepEqual(dropped, [4096], "no second onDropped from late done");
});

test("watchdog requeues unstarted flood-merged steps instead of ACKing them", async () => {
  const term = makeTerm();
  const dropped: number[] = [];
  const ran: number[] = [];
  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));

  // Flood merge into one active multi-step item: stall on step 0, keep steps 1-2
  // unwritten. Watchdog must ACK only step 0 and requeue the rest.
  for (let i = 0; i < 3; i += 1) {
    enqueueTerminalWrite(term, 100, (done) => {
      ran.push(i);
      if (i === 0) return; // lost callback on first step only
      setTimeout(done, 0);
    }, { dropBytes: 100 });
  }

  await settle(50);
  assert.deepEqual(ran, [0], "only the first merged step has started");

  await settle(WRITE_QUEUE_STALL_TIMEOUT_MS + 300);
  assert.deepEqual(dropped, [100], "only the dispatched step is flow-acked");
  assert.deepEqual(ran, [0, 1, 2], "unstarted tail is requeued and still runs");
});

test("watchdog does not force-complete while xterm write buffer is still busy", async () => {
  const term = makeBusyTerm(8192);
  assert.equal(isXtermWriteBufferIdle(term), false);

  const ran: number[] = [];
  const dropped: number[] = [];
  setTerminalWriteQueueDropHandler(term, (bytes) => dropped.push(bytes));

  let release: (() => void) | undefined;
  enqueueTerminalWrite(term, 4096, (done) => {
    ran.push(0);
    release = done;
  });
  enqueueTerminalWrite(term, 10, (done) => {
    ran.push(1);
    done();
  });

  // Well past one stall timeout: still busy inside xterm → must not recover yet.
  await settle(WRITE_QUEUE_STALL_TIMEOUT_MS + 100);
  assert.deepEqual(ran, [0], "must not advance while xterm is still parsing");
  assert.deepEqual(dropped, [], "must not drop/ack a still-in-flight write");

  // Buffer drains (xterm finished parse) but callback still missing → now recover.
  term._core._writeBuffer._pendingData = 0;
  await settle(WRITE_QUEUE_STALL_TIMEOUT_MS + 200);
  assert.deepEqual(ran, [0, 1], "recovers once xterm is idle with no callback");
  assert.deepEqual(dropped, [4096]);

  // Late callback after recovery is a no-op for the queue.
  release?.();
  await settle(20);
  assert.deepEqual(ran, [0, 1]);
});
