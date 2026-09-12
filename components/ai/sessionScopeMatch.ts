import type { AISession } from "../../infrastructure/ai/types";

export function getSessionScopeMatchRank(
  session: AISession,
  scopeType: "terminal" | "workspace",
  scopeTargetId?: string,
  scopeHostIds?: string[],
  /**
   * Session ids currently displayed by other terminal scopes. Tracked by
   * session id rather than `scope.targetId` so that a host-matched session
   * resumed from a different terminal is still recognised as in-use and
   * not offered (or cleaned) as if it were orphaned.
   */
  activeTerminalSessionIds?: Set<string>,
  /**
   * Terminal session ids currently living in this workspace. When terminals
   * merge, their AI chats stay `scope.type === "terminal"`; treating those
   * member chats as exact workspace matches keeps history/resume working.
   */
  workspaceMemberTerminalIds?: Set<string>,
  /** Chats currently selected by workspace members, including resumed history. */
  workspaceMemberActiveSessionIds?: Set<string>,
): number {
  // After a terminal merge the AI panel flips to workspace scope, but chats
  // created or resumed on member terminals remain terminal-scoped. Rank them as
  // exact matches so they stay visible and preferred over stale workspaces.
  if (
    scopeType === "workspace"
    && session.scope.type === "terminal"
    && (
      (session.scope.targetId && workspaceMemberTerminalIds?.has(session.scope.targetId))
      || workspaceMemberActiveSessionIds?.has(session.id)
    )
  ) {
    return 3;
  }

  if (session.scope.type !== scopeType) return 0;
  if (session.scope.targetId === scopeTargetId) return 3;

  if (scopeType === "terminal" && activeTerminalSessionIds?.has(session.id)) {
    return 0;
  }

  if (scopeType === "terminal" && scopeHostIds?.length && session.scope.hostIds?.length) {
    return session.scope.hostIds.some((hostId) => scopeHostIds.includes(hostId)) ? 2 : 0;
  }

  return 1;
}
