import type { Terminal as XTerm } from "@xterm/xterm";

import type { TerminalSessionStartersContext } from "./createTerminalSessionStarters.types";
import { FLOW_LOW_WATER_MARK } from "./terminalFlowConstants";
import type { OutputFlowController } from "./outputFlowController";
import {
  abortTerminalWriteCoalescer,
  resetTerminalWriteCoalescer,
} from "./terminalWriteCoalescer";
import {
  clearDeferredTerminalWriteAck,
  getDeferredTerminalWriteAckBytes,
} from "./terminalWriteAckDeferral";
import {
  abortTerminalWriteQueue,
  getTerminalWriteQueueDepth,
} from "./terminalWriteQueue";
import {
  ackTerminalSessionFlow,
  clearTerminalSessionFlowAck,
  flushTerminalSessionFlowAck,
} from "./terminalFlowAckBuffer";

type FlowBackend = {
  setSessionFlowPaused?: (sessionId: string, paused: boolean) => void;
  ackSessionFlow?: (sessionId: string, bytes: number) => void;
};

type ResumeScheduler = (callback: () => void) => void;

type TerminalInputPriorityReason = "interrupt" | "input";

export type TerminalInputPriorityOptions = {
  reason?: TerminalInputPriorityReason;
  drainStaleOutput?: boolean;
  now?: number;
  quietMs?: number;
  promptQuietMs?: number;
  maxDrainMs?: number;
  promptCandidateBytes?: number;
};

export type TerminalInterruptDisplayFilterReason =
  | "inactive"
  | "draining"
  | "interrupt-echo"
  | "prompt-candidate"
  | "prompt-gap"
  | "quiet-gap"
  | "max-drain";

export type TerminalInterruptDisplayFilterResult = {
  accepted: boolean;
  data: string;
  droppedBytes: number;
  acceptedBytes?: number;
  reason: TerminalInterruptDisplayFilterReason;
};

export type TerminalInputPrioritySnapshot = {
  sessionId: string | null;
  backlogBytes: number;
  writeQueueDepth: number;
  deferredAckBytes: number;
  ackAfterInputBytes: number;
  scheduledBackendResume: boolean;
  skippedReason?: "missing-session" | "below-threshold";
};

const scheduleAfterCurrentInput: ResumeScheduler = (callback) => {
  setTimeout(callback, 0);
};

const DEFAULT_INTERRUPT_DISPLAY_QUIET_MS = 240;
const DEFAULT_INTERRUPT_DISPLAY_PROMPT_QUIET_MS = 80;
const DEFAULT_INTERRUPT_DISPLAY_MAX_DRAIN_MS = 1200;
const DEFAULT_INTERRUPT_DISPLAY_PROMPT_CANDIDATE_BYTES = 512;

type TerminalInterruptDisplayGate = {
  active: boolean;
  startedAt: number;
  lastDroppedAt: number;
  quietMs: number;
  promptQuietMs: number;
  maxDrainMs: number;
  promptCandidateBytes: number;
  droppedBytes: number;
  droppedChunks: number;
  pendingInterruptCaret: boolean;
  pendingDisplayControl: string;
};

const TERMINAL_INTERRUPT_DISPLAY_GATE_KEY = Symbol.for("netcatty.terminalInterruptDisplayGate");
const TERMINAL_INTERRUPT_DISPLAY_GATES_KEY = Symbol.for("netcatty.terminalInterruptDisplayGates");
const terminalInterruptDisplayGateStore = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
const terminalInterruptDisplayGates = (
  terminalInterruptDisplayGateStore[TERMINAL_INTERRUPT_DISPLAY_GATES_KEY] as
    | WeakMap<XTerm, TerminalInterruptDisplayGate>
    | undefined
) ?? new WeakMap<XTerm, TerminalInterruptDisplayGate>();
terminalInterruptDisplayGateStore[TERMINAL_INTERRUPT_DISPLAY_GATES_KEY] = terminalInterruptDisplayGates;

const readTerminalInterruptDisplayGate = (
  term: XTerm,
): TerminalInterruptDisplayGate | undefined => {
  const termStore = term as XTerm & Record<PropertyKey, unknown>;
  return (
    termStore[TERMINAL_INTERRUPT_DISPLAY_GATE_KEY] as TerminalInterruptDisplayGate | undefined
  ) ?? terminalInterruptDisplayGates.get(term);
};

