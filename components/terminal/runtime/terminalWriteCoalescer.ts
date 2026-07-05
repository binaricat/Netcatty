import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
} from "./terminalFlowConstants";
import { createWriteCoalescer, type WriteCoalescer } from "./writeCoalescer.ts";

type CoalescerByteCapResolver = () => number;
export type CoalescedTerminalWriteOptions = {
  deferStart?: boolean;
  yieldAfter?: boolean;
};
type CoalescedTerminalWriteNow = (
  data: string,
  ingressBytes: number,
  options?: CoalescedTerminalWriteOptions,
) => void;

const terminalWriteCoalescers = new WeakMap<XTerm, WriteCoalescer>();
const terminalWriteCoalescerIngress = new WeakMap<XTerm, number>();
const terminalWriteCoalescerByteCapResolvers = new WeakMap<XTerm, CoalescerByteCapResolver>();
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

const getPendingCoalescedBytes = (term: XTerm): number =>
  terminalWriteCoalescers.get(term)?.pendingBytes() ?? 0;

const takePendingIngressBytes = (term: XTerm, fallback = 0): number => {
  const pending = terminalWriteCoalescerIngress.get(term) ?? fallback;
  terminalWriteCoalescerIngress.delete(term);
  return pending;
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
    writeNow(slice, sliceIngress, isSliced ? {
      deferStart: true,
      yieldAfter: true,
    } : undefined);
    offset = end;
  }
};

export const enqueueCoalescedTerminalWrite = (
  term: XTerm,
  data: string,
  writeNow: CoalescedTerminalWriteNow,
  ingressBytes: number = data.length,
): void => {
  terminalWriteCoalescerWriters.set(term, writeNow);
  const maxPendingBytes = resolveCoalescerByteCap(term);
  if (getPendingCoalescedBytes(term) + data.length > maxPendingBytes) {
    flushTerminalWriteCoalescer(term);
  }
  if (data.length > maxPendingBytes) {
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

  let coalescer = terminalWriteCoalescers.get(term);
  if (!coalescer) {
    coalescer = createWriteCoalescer((batch) => {
      const batchIngress = takePendingIngressBytes(term, batch.length);
      const activeWriteNow = terminalWriteCoalescerWriters.get(term) ?? writeNow;
      writeLargeTerminalBatch(
        batch,
        batchIngress,
        resolveTerminalWriteBatchBytes(batch, resolveCoalescerByteCap(term)),
        activeWriteNow,
      );
    }, {
      getMaxPendingBytes: () => resolveCoalescerByteCap(term),
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
    writeLargeTerminalBatch(
      batch,
      batchIngress,
      resolveTerminalWriteBatchBytes(batch, resolveCoalescerByteCap(term)),
      writeNow,
    );
  });
};

export const resetTerminalWriteCoalescer = (term: XTerm): void => {
  terminalWriteCoalescers.get(term)?.dispose();
  terminalWriteCoalescers.delete(term);
  terminalWriteCoalescerIngress.delete(term);
  terminalWriteCoalescerByteCapResolvers.delete(term);
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
  coalescer.abort();
  if (ingressDropped > 0) {
    onDropped?.(ingressDropped);
  }
};

export const resolveFloodCoalescerByteCap = (
  isFlowPaused: boolean,
  queueInFloodMode: boolean,
): number => (
  isFlowPaused || queueInFloodMode
    ? MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD
    : MAX_PENDING_WRITE_COALESCE_BYTES
);
