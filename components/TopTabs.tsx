import { Folder, FolderLock, Menu, Moon, MoreHorizontal, Plus, Settings, Sparkles, Sun } from 'lucide-react';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fromEditorTabId, isEditorTabId, useActiveTabId } from '../application/state/activeTabStore';
import { isHostTreeWorkTabSurface } from '../application/app/workTabSurface';
import type { EditorTab } from '../application/state/editorTabStore';
import { buildWorkspaceActivityMap } from '../application/state/sessionActivity';
import { useSessionActivityMap } from '../application/state/sessionActivityStore';
import {
  useTerminalHostTreeLayoutWidth,
  useTerminalHostTreeOpen,
  useToggleTerminalHostTree,
} from '../application/state/terminalHostTreeStore';
import type { LogView } from '../application/state/logViewState';
import { useWindowControls } from '../application/state/useWindowControls';
import { useI18n } from '../application/i18n/I18nProvider';
import { Host, TerminalSession, Workspace } from '../types';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ContextMenuItem, ContextMenuSeparator } from './ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { SyncStatusButton } from './SyncStatusButton';
import { WindowOpacityButton } from './WindowOpacityButton';
import {
  ActiveTabAutoScroller,
  EditorTopTab,
  LogViewTopTab,
  RootTopTab,
  SessionTopTab,
  scrollTopTabIntoComfortView,
  WindowControls,
  WorkspaceTopTab,
} from './top-tabs/TopTabItems';
import { TERMINAL_HOST_TREE_ANIMATION_MS } from '../application/state/terminalHostTreeAnimation';
import {
  scheduleAfterInstantThemeSwitch,
  scheduleChromeLayoutAnimation,
} from '../application/state/useActiveChromeTheme';
import { useTopTabLifecycleAnimations } from './top-tabs/useTopTabLifecycleAnimations';

// Helper styles for Electron drag regions (use type assertion to include non-standard WebkitAppRegion)
const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const dragRegionNoSelect = { WebkitAppRegion: 'drag', userSelect: 'none' } as React.CSSProperties;
const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;
const emptyTabStyle: React.CSSProperties = {};

export function computeHostTreeTabGutter(hostTreeLayoutWidth: number, toggleRight: number): number {
  return Math.max(0, hostTreeLayoutWidth - toggleRight);
}

export function shouldShowHostTreeToggle({
  enabled,
  activeTabId,
  logViewIds,
  orderedTabs,
  sessionIds,
  workspaceIds,
}: {
  enabled: boolean;
  activeTabId: string;
  logViewIds?: ReadonlySet<string>;
  orderedTabs: readonly string[];
  sessionIds: ReadonlySet<string>;
  workspaceIds: ReadonlySet<string>;
}): boolean {
  return isHostTreeWorkTabSurface({
    enabled,
    activeTabId,
    logViewIds,
    orderedTabs,
    sessionIds,
    workspaceIds,
  });
}

