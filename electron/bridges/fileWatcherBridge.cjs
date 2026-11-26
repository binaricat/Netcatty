/**
 * File Watcher Bridge - Watches local temp files for changes to sync back to remote
 * 
 * This bridge enables auto-sync functionality for files opened with external applications.
 * When a file is downloaded to temp and opened with an external app, we watch for changes
 * and automatically upload them back to the remote server.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { registerWorkerHandle } = require("./workerIpcProxy.cjs");

// Map of watchId -> { watcher, localPath, remotePath, sftpId, lastModified, lastSize }
const activeWatchers = new Map();
const activeWatchIdsByKey = new Map();
const observedOwnerSenders = new WeakSet();
const pendingWatchStarts = new Set();
const MAX_ACTIVE_FILE_WATCHERS = 256;
const TEMP_FILE_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];

// Debounce map to prevent multiple rapid syncs
const debounceTimers = new Map();

// Map of sftpId -> Map<localPath, Set<webContentsId>> to track temp files even without watching
// This allows cleanup when SFTP session closes, regardless of auto-sync setting
const tempFilesMap = new Map();

let sftpClients = null;
let electronModule = null;
let transferBridge = null;

/**
 * Initialize the file watcher bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
  transferBridge = deps.transferBridge || null;
}

/**
 * Register a temp file for cleanup when SFTP session closes
 * Called regardless of whether auto-sync is enabled
 */
function getOwnerId(sender, fallback) {
  if (Number.isSafeInteger(sender?.id)) return sender.id;
  return Number.isSafeInteger(fallback) ? fallback : null;
}

function buildWatchKey(sftpId, localPath, remotePath) {
  return `${sftpId}\0${path.resolve(localPath)}\0${remotePath}`;
}

function registerTempFile(sftpId, localPath, ownerId = null) {
  if (!tempFilesMap.has(sftpId)) {
    tempFilesMap.set(sftpId, new Map());
  }
  const files = tempFilesMap.get(sftpId);
  const owners = files.get(localPath) ?? new Set();
  if (Number.isSafeInteger(ownerId)) owners.add(ownerId);
  files.set(localPath, owners);
  console.log(`[FileWatcher] Registered temp file for cleanup: ${localPath} (session: ${sftpId})`);
}

function releaseTempFileReference(
  sftpId,
  localPath,
  ownerId,
  { force = false, cleanup = false } = {},
) {
  const files = tempFilesMap.get(sftpId);
  const owners = files?.get(localPath);
  if (!files || !owners) return false;

  if (!force && ownerId != null) owners.delete(ownerId);
  if (!force && ownerId != null && owners.size > 0) return false;

  files.delete(localPath);
  if (files.size === 0) tempFilesMap.delete(sftpId);
  if (cleanup) cleanupTempFileAsync(localPath);
  return true;
}

async function unregisterTempFile(event, payload = {}) {
  const { sftpId, localPath } = payload;
  if (!sftpId || !localPath) return { success: false };
  const ownerId = getOwnerId(event?.sender, payload.webContentsId);
  const wasTracked = tempFilesMap.get(sftpId)?.has(localPath) === true;
  releaseTempFileReference(sftpId, localPath, ownerId, {
    force: ownerId == null,
    cleanup: false,
  });
  const retained = tempFilesMap.get(sftpId)?.has(localPath) === true;
  if (!retained) await cleanupTempFileAsync(localPath);
  return { success: true, retained, wasTracked };
}

function hasOtherOwnedWatch(sftpId, localPath, ownerId, excludedWatchId) {
  if (ownerId == null) return false;
  for (const [watchId, watchInfo] of activeWatchers) {
    if (watchId === excludedWatchId) continue;
    if (watchInfo.sftpId !== sftpId || watchInfo.localPath !== localPath) continue;
    if (watchInfo.owners.has(ownerId)) return true;
  }
  return false;
}

