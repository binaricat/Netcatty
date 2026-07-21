import React, { useMemo } from 'react';

import { useActiveTabId } from '../state/activeTabStore';
import type { EditorTab } from '../state/editorTabStore';
import type { LogView } from '../state/logViewState';
import { useManualTerminalChromeSurfaceInjection } from '../state/useManualTerminalChromeSurfaceInjection';
import { TerminalHostTreeSidebar } from '../../components/terminalLayer/TerminalHostTreeSidebar';
import type {
  ResolvedAppearance,
  TerminalAppearanceHostScope,
} from '../../domain/terminalAppearanceRuntime';
import type { GroupConfig, Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
import { resolveActiveChromeTheme } from './activeChromeTheme';
import {
  isHostTreeWorkTabSurface,
  resolveWorkTabActiveHostId,
} from './workTabSurface';

interface AppHostTreeLayerProps {
  enabled: boolean;
  hosts: Host[];
  customGroups: string[];
  groupConfigs: GroupConfig[];
  sessions: TerminalSession[];
  workspaces: Workspace[];
  editorTabs: readonly EditorTab[];
  logViews: readonly LogView[];
  orderedTabs: readonly string[];
  accentMode: 'theme' | 'custom';
  currentTerminalTheme: TerminalTheme;
  customAccent: string;
  followAppTerminalTheme: boolean;
  hostById: ReadonlyMap<string, Host>;
  themeById: ReadonlyMap<string, TerminalTheme>;
  resolveSessionAppearance?: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  onConnect: (host: Host) => void;
  onNewHost?: (defaultGroup?: string) => void;
  onEditHost?: (host: Host) => void;
  onCreateLocalTerminal?: () => void;
}

export function getAppHostTreeLayerStyle(surfaceVisible: boolean): React.CSSProperties {
  return {
    visibility: surfaceVisible ? 'visible' : 'hidden',
    pointerEvents: surfaceVisible ? 'auto' : 'none',
    zIndex: surfaceVisible ? 30 : 0,
  };
}

export const AppHostTreeLayer: React.FC<AppHostTreeLayerProps> = ({
  enabled,
  hosts,
  customGroups,
  groupConfigs,
  sessions,
  workspaces,
  editorTabs,
  logViews,
  orderedTabs,
  accentMode,
  currentTerminalTheme,
  customAccent,
  followAppTerminalTheme,
  hostById,
  themeById,
  resolveSessionAppearance,
  onConnect,
  onNewHost,
  onEditHost,
  onCreateLocalTerminal,
}) => {
  const activeTabId = useActiveTabId();
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const workspaceIds = useMemo(() => new Set(workspaces.map((workspace) => workspace.id)), [workspaces]);
  const logViewIds = useMemo(() => new Set(logViews.map((logView) => logView.id)), [logViews]);
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const surfaceVisible = isHostTreeWorkTabSurface({
    enabled,
    activeTabId,
    logViewIds,
    orderedTabs,
    sessionIds,
    workspaceIds,
  });

  const activeHostId = useMemo(() => resolveWorkTabActiveHostId({
    activeTabId,
    editorTabs,
    sessions,
    workspaces,
  }), [activeTabId, editorTabs, sessions, workspaces]);

  const hostTreeTheme = useMemo(() => (
    resolveActiveChromeTheme({
      accentMode,
      activeTabId,
      currentTerminalTheme,
      customAccent,
      editorTabs,
      followAppTerminalTheme,
      hostById,
      logViews,
      resolveSessionAppearance,
      sessionById,
      themeById,
      workspaceById,
    }) ?? currentTerminalTheme
  ), [
    accentMode,
    activeTabId,
    currentTerminalTheme,
    customAccent,
    editorTabs,
    followAppTerminalTheme,
    hostById,
    logViews,
    resolveSessionAppearance,
    sessionById,
    themeById,
    workspaceById,
  ]);

  useManualTerminalChromeSurfaceInjection(
    hostTreeTheme,
    !followAppTerminalTheme && surfaceVisible,
  );

  return (
    <div
      className="absolute left-0 top-0 bottom-0 flex min-h-0"
      data-section="app-host-tree-layer"
      style={getAppHostTreeLayerStyle(surfaceVisible)}
    >
      <TerminalHostTreeSidebar
        enabled={enabled}
        surfaceVisible={surfaceVisible}
        hosts={hosts}
        customGroups={customGroups}
        groupConfigs={groupConfigs}
        resolvedPreviewTheme={hostTreeTheme}
        activeHostId={activeHostId}
        onConnect={onConnect}
        onNewHost={onNewHost}
        onEditHost={onEditHost}
        onCreateLocalTerminal={onCreateLocalTerminal}
      />
    </div>
  );
};
