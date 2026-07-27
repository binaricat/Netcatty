"use strict";

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { spawn: defaultSpawn } = require("node:child_process");
const tempDirBridge = require("../../tempDirBridge.cjs");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

function resolveAntigravityWorkerPath(baseDir = __dirname) {
  const bundledPath = path.join(baseDir, "antigravity_worker.py");
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  return bundledPath.includes(asarSegment)
    ? bundledPath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : bundledPath;
}

function buildAntigravityWorkerRequest({
  prompt,
  cwd,
  permissionMode,
  toolIntegrationMode,
  model,
  resumeSessionId,
  attachments,
  injectedMcpServers,
  saveDir,
  appDataDir,
}) {
  const request = {
    type: "turn",
    prompt: String(prompt || ""),
    cwd: String(cwd || process.cwd()),
    permissionMode: permissionMode || "confirm",
    toolIntegrationMode: toolIntegrationMode || "mcp",
    saveDir,
    appDataDir,
    conversationId: resumeSessionId || null,
    attachments: (attachments || [])
      .filter((attachment) => attachment?.filePath)
      .map((attachment) => ({
        path: attachment.filePath,
        mediaType: attachment.mediaType || "application/octet-stream",
        filename: attachment.filename || path.basename(attachment.filePath),
      })),
    mcpServers: (injectedMcpServers || [])
      .filter((server) => server?.name && server?.command)
      .map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args || [],
        env: mcpEnvPairsToObject(server.env),
      })),
  };
  if (model) request.model = model;
  return request;
}

function resolveAntigravityStorageDirs() {
  const root = path.join(tempDirBridge.getTempDir(), "antigravity-sdk");
  const saveDir = path.join(root, "sessions");
  const appDataDir = path.join(root, "app-data");
  fs.mkdirSync(saveDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
  return { saveDir, appDataDir };
}

function translateAntigravityWorkerEvent(event, emitter) {
  if (!event || typeof event !== "object") return;
  switch (event.type) {
    case "text":
      emitter.text?.(String(event.text || ""));
      break;
    case "reasoning":
      emitter.reasoning?.(String(event.text || ""));
      break;
    case "reasoning_end":
      emitter.reasoningEnd?.();
      break;
    case "tool_call":
      emitter.toolCall?.(event.name, event.args || {}, event.id || undefined);
      break;
    case "tool_result":
      emitter.toolResult?.(event.id || "", event.output, event.name || undefined);
      break;
    case "usage":
      emitter.usage?.({
        inputTokens: Number(event.inputTokens || 0),
        cachedInputTokens: Number(event.cachedInputTokens || 0),
        outputTokens: Number(event.outputTokens || 0),
        reasoningTokens: Number(event.reasoningTokens || 0),
        totalTokens: Number(event.totalTokens || 0),
      });
      break;
    case "session_id":
      emitter.sessionId?.(event.sessionId);
      break;
    case "status":
      emitter.status?.(String(event.message || ""));
      break;
  }
}

function formatWorkerFailure(stderr, code, signal) {
  const detail = String(stderr || "").trim();
  if (detail) return detail;
  if (signal) return `Antigravity SDK worker stopped by ${signal}`;
  return `Antigravity SDK worker exited with code ${code ?? "unknown"}`;
}

async function runAntigravityTurn(options, deps = {}) {
  const spawn = deps.spawn || defaultSpawn;
  const workerPath = deps.workerPath || resolveAntigravityWorkerPath();
  const pythonPath = String(options.pythonPath || "").trim();
  if (!pythonPath) {
    throw new Error("Antigravity SDK requires Python 3.10+ with google-antigravity installed");
  }

  const resolveStorageDirs = deps.resolveStorageDirs || resolveAntigravityStorageDirs;
  const storageDirs = resolveStorageDirs(options.chatSessionId);
  const child = spawn(pythonPath, [workerPath], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const request = buildAntigravityWorkerRequest({ ...options, ...storageDirs });
  child.stdin.end(`${JSON.stringify(request)}\n`);

  let stderr = "";
  let sessionId = options.resumeSessionId || null;
  let done = false;
  let workerError = null;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      workerError = new Error(`Antigravity SDK worker returned invalid output: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (event.type === "session_id" && event.sessionId) sessionId = event.sessionId;
    if (event.type === "error") {
      workerError = new Error(String(event.message || "Antigravity SDK turn failed"));
      return;
    }
    if (event.type === "done") {
      done = true;
      return;
    }
    translateAntigravityWorkerEvent(event, options.emitter);
  });

  const abort = () => {
    try { child.kill(); } catch {}
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener?.("abort", abort, { once: true });

  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (workerError) return reject(workerError);
        if (options.signal?.aborted) return resolve();
        if (code !== 0 || !done) return reject(new Error(formatWorkerFailure(stderr, code, signal)));
        resolve();
      });
    });
  } finally {
    options.signal?.removeEventListener?.("abort", abort);
    lines.close();
  }

  if (!options.signal?.aborted) options.emitter.emitDone?.();
  return { sessionId };
}

async function listAntigravityModels() {
  return [];
}

module.exports = {
  buildAntigravityWorkerRequest,
  listAntigravityModels,
  resolveAntigravityWorkerPath,
  resolveAntigravityStorageDirs,
  runAntigravityTurn,
  translateAntigravityWorkerEvent,
};
