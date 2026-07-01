/* eslint-disable no-undef */
function registerAgentProcessHandlers(ctx) {
  with (ctx) {
  const maxCommandTimeoutSeconds = 24 * 60 * 60;
  // ── MCP Server session metadata ──

  ipcMain.handle("netcatty:ai:mcp:update-sessions", async (event, { sessions: sessionList, chatSessionId }) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.updateSessionMetadata(sessionList || [], chatSessionId);
    return { ok: true };
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
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    mcpServerBridge.resolveApprovalFromRenderer(approvalId, approved);
    return { ok: true };
  });
  }
}

module.exports = { registerAgentProcessHandlers };
