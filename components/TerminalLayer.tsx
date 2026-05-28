import { FolderTree, MessageSquare, PanelLeft, PanelRight, Palette, X, Zap } from 'lucide-react';
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useActiveTabId } from '../application/state/activeTabStore';
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
import { Host, KnownHost, TerminalSession } from '../types';
import { resolveGroupDefaults, applyGroupDefaults } from '../domain/groupConfig';
import { materializeHostProxyProfile } from '../domain/proxyProfiles';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useI18n } from '../application/i18n/I18nProvider';
import { SftpSidePanel } from './SftpSidePanel';
import { ScriptsSidePanel } from './ScriptsSidePanel';
import { ThemeSidePanel } from './terminal/ThemeSidePanel';
import { focusTerminalSessionInput } from './terminal/focusTerminalSession';
import { TerminalComposeBar } from './terminal/TerminalComposeBar';
import { Button } from './ui/button';
import { setupMcpApprovalBridge } from '../infrastructure/ai/shared/approvalGate';
import { resolveScriptsSidePanelShortcutIntent } from '../application/state/resolveSnippetsShortcutIntent';
import { resolveSidePanelToggleIntent } from '../application/state/resolveSidePanelToggleIntent';
import { terminalLayerAreEqual } from './terminalLayerMemo';
import { useTerminalLayerEffects } from './terminalLayer/useTerminalLayerEffects';
import { TerminalLayerView } from './terminalLayer/TerminalLayerView';
import { useTerminalFocusSidebar } from './terminalLayer/useTerminalFocusSidebar';
import { useTerminalWorkspaceLayout } from './terminalLayer/useTerminalWorkspaceLayout';
import { useTerminalThemePanelState } from './terminalLayer/useTerminalThemePanelState';
import { useTerminalAiContexts } from './terminalLayer/useTerminalAiContexts';
import { resolvePreferredTerminalCwd } from './terminal/sftpCwd';

import {
  AIChatPanelsHost,
  AIStateMaintenanceHost,
  AIStateProvider,
  ChunkedEscapeFilter,
  TerminalPanesHost,
  clearTerminalPreviewVars,
  clearTopTabsPreviewVars,
  filterTabsMap,
  hasNotifiableTerminalOutput,
  type PendingSftpUpload,
  type SidePanelTab,
  type SnippetExecutor,
  type TerminalLayerProps,
} from './terminalLayer/TerminalLayerSupport';

