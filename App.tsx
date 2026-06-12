import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { activeTabStore, toEditorTabId, fromEditorTabId, isEditorTabId } from './application/state/activeTabStore';
import { useAutoSync } from './application/state/useAutoSync';
import { useManagedSourceSync } from './application/state/useManagedSourceSync';
import { usePortForwardingState } from './application/state/usePortForwardingState';
import { useSessionState } from './application/state/useSessionState';
import { useSettingsState } from './application/state/useSettingsState';
import { useUpdateCheck } from './application/state/useUpdateCheck';
import { useVaultState } from './application/state/useVaultState';
import { useWindowControls } from './application/state/useWindowControls';
import { useEditorTabs } from './application/state/editorTabStore';
import {
  clearReferenceKeyPassphrases,
  clearKeyPassphrasesByIds,
  loadDefaultKeyPassphrase,
  rememberKeyPassphrase,
  removeDefaultKeyPassphrases,
  shouldUpdateReferenceKeyPassphrase,
} from './application/defaultKeyPassphrases';
import { initializeFonts } from './application/state/fontStore';
import { initializeUIFonts } from './application/state/uiFontStore';
import { I18nProvider, useI18n } from './application/i18n/I18nProvider';
import { matchesKeyBinding } from './domain/models';
import { resolveGroupDefaults, applyGroupDefaults } from './domain/groupConfig';
import { upsertKnownHost } from './domain/knownHosts';
import { materializeHostProxyProfile } from './domain/proxyProfiles';
import { resolveHostAuth } from './domain/sshAuth';
import { isEncryptedCredentialPlaceholder } from './domain/credentials';
import {
  mergeTerminalHostUpdate,
  type TerminalHostUpdate,
} from './domain/terminalAppearance';
import { selectConnectionLogForTerminalDataCapture } from './domain/connectionLog';
import { collectSessionIds } from './domain/workspace';
import { resolveCloseIntent } from './application/state/resolveCloseIntent';
import { resolveSnippetsShortcutIntent } from './application/state/resolveSnippetsShortcutIntent';
import { resolveWindowCommandCloseIntent } from './application/state/windowCommandClose';
import { TERMINAL_THEMES } from './infrastructure/config/terminalThemes';
import { useCustomThemes } from './application/state/customThemeStore';
import type { SyncPayload } from './domain/sync';
import { applySyncPayload, buildLocalVaultPayload, hasMeaningfulSyncData } from './application/syncPayload';
import {
  applyProtectedSyncPayload,
  ensureVersionChangeBackup,
} from './application/localVaultBackups';
import { getCredentialProtectionAvailability } from './infrastructure/services/credentialProtection';
import { netcattyBridge } from './infrastructure/services/netcattyBridge';
import { localStorageAdapter } from './infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_DEBUG_HOTKEYS,
  STORAGE_KEY_PORT_FORWARDING,
} from './infrastructure/config/storageKeys';
import { getEffectiveKnownHosts } from './infrastructure/syncHelpers';
import { ToastProvider, toast } from './components/ui/toast';
import { TooltipProvider } from './components/ui/tooltip';
import { VaultSection } from './components/VaultView';
import { KeyboardInteractiveRequest } from './components/KeyboardInteractiveModal';
import { PassphraseRequest } from './components/PassphraseModal';
import { classifyLocalShellType } from './lib/localShell';
import { useDiscoveredShells, resolveShellSetting } from './lib/useDiscoveredShells';
import { Host, HostProtocol, KnownHost, SerialConfig, Snippet, SSHKey, TerminalSession } from './types';
import { resolveSnippetCommand } from './components/SnippetExecutionProvider';
import { AppView } from './application/app/AppView';
import { AppActiveTabChrome } from './application/app/AppActiveTabChrome';
import { useAppStartupEffects } from './application/app/useAppStartupEffects';
import { LogViewWrapper, SftpViewMount, TerminalLayerMount, VaultViewContainer } from './application/app/AppMounts';
import { handleTrayJumpToSessionImpl, handleTrayTogglePortForwardImpl, handleTrayPanelConnectImpl, handleGlobalHotkeyKeyDownImpl, handleEscapeKeyDownImpl, handleKeyboardInteractiveSubmitImpl, handleKeyboardInteractiveCancelImpl, handlePassphraseSubmitImpl, handlePassphraseCancelImpl, handlePassphraseSkipImpl, createLocalTerminalWithCurrentShellImpl, splitSessionWithCurrentShellImpl, copySessionWithCurrentShellImpl, copySessionToNewWindowWithCurrentShellImpl, confirmIfBusyLocalTerminalImpl, closeTabsBatchImpl, executeHotkeyActionImpl, handleCreateLocalTerminalImpl, handleConnectToHostImpl, handleTerminalDataCaptureImpl, hasMultipleProtocolsImpl, handleHostConnectWithProtocolCheckImpl, handleProtocolSelectImpl, handleToggleThemeImpl, handleRootContextMenuImpl } from './application/app/AppHandlers';

// Initialize fonts eagerly at app startup
initializeFonts();
initializeUIFonts();

type SettingsState = ReturnType<typeof useSettingsState>;
type OpenSessionInNewWindowPayload = {
  title?: string;
  sourceSession?: TerminalSession;
  localShellType?: TerminalSession['shellType'];
};

const IS_DEV = import.meta.env.DEV;
const HOTKEY_DEBUG =
  IS_DEV && localStorageAdapter.readString(STORAGE_KEY_DEBUG_HOTKEYS) === '1';

