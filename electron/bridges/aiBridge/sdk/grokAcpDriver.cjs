"use strict";

/**
 * Grok Build ACP turn runner — `grok agent … stdio` JSON-RPC client.
 *
 * Lifecycle (Agent Client Protocol / xAI docs):
 *   initialize → authenticate (when authMethods exist)
 *   → session/resume | session/load | session/new
 *   → session/prompt
 *   session/update notifications → canonical Netcatty emitter events
 *
 * Prefer session/resume (no history replay) over session/load when the agent
 * advertises it; keep acceptUpdates=false until session/prompt so load replay
 * never pollutes the current assistant bubble.
 *
 * Prefer session-level mcpServers over project `.grok/config.toml` merge.
 * Keep the headless streaming-json driver as an explicit fallback runtime.
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const {
  GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS,
  createLineBuffer,
  formatGrokErrorForUser,
  resolveGrokToolIntegrationFlags,
  resolveGrokTurnPrompt,
  extractGrokAcpPromptUsage,
  emitGrokUsage,
  normalizeGrokPlanUpdate,
  applyGrokReasoningFallback,
  resolveGrokCatalogCurrentModelId,
  parseGrokModelSelection,
  shouldReportGrokProcessExitFailure,
  spawnGrokProcess,
} = require("./grokDriver.cjs");

const GROK_ACP_ABORT_GRACE_MS = 1_500;
const MAX_GROK_ACP_LINE_BYTES = 10 * 1024 * 1024;
const MAX_GROK_ACP_STDERR_CHARS = 64 * 1024;
const ACP_PROTOCOL_VERSION = 1;
// The outer SDK model-list request has a 10s deadline. Leave enough time for
// the legacy `grok models` fallback when ACP initialize hangs.
const GROK_ACP_MODEL_LIST_TIMEOUT_MS = 4_000;
const GROK_FALLBACK_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const GROK_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function signalProcessTree(child, signal, forceKillImpl) {
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
      // fall through
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through
    }
  }
  try { child.kill(signal); } catch { /* ignore */ }
}

/**
 * Resolve absolute cwd for ACP session lifecycle (protocol requires absolute path).
 */
function resolveGrokAcpCwd(cwd) {
  const raw = String(cwd || process.cwd() || ".").trim() || ".";
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

/**
 * Build argv for `grok [global flags] agent [agent flags] stdio`.
 *
 * Live CLI (grok 0.2.x): `--disallowed-tools` and `--no-auto-update` are
 * top-level options. Placing them after `agent` fails with:
 *   unexpected argument '--disallowed-tools' found
 * Agent-local flags (`--always-approve`, `-m`) stay after `agent`.
 */
function buildGrokAcpSpawnArgs({
  model,
  permissionMode,
  toolIntegrationMode,
} = {}) {
  // Global top-level flags MUST precede the `agent` subcommand.
  const args = ["--no-auto-update"];
  // MCP lockdown is a top-level flag (same as headless `grok -p ...`).
  args.push(...resolveGrokToolIntegrationFlags(toolIntegrationMode));
  args.push("agent");
  const mode = String(permissionMode || "confirm").toLowerCase();
  // Non-interactive Netcatty turns cannot answer ACP permission prompts.
  if (mode !== "observer") {
    args.push("--always-approve");
  }
  const selection = parseGrokModelSelection(model);
  if (selection.model) {
    args.push("-m", selection.model);
  }
  if (selection.effort) {
    args.push("--reasoning-effort", selection.effort);
  }
  args.push("stdio");
  return args;
}

/**
 * Normalize injectMcp env ([{name,value}] or plain object) into Grok ACP's
 * required pair-array shape. A plain {KEY:VALUE} object is rejected by
 * `session/new` (`Invalid params` / McpServer enum).
 */
function toAcpMcpEnvPairs(env) {
  if (Array.isArray(env)) {
    return env
      .filter((pair) => pair && typeof pair.name === "string" && typeof pair.value === "string")
      .map((pair) => ({ name: pair.name, value: pair.value }));
  }
  if (env && typeof env === "object") {
    const out = [];
    for (const [name, value] of Object.entries(env)) {
      if (typeof name === "string" && typeof value === "string") {
        out.push({ name, value });
      }
    }
    return out;
  }
  return [];
}

/**
 * Convert Netcatty injectMcp configs into ACP session/new mcpServers entries.
 * Grok agent stdio expects stdio servers with env as [{name,value}, ...].
 */
function toAcpMcpServers(injectedMcpServers) {
  const out = [];
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name || !cfg.command) continue;
    const entry = {
      name: String(cfg.name),
      // Optional for Grok, but documents stdio transport for the McpServer enum.
      type: "stdio",
      command: String(cfg.command),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: toAcpMcpEnvPairs(cfg.env),
    };
    out.push(entry);
  }
  return out;
}

