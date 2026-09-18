import { useEffect, useMemo } from 'react';

import {
  fromEditorTabId,
  isEditorTabId,
  useActiveTabId,
} from '../state/activeTabStore';
import { updateActiveChromeThemeDeps } from '../state/activeChromeThemeSync';
import { useActiveChromeTheme } from '../state/useActiveChromeTheme';
import { useAppearanceChromeStore } from '../state/appearanceChromeStore';
import { focusEditorInWindow } from '../state/editorWindowClient';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { resolveActiveChromeTheme } from './activeChromeTheme';
import type { TerminalAppearanceHostScope, ResolvedAppearance } from '../../domain/terminalAppearanceRuntime';
import type {
  Host,
  TerminalSession,
  TerminalTheme,
  Workspace,
} from '../../types';
import type { LogView } from '../state/logViewState';
import type { EditorTabChrome } from '../state/editorTabStore';

export interface AppActiveTabChromeProps {
  showSftpTab: boolean;
  setActiveTabId: (id: string) => void;
  applyAppTheme: () => void;
  hostById: Map<string, Host>;
  sessionById: Map<string, TerminalSession>;
  themeById: Map<string, TerminalTheme>;
  workspaceById: Map<string, Workspace>;
  currentTerminalTheme: TerminalTheme;
  followAppTerminalTheme: boolean;
  editorTabs: readonly EditorTabChrome[];
  logViews: readonly LogView[];
  resolveSessionAppearance?: (hostScope: TerminalAppearanceHostScope) => ResolvedAppearance;
  t: (key: string) => string;
}

/**
 * Owns the `activeTabId` subscription and the purely side-effectful "chrome"
 * work derived from it: window title and the SFTP-tab guard.
 * Extracted out of <App> so that switching top tabs only
 * re-renders this null-rendering component (and the self-subscribing leaves)
 * instead of forcing the entire App tree (which holds all vault/session/
 * settings state and rebuilds the giant AppView ctx) to re-render.
 *
 * Accent comes from appearanceChromeStore so color-picker drag does not
 * rebuild AppShell chrome props.
 */
export function AppActiveTabChrome({
  showSftpTab,
  setActiveTabId,
  applyAppTheme,
  hostById,
  sessionById,
  themeById,
  workspaceById,
  currentTerminalTheme,
  followAppTerminalTheme,
  editorTabs,
  logViews,
  resolveSessionAppearance,
  t,
}: AppActiveTabChromeProps) {
  const activeTabId = useActiveTabId();
  const { accentMode, customAccent } = useAppearanceChromeStore();

  useEffect(() => {
    if (!showSftpTab && activeTabId === 'sftp') {
      setActiveTabId('vault');
    }
  }, [showSftpTab, activeTabId, setActiveTabId]);

  useEffect(() => {
    if (!isEditorTabId(activeTabId)) return;
    const editorId = fromEditorTabId(activeTabId);
    if (!editorId) return;
    const tab = editorTabs.find((entry) => entry.id === editorId);
    if (tab?.placement !== 'window') return;
    void focusEditorInWindow(editorId);
    setActiveTabId('vault');
  }, [activeTabId, editorTabs, setActiveTabId]);

  const chromeThemeDeps = useMemo(() => ({
    accentMode,
    applyAppTheme,
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
  }), [
    accentMode,
    applyAppTheme,
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

  updateActiveChromeThemeDeps(chromeThemeDeps);

  const activeChromeTheme = useMemo(() => resolveActiveChromeTheme({
    ...chromeThemeDeps,
    activeTabId,
  }), [chromeThemeDeps, activeTabId]);

  useActiveChromeTheme({
    activeTheme: activeChromeTheme,
    applyAppTheme,
  });

  const editorTabFileNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of editorTabs) counts.set(tab.fileName, (counts.get(tab.fileName) ?? 0) + 1);
    return counts;
  }, [editorTabs]);

  const activeWindowTitle = useMemo(() => {
    if (activeTabId === 'vault') return 'Vaults';
    if (activeTabId === 'sftp') return 'SFTP';
    if (isEditorTabId(activeTabId)) {
      const editorTab = editorTabs.find((tab) => tab.id === fromEditorTabId(activeTabId));
      if (!editorTab) return 'Editor';
      const suffix = (editorTabFileNameCounts.get(editorTab.fileName) ?? 0) > 1
        ? ` · ${editorTab.remotePath.split('/').slice(-2, -1)[0] || '/'}`
        : '';
      return `${editorTab.fileName}${suffix}`;
    }
    const workspace = workspaceById.get(activeTabId);
    if (workspace) return workspace.title;
    const session = sessionById.get(activeTabId);
    if (session) return session.hostLabel;
    const logView = logViews.find((item) => item.id === activeTabId);
    if (logView) {
      const isLocal = logView.log.protocol === 'local' || logView.log.hostname === 'localhost';
      return `${t('tabs.logPrefix')} ${isLocal ? t('tabs.logLocal') : logView.log.hostname}`;
    }
    return 'Netcatty';
  }, [activeTabId, editorTabFileNameCounts, editorTabs, logViews, sessionById, t, workspaceById]);

  useEffect(() => {
    // Title is already memoized by activeTabId; skip redundant IPC when the
    // string did not change (e.g. two tabs sharing the same host label).
    let cancelled = false;
    const bridge = netcattyBridge.get();
    if (!bridge?.setWindowTitle) return;
    // Defer slightly so the title write does not compete with tab-switch paint.
    const timer = window.setTimeout(() => {
      if (!cancelled) void bridge.setWindowTitle?.(activeWindowTitle);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeWindowTitle]);

  return null;
}
