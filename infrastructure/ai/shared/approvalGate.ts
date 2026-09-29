/**
 * approvalGate — Promise-based approval system for tool execution.
 *
 * Catty write tools are gated by `streamText({ toolApproval })` (see cattyToolApproval.ts).
 * MCP/external agents use main-process approval via `setupMcpApprovalBridge()`.
 * `requestApproval()` is the shared renderer Promise used by both paths.
 * a Promise that resolves when the user approves/rejects from the UI, or after
 * a timeout (default 5 minutes) to prevent indefinite hangs.
 *
 * Also supports MCP/SDK-agent tool calls from the Electron main process:
 * the main process sends an IPC approval request, and we route it
 * through the same listener/UI system. MCP approvals are stored in
 * the same pendingApprovals map so they survive ChatMessageList
 * unmount/remount cycles via replayPendingApprovals().
 *
 * Approvals are scoped by optional chatSessionId to prevent cross-session
 * interference when stopping or cancelling sessions.
 */

import {
  CATTY_APPROVAL_TIMEOUT_MS,
  resolveCattyApprovalDeadlines,
} from './approvalConstants';
import { localStorageAdapter } from '../../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_PERMISSION_GRANTS } from '../../config/storageKeys';
import { globalTraceStore } from '../harness/traceStore';
import {
  getActivePermissionGrants,
  matchPermissionGrant,
  resolveCapabilityId,
  sanitizePermissionGrants,
  setActivePermissionGrants,
  type PermissionGrantRule,
} from '../harness/permissionGrants';

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Optional chat session scope — used to clear only relevant approvals on stop */
  chatSessionId?: string;
  capabilityId?: string;
  source?: 'catty' | 'mcp' | 'codex-app-server';
  approvalType?: 'command' | 'file-change' | 'permissions';
  itemId?: string;
  allowSession?: boolean;
  target?: { sessionId: string; hostId: string; label: string; hostname: string };
}

export interface ResolveApprovalOptions {
  approved: boolean;
  persistGrant?: PermissionGrantRule;
  persistGrants?: PermissionGrantRule[];
  scope?: 'once' | 'session';
  cancelled?: boolean;
}

export type ApprovalResolution = {
  approved: boolean;
  scope: 'once' | 'session';
  cancelled: boolean;
};

export type GrantPersister = (rule: PermissionGrantRule) => void;

let grantPersister: GrantPersister | null = null;
const grantPersisterStack: GrantPersister[] = [];

function refreshPermissionGrantsFromStorage(): void {
  if (typeof window === 'undefined') return;
  setActivePermissionGrants(
    sanitizePermissionGrants(localStorageAdapter.read<unknown>(STORAGE_KEY_AI_PERMISSION_GRANTS)),
  );
}

export function setGrantPersister(persister: GrantPersister | null): void {
  grantPersisterStack.length = 0;
  if (persister) {
    grantPersisterStack.push(persister);
  }
  grantPersister = persister;
}

/** Register a grant persister; supports multiple mounted AI panels via a stack. */
export function registerGrantPersister(persister: GrantPersister): () => void {
  grantPersisterStack.push(persister);
  grantPersister = persister;
  return () => {
    const idx = grantPersisterStack.lastIndexOf(persister);
    if (idx >= 0) {
      grantPersisterStack.splice(idx, 1);
    }
    grantPersister = grantPersisterStack[grantPersisterStack.length - 1] ?? null;
  };
}

// Pending approval entries keyed by toolCallId.
// SDK approvals have a real `resolve` callback; MCP approvals use a no-op
// (the real resolution goes via IPC in resolveApproval).
const pendingApprovals = new Map<string, {
  resolve: (resolution: ApprovalResolution) => void;
  request: ApprovalRequest;
  /** Clears the auto-deny timer without resolving the approval. */
  cancelTimeout?: () => void;
}>();

// Subscribers for approval request events (UI listens here)
type ApprovalRequestListener = (request: ApprovalRequest) => void;
const listeners = new Set<ApprovalRequestListener>();

// Subscribers for approval cleared/removed events (UI listens to clean up cards)
type ApprovalClearedListener = (toolCallIds: string[]) => void;
const clearedListeners = new Set<ApprovalClearedListener>();

let approvalEventCounter = 0;

function nextApprovalEventId(prefix: string): string {
  approvalEventCounter += 1;
  return `${prefix}-${Date.now()}-${approvalEventCounter}`;
}

