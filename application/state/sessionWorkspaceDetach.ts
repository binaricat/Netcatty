import type { TerminalSession, Workspace } from "../../domain/models";
import type { AIChatRecencyEntry } from "../../domain/aiSessionRecency";
import { resolveMostRecentlyActiveMemberTerminalId } from "../../domain/aiSessionRecency";
import { collectSessionIds, createEmptyWorkspaceRoot, pruneWorkspaceNode } from "../../domain/workspace";

export type DetachSessionFromWorkspaceStateResult = {
  changed: boolean;
  sessions: TerminalSession[];
  workspaces: Workspace[];
  activeTabId?: string;
};

export type CloseSessionWorkspaceLayoutResult = {
  workspaces: Workspace[];
};

export type CloseSessionsStateResult = {
  sessions: TerminalSession[];
  workspaces: Workspace[];
  tabOrder: string[];
  activeTabId?: string;
};

type DetachSessionFromWorkspaceStateOptions = {
  sessions: TerminalSession[];
  workspaces: Workspace[];
  sessionId: string;
  /**
   * AI chat store snapshot used to rank surviving members by chat recency.
   * Without a recency signal, terminal display still needs a live member.
   */
  aiSessions?: readonly AIChatRecencyEntry[];
};

/**
 * Resolve the member that should receive focus (or an anchor retarget) after a
 * member loss. Prefers the AI-chat recency winner; falls back to the still-
 * valid preferred (focused) member because that is explicit user intent, and
 * falls back to a surviving pane so focus mode never hides all terminals.
 */
const resolveSurvivingFocusMemberId = (
  remainingSessionIds: readonly string[],
  previousFocusedSessionId: string | undefined,
  aiSessions: readonly AIChatRecencyEntry[] | undefined,
): string | undefined => {
  if (previousFocusedSessionId && remainingSessionIds.includes(previousFocusedSessionId)) {
    return previousFocusedSessionId;
  }
  return resolveMostRecentlyActiveMemberTerminalId({
    memberTerminalIds: remainingSessionIds,
    aiSessions,
  }) ?? remainingSessionIds[0];
};

export function closeSessionWorkspaceLayoutState(
  workspaces: readonly Workspace[],
  workspaceId: string | undefined,
  sessionId: string,
  aiSessions?: readonly AIChatRecencyEntry[],
): CloseSessionWorkspaceLayoutResult {
  if (!workspaceId) return { workspaces: [...workspaces] };

  const nextWorkspaces = workspaces
    .map((workspace) => {
      if (workspace.id !== workspaceId) return workspace;
      const prunedRoot = pruneWorkspaceNode(workspace.root, sessionId);
      if (!prunedRoot) {
        // Issue #4098 phase 2: the last member closed, but the workspace is a
        // first-class entity — it survives with an empty root so its id (and
        // the AI chats anchored to it) survive restart and member churn.
        return {
          ...workspace,
          root: createEmptyWorkspaceRoot(),
          focusedSessionId: undefined,
          focusSessionOrder: [],
        };
      }

      const remainingSessionIds = collectSessionIds(prunedRoot);
      // Closing the focused session hands focus to the most-recently-active
      // surviving member when AI chat recency is available.
      const nextFocusedSessionId = resolveSurvivingFocusMemberId(
        remainingSessionIds,
        workspace.focusedSessionId,
        aiSessions,
      );
      const nextFocusSessionOrder = workspace.focusSessionOrder?.filter(
        (candidateId) => remainingSessionIds.includes(candidateId),
      );

      return {
        ...workspace,
        root: prunedRoot,
        focusedSessionId: nextFocusedSessionId,
        focusSessionOrder: nextFocusSessionOrder,
      };
    });

  return {
    workspaces: nextWorkspaces,
  };
}

/**
 * Apply a close-session action to the session list using the layout result.
 * Since issue #4098 phase 2 workspaces survive member loss (no dissolve), the
 * remaining members keep their workspace binding.
 */
export function applyCloseSessionToSessions(
  sessions: readonly TerminalSession[],
  sessionId: string,
): TerminalSession[] {
  return sessions.filter((session) => session.id !== sessionId);
}

export function isPreferredTabAvailableAfterClose(
  input: {
    preferredTabId: string | null | undefined;
    closedSessionId: string;
    layoutResult: CloseSessionWorkspaceLayoutResult;
    remainingSessions: readonly TerminalSession[];
  },
): input is {
  preferredTabId: string;
  closedSessionId: string;
  layoutResult: CloseSessionWorkspaceLayoutResult;
  remainingSessions: readonly TerminalSession[];
} {
  const { preferredTabId, closedSessionId, layoutResult, remainingSessions } = input;
  if (!preferredTabId || preferredTabId === closedSessionId) return false;
  if (preferredTabId === "vault" || preferredTabId === "sftp") return true;
  if (layoutResult.workspaces.some((workspace) => workspace.id === preferredTabId)) return true;
  return remainingSessions.some((session) => (
    session.id === preferredTabId
    && !session.workspaceId
    && !session.hiddenFromTabs
  ));
}

