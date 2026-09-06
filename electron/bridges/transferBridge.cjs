/**
 * Transfer Bridge - Handles file transfers with progress and cancellation
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const tempDirBridge = require("./tempDirBridge.cjs");
const {
  encodePathForSession,
  ensureRemoteDirForSession,
  runRemoteUploadTransaction,
  requireSftpChannel,
  resolveEncodingForRequest,
} = require("./sftpBridge.cjs");
const { isScpModeClient, getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
const { executeBoundedSshCommand } = require("./boundedSshExec.cjs");
const { openBoundedSftpChannel } = require("./boundedSftpOpen.cjs");
const {
  DOWNLOAD_TRANSFER_CONCURRENCY,
  FAST_DOWNLOAD_CHANNELS_PER_SESSION,
  SFTP_OPEN_TIMEOUT_MS,
  SFTP_REQUEST_TIMEOUT_MS,
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
} = require("./transferLimits.cjs");

/**
 * Soft cap for concurrent-range pause drain. Short grace lets already-finished
 * range callbacks land so checkpointBytes is not always 0, without waiting for
 * the full in-flight window (was multi-second "finish current step").
 */
const PAUSE_RANGE_DRAIN_MS = 50;
/** Cap stream drain / pending-open waits for non-concurrent (pipe) pauses. */
const PAUSE_STREAM_DRAIN_MS = 80;
/**
 * Max time resume waits for leftover concurrent ranges after soft-drain pause.
 * Was 1.5s — real SSH writes often exceed that under concurrency, so a second
 * pause→resume mid-file surfaced "still finishing" while ranges were healthy.
 * Background settle (scheduleDeferredSparseTruncateSettle) usually clears the
 * flag before the user clicks Resume; this is the safety wait on that click.
 */
const RESUME_RANGE_SETTLE_MS = Number(process.env.NETCATTY_RESUME_RANGE_SETTLE_MS) > 0
  ? Number(process.env.NETCATTY_RESUME_RANGE_SETTLE_MS)
  : 60_000;
/** Poll interval while waiting for in-flight concurrent ranges to finish. */
const RANGE_SETTLE_POLL_MS = 20;
const internalTransferIds = new Set();

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single-flight *truncate only* (after active ranges are already idle).
 * Wait loops are per-caller so Resume can enforce its own 60s budget without
 * joining a multi-minute background wait, and a failed attempt does not stick
 * forever on the transfer.
 */
function runExclusiveSparseTruncate(transfer) {
  if (!transfer) {
    return Promise.resolve({ ok: false, reason: "Transfer is no longer active" });
  }
  if (!transfer.deferredSparseTruncate) {
    return Promise.resolve({ ok: true });
  }
  if (transfer._sparseTruncatePromise) {
    return transfer._sparseTruncatePromise;
  }
  const run = (async () => {
    try {
      const activeLeft = typeof transfer.getActiveRangeCount === "function"
        ? transfer.getActiveRangeCount()
        : 0;
      if (activeLeft > 0) {
        return {
          ok: false,
          reason: "The current file is still finishing. Try resume again.",
        };
      }
      try {
        await prepareStreamFallbackAfterRangeFailure(transfer, transfer.stagedRemote?.client);
      } catch {
        // Contiguous checkpoint remains valid for resume.
      }
      transfer.deferredSparseTruncate = false;
      return { ok: true };
    } finally {
      // Always clear so a later Resume can retry after ranges finish.
      if (transfer._sparseTruncatePromise === run) {
        transfer._sparseTruncatePromise = null;
      }
    }
  })();
  transfer._sparseTruncatePromise = run;
  return run;
}

/**
 * Wait for active concurrent ranges (caller-owned deadline), then exclusive truncate.
 */
async function ensureDeferredSparseFinalize(transfer, transferId, options = {}) {
  if (!transfer) {
    return { ok: false, reason: "Transfer is no longer active" };
  }
  if (!transfer.deferredSparseTruncate && !transfer._sparseTruncatePromise) {
    return { ok: true };
  }
  const maxWaitMs = Number.isFinite(options.maxWaitMs)
    ? options.maxWaitMs
    : RESUME_RANGE_SETTLE_MS;
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  while (
    transfer.paused
    && !transfer.cancelled
    && activeTransfers.get(transferId) === transfer
    && transfer.deferredSparseTruncate
    && typeof transfer.getActiveRangeCount === "function"
    && transfer.getActiveRangeCount() > 0
    && Date.now() < deadline
  ) {
    await sleepMs(RANGE_SETTLE_POLL_MS);
  }
  if (transfer.cancelled || activeTransfers.get(transferId) !== transfer) {
    return { ok: false, reason: "Transfer is no longer active" };
  }
  if (!transfer.deferredSparseTruncate) {
    return { ok: true };
  }
  const activeLeft = typeof transfer.getActiveRangeCount === "function"
    ? transfer.getActiveRangeCount()
    : 0;
  if (activeLeft > 0) {
    return {
      ok: false,
      reason: "The current file is still finishing. Try resume again.",
    };
  }
  return runExclusiveSparseTruncate(transfer);
}

/** Fire-and-forget background settle after soft-drain pause. */
function scheduleDeferredSparseTruncateSettle(transfer, transferId) {
  if (!transfer?.deferredSparseTruncate) return;
  void ensureDeferredSparseFinalize(transfer, transferId, {
    // Background may wait longer for slow SSH ranges while UI stays paused.
    maxWaitMs: Math.max(RESUME_RANGE_SETTLE_MS, 5 * 60_000),
  }).catch(() => {});
}

/**
 * Fan transfer lifecycle to every window so the global transfer center keeps
 * updating after the originating SFTP panel is hidden or unmounted.
 * This is the sole renderer-facing transfer event channel.
 *
 * @param {object} payload
 */
function broadcastGlobalTransferEvent(payload) {
  if (!payload || !payload.transferId) return;
  if (internalTransferIds.has(String(payload.transferId))) return;
  // Bare Node unit tests must never require("electron"): that package's entry
  // downloads the binary when dist/ is missing, hanging transferBridge tests
  // for tens of seconds per progress/pause event. process.versions.electron is
  // only set inside a real Electron main/renderer process.
  if (typeof process.versions?.electron !== "string") return;
  try {
    const electron = require("electron");
    // Outside Electron, require("electron") is a path string — not the API.
    if (!electron || typeof electron !== "object") return;
    const BrowserWindow = electron.BrowserWindow;
    if (!BrowserWindow?.getAllWindows) return;
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win?.isDestroyed?.()) continue;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed?.()) continue;
        wc.send("netcatty:sftp:global-transfer", payload);
      } catch {
        // best-effort per window
      }
    }
  } catch {
    // electron unavailable
  }
}

function inferTransferDirection(payload) {
  if (payload?.sourceType === "local" && payload?.targetType === "sftp") return "upload";
  if (payload?.sourceType === "sftp" && payload?.targetType === "local") return "download";
  if (payload?.sourceType === "sftp" && payload?.targetType === "sftp") return "remote-to-remote";
  return "local-copy";
}

function buildTransferLifecycleEvent(type, payload) {
  const sourcePath = payload?.sourcePath || "";
  const targetPath = payload?.targetPath || "";
  return {
    type,
    transferId: payload?.transferId,
    direction: inferTransferDirection(payload),
    fileName: (targetPath || sourcePath).split(/[\\/]/).pop() || payload?.transferId,
    sourcePath,
    targetPath,
    sourceHostId: payload?.sourceHostId,
    targetHostId: payload?.targetHostId,
    parentTaskId: payload?.parentTaskId,
    directoryEntryIndex: payload?.directoryEntryIndex,
    directoryEntryIdentity: payload?.directoryEntryIdentity,
    totalBytes: Math.max(0, Number(payload?.totalBytes) || 0),
    isDirectory: payload?.isDirectory === true,
    controlKind: "stream",
    resumable: payload?.resumable === true,
    lifecycleEpoch: Math.max(0, Number(payload?.lifecycleEpoch) || 0),
    lifecycleState: type === "queued" ? "queued" : "transferring",
    startedAt: Date.now(),
  };
}

/**
 * Verify a completed remote upload matches the expected byte count.
 * Without this check, fastPut/stream uploads can report success while leaving
 * a truncated file on servers that mishandle large WRITE packets (#2022).
 */
async function assertRemoteUploadSize(client, remotePath, expectedSize) {
  if (!Number.isFinite(expectedSize) || expectedSize < 0) return;
  if (!client || typeof client.stat !== "function") return;

  let attrs;
  try {
    attrs = await client.stat(remotePath);
  } catch (err) {
    throw new Error(
      `Upload completed but remote file could not be verified (${remotePath}): ${err.message || String(err)}`,
    );
  }

  const remoteSize = Number(attrs?.size);
  if (!Number.isFinite(remoteSize)) {
    throw new Error(`Upload completed but remote file size is unavailable (${remotePath})`);
  }
  if (remoteSize !== expectedSize) {
    throw new Error(
      `Upload size mismatch for ${remotePath}: expected ${expectedSize} bytes, got ${remoteSize}`,
    );
  }
}

function existingModeFromUploadPlan(plan) {
  if (!Number.isFinite(plan?.existingMode)) return null;
  return plan.existingMode & 0o7777;
}

/**
 * Best-effort chmod of captured mode bits onto the published remote path.
 * Failures are warnings only (same as writeSftp); upload bytes are already committed.
 */
async function restoreRemoteUploadModeBestEffort(client, sftpId, remotePath, encoding, existingMode, options = {}) {
  if (!client || existingMode == null || !Number.isFinite(existingMode)) return;
  const mode = existingMode & 0o7777;
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : (Number(process.env.NETCATTY_REMOTE_MODE_RESTORE_TIMEOUT_MS) > 0
      ? Number(process.env.NETCATTY_REMOTE_MODE_RESTORE_TIMEOUT_MS)
      : 15_000);
  try {
    // Post-commit: cancelTransfer will not abort. Bound the wait so a stalled
    // chmod cannot pin the transfer, SFTP lease, or admission slot.
    await awaitBestEffortBounded((async () => {
      if (isScpModeClient(client)) {
        const backend = getScpBackendForClient(client);
        if (typeof backend.chmod !== "function") return;
        await backend.chmod(remotePath, mode, { encoding });
        return;
      }
      const encodedPath = encodePathForSession(sftpId, remotePath, encoding);
      if (typeof client.chmod === "function") {
        await client.chmod(encodedPath, mode);
        return;
      }
      const sftp = client.sftp;
      if (sftp && typeof sftp.chmod === "function") {
        await new Promise((resolve, reject) => {
          sftp.chmod(encodedPath, mode, (err) => (err ? reject(err) : resolve()));
        });
        return;
      }
      if (sftp && typeof sftp.setstat === "function") {
        await new Promise((resolve, reject) => {
          sftp.setstat(encodedPath, { mode }, (err) => (err ? reject(err) : resolve()));
        });
      }
    })(), timeoutMs, "Remote chmod");
  } catch (err) {
    console.warn(
      `[sftp] Failed to restore permissions on ${remotePath}:`,
      err && err.message ? err.message : err,
    );
  }
}

/**
 * Safely ensure a local directory exists.
 * On Windows, `mkdir("E:\\", { recursive: true })` throws EPERM for drive roots.
 * We catch that and verify the directory already exists before re-throwing.
 */
async function ensureLocalDir(dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    // If the directory already exists, ignore the error (covers EPERM on drive roots)
    try {
      const stat = await fs.promises.stat(dir);
      if (stat.isDirectory()) return;
    } catch { /* stat failed, re-throw original */ }
    throw err;
  }
}

function buildRemoteTransferStagePath(targetPath, transferId) {
  const dir = path.posix.dirname(targetPath);
  const base = path.posix.basename(targetPath);
  const safeId = String(transferId).replace(/[^A-Za-z0-9_-]/g, "_");
  return path.posix.join(dir, `.${base}.netcatty-${safeId}.part`);
}

/**
 * True when `filePath` is a deterministic resumable stage that same-id retries
 * reuse (`.${base}.netcatty-${transferId}.part`). Non-resumable uploads use a
 * fresh `.netcatty-upload-...` path per attempt and must not match.
 */
function isReusableRemoteTransferStagePath(filePath, transferId) {
  if (transferId == null || transferId === "") return false;
  const safeId = String(transferId).replace(/[^A-Za-z0-9_-]/g, "_");
  if (!safeId) return false;
  const base = path.posix.basename(String(filePath || ""));
  // buildRemoteTransferStagePath → `.${name}.netcatty-${safeId}.part`
  // non-resumable stages → `.netcatty-upload-${uuid}-....part`
  return (
    base.startsWith(".")
    && base.endsWith(`.netcatty-${safeId}.part`)
    && !base.startsWith(".netcatty-upload-")
  );
}

/**
 * True when an OPEN path refers to the same remote stage as `stagedRemote`.
 *
 * OPEN may receive a session-encoded Buffer (non-utf8 / non-ascii) while
 * stagedRemote.path stays the logical string. Compare both representations.
 *
 * @param {string | Buffer | null | undefined} openPath
 * @param {{ path?: string, sftpId?: string, encoding?: string } | null | undefined} stagedRemote
 */
function remoteOpenPathMatchesStaged(openPath, stagedRemote) {
  const logical = stagedRemote?.path;
  if (openPath == null || logical == null || logical === "") return false;
  if (openPath === logical) return true;
  let encoded = logical;
  if (stagedRemote.sftpId) {
    try {
      encoded = encodePathForSession(
        stagedRemote.sftpId,
        logical,
        stagedRemote.encoding,
      );
    } catch {
      encoded = logical;
    }
  }
  if (openPath === encoded) return true;
  if (Buffer.isBuffer(openPath) && Buffer.isBuffer(encoded)) {
    return openPath.equals(encoded);
  }
  // OPEN Buffer vs logical/encoded string (utf-8/ascii encodePath returns string).
  if (Buffer.isBuffer(openPath) && typeof encoded === "string") {
    return openPath.equals(Buffer.from(encoded));
  }
  if (typeof openPath === "string" && Buffer.isBuffer(encoded)) {
    return encoded.equals(Buffer.from(openPath));
  }
  return false;
}

/**
 * Serialize truncating shared-write OPENs on the same remote path.
 *
 * A drain force-complete can let attempt N return while its OPEN "w" is still
 * in flight. Same-id retries reuse deterministic `.netcatty-<id>.part` stages;
 * if the stale OPEN lands after the retry has begun writing, the server
 * truncates the retry stage and a later size check can promote sparse data
 * (Codex P1 on 42a27ef7). Wait for any prior OPEN on the path to settle before
 * issuing another truncating OPEN; release on OPEN callback so a late truncating
 * OPEN cannot race a retry. When an OPEN dies without a callback, fail() poisons
 * the entry so later waiters reject promptly (fail-closed) instead of hanging
 * forever on waitForPrior (#2755 / Codex P2 on dca41093).
 *
 * @type {Map<string, {
 *   promise: Promise<void>,
 *   resolve: () => void,
 *   reject: (err: Error) => void,
 *   released: boolean,
 *   failed: boolean,
 *   failError: Error | null,
 * }>}
 */
const truncatingSharedWriteOpenGates = new Map();
/** @type {WeakMap<object, string>} */
const truncatingSharedWriteSftpKeys = new WeakMap();
let truncatingSharedWriteSftpSeq = 0;

function createPoisonedWriteOpenPathGateError(message) {
  const err = new Error(
    message || "Prior write OPEN never settled; path gate is fail-closed",
  );
  err.noTransferFallback = true;
  return err;
}

function sharedWriteOpenPathKey(filePath) {
  if (Buffer.isBuffer(filePath)) return `b:${filePath.toString("hex")}`;
  return `s:${String(filePath ?? "")}`;
}

/**
 * Scope path gates per SFTP endpoint so two hosts with the same remote path do
 * not serialize each other (Codex P2 on c3682460).
 * @param {object | null | undefined} sftp
 * @param {object | null | undefined} transfer
 */
function sharedWriteOpenSessionKey(sftp, transfer) {
  // Prefer host identity so an isolated-channel retry still waits for a stale
  // shared OPEN on the same host path (Codex P1 on 294b7a4b). Fall back to
  // sftp/session ids when host is unknown.
  const hostKey = transfer?.targetHostId || transfer?.hostId || transfer?.sourceHostId;
  if (hostKey != null && String(hostKey).length > 0) {
    return `host:${String(hostKey)}`;
  }
  const fromTransfer = transfer?.targetSftpId
    || transfer?.sourceSftpId
    || transfer?.sftpId
    || transfer?.sessionId;
  if (fromTransfer != null && String(fromTransfer).length > 0) {
    return `id:${String(fromTransfer)}`;
  }
  if (sftp && typeof sftp === "object") {
    let key = truncatingSharedWriteSftpKeys.get(sftp);
    if (!key) {
      truncatingSharedWriteSftpSeq += 1;
      key = `obj:${truncatingSharedWriteSftpSeq}`;
      truncatingSharedWriteSftpKeys.set(sftp, key);
    }
    return key;
  }
  return "unknown";
}

/**
 * @param {string | Buffer} filePath
 * @param {string} [sessionKey]
 * @returns {{
 *   waitForPrior: Promise<void>,
 *   release: () => void,
 *   fail: (err?: Error, options?: { reinstall?: boolean }) => void,
 *   markOpenIssued: () => void,
 *   releaseAfterTransportGone: () => void,
 * }}
 */
function beginTruncatingSharedWriteOpen(filePath, sessionKey = "unknown") {
  const key = `${sessionKey}|${sharedWriteOpenPathKey(filePath)}`;
  const prior = truncatingSharedWriteOpenGates.get(key);

  // Poisoned prior: keep the fail-closed barrier. Do not replace the map entry
  // with a fresh waiter that could release and let a later OPEN race a still-
  // pending truncate. New callers fail promptly on waitForPrior.
  if (prior?.failed) {
    const err = prior.failError || createPoisonedWriteOpenPathGateError();
    return {
      waitForPrior: Promise.reject(err),
      release: () => {},
      fail: () => {},
      markOpenIssued: () => {},
      releaseAfterTransportGone: () => {},
    };
  }

  const waitForPrior = prior && !prior.released
    ? prior.promise
    : Promise.resolve();

  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Avoid unhandledRejection when nobody awaits yet (fail before waiters attach).
  promise.catch(() => {});
  const entry = {
    promise,
    resolve: () => {
      resolve();
    },
    reject: (err) => {
      reject(err);
    },
    released: false,
    failed: false,
    failError: null,
    // True once this entry has started the remote OPEN. Waiters that only
    // block on a prior must not act as the OPEN owner for poison cleanup.
    openIssued: false,
    priorEntry: prior && !prior.released ? prior : null,
    transportGone: false,
    transportGoneTimer: null,
    releaseAfterTransportGone: null,
  };
  truncatingSharedWriteOpenGates.set(key, entry);

  const release = () => {
    if (entry.released) return;
    entry.released = true;
    if (entry.transportGoneTimer) {
      clearTimeout(entry.transportGoneTimer);
      entry.transportGoneTimer = null;
    }
    if (truncatingSharedWriteOpenGates.get(key) === entry) {
      truncatingSharedWriteOpenGates.delete(key);
    }
    // Already failed: promise rejected; drop the barrier once OPEN settled.
    if (entry.failed) return;
    entry.resolve();
  };

  /**
   * After the owning SFTP transport is closed/replaced, clear a poisoned
   * barrier so reconnects to the same host/path are not fail-closed forever.
   * Keep a short grace so a late OPEN callback that still races end() cannot
   * wipe a same-path retry with no barrier (Codex P2 on 713719c2).
   */
  const releaseAfterTransportGone = () => {
    entry.transportGone = true;
    if (!entry.failed || entry.released || entry.transportGoneTimer) return;
    entry.transportGoneTimer = setTimeout(() => {
      entry.transportGoneTimer = null;
      if (entry.released || !entry.failed) return;
      release();
    }, 2000);
  };
  entry.releaseAfterTransportGone = releaseAfterTransportGone;

  const markOpenIssued = () => {
    entry.openIssued = true;
  };

  /**
   * @param {Error} [error]
   * @param {{ reinstall?: boolean }} [options]
   *   reinstall — when true (default), make the OPEN-owning entry the durable
   *   map barrier. Successor waiters that only propagate a prior poison must
   *   pass false so they cannot steal the slot (Codex P2 on 64450bfd).
   */
  const fail = (error, options = {}) => {
    const wantReinstall = options.reinstall !== false;
    const err = error instanceof Error
      ? error
      : createPoisonedWriteOpenPathGateError(String(error?.message || error || ""));
    if (!err.noTransferFallback) err.noTransferFallback = true;

    if (!entry.released && !entry.failed) {
      entry.failed = true;
      entry.failError = err;
      entry.reject(err);
    }

    // A successor waiter may already own the map slot. Poison that head too so
    // its promise cannot resolve and clear the barrier for a third upload while
    // the original truncating OPEN may still land (Codex P1 on 0292802c).
    const current = truncatingSharedWriteOpenGates.get(key);
    if (current && current !== entry && !current.released && !current.failed) {
      current.failed = true;
      current.failError = err;
      current.reject(err);
    }

    if (!wantReinstall || entry.released) return;

    // Prefer the OPEN-owning ancestor as the durable barrier. A waiter that
    // reaches fastPut timeout must not reinstall itself and arm transport
    // cleanup while the prior OPEN's channel may still deliver a late truncate
    // (Codex P1 on 251bf9ec).
    let barrier = entry;
    if (!entry.openIssued) {
      let cursor = entry.priorEntry;
      while (cursor && !cursor.released) {
        barrier = cursor;
        if (cursor.openIssued || !cursor.priorEntry || cursor.priorEntry.released) break;
        cursor = cursor.priorEntry;
      }
      if (!barrier.failed) {
        barrier.failed = true;
        barrier.failError = err;
        try { barrier.reject(err); } catch { /* ignore */ }
      }
    }
    truncatingSharedWriteOpenGates.set(key, barrier);
    // Arm post-transport clear only when THIS entry owns the unresolved OPEN
    // and is the one being poisoned (its isolated channel already ended before
    // fastPut timeout). A waiter fail() that walks to an ancestor must not
    // start that ancestor's cleanup while the ancestor's transport may still
    // deliver a late truncating OPEN (Codex P1 on 4f2397ce).
    if (barrier === entry && barrier.openIssued) {
      try { barrier.releaseAfterTransportGone?.(); } catch { /* ignore */ }
    }
  };

  return { waitForPrior, release, fail, markOpenIssued, releaseAfterTransportGone };
}

/**
 * Reconcile a claimed resume offset with durable staged bytes.
 *
 * Progress events update checkpointBytes as soon as data is handed to the write
 * stream — not when those bytes are fully flushed to disk/remote. After a hard
 * app quit the UI-persisted checkpoint is almost always ahead of the .part file,
 * so exact-size equality would reject resume ~100% of the time. Disk/remote size
 * is the source of truth for how far we can safely continue.
 *
 * Returns the safe resume offset (0 when the staged file is missing/unusable).
 */
async function resolveLocalResumeCheckpoint(filePath, claimedCheckpoint) {
  const claimed = Math.max(0, Number(claimedCheckpoint) || 0);
  if (!claimed) return 0;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return 0;
    // Never resume past durable bytes. If the file is larger than the claim,
    // keep the claim — the write stream overwrites from that offset.
    return Math.min(claimed, Math.max(0, Number(stat.size) || 0));
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw new Error(`Resume safety check failed for local temporary file: ${error.message || String(error)}`);
  }
}

async function resolveRemoteResumeCheckpoint(client, sftpId, filePath, encoding, claimedCheckpoint) {
  const claimed = Math.max(0, Number(claimedCheckpoint) || 0);
  if (!claimed) return 0;
  try {
    const stat = isScpModeClient(client)
      ? await getScpBackendForClient(client).stat(filePath, { encoding })
      : await client.stat(encodePathForSession(sftpId, filePath, encoding));
    return Math.min(claimed, Math.max(0, Number(stat?.size) || 0));
  } catch (error) {
    const message = error?.message || String(error);
    // Missing remote .part after kill/crash — start over instead of blocking forever.
    if (
      error?.code === "ENOENT"
      || error?.code === 2
      || /no such file|ENOENT|not found|does not exist/i.test(message)
    ) {
      return 0;
    }
    throw new Error(`Resume safety check failed for remote temporary file: ${message}`);
  }
}

async function hashReadable(readable, options = {}) {
  const { signal, onProgress } = options;
  const inactivityTimeoutMs = Number(options.inactivityTimeoutMs) > 0
    ? Number(options.inactivityTimeoutMs)
    : 0;
  const cancellationError = () => {
    const error = new Error("Transfer cancelled");
    error.code = "ABORT_ERR";
    return error;
  };
  const abortReadable = () => {
    try { readable.destroy?.(); } catch { /* ignore */ }
  };
  if (signal?.aborted) {
    abortReadable();
    throw cancellationError();
  }
  signal?.addEventListener?.("abort", abortReadable, { once: true });
  const hash = crypto.createHash("sha256");
  let bytesRead = 0;
  let timer = null;
  let rejectTimeout = null;
  const armInactivityTimer = () => {
    if (!inactivityTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error(`SFTP stream timed out after ${inactivityTimeoutMs} ms`);
      error.code = "SFTP_STREAM_TIMEOUT";
      error.sftpRequestTimedOut = true;
      try { readable.destroy?.(error); } catch { /* ignore */ }
      rejectTimeout?.(error);
    }, inactivityTimeoutMs);
  };
  const consume = (async () => {
    armInactivityTimer();
    try {
      for await (const chunk of readable) {
        if (signal?.aborted) throw cancellationError();
        hash.update(chunk);
        bytesRead += chunk.length;
        onProgress?.(bytesRead);
        armInactivityTimer();
      }
      if (signal?.aborted) throw cancellationError();
      return hash.digest("hex");
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      throw error;
    }
  })();
  try {
    if (!inactivityTimeoutMs) return await consume;
    const timeout = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    return await Promise.race([consume, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortReadable);
  }
}

const EMPTY_SHA256_HEX = crypto.createHash("sha256").update("").digest("hex");

function hashLocalPrefix(filePath, bytes, options) {
  if (!Number.isFinite(bytes) || bytes < 0) return Promise.resolve(null);
  if (bytes === 0) return Promise.resolve(EMPTY_SHA256_HEX);
  return hashReadable(fs.createReadStream(filePath, { start: 0, end: bytes - 1 }), options);
}

function hashLocalFile(filePath, options = {}) {
  return hashReadable(fs.createReadStream(filePath), options);
}

