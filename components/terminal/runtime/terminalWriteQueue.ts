import type { Terminal as XTerm } from "@xterm/xterm";

import { MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES } from "./terminalFlowConstants";

export const MAX_WRITE_QUEUE_ITEMS = 32;
export const MAX_WRITE_QUEUE_BYTES = 512 * 1024;

/**
 * Soft wall-clock budget per event-loop turn of continuous write-queue drain.
 * After this, yield with setTimeout(0) so input/Ctrl-C can run — similar to
 * keeping the UI responsive without Tabby-style 4KB choppiness.
 */
export const WRITE_QUEUE_TURN_BUDGET_MS = 10;

/**
 * How long an active queue item may make no progress, with nothing scheduled to
 * make any, before the stall watchdog considers recovering it.
 *
 * The completion of an item depends on its write closure invoking the callback
 * it is handed, which in the real pipeline is wired to xterm's
 * `term.write(data, cb)`. A lost `cb` — xterm accepting and parsing a write yet
 * never firing its callback — would otherwise wedge the queue permanently.
 *
 * The watchdog is *not* time-only: it only force-completes when xterm's internal
 * write buffer is idle (drained). A slow parse that still holds pending data
 * re-arms the timer instead of treating the write as dropped. That keeps
 * legitimate multi-hundred-ms callbacks from defeating backpressure.
 *
 * Set above any legitimate single-write callback latency once xterm is idle,
 * yet short enough that a recovered stall reads as a brief hitch rather than a
 * freeze. Aligned with {@link LARGE_WRITE_FLUSH_WATCHDOG_MS} in the session
 * write path, which guards the same kind of stuck-write condition.
 */
export const WRITE_QUEUE_STALL_TIMEOUT_MS = 250;

/**
 * Signal handed to each write closure so flow-control acknowledgement is
 * exclusive between the normal completion path and the stall-watchdog /
 * drop-handler path. Callers that perform `flow.written` / IPC ack must claim
 * via {@link TerminalWriteSignal.tryClaimFlowAck} before acknowledging.
 */
export type TerminalWriteSignal = {
  /** True after the queue force-completed or aborted this item. */
  isCancelled: () => boolean;
  /**
   * Claim exclusive ownership of flow-control ack for this step's dropBytes.
   * Returns true only once — either the normal completion path or the
   * watchdog/drop path may claim it. Prevents double-ack when a late xterm
   * callback arrives after watchdog recovery.
   */
  tryClaimFlowAck: () => boolean;
};

export type TerminalWriteQueueOptions = {
  onDropped?: (bytes: number) => void;
  dropBytes?: number;
  deferStart?: boolean;
  yieldAfter?: boolean;
  maxDrainBytes?: number;
};

type QueuedWrite = {
  bytes: number;
  dropBytes: number;
  steps: QueuedWriteStep[];
  nextIndex: number;
  cancelled: boolean;
  yieldAfter: boolean;
  maxDrainBytes: number;
};

type QueuedWriteStep = {
  bytes: number;
  dropBytes: number;
  write: (done: () => void, signal: TerminalWriteSignal) => void;
  yieldAfter: boolean;
  /** Set once when this step's dropBytes are acknowledged (normal or drop path). */
  flowAckClaimed: boolean;
};

/** xterm.js private write-buffer shape used only to detect an idle drain. */
type XTermWithPrivateWriteBuffer = XTerm & {
  _core?: {
    _writeBuffer?: {
      _bufferOffset?: number;
      _pendingData?: number;
      _writeBuffer?: Array<string | Uint8Array>;
    };
  };
};

/**
 * True when xterm has no queued input left to parse. A missing private API
 * (tests / future xterm) is treated as idle so recovery still works; a
 * positive pending count means a write is still in flight and must not be
 * force-completed on elapsed time alone.
 */
export const isXtermWriteBufferIdle = (term: XTerm): boolean => {
  const writeBuffer = (term as XTermWithPrivateWriteBuffer)._core?._writeBuffer;
  if (!writeBuffer) return true;

  if (
    typeof writeBuffer._pendingData === "number"
    && Number.isFinite(writeBuffer._pendingData)
    && writeBuffer._pendingData > 0
  ) {
    return false;
  }

  const buffer = writeBuffer._writeBuffer;
  if (!Array.isArray(buffer) || buffer.length === 0) return true;
  const offset = typeof writeBuffer._bufferOffset === "number"
    && Number.isFinite(writeBuffer._bufferOffset)
    ? Math.max(0, writeBuffer._bufferOffset)
    : 0;
  return offset >= buffer.length;
};

