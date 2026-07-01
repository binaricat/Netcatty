"use strict";

const crypto = require("node:crypto");

const VAULT_AGENT_TIMEOUT_MS = 15_000;
const pendingVaultRequests = new Map();

function createVaultAgentBridge({ getMainWindowFn, validateSender }) {
  function registerHandlers(ipcMain) {
    ipcMain.handle("netcatty:ai:vault-agent:response", (event, { requestId, result }) => {
      if (!validateSender(event)) {
        return { ok: false, error: "Unauthorized IPC sender" };
      }
      if (!requestId || typeof requestId !== "string") {
        return { ok: false, error: "requestId is required" };
      }
      const entry = pendingVaultRequests.get(requestId);
      if (!entry) {
        return { ok: false, error: "Unknown or expired vault agent request." };
      }
      clearTimeout(entry.timer);
      pendingVaultRequests.delete(requestId);
      entry.resolve(result);
      return { ok: true };
    });
  }

  async function invokeVaultAgent(op, params = {}, options = {}) {
    const mainWin = typeof getMainWindowFn === "function" ? getMainWindowFn() : null;
    if (!mainWin || mainWin.isDestroyed()) {
      return {
        ok: false,
        error: "No active Netcatty window is available for vault access.",
      };
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingVaultRequests.has(requestId)) return;
        pendingVaultRequests.delete(requestId);
        resolve({
          ok: false,
          error: "Vault agent bridge timed out waiting for renderer.",
        });
      }, options.timeoutMs ?? VAULT_AGENT_TIMEOUT_MS);

      pendingVaultRequests.set(requestId, { resolve, timer });
      try {
        mainWin.webContents.send("netcatty:ai:vault-agent:request", {
          requestId,
          op,
          params,
        });
      } catch (err) {
        clearTimeout(timer);
        pendingVaultRequests.delete(requestId);
        resolve({
          ok: false,
          error: err?.message || String(err),
        });
      }
    });
  }

  return {
    registerHandlers,
    invokeVaultAgent,
  };
}

module.exports = {
  createVaultAgentBridge,
  VAULT_AGENT_TIMEOUT_MS,
};
