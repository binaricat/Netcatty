/**
 * Netcatty MCP Server (stdio transport)
 *
 * Spawned by codex-acp (or other ACP agents) as a child process.
 * Communicates with the Netcatty main process via TCP (JSON-RPC over newline-delimited JSON).
 * Exposes SSH terminal and SFTP tools so ACP agents can operate on remote hosts.
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

/** Guard for write tools: blocks in observer mode, checks command safety for commands. */
function guardWriteOperation(command) {
  if (PERMISSION_MODE === "observer") {
    return 'Operation denied: permission mode is "observer" (read-only). Change to "confirm" or "autonomous" in Settings → AI → Safety to allow this action.';
  }
  if (command) {
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
  "Get information about the current Netcatty workspace: all connected remote hosts, their session IDs, OS, and connection status. Call this first to discover available hosts before executing commands.",
  {},
  async () => {
    process.stderr.write(`[netcatty-mcp] get_environment called, SCOPED_SESSION_IDS: ${JSON.stringify(SCOPED_SESSION_IDS)}, CHAT_SESSION_ID: ${CHAT_SESSION_ID}\n`);
    const ctx = await rpcCall("netcatty/getContext", scopeParams);
    process.stderr.write(`[netcatty-mcp] get_environment result: hostCount=${ctx.hostCount}, hosts=${JSON.stringify(ctx.hosts?.map(h => h.sessionId))}\n`);
    return { content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }] };
  },
);

// Tool: terminal_execute
server.tool(
  "terminal_execute",
  "Execute a shell command on a remote host via SSH. The command runs in the host's shell and output (stdout/stderr) is returned when complete.",
  {
    sessionId: z.string().describe("The terminal session ID (from get_environment) to execute on."),
    command: z.string().describe("The shell command to execute on the remote host."),
  },
  async ({ sessionId, command }) => {
    const guardErr = guardWriteOperation(command);
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
    parts.push(`[exit code: ${result.exitCode ?? -1}]`);
    return { content: [{ type: "text", text: parts.join("\n") }] };
  },
);

// Tool: terminal_send_input
server.tool(
  "terminal_send_input",
  "Send raw input to a terminal session on a remote host. Use only for interactive programs that are already running: y/n prompts, passwords, ctrl+c (\\x03), ctrl+d (\\x04), or pressing enter (\\n). This tool does not return the updated terminal output. For normal commands, use terminal_execute.",
  {
    sessionId: z.string().describe("The terminal session ID to send input to."),
    input: z.string().describe("The raw input string. Use escape sequences for special keys (e.g. \\x03 for ctrl+c, \\n for enter)."),
  },
  async ({ sessionId, input }) => {
    const guardErr = guardWriteOperation(input);
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/terminalWrite", { ...scopeParams, sessionId, input });
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Sent input to session ${sessionId}` }] };
  },
);

// Tool: sftp_list_directory
server.tool(
  "sftp_list_directory",
  "List the contents of a directory on the remote host. Returns file names, sizes, types, and modification timestamps.",
  {
    sessionId: z.string().describe("The terminal session ID for the remote host."),
    path: z.string().describe("The absolute path of the remote directory to list."),
  },
  async ({ sessionId, path }) => {
    const result = await rpcCall("netcatty/sftpList", { ...scopeParams, sessionId, path });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result.files || result.output, null, 2) }] };
  },
);

// Tool: sftp_read_file
server.tool(
  "sftp_read_file",
  "Read the content of a file on the remote host. Returns file content as text, truncated if the file is large.",
  {
    sessionId: z.string().describe("The terminal session ID for the remote host."),
    path: z.string().describe("The absolute path of the remote file to read."),
    maxBytes: z.number().optional().default(10000).describe("Maximum bytes to read. Defaults to 10000."),
  },
  async ({ sessionId, path, maxBytes }) => {
    const safeMaxBytes = Math.max(1, Math.min(10 * 1024 * 1024, Number(maxBytes) || 10000));
    const result = await rpcCall("netcatty/sftpRead", { ...scopeParams, sessionId, path, maxBytes: safeMaxBytes });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: result.content || "(empty file)" }] };
  },
);

// Tool: sftp_write_file
server.tool(
  "sftp_write_file",
  "Write content to a file on the remote host. Creates the file if it does not exist, or overwrites it.",
  {
    sessionId: z.string().describe("The terminal session ID for the remote host."),
    path: z.string().describe("The absolute path of the remote file to write."),
    content: z.string().describe("The text content to write to the file."),
  },
  async ({ sessionId, path, content }) => {
    const guardErr = guardWriteOperation(path);
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/sftpWrite", { ...scopeParams, sessionId, path, content });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Written: ${path}` }] };
  },
);

// Tool: sftp_mkdir
server.tool(
  "sftp_mkdir",
  "Create a directory on the remote host. Creates parent directories if they don't exist.",
  {
    sessionId: z.string().describe("The terminal session ID for the remote host."),
    path: z.string().describe("The absolute path of the directory to create."),
  },
  async ({ sessionId, path }) => {
    const guardErr = guardWriteOperation();
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/sftpMkdir", { ...scopeParams, sessionId, path });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Created directory: ${path}` }] };
  },
);

// Tool: sftp_remove
server.tool(
  "sftp_remove",
  "Delete a file or directory on the remote host. Directories are removed recursively.",
  {
    sessionId: z.string().describe("The terminal session ID for the remote host."),
    path: z.string().describe("The absolute path of the file or directory to delete."),
  },
  async ({ sessionId, path }) => {
    const guardErr = guardWriteOperation();
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/sftpRemove", { ...scopeParams, sessionId, path });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Removed: ${path}` }] };
  },
);

// Tool: sftp_rename
server.tool(
  "sftp_rename",
  "Rename or move a file/directory on the remote host.",
  {
    sessionId: z.string().describe("The terminal session ID for the remote host."),
    oldPath: z.string().describe("The current absolute path."),
    newPath: z.string().describe("The new absolute path."),
  },
  async ({ sessionId, oldPath, newPath }) => {
    const guardErr = guardWriteOperation();
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/sftpRename", { ...scopeParams, sessionId, oldPath, newPath });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Renamed: ${oldPath} → ${newPath}` }] };
  },
);

// Tool: sftp_stat
server.tool(
  "sftp_stat",
  "Get file/directory metadata on the remote host: type, size, permissions, and modification time.",
  {
    sessionId: z.string().describe("The terminal session ID for the remote host."),
    path: z.string().describe("The absolute path to stat."),
  },
  async ({ sessionId, path }) => {
    const result = await rpcCall("netcatty/sftpStat", { ...scopeParams, sessionId, path });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

// Tool: multi_host_execute
server.tool(
  "multi_host_execute",
  "Execute a command on multiple remote hosts simultaneously or sequentially. Useful for fleet-wide operations like checking status, deploying updates, or maintenance.",
  {
    sessionIds: z.array(z.string()).describe("Array of session IDs to execute on."),
    command: z.string().describe("The shell command to execute on each host."),
    mode: z.enum(["parallel", "sequential"]).optional().default("parallel").describe("Execution mode. Defaults to parallel."),
    stopOnError: z.boolean().optional().default(false).describe("In sequential mode, stop on first failure."),
  },
  async ({ sessionIds, command, mode, stopOnError }) => {
    const guardErr = guardWriteOperation(command);
    if (guardErr) {
      return { content: [{ type: "text", text: `Error: ${guardErr}` }], isError: true };
    }
    const result = await rpcCall("netcatty/multiExec", { ...scopeParams, sessionIds, command, mode, stopOnError });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result.results, null, 2) }] };
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