function emitApprovalEvent(
  type: 'approval_requested' | 'approval_resolved',
  request: ApprovalRequest,
  extra?: { outcome?: 'approved' | 'denied' | 'timeout'; persistedGrantId?: string },
): void {
  const sessionId = request.chatSessionId ?? 'global';
  const base = {
    sessionId,
    chatSessionId: request.chatSessionId,
    backend: request.source === 'codex-app-server' ? 'external-sdk' as const : 'catty' as const,
    timestamp: Date.now(),
    toolCallId: request.toolCallId,
    toolName: request.toolName,
  };

  if (type === 'approval_requested') {
    globalTraceStore.append({
      ...base,
      id: nextApprovalEventId('approval-requested'),
      type: 'approval_requested',
      args: request.args,
    });
    return;
  }

  globalTraceStore.append({
    ...base,
    id: nextApprovalEventId('approval-resolved'),
    type: 'approval_resolved',
    outcome: extra?.outcome ?? 'denied',
    persistedGrantId: extra?.persistedGrantId,
  });
}

function isGrantedByRules(request: ApprovalRequest): boolean {
  refreshPermissionGrantsFromStorage();
  const capabilityId = request.capabilityId ?? resolveCapabilityId(request.toolName);
  return matchPermissionGrant(getActivePermissionGrants(), {
    capabilityId,
    chatSessionId: request.chatSessionId,
    sessionId: typeof request.args.sessionId === 'string' ? request.args.sessionId : undefined,
    args: request.args,
  }) !== null;
}

/**
 * Called from a tool's `execute` function when it needs user approval.
 * Returns a Promise<boolean> that resolves to `true` (approved) or `false` (denied).
 * The UI is notified via the listener system to render approval buttons.
 *
 * Idle auto-deny uses `timeoutMs` (default 5 minutes). Review activity re-arms
 * a fresh idle window from *now*, but never past a hard deadline from creation
 * (default 3× idle, capped at 30 minutes) so late review is not cut off at the
 * original idle mark while still staying bounded.
 */
export function requestApproval(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  chatSessionId?: string,
  timeoutMs: number = CATTY_APPROVAL_TIMEOUT_MS,
  capabilityId?: string,
): Promise<boolean> {
  const request: ApprovalRequest = {
    toolCallId,
    toolName,
    args,
    chatSessionId,
    capabilityId: capabilityId ?? resolveCapabilityId(toolName),
  };

  if (isGrantedByRules(request)) {
    return Promise.resolve(true);
  }

  const existing = pendingApprovals.get(toolCallId);
  if (existing) {
    return new Promise<boolean>((resolve) => {
      const previousResolve = existing.resolve;
      existing.resolve = (resolution) => {
        previousResolve(resolution);
        resolve(resolution.approved);
      };
    });
  }

  emitApprovalEvent('approval_requested', request);

  return new Promise<boolean>((resolve) => {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const { idleMs, hardDeadlineMs } = resolveCattyApprovalDeadlines(timeoutMs);
    // Hard ceiling from creation — review re-arms idle from now for idleMs
    // but never past this bound.
    const hardDeadlineAt = Date.now() + hardDeadlineMs;

    const clearTimer = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };

    const wrappedResolve = (resolution: ApprovalResolution) => {
      clearTimer();
      resolve(resolution.approved);
    };

    const denyTimedOut = () => {
      const entry = pendingApprovals.get(toolCallId);
      if (!entry) return;
      pendingApprovals.delete(toolCallId);
      wrappedResolve({ approved: false, scope: 'once', cancelled: false });
      emitApprovalEvent('approval_resolved', request, { outcome: 'timeout' });
      for (const cl of clearedListeners) {
        try { cl([toolCallId]); } catch { /* ignore */ }
      }
    };

    const armTimer = (ms: number) => {
      clearTimer();
      if (ms <= 0) {
        // Hard deadline already elapsed — reject synchronously so a late
        // approve cannot race a deferred setTimeout(0) deny.
        denyTimedOut();
        return;
      }
      timerId = setTimeout(denyTimedOut, ms);
    };

    // Initial arm is the idle window. Review re-arms idle (capped by hard deadline).
    armTimer(idleMs);

    pendingApprovals.set(toolCallId, {
      resolve: wrappedResolve,
      request,
      cancelTimeout: () => {
        const remainingHard = hardDeadlineAt - Date.now();
        if (remainingHard <= 0) {
          armTimer(0);
          return;
        }
        // Re-arm a full idle window from now, never past the hard deadline.
        armTimer(Math.min(idleMs, remainingHard));
      },
    });

    // Notify all UI listeners
    for (const listener of listeners) {
      try { listener(request); } catch { /* ignore listener errors */ }
    }
  });
}

/**
 * Cancel / reset the idle auto-deny timer after the user starts reviewing or
 * interacting with the card. Catty local approvals re-arm idle from *now* for
 * a fresh idleMs window, never past the hard creation deadline.
 * Timeout never auto-approves.
 */
