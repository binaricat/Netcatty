import type { Terminal as XTerm } from "@xterm/xterm";

import { MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES } from "./terminalFlowConstants";

export const MAX_WRITE_QUEUE_ITEMS = 32;
export const MAX_WRITE_QUEUE_BYTES = 512 * 1024;

export type TerminalWriteQueueOptions = {
  onDropped?: (bytes: number) => void;
  deferStart?: boolean;
  yieldAfter?: boolean;
  maxDrainBytes?: number;
};

type QueuedWrite = {
  bytes: number;
  steps: QueuedWriteStep[];
  nextIndex: number;
  cancelled: boolean;
  yieldAfter: boolean;
  maxDrainBytes: number;
};

type QueuedWriteStep = {
  bytes: number;
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
  onDropped?: (bytes: number) => void;
  drainTimer?: ReturnType<typeof setTimeout>;
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
      onDropped: terminalWriteQueueDropHandlers.get(term),
    };
    terminalWriteQueues.set(term, queue);
  }
  return queue;
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
    if (terminalWriteQueues.get(term) === queue) {
      terminalWriteQueues.delete(term);
    }
    return;
  }
  if (
    queue.drainBytes > 0
    && queue.drainBytes + next.bytes > next.maxDrainBytes
  ) {
    queue.drainBytes = 0;
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
    scheduleQueueDrain(term, queue, next.yieldAfter);
  });
};

const resolveMaxDrainBytes = (value?: number): number => (
  Number.isFinite(value) && Number(value) > 0
    ? Number(value)
    : MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES
);

const runQueuedWrite = (item: QueuedWrite, done: () => void): void => {
  let index = 0;
  let completed = false;
  let currentDrainBytes = 0;

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
      currentDrainBytes = 0;
      setTimeout(runNext, 0);
      return;
    }
    index += 1;
    item.nextIndex = index;

    let callbackCalledSynchronously = false;
    let insideWrite = true;
    const continueAfterStep = (): void => {
      currentDrainBytes += step.bytes;
      if ((step.yieldAfter || item.yieldAfter) && index < item.steps.length) {
        currentDrainBytes = 0;
        setTimeout(runNext, 0);
        return;
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

const mergePendingWrites = (queue: TerminalWriteQueue): void => {
  if (queue.pending.length <= 1) return;

  const steps: QueuedWriteStep[] = [];
  let bytes = 0;
  for (const item of queue.pending) {
    bytes += item.bytes;
    steps.push(...item.steps.slice(item.nextIndex));
  }
  queue.pending = [{
    bytes,
    steps,
    nextIndex: 0,
    cancelled: false,
    yieldAfter: true,
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

export const isTerminalWriteQueueInFloodMode = (term: XTerm): boolean =>
  terminalWriteQueues.get(term)?.floodMode ?? false;

export const enqueueTerminalWrite = (
  term: XTerm,
  bytes: number,
  write: (done: () => void) => void,
  options: TerminalWriteQueueOptions = {},
): void => {
  const queue = getOrCreateQueue(term);
  if (options.onDropped) {
    queue.onDropped = options.onDropped;
  } else if (!queue.onDropped) {
    queue.onDropped = terminalWriteQueueDropHandlers.get(term);
  }

  updateFloodMode(queue, bytes);

  queue.pending.push({
    bytes,
    steps: [{ bytes, write, yieldAfter: Boolean(options.yieldAfter) }],
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

  let droppedBytes = queue.pendingBytes;
  if (queue.active) {
    queue.active.cancelled = true;
    droppedBytes += queue.active.steps
      .slice(queue.active.nextIndex)
      .reduce((sum, step) => sum + step.bytes, 0);
  }

  queue.pending = [];
  queue.pendingBytes = 0;
  queue.writing = false;
  queue.floodMode = false;
  queue.active = undefined;
  if (queue.drainTimer) {
    clearTimeout(queue.drainTimer);
    queue.drainTimer = undefined;
  }
  terminalWriteQueues.delete(term);

  if (droppedBytes > 0) {
    (onDropped ?? queue.onDropped)?.(droppedBytes);
  }
};
