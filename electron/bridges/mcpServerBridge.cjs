/**
 * MCP Server Bridge — TCP host in Electron main process
 *
 * Starts a local TCP server that the netcatty-mcp-server.cjs child process
 * connects to. Handles JSON-RPC calls by dispatching to real terminal sessions.
 */
"use strict";

const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { existsSync } = require("node:fs");

const { toUnpackedAsarPath, getFreshIdlePrompt } = require("./ai/shellUtils.cjs");
const { execViaPty, startPtyJob, execViaChannel, execViaRawPty } = require("./ai/ptyExec.cjs");
const { safeSend } = require("./ipcUtils.cjs");
const { getCliDiscoveryFilePath } = require("../cli/discoveryPath.cjs");
const sftpBridge = require("./sftpBridge.cjs");

const DEBUG_MCP = process.env.NETCATTY_MCP_DEBUG === "1";

function debugLog(...args) {
  if (!DEBUG_MCP) return;
  console.error("[MCP Bridge:debug]", ...args);
}

let sessions = null;   // Map<sessionId, { sshClient, stream, pty, proc, conn, ... }>
let tcpServer = null;
let tcpPort = null;
let authToken = null;  // Random token generated when TCP server starts
let pendingHostStart = null; // { promise, server, cancel }
let electronModule = null;
let cliDiscoveryFilePath = getCliDiscoveryFilePath();

// Track which sockets have completed authentication
const authenticatedSockets = new WeakSet();

// Per-scope metadata: chatSessionId → { sessionIds: string[], metadata: Map<sessionId, meta> }
// Each chat session only sees the hosts registered for its scope.
const scopedMetadata = new Map();

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
const activeExecChatSessions = new Map(); // chatSessionId -> { sessionId, command, startedAt }
const backgroundJobs = new Map(); // jobId -> job metadata
const activeSessionExecutions = new Map(); // sessionId -> { kind, startedAt, token }
const activeSessionSftpOps = new Map(); // opId -> { chatSessionId, cancel }
const pendingSessionWriteApprovals = new Map(); // sessionId -> method
const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS = 30 * 1000;
const BACKGROUND_JOB_RETENTION_MS = 10 * 60 * 1000;
const MAX_BACKGROUND_JOB_OUTPUT_CHARS = 256 * 1024;
let activeSftpOpSeq = 0;

// ── Approval gate (for confirm mode with ACP/MCP agents) ──
let getMainWindowFn = null; // () => BrowserWindow | null
const pendingApprovals = new Map(); // approvalId → { resolve, chatSessionId }
let approvalIdCounter = 0;

function setMainWindowGetter(fn) {
  getMainWindowFn = fn;
  debugLog("setMainWindowGetter", { hasGetter: typeof fn === "function" });
}

/**
 * Request approval from the renderer process.
 * Sends an IPC event and returns a Promise<boolean> that resolves
 * when the user approves/rejects in the UI, or auto-denies after timeout.
 */
// External ACP agents (for example Codex) may give up on MCP tool calls after
// about 120 seconds; see openai/codex#6127 ("timed out awaiting tools/call
// after 120s"). Keep the Netcatty-side approval window below that with a small
// buffer so a stale approval cannot still be accepted after the agent has
// already timed out and abandoned the call.
const APPROVAL_TIMEOUT_MS = 110 * 1000; // 110 seconds

