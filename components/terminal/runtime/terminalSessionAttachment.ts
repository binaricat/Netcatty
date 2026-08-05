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
  apportionFrameGateIngress,
  collapseAndSplit,
  endsWithSyncOpenerPrefix,
  makesFullRepaint,
} from "./terminalFrameGate";
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
  LOCAL_FLOW_HIGH_WATER_MARK,
  LOCAL_FLOW_LOW_WATER_MARK,
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
  hasPendingTerminalWrites,
  registerFrameGateHibernateHooks,
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
  perfTrace?: TerminalOutputPerfTrace | null;
  timestampDate?: Date;
};

const BACKGROUND_OUTPUT_FLUSH_MAX_PASSES = 64;
// With microtask coalescing, idle drain is only a safety net for rAF TUI path
// and any leftover queue work. Keep xterm on its public async write path here:
// its private flushSync removes a chunk before parsing and can strand the
// matching callback when parsing/rendering throws (notably on Herdr frames).
const VISIBLE_WRITE_IDLE_FLUSH_MS = 24;
const HIDDEN_PANE_DRAIN_MS = 160;
const visibleWriteIdleFlushTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();
const visibleWriteIdleFlushSettleChecks = new WeakSet<XTerm>();
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
  for (let pass = 0; pass < BACKGROUND_OUTPUT_FLUSH_MAX_PASSES; pass += 1) {
    if (!flushTerminalWriteQueueBypassingTimers(term)) {
      return;
    }
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
  // Leave both the queue's cooperative yield timer and xterm's parser timer
  // intact so a large hidden burst cannot turn the backlog into one long task.
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

const cancelVisibleTerminalWriteIdleFlush = (term: XTerm): void => {
  const timer = visibleWriteIdleFlushTimers.get(term);
  if (timer === undefined) return;
  clearTimeout(timer);
  visibleWriteIdleFlushTimers.delete(term);
};

const cancelVisibleTerminalWriteIdleFlushIfSettled = (term: XTerm): void => {
  if (!visibleWriteIdleFlushTimers.has(term)) return;
  if (!hasPendingTerminalWrites(term)) {
    cancelVisibleTerminalWriteIdleFlush(term);
    return;
  }
  // A synchronous xterm callback can run before the serial queue marks its
  // active item complete. Recheck once after the current queue turn unwinds.
  if (visibleWriteIdleFlushSettleChecks.has(term)) return;
  visibleWriteIdleFlushSettleChecks.add(term);
  queueMicrotask(() => {
    visibleWriteIdleFlushSettleChecks.delete(term);
    if (!hasPendingTerminalWrites(term)) {
      cancelVisibleTerminalWriteIdleFlush(term);
    }
  });
};

const scheduleVisibleTerminalWriteIdleFlush = (term: XTerm, isPaneVisible: () => boolean): void => {
  if (!isPaneVisible()) return;
  if (!hasPendingTerminalWrites(term)) {
    cancelVisibleTerminalWriteIdleFlush(term);
    return;
  }
  // This is a maximum wait, not an idle debounce. Sustained TUI output must
  // not postpone the safety drain forever.
  if (visibleWriteIdleFlushTimers.has(term)) return;

  const timer = setTimeout(() => {
    visibleWriteIdleFlushTimers.delete(term);
    if (!isPaneVisible()) {
      flushHiddenPaneWritesNow(term, isPaneVisible);
      return;
    }
    flushTerminalWriteCoalescer(term);
    flushTerminalWriteQueueBypassingTimers(term);
    if (hasPendingTerminalWrites(term) && isPaneVisible()) {
      scheduleVisibleTerminalWriteIdleFlush(term, isPaneVisible);
    }
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
    // A local shell needs no output back-pressure: there is no network to
    // overwhelm, and the source (a local process) blocks on its own write
    // when the pipe fills. The 1 MB watermark meant for SSH otherwise pauses
    // the PTY several times a second under a full-screen animated TUI, which
    // throttles its frame loop far below what the renderer can paint. Give
    // local sessions a much higher ceiling so the pause is rare; SSH keeps the
    // tight default. The ceiling still bounds memory — it does not disable
    // back-pressure, only relaxes it where a flood cannot originate.
    const isLocal = (ctx.hostRef?.current ?? ctx.host)?.protocol === "local";
    const highWaterMark = isLocal
      ? Math.max(FLOW_HIGH_WATER_MARK, LOCAL_FLOW_HIGH_WATER_MARK)
      : FLOW_HIGH_WATER_MARK;
    const lowWaterMark = isLocal
      ? Math.max(FLOW_LOW_WATER_MARK, LOCAL_FLOW_LOW_WATER_MARK)
      : FLOW_LOW_WATER_MARK;
    controller = createOutputFlowController({
      highWaterMark,
      lowWaterMark,
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
      // Watchdog recovery only claims the active item's dropBytes. Small writes
      // may have left ingress in the deferred IPC-ack buffer; a non-deferred
      // write must not clear that buffer until it owns the ack, so a stall can
      // still flush those earlier bytes here (without re-running flow.written —
      // deferred writes already accounted them when they completed).
      const deferredAck = clearDeferredTerminalWriteAck(term);
      const sessionId = ctx.sessionRef.current;
      if (bytes > 0) {
        controller?.written(bytes);
        ackTerminalSessionFlow(ctx.terminalBackend, sessionId, bytes);
      }
      if (deferredAck > 0) {
        ackTerminalSessionFlow(ctx.terminalBackend, sessionId, deferredAck);
      }
      if (sessionId && (bytes > 0 || deferredAck > 0)) {
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
  term?: XTerm,
): void => {
  if (bytes <= 0) return;
  const sessionId = ctx.sessionRef.current;
  ackTerminalSessionFlow(ctx.terminalBackend, sessionId, bytes);
  if (sessionId) {
    flushTerminalSessionFlowAck(sessionId);
    // Dropped frames free backend ingress, but the renderer flow controller may
    // still be above its high-water mark on forwarded writes. Only force-resume
    // when it is not paused; otherwise the controller resumes when pending
    // drains (Codex P2 on efe412a6).
    const flow = term ? getFlowControllerForTerm(term) : undefined;
    if (!flow?.isPaused?.()) {
      ctx.terminalBackend.setSessionFlowPaused?.(sessionId, false);
    }
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
  // Flush held DEC 2026 frames before lifecycle lines. Without this, a process
  // that exits mid-frame leaves a fail-open timer armed; the timer would
  // forward the older partial *after* `[session closed]`, reversing output
  // order and potentially overwriting the exit message.
  resetFrameGate(term, (buffer, ingress) => {
    forwardSessionData(ctx, term, buffer, ingress);
  });
  // Keep lifecycle/control lines ordered after all preceding PTY output.
  flushPendingTerminalOutputNow(term);
  const lineData = `${data}\r\n`;
  // dropBytes: 0 — lifecycle banners never called flow.received(); if the
  // stall watchdog recovered them with display-length dropBytes it would
  // under-count real session backlog and resume SSH too early (Codex P2).
  enqueueTerminalWrite(term, lineData.length, (done) => {
    ctx.onTerminalLogData?.(lineData);
    term.write(lineData, done);
  }, { dropBytes: 0 });
  flushTerminalWritesForBackgroundOutput(term);
};

/**
 * Backlog (unacknowledged bytes awaiting xterm) below which the frame gate
 * forwards frames straight through — a few frames deep, enough to keep xterm
 * fed at full rate without starving. Above it the gate drops superseded frames
 * instead of letting the backlog (and the latency riding behind it) grow.
 */
const FRAME_GATE_FORWARD_BACKLOG = 512 * 1024;
/** Retry cadence for draining held *complete* output when the backlog clears. */
const FRAME_GATE_FLUSH_MS = 8;
/**
 * Fail-open ceiling for the held buffer. Releasing at once past this keeps the
 * gate from withholding output unboundedly and, kept below the SSH flow
 * watermark, avoids deadlocking on a frame larger than that watermark (the
 * backend would pause before the withheld closer could arrive).
 */
const FRAME_GATE_MAX_HELD_BYTES = 512 * 1024;
/**
 * How long a lone trailing partial (an opener with no closer) may be held before
 * it is released to xterm. Long enough not to fire during normal frame assembly,
 * short enough that a process killed mid-frame does not leave its prompt hidden.
 */
const FRAME_GATE_PARTIAL_FAILOPEN_MS = 200;

type FrameGateState = {
  buffer: string;
  /**
   * Flow-control ingress bytes attributable to `buffer`. Tracked separately
   * from `buffer.length` because plugin processing can make a chunk's ingress
   * differ from its rendered length; it is apportioned exactly (via complements)
   * as bytes are forwarded, dropped or held so the backend is neither over- nor
   * under-acknowledged.
   */
  ingress: number;
  meta?: TerminalSessionDataMeta;
  flushTimer?: ReturnType<typeof setTimeout>;
};
const frameGateStates = new WeakMap<XTerm, FrameGateState>();

const getFrameGateState = (term: XTerm): FrameGateState => {
  let state = frameGateStates.get(term);
  if (!state) {
    state = { buffer: "", ingress: 0 };
    frameGateStates.set(term, state);
  }
  return state;
};

export const resetFrameGate = (
  term: XTerm,
  onHeld?: (buffer: string, ingress: number) => void,
): void => {
  const state = frameGateStates.get(term);
  if (!state) return;
  if (state.flushTimer !== undefined) clearTimeout(state.flushTimer);
  // Never silently drop held output before its state is deleted: a reset racing
  // an incomplete frame (hibernation, detach) would otherwise lose the buffered
  // bytes and leave their ingress unacknowledged to the backend. The caller
  // decides how to release it — forward it where a write context exists,
  // acknowledge its ingress where only the backend is available.
  if (state.buffer) onHeld?.(state.buffer, state.ingress);
  frameGateStates.delete(term);
};

/** Ingress flushed to xterm during hibernate before release can ACK it. */
const frameGateHibernateFlushedIngress = new WeakMap<XTerm, number>();

// Wire hibernate/close drains to write held DEC 2026 buffers into xterm before
// serialization (avoids circular import with terminalUnfocusedRepaint).
registerFrameGateHibernateHooks({
  hasHeld: (term) => {
    const state = frameGateStates.get(term);
    return Boolean(state?.buffer);
  },
  flushToTerm: (term) => {
    const state = frameGateStates.get(term);
    if (!state) return;
    if (state.flushTimer !== undefined) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
    if (!state.buffer) return;
    const buffer = state.buffer;
    const ingress = state.ingress;
    // Clear held buffer so hasHeld is false, but keep gate state deleted so
    // subsequent writes re-evaluate engagement cleanly.
    frameGateStates.delete(term);
    try {
      // Route through the same scrollback-safe filter as live writes so a
      // held HOME+CSI 2 J full redraw does not yank scrollback on hibernate
      // (Codex P2 on e8c49563).
      const filtered = filterTerminalSessionData(term, buffer);
      if (filtered) term.write(filtered);
    } catch {
      try {
        term.write(buffer);
      } catch {
        // ignore write failures during teardown
      }
    }
    // Preserve ingress for releaseTerminalFlowBeforeHibernate; also try to ACK
    // immediately via the session drop path if a flow controller is attached
    // so non-hibernate flushPending callers do not leave an unacked floor.
    if (ingress > 0) {
      frameGateHibernateFlushedIngress.set(
        term,
        (frameGateHibernateFlushedIngress.get(term) ?? 0) + ingress,
      );
      try {
        const flow = terminalFlowControllers.get(term);
        if (flow) {
          flow.written(ingress);
        }
      } catch {
        // ignore
      }
    }
  },
});

/**
 * Drain as much of the gate's held buffer as the current backlog allows,
 * collapsing superseded frames first. Held frames that cannot be forwarded yet
 * stay buffered so the next arrival (or flush) collapses them against newer
 * ones instead of letting them pile up.
 */
const drainFrameGate = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
): void => {
  const state = getFrameGateState(term);
  if (state.flushTimer !== undefined) {
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }
  if (!state.buffer) return;

  // Drop a frame only when its successor demonstrably repaints the whole
  // viewport (proven by simulating the writes and counting covered cells), never
  // on raw payload length, which SGR escapes inflate.
  const { complete, partial, dropped } = collapseAndSplit(
    state.buffer,
    (content) => makesFullRepaint(content, term.cols, term.rows),
  );

  // Apportion the buffered ingress across forwarded / dropped / held so the
  // backend is acknowledged in its own units, not rendered-string lengths.
  const {
    forward: ingressComplete,
    dropped: ingressDropped,
    held: ingressPartial,
  } = apportionFrameGateIngress(
    state.ingress,
    state.buffer.length,
    complete.length,
    dropped,
    partial.length,
  );

  state.buffer = partial;
  state.ingress = ingressPartial;
  if (dropped > 0) acknowledgeDroppedTerminalDisplayBytes(ctx, ingressDropped, term);

  let heldComplete = false;
  if (complete) {
    const backlog = getFlowControllerForTerm(term)?.pendingBytes() ?? 0;
    if (backlog < FRAME_GATE_FORWARD_BACKLOG) {
      forwardSessionData(ctx, term, complete, ingressComplete, state.meta);
    } else {
      // xterm is still behind: keep the collapsed complete run buffered ahead of
      // the trailing partial so newer frames supersede it rather than queue up.
      state.buffer = complete + state.buffer;
      state.ingress += ingressComplete;
      heldComplete = true;
    }
  }

  if (!state.buffer) return;

  // Fail-open: never withhold output indefinitely. A held buffer past the cap
  // (e.g. a frame larger than the SSH flow watermark, which would otherwise
  // deadlock) is released at once.
  if (state.buffer.length >= FRAME_GATE_MAX_HELD_BYTES) {
    forwardSessionData(ctx, term, state.buffer, state.ingress, state.meta);
    state.buffer = "";
    state.ingress = 0;
    return;
  }

  // Held *complete* output is released by a clearing backlog, so poll quickly.
  // A lone trailing partial can only be completed by new session data (which
  // calls drainFrameGate itself); poll it only on a longer one-shot that
  // fail-opens if it fires — so a process killed mid-frame never leaves its
  // prompt hidden, yet a stalled session never busy-polls.
  if (state.flushTimer === undefined) {
    const delay = heldComplete ? FRAME_GATE_FLUSH_MS : FRAME_GATE_PARTIAL_FAILOPEN_MS;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      if (heldComplete) {
        drainFrameGate(ctx, term);
        return;
      }
      // Fired with no intervening drain: the partial is stuck — release it.
      const stuck = getFrameGateState(term);
      if (stuck.buffer) {
        forwardSessionData(ctx, term, stuck.buffer, stuck.ingress, stuck.meta);
        stuck.buffer = "";
        stuck.ingress = 0;
      }
    }, delay);
  }
};

/**
 * Entry point for PTY output. When a full-screen animation is in flight (a DEC
 * 2026 frame is present or already buffered) it runs through the frame gate,
 * which caps the display/keyboard latency by dropping superseded frames. All
 * other output takes the direct path unchanged.
 */
export const writeSessionData = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
  ingressBytes: number = data.length,
  meta?: TerminalSessionDataMeta,
) => {
  const state = frameGateStates.get(term);
  // Engage on a complete opener, on already-buffered output, or on a trailing
  // split opener (`ESC[?2026h` cut across PTY chunks) so an aligned stream can
  // never bypass the gate by landing the opener on a chunk boundary.
  // Include 8-bit C1 CSI opener (`\x9b?2026h`) so C1 animated streams enter the
  // collapse/drop gate the same way as ESC CSI (Codex P2 on 3690e6e4).
  const engaged = (state && state.buffer.length > 0)
    || data.includes("\x1b[?2026h")
    || data.includes("\x9b?2026h")
    || endsWithSyncOpenerPrefix(data);
  if (!engaged) {
    forwardSessionData(ctx, term, data, ingressBytes, meta);
    return;
  }
  const gate = getFrameGateState(term);
  gate.buffer += data;
  gate.ingress += ingressBytes;
  gate.meta = meta;
  drainFrameGate(ctx, term);
};

const forwardSessionData = (
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
        perfTrace: writeOptions?.preservePerfTrace === false ? null : perfTrace,
        timestampDate,
      });
      if (isPaneCurrentlyVisible()) {
        flushTerminalWritesForBackgroundOutput(term);
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
  enqueueTerminalWrite(term, displayBytes, (done, signal) => {
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
      // A completed frame ends this safety-deadline generation. Without this,
      // a later frame can inherit the old deadline and be split before its rAF.
      cancelVisibleTerminalWriteIdleFlushIfSettled(term);
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
    const deferFlowAck = !forcePromptNewLine
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
      const finishWrite = () => {
        if (completed) return;
        completed = true;
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
    };

    /**
     * Flow accounting must be exclusive with the stall watchdog's onDropped
     * path. When the watchdog force-completes a lost/late callback it claims
     * first; a subsequent real xterm callback must not re-ack the same bytes.
     */
    const commitFlowAckIfOwned = (): boolean => {
      if (!signal.tryClaimFlowAck()) return false;
      flow.written(ingressBytes);
      return true;
    };

    if (deferFlowAck) {
      writePreparedDisplayData(() => {
        finishQueueItem();
        if (!commitFlowAckIfOwned()) return;
        const deferredTotal = accumulateDeferredTerminalWriteAck(term, ingressBytes);
        if (deferredTotal >= XTERM_WRITE_CALLBACK_BATCH_BYTES) {
          flushDeferredIpcAck();
        } else {
          scheduleDeferredTerminalWriteAckFlush(term, flushIpcAck);
        }
      });
      return;
    }

    // Do not clear deferred IPC acks until this callback owns flow-ack. Clearing
    // early loses those bytes when the stall watchdog recovers the write: the
    // write closure has already dropped them from the deferral buffer, and the
    // late/no-op callback never flushes them — leaving the SSH channel paused.
    writePreparedDisplayData(() => {
      finishQueueItem();
      if (!commitFlowAckIfOwned()) return;
      const deferredBeforeCallback = clearDeferredTerminalWriteAck(term);
      flushIpcAck(deferredBeforeCallback + ingressBytes);
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
  // Only the backend is in scope here; acknowledge held ingress so hibernation
  // does not leave the source paused on bytes that will never be written.
  // Also ACK any ingress already flushed to xterm by the hibernate drain hook.
  let hibernateIngress = frameGateHibernateFlushedIngress.get(term) ?? 0;
  frameGateHibernateFlushedIngress.delete(term);
  resetFrameGate(term, (_buffer, ingress) => {
    hibernateIngress += ingress;
  });
  if (hibernateIngress > 0) {
    ackTerminalSessionFlow(backend, sessionId, hibernateIngress);
    flushTerminalSessionFlowAck(sessionId);
  }
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
  // A write context exists here, so flush any held output to xterm rather than
  // dropping it (forwardSessionData also acknowledges its ingress).
  resetFrameGate(term, (buffer, ingress) => {
    forwardSessionData(ctx, term, buffer, ingress);
  });
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
