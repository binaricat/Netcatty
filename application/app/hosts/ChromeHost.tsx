import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { TERMINAL_THEMES } from '../../../infrastructure/config/terminalThemes';
import { retainStableSessionsIgnoringPresentation } from '../../../domain/terminalPaneSessionsEqual';
import { useI18n } from '../../i18n/I18nProvider';
import { useCustomThemes } from '../../state/customThemeStore';
import { useEditorTabChromeList } from '../../state/editorTabStore';
import { toEditorTabId } from '../../state/activeTabStore';
import {
  getSessionSnapshotActions,
  useSessionSnapshot,
  useSessionSnapshotActions,
} from '../../state/sessionSnapshotStore';
import { useSettingsChromeStore } from '../../state/settingsChromeStore';
import { useVaultSnapshot } from '../../state/vaultSnapshotStore';
import {
  getTerminalSettingsActions,
  useTerminalSettingsStore,
} from '../../state/terminalSettingsStore';
import { usePluginViewTabs } from '../../state/pluginViewTabStore';
import { getAppHandlers, subscribeAppHandlers } from '../appHandlersBridge';
import {
  publishAppShellChrome,
  publishAppShellDomainSlice,
} from '../appShellPropsStore';
import {
  getThemeRuntimeActions,
  subscribeThemeRuntimeActions,
} from '../themeRuntimeBridge';

const IS_MAC_CLIENT =
  typeof navigator !== 'undefined' && /Mac|Macintosh/.test(navigator.userAgent);

/**
 * Chrome island: TopTabs / active-tab chrome from settings chrome store,
 * appearance chrome, and selective session/vault snapshot fields. Assembles
 * chrome + shell chrome bags field-by-field — never spreads a prepared bag.
 */