const writeTerminalInterruptDisplayGate = (
  term: XTerm,
  gate: TerminalInterruptDisplayGate,
): void => {
  terminalInterruptDisplayGates.set(term, gate);
  try {
    (term as XTerm & Record<PropertyKey, unknown>)[TERMINAL_INTERRUPT_DISPLAY_GATE_KEY] = gate;
  } catch {
    // Some test doubles or future terminal objects may be non-extensible.
  }
};

const clearTerminalInterruptDisplayGate = (term: XTerm): void => {
  terminalInterruptDisplayGates.delete(term);
  try {
    delete (term as XTerm & Record<PropertyKey, unknown>)[TERMINAL_INTERRUPT_DISPLAY_GATE_KEY];
  } catch {
    // Best effort only; the WeakMap entry is already gone for this module.
  }
};

const nowFromPriorityOptions = (options: Pick<TerminalInputPriorityOptions, "now"> = {}): number =>
  Number.isFinite(options.now) ? Number(options.now) : Date.now();

const charLength = (value: string): number => value.length;

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\][\\s\\S]*?(?:\\x07|${ANSI_ESCAPE}\\\\)`,
  "g",
);

const stripAnsi = (value: string): string =>
  value
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(ANSI_SEQUENCE_PATTERN, "");

const TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ANSI_ESCAPE}[=>]`,
  "g",
);
const RESTORE_PRIVATE_MODE_PARAMS = new Set([
  1,
  47,
  1000,
  1002,
  1003,
  1004,
  1005,
  1006,
  1015,
  1047,
  1048,
  1049,
  2004,
]);
const SHOW_CURSOR_PRIVATE_MODE_PARAM = 25;
const PRIVATE_MODE_PATTERN = new RegExp(`^${ANSI_ESCAPE}\\[\\?([0-9;:]*)([hl])$`);
const TRAILING_RESTORE_CONTROL_PREFIX_PATTERN = new RegExp(
  `^${ANSI_ESCAPE}\\[\\?[0-9;:]*$`,
);

const getPrivateModeParams = (raw: string): { params: number[]; final: "h" | "l" } | null => {
  const match = PRIVATE_MODE_PATTERN.exec(raw);
  if (!match) return null;
  const params = match[1]!
    .split(/[;:]/)
    .map((param) => Number(param))
    .filter((param) => Number.isFinite(param));
  if (params.length === 0) return null;
  return { params, final: match[2] as "h" | "l" };
};

const shouldPreserveTerminalStateRestore = (raw: string): boolean => {
  if (raw === "\x1b>") return true;
  const privateModes = getPrivateModeParams(raw);
  if (!privateModes) return false;
  if (privateModes.final === "h") {
    return privateModes.params.every((param) => param === SHOW_CURSOR_PRIVATE_MODE_PARAM);
  }
  return privateModes.params.every((param) => RESTORE_PRIVATE_MODE_PARAMS.has(param));
};

const getTrailingRestoreControlPrefix = (text: string): string => {
  const escapeIndex = text.lastIndexOf(ANSI_ESCAPE);
  if (escapeIndex < 0) return "";
  const suffix = text.slice(escapeIndex);
  if (suffix === ANSI_ESCAPE) return suffix;
  if (suffix === `${ANSI_ESCAPE}[`) return suffix;
  if (
    suffix.startsWith(`${ANSI_ESCAPE}[?`)
    && TRAILING_RESTORE_CONTROL_PREFIX_PATTERN.test(suffix)
  ) {
    return suffix;
  }
  return "";
};

const getTrailingOscControlPrefix = (text: string): string => {
  const oscIndex = text.lastIndexOf(`${ANSI_ESCAPE}]`);
  if (oscIndex < 0) return "";
  const suffix = text.slice(oscIndex);
  if (suffix.includes("\x07") || suffix.includes(`${ANSI_ESCAPE}\\`)) return "";
  return suffix;
};

const getTrailingDisplayControlPrefix = (text: string): string =>
  getTrailingRestoreControlPrefix(text) || getTrailingOscControlPrefix(text);

