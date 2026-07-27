import { CheckSquare, Edit2, FileSymlink, Server, Square, Expand, Minimize2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import {
  hostTreeInlineGroupEditStore,
  useHostTreeInlineGroupEdit,
} from '../application/state/hostTreeInlineGroupEditStore';
import { useVaultHostTreeActions } from '../application/state/vaultHostTreeActionsStore';
import { useTreeExpandedState } from '../application/state/useTreeExpandedState';
import { applyGroupDefaults, resolveGroupDefaults } from '../domain/groupConfig';
import { resolveTelnetPort, resolveTelnetUsername, sanitizeHost } from '../domain/host';
import {
  resolveHostActivateAction,
  type HostClickBehavior,
} from '../domain/hostClickBehavior';
import { sortByVaultOrder } from '../domain/vaultOrder';
import { STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED } from '../infrastructure/config/storageKeys';
import { GroupConfig, GroupNode, Host } from '../types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { HostTreeGroupContextMenuContent, HostTreeHostContextMenuContent } from './host/HostTreeContextMenus';
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu';
import { DistroAvatar } from './DistroAvatar';
import { HostNotesIndicator } from './host/HostNotesIndicator';
import { Button } from './ui/button';
import { VaultTreeGroupRow, VaultTreeItemRow } from './vault/VaultTreeRow';

const getTreeGroupDropIntent = (
  element: HTMLElement,
  clientY: number,
): 'before' | 'inside' | 'after' => {
  const rect = element.getBoundingClientRect();
  const edgeSize = Math.max(8, Math.min(14, rect.height * 0.28));
  if (clientY <= rect.top + edgeSize) return 'before';
  if (clientY >= rect.bottom - edgeSize) return 'after';
  return 'inside';
};

const hasDragType = (dataTransfer: DataTransfer, type: string) =>
  Array.from(dataTransfer.types).includes(type);

type HostTreeSortMode = 'manual' | 'az' | 'za' | 'newest' | 'oldest' | 'group';

export type VisibleHostTreeItem =
  | {
    kind: 'group';
    key: string;
    depth: number;
    node: GroupNode;
    posInSet: number;
    setSize: number;
  }
  | {
    kind: 'host';
    key: string;
    depth: number;
    host: Host;
    posInSet: number;
    setSize: number;
  };

const sortHostTreeGroups = (
  nodes: GroupNode[],
  sortMode: HostTreeSortMode,
  groupConfigs: GroupConfig[],
): GroupNode[] => {
  const originalIndex = new Map(nodes.map((node, index) => [node.path, index]));
  const orderByPath = new Map(
    groupConfigs
      .filter((config) => typeof config.order === 'number' && Number.isFinite(config.order))
      .map((config) => [config.path, config.order as number]),
  );
  return [...nodes].sort((a, b) => {
    if (sortMode === 'za') return b.name.localeCompare(a.name);
    if (sortMode === 'manual') {
      const orderA = orderByPath.get(a.path);
      const orderB = orderByPath.get(b.path);
      if (orderA !== undefined && orderB !== undefined && orderA !== orderB) return orderA - orderB;
      if (orderA !== undefined) return -1;
      if (orderB !== undefined) return 1;
      return (originalIndex.get(a.path) ?? 0) - (originalIndex.get(b.path) ?? 0);
    }
    return a.name.localeCompare(b.name);
  });
};

const sortHostTreeHosts = (hosts: Host[], sortMode: HostTreeSortMode): Host[] => {
  const sorted = [...hosts].sort((a, b) => {
    if (sortMode === 'za') return b.label.localeCompare(a.label);
    if (sortMode === 'newest') return (b.createdAt || 0) - (a.createdAt || 0);
    if (sortMode === 'oldest') return (a.createdAt || 0) - (b.createdAt || 0);
    if (sortMode === 'manual') return 0;
    return a.label.localeCompare(b.label);
  });
  return sortMode === 'manual' ? sortByVaultOrder(sorted) : sorted;
};

export function buildVisibleHostTreeItems({
  groupTree,
  ungroupedHosts,
  expandedPaths,
  sortMode,
  groupConfigs,
}: {
  groupTree: GroupNode[];
  ungroupedHosts: Host[];
  expandedPaths: Set<string>;
  sortMode: HostTreeSortMode;
  groupConfigs: GroupConfig[];
}): VisibleHostTreeItem[] {
  const items: VisibleHostTreeItem[] = [];
  const visitGroups = (nodes: GroupNode[], depth: number) => {
    const sortedGroups = sortHostTreeGroups(nodes, sortMode, groupConfigs);
    // Root-level ungrouped hosts are siblings of top-level groups.
    const rootUngrouped = depth === 0 ? sortHostTreeHosts(ungroupedHosts, sortMode) : [];
    const siblingSetSize = sortedGroups.length + rootUngrouped.length;
    sortedGroups.forEach((node, groupIndex) => {
      items.push({
        kind: 'group',
        key: `group:${node.path}`,
        depth,
        node,
        posInSet: groupIndex + 1,
        setSize: siblingSetSize,
      });
      if (!expandedPaths.has(node.path)) return;
      const childGroups = sortHostTreeGroups(
        Object.values(node.children ?? {}) as GroupNode[],
        sortMode,
        groupConfigs,
      );
      const childHosts = sortHostTreeHosts(node.hosts, sortMode);
      const childSetSize = childGroups.length + childHosts.length;
      // Recurse for nested groups first so expanded descendants stay contiguous
      // under each child group, then emit this node's direct host siblings.
      visitChildGroups(childGroups, depth + 1, childSetSize);
      childHosts.forEach((host, hostIndex) => {
        items.push({
          kind: 'host',
          key: `host:${host.id}`,
          depth: depth + 1,
          host,
          posInSet: childGroups.length + hostIndex + 1,
          setSize: childSetSize,
        });
      });
    });
    if (depth === 0) {
      rootUngrouped.forEach((host, hostIndex) => {
        items.push({
          kind: 'host',
          key: `host:${host.id}`,
          depth: 0,
          host,
          posInSet: sortedGroups.length + hostIndex + 1,
          setSize: siblingSetSize,
        });
      });
    }
  };
  const visitChildGroups = (
    sortedGroups: GroupNode[],
    depth: number,
    siblingSetSize: number,
  ) => {
    sortedGroups.forEach((node, groupIndex) => {
      items.push({
        kind: 'group',
        key: `group:${node.path}`,
        depth,
        node,
        posInSet: groupIndex + 1,
        setSize: siblingSetSize,
      });
      if (!expandedPaths.has(node.path)) return;
      const childGroups = sortHostTreeGroups(
        Object.values(node.children ?? {}) as GroupNode[],
        sortMode,
        groupConfigs,
      );
      const childHosts = sortHostTreeHosts(node.hosts, sortMode);
      const childSetSize = childGroups.length + childHosts.length;
      visitChildGroups(childGroups, depth + 1, childSetSize);
      childHosts.forEach((host, hostIndex) => {
        items.push({
          kind: 'host',
          key: `host:${host.id}`,
          depth: depth + 1,
          host,
          posInSet: childGroups.length + hostIndex + 1,
          setSize: childSetSize,
        });
      });
    });
  };
  visitGroups(groupTree, 0);
  return items;
}

export function useHostTreeExpandedPaths({
  persistentExpandedPaths,
  allGroupPaths,
  autoExpandGroupsKey,
  onTogglePath,
  onExpandAll,
  onCollapseAll,
}: {
  persistentExpandedPaths: Set<string>;
  allGroupPaths: string[];
  autoExpandGroupsKey?: string;
  onTogglePath: (path: string) => void;
  onExpandAll: (paths: string[]) => void;
  onCollapseAll: () => void;
}) {
  const [temporaryExpandedPaths, setTemporaryExpandedPaths] = useState<Set<string> | null>(null);
  const lastAutoExpandGroupsKeyRef = useRef<string | undefined>(undefined);
  const lastAutoExpandGroupPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!autoExpandGroupsKey) {
      lastAutoExpandGroupsKeyRef.current = undefined;
      lastAutoExpandGroupPathsRef.current = new Set();
      setTemporaryExpandedPaths(null);
      return;
    }
    const nextGroupPaths = new Set(allGroupPaths);
    if (lastAutoExpandGroupsKeyRef.current !== autoExpandGroupsKey) {
      lastAutoExpandGroupsKeyRef.current = autoExpandGroupsKey;
      lastAutoExpandGroupPathsRef.current = nextGroupPaths;
      setTemporaryExpandedPaths(nextGroupPaths);
      return;
    }
    const newlyVisiblePaths = allGroupPaths.filter(
      (path) => !lastAutoExpandGroupPathsRef.current.has(path),
    );
    lastAutoExpandGroupPathsRef.current = nextGroupPaths;
    if (newlyVisiblePaths.length === 0) return;
    setTemporaryExpandedPaths((current) => new Set([
      ...(current ?? []),
      ...newlyVisiblePaths,
    ]));
  }, [allGroupPaths, autoExpandGroupsKey]);

  const togglePath = useCallback((path: string) => {
    if (temporaryExpandedPaths === null) {
      onTogglePath(path);
      return;
    }
    setTemporaryExpandedPaths((current) => {
      const next = new Set(current ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [onTogglePath, temporaryExpandedPaths]);
  const expandAll = useCallback((paths: string[]) => {
    if (temporaryExpandedPaths === null) onExpandAll(paths);
    else setTemporaryExpandedPaths(new Set(paths));
  }, [onExpandAll, temporaryExpandedPaths]);
  const collapseAll = useCallback(() => {
    if (temporaryExpandedPaths === null) onCollapseAll();
    else setTemporaryExpandedPaths(new Set());
  }, [onCollapseAll, temporaryExpandedPaths]);

  return {
    expandedPaths: temporaryExpandedPaths ?? persistentExpandedPaths,
    togglePath,
    expandAll,
    collapseAll,
  };
}

interface HostTreeViewProps {
  groupTree: GroupNode[];
  hosts: Host[];
  sortMode?: HostTreeSortMode;
  expandedPaths?: Set<string>;
  onTogglePath?: (path: string) => void;
  onExpandAll?: (paths: string[]) => void;
  onCollapseAll?: () => void;
  onConnect: (host: Host) => void;
  onEditHost: (host: Host) => void;
  onDuplicateHost: (host: Host) => void;
  onDeleteHost: (host: Host) => void;
  onCopyCredentials: (host: Host) => void;
  onNewGroup: (parentPath?: string) => void;
  onRenameGroup: (groupPath: string) => void;
  onEditGroup: (groupPath: string) => void;
  onDeleteGroup: (groupPath: string) => void;
  moveHostToGroup: (hostId: string, groupPath: string | null) => void;
  moveGroup: (sourcePath: string, targetParent: string | null) => void;
  commitInlineGroupRename?: (name: string) => void;
  cancelInlineGroupEdit?: () => void;
  managedGroupPaths?: Set<string>;
  onUnmanageGroup?: (groupPath: string) => void;

  isMultiSelectMode?: boolean;
  selectedHostIds?: Set<string>;
  selectedGroupPaths?: Set<string>;
  toggleHostSelection?: (hostId: string) => void;
  toggleGroupSelection?: (groupPath: string) => void;
  hostClickBehavior?: HostClickBehavior;
  focusedHostId?: string | null;
  onFocusHost?: (hostId: string | null) => void;
  focusedGroupPath?: string | null;
  onFocusGroup?: (groupPath: string | null) => void;
  getDropTargetClasses?: (target: string) => string;
  setDragOverDropTarget?: (target: string | null) => void;
  groupConfigs?: GroupConfig[];
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  autoExpandGroupsKey?: string;
}

interface TreeNodeProps {
  node: GroupNode;
  depth: number;
  sortMode: HostTreeSortMode;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  onConnect: (host: Host) => void;
  onEditHost: (host: Host) => void;
  onDuplicateHost: (host: Host) => void;
  onDeleteHost: (host: Host) => void;
  onCopyCredentials: (host: Host) => void;
  onNewGroup: (parentPath?: string) => void;
  onRenameGroup: (groupPath: string) => void;
  onEditGroup: (groupPath: string) => void;
  onDeleteGroup: (groupPath: string) => void;
  moveHostToGroup: (hostId: string, groupPath: string | null) => void;
  moveGroup: (sourcePath: string, targetParent: string | null) => void;
  commitInlineGroupRename?: (name: string) => void;
  cancelInlineGroupEdit?: () => void;
  managedGroupPaths?: Set<string>;
  onUnmanageGroup?: (groupPath: string) => void;

  isMultiSelectMode?: boolean;
  selectedHostIds?: Set<string>;
  selectedGroupPaths?: Set<string>;
  toggleHostSelection?: (hostId: string) => void;
  toggleGroupSelection?: (groupPath: string) => void;
  hostClickBehavior?: HostClickBehavior;
  focusedHostId?: string | null;
  onFocusHost?: (hostId: string | null) => void;
  focusedGroupPath?: string | null;
  onFocusGroup?: (groupPath: string | null) => void;
  getDropTargetClasses?: (target: string) => string;
  setDragOverDropTarget?: (target: string | null) => void;
  groupConfigs: GroupConfig[];
  groupDefaultsByPath: ReadonlyMap<string, Partial<GroupConfig>>;
  activeTreeItemKey: string | null;
  initialTreeItemKey: string | null;
  onActiveTreeItemChange: (key: string) => void;
  renderDescendants?: boolean;
  treePosInSet?: number;
  treeSetSize?: number;
}


const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  depth,
  sortMode,
  expandedPaths,
  onToggle,
  onConnect,
  onEditHost,
  onDuplicateHost,
  onDeleteHost,
  onCopyCredentials,
  onNewGroup,
  onRenameGroup,
  onEditGroup,
  onDeleteGroup,
  moveHostToGroup,
  moveGroup,
  managedGroupPaths,
  onUnmanageGroup,
  commitInlineGroupRename,
  cancelInlineGroupEdit,

  isMultiSelectMode,
  selectedHostIds,
  selectedGroupPaths,
  toggleHostSelection,
  toggleGroupSelection,
  hostClickBehavior = 'connect',
  focusedHostId,
  onFocusHost,
  focusedGroupPath,
  onFocusGroup,
  getDropTargetClasses,
  setDragOverDropTarget,
  groupConfigs,
  groupDefaultsByPath,
  activeTreeItemKey,
  initialTreeItemKey,
  onActiveTreeItemChange,
  renderDescendants = true,
  treePosInSet,
  treeSetSize,
}) => {
  const inlineEdit = useHostTreeInlineGroupEdit();
  const vaultTreeActions = useVaultHostTreeActions();
  const commitRename = commitInlineGroupRename ?? vaultTreeActions?.commitInlineGroupRename;
  const cancelRename = cancelInlineGroupEdit ?? vaultTreeActions?.cancelInlineGroupEdit;
  const isInlineEditing = inlineEdit?.groupPath === node.path;
  const groupRowRef = useRef<HTMLDivElement>(null);
  const isExpanded = expandedPaths.has(node.path);
  const isGroupFocused = hostClickBehavior === 'select' && focusedGroupPath === node.path;
  const isGroupMultiSelected = Boolean(isMultiSelectMode && selectedGroupPaths?.has(node.path));

  useEffect(() => {
    if (!isInlineEditing || !inlineEdit?.shouldScrollIntoView) return;
    const frame = requestAnimationFrame(() => {
      groupRowRef.current?.scrollIntoView({ block: 'nearest' });
      hostTreeInlineGroupEditStore.markScrollHandled();
    });
    return () => cancelAnimationFrame(frame);
  }, [inlineEdit?.groupPath, inlineEdit?.shouldScrollIntoView, isInlineEditing]);
  const hasChildren = node.children && Object.keys(node.children).length > 0;
  const isManaged = managedGroupPaths?.has(node.path) ?? false;
  const hostsCountInNode = node.totalHostCount ?? node.hosts.length;

  const childNodes = useMemo(() => sortHostTreeGroups(
    Object.values(node.children ?? {}) as GroupNode[],
    sortMode,
    groupConfigs,
  ), [groupConfigs, node.children, sortMode]);
  const sortedHosts = useMemo(
    () => sortHostTreeHosts(node.hosts, sortMode),
    [node.hosts, sortMode],
  );

  return (
    <div>
      {/* Group Node */}
      <Collapsible
        open={isExpanded}
        onOpenChange={() => {
          if (isInlineEditing) return;
          if (isMultiSelectMode) {
            toggleGroupSelection?.(node.path);
            return;
          }
          if (hostClickBehavior === 'select' && focusedGroupPath !== node.path) {
            onFocusGroup?.(node.path);
            onFocusHost?.(null);
            return;
          }
          onToggle(node.path);
        }}
      >
        <ContextMenu>
          <ContextMenuTrigger>
            <CollapsibleTrigger asChild>
              <VaultTreeGroupRow
                rowRef={groupRowRef}
                name={node.name}
                depth={depth}
                expanded={isExpanded}
                selected={isGroupFocused || isGroupMultiSelected}
                hasChildren={hasChildren || node.hosts.length > 0}
                count={hostsCountInNode}
                editing={isInlineEditing}
                editingInitialName={inlineEdit?.initialName}
                onRenameCommit={commitRename}
                onRenameCancel={cancelRename}
                className={getDropTargetClasses?.(node.path)}
                data-section="host-tree-row"
                data-row-type="group"
                data-group-path={node.path}
                data-tree-item-key={`group:${node.path}`}
                data-tree-depth={depth}
                role="treeitem"
                aria-level={depth + 1}
                aria-posinset={treePosInSet}
                aria-setsize={treeSetSize}
                aria-selected={isMultiSelectMode ? isGroupMultiSelected : isGroupFocused}
                aria-expanded={hasChildren || node.hosts.length > 0 ? isExpanded : undefined}
                tabIndex={activeTreeItemKey === `group:${node.path}`
                  || (!activeTreeItemKey && initialTreeItemKey === `group:${node.path}`)
                  ? 0
                  : -1}
                onFocus={() => onActiveTreeItemChange(`group:${node.path}`)}
                draggable={!isInlineEditing && !isMultiSelectMode}
                onKeyDown={(event) => {
                  if (!isMultiSelectMode) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  toggleGroupSelection?.(node.path);
                }}
                onDragStart={(e) => {
                  if (isInlineEditing) return;
                  e.dataTransfer.setData("group-path", node.path);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (hasDragType(e.dataTransfer, "group-path")) {
                    const intent = getTreeGroupDropIntent(e.currentTarget, e.clientY);
                    if (intent !== "inside") {
                      setDragOverDropTarget?.(null);
                      return;
                    }
                  }
                  setDragOverDropTarget?.(node.path);
                }}
                onDragLeave={(e) => {
                  const nextTarget = e.relatedTarget;
                  if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) {
                    return;
                  }
                  setDragOverDropTarget?.(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverDropTarget?.(null);
                  const hostId = e.dataTransfer.getData("host-id");
                  const groupPath = e.dataTransfer.getData("group-path");
                  if (hostId) moveHostToGroup(hostId, node.path);
                  if (groupPath && getTreeGroupDropIntent(e.currentTarget, e.clientY) === "inside") {
                    moveGroup(groupPath, node.path);
                  }
                }}
                meta={isManaged && (
                  <span className="mr-1.5 inline-flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    <FileSymlink size={10} />
                    Managed
                  </span>
                )}
                icon={isMultiSelectMode
                  ? isGroupMultiSelected
                    ? <CheckSquare size={16} />
                    : <Square size={16} />
                  : undefined}
                labelActions={!isMultiSelectMode && (
                  <button
                    aria-label={`Edit ${node.name}`}
                    tabIndex={-1}
                    data-host-tree-group-edit-button={node.path}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-colors hover:bg-secondary/80 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditGroup(node.path);
                    }}
                  >
                    <Edit2 size={12} />
                  </button>
                )}
              />
            </CollapsibleTrigger>
          </ContextMenuTrigger>
          <HostTreeGroupContextMenuContent
            groupPath={node.path}
            isManaged={isManaged}
            onNewGroup={onNewGroup}
            onRenameGroup={onRenameGroup}
            onDeleteGroup={onDeleteGroup}
            onUnmanageGroup={onUnmanageGroup}
          />
        </ContextMenu>

        {renderDescendants && <CollapsibleContent role="group">
          {/* Child Groups */}
          {childNodes.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              sortMode={sortMode}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onConnect={onConnect}
              onEditHost={onEditHost}
              onDuplicateHost={onDuplicateHost}
              onDeleteHost={onDeleteHost}
              onCopyCredentials={onCopyCredentials}
              onNewGroup={onNewGroup}
              onRenameGroup={onRenameGroup}
              onEditGroup={onEditGroup}
              onDeleteGroup={onDeleteGroup}
              moveHostToGroup={moveHostToGroup}
              moveGroup={moveGroup}
              managedGroupPaths={managedGroupPaths}
              onUnmanageGroup={onUnmanageGroup}
              commitInlineGroupRename={commitInlineGroupRename}
              cancelInlineGroupEdit={cancelInlineGroupEdit}

	              isMultiSelectMode={isMultiSelectMode}
	              selectedHostIds={selectedHostIds}
	              selectedGroupPaths={selectedGroupPaths}
	              toggleHostSelection={toggleHostSelection}
	              toggleGroupSelection={toggleGroupSelection}
	              hostClickBehavior={hostClickBehavior}
	              focusedHostId={focusedHostId}
	              onFocusHost={onFocusHost}
	              focusedGroupPath={focusedGroupPath}
	              onFocusGroup={onFocusGroup}
	              getDropTargetClasses={getDropTargetClasses}
	              setDragOverDropTarget={setDragOverDropTarget}
	              groupConfigs={groupConfigs}
	              groupDefaultsByPath={groupDefaultsByPath}
	              activeTreeItemKey={activeTreeItemKey}
	              initialTreeItemKey={initialTreeItemKey}
	              onActiveTreeItemChange={onActiveTreeItemChange}
	            />
	          ))}

          {/* Hosts in this group */}
          {sortedHosts.map((host) => (
            <HostTreeItem
              key={host.id}
              host={host}
              depth={depth + 1}
              onConnect={onConnect}
              onEditHost={onEditHost}
              onDuplicateHost={onDuplicateHost}
              onDeleteHost={onDeleteHost}
              onCopyCredentials={onCopyCredentials}
              moveHostToGroup={moveHostToGroup}

	              isMultiSelectMode={isMultiSelectMode}
	              selectedHostIds={selectedHostIds}
	              toggleHostSelection={toggleHostSelection}
	              hostClickBehavior={hostClickBehavior}
	              focusedHostId={focusedHostId}
	              onFocusHost={(hostId) => {
	                onFocusHost?.(hostId);
	                if (hostId) onFocusGroup?.(null);
	              }}
	              groupConfigs={groupConfigs}
	              groupDefaultsByPath={groupDefaultsByPath}
	              activeTreeItemKey={activeTreeItemKey}
	              initialTreeItemKey={initialTreeItemKey}
	              onActiveTreeItemChange={onActiveTreeItemChange}
	            />
	          ))}
        </CollapsibleContent>}
      </Collapsible>
    </div>
  );
};

