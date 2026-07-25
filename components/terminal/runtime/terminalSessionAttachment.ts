import type { Terminal as XTerm } from "@xterm/xterm";
import {
  scrollTerminalToBottomIfNeeded,
  shouldScrollOnTerminalOutput,
} from "../../../domain/terminalScroll";
import { logger } from "../../../lib/logger";
import type { Host, TerminalSettings } from "../../../types";
import {
  clearPasteResidualAfterTerminalWrite,
  prepareTerminalDataForUserPasteDisplay,
} from "./terminalUserPaste";
import {
  detectTerminalCommandCompletions,
  findTerminalPromptSourceChunkVisibleStarts,
  prepareTerminalDataForPromptLineBreak,
  syncPromptLineBreakState,
} from "./promptLineBreak";
import { createOutputFlowController, type OutputFlowController } from "./outputFlowController";
import type {
  TerminalSessionDataMeta,
  TerminalSessionStartersContext,
} from "./createTerminalSessionStarters.types";
import { clearConnectionToken } from "./terminalDistroDetection";
import {
  resetTerminalLineTimestamps,
  type TerminalLineTimestampPerfStep,
  writeTerminalDataWithLineTimestamps,
} from "./terminalLineTimestamps";
import {
  createTerminalOutputPerfTrace,
  logTerminalOutputPerf,
  type TerminalOutputPerfTrace,
} from "./terminalPerformanceDiagnostics";
import {
  noteTerminalOutputPressureData,
  resetTerminalOutputPressure,
  setTerminalOutputPressureVisibility,
  shouldDegradeTerminalSideWork,
} from "./terminalOutputPressure";
import {
  createSudoPasswordAutofill,
  type SudoPasswordAutofillCandidate,
} from "./terminalSudoAutofill";
import {
  filterTerminalSessionData,
  isTerminalSyncBlockOpen,
  resetTerminalSyncBlockFilter,
} from "./terminalSyncBlockFilter";
import { appendEraseScrollbackAfterFullErases } from "../clearTerminalViewport";
import {
  type CoalescedTerminalWriteOptions,
  enqueueCoalescedTerminalWrite,
  flushTerminalWriteCoalescer,
  getTerminalWriteCoalescerPendingBytes,
  resolveFloodCoalescerByteCap,
  setTerminalWriteCoalescerByteCapResolver,
  setTerminalWriteCoalescerFlushGate,
  shouldPreserveTerminalWriteFrameBatch,
} from "./terminalWriteCoalescer";
import {
  accumulateDeferredTerminalWriteAck,
  clearDeferredTerminalWriteAck,
  getDeferredTerminalWriteAckBytes,
  resetDeferredTerminalWriteAck,
  scheduleDeferredTerminalWriteAckFlush,
  shouldDeferTerminalWriteCallback,
} from "./terminalWriteAckDeferral";
import {
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
  XTERM_WRITE_CALLBACK_BATCH_BYTES,
  XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
} from "./terminalFlowConstants";
import {
  ackTerminalSessionFlow,
  flushTerminalSessionFlowAck,
} from "./terminalFlowAckBuffer";
import {
  enqueueTerminalWrite,
  flushTerminalWriteQueueBypassingTimers,
  isTerminalWriteQueueInFloodMode,
  setTerminalWriteQueueDropHandler,
} from "./terminalWriteQueue";
import {
  filterTerminalInterruptDisplayOutput,
  releaseTerminalFlowOutputForTerm,
  teardownTerminalOutputPipeline,
} from "./terminalOutputPipeline";
import {
  flushTerminalWriteBufferBypassingTimers,
  hasPendingTerminalWrites,
  maybeFlushTerminalWriteCoalescerWhenUnfocused,
  scheduleTerminalRepaintWhenUnfocused,
  shouldFlushTerminalWritesForBackgroundOutput,
} from "./terminalUnfocusedRepaint";

export { FLOW_HIGH_WATER_MARK, FLOW_LOW_WATER_MARK };

export const buildTermEnv = (host: Host, terminalSettings?: TerminalSettings) => {
  const env: Record<string, string> = {
    TERM: terminalSettings?.terminalEmulationType ?? "xterm-256color",
  };

  if (host.environmentVariables) {
    for (const { name, value } of host.environmentVariables) {
      if (name) env[name] = value;
    }
  }

  return env;
};

const isTerminalPaneVisible = (ctx: TerminalSessionStartersContext): boolean => (
  (ctx.isPaneVisibleRef?.current ?? ctx.isVisibleRef?.current) !== false
);

const handleTerminalOutputAutoScroll = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
) => {
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  if (!shouldScrollOnTerminalOutput(settings)) {
    return;
  }

  if (!isTerminalPaneVisible(ctx)) {
    notePendingOutputScrollIfEnabled(ctx);
    return;
  }

  scrollTerminalToBottomIfNeeded(term);
};

