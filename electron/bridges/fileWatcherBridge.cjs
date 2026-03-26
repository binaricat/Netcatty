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

// Lazy-load encodePathForSession to avoid circular dependency issues
let encodePathForSession = null;

// Map of watchId -> { watcher, localPath, remotePath, sftpId, lastModified, lastSize }
const activeWatchers = new Map();

// Debounce map to prevent multiple rapid syncs
const debounceTimers = new Map();

// Map of sftpId -> Set<localPath> to track temp files even without watching
// This allows cleanup when SFTP session closes, regardless of auto-sync setting
const tempFilesMap = new Map();

let sftpClients = null;
let electronModule = null;

/**
 * Initialize the file watcher bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
}

/**
 * Register a temp file for cleanup when SFTP session closes
 * Called regardless of whether auto-sync is enabled
 */
function registerTempFile(sftpId, localPath) {
  if (!tempFilesMap.has(sftpId)) {
    tempFilesMap.set(sftpId, new Set());
  }
  tempFilesMap.get(sftpId).add(localPath);
  console.log(`[FileWatcher] Registered temp file for cleanup: ${localPath} (session: ${sftpId})`);
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
  const watchId = `watch-${crypto.randomUUID()}`;
  
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
    console.error(`[FileWatcher] Failed to stat file ${localPath}:`, err.message);
    throw new Error(`Cannot watch file: ${err.message}`);
  }
  
  // Store webContents reference for later notifications
  const webContents = event.sender;
  
  // Use fs.watchFile (polling) instead of fs.watch for better reliability on Windows
  // fs.watch can miss events when editors use atomic writes (save to temp, then rename)
  // fs.watchFile polls the file system at regular intervals
  const pollInterval = 1000; // Check every 1 second
  
  fs.watchFile(localPath, { persistent: true, interval: pollInterval }, async (curr, prev) => {
    console.log(`[FileWatcher] File stat change detected for ${localPath}`);
    console.log(`[FileWatcher]   Previous: mtime=${prev.mtimeMs}, size=${prev.size}`);
    console.log(`[FileWatcher]   Current: mtime=${curr.mtimeMs}, size=${curr.size}`);
    
    // Check if file was deleted
    if (curr.nlink === 0) {
      console.log(`[FileWatcher] File ${localPath} was deleted, stopping watch`);
      stopWatching(null, { watchId });
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
      await handleFileChange(watchId, webContents);
    }, 500); // 500ms debounce

    debounceTimers.set(watchId, timer);
  });

  activeWatchers.set(watchId, {
    watcher: null, // fs.watchFile doesn't return a watcher object
    localPath,
    remotePath,
    sftpId,
    encoding,
    lastModified,
    lastSize,
    webContents,
    useWatchFile: true, // Flag to indicate we're using fs.watchFile
  });
  
  console.log(`[FileWatcher] Watch started with ID: ${watchId} (using fs.watchFile polling every ${pollInterval}ms)`);
  return { watchId };
}

/**
 * Handle file change event - sync to remote
 */
async function handleFileChange(watchId, webContents) {
  const watchInfo = activeWatchers.get(watchId);
  if (!watchInfo) return;
  
  const { localPath, remotePath, sftpId, encoding, lastModified: previousModified, lastSize: previousSize } = watchInfo;

  // Lazy-load encodePathForSession to avoid circular dependency
  if (encodePathForSession === null) {
    ({ encodePathForSession } = require("./sftpBridge.cjs"));
  }

  // Extract file name once for notifications and logging
  const fileName = path.basename(remotePath);
  
  console.log(`[FileWatcher] File change detected: ${localPath}`);
  
  try {
    // Check if file was actually modified (compare mtime and size)
    const stat = await fs.promises.stat(localPath);
    
    // Skip if neither mtime nor size changed (prevents spurious events on some platforms)
    if (stat.mtimeMs <= previousModified && stat.size === previousSize) {
      console.log(`[FileWatcher] File unchanged (mtime and size same), skipping sync`);
      return;
    }
    
    // Update lastModified and lastSize
    watchInfo.lastModified = stat.mtimeMs;
    watchInfo.lastSize = stat.size;
    
    // Get the SFTP client
    if (!sftpClients) {
      throw new Error("SFTP clients not initialized");
    }
    
    const client = sftpClients.get(sftpId);
    if (!client) {
      throw new Error("SFTP session not found or expired");
    }
    
    // Read the local file
    const content = await fs.promises.readFile(localPath);
    
    console.log(`[FileWatcher] Syncing ${content.length} bytes to ${remotePath}`);
    
    // Upload to remote
    const encodedPath = encodePathForSession(sftpId, remotePath, encoding);
    await client.put(content, encodedPath);
    
    console.log(`[FileWatcher] Sync complete: ${remotePath}`);
    
    // Show system notification for successful sync
    showSystemNotification(
      "Netcatty",
      `File synced to remote: ${fileName}`
    );
    
    // Notify the renderer about successful sync
    if (webContents && !webContents.isDestroyed()) {
      webContents.send("netcatty:filewatch:synced", {
        watchId,
        localPath,
        remotePath,
        bytesWritten: content.length,
      });
    }
    
  } catch (err) {
    console.error(`[FileWatcher] Sync failed for ${localPath}:`, err.message);
    
    // Show system notification for sync failure
    showSystemNotification(
      "Netcatty",
      `Failed to sync ${fileName}: ${err.message}`
    );
    
    // Notify the renderer about sync failure
    if (webContents && !webContents.isDestroyed()) {
      webContents.send("netcatty:filewatch:error", {
        watchId,
        localPath,
        remotePath,
        error: err.message,
      });
    }
  }
}

