import type { Terminal as XTerm } from "@xterm/xterm";

import {
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES,
} from "./terminalFlowConstants";
import { shouldDegradeTerminalSideWork } from "./terminalOutputPressure";
import {
  createWriteCoalescer,
  type WriteCoalesceScheduleMode,
  type WriteCoalescer,
} from "./writeCoalescer.ts";

const ESC = String.fromCharCode(0x1b);
/** 8-bit C1 CSI (0x9b); xterm accepts this as equivalent to ESC [. */
const C1_CSI = String.fromCharCode(0x9b);
const ALT_SCREEN_DECSET = new Set(["47", "1047", "1049"]);
/** Cap incomplete CSI param buffer (real sequences are far shorter). */
const MAX_INCOMPLETE_CSI_PARAMS = 48;

type IncompletePrivateCsi = {
  /** 0=ESC, 1=ESC[, 2=ESC[? or C1?, 3=C1 alone */
  phase: 0 | 1 | 2 | 3;
  /** Accumulated private-mode params after '?' */
  params: string;
};

/** Incomplete private CSI state retained across coalescer flushes. */
const incompleteAltScreenCsiByTerm = new WeakMap<XTerm, IncompletePrivateCsi>();
/**
 * Set after a complete enter-alt-screen CSI is observed, until xterm reports
 * `buffer.active.type === "alternate"` (parser is async relative to our schedule).
 */
const pendingAltScreenEntryByTerm = new WeakMap<XTerm, true>();
/** True once we have observed the alternate buffer live on this term. */
const observedAltScreenByTerm = new WeakMap<XTerm, true>();
/** Leave CSI was queued while xterm still reported the alternate buffer. */
const pendingAltScreenLeaveByTerm = new WeakMap<XTerm, true>();
/** One-shot: schedule mode consumes a probe already applied for this push. */
const preappliedAltScreenNeedsRafByTerm = new WeakMap<XTerm, boolean>();

/** Test-only: counts full CSI scans in probeAltScreenScheduling. */
let altScreenProbeScanCountForTests = 0;
export const getAltScreenProbeScanCountForTests = (): number => altScreenProbeScanCountForTests;
export const resetAltScreenProbeScanCountForTests = (): void => {
  altScreenProbeScanCountForTests = 0;
};

const isPrivateParamCharCode = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || code === 0x3b;

type AltScreenProbeResult = {
  needsRaf: boolean;
  incomplete: IncompletePrivateCsi | null;
  lastTransition: "enter" | "leave" | null;
  /** Raw offset where a new alternate-screen frame (or possible split entry) starts. */
  frameStart: number | null;
  /** Raw offset immediately after the final transition back to normal screen. */
  normalScreenStart: number | null;
};

/**
 * Single left-to-right scan for 7-bit (`ESC[?…`) and 8-bit (`CSI?…`) private
 * DECSET modes that enter/leave the alternate screen. Resumes from incomplete
 * parser state so long param lists can span PTY/schedule flushes.
 */
