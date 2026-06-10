import { CheckSquare, ChevronRight, Edit2, FileSymlink, Folder, FolderOpen, Server, Square, Expand, Minimize2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import {
  hostTreeInlineGroupEditStore,
  useHostTreeInlineGroupEdit,
} from '../application/state/hostTreeInlineGroupEditStore';
import { useVaultHostTreeActions } from '../application/state/vaultHostTreeActionsStore';
import { useTreeExpandedState } from '../application/state/useTreeExpandedState';
import { applyGroupDefaults, resolveGroupDefaults } from '../domain/groupConfig';
import { resolveTelnetPort, resolveTelnetUsername, sanitizeHost } from '../domain/host';
import { STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED } from '../infrastructure/config/storageKeys';
import { cn } from '../lib/utils';
import { GroupConfig, GroupNode, Host } from '../types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { HostTreeGroupContextMenuContent, HostTreeHostContextMenuContent } from './host/HostTreeContextMenus';
import { HostTreeGroupInlineRenameInput } from './host/HostTreeGroupInlineRenameInput';
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu';
import { DistroAvatar } from './DistroAvatar';
import { HostNotesIndicator } from './host/HostNotesIndicator';
import { Button } from './ui/button';

interface HostTreeViewProps {
  groupTree: GroupNode[];
  hosts: Host[];
  sortMode?: 'az' | 'za' | 'newest' | 'oldest' | 'group';
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
  sortMode: 'az' | 'za' | 'newest' | 'oldest' | 'group';
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
  const paddingLeft = `${depth * 20 + 12}px`;
  const isManaged = managedGroupPaths?.has(node.path) ?? false;
  const hostsCountInNode = node.totalHostCount ?? node.hosts.length;

  const childNodes = useMemo(() => {
    if (!node.children) return [];
    const nodes = Object.values(node.children) as unknown as GroupNode[];
    return nodes.sort((a, b) => {
      switch (sortMode) {
        case 'za':
          return b.name.localeCompare(a.name);
        case 'newest':
        case 'oldest':
          // For groups, fall back to name sorting since groups don't have creation dates
          return a.name.localeCompare(b.name);
        case 'az':
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [node.children, sortMode]);

  const sortedHosts = useMemo(() => {
    return [...node.hosts].sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'newest':
          return (b.createdAt || 0) - (a.createdAt || 0);
        case 'oldest':
          return (a.createdAt || 0) - (b.createdAt || 0);
        default:
          return a.label.localeCompare(b.label);
      }
    });
  }, [node.hosts, sortMode]);

  return (
    <div>
      {/* Group Node */}
      <Collapsible open={isExpanded} onOpenChange={() => onToggle(node.path)}>
        <ContextMenu>
          <ContextMenuTrigger>
            <CollapsibleTrigger asChild>
              <div
                ref={groupRowRef}
                className={cn(
                  "flex items-center py-2 pr-3 text-sm font-medium cursor-pointer transition-colors select-none group hover:bg-secondary/60 rounded-lg",
                  getDropTargetClasses?.(node.path),
                )}
                style={{ paddingLeft }}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("group-path", node.path)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
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
                  if (groupPath) moveGroup(groupPath, node.path);
                }}
              >
                <div className="mr-2 flex-shrink-0 w-4 h-4 flex items-center justify-center">
                  {(hasChildren || node.hosts.length > 0) && (
                    <div className={cn("transition-transform duration-200", isExpanded ? "rotate-90" : "")}>
                      <ChevronRight size={14} />
                    </div>
                  )}
                </div>
                <div className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center text-primary transition-colors dark:text-primary">
                  {isExpanded ? (
                    <FolderOpen size={21} strokeWidth={2.35} />
                  ) : (
                    <Folder size={21} strokeWidth={2.35} />
                  )}
                </div>
                {isInlineEditing && commitRename && cancelRename ? (
                  <HostTreeGroupInlineRenameInput
                    initialName={inlineEdit.initialName}
                    onCommit={commitRename}
                    onCancel={cancelRename}
                    className="flex-1 font-semibold"
                  />
                ) : (
                  <span className="truncate flex-1 font-semibold">{node.name}</span>
                )}
                {isManaged && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/15 text-primary shrink-0 mr-1.5">
                    <FileSymlink size={10} />
                    Managed
                  </span>
                )}
                {(node.hosts.length > 0 || hasChildren) && (
                  <span className="text-xs opacity-70 bg-background/50 px-2 py-0.5 rounded-full border border-border">
                    {hostsCountInNode}
                  </span>
                )}
                <button
                  className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-secondary/80 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditGroup(node.path);
                  }}
                >
                  <Edit2 size={13} />
                </button>
              </div>
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
}

