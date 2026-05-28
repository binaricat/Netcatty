/* eslint-disable no-undef */
function registerCattyExecHandlers(ctx) {
  with (ctx) {
  ipcMain.handle("netcatty:ai:exec", async (event, { sessionId, command, chatSessionId }) => {
    // Validate IPC sender (Issue #17)
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    // Block execution in observer mode (Issue #11)
    if (mcpServerBridge.getPermissionMode() === "observer") {
      return { ok: false, error: "Execution blocked: permission mode is 'observer'" };
    }
    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }

    // Honor the per-session execution lock so this IPC path does not race with
    // long-running background jobs started via terminal_start.
    const busyErr = mcpServerBridge.getSessionBusyError?.(sessionId);
    if (busyErr) return busyErr;
    const reservation = mcpServerBridge.reserveSessionExecution?.(sessionId, "exec");
    if (reservation && !reservation.ok) return reservation;
    const sessionToken = reservation?.token;
    const releaseLock = () => {
      if (sessionToken) {
        try { mcpServerBridge.releaseSessionExecution?.(sessionId, sessionToken); } catch {}
      }
    };

    // Look up device type from metadata (set by renderer from Host.deviceType).
    // Mosh sessions use a shell-backed PTY, so network device mode only applies to SSH/serial.
    // Prefer session.protocol (runtime truth) over meta.protocol (renderer hint)
    // because Mosh tabs report as protocol:"ssh" in metadata but "mosh" in session.
    const meta = mcpServerBridge.getSessionMeta(sessionId, chatSessionId) || {};
    const sessionProtocol = session.protocol || session.type || meta.protocol || "";
    const isSshOrSerial = sessionProtocol === "ssh" || sessionProtocol === "serial";
    const isNetworkDevice = (meta.deviceType === "network" && isSshOrSerial) || sessionProtocol === "serial";

    // Shell blocklist is meaningless on network device CLIs (e.g. "shutdown"
    // disables an interface on Cisco). Skip for network devices and serial sessions.
    if (!isNetworkDevice) {
      const safety = mcpServerBridge.checkCommandSafety(command);
      if (safety.blocked) {
        releaseLock();
        return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
      }
    }

    // Helper: ensure the session lock is released once the promise settles
    // (or immediately on a synchronous error/early return).
    const withLockRelease = (factory) => {
      try {
        const result = factory();
        return Promise.resolve(result).finally(releaseLock);
      } catch (err) {
        releaseLock();
        return { ok: false, error: err?.message || String(err) };
      }
    };

    try {
      if ((session.protocol === "local" || session.type === "local") && session.shellKind === "unknown") {
        releaseLock();
        return {
          ok: false,
          error: "AI execution is not supported for this local shell executable. Configure the local terminal to use bash/zsh/sh, fish, PowerShell/pwsh, or cmd.exe.",
        };
      }

      const ptyStream = session.stream || session.pty || session.proc;

      // Network devices (switches/routers) connected via SSH: use raw execution.
      // Their vendor CLIs don't run a POSIX shell, so shell-wrapped commands fail.
      if (isNetworkDevice && ptyStream && typeof ptyStream.write === "function") {
        const { execViaRawPty } = require("./ai/ptyExec.cjs");
        const timeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaRawPty(ptyStream, command, {
          timeoutMs,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          chatSessionId,
          encoding: "utf8", // SSH PTY streams use UTF-8, not latin1
        }));
      }

      // Prefer PTY stream (visible in terminal)
      if (ptyStream && typeof ptyStream.write === "function") {
        const timeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaPty(ptyStream, command, {
          stripMarkers: true,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          timeoutMs,
          shellKind: session.shellKind,
          chatSessionId,
          expectedPrompt: getFreshIdlePrompt(session),
          typedInput: true,
          echoCommand: (rawCommand) => {
            const contents = electronModule?.webContents?.fromId?.(session.webContentsId);
            safeSend(contents, "netcatty:data", {
              sessionId,
              data: `${rawCommand}\r\n`,
              syntheticEcho: true,
            });
          },
          // Catty Agent has no terminal_start fallback for long-running
          // commands, so do NOT enforce a hard wall-clock timeout here.
          // The inactivity timeout still applies, so genuinely hung
          // processes are still terminated.
        }));
      }

      // Network devices require an interactive PTY for raw command execution.
      if (isNetworkDevice) {
        releaseLock();
        return { ok: false, error: "Network device session has no writable PTY stream for command execution" };
      }

      // Fallback: SSH exec channel (invisible to terminal)
      const sshClient = session.sshClient || session.conn;
      if (sshClient && typeof sshClient.exec === "function") {
        const { execViaChannel } = require("./ai/ptyExec.cjs");
        const channelTimeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaChannel(sshClient, command, {
          timeoutMs: channelTimeoutMs,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          chatSessionId,
        }));
      }

      // Serial port: raw command execution (no shell wrapping)
      if (session.protocol === "serial" && session.serialPort && typeof session.serialPort.write === "function") {
        const { execViaRawPty } = require("./ai/ptyExec.cjs");
        const serialTimeoutMs = mcpServerBridge.getCommandTimeoutMs ? mcpServerBridge.getCommandTimeoutMs() : 60000;
        return withLockRelease(() => execViaRawPty(session.serialPort, command, {
          timeoutMs: serialTimeoutMs,
          trackForCancellation: mcpServerBridge.activePtyExecs,
          chatSessionId,
          encoding: session.serialEncoding || "utf8",
        }));
      }

      releaseLock();
      return { ok: false, error: "No terminal stream or SSH client available for this session" };
    } catch (err) {
      releaseLock();
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Cancel in-flight Catty Agent command executions for a chat session
  ipcMain.handle("netcatty:ai:catty:cancel", async (event, { chatSessionId }) => {
    if (!validateSender(event)) {
      return { ok: false, error: "Unauthorized IPC sender" };
    }
    mcpServerBridge.cancelPtyExecsForSession(chatSessionId);
    void mcpServerBridge.cancelSftpOpsForSession?.(chatSessionId);
    return { ok: true };
  });
  }
}

module.exports = { registerCattyExecHandlers };