export function shouldKeepHostTreeToggleSurface({
  enabled,
  activeWorkTabCount,
}: {
  enabled: boolean;
  activeWorkTabCount: number;
}): boolean {
  return enabled && activeWorkTabCount > 0;
}

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
  onCopySessionToNewWindow: (sessionId: string) => void;
  onRenameWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onCloseLogView: (logViewId: string) => void;
  onCloseTabsBatch: (targetIds: string[]) => void;
  onOpenQuickSwitcher: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  windowOpacity: number;
  setWindowOpacity: (opacity: number) => void;
  onSyncNow?: () => Promise<void>;
  onStartSessionDrag: (sessionId: string) => void;
  onEndSessionDrag: () => void;
  onReorderTabs: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
  showSftpTab: boolean;
  showHostTreeSidebar: boolean;
  editorTabs: readonly EditorTab[];
  onRequestCloseEditorTab: (editorTabId: string) => void;
  hostById: Map<string, Host>;
}

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
  onCopySessionToNewWindow,
  onRenameWorkspace,
  onCloseWorkspace,
  onCloseLogView,
  onCloseTabsBatch,
  onOpenQuickSwitcher,
  onToggleTheme,
  onOpenSettings,
  windowOpacity,
  setWindowOpacity,
  onSyncNow,
  onStartSessionDrag,
  onEndSessionDrag,
  onReorderTabs,
  showSftpTab,
  showHostTreeSidebar,
  editorTabs,
  onRequestCloseEditorTab,
  hostById,
}) => {
  const { t } = useI18n();
  const { maximize, isFullscreen, onFullscreenChanged } = useWindowControls();
  const sessionActivityMap = useSessionActivityMap();
  const isHostTreeOpen = useTerminalHostTreeOpen();
  const hostTreeLayoutWidth = useTerminalHostTreeLayoutWidth();
  const toggleHostTree = useToggleTerminalHostTree();
  const activeTabId = useActiveTabId();
  const { getTabAnimationClass } = useTopTabLifecycleAnimations(orderedTabs);
  const fixedLeftTabsRef = useRef<HTMLDivElement>(null);
  const hostTreeToggleSlotRef = useRef<HTMLDivElement>(null);
  const suppressHostTreeToggleClickRef = useRef(false);
  const hostTreeGutterCloseRafRef = useRef<number | null>(null);
  const cancelHostTreeChromeReadyRef = useRef<(() => void) | null>(null);
  const cancelRootTabsCompactRef = useRef<(() => void) | null>(null);
  const cancelChromeExitRef = useRef<(() => void) | null>(null);
  const [hostTreeTabGutter, setHostTreeTabGutter] = useState(0);
  const [hostTreeChromeReady, setHostTreeChromeReady] = useState(false);
  const [hostTreeGutterExiting, setHostTreeGutterExiting] = useState(false);
  const [rootTabsCompact, setRootTabsCompact] = useState(false);
  const showWindowControls = !isMacClient;

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
      // Translate vertical wheel to horizontal scroll so users can reach
      // off-screen tabs with a standard mouse wheel. Trackpad gestures that
      // already carry horizontal delta are left alone so native two-finger
      // swiping still works.
      const handleWheel = (e: WheelEvent) => {
        if (e.deltaY !== 0 && e.deltaX === 0) {
          e.preventDefault();
          container.scrollLeft += e.deltaY;
        }
      };
      container.addEventListener('scroll', updateScrollState);
      container.addEventListener('wheel', handleWheel, { passive: false });
      const resizeObserver = new ResizeObserver(updateScrollState);
      resizeObserver.observe(container);
      return () => {
        container.removeEventListener('scroll', updateScrollState);
        container.removeEventListener('wheel', handleWheel);
        resizeObserver.disconnect();
      };
    }
  }, [updateScrollState, orderedTabs]);

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

  const activeWorkTabCount = orderedTabs.length;
  const showHostTreeToggle = shouldShowHostTreeToggle({
    enabled: showHostTreeSidebar,
    activeTabId,
    logViewIds: new Set(logViewMap.keys()),
    orderedTabs,
    sessionIds: new Set(orphanSessionMap.keys()),
    workspaceIds: new Set(workspaceMap.keys()),
  });
  const hasHostTreeToggleSurface = shouldKeepHostTreeToggleSurface({
    enabled: showHostTreeSidebar,
    activeWorkTabCount,
  });
  const effectiveShowHostTreeToggle = hostTreeChromeReady;

  useEffect(() => {
    cancelHostTreeChromeReadyRef.current?.();
    cancelHostTreeChromeReadyRef.current = null;
    cancelRootTabsCompactRef.current?.();
    cancelRootTabsCompactRef.current = null;
    cancelChromeExitRef.current?.();
    cancelChromeExitRef.current = null;

    if (!showHostTreeToggle) {
      if (hostTreeChromeReady) {
        setRootTabsCompact(false);
        setHostTreeGutterExiting(true);
        const gutterRaf = window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => setHostTreeTabGutter(0));
        });
        const timer = window.setTimeout(() => {
          cancelChromeExitRef.current = null;
          setHostTreeChromeReady(false);
          setHostTreeGutterExiting(false);
        }, TERMINAL_HOST_TREE_ANIMATION_MS);
        cancelChromeExitRef.current = () => {
          window.cancelAnimationFrame(gutterRaf);
          window.clearTimeout(timer);
        };
      } else {
        setHostTreeChromeReady(false);
        setHostTreeGutterExiting(false);
        setRootTabsCompact(false);
      }
      return () => {
        cancelChromeExitRef.current?.();
        cancelChromeExitRef.current = null;
      };
    }

    if (!hostTreeChromeReady) {
      cancelHostTreeChromeReadyRef.current = scheduleAfterInstantThemeSwitch(() => {
        cancelHostTreeChromeReadyRef.current = null;
        setHostTreeChromeReady(true);
      });
    }

    if (!rootTabsCompact) {
      cancelRootTabsCompactRef.current = scheduleChromeLayoutAnimation(() => {
        cancelRootTabsCompactRef.current = null;
        setRootTabsCompact(true);
      });
    }

    return () => {
      cancelHostTreeChromeReadyRef.current?.();
      cancelHostTreeChromeReadyRef.current = null;
      cancelRootTabsCompactRef.current?.();
      cancelRootTabsCompactRef.current = null;
    };
  }, [hostTreeChromeReady, rootTabsCompact, showHostTreeToggle]);

  const updateHostTreeTabGutter = useCallback((options?: { deferClose?: boolean }) => {
    if (hostTreeGutterExiting) return;

    if (!effectiveShowHostTreeToggle || hostTreeLayoutWidth <= 0) {
      if (!effectiveShowHostTreeToggle && options?.deferClose) {
        if (hostTreeGutterCloseRafRef.current !== null) {
          window.cancelAnimationFrame(hostTreeGutterCloseRafRef.current);
        }
        hostTreeGutterCloseRafRef.current = window.requestAnimationFrame(() => {
          hostTreeGutterCloseRafRef.current = null;
          setHostTreeTabGutter(0);
        });
        return;
      }
      setHostTreeTabGutter(0);
      return;
    }
    if (hostTreeGutterCloseRafRef.current !== null) {
      window.cancelAnimationFrame(hostTreeGutterCloseRafRef.current);
      hostTreeGutterCloseRafRef.current = null;
    }
    const root = tabsContainerRef.current?.closest('[data-top-tabs-root]') as HTMLElement | null;
    const toggleSlot = hostTreeToggleSlotRef.current;
    if (!root || !toggleSlot) {
      setHostTreeTabGutter(Math.max(0, hostTreeLayoutWidth));
      return;
    }
    const rootLeft = root.getBoundingClientRect().left;
    const toggleRight = toggleSlot.getBoundingClientRect().right - rootLeft;
    setHostTreeTabGutter(computeHostTreeTabGutter(hostTreeLayoutWidth, toggleRight));
  }, [effectiveShowHostTreeToggle, hostTreeGutterExiting, hostTreeLayoutWidth]);

  const updateHostTreeTabGutterRef = useRef(updateHostTreeTabGutter);
  updateHostTreeTabGutterRef.current = updateHostTreeTabGutter;

  useLayoutEffect(() => {
    updateHostTreeTabGutter({ deferClose: true });
  }, [hostTreeLayoutWidth, updateHostTreeTabGutter]);

  useLayoutEffect(() => {
    const syncGutter = () => updateHostTreeTabGutterRef.current();
    syncGutter({ deferClose: true });
    const rafId = window.requestAnimationFrame(() => syncGutter());
    const settleTimer = window.setTimeout(syncGutter, 320);
    const root = tabsContainerRef.current?.closest('[data-top-tabs-root]') as HTMLElement | null;
    const ro = new ResizeObserver(() => syncGutter());
    if (root) ro.observe(root);
    if (fixedLeftTabsRef.current) ro.observe(fixedLeftTabsRef.current);
    if (tabsContainerRef.current) ro.observe(tabsContainerRef.current);
    if (hostTreeToggleSlotRef.current) ro.observe(hostTreeToggleSlotRef.current);
    window.addEventListener('resize', syncGutter);
    return () => {
      window.cancelAnimationFrame(rafId);
      if (hostTreeGutterCloseRafRef.current !== null) {
        window.cancelAnimationFrame(hostTreeGutterCloseRafRef.current);
        hostTreeGutterCloseRafRef.current = null;
      }
      window.clearTimeout(settleTimer);
      ro.disconnect();
      window.removeEventListener('resize', syncGutter);
    };
  }, [
    orderedTabs.length,
    showSftpTab,
    isWindowFullscreen,
    effectiveShowHostTreeToggle,
    isHostTreeOpen,
  ]);

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

  const handleScrollableTabClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    const tab = target.closest('[data-tab-id]') as HTMLElement | null;
    if (!tab || !e.currentTarget.contains(tab)) return;
    scrollTopTabIntoComfortView(e.currentTarget, tab, 'smooth');
  }, []);

  const handleHostTreeTogglePointerDown = useCallback((e: React.PointerEvent) => {
    if (!effectiveShowHostTreeToggle) return;
    e.preventDefault();
    e.stopPropagation();
    suppressHostTreeToggleClickRef.current = true;
    toggleHostTree();
  }, [effectiveShowHostTreeToggle, toggleHostTree]);

  const handleHostTreeToggleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (suppressHostTreeToggleClickRef.current) {
      suppressHostTreeToggleClickRef.current = false;
      return;
    }
    if (!effectiveShowHostTreeToggle) return;
    toggleHostTree();
  }, [effectiveShowHostTreeToggle, toggleHostTree]);

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

  // Pre-compute editor tab map for O(1) access
  const editorTabMap = useMemo(() => {
    const map = new Map<string, EditorTab>();
    for (const t of editorTabs) map.set(t.id, t);
    return map;
  }, [editorTabs]);

  // fileName → count, for the rename-disambiguation suffix in the render loop.
  // Memoed so we don't do a per-tab O(n) filter on every render (was O(n²)).
  const editorTabFileNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of editorTabs) counts.set(t.fileName, (counts.get(t.fileName) ?? 0) + 1);
    return counts;
  }, [editorTabs]);

  // Build ordered tab items using pre-computed maps for O(1) lookups
  const orderedTabItems = useMemo(() => {
    return orderedTabs.map((tabId) => {
      if (isEditorTabId(tabId)) {
        const editorId = fromEditorTabId(tabId);
        const editorTab = editorTabMap.get(editorId);
        if (!editorTab) return null;
        return { type: 'editor' as const, id: tabId, editorTab };
      }
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
  }, [orderedTabs, editorTabMap, orphanSessionMap, workspaceMap, logViewMap, workspacePaneCounts]);

  // Bulk-close menu items shared by session and workspace context menus.
  // Anchor is the tab the user right-clicked on (matches VSCode/JetBrains UX).
  const renderBulkCloseItems = useCallback((anchorId: string) => {
    const anchorIdx = orderedTabs.indexOf(anchorId);
    const othersIds = orderedTabs.filter((id) => id !== anchorId);
    const rightIds = anchorIdx >= 0 ? orderedTabs.slice(anchorIdx + 1) : [];
    return (
      <>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={othersIds.length === 0}
          onClick={() => onCloseTabsBatch(othersIds)}
        >
          {t('tabs.closeOthers')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={rightIds.length === 0}
          onClick={() => onCloseTabsBatch(rightIds)}
        >
          {t('tabs.closeToRight')}
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive"
          onClick={() => onCloseTabsBatch(orderedTabs)}
        >
          {t('tabs.closeAll')}
        </ContextMenuItem>
      </>
    );
  }, [onCloseTabsBatch, orderedTabs, t]);

  // Render the tabs
  const renderOrderedTabs = () => {
    return orderedTabItems.map((item) => {
      if (!item) return null;

      if (item.type === 'editor') {
        const { editorTab } = item;
        const tabId = item.id;
        const host = hostById.get(editorTab.hostId);
        // Disambiguate duplicate filenames using the memoed counts map.
        const suffix = (editorTabFileNameCounts.get(editorTab.fileName) ?? 0) > 1
          ? ` · ${editorTab.remotePath.split('/').slice(-2, -1)[0] || '/'}`
          : '';

        const isBeingDragged = draggingSessionId === tabId;
        const shiftStyle = tabShiftStyles[tabId] || emptyTabStyle;
        const showDropIndicatorBefore = dropIndicator?.tabId === tabId && dropIndicator.position === 'before';
        const showDropIndicatorAfter = dropIndicator?.tabId === tabId && dropIndicator.position === 'after';

        return (
          <EditorTopTab
            key={tabId}
            tabId={tabId}
            editorTab={editorTab}
            host={host}
            suffix={suffix}
            onRequestCloseEditorTab={onRequestCloseEditorTab}
            isBeingDragged={isBeingDragged}
            isDraggingForReorder={isDraggingForReorder}
            shiftStyle={shiftStyle}
            showDropIndicatorBefore={showDropIndicatorBefore}
            showDropIndicatorAfter={showDropIndicatorAfter}
            onTabDragStart={handleTabDragStart}
            onTabDragEnd={handleTabDragEnd}
            onTabDragOver={handleTabDragOver}
            onTabDragLeave={handleTabDragLeave}
            onTabDrop={handleTabDrop}
            tabAnimationClass={getTabAnimationClass(tabId)}
          />
        );
      }

      if (item.type === 'session') {
        const session = item.session;
        const hasActivity = !!sessionActivityMap[session.id];
        const isBeingDragged = draggingSessionId === session.id;
        const shiftStyle = tabShiftStyles[session.id] || emptyTabStyle;
        const showDropIndicatorBefore = dropIndicator?.tabId === session.id && dropIndicator.position === 'before';
        const showDropIndicatorAfter = dropIndicator?.tabId === session.id && dropIndicator.position === 'after';

        return (
          <SessionTopTab
            key={session.id}
            session={session}
            host={hostMap.get(session.hostId)}
            hasActivity={hasActivity}
            isBeingDragged={isBeingDragged}
            isDraggingForReorder={isDraggingForReorder}
            shiftStyle={shiftStyle}
            showDropIndicatorBefore={showDropIndicatorBefore}
            showDropIndicatorAfter={showDropIndicatorAfter}
            onTabDragStart={handleTabDragStart}
            onTabDragEnd={handleTabDragEnd}
            onTabDragOver={handleTabDragOver}
            onTabDragLeave={handleTabDragLeave}
            onTabDrop={handleTabDrop}
            onCloseSession={onCloseSession}
            onRenameSession={onRenameSession}
            onCopySession={onCopySession}
            onCopySessionToNewWindow={onCopySessionToNewWindow}
            renderBulkCloseItems={renderBulkCloseItems}
            t={t}
            tabAnimationClass={getTabAnimationClass(session.id)}
          />
        );
      }

      if (item.type === 'workspace') {
        const workspace = item.workspace;
        const paneCount = item.paneCount;
        const hasActivity = !!workspaceActivityMap.get(workspace.id);
        const isBeingDragged = draggingSessionId === workspace.id;
        const shiftStyle = tabShiftStyles[workspace.id] || emptyTabStyle;
        const showDropIndicatorBefore = dropIndicator?.tabId === workspace.id && dropIndicator.position === 'before';
        const showDropIndicatorAfter = dropIndicator?.tabId === workspace.id && dropIndicator.position === 'after';

        return (
          <WorkspaceTopTab
            key={workspace.id}
            workspace={workspace}
            paneCount={paneCount}
            hasActivity={hasActivity}
            isBeingDragged={isBeingDragged}
            isDraggingForReorder={isDraggingForReorder}
            shiftStyle={shiftStyle}
            showDropIndicatorBefore={showDropIndicatorBefore}
            showDropIndicatorAfter={showDropIndicatorAfter}
            onTabDragStart={handleTabDragStart}
            onTabDragEnd={handleTabDragEnd}
            onTabDragOver={handleTabDragOver}
            onTabDragLeave={handleTabDragLeave}
            onTabDrop={handleTabDrop}
            onRenameWorkspace={onRenameWorkspace}
            onCloseWorkspace={onCloseWorkspace}
            renderBulkCloseItems={renderBulkCloseItems}
            t={t}
            tabAnimationClass={getTabAnimationClass(workspace.id)}
          />
        );
      }

      if (item.type === 'logView') {
        const logView = item.logView;
        const isBeingDragged = draggingSessionId === logView.id;
        const shiftStyle = tabShiftStyles[logView.id] || emptyTabStyle;
        const showDropIndicatorBefore = dropIndicator?.tabId === logView.id && dropIndicator.position === 'before';
        const showDropIndicatorAfter = dropIndicator?.tabId === logView.id && dropIndicator.position === 'after';

        return (
          <LogViewTopTab
            key={logView.id}
            logView={logView}
            onCloseLogView={onCloseLogView}
            isBeingDragged={isBeingDragged}
            isDraggingForReorder={isDraggingForReorder}
            shiftStyle={shiftStyle}
            showDropIndicatorBefore={showDropIndicatorBefore}
            showDropIndicatorAfter={showDropIndicatorAfter}
            onTabDragStart={handleTabDragStart}
            onTabDragEnd={handleTabDragEnd}
            onTabDragOver={handleTabDragOver}
            onTabDragLeave={handleTabDragLeave}
            onTabDrop={handleTabDrop}
            t={t}
            tabAnimationClass={getTabAnimationClass(logView.id)}
          />
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
      <ActiveTabAutoScroller
        tabsContainerRef={tabsContainerRef}
        updateScrollState={updateScrollState}
      />
      {/* Always-on drag stripe so the window can be moved even when tabs fill the bar */}
      <div className="absolute inset-x-0 top-0 h-1 app-drag pointer-events-auto z-10" style={dragRegionStyle} aria-hidden />
      <div
        className="h-9 flex items-end gap-0 app-drag overflow-visible"
        style={{
          ...dragRegionStyle,
          paddingLeft: isMacClient && !isWindowFullscreen ? 76 : 12,
          paddingRight: showWindowControls ? 0 : 12,
        }}
      >
        {/* Fixed left tabs: Vaults and SFTP */}
        <div ref={fixedLeftTabsRef} className="flex items-end gap-0 flex-shrink-0 app-drag">
          <RootTopTab
            tabId="vault"
            label="Vaults"
            icon={<FolderLock size={14} />}
            className="rounded"
            compact={rootTabsCompact}
          />
          {showSftpTab && (
            <RootTopTab
              tabId="sftp"
              label="SFTP"
              icon={<Folder size={14} />}
              className="rounded-t-md"
              compact={rootTabsCompact}
            />
          )}
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
          {hasHostTreeToggleSurface && (
            <div
              ref={hostTreeToggleSlotRef}
              className="top-tab-host-tree-toggle-slot mb-0 flex-shrink-0 self-end app-no-drag"
              data-section="top-tabs-host-tree-toggle"
              data-visible={effectiveShowHostTreeToggle ? 'true' : 'false'}
              style={noDragRegionStyle}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-tab-type="host-tree-toggle"
                    data-state={isHostTreeOpen ? 'active' : 'inactive'}
                    className={cn(
                      'h-7 w-7 flex-shrink-0 app-no-drag rounded-none hover:bg-transparent',
                    )}
                    style={{
                      color: isHostTreeOpen
                        ? 'var(--top-tabs-fg, hsl(var(--foreground)))'
                        : 'var(--top-tabs-muted, hsl(var(--muted-foreground)))',
                      pointerEvents: effectiveShowHostTreeToggle ? 'auto' : 'none',
                      ...noDragRegionStyle,
                    }}
                    onPointerDown={handleHostTreeTogglePointerDown}
                    onClick={handleHostTreeToggleClick}
                  >
                    <Menu size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isHostTreeOpen ? t('terminal.layer.hostTree.collapse') : t('terminal.layer.hostTree.expand')}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
          {hasHostTreeToggleSurface && (
            <div
              className={cn(
                'top-tab-host-tree-gutter flex-shrink-0',
                hostTreeGutterExiting && 'top-tab-host-tree-gutter-exit',
              )}
              style={{ width: hostTreeTabGutter }}
              aria-hidden
            />
          )}

          <div className="relative min-w-0 flex-1 flex app-drag" style={dragRegionStyle}>
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
              onClick={handleScrollableTabClick}
            >
              {renderOrderedTabs()}
              {/* Add new tab button - follows last tab when not overflowing */}
              {!hasOverflow && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      data-section="top-tabs-quick-switcher-toggle"
                      className="h-7 w-7 flex-shrink-0 app-no-drag mb-0 rounded-none"
                      style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
                      onClick={onOpenQuickSwitcher}
                    >
                      <Plus size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('topTabs.openQuickSwitcher')}</TooltipContent>
                </Tooltip>
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

        </div>

        {/* More tabs button - only when overflowing */}
        {hasOverflow && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0 app-no-drag self-end rounded-none"
                style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
                onClick={onOpenQuickSwitcher}
              >
                <MoreHorizontal size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('topTabs.moreTabs')}</TooltipContent>
          </Tooltip>
        )}

        {/* Fixed right controls — utility icons + window controls share one h-7 row */}
        <div
          className="flex-shrink-0 flex items-center gap-0.5 app-drag self-end h-7 overflow-visible"
          style={dragRegionStyle}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn"
                style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
                onClick={() => window.dispatchEvent(new CustomEvent('netcatty:toggle-ai-panel'))}
              >
                <Sparkles size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('topTabs.aiAssistant')}</TooltipContent>
          </Tooltip>
          <WindowOpacityButton
            windowOpacity={windowOpacity}
            setWindowOpacity={setWindowOpacity}
            className="h-7 w-7 shrink-0 top-tab-utility-btn"
            style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
          />
          <SyncStatusButton
            onOpenSettings={onOpenSettings}
            onSyncNow={onSyncNow}
            className="h-7 w-7 shrink-0 top-tab-utility-btn"
            style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn"
                style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
                onClick={onToggleTheme}
              >
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('topTabs.toggleTheme')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 app-no-drag top-tab-utility-btn"
                style={{ color: 'var(--top-tabs-muted, hsl(var(--muted-foreground)))' }}
                onClick={onOpenSettings}
              >
                <Settings size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('topTabs.openSettings')}</TooltipContent>
          </Tooltip>
          {showWindowControls && <WindowControls />}
        </div>
        {/* Small drag shim to the right edge (macOS only – on Windows the close button should touch the edge) */}
        {isMacClient && !showWindowControls && (
          <div className="w-2 h-9 app-drag flex-shrink-0 self-end" />
        )}
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
    prev.onCopySession === next.onCopySession &&
    prev.onCopySessionToNewWindow === next.onCopySessionToNewWindow &&
    prev.onOpenSettings === next.onOpenSettings &&
    prev.windowOpacity === next.windowOpacity &&
    prev.setWindowOpacity === next.setWindowOpacity &&
    prev.onSyncNow === next.onSyncNow &&
    prev.onToggleTheme === next.onToggleTheme &&
    prev.showSftpTab === next.showSftpTab &&
    prev.showHostTreeSidebar === next.showHostTreeSidebar
  );
};

export const TopTabs = memo(TopTabsInner, topTabsAreEqual);
TopTabs.displayName = 'TopTabs';
