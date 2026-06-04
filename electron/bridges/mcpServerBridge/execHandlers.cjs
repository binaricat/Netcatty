/* eslint-disable no-undef */
function createExecHandlerApi(ctx) {
  with (ctx) {
    function resolveExecContext(params) {
      const { sessionId, command } = params;
      debugLog("handleExec:start", { sessionId, command, chatSessionId: params?.chatSessionId });
      if (!sessionId || !command) throw new Error("sessionId and command are required");
      if (typeof command !== 'string' || !command.trim()) {
        return { ok: false, error: 'Invalid command', exitCode: 1 };
      }
    
      const session = sessions?.get(sessionId);
      debugLog("handleExec:sessionLookup", {
        sessionId,
        found: Boolean(session),
        protocol: session?.protocol || session?.type || null,
        shellKind: session?.shellKind || null,
      });
      if (!session) return { ok: false, error: "Session not found" };
    
      // Look up device type from metadata (set by renderer from Host.deviceType).
      const chatSessionId = params?.chatSessionId || null;
      const meta = getSessionMeta(sessionId, chatSessionId) || {};
      // Mosh sessions use a shell-backed PTY and cannot connect to vendor CLIs,
      // so network device mode only applies to SSH and serial sessions.
      // Prefer session.protocol (runtime truth) over meta.protocol (renderer hint)
      // because Mosh tabs report as protocol:"ssh" in metadata but "mosh" in session.
      const sessionProtocol = session.protocol || session.type || meta.protocol || "";
      const isSshOrSerial = sessionProtocol === "ssh" || sessionProtocol === "serial";
      const isNetworkDevice = (meta.deviceType === "network" && isSshOrSerial) || sessionProtocol === "serial";
    
      // The blocklist targets shell-specific patterns (rm -rf, eval, $(), etc.) that
      // are meaningless on network device CLIs. Serial sessions skip the check because
      // commands like "shutdown" (disable an interface) are routine on Cisco/Huawei.
      //
      // Design note: the serial protocol is explicitly chosen by the user in the UI
      // for network devices / embedded systems. While startSerialSession technically
      // supports PTY devices, users connecting to a Linux/BusyBox shell should use
      // the "local" protocol (which goes through the normal shell path with blocklist).
      // Additionally, execViaRawPty sends commands without shell wrapping, so shell
      // metacharacters in blocklist patterns (eval, $(), backticks, pipes) cannot
      // actually be interpreted even if sent to a serial-connected shell.
      if (!isNetworkDevice) {
        const safety = checkCommandSafety(command);
        if (safety.blocked) {
          debugLog("handleExec:blocklisted", { sessionId, matchedPattern: safety.matchedPattern });
          return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
        }
      }
    
      if ((session.protocol === "local" || session.type === "local") && session.shellKind === "unknown") {
        return {
          ok: false,
          error: "AI execution is not supported for this local shell executable. Configure the local terminal to use bash/zsh/sh, fish, PowerShell/pwsh, or cmd.exe.",
        };
      }
    
      const sshClient = session.conn || session.sshClient;
      const ptyStream = session.stream || session.pty || session.proc;
      return {
        ok: true,
        context: {
          sessionId,
          command,
          session,
          chatSessionId,
          sessionProtocol,
          isNetworkDevice,
          sshClient,
          ptyStream,
        },
      };
    }
    
    function handleExec(params) {
      const resolved = resolveExecContext(params);
      if (!resolved.ok) return resolved;
      const {
        sessionId,
        command,
        session,
        chatSessionId,
        sessionProtocol,
        isNetworkDevice,
        sshClient,
        ptyStream,
      } = resolved.context;
      const reservation = reserveSessionExecution(sessionId, "exec");
      if (!reservation.ok) return reservation;
      const sessionToken = reservation.token;
      const executionLock = beginChatExecution(chatSessionId, sessionId, command);
      if (!executionLock.ok) {
        releaseSessionExecution(sessionId, sessionToken);
        return {
          ok: false,
          code: "COMMAND_ALREADY_RUNNING",
          error: `Another Netcatty command is already running for chat session "${chatSessionId}". Wait for it to finish before starting a new exec.`,
          activeCommand: executionLock.active.command,
          activeSessionId: executionLock.active.sessionId,
        };
      }
    
      const runExecution = (factory) => {
        try {
          return Promise.resolve(factory()).finally(() => {
            releaseSessionExecution(sessionId, sessionToken);
            executionLock.release();
          });
        } catch (err) {
          releaseSessionExecution(sessionId, sessionToken);
          executionLock.release();
          return { ok: false, error: err?.message || String(err) };
        }
      };
    
      // Network devices (switches/routers) connected via SSH: use raw execution.
      // Their vendor CLIs (Huawei VRP, Cisco IOS, etc.) don't run a POSIX shell,
      // so shell-wrapped commands with markers would fail. Raw mode sends commands
      // as-is with idle-timeout completion detection — same as serial sessions.
      if (isNetworkDevice && ptyStream && typeof ptyStream.write === "function") {
        return runExecution(() => execViaRawPty(ptyStream, command, {
          timeoutMs: commandTimeoutMs,
          trackForCancellation: activePtyExecs,
          chatSessionId: params?.chatSessionId,
          encoding: "utf8", // SSH PTY streams use UTF-8, not latin1
        }));
      }
    
      // Prefer the interactive PTY so the user sees command/output in-session.
      if (ptyStream && typeof ptyStream.write === "function") {
        return runExecution(() => execViaPty(ptyStream, command, {
          trackForCancellation: activePtyExecs,
          timeoutMs: commandTimeoutMs,
          shellKind: session.shellKind,
          expectedPrompt: getFreshIdlePrompt(session),
          typedInput: true,
          echoCommand: (rawCommand) => echoCommandToSession(session, sessionId, rawCommand),
          chatSessionId,
          // MCP callers have terminal_start as a fallback for long commands,
          // so enforce a hard wall-clock timeout here to match the MCP budget.
          enforceWallTimeout: true,
        }));
      }
    
      // Network devices require an interactive PTY for raw command execution.
      // If we got here, ptyStream wasn't writable — there's no usable channel.
      if (isNetworkDevice) {
        releaseSessionExecution(sessionId, sessionToken);
        executionLock.release();
        return { ok: false, error: "Network device session has no writable PTY stream for command execution" };
      }
    
      // Fallback: SSH exec channel (invisible to terminal).
      // At this point ptyStream is not writable (already returned above if it was).
      if (sshClient && typeof sshClient.exec === "function") {
        return runExecution(() => execViaChannel(sshClient, command, {
          timeoutMs: commandTimeoutMs,
          trackForCancellation: activePtyExecs,
          // Pass chatSessionId so cancelPtyExecsForSession can interrupt this
          // exec channel when the originating SDK agent run is stopped.
          chatSessionId: params?.chatSessionId,
        }));
      }
    
      // Serial port: raw command execution (no shell wrapping)
      if (session.protocol === "serial" && session.serialPort && typeof session.serialPort.write === "function") {
        return runExecution(() => execViaRawPty(session.serialPort, command, {
          timeoutMs: commandTimeoutMs,
          trackForCancellation: activePtyExecs,
          chatSessionId: params?.chatSessionId,
          encoding: session.serialEncoding || "utf8",
        }));
      }
    
      releaseSessionExecution(sessionId, sessionToken);
      executionLock.release();
      return { ok: false, error: "Session does not support command execution" };
    }
    
    function handleJobStart(params) {
      const resolved = resolveExecContext(params);
      if (!resolved.ok) return resolved;
      const {
        sessionId,
        command,
        session,
        chatSessionId,
        isNetworkDevice,
        sessionProtocol,
        ptyStream,
      } = resolved.context;
    
      if (isNetworkDevice || sessionProtocol === "serial") {
        return {
          ok: false,
          error: "Background execution currently supports shell-backed PTY sessions only.",
        };
      }
    
      if (!ptyStream || typeof ptyStream.write !== "function") {
        return {
          ok: false,
          error: "Background execution requires a writable PTY-backed terminal session.",
        };
      }
    
      const reservation = reserveSessionExecution(sessionId, "job");
      if (!reservation.ok) return reservation;
      const sessionToken = reservation.token;
    
      const jobId = createBackgroundJobId();
      const timeoutMs = Math.max(commandTimeoutMs, DEFAULT_BACKGROUND_JOB_TIMEOUT_MS);
      let handle;
      try {
        handle = startPtyJob(ptyStream, command, {
          // Intentionally do NOT register in activePtyExecs: terminal_start jobs
          // are designed to survive SDK agent "Stop" so the model can stop polling
          // without aborting a long-running build/scan/log stream. The job is
          // managed via terminal_stop and the per-session execution lock.
          timeoutMs,
          shellKind: session.shellKind,
          chatSessionId,
          expectedPrompt: getFreshIdlePrompt(session),
          typedInput: true,
          echoCommand: (rawCommand) => echoCommandToSession(session, sessionId, rawCommand),
          maxBufferedChars: MAX_BACKGROUND_JOB_OUTPUT_CHARS,
          normalizeFinalOutput: false,
        });
      } catch (err) {
        releaseSessionExecution(sessionId, sessionToken);
        return { ok: false, error: err?.message || String(err) };
      }
    
      const startedAt = Date.now();
      const job = {
        id: jobId,
        sessionId,
        chatSessionId: chatSessionId || null,
        command,
        status: "running",
        startedAt,
        updatedAt: startedAt,
        exitCode: null,
        error: null,
        stdout: "",
        outputBaseOffset: 0,
        totalOutputChars: 0,
        outputTruncated: false,
        handle,
      };
      backgroundJobs.set(jobId, job);
    
      handle.resultPromise.then((result) => {
        job.updatedAt = Date.now();
        job.exitCode = result.exitCode ?? null;
        storeCompletedJobOutput(job, result.stdout || "", result);
        const isForcedCancel = typeof result.error === "string" && result.error.includes("forced");
        if (result.error === "Cancelled" || isForcedCancel) {
          // Forced cancel means the process ignored SIGINT for the cancel
          // wall-clock window. We mark the job as cancelled and release the
          // lock so the session is reusable; the error message tells the
          // caller the process may still be running so subsequent commands
          // should be considered carefully. This is consistent: callers see
          // completed=true exactly when the lock is no longer held.
          job.status = "cancelled";
          job.error = result.error;
          releaseSessionExecution(sessionId, sessionToken);
          return;
        }
        if (result.error) {
          job.status = "failed";
          job.error = result.error;
          releaseSessionExecution(sessionId, sessionToken);
          return;
        }
        // A non-zero exit code without an error message still represents a
        // failed command (e.g. a build/test that returned 1). Mark it as failed
        // so callers don't have to special-case exitCode against status.
        if (typeof result.exitCode === "number" && result.exitCode !== 0) {
          job.status = "failed";
          job.error = `Command exited with code ${result.exitCode}`;
          releaseSessionExecution(sessionId, sessionToken);
          return;
        }
        job.status = "completed";
        releaseSessionExecution(sessionId, sessionToken);
      }).catch((err) => {
        job.updatedAt = Date.now();
        job.status = "failed";
        job.error = err?.message || String(err);
        storeCompletedJobOutput(job, job.stdout || "");
        releaseSessionExecution(sessionId, sessionToken);
      });
    
      return {
        ok: true,
        jobId,
        sessionId,
        command,
        status: "running",
        startedAt,
        outputMode: "foreground-mirrored",
        recommendedPollIntervalMs: DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS,
      };
    }
    
    function getScopedJob(jobId, chatSessionId) {
      const job = backgroundJobs.get(jobId);
      if (!job) return null;
      // Per-chat isolation: a job started under a chat session can only be
      // accessed by callers presenting the same chatSessionId. Unscoped or
      // statically-scoped callers cannot reach into another chat's jobs.
      if (job.chatSessionId) {
        if (!chatSessionId || job.chatSessionId !== chatSessionId) {
          return null;
        }
      }
      return job;
    }
    
    function handleJobPoll(params) {
      const { jobId, offset = 0, chatSessionId, scopedSessionIds } = params || {};
      if (!jobId) throw new Error("jobId is required");
      const job = getScopedJob(jobId, chatSessionId || null);
      if (!job) return { ok: false, error: "Background job not found" };
      // Re-check session scope so a caller that lost access to the host
      // cannot continue reading output from jobs on that session.
      // Covers dynamic (chatSessionId) and static (scopedSessionIds) modes.
      if (job.sessionId) {
        const scopeErr = validateSessionScope(job.sessionId, chatSessionId || null, scopedSessionIds);
        if (scopeErr) return { ok: false, error: scopeErr };
      }
      return serializeBackgroundJob(job, offset);
    }
    
    function handleJobStop(params) {
      const { jobId, chatSessionId, scopedSessionIds } = params || {};
      if (!jobId) throw new Error("jobId is required");
      const job = getScopedJob(jobId, chatSessionId || null);
      if (!job) return { ok: false, error: "Background job not found" };
      // For statically scoped MCP clients, validate that the job's session is
      // within the caller's static scope so a foreign jobId cannot cancel jobs
      // outside the caller's allowed sessions. Dynamic chat scope is already
      // enforced by getScopedJob (caller's chatSessionId must match the job's),
      // and we intentionally do NOT re-check dynamic scope here so jobs can
      // still be stopped after workspace membership changes — otherwise the
      // session lock would stay held forever.
      if (Array.isArray(scopedSessionIds) && job.sessionId) {
        if (!scopedSessionIds.includes(job.sessionId)) {
          return { ok: false, error: `Session "${job.sessionId}" is not in the current scope.` };
        }
      }
      if (job.status === "running") {
        try {
          job.handle?.cancel?.();
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        }
        job.status = "stopping";
        job.error = "Cancellation requested";
        job.updatedAt = Date.now();
      }
      return serializeBackgroundJob(job, 0);
    }

    return {
      resolveExecContext,
      handleExec,
      handleJobStart,
      getScopedJob,
      handleJobPoll,
      handleJobStop,
    };
  }
}

module.exports = { createExecHandlerApi };
