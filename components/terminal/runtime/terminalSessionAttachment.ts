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
import type { TerminalSessionStartersContext } from "./createTerminalSessionStarters.types";
import { clearConnectionToken } from "./terminalDistroDetection";
import {
  resetTerminalLineTimestamps,
  writeTerminalDataWithLineTimestamps,
} from "./terminalLineTimestamps";
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
  shouldFlushTerminalWritesForHiddenPage,
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
};

const HIDDEN_PAGE_FLUSH_MAX_PASSES = 64;

const flushTerminalWritesForHiddenPage = (term: XTerm): void => {
  flushTerminalWriteBufferBypassingTimers(term);
  for (let pass = 0; pass < HIDDEN_PAGE_FLUSH_MAX_PASSES; pass += 1) {
    if (!flushTerminalWriteQueueBypassingTimers(term)) {
      return;
    }
    flushTerminalWriteBufferBypassingTimers(term);
  }
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
) => {
  const flow = getFlowController(ctx, term);
  const isPaneVisible = ctx.isVisibleRef?.current !== false;
  flow.received(ingressBytes);
  setTerminalOutputPressureVisibility(term, isPaneVisible);
  noteTerminalOutputPressureData(term, data);
  if (shouldFlushTerminalWritesForHiddenPage(isPaneVisible)) {
    const writeHiddenPageData = (
      batch: string,
      batchIngress: number,
    ): void => {
      writeSessionDataImmediate(ctx, term, batch, batchIngress, {
        flushXtermWriteBuffer: true,
      });
      flushTerminalWritesForHiddenPage(term);
    };
    flushTerminalWriteCoalescer(term, writeHiddenPageData);
    flushTerminalWritesForHiddenPage(term);
    enqueueCoalescedTerminalWrite(term, data, writeHiddenPageData, ingressBytes);
    flushTerminalWriteCoalescer(term, writeHiddenPageData);
    flushTerminalWritesForHiddenPage(term);
    return;
  }
  enqueueCoalescedTerminalWrite(term, data, (batch, batchIngress, writeOptions) => {
    writeSessionDataImmediate(ctx, term, batch, batchIngress, writeOptions);
  }, ingressBytes);
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
      writeTerminalDataWithLineTimestamps(term, preparedDisplayData, callback);
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
        commitIpcAck(ackOnCallback);
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
      writeSessionData(ctx, term, data, ingressBytes);
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
