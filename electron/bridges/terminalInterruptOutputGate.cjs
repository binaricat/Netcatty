"use strict";

const {
  stripAnsi,
  extractTerminalStateRestoreControls: extractTerminalStateRestoreControlsShared,
  finalizeAcceptedTextAfterPendingDisplayControl: finalizeAcceptedTextAfterPendingDisplayControlShared,
  isCompletePasswordPrompt,
  extractDrainHold: extractDrainHoldShared,
  isPasswordPrefixPending,
  resolveHeldPasswordPrefix: resolveHeldPasswordPrefixShared,
  getPromptCandidateSuffix,
} = require("../../domain/terminalInterruptParsing.shared.cjs");

const DEFAULT_QUIET_MS = 500;
const DEFAULT_PROMPT_QUIET_MS = 80;
const DEFAULT_MAX_DRAIN_MS = 2500;
const DEFAULT_PROMPT_CANDIDATE_BYTES = 512;
const OUTPUT_GATE_UNACKED_THRESHOLD = 8192;

function nowFromOptions(options = {}) {
  return Number.isFinite(options.now) ? options.now : Date.now();
}

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  return Buffer.byteLength(String(value || ""));
}

function getStreamPaused(stream) {
  try {
    return typeof stream?.isPaused === "function" ? stream.isPaused() : false;
  } catch {
    return false;
  }
}

function extractTerminalStateRestoreControls(text, options = {}) {
  return extractTerminalStateRestoreControlsShared(text, { ...options, measureLength: byteLength });
}

function takePendingDisplayControl(gate) {
  const pending = gate.pendingDisplayControl || "";
  gate.pendingDisplayControl = "";
  return pending;
}

function finalizeAcceptedTextAfterPendingDisplayControl(pending, text) {
  return finalizeAcceptedTextAfterPendingDisplayControlShared(pending, text, {
    measureLength: byteLength,
  });
}

function extractDrainHold(text, options = {}) {
  return extractDrainHoldShared(text, { ...options, measureLength: byteLength });
}

function resolveHeldPasswordPrefix(pending, text) {
  return resolveHeldPasswordPrefixShared(pending, text, { measureLength: byteLength });
}

function shouldArmTerminalInterruptOutputGate(session) {
  if (!session?.stream) return false;
  const flowState = session.flowState;
  return Boolean(
    getStreamPaused(session.stream)
    || flowState?.appliedPause
    || flowState?.rendererPaused
    || (Number(flowState?.unackedBytes) || 0) >= OUTPUT_GATE_UNACKED_THRESHOLD
  );
}

function armTerminalInterruptOutputGate(session, options = {}) {
  if (!session) return false;
  session._interruptOutputGate = {
    active: true,
    startedAt: nowFromOptions(options),
    lastDroppedAt: 0,
    quietMs: Number.isFinite(options.quietMs) ? options.quietMs : DEFAULT_QUIET_MS,
    promptQuietMs: Number.isFinite(options.promptQuietMs) ? options.promptQuietMs : DEFAULT_PROMPT_QUIET_MS,
    maxDrainMs: Number.isFinite(options.maxDrainMs) ? options.maxDrainMs : DEFAULT_MAX_DRAIN_MS,
    promptCandidateBytes: Number.isFinite(options.promptCandidateBytes)
      ? options.promptCandidateBytes
      : DEFAULT_PROMPT_CANDIDATE_BYTES,
    droppedBytes: 0,
    droppedChunks: 0,
    pendingInterruptCaret: false,
    pendingDisplayControl: "",
  };
  return true;
}

function disarmTerminalInterruptOutputGate(session) {
  if (session?._interruptOutputGate) {
    session._interruptOutputGate.active = false;
  }
}

function mergeInterruptOutputMeta(first, second) {
  const droppedOutputMayAffectTerminalState = Boolean(
    first?.droppedOutputMayAffectTerminalState
    || second?.droppedOutputMayAffectTerminalState
  );
  const droppedOutputAlternateScreenAction = second?.droppedOutputMayAffectTerminalState
    ? second?.droppedOutputAlternateScreenAction
    : (second?.droppedOutputAlternateScreenAction ?? first?.droppedOutputAlternateScreenAction);
  if (!droppedOutputMayAffectTerminalState && !droppedOutputAlternateScreenAction) {
    return undefined;
  }
  return {
    ...(droppedOutputMayAffectTerminalState ? { droppedOutputMayAffectTerminalState: true } : {}),
    ...(droppedOutputAlternateScreenAction ? { droppedOutputAlternateScreenAction } : {}),
  };
}

