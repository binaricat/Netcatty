"use strict";

/**
 * FIDO2 PIN / touch prompts for OpenSSH sk-* flows.
 * Mirrors passphraseHandler: main requests → renderer modal → respond IPC.
 */

const { createIpcPromptRegistry } = require("./ipcPromptRegistry.cjs");

const REQUEST_TTL_MS = 3 * 60 * 1000;

const registry = createIpcPromptRegistry({
  prefix: "fido",
  ttlMs: REQUEST_TTL_MS,
  cancelChannel: "netcatty:fido-prompt-cancelled",
  logTag: "[FidoPrompt]",
  notifyBeforeResolve: true,
});

function generateRequestId(prefix = "fido") {
  return registry.generateRequestId(prefix);
}

function cancelFidoPromptRequest(requestId, reason = "cancelled") {
  return registry.cancel(requestId, reason, { cancelled: true });
}

/**
 * Cancel prompts owned by an askpass lease (ssh-add or inherited agent signing).
 * @param {string} leaseId
 * @param {string} [reason]
 * @returns {number}
 */
function cancelFidoPromptRequestsForLease(leaseId, reason = "lease-released", notificationsOnly = false) {
  if (typeof leaseId !== "string" || !leaseId) return 0;
  return registry.cancelWhere(
    (pending) => pending.leaseId === leaseId && (!notificationsOnly || pending.notificationOnly),
    reason,
    { cancelled: true },
  );
}

/**
 * @param {Electron.WebContents|null|undefined} sender
 * @param {{
 *   kind: "pin" | "touch" | "confirm" | "recovery",
 *   reason?: string,
 *   allowPasswordFallback?: boolean,
 *   message?: string,
 *   title?: string,
 *   keyName?: string,
 *   notificationOnly?: boolean,
 *   leaseId?: string,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ cancelled?: boolean, response?: string|null } | null>}
 */
function requestFidoPrompt(sender, options = {}) {
  return new Promise((resolve) => {
    if (!sender || sender.isDestroyed?.()) {
      console.warn("[FidoPrompt] No live sender; cannot show FIDO prompt");
      resolve(null);
      return;
    }

    const kind = ["touch", "confirm", "recovery"].includes(options.kind) ? options.kind : "pin";
    const leaseId = typeof options.leaseId === "string" ? options.leaseId : "";
    const requestId = generateRequestId(kind);

    const { abortedImmediately } = registry.register(
      requestId,
      {
        resolveCallback: resolve,
        sender,
        webContentsId: sender.id,
        kind,
        leaseId,
        notificationOnly: options.notificationOnly === true,
      },
      {
        onTimeout: (id) => {
          registry.settle(
            id,
            { cancelled: true },
            { channel: "netcatty:fido-prompt-timeout" },
          );
        },
        signal: options.signal,
        onAbort: (id) => cancelFidoPromptRequest(id, "helper-exited"),
        triggerIfAborted: true,
      },
    );

    if (abortedImmediately) {
      return;
    }

    try {
      sender.send("netcatty:fido-prompt-request", {
        requestId,
        kind,
        message: options.message || "",
        title: options.title || "",
        keyName: options.keyName || "",
        notificationOnly: options.notificationOnly === true,
        reason: options.reason,
        allowPasswordFallback: options.allowPasswordFallback === true,
      });
    } catch (err) {
      console.error("[FidoPrompt] Failed to send request:", err);
      registry.settle(requestId, null);
    }
  });
}

function handleResponse(_event, payload = {}) {
  const { requestId, response, cancelled } = payload;
  const verification = registry.verifySender(_event, requestId);
  if (!verification.ok) {
    return { success: false, error: verification.error };
  }
  if (cancelled) {
    registry.settle(requestId, { cancelled: true });
  } else {
    registry.settle(requestId, { response: typeof response === "string" ? response : "" });
  }
  return { success: true };
}

function registerHandler(ipcMain) {
  ipcMain.handle("netcatty:fido-prompt:respond", handleResponse);
}

function getRequests() {
  return registry.getMap();
}

/**
 * Classify OpenSSH / ssh-sk-helper askpass prompt text.
 * @param {string} prompt
 * @returns {"pin"|"touch"|"confirm"}
 */
function classifyAskpassPrompt(prompt) {
  const p = String(prompt || "").toLowerCase();
  // ssh-agent combines both requirements in one prompt for verify-required
  // keys: "Enter PIN and confirm user presence ...". It still expects a PIN
  // on stdout; classifying it as touch would silently return an empty string.
  if (/\bpin\b|密码|密碼|口令/.test(p)) return "pin";
  if (/confirm user presence|touch (your |the )?(security )?key|tap (your |the )?(security )?key|user presence|请触摸|請觸摸|请轻触/.test(p)) {
    return "touch";
  }
  if (/pin|authenticator|fido|security key|enter.*code|密码|pin 码|口令/.test(p)) {
    return "pin";
  }
  // Default to PIN-style secret entry for unknown askpass prompts from sk-helper.
  return "pin";
}

module.exports = {
  generateRequestId,
  requestFidoPrompt,
  cancelFidoPromptRequest,
  cancelFidoPromptRequestsForLease,
  handleResponse,
  registerHandler,
  getRequests,
  classifyAskpassPrompt,
};
