/**
 * ZMODEM Helper - Provides ZMODEM file transfer support for terminal sessions.
 *
 * Architecture: ZMODEM detection and transfer runs entirely in the main process.
 * The Sentry wraps the raw data stream and routes data either to the normal
 * string-based terminal pipeline (via `to_terminal`) or to the ZMODEM protocol
 * handler.  This avoids any changes to the IPC / preload / renderer data path.
 *
 * The renderer is only notified for progress display via lightweight IPC events.
 */

const Zmodem = require("zmodem.js");
const fs = require("node:fs");
const path = require("node:path");

// Lazy-load electron to avoid issues when requiring from non-electron contexts
let _electron = null;
function getElectron() {
  if (!_electron) _electron = require("electron");
  return _electron;
}

/**
 * Create a ZMODEM sentry that wraps a session's data stream.
 *
 * All raw data from the PTY / SSH stream / socket should be fed into
 * `consume()`.  The sentry transparently calls `onData(str)` for normal
 * terminal output and handles ZMODEM transfers internally.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {(data: Buffer) => void} opts.onData
 *   Called with raw bytes during normal (non-ZMODEM) operation.
 *   The caller is responsible for charset-aware decoding (UTF-8, iconv, etc.).
 * @param {(buf: Buffer) => void} opts.writeToRemote
 *   Write raw bytes back to the remote side (PTY / SSH stream / socket).
 * @param {() => import('electron').WebContents | null} opts.getWebContents
 *   Returns the Electron WebContents for sending progress IPC events.
 * @param {string} [opts.label]
 *   Human-readable label for log messages (e.g. "Local", "SSH").
 * @returns {ZmodemSentryWrapper}
 */
