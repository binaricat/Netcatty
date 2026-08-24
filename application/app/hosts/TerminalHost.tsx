import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { TERMINAL_THEME_AUTO } from '../../../domain/terminalAppearance';
import { retainStableSessionsIgnoringPresentation } from '../../../domain/terminalPaneSessionsEqual';
import { getAppSettingsRuntime } from '../../state/appRuntimeBridge';
import { useAppearanceChromeStore } from '../../state/appearanceChromeStore';
import { useCustomThemes } from '../../state/customThemeStore';
import {
  useSessionSnapshot,
  useSessionSnapshotActions,
} from '../../state/sessionSnapshotStore';
import {
  useSettingsChromeActions,
  useSettingsChromeStore,
} from '../../state/settingsChromeStore';
import {
  useTerminalSettingsActions,
  useTerminalSettingsStore,
} from '../../state/terminalSettingsStore';
import { useThemeRuntime, useTerminalAppearanceInjection } from '../../state/useThemeRuntime';
import {
  useVaultSnapshot,
  useVaultSnapshotActions,
} from '../../state/vaultSnapshotStore';
import { getAppHandlers, subscribeAppHandlers } from '../appHandlersBridge';
import { publishAppShellDomainSlice } from '../appShellPropsStore';
import { useAppLocalUiStore } from '../appLocalUiStore';
import { registerThemeRuntimeActions } from '../themeRuntimeBridge';

/**
 * Terminal island: sessions from `sessionSnapshotStore`, terminal settings
 * from `terminalSettingsStore`, mutators via snapshot actions, theme runtime
 * owned here, glue handlers from the app handlers bridge. Assembles the full
 * terminal domain bag field-by-field — never spreads a prepared bag.
 */
