"use strict";

/**
 * Pi POC backend driver — wraps @earendil-works/pi-coding-agent.
 *
 * Pi does not ship native MCP support. Netcatty exposes its scoped MCP server as
 * Pi custom tools instead, and disables Pi's built-in local read/write/edit/bash
 * tools so side effects stay behind Netcatty's approval/scope/blocklist layer.
 */
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

const PI_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_PI_MODEL = "anthropic/claude-sonnet-4-5";

function isPiImageAttachment(attachment) {
  return Boolean(
    attachment &&
    PI_IMAGE_MEDIA_TYPES.has(String(attachment.mediaType || "").toLowerCase()) &&
    attachment.base64Data,
  );
}

function buildPiPromptContent(prompt, attachments) {
  const imageAttachments = Array.isArray(attachments)
    ? attachments.filter(isPiImageAttachment)
    : [];
  if (imageAttachments.length === 0) return String(prompt || "");

  return [
    { type: "text", text: String(prompt || "") },
    ...imageAttachments.map((attachment) => ({
      type: "image",
      data: attachment.base64Data,
      mimeType: String(attachment.mediaType).toLowerCase(),
    })),
  ];
}

function parsePiModelSelection(model) {
  const raw = String(model || "").trim();
  if (!raw) return { provider: null, modelId: null, thinkingLevel: undefined };
  const segments = raw.split("/").filter(Boolean);
  let thinkingLevel;
  if (segments.length > 1 && PI_THINKING_LEVELS.has(segments[segments.length - 1])) {
    thinkingLevel = segments.pop();
  }
  if (segments.length < 2) {
    return { provider: null, modelId: raw, thinkingLevel };
  }
  return {
    provider: segments.shift(),
    modelId: segments.join("/"),
    thinkingLevel,
  };
}

function getPiModelId(model) {
  if (!model || typeof model !== "object") return "";
  const provider = model.provider || model.providerId || model.providerID || "";
  const id = model.id || model.model || model.modelId || model.modelID || "";
  return provider && id ? `${provider}/${id}` : String(id || "");
}

async function resolvePiModelSelection(sdk, model, options = {}) {
  const parsed = parsePiModelSelection(model);
  if (!parsed.provider || !parsed.modelId || !sdk?.ModelRegistry || !sdk?.AuthStorage) {
    return { model: undefined, thinkingLevel: parsed.thinkingLevel };
  }

  const registry = options.modelRegistry
    || sdk.ModelRegistry.create(sdk.AuthStorage.create());
  registry.refresh?.();
  const resolved = registry.find(parsed.provider, parsed.modelId);
  if (!resolved) {
    return { model: undefined, thinkingLevel: parsed.thinkingLevel };
  }
  return { model: resolved, thinkingLevel: parsed.thinkingLevel };
}

function mapPiModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((model) => {
      const id = getPiModelId(model);
      if (!id) return null;
      return {
        id,
        name: model.name || id,
        description: model.description,
      };
    })
    .filter(Boolean);
}

function buildPiCreateAgentSessionOptions({
  cwd,
  model,
  thinkingLevel,
  customTools,
  modelRegistry,
  sessionManager,
  sdk,
} = {}) {
  const options = {
    cwd,
    // Disable Pi's local built-ins (read/bash/edit/write/grep/find/ls). Netcatty
    // capability tools are registered below as custom tools.
    noTools: "builtin",
    customTools: Array.isArray(customTools) ? customTools : [],
    tools: Array.isArray(customTools) ? customTools.map((tool) => tool.name).filter(Boolean) : [],
    sessionStartEvent: {
      type: "session_start",
      cwd: cwd || process.cwd(),
      mode: "sdk",
      source: "netcatty",
    },
  };
  if (model) options.model = model;
  if (thinkingLevel && thinkingLevel !== "off") options.thinkingLevel = thinkingLevel;
  if (modelRegistry) options.modelRegistry = modelRegistry;
  if (sessionManager) options.sessionManager = sessionManager;
  else if (sdk?.SessionManager?.inMemory) options.sessionManager = sdk.SessionManager.inMemory(cwd || process.cwd());
  return options;
}

