"use strict";

/**
 * Build the netcatty-mcp-server config to inject into an SDK agent as an
 * EXTERNAL MCP server. Reuses mcpServerBridge.buildMcpServerConfig (unchanged)
 * so the approval/scope/blocklist layer is identical to the ACP era.
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
  // Only inject when the user picked MCP mode. Skills mode uses the netcatty CLI.
  if (toolIntegrationMode !== "mcp") return [];
  try {
    const mcpPort = await mcpServerBridge.getOrCreateHost();
    const scopedIds = mcpServerBridge.getScopedSessionIds(chatSessionId);
    const netcattyMcpConfig = mcpServerBridge.buildMcpServerConfig(
      mcpPort,
      scopedIds,
      chatSessionId,
    );
    return [netcattyMcpConfig];
  } catch (err) {
    console.error("[sdk] Failed to inject netcatty MCP server:", err?.message || err);
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
