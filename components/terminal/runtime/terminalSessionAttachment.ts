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
  createTerminalOutputTimestampPrefixer,
  type TerminalOutputTimestampPrefixer,
} from "./terminalOutputTimestamps";
import { createSudoPasswordAutofill } from "./terminalSudoAutofill";

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
    if (ctx.pendingOutputScrollRef) {
      ctx.pendingOutputScrollRef.current = true;
    }
    return;
  }

  term.scrollToBottom();
};

type TerminalWriteQueue = {
  writing: boolean;
  pending: Array<() => void>;
};

const terminalWriteQueues = new WeakMap<XTerm, TerminalWriteQueue>();
const terminalOutputTimestampPrefixers = new WeakMap<XTerm, TerminalOutputTimestampPrefixer>();

const scheduleNextTerminalWrite = (term: XTerm, queue: TerminalWriteQueue) => {
  const next = queue.pending.shift();
  if (!next) {
    queue.writing = false;
    terminalWriteQueues.delete(term);
    return;
  }

  queue.writing = true;
  next();
};

const enqueueTerminalWrite = (
  term: XTerm,
  write: (done: () => void) => void,
) => {
  let queue = terminalWriteQueues.get(term);
  if (!queue) {
    queue = { writing: false, pending: [] };
    terminalWriteQueues.set(term, queue);
  }

  queue.pending.push(() => {
    write(() => scheduleNextTerminalWrite(term, queue));
  });

  if (!queue.writing) {
    scheduleNextTerminalWrite(term, queue);
  }
};

// Output back-pressure. Without this the renderer can't slow a flooding source,
// so a busy stream grows the write queue and xterm's buffer unbounded. The
// controller tracks bytes received-but-not-yet-rendered and asks the main
// process to pause/resume the session's source stream at these watermarks.
const FLOW_HIGH_WATER_MARK = 256 * 1024; // pause the source above ~256KB backlog
const FLOW_LOW_WATER_MARK = 64 * 1024; // resume once drained to ~64KB

const terminalFlowControllers = new WeakMap<XTerm, OutputFlowController>();

const getTerminalOutputTimestampPrefixer = (term: XTerm): TerminalOutputTimestampPrefixer => {
  let prefixer = terminalOutputTimestampPrefixers.get(term);
  if (!prefixer) {
    prefixer = createTerminalOutputTimestampPrefixer();
    terminalOutputTimestampPrefixers.set(term, prefixer);
  }
  return prefixer;
};

export const resetTerminalOutputTimestamps = (term: XTerm) => {
  getTerminalOutputTimestampPrefixer(term).reset();
};

const applyTerminalOutputTimestamps = (
  term: XTerm,
  data: string,
  enabled: boolean,
): string => {
  const prefixer = getTerminalOutputTimestampPrefixer(term);
  if (!enabled) {
    prefixer.reset();
    return data;
  }
  prefixer.setAlternateScreenActive((term.buffer.active as { type?: string }).type === "alternate");
  return prefixer.append(data);
};

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
  }
  return controller;
};

export const writeTerminalLine = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  enqueueTerminalWrite(term, (done) => {
    const lineData = `${data}\r\n`;
    ctx.onTerminalLogData?.(lineData);
    term.write(lineData, done);
  });
};

export const writeSessionData = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  const flow = getFlowController(ctx, term);
  flow.received(data.length);
  enqueueTerminalWrite(term, (done) => {
    const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
    const timestampsEnabled = settings?.showLineTimestamps === true;
    const forcePromptNewLine = settings?.forcePromptNewLine ?? false;
    if (!forcePromptNewLine && ctx.promptLineBreakStateRef?.current) {
      ctx.promptLineBreakStateRef.current.pendingCommand = false;
      ctx.promptLineBreakStateRef.current.suppressNextPromptCache = false;
    }
    const pasteDisplayData = prepareTerminalDataForUserPasteDisplay(term, data);
    const displayData = prepareTerminalDataForPromptLineBreak(
      term,
      pasteDisplayData,
      ctx.promptLineBreakStateRef?.current,
      forcePromptNewLine,
    );
    const finalDisplayData = applyTerminalOutputTimestamps(term, displayData, timestampsEnabled);
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
    const afterWrite = () => {
      clearPasteResidualAndCapture();
      syncPrompt();
      if (shouldScrollOnTerminalOutput(settings)) {
        handleTerminalOutputAutoScroll(ctx, term);
      }
      done();
      // Acknowledge the chunk so back-pressure can ease once xterm catches up.
      flow.written(data.length);
    };

    term.write(finalDisplayData, afterWrite);
  });
};

export const attachSessionToTerminal = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  id: string,
  opts?: {
    onExitMessage?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => string;
    onConnected?: () => void;
    onExit?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => void;
    // For serial: convert lone LF to CRLF to avoid "staircase effect"
    convertLfToCrlf?: boolean;
    sudoAutofillPassword?: string;
  },
) => {
  ctx.sessionRef.current = id;
  // Clear any stale back-pressure accounting from a prior session on this term.
  getFlowController(ctx, term).reset();
  resetTerminalOutputTimestamps(term);
  ctx.onSessionAttached?.(id);
  const sudoAutofill = createSudoPasswordAutofill({
    password: opts?.sudoAutofillPassword,
    write: (data) => ctx.terminalBackend.writeToSession(id, data, { automated: true }),
    onHint: (active) => ctx.onSudoHint?.(active) ?? false,
  });
  if (ctx.sudoAutofillRef) {
    ctx.sudoAutofillRef.current = sudoAutofill;
  }

  ctx.disposeDataRef.current = ctx.terminalBackend.onSessionData(id, (chunk) => {
    let data = chunk;
    // Convert lone LF (\n) to CRLF (\r\n) for proper terminal display
    // This prevents the "staircase effect" common in serial terminals
    if (opts?.convertLfToCrlf) {
      // Replace \n that is not preceded by \r with \r\n
      data = data.replace(/(?<!\r)\n/g, "\r\n");
    }
    data = sudoAutofill?.handleOutput(data) ?? data;
    writeSessionData(ctx, term, data);
    if (!ctx.hasConnectedRef.current) {
      ctx.updateStatus("connected");
      opts?.onConnected?.();
      setTimeout(() => {
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
  });

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

    // Clean up the connection token for this sessionId so stale timers
    // that haven't fired yet will fail the isConnectionTokenCurrent check
    // (previously they would see the old token still in the map and pass).
    clearConnectionToken(ctx.sessionId);

    opts?.onExit?.(evt);
    if (ctx.sudoAutofillRef) {
      ctx.sudoAutofillRef.current = null;
    }
    ctx.onSessionExit?.(ctx.sessionId, evt);
  });
};