async function hashRemotePrefixViaSshCommand(client, remotePath, bytes, options = {}) {
  if (!Number.isFinite(bytes) || bytes <= 0 || isScpModeClient(client)) return null;
  // Sudo SFTP elevates the subsystem, but exec() still runs as the login user.
  // For a root-only source, head can fail while sha256sum/openssl still emit the
  // empty-input digest and exit 0 — skip the command path and use elevated SFTP.
  if (client?.__netcattySudoMode) return null;
  const sshClient = client?.client;
  if (!sshClient || typeof sshClient.exec !== "function") return null;

  if (typeof remotePath !== "string") return null;
  const byteCount = Math.floor(bytes);
  const escapedPath = remotePath.replace(/'/g, "'\\''");
  const commands = [
    `if command -v head >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1; then head -c ${byteCount} '${escapedPath}' | sha256sum; else exit 127; fi`,
    `if command -v busybox >/dev/null 2>&1; then busybox head -c ${byteCount} '${escapedPath}' | busybox sha256sum; else exit 127; fi`,
    `if command -v head >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1; then head -c ${byteCount} '${escapedPath}' | openssl dgst -sha256; else exit 127; fi`,
  ];

  for (const command of commands) {
    try {
      const result = await executeBoundedSshCommand(sshClient, command, {
        signal: options.signal,
        openingTimeoutMs: Number(options.sshDigestOpeningTimeoutMs) > 0
          ? Number(options.sshDigestOpeningTimeoutMs)
          : 15_000,
        runTimeoutMs: Number(options.sshDigestRunTimeoutMs) > 0
          ? Number(options.sshDigestRunTimeoutMs)
          : 10 * 60_000,
        maxOutputBytes: 64 * 1024,
      });
      if (result.code !== 0) continue;
      const match = String(result.stdout || "").match(/\b([a-fA-F0-9]{64})\b/);
      if (!match) continue;
      const digest = match[1].toLowerCase();
      // Empty-input digest with bytes > 0 means head failed open into the hasher.
      if (digest === EMPTY_SHA256_HEX) continue;
      return digest;
    } catch (error) {
      if (options.signal?.aborted || error?.code === "ABORT_ERR") {
        throw error;
      }
      // Run timeout: the exec stream opened, so the SSH transport is still valid.
      // Treat the optional digest as a miss and fall through to SFTP verification.
      if (error?.code === "SSH_EXEC_RUN_TIMEOUT") {
        return null;
      }
      // Open timeout invalidates the physical transport in boundedSshExec. Do not
      // continue into SFTP on this dead session — propagate so the caller fails
      // closed instead of hanging/failing obscurely on a poisoned channel.
      // Mark noTransferFallback so downloadFile's isolated→shared catch does not
      // retry verification/body transfer on the invalidated transport.
      if (error?.code === "SSH_EXEC_OPEN_TIMEOUT") {
        error.noTransferFallback = true;
        abandonWedgedVerificationSftpChannel(client);
        throw error;
      }
    }
  }
  return null;
}

async function hashRemoteFile(client, sftpId, filePath, encoding, options = {}) {
  if (isScpModeClient(client)) return null;
  const sshClient = client?.client;
  // The server-side helper has no portable byte progress and its command stream
  // is not consistently abortable across SSH backends. Visible/cancellable
  // verification therefore uses the SFTP stream path below.
  if (!options.signal && !options.onProgress && sshClient && typeof sshClient.exec === "function") {
    const escapedPath = String(filePath).replace(/'/g, "'\\''");
    const digest = await executeBoundedSshCommand(
      sshClient,
      `sha256sum -- '${escapedPath}'`,
      {
        openingTimeoutMs: 15_000,
        runTimeoutMs: 10 * 60_000,
        maxOutputBytes: 64 * 1024,
      },
    ).then(({ stdout, code }) => {
      const match = stdout.match(/^([a-fA-F0-9]{64})\s/);
      return code === 0 && match ? match[1].toLowerCase() : null;
    }).catch(() => null);
    if (digest) return digest;
  }
  if (!client.sftp) await requireSftpChannel(client, { signal: options.signal });
  if (typeof client.sftp?.createReadStream !== "function") {
    throw new Error("Remote SHA-256 verification is unavailable");
  }
  return hashReadable(
    client.sftp.createReadStream(encodePathForSession(sftpId, filePath, encoding)),
    options,
  );
}

/** @param {number|null|undefined} prefixBytes null = full file; >=0 = bounded prefix (incl. empty). */
function formatSourceFingerprint(digest, prefixBytes) {
  if (!digest) return null;
  if (Number.isFinite(prefixBytes) && prefixBytes >= 0) {
    return `sha256:p${Math.floor(prefixBytes)}:${digest}`;
  }
  return `sha256:${digest}`;
}

/** Extract the hex digest from legacy `sha256:hex` or versioned `sha256:pN:hex`. */
function sourceFingerprintDigest(fingerprint) {
  if (!fingerprint) return null;
  const match = String(fingerprint).match(/^sha256:(?:p\d+:)?([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function isLegacyFullSourceFingerprint(fingerprint) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(fingerprint || ""));
}

async function computeSourceFingerprint(
  { sourceType, sourcePath, sourceSftpId, sourceEncoding, prefixBytes },
  options = {},
) {
  // Finite prefixBytes (including 0) means a planned snapshot prefix. Omit / NaN
  // means hash the whole current source (uploads and legacy full-file paths).
  const hasBoundedPrefix = Number.isFinite(prefixBytes) && prefixBytes >= 0;
  const boundedPrefix = hasBoundedPrefix ? Math.floor(prefixBytes) : null;
  if (sourceType === "local") {
    if (hasBoundedPrefix) {
      const digest = await hashLocalPrefix(sourcePath, boundedPrefix, options);
      return formatSourceFingerprint(digest, boundedPrefix);
    }
    return formatSourceFingerprint(await hashLocalFile(sourcePath, options), null);
  }
  const client = sftpClients.get(sourceSftpId);
  if (!client) throw new Error("Source SFTP session not found");
  // Remote downloads transfer a fixed snapshot size. Hash only that prefix so
  // append-only growth (e.g. live log files) does not invalidate resume identity.
  if (hasBoundedPrefix) {
    const digest = await hashRemotePrefix(
      client,
      sourceSftpId,
      sourcePath,
      sourceEncoding,
      boundedPrefix,
      options,
    );
    return formatSourceFingerprint(digest, boundedPrefix);
  }
  const digest = await hashRemoteFile(client, sourceSftpId, sourcePath, sourceEncoding, options);
  return formatSourceFingerprint(digest, null);
}

function sourceFingerprintsMatch(storedFingerprint, currentFingerprint) {
  const stored = sourceFingerprintDigest(storedFingerprint);
  const current = sourceFingerprintDigest(currentFingerprint);
  return Boolean(stored && current && stored === current);
}

async function hashRemotePrefix(client, sftpId, filePath, encoding, bytes, options) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  // Empty planned snapshot: fixed empty digest (no stream open required).
  if (bytes === 0) return EMPTY_SHA256_HEX;
  if (isScpModeClient(client)) return null;
  await requireSftpChannel(client, { signal: options?.signal });
  const encodedPath = encodePathForSession(sftpId, filePath, encoding);
  // Resume still hashes the entire required prefix. Use the same bounded READ
  // window as downloads instead of ssh2's serial stream, which makes a large
  // pause/restart verification pay one network round trip per read.
  try {
    const rangeDigest = await hashRemotePrefixWithSftpRanges(client, encodedPath, bytes, options);
    if (rangeDigest !== null) return rangeDigest;
  } catch (error) {
    if (error?.sftpRequestTimedOut) {
      error.noTransferFallback = true;
      abandonWedgedVerificationSftpChannel(client);
      throw error;
    }
    if (options?.signal?.aborted || error?.code === "ABORT_ERR") throw error;
    // Some servers reject concurrent READs while supporting serial streams.
    // Retain the existing compatibility path, without bypassing cancellation
    // or retrying a request timeout on a channel that may still own the request.
  }
  await requireSftpChannel(client, { signal: options?.signal });
  return hashReadable(
    client.sftp.createReadStream(encodedPath, { start: 0, end: bytes - 1 }),
    options,
  );
}

/**
 * The full SHA-256 source identity proves the source version at capture time.
 * The complete saved prefix must still match because pause acknowledgement can
 * precede that capture; a source rewrite in that window must never mix old
 * staged bytes with a newly fingerprinted suffix.
 */
function resumeContentVerifyBytes(checkpoint, fingerprint) {
  const claimed = Math.max(0, Number(checkpoint) || 0);
  if (!claimed) return 0;
  void fingerprint;
  return claimed;
}

async function assertMatchingResumeContent(sourceHashPromise, stagedHashPromise) {
  const [sourceHash, stagedHash] = await Promise.all([sourceHashPromise, stagedHashPromise]);
  if (sourceHash && stagedHash && sourceHash !== stagedHash) {
    throw new Error("Resume safety check failed: saved content does not match the source");
  }
}

function stableLocalFileIdentity(statLike) {
  if (!statLike) return null;
  return [statLike.dev, statLike.ino, statLike.size].join(":");
}

async function promoteLocalTransfer(stagedPath, targetPath, options = {}) {
  const { publishLocalFileExclusive } = require("./localFilePublish.cjs");
  const assertNotCancelled = options.assertNotCancelled || (() => {});
  const token = crypto.randomUUID().replace(/-/g, "");
  const base = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.netcatty-${token}`);
  const readyPath = `${base}.ready`;
  const backupPath = `${base}.backup`;
  const restoreProbePath = `${base}.restore-check`;
  let backedUp = false;
  let committed = false;
  let keepRecoveryFiles = false;
  let preparedHandle;
  let originalHandle;
  let restoreProbeCreated = false;
  let localMtimePrepared = false;
  try {
    assertNotCancelled();
    try {
      await fs.promises.rename(stagedPath, readyPath);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      await fs.promises.copyFile(stagedPath, readyPath, fs.constants.COPYFILE_EXCL);
    }
    // Stamp the private prepared file before applying possibly unreadable
    // destination permissions. Publication carries these times to the target.
    const mtimeMs = Number(options.sourceSoftIdentity?.mtimeMs);
    if (Number.isFinite(mtimeMs) && mtimeMs >= 1000) {
      const when = new Date(Math.floor(mtimeMs / 1000) * 1000);
      await awaitBestEffortBounded(
        fs.promises.utimes(readyPath, when, when), 15_000, "Prepared destination utimes",
      ).then(() => { localMtimePrepared = true; }).catch(() => {});
    }
    // Keep read access to our private bytes before destination permissions
    // can remove it; the no-hardlink fallback copies through this handle.
    preparedHandle = await fs.promises.open(readyPath, "r");
    let appliedMode = null;
    let validatedTarget;
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      validatedTarget = typeof options.validateTarget === "function"
        ? await options.validateTarget()
        : undefined;
      const mode = Number.isInteger(validatedTarget?.existingMode)
        ? validatedTarget.existingMode & 0o7777
        : Number.isInteger(options.existingMode) ? options.existingMode & 0o7777 : null;
      if (mode !== null && mode !== appliedMode) {
        await fs.promises.chmod(readyPath, mode);
        appliedMode = mode;
        continue;
      }
      stable = true;
      break;
    }
    if (!stable) throw new Error("Local download target kept changing before replacement");
    assertNotCancelled();
    const expectedAbsent = validatedTarget?.targetIdentity === "missing" || validatedTarget?.targetIdentity === null;
    const expectedIdentity = validatedTarget?.stableIdentity
      || (validatedTarget?.targetIdentity ? String(validatedTarget.targetIdentity).split(":").slice(0, 3).join(":") : null);
    if (!expectedAbsent) {
      try {
        originalHandle = await fs.promises.open(targetPath, "r");
      } catch (error) {
        if (error?.code === "EACCES" || error?.code === "EPERM") {
          // An unreadable original cannot use copy-based recovery. Verify the
          // non-overwriting alternative before moving its only visible name.
          try {
            await fs.promises.link(targetPath, restoreProbePath);
            restoreProbeCreated = true;
            await fs.promises.unlink(restoreProbePath);
            restoreProbeCreated = false;
          } catch (restoreError) {
            throw new Error("Cannot safely replace unreadable local destination: hardlink recovery unavailable", { cause: restoreError });
          }
        } else if (error?.code !== "ENOENT") throw error;
      }
      assertNotCancelled();
      try {
        await fs.promises.rename(targetPath, backupPath);
        backedUp = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (backedUp && expectedIdentity) {
      const stat = await fs.promises.lstat(backupPath);
      if (!stat.isFile() || stableLocalFileIdentity(stat) !== expectedIdentity) {
        throw new Error("Local download target changed during replacement");
      }
    }
    assertNotCancelled();
    let publishedIdentity = null;
    try {
      publishedIdentity = await publishLocalFileExclusive(readyPath, targetPath, assertNotCancelled, preparedHandle) ?? null;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("Local download target changed during replacement", { cause: error });
      }
      if (error?.localPublicationIncomplete) keepRecoveryFiles = true;
      throw error;
    }
    // Publication is the commit boundary. A late cancel must not perform a
    // check-then-unlink rollback against a name another process may now own.
    committed = true;
    // Hand the published inode identity to the caller for descriptor-based
    // metadata stamping after publication.
    options.onCommit?.(publishedIdentity, localMtimePrepared);
    if (backedUp) await fs.promises.unlink(backupPath).catch(() => {});
    await fs.promises.unlink(readyPath).catch(() => {});
    await fs.promises.unlink(stagedPath).catch(() => {});
  } catch (error) {
    if (committed) throw error;
    if (backedUp && !keepRecoveryFiles) {
      try {
        // The pathname may have changed between open and rename. Never copy
        // an earlier inode over the original actually moved into the backup.
        let restoreHandle;
        if (originalHandle) {
          const [heldStat, backupStat] = await Promise.all([
            originalHandle.stat(), fs.promises.lstat(backupPath),
          ]);
          if (stableLocalFileIdentity(heldStat) === stableLocalFileIdentity(backupStat)) restoreHandle = originalHandle;
        }
        await publishLocalFileExclusive(backupPath, targetPath, undefined, restoreHandle);
        await fs.promises.unlink(backupPath).catch(() => {});
        backedUp = false;
      } catch (restoreError) {
        keepRecoveryFiles = true;
        error.cause ??= restoreError;
      }
    }
    if (keepRecoveryFiles) {
      const failure = new Error(
        `${error.message}. Recovery files preserved. Backup: ${backedUp ? backupPath : "none"}; `
        + `prepared replacement: ${readyPath}; target: ${targetPath}`,
        { cause: error },
      );
      failure.recoveryFailed = true;
      if (backedUp) failure.remoteBackupPath = backupPath;
      throw failure;
    }
    await fs.promises.unlink(readyPath).catch(() => {});
    throw error;
  } finally {
    await preparedHandle?.close().catch(() => {});
    await originalHandle?.close().catch(() => {});
    if (restoreProbeCreated) await fs.promises.unlink(restoreProbePath).catch(() => {});
  }
}

/**
 * Apply the source mtime to the committed destination so skip-unchanged
 * (size + mtime) can match on a later folder transfer. Best-effort: never
 * fails the transfer if utimes/setstat is unsupported or times out.
 */
async function awaitBestEffortBounded(promise, timeoutMs, label) {
  let timer = null;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function preserveTransferredDestinationMtime(transfer, options = {}) {
  try {
    // Only use the pre-transfer soft identity. Re-statting after commit can pick
    // up a rewritten same-size source and stamp a newer mtime onto older bytes
    // (Codex P1 on non-resumable / SCP paths).
    const mtimeMs = Number(transfer?.sourceSoftIdentity?.mtimeMs);
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return;

    // Compare / skip logic uses whole seconds; stamp the destination the same way.
    const mtimeSec = Math.floor(mtimeMs / 1000);
    if (mtimeSec <= 0) return;
    const when = new Date(mtimeSec * 1000);
    // Best-effort stamp must not pin sendComplete / scheduler forever when the
    // server stops answering metadata requests (Codex P2).
    const mtimeTimeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 15_000;

    if (transfer.targetType === "local" && transfer.targetPath) {
      if (transfer.localMtimePrepared) return;
      // Verify and stamp the same open file. A later pathname replacement
      // must never receive metadata belonging to this completed transfer.
      await awaitBestEffortBounded((async () => {
        let handle;
        try {
          handle = await fs.promises.open(transfer.targetPath, "r");
        } catch (error) {
          if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
          // O_WRONLY neither creates nor truncates a write-only destination.
          handle = await fs.promises.open(transfer.targetPath, fs.constants.O_WRONLY);
        }
        try {
          const currentStat = await handle.stat();
          const publishedIdentity = transfer.publishedLocalIdentity;
          const expectedIdentity = typeof publishedIdentity === "string"
            ? publishedIdentity : stableLocalFileIdentity(publishedIdentity);
          if (!currentStat.isFile()
            || (expectedIdentity && stableLocalFileIdentity(currentStat) !== expectedIdentity)) return;
          await handle.utimes(when, when);
        } finally {
          await handle.close();
        }
      })(), mtimeTimeoutMs, "Destination utimes");
      return;
    }

    if (transfer.targetType !== "sftp" || !transfer.targetSftpId || !transfer.targetPath) {
      return;
    }
    const client = sftpClients.get(transfer.targetSftpId);
    if (!client) return;

    if (isScpModeClient(client)) {
      // SCP has no SETSTAT; best-effort touch via the SSH session.
      const sshClient = client.client;
      if (!sshClient || typeof sshClient.exec !== "function") return;
      const escaped = String(transfer.targetPath).replace(/'/g, "'\\''");
      const command = `touch -d @${mtimeSec} -- '${escaped}' 2>/dev/null || `
        + `touch -t "$(date -u -r ${mtimeSec} +%Y%m%d%H%M.%S 2>/dev/null `
        + `|| date -u -d @${mtimeSec} +%Y%m%d%H%M.%S 2>/dev/null)" -- '${escaped}' 2>/dev/null `
        + `|| true`;
      await executeBoundedSshCommand(sshClient, command, { runTimeoutMs: mtimeTimeoutMs });
      return;
    }

    await requireSftpChannel(client);
    const encoded = encodePathForSession(
      transfer.targetSftpId,
      transfer.targetPath,
      transfer.targetEncoding,
    );
    if (typeof client.setStat === "function") {
      await awaitBestEffortBounded(
        client.setStat(encoded, { mtime: mtimeSec, atime: mtimeSec }),
        mtimeTimeoutMs,
        "Destination setStat",
      );
      return;
    }
    const sftp = client.sftp;
    if (!sftp || typeof sftp.setstat !== "function") return;
    await awaitBestEffortBounded(
      new Promise((resolve, reject) => {
        sftp.setstat(encoded, { mtime: mtimeSec, atime: mtimeSec }, (err) => (
          err ? reject(err) : resolve()
        ));
      }),
      mtimeTimeoutMs,
      "Destination setstat",
    );
  } catch (err) {
    console.warn(
      "[transferBridge] failed to preserve destination mtime:",
      err?.message || String(err),
    );
  }
}

async function inspectLocalPromotionTarget(targetPath) {
  const absoluteTargetPath = path.resolve(targetPath);
  const visitedLinkStates = new Set();
  let linkDepth = 0;
  let currentRoot = path.parse(absoluteTargetPath).root;
  let currentPath = currentRoot;
  let pendingParts = absoluteTargetPath
    .slice(currentRoot.length)
    .split(path.sep)
    .filter(Boolean);

  while (pendingParts.length > 0) {
    const nextPart = pendingParts.shift();
    const candidatePath = path.join(currentPath, nextPart);
    let targetLstat;
    try {
      targetLstat = await fs.promises.lstat(candidatePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return {
        promotionTargetPath: path.join(candidatePath, ...pendingParts),
        existingMode: null,
        targetIdentity: "missing",
      };
    }

    if (targetLstat.isSymbolicLink()) {
      linkDepth += 1;
      const linkState = `${candidatePath}\0${pendingParts.join("\0")}`;
      if (linkDepth > 40 || visitedLinkStates.has(linkState)) {
        const error = new Error(`Local download target contains a symbolic-link loop: ${targetPath}`);
        error.code = "ELOOP";
        throw error;
      }
      visitedLinkStates.add(linkState);
      const linkTarget = await fs.promises.readlink(candidatePath);
      const resolvedLinkTarget = path.resolve(path.dirname(candidatePath), linkTarget);
      currentRoot = path.parse(resolvedLinkTarget).root;
      currentPath = currentRoot;
      pendingParts = resolvedLinkTarget
        .slice(currentRoot.length)
        .split(path.sep)
        .filter(Boolean)
        .concat(pendingParts);
      continue;
    }

    if (pendingParts.length > 0) {
      if (!targetLstat.isDirectory()) {
        const error = new Error(`Local download target parent is not a directory: ${candidatePath}`);
        error.code = "ENOTDIR";
        throw error;
      }
      currentPath = candidatePath;
      continue;
    }

    if (!targetLstat.isFile()) {
      const error = new Error(`Local download target is not a regular file: ${candidatePath}`);
      error.code = targetLstat.isDirectory() ? "EISDIR" : "EINVAL";
      throw error;
    }
    return {
      promotionTargetPath: candidatePath,
      existingMode: targetLstat.mode & 0o7777,
      stableIdentity: stableLocalFileIdentity(targetLstat),
      targetIdentity: [
        targetLstat.dev,
        targetLstat.ino,
        targetLstat.size,
        targetLstat.mtimeMs,
        targetLstat.ctimeMs,
      ].join(":"),
    };
  }

  const rootStat = await fs.promises.lstat(currentPath);
  if (!rootStat.isFile()) {
    const error = new Error(`Local download target is not a regular file: ${currentPath}`);
    error.code = rootStat.isDirectory() ? "EISDIR" : "EINVAL";
    throw error;
  }
  return {
    promotionTargetPath: currentPath,
    existingMode: rootStat.mode & 0o7777,
    stableIdentity: stableLocalFileIdentity(rootStat),
    targetIdentity: [
      rootStat.dev,
      rootStat.ino,
      rootStat.size,
      rootStat.mtimeMs,
      rootStat.ctimeMs,
    ].join(":"),
  };
}

// ── Transfer performance tuning ──────────────────────────────────────────────
// Progress IPC throttle: each tick fans out once on the global transfer channel.
//
// IMPORTANT: do NOT use (time OR bytes). On LAN, a bytes-OR gate fires at
// throughput/bytesRate (e.g. 256KB → hundreds of IPC/s) and pegs the renderer
// even when time throttle looks "reasonable". Time-primary only.
// ~5 Hz is smooth enough for bars; do not stack another 500ms in the store.
const PROGRESS_THROTTLE_MS = 200;
const ISOLATED_DOWNLOAD_IDLE_TTL_MS = 5000;

// Speed calculation uses strict sliding-window average:
// speed = bytes_delta_in_window / time_delta_in_window
const SPEED_WINDOW_MS = 3000;             // Keep 3s of samples
const SPEED_MIN_ELAPSED_MS = 50;          // Minimum elapsed time to avoid divide-by-near-zero spikes

// Throughput diagnostics (main process console). Disable with NETCATTY_TRANSFER_DIAG=0.
// Compare wall avg MB/s vs UI window speed to tell "slow network" from "UI lie".
const TRANSFER_DIAG_ENABLED = process.env.NETCATTY_TRANSFER_DIAG !== "0";
const TRANSFER_DIAG_INTERVAL_MS = 5000;

function formatDiagBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(2)}MiB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)}KiB`;
  return `${Math.round(v)}B`;
}

function formatDiagRate(bytesPerSec) {
  const v = Number(bytesPerSec) || 0;
  if (v <= 0) return "0B/s";
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(2)}MiB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)}KiB/s`;
  return `${Math.round(v)}B/s`;
}

function basenameForDiag(p) {
  if (!p || typeof p !== "string") return "";
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/**
 * Structured transfer diagnostics. Grep main process logs for `[transferDiag]`.
 * Fields: event, id, strategy, phase, direction, size, transferred, windowBps, wallBps, checkpoint, resumable.
 */
function logTransferDiag(transfer, event, extra = {}) {
  if (!TRANSFER_DIAG_ENABLED || !transfer) return;
  try {
    const startedAt = transfer.diagStartedAt || Date.now();
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const transferred = Number(
      extra.transferred ?? transfer.diagLastTransferred ?? transfer.checkpointBytes ?? 0,
    ) || 0;
    const total = Number(extra.total ?? transfer.diagTotalBytes ?? 0) || 0;
    const windowBps = Number(extra.windowBps ?? transfer.diagLastWindowBps ?? 0) || 0;
    const wallBps = (transferred * 1000) / elapsedMs;
    const payload = {
      event,
      id: transfer.transferId,
      strategy: transfer.uploadStrategy || transfer.downloadStrategy || extra.strategy || null,
      phase: transfer.phase || null,
      direction: transfer.diagDirection || null,
      size: total > 0 ? formatDiagBytes(total) : null,
      transferred: formatDiagBytes(transferred),
      pct: total > 0 ? Number(((transferred / total) * 100).toFixed(2)) : null,
      window: formatDiagRate(windowBps),
      wallAvg: formatDiagRate(wallBps),
      checkpoint: formatDiagBytes(transfer.checkpointBytes || 0),
      resumable: transfer.resumable === true,
      file: transfer.diagFileName || null,
      ...extra.fields,
    };
    // Drop nullish noise for readability.
    for (const key of Object.keys(payload)) {
      if (payload[key] == null) delete payload[key];
    }
    console.info("[transferDiag]", JSON.stringify(payload));
  } catch {
    // diagnostics must never break transfers
  }
}

// Shared references
let sftpClients = null;

// Active transfers storage
const activeTransfers = new Map();
const admittedTransferQueue = [];
const pausedAdmittedTransfers = new Map();
const workerTransferLifecycleEpochs = new Map();

/**
 * Lift a worker-local transfer lifecycleEpoch into main-process space.
 * Soft-resume/pause on main may advance the main epoch past the worker's;
 * progress still carrying the lower worker epoch would be rejected as stale.
 */
function resolveWorkerTransferLifecycleEpoch(transferId, workerEpoch) {
  if (!transferId) {
    return Number.isFinite(Number(workerEpoch)) ? Number(workerEpoch) : undefined;
  }
  const entry = workerTransferLifecycleEpochs.get(transferId);
  const mainEpoch = Math.max(0, Number(entry?.epoch) || 0);
  const workerVal = Number(workerEpoch);
  const hasWorker = Number.isFinite(workerVal);
  if (!entry) {
    return hasWorker ? workerVal : undefined;
  }
  const resolved = Math.max(mainEpoch, hasWorker ? workerVal : 0);
  if (resolved > mainEpoch) entry.epoch = resolved;
  return resolved;
}
/** Transfer ids cancelled before startTransferNow registered them (skipAdmission open window). */
const pendingCancelTransferIds = new Map();
const MAX_PENDING_CANCEL_TRANSFER_IDS = 4_096;
const PENDING_CANCEL_TTL_MS = 5 * 60 * 1000;
let pendingCancelCleanupTimer = null;

function prunePendingCancelTransferIds(now = Date.now()) {
  for (const [transferId, createdAt] of pendingCancelTransferIds) {
    if (now - createdAt < PENDING_CANCEL_TTL_MS) break;
    pendingCancelTransferIds.delete(transferId);
  }
  while (pendingCancelTransferIds.size > MAX_PENDING_CANCEL_TRANSFER_IDS) {
    const oldestTransferId = pendingCancelTransferIds.keys().next().value;
    if (oldestTransferId == null) break;
    pendingCancelTransferIds.delete(oldestTransferId);
  }
}

function schedulePendingCancelCleanup() {
  if (pendingCancelCleanupTimer || pendingCancelTransferIds.size === 0) return;
  const oldestCreatedAt = pendingCancelTransferIds.values().next().value ?? Date.now();
  const delay = Math.max(1, oldestCreatedAt + PENDING_CANCEL_TTL_MS - Date.now());
  pendingCancelCleanupTimer = setTimeout(() => {
    pendingCancelCleanupTimer = null;
    prunePendingCancelTransferIds();
    schedulePendingCancelCleanup();
  }, delay);
  if (typeof pendingCancelCleanupTimer.unref === "function") {
    pendingCancelCleanupTimer.unref();
  }
}

function rememberPendingCancel(transferId) {
  if (!transferId) return;
  const id = String(transferId);
  pendingCancelTransferIds.delete(id);
  pendingCancelTransferIds.set(id, Date.now());
  prunePendingCancelTransferIds();
  schedulePendingCancelCleanup();
}

function forgetPendingCancel(transferId) {
  if (!transferId) return false;
  const deleted = pendingCancelTransferIds.delete(String(transferId));
  if (pendingCancelTransferIds.size === 0 && pendingCancelCleanupTimer) {
    clearTimeout(pendingCancelCleanupTimer);
    pendingCancelCleanupTimer = null;
  }
  return deleted;
}

function takePendingCancel(transferId) {
  if (!transferId) return false;
  prunePendingCancelTransferIds();
  return forgetPendingCancel(transferId);
}
const admittedActiveByResource = new Map();
let admittedTransferLimit = 2;
const isolatedDownloadChannelPools = new WeakMap();
// One concurrent 64-READ fanout download per SFTP session (#1507) — covers both
// isolated channels and shared/sudo browse READs. Extra downloads wait for the
// session slot instead of degrading to serial createReadStream (#2719 / #2449).
const sessionFastDownloadSlots = new WeakMap();
/** @type {WeakMap<object, Array<{ resolve: () => void, reject: (err: Error) => void, transfer: object }>>} */
const sessionFastDownloadWaiters = new WeakMap();
// Cache live SFTP clients where remote cp is known to be unavailable, so we
// skip repeated failed exec attempts without retaining closed session ids.
const cpUnavailableSet = new WeakSet();

const {
  sftpTransferSessionLeaseStore,
} = require("./sftpTransferSessionLease.cjs");

/**
 * Initialize the transfer bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
}

async function runTransferCancelablePreflight(transfer, operation) {
  if (transfer.cancelled || transfer.signal?.aborted) {
    throw new Error("Transfer cancelled");
  }
  let rejectCancellation;
  const cancelled = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const previousAbort = transfer.abort;
  const abortPreflight = () => {
    try { previousAbort?.(); } finally {
      rejectCancellation(new Error("Transfer cancelled"));
    }
  };
  const signal = transfer.signal;
  transfer.abort = abortPreflight;
  signal?.addEventListener?.("abort", abortPreflight, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      cancelled,
    ]);
  } finally {
    signal?.removeEventListener?.("abort", abortPreflight);
    if (transfer.abort === abortPreflight) transfer.abort = previousAbort;
  }
}

async function runTransferAbortableOperation(transfer, operation) {
  if (transfer.cancelled || transfer.signal?.aborted) {
    throw new Error("Transfer cancelled");
  }
  const controller = new AbortController();
  const previousAbort = transfer.abort;
  const abortOperation = () => {
    try { previousAbort?.(); } finally {
      controller.abort(new Error("Transfer cancelled"));
    }
  };
  const signal = transfer.signal;
  transfer.abort = abortOperation;
  signal?.addEventListener?.("abort", abortOperation, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    signal?.removeEventListener?.("abort", abortOperation);
    if (transfer.abort === abortOperation) transfer.abort = previousAbort;
  }
}

function listTransferSftpIds(payload = {}) {
  return [...new Set(
    [payload.sourceSftpId, payload.targetSftpId].filter((id) => typeof id === "string" && id.length > 0),
  )];
}

function acquireTransferSessionLeases(transferId, payload) {
  const sftpIds = listTransferSftpIds(payload);
  // This whole function is synchronous, so preflight every endpoint before
  // cancelling any uncommitted close claim. That keeps a two-server transfer
  // from partially acquiring one side when the other is already closing.
  const closingSftpId = sftpIds.find((sftpId) => (
    sftpTransferSessionLeaseStore.isHardCloseCommitted(sftpId)
  ));
  if (closingSftpId) {
    throw new Error(`SFTP session is closing: ${closingSftpId}`);
  }
  for (const sftpId of sftpIds) {
    sftpTransferSessionLeaseStore.acquire(sftpId, transferId);
  }
  return sftpIds;
}

function retainSftpTransferSession(_event, payload) {
  const sftpId = payload?.sftpId;
  const leaseId = payload?.leaseId;
  if (!sftpId || !leaseId) {
    return { success: false, reason: "sftpId and leaseId are required" };
  }
  if (!sftpClients?.has?.(sftpId)) {
    return { success: false, reason: "SFTP session not found" };
  }
  try {
    acquireTransferSessionLeases(leaseId, { targetSftpId: sftpId });
    return { success: true };
  } catch (error) {
    return { success: false, reason: error?.message || String(error) };
  }
}

async function hardCloseSftpSession(sftpId, closeToken) {
  if (!sftpId) return;
  // Give a directory walk one turn to acquire the next child lease. That
  // cancels the still-uncommitted claim and safely keeps the session alive.
  await new Promise((resolve) => setImmediate(resolve));
  // TOCTOU: another transfer may have acquired between shouldHardClose and here.
  // Re-arm soft-close and abort the force close so we don't kill live work.
  if (sftpTransferSessionLeaseStore.isHeld(sftpId)) {
    sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
    return;
  }
  if (!sftpTransferSessionLeaseStore.commitHardClose(sftpId, closeToken)) return;
  try {
    const sftpBridge = require("./sftpBridge.cjs");
    if (typeof sftpBridge.closeSftp === "function") {
      const result = await sftpBridge.closeSftp(null, { sftpId, force: true });
      // fileOps may defer if a new lease appeared mid-close.
      if (result?.deferred) return;
      return;
    }
  } catch (err) {
    console.warn(`[Transfer] Failed to hard-close leased SFTP session ${sftpId}:`, err?.message || err);
  }
  // Fallback if bridge close is unavailable (unit tests with partial mocks).
  // Re-check again before wiping the client map.
  if (sftpTransferSessionLeaseStore.isHeld(sftpId)) {
    sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
    return;
  }
  const client = sftpClients?.get?.(sftpId);
  if (!client) {
    sftpTransferSessionLeaseStore.clear(sftpId);
    return;
  }
  try { await client.end?.(); } catch { /* ignore */ }
  if (sftpTransferSessionLeaseStore.isHeld(sftpId)) {
    sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
    return;
  }
  sftpClients.delete(sftpId);
  sftpTransferSessionLeaseStore.clear(sftpId);
}

function releaseTransferSessionLeases(transferId, sftpIds) {
  for (const sftpId of sftpIds || []) {
    const result = sftpTransferSessionLeaseStore.release(sftpId, transferId);
    if (result.shouldHardClose) {
      void hardCloseSftpSession(
        sftpId,
        sftpTransferSessionLeaseStore.getPendingHardCloseToken(sftpId),
      );
    }
  }
}

function releaseSftpTransferSession(_event, payload) {
  const sftpId = payload?.sftpId;
  const leaseId = payload?.leaseId;
  if (!sftpId || !leaseId) {
    return { success: false, reason: "sftpId and leaseId are required" };
  }
  releaseTransferSessionLeases(leaseId, [sftpId]);
  return { success: true };
}

function setGlobalTransferConcurrency(limit) {
  const normalized = Number(limit);
  if (Number.isInteger(normalized) && normalized >= 1 && normalized <= 16) {
    admittedTransferLimit = normalized;
  }
  return admittedTransferLimit;
}

function getGlobalTransferConcurrency() {
  return admittedTransferLimit;
}

/**
 * Execute an SSH command with cancellation support.
 * Registers an abort hook on the transfer object that closes the exec stream,
 * which sends SIGHUP to the remote process.
 */
function execSshCommandCancellable(sshClient, command, transfer) {
  if (transfer.cancelled) return Promise.reject(new Error('Transfer cancelled'));
  const controller = new AbortController();
  const prevAbort = transfer.abort;
  const abort = () => {
    controller.abort(new Error('Transfer cancelled'));
    if (typeof prevAbort === 'function') prevAbort();
  };
  transfer.abort = abort;
  return executeBoundedSshCommand(sshClient, command, {
    signal: controller.signal,
    openingTimeoutMs: 15_000,
    runTimeoutMs: 10 * 60_000,
    maxOutputBytes: 64 * 1024,
  }).then((result) => {
    if (transfer.cancelled) throw new Error('Transfer cancelled');
    return result;
  }).catch((error) => {
    if (transfer.cancelled || error?.code === 'ABORT_ERR') {
      throw new Error('Transfer cancelled');
    }
    throw error;
  }).finally(() => {
    if (transfer.abort === abort) transfer.abort = prevAbort;
  });
}

async function openIsolatedSftpChannel(client, signal = null) {
  const sshClient = client?.client;
  return openBoundedSftpChannel(sshClient, { signal });
}

/**
 * After concurrent ranges fail, staged files may extend past the contiguous
 * checkpoint (sparse tail). Truncate to the durable offset before stream
 * fallback or pause-stat, so resume never skips holes.
 */
async function truncateStagedPathToCheckpoint(filePath, checkpointBytes) {
  const checkpoint = Math.max(0, Number(checkpointBytes) || 0);
  if (!filePath) return;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return;
    if (stat.size > checkpoint) {
      await fs.promises.truncate(filePath, checkpoint);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    // Best-effort: next pipelined strategy can still resume from checkpoint.
    console.warn(
      "[transferBridge] failed to truncate staged local file before fallback:",
      error?.message || String(error),
    );
  }
}

async function truncateRemoteStagedToCheckpoint(client, stagedRemote, checkpointBytes) {
  const checkpoint = Math.max(0, Number(checkpointBytes) || 0);
  if (!client || !stagedRemote?.path) return;
  if (isScpModeClient(client)) return;
  try {
    const encoded = encodePathForSession(
      stagedRemote.sftpId,
      stagedRemote.path,
      stagedRemote.encoding,
    );
    const stat = await client.stat(encoded);
    const size = Math.max(0, Number(stat?.size) || 0);
    if (size <= checkpoint) return;
    // Prefer native truncate when available (ssh2-sftp-client).
    if (typeof client.truncate === "function") {
      await client.truncate(encoded, checkpoint);
      return;
    }
    if (typeof client.sftp?.ftruncate === "function" && typeof client.sftp?.open === "function") {
      await new Promise((resolve, reject) => {
        client.sftp.open(encoded, "r+", (openErr, handle) => {
          if (openErr) return reject(openErr);
          client.sftp.ftruncate(handle, checkpoint, (truncErr) => {
            client.sftp.close(handle, () => {
              if (truncErr) reject(truncErr);
              else resolve();
            });
          });
        });
      });
    }
  } catch (error) {
    console.warn(
      "[transferBridge] failed to truncate staged remote file before fallback:",
      error?.message || String(error),
    );
  }
}

async function prepareStreamFallbackAfterRangeFailure(transfer, client) {
  const checkpoint = Math.max(0, Number(transfer?.checkpointBytes) || 0);
  // Truncate partial *target* staging only. In SFTP→SFTP copies, stagedLocalPath
  // is the fully-downloaded temp *source* during the upload phase — never shrink it.
  // Direct transfers keep resumeStage "direct"; S2S download uses "download".
  // Anything other than "upload" with a staged local path is a partial target.
  const localIsPartialTarget =
    Boolean(transfer?.stagedLocalPath)
    && transfer.resumeStage !== "upload";
  if (localIsPartialTarget) {
    await truncateStagedPathToCheckpoint(transfer.stagedLocalPath, checkpoint);
  }
  if (transfer?.stagedRemote) {
    await truncateRemoteStagedToCheckpoint(
      transfer.stagedRemote.client || client,
      transfer.stagedRemote,
      checkpoint,
    );
  }
}

/**
 * Wait for a prior truncating WRITE OPEN's published gate before fastPut.
 * Cancelable and time-bounded so a dead isolated OPEN that never callbacks
 * cannot hang strategy fallback forever (#2755). On timeout/cancel the waiter
 * fails closed without resolving the published transfer gate (clearing that
 * poison early lets a late truncating OPEN wipe an in-place destination after
 * sendComplete; Codex P1 on e2cc8241), and also poisons the shared path map so
 * later same-path waiters fail promptly (#2755 / Codex P2 on dca41093).
 */
async function waitForPendingWriteOpenPathGate(transfer, options = {}) {
  if (transfer?.noTransferFallback || transfer?.inPlaceWriteOpenPoisoned) {
    const err = new Error("In-place write OPEN poison is still held; refusing same-path fallback");
    err.noTransferFallback = true;
    throw err;
  }
  const gate = transfer?.pendingWriteOpenPathGate;
  if (typeof gate?.then !== "function") return;
  // Default 2s matches fastPut's fail-closed wait (#2755): hanging forever on a
  // dead OPEN pins the transfer/lease; longer waits only delay the poison path.
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 2_000;
  const timeoutMessage = typeof options.timeoutMessage === "string" && options.timeoutMessage
    ? options.timeoutMessage
    : "Timed out waiting for prior write OPEN to settle before fastPut";
  const poisonGate = () => {
    // Fail closed for later same-path waiters: do not resolve/clear the published
    // transfer gate from this waiter (Codex P1 on e2cc8241), but do poison the
    // shared path map so a successor that replaced the entry cannot OPEN while a
    // truncating OPEN may still land (#2755 / Codex P2 on dca41093).
    try {
      transfer._failPendingWriteOpenPathGate?.(
        createPoisonedWriteOpenPathGateError(
          "Prior write OPEN never settled; path gate is fail-closed",
        ),
      );
    } catch { /* ignore */ }
  };
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const previousAbort = transfer.abort;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      transfer.signal?.removeEventListener?.("abort", onAbort);
      if (transfer.abort === abortWait) transfer.abort = previousAbort;
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      transfer.cancelled = true;
      // Same fail-closed poison as the timeout path: cancel must not leave later
      // same-path uploads hanging on waitForPrior (Codex P2).
      poisonGate();
      finish(reject, new Error("Transfer cancelled"));
    };
    const abortWait = () => {
      try { previousAbort?.(); } catch { /* ignore */ }
      onAbort();
    };
    transfer.abort = abortWait;
    transfer.signal?.addEventListener?.("abort", onAbort, { once: true });
    if (transfer.cancelled || transfer.signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      const err = new Error(timeoutMessage);
      err.noTransferFallback = true;
      poisonGate();
      finish(reject, err);
    }, timeoutMs);
    // Only a successful gate release unblocks safely. A poisoned/rejected gate
    // must fail this waiter closed; do not proceed to another writer.
    Promise.resolve(gate).then(
      () => finish(resolve),
      (err) => finish(
        reject,
        err instanceof Error ? err : new Error(String(err?.message || err || "path gate failed")),
      ),
    );
  });
  if (transfer.cancelled || transfer.signal?.aborted) {
    throw new Error("Transfer cancelled");
  }
}

