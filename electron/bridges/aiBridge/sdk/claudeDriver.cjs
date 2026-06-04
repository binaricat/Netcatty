"use strict";

/**
 * Claude backend driver — wraps @anthropic-ai/claude-agent-sdk query().
 *
 * - Spawns the user's system `claude` binary via an ABSOLUTE pathToClaudeCodeExecutable
 *   (SDK existsSync-checks it; PATH is not resolved — issue #205).
 * - Repairs ~/.claude.json before spawn (ensureClaudeConfig).
 * - Bypasses the SDK's built-in permission system and BLOCKS built-in
 *   side-effect tools so the agent can only act through the injected netcatty
 *   MCP server (approval/scope/blocklist enforced there).
 * - Translates SDK messages into the canonical renderer event protocol.
 */
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");
const { ensureClaudeConfig } = require("./claudeConfig.cjs");

// Built-in tools that need interactive UI netcatty doesn't provide - they would
// hang the turn waiting for a response, so they are blocked in BOTH modes.
const UI_DISALLOWED_TOOLS = ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"];

// Whitelist Claude built-ins instead of trying to track every local-capable
// built-in tool the CLI may add over time. MCP tools remain available through
// mcpServers; this only controls Claude Code's own local-machine tools.
const MCP_MODE_TOOLS = [];
const SKILLS_MODE_TOOLS = ["Bash", "Skill"];
const CLAUDE_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isClaudeImageAttachment(attachment) {
  return Boolean(
    attachment &&
    CLAUDE_IMAGE_MEDIA_TYPES.has(String(attachment.mediaType || "").toLowerCase()) &&
    attachment.base64Data,
  );
}

/**
 * Resolve built-in tools for the active tool-integration mode.
 * - "skills": only Bash + Skill so the Netcatty CLI skill can run.
 * - "mcp" (default): no Claude built-in local tools, forcing remote actions
 *   through netcatty MCP.
 */
function claudeBuiltinTools(toolIntegrationMode) {
  return toolIntegrationMode === "skills"
    ? [...SKILLS_MODE_TOOLS]
    : [...MCP_MODE_TOOLS];
}

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

/**
 * Normalize the user-supplied claude `settings` value: a settings.json path
 * (string) or inline JSON ("{...}" -> object). Returns undefined when empty.
 * This is INDEPENDENT of CLAUDE_CONFIG_DIR (which supplies credentials + the
 * base settings layer) — `settings` is an additional override the SDK merges on
 * top, so the two coexist.
 */
function parseClaudeSettings(settings) {
  if (settings == null) return undefined;
  if (typeof settings === "object") return settings;
  const str = String(settings).trim();
  if (!str) return undefined;
  if (str.startsWith("{")) {
    try { return JSON.parse(str); } catch { return str; }
  }
  return str;
}

function buildClaudeQueryOptions({
  cwd, model, env, pathToClaudeCodeExecutable, abortController, injectedMcpServers, settings, resume,
  toolIntegrationMode,
}) {
  const options = {
    cwd,
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    // Required companion to permissionMode:'bypassPermissions' (the SDK rejects
    // the bypass without it). Netcatty blocks Claude's direct local read/write
    // tools and routes remote-session actions through MCP or Skills+CLI, where
    // Netcatty enforces approval/scope.
    allowDangerouslySkipPermissions: true,
    tools: claudeBuiltinTools(toolIntegrationMode),
    disallowedTools: [...UI_DISALLOWED_TOOLS],
    mcpServers: toSdkMcpServers(injectedMcpServers),
    env,
    abortController,
  };
  if (model) options.model = model;
  // Resume the prior session so context carries ACROSS turns. Without this the
  // SDK starts a fresh session every turn (full amnesia). The session id is
  // emitted on system-init (before any turn work), so a mid-turn Stop can't lose
  // it and the next turn resumes correctly. undefined => fresh session.
  if (resume) options.resume = resume;
  // ABSOLUTE path only (SDK does not resolve PATH). undefined => SDK auto-discovery.
  if (pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  }
  // Optional settings.json path / inline object — additive to CLAUDE_CONFIG_DIR.
  const parsedSettings = parseClaudeSettings(settings);
  if (parsedSettings !== undefined) options.settings = parsedSettings;
  return options;
}

/**
 * Translate one SDK message into emitter calls.
 * NOTE: with includePartialMessages, streamed text arrives via stream_event;
 * the consolidated assistant TEXT block is skipped to avoid duplication, but
 * assistant TOOL_USE blocks are the authoritative source for tool calls.
 */
function translateClaudeMessage(message, emitter) {
  if (!message || typeof message !== "object") return;
  const type = message.type;

  if (type === "system" && message.subtype === "init" && message.session_id) {
    emitter.sessionId(message.session_id);
    return;
  }

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
      if (block?.type === "tool_use") {
        emitter.toolCall(block.name, block.input || {}, block.id);
      }
      // text blocks intentionally skipped (already streamed via stream_event)
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
  // 'result' carries final usage/cost — handled by the run loop, no per-event emit.
}

