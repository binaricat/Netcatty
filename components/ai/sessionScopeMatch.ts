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
): number {
  if (session.scope.type !== scopeType) return 0;
  if (session.scope.targetId === scopeTargetId) return 2;

  if (scopeType !== "terminal" || !scopeHostIds?.length || !session.scope.hostIds?.length) {
    return 0;
  }

  if (activeTerminalSessionIds?.has(session.id)) {
    return 0;
  }

  return session.scope.hostIds.some((hostId) => scopeHostIds.includes(hostId)) ? 1 : 0;
}