export const notePendingOutputScrollIfEnabled = (
  ctx: TerminalSessionStartersContext,
): void => {
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  if (!shouldScrollOnTerminalOutput(settings)) return;
  if (ctx.pendingOutputScrollRef) {
    ctx.pendingOutputScrollRef.current = true;
  }
};

const terminalFlowControllers = new WeakMap<XTerm, OutputFlowController>();

type TerminalSessionWriteOptions = CoalescedTerminalWriteOptions & {
  flushXtermWriteBuffer?: boolean;
  perfTrace?: TerminalOutputPerfTrace | null;
  timestampDate?: Date;
};

const BACKGROUND_OUTPUT_FLUSH_MAX_PASSES = 64;
const LARGE_WRITE_FLUSH_WATCHDOG_BYTES = 64 * 1024;
const LARGE_WRITE_FLUSH_WATCHDOG_MS = 250;
// With microtask coalescing, idle flush is only a safety net for rAF TUI path
// and any leftover queue work — keep it short so the last batch does not lag.
const VISIBLE_WRITE_IDLE_FLUSH_MS = 24;
const HIDDEN_PANE_DRAIN_MS = 160;
const visibleWriteIdleFlushTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();
const hiddenPaneDrainTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();
const pendingTimestampSecondByTerm = new WeakMap<XTerm, number>();

type LineTimestampPerfTotals = {
  segmentCalls: number;
  segmentMs: number;
  dataSegments: number;
  timestampSegments: number;
  batchedWrites: number;
  segmentedWrites: number;
  fallbackWrites: number;
  writeCalls: number;
  timestamps: number;
  measureMs: number;
  markerMs: number;
  xtermWriteCallbackMs: number;
  parsedChars: number;
  measuredRows: number;
};

const createLineTimestampPerfTotals = (): LineTimestampPerfTotals => ({
  segmentCalls: 0,
  segmentMs: 0,
  dataSegments: 0,
  timestampSegments: 0,
  batchedWrites: 0,
  segmentedWrites: 0,
  fallbackWrites: 0,
  writeCalls: 0,
  timestamps: 0,
  measureMs: 0,
  markerMs: 0,
  xtermWriteCallbackMs: 0,
  parsedChars: 0,
  measuredRows: 0,
});

const roundMs = (value: number): number => Number(value.toFixed(1));

const recordLineTimestampPerfStep = (
  totals: LineTimestampPerfTotals,
  step: TerminalLineTimestampPerfStep,
): void => {
  if (step.kind === "segment") {
    totals.segmentCalls += 1;
    totals.segmentMs += step.durationMs;
    totals.dataSegments += step.dataSegmentCount;
    totals.timestampSegments += step.timestampSegmentCount;
    totals.parsedChars += step.parsedChars;
    return;
  }
  if (step.kind === "batched-write") {
    totals.batchedWrites += 1;
    totals.writeCalls += 1;
    totals.timestamps += step.timestamps;
    totals.measureMs += step.measureMs;
    totals.markerMs += step.markerMs;
    totals.xtermWriteCallbackMs += step.writeCallbackMs;
    totals.measuredRows += step.rowOffset;
    return;
  }
  if (step.kind === "segmented-write") {
    totals.segmentedWrites += 1;
    totals.writeCalls += step.writeCalls;
    totals.timestamps += step.timestamps;
    totals.xtermWriteCallbackMs += step.writeCallbackMs;
    return;
  }
  totals.fallbackWrites += 1;
  totals.writeCalls += 1;
  totals.xtermWriteCallbackMs += step.writeCallbackMs;
};

const summarizeLineTimestampPerf = (totals: LineTimestampPerfTotals) => ({
  segmentCalls: totals.segmentCalls,
  segmentMs: roundMs(totals.segmentMs),
  dataSegments: totals.dataSegments,
  timestampSegments: totals.timestampSegments,
  batchedWrites: totals.batchedWrites,
  segmentedWrites: totals.segmentedWrites,
  fallbackWrites: totals.fallbackWrites,
  writeCalls: totals.writeCalls,
  timestamps: totals.timestamps,
  measureMs: roundMs(totals.measureMs),
  markerMs: roundMs(totals.markerMs),
  xtermWriteCallbackMs: roundMs(totals.xtermWriteCallbackMs),
  parsedChars: totals.parsedChars,
  measuredRows: totals.measuredRows,
});

