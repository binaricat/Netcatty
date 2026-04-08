/**
 * Netcatty MCP Server (stdio transport)
 *
 * Spawned by codex-acp (or other ACP agents) as a child process.
 * Communicates with the Netcatty main process via TCP (JSON-RPC over newline-delimited JSON).
 * Exposes Netcatty terminal tools so ACP agents can operate on scoped sessions.
 */
"use strict";

const net = require("node:net");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

// ── TCP Bridge to Netcatty main process ──

const NETCATTY_MCP_PORT = parseInt(process.env.NETCATTY_MCP_PORT, 10);
if (!NETCATTY_MCP_PORT) {
  process.stderr.write("[netcatty-mcp] NETCATTY_MCP_PORT not set\n");
  process.exit(1);
}

// Auth token for TCP bridge authentication
const NETCATTY_MCP_TOKEN = process.env.NETCATTY_MCP_TOKEN || "";
if (!NETCATTY_MCP_TOKEN) {
  process.stderr.write("[netcatty-mcp] NETCATTY_MCP_TOKEN not set\n");
  process.exit(1);
}

// Scoped session IDs (comma-separated). When set (even if empty), only listed
// sessions are accessible. When unset, scope enforcement falls back to the
// TCP bridge's own scoping (which also defaults to no-access when empty).
const SCOPED_SESSION_IDS = process.env.NETCATTY_MCP_SESSION_IDS != null
  ? process.env.NETCATTY_MCP_SESSION_IDS.split(",").map(s => s.trim()).filter(Boolean)
  : null;

// Chat session ID for per-scope metadata isolation
const CHAT_SESSION_ID = process.env.NETCATTY_MCP_CHAT_SESSION_ID || null;

// Permission mode: 'observer' | 'confirm' | 'autonomous' (defense-in-depth, TCP bridge also checks)
const PERMISSION_MODE = process.env.NETCATTY_MCP_PERMISSION_MODE || "confirm";

// Default command blocklist (defense-in-depth, TCP bridge also checks)
// NOTE: Keep in sync with DEFAULT_COMMAND_BLOCKLIST in infrastructure/ai/types.ts
const DEFAULT_COMMAND_BLOCKLIST = [
  '\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*\\s+(-[a-zA-Z]*f[a-zA-Z]*\\s+)?|-[a-zA-Z]*f[a-zA-Z]*\\s+(-[a-zA-Z]*r[a-zA-Z]*\\s+)?|--recursive\\s+|--force\\s+){1,}',
  '\\bmkfs\\.',
  '\\bdd\\s+if=.*\\s+of=/dev/',
  '\\b(shutdown|reboot|poweroff|halt)\\b',
  ':\\(\\)\\{\\s*:\\|:\\&\\s*\\};:',
  '>\\s*/dev/sd',
  '\\bchmod\\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\\s+777\\s+/',
  '\\bmv\\s+/\\s',
  ':\\s*>\\s*/etc/',
  '\\bcurl\\s+.*\\|\\s*\\bsudo\\s+\\bbash\\b',
  '\\bwget\\s+.*\\|\\s*\\bsudo\\s+\\bbash\\b',
];

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
  if (PERMISSION_MODE === "observer") {
    return 'Operation denied: permission mode is "observer" (read-only). Change to "confirm" or "autonomous" in Settings → AI → Safety to allow this action.';
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
let pendingRequests = new Map(); // id -> { resolve, reject }
let nextRpcId = 1;
let tcpBuffer = "";

function connectTcp() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: NETCATTY_MCP_PORT }, () => {
      tcpSocket = sock;
      resolve();
    });
    sock.setEncoding("utf-8");
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB
    sock.on("data", (chunk) => {
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
      reject(err);
      // Reject all pending
      for (const { reject: rej } of pendingRequests.values()) {
        rej(new Error("TCP connection lost"));
      }
      pendingRequests.clear();
    });
    sock.on("close", () => {
      // Reject all pending requests on clean close
      for (const { reject: rej } of pendingRequests.values()) {
        rej(new Error("TCP connection closed"));
      }
      pendingRequests.clear();
      tcpSocket = null;
    });
  });
}

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    if (!tcpSocket || tcpSocket.destroyed) {
      return reject(new Error("Not connected to Netcatty"));
    }
    const id = nextRpcId++;
    pendingRequests.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    tcpSocket.write(msg);
  });
}

// ── MCP Server ──

const server = new McpServer({
  name: "netcatty-remote-hosts",
  version: "1.0.0",
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
    const ctx = await rpcCall("netcatty/getContext", scopeParams);
    return {
      contents: [{
        uri: "netcatty://context",
        mimeType: "application/json",
        text: JSON.stringify(ctx, null, 2),
      }],
    };
  },
);

