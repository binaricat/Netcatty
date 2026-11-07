import type {
  AIPanelView,
  AISession,
} from "../../infrastructure/ai/types.ts";

const DEFAULT_PANEL_VIEW: AIPanelView = { mode: "draft" };

export function panelViewsEqual(
  left: AIPanelView,
  right: AIPanelView,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.mode !== right.mode) {
    return false;
  }
  if (left.mode === "session" && right.mode === "session") {
    return left.sessionId === right.sessionId;
  }
  return true;
}

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
  anchorChatId?: string | null,
  preferredHistorySessionId?: string | null,
): AIPanelView {
  if (panelView) {
    return normalizePanelView(panelView, sessions);
  }

  // New terminal sessions should always start from a blank draft. History is
  // still available in the drawer, but never auto-resumed into a fresh SSH tab.
  // Explicit panelView above is the only way a terminal scope shows a session
  // (e.g. after dissolve handoff writes mode:session).
  if (scopeType === "terminal") {
    return DEFAULT_PANEL_VIEW;
  }

  // Workspace: keep the inherited/persisted active chat when the user starts
  // typing a follow-up. Merge seed often writes activeSessionIdMap only, with
  // no explicit panelView — if unsent draft outranked that selection, send
  // would createSession() while the main area still looked like the old chat.
  // Explicit "New Chat" clears the active map and writes mode:draft, so it
  // still wins via the panelView branch above.
  if (persistedSessionId && sessions.some((s) => s.id === persistedSessionId)) {
    return { mode: "session", sessionId: persistedSessionId };
  }

  if (hasDraft) {
    return DEFAULT_PANEL_VIEW;
  }

  // Prefer the workspace anchor, then the candidate selected by scoped
  // history's match-rank/recency ordering. Callers without a ranked candidate
  // retain the recency fallback below.
  if (anchorChatId && sessions.some((s) => s.id === anchorChatId)) {
    return { mode: "session", sessionId: anchorChatId };
  }
  // Scoped history already ranks exact/member matches before other scopes,
  // then sorts each rank by recency. Preserve its selected candidate instead
  // of letting a newer chat from another workspace overtake that match.
  const mostRecent = preferredHistorySessionId === undefined
    ? resolveMostRecentlyUpdatedSession(sessions)
    : sessions.find((session) => session.id === preferredHistorySessionId);
  if (mostRecent) {
    return { mode: "session", sessionId: mostRecent.id };
  }

  return DEFAULT_PANEL_VIEW;
}

/**
 * The most recently updated session by `updatedAt`, or null when the list is
 * empty. Ties keep the earlier entry so the result is deterministic.
 */
export function resolveMostRecentlyUpdatedSession(
  sessions: AISession[],
): AISession | null {
  let best: AISession | null = null;
  let bestUpdatedAt = 0;
  for (const session of sessions) {
    const updatedAt = session.updatedAt ?? 0;
    if (best === null || updatedAt > bestUpdatedAt) {
      best = session;
      bestUpdatedAt = updatedAt;
    }
  }
  return bestUpdatedAt > 0 ? best : null;
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

/**
 * Whether the panel should force `showDraftView` when the normalized view
 * differs from the explicit store view.
 *
 * Explicit session views must stay put while the session is still present in
 * the same scoped history list that `normalizePanelView` uses — otherwise a
 * one-frame history lag after draft send demotes the new chat into history
 * and reopens a blank draft (especially under StrictMode).
 *
 * `sessionExists` must NOT consult the global store alone: a session that
 * exists but is out of this scope's history must demote so the panel does not
 * stick on a blank draft with a ghost active-map entry.
 */
export function shouldForceDraftViewSync(
  explicitPanelView: AIPanelView | undefined,
  normalizedPanelView: AIPanelView,
  sessionExists: (sessionId: string) => boolean,
): boolean {
  if (!explicitPanelView || panelViewsEqual(normalizedPanelView, explicitPanelView)) {
    return false;
  }
  if (explicitPanelView.mode === "session" && sessionExists(explicitPanelView.sessionId)) {
    return false;
  }
  return true;
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
