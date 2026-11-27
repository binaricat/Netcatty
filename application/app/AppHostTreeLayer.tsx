import React, { Suspense, lazy, memo, useMemo, useRef, useState } from 'react';

import { useActiveTabId } from '../state/activeTabStore';
import { useAppearanceChromeStore } from '../state/appearanceChromeStore';
import type { EditorTabChrome } from '../state/editorTabStore';
import type { LogView } from '../state/logViewState';
import { useTerminalHostTreeOpen } from '../state/terminalHostTreeStore';
import { useManualTerminalChromeSurfaceInjection } from '../state/useManualTerminalChromeSurfaceInjection';
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

const TerminalHostTreeSidebar = lazy(() =>
  import('../../components/terminalLayer/TerminalHostTreeSidebar').then((mod) => ({
    default: mod.TerminalHostTreeSidebar,
  })),
);

interface AppHostTreeLayerProps {
  enabled: boolean;
  hosts: Host[];
  customGroups: string[];
  groupConfigs: GroupConfig[];
  sessions: TerminalSession[];
  workspaces: Workspace[];
  editorTabs: readonly EditorTabChrome[];
  logViews: readonly LogView[];
  orderedTabs: readonly string[];
  currentTerminalTheme: TerminalTheme;
  followAppTerminalTheme: boolean;
  hostById: ReadonlyMap<string, Host>;
  themeById: ReadonlyMap<string, TerminalTheme>;
  resolveSessionAppearance?: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  onConnect: (host: Host) => void;
  onConnectRemoteDesktop?: (host: Host, protocol: 'vnc' | 'rdp') => void;
  onOpenSystemRemoteDesktop?: (host: Host, protocol: 'vnc' | 'rdp') => void;
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

function appHostTreeLayerAreEqual(
  prev: AppHostTreeLayerProps,
  next: AppHostTreeLayerProps,
): boolean {
  return prev.enabled === next.enabled
    && prev.hosts === next.hosts
    && prev.customGroups === next.customGroups
    && prev.groupConfigs === next.groupConfigs
    && prev.sessions === next.sessions
    && prev.workspaces === next.workspaces
    && prev.editorTabs === next.editorTabs
    && prev.logViews === next.logViews
    && prev.orderedTabs === next.orderedTabs
    // accentMode / customAccent intentionally omitted — read from
    // appearanceChromeStore so accent drag does not rebuild the App shell.
    && prev.currentTerminalTheme === next.currentTerminalTheme
    && prev.followAppTerminalTheme === next.followAppTerminalTheme
    && prev.hostById === next.hostById
    && prev.themeById === next.themeById
    && prev.resolveSessionAppearance === next.resolveSessionAppearance
    && prev.onConnect === next.onConnect
    && prev.onConnectRemoteDesktop === next.onConnectRemoteDesktop
    && prev.onOpenSystemRemoteDesktop === next.onOpenSystemRemoteDesktop
    && prev.onNewHost === next.onNewHost
    && prev.onEditHost === next.onEditHost
    && prev.onCreateLocalTerminal === next.onCreateLocalTerminal;
}

const AppHostTreeLayerInner: React.FC<AppHostTreeLayerProps> = ({
  enabled,
  hosts,
  customGroups,
  groupConfigs,
  sessions,
  workspaces,
  editorTabs,
  logViews,
  orderedTabs,
  currentTerminalTheme,
  followAppTerminalTheme,
  hostById,
  themeById,
  resolveSessionAppearance,
  onConnect,
  onConnectRemoteDesktop,
  onOpenSystemRemoteDesktop,
  onNewHost,
  onEditHost,
  onCreateLocalTerminal,
}) => {
  const activeTabId = useActiveTabId();
  const isHostTreeOpen = useTerminalHostTreeOpen();
  const { accentMode, customAccent } = useAppearanceChromeStore();
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
  const sidebarActive = surfaceVisible && enabled && isHostTreeOpen;
  const [hasMountedSidebar, setHasMountedSidebar] = useState(sidebarActive);
  if (sidebarActive && !hasMountedSidebar) {
    setHasMountedSidebar(true);
  }

  const activeHostId = useMemo(() => (
    sidebarActive
      ? resolveWorkTabActiveHostId({
          activeTabId,
          editorTabs,
          sessions,
          workspaces,
        })
      : undefined
  ), [activeTabId, editorTabs, sessions, sidebarActive, workspaces]);

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
  const lastActiveSidebarThemeRef = useRef(hostTreeTheme);
  if (sidebarActive) {
    lastActiveSidebarThemeRef.current = hostTreeTheme;
  }
  const sidebarPreviewTheme = sidebarActive
    ? hostTreeTheme
    : lastActiveSidebarThemeRef.current;

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
      {hasMountedSidebar ? (
        <Suspense fallback={null}>
          <TerminalHostTreeSidebar
            enabled={enabled}
            surfaceVisible={surfaceVisible}
            hosts={hosts}
            customGroups={customGroups}
            groupConfigs={groupConfigs}
            resolvedPreviewTheme={sidebarPreviewTheme}
            activeHostId={activeHostId}
            onConnect={onConnect}
            onConnectRemoteDesktop={onConnectRemoteDesktop}
            onOpenSystemRemoteDesktop={onOpenSystemRemoteDesktop}
            onNewHost={onNewHost}
            onEditHost={onEditHost}
            onCreateLocalTerminal={onCreateLocalTerminal}
          />
        </Suspense>
      ) : null}
    </div>
  );
};

export const AppHostTreeLayer = memo(AppHostTreeLayerInner, appHostTreeLayerAreEqual);
AppHostTreeLayer.displayName = 'AppHostTreeLayer';
