"use strict";

const crypto = require("node:crypto");
const {
  execViaPty,
  startPtyJob,
  execViaChannel,
  execViaRawPty,
} = require("../bridges/ai/ptyExec.cjs");
const { getFreshIdlePrompt, formatSyntheticEcho } = require("../bridges/ai/shellUtils.cjs");
const {
  ensureSessionShellKind,
  ensureSessionShellKindForExec,
} = require("../bridges/ai/sessionShellKind.cjs");

const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS = 30 * 1000;
const BACKGROUND_JOB_RETENTION_MS = 10 * 60 * 1000;
const MAX_BACKGROUND_JOB_OUTPUT_CHARS = 256 * 1024;

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

function readWorkerJobSnapshot(job) {
  if (!job) {
    return {
      stdout: "",
      outputBaseOffset: 0,
      totalOutputChars: 0,
      outputTruncated: false,
    };
  }
  if (job.status === "running" || job.status === "stopping") {
    const snapshot = job.handle?.getSnapshot?.();
    if (snapshot) {
      const stdout = String(snapshot.stdout || "");
      const outputBaseOffset = Math.max(0, Number(snapshot.outputBaseOffset) || 0);
      const totalOutputChars = Math.max(outputBaseOffset + stdout.length, Number(snapshot.totalOutputChars) || 0);
      return {
        stdout,
        outputBaseOffset,
        totalOutputChars,
        outputTruncated: Boolean(snapshot.outputTruncated),
      };
    }
  }
  const stdout = String(job.stdout || "");
  const outputBaseOffset = Math.max(0, Number(job.outputBaseOffset) || 0);
  const totalOutputChars = Math.max(outputBaseOffset + stdout.length, Number(job.totalOutputChars) || 0);
  return {
    stdout,
    outputBaseOffset,
    totalOutputChars,
    outputTruncated: Boolean(job.outputTruncated),
  };
}

function createWorkerOutputWindow(stdout) {
  const fullText = String(stdout || "");
  const totalOutputChars = fullText.length;
  const outputBaseOffset = Math.max(0, totalOutputChars - MAX_BACKGROUND_JOB_OUTPUT_CHARS);
  return {
    stdout: outputBaseOffset > 0 ? fullText.slice(outputBaseOffset) : fullText,
    outputBaseOffset,
    totalOutputChars,
    outputTruncated: outputBaseOffset > 0,
  };
}

function refreshRunningWorkerJobSnapshot(job) {
  if (!job || (job.status !== "running" && job.status !== "stopping")) return;
  const snapshot = readWorkerJobSnapshot(job);
  job.stdout = snapshot.stdout;
  job.outputBaseOffset = snapshot.outputBaseOffset;
  job.totalOutputChars = snapshot.totalOutputChars;
  job.outputTruncated = snapshot.outputTruncated;
}

function storeCompletedWorkerJobOutput(job, stdout, metadata = null) {
  if (metadata && typeof metadata === "object") {
    const normalizedStdout = String(metadata.stdout ?? stdout ?? "");
    const outputBaseOffset = Math.max(0, Number(metadata.outputBaseOffset) || 0);
    const totalOutputChars = Math.max(outputBaseOffset + normalizedStdout.length, Number(metadata.totalOutputChars) || 0);
    job.stdout = normalizedStdout;
    job.outputBaseOffset = outputBaseOffset;
    job.totalOutputChars = totalOutputChars;
    job.outputTruncated = Boolean(metadata.outputTruncated);
    job.handle = null;
    return;
  }
  const window = createWorkerOutputWindow(stdout);
  job.stdout = window.stdout;
  job.outputBaseOffset = window.outputBaseOffset;
  job.totalOutputChars = window.totalOutputChars;
  job.outputTruncated = window.outputTruncated;
  job.handle = null;
}

function pruneCompletedWorkerJobs(backgroundJobs, now = Date.now()) {
  for (const [jobId, job] of backgroundJobs) {
    if (job.status === "running" || job.status === "stopping") continue;
    const updatedAt = Number(job.updatedAt) || 0;
    if (updatedAt > 0 && now - updatedAt > BACKGROUND_JOB_RETENTION_MS) {
      backgroundJobs.delete(jobId);
    }
  }
}

