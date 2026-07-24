import type { Terminal as XTerm } from "@xterm/xterm";

import { forceSyncRenderAfterResize } from "../terminalHelpers";
import {
  isTerminalAlternateScreenActive,
  refreshTerminalViewport,
} from "../terminalHibernateRuntime";
import {
  flushTerminalWriteCoalescer,
  getTerminalWriteCoalescerPendingBytes,
} from "./terminalWriteCoalescer";
import {
  enqueueTerminalWrite,
  flushTerminalWriteQueueBypassingTimers,
  hasPendingTerminalWriteQueueWork,
} from "./terminalWriteQueue";

const UNFOCUSED_REPAINT_DEBOUNCE_MS = 16;
const UNFOCUSED_FLUSH_DEBOUNCE_MS = 67;
export const TERMINAL_WRITE_SETTLE_TIMEOUT_MS = 750;
const TERMINAL_WRITE_SETTLE_POLL_MS = 8;
const unfocusedRepaintTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();
const unfocusedFlushTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();

type XTermWithPrivateWriteBuffer = XTerm & {
  _core?: {
    _writeBuffer?: {
      _bufferOffset?: number;
      _pendingData?: number;
      _writeBuffer?: Array<string | Uint8Array>;
    };
  };
};

export function isTerminalWindowUnfocusedButVisible(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && !document.hasFocus();
}

export function isTerminalPageHidden(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState !== "visible";
}

export function shouldFlushTerminalWritesForBackgroundOutput(isPaneVisible: boolean): boolean {
  // Hidden panes should keep their xterm buffer current so tab switches do not
  // reveal a delayed replay of long-running output (#1985).
  if (!isPaneVisible) return true;
  // Fully page-hidden documents throttle rAF hard; force the background drain
  // path so backlog does not sit until the tab is shown again (#1880).
  // Unfocused-but-still-visible windows (Alt+Tab, second monitor) keep normal
  // coalescing + maybeFlush… throttling so alt-screen frames and log batching
  // are not destroyed by a per-chunk force flush.
  return isTerminalPageHidden();
}

function getPendingTerminalWriteBufferBytes(term: XTerm): number {
  const writeBuffer = (term as XTermWithPrivateWriteBuffer)._core?._writeBuffer;
  if (!writeBuffer) return 0;

  if (
    typeof writeBuffer._pendingData === "number"
    && Number.isFinite(writeBuffer._pendingData)
    && writeBuffer._pendingData > 0
  ) {
    return writeBuffer._pendingData;
  }

  const buffer = writeBuffer._writeBuffer;
  if (!Array.isArray(buffer) || buffer.length === 0) return 0;
  const offset = typeof writeBuffer._bufferOffset === "number"
    && Number.isFinite(writeBuffer._bufferOffset)
    ? Math.max(0, writeBuffer._bufferOffset)
    : 0;

  let bytes = 0;
  for (let index = Math.min(offset, buffer.length); index < buffer.length; index += 1) {
    const chunk = buffer[index];
    if (typeof chunk === "string") {
      bytes += chunk.length;
    } else if (chunk instanceof Uint8Array) {
      bytes += chunk.byteLength;
    }
  }
  return bytes;
}

export function hasPendingTerminalWrites(term: XTerm): boolean {
  return (
    getTerminalWriteCoalescerPendingBytes(term) > 0
    || hasPendingTerminalWriteQueueWork(term)
    || getPendingTerminalWriteBufferBytes(term) > 0
  );
}

export function forceTerminalRepaintBypassingAnimationFrame(term: XTerm): void {
  if (isTerminalAlternateScreenActive(term)) {
    refreshTerminalViewport(term);
  }
  forceSyncRenderAfterResize(term);
}

type RevealFrameScheduler = (callback: () => void) => void;

const scheduleRevealFrame: RevealFrameScheduler | undefined =
  typeof globalThis.requestAnimationFrame === "function"
    ? (callback) => { globalThis.requestAnimationFrame(() => callback()); }
    : undefined;

export function repaintTerminalAfterReveal(
  term: XTerm,
  shouldRepaint: () => boolean = () => true,
  scheduleFrame: RevealFrameScheduler | undefined = scheduleRevealFrame,
): void {
  // The layout-effect pass makes the tab feel immediate, but on Windows the
  // compositor can still treat a just-revealed WebGL canvas as hidden and
  // discard this draw. Repeat once in the first visible browser frame so the
  // final rows and cursor are guaranteed to reach the screen (#1985).
  forceTerminalRepaintBypassingAnimationFrame(term);
  scheduleFrame?.(() => {
    if (!shouldRepaint()) return;
    forceTerminalRepaintBypassingAnimationFrame(term);
  });
}