function getIsolatedDownloadChannelPool(client) {
  let pool = isolatedDownloadChannelPools.get(client);
  if (!pool) {
    pool = {
      idle: [],
      idleTimers: new Map(),
      idleErrorHandlers: new Map(),
      busy: new Set(),
      opening: 0,
      maxChannels: FAST_DOWNLOAD_CHANNELS_PER_SESSION,
    };
    isolatedDownloadChannelPools.set(client, pool);
  }
  return pool;
}

function removeIdleIsolatedDownloadChannel(pool, sftp) {
  const index = pool.idle.indexOf(sftp);
  if (index !== -1) {
    pool.idle.splice(index, 1);
  }
}

function clearIdleIsolatedDownloadTimer(pool, sftp) {
  const timer = pool.idleTimers.get(sftp);
  if (timer) {
    clearTimeout(timer);
    pool.idleTimers.delete(sftp);
  }
}

function clearIdleIsolatedDownloadErrorHandler(pool, sftp) {
  const handler = pool.idleErrorHandlers.get(sftp);
  if (!handler) return;
  try { sftp?.removeListener?.("error", handler); } catch { }
  pool.idleErrorHandlers.delete(sftp);
}

function scheduleIdleIsolatedDownloadChannel(client, sftp) {
  const pool = isolatedDownloadChannelPools.get(client);
  if (!pool) return;

  clearIdleIsolatedDownloadTimer(pool, sftp);
  const timer = setTimeout(() => {
    clearIdleIsolatedDownloadTimer(pool, sftp);
    clearIdleIsolatedDownloadErrorHandler(pool, sftp);
    removeIdleIsolatedDownloadChannel(pool, sftp);
    try { sftp?.end?.(); } catch { }
  }, ISOLATED_DOWNLOAD_IDLE_TTL_MS);
  pool.idleTimers.set(sftp, timer);

  const onIdleError = () => {
    clearIdleIsolatedDownloadTimer(pool, sftp);
    clearIdleIsolatedDownloadErrorHandler(pool, sftp);
    removeIdleIsolatedDownloadChannel(pool, sftp);
    try { sftp?.end?.(); } catch { }
  };
  pool.idleErrorHandlers.set(sftp, onIdleError);
  sftp?.once?.("error", onIdleError);
}

function releaseIsolatedDownloadChannel(client, sftp, options = {}) {
  const { dispose = false } = options;
  const pool = isolatedDownloadChannelPools.get(client);
  if (!pool) {
    if (dispose) {
      try { sftp?.end?.(); } catch { }
    }
    return;
  }

  pool.busy.delete(sftp);
  clearIdleIsolatedDownloadTimer(pool, sftp);
  clearIdleIsolatedDownloadErrorHandler(pool, sftp);

  if (dispose) {
    try { sftp?.end?.(); } catch { }
    return;
  }

  pool.idle.push(sftp);
  scheduleIdleIsolatedDownloadChannel(client, sftp);
}

function tryAcquireSessionFastDownloadSlot(client) {
  const inFlight = sessionFastDownloadSlots.get(client) || 0;
  if (inFlight >= FAST_DOWNLOAD_CHANNELS_PER_SESSION) return false;
  sessionFastDownloadSlots.set(client, inFlight + 1);
  return true;
}

function wakeSessionFastDownloadWaiters(client) {
  const waiters = sessionFastDownloadWaiters.get(client);
  if (!waiters || waiters.length === 0) return;
  while (waiters.length > 0) {
    const next = waiters[0];
    if (next.transfer?.cancelled || next.transfer?.signal?.aborted) {
      waiters.shift();
      next.reject(new Error("Transfer cancelled"));
      continue;
    }
    if (!tryAcquireSessionFastDownloadSlot(client)) return;
    waiters.shift();
    next.resolve();
    return;
  }
  if (waiters.length === 0) {
    sessionFastDownloadWaiters.delete(client);
  }
}

function releaseSessionFastDownloadSlot(client) {
  const inFlight = sessionFastDownloadSlots.get(client) || 0;
  if (inFlight <= 1) {
    sessionFastDownloadSlots.delete(client);
  } else {
    sessionFastDownloadSlots.set(client, inFlight - 1);
  }
  wakeSessionFastDownloadWaiters(client);
}

/**
 * Acquire the per-session fast-download slot (isolated or shared READ fanout),
 * waiting (cancelable) when another transfer already holds the budget.
 * Never falls back to serial createReadStream while waiting (#2719).
 */
async function acquireSessionFastDownloadSlot(client, transfer) {
  if (transfer?.cancelled || transfer?.signal?.aborted) {
    throw new Error("Transfer cancelled");
  }
  if (tryAcquireSessionFastDownloadSlot(client)) {
    // Granted immediately — still recheck cancel before the caller starts work.
    if (transfer.cancelled || transfer.signal?.aborted) {
      releaseSessionFastDownloadSlot(client);
      throw new Error("Transfer cancelled");
    }
    return;
  }

  await new Promise((resolve, reject) => {
    const entry = { resolve, reject, transfer };
    const waiters = sessionFastDownloadWaiters.get(client) || [];
    waiters.push(entry);
    sessionFastDownloadWaiters.set(client, waiters);

    const previousAbort = transfer.abort;
    let settled = false;
    const dequeue = () => {
      const list = sessionFastDownloadWaiters.get(client);
      if (!list) return;
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) sessionFastDownloadWaiters.delete(client);
    };
    const cleanupAbort = () => {
      transfer.signal?.removeEventListener?.("abort", abortWait);
      if (transfer.abort === abortWait) transfer.abort = previousAbort;
    };
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      resolve();
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      reject(err);
    };
    const abortWait = () => {
      if (settled) return;
      transfer.cancelled = true;
      dequeue();
      try { previousAbort?.(); } catch { /* ignore */ }
      settleReject(new Error("Transfer cancelled"));
    };
    transfer.abort = abortWait;
    transfer.signal?.addEventListener?.("abort", abortWait, { once: true });

    // Another transfer may have released between tryAcquire and enqueue.
    if (tryAcquireSessionFastDownloadSlot(client)) {
      dequeue();
      settleResolve();
      return;
    }

    entry.resolve = settleResolve;
    entry.reject = settleReject;
  });

  if (transfer.cancelled || transfer.signal?.aborted) {
    releaseSessionFastDownloadSlot(client);
    throw new Error("Transfer cancelled");
  }
}

async function acquireIsolatedDownloadChannel(client, transfer) {
  const pool = getIsolatedDownloadChannelPool(client);
  if (transfer?.cancelled) return null;

  const cached = pool.idle.pop();
  if (cached) {
    clearIdleIsolatedDownloadTimer(pool, cached);
    clearIdleIsolatedDownloadErrorHandler(pool, cached);
    pool.busy.add(cached);
    return cached;
  }

  const currentChannelCount = pool.idle.length + pool.busy.size + pool.opening;
  if (currentChannelCount >= pool.maxChannels) {
    return null;
  }

  pool.opening += 1;
  try {
    const opened = await openIsolatedSftpChannel(client, transfer?.signal);
    pool.opening -= 1;
    if (!opened) return null;
    if (transfer?.cancelled) {
      try { opened.end?.(); } catch { }
      return null;
    }
    pool.busy.add(opened);
    return opened;
  } catch (err) {
    pool.opening -= 1;
    console.warn(
      "[transferBridge] Failed to open isolated SFTP channel for fastGet, trying next pipelined strategy:",
      err.message || String(err),
    );
    return null;
  }
}

/**
 * After a concurrent-range attempt fails, staged remote bytes may extend past
 * the contiguous checkpoint. Truncate / reset so the next strategy resumes
 * safely instead of leaving sparse tails.
 */
async function prepareUploadFallbackCheckpoint(transfer, client, fileSize, sendProgress) {
  await prepareStreamFallbackAfterRangeFailure(transfer, client);
  const fallbackCheckpoint = Math.max(0, Number(transfer.checkpointBytes) || 0);
  if (fallbackCheckpoint > 0 && transfer.stagedRemote) {
    let stagedSize = Number.POSITIVE_INFINITY;
    try {
      const staged = transfer.stagedRemote;
      const encoded = encodePathForSession(staged.sftpId, staged.path, staged.encoding);
      stagedSize = Number((await (staged.client || client).stat(encoded))?.size);
    } catch { /* missing staged file — restart */ }
    if (!Number.isFinite(stagedSize) || stagedSize !== fallbackCheckpoint) {
      transfer.checkpointBytes = 0;
      sendProgress(0, fileSize, { force: true, checkpointBytes: 0 });
    }
  }
}

async function uploadViaFastPut(localPath, remotePath, sftp, fileSize, transfer, sendProgress, { disposeChannel }) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let pendingError = null;
    let forceFinishTimer = null;
    let onFastSftpError = null;
    const clearForceFinish = () => {
      if (forceFinishTimer) {
        clearTimeout(forceFinishTimer);
        forceFinishTimer = null;
      }
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearForceFinish();
      if (transfer.abort === abortFastTransfer) {
        transfer.abort = null;
      }
      if (onFastSftpError) {
        try { sftp.removeListener("error", onFastSftpError); } catch { /* ignore */ }
        onFastSftpError = null;
      }
      if (disposeChannel) {
        try { sftp.end(); } catch { /* ignore */ }
      }

      if (transfer.cancelled) reject(new Error("Transfer cancelled"));
      else if (err) reject(err);
      else resolve();
    };
    const scheduleForceFinish = (err) => {
      clearForceFinish();
      forceFinishTimer = setTimeout(() => finish(err), 2000);
    };
    const abortFastTransfer = () => {
      if (settled) return;
      transfer.cancelled = true;
      if (disposeChannel) {
        try { sftp.end(); } catch { /* ignore */ }
        // Wait for fastPut callback when possible; force after grace period.
        scheduleForceFinish(new Error("Transfer cancelled"));
        return;
      }
      // Shared channel: wait for callback.
    };
    transfer.abort = abortFastTransfer;
    onFastSftpError = (err) => {
      pendingError = err || new Error("SFTP channel error");
      if (disposeChannel) {
        try { sftp.end(); } catch { /* ignore */ }
        scheduleForceFinish(pendingError);
      }
    };
    sftp.on?.("error", onFastSftpError);

    if (transfer.cancelled) {
      finish(new Error("Transfer cancelled"));
      return;
    }

    sftp.fastPut(localPath, remotePath, {
      chunkSize: TRANSFER_CHUNK_SIZE,
      concurrency: UPLOAD_TRANSFER_CONCURRENCY,
      step: (transferred, _chunk, total) => {
        if (transfer.cancelled) return;
        // UI progress only. fastPut byte totals are not a durable contiguous
        // resume offset — keep checkpoint at 0 so a crash mid-fastPut cannot
        // resume past sparse holes on the next run.
        // Do not force every chunk: ssh2 steps per 32KB and would flood IPC.
        sendProgress(transferred, total || fileSize, {
          checkpointBytes: 0,
        });
      },
    }, (err) => {
      if (transfer.cancelled) {
        finish(new Error("Transfer cancelled"));
        return;
      }
      if (pendingError) {
        finish(pendingError);
        return;
      }
      finish(err || null);
    });
  });
}

/**
 * Upload a local file with pipelined SFTP WRITEs only.
 *
 * Aligns with OpenSSH sftp / Electerm / WinSCP: default is outstanding-request
 * fanout, not serial WriteStream. Strategy order:
 *   1. concurrent ranges on an isolated channel (resumable + cancel-safe)
 *   2. ssh2 fastPut on an isolated channel
 *   3. concurrent ranges on the shared browse channel
 *
 * There is no silent serial createWriteStream/put fallback — that path is
 * RTT-bound (~1 WRITE × 32KB) and was the usual cause of sub-MB/s uploads
 * (#2449). When every pipelined strategy fails, the transfer fails with the
 * last underlying error (Electerm-style: fail closed, do not crawl).
 */
async function uploadFile(
  localPath,
  remotePath,
  client,
  fileSize,
  transfer,
  sendProgress,
  encoding = "utf-8",
  onBytesCommitted = null,
  options = {},
) {
  const generatedStagePath = options.generatedStagePath === true;
  const existingRemoteMode = Number.isFinite(options.existingMode)
    ? options.existingMode & 0o7777
    : null;
  if (isScpModeClient(client)) {
    transfer.pauseSupported = false;
    transfer.pauseUnavailableReason = "Pause is unavailable for SCP transfers";
    transfer.uploadStrategy = "scp";
    logTransferDiag(transfer, "strategy", { strategy: "scp" });
    const backend = getScpBackendForClient(client);
    // Stream the live local path directly — no whole-file digest / snapshot.
    // openReadStream is optional for scpBackend (falls back to createReadStream);
    // provide a plain file stream so tests/backends that always call it still work.
    await backend.uploadFile(localPath, remotePath, {
      fileSize,
      transfer,
      encoding,
      signal: transfer.signal,
      openReadStream: () => {
        const stream = fs.createReadStream(localPath, { highWaterMark: 256 * 1024 });
        return { stream, completed: Promise.resolve() };
      },
      onProgress: (transferred, total) => sendProgress(transferred, total || fileSize),
    });
    if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
    onBytesCommitted?.();
    return;
  }

  await requireSftpChannel(client);
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");
  transfer.pauseSupported = Boolean(transfer.resumable);
  const originalLocalPath = localPath;
  const initialSource = (transfer.resumable || !transfer.sourceIsOwnedTemp)
    ? await fs.promises.stat(originalLocalPath)
    : null;

  /** @type {Error | null} */
  let lastPipelineError = null;
  const rememberPipelineError = (err) => {
    if (err && typeof err === "object") lastPipelineError = err;
    else lastPipelineError = new Error(String(err || "SFTP upload failed"));
  };

  // Industry-standard SFTP clients (FileZilla / WinSCP / OpenSSH) resume by
  // size only — no whole-file content digest before or during the body transfer.
  // Pause/resume durability lives in checkpointBytes + the remote .part stage.

  const finishSuccessfulUpload = async () => {
    if (initialSource) {
      const latestSource = await fs.promises.stat(originalLocalPath);
      // Soft size + mtime/ino (no full-file re-hash). Do not claim separate
      // content proof — same-size rewrites that bump mtime still fail closed.
      // ignoreCtime: macOS xattr/Spotlight noise must not abort a true match.
      assertSourceMetadataUnchanged(initialSource, latestSource, fileSize, {
        ignoreCtime: true,
      });
    }
    await assertRemoteUploadSize(client, remotePath, fileSize);
    // In-place replace writes the final path (fastPut / pipelined WRITE). Restore
    // captured mode here; staged `.part` uploads restore after rename instead.
    if (!generatedStagePath && Number.isFinite(existingRemoteMode)) {
      await restoreRemoteUploadModeBestEffort(
        client,
        options.sftpId,
        options.finalRemotePath || remotePath,
        encoding,
        existingRemoteMode,
      );
    }
  };

  // Prefer an isolated SFTP channel so cancellation cannot kill the browse session.
  let isolated = null;
  if (!client.__netcattySudoMode) {
    try {
      isolated = await openIsolatedSftpChannel(client, transfer?.signal);
    } catch (err) {
      rememberPipelineError(err);
      console.warn(
        "[transferBridge] Failed to open isolated SFTP channel for upload:",
        err.message || String(err),
      );
    }
  }
  if (isolated && transfer.cancelled) {
    try { isolated.end?.(); } catch { /* ignore */ }
    isolated = null;
    throw new Error("Transfer cancelled");
  }

  if (isolated) {
    let concurrentIsolatedOk = false;
    try {
      transfer.uploadStrategy = "concurrent-isolated";
      logTransferDiag(transfer, "strategy", {
        strategy: "concurrent-isolated",
        fields: {
          chunk: formatDiagBytes(TRANSFER_CHUNK_SIZE),
          concurrency: UPLOAD_TRANSFER_CONCURRENCY,
        },
      });
      await uploadFileConcurrent(
        localPath,
        remotePath,
        isolated,
        fileSize,
        transfer,
        sendProgress,
        { disposeChannel: true, onBytesCommitted, generatedStagePath },
      );
      concurrentIsolatedOk = true;
    } catch (err) {
      // uploadFileConcurrent ends the isolated channel itself.
      isolated = null;
      if (transfer.cancelled) throw err;
      if (err?.noTransferFallback || transfer.noTransferFallback) {
        if (err && typeof err === "object" && transfer.noTransferFallback) {
          err.noTransferFallback = true;
        }
        throw err;
      }
      rememberPipelineError(err);
      if (transfer.resumable) {
        await prepareUploadFallbackCheckpoint(transfer, client, fileSize, sendProgress);
      } else {
        transfer.checkpointBytes = 0;
      }
      console.warn(
        "[transferBridge] concurrent isolated upload failed, trying next pipelined strategy:",
        err?.message || String(err),
      );
    }
    // Verification errors must not fall through into other strategies.
    if (concurrentIsolatedOk) {
      await finishSuccessfulUpload();
      return;
    }
  }

  if (!isolated && !client.__netcattySudoMode) {
    try {
      isolated = await openIsolatedSftpChannel(client, transfer?.signal);
    } catch (err) {
      rememberPipelineError(err);
      console.warn(
        "[transferBridge] Failed to reopen isolated SFTP channel for fastPut:",
        err.message || String(err),
      );
    }
  }

  // fastPut always truncates and rewrites from offset 0; skip when we
  // already have a durable resume checkpoint from a prior concurrent attempt.
  // fastPut is not pause-aware; do not advertise pause while it runs.
  // In-place OPEN poison is terminal for this transfer: do not wait on/race
  // the unreleased path gate with another same-path strategy (Codex P1 on 3d4cecfa).
  if (transfer.noTransferFallback) {
    const cause = lastPipelineError || new Error("SFTP pipelined upload failed");
    if (typeof cause === "object" && cause) cause.noTransferFallback = true;
    throw cause;
  }
  const hasResumeCheckpoint = Math.max(0, Number(transfer.checkpointBytes) || 0) > 0;
  if (
    isolated
    && typeof isolated.fastPut === "function"
    && !hasResumeCheckpoint
    && !transfer.resumable
  ) {
    let fastPutOk = false;
    try {
      // Wait for any prior/in-flight write OPEN on this path (including our
      // own concurrent attempt's still-pending OPEN) before fastPut truncates
      // the same stage (Codex P1 on 7872a304). Bounded + cancelable: a dead
      // isolated OPEN never settles the path gate; hang or ignore cancel pins
      // the transfer/lease (#2755 / Codex P2 on 667e9115).
      await waitForPendingWriteOpenPathGate(transfer, {
        timeoutMs: 2_000,
        timeoutMessage: "Timed out waiting for prior write OPEN to settle before fastPut",
      });
      if (transfer.cancelled) throw new Error("Transfer cancelled");
      transfer.uploadStrategy = "fastPut-isolated";
      logTransferDiag(transfer, "strategy", { strategy: "fastPut-isolated" });
      transfer.pauseSupported = false;
      transfer.pauseUnavailableReason = "Pause is unavailable during fastPut upload";
      // Stream the live local path (no whole-file snapshot / digest sidecar).
      sendProgress(Math.max(0, Number(transfer.checkpointBytes) || 0), fileSize, {
        force: true,
      });
      await uploadViaFastPut(
        originalLocalPath,
        remotePath,
        isolated,
        fileSize,
        transfer,
        sendProgress,
        { disposeChannel: true },
      );
      fastPutOk = true;
    } catch (err) {
      // Gate-wait / fastPut failure: end the reopened isolated channel before
      // nulling. Rethrow paths skip the post-block else-if end, and fallthrough
      // also clears isolated; either way we must not leak the SSH subsystem
      // opened for this attempt (#2755 Bugbot).
      if (isolated && typeof isolated.end === "function") {
        try { isolated.end(); } catch { /* ignore */ }
      }
      isolated = null;
      // Restore pause capability for subsequent pause-aware strategies.
      transfer.pauseSupported = Boolean(transfer.resumable);
      transfer.pauseUnavailableReason = transfer.resumable
        ? undefined
        : transfer.pauseUnavailableReason;
      if (transfer.cancelled) throw err;
      // Source-change / hard safety errors must not be retried on another path.
      if (err?.noTransferFallback || err?.sourceChanged) throw err;
      rememberPipelineError(err);
      // fastPut progress is not a durable contiguous checkpoint; reset so
      // concurrent-shared does not resume past holes left by the failed put.
      transfer.checkpointBytes = 0;
      sendProgress(0, fileSize, { force: true, checkpointBytes: 0 });
      console.warn(
        "[transferBridge] isolated fastPut failed, trying next pipelined strategy:",
        err?.message || String(err),
      );
    }
    if (fastPutOk) {
      onBytesCommitted?.();
      await finishSuccessfulUpload();
      return;
    }
  } else if (isolated && typeof isolated.end === "function") {
    try { isolated.end(); } catch { /* ignore */ }
  }

  // Concurrent WRITEs on the shared browse channel — still pipelined, does not
  // end the session on cancel/dispose (sudo mode and isolated-open failures).
  if (typeof sftp.open === "function" && typeof sftp.write === "function") {
    let sharedOk = false;
    try {
      transfer.uploadStrategy = "concurrent-shared";
      logTransferDiag(transfer, "strategy", {
        strategy: "concurrent-shared",
        fields: {
          chunk: formatDiagBytes(TRANSFER_CHUNK_SIZE),
          concurrency: UPLOAD_TRANSFER_CONCURRENCY,
        },
      });
      transfer.pauseSupported = Boolean(transfer.resumable);
      if (transfer.resumable) transfer.pauseUnavailableReason = undefined;
      await uploadFileConcurrent(
        localPath,
        remotePath,
        sftp,
        fileSize,
        transfer,
        sendProgress,
        { disposeChannel: false, onBytesCommitted, generatedStagePath },
      );
      sharedOk = true;
    } catch (err) {
      if (transfer.cancelled) throw err;
      if (err?.noTransferFallback) throw err;
      rememberPipelineError(err);
      await prepareUploadFallbackCheckpoint(transfer, client, fileSize, sendProgress);
      console.warn(
        "[transferBridge] concurrent shared upload failed (no serial stream fallback):",
        err?.message || String(err),
      );
    }
    if (sharedOk) {
      await finishSuccessfulUpload();
      return;
    }
  } else if (!lastPipelineError) {
    lastPipelineError = new Error(
      "SFTP session does not support pipelined WRITE (open/write missing)",
    );
  }

  // Fail closed — do not crawl via serial WriteStream (industry practice:
  // OpenSSH/Electerm/WinSCP keep outstanding-request fanout; they do not
  // silently degrade to 1-in-flight put on failure).
  // Main's #2458 pause/unpipe fix still applies to download/local stream paths.
  transfer.uploadStrategy = "failed";
  logTransferDiag(transfer, "strategy", { strategy: "failed" });
  const cause = lastPipelineError;
  const message = cause?.message
    ? `SFTP pipelined upload failed: ${cause.message}`
    : "SFTP pipelined upload failed (no serial stream fallback)";
  const error = new Error(message, cause ? { cause } : undefined);
  if (cause?.code !== undefined) error.code = cause.code;
  if (cause?.noTransferFallback) error.noTransferFallback = true;
  if (transfer.sourceDigestPath) {
    try { await fs.promises.rm(transfer.sourceDigestPath, { force: true }); } catch { /* ignore */ }
    transfer.sourceDigestPath = null;
  }
  throw error;
}

/**
 * Open a remote SFTP handle while transfer.abort can reject the wait without
 * depending on sftp.end(). Isolated channels still pass abortChannel that ends
 * the subsystem; shared/sudo channels pass a no-op end path and only reject.
 * A late OPEN handle after cancel / channel error is closed best-effort when
 * disposeChannel is false so the shared session does not leak handles.
 * Channel `error` while OPEN is pending must reject here: callers only check
 * recorded channelError after this await returns, so a dead channel that never
 * invokes the OPEN callback would otherwise hang the transfer and SFTP lease.
 * Shared write opens ("w" / "r+" / …) publish transfer.sharedWriteOpenDrain and
 * keep it pending until the OPEN callback finishes (including late opens after
 * a cancel settle timeout), so upload cleanup awaits the drain before deleting
 * the remote stage. Channel-error and cancel-settle paths that never receive an
 * OPEN callback arm a short drain force-complete so a dead/stalled channel
 * cannot hold the transfer and SFTP lease forever. A late truncating `"w"` OPEN
 * after cancel still closes the handle and, when the path is an explicit
 * generated stage (`generatedStagePath`), best-effort unlinks it so stage
 * cleanup cannot race a recreate/orphan. In-place final targets are never
 * unlinked here. Same-id retries that already re-own the active transfer
 * slot skip unlink only when the retry's actual `stagedRemote.path` matches
 * this OPEN path. Path-shape / resumable+targetPath heuristics are not used:
 * an in-place retry leaves stagedRemote null while still looking "resumable",
 * and a stale late OPEN on a leftover `.part` must still unlink (Codex P2 on
 * 39e20bfa / 7c446c7 / d19ecb88). Truncating shared opens also take a
 * path-level gate so a same-id retry cannot issue OPEN "w" on a stage while a
 * prior attempt's truncating OPEN is still unsettled (Codex P1 on 42a27ef7).
 *
 * @param {{ disposeChannel?: boolean, abortChannel?: (() => void) | null, generatedStagePath?: boolean }} [options]
 */
