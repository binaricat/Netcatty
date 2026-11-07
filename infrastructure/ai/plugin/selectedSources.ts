import type { TerminalSession, VaultNote, Workspace } from '../../../domain/models';
import { collectSessionIds } from '../../../domain/workspace';
import type { HostSelectedSource } from './trustedHostRuntime';

export interface SelectedSnapshot {
  activeTabId: string;
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
  note: VaultNote | null;
}

function selectedSessionId(snapshot: SelectedSnapshot): string | undefined {
  const workspace = snapshot.workspaces.find((item) => item.id === snapshot.activeTabId);
  return workspace?.focusedSessionId ?? (workspace ? collectSessionIds(workspace.root)[0] : snapshot.activeTabId);
}

// Receives host-selected snapshots only. No Host/Vault DTO serialization,
// inventory reader, terminal scrollback, credential fields, or command access.
export function buildSelectedPluginSources(getSnapshot: () => SelectedSnapshot): HostSelectedSource[] {
  const snapshot = getSnapshot();
  const workspace = snapshot.workspaces.find((item) => item.id === snapshot.activeTabId);
  const sessionId = selectedSessionId(snapshot);
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const sources: HostSelectedSource[] = [];
  const add = (scope: HostSelectedSource['scope'], key: string, title: string, value: unknown, current: () => boolean) => {
    sources.push({ scope, key, title: title.slice(0, 160), version: crypto.randomUUID(),
      readText: () => JSON.stringify(value), isCurrent: current });
  };
  const tabCurrent = () => getSnapshot().activeTabId === snapshot.activeTabId;
  if (workspace) {
    add('workspace', workspace.id, workspace.title, { title: workspace.title, panes: collectSessionIds(workspace.root).length },
      () => tabCurrent() && getSnapshot().workspaces.find((item) => item.id === workspace.id) === workspace);
  }
  if (workspace || session) add('tab', snapshot.activeTabId, workspace?.title ?? session.hostLabel,
    { title: workspace?.title ?? session.hostLabel, kind: workspace ? 'workspace' : 'terminal' }, tabCurrent);
  if (session) {
    const current = () => {
      const latest = getSnapshot();
      return latest.activeTabId === snapshot.activeTabId && selectedSessionId(latest) === session.id
        && latest.sessions.find((item) => item.id === session.id) === session;
    };
    add('session', session.id, session.hostLabel, { label: session.hostLabel, status: session.status, protocol: session.protocol ?? 'ssh' }, current);
    add('host', session.hostId || session.id, session.hostLabel,
      { label: session.hostLabel, hostname: session.hostname, username: session.username, port: session.port, protocol: session.protocol ?? 'ssh' }, current);
  }
  const note = snapshot.note;
  if (note) sources.push({ key: note.id, scope: 'note', title: note.title.slice(0, 160), version: crypto.randomUUID(),
    readText: () => note.content,
    isCurrent: () => getSnapshot().note === note });
  return sources;
}
