/* eslint-disable no-undef */

const { stripAnsi } = require("./tmuxEnv.cjs");
const { execScopedOnSession, shQuote } = require("./muxScope.cjs");

const ZELLIJ_DIAGNOSTIC_LINE = /^(error|usage:|unknown command|no such session)/i;

const NO_SESSIONS_RE = /no active zellij sessions found/i;

function isZellijDiagnosticLine(line) {
  return ZELLIJ_DIAGNOSTIC_LINE.test(String(line || "").trim());
}

/**
 * Parse `zellij list-sessions` output, e.g.:
 *   work [Created 2h 3m ago]
 *   main [Created 5m ago] (current)
 *   old  [Created 1d ago] (EXITED - attach to resurrect)
 * Falls back to `--short` output (bare session names).
 */
function parseZellijSessions(stdout) {
  const sessions = [];
  for (const rawLine of stripAnsi(stdout).split("\n")) {
    const line = rawLine.trim();
    if (!line || isZellijDiagnosticLine(line) || NO_SESSIONS_RE.test(line)) continue;
    const match = line.match(/^(.+?)(?:\s+\[([^\]]+)\])?(?:\s+\(([^)]+)\))?\s*$/);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;
    const marker = String(match[3] || "").toLowerCase();
    sessions.push({
      name,
      createdText: (match[2] || "").trim(),
      attached: marker === "current",
      exited: marker.startsWith("exited"),
      isCurrent: marker === "current",
    });
  }
  return sessions;
}

function createZellijOpsApi({ execOnSession }) {
  async function execZellij(event, sessionId, args, timeoutMs = 8000, options = {}) {
    const { scope = null, retryOnEmptyOutput = true } = options;
    const runScoped = () => execScopedOnSession(execOnSession, event, sessionId, args, timeoutMs, scope);

    if (scope?.user) {
      const scoped = await runScoped();
      if (scoped?.errorCode) return scoped;
      return scoped;
    }

    const attempts = [
      `exec sh -c ${JSON.stringify(args)}`,
      `bash -lc ${JSON.stringify(args)}`,
      args,
    ];
    let last = { success: false, error: "No exec result", stdout: "", stderr: "" };
    for (const cmd of attempts) {
      last = await execOnSession(event, sessionId, cmd, timeoutMs);
      if (last?.success && (!retryOnEmptyOutput || String(last.stdout || last.stderr || "").trim())) {
        return last;
      }
    }
    return last;
  }

  async function listSessions(event, sessionId, scope = null) {
    const commands = [
      "zellij list-sessions 2>&1",
      "zellij ls 2>&1",
      "zellij list-sessions --short 2>&1",
    ];
    let lastError = "Cannot list zellij sessions";

    for (const cmd of commands) {
      const result = await execZellij(event, sessionId, cmd, 8000, { scope });
      if (result?.errorCode) {
        return {
          success: false,
          error: result.error || "sudo authentication failed",
          errorCode: result.errorCode,
        };
      }
      const output = stripAnsi(String(result?.stdout || result?.stderr || "")).trim();
      if (!result?.success && !output) {
        lastError = (result?.error || lastError).slice(0, 240);
        continue;
      }
      if (NO_SESSIONS_RE.test(output)) {
        return { success: true, sessions: [] };
      }
      const sessions = parseZellijSessions(output);
      if (sessions.length > 0) {
        return { success: true, sessions };
      }
      if (output) lastError = output.slice(0, 240);
    }

    return { success: false, error: lastError };
  }

  async function zellijAction(event, payload) {
    const { sessionId, action, sessionName, force, scope } = payload || {};
    if (!sessionId || !action) return { success: false, error: "Missing sessionId or action" };
    const name = String(sessionName || "").trim();
    if (!name) return { success: false, error: "Missing sessionName" };

    let args;
    switch (action) {
      case "killSession":
        args = `zellij kill-session ${shQuote(name)}`;
        break;
      case "deleteSession":
        args = `zellij delete-session ${force ? "--force " : ""}${shQuote(name)}`;
        break;
      default:
        return { success: false, error: `Unknown zellij action: ${action}` };
    }

    const result = await execZellij(event, sessionId, args, 8000, {
      scope,
      retryOnEmptyOutput: false,
    });
    if (result?.errorCode) {
      return { success: false, error: result.error || "sudo authentication failed", errorCode: result.errorCode };
    }
    if (!result?.success) {
      return { success: false, error: result?.error || "zellij command failed" };
    }
    if (typeof result.code === "number" && result.code !== 0) {
      return {
        success: false,
        error: (result.stderr || result.stdout || `zellij exited with code ${result.code}`).trim(),
      };
    }
    return { success: true };
  }

  return { listSessions, zellijAction };
}

module.exports = {
  createZellijOpsApi,
  parseZellijSessions,
  isZellijDiagnosticLine,
  NO_SESSIONS_RE,
};
