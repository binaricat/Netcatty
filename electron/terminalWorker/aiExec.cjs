"use strict";

const crypto = require("node:crypto");
const { clearSessionFlowState } = require("../bridges/terminalFlowAck.cjs");
const {
  execViaPty,
  startPtyJob,
  execViaChannel,
  execViaRawPty,
} = require("../bridges/ai/ptyExec.cjs");
const {
  getFreshIdlePrompt,
  getVisibleIdlePrompt,
  formatSyntheticEcho,
  trackSessionIdlePrompt,
} = require("../bridges/ai/shellUtils.cjs");
const { classifyShellReadiness } = require("../bridges/ai/shellReadinessState.cjs");
const {
  ensureSessionShellKind,
  remoteDisallowsExecChannelProbe, sessionDisallowsExtraSshChannel, ensureSessionShellKindForExec,
} = require("../bridges/ai/sessionShellKind.cjs");
const {
  checkBlocklistForShell,
  checkBlocklistCommonOnly,
  resolveSessionBlocklistShellKind,
} = require("../bridges/ai/commandSafety.cjs");
const {
  DEFAULT_MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  DEFAULT_BACKGROUND_JOB_RETENTION_MS,
  DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS,
  refreshRunningJobSnapshot: refreshRunningWorkerJobSnapshot,
  storeCompletedJobOutput: sharedStoreCompletedJobOutput,
  pruneCompletedBackgroundJobs: sharedPruneCompletedBackgroundJobs,
  collapseCarriageReturns,
  serializeBackgroundJob: sharedSerializeBackgroundJob,
} = require("../bridges/ai/backgroundJobOutput.cjs");

const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const BACKGROUND_JOB_POLL_INTERVAL_MS = DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS;
const BACKGROUND_JOB_RETENTION_MS = DEFAULT_BACKGROUND_JOB_RETENTION_MS;
const MAX_BACKGROUND_JOB_OUTPUT_CHARS = DEFAULT_MAX_BACKGROUND_JOB_OUTPUT_CHARS;
const EXECUTION_GUARD_ERROR = "AI privacy session is unavailable or its settings changed; start a new chat";

async function checkWorkerExecution(event, activePtyExecs, chatSessionId) {
  if (typeof event?.beforeExecute !== "function") return null;
  const marker = `__NCMCP_VALIDATE_${crypto.randomBytes(8).toString("hex")}__`;
  let cancelled = false;
  activePtyExecs?.set(marker, {
    chatSessionId,
    cancel: () => { cancelled = true; },
  });
  try {
    await event.beforeExecute();
    return cancelled ? { ok: false, error: "Cancelled" } : null;
  } catch {
    return { ok: false, error: EXECUTION_GUARD_ERROR };
  } finally {
    activePtyExecs?.delete(marker);
  }
}

function cancelPtyExecsForSession(activePtyExecs, chatSessionId) {
  if (!chatSessionId) return;
  for (const [marker, entry] of activePtyExecs) {
    if (entry.chatSessionId !== chatSessionId) continue;
    try {
      if (typeof entry.cancel === "function") entry.cancel();
      else entry.cleanup?.();
    } catch {
      // Ignore cancellation races while the worker session is shutting down.
    }
    activePtyExecs.delete(marker);
  }
}

function cancelWorkerBackgroundJobsForSession(backgroundJobs, chatSessionId) {
  if (!chatSessionId) return;
  for (const [, job] of backgroundJobs) {
    if (job.chatSessionId !== chatSessionId) continue;
    if (job.status !== "running") continue;
    try {
      job.handle?.cancel?.();
      job.status = "stopping";
      job.error = "Cancellation requested";
      job.updatedAt = Date.now();
    } catch {
      // Ignore cancellation races while the worker session is shutting down.
    }
  }
}

