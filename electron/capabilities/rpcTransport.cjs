"use strict";

const { CAPABILITY_SURFACES } = require("./constants.cjs");
const { resolveRpcTimeoutMs } = require("./rpcTimeouts.cjs");

function createTaggedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createUnavailableError(message) {
  return createTaggedError("RPC_UNAVAILABLE", message);
}

function createRpcTimeoutError(method, timeoutMs, createError = createTaggedError) {
  return createError(
    "RPC_TIMEOUT",
    `Timed out waiting for RPC response to "${method}" after ${timeoutMs}ms.`,
  );
}

/**
 * Create a newline-delimited JSON-RPC client over an existing TCP socket.
 */
function createNdjsonRpcClient({
  socket,
  surface = CAPABILITY_SURFACES.BUILTIN,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onBridgeStatus,
  createError = createTaggedError,
  messages = {},
}) {
  if (!socket) {
    throw new Error("socket is required");
  }

  const connectionClosedMessage = messages.connectionClosed
    || "RPC connection closed.";
  const connectionClosedWhileCallMessage = messages.connectionClosedWhileCall
    || connectionClosedMessage;
  const connectionErrorMessage = messages.connectionError
    || ((error) => `RPC connection failed: ${error?.message || error}`);
  const rpcTimeoutMessage = messages.rpcTimeout
    || ((method, timeoutMs) => `Timed out waiting for RPC response to "${method}" after ${timeoutMs}ms.`);
  const writeFailedMessage = messages.writeFailed
    || ((method, error) => `Failed to send RPC "${method}": ${error?.message || error}`);

  let nextRpcId = 1;
  let buffer = "";
  const pending = new Map();
  let bridgeCommandTimeoutMs = null;
  let bridgePermissionMode = null;
  let bridgeApprovalTimeoutMs = null;

  function settle(id, resolve, reject, payload) {
    pending.delete(id);
    clearTimeoutImpl(payload.timeoutId);
    if (payload.error) {
      reject(payload.error);
      return;
    }
    resolve(payload.result);
  }

  function rejectAll(error) {
    for (const [id, entry] of pending) {
      settle(id, entry.resolve, entry.reject, { timeoutId: entry.timeoutId, error });
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message?.id == null) continue;
      const entry = pending.get(message.id);
      if (!entry) continue;

      if (message.error) {
        settle(message.id, entry.resolve, entry.reject, {
          timeoutId: entry.timeoutId,
          error: createError(
            "RPC_ERROR",
            message.error.message || JSON.stringify(message.error),
          ),
        });
      } else {
        settle(message.id, entry.resolve, entry.reject, {
          timeoutId: entry.timeoutId,
          result: message.result,
        });
      }
    }
  });

  socket.on("error", (error) => {
    rejectAll(createError("CONNECTION_ERROR", connectionErrorMessage(error)));
  });

  socket.on("close", () => {
    rejectAll(createError("CONNECTION_CLOSED", connectionClosedMessage));
  });

  async function call(method, params) {
    if (socket.destroyed || !socket.writable) {
      throw createError("CONNECTION_CLOSED", connectionClosedWhileCallMessage);
    }

    const id = nextRpcId++;
    const timeoutMs = resolveRpcTimeoutMs(method, {
      surface,
      bridgeCommandTimeoutMs,
      bridgePermissionMode,
      bridgeApprovalTimeoutMs,
    });

    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeoutImpl(() => {
        pending.delete(id);
        reject(createError("RPC_TIMEOUT", rpcTimeoutMessage(method, timeoutMs)));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeoutId });

      const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      try {
        socket.write(payload, (writeError) => {
          if (!writeError) return;
          settle(id, resolve, reject, {
            timeoutId,
            error: createError("WRITE_FAILED", writeFailedMessage(method, writeError)),
          });
        });
      } catch (writeError) {
        settle(id, resolve, reject, {
          timeoutId,
          error: createError("WRITE_FAILED", writeFailedMessage(method, writeError)),
        });
      }
    });
  }

  function ingestBridgeStatus(statusResult) {
    if (Number.isFinite(statusResult?.commandTimeoutMs) && statusResult.commandTimeoutMs > 0) {
      bridgeCommandTimeoutMs = statusResult.commandTimeoutMs;
    }
    if (typeof statusResult?.permissionMode === "string") {
      bridgePermissionMode = statusResult.permissionMode;
    }
    if (Number.isFinite(statusResult?.approvalTimeoutMs) && statusResult.approvalTimeoutMs > 0) {
      bridgeApprovalTimeoutMs = statusResult.approvalTimeoutMs;
    }
    onBridgeStatus?.({
      bridgeCommandTimeoutMs,
      bridgePermissionMode,
      bridgeApprovalTimeoutMs,
    });
  }

  return {
    call,
    ingestBridgeStatus,
    close() {
      try {
        socket.end();
      } catch {
        // Ignore shutdown errors.
      }
    },
  };
}

module.exports = {
  createTaggedError,
  createUnavailableError,
  createRpcTimeoutError,
  createNdjsonRpcClient,
};
