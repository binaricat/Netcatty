import React, { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { registerAppHandlers } from './appHandlersBridge';
import { publishAppLocalUi } from './appLocalUiStore';
import { activeTabStore, toEditorTabId, fromEditorTabId, isEditorTabId } from '../state/activeTabStore';
import { useAutoSync } from '../state/useAutoSync';
import { useManagedSourceSync } from '../state/useManagedSourceSync';
import { usePortForwardingState } from '../state/usePortForwardingState';
import { useUpdateCheck } from '../state/useUpdateCheck';
import {
  useAppSessionRuntime,
  useAppSettingsRuntime,
  useAppVaultRuntime,
} from '../state/appRuntimeBridge';
import {
  getConnectionLogsSnapshot,
  subscribeConnectionLogs,
} from '../state/connectionLogsStore';
import { getNotesSnapshot } from '../state/notesStore';
import { useVaultAgentBridge } from '../state/useVaultAgentBridge';
import { useWindowControls } from '../state/useWindowControls';
import { useEditorTabChromeList } from '../state/editorTabStore';
import {
  isPluginViewTabId,
  pluginViewTabStore,
  resolveBatchTabCloseFocus,
  usePluginViewTabs,
} from '../state/pluginViewTabStore';
import {
  clearRememberedKeyPassphrases,
  loadDefaultKeyPassphrase,
  rememberKeyPassphrase,
  shouldUpdateReferenceKeyPassphrase,
} from '../defaultKeyPassphrases';
import { isTerminalBootEpochCurrent } from '../../domain/terminalBootEpoch';
import { useI18n } from '../i18n/I18nProvider';
import { matchesKeyBinding } from '../../domain/models';
import { resolveGroupDefaults, applyGroupDefaults } from '../../domain/groupConfig';
import { upsertKnownHost } from '../../domain/knownHosts';
import { materializeHostProxyProfile } from '../../domain/proxyProfiles';
import { buildSshDeepLinkConnectionHost, buildSshDeepLinkEphemeralHost, buildSshDeepLinkEphemeralHostFromSaved, buildSshDeepLinkHostDraft, findSshDeepLinkHost, parseSshDeepLink } from '../../domain/sshDeepLink';
import { buildTelnetDeepLinkConnectionHost, buildTelnetDeepLinkEphemeralHostFromSaved, buildTelnetDeepLinkOpenHost, findTelnetDeepLinkHost, materializeTelnetDeepLinkMatchHost, parseTelnetDeepLink } from '../../domain/telnetDeepLink';
import { buildJmsDeepLinkEphemeralHost, isSupportedJmsProtocol, parseJmsDeepLink } from '../../domain/jmsDeepLink';
import { applyEphemeralHostsUpdate, splitHostsUpdateByEphemeral } from '../../domain/ephemeralHosts';
import { resolveHostAuth } from '../../domain/sshAuth';
import { isEncryptedCredentialPlaceholder, stripSyncPayloadEncryptedCredentials } from '../../domain/credentials';
import {
  mergeTerminalHostUpdate,
  type TerminalHostUpdate,
} from '../../domain/terminalAppearance';
import { selectConnectionLogForTerminalDataCapture } from '../../domain/connectionLog';
import { collectSessionIds } from '../../domain/workspace';
import { resolveCloseIntent } from '../state/resolveCloseIntent';
import { resolveSnippetsShortcutIntent } from '../state/resolveSnippetsShortcutIntent';
import { resolveWindowCommandCloseIntent } from '../state/windowCommandClose';
import type { SyncPayload } from '../../domain/sync';
import { applySyncPayload, buildLocalVaultPayloadAsync, hasMeaningfulSyncData } from '../syncPayload';
import {
  applyProtectedSyncPayload,
  ensureVersionChangeBackup,
} from '../localVaultBackups';
import { getCredentialProtectionAvailability } from '../../infrastructure/services/credentialProtection';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  markExternalMcpStartupReady,
  readExternalMcpFocusOnHostOpen,
  readExternalMcpSilentSessions,
  syncExternalMcpStartupStateOnce,
} from '../state/useExternalMcpToggleState';
import { useExternalMcpSessionSync } from '../state/useExternalMcpSessionSync';
import {
  STORAGE_KEY_DEBUG_HOTKEYS,
  STORAGE_KEY_PORT_FORWARDING,
} from '../../infrastructure/config/storageKeys';
import { getEffectiveKnownHosts } from '../../infrastructure/syncHelpers';
import { toast } from '../../components/ui/toast';
import { VaultSection } from '../../components/VaultView';
import { KeyboardInteractiveRequest } from '../../components/KeyboardInteractiveModal';
import { PassphraseRequest } from '../../components/PassphraseModal';
import { classifyLocalShellType } from '../../lib/localShell';
import { useDiscoveredShells, resolveShellSetting } from '../../lib/useDiscoveredShells';
import { Host, HostProtocol, KnownHost, SerialConfig, Snippet, SSHKey, TerminalSession } from '../../types';
import { resolveSnippetCommand } from '../../components/SnippetExecutionProvider';
import { isScriptSnippet } from '../../domain/snippetScript.ts';
import { collectSnippetDeleteIds } from '../../domain/snippetSelection.ts';
import { useAppStartupEffects } from './useAppStartupEffects';
import { handleTrayJumpToSessionImpl, handleTrayTogglePortForwardImpl, handleTrayPanelConnectImpl, handleTrayPanelConnectRequestImpl, flushQueuedTrayPanelConnectHostsImpl, handleGlobalHotkeyKeyDownImpl, handleEscapeKeyDownImpl, handleKeyboardInteractiveSubmitImpl, handleKeyboardInteractiveCancelImpl, handlePassphraseSubmitImpl, handlePassphraseCancelImpl, handlePassphraseSkipImpl, createLocalTerminalWithCurrentShellImpl, splitSessionWithCurrentShellImpl, copySessionWithCurrentShellImpl, copyWorkspaceWithCurrentShellImpl, copySessionToNewWindowWithCurrentShellImpl, confirmIfBusyLocalTerminalImpl, closeTabsBatchImpl, executeHotkeyActionImpl, handleCreateLocalTerminalImpl, handleConnectToHostImpl, handleTerminalDataCaptureImpl, hasMultipleProtocolsImpl, handleHostConnectWithProtocolCheckImpl, handleProtocolSelectImpl, handleRootContextMenuImpl } from './AppHandlers';

type OpenSessionInNewWindowPayload = {
  title?: string;
  sourceSession?: TerminalSession;
  localShellType?: TerminalSession['shellType'];
};

const IS_DEV = import.meta.env.DEV;
const HOTKEY_DEBUG =
  IS_DEV && localStorageAdapter.readString(STORAGE_KEY_DEBUG_HOTKEYS) === '1';

