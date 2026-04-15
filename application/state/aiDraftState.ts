import type {
  AIDraft,
  AIPanelView,
} from '../../infrastructure/ai/types';

type DraftsByScope = Partial<Record<string, AIDraft>>;
type PanelViewByScope = Partial<Record<string, AIPanelView>>;
type ActiveSessionIdMap = Record<string, string | null>;
type DraftMutationVersionByScope = Record<string, number>;
type DraftUploadGenerationByScope = Record<string, number>;

const DEFAULT_PANEL_VIEW: AIPanelView = { mode: 'draft' };

export function createEmptyDraft(agentId: string): AIDraft {
  return {
    text: '',
    agentId,
    attachments: [],
    selectedUserSkillSlugs: [],
    updatedAt: Date.now(),
  };
}

export function getDraftMutationVersionState(
  versionsByScope: DraftMutationVersionByScope,
  scopeKey: string,
): number {
  return versionsByScope[scopeKey] ?? 0;
}

export function bumpDraftMutationVersionState(
  versionsByScope: DraftMutationVersionByScope,
  scopeKey: string,
): DraftMutationVersionByScope {
  return {
    ...versionsByScope,
    [scopeKey]: getDraftMutationVersionState(versionsByScope, scopeKey) + 1,
  };
}

export function getDraftUploadGenerationState(
  generationsByScope: DraftUploadGenerationByScope,
  scopeKey: string,
): number {
  return generationsByScope[scopeKey] ?? 0;
}

export function bumpDraftUploadGenerationState(
  generationsByScope: DraftUploadGenerationByScope,
  scopeKey: string,
): DraftUploadGenerationByScope {
  return {
    ...generationsByScope,
    [scopeKey]: getDraftUploadGenerationState(generationsByScope, scopeKey) + 1,
  };
}

export function resolvePanelView(
  panelViewByScope: PanelViewByScope,
  scopeKey: string,
): AIPanelView {
  return panelViewByScope[scopeKey] ?? DEFAULT_PANEL_VIEW;
}

export function setDraftView(
  panelViewByScope: PanelViewByScope,
  scopeKey: string,
): PanelViewByScope {
  const currentPanelView = panelViewByScope[scopeKey];
  if (currentPanelView?.mode === 'draft') {
    return panelViewByScope;
  }

  return {
    ...panelViewByScope,
    [scopeKey]: DEFAULT_PANEL_VIEW,
  };
}

export function activateDraftView(
  activeSessionIdMap: ActiveSessionIdMap,
  panelViewByScope: PanelViewByScope,
  scopeKey: string,
): {
  activeSessionIdMap: ActiveSessionIdMap;
  panelViewByScope: PanelViewByScope;
} {
  const nextPanelViewByScope = setDraftView(panelViewByScope, scopeKey);
  const hasActiveSession = activeSessionIdMap[scopeKey] != null;

  if (!hasActiveSession) {
    return {
      activeSessionIdMap,
      panelViewByScope: nextPanelViewByScope,
    };
  }

  const nextActiveSessionIdMap = { ...activeSessionIdMap };
  delete nextActiveSessionIdMap[scopeKey];

  return {
    activeSessionIdMap: nextActiveSessionIdMap,
    panelViewByScope: nextPanelViewByScope,
  };
}

export function setSessionView(
  panelViewByScope: PanelViewByScope,
  scopeKey: string,
  sessionId: string,
): PanelViewByScope {
  return {
    ...panelViewByScope,
    [scopeKey]: { mode: 'session', sessionId },
  };
}

export function updateDraftForScope(
  draftsByScope: DraftsByScope,
  scopeKey: string,
  fallbackAgentId: string,
  updater: (draft: AIDraft) => AIDraft,
): DraftsByScope {
  const currentDraft = draftsByScope[scopeKey] ?? createEmptyDraft(fallbackAgentId);
  const nextDraft = updater(currentDraft);

  return {
    ...draftsByScope,
    [scopeKey]: nextDraft,
  };
}