export function resolveActiveTabAfterCloseSession({
  currentActiveTabId,
  closedSessionId,
  layoutResult,
  remainingSessions,
  preferredTabId,
}: {
  currentActiveTabId: string | null;
  closedSessionId: string;
  workspaceId: string | undefined;
  layoutResult: CloseSessionWorkspaceLayoutResult;
  remainingSessions: readonly TerminalSession[];
  preferredTabId?: string | null;
}): string | null {
  const fallbackWorkspace = layoutResult.workspaces[layoutResult.workspaces.length - 1];
  const fallbackSolo = remainingSessions.filter((session) => !session.workspaceId && !session.hiddenFromTabs).slice(-1)[0];
  const preferredInput = {
    preferredTabId,
    closedSessionId,
    layoutResult,
    remainingSessions,
  };
  const preferredFallback = isPreferredTabAvailableAfterClose(preferredInput)
    ? preferredInput.preferredTabId
    : undefined;
  const fallback = preferredFallback
    ?? fallbackWorkspace?.id
    ?? fallbackSolo?.id
    ?? "vault";

  // Workspaces survive member loss (#4098 phase 2), so only a closed session
  // tab that was active needs a replacement.
  if (currentActiveTabId === closedSessionId) {
    return fallback;
  }

  return null;
}

export function closeSessionsState({
  sessions,
  workspaces,
  sessionIds,
  currentActiveTabId,
  preferredTabId,
  tabOrder,
  aiSessions,
}: {
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
  sessionIds: readonly string[];
  currentActiveTabId: string | null;
  preferredTabId?: string | null;
  tabOrder: readonly string[];
  aiSessions?: readonly AIChatRecencyEntry[];
}): CloseSessionsStateResult {
  let nextSessions = [...sessions];
  let nextWorkspaces = [...workspaces];
  let nextTabOrder = [...tabOrder];
  let nextActiveTabId = currentActiveTabId;
  let resolvedActiveTabId: string | undefined;

  for (const sessionId of new Set(sessionIds)) {
    const targetSession = nextSessions.find((session) => session.id === sessionId);
    if (!targetSession) continue;

    const workspaceId = targetSession.workspaceId;
    const layoutResult = closeSessionWorkspaceLayoutState(
      nextWorkspaces,
      workspaceId,
      sessionId,
      aiSessions,
    );
    nextWorkspaces = layoutResult.workspaces;
    nextSessions = applyCloseSessionToSessions(nextSessions, sessionId);

    const activeTabAfterClose = resolveActiveTabAfterCloseSession({
      currentActiveTabId: nextActiveTabId,
      closedSessionId: sessionId,
      workspaceId,
      layoutResult,
      remainingSessions: nextSessions,
      preferredTabId,
    });
    if (activeTabAfterClose) {
      nextActiveTabId = activeTabAfterClose;
      resolvedActiveTabId = activeTabAfterClose;
    }
  }

  return {
    sessions: nextSessions,
    workspaces: nextWorkspaces,
    tabOrder: nextTabOrder,
    activeTabId: resolvedActiveTabId,
  };
}

export function detachSessionFromWorkspaceState({
  sessions,
  workspaces,
  sessionId,
  aiSessions,
}: DetachSessionFromWorkspaceStateOptions): DetachSessionFromWorkspaceStateResult {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.workspaceId) {
    return { changed: false, sessions, workspaces };
  }

  const workspaceId = session.workspaceId;
  const targetWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!targetWorkspace) {
    return { changed: false, sessions, workspaces };
  }

  const prunedRoot = pruneWorkspaceNode(targetWorkspace.root, sessionId);
  const nextSessions = sessions.map((candidate) => (
    candidate.id === sessionId ? { ...candidate, workspaceId: undefined } : candidate
  ));

  if (!prunedRoot) {
    // Last member dragged out: the workspace entity survives with an empty
    // root (#4098 phase 2) so its id and anchored AI chats stay stable.
    return {
      changed: true,
      sessions: nextSessions,
      workspaces: workspaces.map((workspace) => (
        workspace.id === workspaceId
          ? {
              ...workspace,
              root: createEmptyWorkspaceRoot(),
              focusedSessionId: undefined,
              focusSessionOrder: [],
            }
          : workspace
      )),
      activeTabId: sessionId,
    };
  }

  const remainingSessionIds = collectSessionIds(prunedRoot);
  const nextFocusedSessionId = resolveSurvivingFocusMemberId(
    remainingSessionIds,
    targetWorkspace.focusedSessionId,
    aiSessions,
  );
  const nextFocusSessionOrder = (targetWorkspace.focusSessionOrder ?? [])
    .filter((candidateId, index, list) => (
      candidateId !== sessionId &&
      remainingSessionIds.includes(candidateId) &&
      list.indexOf(candidateId) === index
    ));
  for (const remainingSessionId of remainingSessionIds) {
    if (!nextFocusSessionOrder.includes(remainingSessionId)) {
      nextFocusSessionOrder.push(remainingSessionId);
    }
  }

  return {
    changed: true,
    sessions: nextSessions,
    workspaces: workspaces.map((workspace) => (
      workspace.id === workspaceId
        ? {
            ...workspace,
            root: prunedRoot,
            focusedSessionId: nextFocusedSessionId,
            focusSessionOrder: nextFocusSessionOrder,
          }
        : workspace
    )),
    activeTabId: sessionId,
  };
}
