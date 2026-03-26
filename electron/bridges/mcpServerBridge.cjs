/**
 * MCP Server Bridge — TCP host in Electron main process
 *
 * Starts a local TCP server that the netcatty-mcp-server.cjs child process
 * connects to. Handles JSON-RPC calls by dispatching to real terminal sessions.
 */
"use strict";

const net = require("node:net");
const crypto = require("node:crypto");
const path = require("node:path");
const { existsSync } = require("node:fs");

const { toUnpackedAsarPath } = require("./ai/shellUtils.cjs");
const { execViaPty, execViaChannel, execViaRawPty } = require("./ai/ptyExec.cjs");

let sessions = null;   // Map<sessionId, { sshClient, stream, pty, proc, conn, ... }>
let tcpServer = null;
let tcpPort = null;
let authToken = null;  // Random token generated when TCP server starts

// Track which sockets have completed authentication
const authenticatedSockets = new WeakSet();

// Per-scope metadata: chatSessionId → { sessionIds: string[], metadata: Map<sessionId, meta> }
// Each chat session only sees the hosts registered for its scope.
const scopedMetadata = new Map();

// Fallback: last-registered scope (used when no chatSessionId is provided)
let fallbackScopedSessionIds = [];

// Command safety checking (reuse from aiBridge)
let commandBlocklist = [];
// Cached compiled RegExp objects for commandBlocklist (rebuilt when blocklist changes)
let compiledBlocklist = [];

// Command timeout in milliseconds (default 60s, synced from user settings)
let commandTimeoutMs = 60000;

// Max iterations for AI agent loops (default 20, synced from user settings)
let maxIterations = 20;

// Permission mode: 'observer' | 'confirm' | 'autonomous' (synced from user settings)
let permissionMode = "confirm";

// Track active PTY executions for cancellation
const activePtyExecs = new Map(); // marker → { ptyStream, cleanup }
const cancelledChatSessions = new Set();

// ── Approval gate (for confirm mode with ACP/MCP agents) ──
let getMainWindowFn = null; // () => BrowserWindow | null
const pendingApprovals = new Map(); // approvalId → { resolve, chatSessionId }
let approvalIdCounter = 0;

function setMainWindowGetter(fn) {
  getMainWindowFn = fn;
}

/**
 * Request approval from the renderer process.
 * Sends an IPC event and returns a Promise<boolean> that resolves
 * when the user approves/rejects in the UI, or auto-denies after timeout.
 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function requestApprovalFromRenderer(toolName, args, chatSessionId) {
  return new Promise((resolve) => {
    const mainWin = typeof getMainWindowFn === 'function' ? getMainWindowFn() : null;
    if (!mainWin || mainWin.isDestroyed()) {
      // No renderer available — deny to preserve confirm mode safety guarantee
      resolve(false);
      return;
    }
    const approvalId = `mcp_approval_${++approvalIdCounter}_${Date.now()}`;

    // Auto-deny after timeout so ACP/MCP tool calls don't hang indefinitely
    const timerId = setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        resolve(false);
        // Notify renderer to remove the stale approval card
        try {
          const win = typeof getMainWindowFn === 'function' ? getMainWindowFn() : null;
          if (win && !win.isDestroyed()) {
            win.webContents.send('netcatty:ai:mcp:approval-cleared', { approvalIds: [approvalId] });
          }
        } catch { /* ignore */ }
      }
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(approvalId, {
      resolve: (approved) => {
        clearTimeout(timerId);
        resolve(approved);
      },
      chatSessionId: chatSessionId || null,
    });
    mainWin.webContents.send('netcatty:ai:mcp:approval-request', {
      approvalId,
      toolName,
      args,
      chatSessionId: chatSessionId || undefined,
    });
  });
}

function resolveApprovalFromRenderer(approvalId, approved) {
  const entry = pendingApprovals.get(approvalId);
  if (entry) {
    pendingApprovals.delete(approvalId);
    entry.resolve(approved);
  }
}

/**
 * Clear pending MCP approvals, optionally scoped to a specific chatSessionId.
 * Resolves matched entries with false (denied) to unblock hanging promises.
 */
function clearPendingApprovals(chatSessionId) {
  if (!chatSessionId) {
    for (const [, entry] of pendingApprovals) {
      entry.resolve(false);
    }
    pendingApprovals.clear();
    return;
  }
  for (const [id, entry] of pendingApprovals) {
    if (entry.chatSessionId === chatSessionId) {
      pendingApprovals.delete(id);
      entry.resolve(false);
    }
  }
}

