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
// Incomplete CSI (params/intermediates, no final byte) — e.g. ESC[0 or ESC[31
const TRAILING_CSI_CONTROL_PREFIX_PATTERN = new RegExp(
  `^${ANSI_ESCAPE}\\[[0-?]*[ -/]*$`,
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
  // Hold any incomplete CSI (ESC[ / ESC[0 / ESC[31 / ESC[?1049), not only
  // private-mode restore prefixes — styled password prompts can split mid-SGR.
  if (TRAILING_CSI_CONTROL_PREFIX_PATTERN.test(suffix)) return suffix;
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
  // Held password-prompt prefixes (plain or SGR-styled). Keep them when
  // quiet/max-drain resumes so a split "Pass"+"word: " is not lost.
  if (isProbablePasswordPromptPrefix(pending)) {
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

const isCompletePasswordPrompt = (candidate: string): boolean => {
  const trimmed = candidate.trimEnd();
  if (!trimmed) return false;
  // Align with terminalSudoAutofill's Kylin coverage (#1293): prompts may end
  // with 密码/口令 and no colon (e.g. "用户 的密码"). Still require a password
  // keyword so ordinary lines like "Password authentication failed" stay out.
  return (
    /(?:\bpassword\b|密\s*码|口\s*令)/i.test(trimmed)
    && (
      /[:：]\s*$/.test(trimmed)
      || /\[sudo/i.test(trimmed)
      || /(?:密\s*码|口\s*令)\s*$/.test(trimmed)
      || /^input\s+password\s*$/i.test(trimmed)
      || /^password\s*$/i.test(trimmed)
    )
  );
};

const isProbablePasswordPromptPrefix = (candidate: string): boolean => {
  // Strip SGR/OSC for matching so styled chunks like "\x1b[31mPass" still hold,
  // while callers keep the raw pending bytes for display.
  let trimmed = stripAnsi(candidate).trimEnd();
  // Incomplete CSI/OSC left after stripAnsi (e.g. trailing "\x1b[") must not
  // prevent matching a held password prefix.
  const trailingControl = getTrailingDisplayControlPrefix(trimmed);
  if (trailingControl) {
    trimmed = trimmed.slice(0, -trailingControl.length).trimEnd();
  }
  if (!trimmed || trimmed.length > 160) return false;
  if (/[\r\n]/.test(trimmed)) return false;
  if (isCompletePasswordPrompt(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  const prefixTargets = [
    "password",
    "password:",
    "password：",
    "[sudo",
    "密码",
    "密码：",
    "口令",
    "口令：",
    "输入密码",
    "输入密码：",
    "input password",
    "input password:",
  ];
  if (prefixTargets.some((target) => target.startsWith(lower))) return true;

  // Allow an unfinished "[sudo…]" tag, or "[sudo…] " + a password-word prefix.
  const sudoTag = trimmed.match(/^\[sudo[^\]]*\]?\s*/i);
  if (sudoTag) {
    const remainder = trimmed.slice(sudoTag[0].length);
    if (!remainder) {
      if (/^\[sudo(?:[^\]]*)\]?\s*$/i.test(trimmed)) return true;
    } else {
      const remLower = remainder.toLowerCase();
      const remTargets = [
        "password",
        "password:",
        "password：",
        "密码",
        "密码：",
        "口令",
        "口令：",
        "输入密码",
        "输入密码：",
        "input password",
        "input password:",
      ];
      if (remTargets.some((target) => target.startsWith(remLower))) return true;
    }
  }

  // Prompts with leading text split mid-keyword, e.g. `alice@host's pass` +
  // `word:` or `用户 的密` + `码`. Hold when a trailing suffix is a real
  // password-keyword prefix at a word boundary.
  return hasTrailingPasswordKeywordPrefix(trimmed);
};

const hasTrailingPasswordKeywordPrefix = (trimmed: string): boolean => {
  const lower = trimmed.toLowerCase();
  const keywordTargets = [
    "password",
    "password:",
    "password：",
    "密码",
    "密码：",
    "口令",
    "口令：",
    "输入密码",
    "输入密码：",
    "input password",
    "input password:",
  ];

  for (const target of keywordTargets) {
    const maxLen = Math.min(lower.length, target.length);
    // ASCII keywords: require >= 3 chars ("pas"/"pass") so lone "p"/"pa" mid-line
    // noise is not held. CJK keywords can match a single character ("密").
    // Ignore punctuation (incl. full-width ：) so "password：" stays ASCII minLen.
    const keywordBody = target.replace(/[:：\s]/g, "");
    let isAsciiKeyword = true;
    for (let i = 0; i < keywordBody.length; i += 1) {
      if (keywordBody.charCodeAt(i) > 0x7f) {
        isAsciiKeyword = false;
        break;
      }
    }
    const minLen = isAsciiKeyword ? 3 : 1;
    for (let len = maxLen; len >= minLen; len -= 1) {
      const suffix = lower.slice(-len);
      if (!target.startsWith(suffix)) continue;
      const before = lower.slice(0, -len);
      if (before.length === 0) return true;
      const prev = before[before.length - 1]!;
      if (!/[a-z0-9]/i.test(prev)) return true;
    }
  }
  return false;
};

const getTrailingPasswordPromptPrefix = (text: string): string => {
  const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  const trailing = text.slice(lastBreak + 1);
  if (!trailing) return "";
  return isProbablePasswordPromptPrefix(trailing) ? trailing : "";
};

/**
 * Restore sequences already counted in `preserved` can also sit at the start of
 * the trailing password-prefix line (e.g. "stale\n\x1b[?1049lPass", or multiple
 * restores "\x1b[?25hstale\n\x1b[?1049lPass"). Strip only complete leading
 * restore sequences that are a real suffix of `preserved` — never peel chars
 * like the final "l" of "\x1b[?1049l" off "login pass".
 */
const stripLeadingPreservedOverlap = (
  passwordPending: string,
  preserved: string,
): string => {
  let pending = passwordPending;
  let keep = preserved;
  if (!pending || !keep) return pending;
  if (pending.startsWith(keep)) return pending.slice(keep.length);

  while (pending && keep) {
    TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
    const match = TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.exec(pending);
    TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
    if (!match || match.index !== 0) break;
    const seq = match[0];
    if (!shouldPreserveTerminalStateRestore(seq) || !keep.endsWith(seq)) break;
    pending = pending.slice(seq.length);
    keep = keep.slice(0, -seq.length);
  }
  return pending;
};

/**
 * When discarding a held prefix that ends mid-CSI, also drop the CSI final
 * byte(s) from the next chunk so "Pass\x1b[0" + "m$ " does not leak as "m$ ".
 */
const consumeTrailingCsiCompletion = (
  pending: string,
  text: string,
): { text: string; extraDroppedBytes: number } => {
  const control = getTrailingDisplayControlPrefix(pending);
  if (!control || !control.startsWith(`${ANSI_ESCAPE}[`)) {
    return { text, extraDroppedBytes: 0 };
  }
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    // CSI parameter bytes 0–? and intermediate bytes SP–/
    if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
      i += 1;
      continue;
    }
    // CSI final byte @–~
    if (code >= 0x40 && code <= 0x7e) {
      return { text: text.slice(i + 1), extraDroppedBytes: i + 1 };
    }
    break;
  }
  return { text, extraDroppedBytes: 0 };
};

const isStandaloneHoldableControlPrefix = (pending: string): boolean => {
  if (!pending) return false;
  if (pending === ANSI_ESCAPE || pending === `${ANSI_ESCAPE}[`) return true;
  // Incomplete private-mode restore CSI and OSC title prefixes are safe to hold
  // alone; incomplete SGR CSI (ESC[31) is not — it can leak into "$ ".
  if (
    pending.startsWith(`${ANSI_ESCAPE}[?`)
    && TRAILING_RESTORE_CONTROL_PREFIX_PATTERN.test(pending)
  ) {
    return true;
  }
  if (pending.startsWith(`${ANSI_ESCAPE}]`)) return true;
  return false;
};

const extractDrainHold = (
  text: string,
  options: { holdTrailingPartial?: boolean } = {},
): { preserved: string; pending: string; droppedBytes: number } => {
  const restoreControls = extractTerminalStateRestoreControls(text, options);
  if (!options.holdTrailingPartial) {
    return restoreControls;
  }

  // A styled prompt can split mid-CSI, e.g. "\x1b[31mPass\x1b[" + "0mword: ".
  // Keep both the password-prefix body and the trailing control prefix so the
  // next chunk can still complete "Password:" (#2010 Codex follow-up).
  const controlPending = restoreControls.pending;
  const textWithoutControl = controlPending
    ? text.slice(0, -controlPending.length)
    : text;
  let passwordPending = getTrailingPasswordPromptPrefix(textWithoutControl);
  passwordPending = stripLeadingPreservedOverlap(
    passwordPending,
    restoreControls.preserved,
  );
  if (!passwordPending || !isProbablePasswordPromptPrefix(passwordPending)) {
    // Incomplete SGR CSI (ESC[31) must not be held alone — otherwise the next
    // shell prompt can be accepted as "\x1b[31$ " and leak stale color bytes.
    // Restore/OSC prefixes stay held as before.
    if (controlPending && !isStandaloneHoldableControlPrefix(controlPending)) {
      return {
        preserved: restoreControls.preserved,
        pending: "",
        droppedBytes: Math.max(
          0,
          charLength(text) - charLength(restoreControls.preserved),
        ),
      };
    }
    return restoreControls;
  }

  const pending = `${passwordPending}${controlPending}`;
  return {
    preserved: restoreControls.preserved,
    pending,
    droppedBytes: Math.max(
      0,
      charLength(text) - charLength(restoreControls.preserved) - charLength(pending),
    ),
  };
};

const isPasswordPrefixPending = (pending: string): boolean =>
  Boolean(pending) && isProbablePasswordPromptPrefix(pending);

const getLastVisibleLine = (text: string): string => {
  const normalized = stripAnsi(text).replace(/\r/g, "\n");
  const lastLineStart = normalized.lastIndexOf("\n") + 1;
  return normalized.slice(lastLineStart).trimEnd();
};

/**
 * A held "Pass" / "[sudo] pass" must only survive when the next chunk continues
 * or completes a password prompt. Otherwise discard it before the generic
 * shell-prompt matcher can accept junk like "Pass$ " (#2010 Codex follow-up).
 */
const resolveHeldPasswordPrefix = (
  pending: string,
  text: string,
): { pending: string; text: string; droppedPendingBytes: number } => {
  if (!isPasswordPrefixPending(pending)) {
    return { pending, text, droppedPendingBytes: 0 };
  }

  // Held prefixes must continue on the same line. A leading line break means
  // the next chunk is a fresh line (e.g. "Pass" then "\nPassword: "), not a
  // completion of the held prefix — discard so quiet-gap still applies.
  if (/^[\r\n]/.test(text)) {
    return {
      pending: "",
      text,
      droppedPendingBytes: charLength(pending),
    };
  }

  const combined = `${pending}${text}`;
  const lastLine = getLastVisibleLine(combined);
  if (isCompletePasswordPrompt(lastLine) || isProbablePasswordPromptPrefix(lastLine)) {
    return { pending: "", text: combined, droppedPendingBytes: 0 };
  }

  const consumed = consumeTrailingCsiCompletion(pending, text);
  return {
    pending: "",
    text: consumed.text,
    droppedPendingBytes: charLength(pending) + consumed.extraDroppedBytes,
  };
};

const getPromptCandidateSuffix = (text: string): string | null => {
  const normalized = stripAnsi(text).replace(/\r/g, "\n");
  const lastLineStart = normalized.lastIndexOf("\n") + 1;
  const candidate = normalized.slice(lastLineStart).trimEnd();
  if (!candidate) return null;
  if (candidate.length > 160) return null;

  // Password prompts are interactive resume points too. Without this, Ctrl+C
  // drain treats "[sudo] password for …:" as stale flood and drops it, so the
  // remote waits for a password while the terminal shows nothing (#2010).
  const looksLikePrompt = (
    isCompletePasswordPrompt(candidate)
    || /^[#$>%]\s*$/.test(candidate)
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
