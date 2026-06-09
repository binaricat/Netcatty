import { ChevronRight, Folder, FolderOpen, Server } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import {
  hostTreeInlineGroupEditStore,
  useHostTreeInlineGroupEdit,
} from '../../application/state/hostTreeInlineGroupEditStore';
import { useVaultHostTreeActions } from '../../application/state/vaultHostTreeActionsStore';
import {
  terminalHostTreeStore,
  useTerminalHostTreeOpen,
} from '../../application/state/terminalHostTreeStore';
import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import { useStoredNumber } from '../../application/state/useStoredNumber';
import { useTreeExpandedState } from '../../application/state/useTreeExpandedState';
import { ensureAncestorPathsExpanded } from '../../domain/hostGroupPathMutations';
import { buildHostGroupTree, collectGroupTreePaths } from '../../domain/hostGroupTree';
import {
  flattenHostGroupTree,
  hostTreeFlatRowContainsHost,
  hostTreeFlatRowKey,
  type HostTreeFlatRow,
} from '../../domain/hostGroupTreeFlat';
import {
  STORAGE_KEY_TERMINAL_HOST_TREE_WIDTH,
  STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED,
} from '../../infrastructure/config/storageKeys';
import { cn } from '../../lib/utils';
import type { GroupNode, Host, TerminalTheme } from '../../types';
import { HostTreeGroupContextMenuContent, HostTreeHostContextMenuContent } from '../host/HostTreeContextMenus';
import { HostTreeGroupInlineRenameInput } from '../host/HostTreeGroupInlineRenameInput';
import { DistroAvatar } from '../DistroAvatar';
import { ContextMenu, ContextMenuTrigger } from '../ui/context-menu';
import { TREE_ROW_HEIGHT } from '../sftp/SftpPaneTreeNode';
import { FixedSizeVirtualList, type FixedSizeVirtualListHandle } from '../ui/FixedSizeVirtualList';
import {
  TerminalHostTreeToolbar,
  type HostTreeToolbarPanel,
} from './TerminalHostTreeToolbar';

const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_DEFAULT_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_ANIM_MS = 220;
const SIDEBAR_ANIM_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

const HOST_TREE_DRAG_HOST_ID = 'host-id';
const HOST_TREE_DRAG_GROUP_PATH = 'group-path';

type HostTreeDropTarget =
  | { kind: 'root' }
  | { kind: 'group'; path: string };

interface TerminalHostTreeSidebarProps {
  hosts: Host[];
  customGroups: string[];
  resolvedPreviewTheme: TerminalTheme;
  activeHostId?: string | null;
  onConnect: (host: Host) => void;
  onCreateLocalTerminal?: () => void;
}

type HostTreeTheme = {
  termBg: string;
  termFg: string;
  mutedFg: string;
  separator: string;
  rowHoverBg: string;
  rowActiveBg: string;
  rowDropBg: string;
  folderFg: string;
};

function hostMatchesSearch(host: Host, search: string): boolean {
  const s = search.toLowerCase();
  return (
    host.label.toLowerCase().includes(s)
    || host.hostname.toLowerCase().includes(s)
    || host.tags.some((tag) => tag.toLowerCase().includes(s))
    || (host.notes?.toLowerCase().includes(s) ?? false)
  );
}

function filterGroupNode(
  node: GroupNode,
  search: string,
  preservePaths?: ReadonlySet<string>,
): GroupNode | null {
  const matchingHosts = search
    ? node.hosts.filter((host) => hostMatchesSearch(host, search))
    : node.hosts;
  const childNodes = Object.values(node.children)
    .map((child) => filterGroupNode(child as GroupNode, search, preservePaths))
    .filter((child): child is GroupNode => child !== null);
  if (!search) return node;
  if (preservePaths?.has(node.path) || matchingHosts.length > 0 || childNodes.length > 0) {
    return {
      ...node,
      hosts: matchingHosts,
      children: Object.fromEntries(childNodes.map((child) => [child.name, child])),
    };
  }
  return null;
}

function pruneEmptyGroupNode(
  node: GroupNode,
  preservePaths?: ReadonlySet<string>,
): GroupNode | null {
  const childNodes = Object.values(node.children)
    .map((child) => pruneEmptyGroupNode(child as GroupNode, preservePaths))
    .filter((child): child is GroupNode => child !== null);
  if (preservePaths?.has(node.path) || node.hosts.length > 0 || childNodes.length > 0) {
    return {
      ...node,
      children: Object.fromEntries(childNodes.map((child) => [child.name, child])),
    };
  }
  return null;
}

