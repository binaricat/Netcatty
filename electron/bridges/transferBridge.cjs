/**
 * Transfer Bridge - Handles file transfers with progress and cancellation
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { encodePathForSession, ensureRemoteDirForSession, requireSftpChannel } = require("./sftpBridge.cjs");

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

// ── Transfer performance tuning ──────────────────────────────────────────────
// ssh2's fastPut/fastGet send multiple SFTP read/write requests in parallel,
// dramatically improving throughput over sequential stream piping.
const TRANSFER_CHUNK_SIZE = 512 * 1024;   // 512KB per SFTP request
const TRANSFER_CONCURRENCY = 64;          // 64 parallel SFTP requests
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
const isolatedDownloadChannelPools = new WeakMap();

/**
 * Initialize the transfer bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
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

function getIsolatedDownloadChannelPool(client) {
  let pool = isolatedDownloadChannelPools.get(client);
  if (!pool) {
    pool = {
      idle: [],
      idleTimers: new Map(),
      busy: new Set(),
      waiters: [],
      opening: 0,
      maxChannels: null,
      warnedCapacity: false,
    };
    isolatedDownloadChannelPools.set(client, pool);
  }
  return pool;
}

function isIsolatedChannelOpenFailure(err) {
  const message = err?.message || String(err || "");
  return (
    message.includes("Channel open failure") ||
    message.includes("open failed")
  );
}

function waitForIsolatedDownloadChannel(pool, transfer) {
  return new Promise((resolve) => {
    let settled = false;
    const waiter = () => {
      if (settled) return;
      settled = true;
      const index = pool.waiters.indexOf(waiter);
      if (index !== -1) {
        pool.waiters.splice(index, 1);
      }
      if (transfer?.wakeWaiter === waiter) {
        transfer.wakeWaiter = null;
      }
      resolve();
    };
    if (transfer) {
      transfer.wakeWaiter = waiter;
    }
    pool.waiters.push(waiter);
  });
}

function notifyIsolatedDownloadWaiter(pool) {
  const waiter = pool.waiters.shift();
  if (waiter) waiter();
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

function scheduleIdleIsolatedDownloadChannel(client, sftp) {
  const pool = isolatedDownloadChannelPools.get(client);
  if (!pool) return;

  clearIdleIsolatedDownloadTimer(pool, sftp);
  const timer = setTimeout(() => {
    clearIdleIsolatedDownloadTimer(pool, sftp);
    removeIdleIsolatedDownloadChannel(pool, sftp);
    try { sftp?.end?.(); } catch { }
  }, ISOLATED_DOWNLOAD_IDLE_TTL_MS);
  pool.idleTimers.set(sftp, timer);
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

  if (dispose) {
    try { sftp?.end?.(); } catch { }
    notifyIsolatedDownloadWaiter(pool);
    return;
  }

  pool.idle.push(sftp);
  scheduleIdleIsolatedDownloadChannel(client, sftp);
  notifyIsolatedDownloadWaiter(pool);
}

async function acquireIsolatedDownloadChannel(client, transfer) {
  const pool = getIsolatedDownloadChannelPool(client);

  while (true) {
    if (transfer?.cancelled) return null;

    const cached = pool.idle.pop();
    if (cached) {
      clearIdleIsolatedDownloadTimer(pool, cached);
      pool.busy.add(cached);
      return cached;
    }

    const knownCapacity = pool.maxChannels;
    const currentChannelCount = pool.idle.length + pool.busy.size + pool.opening;
    if (knownCapacity !== null && currentChannelCount >= knownCapacity) {
      if (pool.opening > 0) {
        await waitForIsolatedDownloadChannel(pool, transfer);
        if (transfer?.cancelled) return null;
        continue;
      }
      if (pool.busy.size === 0) {
        return null;
      }
      await waitForIsolatedDownloadChannel(pool, transfer);
      if (transfer?.cancelled) return null;
      continue;
    }

    pool.opening += 1;
    try {
      const opened = await openIsolatedSftpChannel(client);
      pool.opening -= 1;
      notifyIsolatedDownloadWaiter(pool);
      if (!opened) return null;
      pool.busy.add(opened);
      const knownCapacity = pool.idle.length + pool.busy.size;
      if (pool.maxChannels !== null) {
        pool.maxChannels = Math.max(pool.maxChannels, knownCapacity);
      }
      return opened;
    } catch (err) {
      pool.opening -= 1;
      notifyIsolatedDownloadWaiter(pool);
      if (isIsolatedChannelOpenFailure(err)) {
        if (pool.opening > 0) {
          await waitForIsolatedDownloadChannel(pool, transfer);
          if (transfer?.cancelled) return null;
          continue;
        }
        const detectedCapacity = pool.idle.length + pool.busy.size;
        pool.maxChannels = detectedCapacity;
        if (!pool.warnedCapacity) {
          pool.warnedCapacity = true;
          console.warn(
            `[transferBridge] Isolated fastGet channel capacity reached; reusing up to ${detectedCapacity} extra channel(s) for this SFTP session.`,
          );
        }
        if (detectedCapacity > 0) {
          await waitForIsolatedDownloadChannel(pool, transfer);
          if (transfer?.cancelled) return null;
          continue;
        }
        return null;
      }

      console.warn(
        "[transferBridge] Failed to open isolated SFTP channel for fastGet, falling back to streams:",
        err.message || String(err),
      );
      return null;
    }
  }
}

/**
 * Upload a local file to SFTP using ssh2's fastPut (parallel SFTP requests).
 * Falls back to sequential stream piping if fastPut is unavailable.
 */
