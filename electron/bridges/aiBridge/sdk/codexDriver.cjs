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

function isImageAttachment(attachment) {
  return Boolean(
    attachment &&
    typeof attachment.filePath === "string" &&
    attachment.filePath.length > 0 &&
    String(attachment.mediaType || "").toLowerCase().startsWith("image/"),
  );
}

function buildCodexPromptInput(prompt, attachments) {
  const imageAttachments = Array.isArray(attachments)
    ? attachments.filter(isImageAttachment)
    : [];
  if (imageAttachments.length === 0) return String(prompt || "");

  return [
    { type: "text", text: String(prompt || "") },
    ...imageAttachments.map((attachment) => ({
      type: "local_image",
      path: attachment.filePath,
    })),
  ];
}

function toCodexMcpConfig(injectedMcpServers, { defaultToolsApprovalMode } = {}) {
  const mcp_servers = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name) continue;
    mcp_servers[cfg.name] = {
      command: cfg.command,
      args: cfg.args || [],
      env: mcpEnvPairsToObject(cfg.env),
      ...(defaultToolsApprovalMode
        ? { default_tools_approval_mode: defaultToolsApprovalMode }
        : {}),
    };
  }
  return mcp_servers;
}

function buildCodexConstructorOptions({ codexPath, env, apiKey, injectedMcpServers, baseUrl }) {
  const options = {
    env,
    config: {
      mcp_servers: toCodexMcpConfig(injectedMcpServers),
      // Force codex to emit reasoning SUMMARY items in the JSON stream. The
      // default ("auto") emits nothing in non-interactive `codex exec` (measured:
      // 0 summaries across runs), so the thinking panel went empty after the SDK
      // migration. "concise" restores visible step-by-step reasoning reliably
      // (measured: a summary on every reasoning turn) at the right altitude for a
      // terminal assistant — "detailed" is richer but noisier and less reliable.
      model_reasoning_summary: "concise",
    },
  };
  if (codexPath) options.codexPathOverride = codexPath; // 🔬 SMOKE-CALIBRATE [codex-path]
  if (apiKey) options.apiKey = apiKey;
  if (baseUrl) options.baseUrl = baseUrl;
  return options;
}

// codex-sdk reasoning-effort levels (GPT-5.6 also advertises max/ultra).
const CODEX_REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function parseCodexModelSelection(model) {
  const value = String(model || "");
  const slash = value.lastIndexOf("/");
  const effort = slash > 0 ? value.slice(slash + 1) : "";
  if (slash > 0 && CODEX_REASONING_EFFORTS.has(effort)) {
    return { model: value.slice(0, slash), effort };
  }
  return { model: value || undefined, effort: undefined };
}

