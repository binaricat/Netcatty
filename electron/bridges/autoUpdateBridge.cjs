/**
 * Auto-Update Bridge
 *
 * Wraps electron-updater to provide IPC-driven update checks, downloads, and
 * install-on-quit. Designed around a "prompt" model: the renderer asks to
 * check, then explicitly triggers download and install.
 *
 * Platforms where auto-update is NOT supported (Linux deb/rpm/snap) get a
 * graceful { available: false, error } response so the renderer can fall back
 * to a manual "open GitHub releases" link.
 */

let _deps = null;

/**
 * Read the persisted auto-update preference from a JSON file in userData.
 * Returns true (default) if the file doesn't exist or is unreadable.
 */
function readAutoUpdatePreference() {
  try {
    const { app } = _deps?.electronModule || {};
    if (!app) return true;
    const path = require('path');
    const fs = require('fs');
    const prefPath = path.join(app.getPath('userData'), 'auto-update-pref.json');
    const data = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    return data.enabled !== false;
  } catch {
    return true; // default to enabled
  }
}

/**
 * Persist the auto-update preference to a JSON file in userData.
 */
function writeAutoUpdatePreference(enabled) {
  try {
    const { app } = _deps?.electronModule || {};
    if (!app) return;
    const path = require('path');
    const fs = require('fs');
    const prefPath = path.join(app.getPath('userData'), 'auto-update-pref.json');
    fs.writeFileSync(prefPath, JSON.stringify({ enabled }), 'utf8');
  } catch (err) {
    console.warn('[AutoUpdate] Failed to write preference:', err?.message || err);
  }
}

/**
 * Returns true when the current packaging format supports electron-updater
 * (macOS zip/dmg, Windows NSIS, Linux AppImage).
 */
function isAutoUpdateSupported() {
  if (process.platform === "darwin" || process.platform === "win32") {
    return true;
  }
  // Linux: only AppImage supports in-place update.
  // The APPIMAGE env variable is set by the AppImage runtime.
  if (process.platform === "linux" && process.env.APPIMAGE) {
    return true;
  }
  return false;
}

/** Lazily resolved autoUpdater — avoids importing electron-updater in
 *  contexts where native modules might not be available. */
let _autoUpdater = null;

/** Guard against duplicate listener registration */
let _listenersRegistered = false;

/** Track whether a download is in progress to distinguish download errors from check errors */
let _isDownloading = false;

/** Track whether a checkForUpdates call is in flight (set before call, cleared on result event) */
let _isChecking = false;

/**
 * Snapshot of the last known update status so newly opened windows can hydrate
 * without waiting for the next IPC event.
 * @type {{ status: 'idle' | 'downloading' | 'ready' | 'error', percent: number, error: string | null, version: string | null, isChecking: boolean }}
 */
let _lastStatus = { status: 'idle', percent: 0, error: null, version: null, isChecking: false };
function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = readAutoUpdatePreference();
    autoUpdater.autoInstallOnAppQuit = false;
    // Silence the default electron-log transport (we log ourselves).
    autoUpdater.logger = null;
    _autoUpdater = autoUpdater;
    return autoUpdater;
  } catch (err) {
    console.error("[AutoUpdate] Failed to load electron-updater:", err?.message || err);
    return null;
  }
}

/**
 * Register persistent global IPC event listeners for auto-download flow.
 * Called once in init(). Forwards electron-updater events to the renderer
 * even when no manual download was initiated.
 */
function setupGlobalListeners() {
  if (_listenersRegistered) return;
  const updater = getAutoUpdater();
  if (!updater) return;
  _listenersRegistered = true;

  updater.on("update-not-available", () => {
    _isChecking = false;
    // Reset stale status so late-opening windows don't hydrate from a
    // previous 'error' or 'ready' snapshot after a "no update" check.
    _lastStatus = { status: 'idle', percent: 0, error: null, version: null, isChecking: false };
    broadcastToAllWindows("netcatty:update:update-not-available", {});
  });

  updater.on("update-available", (info) => {
    _isChecking = false;
    // Only track as downloading when autoDownload is enabled — otherwise no
    // download will actually start and the status would be stuck at 0%.
    // Use 'available' so late-opening windows can still hydrate the version.
    const willDownload = updater.autoDownload !== false;
    _isDownloading = willDownload;
    _lastStatus = { status: willDownload ? 'downloading' : 'available', percent: 0, error: null, version: info.version || null, isChecking: false };
    broadcastToAllWindows("netcatty:update:update-available", {
      version: info.version || "",
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : "",
      releaseDate: info.releaseDate || null,
    });
  });

  updater.on("download-progress", (info) => {
    _lastStatus.percent = Math.round(info.percent ?? 0);
    broadcastToAllWindows("netcatty:update:download-progress", {
      percent: info.percent ?? 0,
      bytesPerSecond: info.bytesPerSecond ?? 0,
      transferred: info.transferred ?? 0,
      total: info.total ?? 0,
    });
  });

  updater.on("update-downloaded", () => {
    _isDownloading = false;
    _lastStatus = { ..._lastStatus, status: 'ready', percent: 100 };
    broadcastToAllWindows("netcatty:update:downloaded");
  });

  updater.on("error", (err) => {
    _isChecking = false;
    // Only broadcast download-phase errors; check-phase errors (e.g. network failures
    // during checkForUpdates) are not download failures and must not set autoDownloadStatus.
    if (!_isDownloading) {
      _lastStatus = { ..._lastStatus, isChecking: false };
      console.warn("[AutoUpdate] Check-phase error (not broadcast to renderer):", err?.message || err);
      return;
    }
    _isDownloading = false;
    const errorMsg = err?.message || "Unknown update error";
    _lastStatus = { ..._lastStatus, status: 'error', error: errorMsg };
    broadcastToAllWindows("netcatty:update:error", {
      error: errorMsg,
    });
  });

  console.log("[AutoUpdate] Global listeners registered");
}

