/**
 * Compress Upload Bridge - Handles folder compression and upload
 * 
 * Compresses folders locally using tar, uploads the archive, then extracts on remote server
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { getTempFilePath } = require("./tempDirBridge.cjs");
const { invalidateSshTransport } = require("./sshTransportInvalidation.cjs");

/**
 * Escape shell arguments to prevent injection attacks
 * Wraps arguments in single quotes and escapes any existing single quotes
 */
function escapeShellArg(arg) {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function buildAtomicRemoteExtractionCommand({
  compressionId,
  archivePath,
  targetDir,
  folderName,
}) {
  const normalizedFolderName = path.posix.basename(String(folderName || "").replace(/\\/g, "/"));
  if (!normalizedFolderName || normalizedFolderName === "." || normalizedFolderName === "..") {
    throw new Error("Invalid compressed upload folder name");
  }
  // Recovery artifacts are stable for one destination, not one attempt. A
  // failed post-commit cleanup is therefore reconciled by the next upload
  // instead of leaving one new backup per compression id.
  const suffix = createHash("sha256")
    .update(`${targetDir}\0${normalizedFolderName}`)
    .digest("hex")
    .slice(0, 16);
  const stageDir = path.posix.join(targetDir, `.netcatty-compress-${suffix}.stage`);
  const backupDir = path.posix.join(targetDir, `.netcatty-compress-${suffix}.backup`);
  const finalDir = path.posix.join(targetDir, normalizedFolderName);
  const stagedFinalDir = path.posix.join(stageDir, normalizedFolderName);

  return [
    "set -e",
    `archive=${escapeShellArg(archivePath)}`,
    `stage=${escapeShellArg(stageDir)}`,
    `backup=${escapeShellArg(backupDir)}`,
    `final=${escapeShellArg(finalDir)}`,
    `staged_final=${escapeShellArg(stagedFinalDir)}`,
    "rollback_compressed_upload() {",
    "  status=$1",
    "  trap - EXIT HUP INT TERM",
    "  if [ ! -e \"$final\" ] && [ ! -L \"$final\" ] && { [ -e \"$backup\" ] || [ -L \"$backup\" ]; }; then",
    "    mv -- \"$backup\" \"$final\" 2>/dev/null || true",
    "  fi",
    "  make_tree_writable \"$stage\"",
    "  rm -rf -- \"$stage\"",
    "  rm -f -- \"$archive\"",
    "  exit \"$status\"",
    "}",
    "make_tree_writable() {",
    "  candidate=$1",
    "  if [ -d \"$candidate\" ] && [ ! -L \"$candidate\" ]; then chmod -R u+w -- \"$candidate\" 2>/dev/null || true; fi",
    "}",
    "trap 'rollback_compressed_upload $?' EXIT",
    "trap 'rollback_compressed_upload 129' HUP",
    "trap 'rollback_compressed_upload 130' INT",
    "trap 'rollback_compressed_upload 143' TERM",
    // Recover a prior interrupted promotion before touching either artifact.
    "if [ ! -e \"$final\" ] && [ ! -L \"$final\" ] && { [ -e \"$backup\" ] || [ -L \"$backup\" ]; }; then mv -- \"$backup\" \"$final\"; fi",
    "if [ -L \"$final\" ]; then echo 'Refusing to replace a symlink target' >&2; exit 1; fi",
    "if [ -e \"$backup\" ] || [ -L \"$backup\" ]; then make_tree_writable \"$backup\"; rm -rf -- \"$backup\"; fi",
    "make_tree_writable \"$stage\"",
    "rm -rf -- \"$stage\"",
    "mkdir -p -- \"$stage\"",
    // Preserve merge semantics without exposing the live destination to tar.
    "if [ -e \"$final\" ]; then",
    "  if ! cp -a -- \"$final\" \"$staged_final\" 2>/dev/null; then",
    "    rm -rf -- \"$staged_final\"",
    "    cp -Rp -- \"$final\" \"$staged_final\"",
    "  fi",
    "fi",
    "tar -xzf \"$archive\" -C \"$stage\" --exclude='._*' --exclude='.DS_Store'",
    "if [ ! -d \"$staged_final\" ]; then echo 'Compressed archive did not contain the expected folder' >&2; exit 1; fi",
    "if [ -e \"$final\" ]; then mv -- \"$final\" \"$backup\"; fi",
    "mv -- \"$staged_final\" \"$final\"",
    "make_tree_writable \"$backup\"",
    "make_tree_writable \"$stage\"",
    "rm -rf -- \"$backup\" \"$stage\"",
    "rm -f -- \"$archive\"",
    "trap - EXIT HUP INT TERM",
  ].join("\n");
}

// Shared references
let sftpClients = null;
let transferBridge = null;

// Active compress operations
const activeCompressions = new Map();
const workerCompressionLifecycleEpochs = new Map();
const compressionSupportCache = new Map();
const compressionTargetLocks = new Map();
const COMPRESSION_SUPPORT_CACHE_TTL_MS = 10_000;
const MAX_COMPRESSION_SUPPORT_CACHE_ENTRIES = 64;
const REMOTE_TAR_PROBE_TIMEOUT_MS = 15_000;
const REMOTE_CLEANUP_TIMEOUT_MS = 15_000;
const LOCAL_TAR_PROBE_TIMEOUT_MS = 10_000;
const LOCAL_TAR_KILL_GRACE_MS = 750;
const MAX_REMOTE_EXEC_STDERR_BYTES = 64 * 1024;
const MAX_LOCAL_TAR_STDERR_BYTES = 64 * 1024;

async function runWithCompressionTargetLock(targetKey, signal, operation) {
  const predecessor = compressionTargetLocks.get(targetKey) || Promise.resolve();
  let release;
  const ownGate = new Promise((resolve) => { release = resolve; });
  const ownTail = predecessor.catch(() => {}).then(() => ownGate);
  compressionTargetLocks.set(targetKey, ownTail);

  let removeAbortListener = () => {};
  try {
    if (signal) {
      const aborted = new Promise((_, reject) => {
        const onAbort = () => reject(
          signal.reason instanceof Error ? signal.reason : new Error("Upload cancelled"),
        );
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }
      });
      await Promise.race([predecessor.catch(() => {}), aborted]);
    } else {
      await predecessor.catch(() => {});
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Upload cancelled");
    }
    return await operation();
  } finally {
    removeAbortListener();
    release();
    void ownTail.finally(() => {
      if (compressionTargetLocks.get(targetKey) === ownTail) {
        compressionTargetLocks.delete(targetKey);
      }
    });
  }
}

