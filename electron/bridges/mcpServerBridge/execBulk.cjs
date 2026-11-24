"use strict";

/**
 * terminal_execute_bulk: run one command on 2-20 terminal sessions.
 *
 * Contract (see docs/features/terminal-execute-bulk.md):
 *  - all-or-nothing preflight: if any target cannot run the command, nothing is
 *    sent to any host;
 *  - one approval for the whole fan-out (never satisfied by remembered grants
 *    or session-wide approval);
 *  - every target starts in the same synchronous turn, each with its own
 *    wall-clock timeout (the user's command timeout);
 *  - identical results are grouped to save tokens.
 */

const MIN_BULK_TARGETS = 2;
const MAX_BULK_TARGETS = 20;
const DEFAULT_TAIL_LINES = 100;
const MAX_TAIL_LINES = 2000;
const MAX_DISTINCT_OUTPUT_CHARS = 32 * 1024;
const MAX_RESPONSE_CHARS = 256 * 1024;
const MIN_GROUP_OUTPUT_CHARS = 2 * 1024;
const DEADLINE_GRACE_MS = 10 * 1000;
const BULK_RPC_METHOD = "netcatty/execBulk";

/**
 * Private marker placed on the inner execution context while the bulk call
 * already holds the per-chat exec lock. A Symbol cannot come from RPC params.
 */
const CHAT_LOCK_HELD = Symbol("netcatty.execBulk.chatLockHeld");

function labelPart(sessionId, label) {
  return label ? `${sessionId} (${label})` : sessionId;
}

/**
 * @param {{ command?: unknown, sessionIds?: unknown, tailLines?: unknown }} params
 * @returns {{ ok: true, command: string, sessionIds: string[], tailLines: number } | { ok: false, error: string }}
 */
function parseBulkExecParams(params = {}) {
  const command = params?.command;
  if (typeof command !== "string" || !command.trim()) {
    return { ok: false, error: "Invalid command" };
  }

  const shapeError = `sessionIds must be a JSON array of ${MIN_BULK_TARGETS}-${MAX_BULK_TARGETS} session ID strings`;
  let rawIds = params?.sessionIds;
  if (typeof rawIds === "string") {
    try {
      rawIds = JSON.parse(rawIds);
    } catch {
      return { ok: false, error: shapeError };
    }
  }
  if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string" || !id.trim())) {
    return { ok: false, error: shapeError };
  }
  if (rawIds.length < MIN_BULK_TARGETS) {
    return { ok: false, error: `${shapeError}. Use terminal_execute to run a command on a single session` };
  }
  if (rawIds.length > MAX_BULK_TARGETS) {
    return { ok: false, error: shapeError };
  }
  const sessionIds = rawIds.map((id) => id.trim());
  const duplicates = [...new Set(sessionIds.filter((id, index) => sessionIds.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    return { ok: false, error: `sessionIds must be unique. Duplicates: ${duplicates.join(", ")}` };
  }

  let tailLines = DEFAULT_TAIL_LINES;
  if (params?.tailLines !== undefined && params?.tailLines !== null) {
    const parsed = Number(params.tailLines);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { ok: false, error: "tailLines must be a non-negative number" };
    }
    if (parsed > 0) tailLines = Math.min(MAX_TAIL_LINES, Math.floor(parsed));
  }

  return { ok: true, command, sessionIds, tailLines };
}

/**
 * @param {Array<{ sessionId: string, label?: string, error: string }>} failures
 * @param {number} total
 */
function formatPreflightFailure(failures, total) {
  // The MCP layer prefixes "Error: "; keep the message itself prefix-free.
  const lines = failures.map((failure) => `- ${labelPart(failure.sessionId, failure.label)}: ${failure.error}`);
  return [
    `nothing was sent. ${failures.length} of ${total} targets cannot run this command:`,
    ...lines,
    "Remove or fix these session ids and retry.",
  ].join("\n");
}