const tryClaimStepFlowAck = (step: QueuedWriteStep): boolean => {
  if (step.flowAckClaimed) return false;
  step.flowAckClaimed = true;
  return true;
};

type TerminalWriteQueue = {
  writing: boolean;
  active?: QueuedWrite;
  pending: QueuedWrite[];
  pendingBytes: number;
  drainBytes: number;
  floodMode: boolean;
  turnStartedAt: number;
  onDropped?: (bytes: number) => void;
  drainTimer?: ReturnType<typeof setTimeout>;
  stepTimer?: ReturnType<typeof setTimeout>;
  stepContinuation?: () => void;
  stallWatchdog?: ReturnType<typeof setTimeout>;
  progressSeq: number;
};

const terminalWriteQueues = new WeakMap<XTerm, TerminalWriteQueue>();
const terminalWriteQueueDropHandlers = new WeakMap<XTerm, (bytes: number) => void>();

const getOrCreateQueue = (term: XTerm): TerminalWriteQueue => {
  let queue = terminalWriteQueues.get(term);
  if (!queue) {
    queue = {
      writing: false,
      pending: [],
      pendingBytes: 0,
      drainBytes: 0,
      floodMode: false,
      turnStartedAt: 0,
      onDropped: terminalWriteQueueDropHandlers.get(term),
      progressSeq: 0,
    };
    terminalWriteQueues.set(term, queue);
  }
  return queue;
};

const beginQueueTurn = (queue: TerminalWriteQueue): void => {
  if (queue.turnStartedAt <= 0) {
    queue.turnStartedAt = performance.now();
  }
};

const endQueueTurn = (queue: TerminalWriteQueue): void => {
  queue.turnStartedAt = 0;
};

const isQueueTurnBudgetExceeded = (queue: TerminalWriteQueue): boolean => {
  if (queue.turnStartedAt <= 0) return false;
  return performance.now() - queue.turnStartedAt >= WRITE_QUEUE_TURN_BUDGET_MS;
};

const clearStallWatchdog = (queue: TerminalWriteQueue): void => {
  if (queue.stallWatchdog !== undefined) {
    clearTimeout(queue.stallWatchdog);
    queue.stallWatchdog = undefined;
  }
};

/**
 * Claim dropBytes only for the currently dispatched step of a stalled item.
 * Flood merges put many unstarted steps after `nextIndex`; those have never
 * been written to xterm and must not be ACKed as dropped (Codex P1).
 * `nextIndex` points one past the dispatched step, hence `nextIndex - 1`.
 * Claiming here makes a late real callback's
 * {@link TerminalWriteSignal.tryClaimFlowAck} return false.
 */
const claimDispatchedStepBytesOf = (item: QueuedWrite): number => {
  const from = Math.max(0, item.nextIndex - 1);
  const step = item.steps[from];
  if (!step) {
    return item.dropBytes;
  }
  return tryClaimStepFlowAck(step) ? step.dropBytes : 0;
};

/**
 * Requeue steps that have not been written yet after a stall recovery on a
 * flood-merged item, so remaining chunks still reach xterm.
 */
const requeueUnstartedTail = (queue: TerminalWriteQueue, item: QueuedWrite): void => {
  const tail = item.steps.slice(item.nextIndex);
  if (tail.length === 0) return;
  let bytes = 0;
  let dropBytes = 0;
  for (const step of tail) {
    bytes += step.bytes;
    dropBytes += step.dropBytes;
  }
  queue.pending.unshift({
    bytes,
    dropBytes,
    steps: tail,
    nextIndex: 0,
    cancelled: false,
    yieldAfter: item.yieldAfter,
    maxDrainBytes: item.maxDrainBytes,
  });
  queue.pendingBytes += bytes;
};

/**
 * Arm a watchdog against a lost write callback wedging the queue. It fires only
 * when the same item is still active, has made no progress since it was armed,
 * has nothing scheduled to advance it, *and* xterm's write buffer is idle — a
 * genuine lost-callback stall, never a slow-but-progressing parse. On fire it
 * claims only the dispatched step's unacked bytes (so flow control resumes once,
 * not twice when a late callback arrives), requeues any unstarted merged tail,
 * and advances the queue.
 */
