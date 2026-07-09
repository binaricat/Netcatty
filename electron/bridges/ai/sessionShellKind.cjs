/**
 * Resolve and cache the interactive shell kind used by AI PTY exec wrappers.
 *
 * Local terminals set shellKind from the executable path at spawn time. SSH /
 * Telnet (and similar remote) sessions historically left shellKind unset, so
 * resolveEffectiveShellKind fell through to "posix" and typed a bash-style
 * wrapper into fish login shells (issue #1854).
 *
 * Before AI exec we probe the remote login shell once via a separate SSH exec
 * channel (silent — does not touch the interactive PTY). Only Windows login
 * shells (powershell/cmd) are pinned on session.shellKind. Unix login shells
 * (fish/posix) are stored as session._loginShellKind (soft hint) so
 * resolveEffectiveShellKind can pick fish vs native posix wrappers without
 * permanently assuming login shell === active interactive shell, and without
 * routing bash sessions through /bin/sh (dash).
 */
"use strict";

const crypto = require("node:crypto");
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
const PROBE_OUTPUT_MARKER = "__NETCATTY_SHELL_KIND__:";

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
    `printf "${PROBE_OUTPUT_MARKER}%s\\n" "$SH"`,
  ].join("; ");
  return `exec sh -c ${quoteShellArg(script)}`;
}

function parseRemoteLoginShellProbeOutput(stdout) {
  const lines = String(stdout || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith(PROBE_OUTPUT_MARKER)) continue;
    const kind = classifyShellKindFromRemotePath(line.slice(PROBE_OUTPUT_MARKER.length));
    if (kind) return kind;
  }
  return null;
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
          if (settled) {
            try {
              stream.close?.();
            } catch {
              // ignore
            }
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
  if (typeof session._shellKindExecProbe === "function") {
    return (command, timeoutMs) => session._shellKindExecProbe(command, timeoutMs);
  }
  return (
    createSshConnExecProbe(session.conn)
    || createSshConnExecProbe(session.sshClient)
    || createSshConnExecProbe(session.moshStatsConn)
    || createSshConnExecProbe(session.etStatsConn)
    || null
  );
}

function withProbeTimeout(promise, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Apply a successful remote probe result onto the session.
 *
 * Login-shell probe is a soft hint, not a permanent active-shell pin:
 * - posix / fish: store on session._loginShellKind only. resolveEffectiveShellKind
 *   uses the hint for the wrapper (native posix for bash/zsh, fish for fish)
 *   while leaving session.shellKind unset so live PowerShell prompts can still
 *   override (issue #841 / #1854; Codex P2s on PR #2061).
 * - powershell / cmd: also pin session.shellKind (Windows remote shells).
 *
 * Always mark the probe settled so we do not re-probe every AI exec.
 */
function applyProbedShellKind(session, kind) {
  if (!kind) return session.shellKind;
  session._shellKindProbeSettled = true;
  session._loginShellKind = kind;
  if (kind === "powershell" || kind === "cmd") {
    session.shellKind = kind;
    return session.shellKind;
  }
  // fish / posix — soft hint only; do not pin session.shellKind.
  return session.shellKind;
}

function isShellKindProbeSettled(session) {
  return Boolean(session?._shellKindProbeSettled)
    || isConfirmedShellKind(session?.shellKind);
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

  // Probe already decided "generic posix login shell" (or pinned a kind).
  // Do not re-hit the network; leave shellKind unset for the posix case so
  // resolveEffectiveShellKind can still honor a live PowerShell prompt.
  if (session._shellKindProbeSettled) {
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
      const stdout = await withProbeTimeout(
        execProbe(
          buildRemoteLoginShellProbeCommand(),
          timeoutMs,
        ),
        timeoutMs,
      );
      const kind = parseRemoteLoginShellProbeOutput(stdout);
      return applyProbedShellKind(session, kind);
    } catch {
      return session.shellKind;
    } finally {
      // Retry only when the probe failed to classify anything.
      if (!isShellKindProbeSettled(session)) {
        session._shellKindProbePromise = null;
      }
    }
  })();

  return session._shellKindProbePromise;
}

/**
 * Probe shell kind while remaining cancellable via activePtyExecs.
 *
 * The first AI exec on a remote session may await ensureSessionShellKind for up
 * to the probe timeout before execViaPty registers a real marker. Stop during
 * that window would otherwise find nothing in activePtyExecs and the command
 * would still be typed after the probe resolves (Codex P2 on PR #2061).
 *
 * Mirrors the pending-marker pattern used by execViaChannel: register a
 * cancel latch synchronously, await the probe, then short-circuit if Stop
 * fired before we write to the PTY.
 *
 * @returns {Promise<{ ok: true, shellKind: string|undefined } | { ok: false, cancelled: true, error: string, exitCode: number, stdout: string, stderr: string }>}
 */
async function ensureSessionShellKindForExec(session, options = {}) {
  const {
    trackForCancellation = null,
    chatSessionId = null,
    execProbe,
    timeoutMs,
  } = options;

  let cancelled = false;
  const pendingMarker = trackForCancellation
    ? `__NCMCP_SK_PENDING_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}__`
    : null;

  if (pendingMarker) {
    trackForCancellation.set(pendingMarker, {
      chatSessionId: chatSessionId || null,
      cancel: () => {
        cancelled = true;
      },
      cleanup: () => {
        // Nothing to tear down before the real PTY job starts.
      },
    });
  }

  try {
    await ensureSessionShellKind(session, { execProbe, timeoutMs });
    if (cancelled) {
      return {
        ok: false,
        cancelled: true,
        stdout: "",
        stderr: "",
        exitCode: 130,
        error: "Cancelled",
      };
    }
    return { ok: true, shellKind: session.shellKind };
  } finally {
    if (pendingMarker && trackForCancellation) {
      trackForCancellation.delete(pendingMarker);
    }
  }
}

module.exports = {
  CONFIRMED_SHELL_KINDS,
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_OUTPUT_MARKER,
  isConfirmedShellKind,
  classifyShellKindFromRemotePath,
  buildRemoteLoginShellProbeCommand,
  parseRemoteLoginShellProbeOutput,
  createSshConnExecProbe,
  createSessionExecProbe,
  applyProbedShellKind,
  ensureSessionShellKind,
  ensureSessionShellKindForExec,
};
