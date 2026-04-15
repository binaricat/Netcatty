import type { AISession } from "../../infrastructure/ai/types";

export function getSessionScopeMatchRank(
  session: AISession,
  scopeType: "terminal" | "workspace",
  scopeTargetId?: string,
  scopeHostIds?: string[],
  activeTerminalTargetIds?: Set<string>,
): number {
  if (session.scope.type !== scopeType) return 0;
  if (session.scope.targetId === scopeTargetId) return 2;

  if (scopeType !== "terminal" || !scopeHostIds?.length || !session.scope.hostIds?.length) {
    return 0;
  }

  if (session.scope.targetId && activeTerminalTargetIds?.has(session.scope.targetId)) {
    return 0;
  }

  return session.scope.hostIds.some((hostId) => scopeHostIds.includes(hostId)) ? 1 : 0;
}
