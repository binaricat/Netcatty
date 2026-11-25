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
import {
  extractDrainHold,
  extractTerminalStateRestoreControls,
  finalizeAcceptedTextAfterPendingDisplayControl,
  getPromptCandidateSuffix,
  isCompletePasswordPrompt,
  isPasswordPrefixPending,
  resolveHeldPasswordPrefix,
  stripAnsi,
} from "@/domain/terminalInterruptParsing.shared.cjs";

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
  | "password-prompt"
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

const takePendingDisplayControl = (gate: TerminalInterruptDisplayGate): string => {
  const pending = gate.pendingDisplayControl;
  gate.pendingDisplayControl = "";
  return pending;
};

export const shouldArmTerminalInterruptDisplayGateForProtocol = (
  protocol: string | null | undefined,
): boolean => {
  const normalized = String(protocol || "ssh").toLowerCase();
  return normalized === "ssh";
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
  const incomingText = String(data || "");
  const gate = readTerminalInterruptDisplayGate(term);
  if (!gate?.active) {
    return { accepted: true, data: incomingText, droppedBytes: 0, reason: "inactive" };
  }

  const now = nowFromPriorityOptions(options);
  const rawPendingDisplayControl = takePendingDisplayControl(gate);
  const hadHeldPasswordPrefix = isPasswordPrefixPending(rawPendingDisplayControl);
  const resolvedPasswordPrefix = resolveHeldPasswordPrefix(
    rawPendingDisplayControl,
    incomingText,
  );
  const prefixDropBytes = resolvedPasswordPrefix.droppedPendingBytes;
  // Only treat the held prefix as continued when it was merged into this chunk
  // (not discarded across a line break / non-prompt continuation).
  const heldPasswordPrefixContinued = (
    hadHeldPasswordPrefix
    && prefixDropBytes === 0
    && resolvedPasswordPrefix.pending === ""
  );
  if (prefixDropBytes > 0) {
    gate.droppedBytes += prefixDropBytes;
    gate.droppedChunks += 1;
  }
  const pendingDisplayControl = resolvedPasswordPrefix.pending;
  const text = resolvedPasswordPrefix.text;
  const combinedText = `${pendingDisplayControl}${text}`;
  const bytes = charLength(combinedText);
  const quietGapMs = gate.lastDroppedAt > 0 ? now - gate.lastDroppedAt : 0;
  const withPrefixDrop = (droppedBytes: number): number => droppedBytes + prefixDropBytes;

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
        droppedBytes: withPrefixDrop(droppedBytes),
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
      droppedBytes: withPrefixDrop(droppedBytes),
      reason: "interrupt-echo",
    };
  }

  // Complete password prompts resume immediately — including one-chunk prompts
  // before promptQuietMs, held-prefix completions, and last-line prompts that
  // arrive after a large stale prefix. Unlike shell prompts, password prompts
  // often emit nothing further until the user types; dropping them leaves a
  // blank terminal while the remote waits (#2010). Detect the last-line
  // password candidate independently of the whole-chunk promptCandidateBytes
  // cap used for ordinary shell prompts.
  {
    const passwordPromptCandidate = getPromptCandidateSuffix(combinedText);
    if (
      passwordPromptCandidate
      && isCompletePasswordPrompt(stripAnsi(passwordPromptCandidate))
    ) {
      const droppedPrefix = combinedText.slice(
        0,
        combinedText.length - passwordPromptCandidate.length,
      );
      const restoreControls = extractTerminalStateRestoreControls(droppedPrefix);
      const droppedBytes = restoreControls.droppedBytes;
      gate.droppedBytes += droppedBytes;
      gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
      disarmTerminalInterruptDisplayGate(term);
      return {
        accepted: true,
        data: `${restoreControls.preserved}${passwordPromptCandidate}`,
        droppedBytes: withPrefixDrop(droppedBytes),
        reason: heldPasswordPrefixContinued ? "prompt-gap" : "password-prompt",
      };
    }
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
      droppedBytes: withPrefixDrop(droppedBytes),
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
      droppedBytes: withPrefixDrop(droppedBytes),
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
      droppedBytes: withPrefixDrop(accepted.droppedBytes),
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
      droppedBytes: withPrefixDrop(accepted.droppedBytes),
      reason: "max-drain",
    };
  }

  const restoreControls = extractDrainHold(combinedText, {
    holdTrailingPartial: true,
  });
  const droppedBytes = restoreControls.droppedBytes;
  gate.pendingDisplayControl = restoreControls.pending;
  gate.pendingInterruptCaret = text.endsWith("^");
  gate.lastDroppedAt = now;
  gate.droppedBytes += droppedBytes;
  gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
  if (restoreControls.preserved) {
    return {
      accepted: true,
      data: restoreControls.preserved,
      droppedBytes: withPrefixDrop(droppedBytes),
      reason: "draining",
    };
  }
  return {
    accepted: false,
    data: "",
    droppedBytes: withPrefixDrop(droppedBytes),
    reason: "draining",
  };
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
