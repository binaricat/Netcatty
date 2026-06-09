import { FolderTree, MessageSquare, PanelLeft, PanelRight, Palette, X, Zap } from 'lucide-react';
import React, { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeTabStore } from '../application/state/activeTabStore';
import { canReuseTerminalConnection } from '../application/state/terminalConnectionReuse';
import { resolveTerminalSessionExitIntent, type TerminalSessionExitEvent } from '../application/state/resolveTerminalSessionExitIntent';
import {
  getSessionActivityIdsToClear,
  getValidSessionActivityIds,
  shouldMarkSessionActivity,
} from '../application/state/sessionActivity';
import { sessionActivityStore } from '../application/state/sessionActivityStore';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import { collectSessionIds } from '../domain/workspace';


import { cn, normalizeLineEndings } from '../lib/utils';
import { detectLocalOs } from '../lib/localShell';
import { useStoredString } from '../application/state/useStoredString';
import { useStoredNumber } from '../application/state/useStoredNumber';
import {
  STORAGE_KEY_SIDE_PANEL_WIDTH,
} from '../infrastructure/config/storageKeys';
import { buildCacheKey } from '../application/state/sftp/sharedRemoteHostCache';
import type { DropEntry } from '../lib/sftpFileUtils';
import { Host, KnownHost, TerminalSession, Workspace } from '../types';
import { resolveGroupDefaults, applyGroupDefaults } from '../domain/groupConfig';
import { resolveHostAutofillPassword } from '../domain/sshAuth';
import { materializeHostProxyProfile } from '../domain/proxyProfiles';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useI18n } from '../application/i18n/I18nProvider';
import { SftpSidePanel } from './SftpSidePanel';
import { ScriptsSidePanel } from './ScriptsSidePanel';
import { resolveSnippetCommand } from './SnippetExecutionProvider';
import type { Snippet } from '../types';
import { ThemeSidePanel } from './terminal/ThemeSidePanel';
import { focusTerminalSessionInput } from './terminal/focusTerminalSession';
import { TerminalComposeBar } from './terminal/TerminalComposeBar';
import { Button } from './ui/button';
import { setupMcpApprovalBridge } from '../infrastructure/ai/shared/approvalGate';
import { resolveScriptsSidePanelShortcutIntent } from '../application/state/resolveSnippetsShortcutIntent';
import { resolveSidePanelToggleIntent } from '../application/state/resolveSidePanelToggleIntent';
import { resolveAiSidePanelToggleIntent } from '../application/state/resolveAiSidePanelToggleIntent';
import { terminalLayerAreEqual } from './terminalLayerMemo';
import { TerminalLayerTabBridge } from './terminalLayer/TerminalLayerTabBridge';
import { resolvePreferredTerminalCwd, scheduleBackendCwdProbeAfterCommand } from './terminal/sftpCwd';
import { classifyDistroId, shouldProbeSessionCwd } from '../domain/host';

import {
  AIChatPanelsHost,
  AISidePanelStateRoot,
  AIStateMaintenanceHost,
  AIStateProvider,
  ChunkedEscapeFilter,
  TerminalPanesHost,
  clearTerminalPreviewVars,
  clearTopTabsPreviewVars,
  filterTabsMap,
  hasNotifiableTerminalOutput,
  type PendingSftpUpload,
  type PendingTerminalSelectionForAI,
  type SidePanelTab,
  type SnippetExecutor,
  type TerminalLayerProps,
} from './terminalLayer/TerminalLayerSupport';

const addMountedSidePanelTabId = (
  tabIds: string[],
  tabId: string,
): string[] => (tabIds.includes(tabId) ? tabIds : [...tabIds, tabId]);

const removeMountedSidePanelTabId = (
  tabIds: string[],
  tabId: string,
): string[] => tabIds.filter((id) => id !== tabId);