function collapseCarriageReturns(text) {
  if (!text || text.indexOf("\r") === -1) return text;
  let result = "";
  let crPending = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\r") {
      crPending = true;
      continue;
    }
    if (ch === "\n") {
      crPending = false;
      result += ch;
      continue;
    }
    if (crPending) {
      const lastNl = result.lastIndexOf("\n");
      result = lastNl >= 0 ? result.slice(0, lastNl + 1) : "";
      crPending = false;
    }
    result += ch;
  }
  return result;
}

function serializeWorkerJob(job, offset = 0) {
  if (job.status === "running" || job.status === "stopping") {
    refreshRunningWorkerJobSnapshot(job);
  }
  const stdout = job.stdout || "";
  const outputBaseOffset = job.outputBaseOffset || 0;
  const totalOutputChars = Math.max(outputBaseOffset + stdout.length, job.totalOutputChars || 0);
  const numericOffset = Math.max(0, Number(offset) || 0);
  const relativeOffset = numericOffset <= outputBaseOffset
    ? 0
    : Math.min(numericOffset - outputBaseOffset, stdout.length);
  return {
    ok: true,
    jobId: job.id,
    sessionId: job.sessionId,
    command: job.command,
    status: job.status,
    completed: job.status !== "running" && job.status !== "stopping",
    exitCode: job.exitCode,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    output: collapseCarriageReturns(stdout.slice(relativeOffset)),
    nextOffset: totalOutputChars,
    totalOutputChars,
    outputBaseOffset,
    outputTruncated: Boolean(job.outputTruncated),
    recommendedPollIntervalMs: DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS,
  };
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
    } = payload;
    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    const busy = getActiveWorkerSessionJobError(activeSessionJobs, sessionId);
    if (busy) return busy;

    const meta = sessionMeta || {};
    const { sessionProtocol, isNetworkDevice } = isNetworkDeviceSession(session, meta);
    const timeoutMs = Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 60000;

    if ((session.protocol === "local" || session.type === "local") && session.shellKind === "unknown") {
      return {
        ok: false,
        error: "AI execution is not supported for this local shell executable. Configure the local terminal to use bash/zsh/sh, fish, PowerShell/pwsh, or cmd.exe.",
      };
    }

    const ptyStream = session.stream || session.pty || session.proc;

    if (isNetworkDevice && ptyStream && typeof ptyStream.write === "function") {
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
      const probed = await ensureSessionShellKindForExec(session, {
        trackForCancellation: activePtyExecs,
        chatSessionId,
      });
      if (!probed.ok) return probed;
      return execViaPty(ptyStream, command, {
        stripMarkers: true,
        trackForCancellation: activePtyExecs,
        timeoutMs,
        shellKind: session.shellKind,
        loginShellHint: session._loginShellKind,
        chatSessionId,
        expectedPrompt: getFreshIdlePrompt(session),
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
    if (sshClient && typeof sshClient.exec === "function") {
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

    const timeoutMs = Math.max(
      Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 60000,
      DEFAULT_BACKGROUND_JOB_TIMEOUT_MS,
    );
    let handle;
    try {
      handle = startPtyJob(ptyStream, command, {
        timeoutMs,
        shellKind: session.shellKind,
        loginShellHint: session._loginShellKind,
        chatSessionId,
        expectedPrompt: getFreshIdlePrompt(session),
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
  ipcMain.handle("netcatty:ai:jobStop", createWorkerAiJobStopHandler({
    backgroundJobs,
  }));
  ipcMain.on("netcatty:ai:catty:cancel", (_event, payload = {}) => {
    cancelPtyExecsForSession(activePtyExecs, payload.chatSessionId);
    cancelWorkerBackgroundJobsForSession(backgroundJobs, payload.chatSessionId);
  });
}

module.exports = {
  cancelWorkerBackgroundJobsForSession,
  cancelPtyExecsForSession,
  createWorkerAiExecHandler,
  createWorkerAiJobStartHandler,
  createWorkerAiJobPollHandler,
  createWorkerAiJobStopHandler,
  registerWorkerAiExecHandlers,
};
