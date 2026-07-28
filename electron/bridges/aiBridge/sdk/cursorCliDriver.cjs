"use strict";

/**
 * Cursor Agent CLI turn runner — subscription / login session path.
 *
 * Spawns `cursor-agent` in print/stream-json mode so Catty can use the local
 * CLI login quota without CURSOR_API_KEY.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

const DEFAULT_CURSOR_CLI_MODEL = "auto";
const NETCATTY_MCP_NAME = "netcatty-remote-hosts";

function stripCursorApiKeyFromEnv(env) {
  const out = { ...(env || {}) };
  delete out.CURSOR_API_KEY;
  return out;
}

function resolveCursorCliModel(model) {
  const raw = String(model || "").trim();
  return raw || DEFAULT_CURSOR_CLI_MODEL;
}

/** Map Netcatty permission mode → Cursor CLI execution class. */
function resolveCursorCliExecMode(permissionMode) {
  return String(permissionMode || "confirm").toLowerCase() === "observer" ? "ask" : "agent";
}

function buildCursorCliArgs({
  model,
  resumeSessionId,
  permissionMode,
  cwd,
  prompt,
}) {
  const args = [
    "--print",
    "--trust",
    "--approve-mcps",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    resolveCursorCliModel(model),
  ];

  if (cwd) {
    args.push("--workspace", cwd);
  }

  if (resumeSessionId) {
    args.push("--resume", String(resumeSessionId));
  }

  if (resolveCursorCliExecMode(permissionMode) === "ask") {
    // Read-only ask mode; no shell write approvals expected.
    args.push("--mode", "ask");
  } else {
    // confirm/auto (and any other agent mode): stdin is ignored for the child, so
    // interactive y/n command approval cannot work. Cursor docs require --force
    // (--yolo) to auto-allow shell/tools in non-interactive runs.
    args.push("--force");
  }

  args.push(String(prompt || ""));
  return args;
}

function mcpConfigToCursorMcpJsonEntry(cfg) {
  if (!cfg || !cfg.name || !cfg.command) return null;
  const entry = {
    type: "stdio",
    command: cfg.command,
    args: Array.isArray(cfg.args) ? cfg.args : [],
  };
  const env = mcpEnvPairsToObject(cfg.env);
  if (env && Object.keys(env).length > 0) entry.env = env;
  return { name: cfg.name, entry };
}

/**
 * Cursor CLI discovers MCP via `{cwd}/.cursor/mcp.json`. Packaged Netcatty
 * launched from Finder/Dock often has `process.cwd() === "/"`, which cannot
 * host that file. Always prefer a writable Netcatty temp workspace.
 */
function resolveCursorCliWorkspaceCwd({
  preferredCwd,
  chatSessionId,
  getTempDir,
  mkdirSync,
} = {}) {
  const mkdir = mkdirSync || fs.mkdirSync;
  const resolveTempRoot = typeof getTempDir === "function"
    ? getTempDir
    : () => {
      try {
        return require("../../tempDirBridge.cjs").getTempDir();
      } catch {
        return null;
      }
    };

  const tempRoot = String(resolveTempRoot?.() || "").trim();
  if (tempRoot) {
    const safeId = String(chatSessionId || "default")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 80) || "default";
    const dir = path.join(tempRoot, "cursor-cli-mcp", safeId);
    mkdir(dir, { recursive: true });
    return dir;
  }

  const fallback = String(preferredCwd || process.cwd() || "").trim() || process.cwd();
  try {
    mkdir(path.join(fallback, ".cursor"), { recursive: true });
  } catch {
    /* caller / merge may still fail loudly */
  }
  return fallback;
}

// Per-path refcount so concurrent CLI turns share one original snapshot and only
// the last restorer writes the pre-merge file back (avoids last-writer-wins races).
const mcpMergeRefcounts = new Map();