const TerminalLayerInner: React.FC<TerminalLayerProps> = ({
  hosts,
  customGroups,
  groupConfigs,
  proxyProfiles,
  keys,
  identities,
  snippets,
  snippetPackages,
  sessions,
  workspaces,
  knownHosts = [],
  draggingSessionId,
  terminalTheme,
  followAppTerminalTheme = false,
  accentMode = 'theme',
  customAccent = '',
  terminalSettings,
  terminalFontFamilyId,
  fontSize = 14,
  hotkeyScheme = 'disabled',
  keyBindings = [],
  onHotkeyAction,
  onUpdateTerminalThemeId,
  onUpdateTerminalFontFamilyId,
  onUpdateTerminalFontSize,
  onUpdateTerminalFontWeight,
  onCloseSession,
  onUpdateSessionStatus,
  onUpdateHostDistro,
  onUpdateHost,
  onAddKnownHost,
  onCommandExecuted,
  onTerminalDataCapture,
  onCreateWorkspaceFromSessions,
  onAddSessionToWorkspace,
  onRequestAddToWorkspace,
  onUpdateSplitSizes,
  onSetDraggingSessionId,
  onToggleWorkspaceViewMode,
  onSetWorkspaceFocusedSession,
  onReorderWorkspaceSessions,
  onSplitSession,
  onConnectToHost,
  onCreateLocalTerminal,
  isBroadcastEnabled,
  onToggleBroadcast,
  updateHosts,
  sftpDefaultViewMode,
  sftpDoubleClickBehavior,
  sftpAutoSync,
  sftpShowHiddenFiles,
  sftpUseCompressedUpload,
  sftpAutoOpenSidebar,
  sftpFollowTerminalCwd,
  setSftpFollowTerminalCwd,
  editorWordWrap,
  setEditorWordWrap,
  sessionLogsEnabled,
  sessionLogsDir,
  sessionLogsFormat,
  sessionLogsTimestampsEnabled,
  sshDebugLogsEnabled,
  showHostTreeSidebar = true,
  toggleScriptsSidePanelRef,
  toggleSidePanelRef,
}) => {
  const { t } = useI18n();
  const terminalRendererCwdBySessionRef = useRef<Map<string, string>>(new Map());
  const stableRef = useRef<Record<string, unknown>>({});
  const activeTabIdRef = useRef(activeTabStore.getActiveTabId());
  const activeWorkspaceRef = useRef<Workspace | undefined>(undefined);
  const activeSessionRef = useRef<TerminalSession | undefined>(undefined);
  const focusedSessionIdRef = useRef<string | undefined>(undefined);
  const terminalCwdRevisionRef = useRef(0);
  const [terminalCwdRevision, setTerminalCwdRevision] = useState(0);
  const cwdProbeCancelersRef = useRef<Map<string, () => void>>(new Map());
  const cwdProbeGenerationRef = useRef<Map<string, number>>(new Map());

  const handleTerminalCwdChange = useCallback((sessionId: string, cwd: string | null) => {
    if (cwd && cwd.trim().length > 0) {
      terminalRendererCwdBySessionRef.current.set(sessionId, cwd);
    } else {
      terminalRendererCwdBySessionRef.current.delete(sessionId);
    }
    terminalCwdRevisionRef.current += 1;
    setTerminalCwdRevision(terminalCwdRevisionRef.current);
  }, []);

  // Stable callback references for Terminal components
  const handleCloseSession = useCallback((sessionId: string) => {
    onCloseSession(sessionId);
  }, [onCloseSession]);

  const sftpAutoOpenSidebarRef = useRef(sftpAutoOpenSidebar);
  sftpAutoOpenSidebarRef.current = sftpAutoOpenSidebar;
  const sftpFollowTerminalCwdRef = useRef(sftpFollowTerminalCwd);
  sftpFollowTerminalCwdRef.current = sftpFollowTerminalCwd;

  const handleStatusChange = useCallback((sessionId: string, status: TerminalSession['status']) => {
    onUpdateSessionStatus(sessionId, status);

    // Auto-open SFTP sidebar when a remote host connects (if setting enabled)
    if (status === 'connected' && sftpAutoOpenSidebarRef.current) {
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (!session) return;
      // Only auto-open for SSH/Mosh (SFTP requires SSH); skip local/unset protocol
      const proto = session.protocol;
      if (proto !== 'ssh' && proto !== 'mosh') return;

      const host = hostsRef.current.find(h => h.id === session.hostId);

      // Determine the tab ID (workspace or solo session)
      const tabId = session.workspaceId || sessionId;

      // Only open if the sidebar is not already open for this tab
      if (sidePanelOpenTabsRef.current.has(tabId)) return;

      const hostWithOverrides: Host = host
        ? {
            ...host,
            protocol: session.protocol ?? host.protocol,
            port: session.port ?? host.port,
            moshEnabled: session.moshEnabled ?? host.moshEnabled,
            etEnabled: session.etEnabled ?? host.etEnabled,
          }
        : {
            // Quick Connect / temporary session — build minimal host from session data
            id: session.hostId || sessionId,
            hostname: session.hostname,
            username: session.username,
            port: session.port ?? 22,
            protocol: proto,
            label: session.label || session.hostname,
          } as Host;

      setSidePanelOpenTabs(prev => {
        const next = new Map(prev);
        next.set(tabId, 'sftp');
        return next;
      });
      setSftpHostForTab(prev => {
        const next = new Map(prev);
        next.set(tabId, hostWithOverrides);
        return next;
      });
    }
  }, [onUpdateSessionStatus]);

  const handleSessionExit = useCallback((sessionId: string, evt: TerminalSessionExitEvent) => {
    const intent = resolveTerminalSessionExitIntent(evt);
    if (intent.kind === "closeSession") {
      onCloseSession(sessionId);
    } else {
      onUpdateSessionStatus(sessionId, 'disconnected');
    }
  }, [onCloseSession, onUpdateSessionStatus]);

  const handleOsDetected = useCallback((hostId: string, distro: string) => {
    onUpdateHostDistro(hostId, distro);
  }, [onUpdateHostDistro]);

  const handleUpdateHost = useCallback((host: Host) => {
    onUpdateHost(host);
  }, [onUpdateHost]);

  const handleAddKnownHost = useCallback((knownHost: KnownHost) => {
    onAddKnownHost?.(knownHost);
  }, [onAddKnownHost]);

  const handleTerminalDataCapture = useCallback((sessionId: string, data: string) => {
    onTerminalDataCapture?.(sessionId, data);
  }, [onTerminalDataCapture]);

  // Terminal backend for broadcast writes
  const terminalBackend = useTerminalBackend();
  const snippetExecutorsRef = useRef<Map<string, SnippetExecutor>>(new Map());

  const handleSnippetExecutorChange = useCallback((sessionId: string, executor: SnippetExecutor | null) => {
    if (executor) {
      snippetExecutorsRef.current.set(sessionId, executor);
      return;
    }
    snippetExecutorsRef.current.delete(sessionId);
  }, []);

  const onSessionData = terminalBackend.onSessionData;

  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );

  // Workspace-level compose bar state
  const [isComposeBarOpen, setIsComposeBarOpen] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const onSetWorkspaceFocusedSessionRef = useRef(onSetWorkspaceFocusedSession);
  onSetWorkspaceFocusedSessionRef.current = onSetWorkspaceFocusedSession;

  // Handle broadcast input - write to all other sessions in the source workspace.
  const handleBroadcastInput = useCallback((data: string, sourceSessionId: string) => {
    const sourceSession = sessionsRef.current.find((session) => session.id === sourceSessionId);
    const workspaceId = sourceSession?.workspaceId;
    if (!workspaceId) return;

    for (const session of sessionsRef.current) {
      if (session.workspaceId === workspaceId && session.id !== sourceSessionId) {
        terminalBackend.writeToSession(session.id, data);
      }
    }
  }, [terminalBackend]);

  // Side panel state - per-tab tracking of which sub-panel is active
  // Maps tab IDs to the active sub-panel type (sftp/scripts/theme), absent = closed
  const [sidePanelOpenTabs, setSidePanelOpenTabs] = useState<Map<string, SidePanelTab>>(new Map());
  // Keep AI/scripts/theme panels mounted while switching sub-tabs (like SFTP).
  const [aiMountedTabIds, setAiMountedTabIds] = useState<string[]>([]);
  const [scriptsMountedTabIds, setScriptsMountedTabIds] = useState<string[]>([]);
  const [themeMountedTabIds, setThemeMountedTabIds] = useState<string[]>([]);
  const [sidePanelWidth, setSidePanelWidth, persistSidePanelWidth] = useStoredNumber(
    STORAGE_KEY_SIDE_PANEL_WIDTH, 420, { min: 280, max: 800 },
  );
  const [sidePanelPosition, setSidePanelPosition] = useStoredString<'left' | 'right'>(
    'netcatty_side_panel_position',
    'left',
    (v): v is 'left' | 'right' => v === 'left' || v === 'right',
  );
  const sidePanelOpenTabsRef = useRef(sidePanelOpenTabs);
  sidePanelOpenTabsRef.current = sidePanelOpenTabs;

  // Remember the last sub-panel shown per tab so the toggle shortcut can
  // restore it after a close. Overwritten on open, never cleared on close.
  const lastSidePanelTabRef = useRef<Map<string, SidePanelTab>>(new Map());

  // The host to pass to the SFTP panel - stored when the user opens SFTP
  const [sftpHostForTab, setSftpHostForTab] = useState<Map<string, Host>>(new Map());
  const [sftpInitialLocationForTab, setSftpInitialLocationForTab] = useState<
    Map<string, { hostId: string; path: string }>
  >(new Map());
  const [sftpPendingUploadsForTab, setSftpPendingUploadsForTab] = useState<
    Map<string, PendingSftpUpload>
  >(new Map());
  const [pendingTerminalSelectionForAI, setPendingTerminalSelectionForAI] =
    useState<PendingTerminalSelectionForAI | null>(null);
  const sftpHostForTabRef = useRef(sftpHostForTab);
  sftpHostForTabRef.current = sftpHostForTab;

  const handleToggleWorkspaceComposeBar = useCallback(() => {
    setIsComposeBarOpen(prev => !prev);
  }, []);

  const handleOpenSftp = useCallback((host: Host, initialPath?: string, pendingUploadEntries?: DropEntry[], sourceSessionId?: string) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    // When SFTP is opened from a non-focused workspace pane (toolbar click
    // or drag-drop), switch focus first so the SFTP panel binds to the
    // correct host.
    if (sourceSessionId) {
      const ws = activeWorkspaceRef.current;
      if (ws && ws.focusedSessionId !== sourceSessionId) {
        onSetWorkspaceFocusedSessionRef.current?.(ws.id, sourceSessionId);
      }
    }

    const currentPanel = sidePanelOpenTabsRef.current.get(tabId);
    const isOpen = currentPanel === 'sftp';
    const currentHost = sftpHostForTabRef.current.get(tabId);
    const shouldKeepOpen = !!pendingUploadEntries?.length;
    // Compare full endpoint identity so that session-time overrides
    // (different port/protocol for the same host ID) trigger a switch
    // instead of toggling the panel closed.
    const isSameEndpoint = currentHost
      && currentHost.id === host.id
      && currentHost.hostname === host.hostname
      && currentHost.port === host.port
      && currentHost.protocol === host.protocol
      && currentHost.username === host.username
      && currentHost.sftpSudo === host.sftpSudo;

    const isClosing = !shouldKeepOpen && isOpen && isSameEndpoint;

    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      if (isClosing) {
        next.delete(tabId);
      } else {
        next.set(tabId, 'sftp');
      }
      return next;
    });

    // Store or remove the host for this tab.
    // Removing on close unmounts the panel so SFTP sessions are cleaned up.
    setSftpHostForTab(prev => {
      const next = new Map(prev);
      if (isClosing) {
        next.delete(tabId);
      } else {
        next.set(tabId, host);
      }
      return next;
    });

    setSftpInitialLocationForTab(prev => {
      const next = new Map(prev);
      if (initialPath) {
        next.set(tabId, { hostId: host.id, path: initialPath });
      } else {
        next.delete(tabId);
      }
      return next;
    });

    setSftpPendingUploadsForTab(prev => {
      const next = new Map(prev);
      if (isClosing || !pendingUploadEntries?.length) {
        // Clear any stale pending upload on close or when opening without new files
        next.delete(tabId);
      } else {
        next.set(tabId, {
          requestId: crypto.randomUUID(),
          hostId: host.id,
          connectionKey: buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username),
          targetPath: initialPath,
          entries: pendingUploadEntries,
        });
      }
      return next;
    });
  }, []);

  const handlePendingUploadHandled = useCallback((tabId: string, requestId: string) => {
    setSftpPendingUploadsForTab(prev => {
      const current = prev.get(tabId);
      if (!current || current.requestId !== requestId) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const handleSftpInitialLocationApplied = useCallback((tabId: string, location: { hostId: string; path: string }) => {
    setSftpInitialLocationForTab(prev => {
      const current = prev.get(tabId);
      if (!current || current.hostId !== location.hostId || current.path !== location.path) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  // Pre-compute host lookup map for O(1) access
  const hostMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);
  const hostMapRef = useRef(hostMap);
  hostMapRef.current = hostMap;
  const proxyProfileIdSet = useMemo(
    () => new Set(proxyProfiles.map((profile) => profile.id)),
    [proxyProfiles],
  );
  const effectiveHosts = useMemo(
    () => hosts.map((host) => {
      const groupDefaults = host.group
        ? resolveGroupDefaults(host.group, groupConfigs, { validProxyProfileIds: proxyProfileIdSet })
        : {};
      return materializeHostProxyProfile(
        applyGroupDefaults(host, groupDefaults, { validProxyProfileIds: proxyProfileIdSet }),
        proxyProfiles,
      );
    }),
    [groupConfigs, hosts, proxyProfileIdSet, proxyProfiles],
  );

  // Pre-compute fallback hosts to avoid creating new objects on every render
  const sessionHostsMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const session of sessions) {
      const rawHost = hostMap.get(session.hostId);
      if (rawHost) {
        // Apply group config defaults so Terminal sees the merged host
        const groupDefaults = rawHost.group
          ? resolveGroupDefaults(rawHost.group, groupConfigs, { validProxyProfileIds: proxyProfileIdSet })
          : {};
        const existingHost = materializeHostProxyProfile(
          applyGroupDefaults(rawHost, groupDefaults, { validProxyProfileIds: proxyProfileIdSet }),
          proxyProfiles,
        );

        const protocol = session.protocol ?? existingHost.protocol;
        const port = session.port ?? existingHost.port;
        const moshEnabled = session.moshEnabled ?? existingHost.moshEnabled;
        const etEnabled = session.etEnabled ?? existingHost.etEnabled;

        if (
          protocol === existingHost.protocol &&
          port === existingHost.port &&
          moshEnabled === existingHost.moshEnabled
          && etEnabled === existingHost.etEnabled
        ) {
          map.set(session.id, existingHost);
        } else {
          map.set(session.id, {
            ...existingHost,
            protocol,
            port,
            moshEnabled,
            etEnabled,
          });
        }
      } else {
        // Create stable fallback host object
        const fallbackProtocol = session.protocol ?? 'local' as const;
        map.set(session.id, {
          id: session.hostId,
          label: session.hostLabel || 'Local Terminal',
          hostname: session.hostname || 'localhost',
          username: session.username || 'local',
          port: session.port ?? 22,
          // Only local terminals adopt the client OS — unsaved serial
          // sessions and orphaned remote sessions (whose host was deleted
          // while the session lives on) also hit this fallback, and the
          // non-local autocomplete path in Terminal.tsx trusts host.os, so
          // a Windows-client 'windows' tag here would mis-shape POSIX
          // remote/serial autocomplete (#1112 review).
          os: fallbackProtocol === 'local'
            ? detectLocalOs(navigator.userAgent || navigator.platform)
            : 'linux',
          group: '',
          tags: [],
          protocol: fallbackProtocol,
          moshEnabled: session.moshEnabled,
          etEnabled: session.etEnabled,
          charset: session.charset,
          localShell: session.localShell,
          localShellArgs: session.localShellArgs,
          localShellName: session.localShellName,
          localShellIcon: session.localShellIcon,
        });
      }
    }
    return map;
  }, [sessions, hostMap, groupConfigs, proxyProfileIdSet, proxyProfiles]);
  const sessionChainHostsMap = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const session of sessions) {
      const host = sessionHostsMap.get(session.id);
      if (!host?.hostChain?.hostIds?.length) continue;
      map.set(
        session.id,
        host.hostChain.hostIds
          .map((hostId) => {
            const rawChainHost = hostMap.get(hostId);
            if (!rawChainHost) return undefined;
            const chainGroupDefaults = rawChainHost.group
              ? resolveGroupDefaults(rawChainHost.group, groupConfigs, { validProxyProfileIds: proxyProfileIdSet })
              : {};
            return materializeHostProxyProfile(
              applyGroupDefaults(rawChainHost, chainGroupDefaults, { validProxyProfileIds: proxyProfileIdSet }),
              proxyProfiles,
            );
          })
          .filter((value): value is Host => Boolean(value)),
      );
    }
    return map;
  }, [sessions, sessionHostsMap, hostMap, groupConfigs, proxyProfileIdSet, proxyProfiles]);
  const sessionHostsMapRef = useRef(sessionHostsMap);
  sessionHostsMapRef.current = sessionHostsMap;

  const handleCommandSubmitted = useCallback((_command: string, _hostId: string, _hostLabel: string, sessionId: string) => {
    const tabId = activeTabIdRef.current;
    if (!sftpFollowTerminalCwdRef.current || !tabId || sidePanelOpenTabsRef.current.get(tabId) !== 'sftp') return;

    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session || !canReuseTerminalConnection(session)) return;

    const revisionAtCommand = terminalCwdRevisionRef.current;
    const probeGeneration = (cwdProbeGenerationRef.current.get(sessionId) ?? 0) + 1;
    cwdProbeGenerationRef.current.set(sessionId, probeGeneration);
    cwdProbeCancelersRef.current.get(sessionId)?.();
    const cancelProbe = scheduleBackendCwdProbeAfterCommand({
      sessionId,
      cwdRevisionAtCommand: revisionAtCommand,
      getCwdRevision: () => terminalCwdRevisionRef.current,
      getSessionPwd: (id) => terminalBackend.getSessionPwd(id),
      canProbe: async () => {
        if (cwdProbeGenerationRef.current.get(sessionId) !== probeGeneration) return false;
        const host = sessionHostsMapRef.current.get(sessionId);
        if (!host) return false;
        const detectedDeviceClass = classifyDistroId(host.distro);
        const isNetworkDevice =
          host.deviceType === 'network' || detectedDeviceClass === 'network-device';
        const info = await terminalBackend.getSessionRemoteInfo?.(sessionId);
        return shouldProbeSessionCwd({
          isNetworkDevice,
          remoteSshVersion: info?.remoteSshVersion,
        });
      },
      onProbedCwd: (cwd) => {
        if (cwdProbeGenerationRef.current.get(sessionId) !== probeGeneration) return;
        const existing = terminalRendererCwdBySessionRef.current.get(sessionId);
        if (existing === cwd) return;
        handleTerminalCwdChange(sessionId, cwd);
      },
    });
    cwdProbeCancelersRef.current.set(sessionId, cancelProbe);
  }, [handleTerminalCwdChange, terminalBackend]);

  const handleCommandExecuted = useCallback((command: string, hostId: string, hostLabel: string, sessionId: string) => {
    onCommandExecuted?.(command, hostId, hostLabel, sessionId);
  }, [onCommandExecuted]);

  useEffect(() => () => {
    for (const cancel of cwdProbeCancelersRef.current.values()) {
      cancel();
    }
    cwdProbeCancelersRef.current.clear();
  }, []);
  const sessionSudoAutofillPasswordsMap = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const session of sessions) {
      const rawHost = hostMap.get(session.hostId);
      if (rawHost) {
        // Resolve through identity references too (host.identityId), not just
        // host.password, so a password stored in a Keychain identity is filled
        // (issue #1284) — same resolution SSH login uses.
        map.set(session.id, resolveHostAutofillPassword({ host: rawHost, keys, identities }));
      }
    }
    return map;
  }, [hostMap, sessions, keys, identities]);

  const handleTerminalFontSizeChange = useCallback((sessionId: string, nextFontSize: number) => {
    const sessionHost = sessionHostsMapRef.current.get(sessionId);
    if (!sessionHost) return;

    const rawHost = hostMapRef.current.get(sessionHost.id);
    const usesGlobalFontSize = sessionHost.protocol === 'local' || sessionHost.id?.startsWith('local-') || !rawHost;
    if (usesGlobalFontSize) {
      onUpdateTerminalFontSize?.(nextFontSize);
      return;
    }

    onUpdateHost({ ...rawHost, fontSize: nextFontSize, fontSizeOverride: true });
  }, [onUpdateHost, onUpdateTerminalFontSize]);

  const validAIScopeTargetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) ids.add(session.id);
    for (const workspace of workspaces) ids.add(workspace.id);
    return ids;
  }, [sessions, workspaces]);

  const validSessionActivityIds = useMemo(() => {
    return getValidSessionActivityIds(sessions);
  }, [sessions]);
  const activityTrackedSessions = useMemo(
    () =>
      sessions.filter(
        (session) => session.status !== 'disconnected',
      ),
    [sessions],
  );

  const onSplitSessionRef = useRef(onSplitSession);
  onSplitSessionRef.current = onSplitSession;
  const splitHorizontalHandlersRef = useRef<Map<string, () => void>>(new Map());
  const splitVerticalHandlersRef = useRef<Map<string, () => void>>(new Map());

  const onToggleWorkspaceViewModeRef = useRef(onToggleWorkspaceViewMode);
  onToggleWorkspaceViewModeRef.current = onToggleWorkspaceViewMode;
  const workspaceFocusHandlersRef = useRef<Map<string, () => void>>(new Map());

  const onToggleBroadcastRef = useRef(onToggleBroadcast);
  onToggleBroadcastRef.current = onToggleBroadcast;
  const workspaceBroadcastHandlersRef = useRef<Map<string, () => void>>(new Map());

  const mountedSftpTabIds = useMemo(
    () => Array.from(sftpHostForTab.keys()),
    [sftpHostForTab],
  );
  const markSidePanelSubTabOpened = useCallback((tabId: string, panel: SidePanelTab) => {
    if (panel === 'ai') {
      setAiMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
      return;
    }
    if (panel === 'scripts') {
      setScriptsMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
      return;
    }
    if (panel === 'theme') {
      setThemeMountedTabIds((prev) => addMountedSidePanelTabId(prev, tabId));
    }
  }, []);

  const getActiveTerminalSessionId = useCallback((): string | null => {
    const activeWorkspace = activeWorkspaceRef.current;
    const activeSession = activeSessionRef.current;
    if (!activeWorkspace) return activeSession?.id ?? null;

    const workspaceSessionIdSet = new Set(collectSessionIds(activeWorkspace.root));
    const focusedId = activeWorkspace.focusedSessionId;
    if (focusedId && workspaceSessionIdSet.has(focusedId) && sessionsRef.current.some((session) => session.id === focusedId)) {
      return focusedId;
    }

    return sessionsRef.current.find((session) => workspaceSessionIdSet.has(session.id))?.id ?? null;
  }, []);

  const syncWorkspaceFocusIfNeeded = useCallback((sessionId: string | null) => {
    const activeWorkspace = activeWorkspaceRef.current;
    if (!activeWorkspace || !sessionId || activeWorkspace.focusedSessionId === sessionId) return;
    onSetWorkspaceFocusedSession?.(activeWorkspace.id, sessionId);
  }, [onSetWorkspaceFocusedSession]);

  // Get the focused terminal's current working directory
  const getTerminalCwd = useCallback(async (options?: { preferFreshBackend?: boolean }): Promise<string | null> => {
    const sessionId = getActiveTerminalSessionId();
    return resolvePreferredTerminalCwd({
      rendererCwd: sessionId ? terminalRendererCwdBySessionRef.current.get(sessionId) : undefined,
      sessionId,
      getSessionPwd: (id) => terminalBackend.getSessionPwd(id),
      preferFreshBackend: options?.preferFreshBackend,
    });
  }, [getActiveTerminalSessionId, terminalBackend]);

  const refocusTerminalSession = useCallback((sessionId?: string | null) => {
    focusTerminalSessionInput(sessionId);
  }, []);

  const refocusActiveTerminalSession = useCallback(() => {
    const sessionId = getActiveTerminalSessionId();
    syncWorkspaceFocusIfNeeded(sessionId);
    refocusTerminalSession(sessionId);
  }, [getActiveTerminalSessionId, refocusTerminalSession, syncWorkspaceFocusIfNeeded]);

  // Close the entire side panel for the current tab
  const handleCloseSidePanel = useCallback(() => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;
    const sessionIdToRefocus = getActiveTerminalSessionId();
    syncWorkspaceFocusIfNeeded(sessionIdToRefocus);
    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      next.delete(activeTabId);
      return next;
    });
    // Always clean up SFTP state (it may be mounted in the background
    // while scripts/theme tab was active)
    setSftpHostForTab(prev => {
      const next = new Map(prev);
      next.delete(activeTabId);
      return next;
    });
    setSftpPendingUploadsForTab(prev => {
      const next = new Map(prev);
      next.delete(activeTabId);
      return next;
    });
    setSftpInitialLocationForTab(prev => {
      const next = new Map(prev);
      next.delete(activeTabId);
      return next;
    });
    setAiMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    setScriptsMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    setThemeMountedTabIds((prev) => removeMountedSidePanelTabId(prev, activeTabId));
    refocusTerminalSession(sessionIdToRefocus);
  }, [getActiveTerminalSessionId, refocusTerminalSession, syncWorkspaceFocusIfNeeded]);

  // Resolve the SFTP host for a tab: a previously-stored host, otherwise the
  // host of the workspace's focused session or the active session. null = none.
  const resolveSftpHostForTab = useCallback((tabId: string): Host | null => {
    const stored = sftpHostForTabRef.current.get(tabId);
    if (stored) return stored;
    const currentWorkspace = activeWorkspaceRef.current;
    const currentFocusedSessionId = focusedSessionIdRef.current;
    const currentActiveSession = activeSessionRef.current;
    const currentSessionHosts = sessionHostsMapRef.current;
    if (currentWorkspace && currentFocusedSessionId) {
      return currentSessionHosts.get(currentFocusedSessionId) ?? null;
    }
    if (currentActiveSession) {
      return currentSessionHosts.get(currentActiveSession.id) ?? null;
    }
    return null;
  }, []);

  // Switch side panel to a specific tab (or toggle if already on that tab)
  const handleSwitchSidePanelTab = useCallback((tab: SidePanelTab) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const currentPanel = sidePanelOpenTabsRef.current.get(tabId);

    // If already on this tab, do nothing — user must click X to close
    if (currentPanel === tab) return;

    // If switching to SFTP and no host is stored yet, resolve it
    if (tab === 'sftp' && !sftpHostForTabRef.current.has(tabId)) {
      const host = resolveSftpHostForTab(tabId);
      if (!host) return;
      setSftpHostForTab(prev => {
        const next = new Map(prev);
        next.set(tabId, host);
        return next;
      });
    }

    // Note: When switching away from SFTP, we keep the SFTP host state
    // so the SftpSidePanel stays mounted (hidden) and preserves connections.
    // SFTP state is only cleaned up when the panel is fully closed.

    markSidePanelSubTabOpened(tabId, tab);
    startTransition(() => {
      setSidePanelOpenTabs(prev => {
        const next = new Map(prev);
        next.set(tabId, tab);
        return next;
      });
    });
  }, [markSidePanelSubTabOpened, resolveSftpHostForTab]);

  // Toggle SFTP from activity bar header
  const handleToggleSftpFromBar = useCallback(() => {
    handleSwitchSidePanelTab('sftp');
  }, [handleSwitchSidePanelTab]);

  // Open scripts side panel (called from Terminal toolbar)
  const handleOpenScripts = useCallback(() => {
    handleSwitchSidePanelTab('scripts');
  }, [handleSwitchSidePanelTab]);

  const handleToggleScriptsSidePanel = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const intent = resolveScriptsSidePanelShortcutIntent(
      sidePanelOpenTabsRef.current.get(tabId) ?? null,
    );

    if (intent.kind === 'closeTerminalSidePanel') {
      handleCloseSidePanel();
      return;
    }

    markSidePanelSubTabOpened(tabId, 'scripts');
    startTransition(() => {
      setSidePanelOpenTabs(prev => {
        const next = new Map(prev);
        next.set(tabId, 'scripts');
        return next;
      });
    });
  }, [handleCloseSidePanel, markSidePanelSubTabOpened]);

  // Toggle the whole side panel (new ⌘/Ctrl+\ shortcut). Close if open; if
  // closed, reopen the tab's last sub-panel, defaulting to SFTP (when a host is
  // available) or scripts.
  const handleToggleSidePanel = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const isOpen = sidePanelOpenTabsRef.current.has(tabId);
    const sftpAvailable = !!resolveSftpHostForTab(tabId);
    const fallbackTab: SidePanelTab = sftpAvailable ? 'sftp' : 'scripts';
    const lastTab = lastSidePanelTabRef.current.get(tabId) ?? null;
    const intent = resolveSidePanelToggleIntent<SidePanelTab>({ isOpen, lastTab, fallbackTab });
    if (intent.kind === 'close') {
      handleCloseSidePanel();
      return;
    }
    // If the remembered panel is SFTP but no host is resolvable, use scripts.
    const target: SidePanelTab = intent.tab === 'sftp' && !sftpAvailable ? 'scripts' : intent.tab;
    handleSwitchSidePanelTab(target);
  }, [handleCloseSidePanel, handleSwitchSidePanelTab, resolveSftpHostForTab]);

  // Open theme side panel (called from Terminal toolbar)
  const handleOpenTheme = useCallback(() => {
    handleSwitchSidePanelTab('theme');
  }, [handleSwitchSidePanelTab]);

  // Open AI chat side panel (side-panel rail button: a plain switch that is a
  // no-op when AI is already the active sub-panel, matching the other rail tabs)
  const handleOpenAI = useCallback(() => {
    handleSwitchSidePanelTab('ai');
  }, [handleSwitchSidePanelTab]);

  const handleAddSelectionToAI = useCallback((sourceSessionId: string, selection: string) => {
    const text = selection.trim();
    if (!text) return;

    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const ws = activeWorkspaceRef.current;
    if (ws && ws.focusedSessionId !== sourceSessionId) {
      onSetWorkspaceFocusedSessionRef.current?.(ws.id, sourceSessionId);
    }

    setPendingTerminalSelectionForAI({
      requestId: crypto.randomUUID(),
      tabId,
      text,
    });
    handleSwitchSidePanelTab('ai');
  }, [handleSwitchSidePanelTab]);

  const handlePendingTerminalSelectionConsumed = useCallback((requestId: string) => {
    setPendingTerminalSelectionForAI((current) => (
      current?.requestId === requestId ? null : current
    ));
  }, []);

  // Toggle the AI chat side panel from the top-bar button: open it (or switch
  // to it from another sub-panel), and close the side panel when AI is already
  // the open sub-panel. Unlike handleOpenAI (the rail switch), a second click
  // here dismisses the panel.
  const handleToggleAiFromTopBar = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const intent = resolveAiSidePanelToggleIntent(
      sidePanelOpenTabsRef.current.get(tabId) ?? null,
    );

    if (intent.kind === 'closeTerminalSidePanel') {
      handleCloseSidePanel();
      return;
    }

    handleSwitchSidePanelTab('ai');
  }, [handleCloseSidePanel, handleSwitchSidePanelTab]);

  // Execute snippet on the focused terminal session
  const handleSnippetClickForFocusedSession = useCallback((command: string, noAutoRun?: boolean) => {
    const sessionId = activeWorkspaceRef.current?.focusedSessionId ?? activeSessionRef.current?.id;
    if (!sessionId) return;
    const executor = snippetExecutorsRef.current.get(sessionId);
    if (executor) {
      executor(command, noAutoRun);
      return;
    }

    let data = normalizeLineEndings(command);
    if (!noAutoRun) data = `${data}\r`;
    terminalBackend.writeToSession(sessionId, data);
    // Re-focus the terminal so the user can interact immediately
    const pane = document.querySelector(`[data-session-id="${sessionId}"]`);
    const textarea = pane?.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
    textarea?.focus();
  }, [terminalBackend]);

  const handleSnippetFromPanel = useCallback(async (snippet: Snippet) => {
    const command = await resolveSnippetCommand(snippet);
    if (command === null) return;
    handleSnippetClickForFocusedSession(command, snippet.noAutoRun);
  }, [handleSnippetClickForFocusedSession]);

  const handleComposeSend = useCallback((text: string) => {
    const activeWorkspace = activeWorkspaceRef.current;
    if (!activeWorkspace) return;
    const payload = text + '\r';
    const broadcastEnabled = isBroadcastEnabled?.(activeWorkspace.id);
    const focusedSessionId = activeWorkspace.focusedSessionId;

    if (broadcastEnabled) {
      const allSessionIds = sessionsRef.current
        .filter((session) => session.workspaceId === activeWorkspace.id)
        .map((session) => session.id);
      for (const sid of allSessionIds) {
        const executor = snippetExecutorsRef.current.get(sid);
        if (executor) {
          executor(text, false, { broadcast: false });
        } else {
          terminalBackend.writeToSession(sid, payload);
        }
      }
    } else {
      const workspaceSessions = sessionsRef.current.filter((session) => session.workspaceId === activeWorkspace.id);
      const validFocusedId = focusedSessionId && workspaceSessions.some((session) => session.id === focusedSessionId)
        ? focusedSessionId
        : undefined;
      const targetId = validFocusedId ?? workspaceSessions[0]?.id;
      if (targetId) {
        const executor = snippetExecutorsRef.current.get(targetId);
        if (executor) {
          executor(text, false);
        } else {
          terminalBackend.writeToSession(targetId, payload);
        }
      }
    }
  }, [isBroadcastEnabled, terminalBackend]);

  const sessionLogConfig = useMemo(
    () =>
      sessionLogsEnabled && sessionLogsDir
        ? { enabled: true as const, directory: sessionLogsDir, format: sessionLogsFormat || 'txt', timestampsEnabled: sessionLogsTimestampsEnabled }
        : undefined,
    [sessionLogsDir, sessionLogsEnabled, sessionLogsFormat, sessionLogsTimestampsEnabled],
  );

  stableRef.current = {
    accentMode,
    activityTrackedSessions,
    AIChatPanelsHost,
    AISidePanelStateRoot,
    AIStateMaintenanceHost,
    AIStateProvider,
    Array,
    Button,
    ChunkedEscapeFilter,
    clearTerminalPreviewVars,
    clearTopTabsPreviewVars,
    FolderTree,
    MessageSquare,
    Palette,
    PanelLeft,
    PanelRight,
    cn,
    collectSessionIds,
    customAccent,
    customGroups,
    draggingSessionId,
    editorWordWrap,
    effectiveHosts,
    filterTabsMap,
    followAppTerminalTheme,
    fontSize,
    getSessionActivityIdsToClear,
    getTerminalCwd,
    handleAddKnownHost,
    handleAddSelectionToAI,
    handleBroadcastInput,
    handleCloseSession,
    handleCloseSidePanel,
    handleCommandExecuted,
    handleCommandSubmitted,
    handleComposeSend,
    handleOpenSftp,
    handleOpenScripts,
    handleOpenTheme,
    handleOpenAI,
    handleOsDetected,
    handlePendingTerminalSelectionConsumed,
    handlePendingUploadHandled,
    handleSessionExit,
    handleSftpInitialLocationApplied,
    persistSidePanelWidth,
    handleSnippetClickForFocusedSession,
    handleSnippetFromPanel,
    handleSnippetExecutorChange,
    handleStatusChange,
    handleTerminalCwdChange,
    handleTerminalDataCapture,
    handleTerminalFontSizeChange,
    handleToggleAiFromTopBar,
    handleToggleScriptsSidePanel,
    handleToggleSidePanel,
    handleToggleSftpFromBar,
    handleToggleWorkspaceComposeBar,
    handleUpdateHost,
    hasNotifiableTerminalOutput,
    hostMap,
    hosts,
    hostsRef,
    hotkeyScheme,
    identities,
    isBroadcastEnabled,
    isComposeBarOpen,
    keyBindings,
    keys,
    knownHosts,
    lastSidePanelTabRef,
    mountedAiTabIds: aiMountedTabIds,
    mountedSftpTabIds,
    scriptsMountedTabIds,
    themeMountedTabIds,
    onAddSessionToWorkspace,
    onConnectToHost,
    onCreateLocalTerminal,
    onCreateWorkspaceFromSessions,
    onHotkeyAction,
    onReorderWorkspaceSessions,
    onRequestAddToWorkspace,
    onSessionData,
    onSetDraggingSessionId,
    onSetWorkspaceFocusedSession,
    onSplitSession,
    onSplitSessionRef,
    onToggleBroadcastRef,
    onToggleWorkspaceViewMode,
    onToggleWorkspaceViewModeRef,
    onUpdateHost,
    onUpdateSplitSizes,
    onUpdateTerminalFontFamilyId,
    onUpdateTerminalFontSize,
    onUpdateTerminalFontWeight,
    onUpdateTerminalThemeId,
    pendingTerminalSelectionForAI,
    refocusActiveTerminalSession,
    refocusTerminalSession,
    resolveSftpHostForTab,
    ScriptsSidePanel,
    sessionActivityStore,
    sessionChainHostsMap,
    sessionHostsMap,
    sessionLogConfig,
    sessionSudoAutofillPasswordsMap,
    sessions,
    sessionsRef,
    setEditorWordWrap,
    setIsComposeBarOpen,
    setPendingTerminalSelectionForAI,
    setAiMountedTabIds,
    setScriptsMountedTabIds,
    setThemeMountedTabIds,
    setSidePanelOpenTabs,
    setSidePanelWidth,
    setSftpFollowTerminalCwd,
    setSftpHostForTab,
    setSftpInitialLocationForTab,
    setSftpPendingUploadsForTab,
    setupMcpApprovalBridge,
    showHostTreeSidebar,
    sidePanelOpenTabs,
    sidePanelPosition,
    sidePanelWidth,
    sftpAutoSync,
    sftpDefaultViewMode,
    sftpDoubleClickBehavior,
    sftpFollowTerminalCwd,
    sftpHostForTab,
    sftpInitialLocationForTab,
    sftpPendingUploadsForTab,
    sftpShowHiddenFiles,
    SftpSidePanel,
    sftpUseCompressedUpload,
    shouldMarkSessionActivity,
    snippetExecutorsRef,
    snippetPackages,
    snippets,
    splitHorizontalHandlersRef,
    splitVerticalHandlersRef,
    sshDebugLogsEnabled,
    t,
    TerminalComposeBar,
    TerminalPanesHost,
    terminalCwdRevision,
    terminalFontFamilyId,
    terminalRendererCwdBySessionRef,
    terminalSettings,
    terminalTheme,
    ThemeSidePanel,
    toggleScriptsSidePanelRef,
    toggleSidePanelRef,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    updateHosts,
    X,
    Zap,
    validAIScopeTargetIds,
    validSessionActivityIds,
    workspaceBroadcastHandlersRef,
    workspaceById,
    workspaceFocusHandlersRef,
    workspaces,
    workspacesRef,
    activeTabIdRef,
    activeWorkspaceRef,
    activeSessionRef,
    focusedSessionIdRef,
    setSidePanelPosition,
  };

  return <TerminalLayerTabBridge stableRef={stableRef} />;
};

export const TerminalLayer = memo(TerminalLayerInner, terminalLayerAreEqual);
TerminalLayer.displayName = 'TerminalLayer';