export function ensureDraftForScopeState(
  draftsByScope: DraftsByScope,
  scopeKey: string,
  agentId: string,
): DraftsByScope {
  if (draftsByScope[scopeKey]) {
    return draftsByScope;
  }

  return {
    ...draftsByScope,
    [scopeKey]: createEmptyDraft(agentId),
  };
}

export function clearScopeDraftState(
  draftsByScope: DraftsByScope,
  panelViewByScope: PanelViewByScope,
  scopeKey: string,
): {
  draftsByScope: DraftsByScope;
  panelViewByScope: PanelViewByScope;
} {
  const hasDraft = Object.prototype.hasOwnProperty.call(draftsByScope, scopeKey);
  const hasPanelView = Object.prototype.hasOwnProperty.call(panelViewByScope, scopeKey);

  if (!hasDraft && !hasPanelView) {
    return {
      draftsByScope,
      panelViewByScope,
    };
  }

  return {
    draftsByScope: hasDraft
      ? (() => {
          const nextDrafts = { ...draftsByScope };
          delete nextDrafts[scopeKey];
          return nextDrafts;
        })()
      : draftsByScope,
    panelViewByScope: hasPanelView
      ? (() => {
          const nextPanelViews = { ...panelViewByScope };
          delete nextPanelViews[scopeKey];
          return nextPanelViews;
        })()
      : panelViewByScope,
  };
}

function isClosedTerminalScope(scopeKey: string, activeTerminalTargetIds: Set<string>) {
  if (!scopeKey.startsWith('terminal:')) return false;

  const targetId = scopeKey.slice('terminal:'.length);
  if (!targetId) return false;

  return !activeTerminalTargetIds.has(targetId);
}

export function pruneTerminalScopeState(
  draftsByScope: DraftsByScope,
  panelViewByScope: PanelViewByScope,
  activeTerminalTargetIds: Set<string>,
): {
  draftsByScope: DraftsByScope;
  panelViewByScope: PanelViewByScope;
} {
  const nextDraftsByScope = { ...draftsByScope };
  const nextPanelViewByScope = { ...panelViewByScope };
  let draftsChanged = false;
  let panelViewsChanged = false;

  for (const scopeKey of Object.keys(nextDraftsByScope)) {
    if (!isClosedTerminalScope(scopeKey, activeTerminalTargetIds)) continue;
    delete nextDraftsByScope[scopeKey];
    draftsChanged = true;
  }

  for (const scopeKey of Object.keys(nextPanelViewByScope)) {
    if (!isClosedTerminalScope(scopeKey, activeTerminalTargetIds)) continue;
    delete nextPanelViewByScope[scopeKey];
    panelViewsChanged = true;
  }

  return {
    draftsByScope: draftsChanged ? nextDraftsByScope : draftsByScope,
    panelViewByScope: panelViewsChanged ? nextPanelViewByScope : panelViewByScope,
  };
}

export function pruneTerminalTransientState(
  activeSessionIdMap: ActiveSessionIdMap,
  draftsByScope: DraftsByScope,
  panelViewByScope: PanelViewByScope,
  activeTerminalTargetIds: Set<string>,
): {
  activeSessionIdMap: ActiveSessionIdMap;
  draftsByScope: DraftsByScope;
  panelViewByScope: PanelViewByScope;
} {
  let activeSessionMapChanged = false;
  const nextActiveSessionIdMap: ActiveSessionIdMap = {};

  for (const [scopeKey, sessionId] of Object.entries(activeSessionIdMap)) {
    if (isClosedTerminalScope(scopeKey, activeTerminalTargetIds)) {
      activeSessionMapChanged = true;
      continue;
    }

    nextActiveSessionIdMap[scopeKey] = sessionId;
  }

  const nextTerminalScopeState = pruneTerminalScopeState(
    draftsByScope,
    panelViewByScope,
    activeTerminalTargetIds,
  );

  return {
    activeSessionIdMap: activeSessionMapChanged ? nextActiveSessionIdMap : activeSessionIdMap,
    draftsByScope: nextTerminalScopeState.draftsByScope,
    panelViewByScope: nextTerminalScopeState.panelViewByScope,
  };
}
