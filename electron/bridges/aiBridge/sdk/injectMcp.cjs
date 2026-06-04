"use strict";

/**
 * Build the netcatty-mcp-server config to inject into an SDK agent as an
 * EXTERNAL MCP server. Reuses mcpServerBridge.buildMcpServerConfig (unchanged)
 * so the approval/scope/blocklist layer is identical across integrations.
 *
 * Returns an array of netcatty MCP server configs (0 or 1 entry):
 *   { name, type:'stdio', command, args, env:[{name,value}, ...] }
 * Each driver converts this neutral shape into its SDK's MCP format.
 */
async function buildInjectedMcpServers({
  mcpServerBridge,
  chatSessionId,
  toolIntegrationMode,
}) {
  try {
    // Start the netcatty control host for BOTH modes. getOrCreateHost binds the
    // TCP server and writes the netcatty-tool-cli discovery file on bind:
    //   - mcp mode: the host is injected below as an MCP server.
    //   - skills mode: the agent reaches the host through that discovery file via
    //     the netcatty CLI. Skipping this in skills mode left no host for the CLI
    //     to find, so every `netcatty-tool-cli` call failed with APP_NOT_RUNNING.
    const mcpPort = await mcpServerBridge.getOrCreateHost();
    // Skills mode drives the netcatty CLI, not an injected MCP server.
    if (toolIntegrationMode !== "mcp") return [];
    const scopedIds = mcpServerBridge.getScopedSessionIds(chatSessionId);
    const netcattyMcpConfig = mcpServerBridge.buildMcpServerConfig(
      mcpPort,
      scopedIds,
      chatSessionId,
    );
    return [netcattyMcpConfig];
  } catch (err) {
    console.error("[sdk] Failed to ensure netcatty host / inject MCP server:", err?.message || err);
    return [];
  }
}

/**
 * Convert the neutral env-pair array ([{name,value}]) used by
 * buildMcpServerConfig into a plain {KEY:VALUE} object, which is what the
 * claude/codex/copilot SDKs expect for an MCP server's env field.
 */
function mcpEnvPairsToObject(envPairs) {
  const out = {};
  if (Array.isArray(envPairs)) {
    for (const pair of envPairs) {
      if (pair && typeof pair.name === "string" && typeof pair.value === "string") {
        out[pair.name] = pair.value;
      }
    }
  }
  return out;
}

module.exports = { buildInjectedMcpServers, mcpEnvPairsToObject };
