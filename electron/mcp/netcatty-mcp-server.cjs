/**
 * Netcatty MCP Server (stdio transport)
 *
 * Spawned by managed SDK agents as a child process.
 * Communicates with the Netcatty main process via TCP (JSON-RPC over newline-delimited JSON).
 * Exposes Netcatty terminal tools so external agents can operate on scoped sessions.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { getCatalogToolDescription } = require("./catalogToolMetadata.cjs");
const { NETCATTY_MCP_SERVER_INSTRUCTIONS } = require("./netcattyMcpInstructions.cjs");
const { registerProgressiveMcpTools } = require("./progressiveMcpTools.cjs");
const { normalizeMcpJsonRpcMessage } = require("./normalizeMcpCallArguments.cjs");

function catalogDescription(toolName, fallback) {
  return getCatalogToolDescription(toolName) || fallback;
}

const { createPrivacyBoundary } = require("./externalMcpPrivacyBoundary.cjs");

const DEBUG_MCP = process.env.NETCATTY_MCP_DEBUG === "1";

function debugLog(...args) {
  if (!DEBUG_MCP) return;
  process.stderr.write(`[netcatty-mcp:debug] ${args.map(arg => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(" ")}\n`);
}

// ── TCP Bridge to Netcatty main process ──

// External stdio clients outlive Netcatty. Their port and token stay mutable so
// a later call can refresh discovery. Managed children receive a fixed env and
// keep the original fail-fast exit.
const externalDiscoveryPath = process.env.NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE;
let NETCATTY_MCP_PORT = parseInt(process.env.NETCATTY_MCP_PORT, 10);
let NETCATTY_MCP_TOKEN = process.env.NETCATTY_MCP_TOKEN || "";
if (!externalDiscoveryPath) {
  if (!NETCATTY_MCP_PORT) {
    process.stderr.write("[netcatty-mcp] NETCATTY_MCP_PORT not set\n");
    process.exit(1);
  }
  if (!NETCATTY_MCP_TOKEN) {
    process.stderr.write("[netcatty-mcp] NETCATTY_MCP_TOKEN not set\n");
    process.exit(1);
  }
}

// Scoped session IDs (comma-separated). When set (even if empty), only listed
// sessions are accessible. When unset, scope enforcement falls back to the
// TCP bridge's own scoping (which also defaults to no-access when empty).
const SCOPED_SESSION_IDS = process.env.NETCATTY_MCP_SESSION_IDS != null
  ? process.env.NETCATTY_MCP_SESSION_IDS.split(",").map(s => s.trim()).filter(Boolean)
  : null;

// Chat session ID for per-scope metadata isolation
const CHAT_SESSION_ID = process.env.NETCATTY_MCP_CHAT_SESSION_ID || null;

// Permission mode: 'observer' | 'confirm' | 'auto' (defense-in-depth, TCP bridge also checks).
// External MCP clients may keep a long-lived stdio process; re-read discovery so
// Settings → AI → Safety changes apply without restarting the client.
function readPermissionMode() {
  if (process.env.NETCATTY_MCP_DELEGATED_TOOLS !== undefined) return "confirm";
  const discoveryPath = process.env.NETCATTY_EXTERNAL_MCP_DISCOVERY_FILE;
  if (discoveryPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
      if (typeof parsed?.permissionMode === "string" && parsed.permissionMode.trim()) {
        return parsed.permissionMode.trim();
      }
    } catch {
      // Fall through to env / default.
    }
  }
  return process.env.NETCATTY_MCP_PERMISSION_MODE || "confirm";
}

// Default command blocklist (defense-in-depth, TCP bridge also checks)
const DEFAULT_COMMAND_BLOCKLIST = require("../../lib/commandBlocklist.cjs");

// Pre-compile blocklist regexes once at module load time
const compiledBlocklist = DEFAULT_COMMAND_BLOCKLIST.map(pattern => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null; // placeholder for invalid patterns
  }
});

function checkCommandSafety(command) {
  for (let i = 0; i < compiledBlocklist.length; i++) {
    const re = compiledBlocklist[i];
    if (re && re.test(command)) {
      return { blocked: true, matchedPattern: DEFAULT_COMMAND_BLOCKLIST[i] };
    }
  }
  return { blocked: false };
}

/** Guard for write tools: blocks in observer mode, optionally checks command safety. */
function guardWriteOperation(command, { skipBlocklist = false } = {}) {
  if (readPermissionMode() === "observer") {
    return 'Operation denied: permission mode is "observer" (read-only). Change to "confirm" or "auto" in Settings → AI → Safety to allow this action.';
  }
  // When skipBlocklist is true, the caller relies on the TCP bridge layer for
  // session-aware blocklist checks (e.g. serial and network device sessions skip shell patterns).
  if (!skipBlocklist && command) {
    const safety = checkCommandSafety(command);
    if (safety.blocked) {
      return `Command blocked by safety policy. Pattern: ${safety.matchedPattern}`;
    }
  }
  return null;
}

