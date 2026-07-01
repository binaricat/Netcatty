import type { Terminal as XTerm } from "@xterm/xterm";

import { forceSyncRenderAfterResize } from "../terminalHelpers";
import {
  isTerminalAlternateScreenActive,
  refreshTerminalViewport,
} from "../terminalHibernateRuntime";
import { flushTerminalWriteCoalescer } from "./terminalWriteCoalescer";

const UNFOCUSED_REPAINT_DEBOUNCE_MS = 16;
const UNFOCUSED_FLUSH_DEBOUNCE_MS = 67;
const unfocusedRepaintTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();
const unfocusedFlushTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();

export function isTerminalWindowUnfocusedButVisible(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && !document.hasFocus();
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

export function maybeFlushTerminalWriteCoalescerWhenUnfocused(
  term: XTerm,
  isPaneVisible: boolean,
): void {
  if (!isPaneVisible || !isTerminalWindowUnfocusedButVisible()) return;
  if (unfocusedFlushTimers.has(term)) return;

  const timer = setTimeout(() => {
    unfocusedFlushTimers.delete(term);
    if (!isTerminalWindowUnfocusedButVisible()) return;
    flushTerminalWriteCoalescer(term);
  }, UNFOCUSED_FLUSH_DEBOUNCE_MS);
  unfocusedFlushTimers.set(term, timer);
}
