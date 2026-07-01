"use strict";

const DEFAULT_QUIET_MS = 500;
const DEFAULT_PROMPT_QUIET_MS = 80;
const DEFAULT_MAX_DRAIN_MS = 2500;
const DEFAULT_PROMPT_CANDIDATE_BYTES = 512;
const OUTPUT_GATE_UNACKED_THRESHOLD = 8192;
const ESC = String.fromCharCode(27);
const TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[=>]`,
  "g",
);
const PRIVATE_MODE_PATTERN = new RegExp(`^${ESC}\\[\\?([0-9;:]*)([hl])$`);
const TRAILING_RESTORE_CONTROL_PREFIX_PATTERN = new RegExp(`^${ESC}\\[\\?[0-9;:]*$`);
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

function stripAnsi(value) {
  const raw = String(value || "");
  return raw
    .replace(new RegExp(`${ESC}\\][\\s\\S]*?(?:\\x07|${ESC}\\\\)`, "g"), "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function getPrivateModeParams(raw) {
  const match = PRIVATE_MODE_PATTERN.exec(raw);
  if (!match) return null;
  const params = match[1]
    .split(/[;:]/)
    .map((param) => Number(param))
    .filter((param) => Number.isFinite(param));
  if (params.length === 0) return null;
  return { params, final: match[2] };
}

function shouldPreserveTerminalStateRestore(raw) {
  if (raw === `${ESC}>`) return true;
  const privateModes = getPrivateModeParams(raw);
  if (!privateModes) return false;
  if (privateModes.final === "h") {
    return privateModes.params.every((param) => param === SHOW_CURSOR_PRIVATE_MODE_PARAM);
  }
  return privateModes.params.every((param) => RESTORE_PRIVATE_MODE_PARAMS.has(param));
}

function getTrailingRestoreControlPrefix(text) {
  const raw = String(text || "");
  const escapeIndex = raw.lastIndexOf(ESC);
  if (escapeIndex < 0) return "";
  const suffix = raw.slice(escapeIndex);
  if (suffix === ESC) return suffix;
  if (suffix === `${ESC}[`) return suffix;
  if (suffix.startsWith(`${ESC}[?`) && TRAILING_RESTORE_CONTROL_PREFIX_PATTERN.test(suffix)) {
    return suffix;
  }
  return "";
}

function getTrailingOscControlPrefix(text) {
  const raw = String(text || "");
  const oscIndex = raw.lastIndexOf(`${ESC}]`);
  if (oscIndex < 0) return "";
  const suffix = raw.slice(oscIndex);
  if (suffix.includes("\x07") || suffix.includes(`${ESC}\\`)) return "";
  return suffix;
}

function getTrailingDisplayControlPrefix(text) {
  return getTrailingRestoreControlPrefix(text) || getTrailingOscControlPrefix(text);
}

function extractTerminalStateRestoreControls(text, options = {}) {
  const rawText = String(text || "");
  const pending = options.holdTrailingPartial ? getTrailingDisplayControlPrefix(rawText) : "";
  const searchableText = pending ? rawText.slice(0, -pending.length) : rawText;
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
    droppedBytes: Math.max(0, byteLength(rawText) - byteLength(preserved) - byteLength(pending)),
  };
}

function takePendingDisplayControl(gate) {
  const pending = gate.pendingDisplayControl || "";
  gate.pendingDisplayControl = "";
  return pending;
}

function finalizeAcceptedTextAfterPendingDisplayControl(pending, text) {
  const rawText = String(text || "");
  if (!pending) return { data: rawText, droppedBytes: 0 };
  const combined = `${pending}${rawText}`;
  TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
  const restoreMatch = TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.exec(combined);
  TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
  if (restoreMatch?.index === 0 && restoreMatch[0].length > pending.length) {
    const raw = restoreMatch[0];
    const remainder = combined.slice(raw.length);
    if (shouldPreserveTerminalStateRestore(raw)) {
      return { data: `${raw}${remainder}`, droppedBytes: 0 };
    }
    return { data: remainder, droppedBytes: byteLength(raw) };
  }
  const oscPattern = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\x07|${ESC}\\\\)`, "g");
  const oscMatch = oscPattern.exec(combined);
  if (oscMatch?.index === 0 && oscMatch[0].length > pending.length) {
    return { data: combined, droppedBytes: 0 };
  }
  return { data: rawText, droppedBytes: byteLength(pending) };
}

function getPromptCandidateSuffix(text) {
  const raw = String(text || "");
  const normalized = stripAnsi(raw).replace(/\r/g, "\n");
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

  const rawLastBreak = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r"));
  return raw.slice(rawLastBreak + 1);
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
  const text = String(data || "");
  if (!gate?.active) {
    return { accepted: true, data: text, droppedBytes: 0, reason: "inactive" };
  }

  const now = nowFromOptions(options);
  const pendingDisplayControl = takePendingDisplayControl(gate);
  const combinedText = `${pendingDisplayControl}${text}`;
  const bytes = byteLength(combinedText);
  const quietGapMs = gate.lastDroppedAt > 0 ? now - gate.lastDroppedAt : 0;

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
        droppedBytes,
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
      droppedBytes,
      reason: "interrupt-echo",
    };
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
        droppedBytes,
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
        droppedBytes,
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
      droppedBytes: accepted.droppedBytes,
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
