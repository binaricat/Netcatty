import { collectSessionIds } from '../../domain/workspace';
import { resolveMostRecentlyActiveMemberTerminalId } from '../../domain/aiSessionRecency';
import type { AIChatRecencyEntry } from '../../domain/aiSessionRecency';
import type { TerminalSession, Workspace } from '../../types';

export type PluginContributionContextValue = string | boolean | number | null;
export type PluginContributionContext = Record<string, PluginContributionContextValue>;

export interface TerminalPluginContributionContextOptions {
  surface: 'terminal/context' | 'terminal/toolbar' | 'statusBar' | 'keybinding';
  sessionId?: string;
  status?: TerminalSession['status'];
  hostId?: string;
  hostProtocol?: string;
  workspaceId?: string;
  hasSelection?: boolean;
  alternateScreen?: boolean;
  reconnectable?: boolean;
}

export function buildTerminalPluginContributionContext({
  surface,
  sessionId,
  status,
  hostId,
  hostProtocol,
  workspaceId,
  hasSelection,
  alternateScreen,
  reconnectable,
}: TerminalPluginContributionContextOptions): PluginContributionContext {
  return {
    'netcatty.surface': surface,
    ...(sessionId ? { 'terminal.sessionId': sessionId } : {}),
    ...(status ? { 'terminal.status': status } : {}),
    ...(hostId ? { 'host.id': hostId } : {}),
    ...(hostProtocol ? { 'host.protocol': hostProtocol } : {}),
    ...(workspaceId ? { 'workspace.id': workspaceId } : {}),
    ...(hasSelection === undefined ? {} : { 'terminal.hasSelection': hasSelection }),
    ...(alternateScreen === undefined ? {} : { 'terminal.alternateScreen': alternateScreen }),
    ...(reconnectable === undefined ? {} : { 'terminal.reconnectable': reconnectable }),
  };
}

export function resolveActivePluginKeybindingContext({
  activeTabId,
  sessions,
  workspaces,
  aiSessions,
}: {
  activeTabId: string;
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
  /** AI chat snapshot: resolves the workspace anchor and recency fallback (#4098 phase 2). */
  aiSessions?: readonly AIChatRecencyEntry[];
}): PluginContributionContext {
  const workspace = workspaces.find((candidate) => candidate.id === activeTabId);
  const activeSessionId = workspace
    ? resolveWorkspaceActiveTerminalId(workspace, aiSessions)
    : sessions.some((candidate) => candidate.id === activeTabId)
      ? activeTabId
      : undefined;
  const session = activeSessionId
    ? sessions.find((candidate) => candidate.id === activeSessionId)
    : undefined;
  const workspaceId = workspace?.id ?? session?.workspaceId;

  return {
    ...buildTerminalPluginContributionContext({
      surface: 'keybinding',
      sessionId: session?.id,
      status: session?.status,
      hostId: session?.hostId,
      hostProtocol: session?.protocol ?? (session ? 'ssh' : undefined),
      workspaceId,
    }),
    'netcatty.activeTabId': activeTabId,
  };
}

/**
 * Issue #4098 phase 2: the keybinding context's workspace session resolves by
 * id, never positionally — focused member first, then the terminal member that
 * owns the anchored chat, then the most-recently-active member by chat recency.
 */
function resolveWorkspaceActiveTerminalId(
  workspace: Workspace,
  aiSessions: readonly AIChatRecencyEntry[] | undefined,
): string | undefined {
  if (workspace.focusedSessionId && collectSessionIds(workspace.root).includes(workspace.focusedSessionId)) {
    return workspace.focusedSessionId;
  }

  const memberTerminalIds = collectSessionIds(workspace.root);
  if (memberTerminalIds.length === 1) {
    // A single-member workspace has exactly one candidate — not a positional
    // pick among many.
    return memberTerminalIds[0];
  }
  const anchorChat = workspace.anchorChatId
    ? aiSessions?.find((session) => session.id === workspace.anchorChatId && session.scope?.type === 'terminal')
    : undefined;

  const anchorOwner = anchorChat?.scope.targetId;
  return (anchorOwner && memberTerminalIds.includes(anchorOwner) ? anchorOwner : undefined)
    ?? resolveMostRecentlyActiveMemberTerminalId({ memberTerminalIds, aiSessions })
    ?? undefined;
}
