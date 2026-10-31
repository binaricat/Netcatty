import { resolveSessionGroupSession } from '../../domain/sessionGroup';
import { collectSessionIds } from '../../domain/workspace';
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
}: {
  activeTabId: string;
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
}): PluginContributionContext {
  const workspace = workspaces.find((candidate) => candidate.id === activeTabId);
  const activeSessionId = workspace
    ? (workspace.focusedSessionId ?? collectSessionIds(workspace.root)[0])
    : resolveSessionGroupSession(sessions, activeTabId)?.id;
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