function App({ settings }: { settings: SettingsState }) {
  const { t } = useI18n();

  const [isQuickSwitcherOpen, setIsQuickSwitcherOpen] = useState(false);
  const [isCreateWorkspaceOpen, setIsCreateWorkspaceOpen] = useState(false);
  // Combined state for the AddToWorkspaceDialog. null = closed; mode
  // determines whether picking targets appends them to an existing
  // workspace (focus sidebar "+") or spins up a brand-new workspace
  // tab (QuickSwitcher's New Workspace button).
  const [addToWorkspaceDialog, setAddToWorkspaceDialog] = useState<
    | { mode: 'append'; workspaceId: string }
    | { mode: 'create' }
    | null
  >(null);
  const [quickSearch, setQuickSearch] = useState('');
  // Protocol selection dialog state for QuickSwitcher
  const [protocolSelectHost, setProtocolSelectHost] = useState<Host | null>(null);
  // Navigation state for VaultView sections
  const [navigateToSection, setNavigateToSection] = useState<VaultSection | null>(null);
  // Keyboard-interactive authentication queue (2FA/MFA) - queue-based to handle multiple concurrent sessions
  const [keyboardInteractiveQueue, setKeyboardInteractiveQueue] = useState<KeyboardInteractiveRequest[]>([]);
  // Passphrase request queue for encrypted SSH keys
  const [passphraseQueue, setPassphraseQueue] = useState<PassphraseRequest[]>([]);
  const [pendingNewWindowSession, setPendingNewWindowSession] = useState<OpenSessionInNewWindowPayload | null>(null);

  const {
    theme,
    setTheme,
    resolvedTheme,
    accentMode,
    customAccent,
    terminalThemeId,
    setTerminalThemeId,
    followAppTerminalTheme,
    currentTerminalTheme,
    terminalFontFamilyId,
    setTerminalFontFamilyId,
    terminalFontSize,
    setTerminalFontSize,
    terminalSettings,
    updateTerminalSetting,
    hotkeyScheme,
    keyBindings,
    isHotkeyRecording,
    sftpDoubleClickBehavior,
    sftpAutoSync,
    sftpShowHiddenFiles,
    sftpUseCompressedUpload,
    sftpAutoOpenSidebar,
    sftpFollowTerminalCwd,
    setSftpFollowTerminalCwd,
    sftpDefaultViewMode,
    editorWordWrap,
    setEditorWordWrap,
    sessionLogsEnabled,
    sessionLogsDir,
    sessionLogsFormat,
    sessionLogsTimestampsEnabled,
    applyAppTheme,
    workspaceFocusStyle,
  } = settings;

  const discoveredShells = useDiscoveredShells();

  // Sync workspace focus indicator style to DOM for CSS targeting
  useEffect(() => {
    if (workspaceFocusStyle === 'border') {
      document.documentElement.setAttribute('data-workspace-focus', 'border');
    } else {
      document.documentElement.removeAttribute('data-workspace-focus');
    }
  }, [workspaceFocusStyle]);

  const {
    isInitialized: isVaultInitialized,
    hosts,
    keys,
    identities,
    proxyProfiles,
    snippets,
    customGroups,
    snippetPackages,
    knownHosts,
    shellHistory,
    connectionLogs,
    managedSources,
    updateHosts,
    updateKeys,
    importOrReuseKey,
    updateIdentities,
    updateProxyProfiles,
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
    updateHostLastConnected,
    convertKnownHostToHost,
    importDataFromString,
    groupConfigs,
    updateGroupConfigs,
  } = useVaultState();

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const knownHostsRef = useRef(knownHosts);
  // Bridge the gap while useVaultState hydrates: its async init awaits
  // hosts/keys/identities/proxyProfiles decryption before reading knownHosts,
  // so the state is briefly [] at boot even when localStorage has entries.
  // Any SSH connect during that window (manual click or restored session)
  // would otherwise see no trusted hosts and prompt for fingerprint
  // re-confirmation. Mirrors the same fallback already used by sync payloads.
  const effectiveKnownHosts = useMemo(
    () => getEffectiveKnownHosts(knownHosts) ?? [],
    [knownHosts],
  );
  knownHostsRef.current = effectiveKnownHosts;

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
    updateSessionFontSize,
    clearSessionFontSizeOverride,
    createWorkspaceWithHosts,
    createWorkspaceFromSessions,
    addSessionToWorkspace,
    appendHostToWorkspace,
    appendLocalTerminalToWorkspace,
    createWorkspaceFromTargets,
    updateSplitSizes,
    splitSession,
    toggleWorkspaceViewMode,
    setWorkspaceFocusedSession,
    reorderWorkspaceSessions,
    moveFocusInWorkspace,
    runSnippet,
    orphanSessions,
    orderedTabs,
    getOrderedWorkTabs,
    reorderTabs,
    toggleBroadcast,
    isBroadcastEnabled,
    logViews,
    openLogView,
    closeLogView,
    copySession,
    createSessionFromCloneSource,
  } = useSessionState();

  const handleRunSnippet = useCallback(
    async (snippet: Snippet, targetHosts: Host[]) => {
      const command = await resolveSnippetCommand(snippet);
      if (command === null) return;
      runSnippet(snippet, targetHosts, command);
    },
    [runSnippet],
  );

  // isMacClient is used for window controls styling
  const isMacClient = typeof navigator !== 'undefined' && /Mac|Macintosh/.test(navigator.userAgent);

  // ---------------------------------------------------------------------------
  // Active tab lookup maps
  // ---------------------------------------------------------------------------
  const customThemes = useCustomThemes();
  const editorTabs = useEditorTabs();

  const hostById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host])),
    [hosts],
  );
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const sessionByIdRef = useRef(sessionById);
  sessionByIdRef.current = sessionById;
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const themeById = useMemo(
    () => new Map([...customThemes, ...TERMINAL_THEMES].map((theme) => [theme.id, theme])),
    [customThemes],
  );
  // activeTabId-derived chrome (window title, sftp guard) is owned by
  // <AppActiveTabChrome/> so switching tabs does not re-render App.

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onOpenSessionInNewWindow) return undefined;
    return bridge.onOpenSessionInNewWindow((payload) => {
      if (!payload?.sourceSession) return;
      setPendingNewWindowSession(payload);
    });
  }, []);

  useEffect(() => {
    if (!isVaultInitialized || !pendingNewWindowSession?.sourceSession) return;
    createSessionFromCloneSource(pendingNewWindowSession.sourceSession, {
      localShellType: pendingNewWindowSession.localShellType,
    });
    setPendingNewWindowSession(null);
  }, [createSessionFromCloneSource, isVaultInitialized, pendingNewWindowSession]);

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

  const buildCurrentSyncPayload = useCallback(() => {
    let effectivePortForwardingRules = portForwardingRulesForSync;
    if (effectivePortForwardingRules.length === 0) {
      const stored = localStorageAdapter.read<typeof portForwardingRulesForSync>(
        STORAGE_KEY_PORT_FORWARDING,
      );
      if (stored && Array.isArray(stored) && stored.length > 0) {
        effectivePortForwardingRules = stored.map((rule) => ({
          ...rule,
          status: 'inactive' as const,
          error: undefined,
          lastUsedAt: undefined,
        }));
      }
    }

    return buildLocalVaultPayload(
      {
        hosts,
        keys,
        identities,
        proxyProfiles,
        snippets,
        customGroups,
        snippetPackages,
        knownHosts: getEffectiveKnownHosts(knownHosts),
        groupConfigs,
      },
      effectivePortForwardingRules,
    );
  }, [
    customGroups,
    groupConfigs,
    hosts,
    identities,
    keys,
    proxyProfiles,
    knownHosts,
    portForwardingRulesForSync,
    snippetPackages,
    snippets,
  ]);

  const [startupSyncSafetyReady, setStartupSyncSafetyReady] = useState(false);
  // buildCurrentSyncPayload's identity changes each time the vault
  // settles. The retry effect below watches the underlying data arrays
  // for hydration progress, and uses the ref to always read the latest
  // builder without pulling buildCurrentSyncPayload itself into deps
  // (its identity churns on unrelated state updates too).
  const buildCurrentSyncPayloadRef = useRef(buildCurrentSyncPayload);
  useEffect(() => {
    buildCurrentSyncPayloadRef.current = buildCurrentSyncPayload;
  }, [buildCurrentSyncPayload]);

  const versionBackupAttemptedRef = useRef(false);
  // Two-stage gate: once the vault has initialized we open the auto-sync
  // gate immediately — the hook's own hasMeaningfulSyncData guard and
  // the cross-window restore barrier prevent an empty-but-not-yet-
  // hydrated snapshot from overwriting cloud data. The version-change
  // backup itself is best-effort and retries below as vault data arrives.
  useEffect(() => {
    if (isVaultInitialized && !startupSyncSafetyReady) {
      setStartupSyncSafetyReady(true);
    }
  }, [isVaultInitialized, startupSyncSafetyReady]);

  // Retry the version-change backup as hosts/keys/snippets become
  // available. ensureVersionChangeBackup refuses to advance the stored
  // version stamp when the observed payload is empty, so running this
  // effect repeatedly is safe and eventually latches once the vault has
  // hydrated enough to be backed up (or the user genuinely stays empty,
  // in which case the effect continues to no-op).
  useEffect(() => {
    if (!isVaultInitialized || versionBackupAttemptedRef.current) return;
    const payload = buildCurrentSyncPayloadRef.current();
    if (!hasMeaningfulSyncData(payload)) return;
    versionBackupAttemptedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const info = await netcattyBridge.get()?.getAppInfo?.();
        await ensureVersionChangeBackup(payload, info?.version ?? null);
      } catch (error) {
        if (!cancelled) {
          // Reset the latch so a later data change (or the next mount)
          // can retry. ensureVersionChangeBackup already leaves the
          // version stamp untouched on failure, so retrying is safe.
          versionBackupAttemptedRef.current = false;
        }
        console.error('[App] Failed to create version-change backup:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isVaultInitialized, hosts, keys, identities, proxyProfiles, snippets, customGroups, snippetPackages, knownHosts]);

  // Memoized "apply a remote payload safely" callback. Stable identity
  // across renders so useAutoSync's `syncNow` useCallback doesn't rebuild
  // on unrelated App-level state changes (which would churn the debounced
  // auto-sync useEffect dep chain).
  const handleApplySyncPayload = useCallback(
    (payload: SyncPayload) =>
      applyProtectedSyncPayload({
        buildPreApplyPayload: () => buildCurrentSyncPayload(),
        applyPayload: () =>
          applySyncPayload(payload, {
            importVaultData: importDataFromString,
            importPortForwardingRules,
            onSettingsApplied: settings.rehydrateAllFromStorage,
          }),
        translateProtectiveBackupFailure: (message) =>
          t('cloudSync.localBackups.protectiveBackupFailed', { message }),
      }),
    [
      buildCurrentSyncPayload,
      importDataFromString,
      importPortForwardingRules,
      settings.rehydrateAllFromStorage,
      t,
    ],
  );

  // Auto-sync hook for cloud sync
  const { syncNow: handleSyncNow, emptyVaultConflict, resolveEmptyVaultConflict } = useAutoSync({
    hosts,
    keys,
    identities,
    proxyProfiles,
    snippets,
    customGroups,
    snippetPackages,
    portForwardingRules: portForwardingRulesForSync,
    groupConfigs,
    settingsVersion: settings.settingsVersion,
    startupReady: startupSyncSafetyReady,
    onApplyPayload: handleApplySyncPayload,
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
  const { updateState, dismissUpdate, installUpdate } = useUpdateCheck({
    // Install blocked because an editor has unsaved changes (#1215). The main
    // process broadcasts this; show an actionable toast telling the user to save
    // and click "Restart Now" again.
    onNeedsSave: () => toast.warning(t('update.needsSave.message'), t('update.needsSave.title')),
  });

  // Window controls - must be before update toast effect which uses openSettingsWindow
  const { openSettingsWindow } = useWindowControls();
  const _handleTrayJumpToSession = useEffectEvent((sessionId: string) => { return handleTrayJumpToSessionImpl(() => ({ sessionId, sessions, setActiveTabId, setWorkspaceFocusedSession }), sessionId); });
  const _handleTrayTogglePortForward = useEffectEvent((ruleId: string, start: boolean) => { return handleTrayTogglePortForwardImpl(() => ({ hosts, identities, keys, portForwardingRules, resolveEffectiveHost, ruleId, start, startTunnel, stopTunnel, t, terminalSettings, toast, undefined }), ruleId, start); });
  const _handleTrayPanelConnect = useEffectEvent((hostId: string) => { return handleTrayPanelConnectImpl(() => ({ addConnectionLog, connectToHost, hostId, hosts, identities, keys, resolveEffectiveHost, resolveHostAuth, systemInfoRef, t, toast }), hostId); });
  const _handleGlobalHotkeyKeyDown = useEffectEvent((e: KeyboardEvent) => { return handleGlobalHotkeyKeyDownImpl(() => ({ HOTKEY_DEBUG, closeTabKeyStr, e, executeHotkeyAction, hotkeyScheme, keyBindings, matchesKeyBinding }), e); });
  const _handleEscapeKeyDown = useEffectEvent((e: KeyboardEvent) => { return handleEscapeKeyDownImpl(() => ({ e, isQuickSwitcherOpen, setIsQuickSwitcherOpen }), e); });

  useAppStartupEffects({ dismissUpdate, groupConfigs, hosts, identities, installUpdate, isVaultInitialized, keys, openSettingsWindow, portForwardingRules, proxyProfiles, sessions, setKeyboardInteractiveQueue, t, terminalSettings, updateState, workspaces });

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onTrayFocusSession || !bridge?.onTrayTogglePortForward) return;

    const unsubscribeFocus = bridge.onTrayFocusSession((sessionId) => {
      _handleTrayJumpToSession(sessionId);
    });
    const unsubscribeToggle = bridge.onTrayTogglePortForward((ruleId, start) => {
      _handleTrayTogglePortForward(ruleId, start);
    });

    return () => {
      unsubscribeFocus?.();
      unsubscribeToggle?.();
    };
  }, []);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onTrayPanelJumpToSession || !bridge?.onTrayPanelConnectToHost) return;

    const unsubscribeJump = bridge.onTrayPanelJumpToSession((sessionId) => {
      _handleTrayJumpToSession(sessionId);
    });
    const unsubscribeConnect = bridge.onTrayPanelConnectToHost((hostId) => {
      _handleTrayPanelConnect(hostId);
    });
    return () => {
      unsubscribeJump?.();
      unsubscribeConnect?.();
    };
  }, []);

  // Handle keyboard-interactive submit
  const handleKeyboardInteractiveSubmit = useCallback((requestId: string, responses: string[], savePassword?: string) => { return handleKeyboardInteractiveSubmitImpl(() => ({ hosts, keyboardInteractiveQueue, netcattyBridge, requestId, responses, savePassword, sessions, setKeyboardInteractiveQueue, updateHosts }), requestId, responses, savePassword); }, [keyboardInteractiveQueue, sessions, hosts, updateHosts]);

  // Handle keyboard-interactive cancel
  const handleKeyboardInteractiveCancel = useCallback((requestId: string) => { return handleKeyboardInteractiveCancelImpl(() => ({ netcattyBridge, requestId, setKeyboardInteractiveQueue }), requestId); }, []);

  // Passphrase request event listener for encrypted SSH keys
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPassphraseRequest) return;

    const unsubscribe = bridge.onPassphraseRequest(async (request) => {
      console.log('[App] Passphrase request received:', request);

      // If the bridge already tried a passphrase and it was wrong, skip auto-respond
      if (!request.passphraseInvalid) {
        // Check if a reference key exists for this path — use its passphrase
        const currentKeys = keysRef.current;
        const refKey = currentKeys.find((k: SSHKey) => k.source === 'reference' && k.filePath === request.keyPath);
        if (refKey?.passphrase && refKey.savePassphrase !== false && !isEncryptedCredentialPlaceholder(refKey.passphrase)) {
          console.log('[App] Auto-responding with reference key passphrase for:', request.keyPath);
          void bridge.respondPassphrase?.(request.requestId, refKey.passphrase, false);
          return;
        }

        // Fallback: try old storage for passphrase
        const saved = await loadDefaultKeyPassphrase(request.keyPath);
        if (saved) {
          console.log('[App] Auto-responding with saved passphrase for:', request.keyPath);
          // Migrate to reference key if one exists
          if (shouldUpdateReferenceKeyPassphrase(refKey)) {
            try {
              await rememberKeyPassphrase({
                keyPath: request.keyPath,
                passphrase: saved,
                keys: currentKeys,
                updateKeys,
                setCurrentKeys: (updated) => {
                  keysRef.current = updated;
                },
              });
            } catch (err) {
              console.warn('[App] Failed to migrate passphrase to reference key:', err);
            }
          }
          void bridge.respondPassphrase?.(request.requestId, saved, false);
          return;
        }
      }

      // No saved passphrase or it was invalid, show modal
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
  }, [updateKeys]);

  // Handle passphrase submit
  const handlePassphraseSubmit = useCallback(async (requestId: string, passphrase: string, remember: boolean) => { return handlePassphraseSubmitImpl(() => ({ keysRef, netcattyBridge, passphrase, passphraseQueue, remember, rememberKeyPassphrase, requestId, setPassphraseQueue, updateKeys }), requestId, passphrase, remember); }, [passphraseQueue, updateKeys]);

  // Handle passphrase cancel
  const handlePassphraseCancel = useCallback((requestId: string) => { return handlePassphraseCancelImpl(() => ({ netcattyBridge, requestId, setPassphraseQueue }), requestId); }, []);

  // Handle passphrase skip (skip this key, continue with others)
  const handlePassphraseSkip = useCallback((requestId: string) => { return handlePassphraseSkipImpl(() => ({ netcattyBridge, requestId, setPassphraseQueue }), requestId); }, []);

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

  // Handle passphrase cancellation (owning connection was stopped)
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPassphraseCancelled) return;

    const unsubscribe = bridge.onPassphraseCancelled((event) => {
      console.log('[App] Passphrase request cancelled:', event.requestId);
      setPassphraseQueue(prev => prev.filter(r => r.requestId !== event.requestId));
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  // Handle passphrase auth failure (saved passphrase was wrong, clear it)
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPassphraseAuthFailed) return;

    const unsubscribe = bridge.onPassphraseAuthFailed((event) => {
      const keyPaths = event.keyPaths ?? [];
      const keyIds = event.keyIds ?? [];
      console.log('[App] Passphrase auth failed for keys:', { keyPaths, keyIds });
      removeDefaultKeyPassphrases(keyPaths);
      const withoutReferencePassphrases = clearReferenceKeyPassphrases(keysRef.current, keyPaths);
      const updated = clearKeyPassphrasesByIds(withoutReferencePassphrases, keyIds);
      if (updated !== keysRef.current) {
        keysRef.current = updated;
        void updateKeys(updated);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [updateKeys]);

  // Debounce ref for moveFocus to prevent double-triggering when focus switches
  const lastMoveFocusTimeRef = useRef<number>(0);
  const MOVE_FOCUS_DEBOUNCE_MS = 200;

  // Use ref to store addConnectionLog to avoid circular dependencies with executeHotkeyAction
  const addConnectionLogRef = useRef(addConnectionLog);
  addConnectionLogRef.current = addConnectionLog;

  const toggleScriptsSidePanelRef = useRef<(() => void) | null>(null);
  const toggleSidePanelRef = useRef<(() => void) | null>(null);
  // Populated below so the hotkey dispatcher can open the Settings window
  // even though `handleOpenSettings` is declared further down in the file.
  const handleOpenSettingsRef = useRef<() => void>(() => {});
  const closeTabInFlightRef = useRef(false);
  // Populated by UnsavedChangesProvider render-prop below so that the hotkey
  // dispatcher (defined outside that scope) can still reach the dirty-confirm
  // close flow.
  const handleRequestCloseEditorTabRef = useRef<(id: string) => boolean | Promise<boolean>>(() => false);

  const createLocalTerminalWithCurrentShell = useCallback(() => { return createLocalTerminalWithCurrentShellImpl(() => ({ classifyLocalShellType, createLocalTerminal, discoveredShells, resolveShellSetting, terminalSettings })); }, [createLocalTerminal, terminalSettings, discoveredShells]);

  const splitSessionWithCurrentShell = useCallback((sessionId: string, direction: 'horizontal' | 'vertical') => { return splitSessionWithCurrentShellImpl(() => ({ classifyLocalShellType, direction, discoveredShells, resolveShellSetting, sessionId, splitSession, terminalSettings }), sessionId, direction); }, [splitSession, terminalSettings, discoveredShells]);

  const copySessionWithCurrentShell = useCallback((sessionId: string) => { return copySessionWithCurrentShellImpl(() => ({ classifyLocalShellType, copySession, discoveredShells, resolveShellSetting, sessionId, terminalSettings }), sessionId); }, [copySession, terminalSettings, discoveredShells]);

  const copySessionToNewWindowWithCurrentShell = useCallback((sessionId: string) => { return copySessionToNewWindowWithCurrentShellImpl(() => ({ classifyLocalShellType, discoveredShells, netcattyBridge, resolveShellSetting, sessions, terminalSettings, t, toast }), sessionId); }, [sessions, terminalSettings, discoveredShells, t]);

  const closeTabKeyStr = useMemo(() => {
    if (hotkeyScheme === 'disabled') return null;
    const closeTabBinding = keyBindings.find((binding) => binding.action === 'closeTab');
    if (!closeTabBinding) return null;
    return hotkeyScheme === 'mac' ? closeTabBinding.mac : closeTabBinding.pc;
  }, [hotkeyScheme, keyBindings]);

  const confirmIfBusyLocalTerminal = useCallback(
    async (sessionIds: string[]): Promise<boolean> => { return confirmIfBusyLocalTerminalImpl(() => ({ netcattyBridge, sessionIds, sessions, t }), sessionIds); },
    [sessions, t],
  );

  const closeTabsInFlightRef = useRef(false);

  const editorTabTopIds = useMemo(
    () => editorTabs.map((tab) => toEditorTabId(tab.id)),
    [editorTabs],
  );

  // 顶层标签顺序需要包含编辑器标签，供顶部标签和编辑器邻居计算使用。
  const orderedTabsWithEditors = useMemo(
    () => getOrderedWorkTabs(editorTabTopIds),
    [editorTabTopIds, getOrderedWorkTabs],
  );

  const reorderWorkTabs = useCallback((
    draggedId: string,
    targetId: string,
    position: 'before' | 'after' = 'before',
  ) => {
    reorderTabs(draggedId, targetId, position, editorTabTopIds);
  }, [editorTabTopIds, reorderTabs]);

  // Close many tabs at once with a single batched busy-shell confirmation.
  // Used by the "Close all / Close others / Close to the right" context-menu
  // actions on tabs (#748).
  const closeTabsBatch = useCallback(
    async (targetIds: string[]) => { return closeTabsBatchImpl(() => ({ closeLogView, closeSession, closeTabsInFlightRef, closeWorkspace, confirmIfBusyLocalTerminal, logViews, sessions, targetIds, workspaces }), targetIds); },
    [workspaces, sessions, logViews, confirmIfBusyLocalTerminal, closeWorkspace, closeSession, closeLogView],
  );

  // Shared hotkey action handler - used by both global handler and terminal callback
  const executeHotkeyAction = useCallback((action: string, e: KeyboardEvent) => { return executeHotkeyActionImpl(() => ({ IS_DEV, MOVE_FOCUS_DEBOUNCE_MS, action, activeTabStore, addConnectionLogRef, closeSession, closeTabInFlightRef, closeWorkspace, collectSessionIds, confirmIfBusyLocalTerminal, createLocalTerminalWithCurrentShell, e, editorTabs, fromEditorTabId, handleOpenSettingsRef, handleRequestCloseEditorTabRef, isEditorTabId, isQuickSwitcherOpen, lastMoveFocusTimeRef, moveFocusInWorkspace, orderedTabs, resolveCloseIntent, resolveSnippetsShortcutIntent, sessions, setActiveTabId, setAddToWorkspaceDialog, setIsQuickSwitcherOpen, setNavigateToSection, settings, splitSessionWithCurrentShell, systemInfoRef, toEditorTabId, toggleBroadcast, toggleScriptsSidePanelRef, toggleSidePanelRef, workspaces }), action, e); }, [orderedTabs, editorTabs, sessions, workspaces, isQuickSwitcherOpen, setActiveTabId, closeSession, closeWorkspace, createLocalTerminalWithCurrentShell, splitSessionWithCurrentShell, moveFocusInWorkspace, toggleBroadcast, settings, confirmIfBusyLocalTerminal]);

  const handleWindowCommandCloseRequest = useCallback(async () => {
    const openDialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'));
    const topmostOpenDialog = openDialogs[openDialogs.length - 1] ?? null;
    const topmostDialogClose = topmostOpenDialog?.querySelector<HTMLElement>('[data-dialog-close="true"]');
    if (topmostDialogClose) {
      topmostDialogClose.click();
      return;
    }

    const intent = resolveWindowCommandCloseIntent({
      activeTabId: activeTabStore.getActiveTabId(),
      editorTabIds: editorTabs.map((tab) => toEditorTabId(tab.id)),
      sessionIds: sessions.map((session) => session.id),
      workspaceIds: workspaces.map((workspace) => workspace.id),
      logViewIds: logViews.map((logView) => logView.id),
    });

    if (intent.kind === 'closeTab') {
      executeHotkeyAction('closeTab', new KeyboardEvent('keydown', { key: 'w', metaKey: true }));
      return;
    }

    if (intent.kind === 'closeLogView') {
      closeLogView(intent.tabId);
      return;
    }

    await netcattyBridge.get()?.windowClose?.();
  }, [closeLogView, editorTabs, executeHotkeyAction, logViews, sessions, workspaces]);

  useEffect(() => {
    const unsubscribe = netcattyBridge.get()?.onWindowCommandCloseRequested?.(() => {
      void handleWindowCommandCloseRequest();
    });
    return () => unsubscribe?.();
  }, [handleWindowCommandCloseRequest]);

  // Callback for terminal to invoke app-level hotkey actions
  const handleHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    executeHotkeyAction(action, e);
  }, [executeHotkeyAction]);

  // Global hotkey handler
  useEffect(() => {
    if (hotkeyScheme === 'disabled' || isHotkeyRecording) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      _handleGlobalHotkeyKeyDown(e);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [hotkeyScheme, isHotkeyRecording]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      _handleEscapeKeyDown(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
  }, [quickSearch, hosts, isQuickSwitcherOpen]);

  const handleDeleteHost = useCallback((hostId: string) => {
    const target = hosts.find(h => h.id === hostId);
    const confirmed = window.confirm(t('confirm.deleteHost', { name: target?.label || hostId }));
    if (!confirmed) return;
    updateHosts(hosts.filter(h => h.id !== hostId));
  }, [hosts, updateHosts, t]);

  const handleAddKnownHost = useCallback((kh: KnownHost) => {
    const nextKnownHosts = upsertKnownHost(knownHostsRef.current, kh);
    knownHostsRef.current = nextKnownHosts;
    updateKnownHosts(nextKnownHosts);
  }, [updateKnownHosts]);

  // System info for connection logs
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

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
  const handleCreateLocalTerminal = useCallback((shell?: { command: string; args?: string[]; name?: string; icon?: string }) => { return handleCreateLocalTerminalImpl(() => ({ addConnectionLog, classifyLocalShellType, createLocalTerminal, discoveredShells, resolveShellSetting, shell, systemInfoRef, terminalSettings, undefined }), shell); }, [addConnectionLog, createLocalTerminal, terminalSettings, discoveredShells]);

  const proxyProfileIdSet = useMemo(
    () => new Set(proxyProfiles.map((profile) => profile.id)),
    [proxyProfiles],
  );

  const resolveEffectiveHost = useCallback((host: Host): Host => {
    const withGroupDefaults = host.group
      ? applyGroupDefaults(
          host,
          resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds: proxyProfileIdSet }),
          { validProxyProfileIds: proxyProfileIdSet },
        )
      : applyGroupDefaults(host, {}, { validProxyProfileIds: proxyProfileIdSet });
    return materializeHostProxyProfile(withGroupDefaults, proxyProfiles);
  }, [groupConfigs, proxyProfileIdSet, proxyProfiles]);

  // Wrapper to connect to host with logging
  const handleConnectToHost = useCallback((host: Host) => { return handleConnectToHostImpl(() => ({ addConnectionLog, connectToHost, host, identities, keys, resolveEffectiveHost, resolveHostAuth, systemInfoRef }), host); }, [addConnectionLog, connectToHost, resolveEffectiveHost, identities, keys]);

  // Wrap updateSessionStatus to track lastConnectedAt on successful connection
  const handleSessionStatusChange = useCallback((sessionId: string, status: TerminalSession['status']) => {
    updateSessionStatus(sessionId, status);
    if (status === 'connected') {
      const session = sessionByIdRef.current.get(sessionId);
      if (session?.hostId) {
        updateHostLastConnected(session.hostId);
      }
    }
  }, [updateSessionStatus, updateHostLastConnected]);

  const handleUpdateHostFromTerminal = useCallback((host: TerminalHostUpdate) => {
    updateHosts(hosts.map((h) => (
      h.id === host.id ? mergeTerminalHostUpdate(h, host) : h
    )));
  }, [hosts, updateHosts]);

  // Wrapper to create serial session with logging
  const handleConnectSerial = useCallback((config: SerialConfig, options?: { charset?: string }) => {
    const { username, hostname } = systemInfoRef.current;
    const portName = config.path.split('/').pop() || config.path;
    const sessionId = createSerialSession(config, options);
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
  const handleTerminalDataCapture = useCallback((sessionId: string, data: string) => { return handleTerminalDataCaptureImpl(() => ({ IS_DEV, connectionLogs, data, selectConnectionLogForTerminalDataCapture, sessionId, sessions, updateConnectionLog }), sessionId, data); }, [sessions, connectionLogs, updateConnectionLog]);

  // Check if host has multiple protocols enabled (using effective/resolved host)
  const hasMultipleProtocols = useCallback((host: Host) => { return hasMultipleProtocolsImpl(() => ({ host, resolveEffectiveHost }), host); }, [resolveEffectiveHost]);

  // Handle host connect with protocol selection (used by QuickSwitcher)
  const handleHostConnectWithProtocolCheck = useCallback((host: Host) => { return handleHostConnectWithProtocolCheckImpl(() => ({ handleConnectToHost, hasMultipleProtocols, host, resolveEffectiveHost, setIsQuickSwitcherOpen, setProtocolSelectHost, setQuickSearch }), host); }, [hasMultipleProtocols, handleConnectToHost, resolveEffectiveHost]);

  // Handle protocol selection from dialog
  const handleProtocolSelect = useCallback((protocol: HostProtocol, port: number) => { return handleProtocolSelectImpl(() => ({ handleConnectToHost, port, protocol, protocolSelectHost, setProtocolSelectHost }), protocol, port); }, [protocolSelectHost, handleConnectToHost]);

  const handleToggleTheme = useCallback(() => { return handleToggleThemeImpl(() => ({ openSettingsWindow, resolvedTheme, setTheme, t, theme, toast })); }, [openSettingsWindow, resolvedTheme, setTheme, t, theme]);

  const handleOpenQuickSwitcher = useCallback(() => {
    setIsQuickSwitcherOpen(true);
  }, []);


  const handleOpenSettings = useCallback(() => {
    void (async () => {
      const opened = await openSettingsWindow();
      if (!opened) toast.error(t('toast.settingsUnavailable'), t('common.settings'));
    })();
  }, [openSettingsWindow, t]);
  handleOpenSettingsRef.current = handleOpenSettings;

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

  // Delete-from-sidepanel plumbing: ScriptsSidePanel's right-click menu
  // dispatches `netcatty:snippets:delete` with the snippet id. Handled here
  // (rather than in QuickAddSnippetDialog) because delete needs no UI.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (!id) return;
      updateSnippets(snippets.filter((s) => s.id !== id));
    };
    window.addEventListener('netcatty:snippets:delete', handler);
    return () => window.removeEventListener('netcatty:snippets:delete', handler);
  }, [snippets, updateSnippets]);

  const handleEndSessionDrag = useCallback(() => {
    setDraggingSessionId(null);
  }, [setDraggingSessionId]);

  const handleRootContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => { return handleRootContextMenuImpl(() => ({ e }), e); }, []);

  return (
    <>
      <AppActiveTabChrome
        showSftpTab={settings.showSftpTab}
        setActiveTabId={setActiveTabId}
        applyAppTheme={applyAppTheme}
        hostById={hostById}
        sessionById={sessionById}
        themeById={themeById}
        workspaceById={workspaceById}
        currentTerminalTheme={currentTerminalTheme}
        followAppTerminalTheme={followAppTerminalTheme}
        accentMode={accentMode}
        customAccent={customAccent}
        editorTabs={editorTabs}
        logViews={logViews}
        t={t}
      />
      <AppView ctx={{ accentMode, addShellHistoryEntry, addSessionToWorkspace, addToWorkspaceDialog, appendHostToWorkspace, appendLocalTerminalToWorkspace, clearAndRemoveSource, clearAndRemoveSources, clearUnsavedConnectionLogs, clearSessionFontSizeOverride, closeLogView, closeSession, closeTabsBatch, copySessionWithCurrentShell, copySessionToNewWindowWithCurrentShell, closeWorkspace, connectionLogs, convertKnownHostToHost, createWorkspaceFromSessions, createWorkspaceFromTargets, createWorkspaceWithHosts, customAccent, customGroups, currentTerminalTheme, deleteConnectionLog, draggingSessionId, effectiveKnownHosts, editorTabs, editorWordWrap, emptyVaultConflict, followAppTerminalTheme, groupConfigs, handleAddKnownHost, handleConnectSerial, handleConnectToHost, handleCreateLocalTerminal, handleDeleteHost, handleEndSessionDrag, handleHostConnectWithProtocolCheck, handleHotkeyAction, handleKeyboardInteractiveCancel, handleKeyboardInteractiveSubmit, handleOpenQuickSwitcher, handleOpenSettings, handleRootContextMenu, handlePassphraseCancel, handlePassphraseSkip, handlePassphraseSubmit, handleProtocolSelect, handleRequestCloseEditorTabRef, handleSessionStatusChange, handleSyncNowManual, handleTerminalDataCapture, handleToggleTheme, handleUpdateHostFromTerminal, hostById, hosts, hotkeyScheme, identities, importOrReuseKey, isBroadcastEnabled, isCreateWorkspaceOpen, isMacClient, isQuickSwitcherOpen, keyBindings, keyboardInteractiveQueue, keys, logViews, managedSources, navigateToSection, openLogView, orderedTabsWithEditors, orphanSessions, passphraseQueue, protocolSelectHost, proxyProfiles, quickResults, quickSearch, reorderWorkTabs, reorderWorkspaceSessions, resetSessionRename, resetWorkspaceRename, resolveEmptyVaultConflict, resolvedTheme, runSnippet: handleRunSnippet, sessionLogsDir, sessionLogsEnabled, sessionLogsFormat, sessionLogsTimestampsEnabled, sessionRenameTarget, sessionRenameValue, sessions, setActiveTabId, setAddToWorkspaceDialog, setDraggingSessionId, setEditorWordWrap, setIsCreateWorkspaceOpen, setIsQuickSwitcherOpen, setNavigateToSection, setProtocolSelectHost, setQuickSearch, setSessionRenameValue, setTerminalFontFamilyId, setTerminalFontSize, setTerminalThemeId, setWorkspaceFocusedSession, setWorkspaceRenameValue, settings, sftpAutoOpenSidebar, sftpFollowTerminalCwd, setSftpFollowTerminalCwd, sftpAutoSync, sftpDefaultViewMode, sftpDoubleClickBehavior, sftpShowHiddenFiles, sftpUseCompressedUpload, shellHistory, snippetPackages, snippets, splitSessionWithCurrentShell, sshDebugLogsEnabled: settings.sshDebugLogsEnabled, startSessionRename, startWorkspaceRename, submitSessionRename, submitWorkspaceRename, t, terminalFontFamilyId, terminalFontSize, terminalSettings, terminalThemeId, toggleBroadcast, toggleConnectionLogSaved, toggleScriptsSidePanelRef, toggleSidePanelRef, toggleWorkspaceViewMode, unmanageSource, updateConnectionLog, updateCustomGroups, updateGroupConfigs, updateHostDistro, updateHosts, updateIdentities, updateKeys, updateKnownHosts, updateManagedSources, updateProxyProfiles, updateSnippetPackages, updateSnippets, updateSplitSizes, updateSessionFontSize, updateTerminalSetting, workspaceRenameTarget, workspaceRenameValue, workspaces, VaultViewContainer, SftpViewMount, TerminalLayerMount, LogViewWrapper }} />
    </>
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
        <TooltipProvider delayDuration={300}>
          <App settings={settings} />
        </TooltipProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

export default AppWithProviders;