function stashPendingInterruptOutputMeta(session, meta) {
  if (!session || !meta) return;
  session._pendingInterruptOutputMeta = mergeInterruptOutputMeta(
    session._pendingInterruptOutputMeta,
    meta,
  );
}

function takePendingInterruptOutputMeta(session, meta) {
  if (!session) return meta;
  const pending = session._pendingInterruptOutputMeta;
  delete session._pendingInterruptOutputMeta;
  return mergeInterruptOutputMeta(pending, meta);
}

function clearPendingInterruptOutputMeta(session) {
  if (session) {
    delete session._pendingInterruptOutputMeta;
  }
}

function filterTerminalInterruptOutput(session, data, options = {}) {
  const gate = session?._interruptOutputGate;
  const incomingText = String(data || "");
  if (!gate?.active) {
    return { accepted: true, data: incomingText, droppedBytes: 0, reason: "inactive" };
  }

  const now = nowFromOptions(options);
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
  const bytes = byteLength(combinedText);
  const quietGapMs = gate.lastDroppedAt > 0 ? now - gate.lastDroppedAt : 0;
  const withPrefixDrop = (droppedBytes) => droppedBytes + prefixDropBytes;

  if (gate.pendingInterruptCaret) {
    gate.pendingInterruptCaret = false;
    if (text.startsWith("C")) {
      const restoreControls = extractTerminalStateRestoreControls(pendingDisplayControl);
      const droppedBytes = restoreControls.droppedBytes;
      gate.droppedBytes += droppedBytes;
      gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
      disarmTerminalInterruptOutputGate(session);
      return {
        accepted: true,
        data: `${restoreControls.preserved}^${text}`,
        droppedBytes: withPrefixDrop(droppedBytes),
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
    disarmTerminalInterruptOutputGate(session);
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
      disarmTerminalInterruptOutputGate(session);
      return {
        accepted: true,
        data: `${restoreControls.preserved}${passwordPromptCandidate}`,
        droppedBytes: withPrefixDrop(droppedBytes),
        reason: heldPasswordPrefixContinued ? "prompt-gap" : "password-prompt",
      };
    }
  }

  if (gate.droppedBytes === 0 && bytes <= gate.promptCandidateBytes) {
    const promptCandidate = getPromptCandidateSuffix(combinedText);
    if (promptCandidate) {
      const droppedPrefix = combinedText.slice(0, combinedText.length - promptCandidate.length);
      const restoreControls = extractTerminalStateRestoreControls(droppedPrefix);
      const droppedBytes = restoreControls.droppedBytes;
      gate.droppedBytes += droppedBytes;
      gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
      disarmTerminalInterruptOutputGate(session);
      return {
        accepted: true,
        data: `${restoreControls.preserved}${promptCandidate}`,
        droppedBytes: withPrefixDrop(droppedBytes),
        reason: "prompt-candidate",
      };
    }
  }

  if (quietGapMs >= gate.promptQuietMs && bytes <= gate.promptCandidateBytes) {
    const promptCandidate = getPromptCandidateSuffix(combinedText);
    if (promptCandidate) {
      const droppedPrefix = combinedText.slice(0, combinedText.length - promptCandidate.length);
      const restoreControls = extractTerminalStateRestoreControls(droppedPrefix);
      const droppedBytes = restoreControls.droppedBytes;
      gate.droppedBytes += droppedBytes;
      gate.droppedChunks += droppedBytes > 0 ? 1 : 0;
      disarmTerminalInterruptOutputGate(session);
      return {
        accepted: true,
        data: `${restoreControls.preserved}${promptCandidate}`,
        droppedBytes: withPrefixDrop(droppedBytes),
        reason: "prompt-gap",
      };
    }
  }

  if (quietGapMs >= gate.quietMs) {
    const accepted = finalizeAcceptedTextAfterPendingDisplayControl(pendingDisplayControl, text);
    gate.droppedBytes += accepted.droppedBytes;
    gate.droppedChunks += accepted.droppedBytes > 0 ? 1 : 0;
    disarmTerminalInterruptOutputGate(session);
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
    disarmTerminalInterruptOutputGate(session);
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
}

module.exports = {
  armTerminalInterruptOutputGate,
  clearPendingInterruptOutputMeta,
  disarmTerminalInterruptOutputGate,
  filterTerminalInterruptOutput,
  shouldArmTerminalInterruptOutputGate,
  stashPendingInterruptOutputMeta,
  takePendingInterruptOutputMeta,
};
