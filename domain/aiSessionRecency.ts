/**
 * Recency ranking for workspace member terminals, driven by the AI session
 * store (issue #4098 phase 2). All former "first member" positional fallbacks
 * resolve through this: when a decision has to pick one member out of the
 * survivors, the most recently active member's chat wins — never the first
 * element of an array.
 */
export type AIChatRecencyEntry = {
  id?: string;
  scope: {
    type: string;
    targetId?: string;
  };
  updatedAt?: number;
};

/**
 * Return the member terminal id whose terminal-scoped AI chat has the highest
 * `updatedAt`, or null when no member owns a chat (no recency signal exists —
 * callers must then use their own documented deterministic fallback, not a
 * positional one). Members without a chat rank after members with one.
 */
export function resolveMostRecentlyActiveMemberTerminalId(input: {
  memberTerminalIds: readonly string[];
  aiSessions?: readonly AIChatRecencyEntry[];
}): string | null {
  const recencyByMember = new Map<string, number>();
  for (const session of input.aiSessions ?? []) {
    if (session.scope?.type !== 'terminal' || !session.scope.targetId) continue;
    if (!input.memberTerminalIds.includes(session.scope.targetId)) continue;
    const updatedAt = session.updatedAt ?? 0;
    const current = recencyByMember.get(session.scope.targetId) ?? 0;
    if (updatedAt > current) {
      recencyByMember.set(session.scope.targetId, updatedAt);
    }
  }

  let bestId: string | null = null;
  let bestRecency = 0;
  for (const memberId of input.memberTerminalIds) {
    if (!memberId) continue;
    const recency = recencyByMember.get(memberId) ?? 0;
    if (bestId === null || recency > bestRecency) {
      bestId = memberId;
      bestRecency = recency;
    }
  }
  // All-zero recency means no survivor owns a chat: there is no non-positional
  // signal, so the caller decides.
  return bestRecency > 0 ? bestId : null;
}
