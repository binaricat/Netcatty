import { ChevronRight, Folder, FolderOpen, Plus, Server, Settings2 } from 'lucide-react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import {
  hostTreeInlineGroupEditStore,
  useHostTreeInlineGroupEdit,
} from '../../application/state/hostTreeInlineGroupEditStore';
import { useHostTreeInlineHostEdit } from '../../application/state/hostTreeInlineHostEditStore';
import { useVaultHostTreeActions } from '../../application/state/vaultHostTreeActionsStore';
import {
  TERMINAL_HOST_TREE_DEFAULT_WIDTH,
  TERMINAL_HOST_TREE_MAX_WIDTH,
  TERMINAL_HOST_TREE_MIN_WIDTH,
  terminalHostTreeStore,
  useTerminalHostTreeOpen,
} from '../../application/state/terminalHostTreeStore';
import {
  TERMINAL_HOST_TREE_ANIMATION_EASING,
  TERMINAL_HOST_TREE_ANIMATION_MS,
} from '../../application/state/terminalHostTreeAnimation';
import { scheduleChromeLayoutAnimation } from '../../application/state/useActiveChromeTheme';
import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import { useStoredNumber } from '../../application/state/useStoredNumber';
import { useTreeExpandedState } from '../../application/state/useTreeExpandedState';
import { applyHostLabelRename } from '../../domain/host';
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
import { themeFingerprint } from '../../application/state/useActiveChromeTheme';
import { buildHostTreeThemeFromTerminalTheme } from '../../infrastructure/theme/terminalAppearanceTokens';
import { cn } from '../../lib/utils';
import { matchesHostSearchQuery, matchesSearchQuery } from '../../lib/searchMatcher';
import type { GroupConfig, GroupNode, Host, TerminalTheme } from '../../types';
import { HostTreeGroupContextMenuContent, HostTreeHostContextMenuContent } from '../host/HostTreeContextMenus';
import { HostTreeGroupInlineRenameInput } from '../host/HostTreeGroupInlineRenameInput';
import { LazyMessageResponse } from '../ai-elements/LazyMessageResponse';
import { DistroAvatar } from '../DistroAvatar';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';
import { TREE_ROW_HEIGHT } from '../sftp/SftpPaneTreeNode';
import { FixedSizeVirtualList, type FixedSizeVirtualListHandle } from '../ui/FixedSizeVirtualList';
import {
  TerminalHostTreeToolbar,
  type HostTreeToolbarPanel,
} from './TerminalHostTreeToolbar';

const SIDEBAR_MIN_WIDTH = TERMINAL_HOST_TREE_MIN_WIDTH;
const SIDEBAR_DEFAULT_WIDTH = TERMINAL_HOST_TREE_DEFAULT_WIDTH;
const SIDEBAR_MAX_WIDTH = TERMINAL_HOST_TREE_MAX_WIDTH;

const HOST_TREE_DRAG_HOST_ID = 'host-id';
const HOST_TREE_DRAG_GROUP_PATH = 'group-path';

let activeHostTreeDropIndicator: HTMLElement | null = null;

const clearHostTreeDropIndicators = (_root: ParentNode | null) => {
  activeHostTreeDropIndicator?.removeAttribute('data-vault-drop-position');
  activeHostTreeDropIndicator = null;
};

const markHostTreeDropIndicator = (
  target: HTMLElement,
  clientY: number,
) => {
  const rect = target.getBoundingClientRect();
  const position = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  if (target.dataset.vaultDropPosition === position) return;
  clearHostTreeDropIndicators(target.ownerDocument);
  target.dataset.vaultDropPosition = position;
  activeHostTreeDropIndicator = target;
};

const getHostTreeDropZone = (
  target: HTMLElement,
  clientY: number,
): 'before' | 'inside' | 'after' => {
  const rect = target.getBoundingClientRect();
  const offset = clientY - rect.top;
  const edgeSize = Math.max(6, Math.min(12, rect.height * 0.28));
  if (offset <= edgeSize) return 'before';
  if (offset >= rect.height - edgeSize) return 'after';
  return 'inside';
};