interface HostTreeItemProps {
  host: Host;
  depth: number;
  onConnect: (host: Host) => void;
  onEditHost: (host: Host) => void;
  onDuplicateHost: (host: Host) => void;
  onDeleteHost: (host: Host) => void;
  onCopyCredentials: (host: Host) => void;
  moveHostToGroup: (hostId: string, groupPath: string | null) => void;

  isMultiSelectMode?: boolean;
  selectedHostIds?: Set<string>;
  toggleHostSelection?: (hostId: string) => void;
  hostClickBehavior?: HostClickBehavior;
  focusedHostId?: string | null;
  onFocusHost?: (hostId: string | null) => void;
  groupConfigs: GroupConfig[];
  groupDefaultsByPath: ReadonlyMap<string, Partial<GroupConfig>>;
  activeTreeItemKey: string | null;
  initialTreeItemKey: string | null;
  onActiveTreeItemChange: (key: string) => void;
  treePosInSet?: number;
  treeSetSize?: number;
}

export const getHostTreeDisplayDetails = (
  host: Host,
  groupConfigs: GroupConfig[] = [],
  groupDefaultsByPath?: ReadonlyMap<string, Partial<GroupConfig>>,
) => {
  const displayHost = host.group
    ? applyGroupDefaults(host, groupDefaultsByPath?.get(host.group) ?? resolveGroupDefaults(host.group, groupConfigs))
    : host;
  const isTelnet = displayHost.protocol === 'telnet';
  return {
    protocol: displayHost.protocol,
    username: isTelnet
      ? (resolveTelnetUsername(displayHost) || '')
      : (displayHost.username?.trim() || ''),
    port: isTelnet
      ? resolveTelnetPort(displayHost)
      : (displayHost.port ?? 22),
  };
};