/**
 * Build session/new params including MCP servers and permission meta.
 */
function buildGrokAcpSessionNewParams({
  cwd,
  injectedMcpServers,
  permissionMode,
  toolIntegrationMode,
  systemContext,
} = {}) {
  const mode = String(permissionMode || "confirm").toLowerCase();
  const toolMode = String(toolIntegrationMode || "mcp").toLowerCase();
  const params = {
    cwd: resolveGrokAcpCwd(cwd),
    mcpServers: toAcpMcpServers(injectedMcpServers),
    _meta: {},
  };
  if (mode !== "observer") {
    params._meta.yoloMode = true;
  } else {
    // Soft read-oriented path when no interactive approval UI is available.
    params._meta.autoMode = true;
  }
  if (toolMode !== "skills") {
    params._meta.rules = [
      "Netcatty MCP mode is active. Do not use local shell, search_replace, or write tools for side effects.",
      "Operate on remote terminal sessions only through the injected netcatty-remote-hosts MCP server.",
      `Disallowed local built-ins (policy): ${GROK_MCP_MODE_DISALLOWED_LOCAL_TOOLS.join(", ")}.`,
    ].join(" ");
  }
  if (systemContext && String(systemContext).trim()) {
    // Prefer additive rules so Grok keeps its agent profile; overflow goes to rules.
    const existing = params._meta.rules ? `${params._meta.rules} ` : "";
    params._meta.rules = `${existing}${String(systemContext).trim()}`.slice(0, 16_000);
  }
  return params;
}

function buildGrokAcpInitializeParams() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: {
      name: "netcatty",
      version: "0.0.0",
    },
  };
}

/**
 * Convert Grok's ACP initialize modelState into Netcatty's shared model picker
 * shape. Reasoning levels are model-specific and come from the live catalog;
 * non-reasoning models intentionally remain plain model rows.
 */
function parseGrokAcpModelCatalog(initResult) {
  const modelState = initResult?._meta?.modelState
    || initResult?.modelState
    || initResult?.agentCapabilities?._meta?.modelState;
  if (!modelState || typeof modelState !== "object") {
    return { currentModelId: null, models: [] };
  }

  const models = [];
  for (const entry of Array.isArray(modelState.availableModels) ? modelState.availableModels : []) {
    const id = String(entry?.modelId || entry?.id || "").trim();
    if (!id) continue;
    const preset = {
      id,
      name: String(entry?.name || id),
    };
    if (entry?.description) preset.description = String(entry.description);

    const meta = entry?._meta && typeof entry._meta === "object"
      ? entry._meta
      : (entry?.meta && typeof entry.meta === "object" ? entry.meta : {});
    const supportsReasoning = meta.supportsReasoningEffort === true
      || meta.supports_reasoning_effort === true;
    const explicitlyUnsupported = !supportsReasoning && (
      meta.supportsReasoningEffort === false
      || meta.supports_reasoning_effort === false
    );
    if (supportsReasoning) {
      const rawOptions = Array.isArray(meta.reasoningEfforts)
        ? meta.reasoningEfforts
        : (Array.isArray(meta.reasoning_efforts) ? meta.reasoning_efforts : []);
      const levels = [];
      for (const option of rawOptions) {
        const value = String(option?.value || option?.id || "").trim().toLowerCase();
        if (GROK_REASONING_EFFORTS.has(value) && !levels.includes(value)) {
          levels.push(value);
        }
      }
      if (levels.length === 0) {
        const knownFallback = applyGrokReasoningFallback(preset);
        if (Array.isArray(knownFallback?.thinkingLevels)) {
          levels.push(...knownFallback.thinkingLevels);
        } else {
          levels.push(...GROK_FALLBACK_REASONING_EFFORTS);
        }
      }
      preset.thinkingLevels = levels;

      const advertisedDefault = String(
        meta.reasoningEffort || meta.reasoning_effort || "",
      ).trim().toLowerCase();
      const optionDefault = rawOptions.find((option) => option?.default === true);
      const optionDefaultValue = String(
        optionDefault?.value || optionDefault?.id || "",
      ).trim().toLowerCase();
      if (levels.includes(advertisedDefault)) {
        preset.defaultThinkingLevel = advertisedDefault;
      } else if (levels.includes(optionDefaultValue)) {
        preset.defaultThinkingLevel = optionDefaultValue;
      } else if (levels.includes("high")) {
        preset.defaultThinkingLevel = "high";
      } else {
        preset.defaultThinkingLevel = levels[0];
      }
    } else if (!explicitlyUnsupported) {
      Object.assign(preset, applyGrokReasoningFallback(preset));
    }
    models.push(preset);
  }

  const advertisedCurrentModelId = String(
    modelState.currentModelId || modelState.current_model_id || "",
  ).trim() || null;
  const currentModelId = resolveGrokCatalogCurrentModelId(models, advertisedCurrentModelId);
  return { currentModelId, models };
}

