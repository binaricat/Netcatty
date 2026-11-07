import { buildAIScopeKey } from './aiSessionsForScope';
import { resolveInheritedAIActiveSessionId } from './aiWorkspaceScopeInherit';
import { resolveMostRecentlyActiveMemberTerminalId } from './aiSessionRecency';

export type AIActiveSessionIdMap = Readonly<Record<string, string | null | undefined>>;

export type AISessionScopeHandoffLike = {
  id: string;
  scope: {
    type: string;
    targetId?: string;
    hostIds?: string[];
  };
  updatedAt?: number;
};

export type AIPanelViewHandoffLike = {
  mode: 'draft' | 'session';
  sessionId?: string;
};

export type SeedWorkspaceAIActiveSessionResult = {
  activeSessionIdMap: Record<string, string | null>;
  panelViewByScope: Record<string, AIPanelViewHandoffLike>;
  panelViewChanged: boolean;
};

/**
 * Seed a brand-new workspace scope from member terminal maps (focused first)
 * so the first paint does not wait on a visible-panel write-back.
 *
 * Also materializes an explicit session panel view so follow-up typing does not
 * fall through to draft-only resolution and create a new chat on send.
 */
export function seedWorkspaceAIActiveSessionFromMembers(input: {
  activeSessionIdMap: AIActiveSessionIdMap;
  panelViewByScope?: Readonly<Record<string, AIPanelViewHandoffLike | undefined>>;
  workspaceId: string;
  memberTerminalIds: readonly string[];
  preferredTerminalId?: string | null;
}): SeedWorkspaceAIActiveSessionResult | null {
  const workspaceKey = buildAIScopeKey('workspace', input.workspaceId);
  const existing = input.activeSessionIdMap[workspaceKey];
  if (typeof existing === 'string' && existing.length > 0) {
    return null;
  }

  const inherited = resolveInheritedAIActiveSessionId({
    scopeType: 'workspace',
    scopeTargetId: input.workspaceId,
    activeSessionIdMap: input.activeSessionIdMap,
    memberTerminalIds: input.memberTerminalIds,
    preferredTerminalId: input.preferredTerminalId,
  });
  if (!inherited) return null;

  const previousPanelViewByScope = (
    input.panelViewByScope as Record<string, AIPanelViewHandoffLike> | undefined
  ) ?? {};
  const existingPanelView = previousPanelViewByScope[workspaceKey];
  const needsPanelView = !(
    existingPanelView?.mode === 'session'
    && existingPanelView.sessionId === inherited
  );

  return {
    activeSessionIdMap: {
      ...(input.activeSessionIdMap as Record<string, string | null>),
      [workspaceKey]: inherited,
    },
    panelViewByScope: needsPanelView
      ? {
          ...previousPanelViewByScope,
          [workspaceKey]: { mode: 'session', sessionId: inherited },
        }
      : previousPanelViewByScope,
    panelViewChanged: needsPanelView,
  };
}

/**
 * When a workspace tab dissolves, copy its active chat onto a surviving
 * terminal before the workspace scope key is pruned. An inherited chat that
 * is already terminal-scoped to a pane still in `terminalIds` stays on that
 * owner, even when focus/preferred is a different survivor. Otherwise the
 * target is the preferred survivor, or the first remaining terminal when the
 * original pane is gone. Workspace-scoped chats are reminted onto that
 * target, duplicate terminal map entries for the same chat are cleared, and
 * a session panel view is seeded so terminal scopes do not fall back to a
 * blank draft.
 */
