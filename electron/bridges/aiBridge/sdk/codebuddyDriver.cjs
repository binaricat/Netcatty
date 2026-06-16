"use strict";

/**
 * CodeBuddy backend driver — wraps @tencent-ai/agent-sdk query().
 *
 * - Spawns the user's system `codebuddy` binary (auto-discovered or via
 *   CODEBUDDY_CODE_PATH env var / pathToCodebuddyCode option).
 * - Bypasses the SDK's built-in permission system and routes all side effects
 *   through the injected netcatty MCP server (approval/scope/blocklist enforced
 *   there).
 * - Translates SDK messages into the canonical renderer event protocol.
 * - Supports streaming text via includePartialMessages, multi-turn session
 *   resume, thinking mode config, and model listing.
 */
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

// Built-in tools that need interactive UI netcatty doesn't provide — they would
// hang the turn waiting for a response, so they are blocked in BOTH modes.
const UI_DISALLOWED_TOOLS = ["AskUserQuestion"];

// Whitelist CodeBuddy built-in tools per tool-integration mode.
const MCP_MODE_TOOLS = [];
const SKILLS_MODE_TOOLS = ["Bash"];

const CODEBUDDY_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isCodebuddyImageAttachment(attachment) {
  return Boolean(
    attachment &&
    CODEBUDDY_IMAGE_MEDIA_TYPES.has(String(attachment.mediaType || "").toLowerCase()) &&
    attachment.base64Data,
  );
}

// ---------------------------------------------------------------------------
// Thinking config
// ---------------------------------------------------------------------------

/**
 * Parse env-based thinking config into the SDK's thinking option.
 * Accepts: "adaptive" | "enabled" | "enabled:16000" | "disabled" | ""
 */
function parseCodebuddyThinking(value) {
  if (!value || typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "adaptive") return { type: "adaptive" };
  if (trimmed === "enabled") return { type: "enabled", budgetTokens: 16000 };
  if (trimmed.startsWith("enabled:")) {
    const budget = parseInt(trimmed.slice(8), 10);
    if (Number.isFinite(budget) && budget > 0) return { type: "enabled", budgetTokens: budget };
    return { type: "enabled", budgetTokens: 16000 };
  }
  if (trimmed === "disabled") return { type: "disabled" };
  return undefined;
}

/**
 * Serialize thinking config to env pairs for storage/display.
 */
function buildCodebuddyThinkingEnv(thinking) {
  if (!thinking || typeof thinking !== "object") return {};
  if (thinking.type === "adaptive") return { NETCATTY_CODEBUDDY_THINKING: "adaptive" };
  if (thinking.type === "enabled") {
    const budget = thinking.budgetTokens || 16000;
    return { NETCATTY_CODEBUDDY_THINKING: budget === 16000 ? "enabled" : `enabled:${budget}` };
  }
  if (thinking.type === "disabled") return { NETCATTY_CODEBUDDY_THINKING: "disabled" };
  return {};
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/** Convert neutral injectMcp configs into the SDK's keyed mcpServers map. */
function toSdkMcpServers(injectedMcpServers) {
  const map = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name) continue;
    map[cfg.name] = {
      type: "stdio",
      command: cfg.command,
      args: cfg.args || [],
      env: mcpEnvPairsToObject(cfg.env),
    };
  }
  return map;
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

/**
 * Resolve built-in tools for the active tool-integration mode.
 */
function codebuddyBuiltinTools(toolIntegrationMode) {
  return toolIntegrationMode === "skills"
    ? [...SKILLS_MODE_TOOLS]
    : [...MCP_MODE_TOOLS];
}

