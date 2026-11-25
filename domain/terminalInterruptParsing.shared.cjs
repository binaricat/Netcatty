"use strict";

const ESC = String.fromCharCode(27);
const ANSI_SEQUENCE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\][\\s\\S]*?(?:\\x07|${ESC}\\\\)`,
  "g",
);
const TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[=>]`,
  "g",
);
const PRIVATE_MODE_PATTERN = new RegExp(`^${ESC}\\[\\?([0-9;:]*)([hl])$`);
const TRAILING_RESTORE_CONTROL_PREFIX_PATTERN = new RegExp(`^${ESC}\\[\\?[0-9;:]*$`);
// Incomplete CSI (params/intermediates, no final byte) — e.g. ESC[0 or ESC[31
const TRAILING_CSI_CONTROL_PREFIX_PATTERN = new RegExp(`^${ESC}\\[[0-?]*[ -/]*$`);
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

const PASSWORD_KEYWORD_TARGETS = [
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

const PASSWORD_PREFIX_TARGETS = [
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

function defaultMeasureLength(value) {
  return String(value || "").length;
}

function resolveMeasureLength(options) {
  return typeof options?.measureLength === "function"
    ? options.measureLength
    : defaultMeasureLength;
}

function stripAnsi(value) {
  const raw = String(value || "");
  return raw
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(ANSI_SEQUENCE_PATTERN, "");
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
  // Hold any incomplete CSI (ESC[ / ESC[0 / ESC[31 / ESC[?1049), not only
  // private-mode restore prefixes — styled password prompts can split mid-SGR.
  if (TRAILING_CSI_CONTROL_PREFIX_PATTERN.test(suffix)) return suffix;
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
  const measureLength = resolveMeasureLength(options);
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
    droppedBytes: Math.max(0, measureLength(rawText) - measureLength(preserved) - measureLength(pending)),
  };
}

function isCompletePasswordPrompt(candidate) {
  const trimmed = String(candidate || "").trimEnd();
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
}

function hasTrailingPasswordKeywordPrefix(trimmed) {
  const lower = String(trimmed || "").toLowerCase();

  for (const target of PASSWORD_KEYWORD_TARGETS) {
    const maxLen = Math.min(lower.length, target.length);
    // ASCII keywords: require >= 3 chars ("pas"/"pass") so lone "p"/"pa" mid-line
    // noise is not held. CJK keywords can match a single character ("密").
    // Ignore punctuation/spaces (incl. full-width ：) so "password：" stays ASCII minLen.
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
      const prev = before[before.length - 1];
      if (!/[a-z0-9]/i.test(prev)) return true;
    }
  }
  return false;
}

function isProbablePasswordPromptPrefix(candidate) {
  // Strip SGR/OSC for matching so styled chunks like "\x1b[31mPass" still hold,
  // while callers keep the raw pending bytes for display.
  let trimmed = stripAnsi(String(candidate || "")).trimEnd();
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
  if (PASSWORD_PREFIX_TARGETS.some((target) => target.startsWith(lower))) return true;

  // Allow an unfinished "[sudo…]" tag, or "[sudo…] " + a password-word prefix.
  const sudoTag = trimmed.match(/^\[sudo[^\]]*\]?\s*/i);
  if (sudoTag) {
    const remainder = trimmed.slice(sudoTag[0].length);
    if (!remainder) {
      if (/^\[sudo(?:[^\]]*)\]?\s*$/i.test(trimmed)) return true;
    } else {
      const remLower = remainder.toLowerCase();
      if (PASSWORD_KEYWORD_TARGETS.some((target) => target.startsWith(remLower))) return true;
    }
  }

  // Prompts with leading text split mid-keyword, e.g. `alice@host's pass` +
  // `word:` or `用户 的密` + `码`. Hold when a trailing suffix is a real
  // password-keyword prefix at a word boundary.
  return hasTrailingPasswordKeywordPrefix(trimmed);
}

function finalizeAcceptedTextAfterPendingDisplayControl(pending, text, options = {}) {
  const rawPending = String(pending || "");
  const rawText = String(text || "");
  if (!rawPending) return { data: rawText, droppedBytes: 0 };
  const measureLength = resolveMeasureLength(options);
  const combined = `${rawPending}${rawText}`;
  TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
  const restoreMatch = TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.exec(combined);
  TERMINAL_STATE_RESTORE_SEQUENCE_PATTERN.lastIndex = 0;
  if (restoreMatch?.index === 0 && restoreMatch[0].length > rawPending.length) {
    const raw = restoreMatch[0];
    const remainder = combined.slice(raw.length);
    if (shouldPreserveTerminalStateRestore(raw)) {
      return { data: `${raw}${remainder}`, droppedBytes: 0 };
    }
    return { data: remainder, droppedBytes: measureLength(raw) };
  }
  OSC_SEQUENCE_PATTERN.lastIndex = 0;
  const oscMatch = OSC_SEQUENCE_PATTERN.exec(combined);
  OSC_SEQUENCE_PATTERN.lastIndex = 0;
  if (oscMatch?.index === 0 && oscMatch[0].length > rawPending.length) {
    return { data: combined, droppedBytes: 0 };
  }
  // Held password-prompt prefixes (plain or SGR-styled). Keep them when
  // quiet/max-drain resumes so a split "Pass"+"word: " is not lost.
  if (isProbablePasswordPromptPrefix(rawPending)) {
    return { data: combined, droppedBytes: 0 };
  }
  return { data: rawText, droppedBytes: measureLength(rawPending) };
}

function getTrailingPasswordPromptPrefix(text) {
  const raw = String(text || "");
  const lastBreak = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r"));
  const trailing = raw.slice(lastBreak + 1);
  if (!trailing) return "";
  return isProbablePasswordPromptPrefix(trailing) ? trailing : "";
}