function observeOwnerSender(sender) {
  if (!sender || typeof sender !== "object" || observedOwnerSenders.has(sender)) return;
  observedOwnerSenders.add(sender);
  sender.once?.("destroyed", () => {
    const ownerId = getOwnerId(sender);
    if (ownerId != null) releaseOwnerResources(ownerId, true);
  });
}

/**
 * Show a system notification for file sync events
 * Works on macOS, Windows, and Linux
 */
function showSystemNotification(title, body) {
  try {
    if (!electronModule?.Notification) {
      console.warn("[FileWatcher] Electron Notification API not available");
      return;
    }
    
    const { Notification } = electronModule;
    
    // Check if notifications are supported
    if (!Notification.isSupported()) {
      console.warn("[FileWatcher] System notifications not supported on this platform");
      return;
    }
    
    const notification = new Notification({
      title,
      body,
      silent: false, // Allow notification sound
    });
    
    notification.show();
  } catch (err) {
    console.warn("[FileWatcher] Failed to show system notification:", err.message);
  }
}

/**
 * Start watching a local file for changes
 * Returns a watchId that can be used to stop watching
 */
async function startWatching(event, { localPath, remotePath, sftpId, encoding }) {
  const ownerId = getOwnerId(event?.sender);
  observeOwnerSender(event?.sender);
  const watchKey = buildWatchKey(sftpId, localPath, remotePath);
  const existingWatchId = activeWatchIdsByKey.get(watchKey);
  const existingWatch = existingWatchId ? activeWatchers.get(existingWatchId) : null;
  if (existingWatch) {
    if (ownerId != null) existingWatch.owners.set(ownerId, event.sender);
    existingWatch.encoding = encoding;
    return { watchId: existingWatchId, reused: true };
  }
  if (activeWatchers.size + pendingWatchStarts.size >= MAX_ACTIVE_FILE_WATCHERS) {
    throw new Error(`Too many active external file watches (max ${MAX_ACTIVE_FILE_WATCHERS})`);
  }
  const watchId = `watch-${crypto.randomUUID()}`;
  const pendingStart = { watchId, watchKey, sftpId, ownerId, cancelled: false };
  pendingWatchStarts.add(pendingStart);
  
  console.log(`[FileWatcher] Starting watch: ${localPath} -> ${remotePath}`);
  
  // Get initial file stats
  let lastModified;
  let lastSize;
  try {
    const stat = await fs.promises.stat(localPath);
    lastModified = stat.mtimeMs;
    lastSize = stat.size;
    console.log(`[FileWatcher] Initial file stats: mtime=${lastModified}, size=${lastSize}`);
  } catch (err) {
    pendingWatchStarts.delete(pendingStart);
    console.error(`[FileWatcher] Failed to stat file ${localPath}:`, err.message);
    throw new Error(`Cannot watch file: ${err.message}`);
  }

  if (pendingStart.cancelled) {
    pendingWatchStarts.delete(pendingStart);
    throw new Error("File watch start cancelled because its owner or SFTP session closed");
  }

  // Two identical starts can overlap during the async stat. Re-check after the
  // await so only the first continuation installs a polling listener.
  const racedWatchId = activeWatchIdsByKey.get(watchKey);
  const racedWatch = racedWatchId ? activeWatchers.get(racedWatchId) : null;
  if (racedWatch) {
    if (ownerId != null) racedWatch.owners.set(ownerId, event.sender);
    racedWatch.encoding = encoding;
    pendingWatchStarts.delete(pendingStart);
    return { watchId: racedWatchId, reused: true };
  }
  
  // Use fs.watchFile (polling) instead of fs.watch for better reliability on Windows
  // fs.watch can miss events when editors use atomic writes (save to temp, then rename)
  // fs.watchFile polls the file system at regular intervals
  const pollInterval = 1000; // Check every 1 second
  
  const listener = async (curr, prev) => {
    console.log(`[FileWatcher] File stat change detected for ${localPath}`);
    console.log(`[FileWatcher]   Previous: mtime=${prev.mtimeMs}, size=${prev.size}`);
    console.log(`[FileWatcher]   Current: mtime=${curr.mtimeMs}, size=${curr.size}`);
    
    // Check if file was deleted
    if (curr.nlink === 0) {
      console.log(`[FileWatcher] File ${localPath} was deleted, stopping watch`);
      stopWatching(null, { watchId, force: true, cleanupTempFile: true });
      return;
    }
    
    // Check if file was actually modified
    if (curr.mtimeMs <= prev.mtimeMs && curr.size === prev.size) {
      console.log(`[FileWatcher] File unchanged, skipping`);
      return;
    }
    
    // Debounce rapid changes (e.g., multiple saves in quick succession)
    const existingTimer = debounceTimers.get(watchId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timer = setTimeout(async () => {
      debounceTimers.delete(watchId);
      await handleFileChange(watchId);
    }, 500); // 500ms debounce

    debounceTimers.set(watchId, timer);
  };
  try {
    fs.watchFile(localPath, { persistent: true, interval: pollInterval }, listener);

    activeWatchers.set(watchId, {
      watcher: null, // fs.watchFile doesn't return a watcher object
      localPath,
      remotePath,
      sftpId,
      encoding,
      lastModified,
      lastSize,
      listener,
      watchKey,
      owners: new Map(ownerId == null ? [] : [[ownerId, event.sender]]),
      activeTransferId: null,
      syncPromise: null,
      syncRequested: false,
      syncSequence: 0,
      stopped: false,
      useWatchFile: true, // Flag to indicate we're using fs.watchFile
    });
    activeWatchIdsByKey.set(watchKey, watchId);
  } finally {
    pendingWatchStarts.delete(pendingStart);
  }
  
  console.log(`[FileWatcher] Watch started with ID: ${watchId} (using fs.watchFile polling every ${pollInterval}ms)`);
  return { watchId };
}

/**
 * Handle file change event - sync to remote
 */
function notifyWatchOwners(watchInfo, channel, payload) {
  for (const [ownerId, webContents] of [...watchInfo.owners]) {
    if (webContents?.isDestroyed?.()) {
      watchInfo.owners.delete(ownerId);
      continue;
    }
    webContents?.send?.(channel, payload);
  }
}

async function syncFileChangeOnce(watchId, watchInfo) {
  if (watchInfo.stopped || activeWatchers.get(watchId) !== watchInfo) return;
  
  const { localPath, remotePath, sftpId, encoding, lastModified: previousModified, lastSize: previousSize } = watchInfo;

  // Extract file name once for notifications and logging
  const fileName = path.basename(remotePath);
  
  console.log(`[FileWatcher] File change detected: ${localPath}`);
  
  // Check if file was actually modified (compare mtime and size).
  const stat = await fs.promises.stat(localPath);
  if (stat.mtimeMs <= previousModified && stat.size === previousSize) {
    console.log(`[FileWatcher] File unchanged (mtime and size same), skipping sync`);
    return;
  }

  // Record the observed version before the upload. A save that lands while the
  // stream is running triggers another watcher tick and is serialized below.
  watchInfo.lastModified = stat.mtimeMs;
  watchInfo.lastSize = stat.size;

  if (!sftpClients?.has(sftpId)) throw new Error("SFTP session not found or expired");
  if (!transferBridge?.startInternalTransfer) throw new Error("Transfer runtime not initialized");
  if (watchInfo.stopped || activeWatchers.get(watchId) !== watchInfo) return;

  const transferId = `filewatch-${watchId}-${++watchInfo.syncSequence}`;
  watchInfo.activeTransferId = transferId;
  let warning;
  console.log(`[FileWatcher] Streaming ${stat.size} bytes to ${remotePath}`);
  try {
    const result = await transferBridge.startInternalTransfer(null, {
      transferId,
      sourcePath: localPath,
      targetPath: remotePath,
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: sftpId,
      targetEncoding: encoding,
      totalBytes: stat.size,
      resumable: false,
      sourceIsOwnedTemp: false,
    });
    if (result?.cancelled || /cancel/i.test(result?.error || "")) {
      throw new Error("Transfer cancelled");
    }
    if (result?.error) throw new Error(result.error);
    warning = result?.warning;
  } finally {
    if (watchInfo.activeTransferId === transferId) watchInfo.activeTransferId = null;
  }

  if (watchInfo.stopped || activeWatchers.get(watchId) !== watchInfo) return;
  console.log(`[FileWatcher] Sync complete: ${remotePath}`);
  showSystemNotification("Netcatty", warning || `File synced to remote: ${fileName}`);
  notifyWatchOwners(watchInfo, "netcatty:filewatch:synced", {
    watchId,
    localPath,
    remotePath,
    bytesWritten: stat.size,
    ...(warning ? { warning } : {}),
  });
}

async function handleFileChange(watchId) {
  const watchInfo = activeWatchers.get(watchId);
  if (!watchInfo || watchInfo.stopped) return;
  watchInfo.syncRequested = true;
  if (watchInfo.syncPromise) return watchInfo.syncPromise;

  const syncPromise = (async () => {
    while (
      watchInfo.syncRequested
      && !watchInfo.stopped
      && activeWatchers.get(watchId) === watchInfo
    ) {
      watchInfo.syncRequested = false;
      try {
        await syncFileChangeOnce(watchId, watchInfo);
      } catch (err) {
        // A newer save already queued behind this attempt will be retried; avoid
        // flashing a stale failure for the superseded version.
        if (watchInfo.stopped || activeWatchers.get(watchId) !== watchInfo) break;
        if (watchInfo.syncRequested) continue;
        const message = err?.message || String(err);
        console.error(`[FileWatcher] Sync failed for ${watchInfo.localPath}:`, message);
        showSystemNotification(
          "Netcatty",
          `Failed to sync ${path.basename(watchInfo.remotePath)}: ${message}`,
        );
        notifyWatchOwners(watchInfo, "netcatty:filewatch:error", {
          watchId,
          localPath: watchInfo.localPath,
          remotePath: watchInfo.remotePath,
          error: message,
        });
      }
    }
  })().finally(() => {
    if (watchInfo.syncPromise === syncPromise) watchInfo.syncPromise = null;
  });
  watchInfo.syncPromise = syncPromise;
  return syncPromise;
}

/**
 * Stop watching a file and optionally clean up the temp file
 */
function stopWatching(event, {
  watchId,
  cleanupTempFile = false,
  force = false,
  webContentsId,
}) {
  const watchInfo = activeWatchers.get(watchId);
  if (!watchInfo) {
    console.log(`[FileWatcher] Watch ID not found: ${watchId}`);
    return { success: false };
  }
  
  const ownerId = getOwnerId(event?.sender, webContentsId);
  let tempFileCleanupQueued = false;
  if (force) {
    notifyWatchOwners(watchInfo, "netcatty:filewatch:stopped", {
      watchId,
      localPath: watchInfo.localPath,
      remotePath: watchInfo.remotePath,
      sftpId: watchInfo.sftpId,
    });
  }
  if (!force && ownerId != null) {
    if (!watchInfo.owners.delete(ownerId)) return { success: false };
    if (cleanupTempFile && !hasOtherOwnedWatch(
      watchInfo.sftpId,
      watchInfo.localPath,
      ownerId,
      watchId,
    )) {
      tempFileCleanupQueued = releaseTempFileReference(
        watchInfo.sftpId,
        watchInfo.localPath,
        ownerId,
        {
          cleanup: true,
        },
      );
    }
    if (watchInfo.owners.size > 0) return { success: true, retained: true };
  }

  console.log(`[FileWatcher] Stopping watch: ${watchInfo.localPath}`);
  watchInfo.stopped = true;
  watchInfo.syncRequested = false;
  const activeTransferId = watchInfo.activeTransferId;
  watchInfo.activeTransferId = null;
  if (activeTransferId && transferBridge?.cancelTransfer) {
    void Promise.resolve(transferBridge.cancelTransfer(null, { transferId: activeTransferId })).catch(() => {});
  }
  
  // Clear debounce timer if any
  const timer = debounceTimers.get(watchId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(watchId);
  }
  
  // Stop the watcher
  try {
    if (watchInfo.useWatchFile) {
      // Using fs.watchFile - need to use fs.unwatchFile
      fs.unwatchFile(watchInfo.localPath, watchInfo.listener);
    } else if (watchInfo.watcher) {
      // Using fs.watch - close the watcher
      watchInfo.watcher.close();
    }
  } catch (err) {
    console.warn(`[FileWatcher] Error stopping watcher:`, err.message);
  }
  
  // Clean up temp file if requested
  if (
    cleanupTempFile
    && !tempFileCleanupQueued
    && watchInfo.localPath
    && !hasOtherOwnedWatch(watchInfo.sftpId, watchInfo.localPath, ownerId, watchId)
  ) {
    const releasedRegisteredFile = releaseTempFileReference(
      watchInfo.sftpId,
      watchInfo.localPath,
      ownerId,
      { force: force || ownerId == null, cleanup: true },
    );
    if (!releasedRegisteredFile) cleanupTempFileAsync(watchInfo.localPath);
  }
  
  activeWatchers.delete(watchId);
  if (activeWatchIdsByKey.get(watchInfo.watchKey) === watchId) {
    activeWatchIdsByKey.delete(watchInfo.watchKey);
  }
  
  return { success: true };
}

/**
 * Asynchronously delete a temp file, logging success and silently handling failures
 */
async function cleanupTempFileAsync(filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.unlink(filePath);
      console.log(`[FileWatcher] Temp file cleaned up: ${filePath}`);
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return true;
      const retryable = err?.code === "EBUSY"
        || err?.code === "EPERM"
        || err?.code === "EACCES";
      const delayMs = TEMP_FILE_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (!retryable || delayMs == null) {
        console.log(`[FileWatcher] Could not delete temp file (may be in use): ${filePath}`);
        return false;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        // Cleanup is best-effort and must not keep Electron alive during quit.
        timer.unref?.();
      });
    }
  }
}

