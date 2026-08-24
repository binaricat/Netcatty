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
const { isLikelyNetcattyCliShellCommand } = require("./copilotDriver.cjs");
const { randomUUID } = require("node:crypto");

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

/** Convert neutral injectMcp configs into the SDK's keyed mcpServers map.
 *  Supports stdio (default), sse, http, and sdk (in-process) transport types (SDK 0.3.230). */
function toSdkMcpServers(injectedMcpServers) {
  const map = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name) continue;
    const transport = cfg.type || "stdio";
    if (transport === "sse" || transport === "http") {
      map[cfg.name] = {
        type: transport,
        url: cfg.url,
        headers: cfg.headers || undefined,
      };
    } else if (transport === "sdk") {
      // In-process MCP server created via createSdkMcpServer() — pass instance through.
      map[cfg.name] = {
        type: "sdk",
        name: cfg.name,
        instance: cfg.instance,
      };
    } else {
      map[cfg.name] = {
        type: "stdio",
        command: cfg.command,
        args: cfg.args || [],
        env: mcpEnvPairsToObject(cfg.env),
      };
    }
  }
  return map;
}

/**
 * Create an in-process SDK MCP server with Netcatty tools.
 * Uses createSdkMcpServer() + tool() from @tencent-ai/agent-sdk to avoid
 * spawning a subprocess for lightweight built-in tools.
 * @param {Array<{name: string, description: string, inputSchema: object, handler: Function}>} toolDefs
 * @returns {Promise<object|null>} McpSdkServerResult instance or null if unavailable
 */
async function createCodebuddySdkMcpServer(toolDefs) {
  let sdk;
  try { sdk = await import("@tencent-ai/agent-sdk"); } catch { return null; }
  if (!sdk.createSdkMcpServer || !sdk.tool) return null;
  const tools = (toolDefs || []).map((def) =>
    sdk.tool(def.name, def.description, def.inputSchema, def.handler),
  );
  return sdk.createSdkMcpServer({ name: "netcatty-builtin", tools });
}

// ---------------------------------------------------------------------------
// Permission handler (canUseTool)
// ---------------------------------------------------------------------------

/**
 * Build an SDK canUseTool permission handler based on Netcatty's permission mode.
 *
 * When the CodeBuddy CLI encounters a security restriction that requires a
 * permission decision (instead of throwing an error), the SDK routes the
 * request through this handler:
 * - auto: automatically confirm execution (no user interruption)
 * - confirm: forward to the Netcatty renderer approval UI and wait for the
 *   user's decision (approve once / always allow / reject)
 * - observer: deny all restricted tool executions
 *
 * @param {object} args
 * @param {string} args.permissionMode  Netcatty permission mode ('auto'|'confirm'|'observer')
 * @param {string} [args.chatSessionId]  chat session scope for the approval card
 * @param {Function} [args.requestApproval]  (toolName, args, chatSessionId) => Promise<boolean>
 * @returns {Function} SDK CanUseTool handler: (toolName, input, options) => Promise<PermissionResult>
 */
