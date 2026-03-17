/**
 * MCP Server Bridge — TCP host in Electron main process
 *
 * Starts a local TCP server that the netcatty-mcp-server.cjs child process
 * connects to. Handles JSON-RPC calls by dispatching to real SSH sessions
 * and SFTP clients.
 */
"use strict";

const net = require("node:net");
const crypto = require("node:crypto");
const path = require("node:path");
const { existsSync } = require("node:fs");

const { toUnpackedAsarPath } = require("./ai/shellUtils.cjs");
const { execViaPty, execViaChannel } = require("./ai/ptyExec.cjs");

let sessions = null;   // Map<sessionId, { sshClient, stream, pty, conn, ... }>
let sftpClients = null; // Map<sftpId, SFTPWrapper>
let tcpServer = null;
let tcpPort = null;
let authToken = null;  // Random token generated when TCP server starts

// Track which sockets have completed authentication
const authenticatedSockets = new WeakSet();

/**
 * Safely quote a string for use in a POSIX shell command.
 * Wraps the value in single quotes and escapes any embedded single quotes.
 */
function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

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

function cancelAllPtyExecs() {
  for (const [marker, entry] of activePtyExecs) {
    try {
      entry.cleanup();
      // Send Ctrl+C to kill the running command
      if (entry.ptyStream && typeof entry.ptyStream.write === "function") {
        entry.ptyStream.write("\x03");
      }
    } catch { /* ignore */ }
  }
  activePtyExecs.clear();
}

