/**
 * Transfer Bridge - Handles file transfers with progress and cancellation
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const tempDirBridge = require("./tempDirBridge.cjs");
const { encodePathForSession, ensureRemoteDirForSession, requireSftpChannel, resolveEncodingForRequest } = require("./sftpBridge.cjs");
const { isScpModeClient, getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
const {
  DOWNLOAD_TRANSFER_CONCURRENCY,
  FAST_DOWNLOAD_CHANNELS_PER_SESSION,
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
} = require("./transferLimits.cjs");

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
    try {
      if (typeof client.delete === "function") {
        await client.delete(remotePath);
      }
    } catch {
      // Best-effort cleanup of the corrupt remote file.
    }
    throw new Error(
      `Upload size mismatch for ${remotePath}: expected ${expectedSize} bytes, got ${remoteSize}`,
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

async function hashReadable(readable) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of readable) hash.update(chunk);
  return hash.digest("hex");
}

function hashLocalPrefix(filePath, bytes) {
  if (!bytes) return Promise.resolve(null);
  return hashReadable(fs.createReadStream(filePath, { start: 0, end: bytes - 1 }));
}

function hashLocalFile(filePath) {
  return hashReadable(fs.createReadStream(filePath));
}

async function hashRemoteFile(client, sftpId, filePath, encoding) {
  if (isScpModeClient(client)) return null;
  const sshClient = client?.client;
  if (sshClient && typeof sshClient.exec === "function") {
    const escapedPath = String(filePath).replace(/'/g, "'\\''");
    const digest = await new Promise((resolve, reject) => {
      sshClient.exec(`sha256sum -- '${escapedPath}'`, (error, stream) => {
        if (error) return reject(error);
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk) => { stdout += chunk.toString(); });
        stream.stderr?.on?.("data", (chunk) => { stderr += chunk.toString(); });
        stream.on("close", (code) => {
          const match = stdout.match(/^([a-fA-F0-9]{64})\s/);
          if (code === 0 && match) resolve(match[1].toLowerCase());
          else reject(new Error(stderr || "Remote SHA-256 is unavailable"));
        });
      });
    }).catch(() => null);
    if (digest) return digest;
  }
  if (!client.sftp) await requireSftpChannel(client);
  if (typeof client.sftp?.createReadStream !== "function") {
    throw new Error("Remote SHA-256 verification is unavailable");
  }
  return hashReadable(client.sftp.createReadStream(encodePathForSession(sftpId, filePath, encoding)));
}

async function computeSourceFingerprint({ sourceType, sourcePath, sourceSftpId, sourceEncoding }) {
  if (sourceType === "local") return `sha256:${await hashLocalFile(sourcePath)}`;
  const client = sftpClients.get(sourceSftpId);
  if (!client) throw new Error("Source SFTP session not found");
  const digest = await hashRemoteFile(client, sourceSftpId, sourcePath, sourceEncoding);
  return digest ? `sha256:${digest}` : null;
}

async function hashRemotePrefix(client, sftpId, filePath, encoding, bytes) {
  if (!bytes) return null;
  if (isScpModeClient(client)) return null;
  await requireSftpChannel(client);
  const encodedPath = encodePathForSession(sftpId, filePath, encoding);
  return hashReadable(client.sftp.createReadStream(encodedPath, { start: 0, end: bytes - 1 }));
}

/**
 * Cap content re-hash on resume. Full-prefix hashing of multi-MB .part files
 * over SFTP can take longer than the remaining transfer itself and freezes the
 * UI at "transferring" with no byte movement (seen after Resume All post-quit).
 * A leading sample still catches swapped / truncated garbage cheaply.
 */
const RESUME_CONTENT_VERIFY_MAX_BYTES = 256 * 1024;

function resumeContentVerifyBytes(checkpoint) {
  const claimed = Math.max(0, Number(checkpoint) || 0);
  if (!claimed) return 0;
  return Math.min(claimed, RESUME_CONTENT_VERIFY_MAX_BYTES);
}

async function assertMatchingResumeContent(sourceHashPromise, stagedHashPromise) {
  const [sourceHash, stagedHash] = await Promise.all([sourceHashPromise, stagedHashPromise]);
  if (sourceHash && stagedHash && sourceHash !== stagedHash) {
    throw new Error("Resume safety check failed: saved content does not match the source");
  }
}

