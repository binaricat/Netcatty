"use strict";

const fs = require("node:fs");
const net = require("node:net");

const { getPublicMcpDiscoveryFilePath } = require("../cli/publicMcpDiscoveryPath.cjs");

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_BUFFER_MS = 5_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 110_000;
const LONG_RUNNING_METHODS = new Set([
  "public/terminalExecute",
  "public/terminalStart",
  "public/sftp/list",
  "public/sftp/readFile",
  "public/sftp/writeFile",
  "public/sftp/stat",
  "public/sftp/home",
  "public/sftp/mkdir",
  "public/sftp/delete",
  "public/sftp/rename",
  "public/sftp/chmod",
]);
const APPROVAL_WAIT_METHODS = new Set([
  "public/terminalExecute",
  "public/terminalStart",
  "public/sftp/writeFile",
  "public/sftp/mkdir",
  "public/sftp/delete",
  "public/sftp/rename",
  "public/sftp/chmod",
  "public/asset/add",
  "public/asset/edit",
  "public/asset/remove",
  "public/asset/open",
  "public/asset/connect",
  "public/asset/disconnect",
  "public/asset/reconnect",
]);

function getMcpSdk() {
  return {
    McpServer: require("@modelcontextprotocol/sdk/server/mcp.js").McpServer,
    StdioServerTransport: require("@modelcontextprotocol/sdk/server/stdio.js").StdioServerTransport,
  };
}

function getZod() {
  return require("zod").z;
}

function createUnavailableError(message) {
  const error = new Error(message);
  error.code = "PUBLIC_MCP_UNAVAILABLE";
  return error;
}

function createRpcTimeoutError(method, timeoutMs) {
  const error = new Error(
    `Timed out waiting for Public MCP RPC response to "${method}" after ${timeoutMs}ms. ` +
      "The bridge does not cancel in-flight operations on client timeout; the remote operation may still complete.",
  );
  error.code = "PUBLIC_MCP_RPC_TIMEOUT";
  return error;
}

function resolvePublicRpcTimeoutMs(method, bridgeCommandTimeoutMs, bridgePermissionMode, bridgeApprovalTimeoutMs) {
  const operationTimeoutMs = LONG_RUNNING_METHODS.has(method)
    ? (Number.isFinite(bridgeCommandTimeoutMs) && bridgeCommandTimeoutMs > 0
      ? bridgeCommandTimeoutMs
      : DEFAULT_OPERATION_TIMEOUT_MS)
    : 0;
  const approvalTimeoutMs = APPROVAL_WAIT_METHODS.has(method)
    ? (Number.isFinite(bridgeApprovalTimeoutMs) && bridgeApprovalTimeoutMs > 0
      ? bridgeApprovalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS)
    : 0;

  if (operationTimeoutMs > 0 && approvalTimeoutMs > 0) {
    return Math.max(DEFAULT_RPC_TIMEOUT_MS, approvalTimeoutMs + operationTimeoutMs + RPC_TIMEOUT_BUFFER_MS);
  }
  if (operationTimeoutMs > 0) {
    return Math.max(DEFAULT_RPC_TIMEOUT_MS, operationTimeoutMs + RPC_TIMEOUT_BUFFER_MS);
  }
  if (approvalTimeoutMs > 0) {
    return Math.max(DEFAULT_RPC_TIMEOUT_MS, approvalTimeoutMs + RPC_TIMEOUT_BUFFER_MS);
  }
  return DEFAULT_RPC_TIMEOUT_MS;
}

function readDiscovery({ discoveryPath = getPublicMcpDiscoveryFilePath(), fsModule = fs } = {}) {
  let raw;
  try {
    raw = fsModule.readFileSync(discoveryPath, "utf8");
  } catch (error) {
    throw createUnavailableError("Netcatty is not running or Public MCP is disabled.");
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw createUnavailableError("Netcatty Public MCP discovery is invalid.");
  }

  if (!payload?.port || !payload?.token) {
    throw createUnavailableError("Netcatty Public MCP discovery is incomplete.");
  }

  return payload;
}