function buildCompressionTargetKey(connectionIdentity, targetPath, folderName) {
  if (!connectionIdentity) {
    throw new Error("SFTP connection identity unavailable for compressed upload");
  }
  const normalizedFolderName = path.posix.basename(String(folderName || "").replace(/\\/g, "/"));
  if (!normalizedFolderName || normalizedFolderName === "." || normalizedFolderName === "..") {
    throw new Error("Invalid compressed upload folder name");
  }
  const normalizedTarget = path.posix.normalize(path.posix.join(
    String(targetPath || ".").replace(/\\/g, "/"),
    normalizedFolderName,
  ));
  return `${connectionIdentity}\0${normalizedTarget}`;
}

function resolveCompressionTargetKey(sftpId, targetPath, folderName) {
  const client = sftpClients?.get?.(sftpId);
  const connectionIdentity = client?.__netcattyEndpointKey
    || client?.__netcattyRefHolder?.connRef?.endpointKey;
  return buildCompressionTargetKey(connectionIdentity, targetPath, folderName);
}

function createBoundedUtf8Collector(maxBytes) {
  const limit = Math.max(1, Number(maxBytes) || 1);
  const decoder = new StringDecoder("utf8");
  let text = "";
  let bytes = 0;
  let truncated = false;
  let ended = false;
  return {
    append(chunk) {
      if (ended) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, limit - bytes);
      const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
      if (accepted.length > 0) text += decoder.write(accepted);
      bytes += accepted.length;
      if (accepted.length < buffer.length) truncated = true;
    },
    end() {
      if (ended) return text;
      ended = true;
      // If the byte cap cut through a code point, discard the held prefix
      // instead of turning it into a replacement character in diagnostics.
      if (!truncated || decoder.lastNeed === 0) text += decoder.end();
      return text;
    },
    value() {
      return text;
    },
  };
}

function terminateRemoteExecStream(stream) {
  if (!stream) return;
  try { stream.once?.('error', () => {}); } catch { /* ignore */ }
  try { stream.stderr?.once?.('error', () => {}); } catch { /* ignore */ }
  try { stream.close?.(); } catch { /* ignore */ }
  try { stream.end?.(); } catch { /* ignore */ }
  try { stream.destroy?.(); } catch { /* ignore */ }
}

