"use strict";

/**
 * Grok Build CLI turn runner — headless streaming-json path.
 *
 * Spawns the system `grok` binary with `-p` / `--output-format streaming-json`
 * and maps ACP-derived NDJSON events into the canonical Netcatty emitter shapes.
 *
 * Netcatty MCP is injected by merging a project-scoped
 * `.grok/config.toml` `[mcp_servers.<name>]` section (restored after the turn),
 * matching the Cursor CLI workspace MCP merge pattern.
 */
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const fs = require("node:fs");
const path = require("node:path");
const { prepareCommandForSpawn } = require("../../ai/shellUtils.cjs");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

const NETCATTY_MCP_NAME = "netcatty-remote-hosts";
const GROK_ABORT_GRACE_MS = 1_500;
const MAX_GROK_STDERR_CHARS = 64 * 1024;
const MAX_GROK_MODEL_STDOUT_CHARS = 1024 * 1024;
const MAX_GROK_LINE_BYTES = 10 * 1024 * 1024;
const GROK_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const GROK_REASONING_FALLBACKS = Object.freeze({
  "grok-4.5": {
    name: "Grok 4.5",
    thinkingLevels: ["high", "medium", "low"],
    defaultThinkingLevel: "high",
  },
  "grok-4.6": {
    name: "Grok 4.6",
    thinkingLevels: ["xhigh", "high", "medium", "low"],
    defaultThinkingLevel: "high",
  },
});

/**
 * Resolve Grok CLI spawn target for Windows .cmd/.bat shims.
 * Matches other managed agents (agentCliHelpers / Codex login).
 */
function resolveGrokSpawnSpec(cliPath, args) {
  return prepareCommandForSpawn(String(cliPath || "").trim(), Array.isArray(args) ? args : []);
}

/**
 * Spawn grok via prepareCommandForSpawn so Windows npm/installer shims work.
 * @param {Function|undefined} spawnImpl
 * @param {string} cliPath
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptionsWithoutStdio & object} options
 */
function spawnGrokProcess(spawnImpl, cliPath, args, options = {}) {
  const spawnFn = spawnImpl || spawn;
  const spawnSpec = resolveGrokSpawnSpec(cliPath, args);
  return spawnFn(spawnSpec.command, spawnSpec.args, {
    ...options,
    shell: spawnSpec.shell,
  });
}

function signalGrokProcessTree(child, signal, forceKillImpl) {
  if (!child) return;
  if (typeof forceKillImpl === "function") {
    try { forceKillImpl(child, signal); } catch { /* ignore */ }
    return;
  }
  if (process.platform === "win32" && signal === "SIGKILL" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
      killer.unref?.();
      return;
    } catch {
      // Fall through.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through.
    }
  }
  try { child.kill(signal); } catch { /* ignore */ }
}

function escapeTomlBasicString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"");
}

function formatTomlEnvTable(envObject) {
  if (!envObject || typeof envObject !== "object") return "{}";
  const parts = [];
  for (const [key, value] of Object.entries(envObject)) {
    if (typeof key !== "string" || typeof value !== "string") continue;
    parts.push(`${key} = "${escapeTomlBasicString(value)}"`);
  }
  if (parts.length === 0) return "{}";
  return `{ ${parts.join(", ")} }`;
}

function formatTomlStringArray(values) {
  if (!Array.isArray(values) || values.length === 0) return "[]";
  return `[${values.map((v) => `"${escapeTomlBasicString(v)}"`).join(", ")}]`;
}

/**
 * Build a `[mcp_servers.<name>]` TOML block for Grok project config.
 */
function buildGrokMcpServerTomlSection(cfg) {
  if (!cfg || !cfg.name || !cfg.command) return "";
  const name = String(cfg.name).replace(/[^a-zA-Z0-9_-]/g, "_") || NETCATTY_MCP_NAME;
  const env = mcpEnvPairsToObject(cfg.env);
  const lines = [
    `[mcp_servers.${name}]`,
    `command = "${escapeTomlBasicString(cfg.command)}"`,
    `args = ${formatTomlStringArray(cfg.args || [])}`,
    `env = ${formatTomlEnvTable(env)}`,
    "enabled = true",
    "",
  ];
  return lines.join("\n");
}

