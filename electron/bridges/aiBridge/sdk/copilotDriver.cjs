"use strict";

/**
 * Copilot backend driver — wraps @github/copilot-sdk.
 *
 * new CopilotClient({ cliPath }).createSession({ model, onPermissionRequest, mcpServers })
 *   .sendAndWait({ prompt })
 * - Side effects routed through the injected netcatty MCP server (type:'local'
 *   stdio). Approval is enforced inside netcatty MCP, so the SDK-level
 *   permission callback auto-approves (approveAll-style).
 *
 * 🔬 SMOKE-CALIBRATE [copilot-stream]: replace sendAndWait with the streaming
 *   API + per-event tool-call translation once the callback shape is confirmed.
 */
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

function buildCopilotClientOptions({ cliPath, cliUrl, githubToken }) {
  const options = {};
  if (cliPath) options.cliPath = cliPath;
  if (cliUrl) options.cliUrl = cliUrl;
  if (githubToken) options.githubToken = githubToken;
  return options;
}

function toCopilotMcpServers(injectedMcpServers) {
  const map = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name) continue;
    map[cfg.name] = {
      type: "local",
      command: cfg.command,
      args: cfg.args || [],
      env: mcpEnvPairsToObject(cfg.env),
      tools: ["*"],
    };
  }
  return map;
}

function buildCopilotSessionOptions({ model, injectedMcpServers }) {
  // Auto-approve at the SDK boundary; netcatty MCP does the real gating.
  const onPermissionRequest = async () => ({ approved: true });
  const options = {
    onPermissionRequest,
    mcpServers: toCopilotMcpServers(injectedMcpServers),
  };
  if (model) options.model = model;
  return options;
}

function extractCopilotContent(response) {
  return (response && response.data && response.data.content) || "";
}

/**
 * Run a Copilot turn (保底同步形态).
 * @param {object} args
 * @param {string} args.prompt
 * @param {object} args.clientOptions   buildCopilotClientOptions(...)
 * @param {object} args.sessionOptions  buildCopilotSessionOptions(...)
 * @param {object} args.emitter
 * @param {AbortSignal} [args.signal]
 * @param {Function} [args.CopilotClientCtor] inject CopilotClient (for tests)
 */
async function runCopilotTurn({ prompt, clientOptions, sessionOptions, emitter, signal, CopilotClientCtor }) {
  const { CopilotClient } = CopilotClientCtor
    ? { CopilotClient: CopilotClientCtor }
    : await import("@github/copilot-sdk");

  let client = null;
  try {
    client = new CopilotClient(clientOptions);
    const session = await client.createSession(sessionOptions);
    if (signal?.aborted) return {};
    // 🔬 SMOKE-CALIBRATE [copilot-stream]: prefer streaming once shape confirmed.
    const response = await session.sendAndWait({ prompt });
    const content = extractCopilotContent(response);
    if (content) emitter.text(content);
    if (!content && !signal?.aborted) {
      emitter.emitError(
        "Copilot returned an empty response. Run `copilot` once to log in, or `gh auth login`.",
      );
      return {};
    }
    emitter.emitDone();
    return {};
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
    return {};
  } finally {
    try { await client?.stop?.(); } catch { /* best effort */ }
  }
}

module.exports = {
  buildCopilotClientOptions,
  buildCopilotSessionOptions,
  toCopilotMcpServers,
  extractCopilotContent,
  runCopilotTurn,
};
