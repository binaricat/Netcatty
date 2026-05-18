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

// Active log streams keyed by sessionId
const activeStreams = new Map();

// Buffer flush interval (ms)
const FLUSH_INTERVAL = 500;
// Max buffer size before immediate flush (bytes)
const MAX_BUFFER_SIZE = 64 * 1024;

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
 * @param {{ hostLabel: string, hostname: string, directory: string, format: string, startTime?: number }} opts
 * @returns {symbol|null} Token identifying this stream, or null if no
 *   stream was started (e.g. missing directory).
 */
function startStream(sessionId, opts) {
  if (activeStreams.has(sessionId)) {
    console.warn(`[SessionLogStream] Stream already active for ${sessionId}, stopping old one`);
    stopStream(sessionId);
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

    const writeStream = isRaw
      ? fs.createWriteStream(filePath, { flags: "w", encoding: "utf8" })
      : null;

    if (writeStream) {
      writeStream.on("error", (err) => {
        console.error(`[SessionLogStream] Write error for ${sessionId}:`, err.message);
        // Disable this stream on error to avoid cascading failures
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
      hostLabel: hostLabel || hostname || "unknown",
      startTime: startTime || Date.now(),
      buffer: "",
      flushTimer: null,
      snapshotPromise: null,
      snapshotRequested: false,
      snapshotDirty: false,
      closing: false,
      disabled: false,
      startToken,
    };

    // Start periodic flush
    entry.flushTimer = setInterval(() => {
      flushBuffer(entry);
    }, FLUSH_INTERVAL);

    activeStreams.set(sessionId, entry);
    console.log(`[SessionLogStream] Started stream for ${sessionId} -> ${filePath}`);
    return startToken;
  } catch (err) {
    console.error(`[SessionLogStream] Failed to start stream for ${sessionId}:`, err.message);
    return null;
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

function renderSnapshotContent(entry, { finalize = false } = {}) {
  if (finalize) entry.renderer.finish();
  const renderOptions = finalize ? undefined : { includePendingClearedScreen: true };
  return entry.isHtml
    ? wrapTerminalHtmlContent(entry.renderer.toHtmlContent(renderOptions), entry.hostLabel, entry.startTime)
    : entry.renderer.toString(renderOptions);
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

  entry.buffer += dataChunk;

  // Immediate flush if buffer is large
  if (entry.buffer.length >= MAX_BUFFER_SIZE) {
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
  activeStreams.delete(sessionId);
  entry.closing = true;

  // Stop periodic flush
  if (entry.flushTimer) {
    clearInterval(entry.flushTimer);
    entry.flushTimer = null;
  }

  // Flush remaining buffer
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
  return finalPath;
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
  const ids = [...activeStreams.keys()];
  await Promise.allSettled(ids.map(id => stopStream(id)));
}

module.exports = {
  startStream,
  appendData,
  stopStream,
  hasStream,
  cleanupAll,
};
