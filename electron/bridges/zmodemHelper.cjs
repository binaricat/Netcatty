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
  const {
    sessionId,
    onData,
    writeToRemote,
    getWebContents,
    interruptRemote,
    label = "Session",
  } = opts;

  let active = false;
  let currentZSession = null;
  const pendingEchoes = [];
  let pendingTerminalSuppression = null;
  let cancelInterruptTimer = null;
  let ignoreDetectionUntil = 0;
  // After aborting, suppress incoming data briefly so residual ZMODEM
  // protocol bytes from the remote don't flood the terminal as garbage.
  let cooldownUntil = 0;
  const COOLDOWN_MS = 2000;
  const ECHO_TTL_MS = 1500;
  const ECHO_MAX_BYTES = 256;

  function prunePendingEchoes(now = Date.now()) {
    while (pendingEchoes.length && pendingEchoes[0].expiresAt <= now) {
      pendingEchoes.shift();
    }
  }

  function rememberOutgoingEcho(octets) {
    const buf = Buffer.from(octets);
    if (!buf.length || buf.length > ECHO_MAX_BYTES) return;
    prunePendingEchoes();
    pendingEchoes.push({
      buf,
      expiresAt: Date.now() + ECHO_TTL_MS,
    });
  }

  function stripEchoedOutgoingData(data) {
    if (!pendingEchoes.length) return data;

    prunePendingEchoes();

    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let mutated = false;

    while (pendingEchoes.length && buf.length) {
      const nextEcho = pendingEchoes[0].buf;
      if (buf.length < nextEcho.length) break;
      if (!buf.subarray(0, nextEcho.length).equals(nextEcho)) break;

      mutated = true;
      buf = buf.subarray(nextEcho.length);
      pendingEchoes.shift();
    }

    return mutated ? buf : data;
  }

  function stripPendingTerminalSuppression(data) {
    if (!pendingTerminalSuppression?.length) return data;

    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const fullMatchAt = buf.indexOf(pendingTerminalSuppression);
    if (fullMatchAt !== -1) {
      buf = Buffer.concat([
        buf.subarray(0, fullMatchAt),
        buf.subarray(fullMatchAt + pendingTerminalSuppression.length),
      ]);
      pendingTerminalSuppression = null;
      return buf;
    }

    const maxMatch = Math.min(pendingTerminalSuppression.length, buf.length);
    let matchLen = 0;
    while (matchLen < maxMatch && buf[matchLen] === pendingTerminalSuppression[matchLen]) {
      matchLen += 1;
    }

    if (!matchLen) return buf;

    buf = buf.subarray(matchLen);
    pendingTerminalSuppression = matchLen === pendingTerminalSuppression.length
      ? null
      : pendingTerminalSuppression.subarray(matchLen);

    return buf;
  }

  function stripVisibleZmodemHeaders(data) {
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let searchFrom = 0;

    while (searchFrom < buf.length) {
      const prefixAt = buf.indexOf(Buffer.from([0x2a, 0x2a, 0x18, 0x42]), searchFrom);
      if (prefixAt === -1) break;

      const minHeaderLength = 20;
      if (buf.length - prefixAt < minHeaderLength) break;

      let isHexHeader = true;
      for (let i = 0; i < 14; i += 1) {
        const byte = buf[prefixAt + 4 + i];
        const isHexDigit =
          (byte >= 0x30 && byte <= 0x39) ||
          (byte >= 0x41 && byte <= 0x46) ||
          (byte >= 0x61 && byte <= 0x66);
        if (!isHexDigit) {
          isHexHeader = false;
          break;
        }
      }

      if (!isHexHeader) {
        searchFrom = prefixAt + 1;
        continue;
      }

      let headerLength = 18;
      if (buf[prefixAt + 18] === 0x0d && buf[prefixAt + 19] === 0x0a) {
        headerLength = 20;
        if (buf[prefixAt + 20] === 0x11) {
          headerLength = 21;
        }
      }

      buf = Buffer.concat([
        buf.subarray(0, prefixAt),
        buf.subarray(prefixAt + headerLength),
      ]);
      searchFrom = prefixAt;
    }

    return buf;
  }

  function looksLikeResidualZmodemData(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buf.length) return true;

    for (const byte of buf) {
      const isResidualControl =
        byte === 0x18 || // CAN / ZDLE
        byte === 0x08 || // backspace from abort sequence
        byte === 0x11 || // XON
        byte === 0x13 || // XOFF
        byte === 0x0d ||
        byte === 0x0a;
      if (isResidualControl) continue;
      return false;
    }

    return true;
  }

  function sendExtraAbortBytes() {
    try {
      writeToRemote(Buffer.from([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]));
    } catch {
      /* ignore */
    }
  }

  function scheduleRemoteInterruptAfterCancel(transferRole) {
    if (cancelInterruptTimer) {
      clearTimeout(cancelInterruptTimer);
      cancelInterruptTimer = null;
    }

    if (transferRole !== "send") return;
    ignoreDetectionUntil = Date.now() + 300;

    try { interruptRemote?.(); } catch { /* ignore */ }

    // Some rz builds (notably Debian's lrzsz) can stay attached to the tty
    // after a protocol cancel. Follow up with Ctrl+C so the remote shell
    // reliably regains control. If rz is already gone, this just refreshes
    // the prompt like a normal interactive interrupt.
    cancelInterruptTimer = setTimeout(() => {
      cancelInterruptTimer = null;
      try { interruptRemote?.(); } catch { /* ignore */ }
      try { writeToRemote(Buffer.from("\x03")); } catch { /* ignore */ }
    }, 120);
  }

  function isIgnorableSendKeepaliveError(errMsg) {
    return Boolean(
      active &&
      currentZSession?.type === "send" &&
      !currentZSession?._sending_file &&
      errMsg.includes("Unhandled header: ZRINIT")
    );
  }

  function isIgnorableSendResumePingError(errMsg) {
    return Boolean(
      active &&
      currentZSession?.type === "send" &&
      !currentZSession?._sending_file &&
      currentZSession?._next_header_handler?.ZRINIT &&
      errMsg.includes("Unhandled header: ZRPOS")
    );
  }

  const sentry = new Zmodem.Sentry({
    to_terminal(octets) {
      // Normal data – pass raw bytes to the caller for charset-aware decoding.
      let sanitizedOctets = stripPendingTerminalSuppression(Buffer.from(octets));
      sanitizedOctets = stripVisibleZmodemHeaders(sanitizedOctets);
      if (!sanitizedOctets.length) return;
      onData(sanitizedOctets);
    },

    sender(octets) {
      // ZMODEM protocol bytes – send raw to remote.
      rememberOutgoingEcho(octets);
      writeToRemote(Buffer.from(octets));
    },

    on_detect(detection) {
      if (active) {
        console.warn(`[ZMODEM][${label}] Detection while transfer active; denying`);
        detection.deny();
        return;
      }
      if (Date.now() < ignoreDetectionUntil) {
        console.log(`[ZMODEM][${label}] Ignoring stray detection during cancel grace window`);
        detection.deny();
        return;
      }
      active = true;
      const zsession = detection.confirm();
      currentZSession = zsession;
      pendingTerminalSuppression = zsession.type === "receive"
        ? Buffer.from(Zmodem.Header.build("ZRQINIT").to_hex())
        : zsession._last_ZRINIT?.to_hex
          ? Buffer.from(zsession._last_ZRINIT.to_hex())
          : null;

      const contents = getWebContents();
      const transferType = zsession.type === "send" ? "upload" : "download";

      console.log(`[ZMODEM][${label}] Detected ${transferType} for session ${sessionId}`);

      safeSend(contents, "netcatty:zmodem:detect", {
        sessionId,
        transferType,
      });

      handleTransfer(zsession, transferType, opts)
        .then(() => {
          // Only act if this is still the active session (not replaced by a new one)
          if (currentZSession !== zsession) return;
          console.log(`[ZMODEM][${label}] Transfer completed for session ${sessionId}`);
          safeSend(contents, "netcatty:zmodem:complete", { sessionId });
        })
        .catch((err) => {
          if (currentZSession !== zsession) return;
          console.error(`[ZMODEM][${label}] Transfer error:`, err.message || err);
          try { zsession.abort(); } catch { /* ignore */ }
          safeSend(contents, "netcatty:zmodem:error", {
            sessionId,
            error: String(err.message || err),
          });
        })
        .finally(() => {
          // Only clear state if this is still the active session
          if (currentZSession === zsession) {
            active = false;
            currentZSession = null;
          }
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
      // During cooldown after abort, unconditionally suppress all incoming
      // data.  sz can stream large amounts of file data that's still in
      // SSH/TCP buffers after we send CAN; checking content doesn't help
      // because the residual data contains arbitrary printable bytes.
      if (cooldownUntil) {
        const now = Date.now();
        if (now < cooldownUntil) {
          // Keep sending CAN in case earlier ones were lost in the flood
          if (now - (cooldownUntil - COOLDOWN_MS) > 200) {
            sendExtraAbortBytes();
          }
          return; // drop everything during cooldown
        }
        cooldownUntil = 0;
        // After cooldown, let this chunk through — it's likely the shell prompt
      }

      try {
        const sanitizedData = stripEchoedOutgoingData(data);
        if (!sanitizedData.length) return;
        sentry.consume(sanitizedData);
      } catch (err) {
        const errMsg = String(err.message || err);
        console.error(`[ZMODEM][${label}] Sentry consume error:`, errMsg);

        const wasActive = active;

        // lrzsz's `rz` may resend ZRINIT while we're waiting for the user
        // to choose files. zmodem.js doesn't model that pre-offer keepalive,
        // but the repeated header is harmless, so ignore it and keep waiting.
        if (isIgnorableSendKeepaliveError(errMsg)) {
          console.log(`[ZMODEM][${label}] Ignoring repeated pre-offer ZRINIT`);
          return;
        }

        // Some receivers emit a final ZRPOS ping right before they send the
        // post-file ZRINIT. If that ping is processed a beat late, zmodem.js
        // complains even though the transfer can continue normally.
        if (isIgnorableSendResumePingError(errMsg)) {
          console.log(`[ZMODEM][${label}] Ignoring late post-file ZRPOS`);
          return;
        }

        // ZFIN/OO mismatch: the file transfer completed (ZFIN exchanged)
        // but the shell prompt arrived before the "OO" end marker.  This
        // is common over SSH because sz exits and the shell resumes before
        // the "OO" acknowledgement is sent.  Treat as successful transfer.
        // Do NOT abort() here — that sends CAN bytes to the remote shell.
        // Instead, manually clean up the sentry's internal session state.
        if (wasActive && errMsg.includes("ZFIN") && errMsg.includes("OO")) {
          console.log(`[ZMODEM][${label}] ZFIN/OO mismatch — treating as success`);
          if (currentZSession) {
            try { currentZSession._on_session_end(); } catch { /* ignore */ }
          }
          active = false;
          currentZSession = null;
          safeSend(getWebContents(), "netcatty:zmodem:complete", { sessionId });
          try { sentry.consume(data); } catch { /* ignore */ }
          return;
        }

        // For all other errors, abort and send extra CAN sequences to
        // ensure the remote rz/sz process stops transmitting.
        if (currentZSession) {
          try { currentZSession.abort(); } catch { /* ignore */ }
        }
        sendExtraAbortBytes();
        // Follow up with Ctrl+C after a short delay to kill rz/sz on
        // Debian and other systems where it stays attached after CAN.
        setTimeout(() => {
          try { writeToRemote(Buffer.from("\x03")); } catch { /* ignore */ }
        }, 150);

        active = false;
        currentZSession = null;
        // Enter cooldown: discard incoming data briefly while the remote
        // processes our CAN sequence and stops sending ZMODEM frames.
        cooldownUntil = Date.now() + COOLDOWN_MS;

        if (wasActive) {
          safeSend(getWebContents(), "netcatty:zmodem:error", {
            sessionId,
            error: errMsg,
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
        const transferRole = currentZSession.type;
        console.log(`[ZMODEM][${label}] Cancelling transfer for session ${sessionId}`);
        try { currentZSession.abort(); } catch { /* ignore */ }
        sendExtraAbortBytes();
        active = false;
        currentZSession = null;
        cooldownUntil = Date.now() + COOLDOWN_MS;
        scheduleRemoteInterruptAfterCancel(transferRole);
        safeSend(getWebContents(), "netcatty:zmodem:error", {
          sessionId,
          error: "Transfer cancelled",
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers (module-level, usable from handleUpload / handleDownload)
// ---------------------------------------------------------------------------

/**
 * Send CAN bytes + delayed Ctrl-C to kill the remote rz/sz process.
 * Used from dialog-cancel paths that run outside the sentry closure.
 */
function abortRemoteProcess(writeToRemote) {
  try { writeToRemote(Buffer.from([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18])); } catch { /* ignore */ }
  setTimeout(() => {
    try { writeToRemote(Buffer.from("\x03")); } catch { /* ignore */ }
  }, 150);
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
  const yieldToIO = () => new Promise((resolve) => setImmediate(resolve));

  const win = contents ? BrowserWindow.fromWebContents(contents) : null;
  const result = await dialog.showOpenDialog(win || undefined, {
    properties: ["openFile", "multiSelections"],
    title: "Select files to upload (ZMODEM)",
  });

  if (result.canceled || !result.filePaths.length) {
    try { zsession.abort(); } catch { /* ignore */ }
    abortRemoteProcess(opts.writeToRemote);
    throw new Error("Transfer cancelled");
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
    const CHUNK_SIZE = 64 * 1024; // Leave room for inbound ZMODEM control frames
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(CHUNK_SIZE);
    let sent = 0;

    try {
      while (true) {
        const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE);
        if (bytesRead === 0) break;

        // zmodem.js send() is synchronous and triggers writeToRemote via
        // the sentry's sender callback.  Yield after each chunk so the
        // event loop can flush buffered writes and process inbound control
        // frames, preventing unbounded memory growth on slow links.
        xfer.send(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
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

        await yieldToIO();
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
  let fileIndex = 0;
  const pendingStreams = [];
  const pendingOffers = [];
  let lastProgressTime = 0;
  let downloadDir = null;
  let rejectSession = () => {};

  const processOffer = (xfer, reject) => {
    if (!downloadDir) {
      pendingOffers.push(xfer);
      return;
    }

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

    // Avoid overwriting existing files — append (1), (2), etc.
    let finalPath = savePath;
    if (fs.existsSync(savePath)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let n = 1;
      do {
        finalPath = path.join(downloadDir, `${base} (${n})${ext}`);
        n++;
      } while (fs.existsSync(finalPath));
    }

    const ws = fs.createWriteStream(finalPath);
    let received = 0;
    let writeAborted = false;

    // Track pending write streams (and paths) for cleanup at session end
    pendingStreams.push({ stream: ws, path: finalPath, completed: false });

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

        // Throttle progress IPC to ~10 updates/sec to avoid
        // overwhelming the renderer on fast links.
        const now = Date.now();
        if (now - lastProgressTime >= 100) {
          lastProgressTime = now;
          safeSend(contents, "netcatty:zmodem:progress", {
            sessionId,
            filename: name,
            transferred: received,
            total: size,
            fileIndex: currentIndex,
            fileCount: -1,
            transferType: "download",
          });
        }
      },
    }).catch((err) => {
      ws.destroy();
      reject(err);
    });

    xfer.on("complete", () => {
      const entry = pendingStreams.find((e) => e.stream === ws);
      if (entry) entry.completed = true;
      ws.end();
    });
  };

  const sessionPromise = new Promise((resolve, reject) => {
    rejectSession = reject;
    zsession.on("offer", (xfer) => {
      try {
        processOffer(xfer, reject);
      } catch (err) {
        reject(err);
      }
    });

    // Wait for all write streams to finish flushing before resolving.
    // If a stream never received end() (e.g. transfer was cancelled),
    // destroy it so the fd is released and finish/close can fire.
    zsession.on("session_end", async () => {
      try {
        await Promise.all(
          pendingStreams.map((entry) => {
            const { stream: s, path: filePath, completed } = entry;
            if (s.writableFinished) {
              // Delete partial files that never completed
              if (!completed) {
                try { fs.unlinkSync(filePath); } catch { /* ignore */ }
              }
              return Promise.resolve();
            }
            if (!s.writableEnded) s.destroy();
            return new Promise((r) => {
              s.on("close", () => {
                // Clean up partial downloads
                if (!completed) {
                  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
                }
                r();
              });
            });
          })
        );
      } catch { /* ignore — error handler already called reject */ }
      resolve();
    });
  });

  // Start the session BEFORE showing the dialog so lrzsz doesn't
  // time out waiting for ZRINIT while the user browses for a folder.
  zsession.start();

  const result = await dialog.showOpenDialog(win || undefined, {
    properties: ["openDirectory", "createDirectory"],
    title: "Select download directory (ZMODEM)",
  });

  if (result.canceled || !result.filePaths.length) {
    try { zsession.abort(); } catch { /* ignore */ }
    abortRemoteProcess(opts.writeToRemote);
    void sessionPromise.catch(() => {});
    throw new Error("Transfer cancelled");
  }

  downloadDir = result.filePaths[0];
  while (pendingOffers.length) {
    processOffer(pendingOffers.shift(), rejectSession);
  }

  await sessionPromise;
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