/**
 * Read the live Grok model catalog from ACP initialize. Unlike `grok models`,
 * this response includes per-model reasoning support, available levels, and
 * the default effort. Authentication is not required for the initialize step.
 */
async function listGrokAcpModels({
  binPath,
  env,
  spawnImpl,
  abortController,
  signal,
  timeoutMs = GROK_ACP_MODEL_LIST_TIMEOUT_MS,
  abortGraceMs = GROK_ACP_ABORT_GRACE_MS,
  forceKillImpl,
} = {}) {
  const cliPath = String(binPath || "").trim();
  if (!cliPath) return { currentModelId: null, models: [] };
  const abortSignal = signal || abortController?.signal;
  if (abortSignal?.aborted) return { currentModelId: null, models: [] };

  return await new Promise((resolve) => {
    let child;
    let settled = false;
    let timer = null;
    let forceKillTimer = null;
    let abortHandler = null;
    let childClosed = false;
    let terminationStarted = false;
    const empty = { currentModelId: null, models: [] };

    const terminateChild = () => {
      if (terminationStarted || childClosed || !child || child.exitCode != null) return;
      terminationStarted = true;
      signalProcessTree(child, "SIGTERM", forceKillImpl);
      forceKillTimer = setTimeout(() => {
        if (!childClosed && child?.exitCode == null) {
          signalProcessTree(child, "SIGKILL", forceKillImpl);
        }
      }, Math.max(1, abortGraceMs));
      forceKillTimer.unref?.();
    };

    const finish = (value, terminate = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
      if (terminate) terminateChild();
      try { child?.stdin?.end?.(); } catch { /* ignore */ }
      resolve(value);
    };

    try {
      child = spawnGrokProcess(spawnImpl, cliPath, ["--no-auto-update", "agent", "stdio"], {
        env: { ...(env || process.env) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      finish(empty, false);
      return;
    }

    const lineBuffer = createLineBuffer((line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.id !== 1) return;
      if (message.error) {
        finish(empty);
        return;
      }
      finish(parseGrokAcpModelCatalog(message.result));
    }, MAX_GROK_ACP_LINE_BYTES);

    child.stdout?.on("data", (chunk) => {
      if (settled || abortSignal?.aborted) return;
      try {
        lineBuffer.push(chunk);
      } catch {
        finish(empty);
      }
    });
    child.stdin?.on?.("error", () => finish(empty));
    child.on("error", () => finish(empty, false));
    child.on("close", () => {
      childClosed = true;
      clearTimeout(forceKillTimer);
      if (!settled) {
        try { lineBuffer.flush(); } catch { /* ignore */ }
      }
      finish(empty, false);
    });

    abortHandler = () => finish(empty);
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortHandler();
        return;
      }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    timer = setTimeout(() => finish(empty), Math.max(1, timeoutMs));
    timer.unref?.();

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: buildGrokAcpInitializeParams(),
    };
    try {
      child.stdin?.write?.(`${JSON.stringify(request)}\n`, (err) => {
        if (err) finish(empty);
      });
    } catch {
      finish(empty);
    }
  });
}

function buildGrokAcpPromptParams(sessionId, prompt) {
  return {
    sessionId: String(sessionId || ""),
    prompt: [{ type: "text", text: String(prompt || "") }],
  };
}

/**
 * Parse initialize result into resume/load capability flags.
 * When the agent omits capability fields, treat them as "unknown" so we still
 * try resume then load (Grok versions vary in what they advertise).
 */
function parseGrokAcpAgentCapabilities(initResult) {
  const caps = initResult && typeof initResult === "object"
    ? (initResult.agentCapabilities || {})
    : {};
  const sessionCaps = caps.sessionCapabilities && typeof caps.sessionCapabilities === "object"
    ? caps.sessionCapabilities
    : {};
  const hasLoadField = Object.prototype.hasOwnProperty.call(caps, "loadSession");
  const hasResumeField = Object.prototype.hasOwnProperty.call(sessionCaps, "resume");
  return {
    loadSession: caps.loadSession === true,
    resume: sessionCaps.resume != null && sessionCaps.resume !== false,
    hasCapabilityInfo: hasLoadField || hasResumeField,
  };
}

/**
 * Ordered session establish methods for this turn.
 * Prefer session/resume (no history replay) → session/load → session/new.
 */
function planGrokAcpSessionEstablish({ resumeSessionId, agentCapabilities } = {}) {
  if (!resumeSessionId) return ["new"];
  const caps = agentCapabilities || parseGrokAcpAgentCapabilities(null);
  const methods = [];
  if (caps.resume || !caps.hasCapabilityInfo) methods.push("resume");
  if (caps.loadSession || !caps.hasCapabilityInfo) methods.push("load");
  methods.push("new");
  return [...new Set(methods)];
}

