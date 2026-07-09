import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
} from "./terminalFlowConstants";
import { createWriteCoalescer, type WriteCoalescer } from "./writeCoalescer.ts";

type CoalescerByteCapResolver = () => number;
type CoalescerFlushGate = () => boolean;
export type CoalescedTerminalWriteOptions = {
  deferStart?: boolean;
  yieldAfter?: boolean;
  preservePerfTrace?: boolean;
};
type CoalescedTerminalWriteNow = (
  data: string,
  ingressBytes: number,
  options?: CoalescedTerminalWriteOptions,
) => void;

const terminalWriteCoalescers = new WeakMap<XTerm, WriteCoalescer>();
const terminalWriteCoalescerIngress = new WeakMap<XTerm, number>();
const terminalWriteCoalescerChunkCounts = new WeakMap<XTerm, number>();
const terminalWriteCoalescerByteCapResolvers = new WeakMap<XTerm, CoalescerByteCapResolver>();
const terminalWriteCoalescerFlushGates = new WeakMap<XTerm, CoalescerFlushGate>();
const terminalWriteCoalescerWriters = new WeakMap<XTerm, CoalescedTerminalWriteNow>();

const defaultCoalescerByteCap = (): number => MAX_PENDING_WRITE_COALESCE_BYTES;

export const setTerminalWriteCoalescerByteCapResolver = (
  term: XTerm,
  resolver?: CoalescerByteCapResolver,
): void => {
  if (resolver) {
    terminalWriteCoalescerByteCapResolvers.set(term, resolver);
  } else {
    terminalWriteCoalescerByteCapResolvers.delete(term);
  }
};

const resolveCoalescerByteCap = (term: XTerm): number => {
  const resolver = terminalWriteCoalescerByteCapResolvers.get(term);
  return resolver?.() ?? defaultCoalescerByteCap();
};

const shouldAutoFlushCoalescer = (term: XTerm): boolean =>
  terminalWriteCoalescerFlushGates.get(term)?.() ?? true;

const getPendingCoalescedBytes = (term: XTerm): number =>
  terminalWriteCoalescers.get(term)?.pendingBytes() ?? 0;

const takePendingIngressBytes = (term: XTerm, fallback = 0): number => {
  const pending = terminalWriteCoalescerIngress.get(term) ?? fallback;
  terminalWriteCoalescerIngress.delete(term);
  return pending;
};

const takePendingChunkCount = (term: XTerm): number => {
  const count = terminalWriteCoalescerChunkCounts.get(term) ?? 1;
  terminalWriteCoalescerChunkCounts.delete(term);
  return count;
};

export const setTerminalWriteCoalescerFlushGate = (
  term: XTerm,
  gate?: CoalescerFlushGate,
): void => {
  if (gate) {
    terminalWriteCoalescerFlushGates.set(term, gate);
  } else {
    terminalWriteCoalescerFlushGates.delete(term);
  }
};

const splitIngressBytes = (
  totalDisplayBytes: number,
  totalIngressBytes: number,
  sliceDisplayBytes: number,
  remainingIngressBytes: number,
): number => {
  if (totalDisplayBytes <= 0) {
    return totalIngressBytes;
  }
  const proportionalBytes = Math.floor(
    (totalIngressBytes * sliceDisplayBytes) / totalDisplayBytes,
  );
  return Math.max(0, Math.min(remainingIngressBytes, proportionalBytes));
};

const isPlainTerminalOutput = (data: string): boolean =>
  !data.includes("\x1b") && !data.includes("\x9b");

const LINE_BREAK_SCAN = /[\n\r]/g;

const hasLongUnbrokenRun = (data: string, maxRunBytes: number): boolean => {
  if (data.length <= maxRunBytes) {
    return false;
  }
  // Hot path for every flushed batch: hop between line breaks with a native
  // regex scan instead of visiting each character in JS.
  let runStart = 0;
  LINE_BREAK_SCAN.lastIndex = 0;
  for (
    let match = LINE_BREAK_SCAN.exec(data);
    match !== null;
    match = LINE_BREAK_SCAN.exec(data)
  ) {
    if (match.index - runStart > maxRunBytes) {
      return true;
    }
    runStart = match.index + 1;
  }
  return data.length - runStart > maxRunBytes;
};

const resolveTerminalWriteBatchBytes = (
  data: string,
  maxPendingBytes: number,
): number => (
  isPlainTerminalOutput(data)
    && hasLongUnbrokenRun(data, MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES)
    ? MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES
    : data.length > MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES && isPlainTerminalOutput(data)
      ? MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES
    : maxPendingBytes
);

const writeLargeTerminalBatch = (
  data: string,
  ingressBytes: number,
  maxBatchBytes: number,
  writeNow: (
    data: string,
    ingressBytes: number,
    options?: CoalescedTerminalWriteOptions,
  ) => void,
  options: CoalescedTerminalWriteOptions = {},
): void => {
  const batchSize = Math.max(1, maxBatchBytes);
  const isSliced = data.length > batchSize;
  let offset = 0;
  let remainingIngressBytes = Math.max(0, ingressBytes);

  while (offset < data.length) {
    const end = Math.min(data.length, offset + batchSize);
    const slice = data.slice(offset, end);
    const sliceIngress = end >= data.length
      ? remainingIngressBytes
      : splitIngressBytes(
        data.length,
        ingressBytes,
        slice.length,
        remainingIngressBytes,
      );
    remainingIngressBytes -= sliceIngress;
    const nextOptions = {
      ...options,
      ...(isSliced ? {
        deferStart: true,
        yieldAfter: true,
      } : {}),
    };
    writeNow(
      slice,
      sliceIngress,
      Object.keys(nextOptions).length > 0 ? nextOptions : undefined,
    );
    offset = end;
  }
};