function mergeWorkspaceMcpJson(cwd, injectedMcpServers, { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } = {}) {
  const read = readFileSync || fs.readFileSync;
  const write = writeFileSync || fs.writeFileSync;
  const mkdir = mkdirSync || fs.mkdirSync;
  const exists = existsSync || fs.existsSync;
  const unlink = unlinkSync || ((p) => fs.unlinkSync(p));

  const cursorDir = path.join(cwd || process.cwd(), ".cursor");
  const mcpPath = path.join(cursorDir, "mcp.json");

  let state = mcpMergeRefcounts.get(mcpPath);
  if (!state) {
    let previousRaw = null;
    let previousExisted = false;
    if (exists(mcpPath)) {
      previousExisted = true;
      previousRaw = read(mcpPath, "utf8");
    }
    state = { refCount: 0, previousRaw, previousExisted };
    mcpMergeRefcounts.set(mcpPath, state);
  }
  state.refCount += 1;

  let doc = { mcpServers: {} };
  if (exists(mcpPath)) {
    try {
      const parsed = JSON.parse(read(mcpPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        doc = parsed;
        if (!doc.mcpServers || typeof doc.mcpServers !== "object") doc.mcpServers = {};
      }
    } catch {
      doc = { mcpServers: {} };
    }
  } else if (state.previousExisted && state.previousRaw) {
    try {
      const parsed = JSON.parse(state.previousRaw);
      if (parsed && typeof parsed === "object") {
        doc = parsed;
        if (!doc.mcpServers || typeof doc.mcpServers !== "object") doc.mcpServers = {};
      }
    } catch {
      doc = { mcpServers: {} };
    }
  }

  for (const cfg of injectedMcpServers || []) {
    const mapped = mcpConfigToCursorMcpJsonEntry(cfg);
    if (!mapped) continue;
    doc.mcpServers[mapped.name] = mapped.entry;
  }

  try {
    if (!exists(cursorDir)) {
      mkdir(cursorDir, { recursive: true });
    }
    write(mcpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  } catch (err) {
    // Roll back refcount so a failed write does not pin the lock forever.
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount === 0) mcpMergeRefcounts.delete(mcpPath);
    throw err;
  }

  let restored = false;
  return {
    mcpPath,
    restore() {
      if (restored) return;
      restored = true;
      const current = mcpMergeRefcounts.get(mcpPath);
      if (!current) return;
      current.refCount = Math.max(0, current.refCount - 1);
      if (current.refCount > 0) return;
      mcpMergeRefcounts.delete(mcpPath);
      try {
        if (current.previousExisted) write(mcpPath, current.previousRaw, "utf8");
        else if (exists(mcpPath)) unlink(mcpPath);
      } catch {
        /* best effort */
      }
    },
  };
}

/** Test helper: clear MCP merge refcount state between unit tests. */
function resetMcpMergeRefcountsForTests() {
  mcpMergeRefcounts.clear();
}

function resultToText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (typeof result === "object") {
    if (typeof result.content === "string") return result.content;
    if (result.success && typeof result.success.content === "string") return result.success.content;
    try { return JSON.stringify(result); } catch { return String(result); }
  }
  return String(result);
}

function extractCliToolCall(event) {
  const callId = event?.call_id || event?.toolCallId || null;
  const toolCall = event?.tool_call || event?.toolCall || null;
  if (!toolCall || typeof toolCall !== "object") {
    return { id: callId, name: event?.name || "tool", args: event?.args || {}, result: event?.result };
  }

  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith("ToolCall") || !value || typeof value !== "object") continue;
    const name = key.replace(/ToolCall$/, "");
    const args = value.args && typeof value.args === "object" ? value.args : {};
    const result = value.result != null ? value.result : undefined;
    return { id: callId || value.toolCallId || null, name, args, result };
  }

  return {
    id: callId,
    name: event?.name || "tool",
    args: toolCall.args || {},
    result: toolCall.result,
  };
}

function closeReasoning(state, emitter) {
  if (state?.reasoningOpen) {
    emitter.reasoningEnd();
    state.reasoningOpen = false;
  }
}

