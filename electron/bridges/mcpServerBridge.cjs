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
const { execViaPty, startPtyJob, execViaChannel, execViaRawPty } = require("./ai/ptyExec.cjs");
const { safeSend } = require("./ipcUtils.cjs");

let sessions = null;   // Map<sessionId, { sshClient, stream, pty, proc, conn, ... }>
let tcpServer = null;
let tcpPort = null;
let authToken = null;  // Random token generated when TCP server starts
let electronModule = null;

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
const backgroundJobs = new Map(); // jobId -> job metadata
const activeSessionExecutions = new Map(); // sessionId -> { kind, startedAt, token }
const pendingSessionWriteApprovals = new Map(); // sessionId -> method
const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_BACKGROUND_JOB_POLL_INTERVAL_MS = 30 * 1000;
const BACKGROUND_JOB_RETENTION_MS = 10 * 60 * 1000;
const MAX_BACKGROUND_JOB_OUTPUT_CHARS = 256 * 1024;

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
  if (deps.commandBlocklist) {
    commandBlocklist = deps.commandBlocklist;
  }
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
      deviceType: s.deviceType || "",
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
  "netcatty/jobStart",
  "netcatty/jobStop",
]);

/**
 * Validate that a sessionId is allowed in the current scope.
 * Checks explicit per-call scopedSessionIds first (static MCP scope mode),
 * then per-chatSession scoped metadata (dynamic mode), then global scope.
 *
 * An explicit empty array (`[]`) means "no access" — not "fall through to
 * global scope" — matching the documented behavior in handleGetContext.
 */
function validateSessionScope(sessionId, chatSessionId, explicitScopedIds = null) {
  if (!sessionId) return null; // will fail at handler level
  if (Array.isArray(explicitScopedIds)) {
    if (!explicitScopedIds.includes(sessionId)) {
      return `Session "${sessionId}" is not in the current scope.`;
    }
    return null;
  }
  // If a chat has explicit scoped metadata (even an empty array), enforce it.
  // Only fall through to fallback/global when no chat-scoped context exists.
  if (chatSessionId && scopedMetadata.has(chatSessionId)) {
    const chatScoped = scopedMetadata.get(chatSessionId)?.sessionIds || [];
    if (!chatScoped.includes(sessionId)) {
      return `Session "${sessionId}" is not in the current scope.`;
    }
    return null;
  }
  const scopedIds = getScopedSessionIds(chatSessionId);
  if (scopedIds && scopedIds.length > 0 && !scopedIds.includes(sessionId)) {
    return `Session "${sessionId}" is not in the current scope.`;
  }
  return null;
}

async function dispatch(method, params) {
  const sessionWriteLockId = (method === "netcatty/exec" || method === "netcatty/jobStart") ? params?.sessionId : null;
  pruneCompletedBackgroundJobs();

  // Observer mode: block all write operations *except* netcatty/jobStop,
  // which must remain available so users can interrupt long-running jobs
  // they started before switching to observer mode (otherwise the job
  // would hold the per-session lock until it exits on its own).
  if (permissionMode === "observer" && WRITE_METHODS.has(method) && method !== "netcatty/jobStop") {
    return { ok: false, error: `Operation denied: permission mode is "observer" (read-only). Change to "confirm" or "autonomous" in Settings → AI → Safety to allow this action.` };
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
      case "netcatty/exec":
        return handleExec(params);
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

// ── Handler: exec ──

function resolveExecContext(params) {
  const { sessionId, command } = params;
  if (!sessionId || !command) throw new Error("sessionId and command are required");
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'Invalid command', exitCode: 1 };
  }

  const session = sessions?.get(sessionId);
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

  const runExecution = (factory) => {
    try {
      return Promise.resolve(factory()).finally(() => {
        releaseSessionExecution(sessionId, sessionToken);
      });
    } catch (err) {
      releaseSessionExecution(sessionId, sessionToken);
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
      // MCP callers have terminal_start as a fallback for long commands,
      // so enforce a hard wall-clock timeout here to match the MCP budget.
      enforceWallTimeout: true,
    }));
  }

  // Network devices require an interactive PTY for raw command execution.
  // If we got here, ptyStream wasn't writable — there's no usable channel.
  if (isNetworkDevice) {
    releaseSessionExecution(sessionId, sessionToken);
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
  // Covers dynamic (chatSessionId), static (scopedSessionIds), and global modes.
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
  // Use provided scoped IDs, or resolve from chatSessionId, or fall back
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

function cleanupScopedMetadata(chatSessionId) {
  if (chatSessionId) {
    scopedMetadata.delete(chatSessionId);
    cancelledChatSessions.delete(chatSessionId);
    cancelBackgroundJobsForSession(chatSessionId);
    // Resolve any in-flight approval requests so dispatch()'s finally block
    // releases its pendingSessionWriteApprovals entry. Without this, a chat
    // deleted while an approval was pending would leave the per-session
    // write lock held until the 5-minute approval timeout.
    clearPendingApprovals(chatSessionId);
  }
}

function cleanup() {
  if (tcpServer) {
    tcpServer.close();
    tcpServer = null;
    tcpPort = null;
  }
  scopedMetadata.clear();
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
  getSessionMeta,
  cleanupScopedMetadata,
  cleanup,
  setMainWindowGetter,
  resolveApprovalFromRenderer,
  clearPendingApprovals,
  reserveSessionExecution,
  releaseSessionExecution,
  getSessionBusyError,
};
