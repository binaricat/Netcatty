"use strict";

function emitAppLockReopen(windows) {
  const seen = new Set();
  for (const win of Array.isArray(windows) ? windows : []) {
    try {
      if (!win || win.isDestroyed?.()) continue;
      const id = win.webContents?.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      win.webContents?.send?.("netcatty:app-lock:reopen");
    } catch {
      // ignore
    }
  }
}

function shouldBackgroundLockOnHide(appLockController) {
  return Boolean(appLockController && typeof appLockController.setLocked === "function");
}

function handleAppHide(appLockController) {
  if (!shouldBackgroundLockOnHide(appLockController)) return false;
  try {
    appLockController.setLocked("background");
    return true;
  } catch {
    return false;
  }
}

/**
 * macOS keeps the process alive after the last BrowserWindow closes
 * (`window-all-closed` only quits on non-darwin). App-lock runtime is shared
 * for the process lifetime, so an unlock can otherwise survive a full
 * close → Dock reopen cycle. Re-apply lock with `startup` (same reason as
 * cold start) so a fresh renderer withholds content until unlock. Prefer this
 * over `background`, which waits on a reopen signal that a brand-new window
 * never receives.
 */
function ensureAppLockForFreshSession(appLockController, reason = "startup") {
  if (!shouldBackgroundLockOnHide(appLockController)) return false;
  const nextReason = typeof reason === "string" && reason.trim() !== "" ? reason : "startup";
  try {
    appLockController.setLocked(nextReason);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when no usable app-content windows remain (main / settings / etc.).
 * Used to decide whether recreating a main window is a "fresh session" reopen
 * after the last window was closed, vs. adding another window while one is open.
 */
function hasNoUsableAppContentWindows(appContentWindows) {
  if (!Array.isArray(appContentWindows) || appContentWindows.length === 0) return true;
  return !appContentWindows.some((win) => {
    try {
      if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
        return false;
      }
      // Hidden prewarm windows (e.g. Settings) keep the process alive but are
      // not a user session — do not block fresh-session re-lock (Codex P2).
      // Minimized windows also report !isVisible but are still a live session
      // (Codex P2 on 4e6c3235).
      if (typeof win.isVisible === "function" && !win.isVisible()) {
        if (typeof win.isMinimized === "function" && win.isMinimized()) {
          return true;
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });
}

function handleActivateWithMainWindow({
  app,
  mainWindow,
  globalShortcutBridge,
  windowManager,
  reopenWindows,
}) {
  if (!mainWindow || mainWindow.isDestroyed?.()) return false;

  try {
    if (mainWindow.webContents?.isCrashed?.()) {
      mainWindow.destroy?.();
      return false;
    }
  } catch {
    // ignore
  }

  try {
    globalShortcutBridge?.clearPendingFullscreenHide?.(mainWindow);
  } catch {
    // ignore
  }
  if (typeof windowManager?.showAndFocusMainWindow === "function") {
    windowManager.showAndFocusMainWindow(mainWindow);
  } else {
    try {
      if (mainWindow.isMinimized?.()) mainWindow.restore?.();
    } catch {
      // ignore
    }
    try {
      mainWindow.show?.();
    } catch {
      // ignore
    }
    try {
      mainWindow.focus?.();
    } catch {
      // ignore
    }
  }
  emitAppLockReopen(reopenWindows);
  try {
    app?.focus?.({ steal: true });
  } catch {
    // ignore
  }
  return true;
}

function shouldCommitQuitWithoutDirtyCheck({
  reachableMainWindows,
  queryableWebContents,
}) {
  const hasReachableMainWindows = Array.isArray(reachableMainWindows) && reachableMainWindows.length > 0;
  if (!hasReachableMainWindows) return true;

  const hasQueryableWebContents = Array.isArray(queryableWebContents) && queryableWebContents.length > 0;
  return !hasQueryableWebContents;
}

async function handleBeforeQuit({
  event,
  mainWindows,
  queryDirtyEditors,
  appLockController,
  windowManager,
  app,
  ipcMain,
  quitConfirmed,
  quitGuardChannelBusy,
  timeoutMs,
  setQuitGuardChannelBusy,
  setQuitConfirmed,
  commitQuit,
  cancelPendingUpdateInstall,
}) {
  if (quitConfirmed) return { committed: false, skipped: "quit-confirmed" };
  if (quitGuardChannelBusy) {
    event?.preventDefault?.();
    return { committed: false, skipped: "busy" };
  }

  // When the caller provides commitQuit (async plugin shutdown before the real
  // quit), the original quit event must stay cancelled until commitQuit
  // re-enters app.quit(). commitQuit owns background-lock, isQuitting and
  // quitConfirmed in that case.
  const commit = () => {
    if (typeof commitQuit === "function") {
      event?.preventDefault?.();
      commitQuit();
      return;
    }
    if (shouldBackgroundLockOnHide(appLockController)) {
      appLockController.setLocked("background");
    }
    windowManager?.setIsQuitting?.(true);
    setQuitConfirmed?.(true);
    app?.quit?.();
  };

  const reachableMainWindows = (Array.isArray(mainWindows) ? mainWindows : []).filter((candidate) => (
    candidate && !candidate.isDestroyed?.()
  ));
  // Keep the window alongside webContents so a dirty result can bring the
  // owning window forward (hidden-to-tray / unfocused) before aborting quit.
  const queryableWindows = reachableMainWindows.filter((candidate) => {
    const wc = candidate.webContents;
    return wc && !wc.isDestroyed?.() && !wc.isCrashed?.();
  });
  const queryableWebContents = queryableWindows
    .map((candidate) => candidate.webContents)
    .filter(Boolean);

  if (shouldCommitQuitWithoutDirtyCheck({ reachableMainWindows, queryableWebContents })) {
    commit();
    return { committed: true, skipped: "fast-path" };
  }

  setQuitGuardChannelBusy?.(true);
  event?.preventDefault?.();

  try {
    const dirtyResults = await Promise.all(
      queryableWindows.map((win) =>
        queryDirtyEditors(win.webContents, timeoutMs, { ipcMain }).then((hasDirty) => ({
          win,
          hasDirty: Boolean(hasDirty),
        })),
      ),
    );
    setQuitGuardChannelBusy?.(false);
    const dirtyWindows = dirtyResults.filter((result) => result.hasDirty).map((result) => result.win);
    if (dirtyWindows.length === 0) {
      commit();
      return { committed: true, skipped: null };
    }

    // Renderer only surfaces the dirty toast in its own window. Focus every
    // dirty owner so a tray-hidden or backgrounded window is visible before
    // we refuse to quit.
    for (const win of dirtyWindows) {
      try {
        if (typeof windowManager?.showAndFocusMainWindow === "function") {
          windowManager.showAndFocusMainWindow(win);
        } else {
          try {
            if (win.isMinimized?.()) win.restore?.();
          } catch {
            // ignore
          }
          try {
            win.show?.();
          } catch {
            // ignore
          }
          try {
            win.focus?.();
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    // App Lock overlay sits above renderer toasts (z-index). When the app is
    // already locked, focusing the dirty window does not make the unsaved
    // warning visible — surface a native dialog above the lock screen (Codex P2).
    try {
      const { dialog } = require("electron");
      dialog.showMessageBoxSync({
        type: "warning",
        buttons: ["OK"],
        defaultId: 0,
        message: "Unsaved changes",
        detail:
          "One or more editors have unsaved changes. If the app is locked, unlock it, then save or discard before quitting.",
      });
    } catch {
      // ignore missing dialog in tests
    }

    if (windowManager?.isQuittingForUpdate?.()) {
      // Cancel the install bridge's in-flight state as well as the
      // window-manager flag so a cancelled update can be retried immediately
      // instead of waiting for its watchdog (#1215 review).
      try {
        cancelPendingUpdateInstall?.();
      } catch {
        // ignore
      }
      if (windowManager.isQuittingForUpdate?.()) {
        windowManager.setQuittingForUpdate?.(false);
      }
    }
    return { committed: false, skipped: "dirty" };
  } catch {
    setQuitGuardChannelBusy?.(false);
    commit();
    return { committed: true, skipped: "error" };
  }
}

module.exports = {
  emitAppLockReopen,
  ensureAppLockForFreshSession,
  handleAppHide,
  handleActivateWithMainWindow,
  handleBeforeQuit,
  hasNoUsableAppContentWindows,
  shouldBackgroundLockOnHide,
  shouldCommitQuitWithoutDirtyCheck,
};