const flushTerminalWritesForBackgroundOutput = (term: XTerm): void => {
  flushTerminalWriteBufferBypassingTimers(term);
  for (let pass = 0; pass < BACKGROUND_OUTPUT_FLUSH_MAX_PASSES; pass += 1) {
    if (!flushTerminalWriteQueueBypassingTimers(term)) {
      return;
    }
    flushTerminalWriteBufferBypassingTimers(term);
  }
};

const cancelHiddenPaneDrain = (term: XTerm): void => {
  const timer = hiddenPaneDrainTimers.get(term);
  if (timer === undefined) return;
  clearTimeout(timer);
  hiddenPaneDrainTimers.delete(term);
};

const flushPendingTerminalOutputNow = (term: XTerm): void => {
  cancelHiddenPaneDrain(term);
  flushTerminalWriteCoalescer(term);
  flushTerminalWritesForBackgroundOutput(term);
};

const flushBeforeTimestampBoundary = (
  term: XTerm,
  timestampDate: Date,
): void => {
  const timestampSecond = Math.floor(timestampDate.getTime() / 1000);
  const pendingTimestampSecond = pendingTimestampSecondByTerm.get(term);
  const hadPendingOutput = getTerminalWriteCoalescerPendingBytes(term) > 0;
  if (
    hadPendingOutput
    && pendingTimestampSecond !== undefined
    && pendingTimestampSecond !== timestampSecond
    && !shouldPreserveTerminalWriteFrameBatch(term)
  ) {
    // Split arrival-time batches at the second boundary, but keep any queued
    // bulk slices on their cooperative yield schedule.
    flushTerminalWriteCoalescer(term);
  }
  pendingTimestampSecondByTerm.set(term, timestampSecond);
};

function flushHiddenPaneWritesNow(term: XTerm, isPaneVisible: () => boolean): void {
  if (isPaneVisible()) return;
  flushTerminalWriteCoalescer(term);
  // Each background queue item flushes xterm's parser buffer itself. Leave the
  // queue's zero-delay yield timers intact so a large hidden burst cannot turn
  // the whole backlog into one long renderer task.
  flushTerminalWriteBufferBypassingTimers(term);
  if (!isPaneVisible() && hasPendingTerminalWrites(term)) {
    scheduleHiddenPaneDrain(term, isPaneVisible);
  }
}

function scheduleHiddenPaneDrain(term: XTerm, isPaneVisible: () => boolean): void {
  if (isPaneVisible()) return;
  if (hiddenPaneDrainTimers.has(term)) return;

  const timer = setTimeout(() => {
    hiddenPaneDrainTimers.delete(term);
    flushHiddenPaneWritesNow(term, isPaneVisible);
  }, HIDDEN_PANE_DRAIN_MS);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  hiddenPaneDrainTimers.set(term, timer);
}

const scheduleVisibleTerminalWriteIdleFlush = (term: XTerm, isPaneVisible: () => boolean): void => {
  if (!isPaneVisible()) return;
  const existingTimer = visibleWriteIdleFlushTimers.get(term);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    visibleWriteIdleFlushTimers.delete(term);
    if (!isPaneVisible()) {
      flushHiddenPaneWritesNow(term, isPaneVisible);
      return;
    }
    flushTerminalWriteCoalescer(term);
    flushTerminalWriteBufferBypassingTimers(term);
    flushTerminalWriteQueueBypassingTimers(term);
    flushTerminalWriteBufferBypassingTimers(term);
  }, VISIBLE_WRITE_IDLE_FLUSH_MS);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  visibleWriteIdleFlushTimers.set(term, timer);
};

export const getFlowControllerForTerm = (term: XTerm): OutputFlowController | undefined =>
  terminalFlowControllers.get(term);

export const getFlowController = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
): OutputFlowController => {
  let controller = terminalFlowControllers.get(term);
  if (!controller) {
    controller = createOutputFlowController({
      highWaterMark: FLOW_HIGH_WATER_MARK,
      lowWaterMark: FLOW_LOW_WATER_MARK,
      onPause: () => {
        const id = ctx.sessionRef.current;
        if (id) ctx.terminalBackend.setSessionFlowPaused?.(id, true);
      },
      onResume: () => {
        const id = ctx.sessionRef.current;
        if (id) ctx.terminalBackend.setSessionFlowPaused?.(id, false);
      },
    });
    terminalFlowControllers.set(term, controller);
    setTerminalWriteQueueDropHandler(term, (bytes) => {
      if (bytes <= 0) return;
      controller?.written(bytes);
      const sessionId = ctx.sessionRef.current;
      ackTerminalSessionFlow(ctx.terminalBackend, sessionId, bytes);
      if (sessionId) {
        flushTerminalSessionFlowAck(sessionId);
      }
    });
  }
  setTerminalWriteCoalescerByteCapResolver(term, () => (
    resolveFloodCoalescerByteCap(
      controller!.isPaused(),
      // Treat bulk/large-output pressure like queue flood so we stop packing
      // multi-MB seq dumps into a single microtask flush (UI freeze).
      isTerminalWriteQueueInFloodMode(term) || shouldDegradeTerminalSideWork(term),
    )
  ));
  setTerminalWriteCoalescerFlushGate(term, () => isTerminalPaneVisible(ctx));
  return controller;
};