function cancelAllPtyExecs() {
  for (const [marker, entry] of activePtyExecs) {
    try {
      if (typeof entry.cancel === "function") entry.cancel();
      else entry.cleanup();
    } catch { /* ignore */ }
    activePtyExecs.delete(marker);
  }
  activePtyExecs.clear();
}

/**
 * Cancel PTY executions scoped to a specific chat session.
 * Only affects entries whose chatSessionId matches.
 */
function cancelPtyExecsForSession(chatSessionId) {
  if (!chatSessionId) return;
  for (const [marker, entry] of activePtyExecs) {
    if (entry.chatSessionId !== chatSessionId) continue;
    try {
      if (typeof entry.cancel === "function") entry.cancel();
      else entry.cleanup();
    } catch { /* ignore */ }
    activePtyExecs.delete(marker);
  }
}

function init(deps) {
  sessions = deps.sessions;
  if (deps.commandBlocklist) {
    commandBlocklist = deps.commandBlocklist;
  }
}

function setCommandBlocklist(list) {
  commandBlocklist = list || [];
  // Recompile cached regexes when blocklist changes
  compiledBlocklist = [];
  for (const pattern of commandBlocklist) {
    try {
      compiledBlocklist.push(new RegExp(pattern, "i"));
    } catch {
      compiledBlocklist.push(null); // placeholder for invalid patterns
    }
  }
}

function setCommandTimeout(seconds) {
  commandTimeoutMs = Math.max(1, Math.min(3600, seconds || 60)) * 1000;
}

function getCommandTimeoutMs() {
  return commandTimeoutMs;
}

function setMaxIterations(value) {
  maxIterations = Math.max(1, Math.min(100, value || 20));
}

function getMaxIterations() {
  return maxIterations;
}

function setPermissionMode(mode) {
  if (mode === "observer" || mode === "confirm" || mode === "autonomous") {
    permissionMode = mode;
  }
}

function getPermissionMode() {
  return permissionMode;
}

function setChatSessionCancelled(chatSessionId, cancelled) {
  if (!chatSessionId) return;
  if (cancelled) {
    cancelledChatSessions.add(chatSessionId);
  } else {
    cancelledChatSessions.delete(chatSessionId);
  }
}

function isChatSessionCancelled(chatSessionId) {
  return Boolean(chatSessionId && cancelledChatSessions.has(chatSessionId));
}

/**
 * Register metadata for terminal sessions (called from renderer via IPC).
 * Metadata is stored per-scope (chatSessionId) so different AI chat sessions
 * only see their own hosts.
 * @param {Array<{sessionId, hostname, label, os, username, connected, protocol?, shellType?}>} sessionList
 * @param {string} [chatSessionId] - AI chat session ID for per-scope isolation
 */
function updateSessionMetadata(sessionList, chatSessionId) {
  const ids = sessionList.map(s => s.sessionId);
  const metaMap = new Map();
  for (const s of sessionList) {
    metaMap.set(s.sessionId, {
      hostname: s.hostname || "",
      label: s.label || "",
      os: s.os || "",
      username: s.username || "",
      protocol: s.protocol || "",
      shellType: s.shellType || "",
      connected: s.connected !== false,
    });
  }

  // Store per-scope metadata when chatSessionId is provided
  if (chatSessionId) {
    scopedMetadata.set(chatSessionId, { sessionIds: ids, metadata: metaMap });
  } else {
    // Only update fallback when no chatSessionId — prevents scoped updates from
    // leaking all sessions to unscoped agents
    fallbackScopedSessionIds = ids.slice();
  }
}

/**
 * Get scoped session IDs. If chatSessionId is provided, returns IDs for that
 * specific scope; otherwise returns the last-registered fallback.
 */
function getScopedSessionIds(chatSessionId) {
  if (chatSessionId) {
    const scoped = scopedMetadata.get(chatSessionId);
    if (scoped) return scoped.sessionIds;
  }
  return fallbackScopedSessionIds;
}

/**
 * Look up metadata for a sessionId, scoped to a specific chat session.
 * Falls back to session object properties if no scoped metadata is found.
 */