const HostTreeItem: React.FC<HostTreeItemProps> = ({
  host,
  depth,
  onConnect,
  onEditHost,
  onDuplicateHost,
  onDeleteHost,
  onCopyCredentials,
  moveHostToGroup: _moveHostToGroup,

  isMultiSelectMode,
  selectedHostIds,
  toggleHostSelection,
  hostClickBehavior = 'connect',
  focusedHostId,
  onFocusHost,
  groupConfigs,
  treePosInSet,
  treeSetSize,
  groupDefaultsByPath,
  activeTreeItemKey,
  initialTreeItemKey,
  onActiveTreeItemChange,
}) => {
  const safeHost = sanitizeHost(host);
  const tags = host.tags || [];
  const displayDetails = useMemo(
    () => getHostTreeDisplayDetails(host, groupConfigs, groupDefaultsByPath),
    [groupConfigs, groupDefaultsByPath, host],
  );
  const displayProtocol = displayDetails.protocol;
  const displayUsername = displayDetails.username;
  const displayPort = displayDetails.port;
  const isMultiSelected = Boolean(isMultiSelectMode && selectedHostIds?.has(host.id));
  const isFocusSelected = !isMultiSelectMode && hostClickBehavior === 'select' && focusedHostId === host.id;
  const isSelected = isMultiSelected || isFocusSelected;
  const normalizedHostClickBehavior: HostClickBehavior = hostClickBehavior === 'select'
    ? 'select'
    : 'connect';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <VaultTreeItemRow
          label={host.label}
          depth={depth}
          selected={Boolean(isSelected)}
          className="h-10 rounded-md py-1 pr-2 text-[13px]"
          data-section="host-tree-row"
          data-row-type="host"
          data-host-id={host.id}
          data-tree-item-key={`host:${host.id}`}
          data-tree-depth={depth}
          role="treeitem"
          aria-level={depth + 1}
          aria-posinset={treePosInSet}
          aria-setsize={treeSetSize}
          aria-selected={Boolean(isSelected)}
          tabIndex={activeTreeItemKey === `host:${host.id}`
            || (!activeTreeItemKey && initialTreeItemKey === `host:${host.id}`)
            ? 0
            : -1}
          onFocus={() => onActiveTreeItemChange(`host:${host.id}`)}
          draggable={!isMultiSelectMode}
          onDragStart={(e) => e.dataTransfer.setData("host-id", host.id)}
          onClick={() => {
            const action = resolveHostActivateAction({
              behavior: normalizedHostClickBehavior,
              isMultiSelectMode: Boolean(isMultiSelectMode),
              focusedHostId,
              hostId: host.id,
            });
            if (action === 'toggle-multi') {
              toggleHostSelection?.(host.id);
              return;
            }
            if (action === 'select') {
              onFocusHost?.(host.id);
              return;
            }
            onConnect(safeHost);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            const action = resolveHostActivateAction({
              behavior: normalizedHostClickBehavior,
              isMultiSelectMode: Boolean(isMultiSelectMode),
              focusedHostId,
              hostId: host.id,
            });
            if (action === 'toggle-multi') {
              toggleHostSelection?.(host.id);
              return;
            }
            if (action === 'select') {
              onFocusHost?.(host.id);
              return;
            }
            onConnect(safeHost);
          }}
          leading={isMultiSelectMode ? (
            <div
              className="mr-2 flex h-5 w-4 flex-shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              {isMultiSelected ? (
                <CheckSquare size={15} className="text-primary" />
              ) : (
                <Square size={15} className="text-muted-foreground" />
              )}
            </div>
          ) : (
            <div className="mr-2 h-4 w-4 flex-shrink-0" />
          )}
          icon={(
            <DistroAvatar host={host} fallback={(host.os || "L")[0].toUpperCase()} size="tree" />
          )}
          content={(
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-1.5 truncate font-medium leading-4">
                <span className="truncate">{host.label}</span>
                <button
                  aria-label={`Edit ${host.label}`}
                  tabIndex={-1}
                  data-host-tree-host-edit-button={host.id}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors opacity-0 hover:bg-secondary/80 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditHost(host);
                  }}
                >
                  <Edit2 size={12} />
                </button>
                <HostNotesIndicator notes={host.notes} />
              </div>
              <div className="truncate text-[11px] leading-4 text-muted-foreground">
                {displayUsername}@{host.hostname}:{displayPort}
              </div>
            </div>
          )}
          actions={(displayProtocol && displayProtocol !== 'ssh') || tags.length > 0 ? (
            <div className="ml-2 flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
              {displayProtocol && displayProtocol !== 'ssh' && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary">
                  {displayProtocol.toUpperCase()}
                </span>
              )}
              {tags.length > 0 && (
                <span className="text-[10px] opacity-60">
                  {tags.slice(0, 2).join(', ')}
                  {tags.length > 2 && '...'}
                </span>
              )}
            </div>
          ) : undefined}
        />
      </ContextMenuTrigger>
      <HostTreeHostContextMenuContent
        host={host}
        onConnect={onConnect}
        onDuplicateHost={onDuplicateHost}
        onCopyCredentials={onCopyCredentials}
        onDeleteHost={onDeleteHost}
      />
    </ContextMenu>
  );
};