function buildCodebuddyCanUseTool({ permissionMode, chatSessionId, requestApproval }) {
  return async (toolName, input, _options) => {
    // Auto mode: confirm execution immediately without user interruption.
    if (permissionMode === "auto") {
      return { behavior: "allow" };
    }
    // Observer mode: deny all restricted tool executions.
    if (permissionMode === "observer") {
      return {
        behavior: "deny",
        message: `Observer mode: tool "${toolName}" execution denied.`,
      };
    }
    // Confirm mode (default): forward to the Netcatty approval UI.
    if (typeof requestApproval !== "function") {
      // No approval channel available — deny to preserve confirm-mode safety guarantee.
      return {
        behavior: "deny",
        message: `Tool "${toolName}" requires approval but no approval channel is available.`,
      };
    }
    try {
      const approved = await requestApproval(toolName, input || {}, chatSessionId);
      return approved
        ? { behavior: "allow" }
        : { behavior: "deny", message: `User denied execution of tool "${toolName}".` };
    } catch {
      return {
        behavior: "deny",
        message: `Approval request for tool "${toolName}" failed.`,
      };
    }
  };
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

const CODEBUDDY_REASONING_LEVELS = ["low", "medium", "high", "xhigh"];
const CODEBUDDY_REASONING_LEVEL_SET = new Set(CODEBUDDY_REASONING_LEVELS);

function splitCodebuddyModelSelection(model) {
  if (typeof model !== "string" || !model) {
    return { model: undefined, effort: undefined };
  }
  const slash = model.lastIndexOf("/");
  if (slash <= 0) return { model, effort: undefined };
  const effort = model.slice(slash + 1).toLowerCase();
  if (!CODEBUDDY_REASONING_LEVEL_SET.has(effort)) return { model, effort: undefined };
  return { model: model.slice(0, slash), effort };
}

function attachCodebuddyThinkingLevels(preset) {
  if (!preset) return preset;
  return {
    ...preset,
    thinkingLevels: [...CODEBUDDY_REASONING_LEVELS],
    defaultThinkingLevel: "medium",
    encodeDefaultThinking: false,
  };
}

function buildCodebuddyQueryOptions({
  cwd, model, env, injectedMcpServers, abortController,
  resume, pathToCodebuddyCode, toolIntegrationMode, thinking,
  // Phase 1: SDK 0.3.230 options
  systemPrompt, effort, maxTurns, maxBudgetUsd, fallbackModel,
  sandbox, agents, outputFormat, enableFileCheckpointing,
  traceId, parentSpanId, persistSession, sessionId, hooks,
  elicitation, canUseTool,
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
    // `tools` is the built-in tool whitelist. In mcp mode it is [], so CodeBuddy
    // built-ins stay disabled while injected Netcatty MCP tools remain visible.
    // Do not mirror that empty list into allowedTools: the SDK treats
    // allowedTools as an auto-approval list, and allowedTools: [] prevents MCP
    // tool calls from running under bypassPermissions.
    disallowedTools: [...UI_DISALLOWED_TOOLS],
    // Keep the SDK isolated from user/project settings so local hooks, plugins,
    // or extra MCP servers cannot expand Netcatty's controlled tool boundary.
    settingSources: [],
    env,
  };
  const selection = splitCodebuddyModelSelection(model);
  if (selection.model) options.model = selection.model;
  if (abortController) options.abortController = abortController;
  // Resume prior session for multi-turn context continuity.
  if (resume) options.resume = resume;
  // CLI executable path (auto-discovery if omitted).
  if (pathToCodebuddyCode) options.pathToCodebuddyCode = pathToCodebuddyCode;
  // Thinking mode from env marker or explicit param.
  const thinkingConfig = thinking || parseCodebuddyThinking(env?.NETCATTY_CODEBUDDY_THINKING);
  if (thinkingConfig) {
    options.thinking = thinkingConfig;
  }
  // --- SDK 0.3.230 options ---
  // System prompt: string is treated as append to default.
  if (systemPrompt) {
    options.systemPrompt = typeof systemPrompt === "string"
      ? { append: systemPrompt }
      : systemPrompt;
  }
  // Effort level for model reasoning. Sidebar `model/effort` wins over
  // the Settings-level codebuddyOptions.effort fallback.
  const resolvedEffort = selection.effort || effort;
  if (CODEBUDDY_REASONING_LEVEL_SET.has(resolvedEffort)) {
    options.effort = resolvedEffort;
  }
  // Safety guardrails.
  if (Number.isInteger(maxTurns) && maxTurns > 0) options.maxTurns = maxTurns;
  if (Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) {
    options.maxBudgetUsd = maxBudgetUsd;
  }
  // Fallback model when primary is unavailable.
  if (typeof fallbackModel === "string" && fallbackModel.trim()) {
    options.fallbackModel = fallbackModel.trim();
  }
  // Sandbox settings.
  if (
    sandbox &&
    typeof sandbox === "object" &&
    !Array.isArray(sandbox) &&
    sandbox.enabled === true
  ) {
    options.sandbox = sandbox;
  }
  // Custom subagent definitions.
  if (agents && typeof agents === "object") options.agents = agents;
  // Structured output format.
  if (outputFormat && typeof outputFormat === "object") options.outputFormat = outputFormat;
  // File checkpointing for rollback.
  if (enableFileCheckpointing === true) options.enableFileCheckpointing = true;
  // Distributed tracing.
  if (traceId) options.traceId = traceId;
  if (parentSpanId) options.parentSpanId = parentSpanId;
  // Session persistence control.
  if (persistSession != null) options.persistSession = persistSession;
  // Custom session ID.
  if (sessionId) options.sessionId = sessionId;
  // Lifecycle hooks.
  if (hooks && typeof hooks === "object") options.hooks = hooks;
  // Supported by @tencent-ai/agent-sdk 0.3.230 Options.elicitation.
  // QueryController advertises capabilities.elicitation.form during
  // initialization and routes elicitation_create control requests here.
  if (elicitation && typeof elicitation === "object") options.elicitation = elicitation;
  // Permission handler: when the CLI hits a security restriction, route the
  // decision through Netcatty (auto-confirm / user approval / deny) instead
  // of throwing an error.
  if (typeof canUseTool === "function") options.canUseTool = canUseTool;
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
    if (!opts.skipSessionId && message.session_id) emitter.sessionId(message.session_id);
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

  if (type === "error") {
    emitter.emitError(String(message.error || "CodeBuddy execution failed."));
    return { terminalError: true };
  }

  if (type === "assistant" && message.message && Array.isArray(message.message.content)) {
    if (message.error) {
      emitter.emitError(String(message.error));
      return { terminalError: true };
    }
    for (const block of message.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_use") {
        emitter.toolCall(block.name, block.input || {}, block.id);
      } else if (!opts.skipAssistantText && block.type === "text" && block.text) {
        emitter.text(block.text);
      } else if (
        !opts.skipAssistantReasoning &&
        block.type === "thinking" &&
        block.thinking
      ) {
        emitter.reasoning(block.thinking);
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

  // result carries final duration/cost/usage.
  if (type === "result") {
    const usage = message.usage;
    if (usage && typeof usage === "object") {
      const uncachedInputTokens = Number(usage.input_tokens) || 0;
      const cachedInputTokens = Number(usage.cache_read_input_tokens) || 0;
      const cacheCreationInputTokens = Number(usage.cache_creation_input_tokens) || 0;
      // CodeBuddy follows Anthropic usage semantics: cache read/creation tokens
      // are reported separately from input_tokens. AgentUsage expects total
      // prompt tokens with cachedPromptTokens as the cached subset.
      const inputTokens =
        uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens;
      const outputTokens = Number(usage.output_tokens) || 0;
      emitter.usage?.({
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      });
    }
    const parts = [];
    if (message.num_turns) parts.push(`${message.num_turns} turns`);
    if (message.total_cost_usd > 0) parts.push(`$${message.total_cost_usd.toFixed(4)}`);
    if (message.is_error && Array.isArray(message.errors) && message.errors.length > 0) {
      parts.push(`errors: ${message.errors.join("; ")}`);
    }
    if (parts.length > 0) {
      emitter.status(`CodeBuddy: ${parts.join(", ")}`);
    }
    if (message.is_error) {
      const detail = Array.isArray(message.errors) && message.errors.length > 0
        ? message.errors.join("; ")
        : message.subtype === "error_max_turns"
          ? "CodeBuddy stopped after reaching the maximum turn limit."
          : message.subtype === "error_max_budget_usd"
            ? "CodeBuddy stopped after reaching the configured budget limit."
            : "CodeBuddy execution failed.";
      emitter.emitError(detail);
      return { terminalError: true };
    }
    return { terminalError: false };
  }
  // tool_progress, compact_boundary — no renderer mapping.
}

function inspectCodebuddyMessageContent(message) {
  const delta = message?.type === "stream_event" ? message.event?.delta : null;
  const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
  const streamedText = delta?.type === "text_delta" && Boolean(delta.text);
  const streamedReasoning = delta?.type === "thinking_delta" && Boolean(delta.thinking);
  const assistantText = message?.type === "assistant" &&
    blocks.some((block) => block?.type === "text" && block.text);
  const assistantReasoning = message?.type === "assistant" &&
    blocks.some((block) => block?.type === "thinking" && block.thinking);
  const assistantTool = message?.type === "assistant" &&
    blocks.some((block) => block?.type === "tool_use");
  const toolResult = message?.type === "user" &&
    blocks.some((block) => block?.type === "tool_result");
  return {
    hasContent: streamedText || streamedReasoning ||
      assistantText || assistantReasoning || assistantTool || toolResult,
    hasText: streamedText || assistantText,
    streamedText,
    streamedReasoning,
  };
}

function codebuddyResultFallbackText(message) {
  if (message?.type !== "result" || message.is_error) return "";
  if (typeof message.result === "string" && message.result) return message.result;
  if (message.structured_output === undefined) return "";
  try {
    return JSON.stringify(message.structured_output, null, 2);
  } catch {
    return String(message.structured_output);
  }
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
  if (options.abortController?.signal?.aborted) {
    emitter.emitDone();
    return { sessionId: null };
  }

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
  let hasAssistantText = false;
  let hasStreamedText = false;
  let hasStreamedReasoning = false;
  let hasTerminalError = false;
  let resultFallbackText = "";
  let queryRef = null;
  let removeAbortListener = null;
  try {
    queryRef = query({ prompt: promptInput, options });
    const signal = options.abortController?.signal;
    const interruptQuery = () => {
      if (typeof queryRef?.interrupt === "function") {
        void queryRef.interrupt().catch((err) => {
          console.debug("[CodeBuddy SDK] interrupt failed:", err?.message || err);
        });
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
          try { await queryRef.interrupt(); } catch (err) {
            // Best effort — surface for diagnostics without failing the turn.
            console.debug("[CodeBuddy SDK] interrupt failed:", err?.message || err);
          }
        }
        break;
      }
      if (message?.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
      }
      const contentState = inspectCodebuddyMessageContent(message);
      if (contentState.hasContent) hasContent = true;
      if (contentState.hasText) hasAssistantText = true;
      resultFallbackText ||= codebuddyResultFallbackText(message);
      const translation = translateCodebuddyMessage(
        message,
        emitter,
        {
          skipAssistantText: hasStreamedText,
          skipAssistantReasoning: hasStreamedReasoning,
        },
      );
      if (translation?.terminalError) hasTerminalError = true;
      if (contentState.streamedText) hasStreamedText = true;
      if (contentState.streamedReasoning) hasStreamedReasoning = true;
    }
    if (hasTerminalError) {
      return { sessionId };
    }
    if (!hasAssistantText && resultFallbackText) {
      emitter.text(resultFallbackText);
      hasContent = true;
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
    if (options.abortController?.signal?.aborted) {
      emitter.emitDone();
      return { sessionId };
    }
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

/**
 * Map CodeBuddy SDK ModelInfo[] → renderer preset shape {id, name, description}.
 *
 * The SDK's ModelInfo type declares {value, displayName, description}, but the
 * CLI's `supportedModels()` control response actually returns {id, name} at
 * runtime (verified against codebuddy-code: e.g. {id:"glm-5.1", name:"GLM-5.1"}).
 * The type and the wire shape disagree, so accept all three id keys
 * (id / modelId / value); otherwise every model is filtered out and the UI
 * silently falls back to curated presets even when the fetch succeeds.
 */
function mapCodebuddyModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => {
      if (!m) return null;
      const id = m.id || m.modelId || m.value;
      if (!id) return null;
      return attachCodebuddyThinkingLevels({
        id,
        name: m.name || m.displayName || id,
        description: m.description,
      });
    })
    .filter(Boolean);
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
async function listCodebuddyModels({
  pathToCodebuddyCode,
  env,
  queryFn,
  abortController,
  signal,
}) {
  const externalSignal = signal || abortController?.signal;
  if (externalSignal?.aborted) return [];
  let query = queryFn;
  if (!query) {
    let sdk;
    try { sdk = await import("@tencent-ai/agent-sdk"); } catch { return []; }
    query = sdk.query;
  }
  const queryAbortController = new AbortController();
  const forwardAbort = () => {
    try { queryAbortController.abort(externalSignal?.reason); } catch {}
  };
  if (externalSignal) {
    externalSignal.addEventListener("abort", forwardAbort, { once: true });
    if (externalSignal.aborted) forwardAbort();
  }
  async function* idleInput() {
    await new Promise((resolve) => {
      if (queryAbortController.signal.aborted) return resolve();
      queryAbortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  let q;
  try {
    q = query({
      prompt: idleInput(),
      options: {
        pathToCodebuddyCode,
        env,
        abortController: queryAbortController,
        includePartialMessages: false,
      },
    });
    const result = await Promise.race([
      Promise.resolve(q.supportedModels()).then((models) => ({ type: "models", models })),
      new Promise((resolve) => {
        if (queryAbortController.signal.aborted) return resolve({ type: "aborted" });
        queryAbortController.signal.addEventListener(
          "abort",
          () => resolve({ type: "aborted" }),
          { once: true },
        );
      }),
    ]);
    return result.type === "models" ? mapCodebuddyModels(result.models) : [];
  } catch {
    return [];
  } finally {
    if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
    queryAbortController.abort();
    try { void Promise.resolve(q?.return?.(undefined)).catch(() => {}); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Hooks (SDK 0.3.230 lifecycle callbacks)
// ---------------------------------------------------------------------------

/**
 * Build SDK hooks option from an emitter. Registers PreToolUse / PostToolUse /
 * PostToolUseFailure / SessionEnd / Notification hooks that forward events to
 * the renderer via the existing emitter event channel.
 * @param {object} emitter  createStreamEmitter(...)
 * @returns {object} hooks map suitable for Options.hooks
 */
function isAllowedCodebuddySkillsBash(command, allowedCliCommandPrefix) {
  const text = String(command || "").trim();
  const prefix = String(allowedCliCommandPrefix || "").trim();
  if (!text || !prefix) return false;
  if (text !== prefix && !text.startsWith(`${prefix} `)) return false;
  return isLikelyNetcattyCliShellCommand(text);
}

function buildCodebuddyHooks(
  emitter,
  { toolIntegrationMode, additionalHooks, allowedCliCommandPrefix } = {},
) {
  const makeHook = (hookEventName, extract) => ([{
    hooks: [async (input, _toolUseID, _opts) => {
      try {
        emitter.emitEvent({ type: "hook", hookEvent: hookEventName, ...extract(input) });
      } catch { /* best effort — never block the turn */ }
      return { continue: true };
    }],
  }]);

  const hooks = {
    PreToolUse: [{
      hooks: [async (input, _toolUseID, _opts) => {
        try {
          emitter.emitEvent({
            type: "hook",
            hookEvent: "PreToolUse",
            toolName: input.tool_name,
            toolInput: input.tool_input,
            toolUseId: input.tool_use_id,
          });
        } catch { /* best effort — never block the turn */ }
        if (
          toolIntegrationMode === "skills" &&
          input.tool_name === "Bash" &&
          (
            input.tool_input?.run_in_background === true ||
            !isAllowedCodebuddySkillsBash(
              input.tool_input?.command,
              allowedCliCommandPrefix,
            )
          )
        ) {
          return {
            continue: true,
            decision: "block",
            reason:
              "Only Netcatty CLI commands are allowed in Skills mode. " +
              "Use the netcatty-tool-cli command prefix provided by the host.",
          };
        }
        return { continue: true };
      }],
    }],
    PostToolUse: makeHook("PostToolUse", (input) => ({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id,
    })),
    PostToolUseFailure: makeHook("PostToolUseFailure", (input) => ({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id,
      error: input.error,
    })),
    SessionEnd: makeHook("SessionEnd", (input) => ({
      reason: input.reason,
    })),
    Notification: makeHook("Notification", (input) => ({
      message: input.message,
      title: input.title,
      notificationType: input.notification_type,
    })),
  };
  for (const [eventName, matchers] of Object.entries(additionalHooks || {})) {
    if (!Array.isArray(matchers) || matchers.length === 0) continue;
    hooks[eventName] = [...(hooks[eventName] || []), ...matchers];
  }
  return hooks;
}

// ---------------------------------------------------------------------------
// Elicitation handler (SDK 0.3.230 — interactive confirmations)
// ---------------------------------------------------------------------------

/**
 * Build an elicitation handler that forwards create/complete events to the
 * renderer and waits for the user's decision via a pending-response map.
 * @param {object} emitter  createStreamEmitter(...)
 * @param {Map} pendingMap  Map<elicitationId, { resolve, reject, chatSessionId }> —
 *   shared with the IPC response handler so it can resolve waiting promises.
 * @param {object} [opts]
 * @param {string} [opts.chatSessionId]  chat scope, so cleanup can cancel
 *   pending elicitations when the chat session is torn down.
 * @returns {object} ElicitationHandler
 */
function buildCodebuddyElicitation(emitter, pendingMap, { chatSessionId } = {}) {
  const scopedId = (protocolElicitationId) => {
    const rawId = String(protocolElicitationId || "");
    if (!rawId) return "";
    return chatSessionId
      ? `codebuddy:${encodeURIComponent(String(chatSessionId))}:${encodeURIComponent(rawId)}`
      : rawId;
  };
  return {
    async create(request, { signal } = {}) {
      if (signal?.aborted) {
        return { action: "cancel" };
      }
      const protocolElicitationId = request?._meta?.["codebuddy.ai"]?.elicitationId
        || `elicitation_${randomUUID()}`;
      const elicitationId = scopedId(protocolElicitationId);

      const previous = pendingMap.get(elicitationId);
      if (previous) {
        pendingMap.delete(elicitationId);
        previous.resolve({ action: "cancel" });
      }

      return await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal?.removeEventListener("abort", onAbort);
          if (pendingMap.get(elicitationId) === pending) {
            pendingMap.delete(elicitationId);
          }
        };
        const finish = (response) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(response);
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => finish({ action: "cancel" });
        const pending = { resolve: finish, reject: fail, chatSessionId };
        pendingMap.set(elicitationId, pending);

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
            return;
          }
        }

        try {
          emitter.emitEvent({ type: "elicitation-create", elicitationId, request });
        } catch (error) {
          fail(error);
        }
      });
    },
    complete(notification) {
      const protocolElicitationId = String(notification?.elicitationId || "");
      const elicitationId = scopedId(protocolElicitationId);
      const pending = elicitationId ? pendingMap.get(elicitationId) : null;
      if (pending) {
        pendingMap.delete(elicitationId);
        pending.resolve({ action: "cancel" });
      }
      emitter.emitEvent({
        type: "elicitation-complete",
        notification: {
          ...notification,
          elicitationId,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// MCP server status & account info (SDK 0.3.230)
// ---------------------------------------------------------------------------

/**
 * Query MCP server connection status via the SDK control channel.
 * Returns [] on failure.
 */
async function getCodebuddyMcpStatus({ pathToCodebuddyCode, env, queryFn }) {
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
    return await q.mcpServerStatus();
  } catch {
    return [];
  } finally {
    abortController.abort();
    try { await q.return?.(undefined); } catch { /* best effort */ }
  }
}

/**
 * Query CodeBuddy account info via the SDK control channel.
 * Returns null on failure.
 */
async function getCodebuddyAccountInfo({ pathToCodebuddyCode, env, queryFn }) {
  let query = queryFn;
  if (!query) {
    let sdk;
    try { sdk = await import("@tencent-ai/agent-sdk"); } catch { return null; }
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
    return await q.accountInfo();
  } catch {
    return null;
  } finally {
    abortController.abort();
    try { await q.return?.(undefined); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Plugin management (SDK 0.3.230)
// ---------------------------------------------------------------------------

async function codebuddyInstallPlugin(options) {
  const sdk = await import("@tencent-ai/agent-sdk");
  return sdk.installPlugin(options);
}

async function codebuddyEnablePlugin(name, marketplace) {
  const sdk = await import("@tencent-ai/agent-sdk");
  return sdk.enablePlugin(name, marketplace);
}

async function codebuddyDisablePlugin(name, marketplace) {
  const sdk = await import("@tencent-ai/agent-sdk");
  return sdk.disablePlugin(name, marketplace);
}

async function codebuddyInstallMarketplace(options) {
  const sdk = await import("@tencent-ai/agent-sdk");
  return sdk.installMarketplace(options);
}

async function codebuddyRemoveMarketplace(options) {
  const sdk = await import("@tencent-ai/agent-sdk");
  return sdk.removeMarketplace(options);
}

module.exports = {
  buildCodebuddyQueryOptions,
  buildCodebuddyCanUseTool,
  translateCodebuddyMessage,
  inspectCodebuddyMessageContent,
  codebuddyResultFallbackText,
  classifyCodebuddySpawnError,
  buildCodebuddyPromptInput,
  buildCodebuddyThinkingEnv,
  parseCodebuddyThinking,
  toSdkMcpServers,
  createCodebuddySdkMcpServer,
  runCodebuddyTurn,
  listCodebuddyModels,
  mapCodebuddyModels,
  splitCodebuddyModelSelection,
  codebuddyBuiltinTools,
  buildCodebuddyHooks,
  isAllowedCodebuddySkillsBash,
  buildCodebuddyElicitation,
  getCodebuddyMcpStatus,
  getCodebuddyAccountInfo,
  codebuddyInstallPlugin,
  codebuddyEnablePlugin,
  codebuddyDisablePlugin,
  codebuddyInstallMarketplace,
  codebuddyRemoveMarketplace,
  UI_DISALLOWED_TOOLS,
  MCP_MODE_TOOLS,
  SKILLS_MODE_TOOLS,
};