const BLOCKED_PATTERN = /^Command blocked by safety policy/;
const TIMEOUT_PATTERN = /timed out/i;
const CANCELLED_PATTERN = /cancel/i;
const LOST_PATTERN = /connection lost|terminated unexpectedly|stream lost|connection closed/i;

/**
 * Normalize one exec result into the public per-host shape.
 * `status` records what happened; it never judges the exit code.
 */
function classifyHostResult(result) {
  if (!result || typeof result !== "object") {
    return { status: "error", exitCode: null, stdout: "", stderr: "", error: "Invalid execution result" };
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const error = typeof result.error === "string" ? result.error : "";
  const numericExit = typeof result.exitCode === "number" && Number.isFinite(result.exitCode)
    ? result.exitCode
    : null;

  // An exception inside the exec machinery: we cannot claim the command did or did not run.
  if (result.thrown === true) {
    return { status: "error", exitCode: null, stdout, stderr, error: error || "Execution failed" };
  }
  if (result.code === "SHELL_READINESS_UNKNOWN") {
    return { status: "not_sent", exitCode: null, stdout: "", stderr: "", error: error || "Shell readiness unknown; no command was sent." };
  }
  if (error) {
    let status = "error";
    // Refusals quote the matched blocklist pattern, which could contain any word.
    if (BLOCKED_PATTERN.test(error)) status = "not_sent";
    else if (TIMEOUT_PATTERN.test(error)) status = "timeout";
    else if (CANCELLED_PATTERN.test(error)) status = "cancelled";
    else if (LOST_PATTERN.test(error)) status = "connection_lost";
    // A failure with no output and no exit code means the command never ran
    // (blocked, busy, unsupported session, readiness refused, ...).
    else if (!stdout && !stderr && numericExit === null) status = "not_sent";
    return { status, exitCode: null, stdout, stderr, error };
  }
  return { status: "completed", exitCode: numericExit, stdout, stderr, error: "" };
}

/**
 * Keep the last `tailLines` lines, then the last `maxChars` characters.
 * @returns {{ text: string, omittedLines: number, truncated: boolean }}
 */
function tailText(text, tailLines, maxChars) {
  if (!text) return { text: "", omittedLines: 0, truncated: false };
  let kept = text;
  let omittedLines = 0;
  let truncated = false;
  const lines = kept.split("\n");
  // A trailing newline does not start another line.
  const countable = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (countable > tailLines) {
    omittedLines = countable - tailLines;
    truncated = true;
    kept = lines.slice(omittedLines).join("\n");
  }
  if (kept.length > maxChars) {
    truncated = true;
    const cut = kept.slice(kept.length - maxChars);
    const firstNewline = cut.indexOf("\n");
    // Prefer starting on a line boundary so no partial first line is shown.
    const trimmed = firstNewline >= 0 && firstNewline < cut.length - 1 ? cut.slice(firstNewline + 1) : cut;
    const dropped = kept.slice(0, kept.length - trimmed.length);
    omittedLines += (dropped.match(/\n/g) || []).length;
    kept = trimmed;
  }
  return { text: kept, omittedLines, truncated };
}

/**
 * Group identical per-host results (compared on the full raw output, before
 * truncation) and build the public payload.
 *
 * @param {Array<{ sessionId: string, label?: string, result: object }>} entries ordered like the request
 * @param {{ tailLines?: number }} [options]
 */
function groupBulkResults(entries, options = {}) {
  const tailLines = options.tailLines || DEFAULT_TAIL_LINES;
  const groupsByKey = new Map();
  const counts = {};

  for (const entry of entries) {
    const normalized = classifyHostResult(entry.result);
    counts[normalized.status] = (counts[normalized.status] || 0) + 1;
    const key = JSON.stringify([
      normalized.status, normalized.exitCode, normalized.stdout, normalized.stderr, normalized.error,
    ]);
    let group = groupsByKey.get(key);
    if (!group) {
      group = { normalized, hosts: [] };
      groupsByKey.set(key, group);
    }
    group.hosts.push({ sessionId: entry.sessionId, label: entry.label || "" });
  }

  const groupCount = groupsByKey.size;
  const perGroupChars = Math.min(
    MAX_DISTINCT_OUTPUT_CHARS,
    Math.max(MIN_GROUP_OUTPUT_CHARS, Math.floor(MAX_RESPONSE_CHARS / Math.max(1, groupCount))),
  );

  const groups = [];
  for (const { normalized, hosts } of groupsByKey.values()) {
    const out = tailText(normalized.stdout, tailLines, perGroupChars);
    const err = tailText(normalized.stderr, tailLines, perGroupChars);
    const omittedLines = out.omittedLines + err.omittedLines;
    const group = {
      hosts,
      status: normalized.status,
      exitCode: normalized.exitCode,
      stdout: out.text,
    };
    if (err.text) group.stderr = err.text;
    if (normalized.error) group.error = normalized.error;
    if (out.truncated || err.truncated) {
      group.outputTruncated = true;
      if (omittedLines > 0) group.omittedLines = omittedLines;
    }
    groups.push(group);
  }

  return {
    ok: true,
    hostCount: entries.length,
    counts,
    groups,
  };
}

/**
 * @param {object} deps injected by mcpServerBridge (keeps this module testable)
 */
function createExecBulkHandler(deps) {
  const {
    getSessions,
    getSessionMeta,
    validateSessionScope,
    closingTerminalSessions,
    getSessionBusyError,
    pendingSessionWriteApprovals,
    getActiveChatExecution,
    beginChatExecution,
    isChatSessionCancelled,
    preflightMainExec,
    preflightWorkerExec,
    execOnSession,
    requestApproval,
    sessionIdleManager,
    getCommandTimeoutMs,
    cancelExecsForChat,
    USER_DENIED_MESSAGE,
    CHAT_SESSION_CANCELLED_MESSAGE,
    debugLog = () => {},
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = deps;

  function resolveLabel(sessionId, chatSessionId) {
    const meta = getSessionMeta(sessionId, chatSessionId) || {};
    const session = getSessions()?.get?.(sessionId) || {};
    return meta.label || meta.hostname || session.label || session.hostname || "";
  }

  /** Cheap, side-effect-free checks, in the same order as a single exec. */
  function checkTargetSync(sessionId, ctx, { includePendingWrite }) {
    const scopeError = validateSessionScope(sessionId, ctx.chatSessionId, ctx.scopedSessionIds);
    // Never reveal a label (or existence) for an out-of-scope id.
    if (scopeError) return { sessionId, label: "", error: scopeError };
    const label = resolveLabel(sessionId, ctx.chatSessionId);
    const fail = (error) => ({ sessionId, label, error });
    if (closingTerminalSessions.has(sessionId)) return fail(`Session "${sessionId}" is closing.`);
    const busy = getSessionBusyError(sessionId);
    if (busy) return fail(busy.error);
    if (includePendingWrite && pendingSessionWriteApprovals.has(sessionId)) {
      return fail("Session already has another command request awaiting approval or startup. Wait for it to finish before starting a new command.");
    }
    const hasMainSession = Boolean(getSessions()?.get?.(sessionId));
    const meta = getSessionMeta(sessionId, ctx.chatSessionId);
    if (!hasMainSession && !meta) return fail("Session not found");
    // A live main-process session is connected by definition; its metadata snapshot
    // can be stale. Only worker-hosted sessions rely on the metadata flag.
    if (!hasMainSession && meta.connected === false) return fail(`Session "${sessionId}" is not connected.`);
    return null;
  }

  async function checkTargetTransport(sessionId, label, ctx) {
    const hasMainSession = Boolean(getSessions()?.get?.(sessionId));
    const probeParams = {
      sessionId,
      command: ctx.command,
      chatSessionId: ctx.chatSessionId,
      scopedSessionIds: ctx.scopedSessionIds,
    };
    let outcome;
    try {
      outcome = hasMainSession
        ? await preflightMainExec(probeParams)
        : preflightWorkerExec(probeParams);
    } catch (err) {
      outcome = { ok: false, error: err?.message || String(err) };
    }
    if (outcome && outcome.ok === false) {
      return { sessionId, label, error: outcome.error || "Session does not support command execution" };
    }
    return null;
  }

  async function preflightAll(ctx) {
    const failures = new Array(ctx.sessionIds.length).fill(null);
    const pending = [];
    ctx.sessionIds.forEach((sessionId, index) => {
      const syncFailure = checkTargetSync(sessionId, ctx, { includePendingWrite: true });
      if (syncFailure) {
        failures[index] = syncFailure;
        return;
      }
      pending.push(checkTargetTransport(sessionId, resolveLabel(sessionId, ctx.chatSessionId), ctx)
        .then((failure) => { failures[index] = failure; }));
    });
    await Promise.all(pending);
    return failures.filter(Boolean);
  }

  function preflightFailureResult(failures, total) {
    return {
      ok: false,
      code: "BULK_PREFLIGHT_FAILED",
      error: formatPreflightFailure(failures, total),
    };
  }

  /**
   * @param {object} params RPC params (command, sessionIds, tailLines, chatSessionId, scopedSessionIds)
   * @param {object} approvalContext transport context (externalSocket, beforeExecute)
   * @param {{ requiresApproval?: boolean }} permission result of the permission check
   */
  async function run(params, approvalContext = {}, permission = {}) {
    const parsed = parseBulkExecParams(params);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { command, sessionIds, tailLines } = parsed;
    const chatSessionId = params?.chatSessionId || null;
    const ctx = {
      command,
      sessionIds,
      chatSessionId,
      scopedSessionIds: params?.scopedSessionIds,
    };

    // Phase 1: preflight. Nothing is sent. Report every bad target at once.
    const active = getActiveChatExecution(chatSessionId);
    if (active) {
      return {
        ok: false,
        code: "COMMAND_ALREADY_RUNNING",
        error: `Another Netcatty command is already running for chat session "${chatSessionId}". Wait for it to finish before starting a new exec.`,
        activeCommand: active.command,
        activeSessionId: active.sessionId,
      };
    }
    const failures = await preflightAll(ctx);
    if (failures.length > 0) return preflightFailureResult(failures, sessionIds.length);

    // Claim every target synchronously so no other command can slip in while
    // the user decides. Another claim between preflight and here wins safely.
    const claimConflicts = sessionIds
      .filter((sessionId) => pendingSessionWriteApprovals.has(sessionId))
      .map((sessionId) => ({
        sessionId,
        label: resolveLabel(sessionId, chatSessionId),
        error: "Session already has another command request awaiting approval or startup. Wait for it to finish before starting a new command.",
      }));
    if (claimConflicts.length > 0) return preflightFailureResult(claimConflicts, sessionIds.length);
    for (const sessionId of sessionIds) pendingSessionWriteApprovals.set(sessionId, BULK_RPC_METHOD);
    // Keep the sessions from idle auto-close while waiting for approval and running.
    const activeSessionIds = sessionIds.filter((sessionId) => sessionIdleManager.beginActivity(chatSessionId, sessionId));

    let chatLock = null;
    try {
      // Phase 2: one approval listing every host. Never satisfied by grants or
      // session-wide approval.
      if (permission.requiresApproval) {
        const approved = await requestApproval(
          BULK_RPC_METHOD,
          {
            command,
            sessions: sessionIds.map((sessionId) => labelPart(sessionId, resolveLabel(sessionId, chatSessionId))),
          },
          chatSessionId,
          { ...approvalContext, requireFreshApproval: true },
        );
        if (!approved) return { ok: false, error: USER_DENIED_MESSAGE };
      }

      // Phase 3: commit. Everything from here to the start loop is synchronous.
      if (isChatSessionCancelled(chatSessionId)) {
        return { ok: false, error: CHAT_SESSION_CANCELLED_MESSAGE };
      }
      const recheck = sessionIds
        .map((sessionId) => checkTargetSync(sessionId, ctx, { includePendingWrite: false }))
        .filter(Boolean);
      if (recheck.length > 0) return preflightFailureResult(recheck, sessionIds.length);
      chatLock = beginChatExecution(chatSessionId, `bulk:${sessionIds.length}`, command);
      if (!chatLock.ok) {
        return {
          ok: false,
          code: "COMMAND_ALREADY_RUNNING",
          error: `Another Netcatty command is already running for chat session "${chatSessionId}". Wait for it to finish before starting a new exec.`,
          activeCommand: chatLock.active.command,
          activeSessionId: chatLock.active.sessionId,
        };
      }
      try {
        // Privacy policy may have changed while approval was pending.
        approvalContext.beforeExecute?.();
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }

      const labels = new Map(sessionIds.map((sessionId) => [sessionId, resolveLabel(sessionId, chatSessionId)]));
      const results = new Map();
      const runs = sessionIds.map((sessionId) => {
        let started;
        try {
          started = Promise.resolve(execOnSession(
            { sessionId, command, chatSessionId, scopedSessionIds: params?.scopedSessionIds },
            { beforeExecute: approvalContext.beforeExecute, [CHAT_LOCK_HELD]: true },
          ));
        } catch (err) {
          started = Promise.resolve({ ok: false, thrown: true, error: err?.message || String(err) });
        }
        return started
          .catch((err) => ({ ok: false, thrown: true, error: err?.message || String(err) }))
          .then((result) => { results.set(sessionId, result); });
      });

      // Phase 4: wait. Each host enforces its own wall-clock timeout; this
      // deadline is only a backstop so a stuck host cannot hang the call.
      const timeoutMs = getCommandTimeoutMs();
      let deadlineTimer = null;
      const deadline = new Promise((resolve) => {
        deadlineTimer = setTimeoutFn(() => resolve("deadline"), timeoutMs + DEADLINE_GRACE_MS);
      });
      const outcome = await Promise.race([Promise.all(runs).then(() => "done"), deadline]);
      clearTimeoutFn(deadlineTimer);
      if (outcome === "deadline") {
        debugLog("execBulk:deadline", { chatSessionId, settled: results.size, total: sessionIds.length });
        try { cancelExecsForChat(chatSessionId); } catch { /* best effort */ }
      }

      const timeoutSeconds = Math.round(timeoutMs / 1000);
      const entries = sessionIds.map((sessionId) => ({
        sessionId,
        label: labels.get(sessionId),
        result: results.has(sessionId)
          ? results.get(sessionId)
          : { ok: false, exitCode: -1, error: `Command timed out (${timeoutSeconds}s)` },
      }));

      const payload = groupBulkResults(entries, { tailLines });
      if (payload.groups.every((group) => group.status === "not_sent")) {
        const detail = payload.groups
          .flatMap((group) => group.hosts.map((host) => `- ${labelPart(host.sessionId, host.label)}: ${group.error || "not sent"}`))
          .join("\n");
        return { ok: false, code: "BULK_NOT_SENT", error: `No command was sent to any host.\n${detail}` };
      }
      return payload;
    } finally {
      chatLock?.release?.();
      for (const sessionId of activeSessionIds) sessionIdleManager.endActivity(chatSessionId, sessionId);
      for (const sessionId of sessionIds) {
        if (pendingSessionWriteApprovals.get(sessionId) === BULK_RPC_METHOD) {
          pendingSessionWriteApprovals.delete(sessionId);
        }
      }
    }
  }

  return { run };
}

module.exports = {
  BULK_RPC_METHOD,
  CHAT_LOCK_HELD,
  DEADLINE_GRACE_MS,
  DEFAULT_TAIL_LINES,
  MAX_BULK_TARGETS,
  MAX_TAIL_LINES,
  MIN_BULK_TARGETS,
  classifyHostResult,
  createExecBulkHandler,
  formatPreflightFailure,
  groupBulkResults,
  parseBulkExecParams,
  tailText,
};
