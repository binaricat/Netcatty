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

const { toUnpackedAsarPath } = require("./ai/shellUtils.cjs");
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

function createBackgroundJobId() {
  return `job_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function cancelBackgroundJobsForSession(chatSessionId) {
  if (!chatSessionId) return;
  for (const [, job] of backgroundJobs) {
    if (job.chatSessionId !== chatSessionId) continue;
    if (job.status !== "running") continue;
    try {
      job.handle?.cancel?.();
      job.status = "stopping";
      job.error = "Cancellation requested";
      job.updatedAt = Date.now();
    } catch {
      // Ignore cancellation failures
    }
  }
}

function registerSftpOp(chatSessionId, cancel) {
  if (!chatSessionId || typeof cancel !== "function") {
    return () => {};
  }
  const opId = `sftp_${Date.now().toString(36)}_${(++activeSftpOpSeq).toString(36)}`;
  activeSessionSftpOps.set(opId, { chatSessionId, cancel });
  return () => {
    activeSessionSftpOps.delete(opId);
  };
}

async function cancelSftpOpsForSession(chatSessionId) {
  if (!chatSessionId) return;
  const pending = [];
  for (const [opId, entry] of activeSessionSftpOps) {
    if (entry.chatSessionId !== chatSessionId) continue;
    activeSessionSftpOps.delete(opId);
    try {
      pending.push(Promise.resolve(entry.cancel()));
    } catch {
      // Ignore cancellation failures for already-closed SFTP handles.
    }
  }
  if (pending.length) {
    await Promise.allSettled(pending);
  }
}

function cancelAllSftpOps() {
  const pending = [];
  for (const [opId, entry] of activeSessionSftpOps) {
    activeSessionSftpOps.delete(opId);
    try {
      pending.push(Promise.resolve(entry.cancel()));
    } catch {
      // Ignore cancellation failures during global cleanup.
    }
  }
  return pending.length ? Promise.allSettled(pending) : Promise.resolve([]);
}

function readBackgroundJobSnapshot(job) {
  if (!job) {
    return {
      stdout: "",
      outputBaseOffset: 0,
      totalOutputChars: 0,
      outputTruncated: false,
    };
  }
  if (job.status === "running" || job.status === "stopping") {
    const snapshot = job.handle?.getSnapshot?.();
    if (snapshot) {
      const stdout = String(snapshot.stdout || "");
      const outputBaseOffset = Math.max(0, Number(snapshot.outputBaseOffset) || 0);
      const totalOutputChars = Math.max(outputBaseOffset + stdout.length, Number(snapshot.totalOutputChars) || 0);
      return {
        stdout,
        outputBaseOffset,
        totalOutputChars,
        outputTruncated: Boolean(snapshot.outputTruncated),
      };
    }
  }
  const stdout = String(job.stdout || "");
  const outputBaseOffset = Math.max(0, Number(job.outputBaseOffset) || 0);
  const totalOutputChars = Math.max(outputBaseOffset + stdout.length, Number(job.totalOutputChars) || 0);
  return {
    stdout,
    outputBaseOffset,
    totalOutputChars,
    outputTruncated: Boolean(job.outputTruncated),
  };
}

function createOutputWindow(stdout) {
  const fullText = String(stdout || "");
  const totalOutputChars = fullText.length;
  const outputBaseOffset = Math.max(0, totalOutputChars - MAX_BACKGROUND_JOB_OUTPUT_CHARS);
  return {
    stdout: outputBaseOffset > 0 ? fullText.slice(outputBaseOffset) : fullText,
    outputBaseOffset,
    totalOutputChars,
    outputTruncated: outputBaseOffset > 0,
  };
}

function refreshRunningJobSnapshot(job) {
  if (!job || (job.status !== "running" && job.status !== "stopping")) return;
  const snapshot = readBackgroundJobSnapshot(job);
  job.stdout = snapshot.stdout;
  job.outputBaseOffset = snapshot.outputBaseOffset;
  job.totalOutputChars = snapshot.totalOutputChars;
  job.outputTruncated = snapshot.outputTruncated;
}

function storeCompletedJobOutput(job, stdout, metadata = null) {
  if (metadata && typeof metadata === "object") {
    const normalizedStdout = String(metadata.stdout ?? stdout ?? "");
    const outputBaseOffset = Math.max(0, Number(metadata.outputBaseOffset) || 0);
    const totalOutputChars = Math.max(outputBaseOffset + normalizedStdout.length, Number(metadata.totalOutputChars) || 0);
    job.stdout = normalizedStdout;
    job.outputBaseOffset = outputBaseOffset;
    job.totalOutputChars = totalOutputChars;
    job.outputTruncated = Boolean(metadata.outputTruncated);
    job.handle = null;
    return;
  }
  const window = createOutputWindow(stdout);
  job.stdout = window.stdout;
  job.outputBaseOffset = window.outputBaseOffset;
  job.totalOutputChars = window.totalOutputChars;
  job.outputTruncated = window.outputTruncated;
  job.handle = null;
}

function pruneCompletedBackgroundJobs(now = Date.now()) {
  for (const [jobId, job] of backgroundJobs) {
    if (job.status === "running" || job.status === "stopping") continue;
    const updatedAt = Number(job.updatedAt) || 0;
    if (updatedAt > 0 && now - updatedAt > BACKGROUND_JOB_RETENTION_MS) {
      backgroundJobs.delete(jobId);
    }
  }
}

// Collapse carriage-return progress redraws to the latest frame.
// Each \r resets the cursor to the start of the current line; the next
// non-\r character overwrites the existing line content. A trailing \r
// (with no following content) leaves the existing line intact, so a
// snapshot taken between redraws still shows the latest visible frame.
// Used at serialize time so the stored buffer can keep raw monotonic
// offsets while polled output shows the latest frame.
function collapseCarriageReturns(text) {
  if (!text || text.indexOf("\r") === -1) return text;
  let result = "";
  let crPending = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\r") {
      crPending = true;
      continue;
    }
    if (ch === "\n") {
      crPending = false;
      result += ch;
      continue;
    }
    if (crPending) {
      const lastNl = result.lastIndexOf("\n");
      result = lastNl >= 0 ? result.slice(0, lastNl + 1) : "";
      crPending = false;
    }
    result += ch;
  }
  return result;
}

function serializeBackgroundJob(job, offset = 0) {
  if (job.status === "running" || job.status === "stopping") {
    refreshRunningJobSnapshot(job);
  }
  const stdout = job.stdout || "";
  const outputBaseOffset = job.outputBaseOffset || 0;
  const totalOutputChars = Math.max(outputBaseOffset + stdout.length, job.totalOutputChars || 0);
  const numericOffset = Math.max(0, Number(offset) || 0);
  const relativeOffset = numericOffset <= outputBaseOffset
    ? 0
    : Math.min(numericOffset - outputBaseOffset, stdout.length);
  return {
    ok: true,
    jobId: job.id,
    sessionId: job.sessionId,
    command: job.command,
    status: job.status,
    completed: job.status !== "running" && job.status !== "stopping",
    exitCode: job.exitCode,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    output: collapseCarriageReturns(stdout.slice(relativeOffset)),
    nextOffset: totalOutputChars,
    totalOutputChars,
    outputBaseOffset,
    outputTruncated: Boolean(job.outputTruncated),
    recommendedPollIntervalMs: DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS,
  };
}

function describeActiveSessionExecution(entry) {
  if (!entry) return "another command";
  return entry.kind === "job" ? "a long-running command" : "another command";
}

function getSessionBusyError(sessionId) {
  const active = activeSessionExecutions.get(sessionId);
  if (!active) return null;
  return {
    ok: false,
    error: `Session already has ${describeActiveSessionExecution(active)} in progress. Wait for it to finish or stop it before starting another command.`,
  };
}

function reserveSessionExecution(sessionId, kind) {
  const existing = getSessionBusyError(sessionId);
  if (existing) return existing;
  const token = `${kind}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  activeSessionExecutions.set(sessionId, {
    kind,
    startedAt: Date.now(),
    token,
  });
  return { ok: true, token };
}