export const getHostTreeDisplayDetails = (
  host: Host,
  groupConfigs: GroupConfig[] = [],
) => {
  const displayHost = host.group
    ? applyGroupDefaults(host, resolveGroupDefaults(host.group, groupConfigs))
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
}) => {
  const paddingLeft = `${depth * 20 + 12}px`;
  const safeHost = sanitizeHost(host);
  const tags = host.tags || [];
  const displayDetails = useMemo(
    () => getHostTreeDisplayDetails(host, groupConfigs),
    [groupConfigs, host],
  );
  const displayProtocol = displayDetails.protocol;
  const displayUsername = displayDetails.username;
  const displayPort = displayDetails.port;
  const isSelected = isMultiSelectMode && selectedHostIds?.has(host.id);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className={cn(
            "flex items-center py-2 pr-3 text-sm cursor-pointer transition-colors select-none group hover:bg-secondary/40 rounded-lg",
            isSelected ? "bg-primary/10" : "",
          )}
          style={{ paddingLeft }}
          draggable={!isMultiSelectMode}
          onDragStart={(e) => e.dataTransfer.setData("host-id", host.id)}
          onClick={() => {
            if (isMultiSelectMode && toggleHostSelection) {
              toggleHostSelection(host.id);
            } else {
              onConnect(safeHost);
            }
          }}
        >
          {isMultiSelectMode && (
            <div className="mr-2 flex-shrink-0" onClick={(e) => {
              e.stopPropagation();
              toggleHostSelection?.(host.id);
            }}>
              {isSelected ? (
                <CheckSquare size={18} className="text-primary" />
              ) : (
                <Square size={18} className="text-muted-foreground" />
              )}
            </div>
          )}
          {!isMultiSelectMode && <div className="mr-2 flex-shrink-0 w-4 h-4" />}
          <div className="mr-3 flex-shrink-0">
            <DistroAvatar host={host} fallback={(host.os || "L")[0].toUpperCase()} size="tree" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate flex items-center gap-1.5">
              <span className="truncate">{host.label}</span>
              <HostNotesIndicator notes={host.notes} />
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {displayUsername}@{host.hostname}:{displayPort}
            </div>
          </div>
          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
	            {displayProtocol && displayProtocol !== 'ssh' && (
	              <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
	                {displayProtocol.toUpperCase()}
	              </span>
	            )}
            {tags.length > 0 && (
              <span className="text-xs opacity-60">
                {tags.slice(0, 2).join(', ')}
                {tags.length > 2 && '...'}
              </span>
            )}
            <button
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-secondary/80 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onEditHost(host);
              }}
            >
              <Edit2 size={13} />
            </button>
          </div>
        </div>
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

  const handleExpandAll = () => {
    expandAll(allGroupPaths);
  };

  const handleCollapseAll = () => {
    collapseAll();
  };

  // Get ungrouped hosts (hosts without a group or with empty group) and sort them
  const ungroupedHosts = useMemo(() => {
    const hosts_without_group = hosts.filter(host => !host.group || host.group === '');
    return hosts_without_group.sort((a, b) => {
      switch (sortMode) {
        case 'az':
          return a.label.localeCompare(b.label);
        case 'za':
          return b.label.localeCompare(a.label);
        case 'newest':
          return (b.createdAt || 0) - (a.createdAt || 0);
        case 'oldest':
          return (a.createdAt || 0) - (b.createdAt || 0);
        default:
          return a.label.localeCompare(b.label);
      }
    });
  }, [hosts, sortMode]);

  // Sort group tree based on sort mode
  const sortedGroupTree = useMemo(() => {
    return [...groupTree].sort((a, b) => {
      switch (sortMode) {
        case 'za':
          return b.name.localeCompare(a.name);
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
    <div className="space-y-1">
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
