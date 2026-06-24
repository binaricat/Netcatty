import { CheckSquare, Edit2, FileSymlink, Server, Square, Expand, Minimize2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import {
  hostTreeInlineGroupEditStore,
  useHostTreeInlineGroupEdit,
} from '../application/state/hostTreeInlineGroupEditStore';
import { useVaultHostTreeActions } from '../application/state/vaultHostTreeActionsStore';
import { useTreeExpandedState } from '../application/state/useTreeExpandedState';
import { applyGroupDefaults, resolveGroupDefaults } from '../domain/groupConfig';
import { resolveTelnetPort, resolveTelnetUsername, sanitizeHost } from '../domain/host';
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

interface HostTreeViewProps {
  groupTree: GroupNode[];
  hosts: Host[];
  sortMode?: 'manual' | 'az' | 'za' | 'newest' | 'oldest' | 'group';
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
  toggleHostSelection?: (hostId: string) => void;
  getDropTargetClasses?: (target: string) => string;
  setDragOverDropTarget?: (target: string | null) => void;
  groupConfigs?: GroupConfig[];
}

interface TreeNodeProps {
  node: GroupNode;
  depth: number;
  sortMode: 'manual' | 'az' | 'za' | 'newest' | 'oldest' | 'group';
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
  toggleHostSelection?: (hostId: string) => void;
  getDropTargetClasses?: (target: string) => string;
  setDragOverDropTarget?: (target: string | null) => void;
  groupConfigs: GroupConfig[];
  groupDefaultsByPath: ReadonlyMap<string, Partial<GroupConfig>>;
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
  toggleHostSelection,
  getDropTargetClasses,
  setDragOverDropTarget,
  groupConfigs,
  groupDefaultsByPath,
}) => {
  const inlineEdit = useHostTreeInlineGroupEdit();
  const vaultTreeActions = useVaultHostTreeActions();
  const commitRename = commitInlineGroupRename ?? vaultTreeActions?.commitInlineGroupRename;
  const cancelRename = cancelInlineGroupEdit ?? vaultTreeActions?.cancelInlineGroupEdit;
  const isInlineEditing = inlineEdit?.groupPath === node.path;
  const groupRowRef = useRef<HTMLDivElement>(null);
  const isExpanded = expandedPaths.has(node.path);

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

  const childNodes = useMemo(() => {
    if (!node.children) return [];
    const nodes = Object.values(node.children) as unknown as GroupNode[];
    const originalIndex = new Map(nodes.map((child, index) => [child.path, index]));
    const orderByPath = new Map(
      groupConfigs
        .filter((config) => typeof config.order === 'number' && Number.isFinite(config.order))
        .map((config) => [config.path, config.order as number]),
    );
    return nodes.sort((a, b) => {
      switch (sortMode) {
        case 'za':
          return b.name.localeCompare(a.name);
        case 'manual': {
          const orderA = orderByPath.get(a.path);
          const orderB = orderByPath.get(b.path);
          const hasOrderA = typeof orderA === 'number' && Number.isFinite(orderA);
          const hasOrderB = typeof orderB === 'number' && Number.isFinite(orderB);
          if (hasOrderA && hasOrderB && orderA !== orderB) return orderA - orderB;
          if (hasOrderA) return -1;
          if (hasOrderB) return 1;
          return (originalIndex.get(a.path) ?? 0) - (originalIndex.get(b.path) ?? 0);
        }
        case 'newest':
        case 'oldest':
          // For groups, fall back to name sorting since groups don't have creation dates
          return a.name.localeCompare(b.name);
        case 'az':
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [groupConfigs, node.children, sortMode]);

  const sortedHosts = useMemo(() => {
    const sorted = [...node.hosts].sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'newest':
          return (b.createdAt || 0) - (a.createdAt || 0);
        case 'oldest':
          return (a.createdAt || 0) - (b.createdAt || 0);
        case 'manual':
          return 0;
        default:
          return a.label.localeCompare(b.label);
      }
    });
    if (sortMode === 'manual') return sortByVaultOrder(sorted);
    return sorted;
  }, [node.hosts, sortMode]);

  return (
    <div>
      {/* Group Node */}
      <Collapsible
        open={isExpanded}
        onOpenChange={() => {
          if (isInlineEditing) return;
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
                draggable={!isInlineEditing}
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
                actions={(
                  <button
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-colors hover:bg-secondary/80 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditGroup(node.path);
                    }}
                  >
                    <Edit2 size={13} />
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

        <CollapsibleContent>
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
	              toggleHostSelection={toggleHostSelection}
	              getDropTargetClasses={getDropTargetClasses}
	              setDragOverDropTarget={setDragOverDropTarget}
	              groupConfigs={groupConfigs}
	              groupDefaultsByPath={groupDefaultsByPath}
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
	              groupConfigs={groupConfigs}
	              groupDefaultsByPath={groupDefaultsByPath}
	            />
	          ))}
        </CollapsibleContent>
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
  groupConfigs: GroupConfig[];
  groupDefaultsByPath: ReadonlyMap<string, Partial<GroupConfig>>;
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
  groupConfigs,
  groupDefaultsByPath,
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
  const isSelected = isMultiSelectMode && selectedHostIds?.has(host.id);

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
          draggable={!isMultiSelectMode}
          onDragStart={(e) => e.dataTransfer.setData("host-id", host.id)}
          onClick={() => {
            if (isMultiSelectMode && toggleHostSelection) {
              toggleHostSelection(host.id);
            } else {
              onConnect(safeHost);
            }
          }}
          leading={isMultiSelectMode ? (
            <div className="mr-2 flex h-5 w-4 flex-shrink-0 items-center justify-center" onClick={(e) => {
              e.stopPropagation();
              toggleHostSelection?.(host.id);
            }}>
              {isSelected ? (
                <CheckSquare size={15} className="text-primary" />
              ) : (
                <Square size={15} className="text-muted-foreground" />
              )}
            </div>
          ) : (
            <div className="mr-2 h-4 w-4 flex-shrink-0" />
          )}
          icon={(
            <div className="mr-2 flex-shrink-0">
              <DistroAvatar host={host} fallback={(host.os || "L")[0].toUpperCase()} size="tree" />
            </div>
          )}
          content={(
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-1.5 truncate font-medium leading-4">
                <span className="truncate">{host.label}</span>
                <HostNotesIndicator notes={host.notes} />
              </div>
              <div className="truncate text-[11px] leading-4 text-muted-foreground">
                {displayUsername}@{host.hostname}:{displayPort}
              </div>
            </div>
          )}
          actions={(
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
              <button
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-secondary/80"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditHost(host);
                }}
              >
                <Edit2 size={12} />
              </button>
            </div>
          )}
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
  toggleHostSelection,
  getDropTargetClasses,
  setDragOverDropTarget,
  groupConfigs = [],
}) => {
  const { t } = useI18n();
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
  
  const expandedPaths = externalExpandedPaths || localTreeState.expandedPaths;
  const togglePath = externalOnTogglePath || localTreeState.togglePath;
  const expandAll = externalOnExpandAll || localTreeState.expandAll;
  const collapseAll = externalOnCollapseAll || localTreeState.collapseAll;

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

  const groupDefaultsByPath = useMemo(() => {
    const paths = new Set(allGroupPaths);
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

  // Get ungrouped hosts (hosts without a group or with empty group) and sort them
  const ungroupedHosts = useMemo(() => {
    const hosts_without_group = hosts.filter(host => !host.group || host.group === '');
    const sorted = hosts_without_group.sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'newest':
          return (b.createdAt || 0) - (a.createdAt || 0);
        case 'oldest':
          return (a.createdAt || 0) - (b.createdAt || 0);
        case 'manual':
          return 0;
        default:
          return a.label.localeCompare(b.label);
      }
    });
    if (sortMode === 'manual') return sortByVaultOrder(sorted);
    return sorted;
  }, [hosts, sortMode]);

  // Sort group tree based on sort mode
  const sortedGroupTree = useMemo(() => {
    return [...groupTree].sort((a, b) => {
      switch (sortMode) {
        case 'za':
          return b.name.localeCompare(a.name);
        case 'manual':
          return 0;
        case 'newest':
        case 'oldest':
          // For groups, fall back to name sorting since groups don't have creation dates
          return a.name.localeCompare(b.name);
        case 'az':
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [groupTree, sortMode]);

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

      {/* Group tree */}
      {sortedGroupTree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
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
          toggleHostSelection={toggleHostSelection}
	          getDropTargetClasses={getDropTargetClasses}
	          setDragOverDropTarget={setDragOverDropTarget}
	          groupConfigs={groupConfigs}
	          groupDefaultsByPath={groupDefaultsByPath}
	        />
      ))}

      {/* Ungrouped hosts at root level */}
      {ungroupedHosts.map((host) => (
        <HostTreeItem
          key={host.id}
          host={host}
          depth={0}
          onConnect={onConnect}
          onEditHost={onEditHost}
          onDuplicateHost={onDuplicateHost}
          onDeleteHost={onDeleteHost}
          onCopyCredentials={onCopyCredentials}
          moveHostToGroup={moveHostToGroup}
          isMultiSelectMode={isMultiSelectMode}
	          selectedHostIds={selectedHostIds}
	          toggleHostSelection={toggleHostSelection}
	          groupConfigs={groupConfigs}
	          groupDefaultsByPath={groupDefaultsByPath}
	        />
      ))}
      
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
