import { Bell, Copy, FileText, Folder, LayoutGrid, Minus, Moon, MoreHorizontal, Plus, Shield, Square, Sun, TerminalSquare, User, X } from 'lucide-react';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeTabStore, useActiveTabId } from '../application/state/activeTabStore';
import { LogView } from '../application/state/useSessionState';
import { useWindowControls } from '../application/state/useWindowControls';
import { cn } from '../lib/utils';
import { TerminalSession, Workspace } from '../types';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';

// Helper styles for Electron drag regions (use type assertion to include non-standard WebkitAppRegion)
const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const dragRegionNoSelect = { WebkitAppRegion: 'drag', userSelect: 'none' } as React.CSSProperties;

interface TopTabsProps {
  theme: 'dark' | 'light';
  sessions: TerminalSession[];
  orphanSessions: TerminalSession[];
  workspaces: Workspace[];
  logViews: LogView[];
  orderedTabs: string[];
  draggingSessionId: string | null;
  isMacClient: boolean;
  onCloseSession: (sessionId: string, e?: React.MouseEvent) => void;
  onRenameWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onCloseLogView: (logViewId: string) => void;
  onOpenQuickSwitcher: () => void;
  onToggleTheme: () => void;
  onStartSessionDrag: (sessionId: string) => void;
  onEndSessionDrag: () => void;
  onReorderTabs: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
}

const sessionStatusDot = (status: TerminalSession['status']) => {
  const tone = status === 'connected'
    ? "bg-emerald-400"
    : status === 'connecting'
      ? "bg-amber-400"
      : "bg-rose-500";
  return <span className={cn("inline-block h-2 w-2 rounded-full ring-2 ring-background/60", tone)} />;
};