/**
 * Params for session/resume or session/load (same shape per ACP session-setup).
 */
function buildGrokAcpSessionResumeOrLoadParams({
  sessionId,
  cwd,
  injectedMcpServers,
} = {}) {
  return {
    sessionId: String(sessionId || ""),
    cwd: resolveGrokAcpCwd(cwd),
    mcpServers: toAcpMcpServers(injectedMcpServers),
  };
}

/**
 * Select authenticate methodId per xAI ACP sample:
 * XAI_API_KEY + xai.api_key → xai.api_key; else cached_token; else null.
 * Empty authMethods → skip (already authenticated / no gate).
 */
function selectGrokAcpAuthMethodId(initResult, env = {}) {
  const methods = Array.isArray(initResult?.authMethods) ? initResult.authMethods : [];
  if (methods.length === 0) return { methodId: null, required: false };
  const ids = new Set(
    methods.map((m) => (m && typeof m.id === "string" ? m.id : "")).filter(Boolean),
  );
  const hasApiKey = Boolean(String(env.XAI_API_KEY || process.env.XAI_API_KEY || "").trim());
  if (hasApiKey && ids.has("xai.api_key")) {
    return { methodId: "xai.api_key", required: true };
  }
  if (ids.has("cached_token")) {
    return { methodId: "cached_token", required: true };
  }
  if (ids.has("xai.api_key")) {
    // Advertised but no key in env — still attempt so Grok can read config;
    // missing credentials surface as auth errors after authenticate fails.
    return { methodId: "xai.api_key", required: true };
  }
  return { methodId: null, required: true };
}

/**
 * Run authenticate when the agent advertises methods (xAI official ACP sample).
 */
async function authenticateGrokAcp(rpc, initResult, env = {}) {
  const selected = selectGrokAcpAuthMethodId(initResult, env);
  if (!selected.methodId) {
    if (selected.required) {
      throw new Error("Run `grok login` first, or set XAI_API_KEY.");
    }
    return { skipped: true, methodId: null };
  }
  await rpc.request(
    "authenticate",
    { methodId: selected.methodId, _meta: { headless: true } },
    { timeoutMs: 60_000 },
  );
  return { skipped: false, methodId: selected.methodId };
}

/**
 * Establish session: try plan methods until one succeeds.
 * Caller MUST keep acceptUpdates=false until after this returns (load may replay).
 */
