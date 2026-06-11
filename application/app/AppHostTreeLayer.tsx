import React, { useMemo } from 'react';

import { useActiveTabId } from '../state/activeTabStore';
import type { EditorTab } from '../state/editorTabStore';
import type { LogView } from '../state/logViewState';
import { TerminalHostTreeSidebar } from '../../components/terminalLayer/TerminalHostTreeSidebar';
import type { GroupConfig, Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
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
  resolvedPreviewTheme: TerminalTheme;
  onConnect: (host: Host) => void;
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
  resolvedPreviewTheme,
  onConnect,
  onCreateLocalTerminal,
}) => {
  const activeTabId = useActiveTabId();
  const sessionIds = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  const workspaceIds = useMemo(() => new Set(workspaces.map((workspace) => workspace.id)), [workspaces]);
  const logViewIds = useMemo(() => new Set(logViews.map((logView) => logView.id)), [logViews]);
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
        resolvedPreviewTheme={resolvedPreviewTheme}
        activeHostId={activeHostId}
        onConnect={onConnect}
        onCreateLocalTerminal={onCreateLocalTerminal}
      />
    </div>
  );
};