function buildCodebuddyQueryOptions({
  cwd, model, env, injectedMcpServers, abortController,
  resume, pathToCodebuddyCode, toolIntegrationMode, thinking,
}) {
  const builtinTools = codebuddyBuiltinTools(toolIntegrationMode);
  const options = {
    cwd,
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    extraArgs: { "dangerously-skip-permissions": null },
    mcpServers: toSdkMcpServers(injectedMcpServers),
    tools: builtinTools,
    allowedTools: builtinTools,
    disallowedTools: [...UI_DISALLOWED_TOOLS],
    // Keep the SDK isolated from user/project settings so local hooks, plugins,
    // or extra MCP servers cannot expand Netcatty's controlled tool boundary.
    settingSources: [],
    env,
  };
  if (model) options.model = model;
  if (abortController) options.abortController = abortController;
  // Resume prior session for multi-turn context continuity.
  if (resume) options.resume = resume;
  // CLI executable path (auto-discovery if omitted).
  if (pathToCodebuddyCode) options.pathToCodebuddyCode = pathToCodebuddyCode;
  // Thinking mode from env marker or explicit param.
  const thinkingConfig = thinking || parseCodebuddyThinking(env?.NETCATTY_CODEBUDDY_THINKING);
  if (thinkingConfig) {
    options.thinking = thinkingConfig;
    if (thinkingConfig.type === "enabled" && thinkingConfig.budgetTokens) {
      options.maxThinkingTokens = thinkingConfig.budgetTokens;
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

/**
 * Translate one CodeBuddy SDK message into emitter calls.
 *
 * With includePartialMessages enabled:
 * - Streaming text/reasoning arrives via stream_event (content_block_delta).
 * - The consolidated assistant TEXT block is skipped to avoid duplication,
 *   but assistant TOOL_USE blocks remain the authoritative source for tool calls.
 *
 * Without includePartialMessages (fallback):
 * - Text arrives as complete TextBlock within assistant messages.
 */
function translateCodebuddyMessage(message, emitter, opts = {}) {
  if (!message || typeof message !== "object") return;
  const type = message.type;

  if (type === "system") {
    if (message.session_id) emitter.sessionId(message.session_id);
    if (message.message) emitter.status(message.message);
    return;
  }

  // Streaming deltas (when includePartialMessages is enabled).
  if (type === "stream_event" && message.event) {
    const ev = message.event;
    if (ev.type === "content_block_delta" && ev.delta) {
      if (ev.delta.type === "text_delta" && ev.delta.text) {
        emitter.text(ev.delta.text);
      } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
        emitter.reasoning(ev.delta.thinking);
      }
    }
    return;
  }

  if (type === "assistant" && message.message && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        emitter.toolCall(block.name, block.input || {}, block.id);
      } else if (!opts.skipAssistantText && block.type === "text" && block.text) {
        emitter.text(block.text);
      }
    }
    return;
  }

  if (type === "user" && message.message && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block?.type === "tool_result") {
        const out = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        emitter.toolResult(block.tool_use_id, out, undefined);
      }
    }
    return;
  }

  if (type === "status" && message.message) {
    emitter.status(message.message);
    return;
  }

  // result carries final duration/cost/usage — emit as status summary.
  if (type === "result") {
    const parts = [];
    if (message.num_turns) parts.push(`${message.num_turns} turns`);
    if (message.total_cost_usd > 0) parts.push(`$${message.total_cost_usd.toFixed(4)}`);
    if (message.is_error && Array.isArray(message.errors) && message.errors.length > 0) {
      parts.push(`errors: ${message.errors.join("; ")}`);
    }
    if (parts.length > 0) {
      emitter.status(`CodeBuddy: ${parts.join(", ")}`);
    }
    return;
  }
  // tool_progress, compact_boundary — no renderer mapping.
}

/** Classify a spawn failure for user-friendly error messages. */
function classifyCodebuddySpawnError(error) {
  const code = error && error.code;
  const msg = String((error && error.message) || error || "");
  const isSpawnEnoent =
    code === "ENOENT" ||
    /ENOENT/i.test(msg) ||
    /not found/i.test(msg);
  return { isSpawnEnoent, message: msg };
}

// ---------------------------------------------------------------------------
// Prompt input (with optional image attachments)
// ---------------------------------------------------------------------------

function buildCodebuddyPromptInput(prompt, attachments) {
  const imageAttachments = Array.isArray(attachments)
    ? attachments.filter(isCodebuddyImageAttachment)
    : [];
  if (imageAttachments.length === 0) return String(prompt || "");

  const content = [{ type: "text", text: String(prompt || "") }];
  for (const attachment of imageAttachments) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: String(attachment.mediaType).toLowerCase(),
        data: attachment.base64Data,
      },
    });
  }

  return (async function* codebuddyPromptInput() {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  }());
}

// ---------------------------------------------------------------------------
// Run turn
// ---------------------------------------------------------------------------

/**
 * Run a CodeBuddy turn. Streams events via `emitter`, resolves with { sessionId }.
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array<object>} [args.attachments]
 * @param {object} args.options  result of buildCodebuddyQueryOptions
 * @param {object} args.emitter  createStreamEmitter(...)
 * @param {Function} [args.queryFn] inject @tencent-ai/agent-sdk query (for tests)
 */
