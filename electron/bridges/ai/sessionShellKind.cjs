/**
 * Resolve and cache the interactive shell kind used by AI PTY exec wrappers.
 *
 * Local terminals set shellKind from the executable path at spawn time. SSH /
 * Telnet (and similar remote) sessions historically left shellKind unset, so
 * resolveEffectiveShellKind fell through to "posix" and typed a bash-style
 * wrapper into fish login shells (issue #1854).
 *
 * Before AI exec we probe the remote login shell once via a separate SSH exec
 * channel (silent — does not touch the interactive PTY). All login-shell probe
 * results (fish/posix/powershell/cmd) are stored as session._loginShellKind
 * (soft hint) so resolveEffectiveShellKind can pick the matching wrapper
 * without permanently assuming login shell === active interactive shell, and
 * without routing bash sessions through /bin/sh (dash). Live PS/cmd prompts
 * can still override a Windows DefaultShell hint when the user nested the
 * opposite shell.
 *
 * Windows OpenSSH (issue #2959) has no POSIX `getent`/`sh` login-shell probe:
 * we read HKLM\SOFTWARE\OpenSSH DefaultShell via `reg query` instead. Without
 * that, AI typed a bash wrapper into PowerShell/cmd, hung waiting for markers,
 * and Stop/Ctrl+C tore down the SSH tab.
 */
"use strict";

const { executeBoundedSshCommand } = require("../boundedSshExec.cjs");

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
// Locale-independent: reg.exe missing-value stderr is translated on non-English
// Windows, so the probe echoes this marker via ERRORLEVEL instead.
const WINDOWS_NO_DEFAULT_SHELL_MARKER = "__NETCATTY_NO_DEFAULT_SHELL__";

function isConfirmedShellKind(shellKind) {
  return CONFIRMED_SHELL_KINDS.has(shellKind);
}