function releaseSessionExecution(sessionId, token) {
  const active = activeSessionExecutions.get(sessionId);
  if (!active) return;
  if (token && active.token !== token) return;
  activeSessionExecutions.delete(sessionId);
}

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

function getSessionSftpEncodingStateKey(chatSessionId, sessionId) {
  if (!chatSessionId || !sessionId) return null;
  return `chat:${chatSessionId}:session:${sessionId}`;
}

async function withSessionBackedSftp(params, action, options = {}) {
  if (!params?.sessionId) throw new Error("sessionId is required");
  const chatSessionId = typeof params?.chatSessionId === "string" && params.chatSessionId ? params.chatSessionId : null;
  const encodingStateKey = getSessionSftpEncodingStateKey(chatSessionId, params.sessionId);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
  const cancelCleanupGraceMs = Number.isFinite(options.cancelCleanupGraceMs) && options.cancelCleanupGraceMs >= 0
    ? options.cancelCleanupGraceMs
    : 1000;
  const operationName = options.operationName || "SFTP operation";
  const abortController = new AbortController();
  let sftpId = null;
  let timeoutId = null;
  let forceCloseTimer = null;
  let closeRequested = false;
  let closePromise = null;
  let cancellationError = null;
  let timeoutError = null;
  const closeSftpHandle = () => {
    if (!sftpId) {
      return Promise.resolve();
    }
    if (!closePromise) {
      closePromise = Promise.resolve().then(() => sftpBridge.closeSftp(null, { sftpId, encodingStateKey }));
    }
    return closePromise;
  };
  const closeSftpInBackground = () => {
    if (closeRequested) return;
    closeRequested = true;
    void closeSftpHandle().catch(() => {
      // Ignore close failures while cleaning up a cancelled or timed-out handle.
    });
  };
  const requestAbort = (err) => {
    if (!abortController.signal.aborted) {
      abortController.abort(err);
    }
    if (!forceCloseTimer && !closeRequested) {
      forceCloseTimer = setTimeout(() => {
        forceCloseTimer = null;
        closeSftpInBackground();
      }, cancelCleanupGraceMs);
    }
  };
  const unregisterSftpOp = registerSftpOp(chatSessionId, () => {
    if (!cancellationError) {
      cancellationError = new Error("Cancelled");
    }
    requestAbort(cancellationError);
  });
  try {
    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        if (!timeoutError) {
          timeoutError = new Error(`${operationName} timed out after ${timeoutMs}ms`);
        }
        requestAbort(timeoutError);
      }, timeoutMs);
    }

    const opened = await sftpBridge.openSftpForSession(null, {
      sessionId: params.sessionId,
      encodingStateKey,
      abortSignal: abortController.signal,
      timeoutMs,
    });
    sftpId = opened?.sftpId;
    if (!sftpId) throw new Error("Failed to open session-backed SFTP handle");
    if (timeoutError) {
      throw timeoutError;
    }
    if (cancellationError) {
      throw cancellationError;
    }

    const payload = {
      ...params,
      sftpId,
      abortSignal: abortController.signal,
      timeoutMs,
    };
    const value = await Promise.resolve().then(() => action(payload));
    if (timeoutError) {
      throw timeoutError;
    }
    if (cancellationError) {
      throw cancellationError;
    }
    return value;
  } catch (err) {
    if (timeoutError) {
      throw timeoutError;
    }
    if (cancellationError) {
      throw cancellationError;
    }
    throw err;
  } finally {
    unregisterSftpOp();
    if (timeoutId) clearTimeout(timeoutId);
    if (forceCloseTimer) {
      clearTimeout(forceCloseTimer);
      forceCloseTimer = null;
    }
    try {
      await closeSftpHandle();
    } catch {
      // Ignore close failures for one-off internal SFTP handles.
    }
  }
}

