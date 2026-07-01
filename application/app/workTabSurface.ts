import {
  fromEditorTabId,
  isEditorTabId,
} from '../state/activeTabStore';
import { applyCustomAccentToTerminalTheme, resolveHostTerminalThemeId } from '../../domain/terminalAppearance';
import { collectSessionIds } from '../../domain/workspace';
import type { EditorTab } from '../state/editorTabStore';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';

function uniqueTabIds(tabIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const tabId of tabIds) {
    if (!tabId || seen.has(tabId)) continue;
    seen.add(tabId);
    uniqueIds.push(tabId);
  }
  return uniqueIds;
}

export function isRootPageTabId(activeTabId: string): boolean {
  return activeTabId === 'vault' || activeTabId === 'sftp';
}

export function buildOrderedWorkTabIds(
  tabOrder: readonly string[],
  allTabIds: readonly string[],
): string[] {
  const uniqueAllTabIds = uniqueTabIds(allTabIds);
  const allTabIdSet = new Set(uniqueAllTabIds);
  const orderedIds = uniqueTabIds(tabOrder.filter((id) => allTabIdSet.has(id)));
  const orderedIdSet = new Set(orderedIds);
  const newIds = uniqueAllTabIds.filter((id) => !orderedIdSet.has(id));
  return [...orderedIds, ...newIds];
}

export function reorderWorkTabIds(
  tabOrder: readonly string[],
  allTabIds: readonly string[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after' = 'before',
): string[] {
  if (draggedId === targetId) return buildOrderedWorkTabIds(tabOrder, allTabIds);

  const currentOrder = buildOrderedWorkTabIds(tabOrder, allTabIds);
  const draggedIndex = currentOrder.indexOf(draggedId);
  const targetIndex = currentOrder.indexOf(targetId);
  if (draggedIndex === -1 || targetIndex === -1) return [...tabOrder];

  currentOrder.splice(draggedIndex, 1);

  let nextTargetIndex = targetIndex;
  if (draggedIndex < targetIndex) {
    nextTargetIndex -= 1;
  }
  if (position === 'after') {
    nextTargetIndex += 1;
  }

  currentOrder.splice(nextTargetIndex, 0, draggedId);
  return currentOrder;
}

export function isHostTreeWorkTabSurface({
  enabled,
  activeTabId,
  logViewIds = new Set(),
  orderedTabs,
  sessionIds,
  workspaceIds,
}: {
  enabled: boolean;
  activeTabId: string;
  logViewIds?: ReadonlySet<string>;
  orderedTabs: readonly string[];
  sessionIds: ReadonlySet<string>;
  workspaceIds: ReadonlySet<string>;
}): boolean {
  if (!enabled) return false;
  if (isRootPageTabId(activeTabId)) return false;
  return orderedTabs.includes(activeTabId)
    || isEditorTabId(activeTabId)
    || logViewIds.has(activeTabId)
    || sessionIds.has(activeTabId)
    || workspaceIds.has(activeTabId);
}

export function isTerminalContentTabSurface({
  activeTabId,
  sessionIds,
  workspaceIds,
}: {
  activeTabId: string;
  sessionIds: ReadonlySet<string>;
  workspaceIds: ReadonlySet<string>;
}): boolean {
  return sessionIds.has(activeTabId) || workspaceIds.has(activeTabId);
}

export function resolveWorkspaceTargetSession(
  workspace: Workspace,
  sessions: readonly TerminalSession[],
): TerminalSession | undefined {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  return resolveWorkspaceTargetSessionFromMap(workspace, sessionById);
}

export function resolveWorkspaceTargetSessionFromMap(
  workspace: Workspace,
  sessionById: ReadonlyMap<string, TerminalSession>,
): TerminalSession | undefined {
  const orderedSessionIds = collectSessionIds(workspace.root);
  const workspaceSessionIdSet = new Set(orderedSessionIds);
  const focusedSession = workspace.focusedSessionId
    ? sessionById.get(workspace.focusedSessionId)
    : undefined;
  const validFocusedSession = focusedSession && workspaceSessionIdSet.has(focusedSession.id)
    ? focusedSession
    : undefined;
  if (validFocusedSession) return validFocusedSession;
  for (const sessionId of orderedSessionIds) {
    const session = sessionById.get(sessionId);
    if (session) return session;
  }
  return undefined;
}

export function resolveWorkTabActiveHostId({
  activeTabId,
  editorTabs,
  sessions,
  workspaces,
}: {
  activeTabId: string;
  editorTabs: readonly EditorTab[];
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
}): string | null {
  if (isEditorTabId(activeTabId)) {
    const editorId = fromEditorTabId(activeTabId);
    return editorTabs.find((tab) => tab.id === editorId)?.hostId ?? null;
  }

  const activeSession = sessions.find((session) => session.id === activeTabId);
  if (activeSession) return activeSession.hostId ?? null;

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeTabId);
  if (!activeWorkspace) return null;

  const targetSession = resolveWorkspaceTargetSession(activeWorkspace, sessions);
  return targetSession?.hostId ?? null;
}

export function resolveWorkTabHostTreeTheme({
  activeHostId,
  accentMode,
  currentTerminalTheme,
  customAccent,
  followAppTerminalTheme,
  hostById,
  themeById,
}: {
  activeHostId: string | null;
  accentMode: 'theme' | 'custom';
  currentTerminalTheme: TerminalTheme;
  customAccent: string;
  followAppTerminalTheme: boolean;
  hostById: ReadonlyMap<string, Host>;
  themeById: ReadonlyMap<string, TerminalTheme>;
}): TerminalTheme {
  if (!activeHostId || followAppTerminalTheme) return currentTerminalTheme;

  const host = hostById.get(activeHostId) ?? null;
  const themeId = resolveHostTerminalThemeId(host, currentTerminalTheme.id);
  const baseTheme = themeById.get(themeId) ?? currentTerminalTheme;
  return applyCustomAccentToTerminalTheme(baseTheme, accentMode, customAccent);
}
