import type { Terminal as XTerm } from "@xterm/xterm";
import { shouldScrollOnTerminalOutput } from "../../../domain/terminalScroll";
import { logger } from "../../../lib/logger";
import type { Host, TerminalSettings } from "../../../types";
import {
  clearPasteResidualAfterTerminalWrite,
  prepareTerminalDataForUserPasteDisplay,
} from "./terminalUserPaste";
import {
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
} from "./terminalOutputPressure";
import { createSudoPasswordAutofill } from "./terminalSudoAutofill";
import {
  filterTerminalSessionData,
  resetTerminalSyncBlockFilter,
} from "./terminalSyncBlockFilter";
import { appendEraseScrollbackAfterFullErases } from "../clearTerminalViewport";
import {
  type CoalescedTerminalWriteOptions,
  enqueueCoalescedTerminalWrite,
  flushTerminalWriteCoalescer,
  resolveFloodCoalescerByteCap,
  setTerminalWriteCoalescerByteCapResolver,
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

const handleTerminalOutputAutoScroll = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
) => {
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  if (!shouldScrollOnTerminalOutput(settings)) {
    return;
  }

  if (ctx.isVisibleRef?.current === false) {
    notePendingOutputScrollIfEnabled(ctx);
    return;
  }

  term.scrollToBottom();
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
};

const BACKGROUND_OUTPUT_FLUSH_MAX_PASSES = 64;
const LARGE_WRITE_FLUSH_WATCHDOG_BYTES = 64 * 1024;
const LARGE_WRITE_FLUSH_WATCHDOG_MS = 250;
const VISIBLE_WRITE_IDLE_FLUSH_MS = 64;
const visibleWriteIdleFlushTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();

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

const scheduleVisibleTerminalWriteIdleFlush = (term: XTerm, isPaneVisible: boolean): void => {
  if (!isPaneVisible) return;
  const existingTimer = visibleWriteIdleFlushTimers.get(term);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    visibleWriteIdleFlushTimers.delete(term);
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
    setTerminalWriteCoalescerByteCapResolver(term, () => (
      resolveFloodCoalescerByteCap(
        controller!.isPaused(),
        isTerminalWriteQueueInFloodMode(term),
      )
    ));
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
  return controller;
};

export const resetTerminalLineTimestampState = resetTerminalLineTimestamps;

const acknowledgeDroppedTerminalDisplayBytes = (
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

export const writeTerminalLine = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  const lineData = `${data}\r\n`;
  enqueueTerminalWrite(term, lineData.length, (done) => {
    ctx.onTerminalLogData?.(lineData);
    term.write(lineData, done);
  });
};

export const writeSessionData = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
  ingressBytes: number = data.length,
  meta?: TerminalSessionDataMeta,
) => {
  const flow = getFlowController(ctx, term);
  const isPaneVisible = ctx.isVisibleRef?.current !== false;
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
  if (shouldFlushTerminalWritesForBackgroundOutput(isPaneVisible)) {
    const writeBackgroundOutputData = (
      batch: string,
      batchIngress: number,
    ): void => {
      writeSessionDataImmediate(ctx, term, batch, batchIngress, {
        flushXtermWriteBuffer: true,
        perfTrace,
      });
      flushTerminalWritesForBackgroundOutput(term);
    };
    flushTerminalWriteCoalescer(term, writeBackgroundOutputData);
    flushTerminalWritesForBackgroundOutput(term);
    enqueueCoalescedTerminalWrite(term, data, writeBackgroundOutputData, ingressBytes);
    flushTerminalWriteCoalescer(term, writeBackgroundOutputData);
    flushTerminalWritesForBackgroundOutput(term);
    return;
  }
  enqueueCoalescedTerminalWrite(term, data, (batch, batchIngress, writeOptions) => {
    writeSessionDataImmediate(ctx, term, batch, batchIngress, {
      ...writeOptions,
      perfTrace,
    });
  }, ingressBytes);
  scheduleVisibleTerminalWriteIdleFlush(term, isPaneVisible);
  maybeFlushTerminalWriteCoalescerWhenUnfocused(
    term,
    isPaneVisible,
  );
};