export function TerminalHost() {
  const session = useSessionSnapshot();
  const sessionActions = useSessionSnapshotActions();
  const vault = useVaultSnapshot();
  const vaultActions = useVaultSnapshotActions();
  const terminalSettings = useTerminalSettingsStore();
  const terminalSettingsActions = useTerminalSettingsActions();
  const {
    followAppTerminalTheme,
    terminalThemeId,
    terminalThemeDarkId,
    terminalThemeLightId,
  } = terminalSettings;
  const settingsChrome = useSettingsChromeStore();
  const settingsChromeActions = useSettingsChromeActions();
  const appearance = useAppearanceChromeStore();
  const customThemes = useCustomThemes();
  const local = useAppLocalUiStore();
  const handlers = useSyncExternalStore(
    subscribeAppHandlers,
    getAppHandlers,
    getAppHandlers,
  );

  // Call-time getters: SettingsPublisher registers the runtime in a layout
  // effect after this Host's first render. Capturing noop setters into
  // useThemeRuntime would permanently drop follow-app UI theme persistence.
  const setLightUiThemeId = useCallback((id: string) => {
    getAppSettingsRuntime()?.setLightUiThemeId?.(id);
  }, []);
  const setDarkUiThemeId = useCallback((id: string) => {
    getAppSettingsRuntime()?.setDarkUiThemeId?.(id);
  }, []);

  const themeRuntime = useThemeRuntime({
    terminalThemeId,
    terminalThemeDarkId,
    terminalThemeLightId,
    followAppTerminalTheme,
    resolvedTheme: settingsChrome.resolvedTheme,
    lightUiThemeId: settingsChrome.lightUiThemeId,
    darkUiThemeId: settingsChrome.darkUiThemeId,
    accentMode: appearance.accentMode,
    customAccent: appearance.customAccent,
    customThemes,
    setTheme: settingsChromeActions.setTheme,
    setLightUiThemeId,
    setDarkUiThemeId,
  });

  const {
    globalAppearance,
    accentedGlobalAppearance,
    clearIntent: clearThemeIntent,
    settleManualIntent: settleManualThemeIntent,
    pickTheme: pickTerminalTheme,
    resolveFocusedAppearance,
    currentTerminalTheme,
  } = themeRuntime;

  // Inject live accent into CSS vars without publishing accented theme identity
  // into the terminal domain bag (accent drag must not rebuild AppShell).
  useTerminalAppearanceInjection(accentedGlobalAppearance, {
    includeChromeSurfaces: followAppTerminalTheme,
  });

  const prevFollowAppTerminalThemeRef = useRef(followAppTerminalTheme);
  useLayoutEffect(() => {
    if (prevFollowAppTerminalThemeRef.current === followAppTerminalTheme) return;
    prevFollowAppTerminalThemeRef.current = followAppTerminalTheme;
    clearThemeIntent();
  }, [followAppTerminalTheme, clearThemeIntent]);

  // Bridge exposes the stable base theme only — ChromeHost must not republish
  // when accentedGlobalAppearance identity churns during color-picker drag.
  const themeBridgeActions = useMemo(() => ({
    clearThemeIntent,
    settleManualThemeIntent,
    pickTerminalTheme,
    resolveFocusedAppearance: resolveFocusedAppearance as (...args: never[]) => unknown,
    currentTerminalTheme,
    globalAppearance,
  }), [
    clearThemeIntent,
    currentTerminalTheme,
    globalAppearance,
    pickTerminalTheme,
    resolveFocusedAppearance,
    settleManualThemeIntent,
  ]);

  useLayoutEffect(() => {
    registerThemeRuntimeActions(themeBridgeActions);
    return () => {
      registerThemeRuntimeActions(null);
    };
  }, [themeBridgeActions]);

  const sessionsForShellRef = useRef(session.sessions);
  const sessionsForShell = retainStableSessionsIgnoringPresentation(
    sessionsForShellRef.current,
    session.sessions as never,
  );
  sessionsForShellRef.current = sessionsForShell as typeof session.sessions;

  const hostById = useMemo(
    () => new Map(vault.hosts.map((host) => [host.id, host])),
    [vault.hosts],
  );

  const terminalHosts = useMemo(
    () => (
      local.ephemeralHosts.length > 0
        ? [...vault.hosts, ...local.ephemeralHosts]
        : vault.hosts
    ),
    [local.ephemeralHosts, vault.hosts],
  );

  const handleDefaultTerminalThemeChange = useCallback((themeId: string) => {
    // Persist the default theme for ephemeral/manual hosts. Mode overrides
    // reset to auto so the chosen theme becomes the new baseline for the
    // current resolved UI mode (same behavior as pre-Host App).
    terminalSettingsActions?.setTerminalThemeId(themeId);
    if (settingsChrome.resolvedTheme === 'dark') {
      terminalSettingsActions?.setTerminalThemeDarkId(TERMINAL_THEME_AUTO);
    } else {
      terminalSettingsActions?.setTerminalThemeLightId(TERMINAL_THEME_AUTO);
    }
  }, [settingsChrome.resolvedTheme, terminalSettingsActions]);

  const handleFollowAppTerminalThemeChange = useCallback((themeId: string) => {
    pickTerminalTheme(themeId);
  }, [pickTerminalTheme]);

  const terminalDomain = useMemo(() => {
    if (!handlers) return null;
    return {
      addSessionToWorkspace: sessionActions?.addSessionToWorkspace,
      appendHostToWorkspace: sessionActions?.appendHostToWorkspace,
      appendLocalTerminalToWorkspace: sessionActions?.appendLocalTerminalToWorkspace,
      clearSessionFontSizeOverride: sessionActions?.clearSessionFontSizeOverride,
      closeSession: sessionActions?.closeSession,
      closeTabsBatch: handlers.closeTabsBatch,
      copySessionWithCurrentShell: handlers.copySessionWithCurrentShell,
      copyWorkspaceWithCurrentShell: handlers.copyWorkspaceWithCurrentShell,
      copySessionToNewWindowWithCurrentShell: handlers.copySessionToNewWindowWithCurrentShell,
      closeWorkspace: sessionActions?.closeWorkspace,
      createWorkspaceFromSessions: sessionActions?.createWorkspaceFromSessions,
      createWorkspaceFromTargets: handlers.createWorkspaceFromTargets,
      createWorkspaceWithHosts: handlers.createWorkspaceWithHosts,
      currentTerminalTheme,
      draggingSessionId: session.draggingSessionId,
      editorWordWrap: terminalSettings.editorWordWrap,
      followAppTerminalTheme: terminalSettings.followAppTerminalTheme,
      clearThemeIntent,
      settleManualThemeIntent,
      pickTerminalTheme,
      resolveSessionAppearance: resolveFocusedAppearance,
      handleConnectSerial: handlers.handleConnectSerial,
      handleConnectToHost: handlers.handleConnectToHost,
      handleCreateLocalTerminal: handlers.handleCreateLocalTerminal,
      handleDefaultTerminalThemeChange,
      handleFollowAppTerminalThemeChange,
      handleHotkeyAction: handlers.handleHotkeyAction,
      handleSessionStatusChange: handlers.handleSessionStatusChange,
      handleTerminalDataCapture: handlers.handleTerminalDataCapture,
      handleUpdateHostFromTerminal: handlers.handleUpdateHostFromTerminal,
      hostById,
      terminalHosts,
      updateTerminalHosts: handlers.updateTerminalHosts,
      hotkeyScheme: terminalSettings.hotkeyScheme,
      isBroadcastEnabled: sessionActions?.isBroadcastEnabled,
      keyBindings: terminalSettings.keyBindings,
      openNoteRequest: local.openNoteRequest,
      portForwardingRules: local.portForwardingRules,
      removeSessionFromWorkspace: sessionActions?.removeSessionFromWorkspace,
      reorderWorkspaceSessions: sessionActions?.reorderWorkspaceSessions,
      runSnippet: handlers.runSnippet,
      sessionLogsDir: terminalSettings.sessionLogsDir,
      sessionLogsEnabled: terminalSettings.sessionLogsEnabled,
      sessionLogsFormat: terminalSettings.sessionLogsFormat,
      sessionLogsTimestampsEnabled: terminalSettings.sessionLogsTimestampsEnabled,
      sessions: sessionsForShell,
      setDraggingSessionId: sessionActions?.setDraggingSessionId,
      setEditorWordWrap: terminalSettingsActions?.setEditorWordWrap,
      setTerminalFontFamilyId: terminalSettingsActions?.setTerminalFontFamilyId,
      setTerminalFontSize: terminalSettingsActions?.setTerminalFontSize,
      setWorkspaceFocusedSession: sessionActions?.setWorkspaceFocusedSession,
      sftpAutoOpenSidebar: terminalSettings.sftpAutoOpenSidebar,
      sftpFollowTerminalCwd: terminalSettings.sftpFollowTerminalCwd,
      setSftpFollowTerminalCwd: terminalSettingsActions?.setSftpFollowTerminalCwd,
      sftpAutoSync: terminalSettings.sftpAutoSync,
      sftpDefaultViewMode: terminalSettings.sftpDefaultViewMode,
      sftpDoubleClickBehavior: terminalSettings.sftpDoubleClickBehavior,
      sftpShowHiddenFiles: terminalSettings.sftpShowHiddenFiles,
      sftpUseCompressedUpload: terminalSettings.sftpUseCompressedUpload,
      splitSessionWithCurrentShell: handlers.splitSessionWithCurrentShell,
      sshDebugLogsEnabled: terminalSettings.sshDebugLogsEnabled,
      terminalFontFamilyId: terminalSettings.terminalFontFamilyId,
      terminalFontSize: terminalSettings.terminalFontSize,
      terminalSettings: terminalSettings.terminalSettings,
      terminalThemeId: terminalSettings.terminalThemeId,
      toggleBroadcast: sessionActions?.toggleBroadcast,
      toggleScriptsSidePanelRef: handlers.toggleScriptsSidePanelRef,
      toggleSidePanelRef: handlers.toggleSidePanelRef,
      terminalPaneMagnificationRef: handlers.terminalPaneMagnificationRef,
      sftpPaneMagnificationRef: handlers.sftpPaneMagnificationRef,
      toggleWorkspaceViewMode: sessionActions?.toggleWorkspaceViewMode,
      updateHostDistro: vaultActions?.updateHostDistro,
      updateSplitSizes: sessionActions?.updateSplitSizes,
      updateSessionFontSize: sessionActions?.updateSessionFontSize,
      updateSessionRestoreCwd: sessionActions?.updateSessionRestoreCwd,
      updateSessionDynamicTitle: sessionActions?.updateSessionDynamicTitle,
      updateSessionCodingCliProvider: sessionActions?.updateSessionCodingCliProvider,
      updateTerminalSetting: terminalSettingsActions?.updateTerminalSetting,
      workspaces: session.workspaces,
    };
  }, [
    clearThemeIntent,
    currentTerminalTheme,
    handleDefaultTerminalThemeChange,
    handleFollowAppTerminalThemeChange,
    handlers,
    hostById,
    local.openNoteRequest,
    local.portForwardingRules,
    pickTerminalTheme,
    resolveFocusedAppearance,
    session.draggingSessionId,
    session.workspaces,
    sessionActions,
    sessionsForShell,
    settleManualThemeIntent,
    terminalHosts,
    terminalSettings,
    terminalSettingsActions,
    vaultActions,
  ]);

  useLayoutEffect(() => {
    if (terminalDomain) publishAppShellDomainSlice('terminal', terminalDomain);
  }, [terminalDomain]);

  return null;
}