/**
 * Remove prior `[mcp_servers.<name>]` (and nested tables under that prefix).
 */
function stripGrokMcpServerSection(tomlText, serverName) {
  const name = String(serverName || NETCATTY_MCP_NAME).replace(/[^a-zA-Z0-9_-]/g, "_");
  const lines = String(tomlText || "").split(/\r?\n/);
  const out = [];
  let skipping = false;
  const headerExact = `[mcp_servers.${name}]`;
  const headerNestedPrefix = `[mcp_servers.${name}.`;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (trimmed === headerExact || trimmed.startsWith(headerNestedPrefix)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }

  // Drop trailing blank lines that strip left behind; keep a single trailing newline later.
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

// Per-path refcount so concurrent turns share one original snapshot.
const grokMcpMergeRefcounts = new Map();

function mergeWorkspaceGrokMcpToml(cwd, injectedMcpServers, {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} = {}) {
  const read = readFileSync || fs.readFileSync;
  const write = writeFileSync || fs.writeFileSync;
  const mkdir = mkdirSync || fs.mkdirSync;
  const exists = existsSync || fs.existsSync;
  const unlink = unlinkSync || ((p) => fs.unlinkSync(p));

  const grokDir = path.join(cwd || process.cwd(), ".grok");
  const configPath = path.join(grokDir, "config.toml");

  let state = grokMcpMergeRefcounts.get(configPath);
  if (!state) {
    let previousRaw = null;
    let previousExisted = false;
    if (exists(configPath)) {
      previousExisted = true;
      previousRaw = read(configPath, "utf8");
    }
    state = { refCount: 0, previousRaw, previousExisted };
    grokMcpMergeRefcounts.set(configPath, state);
  }
  state.refCount += 1;

  let baseText = "";
  if (exists(configPath)) {
    try {
      baseText = String(read(configPath, "utf8") || "");
    } catch {
      baseText = state.previousRaw || "";
    }
  } else if (state.previousExisted && state.previousRaw) {
    baseText = state.previousRaw;
  }

  let nextText = baseText;
  const sections = [];
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name || !cfg.command) continue;
    nextText = stripGrokMcpServerSection(nextText, cfg.name);
    const section = buildGrokMcpServerTomlSection(cfg);
    if (section) sections.push(section.trimEnd());
  }

  if (sections.length > 0) {
    const body = nextText.trimEnd();
    nextText = body
      ? `${body}\n\n${sections.join("\n\n")}\n`
      : `${sections.join("\n\n")}\n`;
  }

  try {
    if (!exists(grokDir)) {
      mkdir(grokDir, { recursive: true });
    }
    write(configPath, nextText, "utf8");
  } catch (err) {
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount === 0) grokMcpMergeRefcounts.delete(configPath);
    throw err;
  }

  let restored = false;
  return {
    configPath,
    restore() {
      if (restored) return;
      restored = true;
      const current = grokMcpMergeRefcounts.get(configPath);
      if (!current) return;
      current.refCount = Math.max(0, current.refCount - 1);
      if (current.refCount > 0) return;
      grokMcpMergeRefcounts.delete(configPath);
      try {
        if (current.previousExisted) write(configPath, current.previousRaw, "utf8");
        else if (exists(configPath)) unlink(configPath);
      } catch {
        /* best effort */
      }
    },
  };
}

function resetGrokMcpMergeRefcountsForTests() {
  grokMcpMergeRefcounts.clear();
}

function resolveGrokPermissionFlags(permissionMode) {
  const mode = String(permissionMode || "confirm").toLowerCase();
  if (mode === "observer") {
    // Plan mode keeps the agent from applying side-effecting edits without
    // interactive approval UI (which headless cannot provide).
    return ["--permission-mode", "plan"];
  }
  // confirm / auto / unknown: non-interactive headless must not hang on prompts.
  return ["--always-approve"];
}