export const HostTreeView: React.FC<HostTreeViewProps> = ({
  groupTree,
  hosts,
  sortMode = 'az',
  expandedPaths: externalExpandedPaths,
  onTogglePath: externalOnTogglePath,
  onExpandAll: externalOnExpandAll,
  onCollapseAll: externalOnCollapseAll,
  onConnect,
  onEditHost,
  onDuplicateHost,
  onDeleteHost,
  onCopyCredentials,
  onNewGroup,
  onRenameGroup,
  onEditGroup,
  onDeleteGroup,
  moveHostToGroup,
  moveGroup,
  managedGroupPaths,
  onUnmanageGroup,
  commitInlineGroupRename,
  cancelInlineGroupEdit,

  isMultiSelectMode,
  selectedHostIds,
  selectedGroupPaths,
  toggleHostSelection,
  toggleGroupSelection,
  hostClickBehavior,
  focusedHostId,
  onFocusHost,
  focusedGroupPath,
  onFocusGroup,
  getDropTargetClasses,
  setDragOverDropTarget,
  groupConfigs = [],
  scrollRef,
  autoExpandGroupsKey,
}) => {
  const { t } = useI18n();
  const treeSortMode = sortMode as HostTreeSortMode;
  const inlineEdit = useHostTreeInlineGroupEdit();
  const vaultTreeActions = useVaultHostTreeActions();
  const cancelRename = cancelInlineGroupEdit ?? vaultTreeActions?.cancelInlineGroupEdit;

  const handleTreePointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!inlineEdit?.groupPath || !cancelRename) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-inline-group-edit="true"]')) return;
    const row = target.closest('[data-section="host-tree-row"]');
    if (!row) return;
    if (row.getAttribute('data-group-path') === inlineEdit.groupPath) return;
    cancelRename();
  }, [cancelRename, inlineEdit?.groupPath]);

  // Use external state if provided, otherwise use local persistent state
  const localTreeState = useTreeExpandedState(STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED);
  
  const persistentTogglePath = externalOnTogglePath || localTreeState.togglePath;
  const persistentExpandAll = externalOnExpandAll || localTreeState.expandAll;
  const persistentCollapseAll = externalOnCollapseAll || localTreeState.collapseAll;

  // Get all possible group paths for expand/collapse all functionality
  const getAllGroupPaths = (nodes: GroupNode[]): string[] => {
    const paths: string[] = [];
    const traverse = (nodeList: GroupNode[]) => {
      nodeList.forEach(node => {
        paths.push(node.path);
        if (node.children) {
          traverse(Object.values(node.children) as GroupNode[]);
        }
      });
    };
    traverse(nodes);
    return paths;
  };

  const allGroupPaths = useMemo(() => getAllGroupPaths(groupTree), [groupTree]);
  const persistentExpandedPaths = externalExpandedPaths || localTreeState.expandedPaths;
  const { expandedPaths, togglePath, expandAll, collapseAll } = useHostTreeExpandedPaths({
    persistentExpandedPaths,
    allGroupPaths,
    autoExpandGroupsKey,
    onTogglePath: persistentTogglePath,
    onExpandAll: persistentExpandAll,
    onCollapseAll: persistentCollapseAll,
  });

  const groupDefaultsByPath = useMemo(() => {
    const paths = new Set<string>(allGroupPaths as string[]);
    for (const host of hosts) {
      if (host.group) {
        paths.add(host.group);
      }
    }

    const defaultsByPath = new Map<string, Partial<GroupConfig>>();
    for (const path of paths) {
      defaultsByPath.set(path, resolveGroupDefaults(path, groupConfigs));
    }
    return defaultsByPath;
  }, [allGroupPaths, groupConfigs, hosts]);

  const handleExpandAll = () => {
    expandAll(allGroupPaths);
  };

  const handleCollapseAll = () => {
    collapseAll();
  };

  const ungroupedHosts = useMemo(
    () => hosts.filter((host) => !host.group || host.group === ''),
    [hosts],
  );
  const visibleTreeItems = useMemo(() => buildVisibleHostTreeItems({
    groupTree,
    ungroupedHosts,
    expandedPaths,
    sortMode: treeSortMode,
    groupConfigs,
  }), [expandedPaths, groupConfigs, groupTree, treeSortMode, ungroupedHosts]);

  const treeRef = useRef<HTMLDivElement>(null);
  const pendingTreeFocusKeyRef = useRef<string | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [activeTreeItemKey, setActiveTreeItemKey] = useState<string | null>(null);
  const initialTreeItemKey = visibleTreeItems[0]?.key ?? null;
  const treeItemIndexByKey = useMemo(() => new Map(
    visibleTreeItems.map((item, index) => [item.key, index]),
  ), [visibleTreeItems]);
  const virtualizer = useVirtualizer({
    count: visibleTreeItems.length,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => 40,
    getItemKey: (index) => visibleTreeItems[index]?.key ?? index,
    overscan: 10,
    scrollMargin,
    initialRect: typeof window === 'undefined'
      ? { width: 1280, height: 800 }
      : undefined,
  });

  React.useLayoutEffect(() => {
    const root = treeRef.current;
    const scrollElement = scrollRef?.current;
    if (!root || !scrollElement) return;
    const measure = () => {
      const nextMargin = root.getBoundingClientRect().top
        - scrollElement.getBoundingClientRect().top
        + scrollElement.scrollTop;
      setScrollMargin((current) => current === nextMargin ? current : nextMargin);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [scrollRef, visibleTreeItems.length]);

  React.useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, visibleTreeItems.length]);

  const focusRenderedTreeItem = useCallback((key: string) => {
    const target = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-tree-item-key]') ?? [])]
      .find((item) => item.dataset.treeItemKey === key);
    if (!target) return false;
    target.focus();
    return true;
  }, []);

  React.useLayoutEffect(() => {
    const key = pendingTreeFocusKeyRef.current;
    if (!key || !focusRenderedTreeItem(key)) return;
    pendingTreeFocusKeyRef.current = null;
  });

  useEffect(() => {
    if (!activeTreeItemKey) return;
    if (!treeItemIndexByKey.has(activeTreeItemKey)) {
      setActiveTreeItemKey(null);
    }
  }, [activeTreeItemKey, treeItemIndexByKey]);

  const focusTreeItem = useCallback((index: number) => {
    const item = visibleTreeItems[index];
    if (!item) return;
    const key = item.key;
    pendingTreeFocusKeyRef.current = key;
    setActiveTreeItemKey(key);
    virtualizer.scrollToIndex(index, { align: 'auto' });
    queueMicrotask(() => {
      if (focusRenderedTreeItem(key)) pendingTreeFocusKeyRef.current = null;
    });
  }, [focusRenderedTreeItem, virtualizer, visibleTreeItems]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[role="treeitem"]')
      : null;
    if (!target || !treeRef.current?.contains(target)) return;

    const key = target.dataset.treeItemKey;
    const index = key ? treeItemIndexByKey.get(key) : undefined;
    if (index === undefined) return;
    const currentItem = visibleTreeItems[index];
    const depth = currentItem.depth;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? visibleTreeItems.length - 1
          : Math.max(0, Math.min(
            visibleTreeItems.length - 1,
            index + (event.key === 'ArrowDown' ? 1 : -1),
          ));
      focusTreeItem(nextIndex);
      return;
    }

    const isGroup = target.dataset.rowType === 'group';
    const groupPath = target.dataset.groupPath;
    const isExpandable = target.hasAttribute('aria-expanded');
    const isExpanded = target.getAttribute('aria-expanded') === 'true';
    if (event.key === 'ArrowRight') {
      if (!isGroup || !isExpandable) return;
      event.preventDefault();
      if (!isExpanded && groupPath) {
        togglePath(groupPath);
        return;
      }
      const child = visibleTreeItems[index + 1];
      if (child && child.depth > depth) {
        focusTreeItem(index + 1);
      }
      return;
    }

    event.preventDefault();
    if (isGroup && isExpandable && isExpanded && groupPath) {
      togglePath(groupPath);
      return;
    }
    for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
      const parent = visibleTreeItems[parentIndex];
      if (parent.kind === 'group' && parent.depth < depth) {
        focusTreeItem(parentIndex);
        return;
      }
    }
  }, [focusTreeItem, togglePath, treeItemIndexByKey, visibleTreeItems]);

  return (
    <div className="space-y-1" onPointerDownCapture={handleTreePointerDownCapture}>
      {/* Expand/Collapse controls */}
      {groupTree.length > 0 && (
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/30">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExpandAll}
            className="h-7 px-2 text-xs"
          >
            <Expand size={12} className="mr-1" />
            {t("vault.tree.expandAll")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCollapseAll}
            className="h-7 px-2 text-xs"
          >
            <Minimize2 size={12} className="mr-1" />
            {t("vault.tree.collapseAll")}
          </Button>
        </div>
      )}

      <div
        ref={treeRef}
        className="relative min-w-0"
        style={{ height: virtualizer.getTotalSize() }}
        data-vault-virtual-tree="true"
        role="tree"
        aria-label={t("vault.nav.hosts")}
        aria-multiselectable={isMultiSelectMode || undefined}
        onKeyDownCapture={handleTreeKeyDown}
      >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = visibleTreeItems[virtualRow.index];
        if (!item) return null;
        return (
          <div
            key={item.key}
            data-vault-virtual-tree-row={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {item.kind === 'group' ? (
              <TreeNode
                node={item.node}
                depth={item.depth}
                sortMode={sortMode}
                expandedPaths={expandedPaths}
                onToggle={togglePath}
                onConnect={onConnect}
                onEditHost={onEditHost}
                onDuplicateHost={onDuplicateHost}
                onDeleteHost={onDeleteHost}
                onCopyCredentials={onCopyCredentials}
                onNewGroup={onNewGroup}
                onRenameGroup={onRenameGroup}
                onEditGroup={onEditGroup}
                onDeleteGroup={onDeleteGroup}
                moveHostToGroup={moveHostToGroup}
                moveGroup={moveGroup}
                managedGroupPaths={managedGroupPaths}
                onUnmanageGroup={onUnmanageGroup}
                commitInlineGroupRename={commitInlineGroupRename}
                cancelInlineGroupEdit={cancelInlineGroupEdit}
                isMultiSelectMode={isMultiSelectMode}
                selectedHostIds={selectedHostIds}
                selectedGroupPaths={selectedGroupPaths}
                toggleHostSelection={toggleHostSelection}
                toggleGroupSelection={toggleGroupSelection}
                hostClickBehavior={hostClickBehavior}
                focusedHostId={focusedHostId}
                onFocusHost={onFocusHost}
                focusedGroupPath={focusedGroupPath}
                onFocusGroup={onFocusGroup}
                getDropTargetClasses={getDropTargetClasses}
                setDragOverDropTarget={setDragOverDropTarget}
                groupConfigs={groupConfigs}
                groupDefaultsByPath={groupDefaultsByPath}
                activeTreeItemKey={activeTreeItemKey}
                initialTreeItemKey={initialTreeItemKey}
                onActiveTreeItemChange={setActiveTreeItemKey}
                renderDescendants={false}
                treePosInSet={item.posInSet}
                treeSetSize={item.setSize}
              />
            ) : (
              <HostTreeItem
                host={item.host}
                depth={item.depth}
                onConnect={onConnect}
                onEditHost={onEditHost}
                onDuplicateHost={onDuplicateHost}
                onDeleteHost={onDeleteHost}
                onCopyCredentials={onCopyCredentials}
                moveHostToGroup={moveHostToGroup}
                isMultiSelectMode={isMultiSelectMode}
                selectedHostIds={selectedHostIds}
                toggleHostSelection={toggleHostSelection}
                hostClickBehavior={hostClickBehavior}
                focusedHostId={focusedHostId}
                onFocusHost={(hostId) => {
                  onFocusHost?.(hostId);
                  if (hostId) onFocusGroup?.(null);
                }}
                groupConfigs={groupConfigs}
                groupDefaultsByPath={groupDefaultsByPath}
                activeTreeItemKey={activeTreeItemKey}
                initialTreeItemKey={initialTreeItemKey}
                onActiveTreeItemChange={setActiveTreeItemKey}
                treePosInSet={item.posInSet}
                treeSetSize={item.setSize}
              />
            )}
          </div>
        );
      })}
      </div>
      
      {/* Empty state */}
      {ungroupedHosts.length === 0 && groupTree.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Server size={48} className="mx-auto mb-4 opacity-50" />
          <p className="text-sm">{t("vault.hosts.empty")}</p>
        </div>
      )}
    </div>
  );
};