function translateCursorCliEvent(event, emitter, state = {}) {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "system":
      if (event.session_id) {
        state.sessionId = event.session_id;
        emitter.sessionId?.(event.session_id);
      }
      return false;

    case "thinking":
      if (event.subtype === "completed") {
        closeReasoning(state, emitter);
        return false;
      }
      if (event.text) {
        emitter.reasoning(String(event.text));
        state.reasoningOpen = true;
      }
      return false;

    case "assistant": {
      closeReasoning(state, emitter);
      // With --stream-partial-output, Cursor emits three assistant shapes:
      //   timestamp_ms only          → streaming delta (use)
      //   timestamp_ms + model_call_id → buffered flush before tool (skip)
      //   neither                    → final flush (skip if already streamed)
      // See https://cursor.com/docs/cli/reference/output-format.md#stream-json-format
      if (event.model_call_id) return false;
      const isPartial = Boolean(event.timestamp_ms);
      const content = event.message?.content;
      if (!Array.isArray(content)) return false;
      let text = "";
      for (const block of content) {
        if (block?.type === "text" && block.text) text += String(block.text);
      }
      if (!text) return false;
      if (!isPartial) {
        if (state.streamedAssistantText) return false;
        emitter.text(text);
        state.streamedAssistantText = true;
        return false;
      }
      emitter.text(text);
      state.streamedAssistantText = true;
      return false;
    }

    case "tool_call": {
      closeReasoning(state, emitter);
      const { id, name, args, result } = extractCliToolCall(event);
      if (!id) return false;
      if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
      if (!state.emittedToolResults) state.emittedToolResults = new Set();

      const subtype = String(event.subtype || "");
      if (subtype === "started" || subtype === "running" || !subtype) {
        if (!state.emittedToolCalls.has(id)) {
          state.emittedToolCalls.add(id);
          emitter.toolCall(name || "tool", args && typeof args === "object" ? args : {}, id);
        }
      }
      if (subtype === "completed" || subtype === "error") {
        if (!state.emittedToolCalls.has(id)) {
          state.emittedToolCalls.add(id);
          emitter.toolCall(name || "tool", args && typeof args === "object" ? args : {}, id);
        }
        if (!state.emittedToolResults.has(id)) {
          state.emittedToolResults.add(id);
          emitter.toolResult(id, resultToText(result || event.error || ""), name || "tool");
        }
      }
      return false;
    }

    case "result":
      closeReasoning(state, emitter);
      if (event.session_id) {
        state.sessionId = event.session_id;
        emitter.sessionId?.(event.session_id);
      }
      if (event.is_error || event.subtype === "error") {
        state.failed = true;
        const message = String(event.result || event.error || event.message || "Cursor CLI turn failed");
        emitter.emitError(formatCursorCliErrorForUser(message));
        return true;
      }
      return false;

    case "error":
      closeReasoning(state, emitter);
      state.failed = true;
      emitter.emitError(formatCursorCliErrorForUser(event.message || event.error || "Cursor CLI turn failed"));
      return true;

    default:
      return false;
  }
}

function formatCursorCliErrorForUser(message) {
  const text = String(message || "").trim();
  if (
    /not authenticated|not logged in|please run .*login|unauthenticated|unauthorized/i.test(text)
    || /(?:^|\b)(?:agent|cursor-agent)\s+login\b/i.test(text)
  ) {
    return "Cursor CLI is not logged in. Run `cursor-agent login` in a terminal, then retry.";
  }
  if (/\bapi[_\s-]?key\b/i.test(text) && /invalid|missing|required|auth/i.test(text)) {
    return "Cursor CLI authentication failed. Run `cursor-agent login` or switch Cursor to API Key mode in Settings → AI.";
  }
  return text || "Cursor CLI turn failed";
}

function createLineBuffer(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk || "");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
    },
    flush() {
      const line = buffer.trim();
      buffer = "";
      if (line) onLine(line);
    },
  };
}

