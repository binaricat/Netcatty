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
 * Resolve per-file overwrite choices into an upload plan. Pure (no I/O):
 * `resolveDecision(name)` is awaited only for files in `existingList`, in input
 * order; `{ applyToRest: true }` reuses that action for the remaining conflicts.
 * Returns indices into the original `names` array so callers preserve per-file
 * identity even when two files share a basename.
 * Actions: 'overwrite' (rm remote then send), 'skip' (don't send), 'cancel' (abort all).
 */
async function buildUploadPlan(names, existingList, resolveDecision) {
  const existing = new Set(existingList);
  const offerIndices = [];
  const removeIndices = [];
  let bulkAction = null;
  for (let idx = 0; idx < names.length; idx++) {
    const name = names[idx];
    if (!existing.has(name)) { offerIndices.push(idx); continue; }
    let action = bulkAction;
    if (!action) {
      const decision = (await resolveDecision(name)) || { action: "skip" };
      action = decision.action;
      if (decision.applyToRest && action !== "cancel") bulkAction = action;
    }
    if (action === "cancel") return { offerIndices: [], removeIndices: [], aborted: true };
    if (action === "overwrite") { removeIndices.push(idx); offerIndices.push(idx); }
    // 'skip' → omit from both
  }
  return { offerIndices, removeIndices, aborted: false };
}

/**
 * Resolve which overwritten files need their original mode restored after rz
 * re-creates them. rz writes new files with the remote umask, dropping the
 * prior permission bits (issue #1079). Pure: returns absolute `{ path, mode }`
 * entries for the overwritten files, skipping any whose mode wasn't captured
 * and de-duplicating shared basenames.
 */
function buildModeRestores(dir, names, removeIndices, modes) {
  const base = String(dir).replace(/\/+$/, "");
  const seen = new Set();
  const restores = [];
  for (const i of removeIndices) {
    const name = names[i];
    const mode = modes && modes[name];
    if (!mode) continue;
    const target = `${base}/${name}`;
    if (seen.has(target)) continue;
    seen.add(target);
    restores.push({ path: target, mode });
  }
  return restores;
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
  let _needsDrain = false;
  const pendingEchoes = [];
  let pendingTerminalSuppression = null;
  let cancelInterruptTimer = null;
  let ignoreDetectionUntil = 0;
  // After aborting, suppress incoming data briefly so residual ZMODEM
  // protocol bytes from the remote don't flood the terminal as garbage.
  let cooldownUntil = 0;
  /** Drag-drop upload queued before auto-triggering rz on the PTY. */
  let dragDropUpload = null;
  let dragDropStartTimer = null;
  const COOLDOWN_MS = 2000;
  const ECHO_TTL_MS = 1500;
  const ECHO_MAX_BYTES = 256;
  const dragDropStartTimeoutMs = Number.isFinite(opts.dragDropStartTimeoutMs)
    ? Math.max(0, opts.dragDropStartTimeoutMs)
    : 15000;

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

  function cleanupDragDropTempFiles(upload) {
    if (!upload?.tempPaths?.length) return;
    for (const tempPath of upload.tempPaths) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
    }
  }

  function clearDragDropUpload() {
    clearDragDropStartTimer();
    if (dragDropUpload) {
      cleanupDragDropTempFiles(dragDropUpload);
      dragDropUpload = null;
    }
  }

  function takeDragDropUpload() {
    clearDragDropStartTimer();
    const upload = dragDropUpload;
    dragDropUpload = null;
    return upload;
  }

  function clearDragDropStartTimer() {
    if (dragDropStartTimer) {
      clearTimeout(dragDropStartTimer);
      dragDropStartTimer = null;
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

  function interruptPendingDragDropCommand() {
    ignoreDetectionUntil = Date.now() + 1000;
    sendExtraAbortBytes();
    try { interruptRemote?.(); } catch { /* ignore */ }

    if (cancelInterruptTimer) {
      clearTimeout(cancelInterruptTimer);
      cancelInterruptTimer = null;
    }
    cancelInterruptTimer = setTimeout(() => {
      cancelInterruptTimer = null;
      try { interruptRemote?.(); } catch { /* ignore */ }
      try { writeToRemote(Buffer.from("\x03")); } catch { /* ignore */ }
    }, 120);
  }

  function scheduleDragDropStartTimeout() {
    clearDragDropStartTimer();
    if (!dragDropStartTimeoutMs) return;
    dragDropStartTimer = setTimeout(() => {
      dragDropStartTimer = null;
      if (!dragDropUpload || active) return;
      console.warn(`[ZMODEM][${label}] Drag-drop upload did not start before timeout; cancelling pending upload`);
      interruptPendingDragDropCommand();
      clearDragDropUpload();
      safeSend(getWebContents(), "netcatty:zmodem:error", {
        sessionId,
        error: "ZMODEM drag-drop upload did not start",
      });
    }, dragDropStartTimeoutMs);
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
      const ok = writeToRemote(Buffer.from(octets));
      // Track backpressure: if stream.write() returned false, the
      // kernel TCP buffer is full.  The upload loop should pause.
      if (ok === false) _needsDrain = true;
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

      // Provide a drain helper so the upload loop can pause when the
      // underlying transport's write buffer is full.
      const transferOpts = {
        ...opts,
        getDragDropUpload: () => dragDropUpload,
        takeDragDropUpload,
        clearDragDropUpload,
        waitForDrain: () => {
          if (!_needsDrain) return Promise.resolve();
          _needsDrain = false;
          // Yield to the event loop so Node can flush buffered writes to
          // the kernel.  Using setImmediate (not setTimeout) avoids any
          // fixed delay — we resume as soon as the I/O phase completes.
          return new Promise((resolve) => setImmediate(resolve));
        },
      };
      handleTransfer(zsession, transferType, transferOpts)
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
    cancel(options = {}) {
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
      } else if (dragDropUpload && options.interrupt !== false) {
        interruptPendingDragDropCommand();
      }
      clearDragDropUpload();
    },

    /**
     * Queue files from a terminal drag-drop and auto-trigger rz on the PTY.
     * @param {{ filePaths: string[], remoteNames?: string[], uploadCommand?: string, tempPaths?: string[] }} payload
     */
    queueDragDropUpload(payload) {
      if (active) {
        throw new Error("ZMODEM transfer already in progress");
      }
      const filePaths = payload?.filePaths;
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw new Error("No files to upload");
      }
      if (dragDropUpload) {
        throw new Error("ZMODEM drag-drop upload already pending");
      }

      const uploadCommand = payload.uploadCommand || "rz\r";
      dragDropUpload = {
        filePaths,
        remoteNames: payload.remoteNames,
        uploadCommand,
        tempPaths: payload.tempPaths || [],
      };

      const cmdBuf = Buffer.from(uploadCommand, "utf8");
      const pendingEchoCount = pendingEchoes.length;
      try {
        rememberOutgoingEcho(cmdBuf);
        pendingTerminalSuppression = Buffer.from(uploadCommand.replace(/\r$/, ""));
        writeToRemote(cmdBuf);
        scheduleDragDropStartTimeout();
      } catch (err) {
        pendingEchoes.length = pendingEchoCount;
        pendingTerminalSuppression = null;
        clearDragDropUpload();
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers (module-level, usable from handleUpload / handleDownload)
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout.  If the promise doesn't settle within
 * `ms`, resolve with undefined instead of hanging forever.  This prevents
 * zmodem.js internal promises (xfer.end, zsession.close) from blocking
 * indefinitely after cancel/abort.
 */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("ZMODEM handshake timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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

  const dragDrop = opts.takeDragDropUpload?.() ?? opts.getDragDropUpload?.();
  let filePaths;
  let allNames;
  let dragDropTempPaths = [];

  if (dragDrop?.filePaths?.length) {
    filePaths = dragDrop.filePaths;
    allNames = Array.isArray(dragDrop.remoteNames) && dragDrop.remoteNames.length === filePaths.length
      ? dragDrop.remoteNames
      : filePaths.map((fp) => path.basename(fp));
    dragDropTempPaths = dragDrop.tempPaths || [];
  } else {
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

    filePaths = result.filePaths;
    allNames = filePaths.map((fp) => path.basename(fp));
  }

  try {
    const fileStats = filePaths.map((fp) => fs.statSync(fp));

  // Conflict handling (SSH only — callbacks absent on local/telnet/serial).
  // On any failure we fall back to today's behavior (rz silently skips).
  let plan = { offerIndices: allNames.map((_, i) => i), removeIndices: [], aborted: false };
  let probeDir = null;
  let probeModes = null;
  if (opts.probeReceiveConflicts && opts.requestOverwriteDecision) {
    try {
      const probe = await opts.probeReceiveConflicts(allNames);
      if (probe && probe.dir && Array.isArray(probe.existing) && probe.existing.length > 0) {
        probeDir = probe.dir;
        probeModes = probe.modes || {};
        plan = await buildUploadPlan(allNames, probe.existing, opts.requestOverwriteDecision);
        if (plan.aborted) {
          try { zsession.abort(); } catch { /* ignore */ }
          abortRemoteProcess(opts.writeToRemote);
          throw new Error("Transfer cancelled");
        }
        if (plan.removeIndices.length && opts.removeRemoteFiles) {
          const base = probe.dir.replace(/\/+$/, "");
          const targets = [...new Set(plan.removeIndices.map((i) => `${base}/${allNames[i]}`))];
          try {
            await opts.removeRemoteFiles(targets);
          } catch (err) {
            console.warn("[ZMODEM] removeRemoteFiles failed; rz will skip:", err?.message || err);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === "Transfer cancelled") throw err;
      console.warn("[ZMODEM] conflict probe failed; proceeding:", err?.message || err);
    }
  }

  const offers = plan.offerIndices.map((i) => ({ filePath: filePaths[i], stat: fileStats[i], name: allNames[i] }));

  for (let i = 0; i < offers.length; i++) {
    const { filePath, stat, name } = offers[i];

    safeSend(contents, "netcatty:zmodem:progress", {
      sessionId,
      filename: name,
      transferred: 0,
      total: stat.size,
      fileIndex: i,
      fileCount: offers.length,
      transferType: "upload",
    });

    let bytesRemaining = 0;
    for (let j = i; j < offers.length; j++) bytesRemaining += offers[j].stat.size;

    const xfer = await zsession.send_offer({
      name,
      size: stat.size,
      mtime: new Date(stat.mtimeMs),
      files_remaining: offers.length - i,
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
          fileCount: offers.length,
          transferType: "upload",
        });

        // Wait for transport to drain if its buffer is full, then yield
        // so inbound ZMODEM control frames can be processed.
        if (opts.waitForDrain) await opts.waitForDrain();
        await yieldToIO();
      }
      // All data written to Node.js buffer — but TCP may still be
      // flushing to the remote.  Show "finalizing" state while we
      // wait for the remote to acknowledge.
      safeSend(contents, "netcatty:zmodem:progress", {
        sessionId,
        filename: name,
        transferred: stat.size,
        total: stat.size,
        fileIndex: i,
        fileCount: offers.length,
        transferType: "upload",
        finalizing: true,
      });
      await withTimeout(xfer.end(), 120000);
    } finally {
      fs.closeSync(fd);
    }
  }

  await withTimeout(zsession.close(), 120000);

  // rz re-creates overwritten files with the remote umask, dropping their
  // original permission bits. Now that everything is on disk, restore them
  // to the modes captured before the rm (issue #1079).
  if (plan.removeIndices.length && probeDir && opts.restoreRemoteModes) {
    const restores = buildModeRestores(probeDir, allNames, plan.removeIndices, probeModes);
    if (restores.length) {
      try {
        await opts.restoreRemoteModes(restores);
      } catch (err) {
        console.warn("[ZMODEM] restoreRemoteModes failed:", err?.message || err);
      }
    }
  }

  } finally {
    if (dragDropTempPaths.length) {
      for (const tempPath of dragDropTempPaths) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
      }
    }
  }
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

module.exports = { createZmodemSentry, buildUploadPlan, buildModeRestores };
