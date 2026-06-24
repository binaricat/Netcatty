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
  if (session.scope.targetId === scopeTargetId) return 3;

  if (scopeType === "terminal" && activeTerminalSessionIds?.has(session.id)) {
    return 0;
  }

  if (scopeType === "terminal" && scopeHostIds?.length && session.scope.hostIds?.length) {
    return session.scope.hostIds.some((hostId) => scopeHostIds.includes(hostId)) ? 2 : 0;
  }

  return 1;
}
