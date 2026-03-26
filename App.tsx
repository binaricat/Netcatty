import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeTabStore, useActiveTabId, useIsSftpActive, useIsTerminalLayerVisible, useIsVaultActive } from './application/state/activeTabStore';
import { useAutoSync } from './application/state/useAutoSync';
import { useImmersiveMode } from './application/state/useImmersiveMode';
import { useManagedSourceSync } from './application/state/useManagedSourceSync';
import { usePortForwardingAutoStart } from './application/state/usePortForwardingAutoStart';
import { usePortForwardingState } from './application/state/usePortForwardingState';
import { useSessionState } from './application/state/useSessionState';
import { useSettingsState } from './application/state/useSettingsState';
import { useUpdateCheck } from './application/state/useUpdateCheck';
import { useVaultState } from './application/state/useVaultState';
import { useWindowControls } from './application/state/useWindowControls';
import { initializeFonts } from './application/state/fontStore';
import { initializeUIFonts } from './application/state/uiFontStore';
import { I18nProvider, useI18n } from './application/i18n/I18nProvider';
import { matchesKeyBinding } from './domain/models';
import { resolveHostAuth } from './domain/sshAuth';
import { resolveHostTerminalThemeId } from './domain/terminalAppearance';
import { collectSessionIds } from './domain/workspace';
import { TERMINAL_THEMES } from './infrastructure/config/terminalThemes';
import { useCustomThemes } from './application/state/customThemeStore';
import { applySyncPayload } from './application/syncPayload';
import { getCredentialProtectionAvailability } from './infrastructure/services/credentialProtection';
import { netcattyBridge } from './infrastructure/services/netcattyBridge';
import { localStorageAdapter } from './infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_DEBUG_HOTKEYS } from './infrastructure/config/storageKeys';
import { TopTabs } from './components/TopTabs';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { ToastProvider, toast } from './components/ui/toast';
import { VaultView, VaultSection } from './components/VaultView';
import { KeyboardInteractiveModal, KeyboardInteractiveRequest } from './components/KeyboardInteractiveModal';
import { PassphraseModal, PassphraseRequest } from './components/PassphraseModal';
import { cn } from './lib/utils';
import { classifyLocalShellType } from './lib/localShell';
import { ConnectionLog, Host, HostProtocol, SerialConfig, TerminalSession, TerminalTheme } from './types';
import { LogView as LogViewType } from './application/state/useSessionState';
import type { SftpView as SftpViewComponent } from './components/SftpView';
import type { TerminalLayer as TerminalLayerComponent } from './components/TerminalLayer';

// Initialize fonts eagerly at app startup
initializeFonts();
initializeUIFonts();

// Visibility container for VaultView - isolates isActive subscription
const VaultViewContainer: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isActive = useIsVaultActive();
  const containerStyle: React.CSSProperties = isActive
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

  return (
    <div className={cn("absolute inset-0", isActive ? "z-20" : "")} style={containerStyle}>
      {children}
    </div>
  );
};

// LogView wrapper - manages visibility based on active tab
interface LogViewWrapperProps {
  logView: LogViewType;
  defaultTerminalTheme: TerminalTheme;
  defaultFontSize: number;
  onClose: () => void;
  onUpdateLog: (logId: string, updates: Partial<ConnectionLog>) => void;
}

const LogViewWrapper: React.FC<LogViewWrapperProps> = ({ logView, defaultTerminalTheme, defaultFontSize, onClose, onUpdateLog }) => {
  const activeTabId = useActiveTabId();
  const isVisible = activeTabId === logView.id;

  // Use same pattern as VaultViewContainer for visibility
  const containerStyle: React.CSSProperties = isVisible
    ? {}
    : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };

  return (
    <div className={cn("absolute inset-0", isVisible ? "z-20" : "")} style={containerStyle}>
      <Suspense fallback={null}>
        <LazyLogView
          log={logView.log}
          defaultTerminalTheme={defaultTerminalTheme}
          defaultFontSize={defaultFontSize}
          isVisible={isVisible}
          onClose={onClose}
          onUpdateLog={onUpdateLog}
        />
      </Suspense>
    </div>
  );
};

const LazyLogView = lazy(() => import('./components/LogView'));
const LazyProtocolSelectDialog = lazy(() => import('./components/ProtocolSelectDialog'));
const LazyQuickSwitcher = lazy(() =>
  import('./components/QuickSwitcher').then((m) => ({ default: m.QuickSwitcher })),
);
const LazyCreateWorkspaceDialog = lazy(() =>
  import('./components/CreateWorkspaceDialog').then((m) => ({ default: m.CreateWorkspaceDialog })),
);

const IS_DEV = import.meta.env.DEV;
const HOTKEY_DEBUG =
  IS_DEV &&
  localStorageAdapter.readString(STORAGE_KEY_DEBUG_HOTKEYS) === "1";

const LazySftpView = lazy(() =>
  import('./components/SftpView').then((m) => ({ default: m.SftpView })),
);

const LazyTerminalLayer = lazy(() =>
  import('./components/TerminalLayer').then((m) => ({ default: m.TerminalLayer })),
);

type SettingsState = ReturnType<typeof useSettingsState>;
type SftpViewProps = React.ComponentProps<typeof SftpViewComponent>;
type TerminalLayerProps = React.ComponentProps<typeof TerminalLayerComponent>;

const SftpViewMount: React.FC<SftpViewProps> = (props) => {
  const isActive = useIsSftpActive();
  const [shouldMount, setShouldMount] = useState(isActive);

  useEffect(() => {
    if (isActive) setShouldMount(true);
  }, [isActive]);

  if (!shouldMount) return null;

  return (
    <Suspense fallback={null}>
      <LazySftpView {...props} />
    </Suspense>
  );
};

const TerminalLayerMount: React.FC<TerminalLayerProps> = (props) => {
  const isVisible = useIsTerminalLayerVisible(props.draggingSessionId);
  const [shouldMount, setShouldMount] = useState(isVisible);

  useEffect(() => {
    if (isVisible) setShouldMount(true);
  }, [isVisible]);

  useEffect(() => {
    if (shouldMount) return;
    // Warm up the terminal layer shortly after first paint to reduce latency when opening a session.
    const id = window.setTimeout(() => setShouldMount(true), 1200);
    return () => window.clearTimeout(id);
  }, [shouldMount]);

  if (!shouldMount) return null;

  return (
    <Suspense fallback={null}>
      <LazyTerminalLayer {...props} />
    </Suspense>
  );
};

