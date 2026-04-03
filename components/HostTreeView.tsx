import { CheckSquare, ChevronRight, Edit2, FileSymlink, Folder, FolderOpen, Monitor, Server, Square, Expand, Minimize2 } from 'lucide-react';
import React, { useMemo } from 'react';
import { useI18n } from '../application/i18n/I18nProvider';
import { useTreeExpandedState } from '../application/state/useTreeExpandedState';
import { sanitizeHost } from '../domain/host';
import { STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED } from '../infrastructure/config/storageKeys';
import { cn } from '../lib/utils';
import { GroupNode, Host } from '../types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { DistroAvatar } from './DistroAvatar';
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
  onNewHost: (groupPath?: string) => void;
  onNewGroup: (parentPath?: string) => void;
  onEditGroup: (groupPath: string) => void;
  onDeleteGroup: (groupPath: string) => void;
  moveHostToGroup: (hostId: string, groupPath: string | null) => void;
  moveGroup: (sourcePath: string, targetPath: string) => void;
  managedGroupPaths?: Set<string>;
  onUnmanageGroup?: (groupPath: string) => void;

  isMultiSelectMode?: boolean;
  selectedHostIds?: Set<string>;
  toggleHostSelection?: (hostId: string) => void;
  getDropTargetClasses?: (target: string) => string;
  setDragOverDropTarget?: (target: string | null) => void;
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
  onNewHost: (groupPath?: string) => void;
  onNewGroup: (parentPath?: string) => void;
  onEditGroup: (groupPath: string) => void;
  onDeleteGroup: (groupPath: string) => void;
  moveHostToGroup: (hostId: string, groupPath: string | null) => void;
  moveGroup: (sourcePath: string, targetPath: string) => void;
  managedGroupPaths?: Set<string>;
  onUnmanageGroup?: (groupPath: string) => void;

  isMultiSelectMode?: boolean;
  selectedHostIds?: Set<string>;
  toggleHostSelection?: (hostId: string) => void;
  getDropTargetClasses?: (target: string) => string;
  setDragOverDropTarget?: (target: string | null) => void;
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
  onNewHost,
  onNewGroup,
  onEditGroup,
  onDeleteGroup,
  moveHostToGroup,
  moveGroup,
  managedGroupPaths,
  onUnmanageGroup,

  isMultiSelectMode,
  selectedHostIds,
  toggleHostSelection,
  getDropTargetClasses,
  setDragOverDropTarget,
}) => {
  const { t } = useI18n();
  const isExpanded = expandedPaths.has(node.path);
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
                <div className="mr-3 text-primary/80 group-hover:text-primary transition-colors">
                  {isExpanded ? <FolderOpen size={18} /> : <Folder size={18} />}
                </div>
                <span className="truncate flex-1 font-semibold">{node.name}</span>
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
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onNewHost(node.path)}>
              <Server className="mr-2 h-4 w-4" /> {t("vault.hosts.newHost")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onNewGroup(node.path)}>
              <Folder className="mr-2 h-4 w-4" /> {t("vault.hosts.newGroup")}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onEditGroup(node.path)}>
              <FolderOpen className="mr-2 h-4 w-4" /> {t("vault.groups.rename")}
            </ContextMenuItem>
            <ContextMenuItem 
              onClick={() => onDeleteGroup(node.path)}
              className="text-destructive focus:text-destructive"
            >
              <FolderOpen className="mr-2 h-4 w-4" /> {t("vault.groups.delete")}
            </ContextMenuItem>
            {isManaged && onUnmanageGroup && (
              <ContextMenuItem onClick={() => onUnmanageGroup(node.path)}>
                <FileSymlink className="mr-2 h-4 w-4" /> {t("vault.managedSource.unmanage")}
              </ContextMenuItem>
            )}
          </ContextMenuContent>
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
              onNewHost={onNewHost}
              onNewGroup={onNewGroup}
              onEditGroup={onEditGroup}
              onDeleteGroup={onDeleteGroup}
              moveHostToGroup={moveHostToGroup}
              moveGroup={moveGroup}
              managedGroupPaths={managedGroupPaths}
              onUnmanageGroup={onUnmanageGroup}

              isMultiSelectMode={isMultiSelectMode}
              selectedHostIds={selectedHostIds}
              toggleHostSelection={toggleHostSelection}
              getDropTargetClasses={getDropTargetClasses}
              setDragOverDropTarget={setDragOverDropTarget}
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
}

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
}) => {
  const { t } = useI18n();
  const paddingLeft = `${depth * 20 + 12}px`;
  const safeHost = sanitizeHost(host);
  const tags = host.tags || [];
  const isTelnet = host.protocol === 'telnet';
  const displayUsername = isTelnet
    ? (host.telnetUsername?.trim() || host.username?.trim() || '')
    : (host.username?.trim() || '');
  const displayPort = isTelnet
    ? (host.telnetPort ?? host.port ?? 23)
    : (host.port ?? 22);
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
            <DistroAvatar host={host} fallback={(host.os || "L")[0].toUpperCase()} size="sm" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{host.label}</div>
            <div className="text-xs text-muted-foreground truncate">
              {displayUsername}@{host.hostname}:{displayPort}
            </div>
          </div>
          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            {host.protocol && host.protocol !== 'ssh' && (
              <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                {host.protocol.toUpperCase()}
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
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onConnect(safeHost)}>
          <Monitor className="mr-2 h-4 w-4" /> {t("vault.hosts.connect")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onEditHost(host)}>
          <Server className="mr-2 h-4 w-4" /> {t("action.edit")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onDuplicateHost(host)}>
          <Server className="mr-2 h-4 w-4" /> {t("action.duplicate")}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopyCredentials(host)}>
          <Server className="mr-2 h-4 w-4" /> {t("vault.hosts.copyCredentials")}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => onDeleteHost(host)}
          className="text-destructive focus:text-destructive"
        >
          <Server className="mr-2 h-4 w-4" /> {t("action.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
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
  onNewHost,
  onNewGroup,
  onEditGroup,
  onDeleteGroup,
  moveHostToGroup,
  moveGroup,
  managedGroupPaths,
  onUnmanageGroup,

  isMultiSelectMode,
  selectedHostIds,
  toggleHostSelection,
  getDropTargetClasses,
  setDragOverDropTarget,
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
          onNewHost={onNewHost}
          onNewGroup={onNewGroup}
          onEditGroup={onEditGroup}
          onDeleteGroup={onDeleteGroup}
          moveHostToGroup={moveHostToGroup}
          moveGroup={moveGroup}
          managedGroupPaths={managedGroupPaths}
          onUnmanageGroup={onUnmanageGroup}
          isMultiSelectMode={isMultiSelectMode}
          selectedHostIds={selectedHostIds}
          toggleHostSelection={toggleHostSelection}
          getDropTargetClasses={getDropTargetClasses}
          setDragOverDropTarget={setDragOverDropTarget}
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