export const resetTerminalLineTimestampState = resetTerminalLineTimestamps;

export const acknowledgeDroppedTerminalDisplayBytes = (
  ctx: TerminalSessionStartersContext,
  bytes: number,
): void => {
  if (bytes <= 0) return;
  const sessionId = ctx.sessionRef.current;
  ackTerminalSessionFlow(ctx.terminalBackend, sessionId, bytes);
  if (sessionId) {
    flushTerminalSessionFlowAck(sessionId);
    ctx.terminalBackend.setSessionFlowPaused?.(sessionId, false);
  }
};

/** Live host fields for write-path feature gates (prefer hostRef over frozen host). */
export const resolveLiveHostShowLineTimestamps = (
  ctx: Pick<TerminalSessionStartersContext, "host" | "hostRef">,
): boolean => (
  (ctx.hostRef?.current ?? ctx.host)?.showLineTimestamps === true
);

export const writeTerminalLine = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  // Keep lifecycle/control lines ordered after all preceding PTY output.
  flushPendingTerminalOutputNow(term);
  const lineData = `${data}\r\n`;
  enqueueTerminalWrite(term, lineData.length, (done) => {
    ctx.onTerminalLogData?.(lineData);
    term.write(lineData, done);
  });
  flushTerminalWritesForBackgroundOutput(term);
};

export const writeSessionData = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
  ingressBytes: number = data.length,
  meta?: TerminalSessionDataMeta,
) => {
  const flow = getFlowController(ctx, term);
  const isPaneCurrentlyVisible = () => isTerminalPaneVisible(ctx);
  const isPaneVisible = isPaneCurrentlyVisible();
  const timestampDate = new Date(Date.now());
  const usesBackgroundWritePath = shouldFlushTerminalWritesForBackgroundOutput(isPaneVisible);
  // Flush normal-screen output across an arrival-second boundary so every
  // line keeps its real timestamp. Alternate-screen repaints stay atomic.
  flushBeforeTimestampBoundary(term, timestampDate);
  const perfTrace = createTerminalOutputPerfTrace({
    sessionId: ctx.sessionRef.current ?? ctx.sessionId,
    data,
    ingressBytes,
    meta,
  });
  logTerminalOutputPerf("renderer-receive", perfTrace, {
    visible: isPaneVisible,
  });
  flow.received(ingressBytes);
  setTerminalOutputPressureVisibility(term, isPaneVisible);
  noteTerminalOutputPressureData(term, data);
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  const preservePromptSourceChunks = Boolean(
    settings?.forcePromptNewLine
    && ctx.promptLineBreakStateRef?.current?.pendingCommand
    && ctx.promptLineBreakStateRef.current.lastPromptText,
  );
  if (usesBackgroundWritePath) {
    const writeBackgroundOutputData = (
      batch: string,
      batchIngress: number,
      writeOptions?: CoalescedTerminalWriteOptions,
    ): void => {
      writeSessionDataImmediate(ctx, term, batch, batchIngress, {
        ...writeOptions,
        deferStart: writeOptions?.deferStart ?? !isPaneCurrentlyVisible(),
        flushXtermWriteBuffer: true,
        perfTrace: writeOptions?.preservePerfTrace === false ? null : perfTrace,
        timestampDate,
      });
      if (isPaneCurrentlyVisible()) {
        flushTerminalWritesForBackgroundOutput(term);
      } else {
        flushTerminalWriteBufferBypassingTimers(term);
      }
    };
    if (isPaneVisible) {
      flushTerminalWriteCoalescer(term, writeBackgroundOutputData);
      flushTerminalWritesForBackgroundOutput(term);
    }
    enqueueCoalescedTerminalWrite(
      term,
      data,
      writeBackgroundOutputData,
      ingressBytes,
      { preserveSourceChunkBoundaries: preservePromptSourceChunks },
    );
    if (isPaneVisible) {
      flushTerminalWriteCoalescer(term, writeBackgroundOutputData);
      flushTerminalWritesForBackgroundOutput(term);
    } else {
      scheduleHiddenPaneDrain(term, isPaneCurrentlyVisible);
    }
    return;
  }
  enqueueCoalescedTerminalWrite(term, data, (batch, batchIngress, writeOptions) => {
    writeSessionDataImmediate(ctx, term, batch, batchIngress, {
      ...writeOptions,
      perfTrace: writeOptions?.preservePerfTrace === false ? null : perfTrace,
      timestampDate,
    });
  }, ingressBytes, { preserveSourceChunkBoundaries: preservePromptSourceChunks });
  scheduleVisibleTerminalWriteIdleFlush(term, isPaneCurrentlyVisible);
  scheduleHiddenPaneDrain(term, isPaneCurrentlyVisible);
  maybeFlushTerminalWriteCoalescerWhenUnfocused(
    term,
    isPaneVisible,
  );
};

