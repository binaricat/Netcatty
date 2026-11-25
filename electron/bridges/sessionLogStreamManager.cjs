/**
 * Session Log Stream Manager - Manages real-time log write streams per session
 * Writes terminal data to files in real-time instead of only on session close.
 * Fixes issue #394 where session logs only capture ~55 lines.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  safePathSegment,
  toLocalISOString,
  wrapTerminalHtmlContent,
} = require("./sessionLogsBridge.cjs");
const { createTerminalTextRenderer } = require("./terminalLogSanitizer.cjs");
const { createProgrammaticCommandLogRewriter } = require("./programmaticCommandLog.cjs");

// Active log streams keyed by sessionId
const activeStreams = new Map();
// Keep only the latest server-owned target for each session, including while
// finalization is in flight. Finished records retain no terminal/parser data.
const sessionLogs = new Map();

// Buffer flush interval (ms)
const FLUSH_INTERVAL = 500;
// A failed snapshot retries without waiting for more output, but not in a
// tight loop. The delay grows while the same failure persists.
const SNAPSHOT_RETRY_MIN_MS = 250;
const SNAPSHOT_RETRY_MAX_MS = 5000;
// Max buffer size before immediate flush (bytes)
const MAX_BUFFER_SIZE = 64 * 1024;
const SUDO_AUTOFILL_MARKER_PATTERN = /__NETCATTY_SUDO_[a-z0-9_]+__/gi;
const SUDO_AUTOFILL_REWRITE_PATTERN =
  /\x15?((?:builtin\s+|command\s+)?sudo)\s+-p\s+'\[sudo\] password for %p: (__NETCATTY_SUDO_[a-z0-9_]+__)'([^\r\n]*)(?:\r\n|\r|\n|$)/i;

function formatLogTimestamp(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  // Millisecond precision so sub-second timings stay visible in logs (#3414).
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function parseSudoAutofillRewrite(input) {
  if (!input || typeof input !== "string") return null;
  const match = input.match(SUDO_AUTOFILL_REWRITE_PATTERN);
  if (!match) return null;
  return {
    marker: match[2],
    preparedCommand: `${match[1]} -p '[sudo] password for %p: ${match[2]}'${match[3]}`,
    originalCommand: `${match[1]}${match[3]}`,
  };
}

function applySudoAutofillRewrites(entry, data) {
  if (!data || !entry.sudoAutofillRewrites?.length) return data;
  let nextData = data;
  for (const rewrite of entry.sudoAutofillRewrites) {
    nextData = nextData.replaceAll(rewrite.preparedCommand, rewrite.originalCommand);
    nextData = nextData.replaceAll(rewrite.marker, "");
  }
  return nextData.replace(SUDO_AUTOFILL_MARKER_PATTERN, "");
}

function isPotentialSudoAutofillCommandPending(entry, data) {
  if (!data) return true;
  return (entry.sudoAutofillRewrites ?? []).some((rewrite) =>
    rewrite.preparedCommand.startsWith(data) || data.startsWith(rewrite.preparedCommand)
  );
}

function hasSudoAutofillMarkerPrefix(entry, data) {
  if (!data) return false;
  return (entry.sudoAutofillRewrites ?? []).some((rewrite) => {
    const maxPrefixLength = Math.min(data.length, rewrite.marker.length - 1);
    for (let length = maxPrefixLength; length > 0; length -= 1) {
      if (data.endsWith(rewrite.marker.slice(0, length))) return true;
    }
    return false;
  });
}

function sanitizeSudoAutofillLogData(entry, dataChunk, { final = false } = {}) {
  if (!entry.sudoAutofillRewrites?.length) return dataChunk;
  entry.sudoAutofillPending += dataChunk;
  const lastLineBreakIndex = Math.max(
    entry.sudoAutofillPending.lastIndexOf("\n"),
    entry.sudoAutofillPending.lastIndexOf("\r"),
  );
  if (!final && lastLineBreakIndex < 0) {
    if (
      isPotentialSudoAutofillCommandPending(entry, entry.sudoAutofillPending) ||
      hasSudoAutofillMarkerPrefix(entry, entry.sudoAutofillPending)
    ) {
      return "";
    }
    const pending = entry.sudoAutofillPending;
    const sanitizedPending = applySudoAutofillRewrites(entry, pending);
    entry.sudoAutofillPending = "";
    return sanitizedPending;
  }
  const readyLength = final
    ? entry.sudoAutofillPending.length
    : lastLineBreakIndex + 1;
  const readyData = entry.sudoAutofillPending.slice(0, readyLength);
  entry.sudoAutofillPending = entry.sudoAutofillPending.slice(readyLength);
  return applySudoAutofillRewrites(entry, readyData);
}

/**
 * Start a log stream for a session.
 * Creates the log file and opens a write stream.
 *
 * Returns a unique token identifying the started stream. Callers should pass
 * this token to stopStream() so a late close handler from a previous
 * incarnation of the same sessionId (e.g. SSH conn.once('close') firing
 * after the user clicked "Restart" and a new stream is already running)
 * cannot accidentally tear down the fresh stream. Without the token check,
 * the same sessionId being recycled across reconnects would let stale stop
 * calls kill the new log file. See issue #916.
 *
 * @param {string} sessionId
 * @param {{ hostLabel: string, hostname: string, directory: string, format: string, startTime?: number, timestampsEnabled?: boolean, timestampProvider?: () => number }} opts
 * @returns {symbol|null} Token identifying this stream, or null if no
 *   stream was started (e.g. missing directory).
 */