/**
 * Stop all watchers for a specific SFTP session and clean up temp files
 * Called when SFTP connection is closed
 */
function stopWatchersForSession(sftpId, cleanupTempFiles = true) {
  let watcherCount = 0;
  for (const pendingStart of pendingWatchStarts) {
    if (pendingStart.sftpId === sftpId) pendingStart.cancelled = true;
  }
  
  // Stop active watchers
  for (const [watchId, watchInfo] of activeWatchers.entries()) {
    if (watchInfo.sftpId === sftpId) {
      stopWatching(null, { watchId, cleanupTempFile: cleanupTempFiles, force: true });
      watcherCount++;
    }
  }
  if (watcherCount > 0) {
    console.log(`[FileWatcher] Stopped ${watcherCount} watcher(s) for SFTP session: ${sftpId}`);
  }
  
  // Clean up any registered temp files that weren't being watched
  if (cleanupTempFiles && tempFilesMap.has(sftpId)) {
    const tempFiles = tempFilesMap.get(sftpId);
    let cleanedCount = 0;
    for (const filePath of tempFiles.keys()) {
      cleanupTempFileAsync(filePath);
      cleanedCount++;
    }
    tempFilesMap.delete(sftpId);
    if (cleanedCount > 0) {
      console.log(`[FileWatcher] Queued cleanup for ${cleanedCount} temp file(s) for SFTP session: ${sftpId}`);
    }
  }
}