async function runCodebuddyTurn({ prompt, attachments, options, emitter, queryFn }) {
  let query = queryFn;
  if (!query) {
    let sdk;
    try { sdk = await import("@tencent-ai/agent-sdk"); } catch {
      emitter.emitError("CodeBuddy Agent SDK not installed. Run: npm install @tencent-ai/agent-sdk");
      return { sessionId: null };
    }
    query = sdk.query;
  }

  const promptInput = buildCodebuddyPromptInput(prompt, attachments);

  let sessionId = null;
  let hasContent = false;
  let hasStreamedText = false;
  let queryRef = null;
  let removeAbortListener = null;
  try {
    queryRef = query({ prompt: promptInput, options });
    const signal = options.abortController?.signal;
    const interruptQuery = () => {
      if (typeof queryRef?.interrupt === "function") {
        void queryRef.interrupt().catch(() => {});
      }
    };
    if (signal) {
      if (signal.aborted) interruptQuery();
      else {
        signal.addEventListener("abort", interruptQuery, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", interruptQuery);
      }
    }
    for await (const message of queryRef) {
      if (options.abortController?.signal?.aborted) {
        if (typeof queryRef.interrupt === "function") {
          try { await queryRef.interrupt(); } catch { /* best effort */ }
        }
        break;
      }
      if (message?.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
      }
      if (
        message?.type === "stream_event" ||
        (message?.type === "assistant" && Array.isArray(message?.message?.content) && message.message.content.length > 0)
      ) {
        hasContent = true;
      }
      translateCodebuddyMessage(message, emitter, { skipAssistantText: hasStreamedText });
      if (
        message?.type === "stream_event" &&
        message.event?.type === "content_block_delta" &&
        message.event?.delta?.type === "text_delta" &&
        message.event.delta.text
      ) {
        hasStreamedText = true;
      }
    }
    if (!hasContent && !options.abortController?.signal?.aborted) {
      emitter.emitError(
        "CodeBuddy returned an empty response. Run `codebuddy` in a terminal to log in, " +
        "or set CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN.",
      );
      return { sessionId };
    }
    emitter.emitDone();
    return { sessionId };
  } catch (error) {
    const classified = classifyCodebuddySpawnError(error);
    if (classified.isSpawnEnoent) {
      emitter.emitError(
        "CodeBuddy CLI not found or not runnable. " +
        "Install codebuddy and ensure it's on PATH, or set CODEBUDDY_CODE_PATH.",
      );
    } else {
      emitter.emitError(classified.message || "CodeBuddy turn failed");
    }
    return { sessionId };
  } finally {
    removeAbortListener?.();
  }
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

/** Map CodeBuddy SDK ModelInfo[] → renderer preset shape {id, name, description}. */
function mapCodebuddyModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m && (m.modelId || m.value))
    .map((m) => ({
      id: m.modelId || m.value,
      name: m.name || m.displayName || m.modelId || m.value,
      description: m.description,
    }));
}

/**
 * Fetch available CodeBuddy models via the SDK control channel. Opens a
 * streaming (idle) session so no turn is billed, asks supportedModels(), then
 * tears down. Returns [] on failure (caller falls back to curated presets).
 * @param {object} args
 * @param {string} [args.pathToCodebuddyCode]
 * @param {object} [args.env]
 * @param {Function} [args.queryFn] inject query() for tests
 */
async function listCodebuddyModels({ pathToCodebuddyCode, env, queryFn }) {
  let query = queryFn;
  if (!query) {
    let sdk;
    try { sdk = await import("@tencent-ai/agent-sdk"); } catch { return []; }
    query = sdk.query;
  }
  const abortController = new AbortController();
  async function* idleInput() {
    await new Promise((resolve) => {
      if (abortController.signal.aborted) return resolve();
      abortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  const q = query({
    prompt: idleInput(),
    options: { pathToCodebuddyCode, env, abortController, includePartialMessages: false },
  });
  try {
    return mapCodebuddyModels(await q.supportedModels());
  } catch {
    return [];
  } finally {
    abortController.abort();
    try { await q.return?.(undefined); } catch { /* best effort */ }
  }
}

module.exports = {
  buildCodebuddyQueryOptions,
  translateCodebuddyMessage,
  classifyCodebuddySpawnError,
  buildCodebuddyPromptInput,
  buildCodebuddyThinkingEnv,
  parseCodebuddyThinking,
  toSdkMcpServers,
  runCodebuddyTurn,
  listCodebuddyModels,
  mapCodebuddyModels,
  codebuddyBuiltinTools,
  UI_DISALLOWED_TOOLS,
  MCP_MODE_TOOLS,
  SKILLS_MODE_TOOLS,
};