function requestApprovalFromRenderer(toolName, args, chatSessionId) {
  return new Promise((resolve) => {
    debugLog("requestApprovalFromRenderer", { toolName, args, chatSessionId });
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
  debugLog("resolveApprovalFromRenderer", { approvalId, approved });
  const entry = pendingApprovals.get(approvalId);
  if (entry) {
    pendingApprovals.delete(approvalId);
    entry.resolve(approved);
  }
}

function notifyRendererApprovalCleared(approvalIds) {
  if (!Array.isArray(approvalIds) || approvalIds.length === 0) return;
  try {
    const win = typeof getMainWindowFn === "function" ? getMainWindowFn() : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send("netcatty:ai:mcp:approval-cleared", { approvalIds });
    }
  } catch {
    // Ignore renderer notification failures during approval cleanup.
  }
}

/**
 * Clear pending MCP approvals, optionally scoped to a specific chatSessionId.
 * Resolves matched entries with false (denied) to unblock hanging promises.
 */
function clearPendingApprovals(chatSessionId) {
  const clearedIds = [];
  if (!chatSessionId) {
    for (const [id, entry] of pendingApprovals) {
      entry.resolve(false);
      clearedIds.push(id);
    }
    pendingApprovals.clear();
    notifyRendererApprovalCleared(clearedIds);
    return;
  }
  for (const [id, entry] of pendingApprovals) {
    if (entry.chatSessionId === chatSessionId) {
      pendingApprovals.delete(id);
      entry.resolve(false);
      clearedIds.push(id);
    }
  }
  notifyRendererApprovalCleared(clearedIds);
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

const { createBackgroundJobApi } = require("./mcpServerBridge/backgroundJobs.cjs");
const backgroundJobApi = createBackgroundJobApi({
  get activeSftpOpSeq() { return activeSftpOpSeq; },
  set activeSftpOpSeq(value) { activeSftpOpSeq = value; },
  backgroundJobs, activeSessionSftpOps, activeSessionExecutions, crypto,
  BACKGROUND_JOB_RETENTION_MS, DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS, MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  debugLog, sftpBridge,
});
const {
  createBackgroundJobId,
  cancelBackgroundJobsForSession,
  registerSftpOp,
  cancelSftpOpsForSession,
  cancelAllSftpOps,
  readBackgroundJobSnapshot,
  createOutputWindow,
  refreshRunningJobSnapshot,
  storeCompletedJobOutput,
  pruneCompletedBackgroundJobs,
  collapseCarriageReturns,
  serializeBackgroundJob,
  describeActiveSessionExecution,
  getSessionBusyError,
  reserveSessionExecution,
  releaseSessionExecution,
} = backgroundJobApi;

function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule || null;
  cliDiscoveryFilePath = deps.cliDiscoveryFilePath || getCliDiscoveryFilePath();
  debugLog("init", { hasSessions: Boolean(sessions), hasElectron: Boolean(electronModule) });
  if (deps.commandBlocklist) {
    commandBlocklist = deps.commandBlocklist;
  }
}

function writeCliDiscoveryFile() {
  if (!tcpPort || !authToken || !cliDiscoveryFilePath) return;
  const payload = {
    port: tcpPort,
    token: authToken,
    pid: process.pid,
    permissionMode,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(cliDiscoveryFilePath), { recursive: true });
    fs.writeFileSync(cliDiscoveryFilePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error("[MCP Bridge] Failed to write AI CLI discovery file:", err?.message || err);
  }
}

function removeCliDiscoveryFile() {
  if (!cliDiscoveryFilePath) return;
  try {
    fs.rmSync(cliDiscoveryFilePath, { force: true });
  } catch (err) {
    console.error("[MCP Bridge] Failed to remove AI CLI discovery file:", err?.message || err);
  }
}

function shutdownHost({ preserveScopedMetadata = false } = {}) {
  removeCliDiscoveryFile();
  authToken = null;
  if (pendingHostStart?.server && pendingHostStart.server !== tcpServer) {
    const inFlightStart = pendingHostStart;
    pendingHostStart = null;
    inFlightStart.cancel?.();
  }
  if (tcpServer) {
    tcpServer.close();
    tcpServer = null;
    tcpPort = null;
  }
  clearPendingApprovals();
  cancelAllPtyExecs();
  void cancelAllSftpOps();
  cancelledChatSessions.clear();
  activeExecChatSessions.clear();
  pendingSessionWriteApprovals.clear();
  if (!preserveScopedMetadata) {
    scopedMetadata.clear();
  }
  for (const [, job] of backgroundJobs) {
    try {
      job.handle?.cancel?.();
    } catch {
      // Ignore cancellation failures during cleanup
    }
  }
  backgroundJobs.clear();
  activeSessionExecutions.clear();
}

function echoCommandToSession(session, sessionId, command) {
  if (!electronModule || !session?.webContentsId || !command) return;
  const contents = electronModule.webContents?.fromId?.(session.webContentsId);
  safeSend(contents, "netcatty:data", {
    sessionId,
    data: `${command}\r\n`,
    syntheticEcho: true,
  });
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
    writeCliDiscoveryFile();
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

function getActiveChatExecution(chatSessionId) {
  if (!chatSessionId) return null;
  return activeExecChatSessions.get(chatSessionId) || null;
}

function beginChatExecution(chatSessionId, sessionId, command) {
  if (!chatSessionId) return { ok: true, release: () => {} };
  const active = getActiveChatExecution(chatSessionId);
  if (active) {
    return {
      ok: false,
      active,
    };
  }
  activeExecChatSessions.set(chatSessionId, {
    sessionId,
    command,
    startedAt: Date.now(),
  });
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const current = activeExecChatSessions.get(chatSessionId);
      if (current && current.sessionId === sessionId && current.command === command) {
        activeExecChatSessions.delete(chatSessionId);
      }
    },
  };
}