export const enqueueCoalescedTerminalWrite = (
  term: XTerm,
  data: string,
  writeNow: CoalescedTerminalWriteNow,
  ingressBytes: number = data.length,
): void => {
  const maxPendingBytes = resolveCoalescerByteCap(term);
  const canAutoFlush = shouldAutoFlushCoalescer(term);
  if (canAutoFlush && getPendingCoalescedBytes(term) + data.length > maxPendingBytes) {
    flushTerminalWriteCoalescer(term);
  }
  terminalWriteCoalescerWriters.set(term, writeNow);
  if (canAutoFlush && data.length > maxPendingBytes) {
    writeLargeTerminalBatch(
      data,
      ingressBytes,
      resolveTerminalWriteBatchBytes(data, maxPendingBytes),
      writeNow,
    );
    return;
  }

  terminalWriteCoalescerIngress.set(
    term,
    (terminalWriteCoalescerIngress.get(term) ?? 0) + ingressBytes,
  );
  terminalWriteCoalescerChunkCounts.set(
    term,
    (terminalWriteCoalescerChunkCounts.get(term) ?? 0) + 1,
  );

  let coalescer = terminalWriteCoalescers.get(term);
  if (!coalescer) {
    coalescer = createWriteCoalescer((batch) => {
      const batchIngress = takePendingIngressBytes(term, batch.length);
      const chunkCount = takePendingChunkCount(term);
      const activeWriteNow = terminalWriteCoalescerWriters.get(term) ?? writeNow;
      writeLargeTerminalBatch(
        batch,
        batchIngress,
        resolveTerminalWriteBatchBytes(batch, resolveCoalescerByteCap(term)),
        activeWriteNow,
        chunkCount === 1 ? {} : { preservePerfTrace: false },
      );
    }, {
      getMaxPendingBytes: () => resolveCoalescerByteCap(term),
      shouldFlushScheduledFrame: () => terminalWriteCoalescerFlushGates.get(term)?.() ?? true,
    });
    terminalWriteCoalescers.set(term, coalescer);
  }
  coalescer.push(data);
};

export const flushTerminalWriteCoalescer = (
  term: XTerm,
  writeNow?: CoalescedTerminalWriteNow,
): void => {
  const coalescer = terminalWriteCoalescers.get(term);
  if (!coalescer) return;
  if (!writeNow) {
    coalescer.flushSync();
    return;
  }
  coalescer.flushSync((batch) => {
    const batchIngress = takePendingIngressBytes(term, batch.length);
    const chunkCount = takePendingChunkCount(term);
    writeLargeTerminalBatch(
      batch,
      batchIngress,
      resolveTerminalWriteBatchBytes(batch, resolveCoalescerByteCap(term)),
      writeNow,
      chunkCount === 1 ? {} : { preservePerfTrace: false },
    );
  });
};

export const resetTerminalWriteCoalescer = (term: XTerm): void => {
  terminalWriteCoalescers.get(term)?.dispose();
  terminalWriteCoalescers.delete(term);
  terminalWriteCoalescerIngress.delete(term);
  terminalWriteCoalescerChunkCounts.delete(term);
  terminalWriteCoalescerByteCapResolvers.delete(term);
  terminalWriteCoalescerFlushGates.delete(term);
  terminalWriteCoalescerWriters.delete(term);
};

export const getTerminalWriteCoalescerPendingBytes = (term: XTerm): number =>
  getPendingCoalescedBytes(term);

export const getTerminalWriteCoalescerPendingIngressBytes = (term: XTerm): number =>
  terminalWriteCoalescerIngress.get(term) ?? 0;

export const abortTerminalWriteCoalescer = (
  term: XTerm,
  onDropped?: (bytes: number) => void,
): void => {
  const coalescer = terminalWriteCoalescers.get(term);
  if (!coalescer) return;
  const ingressDropped = takePendingIngressBytes(
    term,
    coalescer.pendingBytes(),
  );
  takePendingChunkCount(term);
  coalescer.abort();
  if (ingressDropped > 0) {
    onDropped?.(ingressDropped);
  }
};

/**
 * Choose the coalescer pending-byte cap based on flow/flood state.
 *
 * Important for issue #1961 (`tail -2000f` over SSH): when flow is paused we
 * must drain the renderer backlog as fast as possible so the SSH channel can
 * resume (each pause/resume costs ~1 RTT). Shrinking to tiny flood batches
 * while paused *slows* that drain and multiplies wall-clock time.
 *
 * - Flow paused → keep the bulk cap so large plain dumps drain quickly.
 * - Queue flood only → use the flood cap (large enough for bulk, smaller than
 *   bulk so interactive frames can interleave).
 * - Normal → bulk cap.
 */
export const resolveFloodCoalescerByteCap = (
  isFlowPaused: boolean,
  queueInFloodMode: boolean,
): number => {
  if (isFlowPaused) {
    return MAX_PENDING_WRITE_COALESCE_BYTES;
  }
  if (queueInFloodMode) {
    return MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD;
  }
  return MAX_PENDING_WRITE_COALESCE_BYTES;
};