const probeAltScreenScheduling = (
  data: string,
  resume: IncompletePrivateCsi | null,
): AltScreenProbeResult => {
  altScreenProbeScanCountForTests += 1;
  let phase: IncompletePrivateCsi["phase"] | null = resume?.phase ?? null;
  let params = resume?.params ?? "";
  let lastTransition: "enter" | "leave" | null = null;
  let incomplete: IncompletePrivateCsi | null = null;
  let sequenceStart = resume ? 0 : -1;
  let frameStart: number | null = null;
  let normalScreenStart: number | null = null;

  const finishPrivate = (final: string, endOffset: number): void => {
    const parts = params.split(";").filter(Boolean);
    if (parts.some((param) => ALT_SCREEN_DECSET.has(param))) {
      lastTransition = final === "h" ? "enter" : "leave";
      if (final === "h" && frameStart === null) {
        frameStart = Math.max(0, sequenceStart);
      }
      normalScreenStart = final === "l" ? endOffset : null;
    }
    phase = null;
    params = "";
    sequenceStart = -1;
  };

  for (let i = 0; i < data.length; i += 1) {
    const ch = data.charAt(i);
    const code = data.charCodeAt(i);

    if (phase === null) {
      if (ch === ESC) {
        phase = 0;
        params = "";
        sequenceStart = i;
        continue;
      }
      if (ch === C1_CSI) {
        phase = 3;
        params = "";
        sequenceStart = i;
        continue;
      }
      continue;
    }

    if (phase === 0) {
      // After ESC: expect '[' (CSI) or 'c' (RIS full reset).
      if (ch === "[") {
        phase = 1;
        continue;
      }
      if (ch === "c") {
        // RIS returns the terminal to the normal screen without DECSET leave.
        lastTransition = "leave";
        normalScreenStart = i + 1;
        phase = null;
        params = "";
        sequenceStart = -1;
        continue;
      }
      phase = null;
      params = "";
      sequenceStart = -1;
      i -= 1; // reprocess this char as potential start
      continue;
    }

    if (phase === 1) {
      // After ESC[: expect '?'
      if (ch === "?") {
        phase = 2;
        params = "";
        continue;
      }
      phase = null;
      params = "";
      sequenceStart = -1;
      i -= 1;
      continue;
    }

    if (phase === 3) {
      // After C1 CSI: expect '?'
      if (ch === "?") {
        phase = 2;
        params = "";
        continue;
      }
      phase = null;
      params = "";
      sequenceStart = -1;
      i -= 1;
      continue;
    }

    // phase === 2: private params then final byte
    if (isPrivateParamCharCode(code)) {
      if (params.length < MAX_INCOMPLETE_CSI_PARAMS) {
        params += ch;
      }
      continue;
    }
    if (ch === "h" || ch === "l") {
      finishPrivate(ch, i + 1);
      continue;
    }
    // Abort incomplete private mode. ESC / C1 start a new sequence (xterm does
    // the same) — reprocess this byte as a fresh introducer.
    phase = null;
    params = "";
    sequenceStart = -1;
    if (ch === ESC || ch === C1_CSI) {
      i -= 1;
    }
  }

  if (phase !== null) {
    incomplete = { phase, params };
    if (frameStart === null) {
      frameStart = Math.max(0, sequenceStart);
    }
  }

  return {
    needsRaf: lastTransition === "enter" || incomplete !== null,
    incomplete,
    lastTransition,
    frameStart,
    normalScreenStart,
  };
};

const isTerminalAlternateScreenActive = (term: XTerm): boolean => {
  try {
    return (term.buffer?.active as { type?: string } | undefined)?.type === "alternate";
  } catch {
    return false;
  }
};

/**
 * Keep a pending write atomic when it is part of an alternate-screen frame.
 * This includes enter sequences that xterm has not parsed yet, including a
 * private CSI split across PTY chunks.
 */
export const shouldPreserveTerminalWriteFrameBatch = (term: XTerm): boolean => (
  (!pendingAltScreenLeaveByTerm.has(term) && isTerminalAlternateScreenActive(term))
  || observedAltScreenByTerm.has(term)
  || pendingAltScreenEntryByTerm.has(term)
  || incompleteAltScreenCsiByTerm.has(term)
);

/**
 * Apply a completed alt-screen probe to per-term latches.
 * Returns whether the next write schedule should use rAF.
 */
const applyAltScreenScheduleProbeResult = (
  term: XTerm,
  probe: AltScreenProbeResult,
): boolean => {
  if (probe.incomplete) {
    incompleteAltScreenCsiByTerm.set(term, probe.incomplete);
  } else {
    incompleteAltScreenCsiByTerm.delete(term);
  }

  if (probe.lastTransition === "leave") {
    pendingAltScreenEntryByTerm.delete(term);
    observedAltScreenByTerm.delete(term);
    pendingAltScreenLeaveByTerm.set(term, true);
  } else if (probe.lastTransition === "enter") {
    // Complete enter CSI observed; xterm may still report normal until parse.
    pendingAltScreenEntryByTerm.set(term, true);
    pendingAltScreenLeaveByTerm.delete(term);
  }

  if (isTerminalAlternateScreenActive(term)) {
    if (pendingAltScreenLeaveByTerm.has(term)) {
      // Schedule the leave with the current TUI frame, but do not re-latch the
      // old alternate state while xterm is still parsing the queued leave.
      return true;
    }
    // Buffer realized alternate — drop enter-pending (no longer needed).
    observedAltScreenByTerm.set(term, true);
    pendingAltScreenEntryByTerm.delete(term);
    return true;
  }

  // Left alternate without a recognized leave CSI (e.g. RIS / ESC c).
  if (observedAltScreenByTerm.has(term)) {
    observedAltScreenByTerm.delete(term);
    pendingAltScreenEntryByTerm.delete(term);
  }
  pendingAltScreenLeaveByTerm.delete(term);

  return (
    probe.needsRaf
    || pendingAltScreenEntryByTerm.has(term)
  );
};