// Custom window controls for Windows/Linux (frameless window)
const WindowControls: React.FC = memo(() => {
  const { minimize, maximize, close, isMaximized: fetchIsMaximized } = useWindowControls();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // Check initial maximized state
    fetchIsMaximized().then(v => setIsMaximized(!!v));

    // Listen for window resize to update maximized state
    const handleResize = () => {
      fetchIsMaximized().then(v => setIsMaximized(!!v));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
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
    <div className="flex items-center app-drag">
      <button
        onClick={handleMinimize}
        className="h-10 w-12 flex items-center justify-center text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-all duration-150 app-no-drag"
        title="Minimize"
      >
        <Minus size={16} />
      </button>
      <button
        onClick={handleMaximize}
        className="h-10 w-12 flex items-center justify-center text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-all duration-150 app-no-drag"
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
        className="h-10 w-12 flex items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white transition-all duration-150 app-no-drag"
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
  sessions,
  orphanSessions,
  workspaces,
  logViews,
  orderedTabs,
  draggingSessionId,
  isMacClient,
  onCloseSession,
  onRenameWorkspace,
  onCloseWorkspace,
  onCloseLogView,
  onOpenQuickSwitcher,
  onToggleTheme,
  onStartSessionDrag,
  onEndSessionDrag,
  onReorderTabs,
}) => {
  // Subscribe to activeTabId from external store
  const { maximize } = useWindowControls();
  const activeTabId = useActiveTabId();
  const isVaultActive = activeTabId === 'vault';
  const isSftpActive = activeTabId === 'sftp';
  const onSelectTab = activeTabStore.setActiveTabId;

  // Tab reorder drag state
  const [dropIndicator, setDropIndicator] = useState<{ tabId: string; position: 'before' | 'after' } | null>(null);
  const [isDraggingForReorder, setIsDraggingForReorder] = useState(false);
  const draggedTabIdRef = useRef<string | null>(null);

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
        const isBeingDragged = draggingSessionId === session.id;
        const shiftStyle = tabShiftStyles[session.id] || {};
        const showDropIndicatorBefore = dropIndicator?.tabId === session.id && dropIndicator.position === 'before';
        const showDropIndicatorAfter = dropIndicator?.tabId === session.id && dropIndicator.position === 'after';

        return (
          <div
            key={session.id}
            data-tab-id={session.id}
            onClick={() => onSelectTab(session.id)}
            draggable
            onDragStart={(e) => handleTabDragStart(e, session.id)}
            onDragEnd={handleTabDragEnd}
            onDragOver={(e) => handleTabDragOver(e, session.id)}
            onDragLeave={handleTabDragLeave}
            onDrop={(e) => handleTabDrop(e, session.id)}
            className={cn(
              "relative h-8 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-md border text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
              "transition-all duration-200 ease-out",
              activeTabId === session.id ? "bg-accent/20 text-foreground" : "border-border/60 text-muted-foreground hover:border-accent/40 hover:text-foreground",
              isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : ""
            )}
            style={{
              ...shiftStyle,
              ...(activeTabId === session.id ? { borderColor: 'hsl(var(--accent))' } : {})
            }}
          >
            {/* Drop indicator line - before */}
            {showDropIndicatorBefore && isDraggingForReorder && (
              <div className="absolute -left-1.5 top-1 bottom-1 w-0.5 bg-primary rounded-full shadow-[0_0_8px_2px] shadow-primary/50 animate-pulse" />
            )}
            {/* Drop indicator line - after */}
            {showDropIndicatorAfter && isDraggingForReorder && (
              <div className="absolute -right-1.5 top-1 bottom-1 w-0.5 bg-primary rounded-full shadow-[0_0_8px_2px] shadow-primary/50 animate-pulse" />
            )}
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <TerminalSquare size={14} className={cn("shrink-0", activeTabId === session.id ? "text-accent" : "text-muted-foreground")} />
              <span className="truncate">{session.hostLabel}</span>
              <div className="flex-shrink-0">{sessionStatusDot(session.status)}</div>
            </div>
            <button
              onClick={(e) => onCloseSession(session.id, e)}
              className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
              aria-label="Close session"
            >
              <X size={12} />
            </button>
          </div>
        );
      }

      if (item.type === 'workspace') {
        const workspace = item.workspace;
        const paneCount = item.paneCount;
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
                  "relative h-8 pl-3 pr-2 min-w-[150px] max-w-[260px] rounded-md border text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
                  "transition-all duration-200 ease-out",
                  isActive ? "bg-accent/20 text-foreground" : "border-border/60 text-muted-foreground hover:border-accent/40 hover:text-foreground",
                  isBeingDragged && isDraggingForReorder ? "opacity-40 scale-95" : ""
                )}
                style={{
                  ...shiftStyle,
                  ...(isActive ? { borderColor: 'hsl(var(--accent))' } : {})
                }}
              >
                {/* Drop indicator line - before */}
                {showDropIndicatorBefore && isDraggingForReorder && (
                  <div className="absolute -left-1.5 top-1 bottom-1 w-0.5 bg-primary rounded-full shadow-[0_0_8px_2px] shadow-primary/50 animate-pulse" />
                )}
                {/* Drop indicator line - after */}
                {showDropIndicatorAfter && isDraggingForReorder && (
                  <div className="absolute -right-1.5 top-1 bottom-1 w-0.5 bg-primary rounded-full shadow-[0_0_8px_2px] shadow-primary/50 animate-pulse" />
                )}
                <div className="flex items-center gap-2 truncate">
                  <LayoutGrid size={14} className={cn("shrink-0", isActive ? "text-primary" : "text-muted-foreground")} />
                  <span className="truncate">{workspace.title}</span>
                </div>
                <div className="text-[10px] px-2 py-1 rounded-full border border-border/70 bg-background/60 min-w-[28px] text-center">
                  {paneCount}
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onRenameWorkspace(workspace.id)}>
                Rename
              </ContextMenuItem>
              <ContextMenuItem className="text-destructive" onClick={() => onCloseWorkspace(workspace.id)}>
                Close
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
              "relative h-8 pl-3 pr-2 min-w-[140px] max-w-[240px] rounded-md border text-xs font-semibold cursor-pointer flex items-center justify-between gap-2 app-no-drag flex-shrink-0",
              "transition-all duration-200 ease-out",
              isActive ? "bg-accent/20 text-foreground" : "border-border/60 text-muted-foreground hover:border-accent/40 hover:text-foreground"
            )}
            style={isActive ? { borderColor: 'hsl(var(--accent))' } : {}}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <FileText size={14} className={cn("shrink-0", isActive ? "text-accent" : "text-muted-foreground")} />
              <span className="truncate">
                Log: {isLocal ? 'Local' : logView.log.hostname}
              </span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseLogView(logView.id);
              }}
              className="p-1 rounded-full hover:bg-destructive/10 hover:text-destructive transition-colors"
              aria-label="Close log view"
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
      className="relative w-full bg-secondary border-b border-border/60 app-drag"
      style={dragRegionNoSelect}
      onDoubleClick={handleTitleBarDoubleClick}
    >
      {/* Always-on drag stripe so the window can be moved even when tabs fill the bar */}
      <div className="absolute inset-x-0 top-0 h-3 app-drag pointer-events-auto z-10" style={dragRegionStyle} aria-hidden />
      <div
        className="h-10 px-3 flex items-center gap-2 app-drag"
        style={{ ...dragRegionStyle, paddingLeft: isMacClient ? 76 : 12 }}
      >
        {/* Fixed left tabs: Vaults and SFTP */}
        <div className="flex items-center gap-2 flex-shrink-0 app-drag">
          <div
            onClick={() => onSelectTab('vault')}
            className={cn(
              "h-8 px-3 rounded-md border text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag",
              isVaultActive ? "bg-accent/20 text-foreground" : "border-border/60 text-muted-foreground hover:border-accent/40 hover:text-foreground"
            )}
            style={isVaultActive ? { borderColor: 'hsl(var(--accent))' } : undefined}
          >
            <Shield size={14} /> Vaults
          </div>
          <div
            onClick={() => onSelectTab('sftp')}
            className={cn(
              "h-8 px-3 rounded-md border text-xs font-semibold cursor-pointer flex items-center gap-2 app-no-drag",
              isSftpActive ? "bg-accent/20 text-foreground" : "border-border/60 text-muted-foreground hover:border-accent/40 hover:text-foreground"
            )}
            style={isSftpActive ? { borderColor: 'hsl(var(--accent))' } : undefined}
          >
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
              style={{ background: 'linear-gradient(to right, hsl(var(--secondary) / 0.9), transparent)' }}
            />
          )}

          {/* Scrollable container */}
          <div
            ref={tabsContainerRef}
            className="flex items-center gap-2 overflow-x-auto scrollbar-none app-drag max-w-full"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {renderOrderedTabs()}
            {/* Add new tab button - follows last tab when not overflowing */}
            {!hasOverflow && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 flex-shrink-0 app-no-drag"
                onClick={onOpenQuickSwitcher}
                title="Open quick switcher"
              >
                <Plus size={14} />
              </Button>
            )}
            {/* Draggable spacer - fixed width handle at the end */}
            <div className="min-w-[20px] h-8 app-drag flex-shrink-0" style={dragRegionStyle} />
          </div>

          {/* Right fade mask */}
          {canScrollRight && (
            <div
              className="absolute right-0 top-0 bottom-0 w-8 pointer-events-none z-10"
              style={{ background: 'linear-gradient(to left, hsl(var(--secondary) / 0.9), transparent)' }}
            />
          )}
        </div>

        {/* More tabs button - only when overflowing */}
        {hasOverflow && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 flex-shrink-0 app-no-drag"
            onClick={onOpenQuickSwitcher}
            title="More tabs"
          >
            <MoreHorizontal size={14} />
          </Button>
        )}

        {/* Fixed right controls */}
        <div className="flex-shrink-0 flex items-center gap-2 app-drag" style={dragRegionStyle}>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground app-no-drag">
            <Bell size={16} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground app-no-drag">
            <User size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground app-no-drag"
            onClick={onToggleTheme}
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
        {/* Custom window controls for Windows/Linux */}
        {!isMacClient && <WindowControls />}
        {/* Small drag shim to the right edge */}
        <div className="w-2 h-10 app-drag flex-shrink-0" />
      </div>
    </div>
  );
};

// Custom comparison: only re-render when data props change - activeTabId is now managed internally via store subscription
const topTabsAreEqual = (prev: TopTabsProps, next: TopTabsProps): boolean => {
  return (
    prev.theme === next.theme &&
    prev.sessions === next.sessions &&
    prev.orphanSessions === next.orphanSessions &&
    prev.workspaces === next.workspaces &&
    prev.orderedTabs === next.orderedTabs &&
    prev.draggingSessionId === next.draggingSessionId &&
    prev.isMacClient === next.isMacClient
  );
};

export const TopTabs = memo(TopTabsInner, topTabsAreEqual);
TopTabs.displayName = 'TopTabs';
