/**
 * Session Log Stream Manager - Manages real-time log write streams per session
 * Writes terminal data to files in real-time instead of only on session close.
 * Fixes issue #394 where session logs only capture ~55 lines.
 */

const fs = require("node:fs");
const path = require("node:path");
const { stripAnsi, terminalDataToHtml } = require("./sessionLogsBridge.cjs");

// Active log streams keyed by sessionId
const activeStreams = new Map();

// Buffer flush interval (ms)
const FLUSH_INTERVAL = 500;
// Max buffer size before immediate flush (bytes)
const MAX_BUFFER_SIZE = 64 * 1024;

/**
 * Start a log stream for a session.
 * Creates the log file and opens a write stream.
 * @param {string} sessionId
 * @param {{ hostLabel: string, hostname: string, directory: string, format: string, startTime?: number }} opts
 */
function startStream(sessionId, opts) {
  if (activeStreams.has(sessionId)) {
    console.warn(`[SessionLogStream] Stream already active for ${sessionId}, stopping old one`);
    stopStream(sessionId);
  }

  const { hostLabel, hostname, directory, format, startTime } = opts;
  if (!directory) {
    console.warn("[SessionLogStream] No directory specified, skipping");
    return;
  }

  try {
    // Build file path: directory / hostSubdir / timestamp.ext
    const safeHostLabel = (hostLabel || hostname || "unknown").replace(/[^a-zA-Z0-9-_]/g, "_");
    const hostDir = path.join(directory, safeHostLabel);
    fs.mkdirSync(hostDir, { recursive: true });

    const date = new Date(startTime || Date.now());
    const dateStr = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // For html format, write raw data to a temp file during streaming,
    // then convert on stopStream.
    const isHtml = format === "html";
    const ext = isHtml ? "log.tmp" : format === "raw" ? "log" : "txt";
    const fileName = `${dateStr}.${ext}`;
    const filePath = path.join(hostDir, fileName);

    const writeStream = fs.createWriteStream(filePath, { flags: "w", encoding: "utf8" });

    writeStream.on("error", (err) => {
      console.error(`[SessionLogStream] Write error for ${sessionId}:`, err.message);
      // Disable this stream on error to avoid cascading failures
      const entry = activeStreams.get(sessionId);
      if (entry) {
        entry.disabled = true;
      }
    });

    const entry = {
      writeStream,
      filePath,
      hostDir,
      format,
      isHtml,
      hostLabel: hostLabel || hostname || "unknown",
      startTime: startTime || Date.now(),
      buffer: "",
      flushTimer: null,
      disabled: false,
    };

    // Start periodic flush
    entry.flushTimer = setInterval(() => {
      flushBuffer(entry);
    }, FLUSH_INTERVAL);

    activeStreams.set(sessionId, entry);
    console.log(`[SessionLogStream] Started stream for ${sessionId} -> ${filePath}`);
  } catch (err) {
    console.error(`[SessionLogStream] Failed to start stream for ${sessionId}:`, err.message);
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

    if (entry.isHtml) {
      // For HTML format, write raw data during streaming; convert on close
      entry.writeStream.write(data);
    } else if (entry.format === "raw") {
      entry.writeStream.write(data);
    } else {
      // txt format: strip ANSI codes
      entry.writeStream.write(stripAnsi(data));
    }
  } catch (err) {
    console.error("[SessionLogStream] Flush error:", err.message);
    entry.disabled = true;
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
 * @param {string} sessionId
 * @returns {Promise<string|null>} The final file path, or null if no stream was active
 */
async function stopStream(sessionId) {
  const entry = activeStreams.get(sessionId);
  if (!entry) return null;
  activeStreams.delete(sessionId);

  // Stop periodic flush
  if (entry.flushTimer) {
    clearInterval(entry.flushTimer);
    entry.flushTimer = null;
  }

  // Flush remaining buffer
  flushBuffer(entry);

  // Close the write stream and wait for it to finish
  await new Promise((resolve) => {
    entry.writeStream.end(resolve);
  });

  let finalPath = entry.filePath;

  // For HTML format: read the temp raw file and convert to HTML
  if (entry.isHtml && !entry.disabled) {
    try {
      const rawData = await fs.promises.readFile(entry.filePath, "utf8");
      const htmlContent = terminalDataToHtml(rawData, entry.hostLabel, entry.startTime);
      const htmlPath = entry.filePath.replace(/\.log\.tmp$/, ".html");
      await fs.promises.writeFile(htmlPath, htmlContent, "utf8");
      // Remove temp file
      try {
        await fs.promises.unlink(entry.filePath);
      } catch {
        // Ignore cleanup errors
      }
      finalPath = htmlPath;
    } catch (err) {
      console.error(`[SessionLogStream] HTML conversion failed for ${sessionId}:`, err.message);
      // Keep the raw temp file as fallback
    }
  }

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