/**
 * Register metadata for terminal sessions (called from renderer via IPC).
 * Metadata is stored per-scope (chatSessionId) so different AI chat sessions
 * only see their own hosts.
 * @param {Array<{sessionId, hostname, label, os, username, connected, protocol?, shellType?}>} sessionList
 * @param {string} [chatSessionId] - AI chat session ID for per-scope isolation
 */
function updateSessionMetadata(sessionList, chatSessionId) {
  debugLog("updateSessionMetadata", {
    chatSessionId,
    count: Array.isArray(sessionList) ? sessionList.length : 0,
    sessionIds: Array.isArray(sessionList) ? sessionList.map(s => s.sessionId) : [],
  });
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
      deviceType: s.deviceType || "",
      connected: s.connected !== false,
    });
  }

  // Store per-scope metadata when chatSessionId is provided
  if (chatSessionId) {
    scopedMetadata.set(chatSessionId, { sessionIds: ids, metadata: metaMap });
  }
}

/**
 * Get scoped session IDs for a specific chat session.
 */
function getScopedSessionIds(chatSessionId) {
  if (!chatSessionId) return [];
  const scoped = scopedMetadata.get(chatSessionId);
  return scoped?.sessionIds || [];
}

/**
 * Resolve the effective session scope for a request.
 * Explicit per-call scopedSessionIds may only narrow the chat scope, never widen it.
 *
 * Returns:
 * - `null` when no scope context was provided at all
 * - `[]` when the effective scope is intentionally empty
 * - a concrete array of allowed session IDs otherwise
 */
function resolveScopedSessionIds(chatSessionId, explicitScopedIds = null) {
  const hasExplicitScope = Array.isArray(explicitScopedIds);
  const hasChatScope = typeof chatSessionId === "string" && chatSessionId.length > 0;

  if (!hasExplicitScope && !hasChatScope) {
    return null;
  }

  if (!hasChatScope) {
    return explicitScopedIds;
  }

  const chatScopedIds = getScopedSessionIds(chatSessionId);
  if (!hasExplicitScope) {
    return chatScopedIds;
  }

  const chatScopedSet = new Set(chatScopedIds);
  return explicitScopedIds.filter((sessionId) => chatScopedSet.has(sessionId));
}

/**
 * Look up metadata for a sessionId, scoped to a specific chat session.
 * Falls back to session object properties if no scoped metadata is found.
 */