const TerminalLayerInner: React.FC<TerminalLayerProps> = ({
  hosts,
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
  isBroadcastEnabled,
  onToggleBroadcast,
  updateHosts,
  sftpDefaultViewMode,
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
  toggleScriptsSidePanelRef,
  toggleSidePanelRef,
}) => {
  const { t } = useI18n();
  // Subscribe to activeTabId from external store
  const activeTabId = useActiveTabId();
  const isVaultActive = activeTabId === 'vault';
  const isSftpActive = activeTabId === 'sftp';
  const isVisible = (!isVaultActive && !isSftpActive) || !!draggingSessionId;
  const terminalRendererCwdBySessionRef = useRef<Map<string, string>>(new Map());

  const handleTerminalCwdChange = useCallback((sessionId: string, cwd: string | null) => {
    if (cwd && cwd.trim().length > 0) {
      terminalRendererCwdBySessionRef.current.set(sessionId, cwd);
    } else {
      terminalRendererCwdBySessionRef.current.delete(sessionId);
    }
  }, []);

  // Stable callback references for Terminal components
  const handleCloseSession = useCallback((sessionId: string) => {
    onCloseSession(sessionId);
  }, [onCloseSession]);

  const sftpAutoOpenSidebarRef = useRef(sftpAutoOpenSidebar);
  sftpAutoOpenSidebarRef.current = sftpAutoOpenSidebar;

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

  const handleCommandExecuted = useCallback((command: string, hostId: string, hostLabel: string, sessionId: string) => {
    onCommandExecuted?.(command, hostId, hostLabel, sessionId);
  }, [onCommandExecuted]);

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
  const activeWorkspace = useMemo(() => activeTabId ? workspaceById.get(activeTabId) : undefined, [workspaceById, activeTabId]);
  const activeSession = useMemo(() => sessions.find(s => s.id === activeTabId), [sessions, activeTabId]);
  const isFocusMode = activeWorkspace?.viewMode === 'focus';

  const {
    activeResizers,
    computeSplitHint,
    dropHint,
    findSplitNode,
    handleWorkspaceDrop,
    resizing,
    setDropHint,
    setResizing,
    setWorkspaceArea,
    workspaceInnerRef,
    workspaceOuterRef,
    workspaceOverlayRef,
    workspaceRectsById,
  } = useTerminalWorkspaceLayout({
    activeSession,
    activeWorkspace,
    isFocusMode,
    onAddSessionToWorkspace,
    onCreateWorkspaceFromSessions,
    onSetDraggingSessionId,
    sessions,
    workspaces,
  });

  // Workspace-level compose bar state
  const [isComposeBarOpen, setIsComposeBarOpen] = useState(false);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
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
  const [sidePanelWidth, setSidePanelWidth, persistSidePanelWidth] = useStoredNumber(
    STORAGE_KEY_SIDE_PANEL_WIDTH, 420, { min: 280, max: 800 },
  );
  const [sidePanelPosition, setSidePanelPosition] = useStoredString<'left' | 'right'>(
    'netcatty_side_panel_position',
    'left',
    (v): v is 'left' | 'right' => v === 'left' || v === 'right',
  );
  const sftpResizingRef = useRef(false);
  const sidePanelOpenTabsRef = useRef(sidePanelOpenTabs);
  sidePanelOpenTabsRef.current = sidePanelOpenTabs;

  // Remember the last sub-panel shown per tab so the toggle shortcut can
  // restore it after a close. Overwritten on open, never cleared on close.
  const lastSidePanelTabRef = useRef<Map<string, SidePanelTab>>(new Map());

  // Whether side panel is open for the currently active tab and which sub-panel
  const isSidePanelOpenForCurrentTab = activeTabId ? sidePanelOpenTabs.has(activeTabId) : false;
  const activeSidePanelTab = activeTabId ? sidePanelOpenTabs.get(activeTabId) ?? null : null;
  // Legacy compatibility helpers for SFTP-specific logic
  const isSftpOpenForCurrentTab = activeSidePanelTab === 'sftp';

  // The host to pass to the SFTP panel - stored when the user opens SFTP
  const [sftpHostForTab, setSftpHostForTab] = useState<Map<string, Host>>(new Map());
  const [sftpInitialLocationForTab, setSftpInitialLocationForTab] = useState<
    Map<string, { hostId: string; path: string }>
  >(new Map());
  const [sftpPendingUploadsForTab, setSftpPendingUploadsForTab] = useState<
    Map<string, PendingSftpUpload>
  >(new Map());
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

  // Side panel resize handler
  const handleSidePanelResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sftpResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidePanelWidth;

    let lastWidth = startWidth;
    let rafId: number | null = null;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      lastWidth = Math.max(280, Math.min(800, startWidth + (sidePanelPosition === 'left' ? delta : -delta)));
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setSidePanelWidth(lastWidth);
      });
    };
    const onMouseUp = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      setSidePanelWidth(lastWidth);
      sftpResizingRef.current = false;
      persistSidePanelWidth(lastWidth);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [sidePanelWidth, sidePanelPosition, setSidePanelWidth, persistSidePanelWidth]);

  // Pre-compute host lookup map for O(1) access
  const hostMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);
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

        if (
          protocol === existingHost.protocol &&
          port === existingHost.port &&
          moshEnabled === existingHost.moshEnabled
        ) {
          map.set(session.id, existingHost);
        } else {
          map.set(session.id, {
            ...existingHost,
            protocol,
            port,
            moshEnabled,
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

  const isTerminalLayerVisible = isVisible || !!draggingSessionId;

  const focusedSessionId = activeWorkspace?.focusedSessionId;
  const focusedSessionIdRef = useRef(focusedSessionId);
  focusedSessionIdRef.current = focusedSessionId;

  // Resolve the SFTP host for the current tab.
  // Uses the stored host from when the user opened SFTP, but updates when
  // the focused session changes in workspace mode.
  const sftpActiveHost = useMemo((): Host | null => {
    if (!isSftpOpenForCurrentTab || !activeTabId) return null;
    // For workspace: follow focus
    if (activeWorkspace && focusedSessionId) {
      return sessionHostsMap.get(focusedSessionId) ?? sftpHostForTab.get(activeTabId) ?? null;
    }
    if (activeSession) {
      return sessionHostsMap.get(activeSession.id) ?? sftpHostForTab.get(activeTabId) ?? null;
    }
    return sftpHostForTab.get(activeTabId) ?? null;
  }, [isSftpOpenForCurrentTab, activeTabId, activeWorkspace, activeSession, focusedSessionId, sessionHostsMap, sftpHostForTab]);

  const mountedSftpTabIds = useMemo(
    () => Array.from(sftpHostForTab.keys()),
    [sftpHostForTab],
  );
  const mountedAiTabIds = useMemo(
    () =>
      Array.from(sidePanelOpenTabs.entries())
        .filter(([, panel]) => panel === 'ai')
        .map(([tabId]) => tabId),
    [sidePanelOpenTabs],
  );

  const getActiveTerminalSessionId = useCallback((): string | null => {
    if (!activeWorkspace) return activeSession?.id ?? null;

    const workspaceSessionIdSet = new Set(collectSessionIds(activeWorkspace.root));
    const focusedSessionId = activeWorkspace.focusedSessionId;
    if (focusedSessionId && workspaceSessionIdSet.has(focusedSessionId) && sessions.some((session) => session.id === focusedSessionId)) {
      return focusedSessionId;
    }

    return sessions.find((session) => workspaceSessionIdSet.has(session.id))?.id ?? null;
  }, [activeWorkspace, activeSession?.id, sessions]);

  const syncWorkspaceFocusIfNeeded = useCallback((sessionId: string | null) => {
    if (!activeWorkspace || !sessionId || activeWorkspace.focusedSessionId === sessionId) return;
    onSetWorkspaceFocusedSession?.(activeWorkspace.id, sessionId);
  }, [activeWorkspace, onSetWorkspaceFocusedSession]);

  // Get the focused terminal's current working directory
  const getTerminalCwd = useCallback(async (): Promise<string | null> => {
    const sessionId = getActiveTerminalSessionId();
    return resolvePreferredTerminalCwd({
      rendererCwd: sessionId ? terminalRendererCwdBySessionRef.current.get(sessionId) : undefined,
      sessionId,
      getSessionPwd: (id) => terminalBackend.getSessionPwd(id),
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
    refocusTerminalSession(sessionIdToRefocus);
  }, [activeTabId, getActiveTerminalSessionId, refocusTerminalSession, syncWorkspaceFocusIfNeeded]);

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

    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      next.set(tabId, tab);
      return next;
    });
  }, [resolveSftpHostForTab]);

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

    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      next.set(tabId, 'scripts');
      return next;
    });
  }, [handleCloseSidePanel]);

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

  // Open AI chat side panel
  const handleOpenAI = useCallback(() => {
    handleSwitchSidePanelTab('ai');
  }, [handleSwitchSidePanelTab]);

  // Execute snippet on the focused terminal session
  const handleSnippetClickForFocusedSession = useCallback((command: string, noAutoRun?: boolean) => {
    const sessionId = activeWorkspace?.focusedSessionId ?? activeSession?.id;
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
  }, [activeWorkspace?.focusedSessionId, activeSession?.id, terminalBackend]);
  const {
    activeTopTabsThemeId,
    appliedPreviewSessionRef,
    applyTerminalPreviewVars,
    applyTopTabsPreviewVars,
    composeBarThemeColors,
    focusedFontFamilyId,
    focusedFontFamilyOverridden,
    focusedFontSize,
    focusedFontSizeOverridden,
    focusedFontWeight,
    focusedFontWeightOverridden,
    focusedThemeOverridden,
    handleFontFamilyChangeForFocusedSession,
    handleFontFamilyResetForFocusedSession,
    handleFontSizeChangeForFocusedSession,
    handleFontSizeResetForFocusedSession,
    handleFontWeightChangeForFocusedSession,
    handleFontWeightResetForFocusedSession,
    handleThemeChangeForFocusedSession,
    handleThemeResetForFocusedSession,
    previewedOrVisibleThemeId,
    previewTargetSessionId,
    resolvedPreviewTheme,
    setThemePreview,
    themeCommitTimerRef,
    themePreview,
    visibleFocusedThemeId,
  } = useTerminalThemePanelState({
    accentMode,
    activeSession,
    activeSidePanelTab,
    activeWorkspace,
    customAccent,
    followAppTerminalTheme,
    focusedSessionId,
    fontSize,
    hostMap,
    isVisible,
    onUpdateHost,
    onUpdateTerminalFontFamilyId,
    onUpdateTerminalFontSize,
    onUpdateTerminalFontWeight,
    onUpdateTerminalThemeId,
    sessionHostsMap,
    terminalFontFamilyId,
    terminalSettings,
    terminalTheme,
  });
  const { aiContextsByTabId, resolveAIExecutorContext } = useTerminalAiContexts({
    hostsRef,
    mountedAiTabIds,
    sessionHostsMap,
    sessions,
    sessionsRef,
    workspaces,
    workspacesRef,
  });

  const sessionLogConfig = useMemo(
    () =>
      sessionLogsEnabled && sessionLogsDir
        ? { enabled: true as const, directory: sessionLogsDir, format: sessionLogsFormat || 'txt' }
        : undefined,
    [sessionLogsDir, sessionLogsEnabled, sessionLogsFormat],
  );
  const { renderFocusModeSidebar } = useTerminalFocusSidebar({
    activeWorkspace,
    focusedSessionId,
    isFocusMode,
    onReorderWorkspaceSessions,
    onRequestAddToWorkspace,
    onSetWorkspaceFocusedSession,
    onToggleWorkspaceViewMode,
    resolvedPreviewTheme,
    sessionHostsMap,
    sessions,
    t,
  });


  // Handle compose bar send for workspace mode
  const handleComposeSend = useCallback((text: string) => {
    if (!activeWorkspace) return;
    const payload = text + '\r';
    const broadcastEnabled = isBroadcastEnabled?.(activeWorkspace.id);

    if (broadcastEnabled) {
      // Send to all sessions in the workspace
      const allSessionIds = sessions
        .filter(s => s.workspaceId === activeWorkspace.id)
        .map(s => s.id);
      for (const sid of allSessionIds) {
        terminalBackend.writeToSession(sid, payload);
      }
    } else {
      // Validate focusedSessionId is a live session, then fallback to first available
      const workspaceSessions = sessions.filter(s => s.workspaceId === activeWorkspace.id);
      const validFocusedId = focusedSessionId && workspaceSessions.some(s => s.id === focusedSessionId)
        ? focusedSessionId
        : undefined;
      const targetId = validFocusedId ?? workspaceSessions[0]?.id;
      if (targetId) {
        terminalBackend.writeToSession(targetId, payload);
      }
    }
  }, [activeWorkspace, focusedSessionId, sessions, terminalBackend, isBroadcastEnabled]);

  // Track previous focusedSessionId to detect changes
  const prevFocusedSessionIdRef = useRef<string | undefined>(undefined);

  useTerminalLayerEffects({ activeSidePanelTab, activeTabId, activeTabIdRef, activeTopTabsThemeId, activeWorkspace, activityTrackedSessions, appliedPreviewSessionRef, applyTerminalPreviewVars, applyTopTabsPreviewVars, cancelAnimationFrame, ChunkedEscapeFilter, clearTerminalPreviewVars, clearTimeout, clearTopTabsPreviewVars, document, dropHint, filterTabsMap, focusedSessionId, followAppTerminalTheme, getSessionActivityIdsToClear, handleOpenAI, handleToggleScriptsSidePanel, handleToggleSidePanel, hasNotifiableTerminalOutput, isFocusMode, isTerminalLayerVisible, lastSidePanelTabRef, Map, Math, onSessionData, onSplitSessionRef, onToggleBroadcastRef, onToggleWorkspaceViewModeRef, onUpdateSplitSizes, prevFocusedSessionIdRef, previewTargetSessionId, requestAnimationFrame, ResizeObserver, resizing, sessionActivityStore, sessions, Set, setDropHint, setResizing, setSftpHostForTab, setSftpInitialLocationForTab, setSftpPendingUploadsForTab, setSidePanelOpenTabs, setThemePreview, setTimeout, setupMcpApprovalBridge, setWorkspaceArea, sftpActiveHost, sftpHostForTab, shouldMarkSessionActivity, sidePanelOpenTabs, splitHorizontalHandlersRef, splitVerticalHandlersRef, terminalRendererCwdBySessionRef, themeCommitTimerRef, themePreview, toggleScriptsSidePanelRef, toggleSidePanelRef, validAIScopeTargetIds, validSessionActivityIds, visibleFocusedThemeId, window, workspaceBroadcastHandlersRef, workspaceFocusHandlersRef, workspaceInnerRef, workspaces });
  return <TerminalLayerView ctx={{ accentMode, activeResizers, activeSidePanelTab, activeTabId, activeWorkspace, AIChatPanelsHost, aiContextsByTabId, AIStateMaintenanceHost, AIStateProvider, Array, Button, cn, composeBarThemeColors, computeSplitHint, customAccent, draggingSessionId, dropHint, editorWordWrap, effectiveHosts, findSplitNode, focusedFontFamilyId, focusedFontFamilyOverridden, focusedFontSize, focusedFontSizeOverridden, focusedFontWeight, focusedFontWeightOverridden, focusedSessionId, focusedThemeOverridden, FolderTree, followAppTerminalTheme, fontSize, getTerminalCwd, handleAddKnownHost, handleBroadcastInput, handleCloseSession, handleCloseSidePanel, handleCommandExecuted, handleComposeSend, handleFontFamilyChangeForFocusedSession, handleFontFamilyResetForFocusedSession, handleFontSizeChangeForFocusedSession, handleFontSizeResetForFocusedSession, handleFontWeightChangeForFocusedSession, handleFontWeightResetForFocusedSession, handleOpenAI, handleOpenScripts, handleOpenSftp, handleOpenTheme, handleOsDetected, handlePendingUploadHandled, handleSessionExit, handleSftpInitialLocationApplied, handleSidePanelResizeStart, handleSnippetClickForFocusedSession, handleSnippetExecutorChange, handleStatusChange, handleTerminalCwdChange, handleTerminalDataCapture, handleThemeChangeForFocusedSession, handleThemeResetForFocusedSession, handleToggleSftpFromBar, handleToggleWorkspaceComposeBar, handleUpdateHost, handleWorkspaceDrop, hosts, hotkeyScheme, identities, isBroadcastEnabled, isComposeBarOpen, isFocusMode, isSidePanelOpenForCurrentTab, isTerminalLayerVisible, keyBindings, keys, knownHosts, MessageSquare, mountedAiTabIds, mountedSftpTabIds, onHotkeyAction, onSetWorkspaceFocusedSession, onSplitSession, Palette, PanelLeft, PanelRight, previewedOrVisibleThemeId, refocusActiveTerminalSession, refocusTerminalSession, renderFocusModeSidebar, resizing, resolveAIExecutorContext, resolvedPreviewTheme, ScriptsSidePanel, sessionChainHostsMap, sessionHostsMap, sessionLogConfig, sessions, setDropHint, setEditorWordWrap, setIsComposeBarOpen, setResizing, setSidePanelPosition, sftpActiveHost, sftpAutoSync, sftpDefaultViewMode, sftpDoubleClickBehavior, sftpInitialLocationForTab, sftpPendingUploadsForTab, sftpShowHiddenFiles, SftpSidePanel, sftpUseCompressedUpload, sidePanelPosition, sidePanelWidth, snippetPackages, snippets, splitHorizontalHandlersRef, splitVerticalHandlersRef, t, TerminalComposeBar, terminalFontFamilyId, TerminalPanesHost, terminalSettings, terminalTheme, themePreview, ThemeSidePanel, Tooltip, TooltipContent, TooltipTrigger, updateHosts, validAIScopeTargetIds, workspaceBroadcastHandlersRef, workspaceById, workspaceFocusHandlersRef, workspaceInnerRef, workspaceOuterRef, workspaceOverlayRef, workspaceRectsById, X, Zap }} />;
};

export const TerminalLayer = memo(TerminalLayerInner, terminalLayerAreEqual);
TerminalLayer.displayName = 'TerminalLayer';