function runRemoteExec(sshClient, command, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || REMOTE_CLEANUP_TIMEOUT_MS);
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    let stream = null;
    let settled = false;
    const stderr = createBoundedUtf8Collector(MAX_REMOTE_EXEC_STDERR_BYTES);
    let hasOutput = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        terminateRemoteExecStream(stream);
        reject(error);
      } else {
        resolve(result);
      }
    };
    const onAbort = () => {
      finish(signal?.reason instanceof Error ? signal.reason : new Error('Remote command cancelled'));
      if (!stream) invalidateSshTransport(sshClient);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Remote command timed out after ${timeoutMs / 1000} seconds`));
      if (!stream) invalidateSshTransport(sshClient);
    }, timeoutMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      sshClient.exec(command, (error, nextStream) => {
        if (settled) {
          terminateRemoteExecStream(nextStream);
          return;
        }
        if (error) {
          finish(error);
          return;
        }
        stream = nextStream;
        stream.on('data', () => { hasOutput = true; });
        stream.stderr?.on?.('data', (data) => {
          stderr.append(data);
        });
        stream.stderr?.once?.('error', (streamError) => finish(streamError));
        stream.once('close', (code) => finish(null, { code, hasOutput, stderr: stderr.end() }));
        stream.once('error', (streamError) => finish(streamError));
      });
    } catch (error) {
      finish(error);
    }
  });
}

function broadcastCompressionEvent(payload) {
  if (!payload?.transferId) return;
  try {
    transferBridge?.broadcastGlobalTransferEvent?.(payload);
  } catch {
    // Global UI fanout is best-effort; the job itself must keep running.
  }
}

function settleCompressionTerminal(compression, type, payload = {}) {
  if (!compression || compression.terminalState) return false;
  compression.terminalState = type;
  broadcastCompressionEvent({
    type,
    transferId: compression.compressionId,
    endedAt: Date.now(),
    ...payload,
  });
  return true;
}

function getCachedCompressionSupport(sftpId) {
  const entry = compressionSupportCache.get(sftpId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    compressionSupportCache.delete(sftpId);
    return null;
  }
  compressionSupportCache.delete(sftpId);
  compressionSupportCache.set(sftpId, entry);
  return entry.value;
}

function cacheCompressionSupport(sftpId, value) {
  compressionSupportCache.delete(sftpId);
  compressionSupportCache.set(sftpId, {
    value,
    expiresAt: Date.now() + COMPRESSION_SUPPORT_CACHE_TTL_MS,
  });
  while (compressionSupportCache.size > MAX_COMPRESSION_SUPPORT_CACHE_ENTRIES) {
    compressionSupportCache.delete(compressionSupportCache.keys().next().value);
  }
  return value;
}

async function resolveCompressedUploadSupport(sftpId, signal) {
  const cached = getCachedCompressionSupport(sftpId);
  if (cached) return cached;
  const localTar = await checkTarAvailable(signal);
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Upload cancelled');
  const remoteTar = localTar ? await checkRemoteTarAvailable(sftpId, signal) : false;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Upload cancelled');
  return cacheCompressionSupport(sftpId, {
    supported: localTar && remoteTar,
    localTar,
    remoteTar,
  });
}

function buildRemoteArchivePath(targetPath, folderName, compressionId) {
  const base = path.posix.basename(String(folderName || 'folder').replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9._-]/g, '_') || 'folder';
  const suffix = createHash('sha256')
    .update(String(compressionId || 'compression'))
    .digest('hex')
    .slice(0, 16);
  return path.posix.join(targetPath, `.${base}.netcatty-${suffix}.tar.gz`);
}

function waitWhilePaused(compression) {
  if (!compression.paused || compression.cancelled) return Promise.resolve();
  broadcastCompressionEvent({
    type: 'paused',
    transferId: compression.compressionId,
    phase: compression.phase,
    lifecycleEpoch: compression.lifecycleEpoch,
    lifecycleState: 'paused',
  });
  return new Promise((resolve) => compression.resumeWaiters.push(resolve));
}

function releasePausedCompression(compression) {
  compression.paused = false;
  const waiters = compression.resumeWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function clearCompressionProcess(compression, processHandle) {
  if (compression.process !== processHandle) return;
  compression.process = null;
  if (compression.processKillTimer) {
    clearTimeout(compression.processKillTimer);
    compression.processKillTimer = null;
  }
}

function terminateCompressionProcess(compression) {
  const processHandle = compression?.process;
  if (!processHandle) return;
  try { processHandle.kill('SIGTERM'); } catch { /* already exited */ }
  if (compression.processKillTimer) clearTimeout(compression.processKillTimer);
  compression.processKillTimer = setTimeout(() => {
    compression.processKillTimer = null;
    if (compression.process !== processHandle) return;
    try { processHandle.kill('SIGKILL'); } catch { /* already exited */ }
  }, LOCAL_TAR_KILL_GRACE_MS);
  compression.processKillTimer.unref?.();
}

/**
 * Initialize the compress upload bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
  transferBridge = deps.transferBridge;
}

/**
 * Check if tar command is available on the system
 */
async function checkTarAvailable(signal) {
  return new Promise((resolve) => {
    const tar = spawn('tar', ['--version'], { stdio: 'ignore' });
    let settled = false;
    let childClosed = false;
    let forceKillTimer = null;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(available);
    };
    const stop = () => {
      try { tar.kill('SIGTERM'); } catch { /* ignore */ }
      if (!childClosed) {
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null;
          if (!childClosed) {
            try { tar.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, LOCAL_TAR_KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }
      finish(false);
    };
    const onAbort = () => stop();
    const timeout = setTimeout(stop, LOCAL_TAR_PROBE_TIMEOUT_MS);
    if (signal?.aborted) {
      stop();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    tar.on('close', (code) => {
      childClosed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finish(code === 0);
    });
    tar.on('error', () => {
      childClosed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finish(false);
    });
  });
}

/**
 * Check if tar command is available on remote server
 */
async function checkRemoteTarAvailable(sftpId, signal) {
  try {
    const client = sftpClients.get(sftpId);
    if (!client) throw new Error("SFTP session not found");
    // Extra exec on a single-channel bastion drops the whole SFTP login.
    // Folder uploads then fall back to per-file SFTP.
    if (client.__netcattySingleChannelSsh) return false;

    // Try to execute tar --version via SSH
    const sshClient = client.client; // Get underlying SSH2 client
    if (!sshClient) throw new Error("SSH client not available");
    
    const result = await runRemoteExec(sshClient, 'tar --version', {
      timeoutMs: REMOTE_TAR_PROBE_TIMEOUT_MS,
      signal,
    });
    return result.code === 0 && result.hasOutput;
  } catch {
    return false;
  }
}

/**
 * Compress a folder using tar
 */
async function compressFolder(folderPath, outputPath, compressionId, sendProgress) {
  return new Promise((resolve, reject) => {
    const compression = activeCompressions.get(compressionId);
    if (!compression) {
      reject(new Error('Compression cancelled'));
      return;
    }

    // Use tar with gzip compression, excluding macOS resource fork files
    // -czf: create, gzip, file
    // -C: change to directory (so we don't include the full path in archive)
    // --exclude='._*': exclude macOS resource fork files
    // --exclude='.DS_Store': exclude macOS folder metadata files
    const folderName = path.basename(folderPath);
    const parentDir = path.dirname(folderPath);
    
    const tar = spawn('tar', [
      '-czf', outputPath, 
      '-C', parentDir, 
      '--exclude=._*',
      '--exclude=.DS_Store',
      '--exclude=.Spotlight-V100',
      '--exclude=.Trashes',
      folderName
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    compression.process = tar;
    const stderr = createBoundedUtf8Collector(MAX_LOCAL_TAR_STDERR_BYTES);

    // Monitor progress by checking output file size periodically
    const progressInterval = setInterval(async () => {
      if (compression.cancelled) {
        clearInterval(progressInterval);
        return;
      }
      
      try {
        const stat = await fs.promises.stat(outputPath);
        // We don't know the final size, so we'll show indeterminate progress
        sendProgress(stat.size, 0); // 0 means indeterminate
      } catch {
        // File doesn't exist yet, ignore
      }
    }, 500);

    tar.stderr.on('data', (data) => {
      stderr.append(data);
    });

    tar.on('close', (code) => {
      clearInterval(progressInterval);
      clearCompressionProcess(compression, tar);
      
      if (compression.cancelled) {
        // Clean up output file if cancelled
        fs.promises.unlink(outputPath).catch(() => {});
        reject(new Error('Compression cancelled'));
        return;
      }
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Tar compression failed: ${stderr.end()}`));
      }
    });

    tar.on('error', (err) => {
      clearInterval(progressInterval);
      clearCompressionProcess(compression, tar);
      reject(new Error(`Failed to start tar: ${err.message}`));
    });
  });
}