/**
 * Restore sequences already counted in `preserved` can also sit at the start of
 * the trailing password-prefix line (e.g. "stale\n\x1b[?1049lPass", or multiple
 * restores "\x1b[?25hstale\n\x1b[?1049lPass"). Strip only complete leading
 * restore sequences that are a real suffix of `preserved` — never peel chars
 * like the final "l" of "\x1b[?1049l" off "login pass".
 */
function stripLeadingPreservedOverlap(passwordPending, preserved) {
  let pending = String(passwordPending || "");
  let keep = String(preserved || "");
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
}

/**
 * When discarding a held prefix that ends mid-CSI, also drop the CSI final
 * byte(s) from the next chunk so "Pass\x1b[0" + "m$ " does not leak as "m$ ".
 */
function consumeTrailingCsiCompletion(pending, text) {
  const control = getTrailingDisplayControlPrefix(pending);
  const raw = String(text || "");
  if (!control || !control.startsWith(`${ESC}[`)) {
    return { text: raw, extraDroppedBytes: 0 };
  }
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    // CSI parameter bytes 0–? and intermediate bytes SP–/
    if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
      i += 1;
      continue;
    }
    // CSI final byte @–~
    if (code >= 0x40 && code <= 0x7e) {
      return { text: raw.slice(i + 1), extraDroppedBytes: i + 1 };
    }
    break;
  }
  return { text: raw, extraDroppedBytes: 0 };
}

function isStandaloneHoldableControlPrefix(pending) {
  const raw = String(pending || "");
  if (!raw) return false;
  if (raw === ESC || raw === `${ESC}[`) return true;
  // Incomplete private-mode restore CSI and OSC title prefixes are safe to hold
  // alone; incomplete SGR CSI (ESC[31) is not — it can leak into "$ ".
  if (raw.startsWith(`${ESC}[?`) && TRAILING_RESTORE_CONTROL_PREFIX_PATTERN.test(raw)) {
    return true;
  }
  if (raw.startsWith(`${ESC}]`)) return true;
  return false;
}

function extractDrainHold(text, options = {}) {
  const rawText = String(text || "");
  const measureLength = resolveMeasureLength(options);
  const restoreControls = extractTerminalStateRestoreControls(rawText, options);
  if (!options.holdTrailingPartial) {
    return restoreControls;
  }

  // A styled prompt can split mid-CSI, e.g. "\x1b[31mPass\x1b[" + "0mword: ".
  // Keep both the password-prefix body and the trailing control prefix so the
  // next chunk can still complete "Password:" (#2010 Codex follow-up).
  const controlPending = restoreControls.pending;
  const textWithoutControl = controlPending
    ? rawText.slice(0, -controlPending.length)
    : rawText;
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
          measureLength(rawText) - measureLength(restoreControls.preserved),
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
      measureLength(rawText) - measureLength(restoreControls.preserved) - measureLength(pending),
    ),
  };
}

function isPasswordPrefixPending(pending) {
  return Boolean(pending) && isProbablePasswordPromptPrefix(pending);
}

function getLastVisibleLine(text) {
  const normalized = stripAnsi(String(text || "")).replace(/\r/g, "\n");
  const lastLineStart = normalized.lastIndexOf("\n") + 1;
  return normalized.slice(lastLineStart).trimEnd();
}

/**
 * A held "Pass" / "[sudo] pass" must only survive when the next chunk continues
 * or completes a password prompt. Otherwise discard it before the generic
 * shell-prompt matcher can accept junk like "Pass$ " (#2010 Codex follow-up).
 */
function resolveHeldPasswordPrefix(pending, text, options = {}) {
  const rawPending = String(pending || "");
  const rawText = String(text || "");
  if (!isPasswordPrefixPending(rawPending)) {
    return { pending: rawPending, text: rawText, droppedPendingBytes: 0 };
  }
  const measureLength = resolveMeasureLength(options);

  // Held prefixes must continue on the same line. A leading line break means
  // the next chunk is a fresh line (e.g. "Pass" then "\nPassword: "), not a
  // completion of the held prefix — discard so quiet-gap still applies.
  if (/^[\r\n]/.test(rawText)) {
    return {
      pending: "",
      text: rawText,
      droppedPendingBytes: measureLength(rawPending),
    };
  }

  const combined = `${rawPending}${rawText}`;
  const lastLine = getLastVisibleLine(combined);
  if (isCompletePasswordPrompt(lastLine) || isProbablePasswordPromptPrefix(lastLine)) {
    return { pending: "", text: combined, droppedPendingBytes: 0 };
  }

  const consumed = consumeTrailingCsiCompletion(rawPending, rawText);
  return {
    pending: "",
    text: consumed.text,
    droppedPendingBytes: measureLength(rawPending) + consumed.extraDroppedBytes,
  };
}

function getPromptCandidateSuffix(text) {
  const raw = String(text || "");
  const normalized = stripAnsi(raw).replace(/\r/g, "\n");
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

  const rawLastBreak = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r"));
  return raw.slice(rawLastBreak + 1);
}

module.exports = {
  stripAnsi,
  getTrailingDisplayControlPrefix,
  extractTerminalStateRestoreControls,
  finalizeAcceptedTextAfterPendingDisplayControl,
  isCompletePasswordPrompt,
  isProbablePasswordPromptPrefix,
  hasTrailingPasswordKeywordPrefix,
  getTrailingPasswordPromptPrefix,
  stripLeadingPreservedOverlap,
  consumeTrailingCsiCompletion,
  isStandaloneHoldableControlPrefix,
  extractDrainHold,
  isPasswordPrefixPending,
  getLastVisibleLine,
  resolveHeldPasswordPrefix,
  getPromptCandidateSuffix,
};