function startStream(sessionId, opts) {
  if (activeStreams.has(sessionId)) {
    console.warn(`[SessionLogStream] Stream already active for ${sessionId}, stopping old one`);
    stopStream(sessionId, activeStreams.get(sessionId)?.startToken);
  }
  forgetSessionLog(sessionId);

  const { hostLabel, hostname, directory, format, startTime } = opts;
  if (!directory) {
    console.warn("[SessionLogStream] No directory specified, skipping");
    return null;
  }

  try {
    // Build file path: directory / hostSubdir / timestamp.ext
    const safeHostLabel = safePathSegment(hostLabel || hostname, "unknown");
    const hostDir = path.join(directory, safeHostLabel);
    fs.mkdirSync(hostDir, { recursive: true });

    const date = new Date(startTime || Date.now());
    const dateStr = toLocalISOString(date);
    // Raw logs are written directly. Txt/html logs keep terminal parser state
    // in memory and write the rendered file on each flush.
    const isRaw = format === "raw";
    const isHtml = format === "html";
    const ext = isRaw ? "log" : isHtml ? "html" : "txt";
    const fileName = `${dateStr}.${ext}`;
    const filePath = path.join(hostDir, fileName);

    return createStreamEntry(sessionId, {
      filePath,
      hostDir,
      format,
      hostLabel: hostLabel || hostname || "unknown",
      startTime: startTime || Date.now(),
      timestampsEnabled: opts.timestampsEnabled,
      timestampProvider: opts.timestampProvider,
    });
  } catch (err) {
    console.error(`[SessionLogStream] Failed to start stream for ${sessionId}:`, err.message);
    return null;
  }
}

function createStreamEntry(sessionId, opts) {
  const { filePath, hostDir, format, hostLabel, startTime } = opts;
  const isRaw = format === "raw";
  const isHtml = format === "html";
  const writeStream = isRaw
    ? fs.createWriteStream(filePath, { flags: "w", encoding: "utf8" })
    : null;

  const startToken = Symbol("session-log-stream");
  const entry = {
    writeStream,
    filePath,
    hostDir,
    format,
    isRaw,
    isHtml,
    renderer: isRaw ? null : createTerminalTextRenderer({
      alternateScreenActive: opts.alternateScreenActive === true,
    }),
    timestampProvider: !isRaw && opts.timestampsEnabled
      ? (opts.timestampProvider ?? Date.now)
      : null,
    timestampedChunks: [],
    lastArrivalTime: undefined,
    hostLabel,
    startTime,
    buffer: "",
    programmaticCommandLogRewriter: createProgrammaticCommandLogRewriter(),
    sudoAutofillRewrites: [],
    sudoAutofillPending: "",
    flushTimer: null,
    snapshotPromise: null,
    snapshotRequested: false,
    snapshotDirty: false,
    snapshotError: null,
    snapshotRetryTimer: null,
    snapshotRetryDelay: 0,
    // Set only while prepareSessionLog is waiting on a snapshot, so that
    // caller can observe the failure before the delayed retry starts.
    deferSnapshotRetry: false,
    error: null,
    closing: false,
    disabled: false,
    startToken,
    stopRequiresToken: Boolean(opts.stopRequiresToken),
    separateInitialLineBeforeLeadingCarriageReturn: false,
    pendingInitialLineLeadingCarriageReturn: false,
  };

  if (writeStream) {
    writeStream.on("error", (err) => {
      console.error(`[SessionLogStream] Write error for ${sessionId}:`, err.message);
      // A delayed error from an old connection must not disable a new stream.
      entry.disabled = true;
      entry.error = err;
      clearFlushTimer(entry);
    });
  }

  activeStreams.set(sessionId, entry);
  sessionLogs.set(sessionId, { entry, filePath, startToken, stopPromise: null, error: null });
  console.log(`[SessionLogStream] Started stream for ${sessionId} -> ${filePath}`);
  return startToken;
}