export function handoffDissolvedWorkspaceAIScope<T extends AISessionScopeHandoffLike>(input: {
  activeSessionIdMap: AIActiveSessionIdMap;
  sessions: readonly T[];
  workspaceId: string;
  terminalIds: readonly string[];
  preferredTerminalId?: string | null;
  panelViewByScope?: Readonly<Record<string, AIPanelViewHandoffLike | undefined>>;
}): {
  activeSessionIdMap: Record<string, string | null>;
  sessions: T[];
  panelViewByScope: Record<string, AIPanelViewHandoffLike>;
  changed: boolean;
} {
  const fallbackTerminalId = (
    input.preferredTerminalId
    && input.terminalIds.includes(input.preferredTerminalId)
      ? input.preferredTerminalId
      : input.terminalIds.find(Boolean)
  ) ?? null;

  const workspaceKey = buildAIScopeKey('workspace', input.workspaceId);
  const workspaceActive = input.activeSessionIdMap[workspaceKey];
  const hasWorkspaceActive = typeof workspaceActive === 'string' && workspaceActive.length > 0;
  const activeSession = hasWorkspaceActive
    ? input.sessions.find((session) => session.id === workspaceActive)
    : undefined;
  const survivingOwnerTerminalId = (
    activeSession?.scope.type === 'terminal'
    && activeSession.scope.targetId
    && input.terminalIds.includes(activeSession.scope.targetId)
      ? activeSession.scope.targetId
      : null
  );
  const handoffTargetTerminalId = survivingOwnerTerminalId ?? fallbackTerminalId;
  const previousPanelViewByScope = (
    input.panelViewByScope as Record<string, AIPanelViewHandoffLike> | undefined
  ) ?? {};

  let nextMap: Record<string, string | null> = {
    ...(input.activeSessionIdMap as Record<string, string | null>),
  };
  let mapChanged = false;

  if (handoffTargetTerminalId && hasWorkspaceActive) {
    const terminalKey = buildAIScopeKey('terminal', handoffTargetTerminalId);
    let map = nextMap;
    let changed = false;
    if (map[terminalKey] !== workspaceActive) {
      map = { ...map, [terminalKey]: workspaceActive };
      changed = true;
    }
    // Drop duplicate selections so other terminal scopes do not claim this
    // chat via the activeTerminalSessionIds ownership filter.
    for (const [key, value] of Object.entries(map)) {
      if (!key.startsWith('terminal:') || key === terminalKey) continue;
      if (value !== workspaceActive) continue;
      if (!changed) {
        map = { ...map };
        changed = true;
      }
      map[key] = null;
    }
    if (changed) {
      nextMap = map;
      mapChanged = true;
    }
  }

  let sessionsChanged = false;
  const nextSessions = input.sessions.map((session) => {
    if (!handoffTargetTerminalId) return session;

    const isWorkspaceScoped = (
      session.scope.type === 'workspace'
      && session.scope.targetId === input.workspaceId
    );
    // Keep an inherited chat on its owner when that pane survives. Remint
    // only when the handoff target is a different terminal (original pane gone).
    const isInheritedActiveChatOnOtherTerminal = (
      hasWorkspaceActive
      && session.id === workspaceActive
      && session.scope.type === 'terminal'
      && Boolean(session.scope.targetId)
      && session.scope.targetId !== handoffTargetTerminalId
    );
    if (!isWorkspaceScoped && !isInheritedActiveChatOnOtherTerminal) return session;
    if (session.scope.type === 'terminal' && session.scope.targetId === handoffTargetTerminalId) {
      return session;
    }

    sessionsChanged = true;
    return {
      ...session,
      scope: {
        ...session.scope,
        type: 'terminal',
        targetId: handoffTargetTerminalId,
      },
      updatedAt: Date.now(),
    };
  });

  let panelViewsChanged = false;
  const nextPanelViewByScope: Record<string, AIPanelViewHandoffLike> = {
    ...previousPanelViewByScope,
  };
  if (handoffTargetTerminalId && hasWorkspaceActive) {
    const terminalKey = buildAIScopeKey('terminal', handoffTargetTerminalId);
    const workspacePanelView = previousPanelViewByScope[workspaceKey];
    const terminalPanelView = previousPanelViewByScope[terminalKey];
    const nextView: AIPanelViewHandoffLike = (
      workspacePanelView?.mode === 'session'
      && workspacePanelView.sessionId === workspaceActive
    )
      ? workspacePanelView
      : { mode: 'session', sessionId: workspaceActive };

    if (
      terminalPanelView?.mode !== nextView.mode
      || (nextView.mode === 'session' && terminalPanelView.sessionId !== nextView.sessionId)
    ) {
      nextPanelViewByScope[terminalKey] = nextView;
      panelViewsChanged = true;
    }
  }

  if (!mapChanged && !sessionsChanged && !panelViewsChanged) {
    return {
      activeSessionIdMap: input.activeSessionIdMap as Record<string, string | null>,
      sessions: input.sessions as T[],
      panelViewByScope: previousPanelViewByScope,
      changed: false,
    };
  }

  return {
    activeSessionIdMap: nextMap,
    sessions: sessionsChanged ? nextSessions : input.sessions as T[],
    panelViewByScope: panelViewsChanged ? nextPanelViewByScope : previousPanelViewByScope,
    changed: true,
  };
}

/**
 * When a still-live workspace loses a member pane whose terminal-scoped chat is
 * the workspace active selection, remint that chat onto a remaining pane so
 * member-history matching keeps it visible. Also clear the departed terminal's
 * active-map entry when it still points at the same chat so detach does not
 * leave two live scopes driving one agent thread.
 */