function createZmodemSentry(opts) {
  const { sessionId, onData, writeToRemote, getWebContents, label = "Session" } = opts;

  let active = false;
  let currentZSession = null;

  const sentry = new Zmodem.Sentry({
    to_terminal(octets) {
      // Normal data – pass raw bytes to the caller for charset-aware decoding.
      onData(Buffer.from(octets));
    },

    sender(octets) {
      // ZMODEM protocol bytes – send raw to remote.
      writeToRemote(Buffer.from(octets));
    },

    on_detect(detection) {
      if (active) {
        console.warn(`[ZMODEM][${label}] Detection while transfer active; denying`);
        detection.deny();
        return;
      }
      active = true;
      const zsession = detection.confirm();
      currentZSession = zsession;

      const contents = getWebContents();
      const transferType = zsession.type === "send" ? "upload" : "download";

      console.log(`[ZMODEM][${label}] Detected ${transferType} for session ${sessionId}`);

      safeSend(contents, "netcatty:zmodem:detect", {
        sessionId,
        transferType,
      });

      handleTransfer(zsession, transferType, opts)
        .then(() => {
          // If cancel() already cleaned up, skip duplicate notification
          if (!currentZSession) return;
          console.log(`[ZMODEM][${label}] Transfer completed for session ${sessionId}`);
          safeSend(contents, "netcatty:zmodem:complete", { sessionId });
        })
        .catch((err) => {
          // If cancel() already cleaned up, skip duplicate notification
          if (!currentZSession) return;
          console.error(`[ZMODEM][${label}] Transfer error:`, err.message || err);
          try { zsession.abort(); } catch { /* ignore */ }
          safeSend(contents, "netcatty:zmodem:error", {
            sessionId,
            error: String(err.message || err),
          });
        })
        .finally(() => {
          active = false;
          currentZSession = null;
        });
    },

    on_retract() {
      // False positive – sentry automatically resumes passthrough.
    },
  });

  return {
    /**
     * Feed raw bytes from the session into the sentry.
     * @param {Buffer|Uint8Array} data
     */
    consume(data) {
      try {
        sentry.consume(data);
      } catch (err) {
        console.error(`[ZMODEM][${label}] Sentry consume error:`, err.message || err);
        if (currentZSession) {
          try { currentZSession.abort(); } catch { /* ignore */ }
        }
        const wasActive = active;
        active = false;
        currentZSession = null;
        // Notify renderer so the progress UI doesn't stay stuck
        if (wasActive) {
          safeSend(getWebContents(), "netcatty:zmodem:error", {
            sessionId,
            error: String(err.message || err),
          });
        }
      }
    },

    /** Whether a ZMODEM transfer is currently in progress. */
    isActive() {
      return active;
    },

    /** Cancel the current ZMODEM transfer. */
    cancel() {
      if (currentZSession) {
        console.log(`[ZMODEM][${label}] Cancelling transfer for session ${sessionId}`);
        try { currentZSession.abort(); } catch { /* ignore */ }
        active = false;
        currentZSession = null;
        safeSend(getWebContents(), "netcatty:zmodem:error", {
          sessionId,
          error: "Transfer cancelled",
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Transfer handlers
// ---------------------------------------------------------------------------

async function handleTransfer(zsession, transferType, opts) {
  if (transferType === "upload") {
    await handleUpload(zsession, opts);
  } else {
    await handleDownload(zsession, opts);
  }
}

/**
 * Upload files to the remote (remote executed `rz`).
 */
async function handleUpload(zsession, opts) {
  const { sessionId, getWebContents } = opts;
  const contents = getWebContents();
  const { BrowserWindow, dialog } = getElectron();

  const win = contents ? BrowserWindow.fromWebContents(contents) : null;
  const result = await dialog.showOpenDialog(win || undefined, {
    properties: ["openFile", "multiSelections"],
    title: "Select files to upload (ZMODEM)",
  });

  if (result.canceled || !result.filePaths.length) {
    // User cancelled – close the ZMODEM session gracefully.
    try { await zsession.close(); } catch { /* ignore */ }
    return;
  }

  const filePaths = result.filePaths;
  const fileStats = filePaths.map((fp) => fs.statSync(fp));

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const stat = fileStats[i];
    const name = path.basename(filePath);

    safeSend(contents, "netcatty:zmodem:progress", {
      sessionId,
      filename: name,
      transferred: 0,
      total: stat.size,
      fileIndex: i,
      fileCount: filePaths.length,
      transferType: "upload",
    });

    let bytesRemaining = 0;
    for (let j = i; j < fileStats.length; j++) bytesRemaining += fileStats[j].size;

    const xfer = await zsession.send_offer({
      name,
      size: stat.size,
      mtime: new Date(stat.mtimeMs),
      files_remaining: filePaths.length - i,
      bytes_remaining: bytesRemaining,
    });

    if (!xfer) {
      // Receiver skipped this file
      continue;
    }

    // Read and send in chunks
    const CHUNK_SIZE = 512 * 1024; // 512KB chunks
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(CHUNK_SIZE);
    let sent = 0;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE);
        if (bytesRead === 0) break;

        // zmodem.js expects an Array or Uint8Array
        await xfer.send(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
        sent += bytesRead;

        safeSend(contents, "netcatty:zmodem:progress", {
          sessionId,
          filename: name,
          transferred: sent,
          total: stat.size,
          fileIndex: i,
          fileCount: filePaths.length,
          transferType: "upload",
        });
      }
      await xfer.end();
    } finally {
      fs.closeSync(fd);
    }
  }

  await zsession.close();
}

/**
 * Download files from the remote (remote executed `sz <file>`).
 */
async function handleDownload(zsession, opts) {
  const { sessionId, getWebContents } = opts;
  const contents = getWebContents();
  const { BrowserWindow, dialog } = getElectron();

  const win = contents ? BrowserWindow.fromWebContents(contents) : null;

  // Ask user to pick a download directory
  const result = await dialog.showOpenDialog(win || undefined, {
    properties: ["openDirectory", "createDirectory"],
    title: "Select download directory (ZMODEM)",
  });

  if (result.canceled || !result.filePaths.length) {
    try { await zsession.close(); } catch { /* ignore */ }
    return;
  }

  const downloadDir = result.filePaths[0];
  let fileIndex = 0;

  await new Promise((resolve, reject) => {
    zsession.on("offer", (xfer) => {
      try {
        const detail = xfer.get_details();
        // Sanitize filename to prevent path traversal attacks
        const rawName = detail.name || `untitled_${Date.now()}`;
        const name = path.basename(rawName);
        const size = detail.size || 0;
        const savePath = path.join(downloadDir, name);
        const currentIndex = fileIndex++;

        safeSend(contents, "netcatty:zmodem:progress", {
          sessionId,
          filename: name,
          transferred: 0,
          total: size,
          fileIndex: currentIndex,
          fileCount: -1, // unknown total until session ends
          transferType: "download",
        });

        const ws = fs.createWriteStream(savePath);
        let received = 0;
        let writeAborted = false;

        ws.on("error", (err) => {
          writeAborted = true;
          console.error(`[ZMODEM] Write stream error for ${name}:`, err.message);
          ws.destroy();
          reject(err);
        });

        xfer.accept({
          on_input(payload) {
            if (writeAborted) return;
            const chunk = Buffer.from(payload);
            ws.write(chunk);
            received += chunk.length;

            safeSend(contents, "netcatty:zmodem:progress", {
              sessionId,
              filename: name,
              transferred: received,
              total: size,
              fileIndex: currentIndex,
              fileCount: -1,
              transferType: "download",
            });
          },
        });

        xfer.on("complete", () => {
          ws.end();
        });
      } catch (err) {
        reject(err);
      }
    });

    zsession.on("session_end", () => resolve());

    zsession.start();
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function safeSend(contents, channel, data) {
  try {
    if (contents && !contents.isDestroyed()) {
      contents.send(channel, data);
    }
  } catch {
    // WebContents may have been destroyed between the check and the send
  }
}

module.exports = { createZmodemSentry };