function releaseOwnerResources(webContentsId, cleanupTempFiles = true) {
  if (!Number.isSafeInteger(webContentsId)) return { removed: 0 };
  for (const pendingStart of pendingWatchStarts) {
    if (pendingStart.ownerId === webContentsId) pendingStart.cancelled = true;
  }
  let removed = 0;
  for (const [watchId, watchInfo] of [...activeWatchers]) {
    if (!watchInfo.owners.has(webContentsId)) continue;
    const result = stopWatching(null, {
      watchId,
      cleanupTempFile: false,
      webContentsId,
    });
    if (result.success) removed += 1;
  }
  for (const [sftpId, files] of [...tempFilesMap]) {
    for (const [filePath, owners] of [...files]) {
      if (!owners.has(webContentsId)) continue;
      releaseTempFileReference(sftpId, filePath, webContentsId, {
        cleanup: cleanupTempFiles,
      });
    }
    if (files.size === 0) tempFilesMap.delete(sftpId);
  }
  return { removed };
}

/**
 * Get list of active watchers
 */
function listWatchers() {
  const watchers = [];
  for (const [watchId, info] of activeWatchers.entries()) {
    watchers.push({
      watchId,
      localPath: info.localPath,
      remotePath: info.remotePath,
      sftpId: info.sftpId,
    });
  }
  return watchers;
}