function getSessionMeta(sessionId, chatSessionId) {
  if (!chatSessionId) return null;
  const scoped = scopedMetadata.get(chatSessionId);
  return scoped?.metadata?.get(sessionId) || null;
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
  if (pendingHostStart?.promise) return pendingHostStart.promise;

  // Generate a random auth token for this server instance
  authToken = crypto.randomBytes(32).toString("hex");

  const server = net.createServer((socket) => {
    debugLog("TCP client connected");
    handleConnection(socket);
  });
  const startState = {
    promise: null,
    server,
    cancel: null,
  };

  const startPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      if (pendingHostStart === startState) {
        pendingHostStart = null;
      }
      if (tcpServer !== server) {
        authToken = null;
      }
      reject(err);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      if (pendingHostStart === startState) {
        pendingHostStart = null;
      }
      resolve(value);
    };
    startState.cancel = () => {
      try {
        server.close();
      } catch {
        // Ignore close failures while aborting a host startup.
      }
      finishReject(new Error("TCP bridge startup cancelled"));
    };

    server.listen(0, "127.0.0.1", () => {
      if (settled) {
        try {
          server.close();
        } catch {
          // Ignore close failures for a host that was already cancelled.
        }
        return;
      }
      tcpPort = server.address().port;
      tcpServer = server;
      debugLog("TCP server listening", { port: tcpPort });
      writeCliDiscoveryFile();
      finishResolve(tcpPort);
    });

    server.on("error", (err) => {
      console.error("[MCP Bridge] TCP server error:", err.message);
      finishReject(err);
    });
  });

  startState.promise = startPromise;
  pendingHostStart = startState;
  return startPromise;
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
      debugLog("Incoming line", line);
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
  debugLog("handleMessage", { id, method, params });
  if (id == null || !method) return;

  // ── Authentication gate ──
  // The first message from any connection MUST be auth/verify with the correct token.
  // All other methods are rejected until the socket is authenticated.
  if (!authenticatedSockets.has(socket)) {
    if (method === "auth/verify" && params?.token === authToken) {
      debugLog("auth/verify success");
      authenticatedSockets.add(socket);
      const response = JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }) + "\n";
      if (!socket.destroyed) socket.write(response);
      return;
    }
    console.warn("[MCP Bridge] auth/verify failed or unexpected first method", method);
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
  "netcatty/sftp/write",
  "netcatty/sftp/download",
  "netcatty/sftp/upload",
  "netcatty/sftp/mkdir",
  "netcatty/sftp/delete",
  "netcatty/sftp/rename",
  "netcatty/sftp/chmod",
  "netcatty/jobStart",
  "netcatty/jobStop",
]);

/**
 * Validate that a sessionId is allowed in the current scope.
 * Explicit per-call scopedSessionIds can only narrow the effective scope;
 * they are intersected with per-chatSession scoped metadata when both exist.
 *
 * An explicit empty array (`[]`) means "no access" — not "fall through to
 * global scope" — matching the documented behavior in handleGetContext.
 */
function validateSessionScope(sessionId, chatSessionId, explicitScopedIds = null) {
  if (!sessionId) return null; // will fail at handler level
  const resolvedScopedIds = resolveScopedSessionIds(chatSessionId, explicitScopedIds);
  if (resolvedScopedIds === null) {
    return "chatSessionId or scopedSessionIds is required.";
  }
  debugLog("validateSessionScope", {
    sessionId,
    chatSessionId,
    explicitScopedIds,
    resolvedScopedIds,
  });
  if (!resolvedScopedIds.includes(sessionId)) {
    return `Session "${sessionId}" is not in the current scope.`;
  }
  return null;
}