/** Classify a spawn failure. SDK wraps spawn ENOENT as a message string. */
function classifyClaudeSpawnError(error) {
  const code = error && error.code;
  const msg = String((error && error.message) || error || "");
  const isSpawnEnoent =
    code === "ENOENT" ||
    /native binary not found/i.test(msg) ||
    /ENOENT/i.test(msg);
  return { isSpawnEnoent, message: msg };
}

function buildClaudePromptInput(prompt, attachments) {
  const imageAttachments = Array.isArray(attachments)
    ? attachments.filter(isClaudeImageAttachment)
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

  return (async function* claudePromptInput() {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  }());
}

/**
 * Run a Claude turn. Streams events via `emitter`, resolves with { sessionId }.
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array<object>} [args.attachments]
 * @param {object} args.options  result of buildClaudeQueryOptions
 * @param {object} args.emitter  createStreamEmitter(...)
 * @param {Function} [args.queryFn] inject @anthropic-ai/claude-agent-sdk query (for tests)
 */
async function runClaudeTurn({ prompt, attachments, options, emitter, queryFn }) {
  ensureClaudeConfig();
  let query = queryFn;
  if (!query) {
    let sdk;
    try { sdk = await import("@anthropic-ai/claude-agent-sdk"); } catch { emitter.emitError("Claude Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk"); return { sessionId: null }; }
    query = sdk.query;
  }
  const promptInput = buildClaudePromptInput(prompt, attachments);

  let sessionId = null;
  let hasContent = false;
  try {
    const stream = query({ prompt: promptInput, options });
    for await (const message of stream) {
      if (options.abortController?.signal?.aborted) break;
      if (message?.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
      }
      if (
        message?.type === "stream_event" ||
        (message?.type === "assistant" && Array.isArray(message?.message?.content) && message.message.content.length > 0)
      ) {
        hasContent = true;
      }
      translateClaudeMessage(message, emitter);
    }
    if (!hasContent && !options.abortController?.signal?.aborted) {
      emitter.emitError(
        "Claude returned an empty response. Run `claude` in a terminal to log in, " +
        "or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.",
      );
      return { sessionId };
    }
    emitter.emitDone();
    return { sessionId };
  } catch (error) {
    const classified = classifyClaudeSpawnError(error);
    if (classified.isSpawnEnoent) {
      emitter.emitError(
        `Claude Code binary not found or not runnable (${options.pathToClaudeCodeExecutable || "auto-discovery"}). ` +
        "Install with `npm i -g @anthropic-ai/claude-code` and ensure it's on PATH.",
      );
    } else {
      emitter.emitError(classified.message || "Claude turn failed");
    }
    return { sessionId };
  }
}

/** Map claude-agent-sdk ModelInfo[] -> renderer preset shape {id,name,description}. */
function mapClaudeModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m && m.value)
    .map((m) => ({ id: m.value, name: m.displayName || m.value, description: m.description }));
}

/**
 * Fetch available Claude models via the SDK control channel. Opens a streaming
 * (idle) session so no turn is billed, asks supportedModels(), then tears down.
 * Returns [] on failure (the caller falls back to the UI's curated presets).
 * @param {object} args
 * @param {string} [args.pathToClaudeCodeExecutable]
 * @param {object} [args.env]
 * @param {Function} [args.queryFn] inject query() for tests
 */
async function listClaudeModels({ pathToClaudeCodeExecutable, env, queryFn }) {
  ensureClaudeConfig();
  let query = queryFn;
  if (!query) {
    let sdk;
    try { sdk = await import("@anthropic-ai/claude-agent-sdk"); } catch { return []; }
    query = sdk.query;
  }
  const abortController = new AbortController();
  // Idle streaming input: keeps the session open (init handshake completes)
  // without sending a turn, so supportedModels() resolves; then we abort.
  async function* idleInput() {
    await new Promise((resolve) => {
      if (abortController.signal.aborted) return resolve();
      abortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  const q = query({
    prompt: idleInput(),
    options: { pathToClaudeCodeExecutable, env, abortController, includePartialMessages: false },
  });
  try {
    return mapClaudeModels(await q.supportedModels());
  } finally {
    abortController.abort();
    try { await q.return?.(undefined); } catch { /* best effort */ }
  }
}

module.exports = {
  buildClaudeQueryOptions,
  parseClaudeSettings,
  translateClaudeMessage,
  classifyClaudeSpawnError,
  buildClaudePromptInput,
  runClaudeTurn,
  listClaudeModels,
  mapClaudeModels,
  claudeBuiltinTools,
  UI_DISALLOWED_TOOLS,
  MCP_MODE_TOOLS,
  SKILLS_MODE_TOOLS,
  toSdkMcpServers,
};