/** True when a batch has no ESC/C1 CSI — safe to skip TUI/filter transforms. */
const isPlainTerminalDisplayData = (data: string): boolean =>
  !data.includes("\x1b") && !data.includes("\x9b");

const writeSessionDataImmediate = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
  ingressBytes: number = data.length,
  writeOptions: TerminalSessionWriteOptions = {},
) => {
  const flow = getFlowController(ctx, term);
  // Tabby-like: under bulk pressure, force a yield after sizable shards so the
  // event loop can paint/input between xterm parses (serial queue otherwise
  // chains the next write the moment the callback fires).
  const displayBytes = data.length;
  const bulkYieldAfter = shouldDegradeTerminalSideWork(term)
    && displayBytes >= XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES;
  enqueueTerminalWrite(term, displayBytes, (done) => {
    const shouldMeasurePerf = Boolean(writeOptions.perfTrace);
    const queueItemStartedAt = shouldMeasurePerf ? performance.now() : 0;
    const prepareStartedAt = shouldMeasurePerf ? performance.now() : 0;
    const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
    const forcePromptNewLine = settings?.forcePromptNewLine ?? false;
    const promptLineBreakState = ctx.promptLineBreakStateRef?.current;
    // Always run filter + paste bookkeeping (stateful). Bulk-plain only skips
    // erase-scrollback / prompt cosmetics when the *post-paste* stream is still
    // plain and forcePromptNewLine is off (Codex: long paste cleanup must run).
    // Capture open sync state before this chunk is filtered so a delayed
    // full-redraw `\x1b[2J` (without a co-chunk `\x1b[?2026h`) still skips
    // scrollback wipe — see #2291 / Codex review on bare 2J + 3J.
    const startInDec2026SyncBlock = isTerminalSyncBlockOpen(term);
    const filteredData = filterTerminalSessionData(term, data);
    const afterErase = appendEraseScrollbackAfterFullErases(filteredData, {
      wipeScrollback: settings?.clearWipesScrollback ?? true,
      normalScreen: term.buffer?.active?.type !== "alternate",
      startInDec2026SyncBlock,
    });
    const pasteDisplayData = prepareTerminalDataForUserPasteDisplay(term, afterErase);
    // Prompt indices must match the string passed to prepare… — source-chunk
    // boundaries are only valid when display transforms are identity.
    const promptSourceBoundaries = pasteDisplayData === data
      ? writeOptions.sourceChunkBoundaries
      : undefined;
    const promptVisibleStarts = (
      forcePromptNewLine
      && promptLineBreakState?.pendingCommand
      ? findTerminalPromptSourceChunkVisibleStarts(
        pasteDisplayData,
        promptLineBreakState.lastPromptText,
        promptSourceBoundaries,
      )
      : []
    );
    const bulkPlainPath = shouldDegradeTerminalSideWork(term)
      && isPlainTerminalDisplayData(pasteDisplayData)
      && !forcePromptNewLine;
    let preparedDisplayData: string;
    let prepareMs = 0;
    if (bulkPlainPath) {
      preparedDisplayData = pasteDisplayData;
      prepareMs = shouldMeasurePerf ? performance.now() - prepareStartedAt : 0;
    } else {
      if (!forcePromptNewLine && ctx.promptLineBreakStateRef?.current) {
        ctx.promptLineBreakStateRef.current.pendingCommand = false;
        ctx.promptLineBreakStateRef.current.suppressNextPromptCache = false;
      }
      preparedDisplayData = prepareTerminalDataForPromptLineBreak(
        term,
        pasteDisplayData,
        promptLineBreakState,
        forcePromptNewLine,
        promptVisibleStarts,
      );
      prepareMs = shouldMeasurePerf ? performance.now() - prepareStartedAt : 0;
    }
    ctx.onTerminalLogData?.(pasteDisplayData);
    const clearPasteResidualAndCapture = () => {
      const cleanupData = clearPasteResidualAfterTerminalWrite(term);
      if (cleanupData) {
        ctx.onTerminalLogData?.(cleanupData);
      }
    };
    const syncPrompt = () => {
      if (bulkPlainPath) return;
      if (forcePromptNewLine) {
        syncPromptLineBreakState(term, ctx.promptLineBreakStateRef?.current);
      }
    };
    const publishCommandCompletion = () => {
      const completed = detectTerminalCommandCompletions(
        term,
        ctx.promptLineBreakStateRef?.current,
      );
      for (let index = 0; index < completed; index += 1) {
        ctx.onCommandCompleted?.();
      }
    };
    const finishQueueItem = () => {
      clearPasteResidualAndCapture();
      syncPrompt();
      publishCommandCompletion();
      if (shouldScrollOnTerminalOutput(settings)) {
        handleTerminalOutputAutoScroll(ctx, term);
      }
      if (isTerminalPaneVisible(ctx)) {
        // Unfocused-but-visible windows have no rAF-driven render; this
        // debounced sync repaint is the only path that updates pixels (#1761).
        scheduleTerminalRepaintWhenUnfocused(term);
      }
      done();
    };
    const commitIpcAck = (ackedBytes: number) => {
      if (ackedBytes <= 0) return;
      ackTerminalSessionFlow(ctx.terminalBackend, ctx.sessionRef.current, ackedBytes);
    };
    const flushIpcAck = (ackedBytes: number) => {
      commitIpcAck(ackedBytes);
      flushTerminalSessionFlowAck(ctx.sessionRef.current);
    };
    const flushDeferredIpcAck = () => {
      flushIpcAck(clearDeferredTerminalWriteAck(term));
    };
    const deferredBeforeWrite = getDeferredTerminalWriteAckBytes(term);
    const deferFlowAck = !writeOptions.flushXtermWriteBuffer
      && !forcePromptNewLine
      && shouldDeferTerminalWriteCallback(
        preparedDisplayData.length,
        deferredBeforeWrite,
        ingressBytes,
        XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
        XTERM_WRITE_CALLBACK_BATCH_BYTES,
      );

    const writePreparedDisplayData = (callback: () => void): void => {
      const lineTimestampPerf = shouldMeasurePerf ? createLineTimestampPerfTotals() : null;
      const writeStartedAt = shouldMeasurePerf ? performance.now() : 0;
      let completed = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finishWrite = () => {
        if (completed) return;
        completed = true;
        if (watchdog !== undefined) {
          clearTimeout(watchdog);
          watchdog = undefined;
        }
        if (shouldMeasurePerf && lineTimestampPerf) {
          const now = performance.now();
          logTerminalOutputPerf("renderer-write-done", writeOptions.perfTrace, {
            batchChars: data.length,
            preparedChars: preparedDisplayData.length,
            ingressBytes,
            prepareMs: roundMs(prepareMs),
            writeMs: roundMs(now - writeStartedAt),
            totalMs: roundMs(now - queueItemStartedAt),
            deferredAck: deferFlowAck,
            lineTimestamps: summarizeLineTimestampPerf(lineTimestampPerf),
            bulkPlainPath,
          });
        }
        callback();
      };
      // Per-second ledger always records (record/render split); true flood still
      // skips via shouldSkipTerminalLineTimestamps. Sparse reflow anchors ≤1/s.
      writeTerminalDataWithLineTimestamps(
        term,
        preparedDisplayData,
        finishWrite,
        {
          ...(shouldMeasurePerf && lineTimestampPerf
            ? { onStep: (step: TerminalLineTimestampPerfStep) => recordLineTimestampPerfStep(lineTimestampPerf, step) }
            : {}),
          timestampDate: writeOptions.timestampDate,
          // hostRef: live gutter toggle for call-site compatibility (recording
          // itself is always on; paint is gated by gutter UI).
          enabled: resolveLiveHostShowLineTimestamps(ctx),
        },
      );
      if (
        !writeOptions.flushXtermWriteBuffer
        && !completed
        && preparedDisplayData.length >= LARGE_WRITE_FLUSH_WATCHDOG_BYTES
      ) {
        watchdog = setTimeout(() => {
          watchdog = undefined;
          if (!completed) {
            flushTerminalWriteBufferBypassingTimers(term);
          }
        }, LARGE_WRITE_FLUSH_WATCHDOG_MS);
      }
      if (writeOptions.flushXtermWriteBuffer) {
        flushTerminalWriteBufferBypassingTimers(term);
      }
    };

    if (deferFlowAck) {
      writePreparedDisplayData(() => {
        finishQueueItem();
        flow.written(ingressBytes);
        const deferredTotal = accumulateDeferredTerminalWriteAck(term, ingressBytes);
        if (deferredTotal >= XTERM_WRITE_CALLBACK_BATCH_BYTES) {
          flushDeferredIpcAck();
        } else {
          scheduleDeferredTerminalWriteAckFlush(term, flushIpcAck);
        }
      });
      return;
    }

    const deferredBeforeCallback = clearDeferredTerminalWriteAck(term);
    const ackOnCallback = deferredBeforeCallback + ingressBytes;
    writePreparedDisplayData(() => {
      finishQueueItem();
      flow.written(ingressBytes);
      if (deferredBeforeCallback > 0) {
        flushIpcAck(ackOnCallback);
      } else {
        flushIpcAck(ackOnCallback);
      }
    });
  }, {
    dropBytes: ingressBytes,
    deferStart: writeOptions.deferStart,
    // Intermediate plain shards set yieldAfter via writeLargeTerminalBatch;
    // bulk pressure also yields after sizable items (Tabby FlowControl intent).
    yieldAfter: writeOptions.yieldAfter === true || bulkYieldAfter,
  });
};