function startStreamToFile(sessionId, opts = {}) {
  if (activeStreams.has(sessionId)) {
    return { ok: false, error: "Stream already active for this session" };
  }

  const { filePath, hostLabel, startTime, initialLine } = opts;
  if (!filePath) {
    return { ok: false, error: "Missing filePath" };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const token = createStreamEntry(sessionId, {
      filePath,
      hostDir: path.dirname(filePath),
      format: opts.format || "raw",
      hostLabel: hostLabel || "session",
      startTime: startTime || Date.now(),
      timestampsEnabled: opts.timestampsEnabled,
      timestampProvider: opts.timestampProvider,
      stopRequiresToken: opts.stopRequiresToken,
      alternateScreenActive: opts.alternateScreenActive === true,
    });
    if (typeof initialLine === "string" && initialLine.length > 0) {
      appendData(sessionId, initialLine);
      const entry = activeStreams.get(sessionId);
      if (entry && opts.separateInitialLineBeforeLeadingCarriageReturn && !/[\r\n]$/.test(initialLine)) {
        entry.separateInitialLineBeforeLeadingCarriageReturn = true;
      }
    }
    return { ok: true, token };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function clearFlushTimer(entry) {
  if (!entry?.flushTimer) return;
  clearTimeout(entry.flushTimer);
  entry.flushTimer = null;
}

function scheduleFlush(entry) {
  if (!entry || entry.flushTimer || entry.disabled || entry.closing || entry.buffer.length === 0) {
    return;
  }
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    flushBuffer(entry);
  }, FLUSH_INTERVAL);
}

/**
 * Flush buffered data to the write stream.
 * @param {object} entry - The stream entry
 */
function flushBuffer(entry) {
  clearFlushTimer(entry);
  if (!entry || entry.disabled || entry.buffer.length === 0) return;

  try {
    const data = entry.buffer;
    entry.buffer = "";

    if (entry.isRaw) {
      entry.writeStream.write(data);
    } else {
      if (entry.timestampProvider) {
        for (const chunk of entry.timestampedChunks) {
          entry.renderer.feed(chunk.data, chunk.timestamp);
        }
        entry.timestampedChunks = [];
      } else {
        entry.renderer.feed(data);
      }
      entry.snapshotDirty = true;
      scheduleSnapshot(entry);
    }
  } catch (err) {
    console.error("[SessionLogStream] Flush error:", err.message);
    entry.disabled = true;
    entry.error = err;
    clearFlushTimer(entry);
  }
}

function registerSudoAutofillInput(sessionId, input) {
  const entry = activeStreams.get(sessionId);
  if (!entry || entry.disabled) return;
  const rewrite = parseSudoAutofillRewrite(input);
  if (!rewrite) return;
  entry.sudoAutofillRewrites.unshift(rewrite);
  entry.sudoAutofillRewrites = entry.sudoAutofillRewrites.slice(0, 8);
}

function registerProgrammaticCommandLogRewrite(sessionId, rewrite) {
  const entry = activeStreams.get(sessionId);
  if (!entry || entry.disabled) return;
  entry.programmaticCommandLogRewriter?.queueRewrite(rewrite);
}

function renderSnapshotContent(entry, { finalize = false } = {}) {
  if (finalize) entry.renderer.finish();
  const renderOptions = {
    includePendingClearedScreen: !finalize,
    formatLine: entry.timestampProvider
      ? (line, timestamp) => line ? `[${formatLogTimestamp(timestamp)}] ${line}` : line
      : undefined,
  };
  const renderedContent = entry.isHtml
    ? entry.renderer.toHtmlContent(renderOptions)
    : entry.renderer.toString(renderOptions);
  const content = renderedContent;
  return entry.isHtml
    ? wrapTerminalHtmlContent(content, entry.hostLabel, entry.startTime)
    : content;
}

