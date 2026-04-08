import { Bell, Copy, FileText, Folder, FolderLock, LayoutGrid, Minus, Moon, MoreHorizontal, Plus, Server, Sparkles, Square, Sun, TerminalSquare, Usb, X } from 'lucide-react';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeTabStore, useActiveTabId } from '../application/state/activeTabStore';
import { buildWorkspaceActivityMap } from '../application/state/sessionActivity';
import { useSessionActivityMap } from '../application/state/sessionActivityStore';
import { LogView } from '../application/state/useSessionState';
import { useWindowControls } from '../application/state/useWindowControls';
import { useI18n } from '../application/i18n/I18nProvider';
import { getEffectiveHostDistro } from '../domain/host';
import { cn } from '../lib/utils';
import { Host, TerminalSession, Workspace } from '../types';
import { DISTRO_LOGOS, DISTRO_COLORS } from './DistroAvatar';
import { getShellIconPath, isMonochromeShellIcon } from '../lib/useDiscoveredShells';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { SyncStatusButton } from './SyncStatusButton';

// Helper styles for Electron drag regions (use type assertion to include non-standard WebkitAppRegion)
const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const dragRegionNoSelect = { WebkitAppRegion: 'drag', userSelect: 'none' } as React.CSSProperties;

interface TopTabsProps {
  theme: 'dark' | 'light';
  hosts: Host[];
  sessions: TerminalSession[];
  orphanSessions: TerminalSession[];
  workspaces: Workspace[];
  logViews: LogView[];
  orderedTabs: string[];
  draggingSessionId: string | null;
  isMacClient: boolean;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onRenameSession: (sessionId: string) => void;
  onCopySession: (sessionId: string) => void;
  onRenameWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onCloseLogView: (logViewId: string) => void;
  onOpenQuickSwitcher: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onSyncNow?: () => Promise<void>;
  isImmersiveActive?: boolean;
  onStartSessionDrag: (sessionId: string) => void;
  onEndSessionDrag: () => void;
  onReorderTabs: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
}

// Detect local OS for local terminal tab icons
const localOsId = (() => {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux';
})();

// Lightweight OS/distro icon for session tabs — matches DistroAvatar "sm" style
const SessionTabIcon: React.FC<{ host: Host | undefined; isActive: boolean; protocol?: string; shellIcon?: string }> = memo(({ host, isActive, protocol, shellIcon }) => {
  const boxBase = "shrink-0 h-4 w-4 rounded flex items-center justify-center";
  const iconSize = "h-2.5 w-2.5";
  const fallbackStyle = { color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' };

  // Serial protocol → USB icon
  if (protocol === 'serial' || host?.protocol === 'serial') {
    return (
      <div className={cn(boxBase, "bg-amber-500/15 text-amber-500")}>
        <Usb className={iconSize} />
      </div>
    );
  }

  // Local protocol → shell-specific icon if available, else OS-specific icon
  if (protocol === 'local' || host?.protocol === 'local' || (!protocol && !host)) {
    // Use shell icon from discovery when available
    const iconId = shellIcon || host?.localShellIcon;
    if (iconId) {
      return (
        <img
          src={getShellIconPath(iconId)}
          alt={iconId}
          className={cn("shrink-0 h-4 w-4 object-contain", isMonochromeShellIcon(iconId) && "dark:invert")}
        />
      );
    }
    const logo = DISTRO_LOGOS[localOsId];
    const bg = DISTRO_COLORS[localOsId] || DISTRO_COLORS.default;
    if (logo) {
      return (
        <div className={cn(boxBase, bg)}>
          <img
            src={logo}
            alt={localOsId}
            className={cn(iconSize, "object-contain invert brightness-0")}
          />
        </div>
      );
    }
    return (
      <div className={boxBase} style={{ backgroundColor: 'color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 15%, transparent)', color: 'var(--top-tabs-accent, hsl(var(--accent)))' }}>
        <TerminalSquare className={iconSize} />
      </div>
    );
  }

  // Try distro logo with brand background color
  if (host) {
    const distro = getEffectiveHostDistro(host);
    const logo = DISTRO_LOGOS[distro];
    if (logo) {
      const bg = DISTRO_COLORS[distro] || DISTRO_COLORS.default;
      return (
        <div className={cn(boxBase, bg)}>
          <img
            src={logo}
            alt={distro || host.os}
            className={cn(iconSize, "object-contain invert brightness-0")}
          />
        </div>
      );
    }
  }

  // Fallback: generic server icon for remote, terminal for unknown
  if (host && host.protocol !== 'local') {
    return (
      <div className={boxBase} style={{ backgroundColor: 'color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 15%, transparent)', color: 'var(--top-tabs-accent, hsl(var(--accent)))' }}>
        <Server className={iconSize} />
      </div>
    );
  }
  return <TerminalSquare className={iconSize} style={fallbackStyle} />;
});
SessionTabIcon.displayName = 'SessionTabIcon';

const sessionStatusDot = (status: TerminalSession['status'], hasActivity: boolean) => {
  const tone = status === 'connected'
    ? "bg-emerald-400"
    : status === 'connecting'
      ? "bg-amber-400"
      : "bg-rose-500";
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center">
      <span
        className={cn(
          "relative inline-block h-2 w-2 rounded-full ring-2",
          tone,
          hasActivity && "session-activity-dot",
        )}
        style={{ boxShadow: '0 0 0 2px color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 60%, transparent)' }}
      />
    </span>
  );
};

