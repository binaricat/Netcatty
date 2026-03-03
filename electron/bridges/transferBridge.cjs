/**
 * Transfer Bridge - Handles file transfers with progress and cancellation
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { encodePathForSession, ensureRemoteDirForSession } = require("./sftpBridge.cjs");

// ── Transfer performance tuning ──────────────────────────────────────────────
// ssh2's fastPut/fastGet send multiple SFTP read/write requests in parallel,
// dramatically improving throughput over sequential stream piping.
const TRANSFER_CHUNK_SIZE = 512 * 1024;   // 512KB per SFTP request
const TRANSFER_CONCURRENCY = 64;          // 64 parallel SFTP requests
// Progress IPC throttle: sending too many IPC messages bogs down the event loop
const PROGRESS_THROTTLE_MS = 100;         // Send IPC at most every 100ms
const PROGRESS_THROTTLE_BYTES = 256 * 1024; // Or every 256KB of progress

// Speed calculation uses strict sliding-window average:
// speed = bytes_delta_in_window / time_delta_in_window
const SPEED_WINDOW_MS = 3000;             // Keep 3s of samples
const SPEED_MIN_ELAPSED_MS = 50;          // Minimum elapsed time to avoid divide-by-near-zero spikes

// Shared references
let sftpClients = null;

// Active transfers storage
const activeTransfers = new Map();

/**
 * Initialize the transfer bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
}

/**
 * Upload a local file to SFTP using ssh2's fastPut (parallel SFTP requests).
 * Falls back to sequential stream piping if fastPut is unavailable.
 */
async function uploadFile(localPath, remotePath, client, fileSize, transfer, sendProgress) {
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");

  // Prefer fastPut: sends multiple SFTP WRITE requests in parallel
  if (typeof sftp.fastPut === 'function') {
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {
        chunkSize: TRANSFER_CHUNK_SIZE,
        concurrency: TRANSFER_CONCURRENCY,
        step: (transferred, _chunk, total) => {
          if (transfer.cancelled) return;
          sendProgress(transferred, total || fileSize);
        }
      }, (err) => {
        if (transfer.cancelled) reject(new Error('Transfer cancelled'));
        else if (err) reject(err);
        else resolve();
      });
    });
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
  const sftp = client.sftp;
  if (!sftp) throw new Error("SFTP client not ready");

  // Prefer fastGet: sends multiple SFTP READ requests in parallel
  if (typeof sftp.fastGet === 'function') {
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {
        chunkSize: TRANSFER_CHUNK_SIZE,
        concurrency: TRANSFER_CONCURRENCY,
        step: (transferred, _chunk, total) => {
          if (transfer.cancelled) return;
          sendProgress(transferred, total || fileSize);
        }
      }, (err) => {
        if (transfer.cancelled) reject(new Error('Transfer cancelled'));
        else if (err) reject(err);
        else resolve();
      });
    });
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

  const transfer = { cancelled: false, readStream: null, writeStream: null };
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
      await fs.promises.mkdir(dir, { recursive: true });

      const encodedSourcePath = encodePathForSession(sourceSftpId, sourcePath, sourceEncoding);
      await downloadFile(encodedSourcePath, targetPath, client, fileSize, transfer, sendProgress);

    } else if (sourceType === 'local' && targetType === 'local') {
      const dir = path.dirname(targetPath);
      await fs.promises.mkdir(dir, { recursive: true });

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
