/* eslint-disable no-undef */
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
      // Jobs a live branched chat still inherited survive this chat's
      // teardown; only un-inherited jobs are cancelled with it.
      const preserve = typeof getLiveInheritedJobIdsForOwner === "function"
        ? new Set(getLiveInheritedJobIdsForOwner(chatSessionId))
        : new Set();
      for (const [jobId, job] of backgroundJobs) {
        if (job.chatSessionId !== chatSessionId) continue;
        if (preserve.has(jobId)) continue;
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
    
    function readBackgroundJobSnapshot(job) {
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
    
    function createOutputWindow(stdout) {
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
    
    function refreshRunningJobSnapshot(job) {
      if (!job || (job.status !== "running" && job.status !== "stopping")) return;
      const snapshot = readBackgroundJobSnapshot(job);
      job.stdout = snapshot.stdout;
      job.outputBaseOffset = snapshot.outputBaseOffset;
      job.totalOutputChars = snapshot.totalOutputChars;
      job.outputTruncated = snapshot.outputTruncated;
    }
    
    function storeCompletedJobOutput(job, stdout, metadata = null) {
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
      const window = createOutputWindow(stdout);
      job.stdout = window.stdout;
      job.outputBaseOffset = window.outputBaseOffset;
      job.totalOutputChars = window.totalOutputChars;
      job.outputTruncated = window.outputTruncated;
      job.handle = null;
    }
    
    function pruneCompletedBackgroundJobs(now = Date.now()) {
      for (const [jobId, job] of backgroundJobs) {
        if (job.status === "running" || job.status === "stopping") continue;
        const updatedAt = Number(job.updatedAt) || 0;
        if (updatedAt > 0 && now - updatedAt > BACKGROUND_JOB_RETENTION_MS) {
          backgroundJobs.delete(jobId);
        }
      }
    }
    
    // Collapse carriage-return progress redraws to the latest frame.
    // Each \r resets the cursor to the start of the current line; the next
    // non-\r character overwrites the existing line content. A trailing \r
    // (with no following content) leaves the existing line intact, so a
    // snapshot taken between redraws still shows the latest visible frame.
    // Used at serialize time so the stored buffer can keep raw monotonic
    // offsets while polled output shows the latest frame.
    function collapseCarriageReturns(text) {
      if (!text || text.indexOf("\r") === -1) return text;
      let result = "";
      let crPending = false;
      for (let i = 0; i < text.length; i++) {
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
    
    function serializeBackgroundJob(job, offset = 0) {
      if (job.status === "running" || job.status === "stopping") {
        refreshRunningJobSnapshot(job);
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