// Custom window controls for Windows/Linux (frameless window)
const WindowControls: React.FC = memo(() => {
  const { minimize, maximize, close, isMaximized: fetchIsMaximized } = useWindowControls();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // Check initial maximized state
    fetchIsMaximized().then(v => setIsMaximized(!!v));

    // Listen for window resize to update maximized state (debounced to avoid IPC storm)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fetchIsMaximized().then(v => setIsMaximized(!!v));
      }, 200);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, [fetchIsMaximized]);

  const handleMinimize = () => {
    minimize();
  };

  const handleMaximize = async () => {
    const result = await maximize();
    setIsMaximized(!!result);
  };

  const handleClose = () => {
    close();
  };

  return (
    <div className="flex items-center app-drag h-full">
      <button
        onClick={handleMinimize}
        className="h-full w-10 flex items-center justify-center transition-all duration-150 app-no-drag"
        style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
        title="Minimize"
      >
        <Minus size={16} />
      </button>
      <button
        onClick={handleMaximize}
        className="h-full w-10 flex items-center justify-center transition-all duration-150 app-no-drag"
        style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
        title={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? (
          // Restore icon (two overlapping squares)
          <Copy size={14} />
        ) : (
          // Maximize icon (single square)
          <Square size={14} />
        )}
      </button>
      <button
        onClick={handleClose}
        className="h-full w-10 flex items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-all duration-150 app-no-drag"
        title="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
});
WindowControls.displayName = 'WindowControls';