function App({ settings }: { settings: SettingsState }) {
  const { t } = useI18n();

  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [isCreateWorkspaceOpen, setIsCreateWorkspaceOpen] = useState(false);
  const [quickSearch, setQuickSearch] = useState('');
  // Protocol selection dialog state for QuickSwitcher
  const [protocolSelectHost, setProtocolSelectHost] = useState<Host | null>(null);
  // Navigation state for VaultView sections
  const [navigateToSection, setNavigateToSection] = useState<VaultSection | null>(null);
  // Keyboard-interactive authentication queue (2FA/MFA) - queue-based to handle multiple concurrent sessions
  const [keyboardInteractiveQueue, setKeyboardInteractiveQueue] = useState<KeyboardInteractiveRequest[]>([]);
  // Passphrase request queue for encrypted SSH keys
  const [passphraseQueue, setPassphraseQueue] = useState<PassphraseRequest[]>([]);

  const {
    setTheme,
    resolvedTheme,
    setTerminalThemeId,
    currentTerminalTheme,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    hotkeyScheme,
    keyBindings,
    isHotkeyRecording,
    sftpDoubleClickBehavior,
    sftpAutoSync,
    sftpShowHiddenFiles,
    sftpUseCompressedUpload,
    sftpAutoOpenSidebar,
    editorWordWrap,
    setEditorWordWrap,
    sessionLogsEnabled,
    sessionLogsDir,
    sessionLogsFormat,
    reapplyCurrentTheme,
    immersiveMode,
  } = settings;

  const {
    hosts,
    keys,
    identities,
    snippets,
    customGroups,
    snippetPackages,
    knownHosts,
    shellHistory,
    connectionLogs,
    managedSources,
    updateHosts,
    updateKeys,
    updateIdentities,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    updateManagedSources,
    addShellHistoryEntry,
    addConnectionLog,
    updateConnectionLog,
    toggleConnectionLogSaved,
    deleteConnectionLog,
    clearUnsavedConnectionLogs,
    updateHostDistro,
    convertKnownHostToHost,
    importDataFromString,
  } = useVaultState();

  const {
    sessions,
    workspaces,
    setActiveTabId,
    draggingSessionId,
    setDraggingSessionId,
    sessionRenameTarget,
    sessionRenameValue,
    setSessionRenameValue,
    startSessionRename,
    submitSessionRename,
    resetSessionRename,
    workspaceRenameTarget,
    workspaceRenameValue,
    setWorkspaceRenameValue,
    startWorkspaceRename,
    submitWorkspaceRename,
    resetWorkspaceRename,
    createLocalTerminal,
    createSerialSession,
    connectToHost,
    closeSession,
    closeWorkspace,
    updateSessionStatus,
    createWorkspaceWithHosts,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    updateSplitSizes,
    splitSession,
    toggleWorkspaceViewMode,
    setWorkspaceFocusedSession,
    moveFocusInWorkspace,
    runSnippet,
    orphanSessions,
    orderedTabs,
    reorderTabs,
    toggleBroadcast,
    isBroadcastEnabled,
    logViews,
    openLogView,
    closeLogView,
    copySession,
  } = useSessionState();

  // isMacClient is used for window controls styling
  const isMacClient = typeof navigator !== 'undefined' && /Mac|Macintosh/.test(navigator.userAgent);

  // ---------------------------------------------------------------------------
  // Immersive Mode — derive UI chrome colors from the active terminal's theme
  // ---------------------------------------------------------------------------
  const activeTabId = useActiveTabId();
  const customThemes = useCustomThemes();

  // Resolve the effective TerminalTheme for the currently focused terminal tab
  const activeTerminalTheme = useMemo<TerminalTheme | null>(() => {
    if (activeTabId === 'vault' || activeTabId === 'sftp') return null;

    const resolveTheme = (s: TerminalSession): TerminalTheme => {
      const host = hosts.find(h => h.id === s.hostId) ?? null;
      const themeId = resolveHostTerminalThemeId(host, currentTerminalTheme.id);
      return TERMINAL_THEMES.find(t => t.id === themeId)
        || customThemes.find(t => t.id === themeId)
        || currentTerminalTheme;
    };

    // Workspace
    const workspace = workspaces.find(w => w.id === activeTabId);
    if (workspace) {
      // Focus mode: use the focused (or first remaining) session's theme
      if (workspace.viewMode === 'focus') {
        const wsSessionIds = collectSessionIds(workspace.root);
        const focused = sessions.find(s => s.id === workspace.focusedSessionId)
          ?? sessions.find(s => wsSessionIds.includes(s.id));
        return focused ? resolveTheme(focused) : null;
      }
      // Split mode: require all sessions to share the same theme
      const sessionIds = collectSessionIds(workspace.root);
      const wsSessions = sessionIds.map(id => sessions.find(s => s.id === id)).filter(Boolean) as TerminalSession[];
      if (wsSessions.length === 0) return null;
      const firstTheme = resolveTheme(wsSessions[0]);
      const allSame = wsSessions.every(s => resolveTheme(s).id === firstTheme.id);
      return allSame ? firstTheme : null;
    }

    // Single session tab
    const session = sessions.find(s => s.id === activeTabId);
    if (!session) return null;
    return resolveTheme(session);
  }, [activeTabId, sessions, workspaces, hosts, currentTerminalTheme, customThemes]);

  useImmersiveMode({
    isImmersive: immersiveMode,
    activeTabId,
    activeTerminalTheme,
    restoreOriginalTheme: reapplyCurrentTheme,
  });

  // Get port forwarding rules and import function
  const { rules: portForwardingRules, importRules: importPortForwardingRules, startTunnel, stopTunnel } = usePortForwardingState();

  const portForwardingRulesForSync = useMemo(
    () =>
      portForwardingRules.map((rule) => ({
        ...rule,
        status: "inactive",
        error: undefined,
        lastUsedAt: undefined,
      })),
    [portForwardingRules],
  );

  // Auto-sync hook for cloud sync
  const { syncNow: handleSyncNow } = useAutoSync({
    hosts,
    keys,
    identities,
    snippets,
    customGroups,
    snippetPackages,
    portForwardingRules: portForwardingRulesForSync,
    knownHosts,
    settingsVersion: settings.settingsVersion,
    onApplyPayload: (payload) => {
      applySyncPayload(payload, {
        importVaultData: importDataFromString,
        importPortForwardingRules,
        onSettingsApplied: settings.rehydrateAllFromStorage,
      });
    },
  });

  const { clearAndRemoveSource, clearAndRemoveSources, unmanageSource } = useManagedSourceSync({
    hosts,
    managedSources,
    onUpdateManagedSources: updateManagedSources,
  });

  const handleSyncNowManual = useCallback(() => {
    return handleSyncNow({ trigger: 'manual' });
  }, [handleSyncNow]);

  // Update check hook - checks for new versions on startup
  const { updateState, dismissUpdate, installUpdate } = useUpdateCheck();

  // Window controls - must be before update toast effect which uses openSettingsWindow
  const { openSettingsWindow } = useWindowControls();

  // Show toast notification when update is available (only when auto-download is idle)
  useEffect(() => {
    // Skip "update available" toast if auto-download has already started or completed
    if (updateState.autoDownloadStatus !== 'idle') return;
    // Don't show automatic notification when auto-update is disabled
    if (localStorageAdapter.readString('netcatty_auto_update_enabled_v1') === 'false') return;
    if (updateState.hasUpdate && updateState.latestRelease) {
      const version = updateState.latestRelease.version;
      toast.info(
        t('update.available.message', { version }),
        {
          title: t('update.available.title'),
          duration: 8000, // Show longer for update notifications
          onClick: () => {
            void openSettingsWindow();
            // Dismiss the update so the toast doesn't re-fire on every render.
            // On unsupported platforms (where autoDownloadStatus stays 'idle')
            // this is the only way to suppress the notification for this version.
            // On supported platforms this toast only shows before auto-download
            // starts, and the Settings window's own useUpdateCheck will pick up
            // the download state via IPC events independently of the dismiss.
            dismissUpdate();
          },
          actionLabel: t('update.viewInSettings'),
        }
      );
    }
  }, [updateState.hasUpdate, updateState.latestRelease, updateState.autoDownloadStatus, t, openSettingsWindow, dismissUpdate]);

  // Track previous autoDownloadStatus so toast effects fire only on actual transitions,
  // not when unrelated deps (installUpdate, openSettingsWindow) change their reference.
  const prevAutoDownloadStatusRef = useRef(updateState.autoDownloadStatus);
  useEffect(() => {
    const prev = prevAutoDownloadStatusRef.current;
    prevAutoDownloadStatusRef.current = updateState.autoDownloadStatus;
    if (prev === updateState.autoDownloadStatus) return;

    if (updateState.autoDownloadStatus === 'ready') {
      const version = updateState.latestRelease?.version ?? '';
      toast.info(
        t('update.readyToInstall.message', { version }),
        {
          title: t('update.readyToInstall.title'),
          duration: 0,
          actionLabel: t('update.restartNow'),
          onClick: () => installUpdate(),
        }
      );
    } else if (updateState.autoDownloadStatus === 'error') {
      toast.error(
        t('update.downloadFailed.message'),
        {
          title: t('update.downloadFailed.title'),
          actionLabel: t('update.viewInSettings'),
          onClick: () => void openSettingsWindow(),
        }
      );
    }
  }, [updateState.autoDownloadStatus, updateState.latestRelease?.version, t, installUpdate, openSettingsWindow]);

  // Auto-start port forwarding rules on app launch
  usePortForwardingAutoStart({
    hosts,
    keys,
    identities,
  });

  // Sync tray menu data + handle tray actions
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.updateTrayMenuData) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;

      const sessionsForTray = sessions.map((s) => {
        const ws = s.workspaceId ? workspaces.find((w) => w.id === s.workspaceId) : undefined;
        return {
          id: s.id,
          label: s.hostname,
          hostLabel: s.hostLabel,
          status: s.status,
          workspaceId: s.workspaceId,
          workspaceTitle: ws?.title,
        };
      });

      void bridge.updateTrayMenuData({
        sessions: sessionsForTray,
        portForwardRules: portForwardingRules,
      });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessions, portForwardingRules, workspaces]);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onTrayFocusSession || !bridge?.onTrayTogglePortForward) return;

    const unsubscribeFocus = bridge.onTrayFocusSession((sessionId) => {
      // Find the session to check if it belongs to a workspace
      const session = sessions.find((s) => s.id === sessionId);
      if (session?.workspaceId) {
        // Session is in a workspace - navigate to workspace and focus the session
        setActiveTabId(session.workspaceId);
        setWorkspaceFocusedSession(session.workspaceId, sessionId);
      } else {
        // Standalone session or session not found - just set tab
        setActiveTabId(sessionId);
      }
    });

    const unsubscribeToggle = bridge.onTrayTogglePortForward((ruleId, start) => {
      const rule = portForwardingRules.find((r) => r.id === ruleId);
      if (!rule) return;
      const host = rule.hostId ? hosts.find((h) => h.id === rule.hostId) : undefined;
      if (!host) {
        toast.error(t("pf.error.hostNotFound"));
        return;
      }

      if (start) {
        void startTunnel(rule, host, hosts, keys, identities, (status, error) => {
          if (status === "error" && error) toast.error(error);
        }, rule.autoStart);
      } else {
        void stopTunnel(ruleId);
      }
    });

    return () => {
      unsubscribeFocus?.();
      unsubscribeToggle?.();
    };
  }, [hosts, identities, keys, portForwardingRules, sessions, setActiveTabId, setWorkspaceFocusedSession, startTunnel, stopTunnel, t]);

  // Tray panel actions (from main process)
  useEffect(() => {
    const handlerJump = (sessionId: string) => {
      // Find the session to check if it belongs to a workspace
      const session = sessions.find((s) => s.id === sessionId);
      if (session?.workspaceId) {
        // Session is in a workspace - navigate to workspace and focus the session
        setActiveTabId(session.workspaceId);
        setWorkspaceFocusedSession(session.workspaceId, sessionId);
      } else {
        // Standalone session or session not found - just set tab
        setActiveTabId(sessionId);
      }
    };

    const handlerConnect = (hostId: string) => {
      const host = hosts.find((h) => h.id === hostId);
      if (!host) {
        toast.error(t("pf.error.hostNotFound"));
        return;
      }

      const { username, hostname: localHost } = systemInfoRef.current;
      if (host.protocol === 'serial') {
        const portName = host.hostname.split('/').pop() || host.hostname;
        const sessionId = connectToHost(host);
        addConnectionLog({
          sessionId,
          hostId: host.id,
          hostLabel: host.label || `Serial: ${portName}`,
          hostname: host.hostname,
          username,
          protocol: 'serial',
          startTime: Date.now(),
          localUsername: username,
          localHostname: localHost,
          saved: false,
        });
        return;
      }

      const protocol = host.moshEnabled ? 'mosh' : (host.protocol || 'ssh');
      const resolvedAuth = resolveHostAuth({ host, keys, identities });
      const sessionId = connectToHost(host);
      addConnectionLog({
        sessionId,
        hostId: host.id,
        hostLabel: host.label,
        hostname: host.hostname,
        username: resolvedAuth.username || 'root',
        protocol: protocol as 'ssh' | 'telnet' | 'local' | 'mosh',
        startTime: Date.now(),
        localUsername: username,
        localHostname: localHost,
        saved: false,
      });
    };

    const bridge = netcattyBridge.get();
    if (!bridge?.onTrayPanelJumpToSession || !bridge?.onTrayPanelConnectToHost) return;

    const unsubscribeJump = bridge.onTrayPanelJumpToSession(handlerJump);
    const unsubscribeConnect = bridge.onTrayPanelConnectToHost(handlerConnect);
    return () => {
      unsubscribeJump?.();
      unsubscribeConnect?.();
    };
  }, [addConnectionLog, connectToHost, hosts, identities, keys, sessions, setActiveTabId, setWorkspaceFocusedSession, t]);

  // Keyboard-interactive authentication (2FA/MFA) event listener
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onKeyboardInteractive) return;

    const unsubscribe = bridge.onKeyboardInteractive((request) => {
      console.log('[App] Keyboard-interactive request received:', request);
      // Add to queue instead of replacing - supports multiple concurrent sessions
      setKeyboardInteractiveQueue(prev => [...prev, {
        requestId: request.requestId,
        name: request.name,
        instructions: request.instructions,
        prompts: request.prompts,
        hostname: request.hostname,
        savedPassword: request.savedPassword,
      }]);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Handle keyboard-interactive submit
  const handleKeyboardInteractiveSubmit = useCallback((requestId: string, responses: string[]) => {
    const bridge = netcattyBridge.get();
    if (bridge?.respondKeyboardInteractive) {
      void bridge.respondKeyboardInteractive(requestId, responses, false);
    }
    // Remove from queue by requestId
    setKeyboardInteractiveQueue(prev => prev.filter(r => r.requestId !== requestId));
  }, []);

  // Handle keyboard-interactive cancel
  const handleKeyboardInteractiveCancel = useCallback((requestId: string) => {
    const bridge = netcattyBridge.get();
    if (bridge?.respondKeyboardInteractive) {
      void bridge.respondKeyboardInteractive(requestId, [], true);
    }
    // Remove from queue by requestId
    setKeyboardInteractiveQueue(prev => prev.filter(r => r.requestId !== requestId));
  }, []);

  // Passphrase request event listener for encrypted SSH keys
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPassphraseRequest) return;

    const unsubscribe = bridge.onPassphraseRequest((request) => {
      console.log('[App] Passphrase request received:', request);
      setPassphraseQueue(prev => [...prev, {
        requestId: request.requestId,
        keyPath: request.keyPath,
        keyName: request.keyName,
        hostname: request.hostname,
      }]);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Handle passphrase submit
  const handlePassphraseSubmit = useCallback((requestId: string, passphrase: string) => {
    const bridge = netcattyBridge.get();
    if (bridge?.respondPassphrase) {
      void bridge.respondPassphrase(requestId, passphrase, false);
    }
    setPassphraseQueue(prev => prev.filter(r => r.requestId !== requestId));
  }, []);

  // Handle passphrase cancel
  const handlePassphraseCancel = useCallback((requestId: string) => {
    const bridge = netcattyBridge.get();
    if (bridge?.respondPassphrase) {
      // Cancel = stop the entire passphrase flow
      void bridge.respondPassphrase(requestId, '', true);
    }
    setPassphraseQueue(prev => prev.filter(r => r.requestId !== requestId));
  }, []);

  // Handle passphrase skip (skip this key, continue with others)
  const handlePassphraseSkip = useCallback((requestId: string) => {
    const bridge = netcattyBridge.get();
    if (bridge?.respondPassphraseSkip) {
      // Skip = skip this key but continue asking for others
      void bridge.respondPassphraseSkip(requestId);
    } else if (bridge?.respondPassphrase) {
      // Fallback for older API
      void bridge.respondPassphrase(requestId, '', false);
    }
    setPassphraseQueue(prev => prev.filter(r => r.requestId !== requestId));
  }, []);

  // Handle passphrase timeout (request expired on backend)
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPassphraseTimeout) return;

    const unsubscribe = bridge.onPassphraseTimeout((event) => {
      console.log('[App] Passphrase request timed out:', event.requestId);
      // Remove from queue - the modal will close automatically
      setPassphraseQueue(prev => prev.filter(r => r.requestId !== event.requestId));
      // Show a toast notification to inform user
      toast.error('Passphrase request timed out. Please try connecting again.');
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Debounce ref for moveFocus to prevent double-triggering when focus switches
  const lastMoveFocusTimeRef = useRef<number>(0);
  const MOVE_FOCUS_DEBOUNCE_MS = 200;

  // Use ref to store addConnectionLog to avoid circular dependencies with executeHotkeyAction
  const addConnectionLogRef = useRef(addConnectionLog);
  addConnectionLogRef.current = addConnectionLog;

  const createLocalTerminalWithCurrentShell = useCallback(() => {
    return createLocalTerminal({
      shellType: classifyLocalShellType(terminalSettings.localShell, navigator.userAgent),
    });
  }, [createLocalTerminal, terminalSettings.localShell]);

  const splitSessionWithCurrentShell = useCallback((sessionId: string, direction: 'horizontal' | 'vertical') => {
    return splitSession(sessionId, direction, {
      localShellType: classifyLocalShellType(terminalSettings.localShell, navigator.userAgent),
    });
  }, [splitSession, terminalSettings.localShell]);

  const copySessionWithCurrentShell = useCallback((sessionId: string) => {
    return copySession(sessionId, {
      localShellType: classifyLocalShellType(terminalSettings.localShell, navigator.userAgent),
    });
  }, [copySession, terminalSettings.localShell]);

  // Shared hotkey action handler - used by both global handler and terminal callback
  const executeHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    switch (action) {
      case 'switchToTab': {
        // Get the number key pressed (1-9)
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9) {
          // Build complete tab list: vault + sftp + sessions/workspaces
          const allTabs = ['vault', 'sftp', ...orderedTabs];
          if (num <= allTabs.length) {
            setActiveTabId(allTabs[num - 1]);
          }
        }
        break;
      }
      case 'nextTab': {
        // Build complete tab list: vault + sftp + sessions/workspaces
        const allTabs = ['vault', 'sftp', ...orderedTabs];
        const currentId = activeTabStore.getActiveTabId();
        const currentIdx = allTabs.indexOf(currentId);
        if (currentIdx !== -1 && allTabs.length > 0) {
          const nextIdx = (currentIdx + 1) % allTabs.length;
          setActiveTabId(allTabs[nextIdx]);
        } else if (allTabs.length > 0) {
          setActiveTabId(allTabs[0]);
        }
        break;
      }
      case 'prevTab': {
        // Build complete tab list: vault + sftp + sessions/workspaces
        const allTabs = ['vault', 'sftp', ...orderedTabs];
        const currentId = activeTabStore.getActiveTabId();
        const currentIdx = allTabs.indexOf(currentId);
        if (currentIdx !== -1 && allTabs.length > 0) {
          const prevIdx = (currentIdx - 1 + allTabs.length) % allTabs.length;
          setActiveTabId(allTabs[prevIdx]);
        } else if (allTabs.length > 0) {
          setActiveTabId(allTabs[allTabs.length - 1]);
        }
        break;
      }
      case 'closeTab': {
        const currentId = activeTabStore.getActiveTabId();
        if (currentId !== 'vault' && currentId !== 'sftp') {
          // Find if it's a session or workspace
          const session = sessions.find(s => s.id === currentId);
          if (session) {
            closeSession(currentId);
          } else {
            const workspace = workspaces.find(w => w.id === currentId);
            if (workspace) {
              closeWorkspace(currentId);
            }
          }
        }
        break;
      }
      case 'newTab':
      case 'openLocal':
        // Add connection log for local terminal
        addConnectionLogRef.current({
          hostId: '',
          hostLabel: 'Local Terminal',
          hostname: 'localhost',
          username: systemInfoRef.current.username,
          protocol: 'local',
          startTime: Date.now(),
          localUsername: systemInfoRef.current.username,
          localHostname: systemInfoRef.current.hostname,
          saved: false,
        });
        createLocalTerminalWithCurrentShell();
        break;
      case 'openHosts':
        setActiveTabId('vault');
        break;
      case 'openSftp':
        setActiveTabId('sftp');
        break;
      case 'quickSwitch':
      case 'commandPalette':
        setIsQuickSwitcherOpen(true);
        break;
      case 'portForwarding':
        // Navigate to vault and open port forwarding section
        setActiveTabId('vault');
        setNavigateToSection('port');
        break;
      case 'snippets':
        // Navigate to vault and open snippets section
        setActiveTabId('vault');
        setNavigateToSection('snippets');
        break;
      case 'broadcast': {
        // Toggle broadcast mode for the active workspace
        const currentId = activeTabStore.getActiveTabId();
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeWs) {
          toggleBroadcast(activeWs.id);
        }
        break;
      }
      case 'splitHorizontal': {
        // Split current terminal horizontally (top/bottom)
        const currentId = activeTabStore.getActiveTabId();
        // Check if it's a standalone session or we're in a workspace
        const activeSession = sessions.find(s => s.id === currentId);
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeSession && !activeSession.workspaceId) {
          // Standalone session - split it
          splitSessionWithCurrentShell(activeSession.id, 'horizontal');
        } else if (activeWs) {
          // In a workspace - need to determine focused session
          // For now, we'll need the terminal to handle this via context menu
          if (IS_DEV) console.log('[Hotkey] Split horizontal in workspace - use context menu on specific terminal');
        }
        break;
      }
      case 'splitVertical': {
        // Split current terminal vertically (left/right)
        const currentId = activeTabStore.getActiveTabId();
        const activeSession = sessions.find(s => s.id === currentId);
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeSession && !activeSession.workspaceId) {
          // Standalone session - split it
          splitSessionWithCurrentShell(activeSession.id, 'vertical');
        } else if (activeWs) {
          // In a workspace - need to determine focused session
          if (IS_DEV) console.log('[Hotkey] Split vertical in workspace - use context menu on specific terminal');
        }
        break;
      }
      case 'moveFocus': {
        // Debounce to prevent double-triggering when focus switches between terminals
        const now = Date.now();
        if (now - lastMoveFocusTimeRef.current < MOVE_FOCUS_DEBOUNCE_MS) {
          if (IS_DEV) console.log('[App] moveFocus debounced, ignoring');
          break;
        }
        lastMoveFocusTimeRef.current = now;

        // Move focus between split panes
        if (IS_DEV) console.log('[App] moveFocus action triggered, key:', e.key);
        const direction = e.key === 'ArrowUp' ? 'up'
          : e.key === 'ArrowDown' ? 'down'
            : e.key === 'ArrowLeft' ? 'left'
              : e.key === 'ArrowRight' ? 'right'
                : null;
        if (IS_DEV) console.log('[App] moveFocus direction:', direction);
        if (direction) {
          // Find the active workspace
          const currentId = activeTabStore.getActiveTabId();
          if (IS_DEV) console.log('[App] Active tab ID:', currentId);
          const activeWs = workspaces.find(w => w.id === currentId);
          if (IS_DEV) console.log('[App] Active workspace:', activeWs?.id, activeWs?.title);
          if (activeWs) {
            const result = moveFocusInWorkspace(activeWs.id, direction as 'up' | 'down' | 'left' | 'right');
            if (IS_DEV) console.log('[App] moveFocusInWorkspace result:', result);
          } else {
            if (IS_DEV) console.log('[App] No active workspace found');
          }
        }
        break;
      }
    }
  }, [orderedTabs, sessions, workspaces, setActiveTabId, closeSession, closeWorkspace, createLocalTerminalWithCurrentShell, splitSessionWithCurrentShell, moveFocusInWorkspace, toggleBroadcast]);

  // Callback for terminal to invoke app-level hotkey actions
  const handleHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    executeHotkeyAction(action, e);
  }, [executeHotkeyAction]);

  // Global hotkey handler
  useEffect(() => {
    if (hotkeyScheme === 'disabled' || isHotkeyRecording) return;

    const isMac = hotkeyScheme === 'mac';
    if (HOTKEY_DEBUG) {
      console.log('[Hotkeys] Registering global hotkey handler, scheme:', hotkeyScheme, 'bindings count:', keyBindings.length);
    }

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Don't handle if we're in an input or textarea (except for Escape)
      // Note: xterm terminal handles its own key interception via attachCustomKeyEventHandler
      const target = e.target as HTMLElement;
      const isFormElement = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      const isMonacoElement =
        target instanceof HTMLElement &&
        !!target.closest?.('.monaco-editor, .monaco-diff-editor, .monaco-inputbox');
      const isXtermInput =
        target instanceof HTMLElement &&
        !!target.closest?.(".xterm, .xterm-helper-textarea, .xterm-screen, .xterm-viewport");

      // Monaco is not always contentEditable/input, so treat it as an editor surface.
      if ((isFormElement || isMonacoElement) && !isXtermInput && e.key !== 'Escape') {
        return;
      }

      const isTerminalElement =
        target instanceof HTMLElement &&
        !!target.closest?.(".xterm, .xterm-helper-textarea, .xterm-screen, .xterm-viewport");
      const isTerminalInPath = Boolean(
        e.composedPath?.().some(
          (node) =>
            node instanceof HTMLElement &&
            (node.classList.contains("xterm") ||
              node.classList.contains("xterm-helper-textarea") ||
              node.classList.contains("xterm-screen") ||
              node.classList.contains("xterm-viewport") ||
              node.hasAttribute("data-session-id")),
        ),
      );

      // Check each key binding
      for (const binding of keyBindings) {
        const keyStr = isMac ? binding.mac : binding.pc;
        if (matchesKeyBinding(e, keyStr, isMac)) {
          if (HOTKEY_DEBUG) console.log('[Hotkeys] Matched binding:', binding.action, keyStr);
          // SFTP shortcuts are handled by SFTP-specific hooks.
          if (binding.category === 'sftp') {
            continue;
          }
          // Terminal-specific actions should be handled by the terminal
          // Don't handle them at app level
          const terminalActions = ['copy', 'paste', 'selectAll', 'clearBuffer', 'searchTerminal'];
          if (terminalActions.includes(binding.action)) {
            if (isTerminalElement) {
              return; // Let terminal handle it
            }
            continue; // Ignore terminal actions outside terminal
          }

          e.preventDefault();
          e.stopPropagation();
          if (HOTKEY_DEBUG) {
            console.log('[Hotkeys] Global handle', {
              action: binding.action,
              key: e.key,
              meta: e.metaKey,
              ctrl: e.ctrlKey,
              alt: e.altKey,
              shift: e.shiftKey,
              targetTag: target?.tagName,
              isTerminalElement,
              isTerminalInPath,
            });
          }
          executeHotkeyAction(binding.action, e);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [hotkeyScheme, keyBindings, isHotkeyRecording, executeHotkeyAction]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isQuickSwitcherOpen) {
        setIsQuickSwitcherOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isQuickSwitcherOpen]);

  const quickResults = useMemo(() => {
    if (!isQuickSwitcherOpen) return [];
    const term = quickSearch.trim().toLowerCase();
    const filtered = term
      ? hosts.filter(h =>
        h.label.toLowerCase().includes(term) ||
        h.hostname.toLowerCase().includes(term) ||
        (h.group || '').toLowerCase().includes(term)
      )
      : hosts;
    return filtered;
  }, [hosts, quickSearch, isQuickSwitcherOpen]);

  const handleDeleteHost = useCallback((hostId: string) => {
    const target = hosts.find(h => h.id === hostId);
    const confirmed = window.confirm(t('confirm.deleteHost', { name: target?.label || hostId }));
    if (!confirmed) return;
    updateHosts(hosts.filter(h => h.id !== hostId));
  }, [hosts, updateHosts, t]);

  // System info for connection logs
  const systemInfoRef = useRef<{ username: string; hostname: string }>({
    username: 'user',
    hostname: 'localhost',
  });

  // Fetch system info on mount
  useEffect(() => {
    void (async () => {
      try {
        const bridge = netcattyBridge.get();
        const info = await bridge?.getSystemInfo?.();
        if (info) {
          systemInfoRef.current = info;
        }
      } catch {
        // Fallback to defaults
      }
    })();
  }, []);

  // Wrapper to create local terminal with logging
  const handleCreateLocalTerminal = useCallback(() => {
    const { username, hostname } = systemInfoRef.current;
    const sessionId = createLocalTerminalWithCurrentShell();
    addConnectionLog({
      sessionId,
      hostId: '',
      hostLabel: 'Local Terminal',
      hostname: 'localhost',
      username: username,
      protocol: 'local',
      startTime: Date.now(),
      localUsername: username,
      localHostname: hostname,
      saved: false,
    });
  }, [addConnectionLog, createLocalTerminalWithCurrentShell]);

  // Wrapper to connect to host with logging
  const handleConnectToHost = useCallback((host: Host) => {
    const { username, hostname: localHost } = systemInfoRef.current;

    // Handle serial hosts separately
    if (host.protocol === 'serial') {
      const portName = host.hostname.split('/').pop() || host.hostname;
      const sessionId = connectToHost(host);
      addConnectionLog({
        sessionId,
        hostId: host.id,
        hostLabel: host.label || `Serial: ${portName}`,
        hostname: host.hostname,
        username: username,
        protocol: 'serial',
        startTime: Date.now(),
        localUsername: username,
        localHostname: localHost,
        saved: false,
      });
      return;
    }

    const protocol = host.moshEnabled ? 'mosh' : (host.protocol || 'ssh');
    const resolvedAuth = resolveHostAuth({ host, keys, identities });
    const sessionId = connectToHost(host);
    addConnectionLog({
      sessionId,
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: resolvedAuth.username || 'root',
      protocol: protocol as 'ssh' | 'telnet' | 'local' | 'mosh',
      startTime: Date.now(),
      localUsername: username,
      localHostname: localHost,
      saved: false,
    });
  }, [addConnectionLog, connectToHost, identities, keys]);

  // Wrapper to create serial session with logging
  const handleConnectSerial = useCallback((config: SerialConfig) => {
    const { username, hostname } = systemInfoRef.current;
    const portName = config.path.split('/').pop() || config.path;
    const sessionId = createSerialSession(config);
    addConnectionLog({
      sessionId,
      hostId: '',
      hostLabel: `Serial: ${portName}`,
      hostname: config.path,
      username: username,
      protocol: 'serial',
      startTime: Date.now(),
      localUsername: username,
      localHostname: hostname,
      saved: false,
    });
  }, [addConnectionLog, createSerialSession]);

  // Handle terminal data capture when session exits
  const handleTerminalDataCapture = useCallback((sessionId: string, data: string) => {
    if (IS_DEV) console.log('[handleTerminalDataCapture] Called', { sessionId, dataLength: data.length });
    const session = sessions.find(s => s.id === sessionId);
    if (IS_DEV) console.log('[handleTerminalDataCapture] Session', session);
    if (IS_DEV) console.log('[handleTerminalDataCapture] All logs:', connectionLogs.map(l => ({ id: l.id, sessionId: l.sessionId, hostname: l.hostname, endTime: l.endTime, hasTerminalData: !!l.terminalData })));

    // Prefer the persisted sessionId because the session may already have been
    // removed from state by the time the terminal unmount cleanup runs.
    const matchingLog = connectionLogs
      .filter((log) => {
        if (log.endTime || log.terminalData) return false;
        if (log.sessionId) return log.sessionId === sessionId;
        return !!session && log.hostname === session.hostname;
      })
      .sort((a, b) => b.startTime - a.startTime)[0];

    if (IS_DEV) console.log('[handleTerminalDataCapture] Matching log', matchingLog);

    if (matchingLog) {
      updateConnectionLog(matchingLog.id, {
        endTime: Date.now(),
        terminalData: data,
      });
      if (IS_DEV) console.log('[handleTerminalDataCapture] Updated log with terminalData');

      // Auto-save is now handled by real-time streaming in the main process
      // via sessionLogStreamManager. No renderer-side fallback needed.
    } else {
      if (IS_DEV) console.log('[handleTerminalDataCapture] No matching log found!');
    }
  }, [sessions, connectionLogs, updateConnectionLog]);

  // Check if host has multiple protocols enabled
  const hasMultipleProtocols = useCallback((host: Host) => {
    let count = 0;
    // SSH is always available as base protocol (unless explicitly set to something else)
    if (host.protocol === 'ssh' || !host.protocol) count++;
    // Mosh adds another option
    if (host.moshEnabled) count++;
    // Telnet adds another option
    if (host.telnetEnabled) count++;
    // If protocol is explicitly telnet (not ssh), count it
    if (host.protocol === 'telnet' && !host.telnetEnabled) count++;
    return count > 1;
  }, []);

  // Handle host connect with protocol selection (used by QuickSwitcher)
  const handleHostConnectWithProtocolCheck = useCallback((host: Host) => {
    if (hasMultipleProtocols(host)) {
      setProtocolSelectHost(host);
      setIsQuickSwitcherOpen(false);
      setQuickSearch('');
    } else {
      handleConnectToHost(host);
      setIsQuickSwitcherOpen(false);
      setQuickSearch('');
    }
  }, [hasMultipleProtocols, handleConnectToHost]);

  // Handle protocol selection from dialog
  const handleProtocolSelect = useCallback((protocol: HostProtocol, port: number) => {
    if (protocolSelectHost) {
      const hostWithProtocol: Host = {
        ...protocolSelectHost,
        protocol: protocol === 'mosh' ? 'ssh' : protocol,
        port,
        moshEnabled: protocol === 'mosh',
      };
      handleConnectToHost(hostWithProtocol);
      setProtocolSelectHost(null);
    }
  }, [protocolSelectHost, handleConnectToHost]);

  const handleToggleTheme = useCallback(() => {
    // Toggle based on the actual rendered theme so clicking always produces a visible change,
    // even when the stored preference is 'system'.
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const handleOpenQuickSwitcher = useCallback(() => {
    setIsQuickSwitcherOpen(true);
  }, []);


  const handleOpenSettings = useCallback(() => {
    void (async () => {
      const opened = await openSettingsWindow();
      if (!opened) toast.error(t('toast.settingsUnavailable'), t('common.settings'));
    })();
  }, [openSettingsWindow, t]);

  const hasShownCredentialProtectionWarningRef = useRef(false);

  useEffect(() => {
    if (hasShownCredentialProtectionWarningRef.current) return;

    let cancelled = false;
    void (async () => {
      const available = await getCredentialProtectionAvailability();
      if (cancelled || available !== false) return;
      hasShownCredentialProtectionWarningRef.current = true;

      toast.warning(t('credentials.protectionUnavailable.message'), {
        title: t('credentials.protectionUnavailable.title'),
        actionLabel: t('credentials.protectionUnavailable.action'),
        duration: 10000,
        onClick: handleOpenSettings,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [handleOpenSettings, t]);

  const handleEndSessionDrag = useCallback(() => {
    setDraggingSessionId(null);
  }, [setDraggingSessionId]);

  const handleRootContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const editableSelector =
      "input, textarea, [contenteditable], .monaco-editor, .monaco-diff-editor, .monaco-inputbox, .monaco-menu-container";

    const nativeEvent = e.nativeEvent;
    const path = typeof nativeEvent.composedPath === "function" ? nativeEvent.composedPath() : [];
    const allowFromPath = path.some(
      (node) => node instanceof Element && !!node.closest(editableSelector),
    );

    const target = e.target;
    const targetElement =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    const allowFromTarget = !!targetElement?.closest(editableSelector);

    const allowNativeContextMenu = allowFromPath || allowFromTarget;

    if (allowNativeContextMenu) {
      return;
    }

    e.preventDefault();
  }, []);

  return (
    <div className={cn("flex flex-col h-screen text-foreground font-sans netcatty-shell", immersiveMode && activeTerminalTheme && "immersive-transition")} onContextMenu={handleRootContextMenu}>
      <TopTabs
        theme={resolvedTheme}
        hosts={hosts}
        sessions={sessions}
        orphanSessions={orphanSessions}
        workspaces={workspaces}
        logViews={logViews}
        orderedTabs={orderedTabs}
        draggingSessionId={draggingSessionId}
        isMacClient={isMacClient}
        onCloseSession={closeSession}
        onRenameSession={startSessionRename}
        onCopySession={copySessionWithCurrentShell}
        onRenameWorkspace={startWorkspaceRename}
        onCloseWorkspace={closeWorkspace}
        onCloseLogView={closeLogView}
        onOpenQuickSwitcher={handleOpenQuickSwitcher}
        onToggleTheme={handleToggleTheme}
        onOpenSettings={handleOpenSettings}
        onSyncNow={handleSyncNowManual}
        isImmersiveActive={immersiveMode && activeTerminalTheme !== null}
        onStartSessionDrag={setDraggingSessionId}
        onEndSessionDrag={handleEndSessionDrag}
        onReorderTabs={reorderTabs}
      />

      <div className="flex-1 relative min-h-0">
        <VaultViewContainer>
          <VaultView
            hosts={hosts}
            keys={keys}
            identities={identities}
            snippets={snippets}
            snippetPackages={snippetPackages}
            customGroups={customGroups}
            knownHosts={knownHosts}
            shellHistory={shellHistory}
            connectionLogs={connectionLogs}
            managedSources={managedSources}
            sessions={sessions}
            hotkeyScheme={hotkeyScheme}
            keyBindings={keyBindings}
            onOpenSettings={handleOpenSettings}
            onOpenQuickSwitcher={handleOpenQuickSwitcher}
            onCreateLocalTerminal={handleCreateLocalTerminal}
            onConnectSerial={handleConnectSerial}
            onDeleteHost={handleDeleteHost}
            onConnect={handleConnectToHost}
            onUpdateHosts={updateHosts}
            onUpdateKeys={updateKeys}
            onUpdateIdentities={updateIdentities}
            onUpdateSnippets={updateSnippets}
            onUpdateSnippetPackages={updateSnippetPackages}
            onUpdateCustomGroups={updateCustomGroups}
            onUpdateKnownHosts={updateKnownHosts}
            onUpdateManagedSources={updateManagedSources}
            onClearAndRemoveManagedSource={clearAndRemoveSource}
            onClearAndRemoveManagedSources={clearAndRemoveSources}
            onUnmanageSource={unmanageSource}
            onConvertKnownHost={convertKnownHostToHost}
            onToggleConnectionLogSaved={toggleConnectionLogSaved}
            onDeleteConnectionLog={deleteConnectionLog}
            onClearUnsavedConnectionLogs={clearUnsavedConnectionLogs}
            onRunSnippet={runSnippet}
            onOpenLogView={openLogView}
            navigateToSection={navigateToSection}
            onNavigateToSectionHandled={() => setNavigateToSection(null)}
          />
        </VaultViewContainer>

        <SftpViewMount hosts={hosts} keys={keys} identities={identities} updateHosts={updateHosts} />

        <TerminalLayerMount
          hosts={hosts}
          keys={keys}
          identities={identities}
          snippets={snippets}
          snippetPackages={snippetPackages}
          sessions={sessions}
          workspaces={workspaces}
          knownHosts={knownHosts}
          draggingSessionId={draggingSessionId}
          terminalTheme={currentTerminalTheme}
          terminalSettings={terminalSettings}
          terminalFontFamilyId={terminalFontFamilyId}
          fontSize={terminalFontSize}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          onHotkeyAction={handleHotkeyAction}
          onUpdateTerminalThemeId={setTerminalThemeId}
          onUpdateTerminalFontFamilyId={setTerminalFontFamilyId}
          onUpdateTerminalFontSize={setTerminalFontSize}
          onCloseSession={closeSession}
          onUpdateSessionStatus={updateSessionStatus}
          onUpdateHostDistro={updateHostDistro}
          onUpdateHost={(host) => updateHosts(hosts.map(h => h.id === host.id ? host : h))}
          onAddKnownHost={(kh) => updateKnownHosts([...knownHosts, kh])}
          onCommandExecuted={(command, hostId, hostLabel, sessionId) => {
            addShellHistoryEntry({ command, hostId, hostLabel, sessionId });
          }}
          onTerminalDataCapture={handleTerminalDataCapture}
          onCreateWorkspaceFromSessions={createWorkspaceFromSessions}
          onAddSessionToWorkspace={addSessionToWorkspace}
          onUpdateSplitSizes={updateSplitSizes}
          onSetDraggingSessionId={setDraggingSessionId}
          onToggleWorkspaceViewMode={toggleWorkspaceViewMode}
          onSetWorkspaceFocusedSession={setWorkspaceFocusedSession}
          onSplitSession={splitSessionWithCurrentShell}
          isBroadcastEnabled={isBroadcastEnabled}
          onToggleBroadcast={toggleBroadcast}
          updateHosts={updateHosts}
          sftpDoubleClickBehavior={sftpDoubleClickBehavior}
          sftpAutoSync={sftpAutoSync}
          sftpShowHiddenFiles={sftpShowHiddenFiles}
          sftpUseCompressedUpload={sftpUseCompressedUpload}
          sftpAutoOpenSidebar={sftpAutoOpenSidebar}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          sessionLogsEnabled={sessionLogsEnabled}
          sessionLogsDir={sessionLogsDir}
          sessionLogsFormat={sessionLogsFormat}
        />

        {/* Log Views - readonly terminal replays */}
        {logViews.map(logView => {
          // Get the latest log data from connectionLogs to reflect updates
          const latestLog = connectionLogs.find(l => l.id === logView.connectionLogId) || logView.log;
          return (
            <LogViewWrapper
              key={logView.id}
              logView={{ ...logView, log: latestLog }}
              defaultTerminalTheme={currentTerminalTheme}
              defaultFontSize={terminalFontSize}
              onClose={() => closeLogView(logView.id)}
              onUpdateLog={updateConnectionLog}
            />
          );
        })}
      </div>

      {isQuickSwitcherOpen && (
        <Suspense fallback={null}>
          <LazyQuickSwitcher
            isOpen={isQuickSwitcherOpen}
            query={quickSearch}
            results={quickResults}
            sessions={sessions}
            workspaces={workspaces}
            onQueryChange={setQuickSearch}
            onSelect={handleHostConnectWithProtocolCheck}
            onSelectTab={(tabId) => {
              setActiveTabId(tabId);
              setIsQuickSwitcherOpen(false);
              setQuickSearch('');
            }}
            onCreateLocalTerminal={() => {
              handleCreateLocalTerminal();
              setIsQuickSwitcherOpen(false);
              setQuickSearch('');
            }}
            onCreateWorkspace={() => {
              setIsQuickSwitcherOpen(false);
              setIsCreateWorkspaceOpen(true);
            }}
            onClose={() => {
              setIsQuickSwitcherOpen(false);
              setQuickSearch('');
            }}
            keyBindings={keyBindings}
          />
        </Suspense>
      )}

      <Dialog open={!!sessionRenameTarget} onOpenChange={(open) => {
        if (!open) {
          resetSessionRename();
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameSession.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="session-name">{t('field.name')}</Label>
            <Input
              id="session-name"
              value={sessionRenameValue}
              onChange={(e) => setSessionRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitSessionRename(); }}
              autoFocus
              placeholder={t('placeholder.sessionName')}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetSessionRename}>{t('common.cancel')}</Button>
            <Button onClick={submitSessionRename} disabled={!sessionRenameValue.trim()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!workspaceRenameTarget} onOpenChange={(open) => {
        if (!open) {
          resetWorkspaceRename();
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameWorkspace.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="workspace-name">{t('field.name')}</Label>
            <Input
              id="workspace-name"
              value={workspaceRenameValue}
              onChange={(e) => setWorkspaceRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitWorkspaceRename(); }}
              autoFocus
              placeholder={t('placeholder.workspaceName')}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={resetWorkspaceRename}>{t('common.cancel')}</Button>
            <Button onClick={submitWorkspaceRename} disabled={!workspaceRenameValue.trim()}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isCreateWorkspaceOpen && (
        <Suspense fallback={null}>
          <LazyCreateWorkspaceDialog
            isOpen={isCreateWorkspaceOpen}
            onClose={() => setIsCreateWorkspaceOpen(false)}
            hosts={hosts}
            onCreate={createWorkspaceWithHosts}
          />
        </Suspense>
      )}

      {/* Protocol Select Dialog for QuickSwitcher */}
      {protocolSelectHost && (
        <Suspense fallback={null}>
          <LazyProtocolSelectDialog
            host={protocolSelectHost}
            onSelect={handleProtocolSelect}
            onCancel={() => setProtocolSelectHost(null)}
          />
        </Suspense>
      )}

      {/* Global Keyboard-Interactive Authentication Modal (2FA/MFA) - processes queue */}
      <KeyboardInteractiveModal
        request={keyboardInteractiveQueue[0] || null}
        onSubmit={handleKeyboardInteractiveSubmit}
        onCancel={handleKeyboardInteractiveCancel}
      />
      {/* Indicator when more 2FA requests are pending */}
      {keyboardInteractiveQueue.length > 1 && (
        <div className="fixed bottom-4 right-4 z-50 bg-muted/90 backdrop-blur-sm text-sm px-3 py-1.5 rounded-full border shadow-sm">
          {keyboardInteractiveQueue.length - 1} more pending
        </div>
      )}

      {/* Global Passphrase Modal for encrypted SSH keys */}
      <PassphraseModal
        request={passphraseQueue[0] || null}
        onSubmit={handlePassphraseSubmit}
        onCancel={handlePassphraseCancel}
        onSkip={handlePassphraseSkip}
      />
    </div>
  );
}

function AppWithProviders() {
  const settings = useSettingsState();

  useEffect(() => {
    try {
      // Hide splash screen with a fade-out animation
      const splash = document.getElementById('splash');
      if (splash) {
        splash.classList.add('fade-out');
        // Remove from DOM after animation completes
        setTimeout(() => splash.remove(), 200);
      }
      // Notify main process that renderer is ready
      netcattyBridge.get()?.rendererReady?.();
    } catch {
      // ignore
    }
  }, []);

  return (
    <I18nProvider locale={settings.uiLanguage}>
      <ToastProvider>
        <App settings={settings} />
      </ToastProvider>
    </I18nProvider>
  );
}

export default AppWithProviders;