/**
 * Local Grok built-ins that must not run side effects on the desktop machine
 * when Tool Access is MCP. Remote session work goes through injected Netcatty
 * MCP (meta-tools remain available under --disallowed-tools per Grok docs).
 * Both historical (`run_terminal_cmd`) and current (`run_terminal_command`)
 * shell IDs are listed so older/newer CLIs stay covered.
 */
const GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS = [
  "run_terminal_command",
  "run_terminal_cmd",
  "search_replace",
  "write",
  "Agent",
];

/**
 * Build --disallowed-tools flags for the active tool-integration mode.
 * - mcp (default): strip local shell/edit/write so Claude-style MCP path is used.
 * - skills: no lockdown here; Netcatty CLI skill needs local shell.
 */
function resolveGrokToolIntegrationFlags(toolIntegrationMode) {
  const mode = String(toolIntegrationMode || "mcp").toLowerCase();
  if (mode === "skills") return [];
  return [
    "--disallowed-tools",
    GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.join(","),
  ];
}

/**
 * The renderer encodes a reasoning selection as `<model>/<effort>`. Grok's
 * CLI requires those values as separate flags, and model ids may themselves
 * contain `/`, so split only a recognized trailing effort token.
 */
function parseGrokModelSelection(model) {
  const value = String(model || "").trim();
  const slash = value.lastIndexOf("/");
  const effort = slash > 0 ? value.slice(slash + 1).toLowerCase() : "";
  if (slash > 0 && GROK_REASONING_EFFORTS.has(effort)) {
    return { model: value.slice(0, slash), effort };
  }
  return { model: value || undefined, effort: undefined };
}

function buildGrokCliArgs({
  prompt,
  model,
  cwd,
  resumeSessionId,
  permissionMode,
  toolIntegrationMode,
}) {
  // Headless automation: skip background update checks (xAI headless docs).
  const args = [
    "--no-auto-update",
    "-p",
    String(prompt || ""),
    "--output-format",
    "streaming-json",
  ];
  const selection = parseGrokModelSelection(model);
  if (selection.model) {
    args.push("-m", selection.model);
  }
  if (selection.effort) {
    args.push("--reasoning-effort", selection.effort);
  }
  if (cwd) {
    args.push("--cwd", String(cwd));
  }
  if (resumeSessionId) {
    args.push("-r", String(resumeSessionId));
  }
  args.push(...resolveGrokPermissionFlags(permissionMode));
  args.push(...resolveGrokToolIntegrationFlags(toolIntegrationMode));
  return args;
}

function resultToText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (typeof result === "object") {
    if (typeof result.content === "string") return result.content;
    if (typeof result.text === "string") return result.text;
    if (typeof result.message === "string") return result.message;
    try { return JSON.stringify(result); } catch { return String(result); }
  }
  return String(result);
}

function closeReasoning(state, emitter) {
  if (state?.reasoningOpen) {
    emitter.reasoningEnd();
    state.reasoningOpen = false;
  }
}

/**
 * Normalize Grok/ACP plan entries to the shared activity shape:
 *   items: [{ text, completed }], status: "running" | "completed"
 * (see domain/agentActivity.ts, emit.planUpdate, Codex App Server turn/plan/updated).
 */
function normalizeGrokPlanUpdate(entries) {
  const items = [];
  for (let index = 0; index < (entries || []).length; index += 1) {
    const entry = entries[index];
    let text = "";
    let statusRaw = "";
    if (typeof entry === "string") {
      text = entry;
    } else if (entry && typeof entry === "object") {
      text = String(entry.content || entry.text || entry.title || entry.step || "");
      statusRaw = String(entry.status || entry.state || "");
    } else if (entry != null) {
      text = String(entry);
    }
    text = text.trim();
    if (!text) continue;
    const status = statusRaw.toLowerCase();
    const completed = status === "completed"
      || status === "complete"
      || status === "done"
      || status === "finished"
      || status === "success"
      || entry?.completed === true;
    items.push({ text, completed: Boolean(completed) });
  }
  if (items.length === 0) return null;
  const status = items.every((item) => item.completed) ? "completed" : "running";
  return { items, status };
}