/**
 * Register IPC handlers for file watching operations
 */
function registerHandlers(ipcMain, options = {}) {
  console.log("[FileWatcher] Registering IPC handlers");
  const terminalWorkerManager = options.terminalWorkerManager || null;
  if (terminalWorkerManager) {
    const observedSenders = new WeakSet();
    const observeSender = (sender) => {
      if (!sender || typeof sender !== "object" || observedSenders.has(sender)) return;
      observedSenders.add(sender);
      sender.once?.("destroyed", () => {
        void terminalWorkerManager.request(
          "netcatty:filewatch:releaseOwner",
          { webContentsId: sender.id, cleanupTempFiles: true },
          { webContentsId: sender.id },
        ).catch(() => {});
      });
    };
    for (const channel of [
      "netcatty:filewatch:start",
      "netcatty:filewatch:registerTempFile",
      "netcatty:filewatch:unregisterTempFile",
    ]) {
      ipcMain.handle(channel, (event, payload) => {
        observeSender(event?.sender);
        return terminalWorkerManager.request(channel, payload, { webContentsId: event?.sender?.id });
      });
    }
    for (const channel of ["netcatty:filewatch:stop", "netcatty:filewatch:list"]) {
      registerWorkerHandle(ipcMain, terminalWorkerManager, channel);
    }
    return;
  }
  ipcMain.handle("netcatty:filewatch:start", (event, args) => {
    console.log("[FileWatcher] IPC netcatty:filewatch:start received", args);
    return startWatching(event, args);
  });
  ipcMain.handle("netcatty:filewatch:stop", stopWatching);
  ipcMain.handle("netcatty:filewatch:list", listWatchers);
  ipcMain.handle("netcatty:filewatch:registerTempFile", (event, { sftpId, localPath }) => {
    observeOwnerSender(event?.sender);
    registerTempFile(sftpId, localPath, getOwnerId(event?.sender));
    return { success: true };
  });
  ipcMain.handle("netcatty:filewatch:unregisterTempFile", unregisterTempFile);
  ipcMain.handle("netcatty:filewatch:releaseOwner", (_event, payload = {}) => (
    releaseOwnerResources(payload.webContentsId, payload.cleanupTempFiles !== false)
  ));
}

/**
 * Cleanup all watchers on shutdown
 */
function cleanup() {
  console.log(`[FileWatcher] Cleaning up ${activeWatchers.size} watcher(s)`);
  for (const pendingStart of pendingWatchStarts) pendingStart.cancelled = true;
  for (const [watchId] of activeWatchers.entries()) {
    stopWatching(null, { watchId, force: true, cleanupTempFile: true });
  }
  for (const [sftpId] of tempFilesMap) stopWatchersForSession(sftpId, true);
}

module.exports = {
  init,
  registerHandlers,
  stopWatchersForSession,
  cleanup,
};