async function handleSftpList(params) {
  const entries = await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.listSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP list" },
  );
  return { ok: true, entries };
}

async function handleSftpRead(params) {
  if (!params?.path) throw new Error("path is required");
  const content = await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.readSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP read" },
  );
  return { ok: true, path: params.path, content };
}

async function handleSftpWrite(params) {
  if (!params?.path) throw new Error("path is required");
  if (typeof params?.content !== "string") throw new Error("content is required");
  await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.writeSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP write" },
  );
  return { ok: true, path: params.path };
}

async function handleSftpDownload(params) {
  if (!params?.remotePath || !params?.localPath) {
    throw new Error("remotePath and localPath are required");
  }
  const result = await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.downloadSftpToLocal(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP download" },
  );
  return { ok: true, ...result };
}

async function handleSftpUpload(params) {
  if (!params?.remotePath || !params?.localPath) {
    throw new Error("remotePath and localPath are required");
  }
  const result = await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.uploadLocalToSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP upload" },
  );
  return { ok: true, ...result };
}

async function handleSftpMkdir(params) {
  if (!params?.path) throw new Error("path is required");
  await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.mkdirSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP mkdir" },
  );
  return { ok: true, path: params.path };
}

async function handleSftpDelete(params) {
  if (!params?.path) throw new Error("path is required");
  await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.deleteSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP delete" },
  );
  return { ok: true, path: params.path };
}

