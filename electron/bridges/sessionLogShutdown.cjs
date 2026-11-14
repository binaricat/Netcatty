const { randomUUID } = require("node:crypto");

// Keep the renderer alive until its ConnectionLog replay writes have committed.
function finalizeSessionLogs(webContents, { ipcMain, timeoutMs = 5000 } = {}) {
  if (!webContents || webContents.isDestroyed?.() || webContents.isCrashed?.()) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const finish = (success) => {
      clearTimeout(timer);
      ipcMain.removeListener("app:session-logs-finalized", onResult);
      if (!success) console.warn("[SessionLogs] Renderer did not finalize logs before close");
      resolve(success);
    };
    const onResult = (event, payload) => {
      if (event.sender === webContents && payload?.requestId === requestId) {
        finish(payload.success === true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ipcMain.on("app:session-logs-finalized", onResult);
    try {
      webContents.send("app:finalize-session-logs", { requestId });
    } catch {
      finish(false);
    }
  });
}

module.exports = { finalizeSessionLogs };
