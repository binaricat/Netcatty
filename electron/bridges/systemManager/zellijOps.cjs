/* eslint-disable no-undef */

const { stripAnsi, MUX_ENV_PREAMBLE, buildMuxBinaryProbe, parseMuxBinaryPath } = require("./tmuxEnv.cjs");
const { execScopedOnSession, shQuote } = require("./muxScope.cjs");

const ZELLIJ_DIAGNOSTIC_LINE = /^(error|usage:|unknown command|no such session|.*command not found)/i;

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
  /** @type {Map<string, { binary: string, resolvedAt: number }>} */
  const binaryCache = new Map();
  const BINARY_TTL_MS = 60_000;

  /**
   * Resolve the zellij binary by absolute path (see buildMuxBinaryProbe):
   * GUI apps and non-login SSH shells often cannot see cargo/Homebrew
   * installs through their bare PATH. Falls back to the bare "zellij" name.
   */
  async function resolveBinary(event, sessionId, scope = null) {
    const cacheKey = scope?.user ? `${sessionId}::${scope.user}` : sessionId;
    const cached = binaryCache.get(cacheKey);
    if (cached && Date.now() - cached.resolvedAt < BINARY_TTL_MS) {
      return cached.binary;
    }
    const probe = `${MUX_ENV_PREAMBLE}; ${buildMuxBinaryProbe("zellij")}`;
    let result;
    if (scope?.user) {
      result = await execScopedOnSession(execOnSession, event, sessionId, probe, 8000, scope);
    } else {
      const attempts = [
        `exec sh -c ${shQuote(probe)}`,
        `bash -lc ${shQuote(probe)}`,
        probe,
      ];
      for (const cmd of attempts) {
        result = await execOnSession(event, sessionId, cmd, 8000);
        if (result?.success && String(result?.stdout || "").trim()) break;
      }
    }
    const binary = (!result?.errorCode && parseMuxBinaryPath(result?.stdout)) || "zellij";
    binaryCache.set(cacheKey, { binary, resolvedAt: Date.now() });
    return binary;
  }

  async function execZellij(event, sessionId, args, timeoutMs = 8000, options = {}) {
    const { scope = null, retryOnEmptyOutput = true } = options;
    // Invoke the resolved absolute path; the locale preamble keeps tmux-style
    // sanitization of control characters away from zellij output too.
    const binary = await resolveBinary(event, sessionId, scope);
    const command = args.startsWith("zellij ") ? `${binary} ${args.slice("zellij ".length)}` : args;
    const script = `${MUX_ENV_PREAMBLE}; ${command}`;
    const runScoped = () => execScopedOnSession(execOnSession, event, sessionId, script, timeoutMs, scope);

    if (scope?.user) {
      const scoped = await runScoped();
      if (scoped?.errorCode) return scoped;
      return scoped;
    }

    // shQuote (single-quote escaping), not JSON.stringify (double quotes):
    // the script contains `$` and `"`, which a double-quoted wrapper would
    // expand or terminate prematurely.
    const attempts = [
      `exec sh -c ${shQuote(script)}`,
      `bash -lc ${shQuote(script)}`,
      script,
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