export function cancelApprovalTimeout(toolCallId: string): void {
  const entry = pendingApprovals.get(toolCallId);
  // Keep cancelTimeout registered so further review activity can re-arm idle.
  entry?.cancelTimeout?.();

  // MCP / Codex App Server approvals are timed in the main process.
  // MCP cancel drops idle but keeps the absolute creation deadline.
  if (toolCallId.startsWith('mcp_approval_')) {
    const bridge = (window as unknown as {
      netcatty?: { cancelMcpApprovalTimeout?: (id: string) => Promise<unknown> };
    }).netcatty;
    void bridge?.cancelMcpApprovalTimeout?.(toolCallId);
  } else if (toolCallId.startsWith('codex_interaction_')) {
    const bridge = (window as unknown as {
      netcatty?: { cancelCodexAppServerInteractionTimeout?: (id: string) => Promise<unknown> };
    }).netcatty;
    void bridge?.cancelCodexAppServerInteractionTimeout?.(toolCallId);
  }
}

/**
 * Called from the UI when the user approves or rejects a tool execution.
 * Handles both SDK tool calls (local Promise) and MCP tool calls (IPC to main process).
 */
export function resolveApproval(
  toolCallId: string,
  decision: boolean | ResolveApprovalOptions,
): void {
  const approved = typeof decision === 'boolean' ? decision : decision.approved;
  const persistGrant = typeof decision === 'boolean' ? undefined : decision.persistGrant;
  const persistGrants = typeof decision === 'boolean'
    ? undefined
    : (decision.persistGrants ?? (persistGrant ? [persistGrant] : undefined));
  const resolution: ApprovalResolution = {
    approved,
    scope: typeof decision === 'boolean' ? 'once' : (decision.scope ?? 'once'),
    cancelled: typeof decision === 'boolean' ? false : decision.cancelled === true,
  };

  const entry = pendingApprovals.get(toolCallId);
  const request = entry?.request;

  if (!entry) {
    // Stale UI click after the map entry was already drained — do not fan out
    // a second MCP IPC response for a missing approval.
    return;
  }

  pendingApprovals.delete(toolCallId);
  entry.resolve(resolution);

  let persistedGrantId: string | undefined;
  if (approved && request?.source !== 'codex-app-server' && persistGrants?.length) {
    for (const grant of persistGrants) {
      grantPersister?.(grant);
      persistedGrantId = grant.id;
    }
  }
  if (request) {
    emitApprovalEvent('approval_resolved', request, {
      outcome: approved ? 'approved' : 'denied',
      persistedGrantId,
    });
  }

  // MCP tool call: also forward response to main process via IPC
  if (toolCallId.startsWith('mcp_approval_')) {
    const bridge = (window as unknown as { netcatty?: { respondMcpApproval?: (id: string, approved: boolean, scope: 'once' | 'session') => Promise<unknown> } }).netcatty;
    bridge?.respondMcpApproval?.(toolCallId, approved, resolution.scope);
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

export function registerExternalApproval(
  request: ApprovalRequest,
  onResolve: (resolution: ApprovalResolution) => void,
): void {
  if (pendingApprovals.has(request.toolCallId)) return;
  emitApprovalEvent('approval_requested', request);
  pendingApprovals.set(request.toolCallId, { request, resolve: onResolve });
  for (const listener of listeners) {
    try { listener(request); } catch { /* ignore listener errors */ }
  }
}

export function clearPendingApprovalIds(toolCallIds: string[]): void {
  const clearedIds: string[] = [];
  for (const toolCallId of toolCallIds) {
    if (pendingApprovals.delete(toolCallId)) clearedIds.push(toolCallId);
  }
  if (clearedIds.length > 0) {
    for (const listener of clearedListeners) {
      try { listener(clearedIds); } catch { /* ignore listener errors */ }
    }
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
      entry.resolve({ approved: false, scope: 'once', cancelled: true });
      clearedIds.push(id);
    }
    pendingApprovals.clear();
  } else {
    // Scoped clear: only remove approvals for this chatSessionId
    for (const [id, entry] of pendingApprovals) {
      if (entry.request.chatSessionId === chatSessionId) {
        pendingApprovals.delete(id);
        entry.resolve({ approved: false, scope: 'once', cancelled: true });
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
 * Set up a bridge to receive MCP/SDK-agent approval requests from the Electron main process.
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
        target?: ApprovalRequest['target'];
        allowSession?: boolean;
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
      capabilityId: resolveCapabilityId(payload.toolName),
      source: 'mcp',
      target: payload.target,
      allowSession: payload.allowSession,
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