let tcpSocket = null;
let pendingRequests = new Map(); // id -> { resolve, reject, sock }
let nextRpcId = 1;
let tcpBuffer = "";

// `destroyed` stays false after the peer FIN has already moved readyState to
// "closed". Writing in that window hits writeAfterFIN and rejects the call
// with "TCP connection lost" instead of reconnecting.
function isLiveSocket(sock) {
  return Boolean(
    sock
    && !sock.destroyed
    && sock.readyState === "open"
    && sock.writable
    && !sock.readableEnded
    && !sock.writableEnded
  );
}

function rejectPendingOnSocket(sock, externalMessage) {
  const managed = !externalDiscoveryPath;
  if (managed && tcpSocket === sock) tcpSocket = null;
  const message = managed ? "Not connected to Netcatty" : externalMessage;
  for (const [id, pending] of pendingRequests) {
    if (pending.sock !== sock) continue;
    pendingRequests.delete(id);
    pending.reject(new Error(message));
  }
}

function connectTcp() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: NETCATTY_MCP_PORT }, () => {
      tcpSocket = sock;
      debugLog("Connected to TCP bridge", { port: NETCATTY_MCP_PORT });
      resolve();
    });
    sock.setEncoding("utf-8");
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB
    sock.on("data", (chunk) => {
      if (tcpSocket !== sock) return;
      tcpBuffer += chunk;
      if (tcpBuffer.length > MAX_BUFFER_SIZE) {
        process.stderr.write(`[netcatty-mcp] TCP buffer exceeded ${MAX_BUFFER_SIZE} bytes, clearing buffer\n`);
        tcpBuffer = "";
        return;
      }
      let newlineIdx;
      while ((newlineIdx = tcpBuffer.indexOf("\n")) !== -1) {
        const line = tcpBuffer.slice(0, newlineIdx);
        tcpBuffer = tcpBuffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          debugLog("TCP message received", {
            id: msg?.id,
            hasError: Boolean(msg?.error),
            keys: msg ? Object.keys(msg) : [],
          });
          if (msg.id != null && pendingRequests.has(msg.id)) {
            const { resolve: res, reject: rej } = pendingRequests.get(msg.id);
            pendingRequests.delete(msg.id);
            if (msg.error) {
              rej(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              res(msg.result);
            }
          }
        } catch {
          // ignore malformed lines
        }
      }
    });
    sock.on("error", (err) => {
      debugLog("TCP socket error", { message: err?.message || String(err) });
      reject(err);
      // External in-flight calls stay rejected and are not replayed.
      // Managed children do not reread discovery, so a call that races the
      // dead socket fails as not-connected rather than "TCP connection lost".
      rejectPendingOnSocket(sock, "TCP connection lost");
    });
    sock.on("close", () => {
      debugLog("TCP socket closed");
      rejectPendingOnSocket(sock, "TCP connection closed");
      if (tcpSocket === sock) tcpSocket = null;
    });
  });
}

function sendRpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!isLiveSocket(tcpSocket)) {
      reject(new Error("Not connected to Netcatty"));
      return;
    }
    const sock = tcpSocket;
    const id = nextRpcId++;
    pendingRequests.set(id, { resolve, reject, sock });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    debugLog("rpcCall", { id, method });
    sock.write(msg);
  });
}

function temporaryUnavailable(error) {
  const message = error?.message || String(error || "connection failed");
  if (message.startsWith("Netcatty is temporarily unavailable")) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`Netcatty is temporarily unavailable: ${message}`);
}

function refreshExternalEndpoint() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(externalDiscoveryPath, "utf8"));
  } catch {
    throw new Error("Netcatty is temporarily unavailable: discovery file is missing or unreadable");
  }
  const port = parseInt(parsed?.port, 10);
  const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
  if (!port || !token) {
    throw new Error("Netcatty is temporarily unavailable: discovery endpoint is incomplete");
  }
  NETCATTY_MCP_PORT = port;
  NETCATTY_MCP_TOKEN = token;
}

function dropActiveSocket() {
  const sock = tcpSocket;
  tcpSocket = null;
  tcpBuffer = "";
  if (sock && !sock.destroyed) sock.destroy();
}

// One reconnect at a time. Auth uses sendRpc so callers waiting on this promise
// cannot deadlock, and calls already rejected by close/error stay rejected.
let connecting = null;