async function promoteLocalTransfer(stagedPath, targetPath) {
  const token = crypto.randomUUID().replace(/-/g, "");
  const targetDir = path.dirname(targetPath);
  const targetBase = path.basename(targetPath);
  const readyPath = path.join(targetDir, `.${targetBase}.netcatty-${token}.ready`);
  const backupPath = path.join(targetDir, `.${targetBase}.netcatty-${token}.backup`);
  let preparedPath = stagedPath;
  let backedUp = false;
  try {
    try {
      await fs.promises.rename(stagedPath, readyPath);
    } catch (err) {
      if (err?.code !== "EXDEV") throw err;
      await fs.promises.copyFile(stagedPath, readyPath);
      preparedPath = readyPath;
    }
    if (preparedPath !== readyPath) preparedPath = readyPath;
    try {
      await fs.promises.rename(targetPath, backupPath);
      backedUp = true;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    await fs.promises.rename(readyPath, targetPath);
    if (backedUp) await fs.promises.unlink(backupPath).catch(() => {});
    if (stagedPath !== readyPath) await fs.promises.unlink(stagedPath).catch(() => {});
  } catch (err) {
    if (backedUp) {
      await fs.promises.rename(backupPath, targetPath).catch(() => {});
    }
    await fs.promises.unlink(readyPath).catch(() => {});
    throw err;
  }
}

async function promoteRemoteTransfer(client, sftpId, stagedPath, targetPath, encoding) {
  const backupPath = `${targetPath}.netcatty-${crypto.randomUUID().replace(/-/g, "")}.backup`;
  let backedUp = false;
  if (isScpModeClient(client)) {
    const backend = getScpBackendForClient(client);
    try {
      await backend.rename(targetPath, backupPath, { encoding });
      backedUp = true;
    } catch { /* target may not exist */ }
    try {
      await backend.rename(stagedPath, targetPath, { encoding });
    } catch (err) {
      if (backedUp) await backend.rename(backupPath, targetPath, { encoding }).catch(() => {});
      throw err;
    }
    if (backedUp) await backend.remove(backupPath, { recursive: false, encoding }).catch(() => {});
    return;
  }
  const encodedStage = encodePathForSession(sftpId, stagedPath, encoding);
  const encodedTarget = encodePathForSession(sftpId, targetPath, encoding);
  const encodedBackup = encodePathForSession(sftpId, backupPath, encoding);
  try {
    await client.rename(encodedTarget, encodedBackup);
    backedUp = true;
  } catch { /* target may not exist */ }
  try {
    await client.rename(encodedStage, encodedTarget);
  } catch (err) {
    if (backedUp) await client.rename(encodedBackup, encodedTarget).catch(() => {});
    throw err;
  }
  if (backedUp) await client.delete(encodedBackup).catch(() => {});
}

// ── Transfer performance tuning ──────────────────────────────────────────────
// Progress IPC throttle: sending too many IPC messages bogs down the event loop
const PROGRESS_THROTTLE_MS = 100;         // Send IPC at most every 100ms
const PROGRESS_THROTTLE_BYTES = 256 * 1024; // Or every 256KB of progress
const ISOLATED_DOWNLOAD_IDLE_TTL_MS = 5000;

// Speed calculation uses strict sliding-window average:
// speed = bytes_delta_in_window / time_delta_in_window
const SPEED_WINDOW_MS = 3000;             // Keep 3s of samples
const SPEED_MIN_ELAPSED_MS = 50;          // Minimum elapsed time to avoid divide-by-near-zero spikes

// Shared references
let sftpClients = null;

// Active transfers storage
const activeTransfers = new Map();
const admittedTransferQueue = [];
const pausedAdmittedTransfers = new Map();
/** Transfer ids cancelled before startTransferNow registered them (skipAdmission open window). */
const pendingCancelTransferIds = new Set();
const admittedActiveByResource = new Map();
let admittedTransferLimit = 2;
const isolatedDownloadChannelPools = new WeakMap();
// Cache sftpIds where remote cp is known to be unavailable, so we skip
// repeated failed exec attempts for each file in a multi-file transfer.
const cpUnavailableSet = new Set();

const {
  sftpTransferSessionLeaseStore,
} = require("./sftpTransferSessionLease.cjs");

/**
 * Initialize the transfer bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
}

function listTransferSftpIds(payload = {}) {
  return [...new Set(
    [payload.sourceSftpId, payload.targetSftpId].filter((id) => typeof id === "string" && id.length > 0),
  )];
}

function acquireTransferSessionLeases(transferId, payload) {
  const sftpIds = listTransferSftpIds(payload);
  for (const sftpId of sftpIds) {
    sftpTransferSessionLeaseStore.acquire(sftpId, transferId);
  }
  return sftpIds;
}

async function hardCloseSftpSession(sftpId) {
  if (!sftpId) return;
  // TOCTOU: another transfer may have acquired between shouldHardClose and here.
  // Re-arm soft-close and abort the force close so we don't kill live work.
  if (sftpTransferSessionLeaseStore.isHeld(sftpId)) {
    sftpTransferSessionLeaseStore.markSoftClosed(sftpId);
    return;
  }
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
      void hardCloseSftpSession(sftpId);
    }
  }
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
  return new Promise((resolve, reject) => {
    if (transfer.cancelled) return reject(new Error('Transfer cancelled'));

    sshClient.exec(command, (err, stream) => {
      if (err) return reject(err);

      // If cancelled between exec() call and callback, kill immediately
      if (transfer.cancelled) {
        try { stream.close(); } catch { }
        return reject(new Error('Transfer cancelled'));
      }

      let stdout = '';
      let stderr = '';

      // Wire abort: closing the stream kills the remote process
      const prevAbort = transfer.abort;
      transfer.abort = () => {
        try { stream.close(); } catch { }
        if (typeof prevAbort === 'function') prevAbort();
      };

      stream.on('close', (code) => {
        transfer.abort = prevAbort; // restore
        if (transfer.cancelled) return reject(new Error('Transfer cancelled'));
        resolve({ stdout, stderr, code });
      });

      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
    });
  });
}

async function openIsolatedSftpChannel(client) {
  const sshClient = client?.client;
  if (!sshClient || typeof sshClient.sftp !== "function") return null;

  return new Promise((resolve, reject) => {
    sshClient.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
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
    // Best-effort: stream fallback can still proceed from checkpoint.
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
    const opened = await openIsolatedSftpChannel(client);
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
      "[transferBridge] Failed to open isolated SFTP channel for fastGet, falling back to streams:",
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
async function uploadFile(localPath, remotePath, client, fileSize, transfer, sendProgress, encoding = "utf-8") {
  if (isScpModeClient(client)) {
    transfer.pauseSupported = false;
    transfer.pauseUnavailableReason = "Pause is unavailable for SCP transfers";
    transfer.uploadStrategy = "scp";
    const backend = getScpBackendForClient(client);
    await backend.uploadFile(localPath, remotePath, {
      fileSize,
      transfer,
      encoding,
      onProgress: (transferred, total) => sendProgress(transferred, total || fileSize),
    });
    return;
  }

  await requireSftpChannel(client);
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");
  transfer.pauseSupported = Boolean(transfer.resumable);
  const initialSource = transfer.resumable
    ? await fs.promises.stat(localPath)
    : null;

  const finishSuccessfulUpload = async () => {
    if (initialSource) {
      const latestSource = await fs.promises.stat(localPath);
      assertSourceMetadataUnchanged(initialSource, latestSource, fileSize);
    }
    await assertRemoteUploadSize(client, remotePath, fileSize);
  };

  /** @type {Error | null} */
  let lastPipelineError = null;
  const rememberPipelineError = (err) => {
    if (err && typeof err === "object") lastPipelineError = err;
    else lastPipelineError = new Error(String(err || "SFTP upload failed"));
  };

  // Prefer an isolated SFTP channel so cancellation cannot kill the browse session.
  if (!client.__netcattySudoMode) {
    let isolated = null;
    try {
      isolated = await openIsolatedSftpChannel(client);
    } catch (err) {
      rememberPipelineError(err);
      console.warn(
        "[transferBridge] Failed to open isolated SFTP channel for upload:",
        err.message || String(err),
      );
    }

    if (isolated && transfer.resumable) {
      let concurrentIsolatedOk = false;
      try {
        transfer.uploadStrategy = "concurrent-isolated";
        await uploadFileConcurrent(
          localPath,
          remotePath,
          isolated,
          fileSize,
          transfer,
          sendProgress,
          { disposeChannel: true },
        );
        concurrentIsolatedOk = true;
      } catch (err) {
        // uploadFileConcurrent ends the isolated channel itself.
        isolated = null;
        if (transfer.cancelled) throw err;
        if (err?.noTransferFallback) throw err;
        rememberPipelineError(err);
        await prepareUploadFallbackCheckpoint(transfer, client, fileSize, sendProgress);
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

    if (!isolated) {
      try {
        isolated = await openIsolatedSftpChannel(client);
      } catch (err) {
        rememberPipelineError(err);
        console.warn(
          "[transferBridge] Failed to reopen isolated SFTP channel for fastPut:",
          err.message || String(err),
        );
      }
    }

    // fastPut always truncates and rewrites from offset 0 — skip when we
    // already have a durable resume checkpoint from a prior concurrent attempt.
    // fastPut is not pause-aware; do not advertise pause while it runs.
    const hasResumeCheckpoint = Math.max(0, Number(transfer.checkpointBytes) || 0) > 0;
    if (isolated && typeof isolated.fastPut === "function" && !hasResumeCheckpoint) {
      let fastPutOk = false;
      let fastPutFingerprint = null;
      try {
        transfer.uploadStrategy = "fastPut-isolated";
        transfer.pauseSupported = false;
        transfer.pauseUnavailableReason = "Pause is unavailable during fastPut upload";
        sendProgress(Math.max(0, Number(transfer.checkpointBytes) || 0), fileSize, {
          force: true,
        });
        if (transfer.resumable) {
          fastPutFingerprint = await captureLocalContentFingerprint(localPath, fileSize);
        }
        await uploadViaFastPut(
          localPath,
          remotePath,
          isolated,
          fileSize,
          transfer,
          sendProgress,
          { disposeChannel: true },
        );
        if (fastPutFingerprint) {
          await assertLocalContentFingerprintUnchanged(
            localPath,
            fastPutFingerprint,
            fileSize,
          );
        }
        fastPutOk = true;
      } catch (err) {
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
        // fastPut progress is not a durable contiguous checkpoint — reset so
        // concurrent-shared does not resume past holes left by the failed put.
        transfer.checkpointBytes = 0;
        sendProgress(0, fileSize, { force: true, checkpointBytes: 0 });
        console.warn(
          "[transferBridge] isolated fastPut failed, trying next pipelined strategy:",
          err?.message || String(err),
        );
      }
      if (fastPutOk) {
        await finishSuccessfulUpload();
        return;
      }
    } else if (isolated && typeof isolated.end === "function") {
      try { isolated.end(); } catch { /* ignore */ }
    }
  }

  // Concurrent WRITEs on the shared browse channel — still pipelined, does not
  // end the session on cancel/dispose (sudo mode and isolated-open failures).
  if (typeof sftp.open === "function" && typeof sftp.write === "function") {
    let sharedOk = false;
    try {
      transfer.uploadStrategy = "concurrent-shared";
      transfer.pauseSupported = Boolean(transfer.resumable);
      if (transfer.resumable) transfer.pauseUnavailableReason = undefined;
      await uploadFileConcurrent(
        localPath,
        remotePath,
        sftp,
        fileSize,
        transfer,
        sendProgress,
        { disposeChannel: false },
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
  const cause = lastPipelineError;
  const message = cause?.message
    ? `SFTP pipelined upload failed: ${cause.message}`
    : "SFTP pipelined upload failed (no serial stream fallback)";
  const error = new Error(message, cause ? { cause } : undefined);
  if (cause?.noTransferFallback) error.noTransferFallback = true;
  throw error;
}

function openSftpHandle(sftp, filePath, flags) {
  return new Promise((resolve, reject) => {
    sftp.open(filePath, flags, (error, handle) => {
      if (error) reject(error);
      else resolve(handle);
    });
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

async function readSftpRange(sftp, handle, buffer, position, length) {
  let received = 0;
  while (received < length) {
    const bytesRead = await new Promise((resolve, reject) => {
      sftp.read(
        handle,
        buffer,
        received,
        length - received,
        position + received,
        (error, count) => {
          if (error) reject(error);
          else resolve(Number(count) || 0);
        },
      );
    });
    if (bytesRead <= 0) {
      throw new Error("Download stream finished before the full source was received");
    }
    received += bytesRead;
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
  for (const position of offsets) {
    if (transfer.cancelled) throw new Error("Transfer cancelled");
    const length = Math.min(sampleSize, fileSize - position);
    const remoteBuffer = Buffer.allocUnsafe(length);
    const localBuffer = Buffer.allocUnsafe(length);
    await readSftpRange(sftp, remoteHandle, remoteBuffer, position, length);
    await readLocalRange(localHandle, localBuffer, position, length);
    if (!remoteBuffer.equals(localBuffer)) {
      const error = new Error("Transfer source content changed during transfer");
      error.noTransferFallback = true;
      error.sourceChanged = true;
      throw error;
    }
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

/**
 * Full content fingerprint for same-size rewrite detection. Uploads can read
 * ranges out of order, so metadata or sparse sampling cannot prove that a
 * large source stayed unchanged throughout the transfer.
 */
async function captureLocalContentFingerprintFromHandle(fileHandle, fileSize) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, fileSize)));
  let position = 0;
  while (position < fileSize) {
    const length = Math.min(buffer.length, fileSize - position);
    await readLocalRange(fileHandle, buffer, position, length);
    hash.update(buffer.subarray(0, length));
    position += length;
  }
  return { size: fileSize, digest: hash.digest("hex") };
}

async function captureLocalContentFingerprint(filePath, fileSize) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    return await captureLocalContentFingerprintFromHandle(handle, fileSize);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function assertLocalContentFingerprintUnchanged(filePath, fingerprint, expectedSize) {
  if (!fingerprint) return;
  let latestStat;
  try {
    latestStat = await fs.promises.stat(filePath);
  } catch (error) {
    const err = new Error(
      `Transfer source disappeared during transfer: ${error?.message || String(error)}`,
    );
    err.noTransferFallback = true;
    err.sourceChanged = true;
    throw err;
  }
  const latestSize = Number(latestStat?.size);
  if (latestSize !== expectedSize) {
    throw createSourceSizeChangedError(expectedSize, latestSize);
  }
  const latest = await captureLocalContentFingerprint(filePath, expectedSize);
  if (latest.digest !== fingerprint.digest) {
    throw createSourceContentChangedError();
  }
}

async function assertLocalContentFingerprintUnchangedFromHandle(fileHandle, fingerprint, expectedSize) {
  if (!fingerprint) return;
  const latest = await captureLocalContentFingerprintFromHandle(fileHandle, expectedSize);
  if (latest.size !== expectedSize || latest.digest !== fingerprint.digest) {
    throw createSourceContentChangedError();
  }
}

function assertSourceMetadataUnchanged(initialSource, latestSource, expectedSize) {
  const latestSize = Number(latestSource?.size);
  if (latestSize !== expectedSize) {
    throw createSourceSizeChangedError(expectedSize, latestSize);
  }
  // Soft signal only — content fingerprint is the durable check for same-size
  // rewrites. Keep metadata as a cheap early reject when timestamps move.
  const versionFields = ["mtimeMs", "ctimeMs", "mtime", "ctime", "ino"];
  const changed = versionFields.some((field) => {
    const before = Number(initialSource?.[field]);
    const after = Number(latestSource?.[field]);
    return Number.isFinite(before) && Number.isFinite(after) && before !== after;
  });
  if (changed) {
    throw createSourceContentChangedError();
  }
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
  let pauseResolvers = [];

  const cancelPauseWait = () => {
    const resolvers = pauseResolvers;
    pauseResolvers = [];
    for (const resolve of resolvers) resolve();
  };

  const publishContiguousCheckpoint = (force = false) => {
    if (transfer.cancelled) return;
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
    for (const resolve of resolvers) resolve();
  };

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
          // Cancel must remain bounded even on a shared channel. Ordinary
          // shared-channel errors, however, must drain their in-flight WRITEs
          // before the caller can clean up or retry the same remote path.
          if (transfer.cancelled || (terminalError && forceSettleOnError)) {
            clearForceFinish();
            forceFinishTimer = setTimeout(() => {
              if (settled) return;
              active = 0;
              settled = true;
              reject(terminalError || new Error("Transfer cancelled"));
            }, 2000);
            forceFinishTimer.unref?.();
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
          const length = Math.min(TRANSFER_CHUNK_SIZE, fileSize - position);
          nextOffset += length;
          active += 1;

          void copyRange(position, length)
            .then(() => {
              transferred += length;
              completedRanges.set(position, position + length);
              while (completedRanges.has(contiguousCheckpoint)) {
                const nextCheckpoint = completedRanges.get(contiguousCheckpoint);
                completedRanges.delete(contiguousCheckpoint);
                contiguousCheckpoint = nextCheckpoint;
              }
              publishContiguousCheckpoint(false);
            })
            .catch((error) => abort(error))
            .finally(() => {
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
        if (active === 0) {
          publishContiguousCheckpoint(true);
          return Promise.resolve();
        }
        return new Promise((resolvePause) => pauseResolvers.push(resolvePause));
      };
      transfer.cancelPauseWait = cancelPauseWait;
      transfer.abort = abort;
      pump();
    });
  } finally {
    if (sftp && onSftpError && typeof sftp.removeListener === "function") {
      try { sftp.removeListener("error", onSftpError); } catch { }
    }
  }
}

/**
 * Pipelined SFTP WRITE upload (same fanout as ssh2 fastPut).
 *
 * @param {{ disposeChannel?: boolean }} [options]
 *   disposeChannel — when true (isolated channel), end the SFTP subsystem on
 *   cancel/finish. When false (shared browse session), never call sftp.end().
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
  const checkpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
  let channelError = null;
  const onChannelError = (error) => {
    channelError = channelError || error;
  };
  sftp.on?.("error", onChannelError);
  // Install cancel before OPEN so a stalled remote open can still end an
  // isolated channel (runPausableConcurrentRanges would install this later).
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
    // Sample content after local OPEN so same-size rewrites are caught even when
    // mtime/ctime stay put. Uses the open handle (channel already acquired).
    const contentFingerprint = await captureLocalContentFingerprintFromHandle(
      localHandle,
      fileSize,
    );
    remoteHandle = await openSftpHandle(sftp, remotePath, checkpoint > 0 ? "r+" : "w");
    if (channelError) throw channelError;
    if (transfer.cancelled) throw new Error("Transfer cancelled");

    try {
      await runPausableConcurrentRanges({
        transfer,
        fileSize,
        checkpoint,
        concurrency: UPLOAD_TRANSFER_CONCURRENCY,
        copyRange: async (position, length) => {
          const buffer = Buffer.allocUnsafe(length);
          await readLocalRange(localHandle, buffer, position, length);
          await writeSftpRange(sftp, remoteHandle, buffer, position, length);
        },
        sendProgress,
        abortChannel,
        sftp,
        forceSettleOnError: disposeChannel,
      });
      if (channelError) throw channelError;
      await assertLocalContentFingerprintUnchangedFromHandle(
        localHandle,
        contentFingerprint,
        fileSize,
      );
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
        try {
          await Promise.race([
            closeSftpHandle(sftp, remoteHandle),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error("SFTP close timed out")), 2000);
            }),
          ]);
        } catch (error) {
          if (!failed && !transfer.cancelled && !/timed out/i.test(error?.message || "")) {
            remoteCloseError = error;
          }
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
  }
}

// Back-compat alias for older call sites / tests that still name the isolated path.
const uploadFileResumableFast = uploadFileConcurrent;

/**
 * Preserve fastGet's high-latency request window without giving up a safe
 * pause checkpoint. Progress and resume offsets track the highest contiguous
 * durable byte; out-of-order range completion cannot advance past a hole.
 * Once pause is requested, no new ranges are scheduled and we wait for every
 * in-flight range before acknowledging it.
 */
async function downloadFileResumableFast(
  remotePath,
  localPath,
  sftp,
  fileSize,
  transfer,
  sendProgress,
) {
  const checkpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
  let channelError = null;
  const onChannelError = (error) => {
    channelError = channelError || error;
  };
  sftp.on?.("error", onChannelError);
  // Install cancel before OPEN so a stalled remote open can still end the
  // isolated channel (runPausableConcurrentRanges would install this later).
  const abortEarly = () => {
    transfer.cancelled = true;
    try { sftp.end?.(); } catch { }
  };
  transfer.abort = abortEarly;

  let remoteHandle = null;
  let localHandle = null;
  let failed = false;
  try {
    if (transfer.cancelled) throw new Error("Transfer cancelled");
    remoteHandle = await openSftpHandle(sftp, remotePath, "r");
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
        abortChannel: () => sftp.end?.(),
        sftp,
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
    if (remoteHandle && !failed && !transfer.cancelled) {
      try {
        await closeSftpHandle(sftp, remoteHandle);
      } catch (error) {
        remoteCloseError = error;
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
      const error = new Error("The isolated SFTP channel failed while closing", { cause: remoteCloseError });
      error.completedWithUnhealthyChannel = true;
      throw error;
    }
  }
}

async function downloadFile(remotePath, localPath, client, fileSize, transfer, sendProgress, encoding = "utf-8") {
  if (isScpModeClient(client)) {
    transfer.pauseSupported = false;
    transfer.pauseUnavailableReason = "Pause is unavailable for SCP transfers";
    const backend = getScpBackendForClient(client);
    await backend.downloadFile(remotePath, localPath, {
      fileSize,
      transfer,
      encoding,
      onProgress: (transferred, total) => sendProgress(transferred, total || fileSize),
    });
    return;
  }

  await requireSftpChannel(client);
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");
  transfer.pauseSupported = Boolean(transfer.resumable);
  const initialSource = transfer.resumable
    ? await client.stat(remotePath)
    : null;

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
          await downloadFileResumableFast(
            remotePath,
            localPath,
            fastSftp,
            fileSize,
            transfer,
            sendProgress,
          );
          const latestSource = await client.stat(remotePath);
          assertSourceMetadataUnchanged(initialSource, latestSource, fileSize);
          releaseIsolatedDownloadChannel(client, fastSftp);
          return;
        }
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
          const latestSource = await client.stat(remotePath);
          assertSourceMetadataUnchanged(initialSource, latestSource, fileSize);
          return;
        }
        // Concurrent ranges may leave sparse tails past the contiguous
        // checkpoint; truncate the actual local target before stream resume.
        const checkpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
        try {
          await fs.promises.truncate(localPath, checkpoint);
        } catch (truncateError) {
          if (!(checkpoint === 0 && truncateError?.code === "ENOENT")) {
            throw truncateError;
          }
        }
        sendProgress(checkpoint, fileSize, { force: true, checkpointBytes: checkpoint });
        console.warn(
          "[transferBridge] fastGet failed, falling back to a compatible stream:",
          err?.message || String(err),
        );
      }
    } else if (fastSftp) {
      // Acquired a channel but cannot use fast path — return it to the pool.
      releaseIsolatedDownloadChannel(client, fastSftp);
    }
  }

  // Fallback: sequential stream piping
  await new Promise((resolve, reject) => {
    const checkpoint = Math.max(0, Math.min(transfer.checkpointBytes || 0, fileSize));
    const readStream = sftp.createReadStream(remotePath, { highWaterMark: TRANSFER_CHUNK_SIZE, start: checkpoint });
    const writeStream = fs.createWriteStream(localPath, {
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
        cleanup(new Error('Download stream finished before the full source was received'));
      } else {
        cleanup(null);
      }
    });
    writeStream.on('close', () => {
      if (transfer.cancelled) cleanup(new Error('Transfer cancelled'));
    });
  });
  if (initialSource) {
    const latestSource = await client.stat(remotePath);
    assertSourceMetadataUnchanged(initialSource, latestSource, fileSize);
  }
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
  if (transferId && pendingCancelTransferIds.has(transferId)) {
    pendingCancelTransferIds.delete(transferId);
    sender.send?.("netcatty:transfer:cancelled", { transferId });
    return { transferId, error: "Transfer cancelled", cancelled: true };
  }

  sender.send?.("netcatty:transfer:started", { transferId });

  const transfer = {
    cancelled: false,
    paused: false,
    pauseSupported: false,
    pauseUnavailableReason: "This transfer cannot be paused safely",
    resumable: payload.resumable === true,
    checkpointBytes: Math.max(0, Number(payload.checkpointBytes) || 0),
    resumeStage: payload.resumeStage || 'direct',
    downloadCheckpointBytes: Math.max(0, Number(payload.downloadCheckpointBytes) || 0),
    uploadCheckpointBytes: Math.max(0, Number(payload.uploadCheckpointBytes) || 0),
    sourceFingerprint: payload.sourceFingerprint,
    sourceType,
    targetType,
    sourcePath,
    targetPath,
    sourceSftpId,
    targetSftpId,
    sourceEncoding,
    targetEncoding,
    readStream: null,
    writeStream: null,
    // True after unpipe (or when open skipped pipe while paused). Guards
    // resumeStreamPair against duplicate pipe() which doubles writes.
    streamsUnpiped: false,
    abort: null,
  };
  activeTransfers.set(transferId, transfer);
  // Hold panel/agent SFTP sessions for the full transfer lifetime (including
  // pause). Panel close becomes a soft-close until we release these leases.
  const leasedSftpIds = acquireTransferSessionLeases(transferId, payload);
  transfer.leasedSftpIds = leasedSftpIds;
  const transferCreatedAt = Date.now();

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
    const bytesSinceLast = transferred - lastProgressSentBytes;

    if (
      force ||
      isComplete ||
      (transferredChanged &&
        (timeSinceLast >= PROGRESS_THROTTLE_MS || bytesSinceLast >= PROGRESS_THROTTLE_BYTES))
    ) {
      lastProgressSentTime = now;
      lastProgressSentBytes = transferred;
      sender.send("netcatty:transfer:progress", {
        transferId,
        transferred,
        speed,
        totalBytes: total,
        checkpointBytes: transfer.checkpointBytes,
        resumeStage: transfer.resumeStage,
        downloadCheckpointBytes: transfer.downloadCheckpointBytes,
        uploadCheckpointBytes: transfer.uploadCheckpointBytes,
        sourceFingerprint: transfer.sourceFingerprint,
        resumable: transfer.resumable && transfer.pauseSupported,
        // Only surface a reason when pause is actually unavailable; never keep
        // the startup default once pauseSupported is true.
        pauseUnavailableReason: transfer.pauseSupported
          ? undefined
          : transfer.pauseUnavailableReason,
      });
    }
  };

  let leasesReleased = false;
  const cleanupTransfer = () => {
    activeTransfers.delete(transferId);
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

  const sendComplete = () => {
    sender.send("netcatty:transfer:complete", { transferId });
    cleanupTransfer();
  };

  const sendError = (error) => {
    cleanupTransfer();
    sender.send("netcatty:transfer:error", { transferId, error: error.message || String(error) });
  };

  try {
    let fileSize = totalBytes || 0;

    if (!fileSize) {
      if (sourceType === 'local') {
        const stat = await fs.promises.stat(sourcePath);
        fileSize = stat.size;
      } else if (sourceType === 'sftp') {
        const client = sftpClients.get(sourceSftpId);
        if (!client) throw new Error("Source SFTP session not found");
        if (isScpModeClient(client)) {
          const st = await getScpBackendForClient(client).stat(sourcePath, {
            encoding: resolveEncodingForRequest(sourceSftpId, sourceEncoding),
          });
          fileSize = st.size;
        } else {
          await requireSftpChannel(client);
          const encodedSourcePath = encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
          const stat = await client.stat(encodedSourcePath);
          fileSize = stat.size;
        }
      }
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

    if (transfer.resumable && transfer.sourceFingerprint) {
      const currentSourceFingerprint = await computeSourceFingerprint({
        sourceType,
        sourcePath,
        sourceSftpId,
        sourceEncoding,
      });
      if (
        transfer.sourceFingerprint
        && currentSourceFingerprint
        && transfer.sourceFingerprint !== currentSourceFingerprint
      ) {
        throw new Error("Resume safety check failed: the source file has changed");
      }
    }

    sendProgress(transfer.checkpointBytes, fileSize, { force: true });

    if (sourceType === 'local' && targetType === 'sftp') {
      const client = sftpClients.get(targetSftpId);
      if (!client) throw new Error("Target SFTP session not found");

      const dir = path.dirname(targetPath).replace(/\\/g, '/');
      try { await ensureRemoteDirForSession(targetSftpId, dir, targetEncoding); } catch { }

      const uploadTargetPath = transfer.resumable
        ? buildRemoteTransferStagePath(targetPath, transferId)
        : targetPath;
      transfer.stagedRemote = transfer.resumable
        ? { client, sftpId: targetSftpId, path: uploadTargetPath, encoding: targetEncoding }
        : null;
      // Clamp UI/progress checkpoint to durable remote .part size (crash-safe).
      transfer.checkpointBytes = await resolveRemoteResumeCheckpoint(
        client, targetSftpId, uploadTargetPath, targetEncoding, transfer.checkpointBytes,
      );
      sendProgress(transfer.checkpointBytes, fileSize, { force: true });
      {
        const verifyBytes = resumeContentVerifyBytes(transfer.checkpointBytes);
        await assertMatchingResumeContent(
          hashLocalPrefix(sourcePath, verifyBytes),
          hashRemotePrefix(client, targetSftpId, uploadTargetPath, targetEncoding, verifyBytes),
        );
      }
      const encodedTargetPath = isScpModeClient(client)
        ? uploadTargetPath
        : encodePathForSession(targetSftpId, uploadTargetPath, targetEncoding);
      await uploadFile(
        sourcePath,
        encodedTargetPath,
        client,
        fileSize,
        transfer,
        sendProgress,
        resolveEncodingForRequest(targetSftpId, targetEncoding),
      );
      if (transfer.resumable) {
        await promoteRemoteTransfer(client, targetSftpId, uploadTargetPath, targetPath, targetEncoding);
        transfer.stagedRemote = null;
      }

    } else if (sourceType === 'sftp' && targetType === 'local') {
      const client = sftpClients.get(sourceSftpId);
      if (!client) throw new Error("Source SFTP session not found");

      const dir = path.dirname(targetPath);
      await ensureLocalDir(dir);

      const encodedSourcePath = isScpModeClient(client)
        ? sourcePath
        : encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
      const downloadTargetPath = transfer.resumable
        ? tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath))
        : targetPath;
      transfer.stagedLocalPath = transfer.resumable ? downloadTargetPath : null;
      transfer.checkpointBytes = await resolveLocalResumeCheckpoint(
        downloadTargetPath, transfer.checkpointBytes,
      );
      sendProgress(transfer.checkpointBytes, fileSize, { force: true });
      {
        const verifyBytes = resumeContentVerifyBytes(transfer.checkpointBytes);
        await assertMatchingResumeContent(
          hashRemotePrefix(client, sourceSftpId, sourcePath, sourceEncoding, verifyBytes),
          hashLocalPrefix(downloadTargetPath, verifyBytes),
        );
      }
      await downloadFile(
        encodedSourcePath,
        downloadTargetPath,
        client,
        fileSize,
        transfer,
        sendProgress,
        resolveEncodingForRequest(sourceSftpId, sourceEncoding),
      );
      if (transfer.resumable) {
        const stagedStat = await fs.promises.stat(downloadTargetPath);
        if (stagedStat.size !== fileSize) {
          throw new Error(`Downloaded file size mismatch: expected ${fileSize}, got ${stagedStat.size}`);
        }
        await promoteLocalTransfer(downloadTargetPath, targetPath);
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
        const verifyBytes = resumeContentVerifyBytes(checkpoint);
        await assertMatchingResumeContent(
          hashLocalPrefix(sourcePath, verifyBytes),
          hashLocalPrefix(localTargetPath, verifyBytes),
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
        await promoteLocalTransfer(transfer.stagedLocalPath, targetPath);
        transfer.stagedLocalPath = null;
      }

    } else if (sourceType === 'sftp' && targetType === 'sftp') {
      // Try same-host optimization first: remote cp via SSH exec.
      // Falls back to download+upload if cp is unavailable (e.g. Windows SSH servers).
      let sameHostDone = false;
      const resolvedSourceEnc = sourceSftpId ? resolveEncodingForRequest(sourceSftpId, sourceEncoding) : sourceEncoding;
      const resolvedTargetEnc = targetSftpId ? resolveEncodingForRequest(targetSftpId, targetEncoding) : targetEncoding;
      if (!transfer.resumable
        && sameHost
        && (!resolvedSourceEnc || resolvedSourceEnc === 'utf-8')
        && (!resolvedTargetEnc || resolvedTargetEnc === 'utf-8')
        && !cpUnavailableSet.has(sourceSftpId)) {
        const srcClient = sftpClients.get(sourceSftpId);
        const sshClient = srcClient?.client;
        if (sshClient && typeof sshClient.exec === 'function') {
          try {
            const dir = path.dirname(targetPath).replace(/\\/g, '/');
            try { await ensureRemoteDirForSession(sourceSftpId, dir, targetEncoding || sourceEncoding); } catch { }

            const escapedSource = sourcePath.replace(/'/g, "'\\''");
            const escapedTarget = targetPath.replace(/'/g, "'\\''");
            const command = `cp -a '${escapedSource}' '${escapedTarget}'`;

            const result = await execSshCommandCancellable(sshClient, command, transfer);
            if (result.code === 0) {
              sendProgress(fileSize, fileSize);
              sameHostDone = true;
            } else if (result.code === 127) {
              // Exit 127 = command not found — cache to skip future attempts
              cpUnavailableSet.add(sourceSftpId);
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
        const tempPath = tempDirBridge.getTransferTempFilePath(transferId, path.basename(sourcePath));
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
            const verifyBytes = resumeContentVerifyBytes(transfer.downloadCheckpointBytes);
            await assertMatchingResumeContent(
              hashRemotePrefix(sourceClient, sourceSftpId, sourcePath, sourceEncoding, verifyBytes),
              hashLocalPrefix(tempPath, verifyBytes),
            );
          }
          const downloadProgress = (transferred, _total, options = {}) => {
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
          await downloadFile(
            encodedSourcePath,
            tempPath,
            sourceClient,
            fileSize,
            transfer,
            downloadProgress,
            resolveEncodingForRequest(sourceSftpId, sourceEncoding),
          );
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
        try { await ensureRemoteDirForSession(targetSftpId, dir, targetEncoding); } catch { }

        transfer.resumeStage = 'upload';
        const uploadTargetPath = transfer.resumable
          ? buildRemoteTransferStagePath(targetPath, transferId)
          : targetPath;
        transfer.uploadCheckpointBytes = await resolveRemoteResumeCheckpoint(
          targetClient, targetSftpId, uploadTargetPath, targetEncoding, transfer.uploadCheckpointBytes,
        );
        transfer.checkpointBytes = transfer.uploadCheckpointBytes;
        // Overall progress for R2R upload stage is ~50% + upload/2.
        lastObservedTransferred = Math.floor(fileSize / 2)
          + Math.floor(transfer.uploadCheckpointBytes / 2);
        // sendProgress stores overall UI bytes on checkpointBytes — restore the
        // stage offset afterward so uploadFile resumes at the durable point.
        sendProgress(lastObservedTransferred, fileSize, { force: true });
        transfer.checkpointBytes = transfer.uploadCheckpointBytes;
        transfer.stagedRemote = transfer.resumable
          ? { client: targetClient, sftpId: targetSftpId, path: uploadTargetPath, encoding: targetEncoding }
          : null;
        {
          const verifyBytes = resumeContentVerifyBytes(transfer.uploadCheckpointBytes);
          await assertMatchingResumeContent(
            hashLocalPrefix(tempPath, verifyBytes),
            hashRemotePrefix(targetClient, targetSftpId, uploadTargetPath, targetEncoding, verifyBytes),
          );
        }
        const encodedTargetPath = isScpModeClient(targetClient)
          ? uploadTargetPath
          : encodePathForSession(targetSftpId, uploadTargetPath, targetEncoding);
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
        await uploadFile(
          tempPath,
          encodedTargetPath,
          targetClient,
          fileSize,
          transfer,
          uploadProgress,
          resolveEncodingForRequest(targetSftpId, targetEncoding),
        );
        if (transfer.resumable) {
          await promoteRemoteTransfer(targetClient, targetSftpId, uploadTargetPath, targetPath, targetEncoding);
          transfer.stagedRemote = null;
        }

        try { await fs.promises.unlink(tempPath); } catch { }
        transfer.stagedLocalPath = null;
      }

    } else {
      throw new Error("Invalid transfer configuration");
    }

    sendProgress(fileSize, fileSize);
    sendComplete();

    return { transferId, totalBytes: fileSize };
  } catch (err) {
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
    if (transfer.cancelled || err.message === 'Transfer cancelled') {
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
    } else {
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
  queued.job.event?.sender?.send?.("netcatty:transfer:paused", {
    transferId,
    checkpointBytes,
    resumeStage,
  });
  return {
    success: true,
    checkpointBytes,
    resumeStage,
    downloadCheckpointBytes: queued.job.payload?.downloadCheckpointBytes,
    uploadCheckpointBytes: queued.job.payload?.uploadCheckpointBytes,
    sourceFingerprint: queued.job.payload?.sourceFingerprint,
  };
}

function cancelQueuedTransfer(transferId) {
  const queued = findQueuedTransfer(transferId);
  const job = queued?.job ?? pausedAdmittedTransfers.get(transferId);
  if (!job) return false;
  if (queued) admittedTransferQueue.splice(queued.index, 1);
  pausedAdmittedTransfers.delete(transferId);
  job.event?.sender?.send?.("netcatty:transfer:cancelled", { transferId });
  job.resolve({ transferId, error: "Transfer cancelled", cancelled: true });
  return true;
}

function resumeQueuedTransfer(transferId) {
  const job = pausedAdmittedTransfers.get(transferId);
  if (!job) return false;
  pausedAdmittedTransfers.delete(transferId);
  admittedTransferQueue.push(job);
  job.event?.sender?.send?.("netcatty:transfer:queued", { transferId });
  pumpAdmittedTransfers();
  return true;
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
    event?.sender?.send?.("netcatty:transfer:queued", { transferId: payload?.transferId });
    pumpAdmittedTransfers();
  });
}

function startTransfer(event, payload, onProgress) {
  if (payload?.skipAdmission === true) {
    return startTransferNow(event, payload, onProgress);
  }
  return runAdmittedTransfer(event, payload, onProgress);
}

/**
 * Cancel a transfer
 */
async function cancelTransfer(event, payload) {
  const { transferId } = payload;
  if (transferId) pendingCancelTransferIds.add(String(transferId));
  if (cancelQueuedTransfer(transferId)) {
    // Queued cancel already settled the job; clear pending so a later retry
    // with a new open can proceed if the UI reuses the id unexpectedly.
    pendingCancelTransferIds.delete(String(transferId));
    return { success: true };
  }
  const transfer = activeTransfers.get(transferId);
  if (transfer) {
    transfer.cancelled = true;
    pendingCancelTransferIds.delete(String(transferId));
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
  if (transferId) pendingCancelTransferIds.delete(String(transferId));
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
  if (transfer.pauseOperation) return transfer.pauseOperation;
  transfer.pauseSuperseded = false;
  const pauseOperation = (async () => {
  transfer.paused = true;
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
      return { success: false, reason: "Pause was superseded by resume" };
    }
  }
  if (transfer.writeStream?.pending) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      transfer.writeStream.once?.('open', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (transfer.writeStream?.writableNeedDrain) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
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
    const deadline = Date.now() + 2000;
    while (transfer.writeStream.bytesWritten < transfer.checkpointBytes && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    // Concurrent range transfers already track the highest contiguous durable
    // byte. File size may extend past a hole when ranges finish out of order.
    if (usesContiguousRangeCheckpoint) {
      // Keep the checkpoint supplied by runPausableConcurrentRanges, and
      // shrink any sparse *target* tail so a later pause/stat cannot overshoot.
      await prepareStreamFallbackAfterRangeFailure(transfer, transfer.stagedRemote?.client);
    } else if (transfer.stagedLocalPath) {
      const stat = await fs.promises.stat(transfer.stagedLocalPath);
      transfer.checkpointBytes = stat.size;
    } else if (transfer.stagedRemote) {
      const staged = transfer.stagedRemote;
      const stat = isScpModeClient(staged.client)
        ? await getScpBackendForClient(staged.client).stat(staged.path, { encoding: staged.encoding })
        : await staged.client.stat(encodePathForSession(staged.sftpId, staged.path, staged.encoding));
      transfer.checkpointBytes = stat.size;
    }
  } catch {
    transfer.paused = false;
    resumeStreamPair(transfer);
    return { success: false, reason: "Could not verify the saved transfer checkpoint" };
  }
  if (transfer.resumeStage === 'download') transfer.downloadCheckpointBytes = transfer.checkpointBytes;
  if (transfer.resumeStage === 'upload') transfer.uploadCheckpointBytes = transfer.checkpointBytes;
  if (transfer.resumable && !transfer.sourceFingerprint) {
    try {
      transfer.sourceFingerprint = await computeSourceFingerprint({
        sourceType: transfer.sourceType,
        sourcePath: transfer.sourcePath,
        sourceSftpId: transfer.sourceSftpId,
        sourceEncoding: transfer.sourceEncoding,
      });
    } catch {
      transfer.paused = false;
      resumeStreamPair(transfer);
      return { success: false, reason: "Could not verify that the source is safe to resume" };
    }
  }
  if (transfer.cancelled || activeTransfers.get(payload?.transferId) !== transfer) {
    return { success: false, reason: "Transfer is no longer active" };
  }
  if (!transfer.paused || transfer.pauseSuperseded) {
    return { success: false, reason: "Pause was superseded by resume" };
  }
  return {
    success: true,
    checkpointBytes: transfer.checkpointBytes || 0,
    resumeStage: transfer.resumeStage,
    downloadCheckpointBytes: transfer.downloadCheckpointBytes || 0,
    uploadCheckpointBytes: transfer.uploadCheckpointBytes || 0,
    ...(transfer.sourceFingerprint ? { sourceFingerprint: transfer.sourceFingerprint } : {}),
  };
  })();
  transfer.pauseOperation = pauseOperation;
  try {
    return await pauseOperation;
  } finally {
    if (transfer.pauseOperation === pauseOperation) transfer.pauseOperation = null;
  }
}

async function resumeTransfer(_event, payload) {
  if (resumeQueuedTransfer(payload?.transferId)) return { success: true };
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
  if (transfer.pauseOperation) {
    transfer.pauseSuperseded = true;
    try { transfer.cancelPauseWait?.(); } catch { }
    await transfer.pauseOperation.catch(() => {});
  }
  const currentTransfer = activeTransfers.get(payload?.transferId);
  if (currentTransfer !== transfer || transfer.cancelled) {
    return { success: false, reason: "Transfer is no longer active" };
  }
  // Already flowing (e.g. double-click resume): do not pipe() again.
  if (!transfer.paused) {
    return { success: true };
  }
  transfer.paused = false;
  transfer.pauseSuperseded = false;
  resumeStreamPair(transfer);
  return { success: true };
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

  // Register in activeTransfers so cancelTransfer can flag it
  const transfer = { cancelled: false, leasedSftpIds: [] };
  if (transferId) {
    activeTransfers.set(transferId, transfer);
    transfer.leasedSftpIds = acquireTransferSessionLeases(transferId, {
      sourceSftpId: sftpId,
      targetSftpId: sftpId,
    });
  }

  try {
    if (cpUnavailableSet.has(sftpId)) return { success: false };

    const client = sftpClients.get(sftpId);
    if (!client) return { success: false };

    const sshClient = client.client;
    if (!sshClient || typeof sshClient.exec !== 'function') {
      return { success: false };
    }

    if (transfer.cancelled) throw new Error("Transfer cancelled");

    // Ensure target directory itself exists (not just its parent),
    // so cp copies contents into it rather than creating a nested subdirectory.
    const targetDir = targetPath.replace(/\\/g, '/');
    try { await ensureRemoteDirForSession(sftpId, targetDir, encoding); } catch { }

    // Use "source/." to copy directory *contents* into target, preserving merge
    // semantics consistent with the recursive per-file transfer path.
    // Without "/.", `cp -ra source target` would create target/source/ when target exists.
    const escapedSource = sourcePath.replace(/'/g, "'\\''");
    const escapedTarget = targetPath.replace(/'/g, "'\\''");
    const command = `cp -ra '${escapedSource}/.' '${escapedTarget}/'`;

    try {
      const result = await execSshCommandCancellable(sshClient, command, transfer);
      if (result.code === 127) {
        cpUnavailableSet.add(sftpId);
        return { success: false };
      }
      if (result.code !== 0) {
        return { success: false };
      }
    } catch (cpErr) {
      if (transfer.cancelled) throw cpErr;
      return { success: false };
    }

    return { success: true };
  } finally {
    if (transferId) {
      activeTransfers.delete(transferId);
      releaseTransferSessionLeases(transferId, transfer.leasedSftpIds || [sftpId]);
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
    const workerRequest = (event, channel, payload) => terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    });
    ipcMain.handle("netcatty:transfer:start", (event, payload) => {
      // Renderer (or outer main) already admitted — skip a second queue so
      // dedicated pool leases are not pinned while waiting on main admission.
      if (payload?.skipAdmission === true) {
        return workerRequest(event, "netcatty:transfer:start", payload);
      }
      return runAdmittedTransfer(
        event,
        payload,
        undefined,
        () => workerRequest(event, "netcatty:transfer:start", {
          ...payload,
          skipAdmission: true,
        }),
      );
    });
    ipcMain.handle("netcatty:transfer:cancel", (event, payload) => (
      cancelQueuedTransfer(payload?.transferId)
        ? { success: true }
        : workerRequest(event, "netcatty:transfer:cancel", payload)
    ));
    ipcMain.handle("netcatty:transfer:pause", (event, payload) => (
      pauseQueuedTransfer(payload?.transferId)
        ?? workerRequest(event, "netcatty:transfer:pause", payload)
    ));
    ipcMain.handle("netcatty:transfer:resume", (event, payload) => (
      resumeQueuedTransfer(payload?.transferId)
        ? { success: true }
        : workerRequest(event, "netcatty:transfer:resume", payload)
    ));
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
}

module.exports = {
  init,
  registerHandlers,
  startTransfer,
  runAdmittedTransfer,
  cancelTransfer,
  clearPendingCancel,
  pauseTransfer,
  resumeTransfer,
  prioritizeTransfer,
  setGlobalTransferConcurrency,
  getGlobalTransferConcurrency,
  cleanupTransferArtifacts,
  sameHostCopyDirectory,
  // Test / integration helpers for session leases
  acquireTransferSessionLeases,
  releaseTransferSessionLeases,
  listTransferSftpIds,
};