/**
 * Map one Grok streaming-json event into canonical emitter calls.
 * Returns true when the stream should stop (terminal error).
 */
function translateGrokStreamEvent(event, emitter, state = {}) {
  if (!event || typeof event !== "object") return false;
  const type = String(event.type || "");

  switch (type) {
    case "thought": {
      const data = event.data != null ? String(event.data) : "";
      if (data) {
        emitter.reasoning(data);
        state.reasoningOpen = true;
      }
      return false;
    }

    case "text": {
      closeReasoning(state, emitter);
      const data = event.data != null ? String(event.data) : "";
      if (data) {
        emitter.text(data);
        state.streamedAssistantText = true;
      }
      return false;
    }

    case "tool_call": {
      closeReasoning(state, emitter);
      const id = event.toolCallId || event.tool_call_id || event.id;
      if (!id) return false;
      if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
      if (!state.toolNames) state.toolNames = new Map();
      const name = String(event.toolName || event.tool_name || event.title || "tool");
      const args = event.rawInput && typeof event.rawInput === "object"
        ? event.rawInput
        : (event.input && typeof event.input === "object" ? event.input : {});
      state.toolNames.set(id, name);
      if (!state.emittedToolCalls.has(id)) {
        state.emittedToolCalls.add(id);
        emitter.toolCall(name, args, id);
      }
      return false;
    }

    case "tool_call_update": {
      closeReasoning(state, emitter);
      const id = event.toolCallId || event.tool_call_id || event.id;
      if (!id) return false;
      if (!state.emittedToolResults) state.emittedToolResults = new Set();
      if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
      if (!state.toolNames) state.toolNames = new Map();

      const status = String(event.status || "").toLowerCase();
      const name = state.toolNames.get(id)
        || String(event.toolName || event.tool_name || event.title || "tool");
      const args = event.rawInput && typeof event.rawInput === "object"
        ? event.rawInput
        : {};

      if (!state.emittedToolCalls.has(id)) {
        state.emittedToolCalls.add(id);
        state.toolNames.set(id, name);
        emitter.toolCall(name, args, id);
      }

      // Align with ACP: emit result on terminal status OR when rawOutput is present
      // (some CLI builds omit status on the final tool_call_update).
      if (
        status === "completed"
        || status === "failed"
        || status === "error"
        || status === "cancelled"
        || event.rawOutput != null
      ) {
        if (!state.emittedToolResults.has(id)) {
          state.emittedToolResults.add(id);
          const output = event.rawOutput != null
            ? resultToText(event.rawOutput)
            : resultToText(event.content || event.error || "");
          emitter.toolResult(id, output, name);
        }
      }
      return false;
    }

    case "plan": {
      const plan = normalizeGrokPlanUpdate(Array.isArray(event.entries) ? event.entries : []);
      if (plan && typeof emitter.planUpdate === "function") {
        emitter.planUpdate(event.itemId || "grok-plan", plan.items, plan.status);
      }
      return false;
    }

    case "usage": {
      const usage = event.usage && typeof event.usage === "object" ? event.usage : event;
      emitGrokUsage(emitter, usage);
      return false;
    }

    case "end": {
      closeReasoning(state, emitter);
      state.turnCompleted = true;
      if (event.sessionId || event.session_id) {
        const sessionId = event.sessionId || event.session_id;
        state.sessionId = sessionId;
        emitter.sessionId?.(sessionId);
      }
      const usage = event.usage && typeof event.usage === "object" ? event.usage : null;
      emitGrokUsage(emitter, usage);
      return false;
    }

    case "error": {
      closeReasoning(state, emitter);
      state.failed = true;
      const message = String(event.message || event.error || "Grok Build turn failed");
      emitter.emitError(formatGrokErrorForUser(message));
      return true;
    }

    case "available_commands":
    case "max_turns_reached":
    case "auto_compact_start":
    case "auto_compact_end":
      return false;

    default:
      return false;
  }
}

