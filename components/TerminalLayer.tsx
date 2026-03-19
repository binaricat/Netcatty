import { Circle, FolderTree, LayoutGrid, MessageSquare, PanelLeft, PanelRight, Palette, Server, X, Zap } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTabId } from '../application/state/activeTabStore';
import { useTerminalBackend } from '../application/state/useTerminalBackend';
import { collectSessionIds } from '../domain/workspace';
import { SplitDirection } from '../domain/workspace';
import { KeyBinding, TerminalSettings } from '../domain/models';
import { cn } from '../lib/utils';
import { useStoredString } from '../application/state/useStoredString';
import { buildCacheKey } from '../application/state/sftp/sharedRemoteHostCache';
import type { DropEntry } from '../lib/sftpFileUtils';
import { Host, Identity, KnownHost, SSHKey, Snippet, TerminalSession, TerminalTheme, Workspace, WorkspaceNode } from '../types';
import { DistroAvatar } from './DistroAvatar';
import Terminal from './Terminal';
import { SftpSidePanel } from './SftpSidePanel';
import { ScriptsSidePanel } from './ScriptsSidePanel';
import { ThemeSidePanel } from './terminal/ThemeSidePanel';
import { AIChatSidePanel } from './AIChatSidePanel';
import { useAIState } from '../application/state/useAIState';
import { TerminalComposeBar } from './terminal/TerminalComposeBar';
import { TERMINAL_THEMES } from '../infrastructure/config/terminalThemes';
import { useCustomThemes } from '../application/state/customThemeStore';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';

type SidePanelTab = 'sftp' | 'scripts' | 'theme' | 'ai';

type WorkspaceRect = { x: number; y: number; w: number; h: number };

type SplitHint = {
  direction: 'horizontal' | 'vertical';
  position: 'left' | 'right' | 'top' | 'bottom';
  targetSessionId?: string;
  rect?: { x: number; y: number; w: number; h: number };
} | null;

type ResizerHandle = {
  id: string;
  splitId: string;
  index: number;
  direction: 'vertical' | 'horizontal';
  rect: { x: number; y: number; w: number; h: number };
  splitArea: { w: number; h: number };
};

type PendingSftpUpload = {
  requestId: string;
  hostId: string;
  /** Full connection identity (id:hostname:port:protocol) for session-override awareness */
  connectionKey: string;
  targetPath?: string;
  entries: DropEntry[];
};

const filterTabsMap = <T,>(source: Map<string, T>, validIds: Set<string>): Map<string, T> => {
  let changed = false;
  const next = new Map<string, T>();
  for (const [id, value] of source) {
    if (validIds.has(id)) {
      next.set(id, value);
    } else {
      changed = true;
    }
  }
  return changed ? next : source;
};

interface TerminalLayerProps {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  snippets: Snippet[];
  snippetPackages: string[];
  sessions: TerminalSession[];
  workspaces: Workspace[];
  knownHosts?: KnownHost[];
  draggingSessionId: string | null;
  terminalTheme: TerminalTheme;
  terminalSettings?: TerminalSettings;
  terminalFontFamilyId: string;
  fontSize?: number;
  hotkeyScheme?: 'disabled' | 'mac' | 'pc';
  keyBindings?: KeyBinding[];
  onHotkeyAction?: (action: string, event: KeyboardEvent) => void;
  onUpdateTerminalThemeId?: (themeId: string) => void;
  onUpdateTerminalFontFamilyId?: (fontFamilyId: string) => void;
  onUpdateTerminalFontSize?: (fontSize: number) => void;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onUpdateSessionStatus: (sessionId: string, status: TerminalSession['status']) => void;
  onUpdateHostDistro: (hostId: string, distro: string) => void;
  onUpdateHost: (host: Host) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  onCommandExecuted?: (command: string, hostId: string, hostLabel: string, sessionId: string) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onCreateWorkspaceFromSessions: (baseSessionId: string, joiningSessionId: string, hint: Exclude<SplitHint, null>) => void;
  onAddSessionToWorkspace: (workspaceId: string, sessionId: string, hint: Exclude<SplitHint, null>) => void;
  onUpdateSplitSizes: (workspaceId: string, splitId: string, sizes: number[]) => void;
  onSetDraggingSessionId: (id: string | null) => void;
  onToggleWorkspaceViewMode?: (workspaceId: string) => void;
  onSetWorkspaceFocusedSession?: (workspaceId: string, sessionId: string) => void;
  onSplitSession?: (sessionId: string, direction: SplitDirection) => void;
  // Broadcast mode
  isBroadcastEnabled?: (workspaceId: string) => boolean;
  onToggleBroadcast?: (workspaceId: string) => void;
  // SFTP side panel
  updateHosts: (hosts: Host[]) => void;
  sftpDoubleClickBehavior: 'open' | 'transfer';
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  sftpAutoOpenSidebar: boolean;
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  // Session log settings for real-time streaming
  sessionLogsEnabled?: boolean;
  sessionLogsDir?: string;
  sessionLogsFormat?: string;
}

