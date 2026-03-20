/**
 * approvalGate — Promise-based approval system for tool execution.
 *
 * Tools call `requestApproval()` inside their `execute` function. This returns
 * a Promise that resolves when the user approves/rejects from the UI, or after
 * a timeout (default 5 minutes) to prevent indefinite hangs.
 *
 * Also supports MCP/ACP tool calls from the Electron main process:
 * the main process sends an IPC approval request, and we route it
 * through the same listener/UI system. MCP approvals are stored in
 * the same pendingApprovals map so they survive ChatMessageList
 * unmount/remount cycles via replayPendingApprovals().
 *
 * Approvals are scoped by optional chatSessionId to prevent cross-session
 * interference when stopping or cancelling sessions.
 */

/** Default timeout for unanswered approval prompts (5 minutes). */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Optional chat session scope — used to clear only relevant approvals on stop */
  chatSessionId?: string;
}

// Pending approval entries keyed by toolCallId.
// SDK approvals have a real `resolve` callback; MCP approvals use a no-op
// (the real resolution goes via IPC in resolveApproval).
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void;
  request: ApprovalRequest;
}>();

// Subscribers for approval request events (UI listens here)
type ApprovalRequestListener = (request: ApprovalRequest) => void;
const listeners = new Set<ApprovalRequestListener>();

// Subscribers for approval cleared/removed events (UI listens to clean up cards)
type ApprovalClearedListener = (toolCallIds: string[]) => void;
const clearedListeners = new Set<ApprovalClearedListener>();

/**
 * Called from a tool's `execute` function when it needs user approval.
 * Returns a Promise<boolean> that resolves to `true` (approved) or `false` (denied).
 * The UI is notified via the listener system to render approval buttons.
 *
 * If the user does not respond within `timeoutMs` (default 5 minutes), the
 * approval is auto-denied to prevent the session from hanging indefinitely.
 */
export function requestApproval(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  chatSessionId?: string,
  timeoutMs: number = APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
  const request: ApprovalRequest = { toolCallId, toolName, args, chatSessionId };

  return new Promise<boolean>((resolve) => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const wrappedResolve = (approved: boolean) => {
      if (timerId) { clearTimeout(timerId); timerId = null; }
      resolve(approved);
    };

    pendingApprovals.set(toolCallId, { resolve: wrappedResolve, request });

    // Auto-deny after timeout so the session doesn't hang indefinitely
    timerId = setTimeout(() => {
      if (pendingApprovals.has(toolCallId)) {
        pendingApprovals.delete(toolCallId);
        wrappedResolve(false);
        // Notify UI to remove the stale card
        for (const cl of clearedListeners) {
          try { cl([toolCallId]); } catch { /* ignore */ }
        }
      }
    }, timeoutMs);

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
  const entry = pendingApprovals.get(toolCallId);
  if (entry) {
    pendingApprovals.delete(toolCallId);
    // SDK tool calls have a real resolve; MCP tool calls have a no-op resolve
    entry.resolve(approved);
  }

  // MCP tool call: also forward response to main process via IPC
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
 * Subscribe to approval cleared/removed events. Returns an unsubscribe function.
 * Fired when approvals are cleared (e.g. on session stop) or timed out,
 * so the UI can remove stale approval cards.
 */
export function onApprovalCleared(listener: ApprovalClearedListener): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

/**
 * Replay all currently pending approval requests to a listener.
 * Useful when ChatMessageList remounts after being unmounted — without this,
 * approvals that fired while unmounted would be silently missed and the
 * corresponding execute Promises would hang indefinitely.
 *
 * This covers both SDK and MCP approvals since both are stored in the same map.
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
 * Also notifies cleared-listeners so the UI can remove stale approval cards.
 *
 * When chatSessionId is provided, only approvals belonging to that session
 * are cleared — preventing cross-session interference in concurrent chats.
 * When omitted, all pending approvals are cleared (backward-compatible).
 */
export function clearAllPendingApprovals(chatSessionId?: string): void {
  const clearedIds: string[] = [];

  if (!chatSessionId) {
    // Clear everything (legacy / global stop)
    for (const [id, entry] of pendingApprovals) {
      entry.resolve(false);
      clearedIds.push(id);
    }
    pendingApprovals.clear();
  } else {
    // Scoped clear: only remove approvals for this chatSessionId
    for (const [id, entry] of pendingApprovals) {
      if (entry.request.chatSessionId === chatSessionId) {
        pendingApprovals.delete(id);
        entry.resolve(false);
        clearedIds.push(id);
      }
    }
  }

  // Notify UI listeners to remove the cards
  if (clearedIds.length > 0) {
    for (const cl of clearedListeners) {
      try { cl(clearedIds); } catch { /* ignore */ }
    }
  }
}

/**
 * Set up a bridge to receive MCP/ACP approval requests from the Electron main process.
 * Subscribes to IPC events and stores them in the same pendingApprovals map,
 * so the same ToolCall UI handles both SDK and MCP approvals, and approvals
 * survive ChatMessageList unmount/remount cycles via replayPendingApprovals().
 *
 * IMPORTANT: Call this from a component that stays mounted for the lifetime of
 * the AI panel (e.g. AIChatSidePanel), NOT from ChatMessageList which unmounts
 * on tab switches.
 *
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
      onMcpApprovalCleared?: (cb: (payload: {
        approvalIds: string[];
      }) => void) => () => void;
    };
  }).netcatty;
  if (!bridge?.onMcpApprovalRequest) return () => {};

  const unsubRequest = bridge.onMcpApprovalRequest((payload) => {
    const request: ApprovalRequest = {
      toolCallId: payload.approvalId,
      toolName: payload.toolName,
      args: payload.args,
      chatSessionId: payload.chatSessionId,
    };

    // Store in pendingApprovals so it survives unmount/remount
    // The resolve is a no-op because MCP approval resolution goes through IPC
    // (handled in resolveApproval when toolCallId starts with 'mcp_approval_')
    if (!pendingApprovals.has(payload.approvalId)) {
      pendingApprovals.set(payload.approvalId, {
        resolve: () => {}, // no-op; real resolution is via IPC
        request,
      });
    }

    // Notify all UI listeners
    for (const listener of listeners) {
      try { listener(request); } catch { /* ignore listener errors */ }
    }
  });

  // Subscribe to main-process approval cleared events (timeout, cancel)
  // so stale approval cards are removed from the renderer UI.
  const unsubCleared = bridge.onMcpApprovalCleared?.((payload) => {
    const clearedIds: string[] = [];
    for (const id of payload.approvalIds) {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        clearedIds.push(id);
      }
    }
    if (clearedIds.length > 0) {
      for (const cl of clearedListeners) {
        try { cl(clearedIds); } catch { /* ignore */ }
      }
    }
  });

  return () => {
    unsubRequest();
    unsubCleared?.();
  };
}
