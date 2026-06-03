"use strict";

/**
 * Codex backend driver — wraps @openai/codex-sdk.
 *
 * new Codex({ codexPathOverride, env, apiKey, config }).startThread({...}).runStreamed(...)
 * - sandbox:'read-only' blocks local writes; side effects must go through the
 *   injected netcatty MCP server (config.mcp_servers).
 * - thread.id is the resumable session id; codex.resumeThread(id) continues it.
 *
 * 🔬 SMOKE-CALIBRATE [codex-path]: verify the exact constructor field for the
 *   binary path override; we set codexPathOverride AND env.PATH for safety.
 * 🔬 SMOKE-CALIBRATE [codex-items]: verify item.* field names for
 *   command_execution / mcp_tool_call against real output.
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

function buildCodexTurnOptions({ cwd, model }) {
  const turn = { sandbox: "read-only" };
  if (cwd) turn.cwd = cwd;
  if (model) turn.model = model;
  return turn;
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
      // 🔬 SMOKE-CALIBRATE [codex-items]: confirm command/output field names.
      const cmd = item.command || item.parsed_cmd || "";
      emitter.toolCall("shell", { command: cmd }, item.id);
      if (item.aggregated_output || item.output) {
        emitter.toolResult(item.id, item.aggregated_output || item.output, "shell");
      }
      return;
    }
    case "mcp_tool_call": {
      // 🔬 SMOKE-CALIBRATE [codex-items]: confirm server/tool/arguments/result names.
      const toolName = item.tool || item.name || "mcp_tool";
      emitter.toolCall(toolName, item.arguments || item.input || {}, item.id);
      const result = item.result ?? item.output;
      const out = typeof result === "string" ? result : JSON.stringify(result ?? "");
      emitter.toolResult(item.id, out, toolName);
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
 * @param {object} args.turnOptions         buildCodexTurnOptions(...)
 * @param {object} args.threadOptions       { workingDirectory, skipGitRepoCheck }
 * @param {string} [args.resumeThreadId]
 * @param {object} args.emitter
 * @param {AbortSignal} [args.signal]
 * @param {Function} [args.CodexCtor]       inject Codex class (for tests)
 */
async function runCodexTurn({
  prompt, constructorOptions, turnOptions, threadOptions, resumeThreadId, emitter, signal, CodexCtor,
}) {
  const Codex = CodexCtor || (await import("@openai/codex-sdk")).Codex;
  let threadId = null;
  try {
    const codex = new Codex(constructorOptions);
    const thread = resumeThreadId
      ? codex.resumeThread(resumeThreadId)
      : codex.startThread(threadOptions);

    const { events } = await thread.runStreamed(prompt, turnOptions);
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
  buildCodexTurnOptions,
  translateCodexEvent,
  runCodexTurn,
  toCodexMcpConfig,
};
