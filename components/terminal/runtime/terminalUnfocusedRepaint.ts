import type { Terminal as XTerm } from "@xterm/xterm";

import { forceSyncRenderAfterResize } from "../terminalHelpers";
import {
  isTerminalAlternateScreenActive,
  refreshTerminalViewport,
} from "../terminalHibernateRuntime";
import { flushTerminalWriteCoalescer } from "./terminalWriteCoalescer";
import { flushTerminalWriteQueueBypassingTimers } from "./terminalWriteQueue";

const UNFOCUSED_REPAINT_DEBOUNCE_MS = 16;
const UNFOCUSED_FLUSH_DEBOUNCE_MS = 67;
const RESUME_FLUSH_MAX_PASSES = 64;
const unfocusedRepaintTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();
const unfocusedFlushTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();

type XTermWithPrivateWriteBuffer = XTerm & {
  _core?: {
    _writeBuffer?: {
      flushSync?: () => void;
      _bufferOffset?: number;
      _callbacks?: Array<(() => void) | undefined>;
      _pendingData?: number;
      _writeBuffer?: Array<string | Uint8Array>;
    };
  };
};

type XTermPrivateWriteBuffer = NonNullable<
  NonNullable<XTermWithPrivateWriteBuffer["_core"]>["_writeBuffer"]
>;

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
  // Minimized/hidden pages and occluded-but-visible windows (common on Windows
  // when Alt+Tabbing away) both throttle requestAnimationFrame, which lets the
  // write coalescer backlog grow and replay slowly on foreground return (#1880).
  return isTerminalPageHidden() || isTerminalWindowUnfocusedButVisible();
}

function normalizeXtermWriteBufferOffset(writeBuffer: XTermPrivateWriteBuffer): void {
  const buffer = writeBuffer._writeBuffer;
  const callbacks = writeBuffer._callbacks;
  const offset = writeBuffer._bufferOffset;
  if (!Array.isArray(buffer) || !Array.isArray(callbacks) || typeof offset !== "number") {
    return;
  }
  if (offset <= 0) return;
  if (offset >= buffer.length) {
    buffer.length = 0;
    callbacks.length = 0;
    writeBuffer._pendingData = 0;
    writeBuffer._bufferOffset = 0;
    return;
  }
  writeBuffer._writeBuffer = buffer.slice(offset);
  writeBuffer._callbacks = callbacks.slice(offset);
  writeBuffer._bufferOffset = 0;
}

export function flushTerminalWriteBufferBypassingTimers(term: XTerm): void {
  const writeBuffer = (term as XTermWithPrivateWriteBuffer)._core?._writeBuffer;
  if (typeof writeBuffer?.flushSync !== "function") return;
  try {
    normalizeXtermWriteBufferOffset(writeBuffer);
    writeBuffer.flushSync();
  } catch {
    // Best-effort private xterm recovery; normal async writes will continue.
  }
}

export function forceTerminalRepaintBypassingAnimationFrame(term: XTerm): void {
  if (isTerminalAlternateScreenActive(term)) {
    refreshTerminalViewport(term);
  }
  forceSyncRenderAfterResize(term);
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
  flushTerminalWriteBufferBypassingTimers(term);
  for (let pass = 0; pass < RESUME_FLUSH_MAX_PASSES; pass += 1) {
    if (!flushTerminalWriteQueueBypassingTimers(term)) {
      return;
    }
    flushTerminalWriteBufferBypassingTimers(term);
  }
}

export function maybeFlushTerminalWriteCoalescerWhenUnfocused(
  term: XTerm,
  isPaneVisible: boolean,
): void {
  // Background fast path already drains coalescer/queue synchronously.
  if (!isPaneVisible || shouldFlushTerminalWritesForBackgroundOutput(isPaneVisible)) return;
  if (!isTerminalWindowUnfocusedButVisible()) return;
  if (unfocusedFlushTimers.has(term)) return;

  const timer = setTimeout(() => {
    unfocusedFlushTimers.delete(term);
    if (!isTerminalWindowUnfocusedButVisible()) return;
    flushTerminalWriteCoalescer(term);
  }, UNFOCUSED_FLUSH_DEBOUNCE_MS);
  unfocusedFlushTimers.set(term, timer);
}