export function AppSideEffects() {
  const settings = useAppSettingsRuntime();
  const { t } = useI18n();
  const pluginViewTabs = usePluginViewTabs();

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
  const [deepLinkHostDraft, setDeepLinkHostDraft] = useState<Host | null>(null);
  const [ephemeralHosts, setEphemeralHosts] = useState<Host[]>([]);
  // Keyboard-interactive authentication queue (2FA/MFA) - queue-based to handle multiple concurrent sessions
  const [keyboardInteractiveQueue, setKeyboardInteractiveQueue] = useState<KeyboardInteractiveRequest[]>([]);
  // Passphrase request queue for encrypted SSH keys
  const [passphraseQueue, setPassphraseQueue] = useState<PassphraseRequest[]>([]);
  const [deleteHostConfirm, setDeleteHostConfirm] = useState<{ hostId: string; name: string } | null>(null);
  const [pendingNewWindowSession, setPendingNewWindowSession] = useState<OpenSessionInNewWindowPayload | null>(null);
  const [pendingTrayPanelConnectHostIds, setPendingTrayPanelConnectHostIds] = useState<string[]>([]);
  const isPeerSessionWindow = typeof window !== 'undefined' && window.location.hash.startsWith('#/session-window');

  const {
    terminalSettings,
    hotkeyScheme,
    keyBindings,
    isHotkeyRecording,
    showSftpTab,
    shellOnlyTabNumberShortcuts,
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

  // External MCP: only persistent+enabled restores at app startup.
  // Keep this on the App mount path (not Settings) so temporary mode is not
  // accidentally disabled when the AI settings page remounts.
  // Skip peer session windows — they also mount App and must not clear a
  // temporary-mode runtime that the main window already started.
  useEffect(() => {
    if (isPeerSessionWindow) return;
    let cancelled = false;
    void (async () => {
      try {
        // Single-flight: StrictMode remount must not double enable/disable IPC.
        await syncExternalMcpStartupStateOnce(netcattyBridge.get());
      } finally {
        if (!cancelled) markExternalMcpStartupReady();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPeerSessionWindow]);

  const vaultState = useAppVaultRuntime();
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
    managedSources,
    updateHosts,
    updateKeys,
    updateSnippets,
    deleteSelectedSnippets,
    updateCustomGroups,
    updateKnownHosts,
    updateManagedSources,
    addConnectionLog,
    updateConnectionLog,
    updateHostLastConnected,
    importDataFromString,
    readPersistedHosts,
    groupConfigs,
    updateGroupConfigs,
  } = vaultState;

  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
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

  const sessionState = useAppSessionRuntime();
  const {
    sessions,
    workspaces,
    setActiveTabId,
    setDraggingSessionId,
    createLocalTerminal,
    createSerialSession,
    connectToHost,
    closeSession,
    closeSessions,
    closeWorkspace,
    updateSessionStatus,
    createWorkspaceWithHosts,
    createWorkspaceFromTargets,
    splitSession,
    toggleWorkspaceViewMode,
    setWorkspaceFocusedSession,
    moveFocusInWorkspace,
    runSnippet,
    getOrderedWorkTabs,
    toggleBroadcast,
    logViews,
    closeLogView,
    copySession,
    copyWorkspace,
    createSessionFromCloneSource,
    getSessionRestoreCwd,
  } = sessionState;

  // Presentation-field thrash stays off Host bags (Hosts use retainStable);
  // AppSideEffects only needs host/session maps for glue handlers and effects.
  const handleRunSnippet = useCallback(
    async (snippet: Snippet, targetHosts: Host[]) => {
      if (targetHosts.length === 0) return;
      if (isScriptSnippet(snippet)) {
        runSnippet(snippet, targetHosts);
        return;
      }
      const command = await resolveSnippetCommand(snippet);
      if (command === null) return;
      runSnippet(snippet, targetHosts, command);
    },
    [runSnippet],
  );

  // Presence-only list: keystrokes must not rebuild App domains / TopTabs structure.
  const editorTabs = useEditorTabChromeList();

  const hostById = useMemo(
    () => new Map(hosts.map((host) => [host.id, host])),
    [hosts],
  );
  const terminalHosts = useMemo(
    () => (ephemeralHosts.length > 0 ? [...hosts, ...ephemeralHosts] : hosts),
    [hosts, ephemeralHosts],
  );
  const ephemeralHostIds = useMemo(
    () => new Set(ephemeralHosts.map((host) => host.id)),
    [ephemeralHosts],
  );
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const sessionByIdRef = useRef(sessionById);
  sessionByIdRef.current = sessionById;
  // activeTabId-derived chrome (window title, sftp guard) is owned by
  // AppActiveTabChrome so switching tabs does not re-render App.

  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onOpenSessionInNewWindow) return undefined;
    return bridge.onOpenSessionInNewWindow((payload) => {
      if (!payload?.sourceSession) return;
      setPendingNewWindowSession(payload);
    });
  }, [isPeerSessionWindow]);

  // Clearing the pending state only lands on the next render, so a re-invoked
  // effect still sees the same payload. Latch on payload identity so a double
  // invoke cannot clone the same source session twice (each create mints a
  // fresh UUID, so a duplicate would open a second window-worth of session).
  const consumedNewWindowSessionRef = useRef<OpenSessionInNewWindowPayload | null>(null);
  useEffect(() => {
    if (!isVaultInitialized || !pendingNewWindowSession?.sourceSession) return;
    if (consumedNewWindowSessionRef.current === pendingNewWindowSession) return;
    const pending = pendingNewWindowSession;
    consumedNewWindowSessionRef.current = pending;
    setPendingNewWindowSession(null);
    createSessionFromCloneSource(pending.sourceSession, {
      localShellType: pending.localShellType,
    });
  }, [createSessionFromCloneSource, isVaultInitialized, pendingNewWindowSession]);

  // Get port forwarding rules and import function
  const {
    rules: portForwardingRules,
    importRules: importPortForwardingRules,
    startTunnel,
    stopTunnel,
    stopRuleTunnels,
    hasRuntimeTunnel,
  } = usePortForwardingState();

  // App-level External MCP session sync (before TerminalLayer lazy-mount).
  useExternalMcpSessionSync({
    sessions,
    hosts: terminalHosts,
    portForwardingRules,
  });

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

  const buildCurrentSyncPayload = useCallback(async () => {
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

    return buildLocalVaultPayloadAsync(
      {
        hosts,
        keys,
        identities,
        proxyProfiles,
        snippets,
        customGroups,
        snippetPackages,
        notes: getNotesSnapshot().notes as SyncPayload['notes'],
        noteGroups: getNotesSnapshot().noteGroups as SyncPayload['noteGroups'],
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
  const versionBackupInFlightRef = useRef(false);
  // Bumps when plugin contributions settle or the sidecar-host grace timer
  // fires so version-change backups can wait for live sidecar collect.
  const [pluginSidecarReadyTick, setPluginSidecarReadyTick] = useState(0);
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

  useEffect(() => {
    if (isPeerSessionWindow) return;
    const bridge = netcattyBridge.get() as {
      onPluginContributionsChanged?: (callback: () => void) => () => void;
    } | null | undefined;
    const unsubscribe = bridge?.onPluginContributionsChanged?.(() => {
      setPluginSidecarReadyTick((v) => v + 1);
    });
    // Plugins stay gated off for many installs; still allow a version
    // backup after a short grace so we do not wait forever for host ready.
    const graceTimer = window.setTimeout(() => {
      setPluginSidecarReadyTick((v) => v + 1);
    }, 5_000);
    return () => {
      unsubscribe?.();
      window.clearTimeout(graceTimer);
    };
  }, [isPeerSessionWindow]);

  // Retry the version-change backup as hosts/keys/snippets become
  // available. ensureVersionChangeBackup refuses to advance the stored
  // version stamp when the observed payload is empty, so running this
  // effect repeatedly is safe and eventually latches once the vault has
  // hydrated enough to be backed up (or the user genuinely stays empty,
  // in which case the effect continues to no-op).
  useEffect(() => {
    if (isPeerSessionWindow || !isVaultInitialized || versionBackupAttemptedRef.current) return;
    // Always wait for contributions or the grace tick — host-ready alone is
    // not enough because collect can still return an empty authoritative
    // bundle before plugin settings are declared.
    if (pluginSidecarReadyTick === 0) return;
    if (versionBackupInFlightRef.current) return;

    let cancelled = false;
    versionBackupInFlightRef.current = true;
    void (async () => {
      try {
        const payload = await buildCurrentSyncPayloadRef.current();
        if (cancelled) return;
        if (!hasMeaningfulSyncData(payload)) return;
        const info = await netcattyBridge.get()?.getAppInfo?.();
        if (cancelled) return;
        await ensureVersionChangeBackup(payload, info?.version ?? null);
        if (cancelled) return;
        // Latch only after a completed (non-cancelled) attempt so effect
        // cleanup cannot permanently suppress retries when the in-flight
        // call later throws.
        versionBackupAttemptedRef.current = true;
      } catch (error) {
        if (!cancelled) {
          console.error('[App] Failed to create version-change backup:', error);
        }
      } finally {
        versionBackupInFlightRef.current = false;
        // If hydration re-ran the effect mid-flight, nudge another attempt
        // now that the in-flight guard is clear.
        if (cancelled && !versionBackupAttemptedRef.current) {
          queueMicrotask(() => {
            setPluginSidecarReadyTick((v) => v + 1);
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isPeerSessionWindow, isVaultInitialized, hosts, keys, identities, proxyProfiles, snippets, customGroups, snippetPackages, knownHosts, pluginSidecarReadyTick]);

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

  const handleApplyConvergentSyncPayload = useCallback(
    (payload: SyncPayload, commitReplica: () => Promise<void>) =>
      applyProtectedSyncPayload({
        buildPreApplyPayload: () => buildCurrentSyncPayload(),
        applyPayload: async () => {
          const portable = stripSyncPayloadEncryptedCredentials(payload);
          await applySyncPayload(portable, {
            importVaultData: importDataFromString,
            importPortForwardingRules,
            onSettingsApplied: settings.rehydrateAllFromStorage,
          });
          await commitReplica();
        },
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
    enabled: !isPeerSessionWindow,
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
    onApplyConvergentPayload: handleApplyConvergentSyncPayload,
  });

  const { clearAndRemoveSource, clearAndRemoveSources, unmanageSource } = useManagedSourceSync({
    hosts,
    managedSources,
    onUpdateManagedSources: updateManagedSources,
    onReadPersistedHosts: readPersistedHosts,
  });

  const handleSyncNowManual = useCallback(() => {
    return handleSyncNow({ trigger: 'manual' });
  }, [handleSyncNow]);

  // Update check hook - checks for new versions on startup
  const { updateState, dismissUpdate, installUpdate } = useUpdateCheck({
    enabled: !isPeerSessionWindow,
    // Install blocked because an editor has unsaved changes (#1215). The main
    // process broadcasts this; show an actionable toast telling the user to save
    // and click "Restart Now" again.
    onNeedsSave: () => toast.warning(t('update.needsSave.message'), t('update.needsSave.title')),
  });

  // Window controls - must be before update toast effect which uses openSettingsWindow
  const { openSettingsWindow } = useWindowControls();
  const _handleTrayJumpToSession = useEffectEvent((sessionId: string) => {
    return handleTrayJumpToSessionImpl(() => ({
      sessionId,
      sessions,
      setActiveTabId,
      setWorkspaceFocusedSession,
      getActiveTabId: () => activeTabStore.getActiveTabId(),
      netcattyBridge,
      toast,
      t,
    }), sessionId);
  });
  const _handleTrayTogglePortForward = useEffectEvent((ruleId: string, start: boolean) => { return handleTrayTogglePortForwardImpl(() => ({ hasRuntimeTunnel, hosts, identities, keys, knownHosts: effectiveKnownHosts, portForwardingRules, resolveEffectiveHost, ruleId, start, startTunnel, stopTunnel, t, terminalSettings, toast, undefined }), ruleId, start); });
  const _handleTrayPanelConnect = useEffectEvent((hostId: string) => { return handleTrayPanelConnectImpl(() => ({ addConnectionLog, connectToHost, hostId, hosts, identities, keys, resolveEffectiveHost, resolveHostAuth, systemInfoRef, t, toast }), hostId); });
  const _handleTrayPanelConnectRequest = useEffectEvent((hostId: string) => { return handleTrayPanelConnectRequestImpl(() => ({ connectNow: _handleTrayPanelConnect, hostId, isVaultInitialized, queueConnect: (queuedHostId: string) => setPendingTrayPanelConnectHostIds((prev) => [...prev, queuedHostId]) }), hostId); });
  const _handleGlobalHotkeyKeyDown = useEffectEvent((e: KeyboardEvent) => { return handleGlobalHotkeyKeyDownImpl(() => ({ HOTKEY_DEBUG, closeTabKeyStr, e, executeHotkeyAction, hotkeyScheme, keyBindings, matchesKeyBinding }), e); });
  const _handleEscapeKeyDown = useEffectEvent((e: KeyboardEvent) => { return handleEscapeKeyDownImpl(() => ({ e, isQuickSwitcherOpen, setIsQuickSwitcherOpen }), e); });

  // Vault hosts for tray / auto-start; terminalHosts (vault + ephemeral) only for
  // dedicated transfer resume so quick-connect rows do not break tray connect.
  useAppStartupEffects({
    dismissUpdate,
    enabled: !isPeerSessionWindow,
    groupConfigs,
    hasRuntimeTunnel,
    hosts,
    resumeHosts: terminalHosts,
    identities,
    installUpdate,
    isVaultInitialized,
    keys,
    knownHosts: effectiveKnownHosts,
    openSettingsWindow,
    portForwardingRules,
    proxyProfiles,
    sessions,
    setKeyboardInteractiveQueue,
    t,
    terminalSettings,
    updateState,
    workspaces,
  });

  useEffect(() => {
    if (isPeerSessionWindow) return;
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
  }, [isPeerSessionWindow]);

  useEffect(() => {
    if (isPeerSessionWindow) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.onTrayPanelJumpToSession || !bridge?.onTrayPanelConnectToHost) return;

    const unsubscribeJump = bridge.onTrayPanelJumpToSession((sessionId) => {
      _handleTrayJumpToSession(sessionId);
    });
    const unsubscribeConnect = bridge.onTrayPanelConnectToHost((hostId) => {
      _handleTrayPanelConnectRequest(hostId);
    });
    return () => {
      unsubscribeJump?.();
      unsubscribeConnect?.();
    };
  }, [isPeerSessionWindow]);

  const pendingTrayConnectFlushKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isVaultInitialized) return;
    if (pendingTrayPanelConnectHostIds.length === 0) {
      pendingTrayConnectFlushKeyRef.current = null;
      return;
    }
    const flushKey = pendingTrayPanelConnectHostIds.join('\0');
    if (pendingTrayConnectFlushKeyRef.current === flushKey) return;
    pendingTrayConnectFlushKeyRef.current = flushKey;
    flushQueuedTrayPanelConnectHostsImpl(() => ({
      connectNow: _handleTrayPanelConnect,
      pendingHostIds: pendingTrayPanelConnectHostIds,
      setPendingHostIds: setPendingTrayPanelConnectHostIds,
    }));
  }, [isVaultInitialized, pendingTrayPanelConnectHostIds]);

  // Handle keyboard-interactive submit
  const handleKeyboardInteractiveSubmit = useCallback((requestId: string, responses: string[], savePassword?: string) => { return handleKeyboardInteractiveSubmitImpl(() => ({ hosts, hostsRef, keyboardInteractiveQueue, netcattyBridge, requestId, responses, savePassword, sessions, setKeyboardInteractiveQueue, t, toast, updateHosts }), requestId, responses, savePassword); }, [keyboardInteractiveQueue, sessions, hosts, t, updateHosts]);

  // Handle keyboard-interactive cancel
  const handleKeyboardInteractiveCancel = useCallback((requestId: string) => { return handleKeyboardInteractiveCancelImpl(() => ({ netcattyBridge, requestId, setKeyboardInteractiveQueue, t, toast }), requestId); }, [t]);

  // Passphrase request event listener for encrypted SSH keys
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPassphraseRequest) return;

    const unsubscribe = bridge.onPassphraseRequest(async (request) => {
      console.log('[App] Passphrase request received:', request);

      const isRequestCurrent = () => (
        typeof request.sessionId !== "string"
        || isTerminalBootEpochCurrent(request.sessionId, request.bootEpoch)
      );

      // Disconnect/reconnect may leave a late passphrase prompt for a
      // superseded boot; reject epoch-tagged requests that are no longer current.
      if (!isRequestCurrent()) {
        void bridge.respondPassphrase?.(request.requestId, "", true);
        return;
      }

      // If the bridge already tried a passphrase and it was wrong, skip auto-respond
      if (!request.passphraseInvalid) {
        // Check if a reference key exists for this path — use its passphrase
        const currentKeys = keysRef.current;
        const refKey = currentKeys.find((k: SSHKey) => k.source === 'reference' && k.filePath === request.keyPath);
        if (refKey?.passphrase && refKey.savePassphrase !== false && !isEncryptedCredentialPlaceholder(refKey.passphrase)) {
          if (!isRequestCurrent()) {
            void bridge.respondPassphrase?.(request.requestId, "", true);
            return;
          }
          console.log('[App] Auto-responding with reference key passphrase for:', request.keyPath);
          void bridge.respondPassphrase?.(request.requestId, refKey.passphrase, false);
          return;
        }

        // Fallback: try old storage for passphrase
        const saved = await loadDefaultKeyPassphrase(request.keyPath);
        if (!isRequestCurrent()) {
          void bridge.respondPassphrase?.(request.requestId, "", true);
          return;
        }
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
            if (!isRequestCurrent()) {
              void bridge.respondPassphrase?.(request.requestId, "", true);
              return;
            }
          }
          void bridge.respondPassphrase?.(request.requestId, saved, false);
          return;
        }
      }

      if (!isRequestCurrent()) {
        void bridge.respondPassphrase?.(request.requestId, "", true);
        return;
      }

      // No saved passphrase or it was invalid, show modal
      setPassphraseQueue(prev => [...prev, {
        requestId: request.requestId,
        keyPath: request.keyPath,
        keyName: request.keyName,
        hostname: request.hostname,
        sessionId: request.sessionId,
        bootEpoch: request.bootEpoch,
      }]);
    });

    return () => {
      unsubscribe?.();
    };
  }, [updateKeys]);

  // Drop queued passphrase prompts when a terminal disconnects mid-boot.
  useEffect(() => {
    const onDisconnected = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const disconnectedSessionId = detail?.sessionId;
      if (!disconnectedSessionId) return;
      const bridge = netcattyBridge.get();
      setPassphraseQueue((prev) => {
        const keep: typeof prev = [];
        for (const item of prev) {
          if (item.sessionId === disconnectedSessionId) {
            void bridge?.respondPassphrase?.(item.requestId, "", true);
            continue;
          }
          keep.push(item);
        }
        return keep;
      });
    };
    window.addEventListener("netcatty:terminal-session-disconnected", onDisconnected);
    return () => {
      window.removeEventListener("netcatty:terminal-session-disconnected", onDisconnected);
    };
  }, []);

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
      void clearRememberedKeyPassphrases({
        keyPaths,
        keyIds,
        getKeys: () => keysRef.current,
        setCurrentKeys: (keys) => {
          keysRef.current = keys;
        },
        updateKeys,
      });
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
  // Keep hotkey/capture paths on stable callback identities so settings/log/session
  // array thrash does not rebuild appTerminalDomain (see domain isolation).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // Logs live in connectionLogsStore — keep a ref fresh without re-rendering App.
  const connectionLogsRef = useRef(getConnectionLogsSnapshot().connectionLogs);
  useEffect(() => {
    const syncLogs = () => {
      connectionLogsRef.current = getConnectionLogsSnapshot().connectionLogs;
    };
    // useVaultState publishes from a layout effect in the parent publisher, so
    // the first snapshot lands after this component rendered but before this
    // effect attaches. Re-read once so the ref is never stuck on the boot-time
    // empty array until the next log append.
    syncLogs();
    return subscribeConnectionLogs(syncLogs);
  }, []);
  const editorTabsRef = useRef(editorTabs);
  editorTabsRef.current = editorTabs;
  const workspacesRefForHotkeys = useRef(workspaces);
  workspacesRefForHotkeys.current = workspaces;
  const showSftpTabRef = useRef(showSftpTab);
  showSftpTabRef.current = showSftpTab;
  const shellOnlyTabNumberShortcutsRef = useRef(shellOnlyTabNumberShortcuts);
  shellOnlyTabNumberShortcutsRef.current = shellOnlyTabNumberShortcuts;
  const isQuickSwitcherOpenRef = useRef(isQuickSwitcherOpen);
  isQuickSwitcherOpenRef.current = isQuickSwitcherOpen;
  const orderedTabsRef = useRef<string[]>([]);

  const toggleScriptsSidePanelRef = useRef<(() => void) | null>(null);
  const toggleSidePanelRef = useRef<(() => void) | null>(null);
  const openNoteRequestIdRef = useRef(0);
  const [openNoteRequest, setOpenNoteRequest] = useState<{
    tabId: string;
    noteId: string;
    requestId: number;
  } | null>(null);
  const vaultFocusRequestIdRef = useRef(0);
  const [vaultFocusRequest, setVaultFocusRequest] = useState<{
    type: 'note';
    noteId: string;
    requestId: number;
  } | {
    type: 'snippet';
    snippetId: string;
    requestId: number;
  } | null>(null);
  // Populated below so the hotkey dispatcher can open the Settings window
  // even though `handleOpenSettings` is declared further down in the file.
  const handleOpenSettingsRef = useRef<() => void>(() => {});
  const closeTabInFlightRef = useRef(false);
  // Populated by UnsavedChangesProvider render-prop below so that the hotkey
  // dispatcher (defined outside that scope) can still reach the dirty-confirm
  // close flow.
  const handleRequestCloseEditorTabRef = useRef<(id: string) => boolean | Promise<boolean>>(() => false);

  const createLocalTerminalWithCurrentShell = useCallback(() => { return createLocalTerminalWithCurrentShellImpl(() => ({ classifyLocalShellType, createLocalTerminal, discoveredShells, resolveShellSetting, terminalSettings })); }, [createLocalTerminal, terminalSettings, discoveredShells]);

  const splitSessionWithCurrentShell = useCallback((sessionId: string, direction: 'horizontal' | 'vertical') => { return splitSessionWithCurrentShellImpl(() => ({ classifyLocalShellType, direction, discoveredShells, getSessionRestoreCwd, hostById, terminalHosts, netcattyBridge, resolveShellSetting, sessionId, sessions, splitSession, terminalSettings }), sessionId, direction); }, [splitSession, terminalSettings, discoveredShells, sessions, getSessionRestoreCwd, hostById, terminalHosts]);

  const copySessionWithCurrentShell = useCallback((sessionId: string) => { return copySessionWithCurrentShellImpl(() => ({ classifyLocalShellType, copySession, discoveredShells, getSessionRestoreCwd, hostById, terminalHosts, netcattyBridge, resolveShellSetting, sessionId, sessions, terminalSettings }), sessionId); }, [copySession, terminalSettings, discoveredShells, sessions, getSessionRestoreCwd, hostById, terminalHosts]);

  const copyWorkspaceWithCurrentShell = useCallback((workspaceId: string) => { return copyWorkspaceWithCurrentShellImpl(() => ({ classifyLocalShellType, collectSessionIds, copyWorkspace, discoveredShells, getSessionRestoreCwd, hostById, terminalHosts, netcattyBridge, resolveShellSetting, sessions, terminalSettings, workspaces }), workspaceId); }, [copyWorkspace, terminalSettings, discoveredShells, sessions, workspaces, getSessionRestoreCwd, hostById, terminalHosts]);

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
  const pluginViewTabIds = useMemo(
    () => pluginViewTabs.map((tab) => tab.id),
    [pluginViewTabs],
  );
  const additionalWorkTabIds = useMemo(
    () => [...editorTabTopIds, ...pluginViewTabIds],
    [editorTabTopIds, pluginViewTabIds],
  );

  // 顶层标签顺序需要包含编辑器标签，供顶部标签和编辑器邻居计算使用。
  const orderedTabsWithEditors = useMemo(
    () => getOrderedWorkTabs(additionalWorkTabIds),
    [additionalWorkTabIds, getOrderedWorkTabs],
  );
  orderedTabsRef.current = orderedTabsWithEditors;

  const closePluginViewTab = useCallback((tabId: string) => {
    const index = orderedTabsWithEditors.indexOf(tabId);
    if (activeTabStore.getActiveTabId() === tabId) {
      const next = orderedTabsWithEditors[index - 1] ?? orderedTabsWithEditors[index + 1] ?? 'vault';
      activeTabStore.setActiveTabId(next === tabId ? 'vault' : next);
    }
    pluginViewTabStore.close(tabId);
  }, [orderedTabsWithEditors]);

  // Close many tabs at once with a single batched busy-shell confirmation.
  // Used by the "Close all / Close others / Close to the right" context-menu
  // actions on tabs (#748).
  const closeTabsBatch = useCallback(
    async (targetIds: string[]) => {
      const closingTabIds = new Set(targetIds);
      const activeBeforeClose = activeTabStore.getActiveTabId();
      const focusAfterClose = resolveBatchTabCloseFocus({
        orderedTabIds: orderedTabsWithEditors,
        closingTabIds,
        activeTabId: activeBeforeClose,
      });
      const pluginIds = targetIds.filter((id) => pluginViewTabStore.getTab(id));
      const regularIds = targetIds.filter((id) => !pluginViewTabStore.getTab(id));
      const canClose = !regularIds.length || await closeTabsBatchImpl(
        () => ({ closeLogView, closeSessions, closeTabsInFlightRef, closeWorkspace, confirmIfBusyLocalTerminal, logViews, sessions, targetIds: regularIds, workspaces }),
        regularIds,
      );
      if (!canClose) return;
      for (const id of pluginIds) pluginViewTabStore.close(id);
      if (closingTabIds.has(activeBeforeClose)) activeTabStore.setActiveTabId(focusAfterClose);
    },
    [workspaces, sessions, logViews, confirmIfBusyLocalTerminal, closeWorkspace, closeSessions, closeLogView, orderedTabsWithEditors],
  );

  // Shared hotkey action handler - used by both global handler and terminal callback.
  // Volatile arrays/settings are read from refs so this identity stays stable under
  // title/log/settings thrash and does not rebuild appTerminalDomain.
  const executeHotkeyAction = useCallback((action: string, e: KeyboardEvent) => {
    return executeHotkeyActionImpl(() => ({
      IS_DEV,
      MOVE_FOCUS_DEBOUNCE_MS,
      action,
      activeTabStore,
      addConnectionLogRef,
      closePluginViewTab,
      closeSession,
      closeTabInFlightRef,
      closeWorkspace,
      collectSessionIds,
      confirmIfBusyLocalTerminal,
      createLocalTerminalWithCurrentShell,
      e,
      editorTabs: editorTabsRef.current,
      fromEditorTabId,
      handleOpenSettingsRef,
      handleRequestCloseEditorTabRef,
      isEditorTabId,
      isPluginViewTabId,
      isQuickSwitcherOpen: isQuickSwitcherOpenRef.current,
      lastMoveFocusTimeRef,
      moveFocusInWorkspace,
      orderedTabs: orderedTabsRef.current,
      resolveCloseIntent,
      resolveSnippetsShortcutIntent,
      sessions: sessionsRef.current,
      setActiveTabId,
      setAddToWorkspaceDialog,
      setIsQuickSwitcherOpen,
      setNavigateToSection,
      settings: {
        showSftpTab: showSftpTabRef.current,
        shellOnlyTabNumberShortcuts: shellOnlyTabNumberShortcutsRef.current,
      },
      splitSessionWithCurrentShell,
      systemInfoRef,
      toEditorTabId,
      toggleBroadcast,
      toggleScriptsSidePanelRef,
      toggleSidePanelRef,
      toggleWorkspaceViewMode,
      workspaces: workspacesRefForHotkeys.current,
    }), action, e);
  }, [
    setActiveTabId,
    closePluginViewTab,
    closeSession,
    closeWorkspace,
    createLocalTerminalWithCurrentShell,
    splitSessionWithCurrentShell,
    moveFocusInWorkspace,
    toggleBroadcast,
    toggleWorkspaceViewMode,
    confirmIfBusyLocalTerminal,
  ]);

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
      pluginViewTabIds: pluginViewTabs.map((tab) => tab.id),
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
  }, [closeLogView, editorTabs, executeHotkeyAction, logViews, pluginViewTabs, sessions, workspaces]);

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

  const handleDeleteHost = useCallback((hostId: string) => {
    const target = hosts.find(h => h.id === hostId);
    setDeleteHostConfirm({ hostId, name: target?.label || hostId });
  }, [hosts]);

  const handleConfirmDeleteHost = useCallback(() => {
    if (!deleteHostConfirm) return;
    updateHosts(hosts.filter(h => h.id !== deleteHostConfirm.hostId));
    setDeleteHostConfirm(null);
  }, [deleteHostConfirm, hosts, updateHosts]);

  const handleCancelDeleteHost = useCallback(() => {
    setDeleteHostConfirm(null);
  }, []);

  const handleAddKnownHost = useCallback((kh: KnownHost) => {
    const nextKnownHosts = upsertKnownHost(knownHostsRef.current, kh);
    knownHostsRef.current = nextKnownHosts;
    updateKnownHosts(nextKnownHosts);
  }, [updateKnownHosts]);

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
  const handleCreateLocalTerminal = useCallback((
    shell?: { command: string; args?: string[]; name?: string; icon?: string },
    options?: { localStartDir?: string },
  ) => {
    return handleCreateLocalTerminalImpl(
      () => ({ addConnectionLog, classifyLocalShellType, createLocalTerminal, discoveredShells, resolveShellSetting, shell, systemInfoRef, terminalSettings, undefined }),
      shell,
      options,
    );
  }, [addConnectionLog, createLocalTerminal, terminalSettings, discoveredShells]);

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

  const createWorkspaceWithEffectiveHosts = useCallback((name: string, selectedHosts: Host[]) => {
    createWorkspaceWithHosts(name, selectedHosts.map(resolveEffectiveHost));
  }, [createWorkspaceWithHosts, resolveEffectiveHost]);

  const createWorkspaceFromEffectiveTargets = useCallback((
    targets: Parameters<typeof createWorkspaceFromTargets>[0],
    name?: string,
  ) => createWorkspaceFromTargets(
    targets.map((target) => target.kind === 'host'
      ? { ...target, host: resolveEffectiveHost(target.host) }
      : target),
    name,
  ), [createWorkspaceFromTargets, resolveEffectiveHost]);

  // Wrapper to connect to host with logging
  const handleConnectToHost = useCallback((host: Host, alreadyEffective = false, hidden = false) => {
    if (host.ephemeral) {
      setEphemeralHosts((previous) => {
        const existingIndex = previous.findIndex((candidate) => candidate.id === host.id);
        if (existingIndex < 0) return [...previous, host];
        return previous.map((candidate, index) => index === existingIndex ? host : candidate);
      });
    }
    const effectiveHostResolver = alreadyEffective
      ? (candidate: Host) => candidate
      : resolveEffectiveHost;
    return handleConnectToHostImpl(() => ({
      addConnectionLog,
      connectToHost,
      host,
      identities,
      keys,
      resolveEffectiveHost: effectiveHostResolver,
      resolveHostAuth,
      systemInfoRef,
    }), host, hidden);
  }, [addConnectionLog, connectToHost, resolveEffectiveHost, identities, keys]);

  const openHostForVaultAgent = useCallback((host: Host, isExternalMcpCall: boolean) => {
    // Silent sessions only apply to actual external MCP clients (chatSessionId
    // equals the reserved external-MCP scope). The in-app Catty AI chat's
    // host_open always opens a visible tab, as documented.
    const hidden = isExternalMcpCall && readExternalMcpSilentSessions();
    const sessionId = handleConnectToHost(host, true, hidden);
    if (!sessionId) {
      return { ok: false as const, error: `Failed to open host "${host.id}".` };
    }
    // Surface the main window for external MCP / CLI open requests, unless the
    // user disabled this in Settings → AI → External MCP.
    if (readExternalMcpFocusOnHostOpen()) {
      void netcattyBridge.get()?.openMainWindow?.();
    }
    return { ok: true as const, sessionId, host };
  }, [handleConnectToHost]);

  const closeSessionForVaultAgent = useCallback((sessionId: string) => {
    if (!sessions.some((session) => session.id === sessionId)) {
      return { ok: false as const, error: `Session "${sessionId}" was not found.` };
    }
    netcattyBridge.get()?.closeSession?.(sessionId);
    closeSession(sessionId);
    return { ok: true as const };
  }, [closeSession, sessions]);

  useEffect(() => {
    if (isPeerSessionWindow) return;
    const bridge = netcattyBridge.get();
    const unsubscribe = bridge?.onTrayPanelCloseSession?.((sessionId) => {
      closeSessionForVaultAgent(sessionId);
    });
    return () => unsubscribe?.();
  }, [isPeerSessionWindow, closeSessionForVaultAgent]);

  useVaultAgentBridge({
    hosts,
    snippets,
    portForwardingRules,
    keys,
    identities,
    knownHosts: effectiveKnownHosts,
    proxyProfiles,
    managedSources,
    terminalSettings,
    updateHosts,
    updateKeys,
    updateSnippets,
    customGroups,
    updateCustomGroups,
    groupConfigs,
    updateGroupConfigs,
    updateManagedSources,
    updatePortForwardingRules: importPortForwardingRules,
    startTunnel,
    stopTunnel,
    stopRuleTunnels,
    openHost: openHostForVaultAgent,
    closeSession: closeSessionForVaultAgent,
    getScriptSessionMeta: (sessionId) => sessions.find((session) => session.id === sessionId),
  });

  const _handleSshDeepLink = useEffectEvent((payload: { url?: string }) => {
    const rawUrl = payload?.url || '';
    const target = parseSshDeepLink(rawUrl);
    if (!target) {
      toast.warning(t('deepLink.ssh.invalid'));
      return;
    }

    const effectiveHosts = hosts.map((host) => {
      const effectiveHost = resolveEffectiveHost(host);
      const resolvedAuth = resolveHostAuth({ host: effectiveHost, keys, identities });
      return {
        ...effectiveHost,
        username: resolvedAuth.username || effectiveHost.username,
      };
    });
    const matchedEffectiveHost = findSshDeepLinkHost(effectiveHosts, target);

    if (target.password) {
      // One-time-password link: connect ephemerally with exactly the URL
      // credentials. A uniquely matched saved host still contributes its
      // non-credential settings (proxy, jump chain, charset, ...). Build
      // from the group-resolved effective host so the builder can clear
      // `group` and block group credential inheritance from later
      // effective-host resolution.
      const draftOptions = { id: crypto.randomUUID(), now: Date.now() };
      const ephemeralHost = matchedEffectiveHost
        ? buildSshDeepLinkEphemeralHostFromSaved(matchedEffectiveHost, target, draftOptions)
        : buildSshDeepLinkEphemeralHost(target, draftOptions);
      setEphemeralHosts((prev) => [...prev, ephemeralHost]);
      handleConnectToHost(ephemeralHost);
      return;
    }

    if (matchedEffectiveHost) {
      const originalHost = hosts.find((host) => host.id === matchedEffectiveHost.id) ?? matchedEffectiveHost;
      handleConnectToHost(buildSshDeepLinkConnectionHost(originalHost));
      return;
    }

    setDeepLinkHostDraft(buildSshDeepLinkHostDraft(target, {
      id: crypto.randomUUID(),
      now: Date.now(),
    }));
    setNavigateToSection('hosts');
    setActiveTabId('vault');
  });

  useEffect(() => {
    if (isPeerSessionWindow) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.onSshDeepLink) return;
    return bridge.onSshDeepLink((payload) => {
      _handleSshDeepLink(payload);
    });
  }, [isPeerSessionWindow]);

  const _handleTelnetDeepLink = useEffectEvent((payload: { url?: string }) => {
    const rawUrl = payload?.url || '';
    const target = parseTelnetDeepLink(rawUrl);
    if (!target) {
      toast.warning(t('deepLink.telnet.invalid'));
      return;
    }

    const effectiveHosts = hosts.map((host) =>
      materializeTelnetDeepLinkMatchHost(resolveEffectiveHost(host), identities),
    );
    const matchedEffectiveHost = findTelnetDeepLinkHost(effectiveHosts, target, {
      ignoreTargetUsername: Boolean(target.password),
    });

    if (matchedEffectiveHost) {
      if (target.password) {
        const ephemeralHost = buildTelnetDeepLinkEphemeralHostFromSaved(matchedEffectiveHost, target, {
          id: crypto.randomUUID(),
          now: Date.now(),
        });
        setEphemeralHosts((prev) => [...prev, ephemeralHost]);
        handleConnectToHost(ephemeralHost);
        return;
      }
      handleConnectToHost(buildTelnetDeepLinkConnectionHost(matchedEffectiveHost));
      return;
    }

    const ephemeralHost = buildTelnetDeepLinkOpenHost(effectiveHosts, target, {
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    setEphemeralHosts((prev) => [...prev, ephemeralHost]);
    handleConnectToHost(ephemeralHost);
  });

  useEffect(() => {
    if (isPeerSessionWindow) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.onTelnetDeepLink) return;
    return bridge.onTelnetDeepLink((payload) => {
      _handleTelnetDeepLink(payload);
    });
  }, [isPeerSessionWindow]);

  const _handleJmsDeepLink = useEffectEvent((payload: { url?: string }) => {
    const rawUrl = payload?.url || '';
    const target = parseJmsDeepLink(rawUrl);
    if (!target) {
      toast.warning(t('deepLink.jms.invalid'));
      return;
    }
    if (!isSupportedJmsProtocol(target.protocol)) {
      toast.warning(t('deepLink.jms.unsupported', { protocol: target.protocol }));
      return;
    }
    const ephemeralHost = buildJmsDeepLinkEphemeralHost(target, {
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    setEphemeralHosts((prev) => [...prev, ephemeralHost]);
    handleConnectToHost(ephemeralHost);
  });

  useEffect(() => {
    if (isPeerSessionWindow) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.onJmsDeepLink) return;
    return bridge.onJmsDeepLink((payload) => {
      _handleJmsDeepLink(payload);
    });
  }, [isPeerSessionWindow]);

  useEffect(() => {
    setEphemeralHosts((prev) => {
      if (prev.length === 0) return prev;
      const referencedHostIds = new Set(
        sessions.map((session) => session.hostId).filter((id): id is string => Boolean(id)),
      );
      const next = prev.filter((host) => referencedHostIds.has(host.id));
      return next.length === prev.length ? prev : next;
    });
  }, [sessions]);

  const _handleOpenTerminalPath = useEffectEvent((payload: { path?: string }) => {
    const localStartDir = typeof payload?.path === 'string' ? payload.path : '';
    if (!localStartDir.trim()) return;
    handleCreateLocalTerminal(undefined, { localStartDir });
  });

  useEffect(() => {
    if (isPeerSessionWindow) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.onOpenTerminalPath) return;
    return bridge.onOpenTerminalPath((payload) => {
      _handleOpenTerminalPath(payload);
    });
  }, [isPeerSessionWindow]);

  const handleOpenHostFromVaultNote = useCallback((host: Host, source?: { noteId?: string }) => {
    const tabId = handleConnectToHost(host);
    if (source?.noteId && typeof tabId === 'string' && tabId) {
      openNoteRequestIdRef.current += 1;
      setOpenNoteRequest({
        tabId,
        noteId: source.noteId,
        requestId: openNoteRequestIdRef.current,
      });
    }
    return tabId;
  }, [handleConnectToHost]);

  const handleOpenVaultNoteFromChat = useCallback((noteId: string) => {
    vaultFocusRequestIdRef.current += 1;
    setVaultFocusRequest({
      type: 'note',
      noteId,
      requestId: vaultFocusRequestIdRef.current,
    });
    setNavigateToSection('notes');
    setActiveTabId('vault');
  }, [setActiveTabId]);

  const handleOpenVaultHostFromChat = useCallback((hostId: string) => {
    const host = hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    setDeepLinkHostDraft(host);
    setNavigateToSection('hosts');
    setActiveTabId('vault');
  }, [hosts, setActiveTabId]);

  const handleOpenVaultSectionFromChat = useCallback((section: 'notes' | 'hosts' | 'snippets') => {
    setNavigateToSection(section);
    setActiveTabId('vault');
  }, [setActiveTabId]);

  const handleOpenVaultSnippetFromChat = useCallback((snippetId: string) => {
    vaultFocusRequestIdRef.current += 1;
    setVaultFocusRequest({
      type: 'snippet',
      snippetId,
      requestId: vaultFocusRequestIdRef.current,
    });
    setNavigateToSection('snippets');
    setActiveTabId('vault');
  }, [setActiveTabId]);

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
    // Functional update + identity-preserving updateHosts: only the patched
    // host object changes, so other open terminals keep stable host props.
    updateHosts((prev) => prev.map((h) => (
      h.id === host.id ? mergeTerminalHostUpdate(h, host) : h
    )));
  }, [updateHosts]);

  // Terminal-layer host updates may include ephemeral deep-link hosts; keep
  // those in memory only and never let them reach the persisted vault.
  const updateTerminalHosts = useCallback((nextHosts: Host[]) => {
    const { vaultHosts, ephemeralHosts: updatedEphemeralHosts } =
      splitHostsUpdateByEphemeral(nextHosts, ephemeralHostIds);
    if (updatedEphemeralHosts.length > 0) {
      setEphemeralHosts((prev) => applyEphemeralHostsUpdate(prev, updatedEphemeralHosts));
    }
    updateHosts(vaultHosts);
  }, [ephemeralHostIds, updateHosts]);

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

  // Handle terminal data capture when session exits. Read sessions/logs via refs
  // so connection-log appends do not rebuild appTerminalDomain.
  const handleTerminalDataCapture = useCallback((sessionId: string, data: string) => {
    return handleTerminalDataCaptureImpl(() => ({
      IS_DEV,
      connectionLogs: connectionLogsRef.current,
      data,
      selectConnectionLogForTerminalDataCapture,
      sessionId,
      sessions: sessionsRef.current,
      updateConnectionLog,
    }), sessionId, data);
  }, [updateConnectionLog]);

  // Check if host has multiple protocols enabled (using effective/resolved host)
  const hasMultipleProtocols = useCallback((host: Host) => { return hasMultipleProtocolsImpl(() => ({ host, resolveEffectiveHost }), host); }, [resolveEffectiveHost]);

  // Handle host connect with protocol selection (used by QuickSwitcher)
  const handleHostConnectWithProtocolCheck = useCallback((host: Host) => { return handleHostConnectWithProtocolCheckImpl(() => ({ handleConnectToHost, hasMultipleProtocols, host, resolveEffectiveHost, setIsQuickSwitcherOpen, setProtocolSelectHost, setQuickSearch }), host); }, [hasMultipleProtocols, handleConnectToHost, resolveEffectiveHost]);

  // Handle protocol selection from dialog
  const handleProtocolSelect = useCallback((protocol: HostProtocol, port: number) => { return handleProtocolSelectImpl(() => ({ handleConnectToHost, port, protocol, protocolSelectHost, setProtocolSelectHost }), protocol, port); }, [protocolSelectHost, handleConnectToHost]);

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

  // Delete-from-sidepanel plumbing: ScriptsSidePanel dispatches
  // `netcatty:snippets:delete` with `id` (single) or `ids` (bulk). Handled
  // here (rather than in QuickAddSnippetDialog) because delete needs no UI.
  // Goes through useVaultState.deleteSelectedSnippets so login/connect script
  // bindings clear with the snippets (SnippetsManager parity) against the
  // latest persisted vault snapshot under the shared cross-window lock.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id?: string; ids?: string[] }>).detail;
      const ids = collectSnippetDeleteIds(detail);
      if (ids.size === 0) return;
      void deleteSelectedSnippets(ids);
    };
    window.addEventListener('netcatty:snippets:delete', handler);
    return () => window.removeEventListener('netcatty:snippets:delete', handler);
  }, [deleteSelectedSnippets]);

  const handleEndSessionDrag = useCallback(() => {
    setDraggingSessionId(null);
  }, [setDraggingSessionId]);

  const handleRootContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => { return handleRootContextMenuImpl(() => ({ e }), e); }, []);


  // Hosts assemble domain bags from stores + this flat glue. Do NOT register
  // catalog arrays or prepared vault/terminal/chrome/dialogs domain bags here.
  useLayoutEffect(() => {
    registerAppHandlers({
      // Vault glue
      handleAddKnownHost,
      handleDeleteHost,
      handleOpenHostFromVaultNote,
      handleOpenVaultHostFromChat,
      handleOpenVaultNoteFromChat,
      handleOpenVaultSectionFromChat,
      handleOpenVaultSnippetFromChat,
      setDeepLinkHostDraft,
      setNavigateToSection,
      setVaultFocusRequest,
      unmanageSource,
      // Terminal glue
      closeTabsBatch,
      copySessionWithCurrentShell,
      copyWorkspaceWithCurrentShell,
      copySessionToNewWindowWithCurrentShell,
      createWorkspaceFromTargets: createWorkspaceFromEffectiveTargets,
      createWorkspaceWithHosts: createWorkspaceWithEffectiveHosts,
      handleConnectSerial,
      handleConnectToHost,
      handleCreateLocalTerminal,
      handleHotkeyAction,
      handleSessionStatusChange,
      handleTerminalDataCapture,
      handleUpdateHostFromTerminal,
      updateTerminalHosts,
      runSnippet: handleRunSnippet,
      splitSessionWithCurrentShell,
      toggleScriptsSidePanelRef,
      toggleSidePanelRef,
      // Chrome glue
      handleEndSessionDrag,
      handleOpenQuickSwitcher,
      handleOpenSettings,
      handleRootContextMenu,
      handleSyncNowManual,
      // Dialogs / overlays glue
      clearAndRemoveSource,
      clearAndRemoveSources,
      handleHostConnectWithProtocolCheck,
      handleKeyboardInteractiveCancel,
      handleKeyboardInteractiveSubmit,
      handlePassphraseCancel,
      handlePassphraseSkip,
      handlePassphraseSubmit,
      handleProtocolSelect,
      handleRequestCloseEditorTabRef,
      resolveEmptyVaultConflict,
      setAddToWorkspaceDialog,
      setIsCreateWorkspaceOpen,
      setIsQuickSwitcherOpen,
      setProtocolSelectHost,
      setQuickSearch,
      handleCancelDeleteHost,
      handleConfirmDeleteHost,
    });
    publishAppLocalUi({
      isQuickSwitcherOpen,
      isCreateWorkspaceOpen,
      addToWorkspaceDialog,
      quickSearch,
      protocolSelectHost,
      navigateToSection,
      deepLinkHostDraft,
      ephemeralHosts,
      portForwardingRules,
      keyboardInteractiveQueue,
      passphraseQueue,
      deleteHostConfirm,
      vaultFocusRequest,
      openNoteRequest,
      emptyVaultConflict,
    });
  }, [
    handleAddKnownHost,
    handleDeleteHost,
    handleOpenHostFromVaultNote,
    handleOpenVaultHostFromChat,
    handleOpenVaultNoteFromChat,
    handleOpenVaultSectionFromChat,
    handleOpenVaultSnippetFromChat,
    setDeepLinkHostDraft,
    setNavigateToSection,
    setVaultFocusRequest,
    unmanageSource,
    closeTabsBatch,
    copySessionWithCurrentShell,
    copyWorkspaceWithCurrentShell,
    copySessionToNewWindowWithCurrentShell,
    createWorkspaceFromEffectiveTargets,
    createWorkspaceWithEffectiveHosts,
    handleConnectSerial,
    handleConnectToHost,
    handleCreateLocalTerminal,
    handleHotkeyAction,
    handleSessionStatusChange,
    handleTerminalDataCapture,
    handleUpdateHostFromTerminal,
    updateTerminalHosts,
    handleRunSnippet,
    splitSessionWithCurrentShell,
    handleEndSessionDrag,
    handleOpenQuickSwitcher,
    handleOpenSettings,
    handleRootContextMenu,
    handleSyncNowManual,
    clearAndRemoveSource,
    clearAndRemoveSources,
    handleHostConnectWithProtocolCheck,
    handleKeyboardInteractiveCancel,
    handleKeyboardInteractiveSubmit,
    handlePassphraseCancel,
    handlePassphraseSkip,
    handlePassphraseSubmit,
    handleProtocolSelect,
    resolveEmptyVaultConflict,
    handleCancelDeleteHost,
    handleConfirmDeleteHost,
    isQuickSwitcherOpen,
    isCreateWorkspaceOpen,
    addToWorkspaceDialog,
    quickSearch,
    protocolSelectHost,
    navigateToSection,
    deepLinkHostDraft,
    ephemeralHosts,
    portForwardingRules,
    keyboardInteractiveQueue,
    passphraseQueue,
    deleteHostConfirm,
    vaultFocusRequest,
    openNoteRequest,
    emptyVaultConflict,
  ]);

  useLayoutEffect(() => () => {
    registerAppHandlers(null);
  }, []);

  return null;
}
