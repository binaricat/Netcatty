/**
 * WebAuthn IPC helper
 *
 * Allows main-process code (SSH/SFTP bridges) to request a WebAuthn assertion
 * from the renderer via preload, and await the result.
 */

const { getAssertionInBrowser } = require("./webauthnBrowserBridge.cjs");

const log = (msg, data) => {
  console.log("[WebAuthn]", msg, data || "");
};

let handlersRegistered = false;

// requestId -> { resolve, reject, timeout }
const pending = new Map();

function registerHandlers(ipcMain) {
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.on("netcatty:webauthn:response", (_event, payload) => {
    const requestId = payload?.requestId;
    if (!requestId || typeof requestId !== "string") return;

    const entry = pending.get(requestId);
    if (!entry) return;

    pending.delete(requestId);
    clearTimeout(entry.timeout);

    if (payload?.ok) {
      entry.resolve(payload.result);
    } else {
      entry.reject(new Error(payload?.error || "WebAuthn request failed"));
    }
  });
}

function requestWebAuthnAssertion(webContents, params) {
  // macOS: Electron's embedded WebAuthn prompt can hang (no Touch ID UI). For biometric keys,
  // use the system browser helper flow instead.
  log("requestWebAuthnAssertion called", {
    platform: process.platform,
    keySource: params?.keySource,
    rpId: params?.rpId,
    hasCredentialId: !!params?.credentialId,
  });
  
  if (process.platform === "darwin" && params?.keySource === "biometric") {
    log("Using browser helper for biometric key on macOS");
    const timeoutMs = Math.max(1000, params?.timeoutMs || 180000);
    return getAssertionInBrowser({
      rpId: params?.rpId,
      credentialId: params?.credentialId,
      challenge: params?.challenge,
      userVerification: params?.userVerification || "preferred",
      timeoutMs,
    }).then((result) => {
      log("Browser helper assertion succeeded");
      if (!result) throw new Error("WebAuthn assertion was cancelled");
      return {
        origin: result.origin,
        authenticatorData: result.authenticatorData,
        clientDataJSON: result.clientDataJSON,
        signature: result.signature,
        userHandle: result.userHandle,
      };
    }).catch((err) => {
      log("Browser helper assertion failed", { error: err?.message });
      throw err;
    });
  }
  
  log("Using embedded WebAuthn (not biometric on macOS)");

  const requestId = `webauthn-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1000, params?.timeoutMs || 180000);
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("WebAuthn request timed out"));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timeout });

    try {
      webContents.send("netcatty:webauthn:request", {
        requestId,
        ...params,
        timeoutMs,
      });
    } catch (err) {
      pending.delete(requestId);
      clearTimeout(timeout);
      reject(err);
    }
  });
}

module.exports = {
  registerHandlers,
  requestWebAuthnAssertion,
};