const extractTerminalStateRestoreControls = (
  text: string,
  options: { holdTrailingPartial?: boolean } = {},
): { preserved: string; pending: string; droppedBytes: number } => {
  const pending = options.holdTrailingPartial ? getTrailingDisplayControlPrefix(text) : "";
  const searchableText = pending ? text.slice(0, -pending.length) : text;
  let preserved = "";
  for (const match of searchableText.matchAll(TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN)) {
    const raw = match[0];
    if (shouldPreserveTerminalStateRestore(raw)) {
      preserved += raw;
    }
  }
  return {
    preserved,
    pending,
    droppedBytes: Math.max(0, charLength(text) - charLength(preserved) - charLength(pending)),
  };
};

const takePendingDisplayControl = (gate: TerminalInterruptDisplayGate): string => {
  const pending = gate.pendingDisplayControl;
  gate.pendingDisplayControl = "";
  return pending;
};

const finalizeAcceptedTextAfterPendingDisplayControl = (
  pending: string,
  text: string,
): { data: string; droppedBytes: number } => {
  if (!pending) return { data: text, droppedBytes: 0 };
  const combined = `${pending}${text}`;
  TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
  const restoreMatch = TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.exec(combined);
  TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
  if (restoreMatch?.index === 0 && restoreMatch[0].length > pending.length) {
    const raw = restoreMatch[0];
    const remainder = combined.slice(raw.length);
    if (shouldPreserveTerminalStateRestore(raw)) {
      return { data: `${raw}${remainder}`, droppedBytes: 0 };
    }
    return { data: remainder, droppedBytes: charLength(raw) };
  }
  OSC_SEQUENCE_PATTERN.lastIndex = 0;
  const oscMatch = OSC_SEQUENCE_PATTERN.exec(combined);
  OSC_SEQUENCE_PATTERN.lastIndex = 0;
  if (oscMatch?.index === 0 && oscMatch[0].length > pending.length) {
    return { data: combined, droppedBytes: 0 };
  }
  return { data: text, droppedBytes: charLength(pending) };
};

export const shouldArmTerminalInterruptDisplayGateForProtocol = (
  protocol: string | null | undefined,
): boolean => {
  const normalized = String(protocol || "ssh").toLowerCase();
  return normalized === "ssh";
};

