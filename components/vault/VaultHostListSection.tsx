/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";

type VaultHostListSectionContext = Record<string, any>;

const isRelatedTargetInside = (
  currentTarget: HTMLElement,
  relatedTarget: EventTarget | null,
) => {
  return (
    typeof Node !== "undefined" &&
    relatedTarget instanceof Node &&
    currentTarget.contains(relatedTarget)
  );
};

export function VaultHostListSection({ ctx }: { ctx: VaultHostListSectionContext }) {
  const { Badge, Boolean, Button, CheckSquare, ClipboardCopy, Clock, cn, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Copy, displayedGroups, displayedHosts, DistroAvatar, Edit2, FileSymlink, FolderPlus, FolderTree, getDropTargetClasses, getEffectiveHostDistro, groupConfigs, groupedDisplayHosts, handleCopyCredentials, handleDuplicateHost, handleEditGroupConfig, handleEditHost, handleHostConnect, handleUnmanageGroup, hasHostsSidePanel, hostListScrollRef, HostTreeView, isHostsSectionActive, isMultiSelectMode, lastPinnedId, LayoutGrid, managedGroupPaths, moveGroup, moveHostToGroup, onDeleteHost, Pin, pinnedHosts, pinnedRecentIds, Plug, recentHosts, sanitizeHost, selectedGroupPath, selectedHostIds, sessionCount, setDeleteTargetPath, setDragOverDropTarget, setEditingHost, setGroupDragOverDropTarget, setIsDeleteGroupOpen, setIsHostPanelOpen, setIsNewFolderOpen, setLastPinnedId, setNewFolderName, setNewHostGroupPath, setSelectedGroupPath, setTargetParentPath, shouldHideEmptyRootHostsSection, showRecentHosts, sortMode, splitViewGridStyle, Square, Star, t, toggleHostPinned, toggleHostSelection, Trash2, treeExpandedState, treeViewGroupTree, treeViewHosts, viewMode, visibleDisplayedHosts } = ctx;
  return <div
          ref={hostListScrollRef}
          className={cn(
            "flex-1 overflow-auto px-4 py-4 space-y-6",
            !isHostsSectionActive && "hidden",
          )}
          data-section="vault-host-list"
          onDragEndCapture={() => setDragOverDropTarget(null)}
        >
                <section className="space-y-2">
                  {viewMode !== "tree" && (
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <button
                        className={cn(
                          "text-primary hover:underline transition-colors duration-150 rounded px-1 -mx-1",
                          getDropTargetClasses({ kind: "root" }),
                        )}
                        onClick={() => setSelectedGroupPath(null)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOverDropTarget({ kind: "root" });
                        }}
                        onDragLeave={(e) => {
                          const nextTarget = e.relatedTarget;
                          if (isRelatedTargetInside(e.currentTarget, nextTarget)) {
                            return;
                          }
                          setDragOverDropTarget((current) =>
                            current?.kind === "root" ? null : current,
                          );
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragOverDropTarget(null);
                          const groupPath = e.dataTransfer.getData("group-path");
                          const hostId = e.dataTransfer.getData("host-id");
                          if (groupPath) moveGroup(groupPath, null);
                          if (hostId) moveHostToGroup(hostId, null);
                        }}
                      >
                        {t("vault.hosts.allHosts")}
                      </button>
                      {selectedGroupPath &&
                        selectedGroupPath
                          .split("/")
                          .filter(Boolean)
                          .map((part, idx, arr) => {
                            const crumbPath = arr.slice(0, idx + 1).join("/");
                            const isLast = idx === arr.length - 1;
                            return (
                              <span
                                key={crumbPath}
                                className="flex items-center gap-2"
                              >
                                <span className="text-muted-foreground">›</span>
                                <button
                                  className={cn(
                                    isLast
                                      ? "text-foreground font-semibold"
                                      : "text-primary hover:underline",
                                  )}
                                  onClick={() =>
                                    setSelectedGroupPath(crumbPath)
                                  }
                                >
                                  {part}
                                </button>
                              </span>
                            );
                          })}
                    </div>
                  )}
                  {/* Pinned hosts section - only at root level */}
                  {viewMode !== "tree" && !selectedGroupPath && pinnedHosts.length > 0 && (
                    <section className="space-y-2 mb-4">
                      <h3 className="text-sm font-semibold text-muted-foreground inline-flex items-center gap-1.5">
                        <Pin size={14} className="shrink-0 -translate-y-[1px]" />
                        {t("vault.hosts.pinned")}
                      </h3>
                      <div className={cn(
                        viewMode === "grid"
                          ? cn(
                            "grid gap-3",
                            !hasHostsSidePanel && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                          )
                          : "flex flex-col gap-0",
                      )}
                      style={viewMode === "grid" ? splitViewGridStyle : undefined}>
                        {pinnedHosts.map((host) => {
                          const safeHost = sanitizeHost(host);
                          const effectiveDistro = getEffectiveHostDistro(safeHost);
                          const distroBadge = {
                            text: (safeHost.os || "L")[0].toUpperCase(),
                            label: effectiveDistro || safeHost.os || "Linux",
                          };
                          return (
                            <ContextMenu key={host.id}>
                              <ContextMenuTrigger>
                                <div
                                  className={cn(
                                    "group cursor-pointer relative",
                                    viewMode === "grid"
                                      ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                      : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                                  )}
                                  style={lastPinnedId === host.id ? { animation: "pop-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" } : undefined}
                                  onAnimationEnd={() => { if (lastPinnedId === host.id) setLastPinnedId(null); }}
                                  draggable={!isMultiSelectMode}
                                  onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = "move";
                                    e.dataTransfer.setData("host-id", host.id);
                                  }}
                                  onClick={() => {
                                    if (isMultiSelectMode) {
                                      toggleHostSelection(host.id);
                                    } else {
                                      handleHostConnect(safeHost);
                                    }
                                  }}
                                >
                                  {viewMode === "grid" && (
                                    <Star size={10} className="absolute top-1.5 right-1.5 text-amber-400 fill-amber-400" />
                                  )}
                                  <div className="flex items-center gap-3 h-full">
                                    {isMultiSelectMode && (
                                      <div className="shrink-0">
                                        {selectedHostIds.has(host.id) ? (
                                          <CheckSquare size={18} className="text-primary" />
                                        ) : (
                                          <Square size={18} className="text-muted-foreground" />
                                        )}
                                      </div>
                                    )}
                                    <DistroAvatar host={safeHost} fallback={distroBadge.text} />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                      <span className="text-sm font-semibold truncate leading-5">
                                        {safeHost.label}
                                      </span>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                        {safeHost.username}@{safeHost.hostname}
                                      </div>
                                    </div>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleEditHost(host);
                                      }}
                                    >
                                      <Edit2 size={14} />
                                    </Button>
                                  </div>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem onClick={() => handleHostConnect(host)}>
                                  <Plug className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleEditHost(host)}>
                                  <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleDuplicateHost(host)}>
                                  <Copy className="mr-2 h-4 w-4" /> {t('action.duplicate')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleCopyCredentials(host)}>
                                  <ClipboardCopy className="mr-2 h-4 w-4" /> {t('vault.hosts.copyCredentials')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => toggleHostPinned(host.id)}>
                                  <Pin className="mr-2 h-4 w-4" /> {t('vault.hosts.unpin')}
                                </ContextMenuItem>
                                <ContextMenuItem className="text-destructive" onClick={() => onDeleteHost(host.id)}>
                                  <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          );
                        })}
                      </div>
                    </section>
                  )}
                  {/* Recently Connected section - only at root level, toggleable */}
                  {viewMode !== "tree" && !selectedGroupPath && showRecentHosts && recentHosts.length > 0 && (
                    <section className="space-y-2 mb-4">
                      <h3 className="text-sm font-semibold text-muted-foreground inline-flex items-center gap-1.5">
                        <Clock size={14} className="shrink-0 -translate-y-[1px]" />
                        {t("vault.hosts.recentlyConnected")}
                      </h3>
                      <div className={cn(
                        viewMode === "grid"
                          ? cn(
                            "grid gap-3",
                            !hasHostsSidePanel && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                          )
                          : "flex flex-col gap-0",
                      )}
                      style={viewMode === "grid" ? splitViewGridStyle : undefined}>
                        {recentHosts.map((host) => {
                          const safeHost = sanitizeHost(host);
                          const effectiveDistro = getEffectiveHostDistro(safeHost);
                          const distroBadge = {
                            text: (safeHost.os || "L")[0].toUpperCase(),
                            label: effectiveDistro || safeHost.os || "Linux",
                          };
                          return (
                            <ContextMenu key={host.id}>
                              <ContextMenuTrigger>
                                <div
                                  className={cn(
                                    "group cursor-pointer relative",
                                    viewMode === "grid"
                                      ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                      : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                                  )}
                                  draggable={!isMultiSelectMode}
                                  onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = "move";
                                    e.dataTransfer.setData("host-id", host.id);
                                  }}
                                  onClick={() => {
                                    if (isMultiSelectMode) {
                                      toggleHostSelection(host.id);
                                    } else {
                                      handleHostConnect(safeHost);
                                    }
                                  }}
                                >
                                  <div className="flex items-center gap-3 h-full">
                                    {isMultiSelectMode && (
                                      <div className="shrink-0">
                                        {selectedHostIds.has(host.id) ? (
                                          <CheckSquare size={18} className="text-primary" />
                                        ) : (
                                          <Square size={18} className="text-muted-foreground" />
                                        )}
                                      </div>
                                    )}
                                    <DistroAvatar host={safeHost} fallback={distroBadge.text} />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                      <span className="text-sm font-semibold truncate leading-5">
                                        {safeHost.label}
                                      </span>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                        {safeHost.username}@{safeHost.hostname}
                                      </div>
                                    </div>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleEditHost(host);
                                      }}
                                    >
                                      <Edit2 size={14} />
                                    </Button>
                                  </div>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem onClick={() => handleHostConnect(host)}>
                                  <Plug className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleEditHost(host)}>
                                  <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleDuplicateHost(host)}>
                                  <Copy className="mr-2 h-4 w-4" /> {t('action.duplicate')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => handleCopyCredentials(host)}>
                                  <ClipboardCopy className="mr-2 h-4 w-4" /> {t('vault.hosts.copyCredentials')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => toggleHostPinned(host.id)}>
                                  <Pin className="mr-2 h-4 w-4" /> {host.pinned ? t('vault.hosts.unpin') : t('vault.hosts.pinToTop')}
                                </ContextMenuItem>
                                <ContextMenuItem className="text-destructive" onClick={() => onDeleteHost(host.id)}>
                                  <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          );
                        })}
                      </div>
                    </section>
                  )}
                  {viewMode !== "tree" && displayedGroups.length > 0 && (
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        {t("vault.groups.title")}
                      </h3>
                      <div className="text-xs text-muted-foreground">
                        {t("vault.groups.total", { count: displayedGroups.length })}
                      </div>
                    </div>
                  )}
                  {viewMode !== "tree" && (
                    <div
                      className={cn(
                        displayedGroups.length === 0 ? "hidden" : "",
                        viewMode === "grid"
                          ? cn(
                            "grid gap-3",
                            !hasHostsSidePanel && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                          )
                          : "flex flex-col gap-0",
                      )}
                      style={viewMode === "grid" ? splitViewGridStyle : undefined}
                      onDragOver={(e) => {
                        e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const hostId = e.dataTransfer.getData("host-id");
                        const groupPath = e.dataTransfer.getData("group-path");
                        if (hostId) moveHostToGroup(hostId, selectedGroupPath);
                        if (groupPath && selectedGroupPath !== null)
                          moveGroup(groupPath, selectedGroupPath);
                      }}
                    >
                      {displayedGroups.map((node) => (
                        <ContextMenu key={node.path}>
                          <ContextMenuTrigger asChild>
                            <div
                              className={cn(
                                "group cursor-pointer transition-colors duration-150",
                                viewMode === "grid"
                                  ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                  : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                                getDropTargetClasses({ kind: "group", path: node.path }),
                              )}
                              draggable
                              onDragStart={(e) =>
                                e.dataTransfer.setData("group-path", node.path)
                              }
                              onDoubleClick={() =>
                                setSelectedGroupPath(node.path)
                              }
                              onClick={() => setSelectedGroupPath(node.path)}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setDragOverDropTarget({ kind: "group", path: node.path });
                              }}
                              onDragLeave={(e) => {
                                const nextTarget = e.relatedTarget;
                                if (isRelatedTargetInside(e.currentTarget, nextTarget)) {
                                  return;
                                }
                                setDragOverDropTarget((current) =>
                                  current?.kind === "group" && current.path === node.path ? null : current,
                                );
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setDragOverDropTarget(null);
                                const hostId =
                                  e.dataTransfer.getData("host-id");
                                const groupPath =
                                  e.dataTransfer.getData("group-path");
                                if (hostId) moveHostToGroup(hostId, node.path);
                                if (groupPath) moveGroup(groupPath, node.path);
                              }}
                            >
                              <div className="flex items-center gap-3 h-full">
                                <div className="h-11 w-11 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
                                  <FolderTree size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-semibold truncate flex items-center gap-2">
                                    {node.name}
                                    {managedGroupPaths.has(node.path) && (
                                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/15 text-primary shrink-0">
                                        <FileSymlink size={10} />
                                        Managed
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {t("vault.groups.hostsCount", { count: node.totalHostCount ?? node.hosts.length })}
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleEditGroupConfig(node.path);
                                  }}
                                >
                                  <Edit2 size={14} />
                                </Button>
                              </div>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onClick={() => {
                                setTargetParentPath(node.path);
                                setNewFolderName("");
                                setIsNewFolderOpen(true);
                              }}
                            >
                              <FolderPlus className="mr-2 h-4 w-4" /> {t("vault.groups.newSubgroup")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              onClick={() => handleEditGroupConfig(node.path)}
                            >
                              <Edit2 className="mr-2 h-4 w-4" /> {t("vault.groups.settings")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              className="text-destructive"
                              onClick={() => {
                                setDeleteTargetPath(node.path);
                                setIsDeleteGroupOpen(true);
                              }}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> {t("vault.groups.delete")}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      ))}
                    </div>
                  )}
                </section>

                {!shouldHideEmptyRootHostsSection && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-muted-foreground">
                      {t("vault.nav.hosts")}
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {t("vault.hosts.header.entries", { count: viewMode === "tree" ? treeViewHosts.length : visibleDisplayedHosts.length })}
                      </span>
                      <div className="bg-secondary/80 border border-border/70 rounded-md px-2 py-1 text-[11px]">
                        {t("vault.hosts.header.live", { count: sessionCount })}
                      </div>
                    </div>
                  </div>

                  {viewMode === "tree" ? (
                    <HostTreeView
                      groupTree={treeViewGroupTree}
                      hosts={treeViewHosts} // Use filtered and sorted hosts for tree view
                      sortMode={sortMode}
                      expandedPaths={treeExpandedState.expandedPaths}
                      onTogglePath={treeExpandedState.togglePath}
                      onExpandAll={treeExpandedState.expandAll}
                      onCollapseAll={treeExpandedState.collapseAll}
                      onConnect={handleHostConnect}
                      onEditHost={handleEditHost}
                      onDuplicateHost={handleDuplicateHost}
                      onDeleteHost={(host) => onDeleteHost(host.id)}
                      onCopyCredentials={handleCopyCredentials}

                      onNewHost={(groupPath) => {
                        setEditingHost(null);
                        setNewHostGroupPath(groupPath || null);
                        setIsHostPanelOpen(true);
                      }}
                      onNewGroup={(parentPath) => {
                        setTargetParentPath(parentPath || null);
                        setNewFolderName("");
                        setIsNewFolderOpen(true);
                      }}
                      onEditGroup={(groupPath) => handleEditGroupConfig(groupPath)}
                      onDeleteGroup={(groupPath) => {
                        setDeleteTargetPath(groupPath);
                        setIsDeleteGroupOpen(true);
                      }}
                      moveHostToGroup={moveHostToGroup}
                      moveGroup={moveGroup}
                      managedGroupPaths={managedGroupPaths}
                      onUnmanageGroup={handleUnmanageGroup}
                      isMultiSelectMode={isMultiSelectMode}
                      selectedHostIds={selectedHostIds}
                      toggleHostSelection={toggleHostSelection}
	                      getDropTargetClasses={(path) =>
	                        getDropTargetClasses({ kind: "group", path })
	                      }
	                      setDragOverDropTarget={setGroupDragOverDropTarget}
	                      groupConfigs={groupConfigs}
	                    />
                  ) : sortMode === "group" && groupedDisplayHosts ? (
                    <div className="space-y-6">
                        {groupedDisplayHosts.map((group) => (
                          <div key={group.name || "__ungrouped__"}>
                            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/40">
                              <FolderTree size={14} className="text-muted-foreground" />
                              <span className="text-sm font-medium text-muted-foreground">
                                {group.name || t("vault.groups.ungrouped")}
                              </span>
                              <span className="text-xs text-muted-foreground/60">
                                ({selectedGroupPath ? group.hosts.length : group.hosts.filter((h) => !pinnedRecentIds.has(h.id)).length})
                              </span>
                            </div>
                            <div
                              className={cn(
                                viewMode === "grid"
                                  ? cn(
                                    "grid gap-3",
                                    !hasHostsSidePanel && "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                                  )
                                  : "flex flex-col gap-0",
                              )}
                              style={viewMode === "grid" ? splitViewGridStyle : undefined}
                            >
                              {group.hosts.filter((h) => selectedGroupPath || !pinnedRecentIds.has(h.id)).map((host) => {
                                const safeHost = sanitizeHost(host);
                                const effectiveDistro = getEffectiveHostDistro(safeHost);
                                const distroBadge = {
                                  text: (safeHost.os || "L")[0].toUpperCase(),
                                  label: effectiveDistro || safeHost.os || "Linux",
                                };
                                return (
                                  <ContextMenu key={host.id}>
                                    <ContextMenuTrigger>
                                      <div
                                        className={cn(
                                          "group cursor-pointer relative",
                                          viewMode === "grid"
                                            ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                            : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                                        )}
                                        draggable
                                        onDragStart={(e) => {
                                          e.dataTransfer.effectAllowed = "move";
                                          e.dataTransfer.setData("host-id", host.id);
                                        }}
                                        onClick={() => {
                                          if (isMultiSelectMode) {
                                            toggleHostSelection(host.id);
                                          } else {
                                            handleHostConnect(safeHost);
                                          }
                                        }}
                                      >
                                        {host.pinned && viewMode === "grid" && (
                                          <Star size={10} className="absolute top-1.5 right-1.5 text-amber-400 fill-amber-400" />
                                        )}
                                        <div className="flex items-center gap-3 h-full">
                                          {isMultiSelectMode && (
                                            <div
                                              className="shrink-0"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleHostSelection(host.id);
                                              }}
                                            >
                                              {selectedHostIds.has(host.id) ? (
                                                <CheckSquare size={18} className="text-primary" />
                                              ) : (
                                                <Square size={18} className="text-muted-foreground" />
                                              )}
                                            </div>
                                          )}
                                          <DistroAvatar
                                            host={safeHost}
                                            fallback={distroBadge.text}
                                          />
                                          <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                            <div className="flex items-center gap-1.5">
                                              <span className="text-sm font-semibold truncate leading-5">
                                                {safeHost.label}
                                              </span>
                                              {safeHost.managedSourceId && (
                                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                                  managed
                                                </Badge>
                                              )}
                                            </div>
                                            <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                              {safeHost.username}@{safeHost.hostname}
                                            </div>
                                          </div>
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleEditHost(host);
                                            }}
                                          >
                                            <Edit2 size={14} />
                                          </Button>
                                        </div>
                                      </div>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                      <ContextMenuItem
                                        onClick={() => handleHostConnect(host)}
                                      >
                                        <Plug className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        onClick={() => handleEditHost(host)}
                                      >
                                        <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        onClick={() => handleDuplicateHost(host)}
                                      >
                                        <Copy className="mr-2 h-4 w-4" /> {t('action.duplicate')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        onClick={() => handleCopyCredentials(host)}
                                      >
                                        <ClipboardCopy className="mr-2 h-4 w-4" /> {t('vault.hosts.copyCredentials')}
                                      </ContextMenuItem>
                                      <ContextMenuItem onClick={() => toggleHostPinned(host.id)}>
                                        <Pin className="mr-2 h-4 w-4" /> {host.pinned ? t('vault.hosts.unpin') : t('vault.hosts.pinToTop')}
                                      </ContextMenuItem>
                                      <ContextMenuItem
                                        className="text-destructive"
                                        onClick={() => onDeleteHost(host.id)}
                                      >
                                        <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
                                      </ContextMenuItem>
                                    </ContextMenuContent>
                                  </ContextMenu>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                        {groupedDisplayHosts.length === 0 && (
                          <div className="col-span-full flex flex-col items-center justify-center py-24 text-muted-foreground">
                            <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                              <LayoutGrid size={32} className="opacity-60" />
                            </div>
                            <h3 className="text-lg font-semibold text-foreground mb-2">
                              {t('vault.hosts.empty.title')}
                            </h3>
                            <p className="text-sm text-center max-w-sm">
                              {t('vault.hosts.empty.desc')}
                            </p>
                          </div>
                        )}
                    </div>
                  ) : (
                    <div
                      className={cn(
                        viewMode === "grid"
                          ? cn(
                            "grid gap-3",
                            !hasHostsSidePanel && "grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                          )
                          : "flex flex-col gap-0",
                      )}
                      style={viewMode === "grid" ? splitViewGridStyle : undefined}
                    >
                      {visibleDisplayedHosts.map((host) => {
                          const safeHost = sanitizeHost(host);
                          const effectiveDistro = getEffectiveHostDistro(safeHost);
                          const distroBadge = {
                            text: (safeHost.os || "L")[0].toUpperCase(),
                            label: effectiveDistro || safeHost.os || "Linux",
                          };
                          return (
                            <ContextMenu key={host.id}>
                              <ContextMenuTrigger>
                                <div
                                  className={cn(
                                    "group cursor-pointer relative",
                                    viewMode === "grid"
                                      ? "soft-card elevate rounded-xl h-[68px] px-3 py-2"
                                      : "h-14 px-3 py-2 hover:bg-secondary/60 rounded-lg transition-colors",
                                  )}
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = "move";
                                    e.dataTransfer.setData("host-id", host.id);
                                  }}
                                  onClick={() => {
                                    if (isMultiSelectMode) {
                                      toggleHostSelection(host.id);
                                    } else {
                                      handleHostConnect(safeHost);
                                    }
                                  }}
                                >
                                  {host.pinned && viewMode === "grid" && (
                                    <Star size={10} className="absolute top-1.5 right-1.5 text-amber-400 fill-amber-400" />
                                  )}
                                  <div className="flex items-center gap-3 h-full">
                                    {isMultiSelectMode && (
                                      <div
                                        className="shrink-0"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleHostSelection(host.id);
                                        }}
                                      >
                                        {selectedHostIds.has(host.id) ? (
                                          <CheckSquare size={18} className="text-primary" />
                                        ) : (
                                          <Square size={18} className="text-muted-foreground" />
                                        )}
                                      </div>
                                    )}
                                    <DistroAvatar
                                      host={safeHost}
                                      fallback={distroBadge.text}
                                    />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-sm font-semibold truncate leading-5">
                                          {safeHost.label}
                                        </span>
                                        {safeHost.managedSourceId && (
                                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                            managed
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                        {safeHost.username}@{safeHost.hostname}
                                      </div>
                                    </div>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleEditHost(host);
                                      }}
                                    >
                                      <Edit2 size={14} />
                                    </Button>
                                  </div>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  onClick={() => handleHostConnect(host)}
                                >
                                  <Plug className="mr-2 h-4 w-4" /> {t('vault.hosts.connect')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() => handleEditHost(host)}
                                >
                                  <Edit2 className="mr-2 h-4 w-4" /> {t('action.edit')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() => handleDuplicateHost(host)}
                                >
                                  <Copy className="mr-2 h-4 w-4" /> {t('action.duplicate')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() => handleCopyCredentials(host)}
                                >
                                  <ClipboardCopy className="mr-2 h-4 w-4" /> {t('vault.hosts.copyCredentials')}
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => toggleHostPinned(host.id)}>
                                  <Pin className="mr-2 h-4 w-4" /> {host.pinned ? t('vault.hosts.unpin') : t('vault.hosts.pinToTop')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  className="text-destructive"
                                  onClick={() => onDeleteHost(host.id)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" /> {t('action.delete')}
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          );
                      })}
                      {displayedHosts.length === 0 && (
                        <div className="col-span-full flex flex-col items-center justify-center py-24 text-muted-foreground">
                          <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                            <LayoutGrid size={32} className="opacity-60" />
                          </div>
                          <h3 className="text-lg font-semibold text-foreground mb-2">
                            {t('vault.hosts.empty.title')}
                          </h3>
                          <p className="text-sm text-center max-w-sm">
                            {t('vault.hosts.empty.desc')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </section>
                )}
        </div>;
}
