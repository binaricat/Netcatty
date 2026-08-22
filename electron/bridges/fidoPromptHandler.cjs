"use strict";

/**
 * FIDO2 PIN / touch prompts for OpenSSH sk-* flows.
 * Mirrors passphraseHandler: main requests → renderer modal → respond IPC.
 */

const { randomUUID } = require("node:crypto");

/** @type {Map<string, {
 *   resolveCallback: (result: { cancelled?: boolean, response?: string|null }) => void,
 *   sender: Electron.WebContents,
 *   webContentsId: number,
 *   kind: string,
 *   leaseId: string,
 *   createdAt: number,
 *   timeoutId: NodeJS.Timeout,
 * }>} */
const fidoPromptRequests = new Map();

const REQUEST_TTL_MS = 3 * 60 * 1000;

function generateRequestId(prefix = "fido") {
  return `${prefix}-${randomUUID()}`;
}

function settleRequest(requestId, result, notification) {
  const pending = fidoPromptRequests.get(requestId);
  if (!pending) return false;

  if (pending.timeoutId) clearTimeout(pending.timeoutId);
  fidoPromptRequests.delete(requestId);

  if (notification) {
    try {
      if (!pending.sender?.isDestroyed?.()) {
        pending.sender?.send?.(notification.channel, {
          requestId,
          ...(notification.payload || {}),
        });
      }
    } catch (err) {
      console.warn(`[FidoPrompt] Failed to send ${notification.channel}:`, err.message);
    }
  }

  pending.resolveCallback(result);
  return true;
}

function cancelFidoPromptRequest(requestId, reason = "cancelled") {
  return settleRequest(
    requestId,
    { cancelled: true },
    {
      channel: "netcatty:fido-prompt-cancelled",
      payload: { reason },
    },
  );
}

/**
 * Cancel prompts owned by an askpass lease (ssh-add or inherited agent signing).
 * @param {string} leaseId
 * @param {string} [reason]
 * @returns {number}
 */
function cancelFidoPromptRequestsForLease(leaseId, reason = "lease-released") {
  if (typeof leaseId !== "string" || !leaseId) return 0;
  let cancelled = 0;
  for (const [requestId, pending] of [...fidoPromptRequests.entries()]) {
    if (pending.leaseId !== leaseId) continue;
    if (cancelFidoPromptRequest(requestId, reason)) cancelled += 1;
  }
  return cancelled;
}

/**
 * @param {Electron.WebContents|null|undefined} sender
 * @param {{
 *   kind: "pin" | "touch" | "confirm",
 *   message?: string,
 *   title?: string,
 *   keyName?: string,
 *   leaseId?: string,
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

    const kind = options.kind === "touch" || options.kind === "confirm" ? options.kind : "pin";
    const leaseId = typeof options.leaseId === "string" ? options.leaseId : "";
    const requestId = generateRequestId(kind);
    const timeoutId = setTimeout(() => {
      settleRequest(
        requestId,
        { cancelled: true },
        { channel: "netcatty:fido-prompt-timeout" },
      );
    }, REQUEST_TTL_MS);

    fidoPromptRequests.set(requestId, {
      resolveCallback: resolve,
      sender,
      webContentsId: sender.id,
      kind,
      leaseId,
      createdAt: Date.now(),
      timeoutId,
    });

    try {
      sender.send("netcatty:fido-prompt-request", {
        requestId,
        kind,
        message: options.message || "",
        title: options.title || "",
        keyName: options.keyName || "",
      });
    } catch (err) {
      console.error("[FidoPrompt] Failed to send request:", err);
      settleRequest(requestId, null);
    }
  });
}

function handleResponse(_event, payload = {}) {
  const { requestId, response, cancelled } = payload;
  const pending = fidoPromptRequests.get(requestId);
  if (!pending) {
    return { success: false, error: "Request not found" };
  }
  if (_event?.sender?.id !== pending.webContentsId) {
    return { success: false, error: "Wrong sender" };
  }
  if (cancelled) {
    settleRequest(requestId, { cancelled: true });
  } else {
    settleRequest(requestId, { response: typeof response === "string" ? response : "" });
  }
  return { success: true };
}

function registerHandler(ipcMain) {
  ipcMain.handle("netcatty:fido-prompt:respond", handleResponse);
}

function getRequests() {
  return fidoPromptRequests;
}

/**
 * Classify OpenSSH / ssh-sk-helper askpass prompt text.
 * @param {string} prompt
 * @returns {"pin"|"touch"|"confirm"}
 */
function classifyAskpassPrompt(prompt) {
  const p = String(prompt || "").toLowerCase();
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
