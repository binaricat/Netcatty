import type {
  AIPanelView,
  AISession,
} from "../../infrastructure/ai/types.ts";

const DEFAULT_PANEL_VIEW: AIPanelView = { mode: "draft" };

interface HistorySessionSelectionActions {
  showSessionView: (sessionId: string) => void;
  setActiveSessionId: (sessionId: string) => void;
  closeHistory?: () => void;
}

interface DraftEntrySelectionActions {
  ensureDraft: () => void;
  showDraftView: () => void;
  preserveSessionView?: boolean;
}

export function resolveDisplayedPanelView(
  panelView: AIPanelView | undefined,
  hasDraft: boolean,
  sessions: AISession[],
  persistedSessionId?: string | null,
  scopeType: "terminal" | "workspace" = "workspace",
): AIPanelView {
  if (panelView) {
    return normalizePanelView(panelView, sessions);
  }

  if (hasDraft) {
    return DEFAULT_PANEL_VIEW;
  }

  // New terminal sessions should always start from a blank draft. History is
  // still available in the drawer, but never auto-resumed into a fresh SSH tab.
  if (scopeType === "terminal") {
    return DEFAULT_PANEL_VIEW;
  }

  // Honour the persisted active-session selection (survives cold mount)
  // before falling back to the newest history entry.
  if (persistedSessionId && sessions.some((s) => s.id === persistedSessionId)) {
    return { mode: "session", sessionId: persistedSessionId };
  }

  if (sessions[0]) {
    return { mode: "session", sessionId: sessions[0].id };
  }

  return DEFAULT_PANEL_VIEW;
}

export function normalizePanelView(
  panelView: AIPanelView,
  sessions: AISession[],
): AIPanelView {
  if (panelView.mode !== "session") {
    return panelView;
  }

  return sessions.some((session) => session.id === panelView.sessionId)
    ? panelView
    : DEFAULT_PANEL_VIEW;
}

export function resolveDisplayedSession(
  panelView: AIPanelView,
  sessions: AISession[],
): AISession | null {
  if (panelView.mode !== "session") {
    return null;
  }

  return sessions.find((session) => session.id === panelView.sessionId) ?? null;
}

export function applyHistorySessionSelection(
  sessionId: string,
  actions: HistorySessionSelectionActions,
): void {
  actions.showSessionView(sessionId);
  actions.setActiveSessionId(sessionId);
  actions.closeHistory?.();
}

export function applyDraftEntrySelection(
  actions: DraftEntrySelectionActions,
): void {
  actions.ensureDraft();
  if (!actions.preserveSessionView) {
    actions.showDraftView();
  }
}