function getPiEventAssistantStreamEvent(event) {
  if (event?.assistantMessageEvent) return event.assistantMessageEvent;
  if (event?.event && typeof event.event === "object") return event.event;
  return null;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content == null) return "";
    return typeof content === "object" ? JSON.stringify(content) : String(content);
  }
  return content
    .map((block) => {
      if (!block) return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.thinking === "string") return block.thinking;
      if (block.type === "image") return "[image]";
      return JSON.stringify(block);
    })
    .join("");
}

function emitPiToolCallOnce(event, emitter, state) {
  const toolCall = event?.toolCall
    || event?.assistantMessageEvent?.toolCall
    || event?.assistantMessageEvent?.partial?.content?.[event?.assistantMessageEvent?.contentIndex]
    || null;
  const toolCallId = event?.toolCallId || toolCall?.id;
  if (!toolCallId) return false;
  state.toolCalls = state.toolCalls || new Set();
  if (state.toolCalls.has(toolCallId)) return false;
  state.toolCalls.add(toolCallId);
  emitter.toolCall(
    event?.toolName || toolCall?.name || "tool",
    event?.args || toolCall?.arguments || {},
    toolCallId,
  );
  return true;
}

function emitPiToolResultOnce(event, emitter, state) {
  const toolCallId = event?.toolCallId || event?.message?.toolCallId;
  if (!toolCallId) return false;
  state.toolResults = state.toolResults || new Set();
  if (state.toolResults.has(toolCallId)) return false;
  state.toolResults.add(toolCallId);
  emitter.toolResult(
    toolCallId,
    contentToText(event?.result?.content ?? event?.result ?? event?.message?.content),
    event?.toolName || event?.message?.toolName,
  );
  return true;
}

function closePiReasoning(emitter, state) {
  if (!state.reasoningOpen) return;
  emitter.reasoningEnd?.();
  state.reasoningOpen = false;
}

function translatePiSessionEvent(event, emitter, state = {}) {
  if (!event || typeof event !== "object") return { content: false, error: false, done: false };

  if (event.type === "session_info_changed" && event.name) {
    emitter.status(`Pi session: ${event.name}`);
    return { content: false, error: false, done: false };
  }
  if (event.type === "compaction_start") {
    emitter.status(`Pi compaction started (${event.reason || "unknown"})`);
    return { content: true, error: false, done: false };
  }
  if (event.type === "compaction_end") {
    emitter.status(
      event.errorMessage
        ? `Pi compaction failed: ${event.errorMessage}`
        : `Pi compaction finished (${event.reason || "unknown"})`,
    );
    return { content: true, error: Boolean(event.errorMessage), done: false };
  }
  if (event.type === "auto_retry_start") {
    emitter.status(`Pi retry ${event.attempt}/${event.maxAttempts}`);
    return { content: true, error: false, done: false };
  }

  const assistantEvent = getPiEventAssistantStreamEvent(event);
  if (assistantEvent) {
    if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
      closePiReasoning(emitter, state);
      emitter.text(assistantEvent.delta);
      return { content: true, error: false, done: false };
    }
    if (assistantEvent.type === "thinking_delta" && assistantEvent.delta) {
      emitter.reasoning(assistantEvent.delta);
      state.reasoningOpen = true;
      return { content: true, error: false, done: false };
    }
    if (assistantEvent.type === "thinking_end") {
      closePiReasoning(emitter, state);
      return { content: false, error: false, done: false };
    }
    if (assistantEvent.type === "toolcall_end") {
      closePiReasoning(emitter, state);
      emitPiToolCallOnce({ ...event, toolCall: assistantEvent.toolCall }, emitter, state);
      return { content: true, error: false, done: false };
    }
  }

  if (event.type === "tool_execution_start") {
    closePiReasoning(emitter, state);
    emitPiToolCallOnce(event, emitter, state);
    return { content: true, error: false, done: false };
  }
  if (event.type === "tool_execution_end") {
    closePiReasoning(emitter, state);
    emitPiToolCallOnce(event, emitter, state);
    emitPiToolResultOnce(event, emitter, state);
    return { content: true, error: Boolean(event.isError), done: false };
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    closePiReasoning(emitter, state);
    if (event.message.errorMessage) {
      emitter.emitError(event.message.errorMessage);
      return { content: true, error: true, done: false };
    }
    return { content: false, error: false, done: false };
  }
  if (event.type === "agent_end") {
    closePiReasoning(emitter, state);
    return { content: false, error: false, done: true };
  }
  return { content: false, error: false, done: false };
}