function isGrokAuthFailureMessage(message) {
  const text = String(message || "");
  if (
    /not authenticated|not logged in|please run .*login|unauthenticated|unauthorized|sign in|auth(?:entication)? (?:failed|required|missing)/i.test(text)
  ) {
    return true;
  }
  if (/\bxai[_\s-]?api[_\s-]?key\b/i.test(text) && /invalid|missing|required|auth/i.test(text)) {
    return true;
  }
  return false;
}

function formatGrokErrorForUser(message) {
  const text = String(message || "").trim();
  if (isGrokAuthFailureMessage(text)) {
    return "Grok Build is not logged in. Run `grok login` or set XAI_API_KEY, then retry.";
  }
  return text || "Grok Build turn failed";
}

/** Normalize dual Grok runtime tokens (ACP vs headless streaming-json). */
function resolveGrokRuntime(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "streaming-json" || raw === "cli" || raw === "headless") return "streaming-json";
  return "acp";
}

/**
 * After establish: only inject historySeed when we asked to resume but landed
 * on session/new (stale/missing Grok session). Successful resume/load must not
 * seed or prior turns duplicate into the current bubble.
 */
function resolveGrokTurnPrompt({
  turnPrompt,
  historySeed,
  resumeSessionId,
  establishMethod,
} = {}) {
  const prompt = String(turnPrompt || "");
  const seed = String(historySeed || "").trim();
  if (!resumeSessionId || !seed) return prompt;
  if (String(establishMethod || "").toLowerCase() !== "new") return prompt;
  return prompt ? `${seed}\n\n${prompt}` : seed;
}

/**
 * Pick usage from a Grok ACP session/prompt result.
 * Live Grok 0.2.x shape (verified):
 *   { stopReason, _meta: { inputTokens, outputTokens, cachedReadTokens,
 *     reasoningTokens, totalTokens, usage: { …same camelCase… } } }
 * There is no top-level result.usage.
 */
function extractGrokAcpPromptUsage(promptResult) {
  if (!promptResult || typeof promptResult !== "object") return null;
  const meta = promptResult._meta && typeof promptResult._meta === "object"
    ? promptResult._meta
    : (promptResult.meta && typeof promptResult.meta === "object" ? promptResult.meta : null);
  if (promptResult.usage && typeof promptResult.usage === "object") return promptResult.usage;
  if (meta?.usage && typeof meta.usage === "object") return meta.usage;
  if (
    meta
    && (
      meta.inputTokens != null
      || meta.outputTokens != null
      || meta.totalTokens != null
      || meta.input_tokens != null
      || meta.output_tokens != null
    )
  ) {
    return meta;
  }
  return null;
}

/**
 * Whether a process close should fail the turn.
 * - turnCompleted: protocol finished (end / session/prompt) → ignore teardown noise
 * - user abort: not a failure
 * - otherwise any close before completion is a failure — including exit 0
 *   (CLI can die without an end/prompt result) and code=null + signal
 *   (Node reports code=null when killed by signal)
 */
function shouldReportGrokProcessExitFailure(state, abortSignal, _code, _exitSignal) {
  if (state?.failed) return false;
  if (abortSignal?.aborted) return false;
  if (state?.turnCompleted) return false;
  return true;
}

/**
 * Forward Grok/ACP usage onto the canonical emitter.
 * Supports Anthropic snake_case and Grok ACP camelCase (cachedReadTokens).
 */
function emitGrokUsage(emitter, usage) {
  if (!usage || typeof usage !== "object" || typeof emitter?.usage !== "function") return false;
  const inputTokens = Number(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
  ) || 0;
  const outputTokens = Number(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens,
  ) || 0;
  const cachedInputTokens = Number(
    usage.cache_read_input_tokens
    ?? usage.cached_input_tokens
    ?? usage.cachedInputTokens
    ?? usage.cachedReadTokens
    ?? usage.cached_read_tokens
  ) || 0;
  const reasoningTokens = Number(
    usage.reasoning_tokens
    ?? usage.reasoningTokens
    ?? usage.reasoning_output_tokens
    ?? usage.reasoningOutputTokens
  ) || 0;
  let totalTokens = Number(usage.total_tokens ?? usage.totalTokens) || 0;
  if (!totalTokens && (inputTokens || outputTokens)) {
    totalTokens = inputTokens + outputTokens;
  }
  if (!inputTokens && !outputTokens && !totalTokens && !cachedInputTokens && !reasoningTokens) {
    return false;
  }
  emitter.usage({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  });
  return true;
}

