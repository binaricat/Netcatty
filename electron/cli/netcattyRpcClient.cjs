"use strict";

const fs = require("node:fs");
const net = require("node:net");

const { getCliDiscoveryFilePath } = require("./discoveryPath.cjs");

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const EXEC_RPC_TIMEOUT_BUFFER_MS = 5_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 110_000;
const LONG_RUNNING_METHODS = new Set([
  "netcatty/exec",
  "netcatty/jobStart",
  "netcatty/sftp/list",
  "netcatty/sftp/read",
  "netcatty/sftp/upload",
  "netcatty/sftp/write",
  "netcatty/sftp/download",
  "netcatty/sftp/mkdir",
  "netcatty/sftp/delete",
  "netcatty/sftp/rename",
  "netcatty/sftp/stat",
  "netcatty/sftp/chmod",
  "netcatty/sftp/home",
]);
const APPROVAL_WAIT_METHODS = new Set([
  "netcatty/exec",
  "netcatty/jobStart",
  "netcatty/sftp/write",
  "netcatty/sftp/download",
  "netcatty/sftp/upload",
  "netcatty/sftp/mkdir",
  "netcatty/sftp/delete",
  "netcatty/sftp/rename",
  "netcatty/sftp/chmod",
]);

function createError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function resolveRpcTimeoutMs(method, bridgeCommandTimeoutMs, bridgePermissionMode, bridgeApprovalTimeoutMs) {
  const execTimeoutMs = LONG_RUNNING_METHODS.has(method)
    ? (Number.isFinite(bridgeCommandTimeoutMs) && bridgeCommandTimeoutMs > 0
      ? bridgeCommandTimeoutMs
      : DEFAULT_EXEC_TIMEOUT_MS)
    : 0;
  const approvalTimeoutMs = (bridgePermissionMode === "confirm" && APPROVAL_WAIT_METHODS.has(method))
    ? (Number.isFinite(bridgeApprovalTimeoutMs) && bridgeApprovalTimeoutMs > 0
      ? bridgeApprovalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS)
    : 0;

  if (execTimeoutMs > 0 && approvalTimeoutMs > 0) {
    return Math.max(
      DEFAULT_RPC_TIMEOUT_MS,
      approvalTimeoutMs + execTimeoutMs + EXEC_RPC_TIMEOUT_BUFFER_MS,
    );
  }
  if (execTimeoutMs > 0) {
    return Math.max(DEFAULT_RPC_TIMEOUT_MS, execTimeoutMs + EXEC_RPC_TIMEOUT_BUFFER_MS);
  }
  if (approvalTimeoutMs > 0) {
    return Math.max(DEFAULT_RPC_TIMEOUT_MS, approvalTimeoutMs + EXEC_RPC_TIMEOUT_BUFFER_MS);
  }
  return DEFAULT_RPC_TIMEOUT_MS;
}

function loadDiscovery() {
  const discoveryPath = getCliDiscoveryFilePath();
  let raw;
  try {
    raw = fs.readFileSync(discoveryPath, "utf8");
  } catch (err) {
    throw createError(
      "APP_NOT_RUNNING",
      `Netcatty is not running or discovery file is missing at ${discoveryPath}. Start Netcatty first.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw createError(
      "DISCOVERY_INVALID",
      `Netcatty discovery file at ${discoveryPath} is invalid JSON.`,
    );
  }

  if (!parsed?.port || !parsed?.token) {
    throw createError(
      "DISCOVERY_INVALID",
      `Netcatty discovery file at ${discoveryPath} is missing required port/token fields.`,
    );
  }

  return parsed;
}

async function connectClient() {
  const discovery = loadDiscovery();
  const socket = await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: discovery.port }, () => resolve(sock));
    sock.setEncoding("utf8");
    sock.once("error", (err) => {
      reject(createError("CONNECT_FAILED", `Failed to connect to Netcatty TCP bridge: ${err?.message || err}`));
    });
  });

  let nextRpcId = 1;
  let buffer = "";
  const pending = new Map();

  function rejectPending(id, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timeoutId);
    entry.reject(error);
  }

  function settlePending(id, result, error) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timeoutId);
    if (error) {
      entry.reject(error);
      return;
    }
    entry.resolve(result);
  }

  function rejectAllPending(error) {
    for (const id of pending.keys()) {
      rejectPending(id, error);
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg?.id == null || !pending.has(msg.id)) continue;
      if (msg.error) {
        settlePending(msg.id, null, createError("RPC_ERROR", msg.error.message || JSON.stringify(msg.error)));
      } else {
        settlePending(msg.id, msg.result, null);
      }
    }
  });

  socket.on("error", (err) => {
    rejectAllPending(
      createError("CONNECTION_ERROR", `Connection to Netcatty TCP bridge failed: ${err?.message || err}`),
    );
  });

  socket.on("close", () => {
    rejectAllPending(createError("CONNECTION_CLOSED", "Connection to Netcatty TCP bridge closed."));
  });

  let bridgeCommandTimeoutMs = null;
  let bridgePermissionMode = null;
  let bridgeApprovalTimeoutMs = null;

  async function call(method, params) {
    if (socket.destroyed || !socket.writable) {
      throw createError("CONNECTION_CLOSED", "Connection to Netcatty TCP bridge is closed.");
    }
    const id = nextRpcId++;
    const timeoutMs = resolveRpcTimeoutMs(
      method,
      bridgeCommandTimeoutMs,
      bridgePermissionMode,
      bridgeApprovalTimeoutMs,
    );
    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        rejectPending(
          id,
          createError("RPC_TIMEOUT", `Timed out waiting for Netcatty RPC response to "${method}" after ${timeoutMs}ms.`),
        );
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeoutId });

      try {
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          (err) => {
            if (err) {
              rejectPending(
                id,
                createError("WRITE_FAILED", `Failed to send Netcatty RPC "${method}": ${err?.message || err}`),
              );
            }
          },
        );
      } catch (err) {
        rejectPending(
          id,
          createError("WRITE_FAILED", `Failed to send Netcatty RPC "${method}": ${err?.message || err}`),
        );
      }
    });
  }

  const authResult = await call("auth/verify", { token: discovery.token });
  if (!authResult?.ok) {
    throw createError("AUTH_FAILED", "Failed to authenticate to Netcatty TCP bridge.");
  }

  try {
    const statusResult = await call("netcatty/getStatus", {});
    if (Number.isFinite(statusResult?.commandTimeoutMs) && statusResult.commandTimeoutMs > 0) {
      bridgeCommandTimeoutMs = statusResult.commandTimeoutMs;
    }
    if (typeof statusResult?.permissionMode === "string") {
      bridgePermissionMode = statusResult.permissionMode;
    }
    if (Number.isFinite(statusResult?.approvalTimeoutMs) && statusResult.approvalTimeoutMs > 0) {
      bridgeApprovalTimeoutMs = statusResult.approvalTimeoutMs;
    }
  } catch {
    // Keep the default RPC timeout when bridge status cannot be fetched.
  }

  return {
    discovery,
    async call(method, params) {
      return await call(method, params);
    },
    close() {
      try {
        socket.end();
      } catch {
        // ignore shutdown errors
      }
    },
  };
}

module.exports = {
  connectClient,
  createError,
};