const noteAltScreenScheduleProbe = (term: XTerm, chunk: string): boolean => {
  // Always scan the chunk first so leave-alt CSI is observed even while
  // buffer.active still reports "alternate" (parser lags our write schedule).
  const resume = incompleteAltScreenCsiByTerm.get(term) ?? null;
  const probe = probeAltScreenScheduling(chunk, resume);
  return applyAltScreenScheduleProbeResult(term, probe);
};

type CoalescerByteCapResolver = () => number;
type CoalescerFlushGate = () => boolean;
export type CoalescedTerminalWriteOptions = {
  deferStart?: boolean;
  yieldAfter?: boolean;
  preservePerfTrace?: boolean;
  /** Raw offsets where later PTY chunks begin inside this coalesced batch. */
  sourceChunkBoundaries?: readonly number[];
};
export type EnqueueCoalescedTerminalWriteOptions = {
  /** Keep original PTY chunks intact when prompt formatting depends on them. */
  preserveSourceChunkBoundaries?: boolean;
};
type CoalescedTerminalWriteNow = (
  data: string,
  ingressBytes: number,
  options?: CoalescedTerminalWriteOptions,
) => void;

const terminalWriteCoalescers = new WeakMap<XTerm, WriteCoalescer>();
const terminalWriteCoalescerIngress = new WeakMap<XTerm, number>();
const terminalWriteCoalescerChunkCounts = new WeakMap<XTerm, number>();
const terminalWriteCoalescerChunkBoundaries = new WeakMap<XTerm, number[]>();
const terminalWriteCoalescerPreserveSourceChunks = new WeakSet<XTerm>();
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

const takePendingChunkBoundaries = (term: XTerm): number[] => {
  const boundaries = terminalWriteCoalescerChunkBoundaries.get(term) ?? [];
  terminalWriteCoalescerChunkBoundaries.delete(term);
  return boundaries;
};