export function retargetWorkspaceActiveChatAfterMemberLoss<T extends AISessionScopeHandoffLike>(input: {
  activeSessionIdMap: AIActiveSessionIdMap;
  sessions: readonly T[];
  workspaceId: string;
  previousMemberTerminalIds: readonly string[];
  currentMemberTerminalIds: readonly string[];
  preferredTerminalId?: string | null;
  /** Current live targets distinguish a closed terminal from a detached one. */
  activeTargetIds?: ReadonlySet<string>;
}): {
  activeSessionIdMap: Record<string, string | null>;
  sessions: T[];
  changed: boolean;
} {
  const previousMap = input.activeSessionIdMap as Record<string, string | null>;
  const workspaceKey = buildAIScopeKey('workspace', input.workspaceId);
  const workspaceActive = previousMap[workspaceKey];
  const survivorTerminalIds = new Set(input.currentMemberTerminalIds.filter(Boolean));
  const departedTerminalIds = input.previousMemberTerminalIds.filter(
    (sessionId) => sessionId && !survivorTerminalIds.has(sessionId),
  );

  if (survivorTerminalIds.size === 0) {
    const activeSession = input.sessions.find((session) => session.id === workspaceActive);
    const ownerId = activeSession?.scope.targetId;
    // A member may have resumed history from an older terminal. Match its
    // current selection as well as the original scope owner when preserving
    // that inherited chat. Still-live detached members keep their selection.
    const carryingTerminalIds = departedTerminalIds.filter((terminalId) => (
      terminalId === ownerId
      || previousMap[buildAIScopeKey('terminal', terminalId)] === workspaceActive
    ));
    if (!activeSession || activeSession.scope.type !== 'terminal' || !ownerId
      || carryingTerminalIds.length === 0
      || !input.activeTargetIds || input.activeTargetIds.has(ownerId)
      || carryingTerminalIds.some((terminalId) => input.activeTargetIds!.has(terminalId))) {
      return { activeSessionIdMap: previousMap, sessions: input.sessions as T[], changed: false };
    }
    const nextMap = { ...previousMap };
    for (const departedTerminalId of departedTerminalIds) {
      const departedKey = buildAIScopeKey('terminal', departedTerminalId);
      if (!input.activeTargetIds.has(departedTerminalId) && nextMap[departedKey] === workspaceActive) {
        nextMap[departedKey] = null;
      }
    }
    return {
      activeSessionIdMap: nextMap,
      sessions: input.sessions.map((session) => session !== activeSession ? session : {
        ...session,
        scope: { ...session.scope, type: 'workspace', targetId: input.workspaceId },
      }),
      changed: true,
    };
  }

  let nextMap: Record<string, string | null> = { ...previousMap };
  let mapChanged = false;
  if (typeof workspaceActive === 'string' && workspaceActive.length > 0) {
    for (const departedTerminalId of departedTerminalIds) {
      const departedKey = buildAIScopeKey('terminal', departedTerminalId);
      if (nextMap[departedKey] !== workspaceActive) continue;
      nextMap = { ...nextMap, [departedKey]: null };
      mapChanged = true;
    }
  }

  if (typeof workspaceActive !== 'string' || workspaceActive.length === 0) {
    return {
      activeSessionIdMap: mapChanged ? nextMap : previousMap,
      sessions: input.sessions as T[],
      changed: mapChanged,
    };
  }

  // Issue #4098 phase 2: when the focused member did not survive, the retarget
  // lands on the most-recently-active survivor (AI chat recency) — never on
  // the first positional member.
  const preferredTerminalId = (
    input.preferredTerminalId
    && survivorTerminalIds.has(input.preferredTerminalId)
      ? input.preferredTerminalId
      : resolveMostRecentlyActiveMemberTerminalId({
          memberTerminalIds: input.currentMemberTerminalIds,
          aiSessions: input.sessions,
        })
  ) ?? null;
  if (!preferredTerminalId) {
    return {
      activeSessionIdMap: mapChanged ? nextMap : previousMap,
      sessions: input.sessions as T[],
      changed: mapChanged,
    };
  }

  const activeSession = input.sessions.find((session) => session.id === workspaceActive);
  if (!activeSession) {
    return {
      activeSessionIdMap: mapChanged ? nextMap : previousMap,
      sessions: input.sessions as T[],
      changed: mapChanged,
    };
  }
  if (activeSession.scope.type !== 'terminal' || !activeSession.scope.targetId) {
    return {
      activeSessionIdMap: mapChanged ? nextMap : previousMap,
      sessions: input.sessions as T[],
      changed: mapChanged,
    };
  }
  if (survivorTerminalIds.has(activeSession.scope.targetId)) {
    return {
      activeSessionIdMap: mapChanged ? nextMap : previousMap,
      sessions: input.sessions as T[],
      changed: mapChanged,
    };
  }

  return {
    activeSessionIdMap: mapChanged ? nextMap : previousMap,
    sessions: input.sessions.map((session) => (
      session.id !== workspaceActive
        ? session
        : {
            ...session,
            scope: {
              ...session.scope,
              type: 'terminal',
              targetId: preferredTerminalId,
            },
            updatedAt: Date.now(),
          }
    )),
    changed: true,
  };
}