async function uploadFile(localPath, remotePath, client, fileSize, transfer, sendProgress) {
  await requireSftpChannel(client);
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");

  // Prefer fastPut on an isolated SFTP channel so cancellation can abort just this transfer.
  if (!client.__netcattySudoMode) {
    let fastSftp = null;
    try {
      fastSftp = await openIsolatedSftpChannel(client);
    } catch (err) {
      console.warn("[transferBridge] Failed to open isolated SFTP channel for fastPut, falling back to streams:", err.message || String(err));
    }

    if (fastSftp && typeof fastSftp.fastPut === "function") {
      return new Promise((resolve, reject) => {
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
          try { fastSftp.end(); } catch { }

          if (transfer.cancelled) reject(new Error("Transfer cancelled"));
          else if (err) reject(err);
          else resolve();
        };
        const abortFastTransfer = () => {
          if (settled) return;
          transfer.cancelled = true;
          try { fastSftp.end(); } catch { }
          finish(new Error("Transfer cancelled"));
        };
        transfer.abort = abortFastTransfer;
        onFastSftpError = (err) => finish(err);
        fastSftp.once("error", onFastSftpError);

        if (transfer.cancelled) {
          finish(new Error("Transfer cancelled"));
          return;
        }

        fastSftp.fastPut(localPath, remotePath, {
          chunkSize: TRANSFER_CHUNK_SIZE,
          concurrency: TRANSFER_CONCURRENCY,
          step: (transferred, _chunk, total) => {
            if (transfer.cancelled) return;
            sendProgress(transferred, total || fileSize);
          },
        }, finish);
      });
    }

    if (fastSftp && typeof fastSftp.end === "function") {
      try { fastSftp.end(); } catch { }
    }
  }

  // Fallback: sequential stream piping
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localPath, { highWaterMark: TRANSFER_CHUNK_SIZE });
    const writeStream = sftp.createWriteStream(remotePath, { highWaterMark: TRANSFER_CHUNK_SIZE });
    let transferred = 0;
    let finished = false;

    transfer.readStream = readStream;
    transfer.writeStream = writeStream;

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
    writeStream.on('close', () => {
      if (transfer.cancelled) cleanup(new Error('Transfer cancelled'));
      else cleanup(null);
    });
    readStream.pipe(writeStream);
  });
}

/**
 * Download from SFTP to local file using ssh2's fastGet (parallel SFTP requests).
 * Falls back to sequential stream piping if fastGet is unavailable.
 */
