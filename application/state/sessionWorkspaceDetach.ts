import type { TerminalSession, Workspace } from "../../domain/models";
import { collectSessionIds, pruneWorkspaceNode } from "../../domain/workspace";

export type DetachSessionFromWorkspaceStateResult = {
  changed: boolean;
  sessions: TerminalSession[];
  workspaces: Workspace[];
  activeTabId?: string;
  dissolvedWorkspaceId?: string;
  replacementTabIds?: string[];
};

export type CloseSessionWorkspaceLayoutResult = {
  workspaces: Workspace[];
  removedWorkspaceId?: string;
  dissolvedWorkspaceId?: string;
  lastRemainingSessionId?: string;
};

type DetachSessionFromWorkspaceStateOptions = {
  sessions: TerminalSession[];
  workspaces: Workspace[];
  sessionId: string;
};

export function replaceDissolvedWorkspaceTabOrder(
  tabOrder: readonly string[],
  workspaceId: string | undefined,
  replacementTabIds: readonly string[] | undefined,
): string[] {
  if (!workspaceId || !replacementTabIds?.length) return [...tabOrder];

  const uniqueReplacementIds = replacementTabIds.filter((tabId, index, list) => (
    tabId && list.indexOf(tabId) === index
  ));
  if (uniqueReplacementIds.length === 0) return [...tabOrder];

  if (!tabOrder.includes(workspaceId)) {
    const hasAllReplacementIds = uniqueReplacementIds.every((tabId) => tabOrder.includes(tabId));
    return hasAllReplacementIds ? [...tabOrder] : [
      ...tabOrder,
      ...uniqueReplacementIds.filter((tabId) => !tabOrder.includes(tabId)),
    ];
  }

  const replacementIdSet = new Set(uniqueReplacementIds);
  let inserted = false;
  const nextOrder: string[] = [];

  for (const tabId of tabOrder) {
    if (tabId === workspaceId) {
      if (!inserted) {
        nextOrder.push(...uniqueReplacementIds);
        inserted = true;
      }
      continue;
    }
    if (!replacementIdSet.has(tabId)) {
      nextOrder.push(tabId);
    }
  }

  return nextOrder;
}

export function closeSessionWorkspaceLayoutState(
  workspaces: readonly Workspace[],
  workspaceId: string | undefined,
  sessionId: string,
): CloseSessionWorkspaceLayoutResult {
  if (!workspaceId) return { workspaces: [...workspaces] };

  let removedWorkspaceId: string | undefined;
  let dissolvedWorkspaceId: string | undefined;
  let lastRemainingSessionId: string | undefined;
  const nextWorkspaces = workspaces
    .map((workspace) => {
      if (workspace.id !== workspaceId) return workspace;
      const prunedRoot = pruneWorkspaceNode(workspace.root, sessionId);
      if (!prunedRoot) {
        removedWorkspaceId = workspace.id;
        return null;
      }

      const remainingSessionIds = collectSessionIds(prunedRoot);
      if (remainingSessionIds.length === 1) {
        dissolvedWorkspaceId = workspace.id;
        lastRemainingSessionId = remainingSessionIds[0];
        return null;
      }

      return { ...workspace, root: prunedRoot };
    })
    .filter((workspace): workspace is Workspace => Boolean(workspace));

  return {
    workspaces: nextWorkspaces,
    removedWorkspaceId,
    dissolvedWorkspaceId,
    lastRemainingSessionId,
  };
}

export function detachSessionFromWorkspaceState({
  sessions,
  workspaces,
  sessionId,
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
  let nextSessions = sessions.map((candidate) => (
    candidate.id === sessionId ? { ...candidate, workspaceId: undefined } : candidate
  ));

  if (!prunedRoot) {
    return {
      changed: true,
      sessions: nextSessions,
      workspaces: workspaces.filter((workspace) => workspace.id !== workspaceId),
      activeTabId: sessionId,
      dissolvedWorkspaceId: workspaceId,
      replacementTabIds: [sessionId],
    };
  }

  const remainingSessionIds = collectSessionIds(prunedRoot);
  if (remainingSessionIds.length === 1) {
    nextSessions = nextSessions.map((candidate) => (
      candidate.id === remainingSessionIds[0] ? { ...candidate, workspaceId: undefined } : candidate
    ));

    return {
      changed: true,
      sessions: nextSessions,
      workspaces: workspaces.filter((workspace) => workspace.id !== workspaceId),
      activeTabId: sessionId,
      dissolvedWorkspaceId: workspaceId,
      replacementTabIds: [sessionId, ...remainingSessionIds],
    };
  }

  const nextFocusedSessionId = remainingSessionIds.includes(targetWorkspace.focusedSessionId)
    ? targetWorkspace.focusedSessionId
    : remainingSessionIds[0];
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