type HostTreeFlatRowProps = {
  row: HostTreeFlatRow;
  activeHostId?: string | null;
  expandedPaths: Set<string>;
  searchActive: boolean;
  canDrag: boolean;
  isDragOver: boolean;
  isInlineEditing: boolean;
  inlineEditInitialName?: string;
  onConnect: (host: Host) => void;
  onTogglePath: (path: string) => void;
  onDragOverTarget: (target: HostTreeDropTarget) => void;
  onDragLeaveRow: (event: React.DragEvent<HTMLDivElement>) => void;
  onDropToParent: (targetParent: string | null, dataTransfer: DataTransfer) => void;
  theme: HostTreeTheme;
  menuActions: ReturnType<typeof useVaultHostTreeActions>;
};

const HostTreeFlatRowItem = memo<HostTreeFlatRowProps>(({
  row,
  activeHostId,
  expandedPaths,
  searchActive,
  canDrag,
  isDragOver,
  isInlineEditing,
  inlineEditInitialName,
  onConnect,
  onTogglePath,
  onDragOverTarget,
  onDragLeaveRow,
  onDropToParent,
  theme,
  menuActions,
}) => {
  if (row.kind === 'host') {
    const isActive = activeHostId === row.host.id;
    const hostDropParent = row.host.group || null;
    const rowBody = (
      <div
        role="button"
        tabIndex={0}
        data-section="terminal-host-tree-sidebar-row"
        data-row-type="host"
        data-host-id={row.host.id}
        data-active={isActive ? 'true' : 'false'}
        data-drag-over={isDragOver ? 'true' : 'false'}
        className={cn(
          'flex min-w-0 items-center gap-1 px-2 cursor-pointer select-none text-sm',
        )}
        style={{
          height: TREE_ROW_HEIGHT,
          paddingLeft: row.depth * 16 + 8,
          backgroundColor: isActive ? theme.rowActiveBg : (isDragOver ? theme.rowDropBg : undefined),
        }}
        draggable={canDrag}
        onDragStart={(event) => {
          if (!canDrag) return;
          event.dataTransfer.setData(HOST_TREE_DRAG_HOST_ID, row.host.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          if (!canDrag) return;
          event.preventDefault();
          event.stopPropagation();
          onDragOverTarget(hostDropParent ? { kind: 'group', path: hostDropParent } : { kind: 'root' });
        }}
        onDragLeave={onDragLeaveRow}
        onDrop={(event) => {
          if (!canDrag) return;
          event.preventDefault();
          event.stopPropagation();
          onDropToParent(hostDropParent, event.dataTransfer);
        }}
        onMouseEnter={(event) => {
          if (!isActive && !isDragOver) event.currentTarget.style.backgroundColor = theme.rowHoverBg;
        }}
        onMouseLeave={(event) => {
          if (!isActive && !isDragOver) event.currentTarget.style.backgroundColor = '';
        }}
        onDoubleClick={() => onConnect(row.host)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onConnect(row.host);
          }
        }}
      >
        <span className="shrink-0 w-4" />
        <span className="shrink-0">
          <DistroAvatar host={row.host} size="xs" fallback={row.host.label.slice(0, 1).toUpperCase()} />
        </span>
        <span className="min-w-0 flex-1 truncate">{row.host.label}</span>
        {row.host.protocol && row.host.protocol !== 'ssh' && (
          <span className="shrink-0 text-[10px] uppercase opacity-70" style={{ color: theme.mutedFg }}>
            {row.host.protocol}
          </span>
        )}
      </div>
    );

    if (!menuActions) return rowBody;

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {rowBody}
        </ContextMenuTrigger>
        <HostTreeHostContextMenuContent
          host={row.host}
          onConnect={onConnect}
          onCopyCredentials={menuActions.onCopyCredentials}
          onDeleteHost={menuActions.onDeleteHost}
        />
      </ContextMenu>
    );
  }

  const { node, depth } = row;
  const isExpanded = searchActive || expandedPaths.has(node.path);
  const hasChildren = Object.keys(node.children).length > 0;
  const hasHosts = node.hosts.length > 0;
  const isManaged = menuActions?.managedGroupPaths?.has(node.path) ?? false;

  const rowBody = (
    <div
      role="button"
      tabIndex={0}
      data-section="terminal-host-tree-sidebar-row"
      data-row-type="group"
      data-group-path={node.path}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-drag-over={isDragOver ? 'true' : 'false'}
      className={cn(
        'flex min-w-0 items-center gap-1 px-2 cursor-pointer select-none text-sm font-medium',
      )}
      style={{
        height: TREE_ROW_HEIGHT,
        paddingLeft: depth * 16 + 8,
        color: theme.termFg,
        backgroundColor: isDragOver ? theme.rowDropBg : undefined,
      }}
      draggable={canDrag}
      onDragStart={(event) => {
        if (!canDrag) return;
        event.dataTransfer.setData(HOST_TREE_DRAG_GROUP_PATH, node.path);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => {
        if (!canDrag) return;
        event.preventDefault();
        event.stopPropagation();
        onDragOverTarget({ kind: 'group', path: node.path });
      }}
      onDragLeave={onDragLeaveRow}
      onDrop={(event) => {
        if (!canDrag) return;
        event.preventDefault();
        event.stopPropagation();
        onDropToParent(node.path, event.dataTransfer);
      }}
      onMouseEnter={(event) => {
        if (!isDragOver) event.currentTarget.style.backgroundColor = theme.rowHoverBg;
      }}
      onMouseLeave={(event) => {
        if (!isDragOver) event.currentTarget.style.backgroundColor = '';
      }}
      onClick={() => onTogglePath(node.path)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onTogglePath(node.path);
        }
      }}
    >
      <span className="shrink-0 w-4 flex items-center justify-center">
        {(hasChildren || hasHosts) && (
          <ChevronRight
            size={14}
            className={cn('transition-transform', isExpanded && 'rotate-90')}
            style={{ color: theme.mutedFg }}
          />
        )}
      </span>
      {isExpanded
        ? <FolderOpen size={14} className="shrink-0" style={{ color: theme.folderFg }} />
        : <Folder size={14} className="shrink-0" style={{ color: theme.folderFg }} />}
      {isInlineEditing && menuActions && inlineEditInitialName ? (
        <HostTreeGroupInlineRenameInput
          initialName={inlineEditInitialName}
          onCommit={menuActions.commitInlineGroupRename}
          onCancel={menuActions.cancelInlineGroupEdit}
          className="flex-1 font-medium"
          style={{ color: theme.termFg }}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      )}
    </div>
  );

  if (!menuActions) return rowBody;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {rowBody}
      </ContextMenuTrigger>
      <HostTreeGroupContextMenuContent
        groupPath={node.path}
        isManaged={isManaged}
        onNewGroup={menuActions.onNewGroup}
        onRenameGroup={menuActions.onRenameGroup}
        onDeleteGroup={menuActions.onDeleteGroup}
        onUnmanageGroup={menuActions.onUnmanageGroup}
      />
    </ContextMenu>
  );
}, (prev, next) => {
  if (prev.row !== next.row) return false;
  if (prev.expandedPaths !== next.expandedPaths) return false;
  if (prev.searchActive !== next.searchActive) return false;
  if (prev.canDrag !== next.canDrag) return false;
  if (prev.isDragOver !== next.isDragOver) return false;
  if (prev.isInlineEditing !== next.isInlineEditing) return false;
  if (prev.inlineEditInitialName !== next.inlineEditInitialName) return false;
  if (prev.theme !== next.theme) return false;
  if (prev.menuActions !== next.menuActions) return false;
  if (prev.onDragOverTarget !== next.onDragOverTarget) return false;
  if (prev.onDragLeaveRow !== next.onDragLeaveRow) return false;
  if (prev.onDropToParent !== next.onDropToParent) return false;
  if (prev.onTogglePath !== next.onTogglePath) return false;
  if (prev.onConnect !== next.onConnect) return false;
  if (prev.activeHostId === next.activeHostId) return true;
  if (prev.row.kind === 'host') {
    return prev.row.host.id !== prev.activeHostId && prev.row.host.id !== next.activeHostId;
  }
  const affectsRow =
    hostTreeFlatRowContainsHost(prev.row, prev.activeHostId)
    || hostTreeFlatRowContainsHost(prev.row, next.activeHostId);
  return !affectsRow;
});
HostTreeFlatRowItem.displayName = 'HostTreeFlatRowItem';