function createLineBuffer(onLine, maxBufferBytes = MAX_GROK_LINE_BYTES) {
  let buffer = "";
  let bufferedBytes = 0;
  let overflowed = false;
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      if (overflowed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
      bufferedBytes += bytes.length;
      buffer += decoder.write(bytes);
      let idx;
      let consumedLine = false;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        consumedLine = true;
        if (line) onLine(line);
      }
      if (consumedLine) bufferedBytes = Buffer.byteLength(buffer, "utf8") + decoder.lastNeed;
      if (bufferedBytes > maxBufferBytes) {
        overflowed = true;
        buffer = "";
        const error = new Error(`Grok Build message exceeded ${maxBufferBytes} bytes`);
        error.code = "GROK_LINE_LIMIT";
        throw error;
      }
    },
    flush() {
      if (overflowed) return;
      buffer += decoder.end();
      const line = buffer.trim();
      buffer = "";
      if (line) onLine(line);
    },
  };
}

async function runGrokTurn({
  prompt,
  binPath,
  cwd,
  model,
  env,
  permissionMode,
  toolIntegrationMode,
  resumeSessionId,
  injectedMcpServers,
  emitter,
  signal,
  spawnImpl,
  mergeMcp,
  abortGraceMs = GROK_ABORT_GRACE_MS,
  forceKillImpl,
}) {
  const cliPath = String(binPath || "").trim();
  if (!cliPath) {
    emitter.emitError(
      "Grok Build CLI not found. Install the Grok CLI (`grok`) and ensure it is on PATH, or set the path in Settings → AI.",
    );
    return { sessionId: resumeSessionId || null, runtime: "streaming-json" };
  }

  const effectiveCwd = String(cwd || process.cwd() || "").trim() || process.cwd();
  const childEnv = { ...(env || process.env) };
  const args = buildGrokCliArgs({
    prompt,
    model,
    cwd: effectiveCwd,
    resumeSessionId,
    permissionMode,
    toolIntegrationMode,
  });

  const doMerge = mergeMcp || mergeWorkspaceGrokMcpToml;
  let mcpHandle = null;
  if (Array.isArray(injectedMcpServers) && injectedMcpServers.length > 0) {
    try {
      mcpHandle = doMerge(effectiveCwd, injectedMcpServers);
    } catch (err) {
      emitter.emitError(
        "Failed to prepare Netcatty MCP for Grok Build "
        + `(cannot write project .grok/config.toml: ${err?.message || err}). `
        + "Terminal tools will be unavailable.",
      );
      return { sessionId: resumeSessionId || null, runtime: "streaming-json" };
    }
  }

  const state = {
    sessionId: resumeSessionId || null,
    reasoningOpen: false,
    streamedAssistantText: false,
    failed: false,
    // True after a terminal stream event (end/result). Avoid treating forced
    // process teardown exit codes as failures on tool-only turns.
    turnCompleted: false,
  };

  let child = null;
  let settled = false;

  const cleanup = () => {
    try { mcpHandle?.restore?.(); } catch { /* ignore */ }
  };

  try {
    child = spawnGrokProcess(spawnImpl, cliPath, args, {
      cwd: effectiveCwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (err) {
    cleanup();
    emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
    return { sessionId: state.sessionId, runtime: "streaming-json" };
  }

  const handleLine = (line) => {
    if (signal?.aborted) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const stop = translateGrokStreamEvent(event, emitter, state);
    if (stop && !signal?.aborted) state.failed = true;
  };

  const stdoutBuffer = createLineBuffer(handleLine);
  let stderrText = "";
  let stderrBytes = 0;
  let stderrTruncated = false;
  let stderrEnded = false;
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout?.on("data", (chunk) => {
    if (signal?.aborted) return;
    try {
      stdoutBuffer.push(chunk);
    } catch (error) {
      if (!state.failed) {
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(error?.message || String(error)));
      }
      signalGrokProcessTree(child, "SIGKILL", forceKillImpl);
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (signal?.aborted) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = Math.max(0, MAX_GROK_STDERR_CHARS - stderrBytes);
    const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
    if (accepted.length > 0) stderrText += stderrDecoder.write(accepted);
    stderrBytes += accepted.length;
    if (accepted.length < buffer.length) stderrTruncated = true;
  });

  let abortHandler = null;
  let forceKillTimer = null;
  await new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      if (!signal?.aborted) stdoutBuffer.flush();
      resolve();
    };
    child.on("error", (err) => {
      if (!state.failed && !signal?.aborted) {
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
      }
      finish();
    });
    child.on("close", (code, exitSignal) => {
      if (!stderrEnded) {
        stderrEnded = true;
        if (!stderrTruncated || stderrDecoder.lastNeed === 0) stderrText += stderrDecoder.end();
      }
      // Only ignore exit after protocol completion (end event).
      // Incomplete turns fail even on exit 0; signal kills report code=null.
      if (shouldReportGrokProcessExitFailure(state, signal, code, exitSignal)) {
        const stderr = stderrText.trim();
        const detail = code != null && code !== 0
          ? `exited with code ${code}`
          : (exitSignal ? `terminated by signal ${exitSignal}` : "exited before the turn completed");
        const message = stderr || `Grok Build ${detail}`;
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(message));
      }
      finish();
    });

    let terminationStarted = false;
    abortHandler = () => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        signalGrokProcessTree(child, "SIGKILL", forceKillImpl);
        finish();
      }, Math.max(0, abortGraceMs));
      forceKillTimer.unref?.();
      signalGrokProcessTree(child, "SIGTERM");
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  if (signal) signal.removeEventListener("abort", abortHandler);
  cleanup();
  closeReasoning(state, emitter);

  // Hard gate: never treat an incomplete protocol turn as success (exit 0 without
  // end/result used to fall through to emitDone).
  if (signal?.aborted) {
    // User cancel: no terminal success/error event.
  } else if (state.failed) {
    // Already reported.
  } else if (state.turnCompleted) {
    emitter.emitDone();
  } else {
    state.failed = true;
    emitter.emitError(formatGrokErrorForUser("Grok Build ended before the turn completed"));
  }

  return { sessionId: state.sessionId, runtime: "streaming-json" };
}