async function establishGrokAcpSession(rpc, {
  resumeSessionId,
  cwd,
  injectedMcpServers,
  permissionMode,
  toolIntegrationMode,
  systemContext,
  agentCapabilities,
} = {}) {
  const methods = planGrokAcpSessionEstablish({ resumeSessionId, agentCapabilities });
  let lastError = null;
  for (const method of methods) {
    try {
      if (method === "new") {
        const created = await rpc.request(
          "session/new",
          buildGrokAcpSessionNewParams({
            cwd,
            injectedMcpServers,
            permissionMode,
            toolIntegrationMode,
            systemContext,
          }),
          { timeoutMs: 30_000 },
        );
        const sessionId = created?.sessionId || created?.session_id;
        if (!sessionId) throw new Error("Grok ACP session/new did not return a sessionId");
        return { sessionId, method: "new" };
      }
      if (method === "resume") {
        const result = await rpc.request(
          "session/resume",
          buildGrokAcpSessionResumeOrLoadParams({
            sessionId: resumeSessionId,
            cwd,
            injectedMcpServers,
          }),
          { timeoutMs: 30_000 },
        );
        const sessionId = result?.sessionId || result?.session_id || resumeSessionId;
        return { sessionId, method: "resume" };
      }
      if (method === "load") {
        const result = await rpc.request(
          "session/load",
          buildGrokAcpSessionResumeOrLoadParams({
            sessionId: resumeSessionId,
            cwd,
            injectedMcpServers,
          }),
          { timeoutMs: 30_000 },
        );
        const sessionId = result?.sessionId || result?.session_id || resumeSessionId;
        return { sessionId, method: "load" };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Grok ACP session establish failed");
}

function resultToText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (typeof result === "object") {
    if (typeof result.content === "string") return result.content;
    if (typeof result.text === "string") return result.text;
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
 * Map one ACP session/update payload (or x.ai notification) to emitter calls.
 * @returns {boolean} true when the stream should stop on error
 */
function translateGrokAcpUpdate(update, emitter, state = {}) {
  if (!update || typeof update !== "object") return false;
  const kind = String(
    update.sessionUpdate
    || update.type
    || update.kind
    || "",
  );

  switch (kind) {
    case "agent_message_chunk":
    case "message_chunk":
    case "text": {
      closeReasoning(state, emitter);
      const text = update.content?.text
        ?? update.text
        ?? update.data
        ?? (typeof update.content === "string" ? update.content : "");
      if (text) {
        emitter.text(String(text));
        state.streamedAssistantText = true;
      }
      return false;
    }

    case "agent_thought_chunk":
    case "thought_chunk":
    case "thought": {
      const text = update.content?.text
        ?? update.text
        ?? update.data
        ?? "";
      if (text) {
        emitter.reasoning(String(text));
        state.reasoningOpen = true;
      }
      return false;
    }

    case "tool_call": {
      closeReasoning(state, emitter);
      const id = update.toolCallId || update.tool_call_id || update.id;
      if (!id) return false;
      if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
      if (!state.toolNames) state.toolNames = new Map();
      const name = String(
        update.toolName
        || update.tool_name
        || update.title
        || update.kind
        || "tool",
      );
      const args = update.rawInput && typeof update.rawInput === "object"
        ? update.rawInput
        : (update.input && typeof update.input === "object" ? update.input : {});
      state.toolNames.set(id, name);
      if (!state.emittedToolCalls.has(id)) {
        state.emittedToolCalls.add(id);
        emitter.toolCall(name, args, id);
      }
      return false;
    }

    case "tool_call_update": {
      closeReasoning(state, emitter);
      const id = update.toolCallId || update.tool_call_id || update.id;
      if (!id) return false;
      if (!state.emittedToolResults) state.emittedToolResults = new Set();
      if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
      if (!state.toolNames) state.toolNames = new Map();
      const status = String(update.status || "").toLowerCase();
      const name = state.toolNames.get(id)
        || String(update.toolName || update.tool_name || update.title || "tool");
      if (!state.emittedToolCalls.has(id)) {
        state.emittedToolCalls.add(id);
        state.toolNames.set(id, name);
        emitter.toolCall(name, {}, id);
      }
      if (
        status === "completed"
        || status === "failed"
        || status === "error"
        || status === "cancelled"
        || update.rawOutput != null
      ) {
        if (!state.emittedToolResults.has(id)) {
          state.emittedToolResults.add(id);
          emitter.toolResult(
            id,
            resultToText(update.rawOutput ?? update.content ?? update.error ?? ""),
            name,
          );
        }
      }
      return false;
    }

    case "plan": {
      // Canonical activity shape: [{ text, completed }] + "running"|"completed"
      // (sdkAgentAdapter / AgentActivityGroup read text+completed, not content+status).
      const plan = normalizeGrokPlanUpdate(Array.isArray(update.entries) ? update.entries : []);
      if (plan && typeof emitter.planUpdate === "function") {
        emitter.planUpdate("grok-plan", plan.items, plan.status);
      }
      return false;
    }

    case "error": {
      closeReasoning(state, emitter);
      state.failed = true;
      emitter.emitError(formatGrokErrorForUser(update.message || update.error || "Grok ACP turn failed"));
      return true;
    }

    default:
      return false;
  }
}

/**
 * Handle a parsed JSON-RPC message from grok agent stdio.
 */
function handleGrokAcpMessage(message, { emitter, state, pending, onPromptComplete }) {
  if (!message || typeof message !== "object") return;

  // Response to a request
  if (Object.prototype.hasOwnProperty.call(message, "id") && message.id != null && !message.method) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(
          message.error.message || message.error.data || JSON.stringify(message.error),
        ));
        // Do NOT call onPromptComplete on error — that used to resolve a race
        // peer and swallow the rejection (async request wrap + microtask hop).
      } else {
        // Mark turn completed + emit usage synchronously on successful
        // session/prompt so teardown/close cannot race past usage emission
        // (UI would fall back to estimated Token ~1).
        if (state.promptRequestId != null && message.id === state.promptRequestId) {
          state.turnCompleted = true;
          emitGrokUsage(emitter, extractGrokAcpPromptUsage(message.result));
          onPromptComplete?.(message);
        }
        waiter.resolve(message.result);
      }
    }
    return;
  }

  const method = String(message.method || "");
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (method === "session/update" || method === "x.ai/session/update") {
    // session/load may re-broadcast historical agent_message_chunk events for
    // client UI rebuild. Those must not be written into the *current* Netcatty
    // assistant bubble — only accept updates after session/prompt is in flight.
    if (state.acceptUpdates === false) {
      if (params.sessionId && !state.sessionId) {
        state.sessionId = params.sessionId;
      }
      return;
    }
    const update = params.update || params.sessionUpdate || params;
    // Nested: params.update.sessionUpdate
    const payload = update?.sessionUpdate || update?.type
      ? update
      : (params.sessionUpdate ? { sessionUpdate: params.sessionUpdate, ...params } : update);
    if (payload) translateGrokAcpUpdate(payload, emitter, state);
    if (params.sessionId && !state.sessionId) {
      state.sessionId = params.sessionId;
      emitter.sessionId?.(params.sessionId);
    }
    return;
  }

  if (method === "session/request_permission" || method === "request_permission") {
    // Non-interactive: auto-allow when yolo was requested; otherwise deny.
    // optionId MUST come from params.options (ACP); do not invent ids.
    const id = message.id;
    if (id == null) return;
    const allow = state.autoAllowPermissions !== false;
    const result = buildGrokAcpPermissionResponse(params, allow);
    // Caller writes responses via pending write hook
    if (typeof state.writeResponse === "function") {
      state.writeResponse(id, result);
    }
    return;
  }
}