const TerminalHostTreeSidebarInner: React.FC<TerminalHostTreeSidebarProps> = ({
  hosts,
  customGroups,
  resolvedPreviewTheme,
  activeHostId,
  onConnect,
  onCreateLocalTerminal,
}) => {
  const { t } = useI18n();
  const isOpen = useTerminalHostTreeOpen();
  const [search, setSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [expandedPanel, setExpandedPanel] = useState<HostTreeToolbarPanel>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<HostTreeDropTarget | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth, persistSidebarWidth] = useStoredNumber(
    STORAGE_KEY_TERMINAL_HOST_TREE_WIDTH,
    SIDEBAR_DEFAULT_WIDTH,
    { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH },
  );
  const { expandedPaths, togglePath, ensurePathExpanded, expandAll, collapseAll } = useTreeExpandedState(
    STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED,
  );
  const menuActions = useVaultHostTreeActions();
  const inlineEdit = useHostTreeInlineGroupEdit();
  const listRef = useRef<FixedSizeVirtualListHandle>(null);

  const theme = useMemo<HostTreeTheme>(() => {
    const termBg = resolvedPreviewTheme.colors.background;
    const termFg = resolvedPreviewTheme.colors.foreground;
    return {
      termBg,
      termFg,
      mutedFg: `color-mix(in srgb, ${termFg} 55%, ${termBg} 45%)`,
      separator: `color-mix(in srgb, ${termFg} 10%, ${termBg} 90%)`,
      rowHoverBg: `color-mix(in srgb, ${termFg} 8%, transparent)`,
      rowActiveBg: `color-mix(in srgb, ${termFg} 14%, transparent)`,
      rowDropBg: `color-mix(in srgb, ${termFg} 20%, transparent)`,
      folderFg: `color-mix(in srgb, ${termFg} 75%, ${termBg} 25%)`,
    };
  }, [resolvedPreviewTheme]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const host of hosts) {
      for (const tag of host.tags ?? []) {
        tags.add(tag);
      }
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [hosts]);

  const tagFilteredHosts = useMemo(() => {
    if (selectedTags.length === 0) return hosts;
    return hosts.filter((host) => selectedTags.some((tag) => host.tags?.includes(tag)));
  }, [hosts, selectedTags]);

  const { groupTree, ungroupedHosts } = useMemo(
    () => buildHostGroupTree(tagFilteredHosts, customGroups),
    [tagFilteredHosts, customGroups],
  );

  const searchTerm = search.trim();
  const searchActive = searchTerm.length > 0;
  const tagsActive = selectedTags.length > 0;
  const treeExpandAll = searchActive || tagsActive;

  const preservePaths = useMemo(() => {
    if (!inlineEdit?.groupPath) return undefined;
    return new Set([inlineEdit.groupPath]);
  }, [inlineEdit?.groupPath]);

  const filteredTree = useMemo(() => {
    let tree = groupTree;
    if (tagsActive) {
      tree = tree
        .map((node) => pruneEmptyGroupNode(node, preservePaths))
        .filter((node): node is GroupNode => node !== null);
    }
    if (!searchActive) return tree;
    return tree
      .map((node) => filterGroupNode(node, searchTerm, preservePaths))
      .filter((node): node is GroupNode => node !== null);
  }, [groupTree, preservePaths, searchActive, searchTerm, tagsActive]);

  const filteredUngrouped = useMemo(() => {
    if (!searchActive) return ungroupedHosts;
    return ungroupedHosts.filter((host) => hostMatchesSearch(host, searchTerm));
  }, [searchActive, searchTerm, ungroupedHosts]);

  const flatRows = useMemo(() => {
    if (!isOpen) return [];
    return flattenHostGroupTree({
      groupNodes: filteredTree,
      ungroupedHosts: filteredUngrouped,
      expandedPaths,
      searchActive: treeExpandAll,
    });
  }, [expandedPaths, filteredTree, filteredUngrouped, isOpen, treeExpandAll]);

  const canDrag = Boolean(menuActions) && !searchActive && !tagsActive;

  const handleNewRootGroup = useCallback(() => {
    if (!menuActions) return;
    setSearch('');
    setSelectedTags([]);
    setExpandedPanel(null);
    menuActions.onNewGroup();
  }, [menuActions]);

  useEffect(() => {
    if (!inlineEdit?.isNew || !inlineEdit.groupPath) return;
    const parentPath = inlineEdit.groupPath.split('/').filter(Boolean).slice(0, -1).join('/');
    if (!parentPath) return;
    ensureAncestorPathsExpanded(parentPath, ensurePathExpanded);
  }, [ensurePathExpanded, inlineEdit?.groupPath, inlineEdit?.isNew]);

  const handleCreateLocalTerminal = useCallback(() => {
    onCreateLocalTerminal?.();
  }, [onCreateLocalTerminal]);

  const allGroupPaths = useMemo(() => collectGroupTreePaths(groupTree), [groupTree]);

  const handleExpandAll = useCallback(() => {
    expandAll(allGroupPaths);
  }, [allGroupPaths, expandAll]);

  const handleCollapseAll = useCallback(() => {
    collapseAll();
  }, [collapseAll]);

  const canExpandCollapse = allGroupPaths.length > 0 && !searchActive && !tagsActive;

  const handleCollapse = useCallback(() => {
    terminalHostTreeStore.setIsOpen(false);
  }, []);

  const clearDragOver = useCallback(() => {
    setDragOverTarget(null);
  }, []);

  const handleDropToParent = useCallback((targetParent: string | null, dataTransfer: DataTransfer) => {
    if (!menuActions) return;
    const hostId = dataTransfer.getData(HOST_TREE_DRAG_HOST_ID);
    const groupPath = dataTransfer.getData(HOST_TREE_DRAG_GROUP_PATH);
    if (hostId) menuActions.moveHostToGroup(hostId, targetParent);
    if (groupPath) menuActions.moveGroup(groupPath, targetParent);
    clearDragOver();
  }, [clearDragOver, menuActions]);

  const handleDragOverTarget = useCallback((target: HostTreeDropTarget) => {
    setDragOverTarget(target);
  }, []);

  const handleDragLeaveRow = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    clearDragOver();
  }, [clearDragOver]);

  const handleRootDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canDrag) return;
    event.preventDefault();
    setDragOverTarget({ kind: 'root' });
  }, [canDrag]);

  const handleRootDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    clearDragOver();
  }, [clearDragOver]);

  const handleRootDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canDrag) return;
    event.preventDefault();
    handleDropToParent(null, event.dataTransfer);
  }, [canDrag, handleDropToParent]);

  useEffect(() => {
    if (!inlineEdit?.shouldScrollIntoView || !inlineEdit.isNew) return;
    const index = flatRows.findIndex(
      (row) => row.kind === 'group' && row.node.path === inlineEdit.groupPath,
    );
    if (index < 0) return;

    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex(index, 'center');
      hostTreeInlineGroupEditStore.markScrollHandled();
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedPaths, flatRows, inlineEdit]);

  const isRowDragOver = useCallback((row: HostTreeFlatRow) => {
    if (!dragOverTarget) return false;
    if (dragOverTarget.kind === 'root') {
      return row.kind === 'host' && !row.host.group;
    }
    if (row.kind === 'group') {
      return dragOverTarget.path === row.node.path;
    }
    return Boolean(row.host.group && row.host.group === dragOverTarget.path);
  }, [dragOverTarget]);

  const renderFlatRow = useCallback((row: HostTreeFlatRow) => (
    <HostTreeFlatRowItem
      row={row}
      activeHostId={activeHostId}
      expandedPaths={expandedPaths}
      searchActive={treeExpandAll}
      canDrag={canDrag}
      isDragOver={isRowDragOver(row)}
      isInlineEditing={row.kind === 'group' && inlineEdit?.groupPath === row.node.path}
      inlineEditInitialName={
        row.kind === 'group' && inlineEdit?.groupPath === row.node.path
          ? inlineEdit.initialName
          : undefined
      }
      onConnect={onConnect}
      onTogglePath={togglePath}
      onDragOverTarget={handleDragOverTarget}
      onDragLeaveRow={handleDragLeaveRow}
      onDropToParent={handleDropToParent}
      theme={theme}
      menuActions={menuActions}
    />
  ), [
    activeHostId,
    canDrag,
    expandedPaths,
    inlineEdit,
    handleDragLeaveRow,
    handleDragOverTarget,
    handleDropToParent,
    isRowDragOver,
    menuActions,
    onConnect,
    treeExpandAll,
    theme,
    togglePath,
  ]);

  const shellTransition = isResizing
    ? 'none'
    : `width ${SIDEBAR_ANIM_MS}ms ${SIDEBAR_ANIM_EASING}`;
  const panelTransition = isResizing
    ? 'none'
    : `opacity ${SIDEBAR_ANIM_MS - 40}ms ease-out, border-color ${SIDEBAR_ANIM_MS}ms ease-out`;

  const handleResizeStart = useCallback((event: React.MouseEvent) => {
    if (!isOpen) return;
    event.preventDefault();
    setIsResizing(true);
    terminalLayoutSuppressStore.begin();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let rafId: number | null = null;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setResizePreviewWidth(next);
      });
    };
    const onMouseUp = (upEvent: MouseEvent) => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWidth + upEvent.clientX - startX),
      );
      setSidebarWidth(next);
      persistSidebarWidth(next);
      setResizePreviewWidth(null);
      setIsResizing(false);
      terminalLayoutSuppressStore.end();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [isOpen, persistSidebarWidth, setSidebarWidth, sidebarWidth]);

  const prevIsOpenRef = useRef(isOpen);

  useEffect(() => {
    if (prevIsOpenRef.current === isOpen) return;
    prevIsOpenRef.current = isOpen;

    const el = shellRef.current;
    if (!el) return;

    terminalLayoutSuppressStore.begin();
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      terminalLayoutSuppressStore.end();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== 'width') return;
      finish();
    };
    el.addEventListener('transitionend', onTransitionEnd);
    const timer = window.setTimeout(finish, SIDEBAR_ANIM_MS + 80);
    return () => {
      el.removeEventListener('transitionend', onTransitionEnd);
      window.clearTimeout(timer);
      finish();
    };
  }, [isOpen]);

  const displayWidth = resizePreviewWidth ?? sidebarWidth;

  useEffect(() => {
    terminalHostTreeStore.setLayoutWidth(isOpen ? displayWidth : 0);
  }, [displayWidth, isOpen]);

  return (
    <div
      ref={shellRef}
      className="relative flex-shrink-0 h-full overflow-hidden"
      style={{
        width: isOpen ? displayWidth : 0,
        transition: shellTransition,
        pointerEvents: isOpen ? 'auto' : 'none',
      }}
      data-section="terminal-host-tree-sidebar-shell"
      data-open={isOpen ? 'true' : 'false'}
    >
      <div
        className="relative flex flex-col h-full"
        style={{
          width: displayWidth,
          opacity: isOpen ? 1 : 0,
          transition: panelTransition,
          backgroundColor: theme.termBg,
          color: theme.termFg,
          borderRight: isOpen ? `1px solid ${theme.separator}` : '1px solid transparent',
        }}
        data-section="terminal-host-tree-sidebar"
      >
        {isOpen && (
          <div
            className="absolute top-0 right-[-3px] h-full w-2 cursor-ew-resize z-30"
            onMouseDown={handleResizeStart}
          />
        )}

        <TerminalHostTreeToolbar
          theme={theme}
          expandedPanel={expandedPanel}
          onExpandedPanelChange={setExpandedPanel}
          search={search}
          onSearchChange={setSearch}
          allTags={allTags}
          selectedTags={selectedTags}
          onSelectedTagsChange={setSelectedTags}
          onNewRootGroup={handleNewRootGroup}
          canNewGroup={Boolean(menuActions)}
          onCreateLocalTerminal={handleCreateLocalTerminal}
          canCreateLocalTerminal={Boolean(onCreateLocalTerminal)}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
          canExpandCollapse={canExpandCollapse}
          onCollapse={handleCollapse}
        />

        <div
          className="flex-1 min-h-0 py-1"
          data-section="terminal-host-tree-sidebar-content"
          style={dragOverTarget?.kind === 'root' ? { backgroundColor: theme.rowDropBg } : undefined}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          {flatRows.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs" style={{ color: theme.mutedFg }}>
              <Server size={24} className="mx-auto mb-2 opacity-50" />
              {t('terminal.layer.hostTree.empty')}
            </div>
          ) : (
            <FixedSizeVirtualList<HostTreeFlatRow>
              ref={listRef}
              items={flatRows}
              itemHeight={TREE_ROW_HEIGHT}
              className="[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
              contentClassName="py-0"
              getItemKey={hostTreeFlatRowKey}
              renderItem={renderFlatRow}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const TerminalHostTreeSidebar = memo(
  TerminalHostTreeSidebarInner,
  (prev, next) => (
    prev.hosts === next.hosts
    && prev.customGroups === next.customGroups
    && prev.resolvedPreviewTheme === next.resolvedPreviewTheme
    && prev.activeHostId === next.activeHostId
    && prev.onConnect === next.onConnect
    && prev.onCreateLocalTerminal === next.onCreateLocalTerminal
  ),
);
TerminalHostTreeSidebar.displayName = 'TerminalHostTreeSidebar';