/**
 * Extract archive on remote server
 * @param {string} sftpId - SFTP session ID
 * @param {string} archivePath - Path to the archive on remote server
 * @param {string} targetDir - Target directory for extraction
 * @param {number} [archiveSize] - Size of the archive in bytes (optional, for timeout calculation)
 */
async function extractRemoteArchive(
  sftpId,
  archivePath,
  targetDir,
  folderName,
  compressionId,
  archiveSize,
  signal,
) {
  const client = sftpClients.get(sftpId);
  if (!client) throw new Error("SFTP session not found");

  const sshClient = client.client;
  if (!sshClient) throw new Error("SSH client not available");

  // Calculate timeout based on archive size
  // Base: 60 seconds minimum
  // Add 30 seconds per 10MB of archive size
  // Maximum: 10 minutes to prevent excessively long waits
  const baseTimeout = 60000; // 60 seconds minimum
  const maxTimeout = 600000; // 10 minutes maximum
  const sizeBasedTimeout = archiveSize ? Math.ceil(archiveSize / (10 * 1024 * 1024)) * 30000 : 0;
  const extractionTimeout = Math.min(maxTimeout, Math.max(baseTimeout, baseTimeout + sizeBasedTimeout));

  // Extract into a sibling staging directory, then atomically swap the complete
  // folder into place. Existing directory contents are copied into the stage so
  // compressed upload keeps its historical merge semantics.
  const command = buildAtomicRemoteExtractionCommand({
    compressionId,
    archivePath,
    targetDir,
    folderName,
  });
  let result;
  try {
    result = await runRemoteExec(sshClient, command, {
      timeoutMs: extractionTimeout,
      signal,
    });
  } catch (error) {
    if (/timed out/i.test(error?.message || '')) {
      throw new Error(`Remote extraction timed out after ${extractionTimeout / 1000} seconds`);
    }
    throw new Error(`Remote extraction failed: ${error?.message || String(error)}`);
  }
  if (result.code === 0) return;
  throw new Error(`Remote extraction failed: ${result.stderr || `exit code ${result.code}`}`);
}

