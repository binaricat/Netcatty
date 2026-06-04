"use strict";

/**
 * Codex backend driver — wraps @openai/codex-sdk.
 *
 * new Codex({ codexPathOverride, env, apiKey, config }).startThread({...}).runStreamed(...)
 * - sandbox:'read-only' blocks local writes; side effects must go through the
 *   injected netcatty MCP server (config.mcp_servers).
 * - thread.id is the resumable session id; codex.resumeThread(id) continues it.
 *
 * Constructor/event field names are calibrated against @openai/codex-sdk's type
 * defs (CodexOptions.codexPathOverride; AgentMessageItem / CommandExecutionItem /
 * McpToolCallItem). `env` is also passed so the binary resolves on PATH. Live
 * smoke confirms end-to-end behavior.
 */
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

function toCodexMcpConfig(injectedMcpServers) {
  const mcp_servers = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name) continue;
    mcp_servers[cfg.name] = {
      command: cfg.command,
      args: cfg.args || [],
      env: mcpEnvPairsToObject(cfg.env),
    };
  }
  return mcp_servers;
}

function buildCodexConstructorOptions({ codexPath, env, apiKey, injectedMcpServers, baseUrl }) {
  const options = {
    env,
    config: { mcp_servers: toCodexMcpConfig(injectedMcpServers) },
  };
  if (codexPath) options.codexPathOverride = codexPath; // 🔬 SMOKE-CALIBRATE [codex-path]
  if (apiKey) options.apiKey = apiKey;
  if (baseUrl) options.baseUrl = baseUrl;
  return options;
}

// codex-sdk reasoning-effort levels.
const CODEX_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function buildCodexThreadOptions({ cwd, model }) {
  // model + sandboxMode + workingDirectory belong to ThreadOptions (startThread).
  // runStreamed's TurnOptions only accepts { outputSchema, signal }, so passing
  // them there (the previous behavior) silently dropped both model selection and
  // the read-only sandbox.
  //
  // approvalPolicy:"never" is codex's analog of claude's permissionMode
  // "bypassPermissions" and copilot's approveAll: the migration delegates ALL
  // gating to the injected netcatty MCP server (approval/scope/blocklist). It
  // maps to `--config approval_policy="never"`. Without it, non-interactive
  // `codex exec` has no channel to satisfy an approval request, so netcatty MCP
  // tool calls (e.g. get_environment) stall and the model reports them as
  // "cancelled". This is independent of the sandbox: codex spawns MCP servers as
  // session infrastructure OUTSIDE the per-command sandbox, so read-only does not
  // block the server's loopback callback to the main process — it only blocks
  // codex's own local writes (side effects must go through the netcatty server).
  const opts = { sandboxMode: "read-only", approvalPolicy: "never", skipGitRepoCheck: true };
  if (cwd) opts.workingDirectory = cwd;
  if (model) {
    // The renderer encodes codex reasoning effort as "<modelId>/<effort>"
    // (e.g. "gpt-5.5/high"). codex-sdk wants them as separate ThreadOptions.
    // Only split when the trailing segment is a real effort — custom/OpenRouter
    // model ids may legitimately contain "/".
    const slash = model.lastIndexOf("/");
    const effort = slash > 0 ? model.slice(slash + 1) : "";
    if (slash > 0 && CODEX_REASONING_EFFORTS.has(effort)) {
      opts.model = model.slice(0, slash);
      opts.modelReasoningEffort = effort;
    } else {
      opts.model = model;
    }
  }
  return opts;
}

/**
 * Extract a display string from a Codex mcp_tool_call item.
 * Calibrated against @openai/codex-sdk McpToolCallItem: successful calls carry
 * `result.content` as an MCP ContentBlock[] (text blocks); failures carry
 * `error.message`.
 */