function normalizeToolParameters(inputSchema) {
  if (inputSchema && typeof inputSchema === "object" && inputSchema.type === "object") {
    return inputSchema;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function mcpResultToText(result) {
  if (result == null) return "";
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) return "";
        if (typeof block.text === "string") return block.text;
        if (block.type === "image") return "[image]";
        if (block.type === "resource") return JSON.stringify(block.resource || block);
        return JSON.stringify(block);
      })
      .join("");
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

async function createDefaultMcpClient(cfg) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  const client = new Client({ name: "netcatty-pi-driver", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args || [],
    env: { ...process.env, ...mcpEnvPairsToObject(cfg.env) },
  });
  await client.connect(transport);
  return {
    async listTools() {
      return client.listTools();
    },
    async callTool(args) {
      return client.callTool(args);
    },
    async close() {
      await client.close();
    },
  };
}

function buildPiToolName(serverName, toolName) {
  return `mcp__${String(serverName || "netcatty").replace(/[^A-Za-z0-9_-]/g, "_")}__${String(toolName || "tool").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

async function buildPiMcpToolDefinitions(injectedMcpServers, options = {}) {
  const tools = [];
  const clients = [];
  const createMcpClient = options.createMcpClient || createDefaultMcpClient;

  for (const cfg of injectedMcpServers || []) {
    if (!cfg?.name || !cfg?.command) continue;
    const client = await createMcpClient(cfg);
    clients.push(client);
    const listed = await client.listTools();
    for (const tool of listed?.tools || []) {
      if (!tool?.name) continue;
      const piToolName = buildPiToolName(cfg.name, tool.name);
      tools.push({
        name: piToolName,
        label: tool.title || tool.name,
        description: tool.description || `Call Netcatty MCP tool ${tool.name}`,
        promptSnippet: `${piToolName}: ${tool.description || "Netcatty capability tool"}`,
        parameters: normalizeToolParameters(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          if (signal?.aborted) {
            return { content: [{ type: "text", text: "Tool call aborted." }], isError: true };
          }
          const result = await client.callTool({ name: tool.name, arguments: params || {} });
          return {
            content: [{ type: "text", text: mcpResultToText(result) }],
            details: result,
            isError: Boolean(result?.isError),
          };
        },
      });
    }
  }

  return {
    tools,
    async cleanup() {
      await Promise.all(clients.map((client) => Promise.resolve().then(() => client.close?.()).catch(() => {})));
    },
  };
}

function applyTemporaryProcessEnv(env) {
  if (!env || typeof env !== "object") return () => {};
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withTemporaryProcessEnv(env, fn) {
  const restore = applyTemporaryProcessEnv(env);
  try {
    return await fn();
  } finally {
    restore();
  }
}

function formatPiErrorForUser(error) {
  const message = String(error?.message || error || "");
  if (/Cannot find package|ERR_MODULE_NOT_FOUND|not installed/i.test(message)) {
    return "Pi SDK not installed. Run: npm install @earendil-works/pi-coding-agent";
  }
  if (/api.?key|auth|credential|login|unauthorized/i.test(message)) {
    return "Pi authentication failed. Run `pi` in a terminal and use /login, or configure a supported provider API key for Pi.";
  }
  return message || "Pi turn failed";
}

async function runPiTurn({
  prompt, attachments, cwd, model, env, injectedMcpServers, emitter, abortController,
  createAgentSessionFn, buildMcpToolsFn, sdkModule, modelRegistry,
}) {
  let sdk = sdkModule;
  if (!sdk) {
    try { sdk = await import("@earendil-works/pi-coding-agent"); } catch (error) {
      emitter.emitError(formatPiErrorForUser(error));
      return { sessionId: null };
    }
  }

  let session = null;
  let unsubscribe = null;
  let removeAbortListener = null;
  let sessionId = null;
  let hasContent = false;
  let failed = false;
  const state = {};

  return withTemporaryProcessEnv(env, async () => {
    const mcpTools = await (buildMcpToolsFn || buildPiMcpToolDefinitions)(injectedMcpServers);
    try {
      const resolvedModel = await resolvePiModelSelection(sdk, model, { modelRegistry });
      const options = buildPiCreateAgentSessionOptions({
        cwd: cwd || process.cwd(),
        model: resolvedModel.model,
        thinkingLevel: resolvedModel.thinkingLevel,
        customTools: mcpTools.tools,
        modelRegistry,
        sdk,
      });
      const createAgentSession = createAgentSessionFn || sdk.createAgentSession;
      const created = await createAgentSession(options);
      session = created?.session || created;
      if (!session || typeof session.sendUserMessage !== "function") {
        throw new Error("Pi SDK did not create a usable AgentSession");
      }
      if (created?.modelFallbackMessage) emitter.status(created.modelFallbackMessage);

      sessionId = session.sessionId || session.sessionManager?.getSessionId?.() || null;
      emitter.sessionId(sessionId);
      unsubscribe = session.subscribe?.((event) => {
        const result = translatePiSessionEvent(event, emitter, state);
        if (result.content) hasContent = true;
        if (result.error) failed = true;
      });

      if (abortController?.signal) {
        const onAbort = () => { void session.abort?.(); };
        abortController.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => abortController.signal.removeEventListener("abort", onAbort);
      }

      await session.sendUserMessage(buildPiPromptContent(prompt, attachments));

      if (!hasContent && !failed && !abortController?.signal?.aborted) {
        emitter.emitError("Pi returned an empty response. Run `pi` in a terminal to configure authentication and models.");
        return { sessionId: null };
      }
      if (!failed && !abortController?.signal?.aborted) emitter.emitDone();
      // Do not return a resumable session id yet: the POC uses an in-memory Pi
      // session and Netcatty replays chat history for continuity on each turn.
      return { sessionId: null };
    } catch (error) {
      failed = true;
      emitter.emitError(formatPiErrorForUser(error));
      return { sessionId: null };
    } finally {
      removeAbortListener?.();
      try { unsubscribe?.(); } catch {}
      try { session?.dispose?.(); } catch {}
      await mcpTools.cleanup?.();
    }
  });
}

async function listPiModels({ env, sdkModule, modelRegistry } = {}) {
  let sdk = sdkModule;
  if (!sdk) {
    try { sdk = await import("@earendil-works/pi-coding-agent"); } catch { return { currentModelId: null, models: [] }; }
  }
  try {
    return await withTemporaryProcessEnv(env, async () => {
      const registry = modelRegistry || sdk.ModelRegistry.create(sdk.AuthStorage.create());
      registry.refresh?.();
      const models = typeof registry.getAvailable === "function"
        ? registry.getAvailable()
        : registry.getAll?.() || [];
      return { currentModelId: null, models: mapPiModels(models) };
    });
  } catch {
    return { currentModelId: null, models: [] };
  }
}

module.exports = {
  DEFAULT_PI_MODEL,
  buildPiCreateAgentSessionOptions,
  buildPiMcpToolDefinitions,
  buildPiPromptContent,
  buildPiToolName,
  contentToText,
  formatPiErrorForUser,
  listPiModels,
  mapPiModels,
  mcpResultToText,
  parsePiModelSelection,
  resolvePiModelSelection,
  runPiTurn,
  translatePiSessionEvent,
};
