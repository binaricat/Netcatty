/* eslint-disable no-undef */
const {
  readBackgroundJobSnapshot: sharedReadBackgroundJobSnapshot,
  createOutputWindow: sharedCreateOutputWindow,
  refreshRunningJobSnapshot: sharedRefreshRunningJobSnapshot,
  storeCompletedJobOutput: sharedStoreCompletedJobOutput,
  pruneCompletedBackgroundJobs: sharedPruneCompletedBackgroundJobs,
  collapseCarriageReturns: sharedCollapseCarriageReturns,
  serializeBackgroundJob: sharedSerializeBackgroundJob,
} = require("../ai/backgroundJobOutput.cjs");

function createBackgroundJobApi(ctx) {
  with (ctx) {
    async function waitForSessionCloseCleanup(pending) {
      if (!pending.length) return;
      const allSettled = Promise.allSettled(pending);
      const timeoutMs = Number.isFinite(SESSION_CLOSE_CLEANUP_TIMEOUT_MS)
        ? Math.max(1, SESSION_CLOSE_CLEANUP_TIMEOUT_MS)
        : 5000;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([allSettled, timeout]);
      if (timer) clearTimeout(timer);
    }

    function createBackgroundJobId() {
      return `job_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    }
    
    function cancelBackgroundJobsForSession(chatSessionId) {
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
          // Ignore cancellation failures
        }
      }
    }

    function cancelBackgroundJobsForTerminalSession(sessionId) {
      if (!sessionId) return;
      for (const [, job] of backgroundJobs) {
        if (job.sessionId !== sessionId) continue;
        if (job.status !== "running" && job.status !== "stopping") continue;
        try {
          job.handle?.cancel?.();
        } catch {
          // The terminal close below will still tear down the underlying stream.
        }
        job.status = "stopping";
        job.error = "Cancellation requested";
        job.updatedAt = Date.now();
      }
    }

    async function settleBackgroundJobsForTerminalSession(sessionId) {
      if (!sessionId) return;
      const matchingJobs = [];
      const pending = [];
      for (const [jobId, job] of backgroundJobs) {
        if (job.sessionId !== sessionId) continue;
        matchingJobs.push([jobId, job]);
        if (job.handle?.resultPromise) pending.push(job.handle.resultPromise);
      }
      await waitForSessionCloseCleanup(pending);
      for (const [jobId] of matchingJobs) backgroundJobs.delete(jobId);
      activeSessionExecutions.delete(sessionId);
    }
    
    function registerSftpOp(chatSessionId, sessionId, cancel) {
      if (!chatSessionId || typeof cancel !== "function") {
        return () => {};
      }
      if (closingTerminalSessions?.has(sessionId)) {
        try {
          void Promise.resolve(cancel()).catch(() => {});
        } catch {
          // The session is already closing; a failed redundant cancellation is harmless.
        }
        return () => {};
      }
      const opId = `sftp_${Date.now().toString(36)}_${(++activeSftpOpSeq).toString(36)}`;
      activeSessionSftpOps.set(opId, { chatSessionId, sessionId, cancel });
      return () => {
        activeSessionSftpOps.delete(opId);
      };
    }
    
    async function cancelSftpOpsForSession(chatSessionId) {
      if (!chatSessionId) return;
      const pending = [];
      for (const [opId, entry] of activeSessionSftpOps) {
        if (entry.chatSessionId !== chatSessionId) continue;
        activeSessionSftpOps.delete(opId);
        try {
          pending.push(Promise.resolve(entry.cancel()));
        } catch {
          // Ignore cancellation failures for already-closed SFTP handles.
        }
      }
      if (pending.length) {
        await Promise.allSettled(pending);
      }
    }

    async function cancelSftpOpsForTerminalSession(sessionId) {
      if (!sessionId) return;
      const pending = [];
      for (const [opId, entry] of activeSessionSftpOps) {
        if (entry.sessionId !== sessionId) continue;
        activeSessionSftpOps.delete(opId);
        try {
          pending.push(Promise.resolve(entry.cancel()));
        } catch {
          // Ignore cancellation failures for already-closed SFTP handles.
        }
      }
      await waitForSessionCloseCleanup(pending);
    }

    function beginTerminalSessionClose(sessionId) {
      if (!sessionId) return;
      const current = closingTerminalSessions?.get(sessionId) || 0;
      closingTerminalSessions?.set(sessionId, current + 1);
    }

    function endTerminalSessionClose(sessionId) {
      if (!sessionId) return;
      const current = closingTerminalSessions?.get(sessionId) || 0;
      if (current <= 1) closingTerminalSessions?.delete(sessionId);
      else closingTerminalSessions?.set(sessionId, current - 1);
    }
    
    function cancelAllSftpOps() {
      const pending = [];
      for (const [opId, entry] of activeSessionSftpOps) {
        activeSessionSftpOps.delete(opId);
        try {
          pending.push(Promise.resolve(entry.cancel()));
        } catch {
          // Ignore cancellation failures during global cleanup.
        }
      }
      return pending.length ? Promise.allSettled(pending) : Promise.resolve([]);
    }
    
    const readBackgroundJobSnapshot = sharedReadBackgroundJobSnapshot;

    const createOutputWindow = (stdout) =>
      sharedCreateOutputWindow(stdout, ctx.MAX_BACKGROUND_JOB_OUTPUT_CHARS);

    const refreshRunningJobSnapshot = sharedRefreshRunningJobSnapshot;

    const storeCompletedJobOutput = (job, stdout, metadata = null) =>
      sharedStoreCompletedJobOutput(job, stdout, metadata, ctx.MAX_BACKGROUND_JOB_OUTPUT_CHARS);

    const pruneCompletedBackgroundJobs = (now = Date.now()) =>
      sharedPruneCompletedBackgroundJobs(ctx.backgroundJobs, now, ctx.BACKGROUND_JOB_RETENTION_MS);

    const collapseCarriageReturns = sharedCollapseCarriageReturns;

    const serializeBackgroundJob = (job, offset = 0) =>
      sharedSerializeBackgroundJob(job, offset, ctx.DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS);
    
    function describeActiveSessionExecution(entry) {
      if (!entry) return "another command";
      return entry.kind === "job" ? "a long-running command" : "another command";
    }
    
    function getSessionBusyError(sessionId) {
      const active = activeSessionExecutions.get(sessionId);
      if (!active) return null;
      return {
        ok: false,
        error: `Session already has ${describeActiveSessionExecution(active)} in progress. Wait for it to finish or stop it before starting another command.`,
      };
    }
    
    function reserveSessionExecution(sessionId, kind) {
      const existing = getSessionBusyError(sessionId);
      if (existing) return existing;
      const token = `${kind}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
      activeSessionExecutions.set(sessionId, {
        kind,
        startedAt: Date.now(),
        token,
      });
      return { ok: true, token };
    }
    
    function releaseSessionExecution(sessionId, token) {
      const active = activeSessionExecutions.get(sessionId);
      if (!active) return;
      if (token && active.token !== token) return;
      activeSessionExecutions.delete(sessionId);
    }

    return {
      createBackgroundJobId,
      cancelBackgroundJobsForSession,
      cancelBackgroundJobsForTerminalSession,
      settleBackgroundJobsForTerminalSession,
      registerSftpOp,
      cancelSftpOpsForSession,
      cancelSftpOpsForTerminalSession,
      beginTerminalSessionClose,
      endTerminalSessionClose,
      cancelAllSftpOps,
      readBackgroundJobSnapshot,
      createOutputWindow,
      refreshRunningJobSnapshot,
      storeCompletedJobOutput,
      pruneCompletedBackgroundJobs,
      collapseCarriageReturns,
      serializeBackgroundJob,
      describeActiveSessionExecution,
      getSessionBusyError,
      reserveSessionExecution,
      releaseSessionExecution,
    };
  }
}

module.exports = { createBackgroundJobApi };
