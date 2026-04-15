import type {
  AIDraft,
  AIPanelView,
  AISession,
} from "../../infrastructure/ai/types";

type DraftsByScope = Partial<Record<string, AIDraft>>;
type PanelViewByScope = Partial<Record<string, AIPanelView>>;
type ActiveSessionIdMap = Record<string, string | null>;

function isInactiveScopedTarget(
  scopeKey: string,
  activeTargetIds: Set<string>,
): boolean {
  const separatorIndex = scopeKey.indexOf(":");
  if (separatorIndex === -1) return false;

  const scopeType = scopeKey.slice(0, separatorIndex);
  if (scopeType !== "terminal" && scopeType !== "workspace") return false;

  const targetId = scopeKey.slice(separatorIndex + 1);
  if (!targetId) return false;

  return !activeTargetIds.has(targetId);
}

export function pruneInactiveScopedState(
  draftsByScope: DraftsByScope,
  panelViewByScope: PanelViewByScope,
  activeTargetIds: Set<string>,
): {
  draftsByScope: DraftsByScope;
  panelViewByScope: PanelViewByScope;
} {
  const nextDraftsByScope = { ...draftsByScope };
  const nextPanelViewByScope = { ...panelViewByScope };
  let draftsChanged = false;
  let panelViewsChanged = false;

  for (const scopeKey of Object.keys(nextDraftsByScope)) {
    if (!isInactiveScopedTarget(scopeKey, activeTargetIds)) continue;
    delete nextDraftsByScope[scopeKey];
    draftsChanged = true;
  }

  for (const scopeKey of Object.keys(nextPanelViewByScope)) {
    if (!isInactiveScopedTarget(scopeKey, activeTargetIds)) continue;
    delete nextPanelViewByScope[scopeKey];
    panelViewsChanged = true;
  }

  return {
    draftsByScope: draftsChanged ? nextDraftsByScope : draftsByScope,
    panelViewByScope: panelViewsChanged ? nextPanelViewByScope : panelViewByScope,
  };
}

export function pruneInactiveScopedTransientState(
  activeSessionIdMap: ActiveSessionIdMap,
  draftsByScope: DraftsByScope,
  panelViewByScope: PanelViewByScope,
  activeTargetIds: Set<string>,
): {
  activeSessionIdMap: ActiveSessionIdMap;
  draftsByScope: DraftsByScope;
  panelViewByScope: PanelViewByScope;
} {
  let activeSessionMapChanged = false;
  const nextActiveSessionIdMap: ActiveSessionIdMap = {};

  for (const [scopeKey, sessionId] of Object.entries(activeSessionIdMap)) {
    if (isInactiveScopedTarget(scopeKey, activeTargetIds)) {
      activeSessionMapChanged = true;
      continue;
    }

    nextActiveSessionIdMap[scopeKey] = sessionId;
  }

  const nextScopedState = pruneInactiveScopedState(
    draftsByScope,
    panelViewByScope,
    activeTargetIds,
  );

  return {
    activeSessionIdMap: activeSessionMapChanged ? nextActiveSessionIdMap : activeSessionIdMap,
    draftsByScope: nextScopedState.draftsByScope,
    panelViewByScope: nextScopedState.panelViewByScope,
  };
}

function isRestorableTerminalSession(session: AISession): boolean {
  return session.scope.type === "terminal"
    && !!session.scope.hostIds?.length
    && session.scope.hostIds.some((id) => !id.startsWith("local-") && !id.startsWith("serial-"));
}

export function pruneInactiveScopedSessions(
  sessions: AISession[],
  activeTargetIds: Set<string>,
  /**
   * Session ids currently displayed by any live scope. A session whose
   * `scope.targetId` is inactive but whose id is still in use somewhere
   * (e.g. resumed from history into a different terminal) must not be
   * treated as orphaned — clearing its `externalSessionId` or deleting
   * it outright would break the chat the user is actively continuing.
   */
  activeSessionIds: Set<string> = new Set(),
): {
  sessions: AISession[];
  orphanedSessionIds: string[];
} {
  const orphanedSessionIds = sessions
    .filter((session) => session.scope.targetId && !activeTargetIds.has(session.scope.targetId))
    .filter((session) => !activeSessionIds.has(session.id))
    .map((session) => session.id);

  if (orphanedSessionIds.length === 0) {
    return {
      sessions,
      orphanedSessionIds,
    };
  }

  const orphanedSessionIdSet = new Set(orphanedSessionIds);
  let sessionsChanged = false;

  const nextSessions = sessions.flatMap((session) => {
    if (!orphanedSessionIdSet.has(session.id)) {
      return [session];
    }

    if (!isRestorableTerminalSession(session)) {
      sessionsChanged = true;
      return [];
    }

    if (!session.externalSessionId) {
      return [session];
    }

    sessionsChanged = true;
    return [
      { ...session, externalSessionId: undefined },
    ];
  });

  return {
    sessions: sessionsChanged ? nextSessions : sessions,
    orphanedSessionIds,
  };
}