export const isTerminalBootActive = (ctx: TerminalSessionStartersContext): boolean =>
  !ctx.isBootActiveRef || ctx.isBootActiveRef.current;

export const closeOrphanBackendSession = (
  ctx: TerminalSessionStartersContext,
  sessionBackendId: string,
) => {
  try {
    const closeResult = ctx.terminalBackend.closeSession(sessionBackendId);
    void Promise.resolve(closeResult).catch((err) => {
      logger.warn("Failed to close orphan session after terminal unmount", err);
    });
  } catch (err) {
    logger.warn("Failed to close orphan session after terminal unmount", err);
  }
};

export const tryAttachSessionToTerminal = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  id: string,
  opts?: {
    onExitMessage?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => string;
    onConnected?: () => void;
    onExit?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => void;
    convertLfToCrlf?: boolean;
    sudoAutofillPassword?: string;
    sudoAutofillCandidates?: SudoPasswordAutofillCandidate[];
  },
): boolean => {
  if (!isTerminalBootActive(ctx)) {
    closeOrphanBackendSession(ctx, id);
    return false;
  }
  attachSessionToTerminal(ctx, term, id, opts);
  return true;
};

export const releaseTerminalFlowBeforeHibernate = (
  backend: TerminalSessionStartersContext["terminalBackend"],
  term: XTerm,
  sessionId: string,
  options?: { resumeBackend?: boolean },
): void => {
  const flow = terminalFlowControllers.get(term);
  flushPendingTerminalOutputNow(term);
  releaseTerminalFlowOutputForTerm(term, backend, sessionId, flow, options);
  setTerminalWriteCoalescerByteCapResolver(term);
  setTerminalWriteCoalescerFlushGate(term);
  pendingTimestampSecondByTerm.delete(term);
  resetDeferredTerminalWriteAck(term);
  terminalFlowControllers.delete(term);
};