const TopTabsInner: React.FC<TopTabsProps> = ({
  theme,
  hosts,
  sessions,
  orphanSessions,
  workspaces,
  logViews,
  orderedTabs,
  draggingSessionId,
  isMacClient,
  onCloseSession,
  onRenameSession,
  onCopySession,
  onRenameWorkspace,
  onCloseWorkspace,
  onCloseLogView,
  onOpenQuickSwitcher,
  onToggleTheme,
  onOpenSettings,
  onSyncNow,
  isImmersiveActive,
  onStartSessionDrag,
  onEndSessionDrag,
  onReorderTabs,
}) => {
  const { t } = useI18n();
  // Subscribe to activeTabId from external store
  const { maximize, isFullscreen, onFullscreenChanged } = useWindowControls();
  const activeTabId = useActiveTabId();
  const sessionActivityMap = useSessionActivityMap();
  const isVaultActive = activeTabId === 'vault';
  const isSftpActive = activeTabId === 'sftp';
  const onSelectTab = activeTabStore.setActiveTabId;

  // Tab reorder drag state
  const [dropIndicator, setDropIndicator] = useState<{ tabId: string; position: 'before' | 'after' } | null>(null);
  const [isDraggingForReorder, setIsDraggingForReorder] = useState(false);
  const draggedTabIdRef = useRef<string | null>(null);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);

  useEffect(() => {
    if (!isMacClient) return;
    let cancelled = false;
    isFullscreen().then((value) => {
      if (!cancelled) setIsWindowFullscreen(!!value);
    });
    const unsubscribe = onFullscreenChanged((value) => setIsWindowFullscreen(!!value));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isFullscreen, isMacClient, onFullscreenChanged]);

  // Refs for scrollable tab container
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);

  // Check scroll state
  const updateScrollState = useCallback(() => {
    const container = tabsContainerRef.current;
    if (container) {
      const hasScroll = container.scrollWidth > container.clientWidth;
      setHasOverflow(hasScroll);
      setCanScrollLeft(container.scrollLeft > 0);
      setCanScrollRight(container.scrollLeft < container.scrollWidth - container.clientWidth - 1);
    }
  }, []);

  // Update scroll state on mount and resize
  useEffect(() => {
    updateScrollState();
    const container = tabsContainerRef.current;
    if (container) {
      container.addEventListener('scroll', updateScrollState);
      const resizeObserver = new ResizeObserver(updateScrollState);
      resizeObserver.observe(container);
      return () => {
        container.removeEventListener('scroll', updateScrollState);
        resizeObserver.disconnect();
      };
    }
  }, [updateScrollState, orderedTabs]);

  // Scroll to active tab when it changes
  useLayoutEffect(() => {
    if (!activeTabId || activeTabId === 'vault' || activeTabId === 'sftp') return;
    const container = tabsContainerRef.current;
    if (!container) return;

    // Find the active tab element
    const activeTabElement = container.querySelector(`[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    if (activeTabElement) {
      const containerRect = container.getBoundingClientRect();
      const tabRect = activeTabElement.getBoundingClientRect();

      // Check if tab is outside visible area
      if (tabRect.left < containerRect.left) {
        container.scrollLeft -= (containerRect.left - tabRect.left + 8);
      } else if (tabRect.right > containerRect.right) {
        container.scrollLeft += (tabRect.right - containerRect.right + 8);
      }
    }
    // Update scroll indicators after scroll
    setTimeout(updateScrollState, 100);
  }, [activeTabId, updateScrollState]);

  // Pre-compute lookup maps for O(1) access instead of O(n) find operations
  const orphanSessionMap = useMemo(() => {
    const map = new Map<string, TerminalSession>();
    for (const s of orphanSessions) map.set(s.id, s);
    return map;
  }, [orphanSessions]);

  const workspaceMap = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const w of workspaces) map.set(w.id, w);
    return map;
  }, [workspaces]);

  const logViewMap = useMemo(() => {
    const map = new Map<string, LogView>();
    for (const lv of logViews) map.set(lv.id, lv);
    return map;
  }, [logViews]);

  const hostMap = useMemo(() => {
    const map = new Map<string, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);

  const workspaceActivityMap = useMemo(() => {
    return buildWorkspaceActivityMap(sessions, sessionActivityMap);
  }, [sessionActivityMap, sessions]);

  // Pre-compute session counts per workspace for O(1) access
  const workspacePaneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (s.workspaceId) {
        counts.set(s.workspaceId, (counts.get(s.workspaceId) || 0) + 1);
      }
    }
    return counts;
  }, [sessions]);

  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('tab-reorder-id', tabId);
    // Also set session-id for backward compatibility with workspace split functionality
    // Only orphan sessions can be dragged to create workspaces
    const isOrphanSession = orphanSessionMap.has(tabId);
    if (isOrphanSession) {
      e.dataTransfer.setData('session-id', tabId);
    }
    draggedTabIdRef.current = tabId;
    // Use setTimeout to allow the drag image to be captured before we change styles
    setTimeout(() => {
      setIsDraggingForReorder(true);
    }, 0);
    onStartSessionDrag(tabId);
  }, [orphanSessionMap, onStartSessionDrag]);

  const handleTabDragEnd = useCallback(() => {
    draggedTabIdRef.current = null;
    setDropIndicator(null);
    setIsDraggingForReorder(false);
    onEndSessionDrag();
  }, [onEndSessionDrag]);

  const handleTabDragOver = useCallback((e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedTabIdRef.current || draggedTabIdRef.current === tabId) {
      return;
    }

    // Determine if we're on the left or right half of the target tab
    const rect = e.currentTarget.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    const position: 'before' | 'after' = e.clientX < midpoint ? 'before' : 'after';

    // Always update drop indicator on drag over to ensure it doesn't get stuck
    setDropIndicator({ tabId, position });
  }, []);

  const handleTabDragLeave = useCallback((_e: React.DragEvent) => {
    // Don't clear drop indicator on drag leave - let onDragOver manage it
    // This prevents the indicator from flickering/disappearing during fast drags
    // The indicator will be cleared when drag ends or on drop
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('tab-reorder-id') || draggedTabIdRef.current;

    if (draggedId && draggedId !== targetTabId && dropIndicator) {
      onReorderTabs(draggedId, targetTabId, dropIndicator.position);
    }

    setDropIndicator(null);
    setIsDraggingForReorder(false);
  }, [dropIndicator, onReorderTabs]);

  // Pre-compute tab shift styles for all tabs to avoid recalculation during render
  const tabShiftStyles = useMemo(() => {
    if (!dropIndicator || !isDraggingForReorder || !draggedTabIdRef.current) {
      return {};
    }
    const styles: Record<string, React.CSSProperties> = {};
    const draggedIndex = orderedTabs.indexOf(draggedTabIdRef.current);
    const targetIndex = orderedTabs.indexOf(dropIndicator.tabId);
    const dropIndex = dropIndicator.position === 'before' ? targetIndex : targetIndex + 1;

    for (let i = 0; i < orderedTabs.length; i++) {
      const tabId = orderedTabs[i];
      if (tabId === draggedTabIdRef.current) continue;

      if (draggedIndex < dropIndex) {
        if (i > draggedIndex && i < dropIndex) {
          styles[tabId] = { transform: 'translateX(-8px)' };
        }
      } else {
        if (i >= dropIndex && i < draggedIndex) {
          styles[tabId] = { transform: 'translateX(8px)' };
        }
      }
    }
    return styles;
  }, [dropIndicator, isDraggingForReorder, orderedTabs]);

  // Build ordered tab items using pre-computed maps for O(1) lookups
  const orderedTabItems = useMemo(() => {
    return orderedTabs.map((tabId) => {
      const session = orphanSessionMap.get(tabId);
      const workspace = workspaceMap.get(tabId);
      const logView = logViewMap.get(tabId);
      if (session) {
        return { type: 'session' as const, id: tabId, session };
      }
      if (workspace) {
        return { type: 'workspace' as const, id: tabId, workspace, paneCount: workspacePaneCounts.get(tabId) || 0 };
      }
      if (logView) {
        return { type: 'logView' as const, id: tabId, logView };
      }
      return null;
    }).filter(Boolean);
  }, [orderedTabs, orphanSessionMap, workspaceMap, logViewMap, workspacePaneCounts]);

  // Render the tabs
  const renderOrderedTabs = () => {
    return orderedTabItems.map((item) => {
      if (!item) return null;

      if (item.type === 'session') {
        const session = item.session;
        const hasActivity = !!sessionActivityMap[session.id];
        const isBeingDragged = draggingSessionId === session.id;
        const shiftStyle = tabShiftStyles[session.id] || {};
        const showDropIndicatorBefore = dropIndicator?.tabId === session.id && dropIndicator.position === 'before';
        const showDropIndicatorAfter = dropIndicator?.tabId === session.id && dropIndicator.position === 'after';

        return (
          <ContextMenu key={session.id}>
            <ContextMenuTrigger asChild>
              <div
                data-tab-id={session.id}
                onClick={() => onSelectTab(session.id)}
                draggable
                onDragStart={(e) => handleTabDragStart(e, session.id)}
                onDragEnd={handleTabDragEnd}
                onDragOver={(e) => handleTabDragOver(e, session.id)}
                onDragLeave={handleTabDragLeave}
                onDrop={(e) => handleTabDrop(e, session.id)}
                className={cn(
                  "relative h-7 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-none text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
                  "transition-transform duration-150",
                  isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : ""
                )}
                style={{
                  ...shiftStyle,
                  backgroundColor: activeTabId === session.id
                    ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
                    : 'transparent',
                  color: activeTabId === session.id
                    ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
                    : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
                }}
                onMouseEnter={(e) => {
                  if (activeTabId !== session.id) {
                    e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
                    e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
                  }
                }}
                onMouseLeave={(e) => {
                  if (activeTabId !== session.id) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
                  }
                }}
              >
                {/* Active tab top accent line */}
                {activeTabId === session.id && (
                  <div
                    className="absolute top-0 left-0 right-0 h-[2px]"
                    style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))' }}
                  />
                )}
                {/* Drop indicator line - before */}
                {showDropIndicatorBefore && isDraggingForReorder && (
                  <div
                    className="absolute -left-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
                    style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
                  />
                )}
                {/* Drop indicator line - after */}
                {showDropIndicatorAfter && isDraggingForReorder && (
                  <div
                    className="absolute -right-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
                    style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
                  />
                )}
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <SessionTabIcon host={hostMap.get(session.hostId)} isActive={activeTabId === session.id} protocol={session.protocol} shellIcon={session.localShellIcon} />
                  <span className="truncate">{session.hostLabel}</span>
                  <div className="flex-shrink-0">{sessionStatusDot(session.status, hasActivity)}</div>
                </div>
                <button
                  onClick={(e) => onCloseSession(session.id, e)}
                  className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
                  aria-label={t('tabs.closeSessionAria')}
                >
                  <X size={12} />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onRenameSession(session.id)}>
                {t('common.rename')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onCopySession(session.id)}>
                {t('tabs.copyTab')}
              </ContextMenuItem>
              <ContextMenuItem className="text-destructive" onClick={() => onCloseSession(session.id)}>
                {t('common.close')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      }

      if (item.type === 'workspace') {
        const workspace = item.workspace;
        const paneCount = item.paneCount;
        const hasActivity = !!workspaceActivityMap.get(workspace.id);
        const isActive = activeTabId === workspace.id;
        const isBeingDragged = draggingSessionId === workspace.id;
        const shiftStyle = tabShiftStyles[workspace.id] || {};
        const showDropIndicatorBefore = dropIndicator?.tabId === workspace.id && dropIndicator.position === 'before';
        const showDropIndicatorAfter = dropIndicator?.tabId === workspace.id && dropIndicator.position === 'after';

        return (
          <ContextMenu key={workspace.id}>
            <ContextMenuTrigger asChild>
              <div
                data-tab-id={workspace.id}
                onClick={() => onSelectTab(workspace.id)}
                draggable
                onDragStart={(e) => handleTabDragStart(e, workspace.id)}
                onDragEnd={handleTabDragEnd}
                onDragOver={(e) => handleTabDragOver(e, workspace.id)}
                onDragLeave={handleTabDragLeave}
                onDrop={(e) => handleTabDrop(e, workspace.id)}
                className={cn(
                  "relative h-7 pl-3 pr-2 min-w-[150px] max-w-[260px] rounded-none text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
                  "transition-transform duration-150",
                  isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : ""
                )}
                style={{
                  ...shiftStyle,
                  backgroundColor: isActive
                    ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
                    : 'transparent',
                  color: isActive
                    ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
                    : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
                    e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
                  }
                }}
              >
                {/* Active tab top accent line */}
                {isActive && (
                  <div
                    className="absolute top-0 left-0 right-0 h-[2px]"
                    style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))' }}
                  />
                )}
                {/* Drop indicator line - before */}
                {showDropIndicatorBefore && isDraggingForReorder && (
                  <div
                    className="absolute -left-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
                    style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
                  />
                )}
                {/* Drop indicator line - after */}
                {showDropIndicatorAfter && isDraggingForReorder && (
                  <div
                    className="absolute -right-0.5 top-1 bottom-1 w-0.5 rounded-full animate-pulse"
                    style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))', boxShadow: '0 0 8px 2px color-mix(in srgb, var(--top-tabs-accent, hsl(var(--accent))) 50%, transparent)' }}
                  />
                )}
                <div className="flex items-center gap-2 truncate">
                  <LayoutGrid
                    size={14}
                    className="shrink-0"
                    style={{ color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
                  />
                  <span className="truncate">{workspace.title}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {hasActivity && sessionStatusDot('connected', true)}
                  <div
                    className="text-[10px] px-1.5 py-0.5 rounded-full min-w-[22px] text-center"
                    style={{
                      border: '1px solid color-mix(in srgb, var(--top-tabs-fg, hsl(var(--foreground))) 18%, transparent)',
                      backgroundColor: 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 60%, transparent)',
                    }}
                  >
                    {paneCount}
                  </div>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onRenameWorkspace(workspace.id)}>
                {t('common.rename')}
              </ContextMenuItem>
              <ContextMenuItem className="text-destructive" onClick={() => onCloseWorkspace(workspace.id)}>
                {t('common.close')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      }

      if (item.type === 'logView') {
        const logView = item.logView;
        const isActive = activeTabId === logView.id;
        const isLocal = logView.log.protocol === 'local' || logView.log.hostname === 'localhost';

        return (
          <div
            key={logView.id}
            data-tab-id={logView.id}
            onClick={() => onSelectTab(logView.id)}
            className={cn(
              "relative h-7 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-none text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
            )}
            style={{
              backgroundColor: isActive
                ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
                : 'transparent',
              color: isActive
                ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
                : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
                e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
              }
            }}
          >
            {/* Active tab top accent line */}
            {isActive && (
              <div
                className="absolute top-0 left-0 right-0 h-[2px]"
                style={{ backgroundColor: 'var(--top-tabs-fg, hsl(var(--foreground)))' }}
              />
            )}
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <FileText
                size={14}
                className="shrink-0"
                style={{ color: isActive ? 'var(--top-tabs-accent, hsl(var(--accent)))' : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
              />
              <span className="truncate">
                {t('tabs.logPrefix')} {isLocal ? t('tabs.logLocal') : logView.log.hostname}
              </span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseLogView(logView.id);
              }}
              className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
              aria-label={t('tabs.closeLogViewAria')}
            >
              <X size={12} />
            </button>
          </div>
        );
      }

      return null;
    });
  };

  // Handle double-click on titlebar to maximize/restore window (Windows/Linux)
  const handleTitleBarDoubleClick = useCallback((e: React.MouseEvent) => {
    // Only handle double-click on the drag region itself, not on buttons/tabs
    if ((e.target as HTMLElement).closest('.app-no-drag')) return;
    if (!isMacClient) {
      maximize();
    }
  }, [isMacClient, maximize]);

  return (
    <div
      data-top-tabs-root
      data-section="top-tabs"
      className="relative w-full bg-secondary app-drag"
      style={{
        ...dragRegionNoSelect,
        backgroundColor: 'var(--top-tabs-bg, hsl(var(--secondary)))',
        color: 'var(--top-tabs-fg, hsl(var(--foreground)))',
      }}
      onDoubleClick={handleTitleBarDoubleClick}
    >
      {/* Always-on drag stripe so the window can be moved even when tabs fill the bar */}
      <div className="absolute inset-x-0 top-0 h-1 app-drag pointer-events-auto z-10" style={dragRegionStyle} aria-hidden />
      <div
        className="h-9 flex items-end gap-0 app-drag"
        style={{ ...dragRegionStyle, paddingLeft: isMacClient && !isWindowFullscreen ? 76 : 12, paddingRight: isMacClient ? 12 : 0 }}
      >
        {/* Fixed left tabs: Vaults and SFTP */}
        <div className="flex items-end gap-0 flex-shrink-0 app-drag">
          <div
            onClick={() => onSelectTab('vault')}
            className={cn(
              "relative h-7 px-3 rounded text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag",
            )}
            style={{
              backgroundColor: isVaultActive
                ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
                : 'transparent',
              color: isVaultActive
                ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
                : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
            }}
            onMouseEnter={(e) => {
              if (!isVaultActive) {
                e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
                e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
              }
            }}
            onMouseLeave={(e) => {
              if (!isVaultActive) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
              }
            }}
          >
            <FolderLock size={14} /> Vaults
          </div>
          <div
            onClick={() => onSelectTab('sftp')}
            className={cn(
              "relative h-7 px-3 rounded-none text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag",
            )}
            style={{
              backgroundColor: isSftpActive
                ? 'var(--top-tabs-active-bg, hsl(var(--background)))'
                : 'transparent',
              color: isSftpActive
                ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
                : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
            }}
            onMouseEnter={(e) => {
              if (!isSftpActive) {
                e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--top-tabs-active-bg, hsl(var(--background))) 40%, transparent)';
                e.currentTarget.style.color = 'var(--top-tabs-fg, hsl(var(--foreground)))';
              }
            }}
            onMouseLeave={(e) => {
              if (!isSftpActive) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = 'var(--top-tabs-muted, hsl(var(--muted-foreground)))';
              }
            }}
          >
            {isSftpActive && (
              <div
                className="absolute top-0 left-0 right-0 h-[2px]"
                style={{ backgroundColor: 'var(--top-tabs-accent, hsl(var(--accent)))' }}
              />
            )}
            <Folder size={14} /> SFTP
          </div>
        </div>

        {/* Scrollable tabs container with fade masks */}
        <div
          className="relative min-w-0 flex-1 flex app-drag"
          style={dragRegionStyle}
          // Add container-level drag handlers to prevent indicator loss
          onDragOver={(e) => {
            // Keep drop indicator active while dragging over the container
            if (draggedTabIdRef.current && isDraggingForReorder && !dropIndicator) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }
          }}
        >
          {/* Left fade mask */}
          {canScrollLeft && (
            <div
              className="absolute left-0 top-0 bottom-0 w-8 pointer-events-none z-10"
              style={{ background: 'linear-gradient(to right, var(--top-tabs-bg, hsl(var(--secondary))), transparent)' }}
            />
          )}

          {/* Scrollable container */}
          <div
            ref={tabsContainerRef}
            className="flex items-end gap-0 overflow-x-auto scrollbar-none app-drag max-w-full"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {renderOrderedTabs()}
            {/* Add new tab button - follows last tab when not overflowing */}
            {!hasOverflow && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0 app-no-drag mb-0 rounded-none"
                style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
                onClick={onOpenQuickSwitcher}
                title="Open quick switcher"
              >
                <Plus size={14} />
              </Button>
            )}
            {/* Draggable spacer - fixed width handle at the end */}
            <div className="min-w-[20px] h-7 app-drag flex-shrink-0" style={dragRegionStyle} />
          </div>

          {/* Right fade mask */}
          {canScrollRight && (
            <div
              className="absolute right-0 top-0 bottom-0 w-8 pointer-events-none z-10"
              style={{ background: 'linear-gradient(to left, var(--top-tabs-bg, hsl(var(--secondary))), transparent)' }}
            />
          )}
        </div>

        {/* More tabs button - only when overflowing */}
        {hasOverflow && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-shrink-0 app-no-drag self-end rounded-none"
            style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
            onClick={onOpenQuickSwitcher}
            title="More tabs"
          >
            <MoreHorizontal size={14} />
          </Button>
        )}

        {/* Fixed right controls */}
        <div className="flex-shrink-0 flex items-center gap-2 app-drag self-center" style={dragRegionStyle}>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 app-no-drag"
            style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
            title="AI Assistant"
            onClick={() => window.dispatchEvent(new CustomEvent('netcatty:toggle-ai-panel'))}
          >
            <Sparkles size={16} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 app-no-drag" style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}>
            <Bell size={16} />
          </Button>
          <SyncStatusButton onOpenSettings={onOpenSettings} onSyncNow={onSyncNow} />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 app-no-drag"
            style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
            onClick={onToggleTheme}
            disabled={isImmersiveActive}
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
        {/* Custom window controls for Windows/Linux */}
        {!isMacClient && <div className="self-stretch flex items-stretch"><WindowControls /></div>}
        {/* Small drag shim to the right edge (macOS only – on Windows the close button should touch the edge) */}
        {isMacClient && <div className="w-2 h-9 app-drag flex-shrink-0" />}
      </div>
    </div>
  );
};

// Custom comparison: only re-render when data props change - activeTabId is now managed internally via store subscription
const topTabsAreEqual = (prev: TopTabsProps, next: TopTabsProps): boolean => {
  return (
    prev.theme === next.theme &&
    prev.hosts === next.hosts &&
    prev.sessions === next.sessions &&
    prev.orphanSessions === next.orphanSessions &&
    prev.workspaces === next.workspaces &&
    prev.orderedTabs === next.orderedTabs &&
    prev.logViews === next.logViews &&
    prev.draggingSessionId === next.draggingSessionId &&
    prev.isMacClient === next.isMacClient &&
    prev.onOpenSettings === next.onOpenSettings &&
    prev.onSyncNow === next.onSyncNow &&
    prev.isImmersiveActive === next.isImmersiveActive
  );
};

export const TopTabs = memo(TopTabsInner, topTabsAreEqual);
TopTabs.displayName = 'TopTabs';