const getPromptCandidateSuffix = (text: string): string | null => {
  const normalized = stripAnsi(text).replace(/\r/g, "\n");
  const lastLineStart = normalized.lastIndexOf("\n") + 1;
  const candidate = normalized.slice(lastLineStart).trimEnd();
  if (!candidate) return null;
  if (candidate.length > 160) return null;

  const looksLikePrompt = (
    /^[#$>%]\s*$/.test(candidate)
    || /^[^ \t\r\n<>]{1,80}[#$>%]\s*$/.test(candidate)
    || /^[^\r\n<>]{1,120}[#$>%]\s*$/.test(candidate)
    || /^<[^>\r\n]{1,80}>\s*$/.test(candidate)
    || /^\[[^\]\r\n]{1,120}\]\s*[#$>%]\s*$/.test(candidate)
  );
  if (!looksLikePrompt) return null;

  const rawLastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return text.slice(rawLastBreak + 1);
};

export const armTerminalInterruptDisplayGate = (
  term: XTerm,
  options: TerminalInputPriorityOptions = {},
): void => {
  writeTerminalInterruptDisplayGate(term, {
    active: true,
    startedAt: nowFromPriorityOptions(options),
    lastDroppedAt: 0,
    quietMs: Number.isFinite(options.quietMs)
      ? Number(options.quietMs)
      : DEFAULT_INTERRUPT_DISPLAY_QUIET_MS,
    promptQuietMs: Number.isFinite(options.promptQuietMs)
      ? Number(options.promptQuietMs)
      : DEFAULT_INTERRUPT_DISPLAY_PROMPT_QUIET_MS,
    maxDrainMs: Number.isFinite(options.maxDrainMs)
      ? Number(options.maxDrainMs)
      : DEFAULT_INTERRUPT_DISPLAY_MAX_DRAIN_MS,
    promptCandidateBytes: Number.isFinite(options.promptCandidateBytes)
      ? Number(options.promptCandidateBytes)
      : DEFAULT_INTERRUPT_DISPLAY_PROMPT_CANDIDATE_BYTES,
    droppedBytes: 0,
    droppedChunks: 0,
    pendingInterruptCaret: false,
    pendingDisplayControl: "",
  });
};

export const disarmTerminalInterruptDisplayGate = (term: XTerm): void => {
  clearTerminalInterruptDisplayGate(term);
};

export const filterTerminalInterruptDisplayOutput = (
  term: XTerm,
  data: string,
  options: Pick<TerminalInputPriorityOptions, "now"> = {},
): TerminalInterruptDisplayFilterResult => {
  const text = String(data || "");
  const gate = readTerminalInterruptDisplayGate(term);
  if (!gate?.active) {
    return { accepted: true, data: text, droppedBytes: 0, reason: "inactive" };
  }

  const now = nowFromPriorityOptions(options);
  const pendingDisplayControl = takePendingDisplayControl(gate);
  const combinedText = `${pendingDisplayControl}${text}`;
  const bytes = charLength(combinedText);
  const quietGapMs = gate.lastDroppedAt > 0 ? now - gate.lastDroppedAt : 0;

  if (gate.pendingInterruptCaret) {
    gate.pendingInterruptCaret = false;
    if (text.startsWith("C")) {
      const restoreControls = extractTerminalStateRestoreControls(pendingDisplayControl);
      const droppedBytes = restoreControls.droppedBytes;
      gate.droppedBytes += droppedBytes;
      gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
      disarmTerminalInterruptDisplayGate(term);
      return {
        accepted: true,
        data: `${restoreControls.preserved}^${text}`,
        droppedBytes,
        acceptedBytes: bytes,
        reason: "interrupt-echo",
      };
    }
  }

  const interruptEchoIndex = combinedText.indexOf("^C");
  if (interruptEchoIndex >= 0) {
    const droppedPrefix = combinedText.slice(0, interruptEchoIndex);
    const restoreControls = extractTerminalStateRestoreControls(droppedPrefix);
    const droppedBytes = restoreControls.droppedBytes;
    gate.droppedBytes += droppedBytes;
    gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
    disarmTerminalInterruptDisplayGate(term);
    return {
      accepted: true,
      data: `${restoreControls.preserved}${combinedText.slice(interruptEchoIndex)}`,
      droppedBytes,
      reason: "interrupt-echo",
    };
  }

  const promptCandidate = bytes <= gate.promptCandidateBytes
    ? getPromptCandidateSuffix(combinedText)
    : null;
  if (promptCandidate && gate.droppedBytes === 0) {
    const droppedPrefix = combinedText.slice(0, combinedText.length - promptCandidate.length);
    const restoreControls = extractTerminalStateRestoreControls(droppedPrefix);
    const droppedBytes = restoreControls.droppedBytes;
    gate.droppedBytes += droppedBytes;
    gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
    disarmTerminalInterruptDisplayGate(term);
    return {
      accepted: true,
      data: `${restoreControls.preserved}${promptCandidate}`,
      droppedBytes,
      reason: "prompt-candidate",
    };
  }

  if (promptCandidate && quietGapMs >= gate.promptQuietMs) {
    const droppedPrefix = combinedText.slice(0, combinedText.length - promptCandidate.length);
    const restoreControls = extractTerminalStateRestoreControls(droppedPrefix);
    const droppedBytes = restoreControls.droppedBytes;
    gate.droppedBytes += droppedBytes;
    gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
    disarmTerminalInterruptDisplayGate(term);
    return {
      accepted: true,
      data: `${restoreControls.preserved}${promptCandidate}`,
      droppedBytes,
      reason: "prompt-gap",
    };
  }

  if (quietGapMs >= gate.quietMs) {
    const accepted = finalizeAcceptedTextAfterPendingDisplayControl(pendingDisplayControl, text);
    gate.droppedBytes += accepted.droppedBytes;
    gate.droppedChunks += accepted.droppedBytes > 0 ? 1 : 0;
    disarmTerminalInterruptDisplayGate(term);
    return {
      accepted: true,
      data: accepted.data,
      droppedBytes: accepted.droppedBytes,
      reason: "quiet-gap",
    };
  }

  if (now - gate.startedAt >= gate.maxDrainMs) {
    const accepted = finalizeAcceptedTextAfterPendingDisplayControl(pendingDisplayControl, text);
    gate.droppedBytes += accepted.droppedBytes;
    gate.droppedChunks += accepted.droppedBytes > 0 ? 1 : 0;
    disarmTerminalInterruptDisplayGate(term);
    return {
      accepted: true,
      data: accepted.data,
      droppedBytes: accepted.droppedBytes,
      reason: "max-drain",
    };
  }

  const restoreControls = extractTerminalStateRestoreControls(combinedText, {
    holdTrailingPartial: true,
  });
  const droppedBytes = restoreControls.droppedBytes;
  gate.pendingDisplayControl = restoreControls.pending;
  gate.pendingInterruptCaret = text.endsWith("^");
  gate.lastDroppedAt = now;
  gate.droppedBytes += droppedBytes;
  gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
  if (restoreControls.preserved) {
    return { accepted: true, data: restoreControls.preserved, droppedBytes, reason: "draining" };
  }
  return { accepted: false, data: "", droppedBytes, reason: "draining" };
};

const resolvePrioritizeTerminalInputArgs = (
  scheduleResumeOrOptions?: ResumeScheduler | TerminalInputPriorityOptions,
  maybeOptions?: TerminalInputPriorityOptions,
): { scheduleResume: ResumeScheduler; options: TerminalInputPriorityOptions } => {
  if (typeof scheduleResumeOrOptions === "function") {
    return {
      scheduleResume: scheduleResumeOrOptions,
      options: maybeOptions ?? {},
    };
  }
  return {
    scheduleResume: scheduleAfterCurrentInput,
    options: scheduleResumeOrOptions ?? maybeOptions ?? {},
  };
};

const acknowledgeDroppedBytes = (
  flow: OutputFlowController | undefined,
  bytes: number,
  backend: FlowBackend,
  sessionId: string | null,
) => {
  if (bytes <= 0) return;
  flow?.written(bytes);
  ackTerminalSessionFlow(backend, sessionId, bytes);
  if (sessionId) {
    flushTerminalSessionFlowAck(sessionId);
    backend.setSessionFlowPaused?.(sessionId, false);
  }
};

export const releaseTerminalFlowOutputForTerm = (
  term: XTerm,
  backend: FlowBackend,
  sessionId: string | null,
  flow: OutputFlowController | undefined,
  options: { resumeBackend?: boolean } = {},
): void => {
  const resumeBackend = options.resumeBackend !== false;
  const onDropped = (bytes: number) => {
    acknowledgeDroppedBytes(flow, bytes, backend, sessionId);
  };

  abortTerminalWriteCoalescer(term, onDropped);
  abortTerminalWriteQueue(term, onDropped);
  const deferredAck = clearDeferredTerminalWriteAck(term);
  if (deferredAck > 0) {
    ackTerminalSessionFlow(backend, sessionId, deferredAck);
  }
  flow?.reset({ resume: resumeBackend });
  if (sessionId) {
    flushTerminalSessionFlowAck(sessionId);
    if (resumeBackend) {
      backend.setSessionFlowPaused?.(sessionId, false);
    }
    clearTerminalSessionFlowAck(sessionId);
  }
  resetTerminalWriteCoalescer(term);
  disarmTerminalInterruptDisplayGate(term);
};

export const teardownTerminalOutputPipeline = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  sessionId: string | null,
  flow: OutputFlowController,
): void => {
  releaseTerminalFlowOutputForTerm(term, ctx.terminalBackend, sessionId, flow);
};

export const prioritizeTerminalInput = (
  term: XTerm,
  sessionId: string | null,
  flow: OutputFlowController | undefined,
  backend: FlowBackend,
  scheduleResumeOrOptions?: ResumeScheduler | TerminalInputPriorityOptions,
  maybeOptions?: TerminalInputPriorityOptions,
): TerminalInputPrioritySnapshot => {
  const { scheduleResume, options } = resolvePrioritizeTerminalInputArgs(
    scheduleResumeOrOptions,
    maybeOptions,
  );
  const isInterrupt = options.reason === "interrupt";
  disarmTerminalInterruptDisplayGate(term);

  if (!sessionId) {
    disarmTerminalInterruptDisplayGate(term);
    return {
      sessionId,
      backlogBytes: 0,
      writeQueueDepth: 0,
      deferredAckBytes: 0,
      ackAfterInputBytes: 0,
      scheduledBackendResume: false,
      skippedReason: "missing-session",
    };
  }

  const backlog = flow?.pendingBytes() ?? 0;
  const queueDepth = getTerminalWriteQueueDepth(term);
  const deferredAck = getDeferredTerminalWriteAckBytes(term);

  if (backlog <= FLOW_LOW_WATER_MARK && queueDepth === 0 && deferredAck === 0) {
    disarmTerminalInterruptDisplayGate(term);
    return {
      sessionId,
      backlogBytes: backlog,
      writeQueueDepth: queueDepth,
      deferredAckBytes: deferredAck,
      ackAfterInputBytes: 0,
      scheduledBackendResume: false,
      skippedReason: "below-threshold",
    };
  }

  const hasVisibleBacklog = backlog > FLOW_LOW_WATER_MARK || queueDepth > 0;
  if (!hasVisibleBacklog && deferredAck > 0) {
    const ackAfterInput = clearDeferredTerminalWriteAck(term);
    scheduleResume(() => {
      if (ackAfterInput > 0) {
        ackTerminalSessionFlow(backend, sessionId, ackAfterInput);
      }
      flushTerminalSessionFlowAck(sessionId);
      backend.setSessionFlowPaused?.(sessionId, false);
    });

    return {
      sessionId,
      backlogBytes: backlog,
      writeQueueDepth: queueDepth,
      deferredAckBytes: deferredAck,
      ackAfterInputBytes: ackAfterInput,
      scheduledBackendResume: true,
    };
  }

  if (hasVisibleBacklog && (!isInterrupt || options.drainStaleOutput !== true)) {
    let ackAfterInput = 0;
    if (deferredAck > 0) {
      ackAfterInput = clearDeferredTerminalWriteAck(term);
      scheduleResume(() => {
        if (ackAfterInput > 0) {
          ackTerminalSessionFlow(backend, sessionId, ackAfterInput);
        }
        flushTerminalSessionFlowAck(sessionId);
      });
    }

    return {
      sessionId,
      backlogBytes: backlog,
      writeQueueDepth: queueDepth,
      deferredAckBytes: deferredAck,
      ackAfterInputBytes: ackAfterInput,
      scheduledBackendResume: ackAfterInput > 0,
    };
  }

  if (isInterrupt && hasVisibleBacklog && options.drainStaleOutput === true) {
    armTerminalInterruptDisplayGate(term, options);
  }

  if (!isInterrupt) {
    const ackAfterInput = clearDeferredTerminalWriteAck(term);
    if (ackAfterInput > 0) {
      scheduleResume(() => {
        ackTerminalSessionFlow(backend, sessionId, ackAfterInput);
        flushTerminalSessionFlowAck(sessionId);
      });
    }

    return {
      sessionId,
      backlogBytes: backlog,
      writeQueueDepth: queueDepth,
      deferredAckBytes: deferredAck,
      ackAfterInputBytes: ackAfterInput,
      scheduledBackendResume: ackAfterInput > 0,
    };
  }

  let ackAfterInput = 0;

  const onDropped = (bytes: number) => {
    if (bytes <= 0) return;
    ackAfterInput += bytes;
  };

  abortTerminalWriteCoalescer(term, onDropped);
  abortTerminalWriteQueue(term, onDropped);
  const flushedDeferredAck = clearDeferredTerminalWriteAck(term);
  if (flushedDeferredAck > 0) {
    ackAfterInput += flushedDeferredAck;
  }
  flow?.reset({ resume: false });
  scheduleResume(() => {
    if (ackAfterInput > 0) {
      ackTerminalSessionFlow(backend, sessionId, ackAfterInput);
    }
    flushTerminalSessionFlowAck(sessionId);
    backend.setSessionFlowPaused?.(sessionId, false);
  });

  return {
    sessionId,
    backlogBytes: backlog,
    writeQueueDepth: queueDepth,
    deferredAckBytes: deferredAck,
    ackAfterInputBytes: ackAfterInput,
    scheduledBackendResume: true,
  };
};
