"use strict";

/**
 * terminal_start_bulk / terminal_poll_bulk / terminal_stop_bulk: background jobs
 * on 2-20 terminal sessions.
 *
 * Contract (see docs/features/terminal-bulk-jobs.md):
 *  - start: all-or-nothing preflight (same rules as terminal_start), one fresh
 *    approval for the whole fan-out, then one background job per session. A
 *    `bulkId` names the set so poll/stop need one id instead of many.
 *  - poll: the existing per-job poll for each job, capped per job and in total.
 *    The total is shared by need, so quiet jobs leave room for busy ones. When a
 *    job has more new output than its share, the newest output is returned and
 *    `skippedChars` says how much was jumped over.
 *  - stop: the existing per-job stop for each job (no approval, like terminal_stop).
 * Per-job problems (expired, out of scope, not found) never fail poll or stop.
 */

const {
  MAX_BULK_TARGETS,
  createBulkTargetGuards,
  formatPreflightFailure,
  labelPart,
  parseBulkExecParams,
} = require("./execBulk.cjs");

const BULK_START_RPC_METHOD = "netcatty/jobStartBulk";
// Polls repeat, so keep them small: enough tail to see progress or an error.
// terminal_poll on one job returns its full kept output.
const MAX_POLL_CHARS_PER_JOB = 4 * 1024;
const MAX_POLL_TOTAL_CHARS = 32 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
/** A job runs at most 1 hour and is kept 10 minutes after it ends; keep the handle a bit longer. */
const BULK_ENTRY_MAX_AGE_MS = (60 + 10 + 5) * 60 * 1000;
const MAX_BULK_ENTRIES = 100;
/** Poll offset past any real output: returns no output, only nextOffset. */
const PEEK_OFFSET = Number.MAX_SAFE_INTEGER;

const CLAIM_CONFLICT_ERROR = "Session already has another command request awaiting approval or startup. Wait for it to finish before starting a new command.";

function parseJsonValue(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the jobs a poll/stop call targets: a bulkId from terminal_start_bulk, or an
 * explicit list of 1-20 jobIds.
 * @returns {{ ok: true, bulkId: string | null, jobIds: string[] } | { ok: false, error: string }}
 */
function parseJobTargets(params = {}) {
  const bulkId = typeof params?.bulkId === "string" ? params.bulkId.trim() : "";
  const hasJobIds = params?.jobIds !== undefined && params?.jobIds !== null && params?.jobIds !== "";
  if (bulkId && hasJobIds) return { ok: false, error: "Pass either bulkId or jobIds, not both" };
  if (bulkId) return { ok: true, bulkId, jobIds: [] };
  if (!hasJobIds) return { ok: false, error: "bulkId or jobIds is required" };
  const shapeError = `jobIds must be a JSON array of 1-${MAX_BULK_TARGETS} job ID strings`;
  const raw = parseJsonValue(params.jobIds);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BULK_TARGETS
    || raw.some((id) => typeof id !== "string" || !id.trim())) {
    return { ok: false, error: shapeError };
  }
  return { ok: true, bulkId: null, jobIds: [...new Set(raw.map((id) => id.trim()))] };
}

/**
 * @returns {{ ok: true, offsets: Map<string, number> } | { ok: false, error: string }}
 */
function parseOffsets(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, offsets: new Map() };
  const value = parseJsonValue(raw);
  const shapeError = "offsets must be a JSON object mapping jobId to the nextOffset from a previous poll";
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: shapeError };
  const offsets = new Map();
  for (const [jobId, offset] of Object.entries(value)) {
    const numeric = Number(offset);
    if (!Number.isFinite(numeric) || numeric < 0) return { ok: false, error: shapeError };
    offsets.set(jobId, Math.floor(numeric));
  }
  return { ok: true, offsets };
}

/**
 * Share `total` characters across jobs by need (water-filling): a job never gets
 * more than it needs or `perJob`, and what quiet jobs leave is shared by the rest.
 * @param {number[]} needs new raw characters available per job
 * @returns {number[]} characters each job may return
 */