function getSessionMeta(sessionId, chatSessionId) {
  // Try scoped metadata first
  if (chatSessionId) {
    const scoped = scopedMetadata.get(chatSessionId);
    if (scoped?.metadata?.has(sessionId)) return scoped.metadata.get(sessionId);
  }
  // Fallback: check all scopes for this sessionId (backwards compat)
  for (const [, scope] of scopedMetadata) {
    if (scope.metadata?.has(sessionId)) return scope.metadata.get(sessionId);
  }
  return null;
}

/**
 * Run an array of async task factories with a concurrency limit.
 */
function checkCommandSafety(command) {
  for (let i = 0; i < compiledBlocklist.length; i++) {
    const re = compiledBlocklist[i];
    if (re && re.test(command)) {
      return { blocked: true, matchedPattern: commandBlocklist[i] };
    }
  }
  return { blocked: false };
}

// ── TCP Server ──

function getOrCreateHost() {
  if (tcpServer && tcpPort) return Promise.resolve(tcpPort);

  // Generate a random auth token for this server instance
  authToken = crypto.randomBytes(32).toString("hex");

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleConnection(socket);
    });

    server.listen(0, "127.0.0.1", () => {
      tcpPort = server.address().port;
      tcpServer = server;
      resolve(tcpPort);
    });

    server.on("error", (err) => {
      console.error("[MCP Bridge] TCP server error:", err.message);
      reject(err);
    });
  });
}

const MAX_TCP_BUFFER = 10 * 1024 * 1024; // 10MB

function handleConnection(socket) {
  let buffer = "";
  socket.setEncoding("utf-8");

  socket.on("data", (chunk) => {
    if (buffer.length + chunk.length > MAX_TCP_BUFFER) {
      console.error("[MCP Bridge] TCP buffer exceeded max size, dropping connection");
      socket.destroy();
      return;
    }
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      handleMessage(socket, line);
    }
  });

  socket.on("error", () => {
    // Client disconnected — nothing to do
  });
}

async function handleMessage(socket, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;
  if (id == null || !method) return;

  // ── Authentication gate ──
  // The first message from any connection MUST be auth/verify with the correct token.
  // All other methods are rejected until the socket is authenticated.
  if (!authenticatedSockets.has(socket)) {
    if (method === "auth/verify" && params?.token === authToken) {
      authenticatedSockets.add(socket);
      const response = JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }) + "\n";
      if (!socket.destroyed) socket.write(response);
      return;
    }
    // Wrong token or wrong method — reject and close
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32001, message: "Authentication required. Send auth/verify with valid token first." },
    }) + "\n";
    if (!socket.destroyed) {
      socket.write(response);
      socket.destroy();
    }
    return;
  }

  try {
    const result = await dispatch(method, params || {});
    const response = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
    if (!socket.destroyed) socket.write(response);
  } catch (err) {
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err?.message || String(err) },
    }) + "\n";
    if (!socket.destroyed) socket.write(response);
  }
}

// ── RPC Dispatch ──

// Methods that modify remote state — blocked in observer mode
const WRITE_METHODS = new Set([
  "netcatty/exec",
]);

/**
 * Validate that a sessionId is allowed in the current scope.
 * Checks both process-level SCOPED_SESSION_IDS and per-chatSession scoped metadata.
 */
function validateSessionScope(sessionId, chatSessionId) {
  if (!sessionId) return null; // will fail at handler level
  const scopedIds = getScopedSessionIds(chatSessionId);
  if (scopedIds && scopedIds.length > 0 && !scopedIds.includes(sessionId)) {
    return `Session "${sessionId}" is not in the current scope.`;
  }
  return null;
}