async function runCursorCliTurn({
  prompt,
  binPath,
  cwd,
  chatSessionId,
  getTempDir,
  model,
  env,
  permissionMode,
  resumeSessionId,
  injectedMcpServers,
  emitter,
  signal,
  spawnImpl,
  mergeMcp,
  workspaceCwd,
}) {
  const cliPath = String(binPath || "").trim();
  if (!cliPath) {
    emitter.emitError("Cursor Agent CLI not found. Install the Cursor CLI (`cursor-agent`) and ensure it is on PATH.");
    return { sessionId: resumeSessionId || null };
  }

  let effectiveCwd;
  try {
    effectiveCwd = workspaceCwd || resolveCursorCliWorkspaceCwd({
      preferredCwd: cwd,
      chatSessionId,
      getTempDir,
    });
  } catch (err) {
    emitter.emitError(
      "Failed to prepare Netcatty MCP for Cursor CLI "
      + `(cannot create workspace: ${err?.message || err}). `
      + "Terminal tools will be unavailable.",
    );
    return { sessionId: resumeSessionId || null };
  }

  const childEnv = stripCursorApiKeyFromEnv(env || process.env);
  const args = buildCursorCliArgs({
    model,
    resumeSessionId,
    permissionMode,
    cwd: effectiveCwd,
    prompt,
  });

  const doMerge = mergeMcp || mergeWorkspaceMcpJson;
  let mcpHandle = null;
  if (Array.isArray(injectedMcpServers) && injectedMcpServers.length > 0) {
    try {
      mcpHandle = doMerge(effectiveCwd, injectedMcpServers);
    } catch (err) {
      emitter.emitError(
        "Failed to prepare Netcatty MCP for Cursor CLI "
        + `(cannot write workspace MCP config: ${err?.message || err}). `
        + "Terminal tools will be unavailable.",
      );
      return { sessionId: resumeSessionId || null };
    }
  }

  const state = {
    sessionId: resumeSessionId || null,
    reasoningOpen: false,
    streamedAssistantText: false,
    failed: false,
  };

  const spawnFn = spawnImpl || spawn;
  let child = null;
  let settled = false;

  const cleanup = () => {
    try { mcpHandle?.restore?.(); } catch { /* ignore */ }
  };

  try {
    child = spawnFn(cliPath, args, {
      cwd: effectiveCwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    cleanup();
    emitter.emitError(formatCursorCliErrorForUser(err?.message || String(err)));
    return { sessionId: state.sessionId };
  }

  const handleLine = (line) => {
    // Soft-cancel: ignore late stream-json after Stop (result/error would emitError).
    if (signal?.aborted) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const stop = translateCursorCliEvent(event, emitter, state);
    if (stop && !signal?.aborted) state.failed = true;
  };

  const stdoutBuffer = createLineBuffer(handleLine);
  const stderrChunks = [];

  child.stdout?.on("data", (chunk) => {
    if (signal?.aborted) return;
    stdoutBuffer.push(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const abortHandler = () => {
    if (!child || child.killed) return;
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  }

  await new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      // Only flush remaining lines if not aborted — late error/result after
      // Stop must not surface as a failed turn.
      if (!signal?.aborted) stdoutBuffer.flush();
      resolve();
    };
    child.on("error", (err) => {
      // Soft-cancel: do not surface spawn errors after user Stop.
      if (!state.failed && !signal?.aborted) {
        state.failed = true;
        emitter.emitError(formatCursorCliErrorForUser(err?.message || String(err)));
      }
      finish();
    });
    child.on("close", (code) => {
      // Soft-cancel: SIGTERM/kill after abort is not a turn failure.
      if (!state.failed && !signal?.aborted && code && code !== 0 && !state.streamedAssistantText) {
        const stderr = stderrChunks.join("").trim();
        const message = stderr || `Cursor CLI exited with code ${code}`;
        state.failed = true;
        emitter.emitError(formatCursorCliErrorForUser(message));
      }
      finish();
    });
  });

  if (signal) signal.removeEventListener("abort", abortHandler);
  cleanup();
  closeReasoning(state, emitter);

  // Match cursorDriver: aborted turns must not report as successful done.
  if (!state.failed && !signal?.aborted) {
    emitter.emitDone();
  }

  return { sessionId: state.sessionId };
}

async function listCursorCliModels({ binPath, env, spawnImpl } = {}) {
  const cliPath = String(binPath || "").trim();
  if (!cliPath) return { currentModelId: null, models: [] };

  const childEnv = stripCursorApiKeyFromEnv(env || process.env);
  const spawnFn = spawnImpl || spawn;

  return await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawnFn(cliPath, ["models"], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish({ currentModelId: null, models: [] });
      return;
    }

    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => finish({ currentModelId: null, models: [] }));
    child.on("close", () => {
      const models = [];
      const seen = new Set();
      let currentModelId = null;
      for (const line of String(stdout).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || /^available models$/i.test(trimmed)) continue;
        const match = trimmed.match(/^([a-z0-9][a-z0-9._-]*)\s+-\s+(.+)$/i);
        if (!match) continue;
        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const rawName = match[2].trim();
        const isCurrent = /\(\s*current(?:\s*,\s*default)?\s*\)/i.test(rawName);
        if (isCurrent) currentModelId = id;
        const name = rawName
          .replace(/\s*\(\s*current(?:\s*,\s*default)?\s*\)\s*/ig, " ")
          .replace(/\s{2,}/g, " ")
          .trim() || id;
        models.push({ id, name });
      }
      if (!currentModelId && models.some((model) => model.id === "auto")) {
        currentModelId = "auto";
      }
      finish({ currentModelId, models });
    });
  });
}

module.exports = {
  DEFAULT_CURSOR_CLI_MODEL,
  NETCATTY_MCP_NAME,
  buildCursorCliArgs,
  formatCursorCliErrorForUser,
  listCursorCliModels,
  mergeWorkspaceMcpJson,
  resetMcpMergeRefcountsForTests,
  resolveCursorCliExecMode,
  resolveCursorCliModel,
  resolveCursorCliWorkspaceCwd,
  runCursorCliTurn,
  stripCursorApiKeyFromEnv,
  translateCursorCliEvent,
};
