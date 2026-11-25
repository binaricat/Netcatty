"use strict";

const { randomUUID } = require("node:crypto");

/**
 * Shared pending-request lifecycle registry for interactive SSH IPC prompts
 * (FIDO2 PIN/touch, encrypted key passphrases, keyboard-interactive auth).
 *
 * Each prompt handler keeps its own IPC channel names, payload schema, and
 * domain semantics (timeout result, pre-aborted signal behavior, resolve vs.
 * notify ordering, and delivery-failure handling).
 *
 * @param {{
 *   prefix: string,
 *   ttlMs: number,
 *   cancelChannel: string,
 *   logTag: string,
 *   notifyBeforeResolve?: boolean,
 *   buildCancelPayload?: (pending: object, requestId: string, reason: string) => object,
 * }} config
 */
function createIpcPromptRegistry({
  prefix,
  ttlMs,
  cancelChannel,
  logTag,
  notifyBeforeResolve = true,
  buildCancelPayload = (_pending, _requestId, reason) => ({ reason }),
}) {
  const requests = new Map();

  function generateRequestId(customPrefix = prefix) {
    return `${customPrefix}-${randomUUID()}`;
  }

  function sendNotification(pending, requestId, notification) {
    if (!notification) return;
    try {
      if (!pending.sender?.isDestroyed?.()) {
        pending.sender?.send?.(notification.channel, {
          requestId,
          ...(notification.payload || {}),
        });
      }
    } catch (err) {
      console.warn(`${logTag} Failed to send ${notification.channel}:`, err.message);
    }
  }

  function removeEntry(requestId) {
    const pending = requests.get(requestId);
    if (!pending) return null;

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
      pending.timeoutId = null;
    }
    pending.abortCleanup?.();
    pending.abortCleanup = null;
    requests.delete(requestId);
    return pending;
  }

  function register(
    requestId,
    entry,
    { onTimeout, signal, onAbort, triggerIfAborted = false } = {},
  ) {
    const timeoutId = setTimeout(() => {
      if (!requests.has(requestId)) return;
      onTimeout?.(requestId);
    }, ttlMs);

    const record = {
      ...entry,
      createdAt: entry.createdAt ?? Date.now(),
      timeoutId,
      abortCleanup: null,
    };
    requests.set(requestId, record);

    if (signal && typeof onAbort === "function") {
      const abortHandler = () => onAbort(requestId);
      record.abortCleanup = () => signal.removeEventListener("abort", abortHandler);
      signal.addEventListener("abort", abortHandler, { once: true });
      if (triggerIfAborted && signal.aborted) {
        abortHandler();
        return { record, abortedImmediately: true };
      }
    }

    return { record, abortedImmediately: false };
  }

  function settle(requestId, result, notification, options = {}) {
    const pending = removeEntry(requestId);
    if (!pending) return false;

    const shouldNotifyFirst = options.notifyBeforeResolve ?? notifyBeforeResolve;
    const invokeResolve = () => {
      if (options.catchResolveError) {
        try {
          pending.resolveCallback(result);
        } catch (err) {
          console.warn(
            `${logTag} ${options.resolveErrorMessage || `Failed to settle request ${requestId}:`}`,
            err?.message,
          );
        }
      } else {
        pending.resolveCallback(result);
      }
    };

    if (shouldNotifyFirst) {
      sendNotification(pending, requestId, notification);
      invokeResolve();
    } else {
      invokeResolve();
      sendNotification(pending, requestId, notification);
    }
    return true;
  }

  function cancel(requestId, reason = "cancelled", result = { cancelled: true }, options = {}) {
    const pending = requests.get(requestId);
    if (!pending) return false;
    return settle(
      requestId,
      result,
      {
        channel: cancelChannel,
        payload: buildCancelPayload(pending, requestId, reason),
      },
      options,
    );
  }

  function cancelWhere(predicate, reason = "cancelled", result = { cancelled: true }, options = {}) {
    let cancelled = 0;
    for (const [requestId, pending] of [...requests.entries()]) {
      if (!predicate(pending, requestId)) continue;
      const didCancel = options.cancelEntry
        ? options.cancelEntry(requestId, reason)
        : cancel(requestId, reason, result, options);
      if (didCancel) cancelled += 1;
    }
    return cancelled;
  }

  function verifySender(event, requestId) {
    const pending = requests.get(requestId);
    if (!pending) {
      return { ok: false, error: "Request not found" };
    }
    if (event?.sender?.id !== pending.webContentsId) {
      return { ok: false, error: "Wrong sender" };
    }
    return { ok: true, pending };
  }

  function getMap() {
    return requests;
  }

  return {
    generateRequestId,
    register,
    removeEntry,
    sendNotification,
    settle,
    cancel,
    cancelWhere,
    verifySender,
    getMap,
  };
}

module.exports = { createIpcPromptRegistry };