function openSftpHandleForTransfer(sftp, filePath, flags, transfer, options = {}) {
  const disposeChannel = options.disposeChannel !== false;
  const abortChannel = typeof options.abortChannel === "function"
    ? options.abortChannel
    : null;
  // Match sftpBridge.runFastPutOnChannel: only unlink planner-generated stages.
  const generatedStagePath = options.generatedStagePath === true;
  // flags may be a getter so afterPathGate can shrink the resume checkpoint and
  // switch r+ → w before the actual OPEN (Codex P2). Resolve at OPEN/unlink time
  // so a post-gate shrink from r+ → w still unlinks generated stages.
  const resolveFlags = () => (typeof flags === "function" ? flags() : flags);
  // ssh2 string flags: "r" is read-only; anything else can create/truncate.
  // Treat function flags as write opens (caller only uses r+/w for transfers).
  const isWriteOpen = typeof flags === "function" || String(flags ?? "r") !== "r";
  const isTruncatingOpenNow = () => String(resolveFlags() ?? "r") === "w";
  const trackSharedWriteDrain = !disposeChannel && isWriteOpen;
  // Path-gate EVERY write open (shared and isolated, "w" and "r+"). An isolated
  // recovery OPEN must still wait for a stale shared truncating OPEN on the same
  // host path (Codex P1 on 294b7a4b / 40db393f).
  const pathGate = isWriteOpen
    ? beginTruncatingSharedWriteOpen(filePath, sharedWriteOpenSessionKey(sftp, transfer))
    : null;
  // Expose a promise that resolves when this OPEN's path gate is released so
  // same-transfer fallbacks (fastPut) can wait instead of racing a still-
  // pending truncating OPEN (Codex P1 on 7872a304). Also expose fail so a
  // fail-closed fastPut timeout can poison the shared path gate for later
  // same-path waiters (Codex P2 on dca41093).
  if (pathGate && transfer && typeof transfer === "object") {
    let resolvePathGate;
    const pending = new Promise((resolve) => { resolvePathGate = resolve; });
    transfer.pendingWriteOpenPathGate = pending;
    transfer._resolvePendingWriteOpenPathGate = () => {
      try { resolvePathGate(); } catch { /* ignore */ }
      if (transfer.pendingWriteOpenPathGate === pending) {
        transfer.pendingWriteOpenPathGate = null;
      }
      transfer._resolvePendingWriteOpenPathGate = null;
      transfer._failPendingWriteOpenPathGate = null;
    };
    transfer._failPendingWriteOpenPathGate = (error) => {
      try { pathGate.fail?.(error); } catch { /* ignore */ }
    };
  }
  // Re-check ownership at unlink time: a same-id retry may already own
  // activeTransfers. Only suppress unlink when the retry's *actual* staged
  // remote path matches this OPEN path. Do not infer ownership from
  // resumable+targetPath or path-shape alone — in-place retries keep
  // resumable/targetPath while stagedRemote is null (e.g. symlink / no-lstat
  // destinations), and a stale late OPEN on a leftover .part must still unlink.
  // Compare in the same representation: OPEN filePath may be a session-encoded
  // Buffer while stagedRemote.path is the logical string.
  // Truncating is re-resolved so getter flags that collapse to "w" still unlink.
  const canUnlinkLateGeneratedStageNow = () => {
    if (!generatedStagePath || !isTruncatingOpenNow()) return false;
    const transferId = transfer?.transferId;
    if (transferId == null || transferId === "") return true;
    const active = activeTransfers.get(transferId);
    if (active && active !== transfer) {
      if (remoteOpenPathMatchesStaged(filePath, active.stagedRemote)) {
        return false;
      }
      return true;
    }
    // Same transfer moved to a non-gated strategy (e.g. fastPut after concurrent
    // OPEN channel-error) still owns the stage — do not unlink the file that
    // the fallback just wrote (Codex P2 on 98b26f31). Only strategy-move counts:
    // ordinary cancel still has stagedRemote set and must unlink (Codex P1).
    if (active === transfer) {
      const strategy = String(active.uploadStrategy || active.strategy || "");
      if (/fastput|stream/i.test(strategy)) return false;
    }
    return true;
  };

  /**
   * When a late truncating OPEN lands after another attempt already opened the
   * same stage/in-place path, the server may have wiped those bytes. Fail the
   * live attempt rather than allow a sparse promote (Codex P1 on 42a27ef7 /
   * cross-id same-path P1 on 2165).
   */
  const invalidateRetryStageIfStaleOpen = () => {
    // Truncating OPEN on either a generated stage or an in-place final can wipe
    // a concurrent same-path writer — same-id retry or a new transferId.
    if (!isTruncatingOpenNow()) return;
    const openHost = transfer?.targetHostId || transfer?.hostId || transfer?.sourceHostId;
    const openSession = transfer?.targetSftpId || transfer?.sourceSftpId || transfer?.sftpId;
    for (const active of activeTransfers.values()) {
      if (!active || active === transfer) continue;
      const matchesStage = remoteOpenPathMatchesStaged(filePath, active.stagedRemote);
      const matchesInPlace = !active.stagedRemote && (
        remoteOpenPathMatchesStaged(filePath, {
          path: active.targetPath,
          sftpId: active.targetSftpId,
          encoding: active.targetEncoding,
        })
        || String(filePath ?? "") === String(active.targetPath ?? "")
      );
      if (!matchesStage && !matchesInPlace) continue;
      const activeHost = active.targetHostId || active.hostId || active.sourceHostId;
      const activeSession = active.targetSftpId || active.sourceSftpId || active.sftpId;
      // Require a matching host or session identity. Do not treat a missing host
      // as a wildcard — clipboard/agent uploads share common paths like /tmp
      // across unrelated endpoints (Codex P2 on 4d194041).
      if (openHost != null && String(openHost).length > 0
        && activeHost != null && String(activeHost).length > 0) {
        if (String(openHost) !== String(activeHost)) continue;
      } else if (openSession != null && String(openSession).length > 0
        && activeSession != null && String(activeSession).length > 0) {
        if (String(openSession) !== String(activeSession)) continue;
      } else {
        continue;
      }
      active.staleOpenTruncatedStage = true;
      // Not yet accepted OPEN: shrink checkpoint so afterPathGate / r+ restart
      // from zero instead of writing a sparse prefix into a wiped stage.
      if (active.sharedWriteOpenAccepted !== true) {
        try { active.checkpointBytes = 0; } catch { /* ignore */ }
        continue;
      }
      try { active.abort?.(); } catch { /* ignore */ }
    }
  };

  let resolveSharedWriteDrain = null;
  if (trackSharedWriteDrain) {
    transfer.sharedWriteOpenDrain = new Promise((resolve) => {
      resolveSharedWriteDrain = resolve;
    });
  }

  const runOpen = () => new Promise((resolve, reject) => {
    let settled = false;
    let openDrainTimer = null;
    let drainForceTimer = null;
    const previousAbort = transfer.abort;
    let pathGateReleased = false;
    // True when we released the path gate without an OPEN callback (timeout
    // after channel error / cancel). A late truncating OPEN can then wipe
    // same-transfer fastPut/shared fallback bytes - invalidate that attempt.
    let pathGateForceReleased = false;

    const releasePathGate = (options = {}) => {
      if (!pathGate || pathGateReleased) return;
      pathGateReleased = true;
      if (options.forced === true) pathGateForceReleased = true;
      pathGate.release();
      try { transfer._resolvePendingWriteOpenPathGate?.(); } catch { /* ignore */ }
    };

    // In-place truncating OPEN must stay poisoned until the OPEN callback
    // settles. Force-releasing lets fastPut/shared fallback finish, then a late
    // OPEN truncates the already-reported destination and invalidation cannot
    // restore it after sendComplete (Codex P1 on e2cc8241). Generated stages
    // still force-release: promotion checks staleOpenTruncatedStage.
    const mayForceReleasePathGate = () => !(
      isTruncatingOpenNow() && !generatedStagePath
    );

    // When we keep in-place poison without force-release, same-path strategy
    // fallbacks must not run: concurrent-shared would wait forever on the
    // unreleased prior gate (Codex P1 on 3d4cecfa). Also poison the shared path
    // map so later same-path waiters fail promptly (Codex P2 on dca41093).
    const markInPlaceOpenPoisonTerminal = () => {
      try {
        transfer.noTransferFallback = true;
        transfer.inPlaceWriteOpenPoisoned = true;
      } catch { /* ignore */ }
      try {
        pathGate?.fail?.(createPoisonedWriteOpenPathGateError(
          "Prior write OPEN never settled; path gate is fail-closed",
        ));
      } catch { /* ignore */ }
    };

    const invalidateSameTransferAfterForcedGateRelease = () => {
      if (!pathGateForceReleased || !isTruncatingOpenNow() || !transfer) return;
      const transferId = transfer.transferId;
      const active = transferId != null && transferId !== ""
        ? activeTransfers.get(transferId)
        : null;
      const target = active || transfer;
      target.staleOpenTruncatedStage = true;
      if (target.sharedWriteOpenAccepted === true) {
        try { target.abort?.(); } catch { /* ignore */ }
      } else {
        try { target.checkpointBytes = 0; } catch { /* ignore */ }
      }
    };

    const clearDrainForceTimer = () => {
      if (!drainForceTimer) return;
      clearTimeout(drainForceTimer);
      drainForceTimer = null;
    };

    const completeSharedWriteDrain = () => {
      clearDrainForceTimer();
      if (!resolveSharedWriteDrain) return;
      const resolveDrain = resolveSharedWriteDrain;
      resolveSharedWriteDrain = null;
      resolveDrain();
    };

    // OPEN wait may settle without a callback (channel error, or cancel settle
    // timeout). Force-complete the drain so cleanup/lease cannot hang, but
    // NEVER release the path gate here for shared channels: a still-in-flight
    // truncating OPEN can land later and wipe a same-path retry (Codex P1 on
    // a0b2ce01 / late-unlink-retry). Gate is only released from the OPEN
    // callback paths (success, error, late finishLateSharedWriteOpen), or via
    // armPathGateForceRelease after isolated sftp.end() when the callback is
    // never expected to arrive.
    const armSharedWriteDrainForceComplete = () => {
      if (!trackSharedWriteDrain || !resolveSharedWriteDrain || drainForceTimer) return;
      drainForceTimer = setTimeout(() => {
        drainForceTimer = null;
        // Free the transfer/lease only. Path gate stays held until the OPEN
        // callback actually settles (or never, if the channel is dead - safer
        // than reusing a path that a stale truncating OPEN can still wipe).
        completeSharedWriteDrain();
      }, 2000);
    };


    // Best-effort remote unlink. A dead shared channel that never invokes the
    // unlink callback is bounded by boundUnlinkThen so finishCancel / gate
    // release cannot hang the transfer or same-path waiters (Codex P2 hang).
    const unlinkSharedWritePathBestEffort = () => new Promise((resolveUnlink) => {
      let settledUnlink = false;
      const finishUnlink = () => {
        if (settledUnlink) return;
        settledUnlink = true;
        resolveUnlink();
      };
      // Ownership can change between close and unlink (retry start).
      if (!canUnlinkLateGeneratedStageNow()) {
        finishUnlink();
        return;
      }
      if (typeof sftp.unlink !== "function") {
        finishUnlink();
        return;
      }
      try {
        sftp.unlink(filePath, () => finishUnlink());
      } catch {
        finishUnlink();
      }
    });

    /**
     * Unlink, then settle transfer and release the path gate.
     * Transfer settle is 2s-bounded so a dead unlink cannot hang the invoke;
     * the path gate stays held until unlink actually settles so a delayed
     * unlink cannot delete a same-path retry that already wrote (Codex P2 on
     * 46ed3722).
     */
    const unlinkThenSettleAndReleaseGate = (settleFn) => {
      let transferSettled = false;
      const settleTransfer = () => {
        if (transferSettled) return;
        transferSettled = true;
        settleFn();
      };
      const settleTimer = setTimeout(settleTransfer, 2000);
      unlinkSharedWritePathBestEffort().then(
        () => {
          clearTimeout(settleTimer);
          settleTransfer();
          releasePathGate();
        },
        () => {
          clearTimeout(settleTimer);
          settleTransfer();
          releasePathGate();
        },
      );
    };

    /** Close with 2s bound so a dead channel cannot pin the path gate. */
    const boundCloseSftpHandle = (handle, thenFn) => {
      let closed = false;
      const finishClose = () => {
        if (closed) return;
        closed = true;
        thenFn();
      };
      const closeTimer = setTimeout(finishClose, 2000);
      closeSftpHandle(sftp, handle).then(
        () => { clearTimeout(closeTimer); finishClose(); },
        () => { clearTimeout(closeTimer); finishClose(); },
      );
    };

    // Late shared write OPEN after settle: close handle, and for generated
    // truncating stages also unlink so a force-completed drain / stage delete
    // cannot leave a recreate orphan after cancel OR channel-error settle
    // (Codex P2 on 0cda4a39 / cd57d960 / bd42c51c). Never unlink in-place
    // final targets (Codex P1 on a9f748c8). Skip unlink only when a same-id
    // retry owns a reusable resume stage at this path (Codex P2 on d19ecb88).
    // Bound close/unlink so a dead channel cannot pin the path gate forever
    // after drain force-complete (Codex P2 on 1a8cac20).
    const finishLateSharedWriteOpen = (handle) => {
      invalidateRetryStageIfStaleOpen();
      // Same-transfer fallback may already be writing after a forced gate
      // release; this late truncating OPEN wiped those bytes (Codex P1).
      invalidateSameTransferAfterForcedGateRelease();
      const afterClose = () => {
        const finish = () => {
          completeSharedWriteDrain();
          releasePathGate();
        };
        if (canUnlinkLateGeneratedStageNow()) {
          // Gate stays held until unlink settles (no 2s force-release).
          unlinkSharedWritePathBestEffort().then(finish, finish);
          return;
        }
        finish();
      };
      if (handle) {
        boundCloseSftpHandle(handle, afterClose);
        return;
      }
      afterClose();
    };


    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (openDrainTimer) {
        clearTimeout(openDrainTimer);
        openDrainTimer = null;
      }
      if (transfer.abort === abortDuringOpen) {
        transfer.abort = previousAbort;
      }
      try { sftp.removeListener?.("error", onOpenChannelError); } catch { /* ignore */ }
      fn(value);
    };

    const abortDuringOpen = () => {
      transfer.cancelled = true;
      // Any write OPEN (shared or isolated) can truncate/create the remote path.
      // A settle timeout unblocks the transfer UX; the path gate stays held until
      // the OPEN callback finishes so a same-path retry cannot race a still-
      // in-flight truncating OPEN (Codex P1 on 76015575 / c30e1734). Shared drain
      // stays pending until callback/force-complete. In-place truncating OPEN
      // also marks this transfer terminal and poisons the shared barrier.
      if (isWriteOpen && !settled) {
        try { abortChannel?.(); } catch { /* ignore */ }
        if (!openDrainTimer) {
          openDrainTimer = setTimeout(() => {
            settle(reject, new Error("Transfer cancelled"));
            if (trackSharedWriteDrain) {
              armSharedWriteDrainForceComplete();
            } else if (!mayForceReleasePathGate()) {
              markInPlaceOpenPoisonTerminal();
              completeSharedWriteDrain();
            }
            // Late OPEN after this still closes/unlinks via finishLateSharedWriteOpen.
          }, 2000);
        }
        return;
      }
      // Settle before abortChannel so a synchronous OPEN callback from
      // sftp.end() cannot win the promise with a channel-close error first.
      settle(reject, new Error("Transfer cancelled"));
      try { abortChannel?.(); } catch { /* ignore */ }
      completeSharedWriteDrain();
      releasePathGate();
    };

    const onOpenChannelError = (error) => {
      settle(reject, error || new Error("SFTP channel error"));
      // Write OPEN: keep path gate until OPEN callback (or shared drain force).
      // Isolated writes never force-release here: a late truncating OPEN can wipe
      // a same-path fallback destination after sendComplete (#2755 / Codex P1 on
      // c30e1734). Generated-stage hang is bounded by fastPut's gate wait timeout
      // (noTransferFallback). In-place truncating OPEN marks the transfer
      // terminal so strategy fallbacks do not wait forever (Codex P1 on 3d4cecfa).
      if (trackSharedWriteDrain) {
        armSharedWriteDrainForceComplete();
      } else if (isWriteOpen) {
        if (!mayForceReleasePathGate()) {
          markInPlaceOpenPoisonTerminal();
          completeSharedWriteDrain();
        }
      } else {
        completeSharedWriteDrain();
        releasePathGate();
      }
    };

    if (transfer.cancelled) {
      completeSharedWriteDrain();
      releasePathGate();
      reject(new Error("Transfer cancelled"));
      return;
    }

    transfer.abort = abortDuringOpen;
    sftp.on?.("error", onOpenChannelError);

    try {
      sftp.open(filePath, resolveFlags(), (error, handle) => {
        if (settled) {
          // Cancel / channel error already settled (possibly via drain timeout).
          // Shared/sudo late handles always close (read or write) so the long-
          // lived session cannot leak. Isolated late write OPENs still run
          // invalidation/unlink (Codex P1 on 76015575 / 298d155e).
          if (!error && handle && (isWriteOpen || !disposeChannel)) {
            finishLateSharedWriteOpen(handle);
            return;
          }
          completeSharedWriteDrain();
          releasePathGate();
          return;
        }
        if (error) {
          settle(reject, error);
          completeSharedWriteDrain();
          releasePathGate();
          return;
        }
        // Ownership moved to a same-id retry before this OPEN applied: treat as
        // late so we never hand the stale truncating handle to the old attempt.
        // Mark noTransferFallback so uploadFile does not run
        // prepareUploadFallbackCheckpoint and truncate the retry's shared stage
        // (Codex P1 on 6834bed1).
        const activeOwner = transfer?.transferId != null
          ? activeTransfers.get(transfer.transferId)
          : null;
        if (activeOwner && activeOwner !== transfer) {
          const supersededErr = new Error("Transfer superseded");
          supersededErr.noTransferFallback = true;
          settle(reject, supersededErr);
          if (handle && isWriteOpen) {
            finishLateSharedWriteOpen(handle);
            return;
          }
          completeSharedWriteDrain();
          releasePathGate();
          return;
        }
        if (transfer.cancelled) {
          const finishCancel = () => {
            settle(reject, new Error("Transfer cancelled"));
            completeSharedWriteDrain();
            releasePathGate();
          };
          if (handle && !disposeChannel) {
            // Close before settle/drain so shared write cleanup runs after the
            // truncating OPEN handle is released. Cancel + generated stage
            // "w": unlink too so a staged recreate cannot survive if cleanup
            // already raced. In-place finals are close-only. Same-id retries
            // that re-own activeTransfers skip unlink (resume stage reuse).
            if (canUnlinkLateGeneratedStageNow()) {
              // Bound close. Unlink: settle transfer after 2s if needed, but keep
              // the path gate until unlink actually settles (Codex P2 hang +
              // delayed-unlink race on 46ed3722).
              boundCloseSftpHandle(handle, () => {
                unlinkThenSettleAndReleaseGate(() => {
                  settle(reject, new Error("Transfer cancelled"));
                  completeSharedWriteDrain();
                });
              });
              return;
            }
            boundCloseSftpHandle(handle, finishCancel);
            return;
          }
          finishCancel();
          return;
        }
        transfer.sharedWriteOpenAccepted = true;
        settle(resolve, handle);
        completeSharedWriteDrain();
        releasePathGate();
      });
    } catch (error) {
      // Sync throw (destroyed channel / bad state) must still settle and drop
      // the error listener; otherwise the shared browse channel leaks listeners.
      settle(reject, error);
      completeSharedWriteDrain();
      releasePathGate();
    }
  });

  if (!pathGate) return runOpen();
  // Wait for any prior truncating OPEN on this path before issuing ours.
  // The wait must be cancelable: a cancelled transfer must release its gate
  // entry and settle drain without waiting forever on a stuck prior OPEN
  // (lease/admission hang + blocking later same-path attempts).
  return new Promise((resolve, reject) => {
    let waiting = true;
    const previousAbort = transfer.abort;

    const detachChannelErrorWhileWaiting = () => {
      try { sftp.removeListener?.("error", onChannelErrorWhileWaiting); } catch { /* ignore */ }
    };

    const abandonGateWait = (error) => {
      if (!waiting) return;
      waiting = false;
      detachChannelErrorWhileWaiting();
      if (transfer.abort === wrappedAbort) {
        transfer.abort = previousAbort;
      }
      // Do not release this waiter immediately: beginTruncatingSharedWriteOpen
      // already replaced the map entry with us. Releasing now would leave later
      // same-path attempts with no barrier while the prior OPEN is still in
      // flight (stale truncating OPEN race). Chain our release to the prior
      // settle; on prior *failure* (poison), propagate fail instead of resolve
      // so a successor waiting on our promise cannot start OPEN (Codex P1).
      pathGate.waitForPrior.then(
        () => {
          pathGate.release();
          try { transfer._resolvePendingWriteOpenPathGate?.(); } catch { /* ignore */ }
        },
        (priorErr) => {
          const failErr = priorErr instanceof Error
            ? priorErr
            : createPoisonedWriteOpenPathGateError(String(priorErr?.message || priorErr || ""));
          if (!failErr.noTransferFallback) failErr.noTransferFallback = true;
          // Propagate rejection to anyone waiting on our promise, but do not
          // reinstall ourselves over the OPEN owner's poisoned barrier.
          try { pathGate.fail?.(failErr, { reinstall: false }); } catch { /* ignore */ }
          try { transfer._resolvePendingWriteOpenPathGate?.(); } catch { /* ignore */ }
        },
      );
      if (resolveSharedWriteDrain) {
        const resolveDrain = resolveSharedWriteDrain;
        resolveSharedWriteDrain = null;
        resolveDrain();
      }
      reject(error);
    };

    const onChannelErrorWhileWaiting = (error) => {
      // Prior OPEN may never settle after a dead channel; reject this waiter so
      // lease/admission are not held until manual cancel (Codex P2 on 1f08f82c).
      const err = error instanceof Error ? error : new Error(String(error?.message || error || "SFTP channel error"));
      abandonGateWait(err);
    };

    const wrappedAbort = () => {
      try { previousAbort?.(); } catch { /* ignore */ }
      transfer.cancelled = true;
      abandonGateWait(new Error("Transfer cancelled"));
    };
    transfer.abort = wrappedAbort;

    if (transfer.cancelled) {
      abandonGateWait(new Error("Transfer cancelled"));
      return;
    }

    try { sftp.on?.("error", onChannelErrorWhileWaiting); } catch { /* ignore */ }

    const startOpen = () => {
      if (!waiting) return;
      waiting = false;
      try { pathGate.markOpenIssued?.(); } catch { /* ignore */ }
      // Keep cancel + channel-error wiring active through afterPathGate. A hung
      // post-gate stage stat must still yield to cancel/channel death so the
      // path gate and lease are not pinned forever (Codex P2 on f642580d).
      let afterGateDone = false;
      const releaseGateAndDrain = () => {
        pathGate.release();
        if (resolveSharedWriteDrain) {
          const resolveDrain = resolveSharedWriteDrain;
          resolveSharedWriteDrain = null;
          resolveDrain();
        }
      };
      const onChannelErrorDuringAfterGate = (error) => {
        const err = error instanceof Error
          ? error
          : new Error(String(error?.message || error || "SFTP channel error"));
        failAfterGate(err);
      };
      const detachAfterGateHooks = () => {
        detachChannelErrorWhileWaiting();
        try { sftp.removeListener?.("error", onChannelErrorDuringAfterGate); } catch { /* ignore */ }
        if (transfer.abort === abortDuringAfterGate) {
          transfer.abort = previousAbort;
        }
      };
      const failAfterGate = (error) => {
        if (afterGateDone) return;
        afterGateDone = true;
        detachAfterGateHooks();
        releaseGateAndDrain();
        reject(error instanceof Error ? error : new Error(String(error?.message || error)));
      };
      const abortDuringAfterGate = () => {
        try { previousAbort?.(); } catch { /* ignore */ }
        transfer.cancelled = true;
        failAfterGate(new Error("Transfer cancelled"));
      };

      // Swap gate-wait channel listener for the after-gate one; keep cancel live.
      detachChannelErrorWhileWaiting();
      transfer.abort = abortDuringAfterGate;
      try { sftp.on?.("error", onChannelErrorDuringAfterGate); } catch { /* ignore */ }

      // After waiting on a prior OPEN, re-validate resume checkpoints so a
      // truncating OPEN that landed while we waited cannot leave us writing
      // past a wiped stage (Codex P2 on 294b7a4b).
      const afterGate = typeof options.afterPathGate === "function"
        ? Promise.resolve().then(() => options.afterPathGate())
        : Promise.resolve();
      afterGate.then(() => {
        if (afterGateDone) return;
        if (transfer.cancelled) {
          failAfterGate(new Error("Transfer cancelled"));
          return;
        }
        afterGateDone = true;
        // Hand off to runOpen: drop after-gate hooks so OPEN owns abort/error.
        detachAfterGateHooks();
        runOpen().then(resolve, reject);
      }, (err) => {
        failAfterGate(err);
      });
    };

    pathGate.waitForPrior.then(
      startOpen,
      (err) => {
        const error = err instanceof Error
          ? err
          : createPoisonedWriteOpenPathGateError(String(err?.message || err || ""));
        if (!error.noTransferFallback) error.noTransferFallback = true;
        abandonGateWait(error);
      },
    );
  });
}

function closeSftpHandle(sftp, handle) {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readSftpRange(sftp, handle, buffer, position, length, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
  const signal = options.signal;
  const abortGate = options.abortGate;
  let received = 0;
  while (received < length) {
    const bytesRead = await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let unwatchAbort = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unwatchAbort?.();
        unwatchAbort = null;
        signal?.removeEventListener?.("abort", onAbort);
      };
      const finish = (error, count) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(Number(count) || 0);
      };
      const onAbort = () => {
        const error = new Error("Transfer cancelled");
        error.code = "ABORT_ERR";
        finish(error);
      };
      if (signal?.aborted || abortGate?.aborted) {
        onAbort();
        return;
      }
      if (abortGate) {
        unwatchAbort = abortGate.watch(onAbort);
      } else {
        signal?.addEventListener?.("abort", onAbort, { once: true });
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error(`SFTP READ timed out after ${timeoutMs} ms`);
          error.code = "SFTP_READ_TIMEOUT";
          error.sftpRequestTimedOut = true;
          finish(error);
        }, timeoutMs);
      }
      try {
        sftp.read(
          handle,
          buffer,
          received,
          length - received,
          position + received,
          (error, count) => finish(error, count),
        );
      } catch (error) {
        finish(error);
      }
    });
    if (bytesRead <= 0) {
      throw new Error("Download stream finished before the full source was received");
    }
    options.onRead?.(bytesRead);
    received += bytesRead;
  }
}

function createSharedAbortGate(signal) {
  const waiters = new Set();
  const notify = () => {
    const error = new Error("Transfer cancelled");
    error.code = "ABORT_ERR";
    for (const reject of [...waiters]) {
      try { reject(error); } catch { /* ignore */ }
    }
    waiters.clear();
  };
  const onAbort = () => notify();
  if (signal?.aborted) {
    return {
      get aborted() { return true; },
      watch(onAbortWatch) {
        onAbortWatch();
        return () => {};
      },
      dispose() {},
    };
  }
  signal?.addEventListener?.("abort", onAbort, { once: true });
  return {
    get aborted() { return Boolean(signal?.aborted); },
    watch(onAbortWatch) {
      if (signal?.aborted) {
        onAbortWatch();
        return () => {};
      }
      waiters.add(onAbortWatch);
      return () => waiters.delete(onAbortWatch);
    },
    dispose() {
      signal?.removeEventListener?.("abort", onAbort);
      waiters.clear();
    },
  };
}

