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
        scopedAttachments.delete(chatSessionId);
        preserveIdleSessionCleanup?.(chatSessionId);
        clearOpenedSessionScope?.(chatSessionId);
        cancelledChatSessions.delete(chatSessionId);
        cancelBackgroundJobsForSession(chatSessionId);
        cancelWorkerBackgroundJobsForSession(chatSessionId);
        // Cancel-and-cleanup leave the owner's jobs running only when a live
        // branch still inherited them. Record which jobs were deferred like
        // that: once the last inheritor chat is deleted, the deferred job
        // has no live chat left to poll or stop it and must be cancelled.
        markOwnerTornDownInheritedJobs?.(chatSessionId);
        // Resolve any in-flight approval requests so dispatch()'s finally block
        // releases its pendingSessionWriteApprovals entry. Without this, a chat
        // deleted while an approval was pending would leave the per-session
        // write lock held until the approval timeout expires.
        clearPendingApprovals(chatSessionId);
        await cancelSftpOpsForSession(chatSessionId);
        sftpBridge.clearSftpEncodingStateByPrefix?.(`chat:${chatSessionId}:session:`);
        // The chat is gone: drop any background-job inheritance it registered
        // (it can no longer poll or stop those jobs). Owner-owned jobs that a
        // different live branch still inherited keep their remaining
        // inheritors, so they stay under the still-live branch's control.
        forgetInheritedJobsForChatSession?.(chatSessionId);
      }
    }

    return { resolveMcpServerRuntimeCommand, buildMcpServerConfig, cleanupScopedMetadata };
  }
}

module.exports = { createConfigAndCleanupApi };
