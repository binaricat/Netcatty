"use strict";

/**
 * First-class shell readiness classification for the pre-input gate in
 * startPtyJob. This composes #4110's OSC 133 marker authority and #4195's
 * asymmetric-harm thesis: a whitelist miss on a live shell must be an
 * actionable `unknown`, never a terminal SHELL_NOT_READY — but anything
 * PROVEN busy (or a credential prompt waiting for the user's secret) must
 * stay a hard block. It mirrors #3935's honesty rule: `unknown` is NOT a lie
 * of success and is never claimed as ready.
 *
 * This module only READS session state. It never writes to a PTY, never
 * injects OSC markers, and never widens tool scope. It lives outside
 * shellUtils.cjs (the prompt whitelist) on purpose so the gating consumer
 * evolves independently of positive-signal additions such as #4197.
 */
const { stripAnsi } = require("./shellUtils.cjs");

/** Distinct, non-terminal code emitted when the gate cannot prove busy. */
const READINESS_UNKNOWN = "SHELL_READINESS_UNKNOWN";

/**
 * Honest, actionable result text. Surfaced verbatim as the exec result
 * `error` and as the MCP/Catty tool-result text. It must never claim ready.
 * (a) connection alive + no busy signal, (b) prompt unrecognized,
 * (c) command NOT sent / no blind typing, (d) the viable read-only path.
 */
const SHELL_READINESS_UNKNOWN_MESSAGE = [
  "Shell readiness unknown (SHELL_READINESS_UNKNOWN): the terminal connection is",
  "alive and no busy, pending-input, or credential-prompt signal was observed, but",
  "the prompt could not be recognized (custom theme, colored/starship/root prompt,",
  "or continuation). The command was NOT sent — never blind-type into a possible",
  "password prompt, editor, or half-typed command. This is a recoverable,",
  "non-terminal state, not a failed command. Read-only next steps: call",
  "get_environment or terminal_read_context to inspect the visible buffer, re-check",
  "readiness after the user presses Enter or a recognized prompt appears, reuse",
  "another idle session, or ask the user to confirm the prompt before retrying.",
  "Retrying once the prompt is recognized is safe.",
].join(" ");

// Known credential/passphrase prompts. #4195: `Password:` (and friends) are
// PROVEN "waiting for secret input" states and MUST remain hard not-ready.
// This is a conservative block-list (hardening only): a miss falls through to
// `unknown`, which still never types.
const BLOCKING_INPUT_PATTERNS = [
  /^(?:\[sudo\]\s*|enter\s+|please\s+enter\s+)?(?:password|passphrase|pin)(?:\s+for\s+[^:]+)?\s*:?\s*$/i,
  /^sorry,\s*try\s+again\.?\s*$/i,
];

function lastVisibleLine(session) {
  const tail = typeof session?._promptTrackTail === "string" ? session._promptTrackTail : "";
  if (!tail) return "";
  const lines = stripAnsi(tail).split(/[\r\n]/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/**
 * Classify a session whose getReadyPrompt() just returned empty (i.e. no
 * whitelist match and no OSC 133 A-with-empty-input ready signal).
 *
 * Returns:
 *   "busy"    — PROVEN busy → keep the hard SHELL_NOT_READY block unchanged.
 *   "unknown" — connection alive, no proven-busy evidence, prompt not
 *               recognized → actionable, non-terminal outcome.
 *
 * Anything ambiguous (missing session, thrown helper, unknown context) fails
 * CLOSED to "busy", so #4110's false-ready guards are never weakened.
 */
function classifyShellReadiness(session, context = {}) {
  if (!session) return "busy";
  const { taskInFlight = false, transportAlive = true } = context || {};
  // Our own tracked task in flight / a dead transport are proven busy and are
  // also hard-blocked at the exec call sites (reserveSessionExecution,
  // writability check) and by the PTY close/error handlers.
  if (taskInFlight || !transportAlive) return "busy";
  // #4110: an OSC 133 C/D marker establishes a running command/output
  // lifecycle. shellUtils.cjs:321 sets osc133Ready=false; getFreshIdlePrompt
  // (:377) and getVisibleIdlePrompt (:406) both return "" for that state.
  if (session.osc133Ready === false) return "busy";
  // #4110 pending-input guards (shellUtils.cjs:265-275): redraw latch,
  // continuation/PS2, and B-marker cursor deviation. An empty prompt while
  // osc133Ready===true with a B-marked line means matchesOsc133EmptyPrompt
  // rejected it → the user typed into the prompt line.
  if (session._osc133PromptRedrawPending) return "busy";
  if (session._osc133PromptContinued) return "busy";
  if (session.osc133Ready === true && session._osc133PromptLine != null) return "busy";
  // Explicit busy / waiting-for-input session state (#3935 recovery model:
  // sessionRecoveryService.cjs:55-56, 101-102).
  if (session.waitingForInput === true || session.busy === true) return "busy";
  if (session.status === "disconnected" || session.status === "stopped") return "busy";
  // Credential prompt waiting for the user's secret (#4195).
  const line = lastVisibleLine(session);
  if (line && BLOCKING_INPUT_PATTERNS.some((pattern) => pattern.test(line))) return "busy";
  // Connection alive, no proven-busy evidence, prompt not recognized.
  return "unknown";
}

module.exports = {
  READINESS_UNKNOWN,
  SHELL_READINESS_UNKNOWN_MESSAGE,
  classifyShellReadiness,
};