function clearSnapshotRetry(entry) {
  if (!entry?.snapshotRetryTimer) return;
  clearTimeout(entry.snapshotRetryTimer);
  entry.snapshotRetryTimer = null;
}

function scheduleSnapshotRetry(entry) {
  if (!entry || entry.closing || entry.disabled || entry.isRaw || entry.snapshotRetryTimer) return;
  const delay = entry.snapshotRetryDelay || SNAPSHOT_RETRY_MIN_MS;
  entry.snapshotRetryTimer = setTimeout(() => {
    entry.snapshotRetryTimer = null;
    if (entry.closing || entry.disabled) return;
    scheduleSnapshot(entry);
  }, delay);
  entry.snapshotRetryDelay = Math.min(delay * 2, SNAPSHOT_RETRY_MAX_MS);
}

function scheduleSnapshot(entry) {
  if (!entry || entry.disabled || entry.isRaw || entry.closing) return;
  if (!entry.snapshotDirty) return;
  clearSnapshotRetry(entry);

  if (entry.snapshotPromise) {
    entry.snapshotRequested = true;
    return;
  }

  entry.snapshotDirty = false;
  entry.snapshotError = null;
  entry.snapshotPromise = fs.promises
    .writeFile(entry.filePath, renderSnapshotContent(entry), "utf8")
    .then(() => {
      entry.snapshotRetryDelay = 0;
    })
    .catch((err) => {
      console.error("[SessionLogStream] Snapshot write failed:", err.message);
      entry.snapshotDirty = true;
      entry.snapshotError = err;
    })
    .finally(() => {
      entry.snapshotPromise = null;
      // prepareSessionLog must see this failure. Other callers retry on a
      // delay, or sooner when new output is flushed.
      if (entry.snapshotError && entry.deferSnapshotRetry) return;
      if (!(entry.snapshotRequested || entry.snapshotDirty) || entry.closing) return;
      entry.snapshotRequested = false;
      if (entry.snapshotError) scheduleSnapshotRetry(entry);
      else scheduleSnapshot(entry);
    });
}

async function waitForSnapshotIdle(entry) {
  while (entry.snapshotPromise) {
    await entry.snapshotPromise;
  }
}

/**
 * Append data to the session's log buffer.
 * Data is flushed periodically or when the buffer exceeds MAX_BUFFER_SIZE.
 * @param {string} sessionId
 * @param {string} dataChunk - Decoded terminal data string
 */
function appendData(sessionId, dataChunk) {
  const entry = activeStreams.get(sessionId);
  if (!entry || entry.disabled) return;

  if (entry.pendingInitialLineLeadingCarriageReturn && dataChunk) {
    entry.pendingInitialLineLeadingCarriageReturn = false;
    dataChunk = dataChunk.startsWith("\n") ? `\r${dataChunk}` : `\n\r${dataChunk}`;
  } else if (entry.separateInitialLineBeforeLeadingCarriageReturn && dataChunk) {
    entry.separateInitialLineBeforeLeadingCarriageReturn = false;
    if (dataChunk === "\r") {
      entry.pendingInitialLineLeadingCarriageReturn = true;
      return;
    }
    if (dataChunk.startsWith("\r") && !dataChunk.startsWith("\r\n")) {
      dataChunk = `\n${dataChunk}`;
    }
  }

  appendBufferedData(entry, dataChunk);
}

function appendBufferedData(entry, dataChunk) {
  if (entry.timestampProvider && dataChunk) {
    entry.lastArrivalTime = entry.timestampProvider() ?? Date.now();
  }
  const readableData = entry.programmaticCommandLogRewriter
    ? entry.programmaticCommandLogRewriter.append(dataChunk)
    : dataChunk;
  bufferReadableData(entry, sanitizeSudoAutofillLogData(entry, readableData));

  // Immediate flush if buffer is large
  if (entry.buffer.length + entry.sudoAutofillPending.length >= MAX_BUFFER_SIZE) {
    flushBuffer(entry);
  }

  // Schedule a one-shot flush only when buffered data remains.
  if (entry.buffer.length > 0 && !entry.flushTimer && !entry.disabled && !entry.closing) {
    scheduleFlush(entry);
  }
}

