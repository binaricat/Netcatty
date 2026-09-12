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

export type TerminalWriteQueueOptions = {
  onDropped?: (bytes: number) => void;
  dropBytes?: number;
  /** Replace older pending writes with the same key before enqueueing. */
  replacePendingKey?: string;
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
  replacePendingKey?: string;
  write: (done: () => void) => void;
  yieldAfter: boolean;
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
  runQueuedWrite(next, () => {
    if (queue.active !== next) {
      return;
    }
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
    const continueAfterStep = (): void => {
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
    });
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

const replacePendingWrites = (
  queue: TerminalWriteQueue,
  replacePendingKey: string,
): void => {
  let removedBytes = 0;
  let droppedBytes = 0;
  const retained: QueuedWrite[] = [];

  for (const item of queue.pending) {
    const steps = item.steps.filter((step) => {
      if (step.replacePendingKey !== replacePendingKey) return true;
      removedBytes += step.bytes;
      droppedBytes += step.dropBytes;
      return false;
    });
    if (steps.length === 0) continue;

    retained.push({
      ...item,
      bytes: steps.reduce((sum, step) => sum + step.bytes, 0),
      dropBytes: steps.reduce((sum, step) => sum + step.dropBytes, 0),
      steps,
      nextIndex: 0,
      yieldAfter: steps.some((step) => step.yieldAfter),
    });
  }

  if (removedBytes === 0) return;
  queue.pending = retained;
  queue.pendingBytes = Math.max(0, queue.pendingBytes - removedBytes);
  if (droppedBytes > 0) {
    queue.onDropped?.(droppedBytes);
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
  write: (done: () => void) => void,
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

  if (options.replacePendingKey) {
    replacePendingWrites(queue, options.replacePendingKey);
  }

  updateFloodMode(queue, bytes);

  queue.pending.push({
    bytes,
    dropBytes,
    steps: [{
      bytes,
      dropBytes,
      replacePendingKey: options.replacePendingKey,
      write,
      yieldAfter: Boolean(options.yieldAfter),
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
  terminalWriteQueues.delete(term);

  if (droppedBytes > 0) {
    (onDropped ?? queue.onDropped)?.(droppedBytes);
  }
};
