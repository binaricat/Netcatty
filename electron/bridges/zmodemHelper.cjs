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

// Apply the Buffer fast paths to zmodem.js receive/send hot paths, plus the
// Send-session robustness fixes for `rz` uploads (see zmodemFastPath.cjs).
// NETCATTY_ZMODEM_FAST_PATH=0 disables only the performance paths.
const {
  applyZmodemFastPath,
  applyZmodemSendSessionFixes,
  applyZmodemSendFastPath,
} = require("./zmodemFastPath.cjs");
const Zmodem = applyZmodemSendFastPath(
  applyZmodemSendSessionFixes(applyZmodemFastPath(require("zmodem.js"))),
);
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
 * `resolveDecision(name, { signal })` is awaited only for files in
 * `existingList`, in input order; `{ applyToRest: true }` reuses that action
 * for the remaining conflicts.
 * Returns indices into the original `names` array so callers preserve per-file
 * identity even when two files share a basename.
 * Actions: 'overwrite' (rm remote then send), 'skip' (don't send), 'cancel' (abort all).
 */
async function buildUploadPlan(names, existingList, resolveDecision, signal) {
  const existing = new Set(existingList);
  const offerIndices = [];
  const removeIndices = [];
  let bulkAction = null;
  for (let idx = 0; idx < names.length; idx++) {
    const name = names[idx];
    if (!existing.has(name)) { offerIndices.push(idx); continue; }
    let action = bulkAction;
    if (!action) {
      throwIfZmodemCancelled(signal);
      const decision = (await racePromiseWithAbortSignal(
        resolveDecision(name, { signal }),
        signal,
      )) || { action: "skip" };
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
 * @param {(buf: Buffer) => boolean | void} opts.writeToRemote
 *   Write raw bytes back to the remote side (PTY / SSH stream / socket).
 *   Prefer returning the underlying stream.write() boolean so uploads can
 *   honor backpressure.
 * @param {((opts?: { signal?: AbortSignal }) => Promise<void> | void)} [opts.waitForTransportDrain]
 *   Optional. When writeToRemote returns false, the upload loop awaits this
 *   before sending more file data (typically waitForWritableDrain(stream)).
 *   Callers should forward `opts.signal` so cancel can abort a blocked drain.
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
  let _sawUploadBackpressure = false;
  let transferAbortController = null;
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
    if (!octets?.length || octets.length > ECHO_MAX_BYTES) return;
    const buf = Buffer.from(octets);
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

  /**
   * After an ignorable send-session consume error, the bytes that followed
   * the offending header in the same chunk stay buffered in the session's
   * _input_buffer — e.g. the post-file ZRINIT that rz sends right behind a
   * final ZRPOS ping. Re-feed them so the pending handshake (xfer.end() /
   * close()) resolves instead of stalling until its timeout. Best-effort:
   * anything still unparseable is dropped or picked up by the next consume.
   */
  function refeedRemainingSessionBytes() {
    const zsession = currentZSession;
    if (
      !zsession ||
      !Array.isArray(zsession._input_buffer) ||
      !zsession._input_buffer.length
    ) {
      return;
    }
    const rest = Buffer.from(zsession._input_buffer.splice(0));
    try {
      sentry.consume(rest);
    } catch {
      /* ignore — next regular consume retries whatever is left */
    }
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
      // Zero-copy view for the send fast path's Buffers; number arrays
      // (non-data frames) still go through the Buffer.from() conversion.
      const wireBuf =
        octets instanceof Uint8Array
          ? Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength)
          : Buffer.from(octets);
      const ok = writeToRemote(wireBuf);
      // Track backpressure: if stream.write() returned false, the
      // kernel TCP buffer is full.  The upload loop should pause.
      if (ok === false) {
        _needsDrain = true;
        _sawUploadBackpressure = true;
      }
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

      const transferType = zsession.type === "send" ? "upload" : "download";

      console.log(`[ZMODEM][${label}] Detected ${transferType} for session ${sessionId}`);

      safeSend(getWebContents(), "netcatty:zmodem:detect", {
        sessionId,
        transferType,
      });

      // Provide a drain helper so the upload loop can pause when the
      // underlying transport's write buffer is full. Prefer a real stream
      // drain (waitForTransportDrain) so large rz uploads do not flood SSH
      // and drop the session before the remote has the full file (#2967).
      const onUploadTimeout = () => {
        ignoreDetectionUntil = Date.now() + 1000;
        cooldownUntil = Date.now() + COOLDOWN_MS;
      };
      transferAbortController = new AbortController();
      const transferSignal = transferAbortController.signal;
      const transferOpts = {
        ...opts,
        signal: transferSignal,
        getDragDropUpload: () => dragDropUpload,
        takeDragDropUpload,
        clearDragDropUpload,
        hasUploadBackpressure: () => _sawUploadBackpressure,
        resetUploadBackpressure: () => {
          _sawUploadBackpressure = false;
        },
        onUploadTimeout,
        waitForDrain: createZmodemUploadDrainWaiter({
          getNeedsDrain: () => _needsDrain,
          clearNeedsDrain: () => {
            _needsDrain = false;
          },
          signal: transferSignal,
          waitForTransportDrain: typeof opts.waitForTransportDrain === "function"
            ? (drainOpts) => opts.waitForTransportDrain(drainOpts)
            : undefined,
          // Drain timeouts bypass waitForUploadHandshake; recover the same way.
          onUploadTimeout,
          writeToRemote: opts.writeToRemote,
        }),
      };
      handleTransfer(zsession, transferType, transferOpts)
        .then(() => {
          // Only act if this is still the active session (not replaced by a new one)
          if (currentZSession !== zsession) return;
          console.log(`[ZMODEM][${label}] Transfer completed for session ${sessionId}`);
          safeSend(getWebContents(), "netcatty:zmodem:complete", { sessionId });
        })
        .catch((err) => {
          if (currentZSession !== zsession) return;
          // cancel() already reported Transfer cancelled and cleared currentZSession.
          if (isZmodemCancelledError(err)) return;
          console.error(`[ZMODEM][${label}] Transfer error:`, err.message || err);
          try { zsession.abort(); } catch { /* ignore */ }
          safeSend(getWebContents(), "netcatty:zmodem:error", {
            sessionId,
            error: String(err.message || err),
          });
        })
        .finally(() => {
          if (transferAbortController?.signal === transferSignal) {
            transferAbortController = null;
          }
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
          refeedRemainingSessionBytes();
          return;
        }

        // Some receivers emit a final ZRPOS ping right before they send the
        // post-file ZRINIT. If that ping is processed a beat late, zmodem.js
        // complains even though the transfer can continue normally.
        // Re-feed buffered bytes (e.g. that ZRINIT) so the pending
        // xfer.end() handshake resolves instead of stalling to its timeout.
        if (isIgnorableSendResumePingError(errMsg)) {
          console.log(`[ZMODEM][${label}] Ignoring late post-file ZRPOS`);
          refeedRemainingSessionBytes();
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

        // If the upload loop is parked on SSH backpressure, wake it now.
        // The ZMODEM session is already aborted and must not resume on a late
        // drain event from the still-connected transport.
        try { transferAbortController?.abort(); } catch { /* ignore */ }
        transferAbortController = null;
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
        // Unblock an SSH upload parked on transport drain so open file
        // descriptors and drag-drop temporary files release promptly.
        try { transferAbortController?.abort(); } catch { /* ignore */ }
        transferAbortController = null;
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

      // -y: overwrite same-named remote files (lrzsz protect mode otherwise skips).
      const uploadCommand = payload.uploadCommand || "rz -y\r";
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

const UPLOAD_FILE_END_TIMEOUT_MS = 45000;
const UPLOAD_BACKPRESSURE_FILE_END_TIMEOUT_MS = 120000;
const UPLOAD_SESSION_CLOSE_TIMEOUT_MS = 15000;
/** Max wait for a single transport drain after write() returned false. */
const UPLOAD_DRAIN_TIMEOUT_MS = 60000;
/** Upload read/send chunk size. */
// Keep the batch bounded so SSH backpressure is observed before another
// large group of 8192-byte wire subpackets enters the channel queue.
const UPLOAD_CHUNK_SIZE = 64 * 1024;
/** Default interval between non-final upload progress IPC events. */
const DEFAULT_UPLOAD_PROGRESS_THROTTLE_MS = 100;

function resolveTimeoutMs(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveProgressThrottleMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_UPLOAD_PROGRESS_THROTTLE_MS;
}

/**
 * Race a promise against a timeout.  If the promise doesn't settle within
 * `ms`, reject instead of hanging forever.  This prevents zmodem.js internal
 * promises (xfer.end, zsession.close) from blocking indefinitely.
 */
function withTimeout(promise, ms, message = "ZMODEM handshake timeout") {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(message);
        err.code = "NETCATTY_ZMODEM_TIMEOUT";
        reject(err);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isZmodemTimeoutError(err) {
  return err && err.code === "NETCATTY_ZMODEM_TIMEOUT";
}

function isZmodemCancelledError(err) {
  return err && err.code === "NETCATTY_ZMODEM_CANCELLED";
}

function createZmodemCancelledError() {
  const err = new Error("Transfer cancelled");
  err.code = "NETCATTY_ZMODEM_CANCELLED";
  return err;
}

function throwIfZmodemCancelled(signal) {
  if (signal?.aborted) throw createZmodemCancelledError();
}

/**
 * Wait until a Node writable stream reports it can accept more data.
 * Used after stream.write() returns false so ZMODEM uploads do not flood
 * the SSH/TCP buffer (issue #2967).
 *
 * Resolves immediately when `writableNeedDrain` is already false (drain may
 * have fired between write(false) and this call). Rejects on close/end/error
 * so a dead transport stops the upload loop instead of looking like a successful
 * drain (wrappers that catch write failures and return true would otherwise keep
 * scanning the file until a later handshake timeout). When timeoutMs is greater
 * than zero, rejects after that long without writableLength progress; slow SSH
 * links may take longer overall while a fully stalled peer stays bounded. When
 * `signal` aborts (user cancel), rejects with NETCATTY_ZMODEM_CANCELLED so a
 * blocked drain wait cannot retain the open upload file after cancel.
 *
 * @param {NodeJS.WritableStream | null | undefined} stream
 * @param {{
 *   timeoutMs?: number,
 *   progressIntervalMs?: number,
 *   getProgressValue?: () => unknown,
 *   signal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<void>}
 */
function waitForWritableDrain(stream, opts = {}) {
  if (!stream || typeof stream.once !== "function") {
    return new Promise((resolve) => setImmediate(resolve));
  }
  if (stream.writableNeedDrain === false) {
    return Promise.resolve();
  }

  const timeoutMs = resolveTimeoutMs(opts.timeoutMs, UPLOAD_DRAIN_TIMEOUT_MS);
  const signal = opts.signal;
  if (signal?.aborted) {
    return Promise.reject(createZmodemCancelledError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const readProgressValue = typeof opts.getProgressValue === "function"
      ? opts.getProgressValue
      : () => Number.isFinite(stream.writableLength) ? Number(stream.writableLength) : null;
    let lastProgressAt = Date.now();
    let lastProgressValue = readProgressValue();
    const onDrain = () => finish();
    const onAbort = () => finish(createZmodemCancelledError());
    const onTransportGone = (cause) => {
      if (cause instanceof Error) {
        finish(cause);
        return;
      }
      const err = new Error("Transport closed during drain wait");
      err.code = "NETCATTY_ZMODEM_TRANSPORT_CLOSED";
      finish(err);
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { stream.off("drain", onDrain); } catch { /* ignore */ }
      try { stream.off("close", onTransportGone); } catch { /* ignore */ }
      try { stream.off("end", onTransportGone); } catch { /* ignore */ }
      try { stream.off("error", onTransportGone); } catch { /* ignore */ }
      if (signal) {
        try { signal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
      }
      if (err) reject(err);
      else resolve();
    };

    stream.once("drain", onDrain);
    stream.once("close", onTransportGone);
    stream.once("end", onTransportGone);
    stream.once("error", onTransportGone);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const scheduleTimeoutCheck = () => {
      if (timeoutMs <= 0 || settled) return;
      const configuredInterval = Number(opts.progressIntervalMs);
      const intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
        ? Math.min(configuredInterval, timeoutMs)
        : timeoutMs;
      const idleMs = Date.now() - lastProgressAt;
      timer = setTimeout(() => {
        const currentProgressValue = readProgressValue();
        if (!Object.is(currentProgressValue, lastProgressValue)) {
          lastProgressAt = Date.now();
        }
        lastProgressValue = currentProgressValue;
        if (Date.now() - lastProgressAt < timeoutMs) {
          scheduleTimeoutCheck();
          return;
        }
        const err = new Error("Transport drain timeout");
        err.code = "NETCATTY_ZMODEM_TIMEOUT";
        finish(err);
      }, Math.max(1, Math.min(intervalMs, timeoutMs - idleMs)));
    };
    scheduleTimeoutCheck();

    // Drain may have cleared between write(false) and listener attach.
    if (stream.writableNeedDrain === false) finish();
  });
}

/**
 * Build the upload-loop drain waiter used by createZmodemSentry.
 * When the transport provides waitForTransportDrain, pause until that
 * promise settles. Otherwise fall back to one event-loop yield.
 *
 * Transport-drain timeouts reject with NETCATTY_ZMODEM_TIMEOUT and never
 * pass through waitForUploadHandshake, so apply the same onUploadTimeout +
 * abortRemoteProcess recovery here before rethrowing (stuck rz after cancel).
 * Transfer cancellation rejects with NETCATTY_ZMODEM_CANCELLED and must not
 * run that timeout recovery (cancel already aborted the remote).
 *
 * @param {{
 *   getNeedsDrain: () => boolean,
 *   clearNeedsDrain: () => void,
 *   waitForTransportDrain?: (opts?: { signal?: AbortSignal }) => Promise<void> | void,
 *   signal?: AbortSignal,
 *   onUploadTimeout?: () => void,
 *   writeToRemote?: (data: any) => void,
 * }} opts
 * @returns {() => Promise<void>}
 */
function createZmodemUploadDrainWaiter(opts) {
  return async function waitForDrain() {
    if (opts.signal?.aborted) {
      throw createZmodemCancelledError();
    }
    if (!opts.getNeedsDrain()) return;

    if (typeof opts.waitForTransportDrain === "function") {
      try {
        const drainOpts = opts.signal ? { signal: opts.signal } : undefined;
        await racePromiseWithAbortSignal(
          opts.waitForTransportDrain(drainOpts),
          opts.signal,
        );
      } catch (err) {
        if (isZmodemTimeoutError(err)) {
          try { opts.onUploadTimeout?.(); } catch { /* ignore */ }
          if (typeof opts.writeToRemote === "function") {
            abortRemoteProcess(opts.writeToRemote);
          }
        }
        throw err;
      } finally {
        opts.clearNeedsDrain();
      }
      return;
    }

    opts.clearNeedsDrain();
    await racePromiseWithAbortSignal(
      new Promise((resolve) => setImmediate(resolve)),
      opts.signal,
    );
  };
}

/**
 * Resolve when `promise` settles, or reject with NETCATTY_ZMODEM_CANCELLED
 * if `signal` aborts first. Used so cancel unblocks upload drain waits even
 * when a transport helper ignores the AbortSignal.
 *
 * @param {Promise<void> | void} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function racePromiseWithAbortSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(createZmodemCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createZmodemCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
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

function resolveUploadFileEndTimeoutMs(opts) {
  const normalTimeout = resolveTimeoutMs(
    opts.uploadFileEndTimeoutMs,
    UPLOAD_FILE_END_TIMEOUT_MS,
  );
  const slowTimeout = resolveTimeoutMs(
    opts.slowUploadFileEndTimeoutMs,
    UPLOAD_BACKPRESSURE_FILE_END_TIMEOUT_MS,
  );

  return opts.hasUploadBackpressure?.()
    ? Math.max(normalTimeout, slowTimeout)
    : normalTimeout;
}

async function waitForUploadHandshake(promise, ms, message, opts) {
  try {
    return await withTimeout(
      racePromiseWithAbortSignal(promise, opts?.signal),
      ms,
      message,
    );
  } catch (err) {
    if (isZmodemTimeoutError(err)) {
      try { opts.onUploadTimeout?.(); } catch { /* ignore */ }
      abortRemoteProcess(opts.writeToRemote);
    }
    throw err;
  }
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
  const uploadSessionCloseTimeoutMs = resolveTimeoutMs(
    opts.uploadSessionCloseTimeoutMs,
    UPLOAD_SESSION_CLOSE_TIMEOUT_MS,
  );

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
    const result = opts.selectUploadFiles
      ? await opts.selectUploadFiles({ sessionId, contents })
      : await (async () => {
        const win = contents ? BrowserWindow.fromWebContents(contents) : null;
        return dialog.showOpenDialog(win || undefined, {
          properties: ["openFile", "multiSelections"],
          title: "Select files to upload (ZMODEM)",
        });
      })();

    if (result.canceled || !result.filePaths.length) {
      try { zsession.abort(); } catch { /* ignore */ }
      abortRemoteProcess(opts.writeToRemote);
      throw new Error("Transfer cancelled");
    }

    filePaths = result.filePaths;
    allNames = filePaths.map((fp) => path.basename(fp));
  }

  try {
    throwIfZmodemCancelled(opts.signal);
    const fileStats = filePaths.map((fp) => fs.statSync(fp));

  // Conflict handling (SSH only — callbacks absent on local/telnet/serial).
  // On probe failure we still offer files; rz -y (drag-drop) or an explicit
  // overwrite decision should replace same-named remotes. If the receiver
  // still ZSKIPs, we fail below instead of reporting a false success (#2863).
  const isDragDropUpload = Boolean(dragDrop?.filePaths?.length);
  let plan = { offerIndices: allNames.map((_, i) => i), removeIndices: [], aborted: false };
  let probeDir = null;
  let probeModes = null;
  // Drag-drop already starts rz with -y, so let the receiver replace files in
  // place. Pre-deleting a conflict would lose the original if the offer or
  // transfer fails before the replacement is committed.
  if (!isDragDropUpload && opts.probeReceiveConflicts && opts.requestOverwriteDecision) {
    try {
      const probe = await racePromiseWithAbortSignal(
        opts.probeReceiveConflicts(allNames, { signal: opts.signal }),
        opts.signal,
      );
      throwIfZmodemCancelled(opts.signal);
      if (probe && probe.dir && Array.isArray(probe.existing) && probe.existing.length > 0) {
        probeDir = probe.dir;
        probeModes = probe.modes || {};
        plan = await buildUploadPlan(
          allNames,
          probe.existing,
          opts.requestOverwriteDecision,
          opts.signal,
        );
        throwIfZmodemCancelled(opts.signal);
        if (plan.aborted) {
          try { zsession.abort(); } catch { /* ignore */ }
          abortRemoteProcess(opts.writeToRemote);
          throw new Error("Transfer cancelled");
        }
        if (plan.removeIndices.length && opts.removeRemoteFiles) {
          throwIfZmodemCancelled(opts.signal);
          const base = probe.dir.replace(/\/+$/, "");
          const targets = [...new Set(plan.removeIndices.map((i) => `${base}/${allNames[i]}`))];
          try {
            await racePromiseWithAbortSignal(
              opts.removeRemoteFiles(targets, { signal: opts.signal }),
              opts.signal,
            );
            throwIfZmodemCancelled(opts.signal);
          } catch (err) {
            if (isZmodemCancelledError(err)) throw err;
            console.warn("[ZMODEM] removeRemoteFiles failed; rz will skip:", err?.message || err);
          }
        }
      }
    } catch (err) {
      if (
        (err instanceof Error && err.message === "Transfer cancelled") ||
        isZmodemCancelledError(err)
      ) throw err;
      console.warn("[ZMODEM] conflict probe failed; proceeding:", err?.message || err);
    }
  }

  const offers = plan.offerIndices.map((i) => ({
    originalIndex: i,
    filePath: filePaths[i],
    stat: fileStats[i],
    name: allNames[i],
  }));
  const skippedOfferIndices = [];

  for (let i = 0; i < offers.length; i++) {
    throwIfZmodemCancelled(opts.signal);
    const { originalIndex, filePath, stat, name } = offers[i];
    opts.resetUploadBackpressure?.();

    safeSend(getWebContents(), "netcatty:zmodem:progress", {
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

    // The offer handshake is the only upload step without a built-in
    // deadline: if rz dies before answering ZFILE (crash, YMODEM fallback),
    // send_offer() would park this loop forever and block all future
    // ZMODEM transfers. Bound it like xfer.end() / zsession.close().
    throwIfZmodemCancelled(opts.signal);
    const xfer = await waitForUploadHandshake(
      zsession.send_offer({
        name,
        size: stat.size,
        mtime: new Date(stat.mtimeMs),
        files_remaining: offers.length - i,
        bytes_remaining: bytesRemaining,
      }),
      resolveUploadFileEndTimeoutMs(opts),
      `Remote did not respond to the offer for ${name}. The upload was stopped so the terminal can recover.`,
      opts,
    );

    if (!xfer) {
      // Receiver protected/skipped this file (e.g. rz without -y).
      skippedOfferIndices.push(originalIndex);
      continue;
    }

    // Read and send in chunks
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(UPLOAD_CHUNK_SIZE);
    let sent = 0;
    // Progress IPC is throttled by default for every transport. Pass 0 only
    // when a caller explicitly needs one event per chunk.
    const progressThrottleMs = resolveProgressThrottleMs(opts.progressThrottleMs);
    let lastProgressEmitAt = -Infinity;

    try {
      while (true) {
        const bytesRead = fs.readSync(fd, buf, 0, UPLOAD_CHUNK_SIZE);
        if (bytesRead === 0) break;

        // zmodem.js send() is synchronous and triggers writeToRemote via
        // the sentry's sender callback.  Yield after each chunk so the
        // event loop can flush buffered writes and process inbound control
        // frames, preventing unbounded memory growth on slow links.
        xfer.send(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
        sent += bytesRead;

        const now = Date.now();
        if (progressThrottleMs === 0 || now - lastProgressEmitAt >= progressThrottleMs) {
          safeSend(getWebContents(), "netcatty:zmodem:progress", {
            sessionId,
            filename: name,
            transferred: sent,
            total: stat.size,
            fileIndex: i,
            fileCount: offers.length,
            transferType: "upload",
          });
          lastProgressEmitAt = now;
        }

        // Wait for transport to drain if its buffer is full, then yield
        // so inbound ZMODEM control frames can be processed.
        if (opts.waitForDrain) await opts.waitForDrain();
        await yieldToIO();
      }
      // All data written to Node.js buffer — but TCP may still be
      // flushing to the remote.  Show "finalizing" state while we
      // wait for the remote to acknowledge.
      safeSend(getWebContents(), "netcatty:zmodem:progress", {
        sessionId,
        filename: name,
        transferred: stat.size,
        total: stat.size,
        fileIndex: i,
        fileCount: offers.length,
        transferType: "upload",
        finalizing: true,
      });
      await waitForUploadHandshake(
        xfer.end(),
        resolveUploadFileEndTimeoutMs(opts),
        `Remote did not confirm receiving ${name}. The upload was stopped so the terminal can recover.`,
        opts,
      );
    } finally {
      fs.closeSync(fd);
    }
  }

  // rz re-creates overwritten files with the remote umask, dropping their
  // original permission bits. Restore modes for files that landed on disk
  // (including when a later offer is ZSKIP'd and we abort the batch — #1079).
  // Filter by original offer index (not basename) so a duplicate-name ZSKIP
  // does not suppress mode restore for an earlier accepted overwrite.
  async function restoreAcceptedOverwriteModes(skippedIndices) {
    if (!plan.removeIndices.length || !probeDir || !opts.restoreRemoteModes) return;
    const skippedSet = skippedIndices?.length ? new Set(skippedIndices) : null;
    const restoreIndices = skippedSet
      ? plan.removeIndices.filter((i) => !skippedSet.has(i))
      : plan.removeIndices;
    if (!restoreIndices.length) return;
    const restores = buildModeRestores(probeDir, allNames, restoreIndices, probeModes);
    if (!restores.length) return;
    try {
      await racePromiseWithAbortSignal(
        opts.restoreRemoteModes(restores, { signal: opts.signal }),
        opts.signal,
      );
      throwIfZmodemCancelled(opts.signal);
    } catch (err) {
      if (isZmodemCancelledError(err)) throw err;
      console.warn("[ZMODEM] restoreRemoteModes failed:", err?.message || err);
    }
  }

  if (skippedOfferIndices.length > 0) {
    try { zsession.abort(); } catch { /* ignore */ }
    abortRemoteProcess(opts.writeToRemote);
    await restoreAcceptedOverwriteModes(skippedOfferIndices);
    const listed = skippedOfferIndices.map((idx) => allNames[idx]).join(", ");
    throw new Error(
      skippedOfferIndices.length === offers.length
        ? `Remote protected existing files and skipped the upload (not overwritten): ${listed}`
        : `Remote skipped some files (not overwritten): ${listed}`,
    );
  }

  await waitForUploadHandshake(
    zsession.close(),
    uploadSessionCloseTimeoutMs,
    "Remote did not finish the ZMODEM upload session in time. The upload was stopped so the terminal can recover.",
    opts,
  );

  await restoreAcceptedOverwriteModes();

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

    safeSend(getWebContents(), "netcatty:zmodem:progress", {
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
        // payload is a number[] on the original zmodem.js pipeline and a
        // Uint8Array on the fast path; take a zero-copy view in the fast
        // case instead of copying every payload byte again.
        const chunk = Array.isArray(payload)
          ? Buffer.from(payload)
          : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
        ws.write(chunk);
        received += chunk.length;

        // Throttle progress IPC to ~10 updates/sec to avoid
        // overwhelming the renderer on fast links.
        const now = Date.now();
        if (now - lastProgressTime >= 100) {
          lastProgressTime = now;
          safeSend(getWebContents(), "netcatty:zmodem:progress", {
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

  const result = opts.selectDownloadDirectory
    ? await opts.selectDownloadDirectory({ sessionId, contents })
    : await (async () => {
      const win = contents ? BrowserWindow.fromWebContents(contents) : null;
      return dialog.showOpenDialog(win || undefined, {
        properties: ["openDirectory", "createDirectory"],
        title: "Select download directory (ZMODEM)",
      });
    })();

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

module.exports = {
  createZmodemSentry,
  buildUploadPlan,
  buildModeRestores,
  handleUpload,
  handleDownload,
  waitForWritableDrain,
  createZmodemUploadDrainWaiter,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_DRAIN_TIMEOUT_MS,
};
