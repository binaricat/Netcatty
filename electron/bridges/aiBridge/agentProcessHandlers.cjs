/* eslint-disable no-undef */
function registerAgentProcessHandlers(ctx) {
  with (ctx) {
  const maxCommandTimeoutSeconds = 24 * 60 * 60;
  // ── MCP Server session metadata ──

  ipcMain.handle("netcatty:ai:mcp:update-sessions", async (event, { sessions: sessionList, chatSessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const list = Array.isArray(sessionList) ? sessionList : [];
    const externalId = mcpServerBridge.EXTERNAL_MCP_CHAT_SESSION_ID;
    if (chatSessionId === externalId) {
      // App-wide External MCP scope is owned by the main-window full-session sync.
      // Reject writes while disabled so in-flight renderer pushes cannot resurrect
      // metadata after stopActiveRuntime cleared the scope.
      try {
        const external = typeof getExternalMcpController === "function"
          ? getExternalMcpController()
          : null;
        if (!external?.isEnabled?.()) {
          return { ok: false, error: "External MCP is disabled" };
        }
      } catch {
        return { ok: false, error: "External MCP is unavailable" };
      }
    }
    mcpServerBridge.updateSessionMetadata(list, chatSessionId);
    return { ok: true, count: list.length };
  });

  // Merge (do not replace) session metadata into a chat scope. Used when agents
  // open a host mid-turn so terminal tools can target the new sessionId
  // without waiting for the next full scope push.
  ipcMain.handle("netcatty:ai:mcp:merge-sessions", async (event, { sessions: sessionList, chatSessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    if (!chatSessionId || typeof chatSessionId !== "string") {
      return { ok: false, error: "chatSessionId is required" };
    }
    const list = Array.isArray(sessionList) ? sessionList : [];
    const externalId = mcpServerBridge.EXTERNAL_MCP_CHAT_SESSION_ID;
    if (chatSessionId === externalId) {
      try {
        const external = typeof getExternalMcpController === "function"
          ? getExternalMcpController()
          : null;
        if (!external?.isEnabled?.()) {
          return { ok: false, error: "External MCP is disabled" };
        }
      } catch {
        return { ok: false, error: "External MCP is unavailable" };
      }
    }
    return mcpServerBridge.mergeSessionMetadata(list, chatSessionId);
  });

  ipcMain.handle("netcatty:ai:mcp:update-attachments", async (event, { attachments, chatSessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.updateAttachmentMetadata(attachments || [], chatSessionId);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-command-blocklist", async (event, { blocklist }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    // Validate: must be an array of strings, each a valid regex pattern
    if (!Array.isArray(blocklist)) {
      return { ok: false, error: "blocklist must be an array" };
    }
    const validPatterns = [];
    for (const pattern of blocklist) {
      if (typeof pattern !== "string") continue;
      try {
        new RegExp(pattern, "i"); // Validate regex
        validPatterns.push(pattern);
      } catch {
        // Skip invalid regex patterns silently
      }
    }
    mcpServerBridge.setCommandBlocklist(validPatterns);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-command-timeout", async (event, { timeout }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const value = Number(timeout);
    if (!Number.isFinite(value) || value < 1 || value > maxCommandTimeoutSeconds) {
      return { ok: false, error: `timeout must be a number between 1 and ${maxCommandTimeoutSeconds}` };
    }
    mcpServerBridge.setCommandTimeout(value);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-max-iterations", async (event, { maxIterations }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const value = Number(maxIterations);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      return { ok: false, error: "maxIterations must be a number between 1 and 100" };
    }
    mcpServerBridge.setMaxIterations(value);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-permission-mode", async (event, { mode }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const validModes = ["observer", "confirm", "auto"];
    if (!validModes.includes(mode)) {
      return { ok: false, error: `mode must be one of: ${validModes.join(", ")}` };
    }
    mcpServerBridge.setPermissionMode(mode);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:set-tool-integration-mode", async (event, { mode }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const validModes = ["mcp", "skills"];
    if (!validModes.includes(mode)) {
      return { ok: false, error: `mode must be one of: ${validModes.join(", ")}` };
    }
    setToolIntegrationMode(mode);
    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:mcp:sync-permission-grants", async (event, { grants }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.setPermissionGrants(grants);
    return { ok: true, count: mcpServerBridge.getPermissionGrants().length };
  });

  // ── MCP Approval response (renderer → main) ──
  ipcMain.handle("netcatty:ai:mcp:approval-response", async (event, { approvalId, approved }) => {
    // Settings window also hosts External MCP approval cards.
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.resolveApprovalFromRenderer(approvalId, approved);
    return { ok: true };
  });
  }
}

module.exports = { registerAgentProcessHandlers };