/**
 * Trigger an automatic update check after a delay.
 * No-op on platforms that don't support auto-update (Linux deb/rpm/snap).
 * Called from main process after the main window is created.
 *
 * @param {number} delayMs - Milliseconds to wait before checking (default: 5000)
 */
let _autoCheckTimer = null;

function startAutoCheck(delayMs = 5000) {
  if (!isAutoUpdateSupported()) {
    console.log("[AutoUpdate] Platform does not support auto-update, skipping auto-check");
    return;
  }
  // Cancel any existing timer to avoid duplicate concurrent checks
  // (e.g. from multiple windows initializing or re-enable toggle).
  cancelAutoCheck();
  _autoCheckTimer = setTimeout(async () => {
    _autoCheckTimer = null;
    const updater = getAutoUpdater();
    if (!updater) {
      console.warn("[AutoUpdate] Auto-check skipped — updater not available");
      return;
    }
    // Respect autoDownload flag — the renderer may have disabled it via IPC
    // before this timer fires.
    if (updater.autoDownload === false) {
      console.log("[AutoUpdate] Auto-check skipped — autoDownload is disabled");
      return;
    }
    _isChecking = true;
    _lastStatus = { ..._lastStatus, isChecking: true };
    try {
      console.log("[AutoUpdate] Starting automatic update check...");
      await updater.checkForUpdates();
    } catch (err) {
      _isChecking = false;
      _lastStatus = { ..._lastStatus, isChecking: false };
      console.warn("[AutoUpdate] Auto-check failed:", err?.message || err);
    }
  }, delayMs);
}

/**
 * Cancel a pending startAutoCheck timer.  Called when the renderer triggers
 * a manual check to avoid racing with the queued auto-check.
 */
function cancelAutoCheck() {
  if (_autoCheckTimer) {
    clearTimeout(_autoCheckTimer);
    _autoCheckTimer = null;
  }
}

function init(deps) {
  _deps = deps;
  setupGlobalListeners();
}

/**
 * Broadcast an IPC event to all non-destroyed BrowserWindows.
 * Ensures both the main window and settings window always receive
 * auto-update events.
 * @param {string} channel
 * @param {unknown} [payload]
 */
function broadcastToAllWindows(channel, payload) {
  try {
    const { BrowserWindow } = _deps?.electronModule || {};
    if (!BrowserWindow) return;
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        if (payload !== undefined) {
          win.webContents.send(channel, payload);
        } else {
          win.webContents.send(channel);
        }
      }
    }
  } catch (err) {
    console.warn("[AutoUpdate] broadcastToAllWindows failed:", err?.message || err);
  }
}

