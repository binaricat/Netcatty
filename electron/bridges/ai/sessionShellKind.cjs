/**
 * Resolve and cache the interactive shell kind used by AI PTY exec wrappers.
 *
 * Local terminals set shellKind from the executable path at spawn time. SSH /
 * Telnet (and similar remote) sessions historically left shellKind unset, so
 * resolveEffectiveShellKind fell through to "posix" and typed a bash-style
 * wrapper into fish login shells (issue #1854).
 *
 * Before AI exec we probe the remote login shell once via a separate SSH exec
 * channel (silent — does not touch the interactive PTY), classify it, and
 * cache session.shellKind for subsequent commands.
 */
"use strict";

const { classifyLocalShellType } = require("../../../lib/localShell.cjs");

// Kinds that buildWrappedCommand / resolveEffectiveShellKind already trust.
// "unknown" is intentionally excluded: local unknown shells are unsupported
// for AI exec, and we do not invent a remote kind without a successful probe.
const CONFIRMED_SHELL_KINDS = new Set([
  "posix",
  "fish",
  "powershell",
  "cmd",
  "raw",
]);

const DEFAULT_PROBE_TIMEOUT_MS = 3000;

function isConfirmedShellKind(shellKind) {
  return CONFIRMED_SHELL_KINDS.has(shellKind);
}

function quoteShellArg(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

/**
 * Map a remote shell path / basename to a wrapper kind.
 * Returns null when we cannot classify (leave session.shellKind unset).
 * Empty / missing paths return null (classifyLocalShellType would default to
 * platform shell — that is wrong for a failed remote probe).
 */
function classifyShellKindFromRemotePath(shellPath) {
  const trimmed = String(shellPath || "").trim();
  if (!trimmed) return null;
  const kind = classifyLocalShellType(trimmed, "linux");
  if (!kind || kind === "unknown") return null;
  return kind;
}

/**
 * Silent remote probe: force POSIX sh so fish/zsh login shells can still run it
 * when sshd invokes the command through the user's login shell (`$SHELL -c`).
 * Prints a single line: absolute login-shell path (or empty).
 */
function buildRemoteLoginShellProbeCommand() {
  const script = [
    'SH="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"',
    '[ -n "$SH" ] || SH="${SHELL:-}"',
    'printf "%s\\n" "$SH"',
  ].join("; ");
  return `exec sh -c ${quoteShellArg(script)}`;
}

function parseRemoteLoginShellProbeOutput(stdout) {
  const firstLine = String(stdout || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  return classifyShellKindFromRemotePath(firstLine);
}

/**
 * Build an execProbe(command, timeoutMs) => Promise<string|null> from an
 * ssh2-like connection (conn.exec(command, cb)).
 */
function createSshConnExecProbe(conn) {
  if (!conn || typeof conn.exec !== "function") return null;
  return function execProbe(command, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      let settled = false;
      let activeStream = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          activeStream?.close?.();
        } catch {
          // ignore
        }
        settle(null);
      }, timeoutMs);

      try {
        conn.exec(command, (err, stream) => {
          if (err || !stream) {
            settle(null);
            return;
          }
          activeStream = stream;
          let stdout = "";
          stream.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
          });
          if (stream.stderr && typeof stream.stderr.on === "function") {
            stream.stderr.on("data", () => {
              // swallow — probe only needs stdout
            });
          }
          stream.on("close", () => {
            settle(stdout);
          });
          stream.on("error", () => {
            settle(null);
          });
        });
      } catch {
        settle(null);
      }
    });
  };
}

/**
 * Prefer the live SSH connection, then any companion stats connection
 * (mosh/et) that still speaks ssh2 exec.
 */
function createSessionExecProbe(session) {
  if (!session || typeof session !== "object") return null;
  return (
    createSshConnExecProbe(session.conn)
    || createSshConnExecProbe(session.sshClient)
    || createSshConnExecProbe(session.moshStatsConn)
    || createSshConnExecProbe(session.etStatsConn)
    || null
  );
}

/**
 * Ensure session.shellKind is set when we can detect it. Safe to call on every
 * AI exec — confirmed kinds short-circuit; concurrent callers share one probe.
 *
 * @param {object} session
 * @param {{ execProbe?: (command: string, timeoutMs?: number) => Promise<string|null>, timeoutMs?: number }} [options]
 * @returns {Promise<string|undefined>}
 */
async function ensureSessionShellKind(session, options = {}) {
  if (!session || typeof session !== "object") return undefined;

  if (isConfirmedShellKind(session.shellKind)) {
    return session.shellKind;
  }

  // Local shells with an unrecognised executable stay "unknown"; do not probe.
  if (
    (session.protocol === "local" || session.type === "local")
    && session.shellKind === "unknown"
  ) {
    return session.shellKind;
  }

  if (session._shellKindProbePromise) {
    return session._shellKindProbePromise;
  }

  const execProbe =
    typeof options.execProbe === "function"
      ? options.execProbe
      : createSessionExecProbe(session);

  if (typeof execProbe !== "function") {
    return session.shellKind;
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;

  session._shellKindProbePromise = (async () => {
    try {
      const stdout = await execProbe(
        buildRemoteLoginShellProbeCommand(),
        timeoutMs,
      );
      const kind = parseRemoteLoginShellProbeOutput(stdout);
      if (kind) {
        session.shellKind = kind;
      }
      return session.shellKind;
    } catch {
      return session.shellKind;
    } finally {
      // Allow a later retry only when we still have no confirmed kind.
      if (!isConfirmedShellKind(session.shellKind)) {
        session._shellKindProbePromise = null;
      }
    }
  })();

  return session._shellKindProbePromise;
}

module.exports = {
  CONFIRMED_SHELL_KINDS,
  DEFAULT_PROBE_TIMEOUT_MS,
  isConfirmedShellKind,
  classifyShellKindFromRemotePath,
  buildRemoteLoginShellProbeCommand,
  parseRemoteLoginShellProbeOutput,
  createSshConnExecProbe,
  createSessionExecProbe,
  ensureSessionShellKind,
};