export const resolveAttachSnapshot = (
  finalSnapshot: unknown,
  fallbackSnapshot: string,
): string => (typeof finalSnapshot === "string" ? finalSnapshot : fallbackSnapshot);

export const detachSessionDataListeners = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
) => {
  const sessionId = ctx.sessionRef.current;
  if (sessionId && term) {
    releaseTerminalFlowBeforeHibernate(ctx.terminalBackend, term, sessionId);
  }

  ctx.disposeDataRef.current?.();
  ctx.disposeDataRef.current = null;
  ctx.disposeExitRef.current?.();
  ctx.disposeExitRef.current = null;
};

export const attachSessionToTerminal = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  id: string,
  opts?: {
    onExitMessage?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => string;
    onConnected?: () => void;
    onExit?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => void;
    convertLfToCrlf?: boolean;
    sudoAutofillPassword?: string;
    sudoAutofillCandidates?: SudoPasswordAutofillCandidate[];
  },
) => {
  if (!isTerminalBootActive(ctx)) {
    closeOrphanBackendSession(ctx, id);
    return;
  }

  flushPendingTerminalOutputNow(term);
  pendingTimestampSecondByTerm.delete(term);
  ctx.sessionRef.current = id;
  const flow = getFlowController(ctx, term);
  teardownTerminalOutputPipeline(ctx, term, id, flow);
  flushTerminalWriteCoalescer(term);
  resetTerminalSyncBlockFilter(term);
  resetTerminalLineTimestamps(term);
  resetTerminalOutputPressure(term);
  ctx.onSessionAttached?.(id);
  const assistMode =
    ctx.terminalSettingsRef?.current?.passwordPromptAssist
    ?? ctx.terminalSettings?.passwordPromptAssist
    ?? "hint";
  const candidates =
    opts?.sudoAutofillCandidates
    ?? ctx.sudoAutofillCandidatesRef?.current
    ?? ctx.sudoAutofillCandidates
    ?? [];
  const password =
    opts?.sudoAutofillPassword
    ?? ctx.sudoAutofillPasswordRef?.current
    ?? ctx.sudoAutofillPassword;
  const sudoAutofill = createSudoPasswordAutofill({
    mode: assistMode,
    password,
    candidates,
    write: (data) => ctx.terminalBackend.writeToSession(id, data, { automated: true, sensitive: true }),
    onHint: (active) => ctx.onSudoHint?.(active) ?? false,
    onPicker: (active, state) => ctx.onPasswordPromptPicker?.(active, state) ?? false,
  });
  if (ctx.sudoAutofillRef) {
    ctx.sudoAutofillRef.current = sudoAutofill;
  }

  const markConnectedOnFirstOutput = () => {
    if (ctx.hasConnectedRef.current) return;
    ctx.updateStatus("connected");
    opts?.onConnected?.();
    setTimeout(() => {
      if (ctx.isVisibleRef?.current === false) {
        notePendingOutputScrollIfEnabled(ctx);
        return;
      }
      if (!ctx.fitAddonRef.current) return;
      try {
        ctx.fitAddonRef.current.fit();
        if (ctx.sessionRef.current) {
          ctx.terminalBackend.resizeSession(ctx.sessionRef.current, term.cols, term.rows);
        }
      } catch (err) {
        logger.warn("Post-connect fit failed", err);
      }
    }, 100);
  };

  ctx.disposeDataRef.current = ctx.terminalBackend.onSessionData(
    id,
    (chunk, meta) => {
      if (typeof meta?.pluginPipelineSensitiveInput === "boolean" && ctx.passwordPromptActiveRef) {
        ctx.passwordPromptActiveRef.current = meta.pluginPipelineSensitiveInput;
      }
      const filtered = filterTerminalInterruptDisplayOutput(term, chunk);
      const pluginPipelineIngressBytes = Number.isFinite(meta?.pluginPipelineIngressBytes)
        ? Math.max(0, Number(meta?.pluginPipelineIngressBytes))
        : null;
      if (filtered.accepted && !filtered.data && pluginPipelineIngressBytes != null) {
        markConnectedOnFirstOutput();
        if (typeof meta?.pluginPipelineSensitiveInput === "boolean") {
          ctx.onTerminalOutput?.("", meta);
        }
        acknowledgeDroppedTerminalDisplayBytes(ctx, pluginPipelineIngressBytes);
        return;
      }
      acknowledgeDroppedTerminalDisplayBytes(
        ctx,
        !filtered.accepted && pluginPipelineIngressBytes != null
          ? pluginPipelineIngressBytes
          : pluginPipelineIngressBytes != null
            ? 0
            : filtered.droppedBytes,
      );
      if (!filtered.accepted) return;

      const ingressBytes = pluginPipelineIngressBytes
        ?? filtered.acceptedBytes
        ?? filtered.data.length;
      let data = filtered.data;
      if (opts?.convertLfToCrlf) {
        data = data.replace(/(?<!\r)\n/g, "\r\n");
      }
      data = sudoAutofill?.handleOutput(data) ?? data;
      writeSessionData(ctx, term, data, ingressBytes, meta);
      ctx.onTerminalOutput?.(data, meta);
      // Mark connected on first visible output so the connection overlay
      // dismisses and interactive Mosh handshake prompts (password/OTP)
      // remain reachable. Startup commands / pending scripts are gated
      // separately on netcatty:mosh:ready so they do not hit the handshake
      // PTY (#2199).
      markConnectedOnFirstOutput();
    },
    { replayBacklog: true },
  );
  ctx.terminalBackend.notifyTerminalSessionDisplayReady?.(id);

  ctx.disposeExitRef.current = ctx.terminalBackend.onSessionExit(id, (evt) => {
    // The backend is already gone. In particular, an observe popup must not
    // run its normal pause/snapshot/restore handoff while closing afterward.
    if (ctx.sessionRef.current === id) {
      ctx.sessionRef.current = null;
    }
    ctx.updateStatus("disconnected");
    if (evt.error) {
      ctx.setError(evt.error);
    }
    const exitMessage = opts?.onExitMessage?.(evt) ?? "\r\n[session closed]";
    writeTerminalLine(ctx, term, exitMessage);

    if (ctx.onTerminalDataCapture && ctx.serializeAddonRef.current) {
      try {
        const terminalData = ctx.serializeAddonRef.current.serialize();
        ctx.onTerminalDataCapture(ctx.sessionId, terminalData);
      } catch (err) {
        logger.warn("Failed to serialize terminal data:", err);
      }
    }

    clearConnectionToken(ctx.sessionId);

    opts?.onExit?.(evt);
    if (ctx.sudoAutofillRef) {
      ctx.sudoAutofillRef.current = null;
    }
    ctx.onSessionExit?.(ctx.sessionId, evt);
  });
};
