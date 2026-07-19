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

// Buffer flush interval (ms)
const FLUSH_INTERVAL = 500;
// Max buffer size before immediate flush (bytes)
const MAX_BUFFER_SIZE = 64 * 1024;
const SUDO_AUTOFILL_MARKER_PATTERN = /__NETCATTY_SUDO_[a-z0-9_]+__/gi;
const SUDO_AUTOFILL_REWRITE_PATTERN =
  /\x15?((?:builtin\s+|command\s+)?sudo)\s+-p\s+'\[sudo\] password for %p: (__NETCATTY_SUDO_[a-z0-9_]+__)'([^\r\n]*)(?:\r\n|\r|\n|$)/i;

function formatLogTimestamp(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function createRenderedLineTimestampPrefixer(opts = {}) {
  const timestampProvider = typeof opts.timestampProvider === "function"
    ? opts.timestampProvider
    : Date.now;
  const timestampsByLine = [];
  const contentByLine = [];

  return (content) => {
    if (!content) return "";

    const lines = content.split("\n");
    timestampsByLine.length = lines.length;
    contentByLine.length = lines.length;

    return lines.map((line, index) => {
      if (line.length === 0 && index === lines.length - 1 && content.endsWith("\n")) {
        return line;
      }

      if (contentByLine[index] !== line) {
        contentByLine[index] = line;
        timestampsByLine[index] = timestampProvider() ?? Date.now();
      }

      return line.length === 0
        ? line
        : `[${formatLogTimestamp(timestampsByLine[index])}] ${line}`;
    }).join("\n");
  };
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

  if (writeStream) {
    writeStream.on("error", (err) => {
      console.error(`[SessionLogStream] Write error for ${sessionId}:`, err.message);
      const entry = activeStreams.get(sessionId);
      if (entry) {
        entry.disabled = true;
      }
    });
  }

  const startToken = Symbol("session-log-stream");
  const entry = {
    writeStream,
    filePath,
    hostDir,
    format,
    isRaw,
    isHtml,
    renderer: isRaw ? null : createTerminalTextRenderer(),
    renderedTimestampPrefixer: !isRaw && opts.timestampsEnabled
      ? createRenderedLineTimestampPrefixer({ timestampProvider: opts.timestampProvider })
      : null,
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
    closing: false,
    disabled: false,
    startToken,
    stopRequiresToken: Boolean(opts.stopRequiresToken),
    separateInitialLineBeforeLeadingCarriageReturn: false,
    pendingInitialLineLeadingCarriageReturn: false,
  };

  entry.flushTimer = setInterval(() => {
    flushBuffer(entry);
  }, FLUSH_INTERVAL);

  activeStreams.set(sessionId, entry);
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

/**
 * Flush buffered data to the write stream.
 * @param {object} entry - The stream entry
 */
function flushBuffer(entry) {
  if (!entry || entry.disabled || entry.buffer.length === 0) return;

  try {
    const data = entry.buffer;
    entry.buffer = "";

    if (entry.isRaw) {
      entry.writeStream.write(data);
    } else {
      entry.renderer.feed(data);
      entry.snapshotDirty = true;
      scheduleSnapshot(entry);
    }
  } catch (err) {
    console.error("[SessionLogStream] Flush error:", err.message);
    entry.disabled = true;
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
  const renderOptions = finalize ? undefined : { includePendingClearedScreen: true };
  const renderedContent = entry.isHtml
    ? entry.renderer.toHtmlContent(renderOptions)
    : entry.renderer.toString(renderOptions);
  const content = entry.renderedTimestampPrefixer
    ? entry.renderedTimestampPrefixer(renderedContent)
    : renderedContent;
  return entry.isHtml
    ? wrapTerminalHtmlContent(content, entry.hostLabel, entry.startTime)
    : content;
}

function scheduleSnapshot(entry) {
  if (!entry || entry.disabled || entry.isRaw || entry.closing) return;
  if (!entry.snapshotDirty) return;

  if (entry.snapshotPromise) {
    entry.snapshotRequested = true;
    return;
  }

  entry.snapshotDirty = false;
  entry.snapshotPromise = fs.promises
    .writeFile(entry.filePath, renderSnapshotContent(entry), "utf8")
    .catch((err) => {
      console.error("[SessionLogStream] Snapshot write failed:", err.message);
      entry.snapshotDirty = true;
    })
    .finally(() => {
      entry.snapshotPromise = null;
      if ((entry.snapshotRequested || entry.snapshotDirty) && !entry.closing) {
        entry.snapshotRequested = false;
        scheduleSnapshot(entry);
      }
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
  const readableData = entry.programmaticCommandLogRewriter
    ? entry.programmaticCommandLogRewriter.append(dataChunk)
    : dataChunk;
  entry.buffer += sanitizeSudoAutofillLogData(entry, readableData);

  // Immediate flush if buffer is large
  if (entry.buffer.length + entry.sudoAutofillPending.length >= MAX_BUFFER_SIZE) {
    flushBuffer(entry);
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

  // Stop periodic flush
  if (entry.flushTimer) {
    clearInterval(entry.flushTimer);
    entry.flushTimer = null;
  }

  // Flush remaining buffer
  if (entry.pendingInitialLineLeadingCarriageReturn) {
    entry.pendingInitialLineLeadingCarriageReturn = false;
    appendBufferedData(entry, "\n\r");
  }
  const readablePending = entry.programmaticCommandLogRewriter?.finish();
  if (readablePending) {
    entry.buffer += sanitizeSudoAutofillLogData(entry, readablePending);
  }
  entry.buffer += sanitizeSudoAutofillLogData(entry, "", { final: true });
  flushBuffer(entry);
  await waitForSnapshotIdle(entry);

  // Close the raw write stream and wait for it to finish.
  if (entry.writeStream) {
    await new Promise((resolve) => {
      entry.writeStream.end(resolve);
    });
  } else if (!entry.disabled) {
    try {
      await fs.promises.writeFile(entry.filePath, renderSnapshotContent(entry, { finalize: true }), "utf8");
      entry.snapshotDirty = false;
    } catch (err) {
      console.error(`[SessionLogStream] Final snapshot write failed for ${sessionId}:`, err.message);
      entry.disabled = true;
    }
  }

  const finalPath = entry.filePath;

  console.log(`[SessionLogStream] Stopped stream for ${sessionId} -> ${finalPath}`);
  return entry.disabled ? null : finalPath;
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
 * Cleanup all active streams (called on app quit).
 */
async function cleanupAll() {
  console.log(`[SessionLogStream] Cleaning up ${activeStreams.size} active streams`);
  const entries = [...activeStreams.entries()];
  await Promise.allSettled(entries.map(([id, entry]) => stopStream(id, entry.startToken)));
}

module.exports = {
  startStream,
  startStreamToFile,
  appendData,
  registerSudoAutofillInput,
  registerProgrammaticCommandLogRewrite,
  stopStream,
  hasStream,
  cleanupAll,
};