const TerminalLayerInner: React.FC<TerminalLayerProps> = ({
  hosts,
  keys,
  identities,
  snippets,
  snippetPackages,
  sessions,
  workspaces,
  knownHosts = [],
  draggingSessionId,
  terminalTheme,
  terminalSettings,
  terminalFontFamilyId,
  fontSize = 14,
  hotkeyScheme = 'disabled',
  keyBindings = [],
  onHotkeyAction,
  onUpdateTerminalThemeId,
  onUpdateTerminalFontFamilyId,
  onUpdateTerminalFontSize,
  onCloseSession,
  onUpdateSessionStatus,
  onUpdateHostDistro,
  onUpdateHost,
  onAddKnownHost,
  onCommandExecuted,
  onTerminalDataCapture,
  onCreateWorkspaceFromSessions,
  onAddSessionToWorkspace,
  onUpdateSplitSizes,
  onSetDraggingSessionId,
  onToggleWorkspaceViewMode,
  onSetWorkspaceFocusedSession,
  onSplitSession,
  isBroadcastEnabled,
  onToggleBroadcast,
  updateHosts,
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
}) => {
  // Subscribe to activeTabId from external store
  const activeTabId = useActiveTabId();
  const isVaultActive = activeTabId === 'vault';
  const isSftpActive = activeTabId === 'sftp';
  const isVisible = (!isVaultActive && !isSftpActive) || !!draggingSessionId;

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

  const handleSessionExit = useCallback((sessionId: string, evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => {
    // Auto-close the tab/session when the user actively exited (e.g. typed `exit`)
    // reason === "exited" means the remote process/shell exited normally (stream-level close),
    // as opposed to network errors, timeouts, or connection-level drops
    if (evt.reason === "exited") {
      onCloseSession(sessionId);
    } else {
      onUpdateSessionStatus(sessionId, 'disconnected');
    }
  }, [onUpdateSessionStatus, onCloseSession]);

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

  const [workspaceArea, setWorkspaceArea] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const workspaceOuterRef = useRef<HTMLDivElement>(null);
  const workspaceInnerRef = useRef<HTMLDivElement>(null);
  const workspaceOverlayRef = useRef<HTMLDivElement>(null);
  const [dropHint, setDropHint] = useState<SplitHint>(null);
  const [resizing, setResizing] = useState<{
    workspaceId: string;
    splitId: string;
    index: number;
    direction: 'vertical' | 'horizontal';
    startSizes: number[];
    startArea: { w: number; h: number };
    startClient: { x: number; y: number };
  } | null>(null);

  const activeWorkspace = useMemo(() => workspaces.find(w => w.id === activeTabId), [workspaces, activeTabId]);
  const activeSession = useMemo(() => sessions.find(s => s.id === activeTabId), [sessions, activeTabId]);

  // Handle broadcast input - write to all other sessions in the same workspace
  const handleBroadcastInput = useCallback((data: string, sourceSessionId: string) => {
    if (!activeWorkspace) return;

    // Get all session IDs in this workspace
    const workspaceSessionIds = sessions
      .filter(s => s.workspaceId === activeWorkspace.id && s.id !== sourceSessionId)
      .map(s => s.id);

    // Write to all other sessions
    for (const targetSessionId of workspaceSessionIds) {
      terminalBackend.writeToSession(targetSessionId, data);
    }
  }, [activeWorkspace, sessions, terminalBackend]);

  // Workspace-level compose bar state
  const [isComposeBarOpen, setIsComposeBarOpen] = useState(false);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const onSetWorkspaceFocusedSessionRef = useRef(onSetWorkspaceFocusedSession);
  onSetWorkspaceFocusedSessionRef.current = onSetWorkspaceFocusedSession;

  // Side panel state - per-tab tracking of which sub-panel is active
  // Maps tab IDs to the active sub-panel type (sftp/scripts/theme), absent = closed
  const [sidePanelOpenTabs, setSidePanelOpenTabs] = useState<Map<string, SidePanelTab>>(new Map());
  const [sidePanelWidth, setSidePanelWidth] = useState(() => {
    const stored = window.localStorage.getItem('netcatty_side_panel_width');
    return stored ? Math.max(280, Math.min(800, Number(stored))) : 420;
  });
  const [sidePanelPosition, setSidePanelPosition] = useStoredString<'left' | 'right'>(
    'netcatty_side_panel_position',
    'left',
    (v): v is 'left' | 'right' => v === 'left' || v === 'right',
  );
  const sftpResizingRef = useRef(false);
  const sidePanelOpenTabsRef = useRef(sidePanelOpenTabs);
  sidePanelOpenTabsRef.current = sidePanelOpenTabs;

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

  // Side panel resize handler
  const handleSidePanelResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sftpResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidePanelWidth;

    let lastWidth = startWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      lastWidth = Math.max(280, Math.min(800, startWidth + (sidePanelPosition === 'left' ? delta : -delta)));
      setSidePanelWidth(lastWidth);
    };
    const onMouseUp = () => {
      sftpResizingRef.current = false;
      window.localStorage.setItem('netcatty_side_panel_width', String(lastWidth));
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [sidePanelWidth, sidePanelPosition]);

  // Pre-compute host lookup map for O(1) access
  const hostMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);

  // Pre-compute fallback hosts to avoid creating new objects on every render
  const sessionHostsMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const session of sessions) {
      const existingHost = hostMap.get(session.hostId);
      if (existingHost) {
        // Apply session-time protocol overrides to the host
        const hostWithOverrides: Host = {
          ...existingHost,
          // Use session protocol settings if provided (from connection-time selection)
          protocol: session.protocol ?? existingHost.protocol,
          port: session.port ?? existingHost.port,
          moshEnabled: session.moshEnabled ?? existingHost.moshEnabled,
        };
        map.set(session.id, hostWithOverrides);
      } else {
        // Create stable fallback host object
        map.set(session.id, {
          id: session.hostId,
          label: session.hostLabel || 'Local Terminal',
          hostname: session.hostname || 'localhost',
          username: session.username || 'local',
          port: session.port ?? 22,
          os: 'linux',
          group: '',
          tags: [],
          protocol: session.protocol ?? 'local' as const,
          moshEnabled: session.moshEnabled,
        });
      }
    }
    return map;
  }, [sessions, hostMap]);

  const validTerminalTabIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) ids.add(session.id);
    for (const workspace of workspaces) ids.add(workspace.id);
    return ids;
  }, [sessions, workspaces]);

  const onSplitSessionRef = useRef(onSplitSession);
  onSplitSessionRef.current = onSplitSession;
  const splitHorizontalHandlersRef = useRef<Map<string, () => void>>(new Map());
  const splitVerticalHandlersRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const validSessionIds = new Set(sessions.map((session) => session.id));

    for (const [id] of splitHorizontalHandlersRef.current) {
      if (!validSessionIds.has(id)) {
        splitHorizontalHandlersRef.current.delete(id);
      }
    }
    for (const [id] of splitVerticalHandlersRef.current) {
      if (!validSessionIds.has(id)) {
        splitVerticalHandlersRef.current.delete(id);
      }
    }

    for (const session of sessions) {
      if (!splitHorizontalHandlersRef.current.has(session.id)) {
        splitHorizontalHandlersRef.current.set(session.id, () => {
          onSplitSessionRef.current?.(session.id, 'horizontal');
        });
      }
      if (!splitVerticalHandlersRef.current.has(session.id)) {
        splitVerticalHandlersRef.current.set(session.id, () => {
          onSplitSessionRef.current?.(session.id, 'vertical');
        });
      }
    }
  }, [sessions]);

  const onToggleWorkspaceViewModeRef = useRef(onToggleWorkspaceViewMode);
  onToggleWorkspaceViewModeRef.current = onToggleWorkspaceViewMode;
  const workspaceFocusHandlersRef = useRef<Map<string, () => void>>(new Map());

  const onToggleBroadcastRef = useRef(onToggleBroadcast);
  onToggleBroadcastRef.current = onToggleBroadcast;
  const workspaceBroadcastHandlersRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));

    for (const [id] of workspaceFocusHandlersRef.current) {
      if (!validWorkspaceIds.has(id)) {
        workspaceFocusHandlersRef.current.delete(id);
      }
    }
    for (const [id] of workspaceBroadcastHandlersRef.current) {
      if (!validWorkspaceIds.has(id)) {
        workspaceBroadcastHandlersRef.current.delete(id);
      }
    }

    for (const workspace of workspaces) {
      if (!workspaceFocusHandlersRef.current.has(workspace.id)) {
        workspaceFocusHandlersRef.current.set(workspace.id, () => {
          onToggleWorkspaceViewModeRef.current?.(workspace.id);
        });
      }
      if (!workspaceBroadcastHandlersRef.current.has(workspace.id)) {
        workspaceBroadcastHandlersRef.current.set(workspace.id, () => {
          onToggleBroadcastRef.current?.(workspace.id);
        });
      }
    }
  }, [workspaces]);

  useEffect(() => {
    setSidePanelOpenTabs(prev => filterTabsMap(prev, validTerminalTabIds));
    setSftpHostForTab(prev => filterTabsMap(prev, validTerminalTabIds));
    setSftpInitialLocationForTab(prev => filterTabsMap(prev, validTerminalTabIds));
    setSftpPendingUploadsForTab(prev => filterTabsMap(prev, validTerminalTabIds));
  }, [validTerminalTabIds]);

  const computeWorkspaceRects = useCallback((workspace?: Workspace, size?: { width: number; height: number }): Record<string, WorkspaceRect> => {
    if (!workspace) return {} as Record<string, WorkspaceRect>;
    const wTotal = size?.width || 1;
    const hTotal = size?.height || 1;
    const rects: Record<string, WorkspaceRect> = {};
    const walk = (node: WorkspaceNode, area: WorkspaceRect) => {
      if (node.type === 'pane') {
        rects[node.sessionId] = area;
        return;
      }
      const isVertical = node.direction === 'vertical';
      const sizes = (node.sizes && node.sizes.length === node.children.length ? node.sizes : Array(node.children.length).fill(1));
      const total = sizes.reduce((acc, n) => acc + n, 0) || 1;
      let offset = 0;
      node.children.forEach((child, idx) => {
        const share = sizes[idx] / total;
        const childArea = isVertical
          ? { x: area.x + area.w * offset, y: area.y, w: area.w * share, h: area.h }
          : { x: area.x, y: area.y + area.h * offset, w: area.w, h: area.h * share };
        walk(child, childArea);
        offset += share;
      });
    };
    walk(workspace.root, { x: 0, y: 0, w: wTotal, h: hTotal });
    return rects;
  }, []);

  const activeWorkspaceRects = useMemo<Record<string, WorkspaceRect>>(
    () => computeWorkspaceRects(activeWorkspace, workspaceArea),
    [activeWorkspace, workspaceArea, computeWorkspaceRects]
  );

  useEffect(() => {
    if (!workspaceInnerRef.current) return;
    const el = workspaceInnerRef.current;
    const updateSize = () => setWorkspaceArea({ width: el.clientWidth, height: el.clientHeight });
    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeWorkspace]);

  const collectResizers = useCallback((workspace?: Workspace, size?: { width: number; height: number }): ResizerHandle[] => {
    if (!workspace || !size?.width || !size?.height) return [];
    const resizers: ResizerHandle[] = [];
    const walk = (node: WorkspaceNode, area: { x: number; y: number; w: number; h: number }) => {
      if (node.type === 'pane') return;
      const isVertical = node.direction === 'vertical';
      const sizes = (node.sizes && node.sizes.length === node.children.length ? node.sizes : Array(node.children.length).fill(1));
      const total = sizes.reduce((acc, n) => acc + n, 0) || 1;
      let offset = 0;
      node.children.forEach((child, idx) => {
        const share = sizes[idx] / total;
        const childArea = isVertical
          ? { x: area.x + area.w * offset, y: area.y, w: area.w * share, h: area.h }
          : { x: area.x, y: area.y + area.h * offset, w: area.w, h: area.h * share };
        if (idx < node.children.length - 1) {
          const boundary = isVertical ? childArea.x + childArea.w : childArea.y + childArea.h;
          const rect = isVertical
            ? { x: boundary - 2, y: area.y, w: 4, h: area.h }
            : { x: area.x, y: boundary - 2, w: area.w, h: 4 };
          resizers.push({
            id: `${node.id}-${idx}`,
            splitId: node.id,
            index: idx,
            direction: node.direction,
            rect,
            splitArea: { w: area.w, h: area.h },
          });
        }
        walk(child, childArea);
        offset += share;
      });
    };
    walk(workspace.root, { x: 0, y: 0, w: size.width, h: size.height });
    return resizers;
  }, []);

  const activeResizers = useMemo(() => collectResizers(activeWorkspace, workspaceArea), [activeWorkspace, workspaceArea, collectResizers]);

  const computeSplitHint = (e: React.DragEvent): SplitHint => {
    if (isFocusMode) return null;
    const surface = workspaceOverlayRef.current || workspaceInnerRef.current || workspaceOuterRef.current;
    if (!surface || !workspaceArea.width || !workspaceArea.height) return null;
    const rect = surface.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    if (localX < 0 || localX > rect.width || localY < 0 || localY > rect.height) return null;

    let targetSessionId: string | undefined;
    let targetRect: WorkspaceRect | undefined;
    const workspaceEntries = Object.entries(activeWorkspaceRects) as Array<[string, WorkspaceRect]>;
    workspaceEntries.forEach(([sessionId, area]) => {
      if (targetSessionId) return;
      if (
        localX >= area.x &&
        localX <= area.x + area.w &&
        localY >= area.y &&
        localY <= area.y + area.h
      ) {
        targetSessionId = sessionId;
        targetRect = area;
      }
    });

    const baseRect: WorkspaceRect = targetRect || { x: 0, y: 0, w: rect.width, h: rect.height };
    const relX = (localX - baseRect.x) / baseRect.w;
    const relY = (localY - baseRect.y) / baseRect.h;

    const prefersVertical = Math.abs(relX - 0.5) > Math.abs(relY - 0.5);
    const direction = prefersVertical ? 'vertical' : 'horizontal';
    const position = prefersVertical
      ? (relX < 0.5 ? 'left' : 'right')
      : (relY < 0.5 ? 'top' : 'bottom');

    const previewRect: WorkspaceRect = { ...baseRect };
    if (direction === 'vertical') {
      previewRect.w = baseRect.w / 2;
      previewRect.x = position === 'left' ? baseRect.x : baseRect.x + baseRect.w / 2;
    } else {
      previewRect.h = baseRect.h / 2;
      previewRect.y = position === 'top' ? baseRect.y : baseRect.y + baseRect.h / 2;
    }

    return {
      direction,
      position,
      targetSessionId,
      rect: previewRect,
    };
  };

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const dimension = resizing.direction === 'vertical' ? resizing.startArea.w : resizing.startArea.h;
      if (dimension <= 0) return;
      const total = resizing.startSizes.reduce((acc, n) => acc + n, 0) || 1;
      const pxSizes = resizing.startSizes.map(s => (s / total) * dimension);
      const i = resizing.index;
      const delta = (resizing.direction === 'vertical' ? e.clientX - resizing.startClient.x : e.clientY - resizing.startClient.y);
      let a = pxSizes[i] + delta;
      let b = pxSizes[i + 1] - delta;
      const minPx = Math.min(120, dimension / 2);
      if (a < minPx) {
        const diff = minPx - a;
        a = minPx;
        b -= diff;
      }
      if (b < minPx) {
        const diff = minPx - b;
        b = minPx;
        a -= diff;
      }
      const newPxSizes = [...pxSizes];
      newPxSizes[i] = Math.max(minPx, a);
      newPxSizes[i + 1] = Math.max(minPx, b);
      const totalPx = newPxSizes.reduce((acc, n) => acc + n, 0) || 1;
      const newSizes = newPxSizes.map(n => n / totalPx);
      onUpdateSplitSizes(resizing.workspaceId, resizing.splitId, newSizes);
    };
    const onUp = () => setResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing, onUpdateSplitSizes]);

  const handleWorkspaceDrop = (e: React.DragEvent) => {
    if (isFocusMode) return;
    const draggedSessionId = e.dataTransfer.getData('session-id');
    if (!draggedSessionId) return;
    e.preventDefault();
    const hint = computeSplitHint(e);
    setDropHint(null);
    onSetDraggingSessionId(null);
    if (!hint) return;

    if (activeWorkspace) {
      const draggedSession = sessions.find(s => s.id === draggedSessionId);
      if (!draggedSession || draggedSession.workspaceId) return;
      onAddSessionToWorkspace(activeWorkspace.id, draggedSessionId, hint);
      return;
    }

    if (activeSession) {
      onCreateWorkspaceFromSessions(activeSession.id, draggedSessionId, hint);
    }
  };

  const findSplitNode = (node: WorkspaceNode, splitId: string): WorkspaceNode | null => {
    if (node.type === 'split') {
      if (node.id === splitId) return node;
      for (const child of node.children) {
        const found = findSplitNode(child, splitId);
        if (found) return found;
      }
    }
    return null;
  };

  const isTerminalLayerVisible = isVisible || !!draggingSessionId;

  // Check if active workspace is in focus mode
  const isFocusMode = activeWorkspace?.viewMode === 'focus';
  const focusedSessionId = activeWorkspace?.focusedSessionId;

  // Resolve the SFTP host for the current tab.
  // Uses the stored host from when the user opened SFTP, but updates when
  // the focused session changes in workspace mode.
  const sftpActiveHost = useMemo((): Host | null => {
    if (!isSftpOpenForCurrentTab || !activeTabId) return null;
    // For workspace: follow focus
    if (activeWorkspace && focusedSessionId) {
      return sessionHostsMap.get(focusedSessionId) ?? sftpHostForTab.get(activeTabId) ?? null;
    }
    // For solo session: use stored host (from when SFTP was opened)
    return sftpHostForTab.get(activeTabId) ?? null;
  }, [isSftpOpenForCurrentTab, activeTabId, activeWorkspace, focusedSessionId, sessionHostsMap, sftpHostForTab]);

  // Keep sftpHostForTab in sync with focus changes in workspace mode
  // so that the toggle check uses the currently displayed host.
  useEffect(() => {
    if (!activeTabId || !sftpActiveHost) return;
    if (sidePanelOpenTabs.get(activeTabId) !== 'sftp') return;
    const stored = sftpHostForTab.get(activeTabId);
    if (stored?.id === sftpActiveHost.id
      && stored?.hostname === sftpActiveHost.hostname
      && stored?.port === sftpActiveHost.port
      && stored?.protocol === sftpActiveHost.protocol) return;
    setSftpHostForTab(prev => {
      const next = new Map(prev);
      next.set(activeTabId, sftpActiveHost);
      return next;
    });
  }, [activeTabId, sftpActiveHost, sidePanelOpenTabs, sftpHostForTab]);

  const mountedSftpTabIds = useMemo(
    () => Array.from(sftpHostForTab.keys()),
    [sftpHostForTab],
  );

  // Get the focused terminal's current working directory
  const getTerminalCwd = useCallback(async (): Promise<string | null> => {
    const sessionId = activeWorkspace?.focusedSessionId ?? activeSession?.id;
    if (!sessionId) return null;
    try {
      const result = await terminalBackend.getSessionPwd(sessionId);
      return result.success && result.cwd ? result.cwd : null;
    } catch {
      return null;
    }
  }, [activeWorkspace?.focusedSessionId, activeSession?.id, terminalBackend]);

  // Close the entire side panel for the current tab
  const handleCloseSidePanel = useCallback(() => {
    if (!activeTabId) return;
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
  }, [activeTabId]);

  // Switch side panel to a specific tab (or toggle if already on that tab)
  const handleSwitchSidePanelTab = useCallback((tab: SidePanelTab) => {
    if (!activeTabId) return;
    const currentPanel = sidePanelOpenTabsRef.current.get(activeTabId);

    // If already on this tab, do nothing — user must click X to close
    if (currentPanel === tab) return;

    // If switching to SFTP and no host is stored yet, resolve it
    if (tab === 'sftp' && !sftpHostForTabRef.current.has(activeTabId)) {
      let host: Host | null = null;
      if (activeWorkspace && focusedSessionId) {
        host = sessionHostsMap.get(focusedSessionId) ?? null;
      } else if (activeSession) {
        host = sessionHostsMap.get(activeSession.id) ?? null;
      }
      if (!host) return;
      setSftpHostForTab(prev => {
        const next = new Map(prev);
        next.set(activeTabId, host);
        return next;
      });
    }

    // Note: When switching away from SFTP, we keep the SFTP host state
    // so the SftpSidePanel stays mounted (hidden) and preserves connections.
    // SFTP state is only cleaned up when the panel is fully closed.

    setSidePanelOpenTabs(prev => {
      const next = new Map(prev);
      next.set(activeTabId, tab);
      return next;
    });
  }, [activeTabId, activeWorkspace, focusedSessionId, activeSession, sessionHostsMap]);

  // Toggle SFTP from activity bar header
  const handleToggleSftpFromBar = useCallback(() => {
    handleSwitchSidePanelTab('sftp');
  }, [handleSwitchSidePanelTab]);

  // Open scripts side panel (called from Terminal toolbar)
  const handleOpenScripts = useCallback(() => {
    handleSwitchSidePanelTab('scripts');
  }, [handleSwitchSidePanelTab]);

  // Open theme side panel (called from Terminal toolbar)
  const handleOpenTheme = useCallback(() => {
    handleSwitchSidePanelTab('theme');
  }, [handleSwitchSidePanelTab]);

  // Open AI chat side panel
  const handleOpenAI = useCallback(() => {
    handleSwitchSidePanelTab('ai');
  }, [handleSwitchSidePanelTab]);

  // Listen for global AI panel toggle (from TopTabs button)
  useEffect(() => {
    const handler = () => handleOpenAI();
    window.addEventListener('netcatty:toggle-ai-panel', handler);
    return () => window.removeEventListener('netcatty:toggle-ai-panel', handler);
  }, [handleOpenAI]);

  // Execute snippet on the focused terminal session
  const handleSnippetClickForFocusedSession = useCallback((command: string, noAutoRun?: boolean) => {
    const sessionId = activeWorkspace?.focusedSessionId ?? activeSession?.id;
    if (!sessionId) return;
    const payload = noAutoRun ? command : `${command}\r`;
    terminalBackend.writeToSession(sessionId, payload);
    // Re-focus the terminal so the user can interact immediately
    const pane = document.querySelector(`[data-session-id="${sessionId}"]`);
    const textarea = pane?.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
    textarea?.focus();
  }, [activeWorkspace?.focusedSessionId, activeSession?.id, terminalBackend]);

  // Resolve theme change handler for the focused session
  const focusedHost = useMemo((): Host | null => {
    if (activeWorkspace && focusedSessionId) {
      return sessionHostsMap.get(focusedSessionId) ?? null;
    }
    if (activeSession) {
      return sessionHostsMap.get(activeSession.id) ?? null;
    }
    return null;
  }, [activeWorkspace, focusedSessionId, activeSession, sessionHostsMap]);

  const isFocusedHostLocal = useMemo(() => {
    return focusedHost?.protocol === 'local' || !!focusedHost?.id?.startsWith('local-');
  }, [focusedHost]);

  const handleThemeChangeForFocusedSession = useCallback((themeId: string) => {
    if (isFocusedHostLocal) {
      onUpdateTerminalThemeId?.(themeId);
      return;
    }
    if (focusedHost) {
      onUpdateHost({ ...focusedHost, theme: themeId });
    }
  }, [focusedHost, isFocusedHostLocal, onUpdateTerminalThemeId, onUpdateHost]);

  const handleFontFamilyChangeForFocusedSession = useCallback((fontFamilyId: string) => {
    if (isFocusedHostLocal) {
      onUpdateTerminalFontFamilyId?.(fontFamilyId);
      return;
    }
    if (focusedHost) {
      onUpdateHost({ ...focusedHost, fontFamily: fontFamilyId });
    }
  }, [focusedHost, isFocusedHostLocal, onUpdateTerminalFontFamilyId, onUpdateHost]);

  const handleFontSizeChangeForFocusedSession = useCallback((newFontSize: number) => {
    if (isFocusedHostLocal) {
      onUpdateTerminalFontSize?.(newFontSize);
      return;
    }
    if (focusedHost) {
      onUpdateHost({ ...focusedHost, fontSize: newFontSize });
    }
  }, [focusedHost, isFocusedHostLocal, onUpdateTerminalFontSize, onUpdateHost]);

  // Current theme/font/size for the focused session (for ThemeSidePanel)
  const focusedThemeId = focusedHost?.theme ?? terminalTheme.id;
  const focusedFontFamilyId = focusedHost?.fontFamily ?? terminalFontFamilyId;
  const focusedFontSize = focusedHost?.fontSize ?? fontSize;

  // AI Chat state
  const aiState = useAIState();
  const { cleanupOrphanedSessions } = aiState;

  useEffect(() => {
    const activeIds = new Set<string>();
    for (const s of sessions) activeIds.add(s.id);
    for (const w of workspaces) activeIds.add(w.id);
    cleanupOrphanedSessions(activeIds);
  }, [sessions, workspaces, cleanupOrphanedSessions]);

  // Build terminal session context for the AI chat panel
  const aiTerminalSessions = useMemo(() => {
    const sessionIds = activeWorkspace?.root
      ? collectSessionIds(activeWorkspace.root)
      : activeSession ? [activeSession.id] : [];

    const result = sessionIds.map(sid => {
      const s = sessions.find(s => s.id === sid);
      const host = s?.hostId ? hosts.find(h => h.id === s.hostId) : undefined;
      return {
        sessionId: sid,
        hostId: s?.hostId || '',
        hostname: host?.hostname || '',
        label: host?.label || s?.hostLabel || '',
        os: host?.os,
        username: host?.username,
        connected: s?.status === 'connected',
      };
    });
    return result;
  }, [sessions, hosts, activeWorkspace, activeSession]);

  const resolveAIExecutorContext = useCallback((scope: {
    type: 'terminal' | 'workspace';
    targetId?: string;
    label?: string;
  }) => {
    const latestWorkspaces = workspacesRef.current;
    const latestSessions = sessionsRef.current;
    const latestHosts = hostsRef.current;
    const sessionIds = scope.type === 'workspace'
      ? (() => {
          const workspace = scope.targetId ? latestWorkspaces.find((w) => w.id === scope.targetId) : undefined;
          return workspace?.root ? collectSessionIds(workspace.root) : [];
        })()
      : scope.targetId ? [scope.targetId] : [];

    const workspaceName = scope.type === 'workspace'
      ? latestWorkspaces.find((w) => w.id === scope.targetId)?.title ?? scope.label
      : undefined;

    return {
      sessions: sessionIds.map((sid) => {
        const session = latestSessions.find((s) => s.id === sid);
        const host = session?.hostId ? latestHosts.find((h) => h.id === session.hostId) : undefined;
        return {
          sessionId: sid,
          hostId: session?.hostId || '',
          hostname: host?.hostname || '',
          label: host?.label || session?.hostLabel || '',
          os: host?.os,
          username: host?.username,
          connected: session?.status === 'connected',
        };
      }),
      workspaceId: scope.type === 'workspace' ? scope.targetId : undefined,
      workspaceName,
    };
  }, []);

  // Subscribe to custom theme changes so editing triggers re-render
  const customThemes = useCustomThemes();

  // Resolve the effective theme for the compose bar in workspace mode
  const composeBarThemeColors = useMemo(() => {
    if (!activeWorkspace || !focusedSessionId) return terminalTheme.colors;
    const focusedHost = sessionHostsMap.get(focusedSessionId);
    if (focusedHost?.theme) {
      const hostTheme = TERMINAL_THEMES.find(t => t.id === focusedHost.theme)
        || customThemes.find(t => t.id === focusedHost.theme);
      if (hostTheme) return hostTheme.colors;
    }
    return terminalTheme.colors;
  }, [activeWorkspace, focusedSessionId, sessionHostsMap, terminalTheme, customThemes]);

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

  useEffect(() => {
    if (isFocusMode && dropHint) {
      setDropHint(null);
    }
  }, [isFocusMode, dropHint]);

  // Track previous focusedSessionId to detect changes
  const prevFocusedSessionIdRef = useRef<string | undefined>(undefined);

  // When focusedSessionId changes in split view, focus the corresponding terminal
  useEffect(() => {
    // Only handle split view mode (not focus mode)
    if (isFocusMode || !focusedSessionId || !activeWorkspace) return;

    // Only trigger when focusedSessionId actually changes
    if (prevFocusedSessionIdRef.current === focusedSessionId) return;
    const prevFocusedId = prevFocusedSessionIdRef.current;
    prevFocusedSessionIdRef.current = focusedSessionId;

    // First, blur the currently focused terminal immediately
    if (prevFocusedId) {
      const prevPane = document.querySelector(`[data-session-id="${prevFocusedId}"]`);
      if (prevPane) {
        const prevTextarea = prevPane.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (prevTextarea) {
          prevTextarea.blur();
        }
      }
    }

    // Focus the new terminal multiple times to fight against xterm's focus restoration
    const focusTarget = () => {
      const targetPane = document.querySelector(`[data-session-id="${focusedSessionId}"]`);
      if (targetPane) {
        const textarea = targetPane.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (textarea) {
          textarea.focus();
        }
      }
    };

    // Focus immediately
    focusTarget();

    // Focus again after short delays to override any competing focus attempts
    const timer1 = setTimeout(focusTarget, 10);
    const timer2 = setTimeout(focusTarget, 50);
    const timer3 = setTimeout(focusTarget, 100);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, [focusedSessionId, isFocusMode, activeWorkspace]);

  // Get sessions for the active workspace in focus mode
  const workspaceSessionIds = useMemo(() => {
    if (!activeWorkspace) return [];
    return collectSessionIds(activeWorkspace.root);
  }, [activeWorkspace]);

  const workspaceSessions = useMemo(() => {
    return sessions.filter(s => workspaceSessionIds.includes(s.id));
  }, [sessions, workspaceSessionIds]);

  // Render focus mode sidebar
  const renderFocusModeSidebar = () => {
    if (!activeWorkspace || !isFocusMode) return null;

    return (
      <div className="w-56 flex-shrink-0 bg-secondary/50 border-r border-border/50 flex flex-col">
        {/* Header with view toggle */}
        <div className="h-10 flex items-center justify-between px-3 border-b border-border/50">
          <span className="text-xs font-medium text-muted-foreground">
            Terminals · {workspaceSessions.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onToggleWorkspaceViewMode?.(activeWorkspace.id)}
            title="Switch to Split View"
          >
            <LayoutGrid size={14} />
          </Button>
        </div>

        {/* Session list */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {workspaceSessions.map(session => {
              const host = sessionHostsMap.get(session.id);
              const isSelected = session.id === focusedSessionId;
              const statusColor = session.status === 'connected'
                ? 'text-emerald-500'
                : session.status === 'connecting'
                  ? 'text-amber-500'
                  : 'text-red-500';

              return (
                <div
                  key={session.id}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
                    isSelected
                      ? "bg-primary/15 border border-primary/30"
                      : "hover:bg-secondary/80 border border-transparent"
                  )}
                  onClick={() => onSetWorkspaceFocusedSession?.(activeWorkspace.id, session.id)}
                >
                  <div className="relative">
                    {host ? (
                      <DistroAvatar host={host} fallback={session.hostLabel} size="sm" />
                    ) : (
                      <Server size={16} className="text-muted-foreground" />
                    )}
                    <Circle
                      size={6}
                      className={cn("absolute -bottom-0.5 -right-0.5 fill-current", statusColor)}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{session.hostLabel}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {session.username}@{session.hostname}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    );
  };

  return (
    <div
      ref={workspaceOuterRef}
      className="absolute inset-0 bg-background flex flex-col"
      style={{ display: isTerminalLayerVisible ? 'flex' : 'none', zIndex: isTerminalLayerVisible ? 10 : 0 }}
    >
      <div className={cn("flex-1 flex min-h-0 relative", sidePanelPosition === 'right' && "flex-row-reverse")}>
        {/* Side panel with tab header + content (SFTP / Scripts / Theme) */}
        {(isSidePanelOpenForCurrentTab || mountedSftpTabIds.length > 0) && (
          <>
            <div
              style={{ width: isSidePanelOpenForCurrentTab ? sidePanelWidth : 0 }}
              className={cn(
                "flex-shrink-0 h-full relative z-20",
              )}
            >
              {isSidePanelOpenForCurrentTab && (
                <div
                  className={cn(
                    "absolute top-0 h-full w-2 cursor-ew-resize z-30",
                    sidePanelPosition === 'left' ? "right-[-3px]" : "left-[-3px]",
                  )}
                  onMouseDown={handleSidePanelResizeStart}
                />
              )}
              <div
                className={cn(
                  "h-full flex flex-col overflow-hidden",
                  !isSidePanelOpenForCurrentTab && "pointer-events-none",
                )}
              >
                {isSidePanelOpenForCurrentTab && (
                  <div className="flex h-9 items-center px-1.5 py-1 flex-shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 rounded-md p-0",
                        activeSidePanelTab === 'sftp'
                          ? "text-foreground opacity-100"
                          : "text-muted-foreground opacity-70 hover:opacity-100",
                        "hover:bg-transparent",
                      )}
                      onClick={handleToggleSftpFromBar}
                      title="SFTP"
                    >
                      <FolderTree size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 rounded-md p-0",
                        activeSidePanelTab === 'scripts'
                          ? "text-foreground opacity-100"
                          : "text-muted-foreground opacity-70 hover:opacity-100",
                        "hover:bg-transparent",
                      )}
                      onClick={handleOpenScripts}
                      title="Scripts"
                    >
                      <Zap size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 rounded-md p-0",
                        activeSidePanelTab === 'theme'
                          ? "text-foreground opacity-100"
                          : "text-muted-foreground opacity-70 hover:opacity-100",
                        "hover:bg-transparent",
                      )}
                      onClick={handleOpenTheme}
                      title="Theme"
                    >
                      <Palette size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 rounded-md p-0",
                        activeSidePanelTab === 'ai'
                          ? "text-foreground opacity-100"
                          : "text-muted-foreground opacity-70 hover:opacity-100",
                        "hover:bg-transparent",
                      )}
                      onClick={handleOpenAI}
                      title="AI Chat"
                    >
                      <MessageSquare size={15} />
                    </Button>
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 rounded-md p-0 text-muted-foreground",
                        "hover:bg-transparent hover:text-foreground",
                      )}
                      onClick={() => setSidePanelPosition(p => p === 'left' ? 'right' : 'left')}
                      title={sidePanelPosition === 'left' ? 'Move panel to right' : 'Move panel to left'}
                    >
                      {sidePanelPosition === 'left' ? <PanelRight size={15} /> : <PanelLeft size={15} />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 rounded-md p-0 text-muted-foreground",
                        "hover:bg-transparent hover:text-foreground",
                      )}
                      onClick={handleCloseSidePanel}
                      title="Close panel"
                    >
                      <X size={15} />
                    </Button>
                  </div>
                )}
                <div className="flex-1 min-h-0 relative">
                  {/* SFTP sub-panel */}
                  {mountedSftpTabIds.map((tabId) => {
                    const isVisibleSftpPanel = activeTabId === tabId && activeSidePanelTab === 'sftp';
                    return (
                        <SftpSidePanel
                          key={tabId}
                          hosts={hosts}
                          keys={keys}
                          identities={identities}
                          updateHosts={updateHosts}
                          activeHost={isVisibleSftpPanel ? sftpActiveHost : null}
                          initialLocation={
                            isVisibleSftpPanel
                              ? (sftpInitialLocationForTab.get(tabId) ?? null)
                              : null
                          }
                          showWorkspaceHostHeader={isVisibleSftpPanel && !!activeWorkspace}
                          isVisible={isVisibleSftpPanel}
                          renderOverlays={isVisibleSftpPanel}
                          pendingUpload={sftpPendingUploadsForTab.get(tabId) ?? null}
                          onPendingUploadHandled={(requestId) => handlePendingUploadHandled(tabId, requestId)}
                          sftpDoubleClickBehavior={sftpDoubleClickBehavior}
                          sftpAutoSync={isVisibleSftpPanel ? sftpAutoSync : false}
                          sftpShowHiddenFiles={sftpShowHiddenFiles}
                          sftpUseCompressedUpload={sftpUseCompressedUpload}
                          editorWordWrap={editorWordWrap}
                          setEditorWordWrap={setEditorWordWrap}
                          onGetTerminalCwd={getTerminalCwd}
                        />
                    );
                  })}

                  {/* Scripts sub-panel */}
                  {activeSidePanelTab === 'scripts' && (
                    <div className="absolute inset-0 z-10">
                      <ScriptsSidePanel
                        snippets={snippets}
                        packages={snippetPackages}
                        onSnippetClick={handleSnippetClickForFocusedSession}
                      />
                    </div>
                  )}

                  {/* Theme sub-panel */}
                  {activeSidePanelTab === 'theme' && (
                    <div className="absolute inset-0 z-10">
                      <ThemeSidePanel
                        currentThemeId={focusedThemeId}
                        currentFontFamilyId={focusedFontFamilyId}
                        currentFontSize={focusedFontSize}
                        onThemeChange={handleThemeChangeForFocusedSession}
                        onFontFamilyChange={handleFontFamilyChangeForFocusedSession}
                        onFontSizeChange={handleFontSizeChangeForFocusedSession}
                      />
                    </div>
                  )}

                  {/* AI Chat sub-panel */}
                  {activeSidePanelTab === 'ai' && (
                    <div className="absolute inset-0 z-10">
                      <AIChatSidePanel
                        sessions={aiState.sessions}
                        activeSessionIdMap={aiState.activeSessionIdMap}
                        setActiveSessionId={aiState.setActiveSessionId}
                        createSession={aiState.createSession}
                        deleteSession={aiState.deleteSession}
                        updateSessionTitle={aiState.updateSessionTitle}
                        updateSessionExternalSessionId={aiState.updateSessionExternalSessionId}
                        addMessageToSession={aiState.addMessageToSession}
                        updateLastMessage={aiState.updateLastMessage}
                        updateMessageById={aiState.updateMessageById}
                        providers={aiState.providers}
                        activeProviderId={aiState.activeProviderId}
                        activeModelId={aiState.activeModelId}
                        defaultAgentId={aiState.defaultAgentId}
                        externalAgents={aiState.externalAgents}
                        setExternalAgents={aiState.setExternalAgents}
                        agentModelMap={aiState.agentModelMap}
                        setAgentModel={aiState.setAgentModel}
                        globalPermissionMode={aiState.globalPermissionMode}
                        setGlobalPermissionMode={aiState.setGlobalPermissionMode}
                        commandBlocklist={aiState.commandBlocklist}
                        maxIterations={aiState.maxIterations}
                        webSearchConfig={aiState.webSearchConfig}
                        scopeType={activeWorkspace ? 'workspace' : 'terminal'}
                        scopeTargetId={activeWorkspace?.id ?? activeSession?.id}
                        scopeHostIds={activeWorkspace?.root
                          ? collectSessionIds(activeWorkspace.root).map(sid => {
                              const s = sessions.find(s => s.id === sid);
                              return s?.hostId;
                            }).filter((id): id is string => !!id)
                          : activeSession?.hostId ? [activeSession.hostId] : []
                        }
                        scopeLabel={activeWorkspace?.title ?? activeSession?.hostLabel ?? ''}
                        terminalSessions={aiTerminalSessions}
                        resolveExecutorContext={resolveAIExecutorContext}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Focus mode sidebar */}
        {isFocusMode && renderFocusModeSidebar()}

        <div ref={workspaceInnerRef} className="overflow-hidden relative flex-1">
          {draggingSessionId && !isFocusMode && (
            <div
              ref={workspaceOverlayRef}
              className="absolute inset-0 z-30"
              onDragOver={(e) => {
                if (isFocusMode) return;
                if (!e.dataTransfer.types.includes('session-id')) return;
                e.preventDefault();
                e.stopPropagation();
                const hint = computeSplitHint(e);
                setDropHint(hint);
              }}
              onDragLeave={(e) => {
                if (!e.dataTransfer.types.includes('session-id')) return;
                setDropHint(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleWorkspaceDrop(e);
              }}
            >
              {dropHint && (
                <div className="absolute inset-0 pointer-events-none">
                  <div
                    className="absolute bg-emerald-600/35 border border-emerald-400/70 backdrop-blur-sm transition-all duration-150"
                    style={{
                      width: dropHint.rect ? `${dropHint.rect.w}px` : dropHint.direction === 'vertical' ? '50%' : '100%',
                      height: dropHint.rect ? `${dropHint.rect.h}px` : dropHint.direction === 'vertical' ? '100%' : '50%',
                      left: dropHint.rect ? `${dropHint.rect.x}px` : dropHint.direction === 'vertical' ? (dropHint.position === 'left' ? 0 : '50%') : 0,
                      top: dropHint.rect ? `${dropHint.rect.y}px` : dropHint.direction === 'vertical' ? 0 : (dropHint.position === 'top' ? 0 : '50%'),
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {sessions.map(session => {
            // Use pre-computed host to avoid creating new objects on every render
            const host = sessionHostsMap.get(session.id)!;
            const inActiveWorkspace = !!activeWorkspace && session.workspaceId === activeWorkspace.id;
            const isActiveSolo = activeTabId === session.id && !activeWorkspace && isTerminalLayerVisible;

            // In focus mode, only the focused session is visible
            const isFocusedInWorkspace = isFocusMode && inActiveWorkspace && session.id === focusedSessionId;
            const isSplitViewVisible = !isFocusMode && inActiveWorkspace;

            const isVisible = ((isFocusedInWorkspace || isSplitViewVisible || isActiveSolo) && isTerminalLayerVisible);

            // In focus mode, use full area; in split mode, use computed rects
            const rect = (isSplitViewVisible && !isFocusMode) ? activeWorkspaceRects[session.id] : null;

            const layoutStyle = rect
              ? {
                left: `${rect.x}px`,
                top: `${rect.y}px`,
                width: `${rect.w}px`,
                height: `${rect.h}px`,
              }
              : { left: 0, top: 0, width: '100%', height: '100%' };

            const style: React.CSSProperties = { ...layoutStyle };

            if (!isVisible) {
              style.display = 'none';
            }

            // Check if this pane is the focused one in the workspace
            const isFocusedPane = inActiveWorkspace && !isFocusMode && session.id === focusedSessionId;
            const workspaceFocusHandler = activeWorkspace
              ? workspaceFocusHandlersRef.current.get(activeWorkspace.id)
              : undefined;
            const workspaceBroadcastHandler = activeWorkspace
              ? workspaceBroadcastHandlersRef.current.get(activeWorkspace.id)
              : undefined;
            const splitHorizontalHandler = splitHorizontalHandlersRef.current.get(session.id);
            const splitVerticalHandler = splitVerticalHandlersRef.current.get(session.id);

            return (
              <div
                key={session.id}
                data-session-id={session.id}
                className={cn(
                  "absolute bg-background",
                  inActiveWorkspace && "workspace-pane",
                  isVisible && "z-10",
                  isFocusedPane && "ring-1 ring-primary/50 ring-inset"
                )}
                style={style}
                tabIndex={-1}
                onClick={() => {
                  // Set focused session when clicking on a pane in split view
                  if (inActiveWorkspace && !isFocusMode && activeWorkspace) {
                    onSetWorkspaceFocusedSession?.(activeWorkspace.id, session.id);
                  }
                }}
              >
                <Terminal
                  host={host}
                  keys={keys}
                  identities={identities}
                  snippets={snippets}
                  allHosts={hosts}
                  knownHosts={knownHosts}
                  isVisible={isVisible}
                  inWorkspace={inActiveWorkspace}
                  isResizing={!!resizing}
                  isFocusMode={isFocusMode}
                  isFocused={isFocusedPane}
                  fontFamilyId={terminalFontFamilyId}
                  fontSize={fontSize}
                  terminalTheme={terminalTheme}
                  terminalSettings={terminalSettings}
                  sessionId={session.id}
                  startupCommand={session.startupCommand}
                  noAutoRun={session.noAutoRun}
                  serialConfig={session.serialConfig}
                  hotkeyScheme={hotkeyScheme}
                  keyBindings={keyBindings}
                  onHotkeyAction={onHotkeyAction}
                  onOpenSftp={handleOpenSftp}
                  onOpenScripts={handleOpenScripts}
                  onOpenTheme={handleOpenTheme}
                  onCloseSession={handleCloseSession}
                  onStatusChange={handleStatusChange}
                  onSessionExit={handleSessionExit}
                  onTerminalDataCapture={handleTerminalDataCapture}
                  onOsDetected={handleOsDetected}
                  onUpdateHost={handleUpdateHost}
                  onAddKnownHost={handleAddKnownHost}
                  onCommandExecuted={handleCommandExecuted}
                  onExpandToFocus={inActiveWorkspace && !isFocusMode ? workspaceFocusHandler : undefined}
                  onSplitHorizontal={onSplitSession ? splitHorizontalHandler : undefined}
                  onSplitVertical={onSplitSession ? splitVerticalHandler : undefined}
                  isBroadcastEnabled={inActiveWorkspace && activeWorkspace ? isBroadcastEnabled?.(activeWorkspace.id) : false}
                  onToggleBroadcast={inActiveWorkspace ? workspaceBroadcastHandler : undefined}
                  onToggleComposeBar={inActiveWorkspace ? handleToggleWorkspaceComposeBar : undefined}
                  isWorkspaceComposeBarOpen={inActiveWorkspace ? isComposeBarOpen : undefined}
                  onBroadcastInput={inActiveWorkspace && activeWorkspace && isBroadcastEnabled?.(activeWorkspace.id) ? handleBroadcastInput : undefined}
                  sessionLog={sessionLogsEnabled && sessionLogsDir ? { enabled: true, directory: sessionLogsDir, format: sessionLogsFormat || 'txt' } : undefined}
                />
              </div>
            );
          })}
          {/* Only show resizers in split view mode, not in focus mode */}
          {!isFocusMode && activeResizers.map(handle => {
            const isVertical = handle.direction === 'vertical';
            // Expand hit area perpendicular to the split line, but stay within bounds
            // Vertical split (left-right): expand horizontally, keep vertical bounds
            // Horizontal split (top-bottom): expand vertically, keep horizontal bounds
            const left = isVertical ? handle.rect.x - 3 : handle.rect.x;
            const top = isVertical ? handle.rect.y : handle.rect.y - 3;
            const width = isVertical ? handle.rect.w + 6 : handle.rect.w;
            const height = isVertical ? handle.rect.h : handle.rect.h + 6;

            return (
              <div
                key={handle.id}
                className={cn("absolute group", isVertical ? "cursor-ew-resize" : "cursor-ns-resize")}
                style={{
                  left: `${left}px`,
                  top: `${top}px`,
                  width: `${width}px`,
                  height: `${height}px`,
                  zIndex: 25,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const ws = activeWorkspace;
                  if (!ws) return;
                  const split = findSplitNode(ws.root, handle.splitId);
                  const childCount = split && split.type === 'split' ? split.children.length : 0;
                  const sizes = split && split.type === 'split' && split.sizes && split.sizes.length === childCount
                    ? split.sizes
                    : Array(childCount).fill(1);
                  setResizing({
                    workspaceId: ws.id,
                    splitId: handle.splitId,
                    index: handle.index,
                    direction: handle.direction,
                    startSizes: sizes.length ? sizes : [1, 1],
                    startArea: handle.splitArea,
                    startClient: { x: e.clientX, y: e.clientY },
                  });
                }}
              >
                <div
                  className={cn(
                    "absolute bg-border/70 group-hover:bg-primary/60 transition-colors",
                    isVertical ? "w-px h-full left-1/2 -translate-x-1/2" : "h-px w-full top-1/2 -translate-y-1/2"
                  )}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Global compose bar for workspace mode */}
      {activeWorkspace && isComposeBarOpen && (
        <TerminalComposeBar
          onSend={handleComposeSend}
          onClose={() => {
            setIsComposeBarOpen(false);
            // Refocus the terminal pane (matching solo-session behavior)
            if (focusedSessionId) {
              requestAnimationFrame(() => {
                const pane = document.querySelector(`[data-session-id="${focusedSessionId}"]`);
                const textarea = pane?.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
                textarea?.focus();
              });
            }
          }}
          isBroadcastEnabled={isBroadcastEnabled?.(activeWorkspace.id)}
          themeColors={composeBarThemeColors}
        />
      )}
    </div>
  );
};

// Only re-render when data props change - activeTabId/isVisible are now managed internally via store subscription
const terminalLayerAreEqual = (prev: TerminalLayerProps, next: TerminalLayerProps): boolean => {
  return (
    prev.hosts === next.hosts &&
    prev.keys === next.keys &&
    prev.snippets === next.snippets &&
    prev.snippetPackages === next.snippetPackages &&
    prev.sessions === next.sessions &&
    prev.workspaces === next.workspaces &&
    prev.draggingSessionId === next.draggingSessionId &&
    prev.terminalTheme === next.terminalTheme &&
    prev.terminalSettings === next.terminalSettings &&
    prev.fontSize === next.fontSize &&
    prev.hotkeyScheme === next.hotkeyScheme &&
    prev.keyBindings === next.keyBindings &&
    prev.sftpDoubleClickBehavior === next.sftpDoubleClickBehavior &&
    prev.sftpAutoSync === next.sftpAutoSync &&
    prev.sftpShowHiddenFiles === next.sftpShowHiddenFiles &&
    prev.sftpUseCompressedUpload === next.sftpUseCompressedUpload &&
    prev.sftpAutoOpenSidebar === next.sftpAutoOpenSidebar &&
    prev.editorWordWrap === next.editorWordWrap &&
    prev.setEditorWordWrap === next.setEditorWordWrap &&
    prev.onHotkeyAction === next.onHotkeyAction &&
    prev.onUpdateHost === next.onUpdateHost &&
    prev.onToggleWorkspaceViewMode === next.onToggleWorkspaceViewMode &&
    prev.onSetWorkspaceFocusedSession === next.onSetWorkspaceFocusedSession &&
    prev.onSplitSession === next.onSplitSession &&
    prev.identities === next.identities
  );
};

export const TerminalLayer = memo(TerminalLayerInner, terminalLayerAreEqual);
TerminalLayer.displayName = 'TerminalLayer';