async function downloadFile(remotePath, localPath, client, fileSize, transfer, sendProgress) {
  await requireSftpChannel(client);
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");

  // Prefer fastGet on an isolated SFTP channel so cancellation can abort just this transfer.
  if (!client.__netcattySudoMode) {
      const fastSftp = await acquireIsolatedDownloadChannel(client, transfer);

    if (fastSftp && typeof fastSftp.fastGet === "function") {
      return new Promise((resolve, reject) => {
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
          concurrency: TRANSFER_CONCURRENCY,
          step: (transferred, _chunk, total) => {
            if (transfer.cancelled) return;
            sendProgress(transferred, total || fileSize);
          },
        }, finish);
      });
    }
  }

  // Fallback: sequential stream piping
  return new Promise((resolve, reject) => {
    const readStream = sftp.createReadStream(remotePath, { highWaterMark: TRANSFER_CHUNK_SIZE });
    const writeStream = fs.createWriteStream(localPath, { highWaterMark: TRANSFER_CHUNK_SIZE });
    let transferred = 0;
    let finished = false;

    transfer.readStream = readStream;
    transfer.writeStream = writeStream;

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
      if (transfer.cancelled) cleanup(new Error('Transfer cancelled'));
      else cleanup(null);
    });
    writeStream.on('close', () => {
      if (transfer.cancelled) cleanup(new Error('Transfer cancelled'));
    });
    readStream.pipe(writeStream);
  });
}

/**
 * Start a file transfer
 */