const writeSessionDataImmediate = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
  ingressBytes: number = data.length,
  writeOptions: TerminalSessionWriteOptions = {},
) => {
  const flow = getFlowController(ctx, term);
  enqueueTerminalWrite(term, ingressBytes, (done) => {
    const queueItemStartedAt = performance.now();
    const prepareStartedAt = performance.now();
    const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
    const filteredData = filterTerminalSessionData(term, data);
    const displayData = appendEraseScrollbackAfterFullErases(filteredData, {
      wipeScrollback: settings?.clearWipesScrollback ?? true,
      normalScreen: term.buffer?.active?.type !== "alternate",
    });
    const forcePromptNewLine = settings?.forcePromptNewLine ?? false;
    if (!forcePromptNewLine && ctx.promptLineBreakStateRef?.current) {
      ctx.promptLineBreakStateRef.current.pendingCommand = false;
      ctx.promptLineBreakStateRef.current.suppressNextPromptCache = false;
    }
    const pasteDisplayData = prepareTerminalDataForUserPasteDisplay(term, displayData);
    const preparedDisplayData = prepareTerminalDataForPromptLineBreak(
      term,
      pasteDisplayData,
      ctx.promptLineBreakStateRef?.current,
      forcePromptNewLine,
    );
    const prepareMs = performance.now() - prepareStartedAt;
    ctx.onTerminalLogData?.(pasteDisplayData);
    const clearPasteResidualAndCapture = () => {
      const cleanupData = clearPasteResidualAfterTerminalWrite(term);
      if (cleanupData) {
        ctx.onTerminalLogData?.(cleanupData);
      }
    };
    const syncPrompt = () => {
      if (forcePromptNewLine) {
        syncPromptLineBreakState(term, ctx.promptLineBreakStateRef?.current);
      }
    };
    const finishQueueItem = () => {
      clearPasteResidualAndCapture();
      syncPrompt();
      if (shouldScrollOnTerminalOutput(settings)) {
        handleTerminalOutputAutoScroll(ctx, term);
      }
      if (ctx.isVisibleRef?.current !== false) {
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
      const shouldMeasurePerf = Boolean(writeOptions.perfTrace);
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
          });
        }
        callback();
      };
      writeTerminalDataWithLineTimestamps(
        term,
        preparedDisplayData,
        finishWrite,
        shouldMeasurePerf && lineTimestampPerf
          ? { onStep: (step) => recordLineTimestampPerfStep(lineTimestampPerf, step) }
          : undefined,
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
    deferStart: writeOptions.deferStart,
    yieldAfter: writeOptions.yieldAfter,
  });
};

export const isTerminalBootActive = (ctx: TerminalSessionStartersContext): boolean =>
  !ctx.isBootActiveRef || ctx.isBootActiveRef.current;

export const closeOrphanBackendSession = (
  ctx: TerminalSessionStartersContext,
  sessionBackendId: string,
) => {
  try {
    ctx.terminalBackend.closeSession(sessionBackendId);
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
  releaseTerminalFlowOutputForTerm(term, backend, sessionId, flow, options);
  setTerminalWriteCoalescerByteCapResolver(term);
  resetDeferredTerminalWriteAck(term);
  terminalFlowControllers.delete(term);
};

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
  },
) => {
  if (!isTerminalBootActive(ctx)) {
    closeOrphanBackendSession(ctx, id);
    return;
  }

  ctx.sessionRef.current = id;
  const flow = getFlowController(ctx, term);
  teardownTerminalOutputPipeline(ctx, term, id, flow);
  flushTerminalWriteCoalescer(term);
  resetTerminalSyncBlockFilter(term);
  resetTerminalLineTimestamps(term);
  resetTerminalOutputPressure(term);
  ctx.onSessionAttached?.(id);
  const sudoAutofill = createSudoPasswordAutofill({
    password: opts?.sudoAutofillPassword,
    write: (data) => ctx.terminalBackend.writeToSession(id, data, { automated: true }),
    onHint: (active) => ctx.onSudoHint?.(active) ?? false,
  });
  if (ctx.sudoAutofillRef) {
    ctx.sudoAutofillRef.current = sudoAutofill;
  }

  ctx.disposeDataRef.current = ctx.terminalBackend.onSessionData(
    id,
    (chunk, meta) => {
      const filtered = filterTerminalInterruptDisplayOutput(term, chunk);
      acknowledgeDroppedTerminalDisplayBytes(ctx, filtered.droppedBytes);
      if (!filtered.accepted) return;

      const ingressBytes = filtered.acceptedBytes ?? filtered.data.length;
      let data = filtered.data;
      if (opts?.convertLfToCrlf) {
        data = data.replace(/(?<!\r)\n/g, "\r\n");
      }
      data = sudoAutofill?.handleOutput(data) ?? data;
      writeSessionData(ctx, term, data, ingressBytes, meta);
      ctx.onTerminalOutput?.(data, meta);
      if (!ctx.hasConnectedRef.current) {
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
      }
    },
    { replayBacklog: true },
  );

  ctx.disposeExitRef.current = ctx.terminalBackend.onSessionExit(id, (evt) => {
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