const armStallWatchdog = (
  term: XTerm,
  queue: TerminalWriteQueue,
  item: QueuedWrite,
): void => {
  clearStallWatchdog(queue);
  const progressAtArm = queue.progressSeq;
  queue.stallWatchdog = setTimeout(() => {
    queue.stallWatchdog = undefined;
    if (terminalWriteQueues.get(term) !== queue) return;
    if (
      queue.active !== item
      || item.cancelled
      || queue.progressSeq !== progressAtArm
      || queue.stepTimer !== undefined
      || queue.stepContinuation !== undefined
      || queue.drainTimer !== undefined
    ) {
      // Either the item advanced/completed, or something is scheduled to make
      // it advance. Not a stall — leave it be.
      return;
    }
    if (!isXtermWriteBufferIdle(term)) {
      // xterm is still parsing this write. Elapsed time alone is not evidence of
      // a lost callback — re-arm and wait for a real drain or real progress.
      armStallWatchdog(term, queue, item);
      return;
    }
    // Mark cancelled so a late real callback becomes a queue no-op, claim flow
    // ack only for the dispatched step, requeue unstarted flood-merge tail, then
    // advance.
    item.cancelled = true;
    const unacked = claimDispatchedStepBytesOf(item);
    requeueUnstartedTail(queue, item);
    queue.active = undefined;
    queue.drainBytes = 0;
    if (unacked > 0) {
      queue.onDropped?.(unacked);
    }
    scheduleQueueDrain(term, queue, true);
  }, WRITE_QUEUE_STALL_TIMEOUT_MS);
};

const scheduleQueueDrain = (
  term: XTerm,
  queue: TerminalWriteQueue,
  deferred: boolean,
): void => {
  if (queue.drainTimer) return;
  if (!deferred) {
    scheduleNextTerminalWrite(term, queue);
    return;
  }
  endQueueTurn(queue);
  queue.drainTimer = setTimeout(() => {
    queue.drainTimer = undefined;
    scheduleNextTerminalWrite(term, queue);
  }, 0);
};

const scheduleNextTerminalWrite = (term: XTerm, queue: TerminalWriteQueue) => {
  const next = queue.pending.shift();
  if (!next) {
    queue.writing = false;
    queue.drainBytes = 0;
    queue.floodMode = false;
    queue.active = undefined;
    clearStallWatchdog(queue);
    endQueueTurn(queue);
    if (terminalWriteQueues.get(term) === queue) {
      terminalWriteQueues.delete(term);
    }
    return;
  }
  beginQueueTurn(queue);
  if (
    queue.drainBytes > 0
    && queue.drainBytes + next.bytes > next.maxDrainBytes
  ) {
    queue.drainBytes = 0;
    queue.pending.unshift(next);
    scheduleQueueDrain(term, queue, true);
    return;
  }
  // Time-budget yield: continuous sync drains stay smooth like Tabby, but never
  // pin the main thread for multi-frame bulk parses.
  if (queue.drainBytes > 0 && isQueueTurnBudgetExceeded(queue)) {
    queue.pending.unshift(next);
    scheduleQueueDrain(term, queue, true);
    return;
  }

  queue.pendingBytes -= next.bytes;
  if (queue.pendingBytes < 0) queue.pendingBytes = 0;
  queue.writing = true;
  queue.active = next;
  armStallWatchdog(term, queue, next);
  runQueuedWrite(next, () => {
    if (queue.active !== next) {
      return;
    }
    clearStallWatchdog(queue);
    queue.drainBytes += next.bytes;
    if (queue.active === next) {
      queue.active = undefined;
    }
    if (next.yieldAfter) {
      queue.drainBytes = 0;
    }
    const shouldDefer = next.yieldAfter || isQueueTurnBudgetExceeded(queue);
    if (shouldDefer && !next.yieldAfter) {
      // Byte drain continues next turn; reset counter so a fresh budget applies.
      queue.drainBytes = 0;
    }
    scheduleQueueDrain(term, queue, shouldDefer);
  }, (continuation) => {
    endQueueTurn(queue);
    const timer = setTimeout(() => {
      if (terminalWriteQueues.get(term) !== queue || queue.stepTimer !== timer) {
        return;
      }
      queue.stepTimer = undefined;
      queue.stepContinuation = undefined;
      continuation();
    }, 0);
    queue.stepTimer = timer;
    queue.stepContinuation = continuation;
  }, () => {
    // Step progress: advance the sequence and re-arm the watchdog so a stall on
    // a later step of a multi-step item is covered as well as the first.
    if (queue.active === next) {
      queue.progressSeq += 1;
      armStallWatchdog(term, queue, next);
    }
  });
};

const resolveMaxDrainBytes = (value?: number): number => (
  Number.isFinite(value) && Number(value) > 0
    ? Number(value)
    : MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES
);

/** Max synchronous recursive step hops inside one merged flood item. */
const MAX_SYNC_MERGED_STEPS_BEFORE_YIELD = 32;