// Preserve each sanitized chunk's receipt time through the periodic disk flush.
// A command held by a rewriter uses the time of the chunk that completes it.
function bufferReadableData(entry, data) {
  if (!data) return;
  entry.buffer += data;
  if (entry.timestampProvider) {
    entry.timestampedChunks.push({ data, timestamp: entry.lastArrivalTime });
  }
}

/**
 * Stop the log stream for a session.
 * Flushes remaining data, closes the write stream, and finalizes the file.
 *
 * If `expectedToken` is provided, the stop is only honoured when it matches
 * the active stream's start token. This protects against stale close
 * handlers from a previous incarnation of the same sessionId (e.g. an SSH
 * connection's `conn.once('close')` firing after the user has already
 * clicked "Restart" and a fresh stream has been started). Without this
 * guard, the stale handler would silently destroy the new session's log.
 * See issue #916.
 *
 * @param {string} sessionId
 * @param {symbol} [expectedToken] - Token returned by startStream()
 * @returns {Promise<string|null>} The final file path, or null if no
 *   matching stream was active.
 */
async function stopStream(sessionId, expectedToken) {
  const entry = activeStreams.get(sessionId);
  if (!entry) return null;
  if (expectedToken && entry.startToken !== expectedToken) {
    // Stale stop call from a previous session that reused this sessionId.
    // The current stream belongs to a fresh incarnation; leave it alone.
    return null;
  }
  if (entry.stopRequiresToken && !expectedToken) {
    return null;
  }
  activeStreams.delete(sessionId);
  entry.closing = true;

  const record = sessionLogs.get(sessionId);
  const stopPromise = finalizeStream(sessionId, entry);
  if (record?.entry === entry) record.stopPromise = stopPromise;
  const finalPath = await stopPromise;
  if (record?.entry === entry) {
    record.entry = null;
    record.stopPromise = null;
    record.error = finalPath ? null : (entry.error || new Error("Failed to finalize session log"));
  }
  return finalPath;
}

async function finalizeStream(sessionId, entry) {
  clearSnapshotRetry(entry);

  // Stop pending flush
  clearFlushTimer(entry);

  // Flush remaining buffer
  if (entry.pendingInitialLineLeadingCarriageReturn) {
    entry.pendingInitialLineLeadingCarriageReturn = false;
    appendBufferedData(entry, "\n\r");
  }
  const readablePending = entry.programmaticCommandLogRewriter?.finish();
  if (readablePending) {
    bufferReadableData(entry, sanitizeSudoAutofillLogData(entry, readablePending));
  }
  bufferReadableData(entry, sanitizeSudoAutofillLogData(entry, "", { final: true }));
  flushBuffer(entry);
  await waitForSnapshotIdle(entry);

  // Close the raw write stream and wait for it to finish. A flush that
  // already disabled the entry must still end the stream, or the fd leaks.
  if (entry.writeStream) {
    let closeError = null;
    try {
      await new Promise((resolve, reject) => {
        entry.writeStream.end((err) => err ? reject(err) : resolve());
      });
    } catch (err) {
      closeError = err;
    }
    if (entry.disabled || closeError) {
      entry.disabled = true;
      entry.error = entry.error || closeError || new Error("Session log stream failed");
    }
  } else if (!entry.disabled) {
    try {
      await fs.promises.writeFile(entry.filePath, renderSnapshotContent(entry, { finalize: true }), "utf8");
      entry.snapshotDirty = false;
    } catch (err) {
      console.error(`[SessionLogStream] Final snapshot write failed for ${sessionId}:`, err.message);
      entry.disabled = true;
      entry.error = err;
    }
  }

  const finalPath = entry.filePath;

  console.log(`[SessionLogStream] Stopped stream for ${sessionId} -> ${finalPath}`);
  return entry.disabled ? null : finalPath;
}

/** Flush the session's current log without ending recording, or return its
 * last finalized log. Paths are never inferred from labels or renderer input.
 */