function allocatePollBudgets(needs, perJob, total) {
  const budgets = needs.map(() => 0);
  const order = needs
    .map((need, index) => ({ index, want: Math.min(Math.max(0, need), perJob) }))
    .filter((entry) => entry.want > 0)
    .sort((a, b) => a.want - b.want);
  let remaining = total;
  for (let i = 0; i < order.length; i++) {
    const share = Math.floor(remaining / (order.length - i));
    if (order[i].want <= share) {
      budgets[order[i].index] = order[i].want;
      remaining -= order[i].want;
      continue;
    }
    // Sorted by want, so every job left wants more than an equal share.
    for (let j = i; j < order.length; j++) budgets[order[j].index] = share;
    break;
  }
  return budgets;
}

function countStatuses(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return counts;
}

/**
 * @param {object} deps injected by mcpServerBridge (keeps this module testable)
 */
function createJobBulkHandler(deps) {
  const {
    getSessions,
    pendingSessionWriteApprovals,
    isChatSessionCancelled,
    preflightMainJobStart,
    preflightWorkerJobStart,
    startJobOnSession,
    pollJob,
    stopJob,
    requestApproval,
    sessionIdleManager,
    getLivePermission,
    USER_DENIED_MESSAGE,
    CHAT_SESSION_CANCELLED_MESSAGE,
    createBulkId = () => `bulk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    now = () => Date.now(),
  } = deps;
  const { resolveLabel, checkTargetSync } = createBulkTargetGuards(deps);

  /** bulkId -> { chatSessionId, createdAt, jobs: [{ jobId, sessionId, label }] } */
  const bulkEntries = new Map();

  function pruneBulkEntries() {
    const cutoff = now() - BULK_ENTRY_MAX_AGE_MS;
    for (const [bulkId, entry] of bulkEntries) {
      if (entry.createdAt < cutoff) bulkEntries.delete(bulkId);
    }
    // Oldest first (Map keeps insertion order).
    while (bulkEntries.size > MAX_BULK_ENTRIES) {
      bulkEntries.delete(bulkEntries.keys().next().value);
    }
  }

  /** Same isolation as a single job: a bulkId is only visible to the chat that created it. */
  function getBulkEntry(bulkId, chatSessionId) {
    pruneBulkEntries();
    const entry = bulkEntries.get(bulkId);
    if (!entry) return null;
    if (entry.chatSessionId && entry.chatSessionId !== (chatSessionId || null)) return null;
    return entry;
  }

  async function checkTargetTransport(sessionId, label, ctx, { probe = true } = {}) {
    const hasMainSession = Boolean(getSessions()?.get?.(sessionId));
    const probeParams = {
      sessionId,
      command: ctx.command,
      chatSessionId: ctx.chatSessionId,
      scopedSessionIds: ctx.scopedSessionIds,
    };
    let outcome;
    try {
      outcome = hasMainSession
        ? await preflightMainJobStart(probeParams, { probe })
        : await preflightWorkerJobStart(probeParams, { probe });
    } catch (err) {
      outcome = { ok: false, error: err?.message || String(err) };
    }
    if (outcome && outcome.ok === false) {
      return { sessionId, label, error: outcome.error || "Session does not support background execution" };
    }
    return null;
  }

  async function preflightAll(ctx, { probe = true } = {}) {
    const failures = new Array(ctx.sessionIds.length).fill(null);
    const pending = [];
    ctx.sessionIds.forEach((sessionId, index) => {
      const syncFailure = checkTargetSync(sessionId, ctx, { includePendingWrite: true });
      if (syncFailure) {
        failures[index] = syncFailure;
        return;
      }
      pending.push(checkTargetTransport(sessionId, resolveLabel(sessionId, ctx.chatSessionId), ctx, { probe })
        .then((failure) => { failures[index] = failure; }));
    });
    await Promise.all(pending);
    return failures.filter(Boolean);
  }

  function preflightFailureResult(failures, total) {
    return { ok: false, code: "BULK_PREFLIGHT_FAILED", error: formatPreflightFailure(failures, total) };
  }

  /**
   * @param {object} params RPC params (command, sessionIds, chatSessionId, scopedSessionIds)
   * @param {object} approvalContext transport context (externalSocket, beforeExecute)
   * @param {{ requiresApproval?: boolean }} permission result of the permission check
   */
  async function start(params, approvalContext = {}, permission = {}) {
    const parsed = parseBulkExecParams(params, { singleTool: "terminal_start" });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const { command, sessionIds } = parsed;
    const chatSessionId = params?.chatSessionId || null;
    const ctx = { command, sessionIds, chatSessionId, scopedSessionIds: params?.scopedSessionIds };

    // Phase 1: preflight. Nothing is started. When a prompt is coming, nothing may touch
    // the remote hosts before the user answers, so shell-kind probes wait until after approval.
    const approvalRequired = permission.requiresApproval === true;
    const failures = await preflightAll(ctx, { probe: !approvalRequired });
    if (failures.length > 0) return preflightFailureResult(failures, sessionIds.length);

    // Claim every target synchronously so no other command can slip in while the user decides.
    const claimConflicts = sessionIds
      .filter((sessionId) => pendingSessionWriteApprovals.has(sessionId))
      .map((sessionId) => ({ sessionId, label: resolveLabel(sessionId, chatSessionId), error: CLAIM_CONFLICT_ERROR }));
    if (claimConflicts.length > 0) return preflightFailureResult(claimConflicts, sessionIds.length);
    for (const sessionId of sessionIds) pendingSessionWriteApprovals.set(sessionId, BULK_START_RPC_METHOD);
    // Keep the sessions from idle auto-close until the jobs exist; a running job then does.
    const activeSessionIds = sessionIds.filter((sessionId) => sessionIdleManager.beginActivity(chatSessionId, sessionId));

    let approvalGranted = false;
    try {
      // Phase 2: one approval listing every host, never satisfied by grants or session approval.
      if (approvalRequired) {
        const approved = await requestApproval(
          BULK_START_RPC_METHOD,
          {
            command,
            sessions: sessionIds.map((sessionId) => labelPart(sessionId, resolveLabel(sessionId, chatSessionId))),
          },
          chatSessionId,
          { ...approvalContext, requireFreshApproval: true },
        );
        if (!approved) return { ok: false, error: USER_DENIED_MESSAGE };
        approvalGranted = true;
      }

      // Phase 3: commit. Local guards first, so a call that is no longer authorized never
      // causes a remote probe.
      const localGuards = () => {
        if (isChatSessionCancelled(chatSessionId)) return { ok: false, error: CHAT_SESSION_CANCELLED_MESSAGE };
        const live = typeof getLivePermission === "function" ? getLivePermission(params) : null;
        if (live) {
          if (live.allowed === false) return { ok: false, error: live.error };
          if (live.requiresApproval === true && !approvalGranted) {
            return {
              ok: false,
              error: "The permission mode changed to confirm while this call was pending. Run it again to be asked for approval.",
            };
          }
        }
        const recheck = sessionIds
          .map((sessionId) => checkTargetSync(sessionId, ctx, { includePendingWrite: false }))
          .filter(Boolean);
        if (recheck.length > 0) return preflightFailureResult(recheck, sessionIds.length);
        try {
          approvalContext.beforeExecute?.();
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        }
        return null;
      };
      const staleBeforeProbe = localGuards();
      if (staleBeforeProbe) return staleBeforeProbe;

      const staleTransport = (await Promise.all(sessionIds.map((sessionId) => (
        checkTargetTransport(sessionId, resolveLabel(sessionId, chatSessionId), ctx, { probe: true })
      )))).filter(Boolean);
      if (staleTransport.length > 0) return preflightFailureResult(staleTransport, sessionIds.length);

      // That pass awaited, so check the local guards again; the start loop is synchronous.
      const staleAfterProbe = localGuards();
      if (staleAfterProbe) return staleAfterProbe;

      const labels = new Map(sessionIds.map((sessionId) => [sessionId, resolveLabel(sessionId, chatSessionId)]));
      const results = await Promise.all(sessionIds.map((sessionId) => {
        let started;
        try {
          started = Promise.resolve(startJobOnSession(
            { sessionId, command, chatSessionId, scopedSessionIds: params?.scopedSessionIds },
            approvalContext.beforeExecute,
          ));
        } catch (err) {
          started = Promise.resolve({ ok: false, error: err?.message || String(err) });
        }
        return started.catch((err) => ({ ok: false, error: err?.message || String(err) }));
      }));

      const jobs = sessionIds.map((sessionId, index) => {
        const result = results[index] || {};
        const label = labels.get(sessionId) || "";
        if (result.ok && result.jobId) {
          return { sessionId, label, jobId: result.jobId, status: result.status || "running" };
        }
        return { sessionId, label, status: "not_started", error: result.error || "Background job did not start" };
      });
      const startedJobs = jobs.filter((job) => job.jobId);
      if (startedJobs.length === 0) {
        const detail = jobs.map((job) => `- ${labelPart(job.sessionId, job.label)}: ${job.error}`).join("\n");
        return { ok: false, code: "BULK_NOT_STARTED", error: `No background job was started.\n${detail}` };
      }

      pruneBulkEntries();
      const bulkId = createBulkId();
      bulkEntries.set(bulkId, {
        chatSessionId,
        createdAt: now(),
        jobs: startedJobs.map(({ jobId, sessionId, label }) => ({ jobId, sessionId, label })),
      });
      pruneBulkEntries();
      return {
        ok: true,
        bulkId,
        hostCount: sessionIds.length,
        counts: countStatuses(jobs),
        jobs,
        recommendedPollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      };
    } finally {
      for (const sessionId of activeSessionIds) sessionIdleManager.endActivity(chatSessionId, sessionId);
      for (const sessionId of sessionIds) {
        if (pendingSessionWriteApprovals.get(sessionId) === BULK_START_RPC_METHOD) {
          pendingSessionWriteApprovals.delete(sessionId);
        }
      }
    }
  }

  /** Jobs for a poll/stop call, each with the label recorded at start when known. */
  function resolveTargetJobs(params) {
    const targets = parseJobTargets(params);
    if (!targets.ok) return targets;
    const chatSessionId = params?.chatSessionId || null;
    if (targets.bulkId) {
      const entry = getBulkEntry(targets.bulkId, chatSessionId);
      if (!entry) {
        return {
          ok: false,
          error: `Bulk job set "${targets.bulkId}" was not found. It may have expired; poll or stop the jobs by jobIds instead.`,
        };
      }
      return { ok: true, bulkId: targets.bulkId, jobs: entry.jobs };
    }
    return { ok: true, bulkId: null, jobs: targets.jobIds.map((jobId) => ({ jobId, sessionId: null, label: "" })) };
  }

  function jobScopeParams(params, jobId, offset) {
    return {
      jobId,
      chatSessionId: params?.chatSessionId || null,
      scopedSessionIds: params?.scopedSessionIds,
      ...(offset !== undefined ? { offset } : {}),
    };
  }

  async function callSafely(fn, args) {
    try {
      return await fn(args);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function jobLabel(job, result, chatSessionId) {
    if (job.label) return job.label;
    return result?.sessionId ? resolveLabel(result.sessionId, chatSessionId) : "";
  }

  function unavailableEntry(job, result, fallback = null, chatSessionId = null) {
    return {
      jobId: job.jobId,
      sessionId: job.sessionId || fallback?.sessionId || undefined,
      label: (fallback ? jobLabel(job, fallback, chatSessionId) : job.label) || undefined,
      status: "unavailable",
      error: result?.error || "Background job not found",
    };
  }

  /**
   * Read one job's output, keeping at most `budget` characters of new output (the
   * newest). The budget is applied by polling from a later offset, so the existing
   * poll slices the raw buffer and collapses progress redraws itself and nextOffset
   * stays exact.
   */
  async function readJobOutput(params, job, peek, requestedOffset, budget) {
    const chatSessionId = params?.chatSessionId || null;
    const end = Number(peek.nextOffset) || 0;
    const fromOffset = Math.max(requestedOffset, end - budget);
    const result = fromOffset >= end
      ? peek
      : await callSafely(pollJob, jobScopeParams(params, job.jobId, fromOffset));
    if (!result || result.ok === false) return unavailableEntry(job, result, peek, chatSessionId);
    let output = typeof result.output === "string" ? result.output : "";
    // Output that arrived between the two polls can push past the budget; keep the newest.
    let trimmed = 0;
    if (output.length > budget) {
      trimmed = output.length - budget;
      output = output.slice(trimmed);
    }
    // Output older than the job's kept window is gone too.
    const effectiveStart = Math.max(fromOffset, Number(result.outputBaseOffset) || 0);
    const skippedChars = Math.max(0, effectiveStart - requestedOffset) + trimmed;
    const entry = {
      jobId: job.jobId,
      sessionId: result.sessionId || job.sessionId,
      label: jobLabel(job, result, chatSessionId),
      status: result.status,
      exitCode: result.exitCode ?? null,
      nextOffset: result.nextOffset,
      output,
    };
    if (result.error) entry.error = result.error;
    if (skippedChars > 0) entry.skippedChars = skippedChars;
    return entry;
  }

  async function poll(params = {}) {
    const resolved = resolveTargetJobs(params);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const offsets = parseOffsets(params?.offsets);
    if (!offsets.ok) return { ok: false, error: offsets.error };
    const chatSessionId = params?.chatSessionId || null;
    const requested = resolved.jobs.map((job) => offsets.offsets.get(job.jobId) || 0);
    // Peek first: no output, just where each job ends, so the budget can follow need.
    const peeks = await Promise.all(resolved.jobs.map((job) => (
      callSafely(pollJob, jobScopeParams(params, job.jobId, PEEK_OFFSET))
    )));
    const needs = peeks.map((peek, index) => {
      if (!peek || peek.ok === false) return 0;
      const start = Math.max(requested[index], Number(peek.outputBaseOffset) || 0);
      return Math.max(0, (Number(peek.nextOffset) || 0) - start);
    });
    const budgets = allocatePollBudgets(needs, MAX_POLL_CHARS_PER_JOB, MAX_POLL_TOTAL_CHARS);
    const jobs = await Promise.all(resolved.jobs.map((job, index) => {
      const peek = peeks[index];
      if (!peek || peek.ok === false) return unavailableEntry(job, peek, null, chatSessionId);
      return readJobOutput(params, job, peek, requested[index], budgets[index]);
    }));
    const counts = countStatuses(jobs);
    const running = (counts.running || 0) + (counts.stopping || 0);
    return {
      ok: true,
      ...(resolved.bulkId ? { bulkId: resolved.bulkId } : {}),
      jobCount: jobs.length,
      allCompleted: running === 0,
      counts,
      jobs,
      recommendedPollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    };
  }

  async function stop(params = {}) {
    const resolved = resolveTargetJobs(params);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const chatSessionId = params?.chatSessionId || null;
    const jobs = await Promise.all(resolved.jobs.map(async (job) => {
      const result = await callSafely(stopJob, jobScopeParams(params, job.jobId));
      if (!result || result.ok === false) {
        return {
          jobId: job.jobId,
          sessionId: job.sessionId || undefined,
          label: job.label || undefined,
          status: "unavailable",
          error: result?.error || "Background job not found",
        };
      }
      const entry = {
        jobId: job.jobId,
        sessionId: result.sessionId || job.sessionId,
        label: jobLabel(job, result, chatSessionId),
        status: result.status,
        exitCode: result.exitCode ?? null,
      };
      if (result.error) entry.error = result.error;
      return entry;
    }));
    return {
      ok: true,
      ...(resolved.bulkId ? { bulkId: resolved.bulkId } : {}),
      jobCount: jobs.length,
      counts: countStatuses(jobs),
      jobs,
    };
  }

  return { start, poll, stop, _bulkEntries: bulkEntries };
}

module.exports = {
  BULK_ENTRY_MAX_AGE_MS,
  BULK_START_RPC_METHOD,
  MAX_BULK_ENTRIES,
  MAX_POLL_CHARS_PER_JOB,
  MAX_POLL_TOTAL_CHARS,
  PEEK_OFFSET,
  allocatePollBudgets,
  createJobBulkHandler,
  parseJobTargets,
  parseOffsets,
};