function extractMcpResultText(item) {
  if (item.error && item.error.message) return String(item.error.message);
  const content = item.result && item.result.content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b.text === "string" ? b.text : (b == null ? "" : JSON.stringify(b))))
      .join("");
  }
  if (item.result != null) return JSON.stringify(item.result);
  return "";
}

/** Translate one Codex ThreadEvent into emitter calls. */
function translateCodexEvent(event, emitter) {
  if (!event || typeof event !== "object") return;

  if (event.type === "turn.failed") {
    emitter.emitError(event.error?.message || "Codex turn failed");
    return;
  }
  if (event.type !== "item.completed" || !event.item) return;

  const item = event.item;
  switch (item.type) {
    case "agent_message":
      if (item.text) emitter.text(item.text);
      return;
    case "reasoning":
      // 🔬 SMOKE-CALIBRATE [codex-items]: confirm reasoning item field (text/summary).
      if (item.text) emitter.text(item.text);
      return;
    case "command_execution": {
      // Calibrated against @openai/codex-sdk CommandExecutionItem (command +
      // aggregated_output).
      emitter.toolCall("shell", { command: item.command || "" }, item.id);
      if (item.aggregated_output) {
        emitter.toolResult(item.id, item.aggregated_output, "shell");
      }
      return;
    }
    case "mcp_tool_call": {
      // Calibrated against @openai/codex-sdk McpToolCallItem (tool + arguments;
      // result.content is an MCP ContentBlock[], errors carry .message).
      const toolName = item.tool || "mcp_tool";
      emitter.toolCall(toolName, item.arguments || {}, item.id);
      emitter.toolResult(item.id, extractMcpResultText(item), toolName);
      return;
    }
    default:
      return;
  }
}

/**
 * Run a Codex turn.
 * @param {object} args
 * @param {string} args.prompt
 * @param {object} args.constructorOptions  buildCodexConstructorOptions(...)
 * @param {object} args.threadOptions       buildCodexThreadOptions(...) — model / sandboxMode / workingDirectory
 * @param {string} [args.resumeThreadId]
 * @param {object} args.emitter
 * @param {AbortSignal} [args.signal]
 * @param {Function} [args.CodexCtor]       inject Codex class (for tests)
 */
async function runCodexTurn({
  prompt, constructorOptions, threadOptions, resumeThreadId, emitter, signal, CodexCtor,
}) {
  const Codex = CodexCtor || (await import("@openai/codex-sdk")).Codex;
  let threadId = null;
  try {
    const codex = new Codex(constructorOptions);
    // ThreadOptions (model + read-only sandbox + cwd) must be applied on resume too.
    const thread = resumeThreadId
      ? codex.resumeThread(resumeThreadId, threadOptions)
      : codex.startThread(threadOptions);

    const { events } = await thread.runStreamed(prompt, signal ? { signal } : undefined);
    let hasContent = false;
    for await (const event of events) {
      if (signal?.aborted) break;
      if (event?.type === "item.completed") hasContent = true;
      translateCodexEvent(event, emitter);
    }
    threadId = thread.id || resumeThreadId || null;
    if (threadId) emitter.sessionId(threadId);
    if (!hasContent && !signal?.aborted) {
      emitter.emitError(
        "Codex returned an empty response. Reconnect Codex in Settings -> AI (codex login), " +
        "or configure a provider in ~/.codex/config.toml.",
      );
      return { threadId };
    }
    emitter.emitDone();
    return { threadId };
  } catch (error) {
    const code = error && error.code;
    const msg = String((error && error.message) || error || "");
    if (code === "ENOENT" || /ENOENT/i.test(msg)) {
      emitter.emitError(
        "Codex binary not found. Install with `npm i -g @openai/codex` (or `brew install --cask codex`).",
      );
    } else {
      emitter.emitError(msg || "Codex turn failed");
    }
    return { threadId };
  }
}

module.exports = {
  buildCodexConstructorOptions,
  buildCodexThreadOptions,
  translateCodexEvent,
  runCodexTurn,
  toCodexMcpConfig,
};
