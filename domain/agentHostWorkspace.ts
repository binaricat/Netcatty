/** Chat scope shape used for host_open placement (structural subset of AISession). */
export interface AgentChatScopeLike {
  type?: string;
  targetId?: string;
}

export interface AgentChatLike {
  scope?: AgentChatScopeLike;
  scopeDangling?: boolean;
}

export interface AgentTerminalSessionLike {
  id: string;
  workspaceId?: string;
}

export interface AgentHostOpenWorkspaceContext {
  activeTabId: string | undefined;
  workspaceIds: readonly string[];
  terminalSessions: readonly AgentTerminalSessionLike[];
}

/**
 * Workspace the invoking chat is bound to, validated against live state.
 * Workspace chat → that workspace; terminal chat → the terminal's workspace;
 * global/unbound/dangling → undefined (caller falls back to a standalone tab).
 */
export function resolveChatBoundWorkspaceId(
  chat: AgentChatLike | undefined,
  context: Pick<AgentHostOpenWorkspaceContext, 'workspaceIds' | 'terminalSessions'>,
): string | undefined {
  const scope = chat && !chat.scopeDangling ? chat.scope : undefined;
  const targetId = scope?.targetId;
  if (!targetId) return undefined;
  if (scope!.type === 'workspace') {
    return context.workspaceIds.includes(targetId) ? targetId : undefined;
  }
  if (scope!.type === 'terminal') {
    const workspaceId = context.terminalSessions.find(
      (session) => session.id === targetId,
    )?.workspaceId;
    return workspaceId && context.workspaceIds.includes(workspaceId) ? workspaceId : undefined;
  }
  return undefined;
}

/**
 * Resolve host_open tab placement. Placement follows the INVOKING CHAT's bound
 * workspace, not the currently focused workspace: a workspace-scoped chat opens
 * into its own workspace even when another workspace is active. An explicit
 * workspaceId keeps its documented meaning; 'current' prefers the chat's bound
 * workspace and only falls back to the focused workspace when unbound. Omitting
 * workspaceId opens into the bound workspace, or a standalone tab when the
 * chat has no binding (external MCP / CLI / global scope).
 */
export function resolveAgentHostOpenWorkspace(
  requested: string | undefined,
  chat: AgentChatLike | undefined,
  context: AgentHostOpenWorkspaceContext,
): { workspaceId?: string; error?: string } {
  const bound = resolveChatBoundWorkspaceId(chat, context);
  if (requested === undefined) {
    return bound ? { workspaceId: bound } : {};
  }
  if (requested === 'current') {
    if (bound) return { workspaceId: bound };
    return resolveAgentHostWorkspace(requested, context.activeTabId, context.workspaceIds);
  }
  return resolveAgentHostWorkspace(requested, context.activeTabId, context.workspaceIds);
}

/** Resolve an explicit placement request without silently changing its target. */
export function resolveAgentHostWorkspace(
  requested: string | undefined,
  activeTabId: string | undefined,
  workspaceIds: readonly string[],
): { workspaceId?: string; error?: string } {
  if (requested === undefined) return {};
  const workspaceId = requested === 'current' ? activeTabId : requested.trim();
  if (!workspaceId || !workspaceIds.includes(workspaceId)) {
    return { error: `Workspace "${requested}" is not available. Select a workspace or provide its id.` };
  }
  return { workspaceId };
}