const runQueuedWrite = (
  item: QueuedWrite,
  done: () => void,
  deferStep: (continuation: () => void) => void,
  onStepProgress?: () => void,
): void => {
  let index = 0;
  let completed = false;
  let currentDrainBytes = 0;
  let syncStepsSinceYield = 0;
  let turnStartedAt = performance.now();

  const deferAndResume = (): void => {
    syncStepsSinceYield = 0;
    currentDrainBytes = 0;
    deferStep(() => {
      turnStartedAt = performance.now();
      runNext();
    });
  };

  const runNext = (): void => {
    if (completed) {
      return;
    }
    if (item.cancelled) {
      completed = true;
      done();
      return;
    }
    const step = item.steps[index];
    if (!step) {
      completed = true;
      done();
      return;
    }
    if (
      currentDrainBytes > 0
      && currentDrainBytes + step.bytes > item.maxDrainBytes
    ) {
      deferAndResume();
      return;
    }
    index += 1;
    item.nextIndex = index;

    let callbackCalledSynchronously = false;
    let insideWrite = true;
    const signal: TerminalWriteSignal = {
      isCancelled: () => item.cancelled,
      tryClaimFlowAck: () => tryClaimStepFlowAck(step),
    };
    const continueAfterStep = (): void => {
      // A completed step is progress: re-arm the stall watchdog against the new
      // step so a lost callback on a *later* step of a multi-step item is
      // covered too, not only the first.
      onStepProgress?.();
      currentDrainBytes += step.bytes;
      // Inter-step yields honor per-step flags only. item.yieldAfter applies
      // after the whole item finishes (see scheduleNextTerminalWrite), so that
      // flood merges preserve writeLargeTerminalBatch drain-budget pacing
      // instead of forcing a timer after every shard.
      if (step.yieldAfter && index < item.steps.length) {
        deferAndResume();
        return;
      }
      // Flood-merged items can hold thousands of tiny sync steps. Bound stack
      // depth and wall-clock time so the main thread stays under the turn budget.
      if (index < item.steps.length) {
        syncStepsSinceYield += 1;
        if (
          syncStepsSinceYield >= MAX_SYNC_MERGED_STEPS_BEFORE_YIELD
          || performance.now() - turnStartedAt >= WRITE_QUEUE_TURN_BUDGET_MS
        ) {
          deferAndResume();
          return;
        }
      }
      runNext();
    };
    step.write(() => {
      if (insideWrite) {
        callbackCalledSynchronously = true;
        return;
      }
      continueAfterStep();
    }, signal);
    insideWrite = false;
    if (callbackCalledSynchronously) {
      continueAfterStep();
    }
  };

  runNext();
};

const runDeferredQueueStepNow = (queue: TerminalWriteQueue): boolean => {
  const continuation = queue.stepContinuation;
  if (!continuation) return false;
  if (queue.stepTimer !== undefined) {
    clearTimeout(queue.stepTimer);
  }
  queue.stepTimer = undefined;
  queue.stepContinuation = undefined;
  continuation();
  return true;
};

const runDeferredQueueDrainNow = (
  term: XTerm,
  queue: TerminalWriteQueue,
): boolean => {
  if (queue.drainTimer === undefined) return false;
  clearTimeout(queue.drainTimer);
  queue.drainTimer = undefined;
  scheduleNextTerminalWrite(term, queue);
  return true;
};

const mergePendingWrites = (queue: TerminalWriteQueue): void => {
  if (queue.pending.length <= 1) return;

  const steps: QueuedWriteStep[] = [];
  let bytes = 0;
  let dropBytes = 0;
  // Keep a post-item yield if any source item asked for one; inter-step yields
  // come only from per-step yieldAfter / maxDrainBytes (not a forced every-step
  // pause). writeLargeTerminalBatch sets yieldAfter only every drain budget.
  let yieldAfterItem = false;
  for (const item of queue.pending) {
    bytes += item.bytes;
    dropBytes += item.dropBytes;
    if (item.yieldAfter) {
      yieldAfterItem = true;
    }
    steps.push(...item.steps.slice(item.nextIndex));
  }
  queue.pending = [{
    bytes,
    dropBytes,
    steps,
    nextIndex: 0,
    cancelled: false,
    yieldAfter: yieldAfterItem,
    maxDrainBytes: Math.min(...queue.pending.map((item) => item.maxDrainBytes)),
  }];
  queue.pendingBytes = bytes;
  queue.floodMode = true;
};

const updateFloodMode = (
  queue: TerminalWriteQueue,
  nextBytes: number,
): void => {
  if (
    queue.floodMode
    || queue.pending.length >= MAX_WRITE_QUEUE_ITEMS
    || queue.pendingBytes + nextBytes > MAX_WRITE_QUEUE_BYTES
  ) {
    queue.floodMode = true;
  }
};