function buildCodexThreadOptions({ cwd, model }) {
  // model + sandboxMode + workingDirectory belong to ThreadOptions (startThread).
  // runStreamed's TurnOptions only accepts { outputSchema, signal }, so passing
  // them there (the previous behavior) silently dropped both model selection and
  // the read-only sandbox.
  //
  // Non-interactive `codex exec` CANCELS every MCP tool call ("user cancelled
  // MCP tool call", failing in 0ns before the server is even invoked) unless
  // approvals are fully bypassed. Empirically (tested across all sandbox ×
  // approval combos) the ONLY combo that lets injected netcatty MCP tools run is
  // sandbox "danger-full-access" + approvalPolicy "never" — i.e. codex's
  // `--dangerously-bypass-approvals-and-sandbox`. read-only and workspace-write
  // both cancel under every approval policy, because codex wants an interactive
  // approver for MCP calls and exec has no channel to answer one.
  //
  // Safe for netcatty's model: the REAL guardrails (approval prompts, command
  // blocklist, observer/confirm permission modes, session scope) are enforced by
  // the injected netcatty MCP server on every remote-host action — NOT by codex's
  // local sandbox. claude blocks its built-in side-effect tools via
  // disallowedTools and copilot is MCP-only; codex-sdk exposes no tool-disable
  // switch, so the sandbox is the only lever and it has to be fully open for the
  // MCP path to work at all.
  const opts = { sandboxMode: "danger-full-access", approvalPolicy: "never", skipGitRepoCheck: true };
  if (cwd) opts.workingDirectory = cwd;
  if (model) {
    // The renderer encodes codex reasoning effort as "<modelId>/<effort>"
    // (e.g. "gpt-5.5/high"). codex-sdk wants them as separate ThreadOptions.
    // Only split when the trailing segment is a real effort — custom/OpenRouter
    // model ids may legitimately contain "/".
    const selection = parseCodexModelSelection(model);
    opts.model = selection.model;
    if (selection.effort) opts.modelReasoningEffort = selection.effort;
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

function ensureStateSet(state, key) {
  if (!state[key]) state[key] = new Set();
  return state[key];
}

function ensureStateMap(state, key) {
  if (!state[key]) state[key] = new Map();
  return state[key];
}

function emitCodexReasoning(item, emitter, state) {
  if (!item || typeof item.text !== "string" || !item.text) return;
  const textById = ensureStateMap(state, "reasoningTextById");
  const itemId = item.id || "__default_reasoning";
  const previous = textById.get(itemId) || "";
  const delta = item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text;
  textById.set(itemId, item.text);
  if (delta) {
    emitter.reasoning(delta);
    state.reasoningOpen = true;
  }
}

function emitCodexToolCallOnce(item, emitter, state, toolName, args) {
  if (!item || !item.id) return false;
  const emittedToolCalls = ensureStateSet(state, "emittedToolCalls");
  if (emittedToolCalls.has(item.id)) return false;
  emittedToolCalls.add(item.id);
  emitter.toolCall(toolName, args || {}, item.id);
  return true;
}

function emitCodexToolResultOnce(item, emitter, state, output, toolName) {
  if (!item || !item.id) return false;
  const emittedToolResults = ensureStateSet(state, "emittedToolResults");
  if (emittedToolResults.has(item.id)) return false;
  emittedToolResults.add(item.id);
  emitter.toolResult(item.id, output || "", toolName);
  return true;
}

/**
 * Codex emits mid-turn `type:"error"` JSONL events while it reconnects after a
 * dropped SSE/response body (`Reconnecting...`, `retrying N/M`). Those are
 * recoverable — the same turn keeps producing items afterward. Treating them
 * as fatal settles the Netcatty sidebar turn and stops UI refresh while the CLI
 * process continues (issue #2456).
 *
 * Explicit `willRetry: false` / `will_retry: false` means Codex exhausted its
 * retry budget — always fatal, even when the message still mentions stream /
 * transport wording. Truly terminal failures also arrive as `turn.failed`.
 */
function isCodexRetryableStreamError(event) {
  if (!event || typeof event !== "object") return false;
  if (event.willRetry === false || event.will_retry === false) return false;
  if (event.willRetry === true || event.will_retry === true) return true;
  const message = String(event.message || "").toLowerCase();
  if (!message) return false;
  return /\breconnecting\b/.test(message) || /\bretrying\b/.test(message);
}

/**
 * Translate one Codex ThreadEvent into emitter calls.
 * `state` ({ reasoningOpen }) is threaded across events so reasoning summary
 * items render as a single collapsible thinking panel that closes when the first
 * non-reasoning content (assistant message / tool call) arrives.
 */
function translateCodexEvent(event, emitter, state) {
  if (!event || typeof event !== "object") return;
  const st = state || {};
  const closeReasoning = () => {
    if (st.reasoningOpen) { emitter.reasoningEnd(); st.reasoningOpen = false; }
  };

  if (event.type === "turn.failed") {
    closeReasoning();
    st.fatalError = true;
    emitter.emitError(event.error?.message || "Codex turn failed");
    return;
  }
  if (event.type === "error") {
    const message = event.message || "Codex stream failed";
    if (isCodexRetryableStreamError(event)) {
      // Keep reasoning open — the turn is still in progress after Codex retries.
      const warningCount = (st.streamWarningCount = (st.streamWarningCount || 0) + 1);
      emitter.warning(`codex-stream-error:${warningCount}`, message);
      return;
    }
    closeReasoning();
    st.fatalError = true;
    emitter.emitError(message);
    return;
  }
  if (event.type === "turn.completed") {
    const usage = event.usage;
    const hasUsage = usage && [
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.output_tokens,
      usage.reasoning_output_tokens,
    ].some((value) => Number.isFinite(value));
    if (!hasUsage) return;
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    emitter.usage({
      inputTokens,
      cachedInputTokens: Number(usage.cached_input_tokens) || 0,
      outputTokens,
      reasoningTokens: Number(usage.reasoning_output_tokens) || 0,
      totalTokens: inputTokens + outputTokens,
    });
    return;
  }
  if (!["item.started", "item.updated", "item.completed"].includes(event.type) || !event.item) return;

  const item = event.item;

  // Reasoning summary items feed the thinking panel. Codex may update the same
  // item with cumulative text before completion, so emit only the new suffix.
  if (item.type === "reasoning") {
    emitCodexReasoning(item, emitter, st);
    return;
  }

  closeReasoning();

  switch (item.type) {
    case "agent_message":
      if (event.type === "item.completed" && item.text) emitter.text(item.text);
      return;
    case "command_execution": {
      // Calibrated against @openai/codex-sdk CommandExecutionItem (command +
      // aggregated_output).
      emitCodexToolCallOnce(item, emitter, st, "shell", { command: item.command || "" });
      if (event.type === "item.completed" && item.aggregated_output) {
        emitCodexToolResultOnce(item, emitter, st, item.aggregated_output, "shell");
      }
      return;
    }
    case "mcp_tool_call": {
      // Calibrated against @openai/codex-sdk McpToolCallItem (tool + arguments;
      // result.content is an MCP ContentBlock[], errors carry .message).
      const toolName = item.tool || "mcp_tool";
      emitCodexToolCallOnce(item, emitter, st, toolName, item.arguments || {});
      if (event.type === "item.completed") {
        emitCodexToolResultOnce(item, emitter, st, extractMcpResultText(item), toolName);
      }
      return;
    }
    case "file_change":
      if (event.type === "item.completed") {
        emitter.fileChange(
          item.id,
          Array.isArray(item.changes) ? item.changes : [],
          item.status === "failed" ? "failed" : "completed",
        );
      }
      return;
    case "web_search":
      emitter.webSearch(
        item.id,
        item.query || "",
        event.type === "item.completed" ? "completed" : "running",
      );
      return;
    case "todo_list":
      emitter.planUpdate(
        item.id,
        Array.isArray(item.items) ? item.items : [],
        event.type === "item.completed" ? "completed" : "running",
      );
      return;
    case "error":
      if (event.type === "item.completed") {
        emitter.warning(item.id, item.message || "Codex reported a recoverable error");
      }
      return;
    default:
      return;
  }
}

/**
 * Run a Codex turn.
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array<object>} [args.attachments]
 * @param {object} args.constructorOptions  buildCodexConstructorOptions(...)
 * @param {object} args.threadOptions       buildCodexThreadOptions(...) — model / sandboxMode / workingDirectory
 * @param {string} [args.resumeThreadId]
 * @param {object} args.emitter
 * @param {AbortSignal} [args.signal]
 * @param {Function} [args.CodexCtor]       inject Codex class (for tests)
 */
async function runCodexTurn({
  prompt, attachments, constructorOptions, threadOptions, resumeThreadId, emitter, signal, CodexCtor,
}) {
  const Codex = CodexCtor || (await import("@openai/codex-sdk")).Codex;
  const promptInput = buildCodexPromptInput(prompt, attachments);
  let threadId = null;
  try {
    const codex = new Codex(constructorOptions);
    // ThreadOptions (model + read-only sandbox + cwd) must be applied on resume too.
    const thread = resumeThreadId
      ? codex.resumeThread(resumeThreadId, threadOptions)
      : codex.startThread(threadOptions);

    const { events } = await thread.runStreamed(promptInput, signal ? { signal } : undefined);
    let hasContent = false;
    const state = { reasoningOpen: false };
    for await (const event of events) {
      // Capture + emit the resumable thread id as EARLY as possible — it exists
      // the moment `thread.started` arrives (the first event). Emitting it only at
      // the END of the turn (the old behavior) meant a mid-turn Stop never
      // persisted it, so the NEXT turn opened a fresh thread and the whole session
      // lost its memory. Verified: codex resume survives an aborted turn, so
      // preserving the id is enough to keep context across a Stop.
      if (!threadId) {
        const tid = thread.id || (event && event.type === "thread.started" ? event.thread_id : null);
        if (tid) { threadId = tid; emitter.sessionId(threadId); }
      }
      if (signal?.aborted) break;
      if (event?.type === "item.completed") hasContent = true;
      translateCodexEvent(event, emitter, state);
      if (state.fatalError) break;
    }
    if (state.reasoningOpen) emitter.reasoningEnd();
    if (!threadId) {
      threadId = thread.id || resumeThreadId || null;
      if (threadId) emitter.sessionId(threadId);
    }
    if (state.fatalError) {
      return { threadId };
    }
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
  buildCodexPromptInput,
  parseCodexModelSelection,
  translateCodexEvent,
  runCodexTurn,
  toCodexMcpConfig,
};
