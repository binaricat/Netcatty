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
function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
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

function init(deps) {
  _deps = deps;
}

/** Get the focused or first available BrowserWindow to send events to. */
function getSenderWindow() {
  try {
    const { BrowserWindow } = _deps?.electronModule || {};
    if (!BrowserWindow) return null;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return focused;
    const all = BrowserWindow.getAllWindows();
    for (const win of all) {
      if (!win.isDestroyed()) return win;
    }
  } catch {}
  return null;
}

function registerHandlers(ipcMain) {
  // ---- Check for updates ------------------------------------------------
  ipcMain.handle("netcatty:update:check", async () => {
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

    try {
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
    const updater = getAutoUpdater();
    if (!updater) {
      return { success: false, error: "Update module not available." };
    }

    try {
      // Capture the requesting window NOW so events always go back to the
      // renderer that initiated the download, even if focus changes later.
      const senderWindow = getSenderWindow();

      // Wire progress events before starting the download.
      const progressHandler = (info) => {
        if (senderWindow && !senderWindow.isDestroyed()) {
          senderWindow.webContents.send("netcatty:update:download-progress", {
            percent: info.percent ?? 0,
            bytesPerSecond: info.bytesPerSecond ?? 0,
            transferred: info.transferred ?? 0,
            total: info.total ?? 0,
          });
        }
      };

      const downloadedHandler = () => {
        if (senderWindow && !senderWindow.isDestroyed()) {
          senderWindow.webContents.send("netcatty:update:downloaded");
        }
        // Cleanup one-shot listeners.
        updater.removeListener("download-progress", progressHandler);
        updater.removeListener("update-downloaded", downloadedHandler);
        updater.removeListener("error", errorHandler);
      };

      const errorHandler = (err) => {
        if (senderWindow && !senderWindow.isDestroyed()) {
          senderWindow.webContents.send("netcatty:update:error", {
            error: err?.message || "Download failed",
          });
        }
        updater.removeListener("download-progress", progressHandler);
        updater.removeListener("update-downloaded", downloadedHandler);
        updater.removeListener("error", errorHandler);
      };

      updater.on("download-progress", progressHandler);
      updater.on("update-downloaded", downloadedHandler);
      updater.on("error", errorHandler);

      await updater.downloadUpdate();
      return { success: true };
    } catch (err) {
      // Clean up listeners to prevent leaks if downloadUpdate() rejects
      // before the error event is emitted.
      const updaterForCleanup = getAutoUpdater();
      if (updaterForCleanup) {
        updaterForCleanup.removeAllListeners("download-progress");
        updaterForCleanup.removeAllListeners("update-downloaded");
        updaterForCleanup.removeAllListeners("error");
      }
      console.error("[AutoUpdate] Download failed:", err?.message || err);
      return { success: false, error: err?.message || "Download failed" };
    }
  });

  // ---- Install (quit & install) ------------------------------------------
  ipcMain.handle("netcatty:update:install", () => {
    const updater = getAutoUpdater();
    if (!updater) return;
    updater.quitAndInstall(false, true);
  });

  console.log("[AutoUpdate] Handlers registered");
}

module.exports = { init, registerHandlers, isAutoUpdateSupported };