function quoteShellArg(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

/**
 * True when the SSH identification software string is Win32-OpenSSH.
 * `session.remoteSshVersion` is the software token from `SSH-2.0-<software>`.
 */
function isWindowsOpenSshRemote(remoteSshVersion) {
  return /openssh_for_windows/i.test(String(remoteSshVersion || ""));
}

/**
 * Whether this SSH banner identifies a bastion that binds the transport to the
 * first interactive session and tears it down when a second channel opens
 * (BHostSSH, QiZhi TERM-SSHD, and other menu-driven jump hosts). For these the
 * exec-channel login-shell probe must be skipped so approving an AI command
 * does not disconnect the session (#3146).
 */
function remoteDisallowsExecChannelProbe(remoteSshVersion) {
  const software = String(remoteSshVersion || "").trim();
  if (!software) return false;
  if (/BHostSSH/i.test(software)) return true;
  if (/TERM-SSHD/i.test(software)) return true;
  return false;
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
 * Silent Windows OpenSSH probe. Force `cmd.exe` so ERRORLEVEL works under both
 * DefaultShell=cmd and DefaultShell=powershell (sshd still invokes console PE
 * binaries). Do not match localized reg.exe diagnostics.
 */
function buildRemoteWindowsLoginShellProbeCommand() {
  // Merge stderr for REG_SZ success lines that some hosts split across streams.
  // Echo the missing-value marker only when the OpenSSH key is readable but
  // DefaultShell is absent. Do not treat a failed OpenSSH child query under a
  // readable HKLM\SOFTWARE parent as "key missing": registry ACLs are per-key,
  // so the account may read SOFTWARE yet be denied OpenSSH while DefaultShell
  // is PowerShell (Codex P2). A bare `if errorlevel 1` on the value query
  // alone would also fire on access denied / policy blocks and permanently
  // pin cmd on PowerShell hosts. When the OpenSSH key itself is unreadable
  // (absent or denied), emit nothing and leave the kind unclassified; English
  // "unable to find..." remains a parser fallback only.
  //
  // `if errorlevel 1` means exit code >= 1; `if not errorlevel 1` means 0.
  return (
    'cmd.exe /d /s /c "reg query HKLM\\SOFTWARE\\OpenSSH /v DefaultShell 2>&1'
    + " & if errorlevel 1 ("
    + "reg query HKLM\\SOFTWARE\\OpenSSH >nul 2>&1"
    + ` & if not errorlevel 1 echo ${WINDOWS_NO_DEFAULT_SHELL_MARKER}`
    + ')"'
  );
}

/**
 * Parse `reg query` DefaultShell output.
 * Missing DefaultShell value (OpenSSH key readable) → Microsoft's documented
 * default (cmd). Unreadable OpenSSH key stays unclassified unless the English
 * missing-key diagnostic is present.
 */
function parseRemoteWindowsLoginShellProbeOutput(stdout) {
  const text = String(stdout || "").replace(/\r/g, "");
  const sz = text.match(/DefaultShell\s+REG_SZ\s+([^\n]+)/i);
  if (sz) {
    const rawPath = sz[1].trim().replace(/^"+|"+$/g, "");
    const kind = classifyShellKindFromRemotePath(rawPath);
    if (kind) return kind;
  }
  if (
    text.includes(WINDOWS_NO_DEFAULT_SHELL_MARKER)
    || /unable to find the specified registry key or value/i.test(text)
  ) {
    return "cmd";
  }
  return null;
}

/**
 * Build an execProbe(command, timeoutMs) => Promise<string|null> from an
 * ssh2-like connection (conn.exec(command, cb)).
 */
function createSshConnExecProbe(conn) {
  if (!conn || typeof conn.exec !== "function") return null;
  return async function execProbe(command, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
    try {
      const result = await executeBoundedSshCommand(conn, command, {
        openingTimeoutMs: timeoutMs,
        runTimeoutMs: timeoutMs,
        maxOutputBytes: 64 * 1024,
      });
      // Include stderr so Windows `reg query` missing-value diagnostics
      // (and any probe that only prints errors) still reach the parser.
      return `${result.stdout || ""}${result.stderr || ""}`;
    } catch {
      return null;
    }
  };
}

/**
 * Prefer the live SSH connection, then any companion stats connection
 * (mosh/et) that still speaks ssh2 exec.
 */
function createSessionExecProbe(session) {
  if (!session || typeof session !== "object") return null;
  // A session-level probe (mosh/et companion stats connection) is independent
  // of the interactive transport, so it is safe even on bastions.
  if (typeof session._shellKindExecProbe === "function") {
    return (command, timeoutMs) => session._shellKindExecProbe(command, timeoutMs);
  }
  // Bastions bind the interactive transport to the first session and tear it
  // down when a second SSH channel opens. Our exec-channel login-shell probe
  // would disconnect them before the command ever runs, so skip it and let the
  // PTY live shell probe (probeLiveShell) determine the wrapper (#3146).
  if (remoteDisallowsExecChannelProbe(session.remoteSshVersion)) return null;
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
 * Login-shell probe is a soft hint, not a permanent active-shell pin.
 * Store on session._loginShellKind only and leave session.shellKind unset so
 * resolveEffectiveShellKind can:
 * - use the hint for the wrapper (native posix for bash/zsh, fish for fish,
 *   powershell/cmd for Windows DefaultShell — issue #1854 / #2959)
 * - still honor a live opposing Windows prompt when the user nested cmd from
 *   a PowerShell login or PowerShell from a cmd login (Codex P2 on #2960)
 * - still honor a live `user@host:...$` POSIX prompt over a Windows soft hint
 *   (e.g. WSL nested from PowerShell/cmd OpenSSH login)
 * - still honor a live PowerShell prompt over a Unix login hint (#841)
 *
 * Always mark the probe settled so we do not re-probe every AI exec.
 */
function applyProbedShellKind(session, kind) {
  if (!kind) return session.shellKind;
  session._shellKindProbeSettled = true;
  session._loginShellKind = kind;
  // Soft hint only; never pin session.shellKind from a remote login probe.
  return session.shellKind;
}

function markShellKindProbeSettled(session) {
  if (!session || typeof session !== "object") return;
  session._shellKindProbeSettled = true;
}

function isShellKindProbeSettled(session) {
  return Boolean(session?._shellKindProbeSettled)
    || isConfirmedShellKind(session?.shellKind);
}

/**
 * Probe once for the remote login shell kind.
 *
 * Prefer the Windows OpenSSH DefaultShell registry probe when the banner says
 * Win32-OpenSSH (POSIX getent/sh never works there). Otherwise try the Unix
 * marker probe, then fall back to the Windows reg probe for hosts whose banner
 * was not recorded on the session.
 *
 * @returns {Promise<{ kind: string|null, settleWithoutKind?: boolean }>}
 */
async function probeRemoteLoginShellKind(execProbe, timeoutMs, session) {
  const preferWindows = isWindowsOpenSshRemote(session?.remoteSshVersion);

  if (preferWindows) {
    const winStdout = await withProbeTimeout(
      execProbe(buildRemoteWindowsLoginShellProbeCommand(), timeoutMs),
      timeoutMs,
    );
    // Timed out / SSH exec failed — leave unsettled for a later retry
    // (same as the Unix probe branch below). Settling here would permanently
    // fall back to the POSIX wrapper on Windows sessions until reconnect.
    if (winStdout == null) {
      return { kind: null };
    }
    const winKind = parseRemoteWindowsLoginShellProbeOutput(winStdout);
    if (winKind) return { kind: winKind };
    // Completed probe but nothing classifiable. Settle without pinning so we
    // stop re-probing; live PS/cmd prompt override can still select the
    // wrapper when lastIdlePrompt is available.
    return { kind: null, settleWithoutKind: true };
  }

  const stdout = await withProbeTimeout(
    execProbe(buildRemoteLoginShellProbeCommand(), timeoutMs),
    timeoutMs,
  );
  const kind = parseRemoteLoginShellProbeOutput(stdout);
  if (kind) return { kind };

  // Timed out / probe returned null — leave unsettled for a later retry.
  // Do not stack a second full-timeout Windows probe in the same attempt.
  if (stdout == null) {
    return { kind: null };
  }

  // Got bytes but no classifiable Unix marker. Skip Windows reg when the
  // Unix probe already printed our marker with an unclassifiable path
  // (exotic login shells); otherwise try DefaultShell for Windows OpenSSH
  // hosts whose banner was not recorded on the session.
  if (String(stdout).includes(PROBE_OUTPUT_MARKER)) {
    return { kind: null };
  }

  const winStdout = await withProbeTimeout(
    execProbe(buildRemoteWindowsLoginShellProbeCommand(), timeoutMs),
    timeoutMs,
  );
  // Timed out / SSH exec failed — leave unsettled for a later retry.
  if (winStdout == null) {
    return { kind: null };
  }
  const winKind = parseRemoteWindowsLoginShellProbeOutput(winStdout);
  if (winKind) return { kind: winKind };
  // Completed Windows fallback but nothing classifiable (access denied, empty,
  // garbage). Settle without pinning so we do not re-run both probes on every
  // AI exec for the life of the session (Codex P2 on #2960).
  return { kind: null, settleWithoutKind: true };
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
      const probed = await probeRemoteLoginShellKind(execProbe, timeoutMs, session);
      if (probed.kind) {
        return applyProbedShellKind(session, probed.kind);
      }
      if (probed.settleWithoutKind) {
        markShellKindProbeSettled(session);
      }
      return session.shellKind;
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
  WINDOWS_NO_DEFAULT_SHELL_MARKER,
  isConfirmedShellKind,
  isWindowsOpenSshRemote,
  remoteDisallowsExecChannelProbe,
  classifyShellKindFromRemotePath,
  buildRemoteLoginShellProbeCommand,
  buildRemoteWindowsLoginShellProbeCommand,
  parseRemoteLoginShellProbeOutput,
  parseRemoteWindowsLoginShellProbeOutput,
  createSshConnExecProbe,
  createSessionExecProbe,
  applyProbedShellKind,
  ensureSessionShellKind,
  ensureSessionShellKindForExec,
};
