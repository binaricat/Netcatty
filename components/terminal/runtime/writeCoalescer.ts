/**
 * Coalesces PTY output chunks into one xterm.write() per schedule tick.
 *
 * Agent CLIs (Codex, Claude Code) emit full-screen repaints as many small PTY
 * chunks. Writing each chunk individually triggers an xterm parse/render cycle
 * per chunk, which can tear TUI frames (missing box borders, clipped bottom
 * rows). Batching keeps rendering atomic per schedule turn.
 *
 * Schedule modes (Tabby-inspired):
 * - `raf`: wait for the next animation frame (best for alternate-screen TUIs)
 * - `microtask`: flush after the current JS turn (normal-screen bulk / echo —
 *   closer to Tabby's direct write, still coalesces same-turn chunks)
 *
 * Ported from superset-sh/superset (issues #2241 / #2244):
 * apps/desktop/src/renderer/lib/terminal/write-coalescer.ts
 */

import {
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
} from "./terminalFlowConstants";

export {
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
};

/** Maximum time pending output may wait for its primary scheduler. */
export const WRITE_COALESCE_FALLBACK_DRAIN_MS = 50;

export type WriteCoalescer = {
  push(chunk: string): void;
  /** Flush pending bytes synchronously before ordered writes (exit notices). */
  flushSync(writeOverride?: (data: string) => void): void;
  /** Drop pending bytes without writing (flood recovery / teardown). */
  abort(onDropped?: (bytes: number) => void): void;
  pendingBytes(): number;
  dispose(): void;
};

export type WriteCoalesceScheduleMode = "raf" | "microtask";

export type WriteCoalesceScheduleContext = {
  /** Chunk about to be (or just) enqueued. */
  nextChunk: string;
  /** Bytes already pending before this chunk was appended. */
  pendingBytesBefore: number;
};

type ScheduleWriteFrame = (callback: () => void) => (() => void) | null;
type ScheduleTimeout = (callback: () => void, ms: number) => (() => void) | null;

export type WriteCoalescerOptions = {
  scheduleFrame?: ScheduleWriteFrame;
  scheduleTimeout?: ScheduleTimeout;
  fallbackDrainMs?: number;
  /**
   * Choose scheduling per push. Alternate-screen TUIs should return `raf`;
   * normal-screen / bulk output should return `microtask` for lower latency.
   * Called with the incoming chunk so callers can detect TUI enter sequences
   * before xterm has switched buffers.
   */
  resolveScheduleMode?: (ctx: WriteCoalesceScheduleContext) => WriteCoalesceScheduleMode;
  getMaxPendingBytes?: () => number;
  shouldFlushScheduledFrame?: () => boolean;
};

const scheduleRafFrame = (callback: () => void): (() => void) | null => {
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

const scheduleMicrotaskFrame = (callback: () => void): (() => void) | null => {
  if (typeof queueMicrotask === "function") {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        callback();
      }
    });
    return () => {
      cancelled = true;
    };
  }
  if (typeof setTimeout === "function") {
    const timer = setTimeout(callback, 0);
    return () => {
      clearTimeout(timer);
    };
  }
  return null;
};

const defaultScheduleTimeout: ScheduleTimeout = (callback, ms) => {
  if (typeof setTimeout !== "function") {
    return null;
  }
  const timer = setTimeout(callback, ms);
  return () => {
    clearTimeout(timer);
  };
};

const scheduleByMode = (
  mode: WriteCoalesceScheduleMode,
  callback: () => void,
  customSchedule?: ScheduleWriteFrame,
): (() => void) | null => {
  if (customSchedule) {
    return customSchedule(callback);
  }
  if (mode === "microtask") {
    // Prefer microtask; fall back to rAF only if microtasks are unavailable.
    return scheduleMicrotaskFrame(callback) ?? scheduleRafFrame(callback);
  }
  // rAF mode must NOT fall back to microtask — when rAF is missing (Node unit
  // tests / headless), returning null makes push() flush synchronously, which
  // matches the pre-coalescer-schedule contract tests rely on.
  return scheduleRafFrame(callback);
};

const combineCancels = (
  cancels: Array<(() => void) | null | undefined>,
): (() => void) | null => {
  const active = cancels.filter((cancel): cancel is () => void => typeof cancel === "function");
  if (active.length === 0) {
    return null;
  }
  return () => {
    for (const cancel of active) {
      cancel();
    }
  };
};