async function prepareSessionLog(sessionId) {
  const record = sessionLogs.get(sessionId);
  if (!record) return null;

  if (record.stopPromise) {
    await record.stopPromise;
  } else if (record.entry) {
    const entry = record.entry;
    if (entry.disabled) throw entry.error || new Error("Session log stream failed");
    flushBuffer(entry);
    if (entry.disabled) throw entry.error || new Error("Failed to flush session log");
    if (entry.isRaw) {
      // An empty write is a barrier for all earlier writes, not just the
      // manager's buffer. Calling write() alone does not make the file ready.
      await new Promise((resolve, reject) => {
        entry.writeStream.write("", (err) => err ? reject(err) : resolve());
      });
    } else {
      // Also materialize an empty txt/html log before its first output arrives.
      // Hold the retry until this wait returns, then resume on the backoff timer.
      entry.snapshotDirty = true;
      entry.deferSnapshotRetry = true;
      try {
        scheduleSnapshot(entry);
        await waitForSnapshotIdle(entry);
        if (entry.snapshotError) throw entry.snapshotError;
      } finally {
        entry.deferSnapshotRetry = false;
        if (!entry.snapshotPromise && !entry.closing
          && (entry.snapshotRequested || entry.snapshotDirty)) {
          if (entry.snapshotError) scheduleSnapshotRetry(entry);
          else scheduleSnapshot(entry);
        }
      }
    }
    // Stop may have begun while the flush was pending; wait for its final file.
    if (record.stopPromise) await record.stopPromise;
  }

  if (sessionLogs.get(sessionId) !== record) {
    throw new Error("Session log changed; try again");
  }
  if (record.error || record.entry?.disabled) {
    throw record.error || record.entry.error || new Error("Session log stream failed");
  }
  const stat = await fs.promises.stat(record.filePath);
  if (!stat.isFile()) throw new Error("Session log is not a file");
  if (sessionLogs.get(sessionId) !== record) {
    throw new Error("Session log changed; try again");
  }
  return record.filePath;
}

/** Invalidate a previous connection's target without disturbing its writer.
 * Late finalization cannot restore it because records are identity-scoped.
 */
function forgetSessionLog(sessionId) {
  sessionLogs.delete(sessionId);
}

function getSessionLogToken(sessionId) {
  return sessionLogs.get(sessionId)?.startToken ?? null;
}

/** Drop only the inactive target observed before an asynchronous reconnect.
 * A continuing manual stream or a newly-created/finalized log must survive.
 */
function forgetInactiveSessionLog(sessionId, expectedToken) {
  if (!expectedToken || activeStreams.has(sessionId)
    || getSessionLogToken(sessionId) !== expectedToken) return false;
  return sessionLogs.delete(sessionId);
}

/** Main-process fallback starts do not pass through the worker's lifecycle
 * guard. Retire their prior inactive log only after a successful same-id start.
 */
function withSessionLogRestart(handler) {
  return async (event, payload) => {
    const sessionId = payload?.sessionId;
    const previousToken = getSessionLogToken(sessionId);
    const result = await handler(event, payload);
    if (sessionId && result?.sessionId === sessionId && result.success !== false && !result.error) {
      forgetInactiveSessionLog(sessionId, previousToken);
    }
    return result;
  };
}

function hasSessionLog(sessionId) {
  return sessionLogs.has(sessionId);
}

/**
 * Check if a session has an active log stream.
 * @param {string} sessionId
 * @returns {boolean}
 */
function hasStream(sessionId) {
  return activeStreams.has(sessionId);
}

/**
 * Absolute paths of files currently open by active log streams.
 * Used by clear-all so it never unlinks a live write target.
 * @returns {string[]}
 */
function getActiveLogPaths() {
  const paths = [];
  for (const entry of activeStreams.values()) {
    if (!entry?.filePath || entry.disabled) continue;
    paths.push(path.resolve(entry.filePath));
  }
  return paths;
}

/**
 * Cleanup all active streams (called on app quit).
 */
async function cleanupAll() {
  console.log(`[SessionLogStream] Cleaning up ${activeStreams.size} active streams`);
  const entries = [...activeStreams.entries()];
  await Promise.allSettled(entries.map(([id, entry]) => stopStream(id, entry.startToken)));
  sessionLogs.clear();
}

module.exports = {
  startStream,
  startStreamToFile,
  appendData,
  registerSudoAutofillInput,
  registerProgrammaticCommandLogRewrite,
  stopStream,
  prepareSessionLog,
  forgetSessionLog,
  getSessionLogToken,
  forgetInactiveSessionLog,
  withSessionLogRestart,
  hasSessionLog,
  hasStream,
  getActiveLogPaths,
  cleanupAll,
};