const takePendingPreserveSourceChunks = (term: XTerm): boolean => {
  const preserve = terminalWriteCoalescerPreserveSourceChunks.has(term);
  terminalWriteCoalescerPreserveSourceChunks.delete(term);
  return preserve;
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
const SOURCE_BOUNDARY_SLICE_SLACK_BYTES = 1024;

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

/**
 * Cap how much plain text reaches xterm in one write().
 *
 * Tabby's FlowControl thresholds ~128KB before tracking write callbacks.
 * Multi-line floods (`seq`, log dumps) are plain text with newlines — they
 * must use the same cap as long unbroken runs. Leaving them at the coalescer
 * pending cap (1MB) feeds hundreds of thousands of buffer lines into a single
 * parse turn and freezes the whole Electron UI.
 */
const resolveTerminalWriteBatchBytes = (
  data: string,
  maxPendingBytes: number,
): number => {
  if (!isPlainTerminalOutput(data)) {
    return maxPendingBytes;
  }
  if (hasLongUnbrokenRun(data, MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES)) {
    return Math.min(maxPendingBytes, MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES);
  }
  return Math.min(maxPendingBytes, MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES);
};

/**
 * Cooperative yield budget between sliced xterm writes.
 *
 * Plain bulk dumps yield after every slice (~128KB, Tabby-like) so paint and
 * input can run between shards. CSI/TUI batches keep a larger drain budget so
 * multi-chunk frames are not chopped into stuttery 128KB pauses.
 */
const resolveSliceYieldBudgetBytes = (data: string, batchSize: number): number => {
  if (isPlainTerminalOutput(data)) {
    return Math.max(1, batchSize);
  }
  return Math.max(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES, MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES);
};

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
  preserveSourceChunkBoundaries = false,
): void => {
  const batchSize = Math.max(1, maxBatchBytes);
  const isSliced = data.length > batchSize;
  const yieldBudget = resolveSliceYieldBudgetBytes(data, batchSize);
  const { sourceChunkBoundaries = [], ...baseOptions } = options;
  let offset = 0;
  let remainingIngressBytes = Math.max(0, ingressBytes);
  let bytesSinceYield = 0;
  let sourceBoundaryIndex = 0;

  while (offset < data.length) {
    while (
      sourceBoundaryIndex < sourceChunkBoundaries.length
      && sourceChunkBoundaries[sourceBoundaryIndex] <= offset
    ) {
      sourceBoundaryIndex += 1;
    }
    const idealEnd = Math.min(data.length, offset + batchSize);
    let end = idealEnd;
    if (preserveSourceChunkBoundaries && idealEnd < data.length) {
      // Prompt formatting treats each original PTY chunk as a semantic unit.
      // Keep one intact when it crosses an otherwise arbitrary bulk slice.
      let boundaryEndIndex = sourceBoundaryIndex;
      while (
        boundaryEndIndex < sourceChunkBoundaries.length
        && sourceChunkBoundaries[boundaryEndIndex] <= idealEnd
      ) {
        boundaryEndIndex += 1;
      }
      if (boundaryEndIndex > sourceBoundaryIndex) {
        end = sourceChunkBoundaries[boundaryEndIndex - 1];
      }
      if (end === idealEnd) {
        const nextBoundary = sourceChunkBoundaries[boundaryEndIndex];
        const boundarySlack = Math.min(batchSize, SOURCE_BOUNDARY_SLICE_SLACK_BYTES);
        if (
          nextBoundary !== undefined
          && nextBoundary > idealEnd
          && nextBoundary - idealEnd <= boundarySlack
        ) {
          // A prompt can end just after the nominal slice boundary. Extending
          // by a small bounded amount keeps that PTY chunk intact without
          // giving up cooperative bulk-write limits.
          end = nextBoundary;
        }
      }
      // A prompt may share its PTY chunk with preceding output. If no source
      // boundary helped, leave enough tail for the final prompt to stay whole.
      if (end === idealEnd) {
        const minimumFinalSliceBytes = Math.min(batchSize, 1024);
        const finalSliceStart = data.length - minimumFinalSliceBytes;
        if (finalSliceStart > offset && idealEnd > finalSliceStart) {
          end = finalSliceStart;
        }
      }
    }
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
    const isLast = end >= data.length;
    bytesSinceYield += slice.length;
    const shouldYield = isSliced && !isLast && bytesSinceYield >= yieldBudget;
    if (shouldYield) {
      bytesSinceYield = 0;
    }
    const sliceChunkBoundaries: number[] = [];
    while (
      sourceBoundaryIndex < sourceChunkBoundaries.length
      && sourceChunkBoundaries[sourceBoundaryIndex] < end
    ) {
      sliceChunkBoundaries.push(sourceChunkBoundaries[sourceBoundaryIndex] - offset);
      sourceBoundaryIndex += 1;
    }
    const nextOptions = {
      ...baseOptions,
      ...(shouldYield ? { yieldAfter: true } : {}),
      ...(sliceChunkBoundaries.length > 0
        ? { sourceChunkBoundaries: sliceChunkBoundaries }
        : {}),
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
  enqueueOptions: EnqueueCoalescedTerminalWriteOptions = {},
): void => {
  const resumedAltScreenCsi = incompleteAltScreenCsiByTerm.has(term);
  // Single CSI scan for frame split + schedule latch (not a second full pass).
  const frameProbe = probeAltScreenScheduling(
    data,
    incompleteAltScreenCsiByTerm.get(term) ?? null,
  );
  const startsNewFrame = frameProbe.frameStart !== null
    && !(resumedAltScreenCsi && frameProbe.frameStart === 0);
  const flushAfterAltScreenLeave = frameProbe.normalScreenStart !== null;
  if (startsNewFrame) {
    // Keep ordinary shell output out of an alternate-screen frame. Otherwise a
    // frame held across a clock boundary makes the preceding shell line inherit
    // the later timestamp when the batch finally drains.
    flushTerminalWriteCoalescer(term);
    const frameStart = frameProbe.frameStart!;
    if (frameStart > 0) {
      const prefix = data.slice(0, frameStart);
      const prefixIngress = splitIngressBytes(
        data.length,
        ingressBytes,
        prefix.length,
        ingressBytes,
      );
      // Prefix may not be the enter CSI; re-probe only those bytes.
      noteAltScreenScheduleProbe(term, prefix);
      writeLargeTerminalBatch(
        prefix,
        prefixIngress,
        resolveTerminalWriteBatchBytes(prefix, resolveCoalescerByteCap(term)),
        writeNow,
        {},
        enqueueOptions.preserveSourceChunkBoundaries === true,
      );
      enqueueCoalescedTerminalWrite(
        term,
        data.slice(frameStart),
        writeNow,
        Math.max(0, ingressBytes - prefixIngress),
        enqueueOptions,
      );
      return;
    }
  }

  // Apply the single full-chunk probe once before schedule/push or oversized write.
  const needsRafFromProbe = applyAltScreenScheduleProbeResult(term, frameProbe);

  const maxPendingBytes = resolveCoalescerByteCap(term);
  // Size caps always drain, even when the frame gate holds scheduled flushes
  // (hidden panes). Otherwise continuous logs pile multi-MB joins for the
  // timed drain window and defeat the original batching bound.
  // Flush *previous* pending with its existing writer before installing this
  // call's writeNow — preserves per-chunk writer identity under cap pressure.
  if (getPendingCoalescedBytes(term) + data.length > maxPendingBytes) {
    flushTerminalWriteCoalescer(term);
  }
  terminalWriteCoalescerWriters.set(term, writeNow);
  if (data.length > maxPendingBytes) {
    // Oversized batches skip the coalescer frame arm; probe already latched above.
    writeLargeTerminalBatch(
      data,
      ingressBytes,
      resolveTerminalWriteBatchBytes(data, maxPendingBytes),
      writeNow,
      {},
      enqueueOptions.preserveSourceChunkBoundaries === true,
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
  if (enqueueOptions.preserveSourceChunkBoundaries) {
    terminalWriteCoalescerPreserveSourceChunks.add(term);
  }
  const pendingBytesBeforePush = getPendingCoalescedBytes(term);
  if (
    terminalWriteCoalescerPreserveSourceChunks.has(term)
    && pendingBytesBeforePush > 0
  ) {
    const boundaries = terminalWriteCoalescerChunkBoundaries.get(term) ?? [];
    boundaries.push(pendingBytesBeforePush);
    terminalWriteCoalescerChunkBoundaries.set(term, boundaries);
  }

  // Hand the already-applied probe result to schedule mode so push() does not
  // re-scan these bytes.
  preappliedAltScreenNeedsRafByTerm.set(term, needsRafFromProbe);

  let coalescer = terminalWriteCoalescers.get(term);
  if (!coalescer) {
    coalescer = createWriteCoalescer((batch) => {
      const batchIngress = takePendingIngressBytes(term, batch.length);
      const chunkCount = takePendingChunkCount(term);
      const sourceChunkBoundaries = takePendingChunkBoundaries(term);
      const preserveSourceChunkBoundaries = takePendingPreserveSourceChunks(term);
      const activeWriteNow = terminalWriteCoalescerWriters.get(term) ?? writeNow;
      writeLargeTerminalBatch(
        batch,
        batchIngress,
        resolveTerminalWriteBatchBytes(batch, resolveCoalescerByteCap(term)),
        activeWriteNow,
        chunkCount === 1
          ? {}
          : { preservePerfTrace: false, sourceChunkBoundaries },
        preserveSourceChunkBoundaries,
      );
    }, {
      getMaxPendingBytes: () => resolveCoalescerByteCap(term),
      shouldFlushScheduledFrame: () => terminalWriteCoalescerFlushGates.get(term)?.() ?? true,
      // Tabby streams normal-screen output without waiting for vsync. Keep rAF
      // for alternate-screen TUIs (including the enter-alt burst before xterm
      // has switched buffer.active.type) so multi-chunk repaints stay atomic.
      // When rAF is unavailable (Node unit tests), prefer the "raf" mode so the
      // coalescer falls back to an immediate flush (legacy test contract).
      resolveScheduleMode: ({ nextChunk }): WriteCoalesceScheduleMode => {
        const preapplied = preappliedAltScreenNeedsRafByTerm.get(term);
        if (preapplied !== undefined) {
          preappliedAltScreenNeedsRafByTerm.delete(term);
          if (preapplied) return "raf";
        } else if (noteAltScreenScheduleProbe(term, nextChunk)) {
          // Later pushes (or paths without a preapplied probe) still scan once.
          return "raf";
        }
        // Bulk pressure: prefer rAF so the browser can paint between flushes.
        // Microtask packing of seq/log floods pins the main thread for many
        // consecutive turns (Tabby instead back-pressures on write callbacks).
        if (shouldDegradeTerminalSideWork(term)) {
          return "raf";
        }
        const canUseMicrotask = typeof queueMicrotask === "function"
          && typeof globalThis.requestAnimationFrame === "function";
        if (canUseMicrotask) {
          return "microtask";
        }
        return "raf";
      },
    });
    terminalWriteCoalescers.set(term, coalescer);
  }
  coalescer.push(data);
  // If push did not consume the preapplied flag (e.g. empty/disposed), drop it.
  preappliedAltScreenNeedsRafByTerm.delete(term);
  if (flushAfterAltScreenLeave) {
    // Do not let shell output after a TUI exit inherit a later batch timestamp.
    // Keeping the leave and its same-chunk suffix together also lets the
    // timestamp parser observe the transition before stamping that suffix.
    flushTerminalWriteCoalescer(term);
  }
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
    const sourceChunkBoundaries = takePendingChunkBoundaries(term);
    const preserveSourceChunkBoundaries = takePendingPreserveSourceChunks(term);
    writeLargeTerminalBatch(
      batch,
      batchIngress,
      resolveTerminalWriteBatchBytes(batch, resolveCoalescerByteCap(term)),
      writeNow,
      chunkCount === 1
        ? {}
        : { preservePerfTrace: false, sourceChunkBoundaries },
      preserveSourceChunkBoundaries,
    );
  });
};

export const resetTerminalWriteCoalescer = (term: XTerm): void => {
  terminalWriteCoalescers.get(term)?.dispose();
  terminalWriteCoalescers.delete(term);
  terminalWriteCoalescerIngress.delete(term);
  terminalWriteCoalescerChunkCounts.delete(term);
  terminalWriteCoalescerChunkBoundaries.delete(term);
  terminalWriteCoalescerPreserveSourceChunks.delete(term);
  terminalWriteCoalescerByteCapResolvers.delete(term);
  terminalWriteCoalescerFlushGates.delete(term);
  terminalWriteCoalescerWriters.delete(term);
  incompleteAltScreenCsiByTerm.delete(term);
  pendingAltScreenEntryByTerm.delete(term);
  observedAltScreenByTerm.delete(term);
  pendingAltScreenLeaveByTerm.delete(term);
  preappliedAltScreenNeedsRafByTerm.delete(term);
};

export const getTerminalWriteCoalescerPendingBytes = (term: XTerm): number =>
  getPendingCoalescedBytes(term);

export const getTerminalWriteCoalescerPendingIngressBytes = (term: XTerm): number =>
  terminalWriteCoalescerIngress.get(term) ?? 0;

export const abortTerminalWriteCoalescer = (
  term: XTerm,
  onDropped?: (bytes: number) => void,
): void => {
  // Always clear alt-screen schedule state, even when no coalescer exists.
  // Oversized direct-write path can latch enter-alt via noteAltScreenScheduleProbe
  // without creating a coalescer; if Ctrl-C drops that queued batch before xterm
  // parses it, a sticky latch would force rAF for later normal-screen output.
  incompleteAltScreenCsiByTerm.delete(term);
  pendingAltScreenEntryByTerm.delete(term);
  observedAltScreenByTerm.delete(term);
  pendingAltScreenLeaveByTerm.delete(term);
  preappliedAltScreenNeedsRafByTerm.delete(term);

  const coalescer = terminalWriteCoalescers.get(term);
  if (!coalescer) return;
  const ingressDropped = takePendingIngressBytes(
    term,
    coalescer.pendingBytes(),
  );
  takePendingChunkCount(term);
  takePendingChunkBoundaries(term);
  takePendingPreserveSourceChunks(term);
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