function createWorkerBackgroundJobId() {
  return `job_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function storeCompletedWorkerJobOutput(job, stdout, metadata = null) {
  sharedStoreCompletedJobOutput(job, stdout, metadata, MAX_BACKGROUND_JOB_OUTPUT_CHARS);
}

function pruneCompletedWorkerJobs(backgroundJobs, now = Date.now()) {
  sharedPruneCompletedBackgroundJobs(backgroundJobs, now, BACKGROUND_JOB_RETENTION_MS);
}

function serializeWorkerJob(job, offset = 0) {
  return sharedSerializeBackgroundJob(job, offset, BACKGROUND_JOB_POLL_INTERVAL_MS);
}

function getScopedWorkerJob(backgroundJobs, jobId, chatSessionId) {
  const job = backgroundJobs.get(jobId);
  if (!job) return null;
  if (job.chatSessionId) {
    if (!chatSessionId || job.chatSessionId !== chatSessionId) return null;
  }
  return job;
}

function getActiveWorkerSessionJobError(activeSessionJobs, sessionId) {
  if (!activeSessionJobs?.has(sessionId)) return null;
  return {
    ok: false,
    error: "Session already has a long-running command in progress. Wait for it to finish or stop it before starting another command.",
  };
}

function isNetworkDeviceSession(session, sessionMeta = {}) {
  const sessionProtocol = session.protocol || session.type || sessionMeta.protocol || "";
  const isSshOrSerial = sessionProtocol === "ssh" || sessionProtocol === "serial";
  return {
    sessionProtocol,
    isNetworkDevice: (sessionMeta.deviceType === "network" && isSshOrSerial) || sessionProtocol === "serial",
  };
}

function createWorkerAiExecHandler({
  sessions,
  activePtyExecs = new Map(),
  activeSessionJobs = new Map(),
}) {
  return async function handleWorkerAiExec(event, payload = {}) {
    const {
      sessionId,
      command,
      chatSessionId,
      commandTimeoutMs,
      sessionMeta,
      enforceWallTimeout,
      commandBlocklist,
      // terminal_execute_bulk validates every target before sending to any of them:
      // run every deterministic check below, then stop without touching the session.
      precheck,
      probe,
    } = payload;
    // A precheck with probe:false must not open any channel to the host.
    const noProbe = precheck === true && probe === false;
    const checkBlocklist = (cmd, session) => {
      if (!noProbe) {
        return checkBlocklistForShell(cmd, resolveSessionBlocklistShellKind(session), commandBlocklist);
      }
      const knownKind = resolveSessionBlocklistShellKind(session);
      return knownKind
        ? checkBlocklistForShell(cmd, knownKind, commandBlocklist)
        : checkBlocklistCommonOnly(cmd, commandBlocklist);
    };
    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    const busy = getActiveWorkerSessionJobError(activeSessionJobs, sessionId);
    if (busy) return busy;

    const meta = sessionMeta || {};
    const { sessionProtocol, isNetworkDevice } = isNetworkDeviceSession(session, meta);
    if (sessionProtocol === "vnc" || sessionProtocol === "rdp") {
      return {
        ok: false,
        error: `Remote desktop (${sessionProtocol.toUpperCase()}) sessions do not support terminal command execution.`,
      };
    }
    const timeoutMs = Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 60000;

    if ((session.protocol === "local" || session.type === "local") && session.shellKind === "unknown") {
      return {
        ok: false,
        error: "AI execution is not supported for this local shell executable. Configure the local terminal to use bash/zsh/sh, fish, PowerShell/pwsh, or cmd.exe.",
      };
    }

    const ptyStream = session.stream || session.pty || session.proc;

    if (isNetworkDevice && ptyStream && typeof ptyStream.write === "function") {
      if (precheck === true) return { ok: true };
      const blocked = await checkWorkerExecution(event, activePtyExecs, chatSessionId);
      if (blocked) return blocked;
      return execViaRawPty(ptyStream, command, {
        timeoutMs,
        trackForCancellation: activePtyExecs,
        chatSessionId,
        encoding: sessionProtocol === "serial" ? (session.serialEncoding || "utf8") : "utf8",
      });
    }

    if (ptyStream && typeof ptyStream.write === "function") {
      // Remote sessions may not set shellKind at connect time; probe once so
      // fish login shells get the fish wrapper (issue #1854). Cancellable so
      // Stop during the probe window does not still type the command.
      if (!noProbe) {
        const probed = await ensureSessionShellKindForExec(session, {
          trackForCancellation: activePtyExecs,
          chatSessionId,
        });
        if (!probed.ok) return probed;
      }
      const safety = checkBlocklist(command, session);
      if (safety.blocked) {
        return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
      }
      if (precheck === true) return { ok: true };
      const blocked = await checkWorkerExecution(event, activePtyExecs, chatSessionId);
      if (blocked) return blocked;
      return execViaPty(ptyStream, command, {
        beforeInput: async () => {
          const blocked = await checkWorkerExecution(event, null, chatSessionId);
          if (blocked) throw new Error(blocked.error);
        },
        onInterrupt: () => clearSessionFlowState(session),
        stripMarkers: true,
        trackForCancellation: activePtyExecs,
        timeoutMs,
        shellKind: session.shellKind,
        loginShellHint: session._loginShellKind,
        probeLiveShell: true,
        bastionKeystrokes: remoteDisallowsExecChannelProbe(session.remoteSshVersion),
        skipPendingInputClear: session.singleChannelSsh === true,
        onProbeAborted: (marker) => {
          event?.sender?.send?.("netcatty:data", {
            sessionId,
            data: `${marker}_R\n`,
          });
        },
        onEchoSuppressionPrime: (marker) => {
          event?.sender?.send?.("netcatty:data", {
            sessionId,
            data: `${marker}_I\n`,
          });
        },
        chatSessionId,
        expectedPrompt: getFreshIdlePrompt(session),
        getReadyPrompt: typeof session._promptTrackTail === "string"
          ? () => getFreshIdlePrompt(session) || getVisibleIdlePrompt(session) : undefined,
        classifyReadiness: () => classifyShellReadiness(session),
        typedInput: true,
        echoCommand: (rawCommand) => {
          event?.sender?.send?.("netcatty:data", {
            sessionId,
            data: formatSyntheticEcho(rawCommand),
            syntheticEcho: true,
          });
        },
        enforceWallTimeout: enforceWallTimeout === true,
      });
    }

    if (isNetworkDevice) {
      return { ok: false, error: "Network device session has no writable PTY stream for command execution" };
    }

    const sshClient = session.sshClient || session.conn;
    if (!session.singleChannelSsh && sshClient && typeof sshClient.exec === "function") {
      if (!noProbe) {
        const probed = await ensureSessionShellKindForExec(session, {
          trackForCancellation: activePtyExecs,
          chatSessionId,
        });
        if (!probed.ok) return probed;
      }
      const safety = checkBlocklist(command, session);
      if (safety.blocked) {
        return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
      }
      if (precheck === true) return { ok: true };
      const blocked = await checkWorkerExecution(event, activePtyExecs, chatSessionId);
      if (blocked) return blocked;
      return execViaChannel(sshClient, command, {
        timeoutMs,
        trackForCancellation: activePtyExecs,
        chatSessionId,
      });
    }

    if (session.protocol === "serial" && session.serialPort && typeof session.serialPort.write === "function") {
      if (session.ymodemActive || session.zmodemSentry?.isActive?.()) {
        return { ok: false, error: "Serial file transfer is already in progress" };
      }
      if (precheck === true) return { ok: true };
      const blocked = await checkWorkerExecution(event, activePtyExecs, chatSessionId);
      if (blocked) return blocked;
      return execViaRawPty(session.serialPort, command, {
        timeoutMs,
        trackForCancellation: activePtyExecs,
        chatSessionId,
        encoding: session.serialEncoding || "utf8",
      });
    }

    return { ok: false, error: "No terminal stream or SSH client available for this session" };
  };
}

function createWorkerAiJobStartHandler({
  sessions,
  backgroundJobs = new Map(),
  activeSessionJobs = new Map(),
}) {
  return async function handleWorkerAiJobStart(event, payload = {}) {
    const {
      sessionId,
      command,
      chatSessionId,
      commandTimeoutMs,
      sessionMeta,
      commandBlocklist,
      // terminal_start_bulk validates every target before starting any job: run every
      // deterministic check below, then stop without creating a job or touching the PTY.
      precheck,
      probe,
    } = payload;
    if (!sessionId || !command) {
      return { ok: false, error: "sessionId and command are required" };
    }
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, error: "Invalid command", exitCode: 1 };
    }
    pruneCompletedWorkerJobs(backgroundJobs);

    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    const busy = getActiveWorkerSessionJobError(activeSessionJobs, sessionId);
    if (busy) return busy;

    if ((session.protocol === "local" || session.type === "local") && session.shellKind === "unknown") {
      return {
        ok: false,
        error: "AI execution is not supported for this local shell executable. Configure the local terminal to use bash/zsh/sh, fish, PowerShell/pwsh, or cmd.exe.",
      };
    }

    const meta = sessionMeta || {};
    const { sessionProtocol, isNetworkDevice } = isNetworkDeviceSession(session, meta);
    if (sessionProtocol === "vnc" || sessionProtocol === "rdp") {
      return {
        ok: false,
        error: `Remote desktop (${sessionProtocol.toUpperCase()}) sessions do not support terminal command execution.`,
      };
    }
    if (isNetworkDevice || sessionProtocol === "serial") {
      return {
        ok: false,
        error: "Background execution currently supports shell-backed PTY sessions only.",
      };
    }

    const ptyStream = session.stream || session.pty || session.proc;
    if (!ptyStream || typeof ptyStream.write !== "function") {
      return {
        ok: false,
        error: "Background execution requires a writable PTY-backed terminal session.",
      };
    }

    if (precheck === true) {
      // A precheck with probe:false must not open any channel to the host: use the
      // shell kind only if it is already known, otherwise the shell-independent patterns.
      const noProbe = probe === false;
      if (!noProbe) {
        try {
          await ensureSessionShellKind(session);
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        }
      }
      const knownKind = resolveSessionBlocklistShellKind(session);
      const safety = noProbe && !knownKind
        ? checkBlocklistCommonOnly(command, commandBlocklist)
        : checkBlocklistForShell(command, knownKind, commandBlocklist);
      if (safety.blocked) {
        return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
      }
      return { ok: true };
    }

    const jobId = createWorkerBackgroundJobId();
    const startedAt = Date.now();
    activeSessionJobs.set(sessionId, jobId);

    // Insert into backgroundJobs *before* the shell-kind probe so
    // netcatty:ai:catty:cancel / cancelWorkerBackgroundJobsForSession can
    // latch cancellation while we await. Without this, the first job on an
    // unprobed remote session has no map entry during the probe and still
    // writes to the PTY after chat cancel (Codex P2 on #2061).
    let probeCancelRequested = false;
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
      pendingShellProbe: true,
      handle: {
        cancel: () => {
          probeCancelRequested = true;
        },
      },
    };
    backgroundJobs.set(jobId, job);

    // Same shellKind probe as foreground exec so background jobs on fish
    // remote shells are not wrapped as posix (issue #1854). Session is
    // reserved above so concurrent starts cannot pass the busy check.
    try {
      await ensureSessionShellKind(session);
      // Main retains the policy snapshot. Revalidate only after the worker's
      // async probe, not just before main handed this command to the worker.
      const blocked = await checkWorkerExecution(event, null, chatSessionId);
      if (blocked) throw new Error(blocked.error);
    } catch (err) {
      job.status = "failed";
      job.error = err?.message || String(err);
      job.updatedAt = Date.now();
      job.pendingShellProbe = false;
      if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
      return { ok: false, error: err?.message || String(err) };
    }

    if (probeCancelRequested || job.status === "stopping") {
      job.status = "cancelled";
      job.error = "Cancelled";
      job.updatedAt = Date.now();
      job.pendingShellProbe = false;
      if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
      return {
        ok: false,
        error: "Cancelled",
        jobId,
        sessionId,
        status: "cancelled",
      };
    }

    const safety = checkBlocklistForShell(
      command,
      resolveSessionBlocklistShellKind(session),
      commandBlocklist,
    );
    if (safety.blocked) {
      job.status = "failed";
      job.error = `Command blocked by safety policy. Pattern: ${safety.matchedPattern}`;
      job.updatedAt = Date.now();
      job.pendingShellProbe = false;
      backgroundJobs.delete(jobId);
      if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
      return { ok: false, error: job.error };
    }

    const timeoutMs = Math.max(
      Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 60000,
      DEFAULT_BACKGROUND_JOB_TIMEOUT_MS,
    );
    let handle;
    try {
      handle = startPtyJob(ptyStream, command, {
        beforeInput: async () => {
          const blocked = await checkWorkerExecution(event, null, chatSessionId);
          if (blocked) throw new Error(blocked.error);
        },
        onInterrupt: () => clearSessionFlowState(session),
        timeoutMs,
        sessionId,
        jobId,
        diagnosticsSession: session,
        shellKind: session.shellKind,
        loginShellHint: session._loginShellKind,
        probeLiveShell: true,
        bastionKeystrokes: remoteDisallowsExecChannelProbe(session.remoteSshVersion),
        skipPendingInputClear: session.singleChannelSsh === true,
        onProbeAborted: (marker) => {
          event?.sender?.send?.("netcatty:data", {
            sessionId,
            data: `${marker}_R\n`,
          });
        },
        onEchoSuppressionPrime: (marker) => {
          event?.sender?.send?.("netcatty:data", {
            sessionId,
            data: `${marker}_I\n`,
          });
        },
        chatSessionId,
        expectedPrompt: getFreshIdlePrompt(session),
        getReadyPrompt: typeof session._promptTrackTail === "string"
          ? () => getFreshIdlePrompt(session) || getVisibleIdlePrompt(session) : undefined,
        classifyReadiness: () => classifyShellReadiness(session),
        typedInput: true,
        echoCommand: (rawCommand) => {
          event?.sender?.send?.("netcatty:data", {
            sessionId,
            data: formatSyntheticEcho(rawCommand),
            syntheticEcho: true,
          });
        },
        maxBufferedChars: MAX_BACKGROUND_JOB_OUTPUT_CHARS,
        normalizeFinalOutput: false,
      });
    } catch (err) {
      job.status = "failed";
      job.error = err?.message || String(err);
      job.updatedAt = Date.now();
      job.pendingShellProbe = false;
      if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
      return { ok: false, error: err?.message || String(err) };
    }

    job.handle = handle;
    job.pendingShellProbe = false;

    handle.resultPromise.then((result) => {
      job.updatedAt = Date.now();
      job.exitCode = result.exitCode ?? null;
      job.code = result.code;
      storeCompletedWorkerJobOutput(job, result.stdout || "", result);
      const isForcedCancel = typeof result.error === "string" && result.error.includes("forced");
      if (result.error === "Cancelled" || isForcedCancel) {
        job.status = "cancelled";
        job.error = result.error;
        if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
        return;
      }
      if (result.error) {
        job.status = "failed";
        job.error = result.error;
        if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
        return;
      }
      if (typeof result.exitCode === "number" && result.exitCode !== 0) {
        job.status = "failed";
        job.error = `Command exited with code ${result.exitCode}`;
        if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
        return;
      }
      job.status = "completed";
      if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
    }).catch((err) => {
      job.updatedAt = Date.now();
      job.status = "failed";
      job.error = err?.message || String(err);
      storeCompletedWorkerJobOutput(job, job.stdout || "");
      if (activeSessionJobs.get(sessionId) === jobId) activeSessionJobs.delete(sessionId);
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
  };
}

function createWorkerAiJobPollHandler({ backgroundJobs = new Map() }) {
  return function handleWorkerAiJobPoll(_event, payload = {}) {
    const { jobId, offset = 0, chatSessionId } = payload || {};
    if (!jobId) return { ok: false, error: "jobId is required" };
    const job = getScopedWorkerJob(backgroundJobs, jobId, chatSessionId || null);
    if (!job) return { ok: false, error: "Background job not found" };
    return serializeWorkerJob(job, offset);
  };
}

function createWorkerAiJobStopHandler({ backgroundJobs = new Map() }) {
  return function handleWorkerAiJobStop(_event, payload = {}) {
    const { jobId, chatSessionId } = payload || {};
    if (!jobId) return { ok: false, error: "jobId is required" };
    const job = getScopedWorkerJob(backgroundJobs, jobId, chatSessionId || null);
    if (!job) return { ok: false, error: "Background job not found" };
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
    return serializeWorkerJob(job, 0);
  };
}

function registerWorkerAiExecHandlers(ipcMain, { sessions }) {
  const activePtyExecs = new Map();
  const backgroundJobs = new Map();
  const activeSessionJobs = new Map();
  ipcMain.handle("netcatty:ai:exec", createWorkerAiExecHandler({
    sessions,
    activePtyExecs,
    activeSessionJobs,
  }));
  ipcMain.handle("netcatty:ai:jobStart", createWorkerAiJobStartHandler({
    sessions,
    backgroundJobs,
    activeSessionJobs,
  }));
  ipcMain.handle("netcatty:ai:jobPoll", createWorkerAiJobPollHandler({
    backgroundJobs,
  }));
  ipcMain.handle("netcatty:ai:shellReadiness", (_event, payload = {}) => {
    // Read-only probe used by session recovery readiness inspection. Sessions
    // live here in the default worker path, so the main process cannot see
    // prompt tracking state without this route. Never mutates the session and
    // never writes to the PTY.
    const session = sessions.get(payload?.sessionId);
    if (!session) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
      trackedShell: typeof session._promptTrackTail === "string",
      freshIdlePrompt: getFreshIdlePrompt(session) || "",
      visibleIdlePrompt: getVisibleIdlePrompt(session) || "",
      readiness: classifyShellReadiness(session),
    };
  });
  ipcMain.handle("netcatty:ai:seedIdlePrompt", (_event, payload = {}) => {
    const session = sessions.get(payload?.sessionId);
    if (!session) return { ok: true, found: false };
    const context = typeof payload?.context === "string" ? payload.context : "";
    if (context) {
      // The renderer's visible buffer can survive a worker-side tracker reset or
      // a paint sequence that never reached prompt tracking. Seeding is
      // read-only: it updates the idleness cache without writing to the PTY.
      trackSessionIdlePrompt(session, `\r\n${context}`);
    }
    const prompt = getFreshIdlePrompt(session) || getVisibleIdlePrompt(session) || "";
    return {
      ok: true,
      found: true,
      ready: Boolean(prompt),
      prompt,
      readiness: classifyShellReadiness(session),
    };
  });
  ipcMain.handle("netcatty:ai:jobStop", createWorkerAiJobStopHandler({
    backgroundJobs,
  }));
  ipcMain.on("netcatty:ai:catty:cancel", (_event, payload = {}) => {
    cancelPtyExecsForSession(activePtyExecs, payload.chatSessionId);
    cancelWorkerBackgroundJobsForSession(backgroundJobs, payload.chatSessionId);
  });
  // Foreground execs only; background jobs of the same chat keep running.
  ipcMain.on("netcatty:ai:exec:cancel", (_event, payload = {}) => {
    cancelPtyExecsForSession(activePtyExecs, payload.chatSessionId);
  });
}

module.exports = {
  collapseCarriageReturns,
  cancelWorkerBackgroundJobsForSession,
  cancelPtyExecsForSession,
  createWorkerAiExecHandler,
  createWorkerAiJobStartHandler,
  createWorkerAiJobPollHandler,
  createWorkerAiJobStopHandler,
  registerWorkerAiExecHandlers,
};
