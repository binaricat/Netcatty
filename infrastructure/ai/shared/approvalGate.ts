/**
 * approvalGate — Promise-based approval system for tool execution.
 *
 * Instead of interrupting the SDK stream (needsApproval), tools call
 * `requestApproval()` inside their `execute` function. This returns
 * a Promise that resolves when the user approves/rejects from the UI.
 * The SDK stream stays alive — from the SDK's perspective, the tool
 * execution just takes longer.
 *
 * Also supports MCP/ACP tool calls from the Electron main process:
 * the main process sends an IPC approval request, and we route it
 * through the same listener/UI system.
 *
 * Approvals are scoped by optional chatSessionId to prevent cross-session
 * interference when stopping or cancelling sessions.
 */

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Optional chat session scope — used to clear only relevant approvals on stop */
  chatSessionId?: string;
}

// Pending approval promises keyed by toolCallId (for SDK tool calls)
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void;
  request: ApprovalRequest;
}>();

// Subscribers for approval request events (UI listens here)
type ApprovalRequestListener = (request: ApprovalRequest) => void;
const listeners = new Set<ApprovalRequestListener>();

/**
 * Called from a tool's `execute` function when it needs user approval.
 * Returns a Promise<boolean> that resolves to `true` (approved) or `false` (denied).
 * The UI is notified via the listener system to render approval buttons.
 */
export function requestApproval(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  chatSessionId?: string,
): Promise<boolean> {
  const request: ApprovalRequest = { toolCallId, toolName, args, chatSessionId };

  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(toolCallId, { resolve, request });
    // Notify all UI listeners
    for (const listener of listeners) {
      try { listener(request); } catch { /* ignore listener errors */ }
    }
  });
}

/**
 * Called from the UI when the user approves or rejects a tool execution.
 * Handles both SDK tool calls (local Promise) and MCP tool calls (IPC to main process).
 */
export function resolveApproval(toolCallId: string, approved: boolean): void {
  // SDK tool call: resolve the local Promise
  const entry = pendingApprovals.get(toolCallId);
  if (entry) {
    pendingApprovals.delete(toolCallId);
    entry.resolve(approved);
    return;
  }

  // MCP tool call: forward response to main process via IPC
  if (toolCallId.startsWith('mcp_approval_')) {
    const bridge = (window as unknown as { netcatty?: { respondMcpApproval?: (id: string, approved: boolean) => Promise<unknown> } }).netcatty;
    bridge?.respondMcpApproval?.(toolCallId, approved);
  }
}

/**
 * Subscribe to approval request events. Returns an unsubscribe function.
 */
export function onApprovalRequest(listener: ApprovalRequestListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Replay all currently pending approval requests to a listener.
 * Useful when ChatMessageList remounts after being unmounted — without this,
 * approvals that fired while unmounted would be silently missed and the
 * corresponding execute Promises would hang indefinitely.
 */
export function replayPendingApprovals(listener: ApprovalRequestListener): void {
  for (const [, entry] of pendingApprovals) {
    try { listener(entry.request); } catch { /* ignore */ }
  }
}

/**
 * Check if a specific toolCallId has a pending approval.
 */
export function hasPendingApproval(toolCallId: string): boolean {
  return pendingApprovals.has(toolCallId);
}

/**
 * Clear pending approvals, optionally scoped to a specific chatSessionId.
 * Resolves matching entries with `false` (denied) so execute functions don't hang.
 *
 * When chatSessionId is provided, only approvals belonging to that session
 * are cleared — preventing cross-session interference in concurrent chats.
 * When omitted, all pending approvals are cleared (backward-compatible).
 */
export function clearAllPendingApprovals(chatSessionId?: string): void {
  if (!chatSessionId) {
    // Clear everything (legacy / global stop)
    for (const [, entry] of pendingApprovals) {
      entry.resolve(false);
    }
    pendingApprovals.clear();
    return;
  }

  // Scoped clear: only remove approvals for this chatSessionId
  for (const [id, entry] of pendingApprovals) {
    if (entry.request.chatSessionId === chatSessionId) {
      pendingApprovals.delete(id);
      entry.resolve(false);
    }
  }
}

/**
 * Set up a bridge to receive MCP/ACP approval requests from the Electron main process.
 * Subscribes to IPC events and routes them through the same listener system,
 * so the same ToolCall UI handles both SDK and MCP approvals.
 * Returns an unsubscribe function.
 */
export function setupMcpApprovalBridge(): () => void {
  const bridge = (window as unknown as {
    netcatty?: {
      onMcpApprovalRequest?: (cb: (payload: {
        approvalId: string;
        toolName: string;
        args: Record<string, unknown>;
        chatSessionId?: string;
      }) => void) => () => void;
    };
  }).netcatty;
  if (!bridge?.onMcpApprovalRequest) return () => {};

  return bridge.onMcpApprovalRequest((payload) => {
    const request: ApprovalRequest = {
      toolCallId: payload.approvalId,
      toolName: payload.toolName,
      args: payload.args,
      chatSessionId: payload.chatSessionId,
    };
    // Notify all UI listeners (same as SDK approval flow)
    for (const listener of listeners) {
      try { listener(request); } catch { /* ignore listener errors */ }
    }
  });
}
