import { buildAIScopeKey } from './aiSessionsForScope';

/**
 * When terminals merge into a workspace, AI panel scope flips from
 * `terminal:<id>` to `workspace:<id>`. Prefer the workspace's own active
 * chat, otherwise inherit from member terminal scopes (focused first) so
 * the chat the user was using survives the merge.
 */
export function resolveInheritedAIActiveSessionId(input: {
  scopeType: 'terminal' | 'workspace' | 'global';
  scopeTargetId?: string;
  activeSessionIdMap: Readonly<Record<string, string | null | undefined>>;
  memberTerminalIds: readonly string[];
  preferredTerminalId?: string | null;
  /**
   * When provided, inherited ids must appear here (e.g. ranked history).
   * Direct workspace-map hits are returned even if absent so callers can
   * decide how to recover stale ids.
   */
  visibleSessionIds?: ReadonlySet<string>;
}): string | null {
  const scopeKey = buildAIScopeKey(input.scopeType, input.scopeTargetId);
  const direct = input.activeSessionIdMap[scopeKey];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  if (input.scopeType !== 'workspace') {
    return null;
  }

  const preferredOrder: string[] = [];
  if (input.preferredTerminalId) {
    preferredOrder.push(input.preferredTerminalId);
  }
  for (const terminalId of input.memberTerminalIds) {
    if (terminalId && !preferredOrder.includes(terminalId)) {
      preferredOrder.push(terminalId);
    }
  }

  for (const terminalId of preferredOrder) {
    const sessionId = input.activeSessionIdMap[buildAIScopeKey('terminal', terminalId)];
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
    if (input.visibleSessionIds && !input.visibleSessionIds.has(sessionId)) continue;
    return sessionId;
  }

  return null;
}