function shouldRetryConnection(error) {
  return /closed|refused|stale|auth|connect|econnrefused/i.test(error?.message || "");
}

async function connectPublicBridge(discovery, options = {}) {
  const netModule = options.netModule || net;
  const setTimeoutImpl = options.setTimeout || setTimeout;
  const clearTimeoutImpl = options.clearTimeout || clearTimeout;
  const socket = await new Promise((resolve, reject) => {
    const sock = netModule.createConnection(
      { host: discovery.host || "127.0.0.1", port: discovery.port },
      () => resolve(sock),
    );
    sock.setEncoding("utf8");
    sock.once("error", (error) => {
      reject(createUnavailableError(`Netcatty Public MCP bridge is unavailable: ${error?.message || error}`));
    });
  });

  let buffer = "";
  let nextRpcId = 1;
  let bridgeCommandTimeoutMs = null;
  let bridgePermissionMode = null;
  let bridgeApprovalTimeoutMs = null;
  const pending = new Map();

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
          error: new Error(message.error.message || "Public MCP RPC failed"),
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
    rejectAll(createUnavailableError(`Netcatty Public MCP bridge connection failed: ${error?.message || error}`));
  });

  socket.on("close", () => {
    rejectAll(createUnavailableError("Netcatty Public MCP bridge connection closed."));
  });

  async function call(method, params) {
    if (socket.destroyed || !socket.writable) {
      throw createUnavailableError("Netcatty Public MCP bridge connection closed.");
    }

    const id = nextRpcId++;
    const timeoutMs = resolvePublicRpcTimeoutMs(method, bridgeCommandTimeoutMs, bridgePermissionMode, bridgeApprovalTimeoutMs);
    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeoutImpl(() => {
        pending.delete(id);
        reject(createRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeoutId });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  const authResult = await call("auth/verify", { token: discovery.token });
  if (!authResult?.ok) {
    throw createUnavailableError("Netcatty Public MCP token is stale. Retry after refreshing discovery.");
  }

  try {
    const statusResult = await call("public/getStatus", {});
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
    // Keep the conservative long-operation default when bridge status cannot be fetched.
  }

  return {
    async call(method, params) {
      return await call(method, params);
    },
    close() {
      try {
        socket.end();
      } catch {
        // Ignore shutdown errors.
      }
    },
  };
}

function createPublicBridgeClientManager(options = {}) {
  const readDiscoveryImpl = options.readDiscovery || (() => readDiscovery());
  const connectImpl = options.connectPublicBridge || ((discovery) => connectPublicBridge(discovery));
  const shouldRetryImpl = options.shouldRetryConnection || shouldRetryConnection;
  const onRetry = options.onRetry || (() => {});
  let client = null;

  async function ensureConnected() {
    if (client) return client;
    const discovery = readDiscoveryImpl();
    client = await connectImpl(discovery);
    return client;
  }

  function reset() {
    try {
      client?.close?.();
    } catch {
      // Ignore reset failures.
    }
    client = null;
  }

  async function call(method, params) {
    try {
      const activeClient = await ensureConnected();
      return await activeClient.call(method, params);
    } catch (error) {
      if (!shouldRetryImpl(error)) {
        throw error;
      }
      reset();
      onRetry(error);
      try {
        const retryClient = await ensureConnected();
        return await retryClient.call(method, params);
      } catch (retryError) {
        reset();
        if (!shouldRetryImpl(retryError)) {
          throw retryError;
        }
        throw createUnavailableError(retryError?.message || "Netcatty is not running or Public MCP is disabled.");
      }
    }
  }

  return {
    call,
    reset,
  };
}

function mapToolResult(result) {
  if (!result?.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${result?.error || "Public MCP request failed"}` }],
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

const PUBLIC_TOOL_DEFINITIONS = {
  get_environment: {
    description: "Get the currently public live SSH PTY sessions exposed by Netcatty Public MCP.",
    schemaBuilder: () => ({}),
    rpcMethod: "public/getEnvironment",
    buildParams: () => ({}),
  },
  terminal_execute: {
    description: "Execute a short command in a visible live SSH PTY session exposed by Netcatty.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        command: z.string().describe("The command to execute in the target session."),
      };
    },
    rpcMethod: "public/terminalExecute",
    buildParams: ({ sessionId, command }) => ({ sessionId, command }),
  },
  terminal_start: {
    description: "Start a long-running command in a visible live SSH PTY session exposed by Netcatty.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        command: z.string().describe("The command to start in the target session."),
      };
    },
    rpcMethod: "public/terminalStart",
    buildParams: ({ sessionId, command }) => ({ sessionId, command }),
  },
  terminal_poll: {
    description: "Poll a long-running terminal job started by terminal_start.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        jobId: z.string().describe("The background job ID returned by terminal_start."),
        offset: z.number().int().min(0).optional().describe("Output offset returned by the previous poll."),
      };
    },
    rpcMethod: "public/terminalPoll",
    buildParams: ({ jobId, offset }) => ({ jobId, offset: offset || 0 }),
  },
  terminal_stop: {
    description: "Stop a long-running terminal job started by terminal_start.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        jobId: z.string().describe("The background job ID returned by terminal_start."),
      };
    },
    rpcMethod: "public/terminalStop",
    buildParams: ({ jobId }) => ({ jobId }),
  },
  sftp_list: {
    description: "List a remote directory over the live SSH session's SFTP connection.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        path: z.string().describe("Remote directory path."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/list",
    buildParams: ({ sessionId, path, encoding }) => ({ sessionId, path, encoding }),
  },
  sftp_read_file: {
    description: "Read a remote file over the live SSH session's SFTP connection.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        path: z.string().describe("Remote file path."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/readFile",
    buildParams: ({ sessionId, path, encoding }) => ({ sessionId, path, encoding }),
  },
  sftp_write_file: {
    description: "Write a remote file over the live SSH session's SFTP connection.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        path: z.string().describe("Remote file path."),
        content: z.string().describe("Text content to write."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/writeFile",
    buildParams: ({ sessionId, path, content, encoding }) => ({ sessionId, path, content, encoding }),
  },
  sftp_stat: {
    description: "Get remote file metadata over SFTP.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        path: z.string().describe("Remote path."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/stat",
    buildParams: ({ sessionId, path, encoding }) => ({ sessionId, path, encoding }),
  },
  sftp_home: {
    description: "Get the SSH session's remote home directory.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
      };
    },
    rpcMethod: "public/sftp/home",
    buildParams: ({ sessionId }) => ({ sessionId }),
  },
  sftp_mkdir: {
    description: "Create a remote directory over SFTP.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        path: z.string().describe("Remote directory path."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/mkdir",
    buildParams: ({ sessionId, path, encoding }) => ({ sessionId, path, encoding }),
  },
  sftp_delete: {
    description: "Delete a remote file or directory over SFTP.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        path: z.string().describe("Remote path."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/delete",
    buildParams: ({ sessionId, path, encoding }) => ({ sessionId, path, encoding }),
  },
  sftp_rename: {
    description: "Rename a remote file or directory over SFTP.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        oldPath: z.string().describe("Existing remote path."),
        newPath: z.string().describe("Replacement remote path."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/rename",
    buildParams: ({ sessionId, oldPath, newPath, encoding }) => ({ sessionId, oldPath, newPath, encoding }),
  },
  sftp_chmod: {
    description: "Change remote file mode over SFTP.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("The session ID returned by get_environment."),
        path: z.string().describe("Remote path."),
        mode: z.string().describe("File mode, for example 0644."),
        encoding: z.string().optional().describe("Optional remote path encoding override."),
      };
    },
    rpcMethod: "public/sftp/chmod",
    buildParams: ({ sessionId, path, mode, encoding }) => ({ sessionId, path, mode, encoding }),
  },
  asset_list: {
    description: "List saved server assets from Netcatty Vault Hosts (metadata only; no passwords or keys).",
    schemaBuilder: () => ({}),
    rpcMethod: "public/asset/list",
    buildParams: () => ({}),
  },
  asset_get: {
    description: "Get a saved server asset by host ID (metadata only; no passwords or keys).",
    schemaBuilder: () => {
      const z = getZod();
      return {
        hostId: z.string().describe("Saved server asset host ID."),
      };
    },
    rpcMethod: "public/asset/get",
    buildParams: ({ hostId }) => ({ hostId }),
  },
  asset_add: {
    description: "Add one or more saved server assets to Netcatty Vault Hosts.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        hosts: z.string().describe("JSON array of server asset host objects."),
        dryRun: z.string().optional().describe("Set to true to validate and preview without writing."),
        skipDuplicates: z.string().optional().describe("Set to false to create even when a matching asset exists."),
      };
    },
    rpcMethod: "public/asset/add",
    buildParams: ({ hosts, dryRun, skipDuplicates }) => ({ hosts, dryRun, skipDuplicates }),
  },
  asset_edit: {
    description: "Edit fields on a saved server asset.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        hostId: z.string().describe("Saved server asset host ID."),
        patch: z.string().describe("JSON object of fields to patch on the asset."),
      };
    },
    rpcMethod: "public/asset/edit",
    buildParams: ({ hostId, patch }) => ({ hostId, patch }),
  },
  asset_remove: {
    description: "Remove a saved server asset from Netcatty Vault Hosts.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        hostId: z.string().describe("Saved server asset host ID."),
      };
    },
    rpcMethod: "public/asset/remove",
    buildParams: ({ hostId }) => ({ hostId }),
  },
  asset_open: {
    description: "Open a saved server asset in the Netcatty Vault Hosts UI.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        hostId: z.string().describe("Saved server asset host ID to open."),
      };
    },
    rpcMethod: "public/asset/open",
    buildParams: ({ hostId }) => ({ hostId }),
  },
  asset_connect: {
    description: "Open a new SSH terminal session for a saved server asset.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        hostId: z.string().describe("Saved SSH server asset host ID to connect."),
      };
    },
    rpcMethod: "public/asset/connect",
    buildParams: ({ hostId }) => ({ hostId }),
  },
  asset_disconnect: {
    description: "Close an existing terminal session for a saved server asset.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().optional().describe("Terminal session ID to close."),
        hostId: z.string().optional().describe("Saved server asset host ID. Required when sessionId is omitted."),
      };
    },
    rpcMethod: "public/asset/disconnect",
    buildParams: ({ sessionId, hostId }) => ({ sessionId, hostId }),
  },
  asset_reconnect: {
    description: "Close and reopen an existing SSH terminal session for a saved server asset.",
    schemaBuilder: () => {
      const z = getZod();
      return {
        sessionId: z.string().describe("Terminal session ID to close and reopen."),
        hostId: z.string().optional().describe("Optional saved server asset host ID to validate before reconnecting."),
      };
    },
    rpcMethod: "public/asset/reconnect",
    buildParams: ({ sessionId, hostId }) => ({ sessionId, hostId }),
  },
};

function buildPublicMcpServer(options = {}) {
  const { McpServer } = getMcpSdk();
  const clientManager = options.clientManager || createPublicBridgeClientManager();
  const server = options.server || new McpServer({
    name: "netcatty-public",
    version: "1.0.0",
  });

  for (const [toolName, definition] of Object.entries(PUBLIC_TOOL_DEFINITIONS)) {
    server.tool(
      toolName,
      definition.description,
      definition.schemaBuilder ? definition.schemaBuilder() : definition.schema,
      async (input = {}) => {
        try {
          const result = await clientManager.call(definition.rpcMethod, definition.buildParams(input));
          return mapToolResult(result);
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: ${error?.message || String(error)}` }],
          };
        }
      },
    );
  }

  return { server, clientManager };
}

async function main() {
  const { StdioServerTransport } = getMcpSdk();
  const { server } = buildPublicMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[netcatty-public-mcp] Fatal: ${error?.message || error}\n`);
    process.exit(1);
  });
}

module.exports = {
  createUnavailableError,
  createRpcTimeoutError,
  resolvePublicRpcTimeoutMs,
  readDiscovery,
  connectPublicBridge,
  createPublicBridgeClientManager,
  mapToolResult,
  PUBLIC_TOOL_DEFINITIONS,
  buildPublicMcpServer,
  main,
};
