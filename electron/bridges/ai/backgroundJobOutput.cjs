"use strict";

const DEFAULT_MAX_BACKGROUND_JOB_OUTPUT_CHARS = 256 * 1024;
const DEFAULT_BACKGROUND_JOB_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS = 30 * 1000;

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

function createOutputWindow(stdout, maxOutputChars = DEFAULT_MAX_BACKGROUND_JOB_OUTPUT_CHARS) {
  const fullText = String(stdout || "");
  const totalOutputChars = fullText.length;
  const outputBaseOffset = Math.max(0, totalOutputChars - maxOutputChars);
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

function storeCompletedJobOutput(
  job,
  stdout,
  metadata = null,
  maxOutputChars = DEFAULT_MAX_BACKGROUND_JOB_OUTPUT_CHARS,
) {
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
  const window = createOutputWindow(stdout, maxOutputChars);
  job.stdout = window.stdout;
  job.outputBaseOffset = window.outputBaseOffset;
  job.totalOutputChars = window.totalOutputChars;
  job.outputTruncated = window.outputTruncated;
  job.handle = null;
}

function pruneCompletedBackgroundJobs(
  backgroundJobs,
  now = Date.now(),
  retentionMs = DEFAULT_BACKGROUND_JOB_RETENTION_MS,
) {
  for (const [jobId, job] of backgroundJobs) {
    if (job.status === "running" || job.status === "stopping") continue;
    const updatedAt = Number(job.updatedAt) || 0;
    if (updatedAt > 0 && now - updatedAt > retentionMs) {
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
  const parts = [];
  let segStart = 0;
  let lastSegStart = 0;
  let lastSegEnd = 0;
  const len = text.length;

  for (let i = 0; i < len; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      if (i > segStart) {
        lastSegStart = segStart;
        lastSegEnd = i;
      }
      segStart = i + 1;
    } else if (code === 10) {
      if (i > segStart) {
        parts.push(text.slice(segStart, i + 1));
      } else if (lastSegEnd > lastSegStart) {
        parts.push(text.slice(lastSegStart, lastSegEnd), "\n");
      } else {
        parts.push("\n");
      }
      segStart = i + 1;
      lastSegStart = segStart;
      lastSegEnd = segStart;
    }
  }

  if (len > segStart) {
    parts.push(text.slice(segStart, len));
  } else if (lastSegEnd > lastSegStart) {
    parts.push(text.slice(lastSegStart, lastSegEnd));
  }

  return parts.join("");
}

function serializeBackgroundJob(
  job,
  offset = 0,
  pollIntervalMs = DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS,
) {
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
    ...(job.code ? { code: job.code } : {}),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    output: collapseCarriageReturns(stdout.slice(relativeOffset)),
    nextOffset: totalOutputChars,
    totalOutputChars,
    outputBaseOffset,
    outputTruncated: Boolean(job.outputTruncated),
    recommendedPollIntervalMs: pollIntervalMs,
  };
}

module.exports = {
  DEFAULT_MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  DEFAULT_BACKGROUND_JOB_RETENTION_MS,
  DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS,
  readBackgroundJobSnapshot,
  createOutputWindow,
  refreshRunningJobSnapshot,
  storeCompletedJobOutput,
  pruneCompletedBackgroundJobs,
  collapseCarriageReturns,
  serializeBackgroundJob,
};