async function startTransfer(event, payload, onProgress) {
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
  } = payload;
  const sender = event.sender;

  const transfer = { cancelled: false, readStream: null, writeStream: null, abort: null, wakeWaiter: null };
  activeTransfers.set(transferId, transfer);
  const transferCreatedAt = Date.now();

  // ── Progress/speed tracking ──────────────────────────────────────────────
  // Keep progress monotonic and compute speed from a strict sliding window.
  const speedSamples = [{ time: transferCreatedAt, bytes: 0 }]; // [{ time, bytes }]
  let lastObservedTransferred = 0;
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
      sender.send("netcatty:transfer:progress", { transferId, transferred, speed, totalBytes: total });
    }
  };

  const cleanupTransfer = () => {
    activeTransfers.delete(transferId);
  };

  const sendProgress = (transferred, total) => {
    if (transfer.cancelled) return;

    const now = Date.now();

    let normalizedTotal = Number.isFinite(total) && total > 0 ? total : 0;
    if (normalizedTotal === 0) {
      normalizedTotal = lastObservedTotal || 0;
    }
    normalizedTotal = Math.max(normalizedTotal, lastObservedTotal, 0);

    let normalizedTransferred = Number.isFinite(transferred) && transferred > 0 ? transferred : 0;
    if (normalizedTotal > 0) {
      normalizedTransferred = Math.min(normalizedTransferred, normalizedTotal);
    }
    normalizedTransferred = Math.max(normalizedTransferred, lastObservedTransferred);

    lastObservedTransferred = normalizedTransferred;
    lastObservedTotal = normalizedTotal;

    const lastSample = speedSamples[speedSamples.length - 1];
    if (!lastSample || lastSample.bytes !== normalizedTransferred || now - lastSample.time >= PROGRESS_THROTTLE_MS) {
      speedSamples.push({ time: now, bytes: normalizedTransferred });
    }

    const speed = computeWindowSpeed(now, normalizedTransferred);

    if (onProgress) {
      onProgress(normalizedTransferred, normalizedTotal, speed);
    }

    emitProgress(now, normalizedTransferred, normalizedTotal, speed);
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
        await requireSftpChannel(client);
        const encodedSourcePath = encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
        const stat = await client.stat(encodedSourcePath);
        fileSize = stat.size;
      }
    }

    sendProgress(0, fileSize);

    if (sourceType === 'local' && targetType === 'sftp') {
      const client = sftpClients.get(targetSftpId);
      if (!client) throw new Error("Target SFTP session not found");

      const dir = path.dirname(targetPath).replace(/\\/g, '/');
      try { await ensureRemoteDirForSession(targetSftpId, dir, targetEncoding); } catch { }

      const encodedTargetPath = encodePathForSession(targetSftpId, targetPath, targetEncoding);
      await uploadFile(sourcePath, encodedTargetPath, client, fileSize, transfer, sendProgress);

    } else if (sourceType === 'sftp' && targetType === 'local') {
      const client = sftpClients.get(sourceSftpId);
      if (!client) throw new Error("Source SFTP session not found");

      const dir = path.dirname(targetPath);
      await ensureLocalDir(dir);

      const encodedSourcePath = encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
      await downloadFile(encodedSourcePath, targetPath, client, fileSize, transfer, sendProgress);

    } else if (sourceType === 'local' && targetType === 'local') {
      const dir = path.dirname(targetPath);
      await ensureLocalDir(dir);

      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(sourcePath, { highWaterMark: TRANSFER_CHUNK_SIZE });
        const writeStream = fs.createWriteStream(targetPath, { highWaterMark: TRANSFER_CHUNK_SIZE });
        let transferred = 0;
        let finished = false;

        transfer.readStream = readStream;
        transfer.writeStream = writeStream;

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
          if (transfer.cancelled) cleanup(new Error('Transfer cancelled'));
          else cleanup(null);
        });
        writeStream.on('close', () => {
          if (transfer.cancelled) cleanup(new Error('Transfer cancelled'));
        });
        readStream.pipe(writeStream);
      });

    } else if (sourceType === 'sftp' && targetType === 'sftp') {
      const tempPath = path.join(os.tmpdir(), `netcatty-transfer-${transferId}`);

      const sourceClient = sftpClients.get(sourceSftpId);
      const targetClient = sftpClients.get(targetSftpId);
      if (!sourceClient) throw new Error("Source SFTP session not found");
      if (!targetClient) throw new Error("Target SFTP session not found");

      const encodedSourcePath = encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
      const downloadProgress = (transferred) => {
        sendProgress(Math.floor(transferred / 2), fileSize);
      };
      await downloadFile(encodedSourcePath, tempPath, sourceClient, fileSize, transfer, downloadProgress);

      if (transfer.cancelled) {
        try { await fs.promises.unlink(tempPath); } catch { }
        throw new Error('Transfer cancelled');
      }

      const dir = path.dirname(targetPath).replace(/\\/g, '/');
      try { await ensureRemoteDirForSession(targetSftpId, dir, targetEncoding); } catch { }

      const encodedTargetPath = encodePathForSession(targetSftpId, targetPath, targetEncoding);
      const uploadProgress = (transferred) => {
        sendProgress(Math.floor(fileSize / 2) + Math.floor(transferred / 2), fileSize);
      };
      await uploadFile(tempPath, encodedTargetPath, targetClient, fileSize, transfer, uploadProgress);

      try { await fs.promises.unlink(tempPath); } catch { }

    } else {
      throw new Error("Invalid transfer configuration");
    }

    sendProgress(fileSize, fileSize);
    sendComplete();

    return { transferId, totalBytes: fileSize };
  } catch (err) {
    if (err.message === 'Transfer cancelled') {
      cleanupTransfer();
      sender.send("netcatty:transfer:cancelled", { transferId });
    } else {
      sendError(err);
    }
    return { transferId, error: err.message };
  }
}

/**
 * Cancel a transfer
 */
async function cancelTransfer(event, payload) {
  const { transferId } = payload;
  const transfer = activeTransfers.get(transferId);
  if (transfer) {
    transfer.cancelled = true;
    if (typeof transfer.wakeWaiter === "function") {
      try { transfer.wakeWaiter(); } catch { }
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

/**
 * Register IPC handlers for transfer operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:transfer:start", startTransfer);
  ipcMain.handle("netcatty:transfer:cancel", cancelTransfer);
}

module.exports = {
  init,
  registerHandlers,
  startTransfer,
  cancelTransfer,
};
