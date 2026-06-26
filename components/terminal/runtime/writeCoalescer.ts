/**
 * Coalesces PTY output chunks into one xterm.write() per animation frame.
 *
 * Agent CLIs (Codex, Claude Code) emit full-screen repaints as many small PTY
 * chunks. Writing each chunk individually triggers an xterm parse/render cycle
 * per chunk, which can tear TUI frames (missing box borders, clipped bottom
 * rows). Batching to the display refresh rate keeps rendering atomic per frame.
 *
 * Ported from superset-sh/superset (issues #2241 / #2244):
 * apps/desktop/src/renderer/lib/terminal/write-coalescer.ts
 *
 * Background-resume behaviour: while the window is hidden Chromium throttles (or
 * fully pauses) requestAnimationFrame, so the rAF-only flush stalls and a busy
 * source piles up to the hard ceiling. Returning to the foreground then dumps
 * that whole batch into a single write(), whose synchronous filtering + parse
 * kickoff janks for seconds. Two mechanisms keep the resume responsive without
 * pausing the remote source: a timer races the frame so flushing continues when
 * rAF is throttled, and a flush drains in bounded slices so the catch-up work
 * is paced through the downstream write queue instead of blocking in one go.
 */

/** Pending-byte ceiling when rAF is throttled (hidden window). */
export const MAX_PENDING_WRITE_COALESCE_BYTES = 1024 * 1024;

/**
 * Upper bound on the bytes handed to a single downstream write(). A backlog
 * accumulated while the window was hidden is drained in slices of this size so
 * the per-write synchronous work (session-data filtering + xterm parse kickoff)
 * stays small and the serialized write queue interleaves with the event loop —
 * the foreground catch-up stays responsive instead of freezing for seconds.
 * Chunk boundaries are never split, so a single chunk larger than this is still
 * emitted whole (PTY chunks are ~16KB, comfortably under it) and normal
 * per-frame batches (a few KB) keep emitting as one atomic write.
 */
export const MAX_WRITE_COALESCE_FLUSH_BYTES = 64 * 1024;

/**
 * Fallback flush delay used when requestAnimationFrame is throttled or paused
 * (hidden window). rAF wins the race while the window is visible; this timer
 * takes over when it does not, so the backlog keeps draining and resume no
 * longer faces one giant accumulated batch.
 */
export const HIDDEN_WRITE_COALESCE_FLUSH_MS = 200;

export type WriteCoalescer = {
  push(chunk: string): void;
  /** Flush pending bytes synchronously before ordered writes (exit notices). */
  flushSync(): void;
  dispose(): void;
};

type ScheduleWriteFrame = (callback: () => void) => (() => void) | null;
type ScheduleWriteTimer = (callback: () => void, delayMs: number) => () => void;

const scheduleWriteFrame = (callback: () => void): (() => void) | null => {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const frameId = globalThis.requestAnimationFrame(callback);
    return () => {
      if (typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frameId);
      }
    };
  }

  return null;
};

const scheduleWriteTimer: ScheduleWriteTimer = (callback, delayMs) => {
  const timerId = setTimeout(callback, delayMs);
  return () => clearTimeout(timerId);
};

export const createWriteCoalescer = (
  write: (data: string) => void,
  options: {
    scheduleFrame?: ScheduleWriteFrame;
    scheduleTimer?: ScheduleWriteTimer;
    maxFlushBytes?: number;
    hiddenFlushMs?: number;
  } = {},
): WriteCoalescer => {
  let pending: string[] = [];
  let pendingBytes = 0;
  let cancelScheduled: (() => void) | null = null;
  let disposed = false;
  const scheduleFrame = options.scheduleFrame ?? scheduleWriteFrame;
  const scheduleTimer = options.scheduleTimer ?? scheduleWriteTimer;
  const maxFlushBytes = options.maxFlushBytes ?? MAX_WRITE_COALESCE_FLUSH_BYTES;
  const hiddenFlushMs = options.hiddenFlushMs ?? HIDDEN_WRITE_COALESCE_FLUSH_MS;

  const cancelSchedule = (): void => {
    if (cancelScheduled !== null) {
      cancelScheduled();
      cancelScheduled = null;
    }
  };

  // Drain `pending` into write() in batches no larger than maxFlushBytes,
  // never splitting an individual chunk (keeps multi-byte sequences and normal
  // TUI frame boundaries intact). The common case (a few KB per frame) emits
  // exactly one batch; only a hidden-window backlog is sliced. Reset state
  // before writing so a re-entrant push lands in a fresh batch.
  const drainPending = (): void => {
    const chunks = pending;
    pending = [];
    pendingBytes = 0;

    let batch = "";
    for (const chunk of chunks) {
      if (batch.length > 0 && batch.length + chunk.length > maxFlushBytes) {
        write(batch);
        batch = "";
      }
      batch += chunk;
    }
    if (batch.length > 0) {
      write(batch);
    }
  };

  const flushSync = (): void => {
    cancelSchedule();
    if (pendingBytes === 0) {
      return;
    }
    drainPending();
  };

  // Race a frame against a timer: rAF gives smooth per-frame batching while the
  // window is visible; the timer is the fallback for when rAF is throttled or
  // paused in the background, so the backlog keeps draining instead of growing
  // to the hard ceiling and bursting on resume. Whichever fires first cancels
  // the other.
  const scheduleFlush = (): void => {
    if (cancelScheduled !== null) {
      return;
    }
    let cancelFrame: (() => void) | null = null;
    let cancelTimer: (() => void) | null = null;
    const cancelBoth = (): void => {
      cancelFrame?.();
      cancelTimer?.();
    };
    const run = (): void => {
      cancelScheduled = null;
      cancelBoth();
      flushSync();
    };
    cancelFrame = scheduleFrame(run);
    cancelTimer = scheduleTimer(run, hiddenFlushMs);
    cancelScheduled = cancelBoth;
  };

  const push = (chunk: string): void => {
    if (disposed || chunk.length === 0) {
      return;
    }
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes > MAX_PENDING_WRITE_COALESCE_BYTES) {
      flushSync();
      return;
    }
    scheduleFlush();
  };

  return {
    push,
    flushSync,
    dispose() {
      if (disposed) {
        return;
      }
      flushSync();
      disposed = true;
    },
  };
};