export const createWriteCoalescer = (
  write: (data: string) => void,
  options: WriteCoalescerOptions = {},
): WriteCoalescer => {
  let pending: string[] = [];
  let pendingBytes = 0;
  let cancelPendingSchedule: (() => void) | null = null;
  let scheduledMode: WriteCoalesceScheduleMode | null = null;
  let disposed = false;
  const customScheduleFrame = options.scheduleFrame;
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const fallbackDrainMs = options.fallbackDrainMs ?? WRITE_COALESCE_FALLBACK_DRAIN_MS;
  const resolveScheduleMode = options.resolveScheduleMode ?? (() => "raf" as const);
  const getMaxPendingBytes = options.getMaxPendingBytes
    ?? (() => MAX_PENDING_WRITE_COALESCE_BYTES);
  const shouldFlushScheduledFrame = options.shouldFlushScheduledFrame ?? (() => true);

  const cancelScheduledDrain = (): void => {
    if (cancelPendingSchedule !== null) {
      cancelPendingSchedule();
      cancelPendingSchedule = null;
    }
    scheduledMode = null;
  };

  const armDeferredDrain = (mode: WriteCoalesceScheduleMode): void => {
    if (disposed || pendingBytes === 0 || cancelPendingSchedule !== null) {
      return;
    }
    const cancel = scheduleTimeout(() => {
      cancelPendingSchedule = null;
      scheduledMode = null;
      if (disposed || pendingBytes === 0) {
        return;
      }
      if (!shouldFlushScheduledFrame()) {
        armDeferredDrain(mode);
        return;
      }
      flushSync();
    }, Math.max(fallbackDrainMs, 1));
    if (cancel === null) {
      return;
    }
    cancelPendingSchedule = cancel;
    scheduledMode = mode;
  };

  const armSchedule = (mode: WriteCoalesceScheduleMode): void => {
    let settled = false;
    const onScheduled = (): void => {
      if (settled || disposed) {
        return;
      }
      settled = true;
      const cancel = cancelPendingSchedule;
      cancelPendingSchedule = null;
      scheduledMode = null;
      cancel?.();
      if (!shouldFlushScheduledFrame()) {
        if (pendingBytes > 0) {
          armDeferredDrain(mode);
        }
        return;
      }
      flushSync();
    };

    const primaryCancel = scheduleByMode(mode, onScheduled, customScheduleFrame);
    const fallbackCancel = mode === "raf"
      && fallbackDrainMs > 0
      && primaryCancel !== null
      ? scheduleTimeout(onScheduled, fallbackDrainMs)
      : null;
    const cancelFrame = combineCancels([primaryCancel, fallbackCancel]);
    if (cancelFrame === null) {
      if (!shouldFlushScheduledFrame()) {
        return;
      }
      flushSync();
      return;
    }
    cancelPendingSchedule = cancelFrame;
    scheduledMode = mode;
  };

  const flushSync = (writeOverride?: (data: string) => void): void => {
    cancelScheduledDrain();
    if (pendingBytes === 0) {
      return;
    }
    const batch = pending.length === 1 ? pending[0]! : pending.join("");
    pending = [];
    pendingBytes = 0;
    (writeOverride ?? write)(batch);
  };

  const abort = (onDropped?: (bytes: number) => void): void => {
    cancelScheduledDrain();
    if (pendingBytes === 0) {
      return;
    }
    const dropped = pendingBytes;
    pending = [];
    pendingBytes = 0;
    onDropped?.(dropped);
  };

  const push = (chunk: string): void => {
    if (disposed || chunk.length === 0) {
      return;
    }
    const pendingBytesBefore = pendingBytes;
    pending.push(chunk);
    pendingBytes += chunk.length;
    // Always resolve schedule mode before cap drain so callers can probe
    // enter-alt CSI (side-effect latch) even when this push immediately flushes.
    const mode = resolveScheduleMode({
      nextChunk: chunk,
      pendingBytesBefore,
    });
    if (pendingBytes > getMaxPendingBytes()) {
      // Byte-cap always drains. The frame gate only suppresses idle/rAF flushes
      // (hidden panes); unbounded hold past the cap freezes multi-terminal log
      // floods with multi-MB joins until a timed drain (issue #2397).
      flushSync();
      return;
    }
    if (cancelPendingSchedule === null) {
      armSchedule(mode);
      return;
    }
    // Upgrade microtask → rAF when a later chunk enters a TUI: the first shell
    // chunk may have scheduled a same-turn flush before the alt-screen CSI
    // arrived, which would tear the first repaint (Codex PR review).
    if (scheduledMode === "microtask" && mode === "raf") {
      cancelScheduledDrain();
      armSchedule("raf");
    }
  };

  return {
    push,
    flushSync,
    abort,
    pendingBytes: () => pendingBytes,
    dispose() {
      if (disposed) {
        return;
      }
      flushSync();
      disposed = true;
    },
  };
};