/**
 * Parse `grok models` plain-text output into { currentModelId, models }.
 */
function parseGrokModelsOutput(stdout) {
  const models = [];
  const seen = new Set();
  let currentModelId = null;
  let defaultFromHeader = null;

  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const defaultMatch = trimmed.match(/^Default model:\s*(\S+)/i);
    if (defaultMatch) {
      defaultFromHeader = defaultMatch[1];
      continue;
    }

    // "* grok-4.5 (default)" or "  * model-id"
    const bullet = trimmed.match(/^\*+\s*([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*(.*)$/);
    if (!bullet) continue;
    const id = bullet[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const rest = bullet[2] || "";
    const isDefault = /\(\s*default\s*\)/i.test(rest);
    if (isDefault) currentModelId = id;
    const name = rest
      .replace(/\s*\(\s*default\s*\)\s*/ig, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || id;
    models.push({ id, name });
  }

  if (!currentModelId && defaultFromHeader) {
    currentModelId = defaultFromHeader;
    if (!seen.has(defaultFromHeader)) {
      models.unshift({ id: defaultFromHeader, name: defaultFromHeader });
    }
  }

  return { currentModelId, models: models.map(applyGrokReasoningFallback) };
}

function applyGrokReasoningFallback(model) {
  const id = String(model?.id || "").trim();
  const fallback = GROK_REASONING_FALLBACKS[id];
  if (!fallback || (Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length > 0)) {
    return model;
  }
  return {
    ...model,
    name: String(model?.name || fallback.name),
    thinkingLevels: [...fallback.thinkingLevels],
    defaultThinkingLevel: fallback.defaultThinkingLevel,
  };
}

function resolveGrokCatalogCurrentModelId(models, currentModelId) {
  const advertised = String(currentModelId || "").trim();
  if (!advertised) return null;
  const selection = parseGrokModelSelection(advertised);
  const preset = (Array.isArray(models) ? models : [])
    .find((entry) => entry?.id === selection.model);
  if (!preset?.thinkingLevels?.length) return advertised;
  const effort = preset.thinkingLevels.includes(selection.effort)
    ? selection.effort
    : (preset.defaultThinkingLevel || preset.thinkingLevels[0]);
  return effort ? `${preset.id}/${effort}` : preset.id;
}

async function listGrokModels({
  binPath,
  env,
  spawnImpl,
  abortController,
  signal,
  abortGraceMs = GROK_ABORT_GRACE_MS,
  forceKillImpl,
} = {}) {
  const cliPath = String(binPath || "").trim();
  if (!cliPath) return { currentModelId: null, models: [] };
  const abortSignal = signal || abortController?.signal;
  if (abortSignal?.aborted) return { currentModelId: null, models: [] };

  const childEnv = { ...(env || process.env) };

  return await new Promise((resolve) => {
    let stdout = "";
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stdoutEnded = false;
    const stdoutDecoder = new StringDecoder("utf8");
    let settled = false;
    let abortHandler = null;
    let forceKillTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
      resolve(value);
    };

    let child;
    try {
      child = spawnGrokProcess(spawnImpl, cliPath, ["--no-auto-update", "models"], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      finish({ currentModelId: null, models: [] });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      if (abortSignal?.aborted) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, MAX_GROK_MODEL_STDOUT_CHARS - stdoutBytes);
      const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
      if (accepted.length > 0) stdout += stdoutDecoder.write(accepted);
      stdoutBytes += accepted.length;
      if (accepted.length < buffer.length) stdoutTruncated = true;
    });
    child.on("error", () => finish({ currentModelId: null, models: [] }));
    child.on("close", () => {
      if (!stdoutEnded) {
        stdoutEnded = true;
        if (!stdoutTruncated || stdoutDecoder.lastNeed === 0) stdout += stdoutDecoder.end();
      }
      finish(parseGrokModelsOutput(stdout));
    });

    abortHandler = () => {
      if (settled) return;
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        signalGrokProcessTree(child, "SIGKILL", forceKillImpl);
        finish({ currentModelId: null, models: [] });
      }, Math.max(0, abortGraceMs));
      forceKillTimer.unref?.();
      signalGrokProcessTree(child, "SIGTERM", forceKillImpl);
    };
    if (abortSignal) {
      if (abortSignal.aborted) abortHandler();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

module.exports = {
  NETCATTY_MCP_NAME,
  MAX_GROK_LINE_BYTES,
  GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS,
  applyGrokReasoningFallback,
  buildGrokCliArgs,
  buildGrokMcpServerTomlSection,
  createLineBuffer,
  formatGrokErrorForUser,
  isGrokAuthFailureMessage,
  listGrokModels,
  mergeWorkspaceGrokMcpToml,
  parseGrokModelsOutput,
  resetGrokMcpMergeRefcountsForTests,
  resolveGrokPermissionFlags,
  resolveGrokCatalogCurrentModelId,
  resolveGrokRuntime,
  resolveGrokSpawnSpec,
  resolveGrokToolIntegrationFlags,
  resolveGrokTurnPrompt,
  extractGrokAcpPromptUsage,
  emitGrokUsage,
  normalizeGrokPlanUpdate,
  parseGrokModelSelection,
  shouldReportGrokProcessExitFailure,
  runGrokTurn,
  spawnGrokProcess,
  stripGrokMcpServerSection,
  translateGrokStreamEvent,
};
