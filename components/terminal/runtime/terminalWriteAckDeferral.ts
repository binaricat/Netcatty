import type { Terminal as XTerm } from "@xterm/xterm";

import { XTERM_WRITE_CALLBACK_BATCH_BYTES } from "./terminalFlowConstants";

const DEFERRED_TERMINAL_WRITE_ACK_IDLE_FLUSH_MS = 16;

/** Ingress bytes written to xterm but not yet reported to main-process IPC ACK. */
const deferredIpcAckBytesByTerm = new WeakMap<XTerm, number>();
const deferredIpcAckFlushTimersByTerm = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();

const cancelDeferredTerminalWriteAckFlush = (term: XTerm): void => {
  const timer = deferredIpcAckFlushTimersByTerm.get(term);
  if (timer === undefined) return;
  clearTimeout(timer);
  deferredIpcAckFlushTimersByTerm.delete(term);
};

export const getDeferredTerminalWriteAckBytes = (term: XTerm): number =>
  deferredIpcAckBytesByTerm.get(term) ?? 0;

export const accumulateDeferredTerminalWriteAck = (
  term: XTerm,
  bytes: number,
): number => {
  if (bytes <= 0) return getDeferredTerminalWriteAckBytes(term);
  const next = getDeferredTerminalWriteAckBytes(term) + bytes;
  deferredIpcAckBytesByTerm.set(term, next);
  return next;
};

export const clearDeferredTerminalWriteAck = (term: XTerm): number => {
  cancelDeferredTerminalWriteAckFlush(term);
  const bytes = deferredIpcAckBytesByTerm.get(term) ?? 0;
  deferredIpcAckBytesByTerm.delete(term);
  return bytes;
};

export const scheduleDeferredTerminalWriteAckFlush = (
  term: XTerm,
  onFlush: (bytes: number) => void,
  delayMs: number = DEFERRED_TERMINAL_WRITE_ACK_IDLE_FLUSH_MS,
): void => {
  if (getDeferredTerminalWriteAckBytes(term) <= 0) return;
  if (deferredIpcAckFlushTimersByTerm.has(term)) return;

  const timer = setTimeout(() => {
    deferredIpcAckFlushTimersByTerm.delete(term);
    const bytes = clearDeferredTerminalWriteAck(term);
    if (bytes > 0) {
      onFlush(bytes);
    }
  }, Math.max(0, delayMs));
  deferredIpcAckFlushTimersByTerm.set(term, timer);
};

export const shouldDeferTerminalWriteCallback = (
  displayBytes: number,
  deferredIngressBytes: number,
  ingressBytes: number,
  fastPathMaxBytes: number,
  batchBytes: number = XTERM_WRITE_CALLBACK_BATCH_BYTES,
): boolean =>
  displayBytes <= fastPathMaxBytes
  && deferredIngressBytes + ingressBytes < batchBytes;

export const resetDeferredTerminalWriteAck = (term: XTerm): void => {
  cancelDeferredTerminalWriteAckFlush(term);
  deferredIpcAckBytesByTerm.delete(term);
};
