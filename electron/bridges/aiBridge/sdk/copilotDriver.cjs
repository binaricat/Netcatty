"use strict";

/**
 * Copilot backend driver — wraps @github/copilot-sdk.
 *
 * new CopilotClient({ connection: RuntimeConnection.forStdio({ path }), useLoggedInUser })
 *   .createSession({ model, onPermissionRequest: approveAll, mcpServers })
 *   .sendAndWait({ prompt }) -> response.data.content
 *
 * - The bundled copilot runtime (@github/copilot) is excluded from packaging
 *   (bring-your-own-CLI), so we MUST point `connection` at the user's system
 *   `copilot` binary via RuntimeConnection.forStdio({ path }) — otherwise the SDK
 *   falls back to the (absent) bundled runtime in the shipped app.
 * - Side effects route through the injected netcatty MCP server (stdio). Approval
 *   is enforced inside netcatty MCP, so the SDK-level permission handler is the
 *   SDK's `approveAll` (the real gate is netcatty MCP's approval IPC).
 *
 * 🔬 SMOKE-CALIBRATE [copilot-stream]: sendAndWait returns only the final
 *   assistant text. A follow-up can subscribe via session.on(handler) to stream
 *   text + per-tool-call events (assistant.message / tool execution events).
 */
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

// Neutral client options. The real CopilotClient options (with RuntimeConnection)
// are assembled in runCopilotTurn, because RuntimeConnection comes from the SDK
// module which is loaded via dynamic import().
function buildCopilotClientOptions({ cliPath, gitHubToken }) {
  const options = {};
  if (cliPath) options.cliPath = cliPath;
  if (gitHubToken) options.gitHubToken = gitHubToken;
  return options;
}

function toCopilotMcpServers(injectedMcpServers) {
  const map = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name) continue;
    map[cfg.name] = {
      // Local subprocess MCP server (MCPStdioServerConfig). 'stdio' is the
      // SDK's canonical value for local/subprocess servers.
      type: "stdio",
      command: cfg.command,
      args: cfg.args || [],
      env: mcpEnvPairsToObject(cfg.env),
      tools: ["*"],
    };
  }
  return map;
}

function buildCopilotSessionOptions({ model, injectedMcpServers }) {
  // onPermissionRequest is wired in runCopilotTurn (it needs the SDK's approveAll).
  const options = {
    mcpServers: toCopilotMcpServers(injectedMcpServers),
  };
  if (model) options.model = model;
  return options;
}

function extractCopilotContent(response) {
  return (response && response.data && response.data.content) || "";
}

/** Extract a display string from a tool.execution_complete event's data. */
function extractCopilotResultText(data) {
  if (!data) return "";
  if (data.error && data.error.message) return String(data.error.message);
  const result = data.result;
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b.text === "string" ? b.text : (b == null ? "" : JSON.stringify(b))))
      .join("");
  }
  return typeof result === "object" ? JSON.stringify(result) : String(result);
}

/**
 * Translate one copilot SessionEvent into emitter calls — gives copilot the same
 * live tool-card + thinking-panel UX as codex/claude (it previously showed only
 * the final text). `state` ({ reasoningOpen, streamedText }) threads the thinking
 * block and records whether any delta streamed, so runCopilotTurn can fall back
 * to the final consolidated message when the runtime emits no deltas.
 * Event shapes calibrated against @github/copilot-sdk generated session-events.
 */
function translateCopilotEvent(event, emitter, state) {
  if (!event || typeof event !== "object") return;
  const st = state || {};
  const data = event.data || {};
  const closeReasoning = () => {
    if (st.reasoningOpen) { emitter.reasoningEnd(); st.reasoningOpen = false; }
  };
  switch (event.type) {
    case "assistant.reasoning_delta":
      if (data.deltaContent) { emitter.reasoning(data.deltaContent); st.reasoningOpen = true; }
      return;
    case "assistant.message_delta":
      if (data.deltaContent) { closeReasoning(); emitter.text(data.deltaContent); st.streamedText = true; }
      return;
    case "tool.execution_start":
      closeReasoning();
      emitter.toolCall(data.toolName || data.mcpToolName || "tool", data.arguments || {}, data.toolCallId);
      return;
    case "tool.execution_complete":
      emitter.toolResult(data.toolCallId, extractCopilotResultText(data), undefined);
      return;
    default:
      // assistant.message (final consolidated text) is intentionally ignored —
      // text arrives via message_delta (or the runCopilotTurn fallback). Other
      // events (turn start/end, usage, state changes) have no UI mapping.
      return;
  }
}

/**
 * Run a Copilot turn (保底同步形态 via sendAndWait).
 * @param {object} args
 * @param {string} args.prompt
 * @param {object} args.clientOptions   buildCopilotClientOptions(...) (neutral: {cliPath, gitHubToken})
 * @param {object} args.sessionOptions  buildCopilotSessionOptions(...) ({model, mcpServers})
 * @param {object} args.emitter
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.sdkModule] inject the @github/copilot-sdk module (for tests)
 */