async function dispatch(method, params) {
  debugLog("dispatch", { method, params, permissionMode });
  const sessionWriteLockId = (method === "netcatty/exec" || method === "netcatty/jobStart") ? params?.sessionId : null;
  pruneCompletedBackgroundJobs();

  // Observer mode: block all write operations *except* netcatty/jobStop,
  // which must remain available so users can interrupt long-running jobs
  // they started before switching to observer mode (otherwise the job
  // would hold the per-session lock until it exits on its own).
  if (permissionMode === "observer" && WRITE_METHODS.has(method) && method !== "netcatty/jobStop") {
    return { ok: false, error: `Operation denied: permission mode is "observer" (read-only). Change to "confirm" or "autonomous" in Settings → AI → Safety to allow this action.` };
  }

  if (WRITE_METHODS.has(method) && !params?.chatSessionId) {
    return {
      ok: false,
      error: "chatSessionId is required for write operations.",
    };
  }

  // netcatty/jobStop must remain callable after ACP cancel so users can stop
  // a long-running terminal_start job (which intentionally survives ACP Stop)
  // even from a chat session whose write methods are otherwise blocked.
  if (WRITE_METHODS.has(method) && method !== "netcatty/jobStop" && isChatSessionCancelled(params?.chatSessionId)) {
    return { ok: false, error: "Operation cancelled: the ACP session was stopped." };
  }

  // Validate session scope *first* so out-of-scope callers cannot infer the
  // existence or activity of foreign sessions through busy-state error
  // messages, and so requests fail fast without blocking the write lock.
  if (method !== "netcatty/getContext" && params?.sessionId) {
    const scopeErr = validateSessionScope(params.sessionId, params?.chatSessionId, params?.scopedSessionIds);
    if (scopeErr) return { ok: false, error: scopeErr };
  }

  if ((method === "netcatty/exec" || method === "netcatty/jobStart") && params?.sessionId) {
    const busy = getSessionBusyError(params.sessionId);
    if (busy) return busy;
  }

  if (sessionWriteLockId) {
    const pendingMethod = pendingSessionWriteApprovals.get(sessionWriteLockId);
    if (pendingMethod) {
      return {
        ok: false,
        error: "Session already has another command request awaiting approval or startup. Wait for it to finish before starting a new command.",
      };
    }
    pendingSessionWriteApprovals.set(sessionWriteLockId, method);
  }

  try {
    // Confirm mode: request user approval for write operations.
    // netcatty/jobStop bypasses approval — it's a stop/cancel action that
    // must remain available even if the renderer is unavailable; otherwise
    // a runaway terminal_start job could not be interrupted at all.
    if (permissionMode === "confirm" && WRITE_METHODS.has(method) && method !== "netcatty/jobStop") {
      const { chatSessionId, ...toolArgs } = params || {};
      const approved = await requestApprovalFromRenderer(method, toolArgs, chatSessionId);
      if (!approved) {
        return { ok: false, error: "Operation denied by user." };
      }
    }
    switch (method) {
      case "netcatty/getContext":
        return handleGetContext(params);
      case "netcatty/getStatus":
        return handleGetStatus();
      case "netcatty/exec":
        return handleExec(params);
      case "netcatty/sftp/list":
        return handleSftpList(params);
      case "netcatty/sftp/read":
        return handleSftpRead(params);
      case "netcatty/sftp/write":
        return handleSftpWrite(params);
      case "netcatty/sftp/download":
        return handleSftpDownload(params);
      case "netcatty/sftp/upload":
        return handleSftpUpload(params);
      case "netcatty/sftp/mkdir":
        return handleSftpMkdir(params);
      case "netcatty/sftp/delete":
        return handleSftpDelete(params);
      case "netcatty/sftp/rename":
        return handleSftpRename(params);
      case "netcatty/sftp/stat":
        return handleSftpStat(params);
      case "netcatty/sftp/chmod":
        return handleSftpChmod(params);
      case "netcatty/sftp/home":
        return handleSftpHome(params);
      case "netcatty/setCancelled":
        return handleSetCancelled(params);
      case "netcatty/jobStart":
        return handleJobStart(params);
      case "netcatty/jobPoll":
        return handleJobPoll(params);
      case "netcatty/jobStop":
        return handleJobStop(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  } finally {
    if (sessionWriteLockId) {
      pendingSessionWriteApprovals.delete(sessionWriteLockId);
    }
  }
}

// ── Handler: getContext ──

function handleGetContext(params) {
  debugLog("handleGetContext:start", { params, sessionCount: sessions?.size || 0 });
  if (!sessions) return { hosts: [], instructions: "No sessions available." };

  // chatSessionId may be passed via env for per-scope metadata lookup
  const chatSessionId = params?.chatSessionId || null;
  const explicitScopedIds = Array.isArray(params?.scopedSessionIds)
    ? params.scopedSessionIds
    : null;
  const resolvedScopedIds = resolveScopedSessionIds(chatSessionId, explicitScopedIds);
  if (resolvedScopedIds === null) {
    throw new Error("chatSessionId or scopedSessionIds is required.");
  }
  const hasScopedContext = true;
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
      deviceType: meta.deviceType || "",
      connected: meta.connected !== undefined ? meta.connected : !!(session.sshClient || session.conn || ptyStream || session.serialPort),
    });
  }

  return {
    environment: "netcatty-terminal",
    description: "You are operating inside Netcatty, a multi-session terminal manager. " +
      "The available sessions may be remote hosts, local terminals, Mosh-backed shells, or serial port connections (network devices, embedded systems). " +
      "Use the provided tools to execute commands through the sessions exposed by Netcatty. " +
      "Serial sessions (protocol: serial, shellType: raw) do not run a standard shell — commands are sent as-is. " +
      "Network device sessions (deviceType: network) use vendor CLIs (Huawei VRP, Cisco IOS, etc.) — commands are sent as-is without shell wrapping, and exit codes are unavailable. " +
      "Always prefer these tools over suggesting the user to do things manually.",
    hosts,
    hostCount: hosts.length,
  };
}