const hasDragType = (dataTransfer: DataTransfer, type: string) =>
  Array.from(dataTransfer.types).includes(type);

type HostTreeDropTarget =
  | { kind: 'root' }
  | { kind: 'group'; path: string };

interface TerminalHostTreeSidebarProps {
  enabled?: boolean;
  surfaceVisible?: boolean;
  hosts: Host[];
  customGroups: string[];
  groupConfigs?: GroupConfig[];
  resolvedPreviewTheme: TerminalTheme;
  activeHostId?: string | null;
  onConnect: (host: Host) => void;
  onNewHost?: (defaultGroup?: string) => void;
  onEditHost?: (host: Host) => void;
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

export function isTerminalHostTreeSidebarVisible(
  isOpen: boolean,
  enabled = true,
  surfaceVisible = true,
): boolean {
  return surfaceVisible && enabled && isOpen;
}

export function getTerminalHostTreeSidebarShellStyle(
  isVisible: boolean,
  layoutWidth: number,
  shellTransition: string,
): React.CSSProperties {
  return {
    width: layoutWidth,
    transition: shellTransition,
    pointerEvents: isVisible ? 'auto' : 'none',
  };
}

export function getTerminalHostTreeSidebarPanelStyle({
  isVisible,
  displayWidth,
  panelTransition,
  theme,
}: {
  isVisible: boolean;
  displayWidth: number;
  panelTransition: string;
  theme: HostTreeTheme;
}): React.CSSProperties {
  return {
    width: displayWidth,
    opacity: 1,
    transition: panelTransition,
    backgroundColor: theme.termBg,
    color: theme.termFg,
    borderRight: isVisible ? `1px solid ${theme.separator}` : '1px solid transparent',
  };
}

export function getTerminalHostTreeLayoutTargetWidth(isVisible: boolean, displayWidth: number): number {
  return isVisible ? displayWidth : 0;
}

export function getTerminalHostTreeHiddenSurfaceShellWidth(
  isOpen: boolean,
  enabled: boolean,
  displayWidth: number,
): number {
  return getTerminalHostTreeLayoutTargetWidth(
    isTerminalHostTreeSidebarVisible(isOpen, enabled, true),
    displayWidth,
  );
}

export function getTerminalHostTreeInitialLayoutWidth(): number {
  return 0;
}

export const applyTerminalHostTreeHostRename = applyHostLabelRename;

export function shouldShowTerminalHostHoverCard(
  hoveredHostId: string | null,
  editingHostId: string | null,
): boolean {
  return Boolean(hoveredHostId) && hoveredHostId !== editingHostId;
}

export function getTerminalHostTreeMeasuredLayoutWidth(
  element: Pick<HTMLElement, 'getBoundingClientRect'> | null,
  fallbackWidth: number,
): number {
  const measuredWidth = element?.getBoundingClientRect().width;
  return typeof measuredWidth === 'number' && Number.isFinite(measuredWidth)
    ? Math.max(0, measuredWidth)
    : Math.max(0, fallbackWidth);
}

function hostMatchesSearch(host: Host, search: string): boolean {
  return matchesHostSearchQuery(search, host)
    || matchesSearchQuery(search, host.username, host.notes);
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

const TerminalHostTreeHostHoverCard: React.FC<{ host: Host }> = ({ host }) => {
  const { t } = useI18n();
  const protocol = host.protocol || 'ssh';
  const port = host.port ?? 22;
  const username = host.username?.trim();
  const notes = host.notes?.trim();

  const rows = [
    [t('terminal.layer.hostTree.details.host'), host.hostname],
    [t('terminal.layer.hostTree.details.user'), username],
    [t('terminal.layer.hostTree.details.port'), String(port)],
    [t('terminal.layer.hostTree.details.protocol'), protocol.toUpperCase()],
    [t('terminal.layer.hostTree.details.group'), host.group],
    [t('terminal.layer.hostTree.details.tags'), host.tags?.join(', ')],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <HoverCardContent
      side="right"
      align="start"
      sideOffset={10}
      className="w-72 p-3 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <DistroAvatar
          host={host}
          size="sm"
          fallback={host.label.slice(0, 1).toUpperCase()}
        />
        <div className="flex min-h-6 min-w-0 items-center">
          <div className="truncate text-[15px] font-semibold leading-5">{host.label}</div>
        </div>
      </div>
      <div className="mt-3 space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[82px_minmax(0,1fr)] gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate">{value}</span>
          </div>
        ))}
      </div>
      {notes && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="mb-1 text-muted-foreground">{t('hostDetails.notes.label')}</div>
          <LazyMessageResponse className="host-tree-notes-scroll max-h-[min(44vh,420px)] overflow-y-auto pr-2 text-xs leading-relaxed text-popover-foreground/90 [&_h1]:text-sm [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-sm [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:mt-1.5 [&_h3]:mb-1 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1">
            {notes}
          </LazyMessageResponse>
        </div>
      )}
    </HoverCardContent>
  );
};

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
  onNewHost?: (defaultGroup?: string) => void;
  onEditHost?: (host: Host) => void;
  onTogglePath: (path: string) => void;
  onDragOverTarget: (target: HostTreeDropTarget) => void;
  onClearDragOverTarget: () => void;
  onDragLeaveRow: (event: React.DragEvent<HTMLDivElement>) => void;
  onDropToParent: (targetParent: string | null, dataTransfer: DataTransfer) => void;
  onDropToRow: (row: HostTreeFlatRow, event: React.DragEvent<HTMLDivElement>) => boolean;
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
  onNewHost,
  onEditHost,
  onTogglePath,
  onDragOverTarget,
  onClearDragOverTarget,
  onDragLeaveRow,
  onDropToParent,
  onDropToRow,
  theme,
  menuActions,
}) => {
  const { t } = useI18n();

  if (row.kind === 'host') {
    const isActive = activeHostId === row.host.id;
    const hostDropParent = row.host.group || null;
    const canShowHoverCard = shouldShowTerminalHostHoverCard(
      row.host.id,
      isInlineEditing ? row.host.id : null,
    );
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
          'vault-drop-indicator-row flex min-w-0 items-center gap-1 px-2 cursor-pointer select-none text-sm',
        )}
        style={{
          height: TREE_ROW_HEIGHT,
          paddingLeft: row.depth * 16 + 8,
          backgroundColor: isActive ? theme.rowActiveBg : (isDragOver ? theme.rowDropBg : undefined),
        }}
        draggable={canDrag && !isInlineEditing}
        onDragStart={(event) => {
          if (!canDrag || isInlineEditing) return;
          event.dataTransfer.setData(HOST_TREE_DRAG_HOST_ID, row.host.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          if (!canDrag) return;
          event.preventDefault();
          event.stopPropagation();
          if (hasDragType(event.dataTransfer, HOST_TREE_DRAG_HOST_ID)) {
            markHostTreeDropIndicator(event.currentTarget, event.clientY);
            onClearDragOverTarget();
          } else {
            clearHostTreeDropIndicators(event.currentTarget.ownerDocument);
            onDragOverTarget(hostDropParent ? { kind: 'group', path: hostDropParent } : { kind: 'root' });
          }
        }}
        onDragLeave={onDragLeaveRow}
        onDrop={(event) => {
          if (!canDrag) return;
          event.preventDefault();
          event.stopPropagation();
          clearHostTreeDropIndicators(event.currentTarget.ownerDocument);
          if (onDropToRow(row, event)) return;
          onDropToParent(hostDropParent, event.dataTransfer);
        }}
        onDragEnd={(event) => clearHostTreeDropIndicators(event.currentTarget.ownerDocument)}
        onMouseEnter={(event) => {
          if (!isActive && !isDragOver) event.currentTarget.style.backgroundColor = theme.rowHoverBg;
        }}
        onMouseLeave={(event) => {
          if (!isActive && !isDragOver) event.currentTarget.style.backgroundColor = '';
        }}
        onDoubleClick={() => {
          if (!isInlineEditing) onConnect(row.host);
        }}
        onKeyDown={(event) => {
          if (isInlineEditing) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onConnect(row.host);
          }
        }}
      >
        <span className="flex h-5 w-4 shrink-0 items-center" />
        <span className="flex h-5 shrink-0 items-center justify-center">
          <DistroAvatar host={row.host} size="xs" fallback={row.host.label.slice(0, 1).toUpperCase()} />
        </span>
        {isInlineEditing && menuActions && inlineEditInitialName ? (
          <HostTreeGroupInlineRenameInput
            initialName={inlineEditInitialName}
            onCommit={menuActions.commitInlineHostRename}
            onCancel={menuActions.cancelInlineHostEdit}
            className="flex-1 font-medium"
            style={{ color: theme.termFg }}
          />
        ) : (
          <span
            className="flex min-w-0 flex-1 items-center truncate leading-5"
            style={{ color: theme.termFg }}
          >
            {row.host.label}
          </span>
        )}
        {row.host.protocol && row.host.protocol !== 'ssh' && (
          <span className="flex shrink-0 items-center text-[10px] leading-4 uppercase opacity-70" style={{ color: theme.mutedFg }}>
            {row.host.protocol}
          </span>
        )}
      </div>
    );

    if (!menuActions && !onEditHost) return rowBody;

    return (
      <HoverCard openDelay={650} closeDelay={80}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <HoverCardTrigger asChild>
              {rowBody}
            </HoverCardTrigger>
          </ContextMenuTrigger>
          {menuActions ? (
            <HostTreeHostContextMenuContent
              host={row.host}
              onConnect={onConnect}
              onEditHost={onEditHost}
              onRenameHost={menuActions.onRenameHost}
              onDuplicateHost={menuActions.onDuplicateHost}
              onCopyCredentials={menuActions.onCopyCredentials}
              onDeleteHost={menuActions.onDeleteHost}
            />
          ) : (
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onConnect(row.host)}>
                <Server className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onEditHost?.(row.host)}>
                <Settings2 className="mr-2 h-4 w-4" /> {t('terminal.layer.hostTree.editHost')}
              </ContextMenuItem>
            </ContextMenuContent>
          )}
        </ContextMenu>
        {canShowHoverCard && <TerminalHostTreeHostHoverCard host={row.host} />}
      </HoverCard>
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
        'vault-drop-indicator-row flex min-w-0 items-center gap-1 px-2 cursor-pointer select-none text-sm font-medium',
      )}
      style={{
        height: TREE_ROW_HEIGHT,
        paddingLeft: depth * 16 + 8,
        color: theme.termFg,
        backgroundColor: isDragOver ? theme.rowDropBg : undefined,
      }}
      draggable={canDrag && !isInlineEditing}
      onDragStart={(event) => {
        if (!canDrag || isInlineEditing) return;
        event.dataTransfer.setData(HOST_TREE_DRAG_GROUP_PATH, node.path);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(event) => {
        if (!canDrag) return;
        event.preventDefault();
        event.stopPropagation();
        const isDraggingGroup = hasDragType(event.dataTransfer, HOST_TREE_DRAG_GROUP_PATH);
        const zone = getHostTreeDropZone(event.currentTarget, event.clientY);
        if (isDraggingGroup && zone !== 'inside') {
          onClearDragOverTarget();
          markHostTreeDropIndicator(event.currentTarget, event.clientY);
          return;
        }
        clearHostTreeDropIndicators(event.currentTarget.ownerDocument);
        onDragOverTarget({ kind: 'group', path: node.path });
      }}
      onDragLeave={onDragLeaveRow}
      onDrop={(event) => {
        if (!canDrag) return;
        event.preventDefault();
        event.stopPropagation();
        clearHostTreeDropIndicators(event.currentTarget.ownerDocument);
        const isDraggingGroup = hasDragType(event.dataTransfer, HOST_TREE_DRAG_GROUP_PATH);
        const zone = getHostTreeDropZone(event.currentTarget, event.clientY);
        if (isDraggingGroup && zone !== 'inside' && onDropToRow(row, event)) return;
        onDropToParent(node.path, event.dataTransfer);
      }}
      onDragEnd={(event) => clearHostTreeDropIndicators(event.currentTarget.ownerDocument)}
      onMouseEnter={(event) => {
        if (!isDragOver) event.currentTarget.style.backgroundColor = theme.rowHoverBg;
      }}
      onMouseLeave={(event) => {
        if (!isDragOver) event.currentTarget.style.backgroundColor = '';
      }}
      onClick={() => {
        if (isInlineEditing) return;
        onTogglePath(node.path);
      }}
      onKeyDown={(event) => {
        if (isInlineEditing) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onTogglePath(node.path);
        }
      }}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {(hasChildren || hasHosts) && (
          <ChevronRight
            size={14}
            className={cn('transition-transform', isExpanded && 'rotate-90')}
            style={{ color: theme.mutedFg }}
          />
        )}
      </span>
      <span className="flex h-5 shrink-0 items-center">
        {isExpanded
          ? <FolderOpen size={14} className="shrink-0" style={{ color: theme.folderFg }} />
          : <Folder size={14} className="shrink-0" style={{ color: theme.folderFg }} />}
      </span>
      {isInlineEditing && menuActions && inlineEditInitialName ? (
        <HostTreeGroupInlineRenameInput
          initialName={inlineEditInitialName}
          onCommit={menuActions.commitInlineGroupRename}
          onCancel={menuActions.cancelInlineGroupEdit}
          className="flex-1 font-medium"
          style={{ color: theme.termFg }}
        />
      ) : (
        <span className="flex min-w-0 flex-1 items-center truncate leading-5">{node.name}</span>
      )}
    </div>
  );

  if (!menuActions && !onNewHost) return rowBody;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {rowBody}
      </ContextMenuTrigger>
      {menuActions ? (
        <HostTreeGroupContextMenuContent
          groupPath={node.path}
          isManaged={isManaged}
          onNewHost={(groupPath) => onNewHost?.(groupPath)}
          onNewGroup={menuActions.onNewGroup}
          onRenameGroup={menuActions.onRenameGroup}
          onDeleteGroup={menuActions.onDeleteGroup}
          onUnmanageGroup={menuActions.onUnmanageGroup}
        />
      ) : (
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onNewHost?.(node.path)}>
            <Plus className="mr-2 h-4 w-4" /> {t('terminal.layer.hostTree.newHostInGroup')}
          </ContextMenuItem>
        </ContextMenuContent>
      )}
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
  if (prev.onClearDragOverTarget !== next.onClearDragOverTarget) return false;
  if (prev.onDragLeaveRow !== next.onDragLeaveRow) return false;
  if (prev.onDropToParent !== next.onDropToParent) return false;
  if (prev.onDropToRow !== next.onDropToRow) return false;
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
  enabled = true,
  surfaceVisible = true,
  hosts,
  customGroups,
  groupConfigs = [],
  resolvedPreviewTheme,
  activeHostId,
  onConnect,
  onNewHost,
  onEditHost,
  onCreateLocalTerminal,
}) => {
  const { t } = useI18n();
  const isOpen = useTerminalHostTreeOpen();
  const isVisible = isTerminalHostTreeSidebarVisible(isOpen, enabled, surfaceVisible);
  const [search, setSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [expandedPanel, setExpandedPanel] = useState<HostTreeToolbarPanel>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [resizePreviewWidth, setResizePreviewWidth] = useState<number | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<HostTreeDropTarget | null>(null);
  const [rootContextMenuOpen, setRootContextMenuOpen] = useState(false);
  const rootContextMenuAllowedRef = useRef(false);
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
  const inlineHostEdit = useHostTreeInlineHostEdit();
  const listRef = useRef<FixedSizeVirtualListHandle>(null);

  const theme = useMemo(
    () => buildHostTreeThemeFromTerminalTheme(resolvedPreviewTheme),
    [resolvedPreviewTheme],
  );

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
    () => buildHostGroupTree(tagFilteredHosts, customGroups, groupConfigs),
    [tagFilteredHosts, customGroups, groupConfigs],
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
    return flattenHostGroupTree({
      groupNodes: filteredTree,
      ungroupedHosts: filteredUngrouped,
      expandedPaths,
      searchActive: treeExpandAll,
    });
  }, [expandedPaths, filteredTree, filteredUngrouped, treeExpandAll]);

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

  const handleDropToRow = useCallback((row: HostTreeFlatRow, event: React.DragEvent<HTMLDivElement>) => {
    if (!menuActions) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    if (row.kind === 'host') {
      const hostId = event.dataTransfer.getData(HOST_TREE_DRAG_HOST_ID);
      if (hostId && hostId !== row.host.id) {
        menuActions.reorderHost(hostId, row.host.id, position);
        clearDragOver();
        return true;
      }
      return false;
    }

    const groupPath = event.dataTransfer.getData(HOST_TREE_DRAG_GROUP_PATH);
    if (groupPath && groupPath !== row.node.path) {
      const handled = menuActions.reorderGroup(groupPath, row.node.path, position);
      if (handled) {
        clearDragOver();
        return true;
      }
    }
    return false;
  }, [clearDragOver, menuActions]);

  const handleDragOverTarget = useCallback((target: HostTreeDropTarget) => {
    setDragOverTarget(target);
  }, []);

  const handleDragLeaveRow = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    clearHostTreeDropIndicators(event.currentTarget.ownerDocument);
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
    clearHostTreeDropIndicators(event.currentTarget.ownerDocument);
    clearDragOver();
  }, [clearDragOver]);

  const handleRootDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canDrag) return;
    event.preventDefault();
    clearHostTreeDropIndicators(event.currentTarget.ownerDocument);
    handleDropToParent(null, event.dataTransfer);
  }, [canDrag, handleDropToParent]);

  const handleListPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!menuActions) return;
    const editingGroupPath = inlineEdit?.groupPath;
    const editingHostId = inlineHostEdit?.hostId;
    if (!editingGroupPath && !editingHostId) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-inline-group-edit="true"]')) return;
    const row = target.closest('[data-section="terminal-host-tree-sidebar-row"]');
    if (!row) return;
    if (editingGroupPath && row.getAttribute('data-group-path') === editingGroupPath) return;
    if (editingHostId && row.getAttribute('data-host-id') === editingHostId) return;

    if (editingGroupPath) menuActions.cancelInlineGroupEdit();
    if (editingHostId) menuActions.cancelInlineHostEdit();
  }, [inlineEdit?.groupPath, inlineHostEdit?.hostId, menuActions]);

  const handleRootContextMenuCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    rootContextMenuAllowedRef.current = target instanceof Element
      && !target.closest('[data-row-type]');
  }, []);

  const handleRootContextMenuOpenChange = useCallback((open: boolean) => {
    setRootContextMenuOpen(open && rootContextMenuAllowedRef.current);
    if (!open) rootContextMenuAllowedRef.current = false;
  }, []);

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
      isInlineEditing={
        (row.kind === 'group' && inlineEdit?.groupPath === row.node.path)
        || (row.kind === 'host' && inlineHostEdit?.hostId === row.host.id)
      }
      inlineEditInitialName={
        row.kind === 'group' && inlineEdit?.groupPath === row.node.path
          ? inlineEdit.initialName
          : row.kind === 'host' && inlineHostEdit?.hostId === row.host.id
            ? inlineHostEdit.initialName
            : undefined
      }
      onConnect={onConnect}
      onNewHost={onNewHost}
      onEditHost={onEditHost}
      onTogglePath={togglePath}
      onDragOverTarget={handleDragOverTarget}
      onClearDragOverTarget={clearDragOver}
      onDragLeaveRow={handleDragLeaveRow}
      onDropToParent={handleDropToParent}
      onDropToRow={handleDropToRow}
      theme={theme}
      menuActions={menuActions}
    />
  ), [
    activeHostId,
    canDrag,
    clearDragOver,
    expandedPaths,
    inlineEdit,
    inlineHostEdit,
    handleDragLeaveRow,
    handleDragOverTarget,
    handleDropToParent,
    handleDropToRow,
    isRowDragOver,
    menuActions,
    onConnect,
    onNewHost,
    onEditHost,
    treeExpandAll,
    theme,
    togglePath,
  ]);

  const shellTransition = isResizing || !surfaceVisible
    ? 'none'
    : `width ${TERMINAL_HOST_TREE_ANIMATION_MS}ms ${TERMINAL_HOST_TREE_ANIMATION_EASING}`;
  const panelTransition = isResizing
    ? 'none'
    : `border-color ${TERMINAL_HOST_TREE_ANIMATION_MS}ms ease-out`;

  const handleResizeStart = useCallback((event: React.MouseEvent) => {
    if (!isVisible) return;
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
  }, [isVisible, persistSidebarWidth, setSidebarWidth, sidebarWidth]);

  const displayWidth = resizePreviewWidth ?? sidebarWidth;
  const canExpandCollapse = allGroupPaths.length > 0 && !searchActive && !tagsActive;
  const targetLayoutWidth = getTerminalHostTreeLayoutTargetWidth(isVisible, displayWidth);
  const hiddenSurfaceShellWidth = getTerminalHostTreeHiddenSurfaceShellWidth(isOpen, enabled, displayWidth);
  const [shellWidth, setShellWidth] = useState(getTerminalHostTreeInitialLayoutWidth);
  const cancelSyncLayoutWidthRef = useRef<(() => void) | null>(null);
  const prevIsVisibleRef = useRef(isVisible);

  const syncLayoutWidthFromShell = useCallback((fallbackWidth = targetLayoutWidth) => {
    terminalHostTreeStore.setLayoutWidth(
      getTerminalHostTreeMeasuredLayoutWidth(shellRef.current, fallbackWidth),
    );
  }, [targetLayoutWidth]);

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      if (isResizing) return;
      syncLayoutWidthFromShell();
    });
    ro.observe(el);
    syncLayoutWidthFromShell();

    return () => ro.disconnect();
  }, [isResizing, syncLayoutWidthFromShell]);

  useEffect(() => {
    if (prevIsVisibleRef.current === isVisible) return;
    prevIsVisibleRef.current = isVisible;

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
      syncLayoutWidthFromShell();
      finish();
    };
    el.addEventListener('transitionend', onTransitionEnd);
    const timer = window.setTimeout(() => {
      syncLayoutWidthFromShell();
      finish();
    }, TERMINAL_HOST_TREE_ANIMATION_MS + 80);
    return () => {
      el.removeEventListener('transitionend', onTransitionEnd);
      window.clearTimeout(timer);
      finish();
    };
  }, [isVisible, syncLayoutWidthFromShell]);

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;

    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== 'width' || isResizing) return;
      syncLayoutWidthFromShell();
    };
    el.addEventListener('transitionend', onTransitionEnd);
    return () => el.removeEventListener('transitionend', onTransitionEnd);
  }, [isResizing, syncLayoutWidthFromShell]);

  useEffect(() => {
    cancelSyncLayoutWidthRef.current?.();
    cancelSyncLayoutWidthRef.current = null;

    if (isResizing) {
      setShellWidth(targetLayoutWidth);
      terminalHostTreeStore.setLayoutWidth(targetLayoutWidth);
      return;
    }

    if (!surfaceVisible) {
      setShellWidth(hiddenSurfaceShellWidth);
      terminalHostTreeStore.setLayoutWidth(0);
      return;
    }

    syncLayoutWidthFromShell();
    cancelSyncLayoutWidthRef.current = scheduleChromeLayoutAnimation(() => {
      cancelSyncLayoutWidthRef.current = null;
      setShellWidth(targetLayoutWidth);
    });

    return () => {
      cancelSyncLayoutWidthRef.current?.();
      cancelSyncLayoutWidthRef.current = null;
    };
  }, [hiddenSurfaceShellWidth, isResizing, surfaceVisible, syncLayoutWidthFromShell, targetLayoutWidth]);

  return (
    <div
      ref={shellRef}
      className="relative flex-shrink-0 h-full overflow-hidden"
      style={getTerminalHostTreeSidebarShellStyle(isVisible, shellWidth, shellTransition)}
      data-section="terminal-host-tree-sidebar-shell"
      data-open={isVisible ? 'true' : 'false'}
      data-enabled={enabled ? 'true' : 'false'}
    >
      <div
        className="relative flex flex-col h-full"
        style={getTerminalHostTreeSidebarPanelStyle({
          isVisible,
          displayWidth,
          panelTransition,
          theme,
        })}
        data-section="terminal-host-tree-sidebar"
      >
        {isVisible && (
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
          onNewHost={() => onNewHost?.()}
          canNewHost={Boolean(onNewHost)}
          onNewRootGroup={handleNewRootGroup}
          canNewGroup={Boolean(menuActions)}
          onCreateLocalTerminal={handleCreateLocalTerminal}
          canCreateLocalTerminal={Boolean(onCreateLocalTerminal)}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
          canExpandCollapse={canExpandCollapse}
          onCollapse={handleCollapse}
        />

        <ContextMenu open={rootContextMenuOpen} onOpenChange={handleRootContextMenuOpenChange}>
          <ContextMenuTrigger asChild>
            <div
              className="flex-1 min-h-0 py-1"
              data-section="terminal-host-tree-sidebar-content"
              style={dragOverTarget?.kind === 'root' ? { backgroundColor: theme.rowDropBg } : undefined}
              onContextMenuCapture={handleRootContextMenuCapture}
              onPointerDownCapture={handleListPointerDownCapture}
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
          </ContextMenuTrigger>
          <ContextMenuContent data-section="terminal-host-tree-root-context">
            <ContextMenuItem onClick={() => onNewHost?.()}>
              <Plus className="mr-2 h-4 w-4" /> {t('terminal.layer.hostTree.newHost')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </div>
  );
};

export const TerminalHostTreeSidebar = memo(
  TerminalHostTreeSidebarInner,
  (prev, next) => (
    prev.hosts === next.hosts
    && prev.enabled === next.enabled
    && prev.surfaceVisible === next.surfaceVisible
    && prev.customGroups === next.customGroups
    && prev.activeHostId === next.activeHostId
    && themeFingerprint(prev.resolvedPreviewTheme) === themeFingerprint(next.resolvedPreviewTheme)
    && prev.onConnect === next.onConnect
    && prev.onNewHost === next.onNewHost
    && prev.onEditHost === next.onEditHost
    && prev.onCreateLocalTerminal === next.onCreateLocalTerminal
  ),
);
TerminalHostTreeSidebar.displayName = 'TerminalHostTreeSidebar';