async function runCopilotTurn({ prompt, clientOptions, sessionOptions, resumeSessionId, emitter, signal, sdkModule }) {
  const sdk = sdkModule || (await import("@github/copilot-sdk"));
  const { CopilotClient, RuntimeConnection, approveAll } = sdk;

  // Assemble the real CopilotClient options: point at the user's system CLI
  // (the bundled runtime is excluded from packaging) and authenticate as the
  // logged-in user (gh CLI / stored OAuth).
  const realClientOptions = { useLoggedInUser: true };
  if (clientOptions?.cliPath && RuntimeConnection?.forStdio) {
    realClientOptions.connection = RuntimeConnection.forStdio({ path: clientOptions.cliPath });
  }
  if (clientOptions?.gitHubToken) realClientOptions.gitHubToken = clientOptions.gitHubToken;

  let client = null;
  let sessionId = resumeSessionId || null;
  try {
    client = new CopilotClient(realClientOptions);
    const sessionConfig = {
      ...sessionOptions,
      // Auto-approve at the SDK boundary; netcatty MCP performs the real gating.
      onPermissionRequest: approveAll,
    };
    // Resume the prior conversation so context carries ACROSS turns (incl. after
    // a Stop). Always (re)apply sessionConfig so the FRESH netcatty MCP server
    // config — its current port/token/chat-session id — is used, not the stale
    // one from the resumed session. Fall back to a fresh session if there's no id
    // yet or the resume fails (session expired/deleted).
    let session;
    if (resumeSessionId && typeof client.resumeSession === "function") {
      try {
        session = await client.resumeSession(resumeSessionId, sessionConfig);
      } catch {
        session = await client.createSession(sessionConfig);
      }
    } else {
      session = await client.createSession(sessionConfig);
    }
    // Emit the resumable session id IMMEDIATELY — before the blocking sendAndWait
    // — so a mid-turn Stop can't lose it; the next turn resumes this conversation.
    sessionId = session.sessionId || sessionId;
    if (sessionId) emitter.sessionId(sessionId);
    if (signal?.aborted) return { sessionId };

    // Stream tool calls + text/reasoning deltas in real time (parity with
    // codex/claude — copilot previously showed only the final text). on() gets
    // every SessionEvent; streamDeltas enables assistant.message_delta /
    // assistant.reasoning_delta; tool.execution_* events arrive regardless.
    const state = { reasoningOpen: false, streamedText: false };
    let unsubscribe = () => {};
    if (typeof session.on === "function") {
      unsubscribe = session.on((ev) => translateCopilotEvent(ev, emitter, state));
    }
    let final;
    try {
      final = await session.sendAndWait({ prompt, streamDeltas: true });
    } finally {
      try { unsubscribe(); } catch { /* best effort */ }
    }
    if (state.reasoningOpen) emitter.reasoningEnd();

    // Fallback: if nothing streamed (older runtime / streamDeltas unsupported),
    // emit the final consolidated text so the turn isn't silent.
    if (!state.streamedText) {
      const content = extractCopilotContent(final);
      if (content) emitter.text(content);
      if (!content && !signal?.aborted) {
        emitter.emitError(
          "Copilot returned an empty response. Run `copilot` once to log in, or `gh auth login`.",
        );
        return { sessionId };
      }
    }
    emitter.emitDone();
    return { sessionId };
  } catch (error) {
    const code = error && error.code;
    const msg = String((error && error.message) || error || "");
    if (code === "ENOENT" || /ENOENT/i.test(msg)) {
      emitter.emitError(
        "Copilot CLI not found. Install with `npm i -g @github/copilot` and run `gh auth login`.",
      );
    } else {
      emitter.emitError(msg || "Copilot turn failed");
    }
    return { sessionId };
  } finally {
    try { await client?.stop?.(); } catch { /* best effort */ }
  }
}

/** Map copilot-sdk ModelInfo[] -> renderer preset shape {id,name}. */
function mapCopilotModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m && m.id)
    .map((m) => ({ id: m.id, name: m.name || m.id }));
}

/**
 * Fetch available Copilot models via client.start() + client.listModels().
 * Returns [] on failure (the caller falls back to the UI's curated presets).
 * @param {object} args
 * @param {string} [args.cliPath]
 * @param {object} [args.sdkModule] inject the @github/copilot-sdk module (for tests)
 */
async function listCopilotModels({ cliPath, sdkModule }) {
  const sdk = sdkModule || (await import("@github/copilot-sdk"));
  const { CopilotClient, RuntimeConnection } = sdk;
  const clientOptions = { useLoggedInUser: true };
  if (cliPath && RuntimeConnection?.forStdio) {
    clientOptions.connection = RuntimeConnection.forStdio({ path: cliPath });
  }
  const client = new CopilotClient(clientOptions);
  try {
    await client.start();
    return mapCopilotModels(await client.listModels());
  } finally {
    try { await client.stop(); } catch { /* best effort */ }
  }
}

module.exports = {
  buildCopilotClientOptions,
  buildCopilotSessionOptions,
  toCopilotMcpServers,
  extractCopilotContent,
  extractCopilotResultText,
  translateCopilotEvent,
  runCopilotTurn,
  listCopilotModels,
  mapCopilotModels,
};