async function connectAndAuth() {
  // Drop the reference only. In-flight requests stay bound to the old socket
  // and are rejected when that socket closes; they are not replayed.
  if (!isLiveSocket(tcpSocket)) {
    tcpSocket = null;
    tcpBuffer = "";
  }
  refreshExternalEndpoint();
  tcpBuffer = "";
  try {
    await connectTcp();
    const authResult = await sendRpc("auth/verify", { token: NETCATTY_MCP_TOKEN });
    if (!authResult?.ok) {
      throw new Error("Netcatty is temporarily unavailable: TCP bridge authentication failed");
    }
  } catch (error) {
    dropActiveSocket();
    throw temporaryUnavailable(error);
  }
  process.stderr.write("[netcatty-mcp] Authenticated with TCP bridge\n");
}

function ensureConnected() {
  // Join an in-flight reconnect before trusting tcpSocket. connectTcp assigns
  // the socket before auth/verify returns; a second caller must wait for that
  // re-auth instead of sending on an unauthenticated socket.
  if (connecting) return connecting;
  if (isLiveSocket(tcpSocket)) return Promise.resolve();
  connecting = connectAndAuth().finally(() => {
    connecting = null;
  });
  return connecting;
}

function rpcCall(method, params) {
  if (!externalDiscoveryPath) return sendRpc(method, params);
  return ensureConnected().then(() => sendRpc(method, params));
}

// External clients own connection maps here; managed agents use the main-process chat boundary.
const exposedRpcCall = externalDiscoveryPath
  ? createPrivacyBoundary(rpcCall, () => {
    const discovery = JSON.parse(fs.readFileSync(externalDiscoveryPath, "utf8"));
    return discovery.redaction;
  })
  : rpcCall;

// ── MCP Server ──

const server = new McpServer({
  name: "netcatty-remote-hosts",
  version: "1.0.0",
}, {
  instructions: NETCATTY_MCP_SERVER_INSTRUCTIONS,
});

// Scope params shared by all tool calls.
// When chatSessionId is present, let the main process resolve the current
// workspace membership dynamically so mid-session workspace changes are visible
// without restarting the MCP subprocess.
const scopeParams = CHAT_SESSION_ID
  ? { chatSessionId: CHAT_SESSION_ID }
  : { scopedSessionIds: SCOPED_SESSION_IDS, chatSessionId: CHAT_SESSION_ID };

// Resource: environment context
server.resource(
  "environment",
  "netcatty://context",
  { description: "Current Netcatty workspace context: connected hosts, session IDs, and environment description." },
  async () => {
    const ctx = await exposedRpcCall("netcatty/getContext", scopeParams);
    return {
      contents: [{
        uri: "netcatty://context",
        mimeType: "application/json",
        text: JSON.stringify(ctx, null, 2),
      }],
    };
  },
);

// Start with core tools; load specialized catalog groups through load_netcatty_tools.
const toolDependencies = {
  rpcCall: exposedRpcCall,
  scopeParams,
  guardWriteOperation,
  catalogDescription,
};
if (process.env.NETCATTY_MCP_DELEGATED_TOOLS !== undefined) {
  const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");
  const { registerMcpTools } = require("../capabilities/codegen/mcpToolRegistry.cjs");
  const names = JSON.parse(process.env.NETCATTY_MCP_DELEGATED_TOOLS);
  if (!Array.isArray(names) || names.length > 128 || names.some((name) => typeof name !== "string")) throw Error("Invalid delegated tool profile");
  const allowed = new Set(names);
  registerMcpTools(server, toolDependencies, listMcpTools().filter((tool) => allowed.has(tool.mcpTool)));
} else registerProgressiveMcpTools(server, toolDependencies);

// ── Start ──

async function main() {
  debugLog("Starting MCP server", {
    port: NETCATTY_MCP_PORT,
    hasToken: Boolean(NETCATTY_MCP_TOKEN),
    scopedSessionIds: SCOPED_SESSION_IDS,
    chatSessionId: CHAT_SESSION_ID,
    permissionMode: readPermissionMode(),
    externalDiscovery: Boolean(externalDiscoveryPath),
  });
  if (externalDiscoveryPath) {
    await ensureConnected();
  } else {
    await connectTcp();
    // Authenticate with the TCP bridge before accepting any tool calls.
    const authResult = await rpcCall("auth/verify", { token: NETCATTY_MCP_TOKEN });
    debugLog("auth/verify result", authResult);
    if (!authResult?.ok) {
      throw new Error("TCP bridge authentication failed");
    }
    process.stderr.write("[netcatty-mcp] Authenticated with TCP bridge\n");
  }

  const transport = new StdioServerTransport();
  // Protocol.connect keeps this callback and runs it before request dispatch.
  transport.onmessage = (message) => {
    normalizeMcpJsonRpcMessage(message);
  };
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[netcatty-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
