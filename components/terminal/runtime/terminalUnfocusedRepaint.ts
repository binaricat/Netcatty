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
  flushTerminalWriteQueueBypassingTimers,
  hasPendingTerminalWriteQueueWork,
} from "./terminalWriteQueue";

const UNFOCUSED_REPAINT_DEBOUNCE_MS = 16;
const UNFOCUSED_FLUSH_DEBOUNCE_MS = 67;
const RESUME_FLUSH_MAX_PASSES = 64;
const HIBERNATE_FLUSH_MAX_PASSES = 4096;
const HIBERNATE_FLUSH_YIELD_EVERY_PASSES = 64;
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
  flushTerminalWriteBufferBypassingTimers(term);
  for (let pass = 0; pass < RESUME_FLUSH_MAX_PASSES; pass += 1) {
    if (!flushTerminalWriteQueueBypassingTimers(term)) {
      return;
    }
    flushTerminalWriteBufferBypassingTimers(term);
  }
}

const waitForTerminalWriteCallbacks = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export async function flushPendingTerminalWritesBeforeHibernate(term: XTerm): Promise<boolean> {
  for (let pass = 0; pass < HIBERNATE_FLUSH_MAX_PASSES; pass += 1) {
    flushTerminalWriteCoalescer(term);
    flushTerminalWriteQueueBypassingTimers(term);
    flushTerminalWriteBufferBypassingTimers(term);

    if (!hasPendingTerminalWrites(term)) {
      return true;
    }

    if ((pass + 1) % HIBERNATE_FLUSH_YIELD_EVERY_PASSES === 0) {
      await waitForTerminalWriteCallbacks();
    }
  }

  flushTerminalWriteCoalescer(term);
  flushTerminalWriteQueueBypassingTimers(term);
  flushTerminalWriteBufferBypassingTimers(term);
  return !hasPendingTerminalWrites(term);
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