function init(deps) {
  sessions = deps.sessions;
  sftpClients = deps.sftpClients;
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
 * @param {Array<{sessionId, hostname, label, os, username, connected}>} sessionList
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
async function limitConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const p = task().then(r => { results[i] = r; }).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

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
  "netcatty/terminalWrite",
  "netcatty/sftpWrite",
  "netcatty/sftpMkdir",
  "netcatty/sftpRemove",
  "netcatty/sftpRename",
  "netcatty/multiExec",
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

  // Scope validation for session-targeted operations
  if (method !== "netcatty/getContext" && params?.sessionId) {
    const scopeErr = validateSessionScope(params.sessionId, params?.chatSessionId);
    if (scopeErr) return { ok: false, error: scopeErr };
  }
  // For multi-exec, validate all session IDs
  if (method === "netcatty/multiExec" && Array.isArray(params?.sessionIds)) {
    for (const sid of params.sessionIds) {
      const scopeErr = validateSessionScope(sid, params?.chatSessionId);
      if (scopeErr) return { ok: false, error: scopeErr };
    }
  }

  switch (method) {
    case "netcatty/getContext":
      return handleGetContext(params);
    case "netcatty/exec":
      return handleExec(params);
    case "netcatty/terminalWrite":
      return handleTerminalWrite(params);
    case "netcatty/sftpList":
      return handleSftpList(params);
    case "netcatty/sftpRead":
      return handleSftpRead(params);
    case "netcatty/sftpWrite":
      return handleSftpWrite(params);
    case "netcatty/sftpMkdir":
      return handleSftpMkdir(params);
    case "netcatty/sftpRemove":
      return handleSftpRemove(params);
    case "netcatty/sftpRename":
      return handleSftpRename(params);
    case "netcatty/sftpStat":
      return handleSftpStat(params);
    case "netcatty/multiExec":
      return handleMultiExec(params);
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
    // Only include SSH sessions (skip local terminal sessions)
    const sshClient = session.conn || session.sshClient;
    if (!sshClient || typeof sshClient.exec !== "function") continue;

    // Look up metadata scoped to this chat session
    const meta = getSessionMeta(sessionId, chatSessionId) || {};
    hosts.push({
      sessionId,
      hostname: meta.hostname || session.hostname || "",
      label: meta.label || session.label || "",
      os: meta.os || "",
      username: meta.username || session.username || "",
      connected: meta.connected !== undefined ? meta.connected : !!(session.sshClient || session.conn),
    });
  }

  return {
    environment: "netcatty-terminal",
    description: "You are operating inside Netcatty, a multi-host SSH terminal manager. " +
      "The user is managing remote servers. Use the provided tools to execute commands, " +
      "read/write files, and manage hosts on the remote machines. " +
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

  const safety = checkCommandSafety(command);
  if (safety.blocked) {
    return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
  }

  const session = sessions?.get(sessionId);
  if (!session) return { ok: false, error: "Session not found" };

  const sshClient = session.conn || session.sshClient;
  if (!sshClient || typeof sshClient.exec !== "function") {
    return { ok: false, error: "Not an SSH session" };
  }

  const ptyStream = session.stream;

  // If no PTY stream, fall back to exec channel (invisible to terminal)
  if (!ptyStream || typeof ptyStream.write !== "function") {
    return execViaChannel(sshClient, command, {
      timeoutMs: commandTimeoutMs,
      trackForCancellation: activePtyExecs,
    });
  }

  // Execute via PTY stream so user sees the command in the terminal
  return execViaPty(ptyStream, command, {
    trackForCancellation: activePtyExecs,
    timeoutMs: commandTimeoutMs,
  });
}

// ── Handler: terminalWrite ──

function handleTerminalWrite(params) {
  const { sessionId, input } = params;
  if (!sessionId || input == null) throw new Error("sessionId and input are required");

  // Validate input against command blocklist
  const safety = checkCommandSafety(input);
  if (safety.blocked) {
    return { ok: false, error: `Input blocked by safety policy. Pattern: ${safety.matchedPattern}` };
  }

  const session = sessions?.get(sessionId);
  if (!session) return { ok: false, error: "Session not found" };

  if (session.stream) {
    session.stream.write(input);
    return { ok: true };
  }
  if (session.pty) {
    session.pty.write(input);
    return { ok: true };
  }
  return { ok: false, error: "No writable stream" };
}

// ── SFTP Helpers ──

function findSftpForSession(sessionId) {
  // Try to find an SFTP client keyed by the same sessionId
  if (sftpClients?.has(sessionId)) {
    return sftpClients.get(sessionId);
  }
  // Look through all SFTP clients for one sharing the same SSH connection
  const session = sessions?.get(sessionId);
  if (!session?.sshClient) return null;

  for (const [, client] of sftpClients || []) {
    if (client.client === session.sshClient || client._sshClient === session.sshClient) {
      return client;
    }
  }
  return null;
}

// ── Handler: sftpList ──

async function handleSftpList(params) {
  const { sessionId, path: dirPath } = params;
  if (!sessionId || !dirPath) throw new Error("sessionId and path are required");

  const sftpClient = findSftpForSession(sessionId);
  if (sftpClient) {
    try {
      const list = await sftpClient.list(dirPath);
      return {
        files: list.map(f => ({
          name: f.name,
          type: f.type === "d" ? "directory" : f.type === "l" ? "symlink" : "file",
          size: f.size,
          lastModified: f.modifyTime,
          permissions: f.rights ? `${f.rights.user}${f.rights.group}${f.rights.other}` : undefined,
        })),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Fallback: use SSH exec
  const result = await handleExec({ sessionId, command: `ls -la ${shellQuote(dirPath)}` });
  if (!result.ok) return { ok: false, error: result.error };
  return { output: result.stdout || "(empty directory)" };
}

// ── Handler: sftpRead ──

async function handleSftpRead(params) {
  const { sessionId, path: filePath } = params;
  if (params.maxBytes != null && (typeof params.maxBytes !== 'number' || params.maxBytes < 1 || params.maxBytes > 10 * 1024 * 1024)) {
    return { ok: false, error: 'maxBytes must be a positive number between 1 and 10485760' };
  }
  // Clamp maxBytes to a safe upper bound (10MB)
  const maxBytes = Math.max(1, Math.min(Number(params.maxBytes) || 10000, 10 * 1024 * 1024));
  if (!sessionId || !filePath) throw new Error("sessionId and path are required");

  // Fallback to SSH exec (more reliable across SFTP client states)
  const result = await handleExec({ sessionId, command: `head -c ${maxBytes} ${shellQuote(filePath)}` });
  if (!result.ok) return { ok: false, error: result.error };
  return { content: result.stdout || "(empty file)" };
}

// ── Handler: sftpWrite ──

async function handleSftpWrite(params) {
  const { sessionId, path: filePath, content } = params;
  if (!sessionId || !filePath || content == null) throw new Error("sessionId, path and content are required");

  const sftpClient = findSftpForSession(sessionId);
  if (sftpClient) {
    try {
      await sftpClient.put(Buffer.from(content, "utf-8"), filePath);
      return { written: filePath };
    } catch {
      // Fallback to SSH
    }
  }

  // Use base64 encoding to avoid heredoc delimiter collision issues
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  const result = await handleExec({ sessionId, command: `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(filePath)}` });
  if (!result.ok) return { ok: false, error: result.error };
  return { written: filePath };
}

// ── Handler: sftpMkdir ──

async function handleSftpMkdir(params) {
  const { sessionId, path: dirPath } = params;
  if (!sessionId || !dirPath) throw new Error("sessionId and path are required");

  const sftpClient = findSftpForSession(sessionId);
  if (sftpClient) {
    try {
      await sftpClient.mkdir(dirPath, true); // recursive
      return { created: dirPath };
    } catch {
      // Fallback
    }
  }

  const result = await handleExec({ sessionId, command: `mkdir -p ${shellQuote(dirPath)}` });
  if (!result.ok) return { ok: false, error: result.error };
  return { created: dirPath };
}

// ── Handler: sftpRemove ──

// Critical paths that must never be removed (module-level constant)
const CRITICAL_PATHS = new Set([
  "/", "/root", "/home", "/etc", "/var", "/usr", "/boot",
  "/bin", "/sbin", "/lib", "/lib64", "/dev", "/proc", "/sys", "/tmp", "/opt",
]);

async function handleSftpRemove(params) {
  const { sessionId, path: targetPath } = params;
  if (!sessionId || !targetPath) throw new Error("sessionId and path are required");

  // Guard against deleting root or critical system directories
  // Normalize to resolve "..", "//", and trailing slashes before checking
  const normalizedPath = path.posix.normalize(targetPath).replace(/\/+$/, "") || "/";
  if (CRITICAL_PATHS.has(normalizedPath) || /^\/[^/]+$/.test(normalizedPath)) {
    return { ok: false, error: `Refusing to remove critical or root-level path: ${targetPath}` };
  }

  // Use rm -r (without -f) so permission errors surface instead of being silently ignored
  const result = await handleExec({ sessionId, command: `rm -r ${shellQuote(targetPath)}` });
  if (!result.ok) return { ok: false, error: result.error };
  return { removed: targetPath };
}

// ── Handler: sftpRename ──

async function handleSftpRename(params) {
  const { sessionId, oldPath, newPath } = params;
  if (!sessionId || !oldPath || !newPath) throw new Error("sessionId, oldPath and newPath are required");

  const sftpClient = findSftpForSession(sessionId);
  if (sftpClient) {
    try {
      await sftpClient.rename(oldPath, newPath);
      return { renamed: `${oldPath} → ${newPath}` };
    } catch {
      // Fallback
    }
  }

  const result = await handleExec({ sessionId, command: `mv ${shellQuote(oldPath)} ${shellQuote(newPath)}` });
  if (!result.ok) return { ok: false, error: result.error };
  return { renamed: `${oldPath} → ${newPath}` };
}

// ── Handler: sftpStat ──

async function handleSftpStat(params) {
  const { sessionId, path: targetPath } = params;
  if (!sessionId || !targetPath) throw new Error("sessionId and path are required");

  const sftpClient = findSftpForSession(sessionId);
  if (sftpClient) {
    try {
      const stat = await sftpClient.stat(targetPath);
      return {
        name: path.basename(targetPath),
        type: stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file",
        size: stat.size,
        lastModified: stat.modifyTime,
        permissions: stat.mode ? (stat.mode & 0o777).toString(8) : undefined,
      };
    } catch {
      // Fallback
    }
  }

  // Fallback: use stat command
  const result = await handleExec({ sessionId, command: `stat -c '{"size":%s,"mode":"%a","mtime":%Y,"type":"%F"}' ${shellQuote(targetPath)}` });
  if (!result.ok) return { ok: false, error: result.error };
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {
      name: path.basename(targetPath),
      type: parsed.type?.includes("directory") ? "directory" : "file",
      size: parsed.size,
      lastModified: parsed.mtime * 1000,
      permissions: parsed.mode,
    };
  } catch {
    return { ok: false, error: "Failed to parse stat output" };
  }
}

// ── Handler: multiExec ──

async function handleMultiExec(params) {
  const { sessionIds, command, mode = "parallel", stopOnError = false } = params;
  if (!Array.isArray(sessionIds) || !command) throw new Error("sessionIds and command are required");
  if (sessionIds.length > 50) {
    return { ok: false, error: 'Too many session IDs: maximum is 50' };
  }
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'Invalid command' };
  }

  const safety = checkCommandSafety(command);
  if (safety.blocked) {
    return { ok: false, error: `Command blocked by safety policy. Pattern: ${safety.matchedPattern}` };
  }

  const results = {};

  if (mode === "sequential") {
    for (const sid of sessionIds) {
      const result = await handleExec({ sessionId: sid, command });
      results[sid] = {
        ok: result.ok,
        output: result.ok ? (result.stdout || "(no output)") : `Error: ${result.error || result.stderr || "Failed"}`,
      };
      if (!result.ok && stopOnError) break;
    }
  } else {
    // Parallel execution with concurrency limit
    const tasks = sessionIds.map((sid) => () => {
      return handleExec({ sessionId: sid, command }).then(result => ({
        sid,
        ok: result.ok,
        output: result.ok ? (result.stdout || "(no output)") : `Error: ${result.error || result.stderr || "Failed"}`,
      }));
    });
    const resolved = await limitConcurrency(tasks, 10);
    for (const r of resolved) {
      results[r.sid] = { ok: r.ok, output: r.output };
    }
  }

  return { results };
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
  cancelAllPtyExecs,
  cleanupScopedMetadata,
  cleanup,
};
