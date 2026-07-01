"use strict";

const crypto = require("node:crypto");

const ASSET_ACTION_TIMEOUT_MS = 15_000;
const pendingAssetActionRequests = new Map();

function createAssetActionBridge({ getMainWindowFn, validateSender }) {
  function registerHandlers(ipcMain) {
    ipcMain.handle("netcatty:ai:asset-action:response", (event, { requestId, result }) => {
      if (!validateSender(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      if (!requestId || typeof requestId !== "string") {
        return { ok: false, error: "requestId is required" };
      }
      const entry = pendingAssetActionRequests.get(requestId);
      if (!entry) {
        return { ok: false, error: "Unknown or expired asset action request." };
      }
      clearTimeout(entry.timer);
      pendingAssetActionRequests.delete(requestId);
      entry.resolve(result);
      return { ok: true };
    });
  }

  async function invokeAssetAction(op, params = {}, options = {}) {
    const mainWin = typeof getMainWindowFn === "function" ? getMainWindowFn() : null;
    if (!mainWin || mainWin.isDestroyed()) {
      return {
        ok: false,
        error: "No active Netcatty window is available for asset actions.",
      };
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingAssetActionRequests.has(requestId)) return;
        pendingAssetActionRequests.delete(requestId);
        resolve({
          ok: false,
          error: "Asset action bridge timed out waiting for renderer.",
        });
      }, options.timeoutMs ?? ASSET_ACTION_TIMEOUT_MS);

      pendingAssetActionRequests.set(requestId, { resolve, timer });
      try {
        mainWin.webContents.send("netcatty:ai:asset-action:request", {
          requestId,
          op,
          params,
        });
      } catch (err) {
        clearTimeout(timer);
        pendingAssetActionRequests.delete(requestId);
        resolve({
          ok: false,
          error: err?.message || String(err),
        });
      }
    });
  }

  return {
    registerHandlers,
    invokeAssetAction,
  };
}

module.exports = {
  createAssetActionBridge,
  ASSET_ACTION_TIMEOUT_MS,
};