function handleGetStatus() {
  return {
    ok: true,
    environment: "netcatty-terminal",
    permissionMode,
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    commandTimeoutMs,
    maxIterations,
    tcpPort,
    sessionCount: sessions?.size || 0,
    scopedContextCount: scopedMetadata.size,
    activeExecutionCount: activePtyExecs.size,
    activeSftpOperationCount: activeSessionSftpOps.size,
    activeChatExecutionCount: activeExecChatSessions.size,
    pendingApprovalCount: pendingApprovals.size,
    discoveryFilePath: cliDiscoveryFilePath || null,
    discoveryFilePresent: Boolean(cliDiscoveryFilePath && existsSync(cliDiscoveryFilePath)),
  };
}

async function handleSetCancelled(params) {
  const chatSessionId = params?.chatSessionId;
  const cancelled = params?.cancelled !== false;
  if (!chatSessionId || typeof chatSessionId !== "string") {
    throw new Error("chatSessionId is required");
  }

  if (cancelled) {
    setChatSessionCancelled(chatSessionId, true);
    cancelPtyExecsForSession(chatSessionId);
    cancelBackgroundJobsForSession(chatSessionId);
    clearPendingApprovals(chatSessionId);
    void cancelSftpOpsForSession(chatSessionId);
  } else {
    setChatSessionCancelled(chatSessionId, false);
  }

  return {
    ok: true,
    chatSessionId,
    cancelled,
  };
}

const { createSftpHandlerApi } = require("./mcpServerBridge/sftpHandlers.cjs");
const sftpHandlerApi = createSftpHandlerApi({
  get commandTimeoutMs() { return commandTimeoutMs; },
  sftpBridge, registerSftpOp, setTimeout, clearTimeout, AbortController, Promise, Error,
});
const {
  getSessionSftpEncodingStateKey,
  withSessionBackedSftp,
  handleSftpList,
  handleSftpRead,
  handleSftpWrite,
  handleSftpDownload,
  handleSftpUpload,
  handleSftpMkdir,
  handleSftpDelete,
  handleSftpRename,
  handleSftpStat,
  handleSftpChmod,
  handleSftpHome,
} = sftpHandlerApi;

// ── Handler: exec ──

const { createExecHandlerApi } = require("./mcpServerBridge/execHandlers.cjs");
const execHandlerApi = createExecHandlerApi({
  get sessions() { return sessions; },
  get commandTimeoutMs() { return commandTimeoutMs; },
  DEFAULT_BACKGROUND_JOB_TIMEOUT_MS, DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS, MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  backgroundJobs, activePtyExecs,
  debugLog, getSessionMeta, checkCommandSafety, reserveSessionExecution, releaseSessionExecution,
  beginChatExecution, execViaRawPty, execViaPty, execViaChannel, startPtyJob,
  getFreshIdlePrompt, echoCommandToSession, createBackgroundJobId, storeCompletedJobOutput,
  serializeBackgroundJob, validateSessionScope, Date, Error,
});
const {
  resolveExecContext,
  handleExec,
  handleJobStart,
  getScopedJob,
  handleJobPoll,
  handleJobStop,
} = execHandlerApi;
const { createConfigAndCleanupApi } = require("./mcpServerBridge/configAndCleanup.cjs");
const configAndCleanupApi = createConfigAndCleanupApi({
  get authToken() { return authToken; },
  get permissionMode() { return permissionMode; },
  process, existsSync, path, __dirname, toUnpackedAsarPath, DEBUG_MCP,
  getScopedSessionIds, scopedMetadata, cancelledChatSessions, cancelBackgroundJobsForSession,
  clearPendingApprovals, cancelSftpOpsForSession, sftpBridge,
});
const { resolveMcpServerRuntimeCommand, buildMcpServerConfig, cleanupScopedMetadata } = configAndCleanupApi;

function cleanup() {
  shutdownHost();
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
  cancelBackgroundJobsForSession,
  cancelAllPtyExecs,
  cancelPtyExecsForSession,
  cancelSftpOpsForSession,
  getSessionMeta,
  cleanupScopedMetadata,
  cleanup,
  shutdownHost,
  setMainWindowGetter,
  resolveApprovalFromRenderer,
  clearPendingApprovals,
  reserveSessionExecution,
  releaseSessionExecution,
  getSessionBusyError,
};