/**
 * Build ACP permission result using an offered option's real optionId.
 * Prefers allow_always / allow_once kinds when allowing; reject/cancel when denying.
 */
function buildGrokAcpPermissionResponse(params, allow) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const optionKey = (opt) => {
    const optionId = String(opt?.optionId ?? opt?.id ?? "").trim();
    const kind = String(opt?.kind ?? opt?.name ?? "").trim();
    return { optionId, kind, blob: `${optionId} ${kind}`.toLowerCase() };
  };
  if (allow) {
    let best = null;
    let bestScore = 0;
    for (const opt of options) {
      if (!opt || typeof opt !== "object") continue;
      const { optionId, blob } = optionKey(opt);
      if (!optionId) continue;
      let score = 0;
      if (/allow[_-]?always|always[_-]?allow|allow_for_session|allow-session/.test(blob)) score = 3;
      else if (/allow[_-]?once|once|allow_this|allow-this/.test(blob)) score = 2;
      else if (/\ballow\b/.test(blob)) score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = optionId;
      }
    }
    if (best) return { outcome: { outcome: "selected", optionId: best } };
    // Agent omitted options: last-resort ACP-ish id (prefer underscore form).
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  }
  for (const opt of options) {
    if (!opt || typeof opt !== "object") continue;
    const { optionId, blob } = optionKey(opt);
    if (!optionId) continue;
    if (/reject|cancel|deny|refuse|disallow/.test(blob)) {
      return { outcome: { outcome: "selected", optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

function createJsonRpcClient({ write, onMessage }) {
  let nextId = 1;
  const pending = new Map();

  function request(method, params, { timeoutMs = 120_000 } = {}) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Grok ACP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  function notify(method, params) {
    write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    onMessage(message, pending);
  }

  function rejectAll(err) {
    for (const [, waiter] of pending) {
      try { waiter.reject(err); } catch { /* ignore */ }
    }
    pending.clear();
  }

  return { request, notify, handleLine, pending, rejectAll, getNextId: () => nextId };
}

async function runGrokAcpTurn({
  prompt,
  systemPrompt,
  binPath,
  cwd,
  model,
  env,
  permissionMode,
  toolIntegrationMode,
  resumeSessionId,
  historySeed,
  injectedMcpServers,
  emitter,
  signal,
  spawnImpl,
  abortGraceMs = GROK_ACP_ABORT_GRACE_MS,
  forceKillImpl,
  // inject for tests: skip real spawn
  rpcClientFactory,
}) {
  const cliPath = String(binPath || "").trim();
  if (!cliPath) {
    emitter.emitError(
      "Grok Build CLI not found. Install the Grok CLI (`grok`) and ensure it is on PATH, or set the path in Settings → AI.",
    );
    return { sessionId: resumeSessionId || null, runtime: "acp" };
  }

  const effectiveCwd = resolveGrokAcpCwd(cwd);
  const childEnv = { ...(env || process.env) };
  const spawnArgs = buildGrokAcpSpawnArgs({
    model,
    permissionMode,
    toolIntegrationMode,
  });

  const state = {
    sessionId: resumeSessionId || null,
    reasoningOpen: false,
    streamedAssistantText: false,
    failed: false,
    // True after session/prompt resolves successfully. Process teardown (SIGTERM /
    // taskkill) often yields a non-zero exit on Windows; that must not flip a
    // completed tool-only turn into emitError (no assistant text).
    turnCompleted: false,
    // Suppress session/load history replay until session/prompt starts.
    acceptUpdates: false,
    autoAllowPermissions: String(permissionMode || "confirm").toLowerCase() !== "observer",
    promptRequestId: null,
    writeResponse: null,
  };

  // Test inject path: pure RPC loop without process
  if (typeof rpcClientFactory === "function") {
    const client = rpcClientFactory({ state, emitter });
    try {
      const initResult = await client.request("initialize", buildGrokAcpInitializeParams());
      await authenticateGrokAcp(client, initResult, childEnv);
      const established = await establishGrokAcpSession(client, {
        resumeSessionId,
        cwd: effectiveCwd,
        injectedMcpServers,
        permissionMode,
        toolIntegrationMode,
        systemContext: systemPrompt,
        agentCapabilities: parseGrokAcpAgentCapabilities(initResult),
      });
      state.sessionId = established.sessionId;
      emitter.sessionId?.(established.sessionId);
      const effectivePrompt = resolveGrokTurnPrompt({
        turnPrompt: prompt,
        historySeed,
        resumeSessionId,
        establishMethod: established.method,
      });
      // Only accept updates for this turn's prompt (not session/load replay).
      state.acceptUpdates = true;
      const promptResult = await client.request(
        "session/prompt",
        buildGrokAcpPromptParams(state.sessionId, effectivePrompt),
      );
      state.turnCompleted = true;
      // Fixture/RPC inject path has no process race; still emit from the result.
      emitGrokUsage(emitter, extractGrokAcpPromptUsage(promptResult));
      closeReasoning(state, emitter);
      if (!state.failed && !signal?.aborted) emitter.emitDone();
    } catch (err) {
      if (!state.failed && !signal?.aborted) {
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
      }
    }
    return { sessionId: state.sessionId, runtime: "acp" };
  }

  let child;
  try {
    child = spawnGrokProcess(spawnImpl, cliPath, spawnArgs, {
      cwd: effectiveCwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (err) {
    emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
    return { sessionId: state.sessionId, runtime: "acp" };
  }

  let stderrText = "";
  let stderrBytes = 0;
  let stderrTruncated = false;
  let stderrEnded = false;
  const stderrDecoder = new StringDecoder("utf8");
  let settled = false;
  let forceKillTimer = null;
  let abortHandler = null;
  /** @type {ReturnType<typeof createJsonRpcClient>|null} */
  let rpc = null;

  // Match processErrorGuards / terminalBridge: EPIPE after peer exit is benign.
  // Without a listener, Node treats async stdin errors as unhandled and can
  // take down the Electron main process.
  const isBenignStdinError = (err) => {
    const code = err?.code;
    return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
  };
  const failTurnFromStdin = (err) => {
    if (settled || state.failed || signal?.aborted || state.turnCompleted) return;
    if (isBenignStdinError(err)) return;
    state.failed = true;
    emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
    try { rpc?.rejectAll?.(err || new Error("Grok ACP stdin error")); } catch { /* ignore */ }
  };
  if (typeof child.stdin?.on === "function") {
    child.stdin.on("error", (err) => {
      // Benign teardown races (peer closed): ignore, same as processErrorGuards.
      if (isBenignStdinError(err) || settled || state.failed || signal?.aborted || state.turnCompleted) {
        return;
      }
      failTurnFromStdin(err);
    });
  }

  const writeLine = (line) => {
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writable === false) return;
    try {
      stdin.write(line, (err) => {
        if (err) failTurnFromStdin(err);
      });
    } catch (err) {
      failTurnFromStdin(err);
    }
  };

  state.writeResponse = (id, result) => {
    writeLine(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };

  rpc = createJsonRpcClient({
    write: writeLine,
    onMessage: (message, pending) => {
      if (signal?.aborted) return;
      handleGrokAcpMessage(message, {
        emitter,
        state,
        pending,
      });
    },
  });

  // Track prompt request id so completion is detected.
  // IMPORTANT: keep this wrapper synchronous — an `async` function adds a
  // microtask hop that lets a concurrent promptDone resolve win Promise.race
  // and swallow session/prompt rejections (silent success + unhandledRejection).
  const originalRequest = rpc.request.bind(rpc);
  rpc.request = (method, params, options) => {
    const idBefore = rpc.getNextId();
    if (method === "session/prompt") {
      state.promptRequestId = idBefore;
    }
    return originalRequest(method, params, options);
  };

  const lineBuffer = createLineBuffer((line) => {
    if (signal?.aborted) return;
    try {
      rpc.handleLine(line);
    } catch (err) {
      if (!state.failed) {
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
      }
    }
  }, MAX_GROK_ACP_LINE_BYTES);

  child.stdout?.on("data", (chunk) => {
    if (signal?.aborted) return;
    try {
      lineBuffer.push(chunk);
    } catch (err) {
      if (!state.failed) {
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
      }
      signalProcessTree(child, "SIGKILL", forceKillImpl);
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (signal?.aborted) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = Math.max(0, MAX_GROK_ACP_STDERR_CHARS - stderrBytes);
    const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
    if (accepted.length > 0) stderrText += stderrDecoder.write(accepted);
    stderrBytes += accepted.length;
    if (accepted.length < buffer.length) stderrTruncated = true;
  });

  const closePromise = new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      if (!signal?.aborted) {
        try { lineBuffer.flush(); } catch { /* ignore */ }
      }
      resolve();
    };
    child.on("error", (err) => {
      if (!state.failed && !signal?.aborted) {
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(err?.message || String(err)));
      }
      rpc.rejectAll(err || new Error("Grok ACP process error"));
      finish();
    });
    child.on("close", (code, exitSignal) => {
      if (!stderrEnded) {
        stderrEnded = true;
        if (!stderrTruncated || stderrDecoder.lastNeed === 0) stderrText += stderrDecoder.end();
      }
      // Only ignore exit after session/prompt succeeded (turnCompleted).
      // Incomplete turns fail even on exit 0; signal kills report code=null.
      if (shouldReportGrokProcessExitFailure(state, signal, code, exitSignal)) {
        const stderr = stderrText.trim();
        const detail = code != null && code !== 0
          ? `exited with code ${code}`
          : (exitSignal ? `terminated by signal ${exitSignal}` : "exited before the turn completed");
        state.failed = true;
        emitter.emitError(formatGrokErrorForUser(stderr || `Grok ACP ${detail}`));
      }
      // Unblock any in-flight RPC (initialize/prompt) so await rejects into catch.
      rpc.rejectAll(new Error("Grok ACP process closed"));
      finish();
    });

    let terminationStarted = false;
    abortHandler = () => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      // Prefer protocol cancel when a session is active (ACP prompt-turn).
      if (state.sessionId) {
        try {
          rpc.notify("session/cancel", { sessionId: state.sessionId });
        } catch { /* ignore */ }
      }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        signalProcessTree(child, "SIGKILL", forceKillImpl);
        finish();
      }, Math.max(0, abortGraceMs));
      forceKillTimer.unref?.();
      signalProcessTree(child, "SIGTERM");
      try { child.stdin?.end(); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  try {
    const initResult = await rpc.request(
      "initialize",
      buildGrokAcpInitializeParams(),
      { timeoutMs: 30_000 },
    );
    await authenticateGrokAcp(rpc, initResult, childEnv);

    const established = await establishGrokAcpSession(rpc, {
      resumeSessionId,
      cwd: effectiveCwd,
      injectedMcpServers,
      permissionMode,
      toolIntegrationMode,
      systemContext: systemPrompt,
      agentCapabilities: parseGrokAcpAgentCapabilities(initResult),
    });
    state.sessionId = established.sessionId;
    emitter.sessionId?.(established.sessionId);
    const effectivePrompt = resolveGrokTurnPrompt({
      turnPrompt: prompt,
      historySeed,
      resumeSessionId,
      establishMethod: established.method,
    });

    // Accept streamed updates only for this turn's prompt (not session/load replay).
    state.acceptUpdates = true;

    // Await the prompt RPC only (no race with promptDone). Process death
    // rejects via rejectAll on close; success sets turnCompleted + usage in
    // handleGrokAcpMessage before resolve.
    await rpc.request(
      "session/prompt",
      buildGrokAcpPromptParams(state.sessionId, effectivePrompt),
      { timeoutMs: 30 * 60_000 },
    );
  } catch (err) {
    if (!state.failed && !signal?.aborted) {
      state.failed = true;
      const message = err?.message || String(err);
      const stderr = stderrText.trim();
      emitter.emitError(formatGrokErrorForUser(
        stderr && !message.includes(stderr) ? `${message} (${stderr})` : message,
      ));
    }
  } finally {
    try { child.stdin?.end(); } catch { /* ignore */ }
    // Give the process a moment to exit cleanly after prompt completes.
    if (!settled && child.exitCode == null && !child.killed) {
      signalProcessTree(child, "SIGTERM", forceKillImpl);
    }
    await closePromise;
    if (signal) signal.removeEventListener("abort", abortHandler);
  }

  closeReasoning(state, emitter);
  // Hard gate: incomplete protocol must not look like success (exit 0 / swallowed
  // RPC error previously fell through to emitDone).
  if (signal?.aborted) {
    // User cancel.
  } else if (state.failed) {
    // Already reported.
  } else if (state.turnCompleted) {
    emitter.emitDone();
  } else {
    state.failed = true;
    emitter.emitError(formatGrokErrorForUser("Grok ACP ended before the turn completed"));
  }

  return { sessionId: state.sessionId, runtime: "acp" };
}

module.exports = {
  ACP_PROTOCOL_VERSION,
  authenticateGrokAcp,
  buildGrokAcpInitializeParams,
  buildGrokAcpPermissionResponse,
  buildGrokAcpPromptParams,
  buildGrokAcpSessionNewParams,
  buildGrokAcpSessionResumeOrLoadParams,
  buildGrokAcpSpawnArgs,
  createJsonRpcClient,
  establishGrokAcpSession,
  handleGrokAcpMessage,
  parseGrokAcpAgentCapabilities,
  parseGrokAcpModelCatalog,
  planGrokAcpSessionEstablish,
  resolveGrokAcpCwd,
  runGrokAcpTurn,
  listGrokAcpModels,
  selectGrokAcpAuthMethodId,
  toAcpMcpEnvPairs,
  toAcpMcpServers,
  translateGrokAcpUpdate,
};