/**
 * Stop watching a file and optionally clean up the temp file
 */
function stopWatching(event, { watchId, cleanupTempFile = false }) {
  const watchInfo = activeWatchers.get(watchId);
  if (!watchInfo) {
    console.log(`[FileWatcher] Watch ID not found: ${watchId}`);
    return { success: false };
  }
  
  console.log(`[FileWatcher] Stopping watch: ${watchInfo.localPath}`);
  
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
      fs.unwatchFile(watchInfo.localPath);
    } else if (watchInfo.watcher) {
      // Using fs.watch - close the watcher
      watchInfo.watcher.close();
    }
  } catch (err) {
    console.warn(`[FileWatcher] Error stopping watcher:`, err.message);
  }
  
  // Clean up temp file if requested
  if (cleanupTempFile && watchInfo.localPath) {
    cleanupTempFileAsync(watchInfo.localPath);
  }
  
  activeWatchers.delete(watchId);
  
  return { success: true };
}

/**
 * Asynchronously delete a temp file, logging success and silently handling failures
 */
async function cleanupTempFileAsync(filePath) {
  try {
    await fs.promises.unlink(filePath);
    console.log(`[FileWatcher] Temp file cleaned up: ${filePath}`);
  } catch (err) {
    // Silently ignore deletion failures (file may be in use or already deleted)
    console.log(`[FileWatcher] Could not delete temp file (may be in use): ${filePath}`);
  }
}

/**
 * Stop all watchers for a specific SFTP session and clean up temp files
 * Called when SFTP connection is closed
 */
function stopWatchersForSession(sftpId, cleanupTempFiles = true) {
  let watcherCount = 0;
  
  // Stop active watchers
  for (const [watchId, watchInfo] of activeWatchers.entries()) {
    if (watchInfo.sftpId === sftpId) {
      stopWatching(null, { watchId, cleanupTempFile: cleanupTempFiles });
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
    for (const filePath of tempFiles) {
      cleanupTempFileAsync(filePath);
      cleanedCount++;
    }
    tempFilesMap.delete(sftpId);
    if (cleanedCount > 0) {
      console.log(`[FileWatcher] Queued cleanup for ${cleanedCount} temp file(s) for SFTP session: ${sftpId}`);
    }
  }
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
function registerHandlers(ipcMain) {
  console.log("[FileWatcher] Registering IPC handlers");
  ipcMain.handle("netcatty:filewatch:start", (event, args) => {
    console.log("[FileWatcher] IPC netcatty:filewatch:start received", args);
    return startWatching(event, args);
  });
  ipcMain.handle("netcatty:filewatch:stop", stopWatching);
  ipcMain.handle("netcatty:filewatch:list", listWatchers);
  ipcMain.handle("netcatty:filewatch:registerTempFile", (_event, { sftpId, localPath }) => {
    registerTempFile(sftpId, localPath);
    return { success: true };
  });
}

/**
 * Cleanup all watchers on shutdown
 */
function cleanup() {
  console.log(`[FileWatcher] Cleaning up ${activeWatchers.size} watcher(s)`);
  for (const [watchId] of activeWatchers.entries()) {
    stopWatching(null, { watchId });
  }
}

module.exports = {
  init,
  registerHandlers,
  stopWatchersForSession,
};