function registerHandlers(ipcMain) {
  // ---- Check for updates ------------------------------------------------
  ipcMain.handle("netcatty:update:check", async () => {
    // Cancel any pending auto-check to prevent concurrent checkForUpdates()
    // calls — electron-updater rejects them and surfaces false errors.
    cancelAutoCheck();

    if (!isAutoUpdateSupported()) {
      return {
        available: false,
        supported: false,
        error: "Auto-update is not supported on this platform/package format.",
      };
    }

    const updater = getAutoUpdater();
    if (!updater) {
      return {
        available: false,
        supported: false,
        error: "Update module failed to load.",
      };
    }

    // If a check is already in flight (e.g. from startAutoCheck), don't
    // start a concurrent one — electron-updater rejects it and surfaces a
    // confusing error.  Return a sentinel so the renderer knows to wait.
    if (_isChecking) {
      return { available: false, supported: true, checking: true };
    }

    // If a download is already in progress or the update is ready to install,
    // skip the check entirely — calling checkForUpdates() while downloading
    // can cause electron-updater to error, which corrupts the download state
    // and forces the user to download manually (GitHub issue #522).
    if (_isDownloading) {
      return { available: true, supported: true, downloading: true, version: _lastStatus.version };
    }
    if (_lastStatus.status === 'ready') {
      return { available: true, supported: true, ready: true, version: _lastStatus.version };
    }

    try {
      _isChecking = true;
      _lastStatus = { ..._lastStatus, isChecking: true };
      const result = await updater.checkForUpdates();
      if (!result || !result.updateInfo) {
        return { available: false, supported: true };
      }

      const { version, releaseNotes, releaseDate } = result.updateInfo;

      // Compare with current version using semver ordering.
      // Only report an update when the feed version is strictly newer,
      // avoiding false positives for pre-release or nightly builds.
      const { app } = _deps?.electronModule || {};
      const currentVersion = app?.getVersion?.() || "0.0.0";
      const isNewer = currentVersion.localeCompare(version, undefined, { numeric: true, sensitivity: 'base' }) < 0;
      if (!isNewer) {
        return { available: false, supported: true };
      }

      return {
        available: true,
        supported: true,
        version,
        releaseNotes: typeof releaseNotes === "string" ? releaseNotes : "",
        releaseDate: releaseDate || null,
      };
    } catch (err) {
      _isChecking = false;
      _lastStatus = { ..._lastStatus, isChecking: false };
      console.warn("[AutoUpdate] Check failed:", err?.message || err);
      return {
        available: false,
        supported: true,
        error: err?.message || "Unknown update check error",
      };
    }
  });

  // ---- Download update ---------------------------------------------------
  ipcMain.handle("netcatty:update:download", async () => {
    if (_isDownloading) {
      return { success: true };
    }
    const updater = getAutoUpdater();
    if (!updater) {
      return { success: false, error: "Update module not available." };
    }
    try {
      _isDownloading = true;
      _lastStatus = { ..._lastStatus, status: 'downloading', percent: 0, error: null };
      await updater.downloadUpdate();
      return { success: true };
    } catch (err) {
      _isDownloading = false;
      _lastStatus = { ..._lastStatus, status: 'error', error: err?.message || "Download failed", percent: 0 };
      // Don't broadcast here — the global updater "error" listener already handles it
      console.error("[AutoUpdate] Download failed:", err?.message || err);
      return { success: false, error: err?.message || "Download failed" };
    }
  });

  // ---- Get current update status (for late-opening windows) ---------------
  ipcMain.handle("netcatty:update:getStatus", () => {
    return { ..._lastStatus };
  });

  // ---- Install (quit & install) ------------------------------------------
  ipcMain.handle("netcatty:update:install", () => {
    const updater = getAutoUpdater();
    if (!updater) return;

    // On macOS, the system tray keeps the app process alive even after all
    // windows are closed, which prevents quitAndInstall from completing.
    // Destroy the tray (and its panel window) before quitting so the app
    // can exit cleanly and the installer can proceed.
    try {
      const globalShortcutBridge = require("./globalShortcutBridge.cjs");
      globalShortcutBridge.cleanup();
    } catch {
      // ignore — bridge may not be available
    }

    updater.quitAndInstall(false, true);
  });

  // ---- Get auto-update preference -----------------------------------------
  ipcMain.handle("netcatty:update:getAutoUpdate", () => {
    return { enabled: readAutoUpdatePreference() };
  });

  // ---- Enable/disable auto-update ----------------------------------------
  let _prevAutoDownloadEnabled = readAutoUpdatePreference();
  ipcMain.handle("netcatty:update:setAutoUpdate", (_event, { enabled }) => {
    const wasEnabled = _prevAutoDownloadEnabled;
    _prevAutoDownloadEnabled = !!enabled;
    const updater = getAutoUpdater();
    if (updater) {
      updater.autoDownload = !!enabled;
      console.log("[AutoUpdate] autoDownload set to:", !!enabled);
    }
    // Persist so the preference survives app restarts
    writeAutoUpdatePreference(!!enabled);
    if (!enabled) {
      cancelAutoCheck();
    } else if (!wasEnabled && !_isChecking) {
      // Only re-schedule when actually re-enabling (not on every mount sync),
      // to avoid duplicate checks from multiple windows initializing.
      // Skip if a check is already in flight to prevent concurrent calls.
      startAutoCheck(2000);
    }
    return { success: true };
  });

  console.log("[AutoUpdate] Handlers registered");
}

module.exports = { init, registerHandlers, isAutoUpdateSupported, startAutoCheck };