export function ChromeHost() {
  const { t } = useI18n();
  const settingsChrome = useSettingsChromeStore();
  const session = useSessionSnapshot();
  const sessionActions = useSessionSnapshotActions();
  const vault = useVaultSnapshot();
  const terminalSettings = useTerminalSettingsStore();
  const editorTabs = useEditorTabChromeList();
  const pluginViewTabs = usePluginViewTabs();
  void pluginViewTabs;
  const customThemes = useCustomThemes();
  const handlers = useSyncExternalStore(
    subscribeAppHandlers,
    getAppHandlers,
    getAppHandlers,
  );
  const themeRuntime = useSyncExternalStore(
    subscribeThemeRuntimeActions,
    getThemeRuntimeActions,
    getThemeRuntimeActions,
  );

  const orphanSessionsForShellRef = useRef(session.orphanSessions);
  const orphanSessionsForShell = retainStableSessionsIgnoringPresentation(
    orphanSessionsForShellRef.current,
    session.orphanSessions as never,
  );
  orphanSessionsForShellRef.current = orphanSessionsForShell as typeof session.orphanSessions;

  const themeById = useMemo(
    () => new Map([...customThemes, ...TERMINAL_THEMES].map((theme) => [theme.id, theme])),
    [customThemes],
  );

  const hostById = useMemo(
    () => new Map(vault.hosts.map((host) => [host.id, host])),
    [vault.hosts],
  );

  const sessionById = useMemo(
    () => new Map(session.sessions.map((s) => [s.id, s])),
    [session.sessions],
  );

  const workspaceById = useMemo(
    () => new Map(session.workspaces.map((workspace) => [workspace.id, workspace])),
    [session.workspaces],
  );

  const editorTabTopIds = useMemo(
    () => editorTabs.map((tab) => toEditorTabId(tab.id)),
    [editorTabs],
  );
  const pluginViewTabIds = useMemo(
    () => pluginViewTabs.map((tab) => tab.id),
    [pluginViewTabs],
  );
  const additionalWorkTabIds = useMemo(
    () => [...editorTabTopIds, ...pluginViewTabIds],
    [editorTabTopIds, pluginViewTabIds],
  );

  const orderedTabsWithEditors = useMemo(
    () => sessionActions?.getOrderedWorkTabs(additionalWorkTabIds) ?? ['vault'],
    [additionalWorkTabIds, sessionActions],
  );

  const reorderWorkTabs = useCallback((
    draggedId: string,
    targetId: string,
    position: 'before' | 'after' = 'before',
  ) => {
    sessionActions?.reorderTabs(draggedId, targetId, position, additionalWorkTabIds);
  }, [additionalWorkTabIds, sessionActions]);

  const chromeDomain = useMemo(() => {
    if (!handlers) return null;
    return {
      closeLogView: sessionActions?.closeLogView,
      handleEndSessionDrag: handlers.handleEndSessionDrag,
      handleOpenQuickSwitcher: handlers.handleOpenQuickSwitcher,
      handleOpenSettings: handlers.handleOpenSettings,
      handleRootContextMenu: handlers.handleRootContextMenu,
      handleSyncNowManual: handlers.handleSyncNowManual,
      isMacClient: IS_MAC_CLIENT,
      logViews: session.logViews,
      openLogView: sessionActions?.openLogView,
      orderedTabsWithEditors,
      orphanSessions: orphanSessionsForShell,
      reorderWorkTabs,
      resetSessionRename: sessionActions?.resetSessionRename,
      resetWorkspaceRename: sessionActions?.resetWorkspaceRename,
      sessionRenameTarget: session.sessionRenameTarget,
      setActiveTabId: sessionActions?.setActiveTabId,
      startSessionRename: sessionActions?.startSessionRename,
      renameSessionInline: sessionActions?.renameSessionInline,
      startWorkspaceRename: sessionActions?.startWorkspaceRename,
      submitSessionRename: sessionActions?.submitSessionRename,
      submitWorkspaceRename: sessionActions?.submitWorkspaceRename,
      t,
      themeById,
      workspaceRenameTarget: session.workspaceRenameTarget,
    };
  }, [
    handlers,
    orderedTabsWithEditors,
    orphanSessionsForShell,
    reorderWorkTabs,
    session.logViews,
    session.sessionRenameTarget,
    session.workspaceRenameTarget,
    sessionActions,
    t,
    themeById,
  ]);

  // Call-time getters so chrome can publish before Publisher layout effects
  // register action slots — avoids undefined applyAppTheme/setActiveTabId on
  // the first Host publish (startup TypeError under StrictMode).
  const setActiveTabId = useCallback((id: string) => {
    getSessionSnapshotActions()?.setActiveTabId?.(id);
  }, []);
  const applyAppTheme = useCallback(() => {
    getTerminalSettingsActions()?.applyAppTheme?.();
  }, []);

  const appShellChrome = useMemo(() => {
    if (!handlers) return null;
    // Theme runtime actions may still be null on the first paint before
    // TerminalHost registers them; wait so AppActiveTabChrome never mounts
    // with a missing resolveSessionAppearance / currentTerminalTheme.
    if (!themeRuntime?.currentTerminalTheme || !themeRuntime?.resolveFocusedAppearance) {
      return null;
    }
    return {
      // The SFTP-tab guard only redirects when the SFTP surface is truly
      // unreachable; sidebar placement (sftpInSidebar) keeps it reachable
      // even when the top tab flag is off.
      showSftpTab: settingsChrome.showSftpTab || settingsChrome.sftpInSidebar,
      setActiveTabId,
      applyAppTheme,
      hostById,
      sessionById,
      themeById,
      workspaceById,
      currentTerminalTheme: themeRuntime.currentTerminalTheme,
      followAppTerminalTheme: terminalSettings.followAppTerminalTheme,
      editorTabs,
      logViews: session.logViews,
      resolveSessionAppearance: themeRuntime.resolveFocusedAppearance,
      t,
    };
  }, [
    applyAppTheme,
    editorTabs,
    handlers,
    hostById,
    session.logViews,
    sessionById,
    setActiveTabId,
    settingsChrome.showSftpTab,
    settingsChrome.sftpInSidebar,
    t,
    terminalSettings.followAppTerminalTheme,
    themeById,
    themeRuntime,
    workspaceById,
  ]);

  useLayoutEffect(() => {
    if (chromeDomain) publishAppShellDomainSlice('chrome', chromeDomain);
    if (appShellChrome) publishAppShellChrome(appShellChrome as never);
  }, [appShellChrome, chromeDomain]);

  return null;
}