export function scheduleTerminalRepaintWhenUnfocused(term: XTerm): void {
  if (!isTerminalWindowUnfocusedButVisible()) return;

  if (unfocusedRepaintTimers.has(term)) return;

  const timer = setTimeout(() => {
    unfocusedRepaintTimers.delete(term);
    if (!isTerminalWindowUnfocusedButVisible()) return;
    forceTerminalRepaintBypassingAnimationFrame(term);
  }, UNFOCUSED_REPAINT_DEBOUNCE_MS);
  unfocusedRepaintTimers.set(term, timer);
}

export function cancelScheduledUnfocusedRepaint(term: XTerm): void {
  const timer = unfocusedRepaintTimers.get(term);
  if (timer !== undefined) {
    clearTimeout(timer);
    unfocusedRepaintTimers.delete(term);
  }

  const flushTimer = unfocusedFlushTimers.get(term);
  if (flushTimer === undefined) return;
  clearTimeout(flushTimer);
  unfocusedFlushTimers.delete(term);
}

export function flushPendingTerminalWritesOnResume(term: XTerm): void {
  flushTerminalWriteCoalescer(term);
  flushTerminalWriteQueueBypassingTimers(term);
}

export function writeLocalTerminalDataInOrder(
  term: XTerm,
  data: string,
  capture?: (data: string) => void,
): void {
  if (!data) return;
  // Hidden-pane PTY output may still be waiting in the coalescer. Drain it
  // into the ordered queue before appending local echo. Do not bypass queue
  // yields for every echoed character during a large output burst.
  flushTerminalWriteCoalescer(term);
  enqueueTerminalWrite(term, 0, (done) => {
    capture?.(data);
    term.write(data, done);
  });
}

const waitForTerminalWriteCallbacks = (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

export async function flushPendingTerminalWritesBeforeHibernate(
  term: XTerm,
  timeoutMs: number = TERMINAL_WRITE_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    flushTerminalWriteCoalescer(term);
    flushTerminalWriteQueueBypassingTimers(term);

    if (!hasPendingTerminalWrites(term)) {
      return true;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await waitForTerminalWriteCallbacks(Math.min(TERMINAL_WRITE_SETTLE_POLL_MS, remainingMs));
  }

  flushTerminalWriteCoalescer(term);
  flushTerminalWriteQueueBypassingTimers(term);
  return !hasPendingTerminalWrites(term);
}

type TerminalOutputPauseBackend = {
  acquireSessionFlowPauseLease: (sessionId: string) => Promise<{
    release(options?: { keepPaused?: boolean }): void;
    waitForPause(): Promise<unknown>;
  }>;
};

/**
 * Run a synchronous terminal operation only after pending writes have settled,
 * while keeping the backend source paused across the operation.
 *
 * Draining xterm can cross the renderer flow controller's low watermark. The
 * main-process lease keeps that automatic resume from overriding another
 * window's resize, snapshot, or handoff operation.
 */
export async function runWithTerminalOutputPausedAfterWritesSettle(
  term: XTerm,
  sessionId: string | null,
  backend: TerminalOutputPauseBackend,
  operation: () => void,
  shouldResumeBackend: () => boolean = () => true,
): Promise<boolean> {
  const lease = sessionId
    ? await backend.acquireSessionFlowPauseLease(sessionId)
    : null;
  try {
    if (lease) {
      try {
        await lease.waitForPause();
      } catch {
        // Acquiring the main-process lease already paused the source. Continue
        // with the local drain if the renderer acknowledgement path is absent.
      }
    }

    const settled = await flushPendingTerminalWritesBeforeHibernate(term);
    if (!settled) return false;

    operation();
    return true;
  } finally {
    lease?.release({ keepPaused: !shouldResumeBackend() });
  }
}

export function maybeFlushTerminalWriteCoalescerWhenUnfocused(
  term: XTerm,
  isPaneVisible: boolean,
): void {
  // Hidden pane / page-hidden use the background drain path in writeSessionData.
  if (!isPaneVisible || isTerminalPageHidden()) return;
  if (!isTerminalWindowUnfocusedButVisible()) return;
  if (unfocusedFlushTimers.has(term)) return;

  const timer = setTimeout(() => {
    unfocusedFlushTimers.delete(term);
    if (!isTerminalWindowUnfocusedButVisible()) return;
    flushTerminalWriteCoalescer(term);
  }, UNFOCUSED_FLUSH_DEBOUNCE_MS);
  unfocusedFlushTimers.set(term, timer);
}