// Tool: get_environment
server.tool(
  "get_environment",
  "Get information about the current Netcatty scope: all terminal sessions exposed by Netcatty, their session IDs, OS, shell hints, and connection status. Sessions may be remote hosts, a local terminal, Mosh-backed shells, or serial port connections (network devices, embedded systems). Serial sessions have protocol 'serial' and shellType 'raw'. SSH sessions with deviceType 'network' are network equipment (Huawei VRP, Cisco IOS, etc.) using vendor CLIs instead of a standard shell. Call this first before executing commands.",
  {},
  async () => {
    process.stderr.write(`[netcatty-mcp] get_environment called, SCOPED_SESSION_IDS: ${JSON.stringify(SCOPED_SESSION_IDS)}, CHAT_SESSION_ID: ${CHAT_SESSION_ID}\n`);
    const ctx = await rpcCall("netcatty/getContext", scopeParams);
    process.stderr.write(`[netcatty-mcp] get_environment result: hostCount=${ctx.hostCount}, hosts=${JSON.stringify(ctx.hosts?.map(h => h.sessionId))}\n`);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(ctx, null, 2),
      }],
    };
  },
);

// Tool: terminal_execute
server.tool(
  "terminal_execute",
  "Execute a short command on a Netcatty terminal session and wait for the full result. Use this only for commands expected to finish within about 60 seconds. For long-running commands such as builds, scans, log-following, or anything likely to exceed that budget, use terminal_start and then terminal_poll instead.",
  {
    sessionId: z.string().describe("The terminal session ID (from get_environment) to execute on."),
    command: z.string().describe("The command to execute in the target session."),
  },
  async ({ sessionId, command }) => {
    // skipBlocklist: bridge layer does session-aware blocklist (serial sessions skip shell patterns)
    const guardErr = guardWriteOperation(command, { skipBlocklist: true });
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/exec", { ...scopeParams, sessionId, command });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error || "Command failed"}` }], isError: true };
    }
    const parts = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
    // Serial/raw and network device sessions return null exitCode (vendor CLIs have no exit codes)
    if (result.exitCode != null) {
      parts.push(`[exit code: ${result.exitCode}]`);
    }
    return { content: [{ type: "text", text: parts.join("\n") }] };
  },
);

server.tool(
  "terminal_start",
  "Start a long-running command on a Netcatty terminal session without waiting for final completion. The command still runs in the visible terminal/PTTY so the user can watch live output. Prefer this whenever the command may exceed about 2 minutes, or when it streams output for an extended period, such as builds, scans, watch commands, and log-follow commands. After starting, wait at least about 30 seconds before the first terminal_poll unless you have a strong reason to check sooner.",
  {
    sessionId: z.string().describe("The terminal session ID (from get_environment) to execute on."),
    command: z.string().describe("The command to start in the target session."),
  },
  async ({ sessionId, command }) => {
    const guardErr = guardWriteOperation(command, { skipBlocklist: true });
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/jobStart", { ...scopeParams, sessionId, command });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error || "Failed to start background command"}` }], isError: true };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          jobId: result.jobId,
          sessionId: result.sessionId,
          status: result.status,
          startedAt: result.startedAt,
          outputMode: result.outputMode,
          recommendedPollIntervalMs: result.recommendedPollIntervalMs,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "terminal_poll",
  "Poll a long-running Netcatty command that was started with terminal_start. Returns incremental output since the given offset and the current status. Use the returned nextOffset for the next poll. If outputTruncated is true, only the retained tail starting at outputBaseOffset is still available. Do not poll aggressively: wait at least about 30 seconds between polls unless the tool output explicitly justifies checking sooner. As soon as completed is true, stop polling and analyze the final result immediately.",
  {
    jobId: z.string().describe("The background job ID returned by terminal_start."),
    offset: z.number().int().min(0).optional().describe("Character offset previously returned as nextOffset. Omit or use 0 on the first poll."),
  },
  async ({ jobId, offset }) => {
    const result = await rpcCall("netcatty/jobPoll", { ...scopeParams, jobId, offset: offset || 0 });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error || "Failed to poll background command"}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "terminal_stop",
  "Stop a long-running Netcatty command that was started with terminal_start. This sends Ctrl+C to the running terminal job and returns its latest state.",
  {
    jobId: z.string().describe("The background job ID returned by terminal_start."),
  },
  async ({ jobId }) => {
    const result = await rpcCall("netcatty/jobStop", { ...scopeParams, jobId });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error || "Failed to stop background command"}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Start ──

async function main() {
  await connectTcp();

  // Authenticate with the TCP bridge before accepting any tool calls
  const authResult = await rpcCall("auth/verify", { token: NETCATTY_MCP_TOKEN });
  if (!authResult?.ok) {
    throw new Error("TCP bridge authentication failed");
  }
  process.stderr.write("[netcatty-mcp] Authenticated with TCP bridge\n");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[netcatty-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