async function handleSftpRename(params) {
  if (!params?.oldPath || !params?.newPath) {
    throw new Error("oldPath and newPath are required");
  }
  await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.renameSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP rename" },
  );
  return { ok: true, oldPath: params.oldPath, newPath: params.newPath };
}

async function handleSftpStat(params) {
  if (!params?.path) throw new Error("path is required");
  const stat = await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.statSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP stat" },
  );
  return { ok: true, stat };
}

async function handleSftpChmod(params) {
  if (!params?.path || !params?.mode) throw new Error("path and mode are required");
  await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.chmodSftp(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP chmod" },
  );
  return { ok: true, path: params.path, mode: params.mode };
}

async function handleSftpHome(params) {
  const result = await withSessionBackedSftp(
    params,
    (payload) => sftpBridge.getSftpHomeDir(null, payload),
    { timeoutMs: commandTimeoutMs, operationName: "SFTP home" },
  );
  if (!result?.success) {
    throw new Error(result?.error || "Could not determine home directory");
  }
  return { ok: true, homeDir: result.homeDir };
}

// ── Handler: exec ──

function resolveExecContext(params) {
  const { sessionId, command } = params;
  debugLog("handleExec:start", { sessionId, command, chatSessionId: params?.chatSessionId });
  if (!sessionId || !command) throw new Error("sessionId and command are required");
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'Invalid command', exitCode: 1 };
  }

  const session = sessions?.get(sessionId);
  debugLog("handleExec:sessionLookup", {
    sessionId,
    found: Boolean(session),
    protocol: session?.protocol || session?.type || null,
    shellKind: session?.shellKind || null,
  });
  if (!session) return { ok: false, error: "Session not found" };

  // Look up device type from metadata (set by renderer from Host.deviceType).
  const chatSessionId = params?.chatSessionId || null;
  const meta = getSessionMeta(sessionId, chatSessionId) || {};
  // Mosh sessions use a shell-backed PTY and cannot connect to vendor CLIs,
  // so network device mode only applies to SSH and serial sessions.
  // Prefer session.protocol (runtime truth) over meta.protocol (renderer hint)
  // because Mosh tabs report as protocol:"ssh" in metadata but "mosh" in session.
  const sessionProtocol = session.protocol || session.type || meta.protocol || "";
  const isSshOrSerial = sessionProtocol === "ssh" || sessionProtocol === "serial";
  const isNetworkDevice = (meta.deviceType === "network" && isSshOrSerial) || sessionProtocol === "serial";

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
  if (!isNetworkDevice) {
    const safety = checkCommandSafety(command);
    if (safety.blocked) {
      debugLog("handleExec:blocklisted", { sessionId, matchedPattern: safety.matchedPattern });
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
  return {
    ok: true,
    context: {
      sessionId,
      command,
      session,
      chatSessionId,
      sessionProtocol,
      isNetworkDevice,
      sshClient,
      ptyStream,
    },
  };
}

function handleExec(params) {
  const resolved = resolveExecContext(params);
  if (!resolved.ok) return resolved;
  const {
    sessionId,
    command,
    session,
    chatSessionId,
    sessionProtocol,
    isNetworkDevice,
    sshClient,
    ptyStream,
  } = resolved.context;
  const reservation = reserveSessionExecution(sessionId, "exec");
  if (!reservation.ok) return reservation;
  const sessionToken = reservation.token;
  const executionLock = beginChatExecution(chatSessionId, sessionId, command);
  if (!executionLock.ok) {
    releaseSessionExecution(sessionId, sessionToken);
    return {
      ok: false,
      code: "COMMAND_ALREADY_RUNNING",
      error: `Another Netcatty command is already running for chat session "${chatSessionId}". Wait for it to finish before starting a new exec.`,
      activeCommand: executionLock.active.command,
      activeSessionId: executionLock.active.sessionId,
    };
  }

  const runExecution = (factory) => {
    try {
      return Promise.resolve(factory()).finally(() => {
        releaseSessionExecution(sessionId, sessionToken);
        executionLock.release();
      });
    } catch (err) {
      releaseSessionExecution(sessionId, sessionToken);
      executionLock.release();
      return { ok: false, error: err?.message || String(err) };
    }
  };

  // Network devices (switches/routers) connected via SSH: use raw execution.
  // Their vendor CLIs (Huawei VRP, Cisco IOS, etc.) don't run a POSIX shell,
  // so shell-wrapped commands with markers would fail. Raw mode sends commands
  // as-is with idle-timeout completion detection — same as serial sessions.
  if (isNetworkDevice && ptyStream && typeof ptyStream.write === "function") {
    return runExecution(() => execViaRawPty(ptyStream, command, {
      timeoutMs: commandTimeoutMs,
      trackForCancellation: activePtyExecs,
      chatSessionId: params?.chatSessionId,
      encoding: "utf8", // SSH PTY streams use UTF-8, not latin1
    }));
  }

  // Prefer the interactive PTY so the user sees command/output in-session.
  if (ptyStream && typeof ptyStream.write === "function") {
    return runExecution(() => execViaPty(ptyStream, command, {
      trackForCancellation: activePtyExecs,
      timeoutMs: commandTimeoutMs,
      shellKind: session.shellKind,
      expectedPrompt: session.lastIdlePrompt || "",
      typedInput: true,
      echoCommand: (rawCommand) => echoCommandToSession(session, sessionId, rawCommand),
      chatSessionId,
      // MCP callers have terminal_start as a fallback for long commands,
      // so enforce a hard wall-clock timeout here to match the MCP budget.
      enforceWallTimeout: true,
    }));
  }

  // Network devices require an interactive PTY for raw command execution.
  // If we got here, ptyStream wasn't writable — there's no usable channel.
  if (isNetworkDevice) {
    releaseSessionExecution(sessionId, sessionToken);
    executionLock.release();
    return { ok: false, error: "Network device session has no writable PTY stream for command execution" };
  }

  // Fallback: SSH exec channel (invisible to terminal).
  // At this point ptyStream is not writable (already returned above if it was).
  if (sshClient && typeof sshClient.exec === "function") {
    return runExecution(() => execViaChannel(sshClient, command, {
      timeoutMs: commandTimeoutMs,
      trackForCancellation: activePtyExecs,
      // Pass chatSessionId so cancelPtyExecsForSession can interrupt this
      // exec channel when the originating ACP run is stopped.
      chatSessionId: params?.chatSessionId,
    }));
  }

  // Serial port: raw command execution (no shell wrapping)
  if (session.protocol === "serial" && session.serialPort && typeof session.serialPort.write === "function") {
    return runExecution(() => execViaRawPty(session.serialPort, command, {
      timeoutMs: commandTimeoutMs,
      trackForCancellation: activePtyExecs,
      chatSessionId: params?.chatSessionId,
      encoding: session.serialEncoding || "utf8",
    }));
  }

  releaseSessionExecution(sessionId, sessionToken);
  executionLock.release();
  return { ok: false, error: "Session does not support command execution" };
}

function handleJobStart(params) {
  const resolved = resolveExecContext(params);
  if (!resolved.ok) return resolved;
  const {
    sessionId,
    command,
    session,
    chatSessionId,
    isNetworkDevice,
    sessionProtocol,
    ptyStream,
  } = resolved.context;

  if (isNetworkDevice || sessionProtocol === "serial") {
    return {
      ok: false,
      error: "Background execution currently supports shell-backed PTY sessions only.",
    };
  }

  if (!ptyStream || typeof ptyStream.write !== "function") {
    return {
      ok: false,
      error: "Background execution requires a writable PTY-backed terminal session.",
    };
  }

  const reservation = reserveSessionExecution(sessionId, "job");
  if (!reservation.ok) return reservation;
  const sessionToken = reservation.token;

  const jobId = createBackgroundJobId();
  const timeoutMs = Math.max(commandTimeoutMs, DEFAULT_BACKGROUND_JOB_TIMEOUT_MS);
  let handle;
  try {
    handle = startPtyJob(ptyStream, command, {
      // Intentionally do NOT register in activePtyExecs: terminal_start jobs
      // are designed to survive ACP "Stop" so the model can stop polling
      // without aborting a long-running build/scan/log stream. The job is
      // managed via terminal_stop and the per-session execution lock.
      timeoutMs,
      shellKind: session.shellKind,
      chatSessionId,
      expectedPrompt: session.lastIdlePrompt || "",
      typedInput: true,
      echoCommand: (rawCommand) => echoCommandToSession(session, sessionId, rawCommand),
      maxBufferedChars: MAX_BACKGROUND_JOB_OUTPUT_CHARS,
      normalizeFinalOutput: false,
    });
  } catch (err) {
    releaseSessionExecution(sessionId, sessionToken);
    return { ok: false, error: err?.message || String(err) };
  }

  const startedAt = Date.now();
  const job = {
    id: jobId,
    sessionId,
    chatSessionId: chatSessionId || null,
    command,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    exitCode: null,
    error: null,
    stdout: "",
    outputBaseOffset: 0,
    totalOutputChars: 0,
    outputTruncated: false,
    handle,
  };
  backgroundJobs.set(jobId, job);

  handle.resultPromise.then((result) => {
    job.updatedAt = Date.now();
    job.exitCode = result.exitCode ?? null;
    storeCompletedJobOutput(job, result.stdout || "", result);
    const isForcedCancel = typeof result.error === "string" && result.error.includes("forced");
    if (result.error === "Cancelled" || isForcedCancel) {
      // Forced cancel means the process ignored SIGINT for the cancel
      // wall-clock window. We mark the job as cancelled and release the
      // lock so the session is reusable; the error message tells the
      // caller the process may still be running so subsequent commands
      // should be considered carefully. This is consistent: callers see
      // completed=true exactly when the lock is no longer held.
      job.status = "cancelled";
      job.error = result.error;
      releaseSessionExecution(sessionId, sessionToken);
      return;
    }
    if (result.error) {
      job.status = "failed";
      job.error = result.error;
      releaseSessionExecution(sessionId, sessionToken);
      return;
    }
    // A non-zero exit code without an error message still represents a
    // failed command (e.g. a build/test that returned 1). Mark it as failed
    // so callers don't have to special-case exitCode against status.
    if (typeof result.exitCode === "number" && result.exitCode !== 0) {
      job.status = "failed";
      job.error = `Command exited with code ${result.exitCode}`;
      releaseSessionExecution(sessionId, sessionToken);
      return;
    }
    job.status = "completed";
    releaseSessionExecution(sessionId, sessionToken);
  }).catch((err) => {
    job.updatedAt = Date.now();
    job.status = "failed";
    job.error = err?.message || String(err);
    storeCompletedJobOutput(job, job.stdout || "");
    releaseSessionExecution(sessionId, sessionToken);
  });

  return {
    ok: true,
    jobId,
    sessionId,
    command,
    status: "running",
    startedAt,
    outputMode: "foreground-mirrored",
    recommendedPollIntervalMs: DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS,
  };
}

function getScopedJob(jobId, chatSessionId) {
  const job = backgroundJobs.get(jobId);
  if (!job) return null;
  // Per-chat isolation: a job started under a chat session can only be
  // accessed by callers presenting the same chatSessionId. Unscoped or
  // statically-scoped callers cannot reach into another chat's jobs.
  if (job.chatSessionId) {
    if (!chatSessionId || job.chatSessionId !== chatSessionId) {
      return null;
    }
  }
  return job;
}

function handleJobPoll(params) {
  const { jobId, offset = 0, chatSessionId, scopedSessionIds } = params || {};
  if (!jobId) throw new Error("jobId is required");
  const job = getScopedJob(jobId, chatSessionId || null);
  if (!job) return { ok: false, error: "Background job not found" };
  // Re-check session scope so a caller that lost access to the host
  // cannot continue reading output from jobs on that session.
  // Covers dynamic (chatSessionId) and static (scopedSessionIds) modes.
  if (job.sessionId) {
    const scopeErr = validateSessionScope(job.sessionId, chatSessionId || null, scopedSessionIds);
    if (scopeErr) return { ok: false, error: scopeErr };
  }
  return serializeBackgroundJob(job, offset);
}

function handleJobStop(params) {
  const { jobId, chatSessionId, scopedSessionIds } = params || {};
  if (!jobId) throw new Error("jobId is required");
  const job = getScopedJob(jobId, chatSessionId || null);
  if (!job) return { ok: false, error: "Background job not found" };
  // For statically scoped MCP clients, validate that the job's session is
  // within the caller's static scope so a foreign jobId cannot cancel jobs
  // outside the caller's allowed sessions. Dynamic chat scope is already
  // enforced by getScopedJob (caller's chatSessionId must match the job's),
  // and we intentionally do NOT re-check dynamic scope here so jobs can
  // still be stopped after workspace membership changes — otherwise the
  // session lock would stay held forever.
  if (Array.isArray(scopedSessionIds) && job.sessionId) {
    if (!scopedSessionIds.includes(job.sessionId)) {
      return { ok: false, error: `Session "${job.sessionId}" is not in the current scope.` };
    }
  }
  if (job.status === "running") {
    try {
      job.handle?.cancel?.();
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
    job.status = "stopping";
    job.error = "Cancellation requested";
    job.updatedAt = Date.now();
  }
  return serializeBackgroundJob(job, 0);
}

// ── MCP Server Config Builder ──

function resolveMcpServerRuntimeCommand() {
  const runtimeCommand = process.execPath;
  const runtimeEnv = [];

  if (runtimeCommand && existsSync(runtimeCommand)) {
    const basename = path.basename(runtimeCommand).toLowerCase();
    const isNodeBinary = basename === "node" || basename.startsWith("node.");
    if (!isNodeBinary) {
      runtimeEnv.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
    }
    return { command: runtimeCommand, env: runtimeEnv };
  }

  return { command: "node", env: runtimeEnv };
}

function buildMcpServerConfig(port, scopedSessionIds, chatSessionId) {
  // Use provided scoped IDs, or resolve them from chatSessionId.
  const effectiveIds = (scopedSessionIds && scopedSessionIds.length > 0)
    ? scopedSessionIds
    : getScopedSessionIds(chatSessionId);

  const runtimePath = toUnpackedAsarPath(
    path.join(__dirname, "..", "mcp", "netcatty-mcp-server.cjs"),
  );
  const runtime = resolveMcpServerRuntimeCommand();

  const env = [
    ...runtime.env,
    { name: "NETCATTY_MCP_PORT", value: String(port) },
  ];

  if (authToken) {
    env.push({ name: "NETCATTY_MCP_TOKEN", value: authToken });
  }
  if (DEBUG_MCP) {
    env.push({ name: "NETCATTY_MCP_DEBUG", value: "1" });
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
    command: runtime.command,
    args: [runtimePath],
    env,
  };
}

// ── Cleanup ──

async function cleanupScopedMetadata(chatSessionId) {
  if (chatSessionId) {
    scopedMetadata.delete(chatSessionId);
    cancelledChatSessions.delete(chatSessionId);
    cancelBackgroundJobsForSession(chatSessionId);
    // Resolve any in-flight approval requests so dispatch()'s finally block
    // releases its pendingSessionWriteApprovals entry. Without this, a chat
    // deleted while an approval was pending would leave the per-session
    // write lock held until the approval timeout expires.
    clearPendingApprovals(chatSessionId);
    await cancelSftpOpsForSession(chatSessionId);
    sftpBridge.clearSftpEncodingStateByPrefix?.(`chat:${chatSessionId}:session:`);
  }
}

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
