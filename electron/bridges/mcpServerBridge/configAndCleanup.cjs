/* eslint-disable no-undef */
function createConfigAndCleanupApi(ctx) {
  with (ctx) {
    function resolveMcpServerRuntimeCommand() {
      const runtimeCommand = process.execPath;
      const runtimeEnv = [];
    
      if (runtimeCommand && existsSync(runtimeCommand)) {
        const basename = path.basename(runtimeCommand).toLowerCase();
        const isNodeBinary = basename === "node" || basename.startsWith("node.");
        if (!isNodeBinary) {
          runtimeEnv.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
        }
        return { command: runtimeCommand, env: runtimeEnv };
      }
    
      return { command: "node", env: runtimeEnv };
    }
    
    function buildMcpServerConfig(port, scopedSessionIds, chatSessionId) {
      // Use provided scoped IDs, or resolve them from chatSessionId.
      const effectiveIds = (scopedSessionIds && scopedSessionIds.length > 0)
        ? scopedSessionIds
        : getScopedSessionIds(chatSessionId);
    
      const runtimePath = toUnpackedAsarPath(
        path.join(__dirname, "..", "mcp", "netcatty-mcp-server.cjs"),
      );
      const runtime = resolveMcpServerRuntimeCommand();
    
      const env = [
        ...runtime.env,
        { name: "NETCATTY_MCP_PORT", value: String(port) },
      ];
    
      if (authToken) {
        env.push({ name: "NETCATTY_MCP_TOKEN", value: authToken });
      }
      if (DEBUG_MCP) {
        env.push({ name: "NETCATTY_MCP_DEBUG", value: "1" });
      }
    
      // When chatSessionId is present, the MCP subprocess resolves scope dynamically
      // through main-process metadata, so avoid freezing session IDs at spawn time.
      if (!chatSessionId && effectiveIds && effectiveIds.length > 0) {
        env.push({ name: "NETCATTY_MCP_SESSION_IDS", value: effectiveIds.join(",") });
      }
    
      // Pass chatSessionId so MCP server can scope getContext responses
      if (chatSessionId) {
        env.push({ name: "NETCATTY_MCP_CHAT_SESSION_ID", value: chatSessionId });
      }
    
      // Pass permission mode so MCP server can enforce it locally (defense-in-depth)
      env.push({ name: "NETCATTY_MCP_PERMISSION_MODE", value: permissionMode });
    
      return {
        name: "netcatty-remote-hosts",
        type: "stdio",
        command: runtime.command,
        args: [runtimePath],
        env,
      };
    }
    
    // ── Cleanup ──
    
    async function cleanupScopedMetadata(chatSessionId) {
      if (chatSessionId) {
        scopedMetadata.delete(chatSessionId);
        cancelledChatSessions.delete(chatSessionId);
        cancelBackgroundJobsForSession(chatSessionId);
        // Resolve any in-flight approval requests so dispatch()'s finally block
        // releases its pendingSessionWriteApprovals entry. Without this, a chat
        // deleted while an approval was pending would leave the per-session
        // write lock held until the approval timeout expires.
        clearPendingApprovals(chatSessionId);
        await cancelSftpOpsForSession(chatSessionId);
        sftpBridge.clearSftpEncodingStateByPrefix?.(`chat:${chatSessionId}:session:`);
      }
    }

    return { resolveMcpServerRuntimeCommand, buildMcpServerConfig, cleanupScopedMetadata };
  }
}

module.exports = { createConfigAndCleanupApi };
