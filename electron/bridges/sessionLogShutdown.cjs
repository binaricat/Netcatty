const { randomUUID } = require("node:crypto");

// Keep the renderer alive until its ConnectionLog replay writes have committed.
function finalizeSessionLogs(webContents, { ipcMain, timeoutMs = 5000 } = {}) {
  if (!webContents || webContents.isDestroyed?.() || webContents.isCrashed?.()
    || typeof webContents.send !== "function"
    || typeof ipcMain?.on !== "function"
    || typeof ipcMain?.removeListener !== "function") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const finish = (success) => {
      clearTimeout(timer);
      try {
        ipcMain.removeListener("app:session-logs-finalized", onResult);
      } catch {
        // IPC teardown must not prevent the window from closing.
      }
      if (!success) console.warn("[SessionLogs] Renderer did not finalize logs before close");
      resolve(success);
    };
    const onResult = (event, payload) => {
      if (event.sender === webContents && payload?.requestId === requestId) {
        finish(payload.success === true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ipcMain.on("app:session-logs-finalized", onResult);
      webContents.send("app:finalize-session-logs", { requestId });
    } catch {
      finish(false);
    }
  });
}

module.exports = { finalizeSessionLogs };