export const setTerminalWriteQueueDropHandler = (
  term: XTerm,
  onDropped?: (bytes: number) => void,
): void => {
  if (onDropped) {
    terminalWriteQueueDropHandlers.set(term, onDropped);
  } else {
    terminalWriteQueueDropHandlers.delete(term);
  }
  const queue = terminalWriteQueues.get(term);
  if (queue && onDropped) {
    queue.onDropped = onDropped;
  }
};

export const getTerminalWriteQueueDepth = (term: XTerm): number =>
  terminalWriteQueues.get(term)?.pending.length ?? 0;

export const hasPendingTerminalWriteQueueWork = (term: XTerm): boolean => {
  const queue = terminalWriteQueues.get(term);
  if (!queue) return false;
  return (
    queue.writing
    || queue.active !== undefined
    || queue.pending.length > 0
    || queue.pendingBytes > 0
    || queue.drainTimer !== undefined
    || queue.stepTimer !== undefined
    || queue.stepContinuation !== undefined
  );
};

export const isTerminalWriteQueueInFloodMode = (term: XTerm): boolean =>
  terminalWriteQueues.get(term)?.floodMode ?? false;

export const flushTerminalWriteQueueBypassingTimers = (term: XTerm): boolean => {
  let flushed = false;
  for (let guard = 0; guard < 4096; guard += 1) {
    const queue = terminalWriteQueues.get(term);
    if (!queue) return flushed;
    if (runDeferredQueueStepNow(queue)) {
      flushed = true;
      continue;
    }
    if (runDeferredQueueDrainNow(term, queue)) {
      flushed = true;
      continue;
    }
    if (!queue.writing && queue.pending.length > 0) {
      scheduleNextTerminalWrite(term, queue);
      flushed = true;
      continue;
    }
    return flushed;
  }
  return flushed;
};

export const enqueueTerminalWrite = (
  term: XTerm,
  bytes: number,
  write: (done: () => void, signal: TerminalWriteSignal) => void,
  options: TerminalWriteQueueOptions = {},
): void => {
  const queue = getOrCreateQueue(term);
  const dropBytes = Number.isFinite(options.dropBytes)
    ? Math.max(0, Number(options.dropBytes))
    : bytes;
  if (options.onDropped) {
    queue.onDropped = options.onDropped;
  } else if (!queue.onDropped) {
    queue.onDropped = terminalWriteQueueDropHandlers.get(term);
  }

  updateFloodMode(queue, bytes);

  queue.pending.push({
    bytes,
    dropBytes,
    steps: [{
      bytes,
      dropBytes,
      write,
      yieldAfter: Boolean(options.yieldAfter),
      flowAckClaimed: false,
    }],
    nextIndex: 0,
    cancelled: false,
    yieldAfter: Boolean(options.yieldAfter),
    maxDrainBytes: resolveMaxDrainBytes(options.maxDrainBytes),
  });
  queue.pendingBytes += bytes;
  if (
    queue.floodMode
    || queue.pending.length >= MAX_WRITE_QUEUE_ITEMS
    || queue.pendingBytes > MAX_WRITE_QUEUE_BYTES
  ) {
    mergePendingWrites(queue);
  }

  if (!queue.writing) {
    scheduleQueueDrain(term, queue, Boolean(options.deferStart));
  }
};

/** Drop queued output frames without writing them to xterm. */
export const abortTerminalWriteQueue = (
  term: XTerm,
  onDropped?: (bytes: number) => void,
): void => {
  const queue = terminalWriteQueues.get(term);
  if (!queue) return;

  let droppedBytes = queue.pending.reduce((sum, item) => sum + item.dropBytes, 0);
  if (queue.active) {
    queue.active.cancelled = true;
    droppedBytes += queue.active.steps
      .slice(queue.active.nextIndex)
      .reduce((sum, step) => sum + step.dropBytes, 0);
  }

  queue.pending = [];
  queue.pendingBytes = 0;
  queue.writing = false;
  queue.floodMode = false;
  queue.turnStartedAt = 0;
  queue.active = undefined;
  if (queue.drainTimer) {
    clearTimeout(queue.drainTimer);
    queue.drainTimer = undefined;
  }
  if (queue.stepTimer !== undefined) {
    clearTimeout(queue.stepTimer);
    queue.stepTimer = undefined;
  }
  queue.stepContinuation = undefined;
  clearStallWatchdog(queue);
  terminalWriteQueues.delete(term);

  if (droppedBytes > 0) {
    (onDropped ?? queue.onDropped)?.(droppedBytes);
  }
};
