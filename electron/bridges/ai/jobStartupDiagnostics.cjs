/**
 * Job startup diagnostics for background AI jobs (issue #3443).
 *
 * Emits a read-only `[Netcatty JobDiag]` timeline keyed by sessionId + jobId
 * covering the startup pipeline checkpoints: probe write/reply, command write,
 * start marker, startup timeout, interrupt delivery, and the MCP-server
 * background-job routing map lifecycle.
 *
 * Read-only by design: every emitter is gated behind an environment flag and
 * instrumentation calls never alter control flow, timeouts, or error paths.
 * Flow-control state (checkpoint 1) remains covered by the existing
 * [Netcatty Ctrl+C] / [Netcatty Terminal Perf] emitters; the session snapshots
 * attached here reuse the same helpers so both timelines can be correlated.
 */
"use strict";

const DEBUG_ENV_KEYS = [
  "NETCATTY_JOB_DIAG",
  "NETCATTY_TERMINAL_DEBUG",
];

function isJobDiagEnabled() {
  return DEBUG_ENV_KEYS.some((key) => process.env[key] === "1");
}

function safeJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return nested.toString();
    if (typeof nested === "function") return "[function]";
    return nested;
  });
}

function writeJobDiag(payload) {
  const line = `[Netcatty JobDiag] ${safeJson(payload)}`;
  // Utility-process stdout is not reliably captured by the app's launch log.
  // Use the existing worker message channel and log once in the main process.
  if (process.parentPort) {
    process.parentPort.postMessage({ kind: "job-diagnostic", line });
  } else {
    console.info(line);
  }
}

/**
 * Emit a one-off job diagnostics event from a caller that already knows the
 * session/job identity (e.g. the MCP bridge routing map lifecycle).
 */
function emitJobDiag(event, payload = {}) {
  if (!isJobDiagEnabled()) return;
  const {
    sessionId = null,
    jobId = null,
    chatSessionId = null,
    ...details
  } = payload;
  try {
    writeJobDiag({
      event,
      sessionId,
      jobId,
      chatSessionId,
      at: Date.now(),
      ...details,
    });
  } catch {
    // Diagnostics must never affect routing or control flow.
  }
}

/**
 * Create a per-job diagnostics context for startPtyJob. The returned emitter
 * stamps every payload with sessionId/jobId/chatSessionId, a monotonic wall
 * timestamp, and sinceStartMs relative to job acceptance, plus a shared stats
 * object the caller updates so timeout events can report what was seen.
 */
function createJobStartupDiag(context = {}) {
  const startedAt = Date.now();
  const stats = {
    probeOutputSeen: false,
    probeBytes: 0,
    outputChunks: 0,
    outputChars: 0,
  };
  function emit(event, details = {}) {
    if (!isJobDiagEnabled()) return;
    const now = Date.now();
    try {
      writeJobDiag({
        event,
        sessionId: context.sessionId ?? null,
        jobId: context.jobId ?? null,
        chatSessionId: context.chatSessionId ?? null,
        at: now,
        sinceStartMs: now - startedAt,
        ...details,
      });
    } catch {
      // Diagnostics must never affect job control flow.
    }
  }
  return { startedAt, stats, emit };
}

module.exports = {
  createJobStartupDiag,
  emitJobDiag,
  isJobDiagEnabled,
};