async function dispatch(method, params) {
  // Observer mode: block all write operations
  if (permissionMode === "observer" && WRITE_METHODS.has(method)) {
    return { ok: false, error: `Operation denied: permission mode is "observer" (read-only). Change to "confirm" or "autonomous" in Settings → AI → Safety to allow this action.` };
  }

  if (WRITE_METHODS.has(method) && isChatSessionCancelled(params?.chatSessionId)) {
    return { ok: false, error: "Operation cancelled: the ACP session was stopped." };
  }

  // Confirm mode: request user approval for write operations
  if (permissionMode === "confirm" && WRITE_METHODS.has(method)) {
    const { chatSessionId, ...toolArgs } = params || {};
    const approved = await requestApprovalFromRenderer(method, toolArgs, chatSessionId);
    if (!approved) {
      return { ok: false, error: "Operation denied by user." };
    }
  }

  // Scope validation for session-targeted operations
  if (method !== "netcatty/getContext" && params?.sessionId) {
    const scopeErr = validateSessionScope(params.sessionId, params?.chatSessionId);
    if (scopeErr) return { ok: false, error: scopeErr };
  }
  switch (method) {
    case "netcatty/getContext":
      return handleGetContext(params);
    case "netcatty/exec":
      return handleExec(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ── Handler: getContext ──

function handleGetContext(params) {
  if (!sessions) return { hosts: [], instructions: "No sessions available." };

  // chatSessionId may be passed via env for per-scope metadata lookup
  const chatSessionId = params?.chatSessionId || null;
  const explicitScopedIds = Array.isArray(params?.scopedSessionIds)
    ? params.scopedSessionIds
    : null;
  const resolvedScopedIds = explicitScopedIds ?? (chatSessionId ? getScopedSessionIds(chatSessionId) : null);
  const hasScopedContext = explicitScopedIds !== null || chatSessionId !== null;
  const scopedIds = resolvedScopedIds ? new Set(resolvedScopedIds) : null;

  const hosts = [];
  // When a scoped context exists but currently resolves to zero sessions, treat
  // it as "no access" rather than falling back to all sessions.
  if (hasScopedContext && (!resolvedScopedIds || resolvedScopedIds.length === 0)) {
    return {
      environment: "netcatty-terminal",
      description: "No hosts are available in the current scope.",
      hosts: [],
      hostCount: 0,
    };
  }
  for (const [sessionId, session] of sessions.entries()) {
    if (scopedIds && !scopedIds.has(sessionId)) continue;
    const ptyStream = session.stream || session.pty || session.proc;
    const sshClient = session.conn || session.sshClient;
    const hasCommandablePty = ptyStream && typeof ptyStream.write === "function";
    const hasSshExec = sshClient && typeof sshClient.exec === "function";
    const hasSerialPort = session.serialPort && typeof session.serialPort.write === "function";
    if (!hasCommandablePty && !hasSshExec && !hasSerialPort) continue;

    // Look up metadata scoped to this chat session
    const meta = getSessionMeta(sessionId, chatSessionId) || {};
    hosts.push({
      sessionId,
      hostname: meta.hostname || session.hostname || "",
      label: meta.label || session.label || "",
      os: meta.os || "",
      username: meta.username || session.username || "",
      protocol: meta.protocol || session.protocol || session.type || "",
      shellType: meta.shellType || session.shellKind || "",
      connected: meta.connected !== undefined ? meta.connected : !!(session.sshClient || session.conn || ptyStream || session.serialPort),
    });
  }

  return {
    environment: "netcatty-terminal",
    description: "You are operating inside Netcatty, a multi-session terminal manager. " +
      "The available sessions may be remote hosts, local terminals, Mosh-backed shells, or serial port connections (network devices, embedded systems). " +
      "Use the provided tools to execute commands through the sessions exposed by Netcatty. " +
      "Serial sessions (protocol: serial, shellType: raw) do not run a standard shell — commands are sent as-is. " +
      "Always prefer these tools over suggesting the user to do things manually.",
    hosts,
    hostCount: hosts.length,
  };
}

// ── Handler: exec ──

function handleExec(params) {
  const { sessionId, command } = params;
  if (!sessionId || !command) throw new Error("sessionId and command are required");
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'Invalid command', exitCode: 1 };
  }

  const session = sessions?.get(sessionId);
  if (!session) return { ok: false, error: "Session not found" };

  // The blocklist targets shell-specific patterns (rm -rf, eval, $(), etc.) that
  // are meaningless on network device CLIs. Serial sessions skip the check because
  // commands like "shutdown" (disable an interface) are routine on Cisco/Huawei.
  //
  // Design note: the serial protocol is explicitly chosen by the user in the UI
  // for network devices / embedded systems. While startSerialSession technically
  // supports PTY devices, users connecting to a Linux/BusyBox shell should use
  // the "local" protocol (which goes through the normal shell path with blocklist).
  // Additionally, execViaRawPty sends commands without shell wrapping, so shell
  // metacharacters in blocklist patterns (eval, $(), backticks, pipes) cannot
  // actually be interpreted even if sent to a serial-connected shell.
  if (session.protocol !== "serial") {
    const safety = checkCommandSafety(command);
    if (safety.blocked) {
      return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
    }
  }

  if ((session.protocol === "local" || session.type === "local") && session.shellKind === "unknown") {
    return {
      ok: false,
      error: "AI execution is not supported for this local shell executable. Configure the local terminal to use bash/zsh/sh, fish, PowerShell/pwsh, or cmd.exe.",
    };
  }

  const sshClient = session.conn || session.sshClient;
  const ptyStream = session.stream || session.pty || session.proc;

  // Prefer the interactive PTY so the user sees command/output in-session.
  if (ptyStream && typeof ptyStream.write === "function") {
    return execViaPty(ptyStream, command, {
      trackForCancellation: activePtyExecs,
      timeoutMs: commandTimeoutMs,
      shellKind: session.shellKind,
      expectedPrompt: session.lastIdlePrompt || "",
    });
  }

  // Fallback: SSH exec channel (invisible to terminal).
  // At this point ptyStream is not writable (already returned above if it was).
  if (sshClient && typeof sshClient.exec === "function") {
    return execViaChannel(sshClient, command, {
      timeoutMs: commandTimeoutMs,
      trackForCancellation: activePtyExecs,
    });
  }

  // Serial port: raw command execution (no shell wrapping)
  if (session.protocol === "serial" && session.serialPort && typeof session.serialPort.write === "function") {
    return execViaRawPty(session.serialPort, command, {
      timeoutMs: commandTimeoutMs,
      trackForCancellation: activePtyExecs,
      chatSessionId: params?.chatSessionId,
    });
  }

  return { ok: false, error: "Session does not support command execution" };
}

// ── MCP Server Config Builder ──

function buildMcpServerConfig(port, scopedSessionIds, chatSessionId) {
  // Use provided scoped IDs, or resolve from chatSessionId, or fall back
  const effectiveIds = (scopedSessionIds && scopedSessionIds.length > 0)
    ? scopedSessionIds
    : getScopedSessionIds(chatSessionId);

  const runtimePath = toUnpackedAsarPath(
    path.join(__dirname, "..", "mcp", "netcatty-mcp-server.cjs"),
  );

  const env = [
    { name: "NETCATTY_MCP_PORT", value: String(port) },
  ];

  if (authToken) {
    env.push({ name: "NETCATTY_MCP_TOKEN", value: authToken });
  }

  // When chatSessionId is present, the MCP subprocess resolves scope dynamically
  // through main-process metadata, so avoid freezing session IDs at spawn time.
  if (!chatSessionId && effectiveIds && effectiveIds.length > 0) {
    env.push({ name: "NETCATTY_MCP_SESSION_IDS", value: effectiveIds.join(",") });
  }

  // Pass chatSessionId so MCP server can scope getContext responses
  if (chatSessionId) {
    env.push({ name: "NETCATTY_MCP_CHAT_SESSION_ID", value: chatSessionId });
  }

  // Pass permission mode so MCP server can enforce it locally (defense-in-depth)
  env.push({ name: "NETCATTY_MCP_PERMISSION_MODE", value: permissionMode });

  return {
    name: "netcatty-remote-hosts",
    type: "stdio",
    command: "node",
    args: [runtimePath],
    env,
  };
}

// ── Cleanup ──

function cleanupScopedMetadata(chatSessionId) {
  if (chatSessionId) {
    scopedMetadata.delete(chatSessionId);
    cancelledChatSessions.delete(chatSessionId);
  }
}

function cleanup() {
  if (tcpServer) {
    tcpServer.close();
    tcpServer = null;
    tcpPort = null;
  }
  scopedMetadata.clear();
}

module.exports = {
  init,
  setCommandBlocklist,
  setCommandTimeout,
  getCommandTimeoutMs,
  setMaxIterations,
  getMaxIterations,
  setPermissionMode,
  getPermissionMode,
  setChatSessionCancelled,
  checkCommandSafety,
  updateSessionMetadata,
  getScopedSessionIds,
  getOrCreateHost,
  buildMcpServerConfig,
  activePtyExecs,
  cancelAllPtyExecs,
  cancelPtyExecsForSession,
  cleanupScopedMetadata,
  cleanup,
  setMainWindowGetter,
  resolveApprovalFromRenderer,
  clearPendingApprovals,
};
