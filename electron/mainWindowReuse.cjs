function getReusableMainWindow({ getWindowManager, logWarn = console.warn } = {}) {
  if (typeof getWindowManager !== "function") return null;

  let win = null;
  try {
    win = getWindowManager()?.getMainWindow?.() || null;
  } catch {
    return null;
  }

  if (!win || win.isDestroyed?.()) return null;

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

  return win;
}

module.exports = { getReusableMainWindow };
