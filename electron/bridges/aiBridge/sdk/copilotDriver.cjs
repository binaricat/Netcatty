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
async function runCopilotTurn({ prompt, clientOptions, sessionOptions, emitter, signal, sdkModule }) {
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
  try {
    client = new CopilotClient(realClientOptions);
    const session = await client.createSession({
      ...sessionOptions,
      // Auto-approve at the SDK boundary; netcatty MCP performs the real gating.
      onPermissionRequest: approveAll,
    });
    if (signal?.aborted) return {};
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