async function closeSftpHandleBestEffort(sftp, handle, timeoutMs = 2_000) {
  let timer = null;
  let timedOut = false;
  let failed = false;
  try {
    await Promise.race([
      closeSftpHandle(sftp, handle),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch {
    // Verification cleanup must not mask the content check result.
    failed = true;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { timedOut, failed, unclean: timedOut || failed };
}

function openSftpReadHandle(sftp, remotePath, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, handle) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(handle);
    };
    const onAbort = () => {
      const error = new Error("Transfer cancelled");
      error.code = "ABORT_ERR";
      finish(error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error(`SFTP OPEN timed out after ${timeoutMs} ms`);
        error.code = "SFTP_OPEN_TIMEOUT";
        error.sftpRequestTimedOut = true;
        finish(error);
      }, timeoutMs);
    }
    try {
      sftp.open(remotePath, "r", (error, handle) => {
        if (settled) {
          if (handle) closeSftpHandle(sftp, handle).catch(() => {});
          return;
        }
        finish(error, handle);
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function hashRemotePrefixWithSftpRanges(client, remotePath, bytes, options = {}) {
  if (!Number.isFinite(bytes) || bytes <= 0 || isScpModeClient(client)) return null;
  await requireSftpChannel(client, { signal: options.signal });
  const sftp = client.sftp;
  if (typeof sftp?.open !== "function" || typeof sftp?.read !== "function") return null;

  const chunkSize = TRANSFER_CHUNK_SIZE;
  const rangeCount = Math.ceil(bytes / chunkSize);
  const concurrency = Math.min(DOWNLOAD_TRANSFER_CONCURRENCY, rangeCount);
  let completedBytes = 0;
  const openTimeoutMs = Number(options.sftpOpenTimeoutMs) > 0
    ? Number(options.sftpOpenTimeoutMs)
    : SFTP_OPEN_TIMEOUT_MS;
  const readTimeoutMs = Number(options.sftpReadTimeoutMs) > 0
    ? Number(options.sftpReadTimeoutMs)
    : SFTP_REQUEST_TIMEOUT_MS;
  const handle = await openSftpReadHandle(sftp, remotePath, options.signal, openTimeoutMs);
  const abortGate = createSharedAbortGate(options.signal);
  try {
    // Hash windows in order so peak retained buffers stay within the concurrency
    // fanout (~2MB), not the full multi-GB prefix.
    const hash = crypto.createHash("sha256");
    for (let windowStart = 0; windowStart < rangeCount; windowStart += concurrency) {
      const windowCount = Math.min(concurrency, rangeCount - windowStart);
      const windowBuffers = new Array(windowCount);
      // One inactivity watchdog for the whole window. Per-request deadlines would
      // fire together after readTimeoutMs even while earlier reads keep landing
      // on a slow/serialized server.
      let inactivityTimer = null;
      let rejectInactivity = null;
      let windowActive = true;
      const clearInactivity = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = null;
      };
      const armInactivity = () => {
        if (!windowActive || !(readTimeoutMs > 0) || options.signal?.aborted || abortGate.aborted) return;
        clearInactivity();
        inactivityTimer = setTimeout(() => {
          const error = new Error(`SFTP READ timed out after ${readTimeoutMs} ms`);
          error.code = "SFTP_READ_TIMEOUT";
          error.sftpRequestTimedOut = true;
          rejectInactivity?.(error);
        }, readTimeoutMs);
      };
      const inactivityWait = readTimeoutMs > 0
        ? new Promise((_, reject) => { rejectInactivity = reject; })
        : null;
      armInactivity();
      try {
        await Promise.race([
          Promise.all(Array.from({ length: windowCount }, async (_, offset) => {
            const index = windowStart + offset;
            const position = index * chunkSize;
            const length = Math.min(chunkSize, bytes - position);
            const buffer = Buffer.allocUnsafe(length);
            await readSftpRange(sftp, handle, buffer, position, length, {
              abortGate,
              onRead: () => {
                // Short READ replies are real activity too. Do not start the
                // next partial read after this window has already failed.
                if (!windowActive) throw new Error("SFTP verification window ended");
                armInactivity();
              },
            });
            if (!windowActive) return;
            windowBuffers[offset] = buffer;
            completedBytes += length;
            options.onProgress?.(completedBytes);
          })),
          ...(inactivityWait ? [inactivityWait] : []),
        ]);
      } finally {
        windowActive = false;
        clearInactivity();
        rejectInactivity = null;
      }
      for (const buffer of windowBuffers) hash.update(buffer);
    }
    return hash.digest("hex");
  } finally {
    abortGate.dispose();
    const closeResult = await closeSftpHandleBestEffort(
      sftp,
      handle,
      Number(options.sftpCloseTimeoutMs) > 0 ? Number(options.sftpCloseTimeoutMs) : 2_000,
    );
    // A timed-out/failed CLOSE leaves an unresolved request on the shared
    // channel; drop it so later browse/transfer work cannot reuse it.
    if (closeResult?.unclean) {
      abandonWedgedVerificationSftpChannel(client);
    }
  }
}

async function writeLocalRange(fileHandle, buffer, position, length) {
  let written = 0;
  while (written < length) {
    const result = await fileHandle.write(buffer, written, length - written, position + written);
    if (!result || result.bytesWritten <= 0) {
      throw new Error("Local download file stopped accepting data");
    }
    written += result.bytesWritten;
  }
}

async function readLocalRange(fileHandle, buffer, position, length) {
  let received = 0;
  while (received < length) {
    const result = await fileHandle.read(buffer, received, length - received, position + received);
    if (!result || result.bytesRead <= 0) {
      throw new Error("Upload source ended before the expected file size");
    }
    received += result.bytesRead;
  }
}

function writeSftpRange(sftp, handle, buffer, position, length) {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, 0, length, position, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function verifyFastDownloadSamples(sftp, remoteHandle, localHandle, fileSize, transfer) {
  if (fileSize <= 0) return;
  const sampleSize = Math.min(TRANSFER_CHUNK_SIZE, fileSize);
  const offsets = [...new Set([
    0,
    Math.max(0, Math.floor((fileSize - sampleSize) / 2)),
    Math.max(0, fileSize - sampleSize),
  ])];

  // Verification READs sit outside runPausableConcurrentRanges. After ranges
  // settle, the prior abort hook is a no-op, so shared/sudo cancel (or a
  // channel error without a READ callback) would hang forever without a local
  // force-settle — same 2s grace as forceSettleOnError for download READs.
  let rejectPending = null;
  let forceSettleTimer = null;
  let verifyDone = false;
  let channelError = null;
  const previousAbort = transfer.abort;
  const cancelError = () => new Error("Transfer cancelled");
  const abortDuringVerify = () => {
    transfer.cancelled = true;
    try { previousAbort?.(); } catch { /* ignore */ }
    if (verifyDone || forceSettleTimer) return;
    forceSettleTimer = setTimeout(() => {
      forceSettleTimer = null;
      rejectPending?.(cancelError());
    }, 2000);
  };
  const onVerifyChannelError = (error) => {
    // Remember across sample gaps: an error between races (after one sample
    // resolves, before the next rejectPending is installed) must still fail
    // the next sample instead of letting readSftpRange hang forever.
    channelError = channelError || error || new Error("SFTP channel error");
    rejectPending?.(channelError);
  };
  transfer.abort = abortDuringVerify;
  sftp.on?.("error", onVerifyChannelError);

  try {
    if (transfer.cancelled) throw cancelError();
    if (channelError) throw channelError;
    for (const position of offsets) {
      if (transfer.cancelled) throw cancelError();
      if (channelError) throw channelError;
      const length = Math.min(sampleSize, fileSize - position);
      const remoteBuffer = Buffer.allocUnsafe(length);
      const localBuffer = Buffer.allocUnsafe(length);
      await Promise.race([
        (async () => {
          await readSftpRange(sftp, remoteHandle, remoteBuffer, position, length);
          await readLocalRange(localHandle, localBuffer, position, length);
          if (!remoteBuffer.equals(localBuffer)) {
            const error = new Error("Transfer source content changed during transfer");
            error.noTransferFallback = true;
            error.sourceChanged = true;
            throw error;
          }
        })(),
        new Promise((_, reject) => {
          rejectPending = reject;
          if (channelError) {
            reject(channelError);
            return;
          }
          if (transfer.cancelled) abortDuringVerify();
        }),
      ]);
      // Cancel during a responsive sample can win the race above without the
      // force-settle timer firing. Recheck so we never report complete after
      // cancel (especially the last sample on direct/non-staged downloads).
      if (transfer.cancelled) throw cancelError();
      if (channelError) throw channelError;
    }
  } finally {
    verifyDone = true;
    if (forceSettleTimer) {
      clearTimeout(forceSettleTimer);
      forceSettleTimer = null;
    }
    rejectPending = null;
    if (transfer.abort === abortDuringVerify) {
      transfer.abort = previousAbort;
    }
    try { sftp.removeListener?.("error", onVerifyChannelError); } catch { /* ignore */ }
  }
}

function createSourceSizeChangedError(expectedSize, actualSize) {
  const error = new Error(
    `Transfer source size changed during transfer: expected ${expectedSize}, got ${actualSize}`,
  );
  error.noTransferFallback = true;
  error.sourceChanged = true;
  return error;
}

function createSourceContentChangedError() {
  const error = new Error("Transfer source content changed during transfer");
  error.noTransferFallback = true;
  error.sourceChanged = true;
  return error;
}

function isTransferCancelled(transfer) {
  return Boolean(transfer?.cancelled || transfer?.signal?.aborted);
}

const UPLOAD_DIGEST_SCAN_SIZE = TRANSFER_CHUNK_SIZE * 128;
const EMPTY_DIGEST_SLOT = Buffer.alloc(32);

function uploadDigestByteLength(fileSize) {
  return Math.ceil(Math.max(0, Number(fileSize) || 0) / TRANSFER_CHUNK_SIZE) * 32;
}

function isUnsetDigestSlot(buffer, bytesRead) {
  if (bytesRead !== 32) return true;
  return buffer.equals(EMPTY_DIGEST_SLOT);
}

async function assertUploadDigestCapacity(digestPath, fileSize) {
  if (typeof fs.promises.statfs !== "function") return;
  const requiredBytes = BigInt(uploadDigestByteLength(fileSize));
  let stats;
  try {
    stats = await fs.promises.statfs(path.dirname(digestPath), { bigint: true });
  } catch {
    return;
  }
  const availableBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
  if (availableBytes < requiredBytes) {
    const error = new Error(
      `Not enough Netcatty temporary storage for upload verification: requires ${requiredBytes} bytes, ${availableBytes} bytes available`,
    );
    error.noTransferFallback = true;
    throw error;
  }
}

/**
 * Allocate an empty per-chunk digest sidecar without reading the source.
 * Chunk digests are filled on first verified read during the upload pass so
 * multi-GB files no longer wait on a full pre-hash before the first WRITE.
 */
async function prepareUploadDigestSidecar(digestPath, fileSize) {
  await fs.promises.rm(digestPath, { force: true });
  await assertUploadDigestCapacity(digestPath, fileSize);
  const requiredBytes = uploadDigestByteLength(fileSize);
  const handle = await fs.promises.open(digestPath, "w");
  try {
    if (requiredBytes > 0) await handle.truncate(requiredBytes);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function verifyUploadDigestBaseline(sourcePath, digestPath, fileSize, transfer, onProgress = null) {
  let sourceHandle = null;
  let digestHandle = null;
  try {
    sourceHandle = await fs.promises.open(sourcePath, "r");
    // r+ so a lazy sidecar can finish filling any still-empty slots on the
    // post-upload re-scan (e.g. resume after a crash with a partial digest).
    digestHandle = await fs.promises.open(digestPath, "r+");
    const buffer = Buffer.allocUnsafe(Math.min(UPLOAD_DIGEST_SCAN_SIZE, Math.max(1, fileSize)));
    let position = 0;
    let chunkIndex = 0;
    while (position < fileSize) {
      if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
      const length = Math.min(buffer.length, fileSize - position);
      await readLocalRange(sourceHandle, buffer, position, length);
      if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
      const digestCount = Math.ceil(length / TRANSFER_CHUNK_SIZE);
      const expected = Buffer.allocUnsafe(digestCount * 32);
      await readLocalRange(digestHandle, expected, chunkIndex * 32, expected.length);
      for (let offset = 0, index = 0; offset < length; offset += TRANSFER_CHUNK_SIZE, index += 1) {
        const actual = crypto.createHash("sha256")
          .update(buffer.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, length)))
          .digest();
        const slot = expected.subarray(index * 32, (index + 1) * 32);
        if (isUnsetDigestSlot(slot, 32)) {
          const writeResult = await digestHandle.write(
            actual,
            0,
            32,
            (chunkIndex + index) * 32,
          );
          if (!writeResult || writeResult.bytesWritten !== 32) {
            throw new Error("Upload digest sidecar stopped accepting data");
          }
        } else if (!slot.equals(actual)) {
          throw createSourceContentChangedError();
        }
      }
      position += length;
      chunkIndex += digestCount;
      onProgress?.(position, fileSize);
    }
  } finally {
    await sourceHandle?.close().catch(() => {});
    await digestHandle?.close().catch(() => {});
  }
}

async function createUploadDigestBaseline(
  sourcePath,
  digestPath,
  fileSize,
  transfer,
  onProgress = null,
  options = {},
) {
  // merge:true — fill/verify an existing sidecar while uploads are in flight.
  // Default replaces the file (SCP / snapshot callers need a clean baseline).
  const merge = options.merge === true;
  if (!merge) {
    await fs.promises.rm(digestPath, { force: true });
    await prepareUploadDigestSidecar(digestPath, fileSize);
  } else {
    await assertUploadDigestCapacity(digestPath, fileSize);
    try {
      await fs.promises.access(digestPath);
    } catch {
      await prepareUploadDigestSidecar(digestPath, fileSize);
    }
  }
  let sourceHandle = null;
  let digestHandle = null;
  let completed = false;
  try {
    sourceHandle = await fs.promises.open(sourcePath, "r");
    digestHandle = await fs.promises.open(digestPath, "r+");
    const buffer = Buffer.allocUnsafe(Math.min(UPLOAD_DIGEST_SCAN_SIZE, Math.max(1, fileSize)));
    let position = 0;
    let chunkIndex = 0;
    while (position < fileSize) {
      if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
      const length = Math.min(buffer.length, fileSize - position);
      await readLocalRange(sourceHandle, buffer, position, length);
      if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
      const digestCount = Math.ceil(length / TRANSFER_CHUNK_SIZE);
      for (let offset = 0, index = 0; offset < length; offset += TRANSFER_CHUNK_SIZE, index += 1) {
        const actual = crypto.createHash("sha256")
          .update(buffer.subarray(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, length)))
          .digest();
        const slotIndex = chunkIndex + index;
        const digestOffset = slotIndex * 32;
        await withDigestSlotLock(digestHandle, slotIndex, async () => {
          const expected = Buffer.allocUnsafe(32);
          const digestResult = await digestHandle.read(expected, 0, 32, digestOffset);
          if (isUnsetDigestSlot(expected, digestResult.bytesRead)) {
            const writeResult = await digestHandle.write(actual, 0, 32, digestOffset);
            if (!writeResult || writeResult.bytesWritten !== 32) {
              throw new Error("Upload digest baseline stopped accepting data");
            }
          } else if (!expected.equals(actual)) {
            throw createSourceContentChangedError();
          }
        });
      }
      position += length;
      chunkIndex += digestCount;
      // Report scan progress so large uploads do not look stuck at 0 B/s while
      // hashing (#2712 / #2556). Bytes here are local read progress, not remote.
      onProgress?.(position, fileSize);
    }
    if (typeof digestHandle.sync === "function") {
      await digestHandle.sync().catch(() => {});
    }
    completed = true;
  } finally {
    await sourceHandle?.close().catch(() => {});
    await digestHandle?.close().catch(() => {});
    // Background filler must not delete a sidecar still used by live uploads.
    if (!completed && !merge) {
      await fs.promises.rm(digestPath, { force: true }).catch(() => {});
    }
  }
}

async function createVerifiedUploadSnapshot(
  sourcePath,
  snapshotPath,
  digestPath,
  fileSize,
  transfer,
) {
  await fs.promises.rm(snapshotPath, { force: true });
  let sourceHandle = null;
  let digestHandle = null;
  let snapshotHandle = null;
  let completed = false;
  try {
    sourceHandle = await fs.promises.open(sourcePath, "r");
    digestHandle = await fs.promises.open(digestPath, "r+");
    snapshotHandle = await fs.promises.open(snapshotPath, "w");
    const sourceStats = await sourceHandle.stat();
    let position = 0;
    while (position < fileSize) {
      if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
      const length = Math.min(UPLOAD_DIGEST_SCAN_SIZE, fileSize - position);
      const buffer = await readVerifiedUploadRange(
        sourceHandle,
        digestHandle,
        position,
        length,
        fileSize,
      );
      let written = 0;
      while (written < buffer.length) {
        const result = await snapshotHandle.write(
          buffer,
          written,
          buffer.length - written,
          position + written,
        );
        if (!result || result.bytesWritten <= 0) {
          throw new Error("Upload snapshot stopped accepting data");
        }
        written += result.bytesWritten;
      }
      position += length;
    }
    await snapshotHandle.chmod(sourceStats.mode & 0o7777);
    completed = true;
  } finally {
    await sourceHandle?.close().catch(() => {});
    await digestHandle?.close().catch(() => {});
    await snapshotHandle?.close().catch(() => {});
    if (!completed) await fs.promises.rm(snapshotPath, { force: true }).catch(() => {});
  }
}

function createVerifiedUploadReadStream(
  sourcePath,
  digestPath,
  fileSize,
  transfer,
) {
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const stream = Readable.from((async function* verifiedUploadChunks() {
    let sourceHandle = null;
    let digestHandle = null;
    try {
      sourceHandle = await fs.promises.open(sourcePath, "r");
      digestHandle = await fs.promises.open(digestPath, "r+");
      let position = 0;
      while (position < fileSize) {
        if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
        const length = Math.min(UPLOAD_DIGEST_SCAN_SIZE, fileSize - position);
        const chunk = await readVerifiedUploadRange(
          sourceHandle,
          digestHandle,
          position,
          length,
          fileSize,
        );
        if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
        yield chunk;
        position += length;
      }
    } finally {
      await sourceHandle?.close().catch(() => {});
      await digestHandle?.close().catch(() => {});
      resolveCompleted();
    }
  })());
  return { stream, completed };
}

async function withDigestSlotLock(digestHandle, chunkIndex, fn) {
  // Per-chunk locks keep pipelined uploads concurrent across ranges while still
  // serializing r+ ops on the same 32-byte digest slot.
  if (!digestHandle.__netcattySlotLocks) {
    digestHandle.__netcattySlotLocks = new Map();
  }
  const locks = digestHandle.__netcattySlotLocks;
  const previous = locks.get(chunkIndex) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(chunkIndex, previous.then(() => gate, () => gate));
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

async function readVerifiedUploadRange(
  localHandle,
  digestHandle,
  position,
  length,
  fileSize,
  options = {},
) {
  // allowCreate: first pass fills empty digest slots while uploading (no full
  // pre-hash). Resume re-reads must require an existing non-empty slot so a
  // rewritten source cannot silently mint a new identity for already-sent bytes.
  const allowCreate = options.allowCreate !== false;
  const output = Buffer.allocUnsafe(length);
  let outputOffset = 0;
  while (outputOffset < length) {
    const rangePosition = position + outputOffset;
    const chunkStart = Math.floor(rangePosition / TRANSFER_CHUNK_SIZE) * TRANSFER_CHUNK_SIZE;
    const chunkLength = Math.min(TRANSFER_CHUNK_SIZE, fileSize - chunkStart);
    const chunk = Buffer.allocUnsafe(chunkLength);
    // Local reads may run concurrently; only digest-slot mutations are locked.
    await readLocalRange(localHandle, chunk, chunkStart, chunkLength);
    const actual = crypto.createHash("sha256").update(chunk).digest();
    const chunkIndex = Math.floor(chunkStart / TRANSFER_CHUNK_SIZE);
    const digestOffset = chunkIndex * 32;
    await withDigestSlotLock(digestHandle, chunkIndex, async () => {
      const expected = Buffer.allocUnsafe(32);
      const digestResult = await digestHandle.read(expected, 0, 32, digestOffset);
      if (isUnsetDigestSlot(expected, digestResult.bytesRead)) {
        if (!allowCreate) throw createSourceContentChangedError();
        // Record identity for this chunk as we upload it (single local read).
        const writeResult = await digestHandle.write(actual, 0, 32, digestOffset);
        if (!writeResult || writeResult.bytesWritten !== 32) {
          throw new Error("Upload digest sidecar stopped accepting data");
        }
      } else if (!expected.equals(actual)) {
        throw createSourceContentChangedError();
      }
    });
    const chunkOffset = rangePosition - chunkStart;
    const copyLength = Math.min(length - outputOffset, chunkLength - chunkOffset);
    chunk.copy(output, outputOffset, chunkOffset, chunkOffset + copyLength);
    outputOffset += copyLength;
  }
  return output;
}

/**
 * Reject when the source identity is no longer safe to trust.
 *
 * Size always fails hard for shrinks. Growth is optional for download snapshots:
 * append-only files (live logs) grow while we still hold a valid [0, N) copy.
 * Growth alone is *not* proof of append-only — an in-place rewrite/rotate can
 * also enlarge the file. Callers must verify the planned prefix (or pass
 * contentVerifiedSeparately) before accepting growth.
 * Timestamp / inode fields are only a *cheap early reject* when we have no
 * separate content proof (e.g. remote download with no digest). When a digest
 * baseline already verifies bytes — or every range was already verified against
 * one — treat metadata as soft:
 * macOS routinely bumps ctime for xattr / quarantine / Spotlight without
 * rewriting file data, and repeated pause/resume makes long uploads much more
 * likely to hit that drift right at the finish revalidation.
 *
 * @param {object|null|undefined} initialSource
 * @param {object|null|undefined} latestSource
 * @param {number} expectedSize
 * @param {{ contentVerifiedSeparately?: boolean, allowSourceGrowth?: boolean, ignoreCtime?: boolean }} [options]
 */
function assertSourceMetadataUnchanged(initialSource, latestSource, expectedSize, options = {}) {
  const latestSize = Number(latestSource?.size);
  if (!Number.isFinite(latestSize)) {
    throw createSourceSizeChangedError(expectedSize, latestSize);
  }
  if (latestSize < expectedSize) {
    throw createSourceSizeChangedError(expectedSize, latestSize);
  }
  if (latestSize > expectedSize) {
    if (!options.allowSourceGrowth) {
      throw createSourceSizeChangedError(expectedSize, latestSize);
    }
    // Growth without a separate prefix proof is indistinguishable from an
    // in-place rewrite that also enlarged the file. Callers must hash the
    // planned [0, expectedSize) range first, then pass contentVerifiedSeparately.
    if (!options.contentVerifiedSeparately) {
      throw createSourceContentChangedError();
    }
    // Append writers always bump mtime/ctime; skip soft metadata after content proof.
    return;
  }
  if (options.contentVerifiedSeparately) {
    return;
  }
  // No digest / per-range content proof: timestamps + inode are the durable
  // same-size rewrite signal. Upload finish may set ignoreCtime so macOS
  // xattr/Spotlight ctime bumps do not abort after a true size match.
  const versionFields = options.ignoreCtime
    ? ["mtimeMs", "mtime", "ino"]
    : ["mtimeMs", "ctimeMs", "mtime", "ctime", "ino"];
  const changed = versionFields.some((field) => {
    const before = Number(initialSource?.[field]);
    const after = Number(latestSource?.[field]);
    return Number.isFinite(before) && Number.isFinite(after) && before !== after;
  });
  if (changed) {
    throw createSourceContentChangedError();
  }
}

/**
 * Prove the staged local download still matches remote [0, prefixBytes).
 * Required before accepting remote source growth as append-only.
 *
 * @param {string} localPath
 * @param {object} client
 * @param {string} remotePath session-encoded remote path used by the download
 * @param {number} prefixBytes planned snapshot size
 * @param {{ signal?: AbortSignal, onProgress?: (n: number) => void }} [options]
 */
function abandonWedgedVerificationSftpChannel(client) {
  const sftp = client?.sftp;
  if (!client || !sftp) return;
  // Drop the cached channel first so requireSftpChannel cannot hand the wedged
  // object back to later browse/transfer work (hasSftpChannelApi only checks
  // method presence). Non-sudo sessions can reopen; sudo recovery stays disabled.
  client.sftp = null;
  try { sftp.end?.(); } catch { /* ignore */ }
  try { sftp.destroy?.(); } catch { /* ignore */ }
}

async function assertLocalDownloadMatchesRemotePrefix(
  localPath,
  client,
  remotePath,
  prefixBytes,
  options = {},
) {
  if (!(prefixBytes > 0)) return;
  if (isScpModeClient(client)) {
    // SCP cannot range-hash portably; fail closed when growth needs proof.
    throw createSourceContentChangedError();
  }
  try {
    await requireSftpChannel(client, { signal: options.signal });
    const remoteHash = (async () => {
      const commandDigest = await hashRemotePrefixViaSshCommand(
        client,
        remotePath,
        prefixBytes,
        options,
      );
      if (commandDigest) return commandDigest;
      if (options.preferSftpRanges !== false) {
        try {
          const rangeDigest = await hashRemotePrefixWithSftpRanges(
            client,
            remotePath,
            prefixBytes,
            options,
          );
          if (rangeDigest) return rangeDigest;
        } catch (error) {
          if (options.signal?.aborted || error?.sftpRequestTimedOut) throw error;
        }
      }
      if (typeof client.sftp?.createReadStream !== "function") {
        throw createSourceContentChangedError();
      }
      return hashReadable(
        client.sftp.createReadStream(remotePath, {
          start: 0,
          end: prefixBytes - 1,
        }),
        {
          ...options,
          inactivityTimeoutMs: Number(options.sftpReadTimeoutMs) > 0
            ? Number(options.sftpReadTimeoutMs)
            : SFTP_REQUEST_TIMEOUT_MS,
        },
      );
    })();
    const [localHash, verifiedRemoteHash] = await Promise.all([
      hashLocalFile(localPath, options),
      remoteHash,
    ]);
    if (!localHash || !verifiedRemoteHash || localHash !== verifiedRemoteHash) {
      throw createSourceContentChangedError();
    }
  } catch (error) {
    // Verification OPEN/READ/stream watchdogs must fail closed — downloadFile's
    // isolated→shared catch would otherwise retry body transfer on a channel
    // that still owns the timed-out request and can hang indefinitely.
    if (error && typeof error === "object" && error.sftpRequestTimedOut) {
      error.noTransferFallback = true;
      abandonWedgedVerificationSftpChannel(client);
    }
    throw error;
  }
}

/**
 * Finish-path source check for downloads. Accepts append-only growth only after
 * the full planned prefix is proven intact against the staged local file.
 */
async function assertDownloadSourceAfterTransfer(
  initialSource,
  latestSource,
  expectedSize,
  {
    localPath,
    client,
    remotePath,
    signal,
    preferSftpRanges = true,
    ...verificationOptions
  } = {},
) {
  if (!initialSource) return;
  const latestSize = Number(latestSource?.size);
  if (!Number.isFinite(latestSize)) {
    throw createSourceSizeChangedError(expectedSize, latestSize);
  }
  if (latestSize < expectedSize) {
    throw createSourceSizeChangedError(expectedSize, latestSize);
  }
  if (latestSize > expectedSize) {
    await assertLocalDownloadMatchesRemotePrefix(
      localPath,
      client,
      remotePath,
      expectedSize,
      { signal, preferSftpRanges, ...verificationOptions },
    );
    assertSourceMetadataUnchanged(initialSource, latestSource, expectedSize, {
      allowSourceGrowth: true,
      contentVerifiedSeparately: true,
    });
    return;
  }
  assertSourceMetadataUnchanged(initialSource, latestSource, expectedSize);
}

async function runPausableConcurrentRanges({
  transfer,
  fileSize,
  checkpoint,
  concurrency,
  copyRange,
  sendProgress,
  abortChannel,
  sftp = null,
  forceSettleOnError = false,
}) {
  let nextOffset = checkpoint;
  // Progress may complete out of order, but the resume checkpoint must never
  // advance past a range that has not durably finished yet.
  let transferred = checkpoint;
  let contiguousCheckpoint = checkpoint;
  const completedRanges = new Map();
  let active = 0;
  let settled = false;
  let terminalError = null;
  // Each entry: { resolve, timer? } — timer is the soft-drain force-resolve.
  let pauseResolvers = [];

  const cancelPauseWait = () => {
    const resolvers = pauseResolvers;
    pauseResolvers = [];
    for (const entry of resolvers) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve();
    }
  };

  const publishContiguousCheckpoint = (force = false) => {
    if (transfer.cancelled) return;
    // Keep transfer.checkpointBytes in lockstep so a soft-drained pause that
    // returns early still exposes the highest contiguous durable offset.
    transfer.checkpointBytes = contiguousCheckpoint;
    sendProgress(transferred, fileSize, {
      checkpointBytes: contiguousCheckpoint,
      ...(force ? { force: true } : {}),
    });
  };

  const settlePauseWaiters = () => {
    if (!transfer.paused || active !== 0 || pauseResolvers.length === 0) return;
    // Flush the contiguous offset before resolving pause so pauseTransfer
    // never has to re-stat a sparse staged file.
    publishContiguousCheckpoint(true);
    const resolvers = pauseResolvers;
    pauseResolvers = [];
    for (const entry of resolvers) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve();
    }
  };

  transfer.getActiveRangeCount = () => active;

  let onSftpError = null;

  try {
    await new Promise((resolve, reject) => {
      let forceFinishTimer = null;
      const clearForceFinish = () => {
        if (forceFinishTimer) {
          clearTimeout(forceFinishTimer);
          forceFinishTimer = null;
        }
      };
      const finish = (error) => {
        if (settled) return;
        if (error) terminalError = terminalError || error;
        if (active > 0) {
          // forceSettleOnError callers may abandon in-flight ranges after a
          // short grace: isolated channels (after sftp.end), and shared
          // downloads (READ-only — no remote WRITEs to drain). Shared uploads
          // must keep forceSettleOnError false so outstanding WRITEs finish
          // before the caller reuses or cleans up the remote path.
          if (terminalError && forceSettleOnError) {
            if (!forceFinishTimer) {
              forceFinishTimer = setTimeout(() => {
                if (settled) return;
                active = 0;
                settled = true;
                reject(terminalError || new Error("Transfer cancelled"));
              }, 2000);
            }
          }
          return;
        }
        clearForceFinish();
        settled = true;
        if (terminalError) reject(terminalError);
        else resolve();
      };

      const abort = (error = new Error("Transfer cancelled")) => {
        terminalError = terminalError || error;
        try { abortChannel?.(); } catch { /* ignore */ }
        finish(terminalError);
      };

      // Channel-level errors must not become unhandled EventEmitter crashes.
      if (sftp && typeof sftp.on === "function") {
        onSftpError = (error) => {
          abort(error || new Error("Isolated SFTP channel error"));
        };
        sftp.on("error", onSftpError);
      }

      const pump = () => {
        if (settled) return;
        if (terminalError || transfer.cancelled) {
          finish(terminalError || new Error("Transfer cancelled"));
          return;
        }
        if (transfer.paused) {
          settlePauseWaiters();
          return;
        }

        while (
          active < concurrency
          && nextOffset < fileSize
          && !transfer.paused
          && !transfer.cancelled
        ) {
          const position = nextOffset;
          const length = Math.min(
            TRANSFER_CHUNK_SIZE - (position % TRANSFER_CHUNK_SIZE),
            fileSize - position,
          );
          nextOffset += length;
          active += 1;

          void copyRange(position, length)
            .then(() => {
              // After force-settle, abandoned ranges must not publish progress
              // or advance checkpoints into the caller's truncate/fallback window.
              if (settled) return;
              transferred += length;
              completedRanges.set(position, position + length);
              while (completedRanges.has(contiguousCheckpoint)) {
                const nextCheckpoint = completedRanges.get(contiguousCheckpoint);
                completedRanges.delete(contiguousCheckpoint);
                contiguousCheckpoint = nextCheckpoint;
              }
              publishContiguousCheckpoint(false);
            })
            .catch((error) => {
              if (settled) return;
              abort(error);
            })
            .finally(() => {
              if (settled) return;
              active -= 1;
              settlePauseWaiters();
              if (terminalError || transfer.cancelled) {
                finish(terminalError || new Error("Transfer cancelled"));
              } else if (contiguousCheckpoint === fileSize) finish();
              else pump();
            });
        }

        if (fileSize === checkpoint && active === 0) finish();
      };

      transfer.readStream = {
        pause() {
          transfer.paused = true;
        },
        resume() {
          transfer.paused = false;
          pump();
        },
        destroy() {
          abort();
        },
      };
      transfer.waitForPause = () => {
        publishContiguousCheckpoint(true);
        if (active === 0) {
          return Promise.resolve();
        }
        // Soft-drain: resolve after a short grace even if some ranges are still
        // in flight. Contiguous checkpoint never advances past holes; leftover
        // ranges finish under paused=true without scheduling new work.
        if (PAUSE_RANGE_DRAIN_MS <= 0) {
          return Promise.resolve();
        }
        return new Promise((resolvePause) => {
          const entry = {
            resolve: resolvePause,
            timer: null,
          };
          entry.timer = setTimeout(() => {
            entry.timer = null;
            const index = pauseResolvers.indexOf(entry);
            if (index === -1) return;
            pauseResolvers.splice(index, 1);
            publishContiguousCheckpoint(true);
            resolvePause();
          }, PAUSE_RANGE_DRAIN_MS);
          pauseResolvers.push(entry);
        });
      };
      transfer.cancelPauseWait = cancelPauseWait;
      transfer.abort = abort;
      pump();
    });
  } finally {
    transfer.getActiveRangeCount = null;
    if (sftp && onSftpError && typeof sftp.removeListener === "function") {
      try { sftp.removeListener("error", onSftpError); } catch { }
    }
  }
}

/**
 * Pipelined SFTP WRITE upload (same fanout as ssh2 fastPut).
 *
 * @param {{ disposeChannel?: boolean, onBytesCommitted?: (() => void) | null, generatedStagePath?: boolean }} [options]
 *   disposeChannel — when true (isolated channel), end the SFTP subsystem on
 *   cancel/finish. When false (shared browse session), never call sftp.end().
 *   generatedStagePath — when true, cancel may best-effort unlink this path
 *   after a truncating OPEN; in-place finals must leave this false.
 */
async function uploadFileConcurrent(
  localPath,
  remotePath,
  sftp,
  fileSize,
  transfer,
  sendProgress,
  options = {},
) {
  const disposeChannel = options.disposeChannel !== false;
  const generatedStagePath = options.generatedStagePath === true;
  // Mutable: may shrink after path-gate wait if a stale truncating OPEN wiped
  // the stage while we were waiting (Codex P2 on 294b7a4b).
  let checkpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
  let channelError = null;
  const onChannelError = (error) => {
    channelError = channelError || error;
  };
  sftp.on?.("error", onChannelError);
  // Install cancel before OPEN so a stalled remote open can still settle:
  // isolated channels end the subsystem; shared/sudo reject OPEN without end().
  // (runPausableConcurrentRanges would install abort later, after OPEN.)
  const abortChannel = () => {
    if (disposeChannel) {
      try { sftp.end?.(); } catch { /* ignore */ }
    }
  };
  const abortEarly = () => {
    transfer.cancelled = true;
    abortChannel();
  };
  transfer.abort = abortEarly;

  let localHandle = null;
  let initialSource = null;
  let remoteHandle = null;
  let failed = false;
  let noTransferFallback = false;
  try {
    if (transfer.cancelled) throw new Error("Transfer cancelled");
    try {
      localHandle = await fs.promises.open(localPath, "r");
    } catch (error) {
      failed = true;
      noTransferFallback = true;
      const localOpenError = new Error(error?.message || String(error), { cause: error });
      localOpenError.noTransferFallback = true;
      throw localOpenError;
    }
    if (transfer.cancelled) throw new Error("Transfer cancelled");
    if (!transfer.sourceIsOwnedTemp) {
      initialSource = await localHandle.stat();
    }
    if (transfer.cancelled) throw new Error("Transfer cancelled");
    remoteHandle = await openSftpHandleForTransfer(
      sftp,
      remotePath,
      // Getter so afterPathGate can shrink checkpoint and switch r+ → w.
      () => (checkpoint > 0 ? "r+" : "w"),
      transfer,
      {
        disposeChannel,
        abortChannel,
        generatedStagePath,
        afterPathGate: async () => {
          // A late stale OPEN may have zeroed the stage while we waited; force
          // a full rewrite rather than sparse r+ from an obsolete offset.
          // Consume the flag here: a gated restart from zero is the recovery
          // path. Leaving it set makes the post-upload guard fail a successful
          // full rewrite (Codex P2 on 81979ebb).
          if (transfer.staleOpenTruncatedStage) {
            transfer.staleOpenTruncatedStage = false;
            checkpoint = 0;
            transfer.checkpointBytes = 0;
            try {
              sendProgress(0, fileSize, { force: true, checkpointBytes: 0 });
            } catch { /* best-effort */ }
            return;
          }
          // Re-read durable stage size after waiting; a prior OPEN "w" may have
          // truncated the file while we were queued (Codex P2 / P1 on 2178).
          if (checkpoint <= 0 || !transfer.stagedRemote) return;
          try {
            const staged = transfer.stagedRemote;
            let size = null;
            if (isScpModeClient(staged.client)) {
              const st = await getScpBackendForClient(staged.client).stat(staged.path, {
                encoding: staged.encoding,
              });
              size = Number(st?.size);
            } else if (typeof staged.client?.stat === "function") {
              const st = await staged.client.stat(
                encodePathForSession(staged.sftpId, staged.path, staged.encoding),
              );
              size = Number(st?.size);
            }
            if (Number.isFinite(size) && size >= 0 && size < checkpoint) {
              checkpoint = size;
              transfer.checkpointBytes = size;
              try {
                sendProgress(size, fileSize, { force: true, checkpointBytes: size });
              } catch { /* best-effort */ }
            }
          } catch {
            // Missing stage → fall through; OPEN "w" or r+ will fail and retry.
          }
        },
      },
    );
    if (channelError) throw channelError;
    if (transfer.cancelled) throw new Error("Transfer cancelled");

    try {
      await runPausableConcurrentRanges({
        transfer,
        fileSize,
        checkpoint,
        concurrency: UPLOAD_TRANSFER_CONCURRENCY,
        copyRange: async (position, length) => {
          // Size-based resume: read the source range at `position` and WRITE it.
          // No per-chunk content digest (FileZilla / WinSCP style).
          const buffer = Buffer.allocUnsafe(length);
          await readLocalRange(localHandle, buffer, position, length);
          if (transfer.cancelled) throw new Error("Transfer cancelled");
          await writeSftpRange(sftp, remoteHandle, buffer, position, length);
        },
        sendProgress,
        abortChannel,
        sftp,
        forceSettleOnError: disposeChannel,
      });
      if (channelError) throw channelError;
      // Every remote WRITE has completed. In-place destinations are already
      // published at this point, so stop accepting cancellation before source
      // revalidation and handle cleanup; staged uploads pass no callback.
      options.onBytesCommitted?.();
      if (initialSource) {
        const latestSource = await localHandle.stat();
        // Soft size + mtime/ino only — no digest, but not fail-open either.
        assertSourceMetadataUnchanged(initialSource, latestSource, fileSize, {
          ignoreCtime: true,
        });
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  } catch (error) {
    failed = true;
    if (noTransferFallback && error && typeof error === "object") {
      error.noTransferFallback = true;
    }
    throw error;
  } finally {
    // Shared write OPEN may still be in flight after a cancel settle timeout or
    // channel error. Await the drain barrier before returning so
    // runRemoteUploadTransaction cannot clean up the stage before a late
    // truncating OPEN finishes (Codex P2 on 747847e7). openSftpHandleForTransfer
    // force-completes the drain if the OPEN callback never arrives; late cancel
    // truncating opens on generated stages also unlink after close so a
    // force-complete cannot orphan a recreated stage.
    const sharedWriteOpenDrain = transfer.sharedWriteOpenDrain;
    if (sharedWriteOpenDrain) {
      await sharedWriteOpenDrain.catch(() => {});
      if (transfer.sharedWriteOpenDrain === sharedWriteOpenDrain) {
        transfer.sharedWriteOpenDrain = null;
      }
    }
    transfer.readStream = null;
    transfer.waitForPause = null;
    transfer.cancelPauseWait = null;
    transfer.abort = null;
    if (localHandle) {
      await localHandle.close().catch(() => {});
    }
    let remoteCloseError = null;
    // Close remote handles while the channel is still live. On disposeChannel
    // cancel/failure the channel is about to be ended (or already dead); a
    // CLOSE request would hang forever with no callback from ssh2.
    if (remoteHandle) {
      const skipClose = disposeChannel && (failed || transfer.cancelled);
      if (!skipClose) {
        let closeTimeout = null;
        try {
          await Promise.race([
            closeSftpHandle(sftp, remoteHandle),
            new Promise((_, reject) => {
              closeTimeout = setTimeout(() => reject(new Error("SFTP close timed out")), 2000);
            }),
          ]);
        } catch (error) {
          if (!failed && !transfer.cancelled && !/timed out/i.test(error?.message || "")) {
            remoteCloseError = error;
          }
        } finally {
          if (closeTimeout) clearTimeout(closeTimeout);
        }
      }
    }
    if (!failed && !transfer.cancelled && !remoteCloseError && channelError) {
      remoteCloseError = channelError;
    }
    if (disposeChannel) {
      try { sftp.end?.(); } catch { /* ignore */ }
    }
    try { sftp.removeListener?.("error", onChannelError); } catch { /* ignore */ }
    if (remoteCloseError) throw remoteCloseError;
    // After the drain barrier, a late stale OPEN may have zeroed the stage while
    // this attempt already finished writing. Fail closed so promotion cannot
    // rename a corrupt stage (Codex P1 on 2898c4c0).
    if (!failed && !transfer.cancelled && transfer.staleOpenTruncatedStage) {
      throw new Error("Remote stage truncated by stale OPEN");
    }
  }
}

/**
 * Preserve fastGet's high-latency request window without giving up a safe
 * pause checkpoint. Progress and resume offsets track the highest contiguous
 * durable byte; out-of-order range completion cannot advance past a hole.
 * Once pause is requested, no new ranges are scheduled and we wait for every
 * in-flight range before acknowledging it.
 *
 * @param {{ disposeChannel?: boolean }} [options]
 *   disposeChannel — when true (isolated channel), cancel/abort may call
 *   sftp.end(); the caller still returns healthy channels to the download pool.
 *   When false (shared browse / sudo session), never call sftp.end().
 */
async function downloadFileResumableFast(
  remotePath,
  localPath,
  sftp,
  fileSize,
  transfer,
  sendProgress,
  options = {},
) {
  const disposeChannel = options.disposeChannel !== false;
  const checkpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
  let channelError = null;
  const onChannelError = (error) => {
    channelError = channelError || error;
  };
  sftp.on?.("error", onChannelError);
  // Install cancel before OPEN so a stalled remote open can still settle:
  // isolated channels end the subsystem; shared/sudo reject OPEN without end().
  // (runPausableConcurrentRanges would install abort later, after OPEN.)
  const abortChannel = () => {
    if (disposeChannel) {
      try { sftp.end?.(); } catch { /* ignore */ }
    }
  };
  const abortEarly = () => {
    transfer.cancelled = true;
    abortChannel();
  };
  transfer.abort = abortEarly;

  let remoteHandle = null;
  let localHandle = null;
  let failed = false;
  try {
    if (transfer.cancelled) throw new Error("Transfer cancelled");
    remoteHandle = await openSftpHandleForTransfer(
      sftp,
      remotePath,
      "r",
      transfer,
      { disposeChannel, abortChannel },
    );
    if (channelError) throw channelError;
    if (transfer.cancelled) throw new Error("Transfer cancelled");
    localHandle = await fs.promises.open(localPath, checkpoint > 0 ? "r+" : "w+");
    if (transfer.cancelled) throw new Error("Transfer cancelled");

    try {
      await runPausableConcurrentRanges({
        transfer,
        fileSize,
        checkpoint,
        concurrency: DOWNLOAD_TRANSFER_CONCURRENCY,
        copyRange: async (position, length) => {
          const buffer = Buffer.allocUnsafe(length);
          await readSftpRange(sftp, remoteHandle, buffer, position, length);
          await writeLocalRange(localHandle, buffer, position, length);
        },
        sendProgress,
        abortChannel,
        sftp,
        // Always force-settle on cancel/error: downloads have no remote WRITEs
        // to drain. Shared/sudo paths cannot sftp.end() a stuck READ, so without
        // this a hung read callback would hold the transfer and SFTP lease forever.
        forceSettleOnError: true,
      });
      if (channelError) throw channelError;
      await verifyFastDownloadSamples(sftp, remoteHandle, localHandle, fileSize, transfer);
    } catch (error) {
      failed = true;
      throw error;
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    transfer.readStream = null;
    transfer.waitForPause = null;
    transfer.cancelPauseWait = null;
    transfer.abort = null;
    let localCloseError = null;
    if (localHandle) {
      try {
        await localHandle.close();
      } catch (error) {
        localCloseError = error;
      }
    }
    let remoteCloseError = null;
    // Close remote handles while the channel is still live. On disposeChannel
    // cancel/failure the channel is about to be ended (or already dead); a
    // CLOSE request would hang forever with no callback from ssh2.
    if (remoteHandle) {
      const skipClose = disposeChannel && (failed || transfer.cancelled);
      if (!skipClose) {
        if (failed || transfer.cancelled) {
          // Shared cancel/failure already settled the transfer; do not await
          // CLOSE (adds up to 2s on a dead channel). Best-effort close only.
          closeSftpHandle(sftp, remoteHandle).catch(() => {});
        } else {
          // Success path: bound CLOSE so a hung callback cannot block lease
          // release. Tag the watchdog so real server "timed out" CLOSE errors
          // are not swallowed by message matching.
          let closeTimeout = null;
          try {
            await Promise.race([
              closeSftpHandle(sftp, remoteHandle),
              new Promise((_, reject) => {
                closeTimeout = setTimeout(() => {
                  const timeoutError = new Error("SFTP close timed out");
                  timeoutError.sftpCloseTimedOut = true;
                  reject(timeoutError);
                }, 2000);
              }),
            ]);
          } catch (error) {
            if (error?.sftpCloseTimedOut) {
              console.warn(
                "[transferBridge] SFTP CLOSE timed out; abandoning remote handle",
                transfer.transferId || "",
                disposeChannel ? "(isolated — dispose channel)" : "(shared — keep session)",
              );
              // Shared/sudo: timeout is non-fatal (session stays alive).
              // Isolated: mark unhealthy so downloadFile disposes instead of
              // returning a possibly-dead channel to the pool.
              if (disposeChannel) {
                remoteCloseError = error;
              }
            } else {
              remoteCloseError = error;
            }
          } finally {
            if (closeTimeout) clearTimeout(closeTimeout);
          }
        }
      }
    }
    if (!failed && !transfer.cancelled && !remoteCloseError && channelError) {
      remoteCloseError = channelError;
    }
    try { sftp.removeListener?.("error", onChannelError); } catch { }
    if (!failed && !transfer.cancelled && localCloseError) {
      const error = new Error("Could not safely close the downloaded file", { cause: localCloseError });
      error.noTransferFallback = true;
      throw error;
    }
    if (!failed && !transfer.cancelled && remoteCloseError) {
      if (disposeChannel) {
        const error = new Error("The isolated SFTP channel failed while closing", { cause: remoteCloseError });
        error.completedWithUnhealthyChannel = true;
        throw error;
      }
      throw remoteCloseError;
    }
  }
}

/**
 * Download a remote file with pipelined SFTP READs only.
 *
 * Strategy order (mirrors uploadFile / #2449 fail-closed):
 *   1. concurrent ranges (or fastGet) on an isolated channel
 *   2. concurrent ranges on the shared browse channel (sudo + isolated miss)
 *
 * There is intentionally no createReadStream bulk path: serial READ is
 * RTT-bound (1 × 32KB) and was the usual cause of sub-MB/s downloads under
 * sudo (#2719) and isolated miss. When every pipelined strategy fails (or
 * open/read are missing), the transfer fails closed with the last error.
 * Hash helpers may still use createReadStream for content verification only.
 */
async function downloadFile(
  remotePath,
  localPath,
  client,
  fileSize,
  transfer,
  sendProgress,
  encoding = "utf-8",
  runCancelablePreflight = async (operation) => operation(),
) {
  if (isScpModeClient(client)) {
    transfer.pauseSupported = false;
    transfer.pauseUnavailableReason = "Pause is unavailable for SCP transfers";
    const backend = getScpBackendForClient(client);
    return backend.downloadFile(remotePath, localPath, {
      fileSize,
      transfer,
      encoding,
      signal: transfer.signal,
      onProgress: (transferred, total) => sendProgress(transferred, total || fileSize),
    });
  }

  await requireSftpChannel(client);
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");
  transfer.pauseSupported = Boolean(transfer.resumable);
  const initialSource = transfer.resumable
    ? await runCancelablePreflight(() => client.stat(remotePath))
    : null;

  // Planned snapshot already fully staged (including zero-byte snapshots).
  // Do not open a source handle at EOF — an unbounded read would pull any
  // append tail and fail the transferred === fileSize finish check.
  const earlyCheckpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
  if (earlyCheckpoint >= fileSize) {
    transfer.downloadStrategy = transfer.downloadStrategy || "checkpoint-complete";
    logTransferDiag(transfer, "strategy", { strategy: "checkpoint-complete" });
    if (fileSize === 0) {
      await fs.promises.writeFile(localPath, Buffer.alloc(0));
    }
    sendProgress(fileSize, fileSize, { force: true, checkpointBytes: fileSize });
    if (initialSource) {
      // Growth verification may use concurrent prefix ranges (especially sudo,
      // which skips unprivileged SSH digests). Hold the session fast-download
      // slot so those READs do not race another download's fanout.
      let holdSessionSlot = false;
      try {
        await acquireSessionFastDownloadSlot(client, transfer);
        holdSessionSlot = true;
        const latestSource = await runCancelablePreflight(() => client.stat(remotePath));
        await assertDownloadSourceAfterTransfer(initialSource, latestSource, fileSize, {
          localPath,
          client,
          remotePath,
          signal: transfer.signal,
        });
      } finally {
        if (holdSessionSlot) {
          releaseSessionFastDownloadSlot(client);
        }
      }
    }
    return;
  }

  /** @type {Error | null} */
  let lastPipelineError = null;
  const rememberPipelineError = (err) => {
    if (err && typeof err === "object") lastPipelineError = err;
    else lastPipelineError = new Error(String(err || "SFTP download failed"));
  };

  const prepareDownloadFallbackCheckpoint = async () => {
    const checkpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
    try {
      await fs.promises.truncate(localPath, checkpoint);
    } catch (truncateError) {
      if (!(checkpoint === 0 && truncateError?.code === "ENOENT")) {
        throw truncateError;
      }
    }
    sendProgress(checkpoint, fileSize, { force: true, checkpointBytes: checkpoint });
  };

  const finishSuccessfulDownload = async () => {
    if (!initialSource) return;
    const previousPhase = transfer.phase;
    let lastVerificationProgressAt = 0;
    transfer.phase = "verifying";
    transfer.publishCurrentProgress?.();
    try {
      const latestSource = await runCancelablePreflight(() => client.stat(remotePath));
      // Downloads capture a fixed snapshot; remote appends (live logs) are OK
      // only when the full planned prefix still matches the staged file.
      await assertDownloadSourceAfterTransfer(initialSource, latestSource, fileSize, {
        localPath,
        client,
        remotePath,
        signal: transfer.signal,
        onProgress: () => {
          const now = Date.now();
          if (now - lastVerificationProgressAt < 250) return;
          lastVerificationProgressAt = now;
          transfer.publishCurrentProgress?.();
        },
      });
      transfer.publishCurrentProgress?.();
    } finally {
      transfer.phase = previousPhase || "transferring";
      if (!transfer.cancelled && !transfer.signal?.aborted) {
        transfer.publishCurrentProgress?.();
      }
    }
  };

  // One session-wide fast-path slot for isolated + shared READ fanout (#1507).
  // Wait (cancelable) instead of degrading to serial createReadStream (#2719).
  let holdSessionSlot = false;
  try {
    await acquireSessionFastDownloadSlot(client, transfer);
    holdSessionSlot = true;

    // Prefer an isolated SFTP channel so cancellation cannot kill the browse session.
    if (!client.__netcattySudoMode) {
      const fastSftp = await acquireIsolatedDownloadChannel(client, transfer);
      if (transfer.cancelled) {
        if (fastSftp) {
          releaseIsolatedDownloadChannel(client, fastSftp, { dispose: true });
        }
        throw new Error("Transfer cancelled");
      }

      if (fastSftp && (transfer.resumable || typeof fastSftp.fastGet === "function")) {
        try {
          if (transfer.resumable) {
            transfer.downloadStrategy = "concurrent-isolated";
            logTransferDiag(transfer, "strategy", {
              strategy: "concurrent-isolated",
              fields: {
                chunk: formatDiagBytes(TRANSFER_CHUNK_SIZE),
                concurrency: DOWNLOAD_TRANSFER_CONCURRENCY,
              },
            });
            await downloadFileResumableFast(
              remotePath,
              localPath,
              fastSftp,
              fileSize,
              transfer,
              sendProgress,
            );
            await finishSuccessfulDownload();
            releaseIsolatedDownloadChannel(client, fastSftp);
            return;
          }
          transfer.downloadStrategy = "fastGet-isolated";
          logTransferDiag(transfer, "strategy", { strategy: "fastGet-isolated" });
          await new Promise((resolve, reject) => {
            let settled = false;
            let onFastSftpError = null;
            const finish = (err) => {
              if (settled) return;
              settled = true;
              if (transfer.abort === abortFastTransfer) {
                transfer.abort = null;
              }
              if (onFastSftpError) {
                try { fastSftp.removeListener("error", onFastSftpError); } catch { }
                onFastSftpError = null;
              }
              releaseIsolatedDownloadChannel(client, fastSftp, {
                dispose: !!err || transfer.cancelled,
              });

              if (transfer.cancelled) reject(new Error("Transfer cancelled"));
              else if (err) reject(err);
              else resolve();
            };
            const abortFastTransfer = () => {
              if (settled) return;
              transfer.cancelled = true;
              finish(new Error("Transfer cancelled"));
            };
            transfer.abort = abortFastTransfer;
            onFastSftpError = (err) => finish(err);
            fastSftp.once("error", onFastSftpError);

            if (transfer.cancelled) {
              finish(new Error("Transfer cancelled"));
              return;
            }

            fastSftp.fastGet(remotePath, localPath, {
              chunkSize: TRANSFER_CHUNK_SIZE,
              concurrency: DOWNLOAD_TRANSFER_CONCURRENCY,
              step: (transferred, _chunk, total) => {
                if (transfer.cancelled) return;
                sendProgress(transferred, total || fileSize);
              },
            }, finish);
          });
          return;
        } catch (err) {
          // Always release before rethrowing cancel — otherwise the channel stays
          // in pool.busy and the per-session fast-download budget is exhausted.
          releaseIsolatedDownloadChannel(client, fastSftp, { dispose: true });
          if (transfer.cancelled) throw err;
          if (err?.noTransferFallback) throw err;
          if (err?.completedWithUnhealthyChannel) {
            await finishSuccessfulDownload();
            return;
          }
          // Concurrent ranges may leave sparse tails past the contiguous
          // checkpoint; truncate before trying the next pipelined strategy.
          rememberPipelineError(err);
          await prepareDownloadFallbackCheckpoint();
          console.warn(
            "[transferBridge] isolated download failed, trying next pipelined strategy:",
            err?.message || String(err),
          );
        }
      } else if (fastSftp) {
        // Acquired a channel but cannot use fast path — return it to the pool.
        releaseIsolatedDownloadChannel(client, fastSftp);
      }
    }

    // Pipelined READs on the shared browse session — covers sudo (no isolated
    // channel) and non-sudo isolated miss/failure. Same session slot already held.
    if (typeof sftp.open === "function" && typeof sftp.read === "function") {
      try {
        transfer.downloadStrategy = "concurrent-shared";
        logTransferDiag(transfer, "strategy", {
          strategy: "concurrent-shared",
          fields: {
            chunk: formatDiagBytes(TRANSFER_CHUNK_SIZE),
            concurrency: DOWNLOAD_TRANSFER_CONCURRENCY,
          },
        });
        transfer.pauseSupported = Boolean(transfer.resumable);
        if (transfer.resumable) transfer.pauseUnavailableReason = undefined;
        await downloadFileResumableFast(
          remotePath,
          localPath,
          sftp,
          fileSize,
          transfer,
          sendProgress,
          { disposeChannel: false },
        );
        await finishSuccessfulDownload();
        return;
      } catch (err) {
        if (transfer.cancelled) throw err;
        if (err?.noTransferFallback) throw err;
        rememberPipelineError(err);
        await prepareDownloadFallbackCheckpoint();
        console.warn(
          "[transferBridge] concurrent shared download failed (no serial stream fallback):",
          err?.message || String(err),
        );
      }
    } else if (!lastPipelineError) {
      lastPipelineError = new Error(
        "SFTP session does not support pipelined READ (open/read missing)",
      );
    }
  } finally {
    if (holdSessionSlot) {
      releaseSessionFastDownloadSlot(client);
    }
  }

  // Fail closed — no serial createReadStream bulk path (kept out of the tree
  // intentionally so future edits cannot reintroduce a silent crawl).
  transfer.downloadStrategy = "failed";
  logTransferDiag(transfer, "strategy", { strategy: "failed" });
  const cause = lastPipelineError;
  const message = cause?.message
    ? `SFTP pipelined download failed: ${cause.message}`
    : "SFTP pipelined download failed (no serial stream fallback)";
  const error = new Error(message, cause ? { cause } : undefined);
  if (cause?.code !== undefined) error.code = cause.code;
  if (cause?.noTransferFallback) error.noTransferFallback = true;
  throw error;
}

async function downloadFileWithTempRootRecovery({
  transfer,
  transferId,
  fileName,
  localPath,
  run,
}) {
  const initialGeneration = tempDirBridge.getTempDirRebindGeneration();
  try {
    const result = await run(localPath);
    tempDirBridge.getTempDir();
    if (tempDirBridge.getTempDirRebindGeneration() === initialGeneration) {
      return { localPath, result };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    tempDirBridge.getTempDir();
    if (tempDirBridge.getTempDirRebindGeneration() === initialGeneration) throw error;
  }
  const recoveredPath = tempDirBridge.getTransferTempFilePath(transferId, fileName);
  transfer.checkpointBytes = 0;
  transfer.downloadCheckpointBytes = 0;
  transfer.stagedLocalPath = recoveredPath;
  const recoveryGeneration = tempDirBridge.getTempDirRebindGeneration();
  const result = await run(recoveredPath);
  tempDirBridge.getTempDir();
  if (tempDirBridge.getTempDirRebindGeneration() !== recoveryGeneration) {
    throw new Error("Temporary directory was replaced during SFTP download recovery.");
  }
  return { localPath: recoveredPath, result };
}

/**
 * Start a file transfer
 */
async function startTransferNow(event, payload, onProgress) {
  const {
    transferId,
    sourcePath,
    targetPath,
    sourceType,
    targetType,
    sourceSftpId,
    targetSftpId,
    totalBytes,
    sourceEncoding,
    targetEncoding,
    sameHost,
  } = payload;
  const sender = event.sender;

  // Cancel may have won the race during open/reconnect before we register.
  if (takePendingCancel(transferId)) {
    sender.send?.("netcatty:transfer:cancelled", { transferId });
    broadcastGlobalTransferEvent({ type: "cancelled", transferId, endedAt: Date.now() });
    return { transferId, error: "Transfer cancelled", cancelled: true };
  }

  const startedEvent = buildTransferLifecycleEvent("started", payload);
  sender.send?.("netcatty:transfer:started", startedEvent);
  broadcastGlobalTransferEvent(startedEvent);

  const transfer = {
    transferId,
    cancelled: false,
    paused: false,
    lifecycleEpoch: Math.max(0, Number(payload.lifecycleEpoch) || 0),
    lifecycleState: "transferring",
    phase: "transferring",
    pauseSupported: false,
    pauseUnavailableReason: "This transfer cannot be paused safely",
    resumable: payload.resumable === true,
    checkpointBytes: Math.max(0, Number(payload.checkpointBytes) || 0),
    resumeStage: payload.resumeStage || 'direct',
    downloadCheckpointBytes: Math.max(0, Number(payload.downloadCheckpointBytes) || 0),
    uploadCheckpointBytes: Math.max(0, Number(payload.uploadCheckpointBytes) || 0),
    sourceFingerprint: payload.sourceFingerprint,
    sourceFingerprintPromise: null,
    sourceType,
    targetType,
    sourcePath,
    targetPath,
    sourceSftpId,
    targetSftpId,
    // Host IDs must ride on the transfer object so path-gate keys stay host-
    // scoped when a dedicated-resume opens a new sftpId (Codex P1 on d44886e6).
    sourceHostId: payload.sourceHostId,
    targetHostId: payload.targetHostId,
    hostId: payload.hostId || payload.targetHostId || payload.sourceHostId,
    parentTaskId: payload.parentTaskId,
    directoryEntryIndex: payload.directoryEntryIndex,
    directoryEntryIdentity: payload.directoryEntryIdentity,
    sourceEncoding,
    targetEncoding,
    readStream: null,
    writeStream: null,
    // True after unpipe (or when open skipped pipe while paused). Guards
    // resumeStreamPair against duplicate pipe() which doubles writes.
    streamsUnpiped: false,
    abort: null,
    sourceDigestPath: null,
    sourceIsOwnedTemp: payload.sourceIsOwnedTemp === true,
    signal: null,
    // Throughput diagnostics (see logTransferDiag).
    diagStartedAt: Date.now(),
    diagLastLogAt: 0,
    diagLastTransferred: Math.max(0, Number(payload.checkpointBytes) || 0),
    diagLastWindowBps: 0,
    diagTotalBytes: Math.max(0, Number(totalBytes) || 0),
    diagDirection: sourceType === "local" && targetType === "sftp"
      ? "upload"
      : sourceType === "sftp" && targetType === "local"
        ? "download"
        : sourceType === "sftp" && targetType === "sftp"
          ? "remote-to-remote"
          : `${sourceType}->${targetType}`,
    diagFileName: basenameForDiag(sourcePath) || basenameForDiag(targetPath) || transferId,
  };
  logTransferDiag(transfer, "start", {
    total: transfer.diagTotalBytes,
    transferred: transfer.checkpointBytes,
    fields: {
      sourceType,
      targetType,
      resumeStage: transfer.resumeStage,
      checkpoint: formatDiagBytes(transfer.checkpointBytes),
    },
  });
  // Own an AbortController so cancelTransfer always stops cancelable preflight
  // work (destination hashing, probes) even when callers pass no abortSignal.
  const ownedAbort = new AbortController();
  if (payload.abortSignal) {
    if (payload.abortSignal.aborted) {
      ownedAbort.abort(payload.abortSignal.reason);
    } else {
      payload.abortSignal.addEventListener(
        "abort",
        () => {
          try { ownedAbort.abort(payload.abortSignal.reason); } catch { /* ignore */ }
        },
        { once: true },
      );
    }
  }
  transfer.signal = ownedAbort.signal;
  transfer.abortOwnedSignal = () => {
    try { ownedAbort.abort(); } catch { /* ignore */ }
  };
  // Hold panel/agent SFTP sessions for the full transfer lifetime (including
  // pause). Panel close becomes a soft-close until we release these leases.
  const leasedSftpIds = acquireTransferSessionLeases(transferId, payload);
  transfer.leasedSftpIds = leasedSftpIds;
  // Publish only after every requested session lease was acquired. A closing
  // endpoint rejects synchronously and must not leave a ghost active transfer.
  activeTransfers.set(transferId, transfer);
  const transferCreatedAt = Date.now();

  const runCancelablePreflight = (operation) => runTransferCancelablePreflight(transfer, operation);

  // ── Progress/speed tracking ──────────────────────────────────────────────
  // Keep progress monotonic and compute speed from a strict sliding window.
  const speedSamples = [{ time: transferCreatedAt, bytes: transfer.checkpointBytes }]; // [{ time, bytes }]
  let lastObservedTransferred = transfer.checkpointBytes;
  let lastObservedTotal = Math.max(0, totalBytes || 0);
  let lastProgressSentTime = 0;
  let lastProgressSentBytes = -1;

  const computeWindowSpeed = (now, transferred) => {
    const targetTime = now - SPEED_WINDOW_MS;

    // Keep exactly one sample before targetTime for boundary interpolation.
    while (speedSamples.length >= 2 && speedSamples[1].time <= targetTime) {
      speedSamples.shift();
    }

    const first = speedSamples[0];
    if (!first) return 0;

    let boundaryTime = first.time;
    let boundaryBytes = first.bytes;

    if (speedSamples.length >= 2 && targetTime > first.time) {
      const next = speedSamples[1];
      const range = next.time - first.time;
      if (range > 0) {
        const ratio = (targetTime - first.time) / range;
        boundaryBytes = first.bytes + (next.bytes - first.bytes) * ratio;
        boundaryTime = targetTime;
      }
    }

    const elapsedMs = now - boundaryTime;
    if (elapsedMs < SPEED_MIN_ELAPSED_MS) return 0;

    const deltaBytes = transferred - boundaryBytes;
    if (deltaBytes <= 0) return 0;

    const speed = (deltaBytes * 1000) / elapsedMs;
    return Number.isFinite(speed) && speed > 0 ? Math.round(speed) : 0;
  };

  const emitProgress = (now, transferred, total, speed, force = false) => {
    const isComplete = total > 0 && transferred >= total;
    const transferredChanged = transferred !== lastProgressSentBytes;
    const timeSinceLast = now - lastProgressSentTime;

    if (
      force
      || isComplete
      || (transferredChanged && timeSinceLast >= PROGRESS_THROTTLE_MS)
    ) {
      lastProgressSentTime = now;
      lastProgressSentBytes = transferred;
      transfer.diagLastTransferred = transferred;
      transfer.diagLastWindowBps = speed;
      if (total > 0) transfer.diagTotalBytes = total;
      // Periodic wall-clock vs window speed (not every IPC tick).
      if (
        TRANSFER_DIAG_ENABLED
        && (
          force
          || isComplete
          || !transfer.diagLastLogAt
          || (now - transfer.diagLastLogAt) >= TRANSFER_DIAG_INTERVAL_MS
        )
      ) {
        transfer.diagLastLogAt = now;
        logTransferDiag(transfer, isComplete ? "complete-progress" : "progress", {
          transferred,
          total,
          windowBps: speed,
        });
      }
      const progressPayload = {
        transferId,
        parentTaskId: transfer.parentTaskId,
        directoryEntryIndex: transfer.directoryEntryIndex,
        directoryEntryIdentity: transfer.directoryEntryIdentity,
        transferred,
        speed,
        totalBytes: total,
        checkpointBytes: transfer.checkpointBytes,
        resumeStage: transfer.resumeStage,
        downloadCheckpointBytes: transfer.downloadCheckpointBytes,
        uploadCheckpointBytes: transfer.uploadCheckpointBytes,
        sourceFingerprint: transfer.sourceFingerprint,
        lifecycleEpoch: transfer.lifecycleEpoch,
        lifecycleState: transfer.lifecycleState,
        phase: transfer.phase,
        resumable: transfer.resumable && transfer.pauseSupported,
        // Only surface a reason when pause is actually unavailable; never keep
        // the startup default once pauseSupported is true.
        pauseUnavailableReason: transfer.pauseSupported
          ? undefined
          : transfer.pauseUnavailableReason,
      };
      sender.send("netcatty:transfer:progress", progressPayload);
      broadcastGlobalTransferEvent({
        type: "progress",
        transferId,
        transferred,
        totalBytes: total,
        speed,
        checkpointBytes: transfer.checkpointBytes,
        resumeStage: transfer.resumeStage,
        downloadCheckpointBytes: transfer.downloadCheckpointBytes,
        uploadCheckpointBytes: transfer.uploadCheckpointBytes,
        sourceFingerprint: transfer.sourceFingerprint,
        lifecycleEpoch: transfer.lifecycleEpoch,
        lifecycleState: transfer.lifecycleState,
        phase: transfer.phase,
        resumable: progressPayload.resumable,
        pauseUnavailableReason: progressPayload.pauseUnavailableReason,
        parentTaskId: transfer.parentTaskId,
        directoryEntryIndex: transfer.directoryEntryIndex,
        directoryEntryIdentity: transfer.directoryEntryIdentity,
        sourceHostId: transfer.sourceHostId || payload?.sourceHostId,
        targetHostId: transfer.targetHostId || payload?.targetHostId,
      });
    }
  };

  let leasesReleased = false;
  const cleanupTransfer = (options = {}) => {
    // A stale completion must never unregister a newer transfer that reused the
    // same id after this one became terminal.
    if (activeTransfers.get(transferId) === transfer) {
      activeTransfers.delete(transferId);
    }
    // Superseded attempts share the lease Set entry with a same-id retry —
    // releasing here would drop the only lease and hard-close SFTP under the
    // live retry (Codex P2 on 5f3e3e2a).
    if (options.releaseLeases === false) return;
    if (!leasesReleased) {
      leasesReleased = true;
      releaseTransferSessionLeases(transferId, transfer.leasedSftpIds || leasedSftpIds);
      transfer.leasedSftpIds = [];
    }
  };

  const sendProgress = (transferred, total, options = {}) => {
    if (transfer.cancelled) return;

    const now = Date.now();
    const force = options.force === true;

    let normalizedTotal = Number.isFinite(total) && total > 0 ? total : 0;
    if (normalizedTotal === 0) {
      normalizedTotal = lastObservedTotal || 0;
    }
    normalizedTotal = Math.max(normalizedTotal, lastObservedTotal, 0);

    let normalizedTransferred = Number.isFinite(transferred) && transferred > 0 ? transferred : 0;
    // Explicit force (resume clamp / restart) may lower the durable offset.
    if (!force) {
      if (normalizedTotal > 0) {
        normalizedTransferred = Math.min(normalizedTransferred, normalizedTotal);
      }
      normalizedTransferred = Math.max(normalizedTransferred, lastObservedTransferred);
    } else if (normalizedTotal > 0) {
      normalizedTransferred = Math.min(normalizedTransferred, normalizedTotal);
    }

    lastObservedTransferred = normalizedTransferred;
    lastObservedTotal = normalizedTotal;
    const requestedCheckpoint = Number(options.checkpointBytes);
    transfer.checkpointBytes = Number.isFinite(requestedCheckpoint) && requestedCheckpoint >= 0
      ? Math.min(requestedCheckpoint, normalizedTotal || requestedCheckpoint)
      : normalizedTransferred;

    const lastSample = speedSamples[speedSamples.length - 1];
    if (!lastSample || lastSample.bytes !== normalizedTransferred || now - lastSample.time >= PROGRESS_THROTTLE_MS) {
      speedSamples.push({ time: now, bytes: normalizedTransferred });
    }

    const speed = computeWindowSpeed(now, normalizedTransferred);

    if (onProgress) {
      onProgress(normalizedTransferred, normalizedTotal, speed);
    }

    emitProgress(now, normalizedTransferred, normalizedTotal, speed, force);
  };

  transfer.publishCurrentProgress = () => sendProgress(
    lastObservedTransferred,
    lastObservedTotal,
    { force: true, checkpointBytes: transfer.checkpointBytes },
  );

  const computeVisibleSourceFingerprint = async () => {
    const previousPhase = transfer.phase;
    const startedAt = Date.now();
    let lastReportedAt = startedAt;
    let lastReportedBytes = 0;
    transfer.phase = "verifying";
    transfer.publishCurrentProgress?.();
    try {
      // Remote downloads transfer a fixed snapshot (including empty). Fingerprint
      // only that prefix so append-only growth does not break pause/resume identity.
      const plannedRemoteBytes = sourceType === "sftp"
        ? Math.max(
          0,
          Number.isFinite(transfer.totalBytes) ? Number(transfer.totalBytes) : 0,
          Number.isFinite(lastObservedTotal) ? Number(lastObservedTotal) : 0,
        )
        : null;
      return await runTransferAbortableOperation(transfer, (signal) => computeSourceFingerprint(
        {
          sourceType,
          sourcePath,
          sourceSftpId,
          sourceEncoding,
          ...(plannedRemoteBytes !== null ? { prefixBytes: plannedRemoteBytes } : {}),
        },
        {
          signal,
          onProgress(bytes) {
            const now = Date.now();
            const elapsed = now - lastReportedAt;
            const delta = bytes - lastReportedBytes;
            // Time-primary: do not let large hash chunks force UI floods.
            if (elapsed < PROGRESS_THROTTLE_MS) return;
            const speed = elapsed > 0 && delta > 0 ? Math.round((delta * 1000) / elapsed) : 0;
            lastReportedAt = now;
            lastReportedBytes = bytes;
            emitProgress(now, lastObservedTransferred, lastObservedTotal, speed, true);
            onProgress?.(lastObservedTransferred, lastObservedTotal, speed);
          },
        },
      ));
    } finally {
      transfer.phase = previousPhase || "transferring";
      if (!transfer.cancelled && !transfer.signal?.aborted) transfer.publishCurrentProgress?.();
    }
  };

  transfer.verifySourceFingerprint = async (storedFingerprint) => {
    const currentFingerprint = await computeVisibleSourceFingerprint();
    if (sourceFingerprintsMatch(storedFingerprint, currentFingerprint)) return;
    // Older builds stored full-file digests as bare `sha256:<hex>` even after the
    // remote had already grown past the planned snapshot. Prefer the planned
    // prefix above; fall back to a full-file check so those tasks still resume
    // when the entire remote content still matches the saved digest.
    if (sourceType === "sftp" && isLegacyFullSourceFingerprint(storedFingerprint)) {
      const fullFingerprint = await runTransferAbortableOperation(transfer, (signal) => (
        computeSourceFingerprint(
          {
            sourceType,
            sourcePath,
            sourceSftpId,
            sourceEncoding,
          },
          { signal },
        )
      ));
      if (sourceFingerprintsMatch(storedFingerprint, fullFingerprint)) return;
    }
    throw new Error("Resume safety check failed: the source file has changed");
  };

  /**
   * Soft-resume stays on the live stream handle. Avoid full-file SHA-256 (multi-GB
   * freeze). Detect same-size in-place rewrites with size + mtime + a short
   * head sample; hard reconnect after restart still uses full fingerprint in
   * startTransferNow.
   */
  const SOFT_RESUME_SAMPLE_BYTES = 256 * 1024;
  const readSourceSoftIdentity = async () => {
    if (sourceType === "local") {
      const st = await fs.promises.stat(sourcePath);
      const sampleBytes = Math.min(SOFT_RESUME_SAMPLE_BYTES, Math.max(0, st.size));
      const sample = sampleBytes > 0
        ? await hashLocalPrefix(sourcePath, sampleBytes, { signal: transfer.signal })
        : null;
      return {
        size: st.size,
        mtimeMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : undefined,
        sample: sample ? `sha256:${sample}` : null,
      };
    }
    if (sourceType === "sftp") {
      const client = sftpClients.get(sourceSftpId);
      if (!client) throw new Error("Source SFTP session not found");
      let size = 0;
      let mtimeMs;
      if (isScpModeClient(client)) {
        const st = await getScpBackendForClient(client).stat(sourcePath, {
          encoding: resolveEncodingForRequest(sourceSftpId, sourceEncoding),
          signal: transfer.signal,
        });
        size = st.size;
        mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs
          : (Number.isFinite(st.mtime) ? st.mtime * 1000 : undefined);
      } else {
        // Race channel reopen against cancel (Codex P2): a dead sftp handle can
        // sit in requireSftpChannel for ~10s; cancel must not wait that out.
        await requireSftpChannel(client, { signal: transfer.signal });
        const encoded = encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
        const st = await client.stat(encoded);
        size = st.size;
        // ssh2 attrs: mtime is seconds.
        mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs
          : (Number.isFinite(st.mtime) ? st.mtime * 1000 : undefined);
      }
      // Skip remote head samples here: open-ended SFTP reads hang on incomplete
      // mocks and slow links. Size + mtime covers same-size rewrites that bump
      // mtime; full SHA-256 still runs on hard reconnect.
      return { size, mtimeMs, sample: null };
    }
    return {
      size: Math.max(0, Number(transfer.totalBytes) || Number(lastObservedTotal) || 0),
      mtimeMs: undefined,
      sample: null,
    };
  };

  transfer.captureSourceSoftIdentity = async () => {
    try {
      transfer.sourceSoftIdentity = await readSourceSoftIdentity();
    } catch (error) {
      // Propagate cancel/abort so preflight racing can settle; other failures
      // stay best-effort (soft resume simply lacks a baseline).
      if (
        transfer.cancelled
        || transfer.signal?.aborted
        || /cancel|abort/i.test(String(error?.message || error))
      ) {
        throw error;
      }
    }
  };

  transfer.quickVerifySourceForSoftResume = async () => {
    const expectedSize = Math.max(
      0,
      Number(transfer.sourceSoftIdentity?.size) || 0,
      Number(transfer.totalBytes) || 0,
      Number(lastObservedTotal) || 0,
    );
    const current = await readSourceSoftIdentity();
    // Remote sources may grow append-only (live logs). Local upload sources must
    // stay exact — growth means the remaining payload changed.
    const allowSourceGrowth = sourceType === "sftp";
    if (expectedSize > 0) {
      if (current.size < expectedSize) {
        throw new Error("Resume safety check failed: the source file has changed");
      }
      if (current.size > expectedSize && !allowSourceGrowth) {
        throw new Error("Resume safety check failed: the source file has changed");
      }
    }
    // Append growth always bumps mtime; only enforce mtime when size is stable.
    if (!(allowSourceGrowth && expectedSize > 0 && current.size > expectedSize)) {
      const expectedMtime = transfer.sourceSoftIdentity?.mtimeMs;
      if (
        Number.isFinite(expectedMtime)
        && Number.isFinite(current.mtimeMs)
        && current.mtimeMs !== expectedMtime
      ) {
        throw new Error("Resume safety check failed: the source file has changed");
      }
    }
    const expectedSample = transfer.sourceSoftIdentity?.sample;
    if (expectedSample && current.sample && current.sample !== expectedSample) {
      throw new Error("Resume safety check failed: the source file has changed");
    }
    // Refresh baseline for a later pause/resume cycle in this same stream.
    // Keep the original snapshot size so later growth still compares to the
    // transfer plan, not the expanded remote size.
    transfer.sourceSoftIdentity = {
      ...current,
      size: expectedSize > 0 ? expectedSize : current.size,
    };
  };

  transfer.captureSourceFingerprint = () => {
    if (transfer.sourceFingerprint) return Promise.resolve(transfer.sourceFingerprint);
    if (transfer.sourceFingerprintPromise) return transfer.sourceFingerprintPromise;
    const captureId = transferId;
    const fingerprintPromise = computeVisibleSourceFingerprint().then((fingerprint) => {
      const live = activeTransfers.get(captureId);
      if (!fingerprint || !live || live !== transfer || live.cancelled) return fingerprint;
      live.sourceFingerprint = fingerprint;
      try { live.publishCurrentProgress?.(); } catch { /* best-effort */ }
      if (live.paused) {
        broadcastGlobalTransferEvent({
          type: "paused",
          transferId: captureId,
          checkpointBytes: live.checkpointBytes || 0,
          resumeStage: live.resumeStage,
          downloadCheckpointBytes: live.downloadCheckpointBytes || 0,
          uploadCheckpointBytes: live.uploadCheckpointBytes || 0,
          sourceFingerprint: fingerprint,
          lifecycleEpoch: live.lifecycleEpoch,
          lifecycleState: "paused",
        });
      }
      return fingerprint;
    });
    const trackedPromise = fingerprintPromise.catch((error) => {
      if (transfer.sourceFingerprintPromise === trackedPromise) {
        transfer.sourceFingerprintPromise = null;
      }
      throw error;
    });
    transfer.sourceFingerprintPromise = trackedPromise;
    return transfer.sourceFingerprintPromise;
  };

  const verifyResumeContent = async (bytes, createSourceHash, createStagedHash) => {
    if (!bytes) return;
    const previousPhase = transfer.phase;
    const verificationStartedAt = Date.now();
    let sourceBytes = 0;
    let stagedBytes = 0;
    let lastReportedAt = verificationStartedAt;
    let lastReportedBytes = 0;

    const publishVerificationProgress = (force = false) => {
      if (transfer.cancelled || transfer.signal?.aborted) return;
      const now = Date.now();
      const verifiedBytes = sourceBytes + stagedBytes;
      const elapsedSinceReport = now - lastReportedAt;
      const bytesSinceReport = verifiedBytes - lastReportedBytes;
      if (!force && elapsedSinceReport < PROGRESS_THROTTLE_MS) {
        return;
      }
      const speed = elapsedSinceReport > 0 && bytesSinceReport > 0
        ? Math.round((bytesSinceReport * 1000) / elapsedSinceReport)
        : 0;
      lastReportedAt = now;
      lastReportedBytes = verifiedBytes;
      emitProgress(now, lastObservedTransferred, lastObservedTotal, speed, true);
      onProgress?.(lastObservedTransferred, lastObservedTotal, speed);
    };

    transfer.phase = "verifying";
    publishVerificationProgress(true);
    try {
      await runTransferAbortableOperation(transfer, (signal) => assertMatchingResumeContent(
        createSourceHash({
          signal,
          onProgress(value) {
            sourceBytes = value;
            publishVerificationProgress();
          },
        }),
        createStagedHash({
          signal,
          onProgress(value) {
            stagedBytes = value;
            publishVerificationProgress();
          },
        }),
      ));
      publishVerificationProgress(true);
    } finally {
      transfer.phase = previousPhase || "transferring";
      if (!transfer.cancelled && !transfer.signal?.aborted) {
        emitProgress(Date.now(), lastObservedTransferred, lastObservedTotal, 0, true);
        onProgress?.(lastObservedTransferred, lastObservedTotal, 0);
      }
    }
  };

  const sendComplete = () => {
    sender.send("netcatty:transfer:complete", { transferId });
    broadcastGlobalTransferEvent({
      type: "completed",
      transferId,
      endedAt: Date.now(),
      transferred: lastObservedTransferred,
      totalBytes: lastObservedTotal,
      parentTaskId: transfer.parentTaskId,
      directoryEntryIndex: transfer.directoryEntryIndex,
      directoryEntryIdentity: transfer.directoryEntryIdentity,
    });
    cleanupTransfer();
  };

  const sendError = (error) => {
    const message = error?.message || String(error);
    const superseded = /superseded/i.test(message);
    // Superseded always means this attempt lost ownership. Suppress terminal
    // events even after the retry has finished and left activeTransfers, or
    // the completed retry is rewritten as cancelled (Codex P2 on 52f0248c).
    // Release only leases the live same-id retry did not also acquire (Codex P2).
    if (superseded) {
      const liveOwner = activeTransfers.get(transferId);
      const liveLeaseIds = new Set(
        Array.isArray(liveOwner?.leasedSftpIds) ? liveOwner.leasedSftpIds : [],
      );
      const oldLeaseIds = (transfer.leasedSftpIds || leasedSftpIds || []).filter(
        (id) => id != null && !liveLeaseIds.has(id),
      );
      if (oldLeaseIds.length > 0) {
        releaseTransferSessionLeases(transferId, oldLeaseIds);
      }
      cleanupTransfer({ releaseLeases: false });
      return;
    }
    cleanupTransfer();
    const cancelled = /cancel/i.test(message);
    if (cancelled) {
      sender.send("netcatty:transfer:cancelled", { transferId, error: message });
      broadcastGlobalTransferEvent({
        type: "cancelled",
        transferId,
        endedAt: Date.now(),
        error: message,
        parentTaskId: transfer.parentTaskId,
        directoryEntryIndex: transfer.directoryEntryIndex,
        directoryEntryIdentity: transfer.directoryEntryIdentity,
      });
      return;
    }
    sender.send("netcatty:transfer:error", { transferId, error: message });
    broadcastGlobalTransferEvent({
      type: "failed",
      transferId,
      endedAt: Date.now(),
      error: message,
      parentTaskId: transfer.parentTaskId,
      directoryEntryIndex: transfer.directoryEntryIndex,
      directoryEntryIdentity: transfer.directoryEntryIdentity,
    });
  };

  try {
    // Explicit 0 is a valid empty-snapshot plan (e.g. download of an empty log
    // that may grow later). Do not treat it as "size unknown" and re-stat into
    // a grown remote size.
    const hasExplicitTotal = Number.isFinite(totalBytes) && totalBytes >= 0;
    let fileSize = hasExplicitTotal ? Math.max(0, Number(totalBytes)) : 0;

    if (!hasExplicitTotal) {
      if (sourceType === 'local') {
        const stat = await fs.promises.stat(sourcePath);
        fileSize = stat.size;
      } else if (sourceType === 'sftp') {
        const client = sftpClients.get(sourceSftpId);
        if (!client) throw new Error("Source SFTP session not found");
        if (isScpModeClient(client)) {
          const st = await getScpBackendForClient(client).stat(sourcePath, {
            encoding: resolveEncodingForRequest(sourceSftpId, sourceEncoding),
            signal: transfer.signal,
          });
          fileSize = st.size;
        } else {
          const stat = await runCancelablePreflight(async () => {
            await requireSftpChannel(client);
            const encodedSourcePath = encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
            return client.stat(encodedSourcePath);
          });
          fileSize = stat.size;
        }
      }
    }
    // Keep the planned snapshot size on the transfer so pause-time fingerprints
    // and soft resume compare against the original plan, not a grown remote.
    transfer.totalBytes = fileSize;

    // Baseline for soft resume and destination mtime preserve (size + mtime +
    // head sample). Capture before bytes move so non-resumable / SCP paths stamp
    // the pre-transfer identity (Codex P1). Full SHA-256 remains for hard
    // reconnect / crash recovery. Run through cancelable preflight so a hung
    // SFTP reopen cannot outlive cancel (Codex P2).
    if (typeof transfer.captureSourceSoftIdentity === "function") {
      await runCancelablePreflight(() => transfer.captureSourceSoftIdentity());
    }

    const sourceClient = sourceType === "sftp" ? sftpClients.get(sourceSftpId) : null;
    const targetClient = targetType === "sftp" ? sftpClients.get(targetSftpId) : null;
    if ((sourceClient && isScpModeClient(sourceClient)) || (targetClient && isScpModeClient(targetClient))) {
      transfer.resumable = false;
      transfer.pauseSupported = false;
      transfer.pauseUnavailableReason = "Pause is unavailable for SCP transfers; cancel and retry from the beginning instead";
    } else {
      transfer.pauseSupported = Boolean(transfer.resumable);
      // Clear the default "cannot be paused safely" once we know pause works.
      if (transfer.pauseSupported) {
        transfer.pauseUnavailableReason = undefined;
      }
    }

    const hasSavedCheckpoint = transfer.checkpointBytes > 0
      || transfer.downloadCheckpointBytes > 0
      || transfer.uploadCheckpointBytes > 0;
    if (
      transfer.resumable
      && hasSavedCheckpoint
      && (
        !transfer.sourceFingerprint
        || String(transfer.sourceFingerprint).startsWith("meta:")
      )
    ) {
      // Older builds persisted only size/mtime/sparse samples. They cannot prove
      // that the untransferred suffix still belongs to the same source. Restart
      // safely from zero; new pauses persist a full SHA-256 identity.
      transfer.checkpointBytes = 0;
      transfer.downloadCheckpointBytes = 0;
      transfer.uploadCheckpointBytes = 0;
      transfer.sourceFingerprint = undefined;
    }

    if (transfer.resumable && transfer.sourceFingerprint) {
      await transfer.verifySourceFingerprint(transfer.sourceFingerprint);
    }

    sendProgress(transfer.checkpointBytes, fileSize, { force: true });

    if (sourceType === 'local' && targetType === 'sftp') {
      const client = sftpClients.get(targetSftpId);
      if (!client) throw new Error("Target SFTP session not found");

      const dir = path.dirname(targetPath).replace(/\\/g, '/');
      try {
        await runTransferAbortableOperation(transfer, (signal) => ensureRemoteDirForSession(
          targetSftpId,
          dir,
          targetEncoding,
          { signal },
        ));
      } catch (error) {
        if (transfer.cancelled || transfer.signal?.aborted) throw new Error("Transfer cancelled");
      }

      const resolvedTargetEncoding = resolveEncodingForRequest(targetSftpId, targetEncoding);
      let existingRemoteMode = null;
      const deterministicStagePath = buildRemoteTransferStagePath(targetPath, transferId);
      await runRemoteUploadTransaction(client, sourcePath, targetPath, {
        encoding: resolvedTargetEncoding,
        expectedSize: fileSize,
        stagedPath: transfer.resumable ? deterministicStagePath : undefined,
        allowInPlaceFallback: !transfer.resumable,
        preserveStageOnUploadError: transfer.resumable,
        signal: transfer.signal,
        assertCanPromote() {
          if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
          // Late force-completed OPEN "w" from a prior same-id attempt can
          // truncate the stage after concurrent write finished; do not rename
          // a zeroed/corrupt stage to the final path (Codex P1 on 2898c4c0).
          if (transfer.staleOpenTruncatedStage) {
            throw new Error("Remote stage truncated by stale OPEN");
          }
        },
        commitPromotion() {
          transfer.completionCommitted = true;
        },
        runCancelablePreflight,
        async uploadFile(encodedUploadPath, uploadTarget) {
          const uploadTargetPath = uploadTarget.logicalPath;
          const usesStage = uploadTarget.generatedStagePath === true;
          existingRemoteMode = existingModeFromUploadPlan(uploadTarget.plan);
          transfer.stagedRemote = usesStage
            ? { client, sftpId: targetSftpId, path: uploadTargetPath, encoding: targetEncoding }
            : null;
          transfer.checkpointBytes = usesStage && transfer.resumable
            ? await runCancelablePreflight(() => resolveRemoteResumeCheckpoint(
                  client,
                  targetSftpId,
                  uploadTargetPath,
                  targetEncoding,
                  transfer.checkpointBytes,
                ))
            : 0;
          sendProgress(transfer.checkpointBytes, fileSize, { force: true });
          // Resume is size-based only (WinSCP/FileZilla): the durable .part size
          // is the checkpoint. Do not re-hash [0, checkpoint) on both ends —
          // that blocked large-file resume for seconds-to-minutes with no bytes
          // moving.
          await uploadFile(
            sourcePath,
            encodedUploadPath,
            client,
            fileSize,
            transfer,
            sendProgress,
            resolvedTargetEncoding,
            usesStage ? null : () => { transfer.completionCommitted = true; },
            {
              generatedStagePath: usesStage,
              existingMode: existingRemoteMode,
              sftpId: targetSftpId,
              finalRemotePath: targetPath,
            },
          );
        },
      });
      transfer.stagedRemote = null;
      await restoreRemoteUploadModeBestEffort(
        client,
        targetSftpId,
        targetPath,
        resolvedTargetEncoding,
        existingRemoteMode,
      );

    } else if (sourceType === 'sftp' && targetType === 'local') {
      const client = sftpClients.get(sourceSftpId);
      if (!client) throw new Error("Source SFTP session not found");

      const dir = path.dirname(targetPath);
      await ensureLocalDir(dir);

      const encodedSourcePath = isScpModeClient(client)
        ? sourcePath
        : encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
      // SCP cannot resume, but it must still stage locally so a failed/cancelled
      // overwrite never truncates or removes the existing destination.
      const stageLocalDownload = transfer.resumable || isScpModeClient(client);
      let downloadTargetPath = stageLocalDownload
        ? tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath))
        : targetPath;
      transfer.stagedLocalPath = stageLocalDownload ? downloadTargetPath : null;
      transfer.checkpointBytes = await resolveLocalResumeCheckpoint(
        downloadTargetPath, transfer.checkpointBytes,
      );
      sendProgress(transfer.checkpointBytes, fileSize, { force: true });
      {
        const verifyBytes = resumeContentVerifyBytes(
          transfer.checkpointBytes,
          transfer.sourceFingerprint,
        );
        await verifyResumeContent(
          verifyBytes,
          (options) => hashRemotePrefix(
            client,
            sourceSftpId,
            sourcePath,
            sourceEncoding,
            verifyBytes,
            options,
          ),
          (options) => hashLocalPrefix(downloadTargetPath, verifyBytes, options),
        );
      }
      const download = stageLocalDownload
        ? await downloadFileWithTempRootRecovery({
          transfer,
          transferId,
          fileName: path.basename(targetPath),
          localPath: downloadTargetPath,
          run: recoveredPath => downloadFile(
            encodedSourcePath,
            recoveredPath,
            client,
            fileSize,
            transfer,
            sendProgress,
            resolveEncodingForRequest(sourceSftpId, sourceEncoding),
            runCancelablePreflight,
          ),
        })
        : { localPath: downloadTargetPath, result: await downloadFile(
          encodedSourcePath,
          downloadTargetPath,
          client,
          fileSize,
          transfer,
          sendProgress,
          resolveEncodingForRequest(sourceSftpId, sourceEncoding),
          runCancelablePreflight,
        ) };
      downloadTargetPath = download.localPath;
      const downloadResult = download.result;
      if (
        isScpModeClient(client)
        && Number.isFinite(downloadResult?.fileSize)
        && downloadResult.fileSize >= 0
      ) {
        // SCP follows symlinks. Its wire header is authoritative for the bytes
        // received, while the preflight shell stat describes the link node.
        fileSize = downloadResult.fileSize;
        lastObservedTotal = fileSize;
        lastObservedTransferred = Math.min(lastObservedTransferred, fileSize);
      }
      if (stageLocalDownload) {
        if (transfer.cancelled) throw new Error("Transfer cancelled");
        const stagedStat = await fs.promises.stat(downloadTargetPath);
        if (transfer.cancelled) throw new Error("Transfer cancelled");
        if (stagedStat.size !== fileSize) {
          throw new Error(`Downloaded file size mismatch: expected ${fileSize}, got ${stagedStat.size}`);
        }
        if (transfer.cancelled) throw new Error("Transfer cancelled");
        const {
          promotionTargetPath,
          existingMode,
          targetIdentity,
        } = await inspectLocalPromotionTarget(targetPath);
        if (transfer.cancelled) throw new Error("Transfer cancelled");
        await promoteLocalTransfer(downloadTargetPath, promotionTargetPath, {
          sourceSoftIdentity: transfer.sourceSoftIdentity,
          existingMode,
          async validateTarget() {
            const latestTarget = await inspectLocalPromotionTarget(targetPath);
            if (latestTarget.promotionTargetPath !== promotionTargetPath) {
              throw new Error("Local download target changed before replacement");
            }
            if (latestTarget.targetIdentity !== targetIdentity) {
              throw new Error("Local download target changed before replacement");
            }
            return latestTarget;
          },
          assertNotCancelled() {
            if (transfer.cancelled) throw new Error("Transfer cancelled");
          },
          onCommit(publishedIdentity, localMtimePrepared) {
            transfer.completionCommitted = true;
            transfer.localMtimePrepared = localMtimePrepared;
            transfer.publishedLocalIdentity = publishedIdentity ?? null;
          },
        });
        transfer.stagedLocalPath = null;
      }

    } else if (sourceType === 'local' && targetType === 'local') {
      const dir = path.dirname(targetPath);
      await ensureLocalDir(dir);
      const localTargetPath = transfer.resumable
        ? tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath))
        : targetPath;
      transfer.stagedLocalPath = transfer.resumable ? localTargetPath : null;
      const checkpoint = Math.max(
        0,
        Math.min(
          await resolveLocalResumeCheckpoint(localTargetPath, transfer.checkpointBytes || 0),
          fileSize,
        ),
      );
      transfer.checkpointBytes = checkpoint;
      sendProgress(checkpoint, fileSize, { force: true });
      {
        const verifyBytes = resumeContentVerifyBytes(checkpoint, transfer.sourceFingerprint);
        await verifyResumeContent(
          verifyBytes,
          (options) => hashLocalPrefix(sourcePath, verifyBytes, options),
          (options) => hashLocalPrefix(localTargetPath, verifyBytes, options),
        );
      }

      await new Promise((resolve, reject) => {
        transfer.pauseSupported = Boolean(transfer.resumable);
        const readStream = fs.createReadStream(sourcePath, { highWaterMark: TRANSFER_CHUNK_SIZE, start: checkpoint });
        const writeStream = fs.createWriteStream(localTargetPath, {
          highWaterMark: TRANSFER_CHUNK_SIZE,
          flags: checkpoint > 0 ? "r+" : "w",
          start: checkpoint,
        });
        let transferred = checkpoint;
        let finished = false;

        transfer.readStream = readStream;
        transfer.writeStream = writeStream;
        if (transfer.paused) {
          try { readStream.pause(); } catch { }
          transfer.streamsUnpiped = true;
        } else {
          readStream.pipe(writeStream);
          transfer.streamsUnpiped = false;
        }

        const cleanup = (err) => {
          if (finished) return;
          finished = true;
          readStream.removeAllListeners();
          writeStream.removeAllListeners();
          if (err) {
            try { readStream.destroy(); } catch { }
            try { writeStream.destroy(); } catch { }
            reject(err);
          } else {
            resolve();
          }
        };

        readStream.on('data', (chunk) => {
          if (transfer.cancelled) { cleanup(new Error('Transfer cancelled')); return; }
          transferred += chunk.length;
          sendProgress(transferred, fileSize);
        });
        readStream.on('error', cleanup);
        writeStream.on('error', cleanup);
        writeStream.on('finish', () => {
          if (transfer.cancelled) {
            cleanup(new Error('Transfer cancelled'));
          } else if (!readStream.readableEnded || transferred !== fileSize) {
            cleanup(new Error('Local copy finished before the full source was read'));
          } else {
            cleanup(null);
          }
        });
        writeStream.on('close', () => {
          if (transfer.cancelled) cleanup(new Error('Transfer cancelled'));
        });
      });
      if (transfer.resumable && transfer.stagedLocalPath) {
        await promoteLocalTransfer(transfer.stagedLocalPath, targetPath, {
          sourceSoftIdentity: transfer.sourceSoftIdentity,
          assertNotCancelled() {
            if (transfer.cancelled) throw new Error("Transfer cancelled");
          },
          onCommit(publishedIdentity, localMtimePrepared) {
            transfer.completionCommitted = true;
            transfer.localMtimePrepared = localMtimePrepared;
            transfer.publishedLocalIdentity = publishedIdentity ?? null;
          },
        });
        transfer.stagedLocalPath = null;
      }

    } else if (sourceType === 'sftp' && targetType === 'sftp') {
      // Try same-host optimization first: remote cp via SSH exec.
      // Falls back to download+upload if cp is unavailable (e.g. Windows SSH servers).
      let sameHostDone = false;
      const resolvedSourceEnc = sourceSftpId ? resolveEncodingForRequest(sourceSftpId, sourceEncoding) : sourceEncoding;
      const resolvedTargetEnc = targetSftpId ? resolveEncodingForRequest(targetSftpId, targetEncoding) : targetEncoding;
      const srcClient = sftpClients.get(sourceSftpId);
      if (!transfer.resumable
        && sameHost
        && (!resolvedSourceEnc || resolvedSourceEnc === 'utf-8')
        && (!resolvedTargetEnc || resolvedTargetEnc === 'utf-8')
        && srcClient
        && !cpUnavailableSet.has(srcClient)) {
        const sshClient = srcClient?.client;
        if (sshClient && typeof sshClient.exec === 'function') {
          try {
            const dir = path.dirname(targetPath).replace(/\\/g, '/');
            try {
              await runTransferAbortableOperation(transfer, (signal) => ensureRemoteDirForSession(
                sourceSftpId,
                dir,
                targetEncoding || sourceEncoding,
                { signal },
              ));
            } catch (error) {
              if (transfer.cancelled || transfer.signal?.aborted) throw new Error("Transfer cancelled");
            }

            const escapedSource = sourcePath.replace(/'/g, "'\\''");
            const escapedTarget = targetPath.replace(/'/g, "'\\''");
            const command = `cp -a '${escapedSource}' '${escapedTarget}'`;

            const result = await execSshCommandCancellable(sshClient, command, transfer);
            if (result.code === 0) {
              sendProgress(fileSize, fileSize);
              sameHostDone = true;
            } else if (result.code === 127) {
              // Exit 127 = command not found — cache to skip future attempts
              cpUnavailableSet.add(srcClient);
            }
            // Other non-zero exits (permission denied, disk full, etc.)
            // fall through to download+upload without caching
          } catch (cpErr) {
            // If cancelled, re-throw; otherwise fall back to download+upload
            if (transfer.cancelled) throw cpErr;
          }
        }
      }

      if (!sameHostDone) {
        let tempPath = tempDirBridge.getTransferTempFilePath(transferId, path.basename(sourcePath));
        transfer.stagedLocalPath = tempPath;

        const sourceClient = sftpClients.get(sourceSftpId);
        const targetClient = sftpClients.get(targetSftpId);
        if (!sourceClient) throw new Error("Source SFTP session not found");
        if (!targetClient) throw new Error("Target SFTP session not found");

        if (transfer.resumeStage !== 'upload') {
          transfer.resumeStage = 'download';
          transfer.downloadCheckpointBytes = await resolveLocalResumeCheckpoint(
            tempPath, transfer.downloadCheckpointBytes,
          );
          transfer.checkpointBytes = transfer.downloadCheckpointBytes;
          lastObservedTransferred = Math.floor(transfer.downloadCheckpointBytes / 2);
          // sendProgress stores overall UI bytes on checkpointBytes — restore the
          // stage offset afterward so downloadFile resumes at the durable point.
          sendProgress(lastObservedTransferred, fileSize, { force: true });
          transfer.checkpointBytes = transfer.downloadCheckpointBytes;
          const encodedSourcePath = isScpModeClient(sourceClient)
            ? sourcePath
            : encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
          {
            const verifyBytes = resumeContentVerifyBytes(
              transfer.downloadCheckpointBytes,
              transfer.sourceFingerprint,
            );
            await verifyResumeContent(
              verifyBytes,
              (options) => hashRemotePrefix(
                sourceClient,
                sourceSftpId,
                sourcePath,
                sourceEncoding,
                verifyBytes,
                options,
              ),
              (options) => hashLocalPrefix(tempPath, verifyBytes, options),
            );
          }
          const downloadProgress = (transferred, reportedTotal, options = {}) => {
            if (
              isScpModeClient(sourceClient)
              && Number.isFinite(reportedTotal)
              && reportedTotal >= 0
              && reportedTotal !== fileSize
            ) {
              // SCP's first data event carries the followed file's wire size.
              // Adopt it before mapping download progress onto the first half
              // of an S2S transfer, otherwise a short link node shows 100% and
              // then appears to move backwards when the real size arrives.
              fileSize = reportedTotal;
              lastObservedTotal = fileSize;
              lastObservedTransferred = Math.min(lastObservedTransferred, Math.floor(transferred / 2));
            }
            const durableCheckpoint = Number.isFinite(options.checkpointBytes)
              ? options.checkpointBytes
              : transferred;
            transfer.downloadCheckpointBytes = durableCheckpoint;
            sendProgress(Math.floor(transferred / 2), fileSize, {
              checkpointBytes: durableCheckpoint,
              force: options.force === true,
            });
            transfer.checkpointBytes = durableCheckpoint;
          };
          const download = await downloadFileWithTempRootRecovery({
            transfer,
            transferId,
            fileName: path.basename(sourcePath),
            localPath: tempPath,
            run: recoveredPath => downloadFile(
              encodedSourcePath,
              recoveredPath,
              sourceClient,
              fileSize,
              transfer,
              downloadProgress,
              resolveEncodingForRequest(sourceSftpId, sourceEncoding),
              runCancelablePreflight,
            ),
          });
          tempPath = download.localPath;
          const downloadResult = download.result;
          if (
            isScpModeClient(sourceClient)
            && Number.isFinite(downloadResult?.fileSize)
            && downloadResult.fileSize >= 0
          ) {
            fileSize = downloadResult.fileSize;
            lastObservedTotal = fileSize;
            lastObservedTransferred = Math.min(lastObservedTransferred, fileSize);
          }
        }

        const localStageStat = await fs.promises.stat(tempPath);
        if (localStageStat.size !== fileSize) {
          throw new Error(`Server copy download size mismatch: expected ${fileSize}, got ${localStageStat.size}`);
        }

        if (transfer.cancelled) {
          try { await fs.promises.unlink(tempPath); } catch { }
          throw new Error('Transfer cancelled');
        }

        const dir = path.dirname(targetPath).replace(/\\/g, '/');
        try {
          await runTransferAbortableOperation(transfer, (signal) => ensureRemoteDirForSession(
            targetSftpId,
            dir,
            targetEncoding,
            { signal },
          ));
        } catch (error) {
          if (transfer.cancelled || transfer.signal?.aborted) throw new Error("Transfer cancelled");
        }

        transfer.resumeStage = 'upload';
        const uploadProgress = (transferred, _total, options = {}) => {
          const durableCheckpoint = Number.isFinite(options.checkpointBytes)
            ? options.checkpointBytes
            : transferred;
          transfer.uploadCheckpointBytes = durableCheckpoint;
          sendProgress(Math.floor(fileSize / 2) + Math.floor(transferred / 2), fileSize, {
            checkpointBytes: durableCheckpoint,
            force: options.force === true,
          });
          transfer.checkpointBytes = durableCheckpoint;
        };
        transfer.sourceIsOwnedTemp = true;
        const resolvedTargetEncoding = resolveEncodingForRequest(targetSftpId, targetEncoding);
        let existingRemoteMode = null;
        const deterministicStagePath = buildRemoteTransferStagePath(targetPath, transferId);
        await runRemoteUploadTransaction(targetClient, tempPath, targetPath, {
          encoding: resolvedTargetEncoding,
          expectedSize: fileSize,
          stagedPath: transfer.resumable ? deterministicStagePath : undefined,
          allowInPlaceFallback: !transfer.resumable,
          preserveStageOnUploadError: transfer.resumable,
          signal: transfer.signal,
          assertCanPromote() {
            if (isTransferCancelled(transfer)) throw new Error("Transfer cancelled");
            if (transfer.staleOpenTruncatedStage) {
              throw new Error("Remote stage truncated by stale OPEN");
            }
          },
          commitPromotion() {
            transfer.completionCommitted = true;
          },
          runCancelablePreflight,
          async uploadFile(encodedUploadPath, uploadTarget) {
            const uploadTargetPath = uploadTarget.logicalPath;
            const usesStage = uploadTarget.generatedStagePath === true;
            existingRemoteMode = existingModeFromUploadPlan(uploadTarget.plan);
            transfer.stagedRemote = usesStage
              ? { client: targetClient, sftpId: targetSftpId, path: uploadTargetPath, encoding: targetEncoding }
              : null;
            transfer.uploadCheckpointBytes = usesStage && transfer.resumable
              ? await runCancelablePreflight(() => resolveRemoteResumeCheckpoint(
                    targetClient,
                    targetSftpId,
                    uploadTargetPath,
                    targetEncoding,
                    transfer.uploadCheckpointBytes,
                  ))
              : 0;
            transfer.checkpointBytes = transfer.uploadCheckpointBytes;
            // Overall progress for R2R upload stage is ~50% + upload/2.
            lastObservedTransferred = Math.floor(fileSize / 2)
              + Math.floor(transfer.uploadCheckpointBytes / 2);
            sendProgress(lastObservedTransferred, fileSize, { force: true });
            transfer.checkpointBytes = transfer.uploadCheckpointBytes;
            if (usesStage && transfer.uploadCheckpointBytes > 0) {
              const verifyBytes = resumeContentVerifyBytes(
                transfer.uploadCheckpointBytes,
                transfer.sourceFingerprint,
              );
              await verifyResumeContent(
                verifyBytes,
                (options) => hashLocalPrefix(tempPath, verifyBytes, options),
                (options) => hashRemotePrefix(
                  targetClient,
                  targetSftpId,
                  uploadTargetPath,
                  targetEncoding,
                  verifyBytes,
                  options,
                ),
              );
            }
            await uploadFile(
              tempPath,
              encodedUploadPath,
              targetClient,
              fileSize,
              transfer,
              uploadProgress,
              resolvedTargetEncoding,
              usesStage ? null : () => { transfer.completionCommitted = true; },
              {
                generatedStagePath: usesStage,
                existingMode: existingRemoteMode,
                sftpId: targetSftpId,
                finalRemotePath: targetPath,
              },
            );
          },
        });
        transfer.stagedRemote = null;
        await restoreRemoteUploadModeBestEffort(
          targetClient,
          targetSftpId,
          targetPath,
          resolvedTargetEncoding,
          existingRemoteMode,
        );

        try { await fs.promises.unlink(tempPath); } catch { }
        transfer.stagedLocalPath = null;
      }

    } else {
      throw new Error("Invalid transfer configuration");
    }

    sendProgress(fileSize, fileSize);
    // Stamp destination mtime from the source so skip-unchanged can match later.
    await preserveTransferredDestinationMtime(transfer);
    logTransferDiag(transfer, "done", {
      transferred: fileSize,
      total: fileSize,
      windowBps: transfer.diagLastWindowBps,
      fields: {
        elapsedMs: Date.now() - (transfer.diagStartedAt || Date.now()),
      },
    });
    sendComplete();

    return { transferId, totalBytes: fileSize };
  } catch (err) {
    logTransferDiag(transfer, transfer.cancelled ? "cancelled" : "error", {
      transferred: transfer.diagLastTransferred,
      total: transfer.diagTotalBytes,
      windowBps: transfer.diagLastWindowBps,
      fields: {
        error: err?.message || String(err),
        elapsedMs: Date.now() - (transfer.diagStartedAt || Date.now()),
      },
    });
    if (transfer.sourceDigestPath) {
      try { await fs.promises.rm(transfer.sourceDigestPath, { force: true }); } catch { }
      transfer.sourceDigestPath = null;
    }
    if (err?.sourceChanged) {
      if (transfer.stagedLocalPath) {
        try { await fs.promises.rm(transfer.stagedLocalPath, { force: true }); } catch { }
        transfer.stagedLocalPath = null;
      }
      if (transfer.stagedRemote) {
        const staged = transfer.stagedRemote;
        try {
          if (isScpModeClient(staged.client)) {
            await getScpBackendForClient(staged.client).remove(staged.path, {
              recursive: false,
              encoding: staged.encoding,
            });
          } else {
            await staged.client.delete(encodePathForSession(staged.sftpId, staged.path, staged.encoding));
          }
        } catch { }
        transfer.stagedRemote = null;
      }
    }
    // Superseded before cancelled: a cancelled attempt can still lose ownership
    // to a same-id retry while OPEN is pending. Treat as superseded so we do not
    // delete the retry stage, release its leases, or emit cancelled (Codex P2).
    if (/superseded/i.test(err?.message || String(err))) {
      sendError(err);
      return { transferId, superseded: true };
    }
    if (!err?.recoveryFailed && (transfer.cancelled || err.message === 'Transfer cancelled')) {
      if (transfer.stagedLocalPath) {
        try { await fs.promises.unlink(transfer.stagedLocalPath); } catch { }
      }
      if (transfer.stagedRemote) {
        const staged = transfer.stagedRemote;
        try {
          if (isScpModeClient(staged.client)) {
            await getScpBackendForClient(staged.client).remove(staged.path, { recursive: false, encoding: staged.encoding });
          } else {
            await staged.client.delete(encodePathForSession(staged.sftpId, staged.path, staged.encoding));
          }
        } catch { }
      }
      cleanupTransfer();
      sender.send("netcatty:transfer:cancelled", { transferId });
      broadcastGlobalTransferEvent({ type: "cancelled", transferId, endedAt: Date.now() });
    } else {
      if (transfer.stagedLocalPath && !transfer.resumable) {
        try { await fs.promises.rm(transfer.stagedLocalPath, { force: true }); } catch { }
        transfer.stagedLocalPath = null;
      }
      sendError(err);
    }
    return { transferId, error: err.message };
  }
}

function getAdmissionResourceKeys(payload) {
  const keys = [
    payload?.sourceHostId ? `host:${payload.sourceHostId}` : payload?.sourceSftpId ? `session:${payload.sourceSftpId}` : null,
    payload?.targetHostId ? `host:${payload.targetHostId}` : payload?.targetSftpId ? `session:${payload.targetSftpId}` : null,
  ].filter(Boolean);
  return [...new Set(keys.length > 0 ? keys : ["local"])];
}

function canAdmitTransfer(job) {
  return job.resourceKeys.every((key) => (admittedActiveByResource.get(key) || 0) < admittedTransferLimit);
}

function adjustAdmittedResources(job, delta) {
  for (const key of job.resourceKeys) {
    const next = (admittedActiveByResource.get(key) || 0) + delta;
    if (next > 0) admittedActiveByResource.set(key, next);
    else admittedActiveByResource.delete(key);
  }
}

function pumpAdmittedTransfers() {
  while (admittedTransferQueue.length > 0) {
    const runnableIndex = admittedTransferQueue.findIndex(canAdmitTransfer);
    if (runnableIndex < 0) return;
    const [job] = admittedTransferQueue.splice(runnableIndex, 1);
    if (!job) return;
    adjustAdmittedResources(job, 1);
    void job.run()
      .then(job.resolve, job.reject)
      .finally(() => {
        adjustAdmittedResources(job, -1);
        pumpAdmittedTransfers();
      });
  }
}

function findQueuedTransfer(transferId) {
  const index = admittedTransferQueue.findIndex((job) => job.payload?.transferId === transferId);
  return index === -1 ? null : { index, job: admittedTransferQueue[index] };
}

function pauseQueuedTransfer(transferId) {
  const queued = findQueuedTransfer(transferId);
  if (!queued) return null;
  admittedTransferQueue.splice(queued.index, 1);
  pausedAdmittedTransfers.set(transferId, queued.job);
  // Preserve the resume checkpoint from the payload — never report 0, or the
  // UI/store will wipe a real checkpoint and restart from byte 0 after restart.
  const checkpointBytes = Math.max(
    0,
    Number(queued.job.payload?.checkpointBytes) || 0,
    Number(queued.job.payload?.downloadCheckpointBytes) || 0,
    Number(queued.job.payload?.uploadCheckpointBytes) || 0,
  );
  const resumeStage = queued.job.payload?.resumeStage || "direct";
  const lifecycleEpoch = Math.max(0, Number(queued.job.payload?.lifecycleEpoch) || 0) + 1;
  queued.job.payload.lifecycleEpoch = lifecycleEpoch;
  queued.job.event?.sender?.send?.("netcatty:transfer:paused", {
    transferId,
    checkpointBytes,
    resumeStage,
    lifecycleEpoch,
  });
  const result = {
    success: true,
    checkpointBytes,
    resumeStage,
    downloadCheckpointBytes: queued.job.payload?.downloadCheckpointBytes,
    uploadCheckpointBytes: queued.job.payload?.uploadCheckpointBytes,
    sourceFingerprint: queued.job.payload?.sourceFingerprint,
    lifecycleEpoch,
  };
  broadcastGlobalTransferEvent({
    type: "paused",
    transferId,
    checkpointBytes: result.checkpointBytes,
    resumeStage: result.resumeStage,
    downloadCheckpointBytes: result.downloadCheckpointBytes,
    uploadCheckpointBytes: result.uploadCheckpointBytes,
    sourceFingerprint: result.sourceFingerprint,
    lifecycleEpoch: result.lifecycleEpoch,
  });
  return result;
}

function cancelQueuedTransfer(transferId) {
  const queued = findQueuedTransfer(transferId);
  const job = queued?.job ?? pausedAdmittedTransfers.get(transferId);
  if (!job) return false;
  if (queued) admittedTransferQueue.splice(queued.index, 1);
  pausedAdmittedTransfers.delete(transferId);
  job.event?.sender?.send?.("netcatty:transfer:cancelled", { transferId });
  broadcastGlobalTransferEvent({ type: "cancelled", transferId, endedAt: Date.now() });
  job.resolve({ transferId, error: "Transfer cancelled", cancelled: true });
  return true;
}

function resumeQueuedTransfer(transferId) {
  const job = pausedAdmittedTransfers.get(transferId);
  if (!job) return null;
  pausedAdmittedTransfers.delete(transferId);
  const lifecycleEpoch = Math.max(0, Number(job.payload?.lifecycleEpoch) || 0) + 1;
  job.payload.lifecycleEpoch = lifecycleEpoch;
  admittedTransferQueue.push(job);
  const queuedEvent = buildTransferLifecycleEvent("queued", job.payload);
  queuedEvent.lifecycleEpoch = lifecycleEpoch;
  job.event?.sender?.send?.("netcatty:transfer:queued", queuedEvent);
  broadcastGlobalTransferEvent(queuedEvent);
  pumpAdmittedTransfers();
  // Soft-resume must stamp this epoch; synthesizing another one freezes progress.
  return { success: true, lifecycleEpoch };
}

function prioritizeQueuedTransfer(transferId) {
  const queued = findQueuedTransfer(transferId);
  if (!queued) return false;
  admittedTransferQueue.splice(queued.index, 1);
  admittedTransferQueue.unshift(queued.job);
  return true;
}

function runAdmittedTransfer(event, payload, onProgress, runner) {
  const requestedLimit = Number(payload?.globalConcurrency);
  if (Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 16) {
    setGlobalTransferConcurrency(requestedLimit);
  }
  return new Promise((resolve, reject) => {
    admittedTransferQueue.push({
      event,
      payload,
      resourceKeys: getAdmissionResourceKeys(payload),
      onProgress,
      resolve,
      reject,
      run: runner ?? (() => startTransferNow(event, payload, onProgress)),
    });
    const queuedEvent = buildTransferLifecycleEvent("queued", payload);
    event?.sender?.send?.("netcatty:transfer:queued", queuedEvent);
    broadcastGlobalTransferEvent(queuedEvent);
    pumpAdmittedTransfers();
  });
}

function startTransfer(event, payload, onProgress) {
  if (payload?.skipAdmission === true) {
    return startTransferNow(event, payload, onProgress);
  }
  return runAdmittedTransfer(event, payload, onProgress);
}

async function startInternalTransfer(event, payload, onProgress) {
  const transferId = String(payload?.transferId || "");
  if (!transferId) throw new Error("Internal transfer ID is required");
  internalTransferIds.add(transferId);
  try {
    return await startTransfer({ ...event, sender: { send() {} } }, payload, onProgress);
  } finally {
    internalTransferIds.delete(transferId);
  }
}

/**
 * Cancel a transfer
 */
async function cancelTransfer(event, payload) {
  const { transferId } = payload;
  rememberPendingCancel(transferId);
  if (cancelQueuedTransfer(transferId)) {
    // Queued cancel already settled the job; clear pending so a later retry
    // with a new open can proceed if the UI reuses the id unexpectedly.
    forgetPendingCancel(transferId);
    return { success: true };
  }
  const transfer = activeTransfers.get(transferId);
  if (transfer) {
    if (transfer.completionCommitted) {
      forgetPendingCancel(transferId);
      return { success: true };
    }
    transfer.cancelled = true;
    forgetPendingCancel(transferId);
    if (typeof transfer.abortOwnedSignal === "function") {
      try { transfer.abortOwnedSignal(); } catch { /* ignore */ }
    }
    if (typeof transfer.abort === "function") {
      try { transfer.abort(); } catch { }
    }

    // Destroy streams for stream-based fallback transfers
    if (transfer.readStream) {
      try { transfer.readStream.destroy(); } catch { }
    }
    if (transfer.writeStream) {
      try { transfer.writeStream.destroy(); } catch { }
    }
  }
  return { success: true };
}

/** Clear a pre-start cancel latch (used when retrying the same transfer id). */
function clearPendingCancel(transferId) {
  forgetPendingCancel(transferId);
}

/**
 * Re-attach a paused stream pair and continue reading.
 * pauseTransfer unpipes so destination drain cannot auto-resume the source.
 * Idempotent: Node does not dedupe pipe(), so only re-pipe while unpiped.
 */
function resumeStreamPair(transfer) {
  if (transfer.readStream && transfer.writeStream && transfer.streamsUnpiped) {
    try { transfer.readStream.pipe(transfer.writeStream); } catch { }
    transfer.streamsUnpiped = false;
  }
  try { transfer.readStream?.resume?.(); } catch { }
}

async function pauseTransfer(_event, payload) {
  const queuedResult = pauseQueuedTransfer(payload?.transferId);
  if (queuedResult) return queuedResult;
  const transfer = activeTransfers.get(payload?.transferId);
  if (!transfer) {
    return { success: false, reason: "Transfer is no longer active" };
  }
  if (!transfer.pauseSupported) {
    return {
      success: false,
      reason: transfer.pauseUnavailableReason || "This transfer cannot be paused safely",
    };
  }
  // Refuse until streams (or an abortable fast path) exist — otherwise the UI
  // latches "paused" while content-verify/fingerprint still runs and then the
  // stream starts under a paused row.
  if (
    !transfer.readStream
    && !transfer.writeStream
    && typeof transfer.abort !== "function"
  ) {
    return { success: false, reason: "This transfer cannot be paused yet" };
  }
  // A repeated pause is still a newer user decision: invalidate any resume
  // waiting for verification or outstanding ranges, even if already paused.
  transfer.pauseRequestToken = Symbol("pause");
  if (transfer.pauseOperation) {
    transfer.pauseSuperseded = false;
    return transfer.pauseOperation;
  }
  if (transfer.paused && transfer.lifecycleState === "paused") {
    const result = {
      success: true,
      checkpointBytes: transfer.checkpointBytes || 0,
      resumeStage: transfer.resumeStage,
      downloadCheckpointBytes: transfer.downloadCheckpointBytes || 0,
      uploadCheckpointBytes: transfer.uploadCheckpointBytes || 0,
      lifecycleEpoch: transfer.lifecycleEpoch,
      ...(transfer.sourceFingerprint ? { sourceFingerprint: transfer.sourceFingerprint } : {}),
    };
    broadcastGlobalTransferEvent({
      type: "paused",
      transferId: payload.transferId,
      checkpointBytes: result.checkpointBytes,
      resumeStage: result.resumeStage,
      downloadCheckpointBytes: result.downloadCheckpointBytes,
      uploadCheckpointBytes: result.uploadCheckpointBytes,
      sourceFingerprint: result.sourceFingerprint,
      lifecycleEpoch: result.lifecycleEpoch,
      lifecycleState: "paused",
    });
    return result;
  }
  transfer.pauseSuperseded = false;
  const pauseOperation = (async () => {
  transfer.paused = true;
  transfer.lifecycleEpoch += 1;
  transfer.lifecycleState = "pausing";
  broadcastGlobalTransferEvent({
    type: "pausing",
    transferId: payload.transferId,
    checkpointBytes: transfer.checkpointBytes || 0,
    resumeStage: transfer.resumeStage,
    downloadCheckpointBytes: transfer.downloadCheckpointBytes || 0,
    uploadCheckpointBytes: transfer.uploadCheckpointBytes || 0,
    lifecycleEpoch: transfer.lifecycleEpoch,
    lifecycleState: transfer.lifecycleState,
  });
  // Stream transfers use readStream.pipe(writeStream). Node's pipe resumes the
  // source on destination 'drain', and pauseTransfer waits for that drain to
  // flush durable bytes — so pause() alone is undone and upload continues while
  // the UI shows paused. Unpipe first; resumeTransfer re-pipes.
  if (transfer.readStream && transfer.writeStream) {
    try { transfer.readStream.unpipe?.(transfer.writeStream); } catch { }
    transfer.streamsUnpiped = true;
  }
  try { transfer.readStream?.pause?.(); } catch { }
  const usesContiguousRangeCheckpoint = typeof transfer.waitForPause === "function";
  if (usesContiguousRangeCheckpoint) {
    await transfer.waitForPause();
    if (!transfer.paused || transfer.pauseSuperseded) {
      return { success: false, superseded: true, supersededBy: "resume", reason: "Pause was superseded by resume" };
    }
    // Concurrent path already tracks contiguous durable bytes — do not spend
    // hundreds of ms waiting for writeStream drain before acknowledging pause.
  } else {
    if (transfer.writeStream?.pending) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, PAUSE_STREAM_DRAIN_MS);
        transfer.writeStream.once?.('open', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (transfer.writeStream?.writableNeedDrain) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, PAUSE_STREAM_DRAIN_MS);
        transfer.writeStream.once?.('drain', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (
      transfer.writeStream
      && Number.isFinite(transfer.writeStream.bytesWritten)
      && transfer.writeStream.bytesWritten < transfer.checkpointBytes
    ) {
      const deadline = Date.now() + PAUSE_STREAM_DRAIN_MS;
      while (transfer.writeStream.bytesWritten < transfer.checkpointBytes && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
  try {
    // Concurrent range transfers already track the highest contiguous durable
    // byte. File size may extend past a hole when ranges finish out of order.
    if (usesContiguousRangeCheckpoint) {
      const activeRanges = typeof transfer.getActiveRangeCount === "function"
        ? transfer.getActiveRangeCount()
        : 0;
      // Soft-drained pause may still have in-flight ranges writing past the
      // contiguous checkpoint. Truncating now races those writes — defer until
      // the pump is idle (or resume), and trust contiguousCheckpointBytes.
      if (activeRanges === 0) {
        try {
          await prepareStreamFallbackAfterRangeFailure(transfer, transfer.stagedRemote?.client);
          transfer.deferredSparseTruncate = false;
        } catch (truncateError) {
          // Truncate can race with the last soft-drain write. Contiguous
          // checkpoint is still valid for resume — do not abort the pause.
          console.warn(
            "[transferBridge] sparse truncate on pause failed; keeping contiguous checkpoint:",
            truncateError?.message || String(truncateError),
          );
          transfer.deferredSparseTruncate = false;
        }
      } else {
        transfer.deferredSparseTruncate = true;
        // New pause owns a fresh exclusive truncate slot.
        transfer._sparseTruncatePromise = null;
        // Finish truncate in the background when in-flight ranges land so a
        // later Resume is not blocked by "still finishing" after a short wait.
        scheduleDeferredSparseTruncateSettle(transfer, payload?.transferId);
      }
    } else if (transfer.stagedLocalPath) {
      try {
        const stat = await fs.promises.stat(transfer.stagedLocalPath);
        transfer.checkpointBytes = stat.size;
      } catch (statError) {
        // Fall through to outer catch only when we have no usable checkpoint.
        if (!(Number.isFinite(transfer.checkpointBytes) && transfer.checkpointBytes >= 0)) {
          throw statError;
        }
      }
    } else if (transfer.stagedRemote) {
      try {
        const staged = transfer.stagedRemote;
        const stat = isScpModeClient(staged.client)
          ? await getScpBackendForClient(staged.client).stat(staged.path, { encoding: staged.encoding })
          : await staged.client.stat(encodePathForSession(staged.sftpId, staged.path, staged.encoding));
        transfer.checkpointBytes = stat.size;
      } catch (statError) {
        if (!(Number.isFinite(transfer.checkpointBytes) && transfer.checkpointBytes >= 0)) {
          throw statError;
        }
      }
    }
  } catch {
    // Last resort: keep pause if we already have a contiguous/progress checkpoint.
    // Unpausing here made folder pause look broken (amber error + children keep going).
    if (Number.isFinite(transfer.checkpointBytes) && transfer.checkpointBytes >= 0) {
      transfer.deferredSparseTruncate = true;
      transfer._sparseTruncatePromise = null;
      scheduleDeferredSparseTruncateSettle(transfer, payload?.transferId);
    } else {
      transfer.deferredSparseTruncate = false;
      transfer.paused = false;
      transfer.lifecycleEpoch += 1;
      transfer.lifecycleState = "transferring";
      resumeStreamPair(transfer);
      broadcastGlobalTransferEvent({
        type: "resumed",
        transferId: payload.transferId,
        lifecycleEpoch: transfer.lifecycleEpoch,
      });
      return { success: false, reason: "Could not verify the saved transfer checkpoint" };
    }
  }
  if (transfer.resumeStage === 'download') transfer.downloadCheckpointBytes = transfer.checkpointBytes;
  if (transfer.resumeStage === 'upload') transfer.uploadCheckpointBytes = transfer.checkpointBytes;
  if (transfer.cancelled || activeTransfers.get(payload?.transferId) !== transfer) {
    return { success: false, reason: "Transfer is no longer active" };
  }
  if (!transfer.paused || transfer.pauseSuperseded) {
    return { success: false, superseded: true, supersededBy: "resume", reason: "Pause was superseded by resume" };
  }
  // Confirm pause as soon as soft-drain + durable checkpoint are ready.
  // Source identity (remote sample reads on download) used to block this IPC
  // for seconds while the UI sat on "finishing current step". Fingerprint is
  // only required at resume — compute it after the user already sees paused.
  transfer.lifecycleState = "paused";
  const result = {
    success: true,
    checkpointBytes: transfer.checkpointBytes || 0,
    resumeStage: transfer.resumeStage,
    downloadCheckpointBytes: transfer.downloadCheckpointBytes || 0,
    uploadCheckpointBytes: transfer.uploadCheckpointBytes || 0,
    lifecycleEpoch: transfer.lifecycleEpoch,
    ...(transfer.sourceFingerprint ? { sourceFingerprint: transfer.sourceFingerprint } : {}),
  };
  broadcastGlobalTransferEvent({
    type: "paused",
    transferId: payload.transferId,
    checkpointBytes: result.checkpointBytes,
    resumeStage: result.resumeStage,
    downloadCheckpointBytes: result.downloadCheckpointBytes,
    uploadCheckpointBytes: result.uploadCheckpointBytes,
    ...(result.sourceFingerprint ? { sourceFingerprint: result.sourceFingerprint } : {}),
    lifecycleEpoch: result.lifecycleEpoch,
    lifecycleState: transfer.lifecycleState,
  });
  if (transfer.resumable && !transfer.sourceFingerprint) {
    void transfer.captureSourceFingerprint?.().catch(() => {
      // Resume can recompute identity if pause-time fingerprint is missing.
    });
  }
  return result;
  })();
  transfer.pauseOperation = pauseOperation;
  try {
    return await pauseOperation;
  } finally {
    if (transfer.pauseOperation === pauseOperation) transfer.pauseOperation = null;
  }
}

async function resumeTransfer(_event, payload) {
  const queuedResume = resumeQueuedTransfer(payload?.transferId);
  if (queuedResume) return queuedResume;
  const transfer = activeTransfers.get(payload?.transferId);
  if (!transfer) {
    return { success: false, reason: "Transfer is no longer active" };
  }
  if (!transfer.pauseSupported) {
    return {
      success: false,
      reason: transfer.pauseUnavailableReason || "This transfer cannot be resumed safely",
    };
  }
  const pauseRequestToken = transfer.pauseRequestToken;
  const invalidResumeResult = (reason) => ({
    success: false, reason,
    ...(transfer.pauseRequestToken !== pauseRequestToken ? { superseded: true, supersededBy: "pause" } : {}),
  });
  const resumeInvalidReason = () => {
    if (activeTransfers.get(payload?.transferId) !== transfer || transfer.cancelled) {
      return "Transfer is no longer active";
    }
    if (transfer.pauseRequestToken !== pauseRequestToken) {
      return "Resume was superseded by a newer pause";
    }
    return null;
  };
  if (transfer.pauseOperation) {
    transfer.pauseSuperseded = true;
    try { transfer.cancelPauseWait?.(); } catch { }
    await transfer.pauseOperation.catch(() => {});
  }
  const currentTransfer = activeTransfers.get(payload?.transferId);
  if (currentTransfer !== transfer || transfer.cancelled) {
    return { success: false, reason: "Transfer is no longer active" };
  }
  const initialInvalidReason = resumeInvalidReason();
  if (initialInvalidReason) return invalidResumeResult(initialInvalidReason);
  // Already flowing (e.g. double-click resume): do not pipe() again.
  if (!transfer.paused) {
    transfer.lifecycleState = "transferring";
    broadcastGlobalTransferEvent({
      type: "resumed",
      transferId: payload.transferId,
      lifecycleEpoch: transfer.lifecycleEpoch,
    });
    return { success: true, lifecycleEpoch: transfer.lifecycleEpoch };
  }
  if (transfer.resumable) {
    try {
      // Prefer pause-time full fingerprint when available (or still capturing).
      // Only fall back to soft identity (size/mtime/head sample) when no full
      // SHA-256 exists — never skip a stored fingerprint before unpausing.
      if (transfer.sourceFingerprintPromise) {
        try { await transfer.sourceFingerprintPromise; } catch { /* fall through */ }
      }
      if (
        transfer.sourceFingerprint
        && String(transfer.sourceFingerprint).startsWith("sha256:")
        && typeof transfer.verifySourceFingerprint === "function"
      ) {
        await transfer.verifySourceFingerprint(transfer.sourceFingerprint);
      } else if (typeof transfer.quickVerifySourceForSoftResume === "function") {
        await transfer.quickVerifySourceForSoftResume();
        if (!transfer.sourceFingerprint) {
          void transfer.captureSourceFingerprint?.().catch(() => {});
        }
      } else if (transfer.verifySourceFingerprint) {
        if (!transfer.sourceFingerprint) {
          await transfer.captureSourceFingerprint?.();
        }
        if (!transfer.sourceFingerprint) {
          return invalidResumeResult("Could not verify the source file for resume");
        }
        await transfer.verifySourceFingerprint(transfer.sourceFingerprint);
      }
    } catch (error) {
      if (transfer.cancelled || activeTransfers.get(payload?.transferId) !== transfer) {
        return { success: false, reason: "Transfer is no longer active" };
      }
      return invalidResumeResult(error?.message || "Could not verify the source file for resume");
    }
  }
  const verifiedInvalidReason = resumeInvalidReason();
  if (verifiedInvalidReason) return invalidResumeResult(verifiedInvalidReason);
  // Soft-drained concurrent pause may leave a sparse tail past the contiguous
  // checkpoint. Wait with Resume's own budget, then single-flight truncate so
  // background settle cannot race new writes after unpause.
  if (transfer.deferredSparseTruncate || transfer._sparseTruncatePromise) {
    const settled = await ensureDeferredSparseFinalize(
      transfer,
      payload?.transferId,
      { maxWaitMs: RESUME_RANGE_SETTLE_MS },
    );
    if (!settled?.ok) {
      return invalidResumeResult(settled?.reason || "The current file is still finishing. Try resume again.");
    }
    if (transfer.cancelled || activeTransfers.get(payload?.transferId) !== transfer) {
      return { success: false, reason: "Transfer is no longer active" };
    }
  }
  const finalInvalidReason = resumeInvalidReason();
  if (finalInvalidReason) return invalidResumeResult(finalInvalidReason);
  transfer.paused = false;
  transfer.pauseSuperseded = false;
  transfer.lifecycleEpoch += 1;
  transfer.lifecycleState = "transferring";
  resumeStreamPair(transfer);
  broadcastGlobalTransferEvent({
    type: "resumed",
    transferId: payload.transferId,
    lifecycleEpoch: transfer.lifecycleEpoch,
  });
  // Soft-resume UI stamps this epoch so a late pause event with an older
  // epoch cannot paint the row back to "paused" after a successful resume.
  return { success: true, lifecycleEpoch: transfer.lifecycleEpoch };
}

async function prioritizeTransfer(_event, payload) {
  return { success: prioritizeQueuedTransfer(payload?.transferId) };
}

async function cleanupTransferArtifacts(_event, payload) {
  const transferId = payload?.transferId;
  if (!transferId) return { success: false };
  const stageNames = new Set([
    path.basename(payload.targetPath || "transfer"),
    path.basename(payload.sourcePath || "transfer"),
  ]);
  for (const fileName of stageNames) {
    const localStage = tempDirBridge.getTransferTempFilePath(transferId, fileName);
    await fs.promises.rm(localStage, { recursive: true, force: true }).catch(() => {});
  }

  if (payload.targetSftpId && payload.targetPath) {
    const client = sftpClients.get(payload.targetSftpId);
    if (client) {
      const stagePath = buildRemoteTransferStagePath(payload.targetPath, transferId);
      try {
        if (isScpModeClient(client)) {
          await getScpBackendForClient(client).remove(stagePath, { recursive: false, encoding: payload.targetEncoding });
        } else {
          await client.delete(encodePathForSession(payload.targetSftpId, stagePath, payload.targetEncoding));
        }
      } catch { /* artifact may not exist */ }
    }
  }

  if (payload.stagedTargetPath) {
    try {
      if (payload.targetSftpId) {
        const client = sftpClients.get(payload.targetSftpId);
        if (client) await client.rmdir(encodePathForSession(payload.targetSftpId, payload.stagedTargetPath, payload.targetEncoding), true);
      } else {
        await fs.promises.rm(payload.stagedTargetPath, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
  return { success: true };
}

/**
 * Same-host directory copy: uses a single `cp -ra` command on the remote server
 * instead of recursively transferring files one by one.
 */
async function sameHostCopyDirectory(event, payload) {
  const { sftpId, sourcePath, targetPath, encoding, transferId } = payload;

  const transfer = { cancelled: false, leasedSftpIds: [] };

  try {
    if (transferId && takePendingCancel(transferId)) {
      const cancelledEvent = { type: "cancelled", transferId, endedAt: Date.now() };
      event?.sender?.send?.("netcatty:transfer:cancelled", cancelledEvent);
      broadcastGlobalTransferEvent(cancelledEvent);
      return { success: false, cancelled: true };
    }

    if (transferId) {
      // Match the regular file path: a transfer becomes cancellable/visible
      // only after every requested session lease has been acquired. A hard
      // close rejection therefore cannot leave a ghost active transfer.
      transfer.leasedSftpIds = acquireTransferSessionLeases(transferId, {
        sourceSftpId: sftpId,
        targetSftpId: sftpId,
      });
      activeTransfers.set(transferId, transfer);
    }

    const client = sftpClients.get(sftpId);
    if (!client) return { success: false };
    if (cpUnavailableSet.has(client)) return { success: false };

    const sshClient = client.client;
    if (!sshClient || typeof sshClient.exec !== 'function') {
      return { success: false };
    }

    if (transfer.cancelled) throw new Error("Transfer cancelled");
    const lifecyclePayload = {
      ...payload,
      sourceType: "sftp",
      targetType: "sftp",
      isDirectory: true,
      resumable: false,
    };
    const startedEvent = buildTransferLifecycleEvent("started", lifecyclePayload);
    event?.sender?.send?.("netcatty:transfer:started", startedEvent);
    broadcastGlobalTransferEvent(startedEvent);

    // Ensure target directory itself exists (not just its parent),
    // so cp copies contents into it rather than creating a nested subdirectory.
    const targetDir = targetPath.replace(/\\/g, '/');
    try {
      await runTransferAbortableOperation(
        transfer,
        (signal) => ensureRemoteDirForSession(sftpId, targetDir, encoding, { signal }),
      );
    } catch (error) {
      if (transfer.cancelled) throw new Error("Transfer cancelled");
    }

    // Use "source/." to copy directory *contents* into target, preserving merge
    // semantics consistent with the recursive per-file transfer path.
    // Without "/.", `cp -ra source target` would create target/source/ when target exists.
    const escapedSource = sourcePath.replace(/'/g, "'\\''");
    const escapedTarget = targetPath.replace(/'/g, "'\\''");
    const command = `cp -ra '${escapedSource}/.' '${escapedTarget}/'`;

    try {
      const result = await execSshCommandCancellable(sshClient, command, transfer);
      if (result.code === 127) {
        cpUnavailableSet.add(client);
        return { success: false };
      }
      if (result.code !== 0) {
        return { success: false };
      }
    } catch (cpErr) {
      if (transfer.cancelled) throw cpErr;
      return { success: false };
    }

    const completedEvent = { type: "completed", transferId, endedAt: Date.now() };
    event?.sender?.send?.("netcatty:transfer:complete", completedEvent);
    broadcastGlobalTransferEvent(completedEvent);
    return { success: true };
  } catch (error) {
    if (transfer.cancelled || /cancel/i.test(error?.message || "")) {
      const cancelledEvent = { type: "cancelled", transferId, endedAt: Date.now() };
      event?.sender?.send?.("netcatty:transfer:cancelled", cancelledEvent);
      broadcastGlobalTransferEvent(cancelledEvent);
    }
    throw error;
  } finally {
    if (transferId) {
      if (activeTransfers.get(transferId) === transfer) {
        activeTransfers.delete(transferId);
      }
      releaseTransferSessionLeases(transferId, transfer.leasedSftpIds);
      transfer.leasedSftpIds = [];
    }
  }
}

function registerWorkerHandle(ipcMain, terminalWorkerManager, channel) {
  ipcMain.handle(channel, (event, payload) => terminalWorkerManager.request(channel, payload, {
    webContentsId: event?.sender?.id,
  }));
}

/**
 * Register IPC handlers for transfer operations
 */
function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;
  if (terminalWorkerManager) {
    // Control replies can arrive out of order across windows. Only the latest
    // request may publish lifecycle state; retain tokens only while in flight.
    const workerControlRequests = new Map();
    const withWorkerControl = async (transferId, action, work) => {
      const token = Symbol("control");
      const state = workerControlRequests.get(transferId) || { token, action, pending: 0 };
      state.token = token;
      state.action = action;
      state.pending += 1;
      workerControlRequests.set(transferId, state);
      const isCurrent = () => workerControlRequests.get(transferId) === state && state.token === token;
      const superseded = () => ({ success: false, superseded: true, supersededBy: state.action });
      try {
        const result = await work(isCurrent, superseded);
        if (isCurrent() && !result?.success && !result?.superseded) {
          if (action === "pause") state.action = "resume";
          else if (action === "resume") state.action = "pause";
        }
        return result;
      } catch (error) {
        if (!isCurrent()) return superseded();
        if (action === "pause") state.action = "resume";
        else if (action === "resume") state.action = "pause";
        throw error;
      } finally {
        state.pending -= 1;
        if (state.pending === 0 && workerControlRequests.get(transferId) === state) {
          workerControlRequests.delete(transferId);
        }
      }
    };
    const nextWorkerLifecycleEpoch = (transferId, suggestedEpoch) => {
      const entry = workerTransferLifecycleEpochs.get(transferId);
      const current = Math.max(0, Number(entry?.epoch) || 0);
      const suggested = Number(suggestedEpoch);
      const next = Number.isFinite(suggested) && suggested > current ? suggested : current + 1;
      if (entry) entry.epoch = next;
      return next;
    };
    const workerRequest = (event, channel, payload) => terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    });
    ipcMain.handle("netcatty:transfer:start", (event, payload) => {
      let lifecycleEntry = null;
      if (payload?.transferId) {
        lifecycleEntry = {
          epoch: Math.max(0, Number(payload.lifecycleEpoch) || 0),
        };
        workerTransferLifecycleEpochs.set(payload.transferId, lifecycleEntry);
      }
      const releaseLifecycleEntry = () => {
        if (
          payload?.transferId
          && workerTransferLifecycleEpochs.get(payload.transferId) === lifecycleEntry
        ) {
          workerTransferLifecycleEpochs.delete(payload.transferId);
          workerControlRequests.delete(payload.transferId);
        }
      };
      // Renderer (or outer main) already admitted — skip a second queue so
      // dedicated pool leases are not pinned while waiting on main admission.
      try {
        const operation = payload?.skipAdmission === true
          ? workerRequest(event, "netcatty:transfer:start", payload)
          : runAdmittedTransfer(
              event,
              payload,
              undefined,
              () => workerRequest(event, "netcatty:transfer:start", {
                ...payload,
                skipAdmission: true,
              }),
            );
        return Promise.resolve(operation).finally(releaseLifecycleEntry);
      } catch (error) {
        releaseLifecycleEntry();
        throw error;
      }
    });
    ipcMain.handle("netcatty:transfer:cancel", (event, payload) => (
      cancelQueuedTransfer(payload?.transferId)
        ? { success: true }
        : withWorkerControl(payload?.transferId, "cancel", () => workerRequest(event, "netcatty:transfer:cancel", payload))
    ));
    ipcMain.handle("netcatty:transfer:pause", async (event, payload) => {
      const queued = pauseQueuedTransfer(payload?.transferId);
      if (queued) return queued;
      return withWorkerControl(payload?.transferId, "pause", async (isCurrent, superseded) => {
        const lifecycleEpoch = nextWorkerLifecycleEpoch(payload?.transferId);
        broadcastGlobalTransferEvent({
          type: "pausing",
          transferId: payload?.transferId,
          lifecycleEpoch,
          lifecycleState: "pausing",
      });
      try {
        const result = await workerRequest(event, "netcatty:transfer:pause", payload);
        if (!isCurrent()) return superseded();
        if (!result?.success) {
          const rollbackEpoch = nextWorkerLifecycleEpoch(payload?.transferId);
          broadcastGlobalTransferEvent({
            type: "resumed",
            transferId: payload?.transferId,
            lifecycleEpoch: rollbackEpoch,
            lifecycleState: "transferring",
          });
          return result;
        }
        broadcastGlobalTransferEvent({
          type: "paused",
          transferId: payload?.transferId,
          checkpointBytes: result.checkpointBytes,
          resumeStage: result.resumeStage,
          downloadCheckpointBytes: result.downloadCheckpointBytes,
          uploadCheckpointBytes: result.uploadCheckpointBytes,
          sourceFingerprint: result.sourceFingerprint,
          lifecycleEpoch,
          lifecycleState: "paused",
        });
        return { ...result, lifecycleEpoch };
      } catch (error) {
        if (!isCurrent()) throw error;
        const rollbackEpoch = nextWorkerLifecycleEpoch(payload?.transferId);
        broadcastGlobalTransferEvent({
          type: "resumed",
          transferId: payload?.transferId,
          lifecycleEpoch: rollbackEpoch,
          lifecycleState: "transferring",
        });
        throw error;
      }
      });
    });
    ipcMain.handle("netcatty:transfer:resume", async (event, payload) => {
      const queuedResume = resumeQueuedTransfer(payload?.transferId);
      if (queuedResume) return queuedResume;
      return withWorkerControl(payload?.transferId, "resume", async (isCurrent, superseded) => {
        const result = await workerRequest(event, "netcatty:transfer:resume", payload);
        if (!isCurrent()) return superseded();
        if (result?.success) {
          // Normalize into main-process epoch space (may advance past worker-local).
          // Soft-resume UI must stamp THIS epoch or later worker progress is stale.
          const lifecycleEpoch = nextWorkerLifecycleEpoch(payload?.transferId, result.lifecycleEpoch);
          broadcastGlobalTransferEvent({
            type: "resumed",
            transferId: payload?.transferId,
            lifecycleEpoch,
            lifecycleState: "transferring",
          });
          return { ...result, lifecycleEpoch };
        }
        return result;
      });
    });
    ipcMain.handle("netcatty:transfer:prioritize", (event, payload) => (
      prioritizeQueuedTransfer(payload?.transferId)
        ? { success: true }
        : workerRequest(event, "netcatty:transfer:prioritize", payload)
    ));
    [
      "netcatty:transfer:cleanup",
      "netcatty:transfer:same-host-copy-dir",
    ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel));
    ipcMain.handle("netcatty:transfer:set-concurrency", async (_event, payload) => {
      const limit = setGlobalTransferConcurrency(payload?.limit);
      await terminalWorkerManager.request("netcatty:transfer:set-concurrency", { limit }).catch(() => {});
      return { success: true, limit };
    });
    // With skipAdmission, cancel latches pendingCancel inside the worker process.
    // Clear must reach the same process that owns startTransferNow.
    ipcMain.handle("netcatty:transfer:clear-pending-cancel", (event, payload) => (
      workerRequest(event, "netcatty:transfer:clear-pending-cancel", payload)
        .catch(() => {
          clearPendingCancel(payload?.transferId);
          return { success: true };
        })
    ));
    ipcMain.handle("netcatty:transfer:retain-sftp-session", (event, payload) => (
      workerRequest(event, "netcatty:transfer:retain-sftp-session", payload)
    ));
    ipcMain.handle("netcatty:transfer:release-sftp-session", (event, payload) => (
      workerRequest(event, "netcatty:transfer:release-sftp-session", payload)
    ));
    return;
  }
  ipcMain.handle("netcatty:transfer:start", startTransfer);
  ipcMain.handle("netcatty:transfer:cancel", cancelTransfer);
  ipcMain.handle("netcatty:transfer:pause", pauseTransfer);
  ipcMain.handle("netcatty:transfer:resume", resumeTransfer);
  ipcMain.handle("netcatty:transfer:prioritize", prioritizeTransfer);
  ipcMain.handle("netcatty:transfer:set-concurrency", (_event, payload) => ({
    success: true,
    limit: setGlobalTransferConcurrency(payload?.limit),
  }));
  ipcMain.handle("netcatty:transfer:cleanup", cleanupTransferArtifacts);
  ipcMain.handle("netcatty:transfer:same-host-copy-dir", sameHostCopyDirectory);
  ipcMain.handle("netcatty:transfer:clear-pending-cancel", (_event, payload) => {
    clearPendingCancel(payload?.transferId);
    return { success: true };
  });
  ipcMain.handle("netcatty:transfer:retain-sftp-session", retainSftpTransferSession);
  ipcMain.handle("netcatty:transfer:release-sftp-session", releaseSftpTransferSession);
}

module.exports = {
  init,
  registerHandlers,
  startTransfer,
  startInternalTransfer,
  runAdmittedTransfer,
  cancelTransfer,
  clearPendingCancel,
  pauseTransfer,
  resumeTransfer,
  prioritizeTransfer,
  setGlobalTransferConcurrency,
  getGlobalTransferConcurrency,
  broadcastGlobalTransferEvent,
  resolveWorkerTransferLifecycleEpoch,
  cleanupTransferArtifacts,
  sameHostCopyDirectory,
  // Test / integration helpers for session leases
  acquireTransferSessionLeases,
  releaseTransferSessionLeases,
  retainSftpTransferSession,
  releaseSftpTransferSession,
  listTransferSftpIds,
  _promoteLocalTransferForTests: promoteLocalTransfer,
  _preserveTransferredDestinationMtimeForTests: preserveTransferredDestinationMtime,
  _restoreRemoteUploadModeBestEffortForTests: restoreRemoteUploadModeBestEffort,
  _waitForPendingWriteOpenPathGateForTests: waitForPendingWriteOpenPathGate,
  _stableLocalFileIdentityForTests: stableLocalFileIdentity,
  _getWorkerTransferLifecycleEpochCountForTests: () => workerTransferLifecycleEpochs.size,
  _setWorkerTransferLifecycleEpochForTests: (transferId, epoch) => {
    workerTransferLifecycleEpochs.set(transferId, { epoch: Math.max(0, Number(epoch) || 0) });
  },
  _clearWorkerTransferLifecycleEpochsForTests: () => {
    workerTransferLifecycleEpochs.clear();
  },
  _getPendingCancelCountForTests: () => pendingCancelTransferIds.size,
  _getActiveTransferCountForTests: () => activeTransfers.size,
  /** @param {object} client SFTP client object used as WeakMap key */
  _getSessionFastDownloadWaiterCountForTests: (client) => (
    sessionFastDownloadWaiters.get(client)?.length || 0
  ),
  _execSshCommandCancellableForTests: execSshCommandCancellable,
  _assertSourceMetadataUnchangedForTests: assertSourceMetadataUnchanged,
  _assertDownloadSourceAfterTransferForTests: assertDownloadSourceAfterTransfer,
  _assertLocalDownloadMatchesRemotePrefixForTests: assertLocalDownloadMatchesRemotePrefix,
  _hashRemotePrefixForTests: hashRemotePrefix,
  _remoteOpenPathMatchesStagedForTests: remoteOpenPathMatchesStaged,
};
