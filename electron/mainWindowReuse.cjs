function getReusableMainWindow({ getWindowManager, logWarn = console.warn } = {}) {
  if (typeof getWindowManager !== "function") return null;

  let windowManager = null;
  let win = null;
  try {
    windowManager = getWindowManager();
    win = windowManager?.getMainWindow?.() || null;
  } catch {
    return null;
  }

  if (!win || win.isDestroyed?.()) return null;

  if (typeof windowManager?.isWindowUsable === "function") {
    let usable = false;
    try {
      usable = windowManager.isWindowUsable(win);
    } catch {
      return null;
    }
    if (usable) return win;
  }

  try {
    if (win.webContents?.isCrashed?.()) {
      logWarn?.("[Main] Main window webContents has crashed, destroying window");
      try {
        win.destroy?.();
      } catch {
        // ignore
      }
      return null;
    }
  } catch {
    // If the crash check itself fails, keep the existing window path best-effort.
  }

  if (typeof windowManager?.isWindowUsable === "function") return null;

  return win;
}

module.exports = { getReusableMainWindow };