/**
 * Start compressed folder upload
 */
async function startCompressedUpload(event, payload) {
  const {
    compressionId,
    folderPath,
    targetPath,
    sftpId,
    folderName,
    totalBytes = 0,
  } = payload;
  if (activeCompressions.has(compressionId)) {
    throw new Error(`Compressed upload is already active: ${compressionId}`);
  }
  const sender = event.sender;
  // Register compression for cancellation
  const compression = {
    compressionId,
    cancelled: false,
    process: null,
    processKillTimer: null,
    phase: 'preparing',
    paused: false,
    lifecycleEpoch: Math.max(0, Number(payload.lifecycleEpoch) || 0),
    lifecycleState: 'transferring',
    terminalState: null,
    resumeWaiters: [],
    remoteExecAbortController: new AbortController(),
  };
  activeCompressions.set(compressionId, compression);

  broadcastCompressionEvent({
    type: 'started',
    transferId: compressionId,
    direction: 'upload',
    fileName: `${folderName} (compressed)`,
    sourcePath: folderPath,
    targetPath: `${targetPath}/${folderName}`,
    totalBytes,
    isDirectory: true,
    controlKind: 'compressed-upload',
    phase: 'compressing',
    startedAt: Date.now(),
    lifecycleEpoch: compression.lifecycleEpoch,
    lifecycleState: compression.lifecycleState,
  });

  const sendProgress = (phase, transferred, total) => {
    if (compression.cancelled) return;
    const ratio = total > 0 ? Math.max(0, Math.min(1, transferred / total)) : 0;
    const transferredBytes = Math.floor(ratio * totalBytes);
    sender.send("netcatty:compress:progress", {
      compressionId,
      phase,
      transferred,
      total,
      transferredBytes,
      totalBytes,
      fileName: `${folderName} (compressed)`,
      sourcePath: folderPath,
      targetPath: `${targetPath}/${folderName}`,
      lifecycleEpoch: compression.lifecycleEpoch,
      lifecycleState: compression.lifecycleState,
    });
    broadcastCompressionEvent({
      type: 'progress',
      transferId: compressionId,
      transferred: transferredBytes,
      totalBytes,
      speed: 0,
      phase,
      lifecycleEpoch: compression.lifecycleEpoch,
      lifecycleState: compression.lifecycleState,
    });
  };

  const sendComplete = () => {
    if (compression.terminalState) return;
    // Send final 100% progress before completion
    if (!compression.cancelled) {
      sendProgress('extracting', 100, 100);
    }
    if (!settleCompressionTerminal(compression, 'completed', {
      transferred: totalBytes,
      totalBytes,
    })) return;
    sender.send("netcatty:compress:complete", { compressionId });
  };

  const sendError = (error) => {
    if (!settleCompressionTerminal(compression, 'failed', {
      error: error.message || String(error),
    })) return;
    sender.send("netcatty:compress:error", {
      compressionId,
      error: error.message || String(error),
    });
  };

  const sendCancelled = () => {
    if (!settleCompressionTerminal(compression, 'cancelled')) return;
    sender.send("netcatty:compress:cancelled", { compressionId });
  };

  // Declare tempArchivePath in outer scope for cleanup access
  let tempArchivePath = null;
  const lifecycleLeaseId = `compress-lifecycle:${compressionId}`;
  let lifecycleLeasedSftpIds = [];

  try {
    if (
      !transferBridge?.acquireTransferSessionLeases
      || !transferBridge?.releaseTransferSessionLeases
    ) {
      throw new Error("Transfer runtime session leasing is unavailable");
    }
    // The archive upload has its own short-lived transfer lease, but probe,
    // compression, extraction and cleanup also use this SFTP/SSH handle. Hold
    // one outer lease so closing the browse tab soft-closes instead of tearing
    // down the connection halfway through the operation.
    lifecycleLeasedSftpIds = transferBridge.acquireTransferSessionLeases(
      lifecycleLeaseId,
      { targetSftpId: sftpId },
    );

    // Reuse the short-lived result produced by the renderer's support check.
    // A cache miss still performs one bounded, cancellable probe here.
    const support = await resolveCompressedUploadSupport(
      sftpId,
      compression.remoteExecAbortController.signal,
    );
    if (!support.localTar) {
      throw new Error("tar command not available on local system. Please install tar.");
    }
    if (!support.remoteTar) {
      throw new Error("tar command not available on remote server. Please install tar on the remote system.");
    }

    // Phase 1: Compression (0-30%)
    compression.phase = 'compressing';
    await waitWhilePaused(compression);
    sendProgress('compressing', 0, 100);
    
    tempArchivePath = getTempFilePath(`${folderName}.tar.gz`);
    
    await compressFolder(folderPath, tempArchivePath, compressionId, (transferred) => {
      // Show compression progress (0-30%)
      sendProgress('compressing', Math.min(30, transferred / 1024 / 1024), 100);
    });

    if (compression.cancelled) {
      try {
        await fs.promises.unlink(tempArchivePath);
      } catch {
        // Ignore cleanup errors
      }
      throw new Error('Upload cancelled');
    }

    // Get compressed file size
    const stat = await fs.promises.stat(tempArchivePath);
    const compressedSize = stat.size;
    
    sendProgress('compressing', 30, 100);

    // Phase 2: Upload (30-90%)
    compression.phase = 'uploading';
    await waitWhilePaused(compression);
    sendProgress('uploading', 30, 100);

    const remoteArchivePath = buildRemoteArchivePath(targetPath, folderName, compressionId);

    // Use existing transfer bridge for upload with progress
    const transferId = `compress-${compressionId}`;

    // Progress callback to map upload progress to 30-90%
    const onUploadProgress = (transferred, total, _speed) => {
      if (compression.cancelled) return;
      compression.checkpointBytes = transferred;
      const uploadProgress = Math.min(60, (transferred / total) * 60);
      sendProgress('uploading', 30 + uploadProgress, 100);
    };

    // Start the transfer with progress callback
    const uploadResult = await transferBridge.startInternalTransfer(event, {
      transferId,
      sourcePath: tempArchivePath,
      targetPath: remoteArchivePath,
      sourceType: 'local',
      targetType: 'sftp',
      targetSftpId: sftpId,
      totalBytes: compressedSize,
      resumable: true,
      checkpointBytes: compression.checkpointBytes || 0,
    }, onUploadProgress);
    if (uploadResult?.error) {
      throw new Error(uploadResult.error);
    }

    if (compression.cancelled) {
      await fs.promises.unlink(tempArchivePath).catch(() => {});
      throw new Error('Upload cancelled');
    }

    // Upload completed, update to 90%
    sendProgress('uploading', 90, 100);

    // Phase 3: Extraction (90-100%)
    compression.phase = 'extracting';
    await waitWhilePaused(compression);
    sendProgress('extracting', 90, 100);

    await runWithCompressionTargetLock(
      resolveCompressionTargetKey(sftpId, targetPath, folderName),
      compression.remoteExecAbortController.signal,
      () => extractRemoteArchive(
        sftpId,
        remoteArchivePath,
        targetPath,
        folderName,
        compressionId,
        compressedSize,
        compression.remoteExecAbortController.signal,
      ),
    );

    // Extraction is an atomic remote step. A pause requested during extraction
    // takes effect here, before completion is published.
    await waitWhilePaused(compression);

    // Update progress to 95% after extraction
    sendProgress('extracting', 95, 100);

    // Keep the outer SFTP lease until best-effort archive cleanup settles.
    // The extraction command already excludes macOS AppleDouble files. Never
    // run a parent-directory-wide find/delete here: that can remove unrelated,
    // pre-existing files whose names happen to begin with "._".
    try {
      const client = sftpClients.get(sftpId);
      if (client && client.client && client.client.writable !== false) {
        await runRemoteExec(client.client, `rm -f ${escapeShellArg(remoteArchivePath)}`, {
          timeoutMs: REMOTE_CLEANUP_TIMEOUT_MS,
          signal: compression.remoteExecAbortController.signal,
        });
      }
    } catch {
      // Cleanup is best-effort; staging/promotion already committed atomically.
    }

    // Clean up local temp file
    try {
      await fs.promises.unlink(tempArchivePath);
    } catch {
      // Ignore cleanup errors
    }

    // Check if cancelled during extraction before reporting completion
    if (compression.cancelled) {
      sendCancelled();
      return { compressionId, cancelled: true };
    }

    sendComplete();

    return { compressionId, success: true };
  } catch (err) {
    // Clean up local temp file if it exists
    if (tempArchivePath) {
      try {
        await fs.promises.unlink(tempArchivePath);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (err.message === 'Upload cancelled' || err.message === 'Compression cancelled' || err.message === 'Transfer cancelled') {
      sendCancelled();
    } else {
      sendError(err.message || 'Unknown error occurred');
    }
    return { compressionId, error: err.message };
  } finally {
    // Always clean up the active compression entry
    try {
      compression.remoteExecAbortController.abort(new Error('Compression finished'));
    } catch { /* ignore */ }
    if (lifecycleLeasedSftpIds.length > 0) {
      transferBridge.releaseTransferSessionLeases(
        lifecycleLeaseId,
        lifecycleLeasedSftpIds,
      );
      lifecycleLeasedSftpIds = [];
    }
    if (activeCompressions.get(compressionId) === compression) {
      activeCompressions.delete(compressionId);
    }
  }
}

/**
 * Cancel a compression operation
 */
async function cancelCompression(event, payload) {
  const { compressionId } = payload;
  const compression = activeCompressions.get(compressionId);

  if (compression && !compression.terminalState) {
    compression.cancelled = true;
    settleCompressionTerminal(compression, 'cancelled');
    event?.sender?.send?.("netcatty:compress:cancelled", { compressionId });
    releasePausedCompression(compression);
    try {
      compression.remoteExecAbortController?.abort(new Error('Upload cancelled'));
    } catch { /* ignore */ }

    terminateCompressionProcess(compression);

    // Cancel the associated transfer if it's running
    const transferId = `compress-${compressionId}`;
    if (transferBridge && transferBridge.cancelTransfer) {
      try {
        await transferBridge.cancelTransfer(event, { transferId });
      } catch {
        // Ignore errors when cancelling transfer
      }
    }
  }

  return compression
    ? { success: true }
    : { success: false, reason: 'Compression is not active' };
}

async function pauseCompression(event, payload) {
  const { compressionId } = payload;
  const compression = activeCompressions.get(compressionId);
  if (!compression || compression.cancelled) {
    return { success: false, reason: 'Compression is not active' };
  }

  if (compression.paused) return { success: true, deferred: compression.phase === 'extracting' };
  compression.paused = true;
  compression.lifecycleEpoch += 1;
  compression.lifecycleState = 'pausing';

  if (compression.phase === 'compressing' && compression.process && process.platform !== 'win32') {
    try {
      compression.process.kill('SIGSTOP');
    } catch {
      // The process may have completed between the phase check and signal.
    }
  }
  if (compression.phase === 'uploading' && transferBridge?.pauseTransfer) {
    const result = await transferBridge.pauseTransfer(event, { transferId: `compress-${compressionId}` });
    if (!result?.success) {
      compression.paused = false;
      compression.lifecycleEpoch += 1;
      compression.lifecycleState = 'transferring';
      broadcastCompressionEvent({
        type: 'resumed',
        transferId: compressionId,
        phase: compression.phase,
        lifecycleEpoch: compression.lifecycleEpoch,
        lifecycleState: compression.lifecycleState,
      });
      return result || { success: false, reason: 'Upload pause is unavailable' };
    }
  }

  const deferred = compression.phase === 'extracting' || (compression.phase === 'compressing' && process.platform === 'win32');
  compression.lifecycleState = deferred ? 'pausing' : 'paused';
  broadcastCompressionEvent({
    type: deferred ? 'pausing' : 'paused',
    transferId: compressionId,
    phase: compression.phase,
    lifecycleEpoch: compression.lifecycleEpoch,
    lifecycleState: compression.lifecycleState,
  });
  return { success: true, deferred, lifecycleEpoch: compression.lifecycleEpoch };
}

async function resumeCompression(event, payload) {
  const { compressionId } = payload;
  const compression = activeCompressions.get(compressionId);
  if (!compression || compression.cancelled) {
    return { success: false, reason: 'Compression is not active' };
  }

  if (compression.phase === 'compressing' && compression.process && process.platform !== 'win32') {
    try {
      compression.process.kill('SIGCONT');
    } catch {
      // The process may have completed while the request was in flight.
    }
  }
  if (compression.phase === 'uploading' && transferBridge?.resumeTransfer) {
    const result = await transferBridge.resumeTransfer(event, { transferId: `compress-${compressionId}` });
    if (!result?.success) return result || { success: false, reason: 'Upload resume is unavailable' };
  }
  compression.lifecycleEpoch += 1;
  compression.lifecycleState = 'transferring';
  releasePausedCompression(compression);
  broadcastCompressionEvent({
    type: 'resumed',
    transferId: compressionId,
    phase: compression.phase,
    lifecycleEpoch: compression.lifecycleEpoch,
    lifecycleState: compression.lifecycleState,
  });
  return { success: true, lifecycleEpoch: compression.lifecycleEpoch };
}

/**
 * Check if compressed upload is supported (tar available on both local and remote)
 */
async function checkCompressedUploadSupport(event, payload) {
  const { sftpId } = payload;
  
  try {
    return await resolveCompressedUploadSupport(sftpId);
  } catch (err) {
    return {
      supported: false,
      localTar: false,
      remoteTar: false,
      error: err.message
    };
  }
}

function registerWorkerHandle(ipcMain, terminalWorkerManager, channel) {
  ipcMain.handle(channel, (event, payload) => terminalWorkerManager.request(channel, payload, {
    webContentsId: event?.sender?.id,
  }));
}

/**
 * Register IPC handlers
 */
function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;
  if (terminalWorkerManager) {
    const workerRequest = (event, channel, payload) => terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    });
    const nextEpoch = (compressionId, suggestedEpoch) => {
      const entry = workerCompressionLifecycleEpochs.get(compressionId);
      const current = Math.max(0, Number(entry?.epoch) || 0);
      const suggested = Number(suggestedEpoch);
      const next = Number.isFinite(suggested) && suggested > current ? suggested : current + 1;
      if (entry) entry.epoch = next;
      return next;
    };
    ipcMain.handle("netcatty:compress:start", (event, payload) => {
      let lifecycleEntry = null;
      if (payload?.compressionId) {
        lifecycleEntry = {
          epoch: Math.max(0, Number(payload.lifecycleEpoch) || 0),
        };
        workerCompressionLifecycleEpochs.set(payload.compressionId, lifecycleEntry);
      }
      const releaseLifecycleEntry = () => {
        if (
          payload?.compressionId
          && workerCompressionLifecycleEpochs.get(payload.compressionId) === lifecycleEntry
        ) {
          workerCompressionLifecycleEpochs.delete(payload.compressionId);
        }
      };
      try {
        return Promise.resolve(workerRequest(event, "netcatty:compress:start", payload))
          .finally(releaseLifecycleEntry);
      } catch (error) {
        releaseLifecycleEntry();
        throw error;
      }
    });
    ipcMain.handle("netcatty:compress:pause", async (event, payload) => {
      const lifecycleEpoch = nextEpoch(payload?.compressionId);
      broadcastCompressionEvent({
        type: 'pausing',
        transferId: payload?.compressionId,
        lifecycleEpoch,
        lifecycleState: 'pausing',
      });
      try {
        const result = await workerRequest(event, "netcatty:compress:pause", payload);
        if (!result?.success) {
          const rollbackEpoch = nextEpoch(payload?.compressionId);
          broadcastCompressionEvent({
            type: 'resumed',
            transferId: payload?.compressionId,
            lifecycleEpoch: rollbackEpoch,
            lifecycleState: 'transferring',
          });
          return result;
        }
        const lifecycleState = result.deferred ? 'pausing' : 'paused';
        broadcastCompressionEvent({
          type: lifecycleState,
          transferId: payload?.compressionId,
          lifecycleEpoch,
          lifecycleState,
        });
        return result;
      } catch (error) {
        const rollbackEpoch = nextEpoch(payload?.compressionId);
        broadcastCompressionEvent({
          type: 'resumed',
          transferId: payload?.compressionId,
          lifecycleEpoch: rollbackEpoch,
          lifecycleState: 'transferring',
        });
        throw error;
      }
    });
    ipcMain.handle("netcatty:compress:resume", async (event, payload) => {
      const result = await workerRequest(event, "netcatty:compress:resume", payload);
      if (result?.success) {
        const lifecycleEpoch = nextEpoch(payload?.compressionId, result.lifecycleEpoch);
        broadcastCompressionEvent({
          type: 'resumed',
          transferId: payload?.compressionId,
          lifecycleEpoch,
          lifecycleState: 'transferring',
        });
      }
      return result;
    });
    [
      "netcatty:compress:cancel",
      "netcatty:compress:checkSupport",
    ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel));
    return;
  }
  ipcMain.handle("netcatty:compress:start", startCompressedUpload);
  ipcMain.handle("netcatty:compress:cancel", cancelCompression);
  ipcMain.handle("netcatty:compress:pause", pauseCompression);
  ipcMain.handle("netcatty:compress:resume", resumeCompression);
  ipcMain.handle("netcatty:compress:checkSupport", checkCompressedUploadSupport);
}

module.exports = {
  init,
  registerHandlers,
  pauseCompression,
  resumeCompression,
  _checkCompressedUploadSupportForTests: checkCompressedUploadSupport,
  _runRemoteExecForTests: runRemoteExec,
  _buildAtomicRemoteExtractionCommandForTests: buildAtomicRemoteExtractionCommand,
  _buildRemoteArchivePathForTests: buildRemoteArchivePath,
  _createBoundedUtf8CollectorForTests: createBoundedUtf8Collector,
  _getActiveCompressionCountForTests: () => activeCompressions.size,
  _getWorkerCompressionLifecycleEpochCountForTests: () => workerCompressionLifecycleEpochs.size,
  _resetCompressionSupportCacheForTests: () => compressionSupportCache.clear(),
  _runWithCompressionTargetLockForTests: runWithCompressionTargetLock,
  _buildCompressionTargetKeyForTests: buildCompressionTargetKey,
  _resolveCompressionTargetKeyForTests: resolveCompressionTargetKey,
  _getCompressionTargetLockCountForTests: () => compressionTargetLocks.size,
};
