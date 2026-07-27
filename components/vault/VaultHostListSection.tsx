/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { HostNotesIndicator } from "../host/HostNotesIndicator";
import {
  getNextVirtualHostIndex,
  getVaultHostColumnCount,
  VirtualizedGroupedHostCollection,
  VirtualizedHostCollection,
} from "./VirtualizedHostCollection";
import { VaultEntityIcon, vaultPrimaryIconClass } from "./VaultEntityIcon";
import {
  clearVaultDropIndicator,
  getVaultDropIntent,
  getVaultDropPosition,
  hasVaultDragType,
  handleVaultHostDropToGroup,
  handleVaultRootDrop,
  markVaultDropIndicator,
  useVaultGridLayoutAnimation,
} from "./vaultReorderDrag";
import {
  hostCardFocusClassName,
  resolveGroupActivateAction,
  resolveHostActivateAction,
  shouldClearHostFocusOnBackgroundClick,
  type HostClickBehavior,
} from "../../domain/hostClickBehavior";
import type { GroupNode, Host } from "../../domain/models";

type VaultHostListSectionContext = Record<string, any>;

export const getVaultTreeAutoExpandKey = (
  search: string | undefined,
  selectedTags: string[] | undefined,
): string | undefined => {
  const normalizedSearch = search?.trim() ?? "";
  const normalizedTags = [...(selectedTags ?? [])].sort();
  return normalizedSearch || normalizedTags.length > 0
    ? JSON.stringify([normalizedSearch, normalizedTags])
    : undefined;
};

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
  const { Badge, Boolean, Button, cancelInlineGroupEdit, CheckSquare, ClipboardCopy, Clock, cn, commitInlineGroupRename, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Copy, displayedGroups, displayedHosts, DistroAvatar, Edit2, FileSymlink, FolderPlus, FolderTree, getDropTargetClasses, getEffectiveHostDistro, groupConfigs, groupedDisplayHosts, handleCopyCredentials, handleDuplicateHost, handleEditGroupConfig, handleEditHost, handleHostConnect, hostClickBehavior: hostClickBehaviorProp, handleUnmanageGroup, hasHostsSidePanel, hostListScrollRef, HostTreeView, isHostsSectionActive, isMultiSelectMode, lastPinnedId, LayoutGrid, managedGroupPaths, moveGroup, moveHostToGroup, onDeleteHost, Pin, pinnedHosts, Plug, recentHosts, reorderGroup, reorderHost, sanitizeHost, search, selectedGroupPath, selectedGroupPaths, selectedHostIds, selectedTags, sessionCount, setDeleteTargetPath, setDragOverDropTarget, setGroupDragOverDropTarget, setIsDeleteGroupOpen, setIsNewFolderOpen, setLastPinnedId, setNewFolderName, setSelectedGroupPath, setTargetParentPath, shouldHideEmptyRootHostsSection, showRecentHosts, sortMode, splitViewGridStyle, Square, Star, startInlineDeleteGroup, startInlineNewGroup, startInlineRenameGroup, t, toggleGroupSelection, toggleHostPinned, toggleHostSelection, Trash2, treeExpandedState, treeViewGroupTree, treeViewHosts, viewMode, visibleDisplayedHosts } = ctx;
  const hostClickBehavior: HostClickBehavior = hostClickBehaviorProp === 'select' ? 'select' : 'connect';
  const multiSelectedGroupPaths: Set<string> = selectedGroupPaths ?? new Set();
  const [draggingHostId, setDraggingHostId] = React.useState<string | null>(null);
  const draggingHostIdRef = React.useRef<string | null>(null);
  const lastPreviewReorderRef = React.useRef<string | null>(null);
  const prepareGridLayoutAnimation = useVaultGridLayoutAnimation(hostListScrollRef);
  const [focusedHostId, setFocusedHostId] = React.useState<string | null>(null);
  const [focusedGroupPath, setFocusedGroupPath] = React.useState<string | null>(null);
  const hostCollectionLayoutKey = [
    displayedGroups.length,
    hasHostsSidePanel ? "panel" : "full",
    lastPinnedId ?? "",
    pinnedHosts.length,
    recentHosts.length,
    selectedGroupPath ?? "root",
    showRecentHosts ? "recent" : "hidden",
    sortMode,
    viewMode,
  ].join("|");

  React.useEffect(() => {
    if (isMultiSelectMode) {
      setFocusedHostId(null);
      setFocusedGroupPath(null);
    }
  }, [isMultiSelectMode]);

  React.useEffect(() => {
    setFocusedHostId(null);
    setFocusedGroupPath(null);
  }, [selectedGroupPath, viewMode, hostClickBehavior]);

  const activateHost = React.useCallback((host: Host) => {
    const action = resolveHostActivateAction({
      behavior: hostClickBehavior,
      isMultiSelectMode,
      focusedHostId,
      hostId: host.id,
    });
    if (action === "toggle-multi") {
      toggleHostSelection(host.id);
      return;
    }
    if (action === "select") {
      setFocusedHostId(host.id);
      setFocusedGroupPath(null);
      return;
    }
    handleHostConnect(host);
  }, [focusedHostId, handleHostConnect, hostClickBehavior, isMultiSelectMode, toggleHostSelection]);

  const focusHost = React.useCallback((host: Host) => {
    setFocusedHostId(host.id);
    setFocusedGroupPath(null);
  }, []);
  const mainKeyboardHosts = groupedDisplayHosts
    ? groupedDisplayHosts.flatMap((group) => group.hosts)
    : visibleDisplayedHosts;
  const focusHostAndElement = (host: Host) => {
    focusHost(host);
    queueMicrotask(() => {
      const scrollElement = hostListScrollRef.current as HTMLElement | null;
      const element = [...(scrollElement?.querySelectorAll<HTMLElement>("[data-host-id]") ?? [])]
        .find((candidate) => candidate.dataset.hostId === host.id);
      element?.focus();
    });
  };
  const focusGroupAndElement = (group: GroupNode) => {
    setFocusedGroupPath(group.path);
    setFocusedHostId(null);
    queueMicrotask(() => {
      const scrollElement = hostListScrollRef.current as HTMLElement | null;
      const element = [...(scrollElement?.querySelectorAll<HTMLElement>("[data-group-path]") ?? [])]
        .find((candidate) => candidate.dataset.groupPath === group.path);
      element?.focus();
    });
  };
  const keyboardHostSections = [
    {
      key: "pinned",
      hasItems: pinnedHosts.length > 0,
      focusEdge: (direction: "previous" | "next") => focusHostAndElement(
        direction === "next" ? pinnedHosts[0] : pinnedHosts.at(-1)!,
      ),
    },
    {
      key: "recent",
      hasItems: showRecentHosts && recentHosts.length > 0,
      focusEdge: (direction: "previous" | "next") => focusHostAndElement(
        direction === "next" ? recentHosts[0] : recentHosts.at(-1)!,
      ),
    },
    {
      key: "groups",
      hasItems: displayedGroups.length > 0,
      focusEdge: (direction: "previous" | "next") => focusGroupAndElement(
        direction === "next" ? displayedGroups[0] : displayedGroups.at(-1)!,
      ),
    },
    {
      key: "main",
      hasItems: mainKeyboardHosts.length > 0,
      focusEdge: (direction: "previous" | "next") => focusHostAndElement(
        direction === "next" ? mainKeyboardHosts[0] : mainKeyboardHosts.at(-1)!,
      ),
    },
  ];
  const navigateHostSection = (
    sectionKey: "pinned" | "recent" | "groups" | "main",
    direction: "previous" | "next",
  ) => {
    const currentSectionIndex = keyboardHostSections.findIndex((section) => section.key === sectionKey);
    const step = direction === "next" ? 1 : -1;
    let sectionIndex = currentSectionIndex + step;
    while (sectionIndex >= 0 && sectionIndex < keyboardHostSections.length) {
      const section = keyboardHostSections[sectionIndex];
      if (section.hasItems) {
        section.focusEdge(direction);
        return;
      }
      sectionIndex += step;
    }
  };
  const initialKeyboardHostId = pinnedHosts[0]?.id
    ?? (showRecentHosts ? recentHosts[0]?.id : undefined)
    ?? groupedDisplayHosts?.[0]?.hosts[0]?.id
    ?? visibleDisplayedHosts[0]?.id;
  const focusedHostIsVisible = Boolean(
    focusedHostId
    && [
      ...pinnedHosts,
      ...(showRecentHosts ? recentHosts : []),
      ...mainKeyboardHosts,
    ].some((host) => host.id === focusedHostId),
  );
  const getHostTabIndex = (hostId: string) => (
    (focusedHostIsVisible ? focusedHostId === hostId : initialKeyboardHostId === hostId) ? 0 : -1
  );
  const initialKeyboardGroupPath = displayedGroups[0]?.path;
  const focusedGroupIsVisible = Boolean(
    focusedGroupPath && displayedGroups.some((group) => group.path === focusedGroupPath),
  );
  const getGroupTabIndex = (groupPath: string) => (
    (focusedGroupIsVisible ? focusedGroupPath === groupPath : initialKeyboardGroupPath === groupPath)
      ? 0
      : -1
  );

  const activateGroup = React.useCallback((groupPath: string) => {
    if (isMultiSelectMode) {
      toggleGroupSelection(groupPath);
      return;
    }
    const action = resolveGroupActivateAction({
      behavior: hostClickBehavior,
      focusedGroupPath,
      groupPath,
    });
    if (action === "select") {
      setFocusedGroupPath(groupPath);
      setFocusedHostId(null);
      return;
    }
    setSelectedGroupPath(groupPath);
  }, [focusedGroupPath, hostClickBehavior, isMultiSelectMode, setSelectedGroupPath, toggleGroupSelection]);

  const handleHostListClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    const clickedWithinHostList = target instanceof Node
      && event.currentTarget.contains(target);
    const clickedHostOrGroup = target instanceof Element
      && !!target.closest("[data-host-id], [data-group-path]");
    if (!shouldClearHostFocusOnBackgroundClick({
      behavior: hostClickBehavior,
      isMultiSelectMode,
      clickedWithinHostList,
      clickedHostOrGroup,
    })) return;
    setFocusedHostId(null);
    setFocusedGroupPath(null);
  }, [hostClickBehavior, isMultiSelectMode]);


  const handleHostDragStart = React.useCallback((e: React.DragEvent, hostId: string) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("host-id", hostId);
    draggingHostIdRef.current = hostId;
    setDraggingHostId(hostId);
    lastPreviewReorderRef.current = null;
  }, []);

  const resetHostDragState = React.useCallback(() => {
    draggingHostIdRef.current = null;
    setDraggingHostId(null);
    lastPreviewReorderRef.current = null;
    setDragOverDropTarget(null);
  }, [setDragOverDropTarget]);

  const renderHostEditButton = (host: any, compact = false) => (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Edit ${host.label || "host"}`}
      data-vault-host-edit-button={host.id}
      className={cn(
        "opacity-0 group-hover:opacity-100 transition-opacity shrink-0",
        compact ? "h-6 w-6" : "h-8 w-8",
      )}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        handleEditHost(host);
      }}
    >
      <Edit2 size={compact ? 13 : 14} />
    </Button>
  );

  const renderGroupEditButton = (groupPath: string, compact = false) => (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Edit ${groupPath || "group"}`}
      data-vault-group-edit-button={groupPath}
      className={cn(
        "opacity-0 group-hover:opacity-100 transition-opacity shrink-0",
        compact ? "h-6 w-6" : "h-8 w-8",
      )}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        handleEditGroupConfig(groupPath);
      }}
    >
      <Edit2 size={compact ? 13 : 14} />
    </Button>
  );

  return <div
          ref={hostListScrollRef}
          className={cn(
            "flex-1 overflow-auto px-4 pb-4 space-y-3",
            viewMode === "tree" ? "pt-1.5" : "pt-0",
            !isHostsSectionActive && "hidden",
          )}
          data-section="vault-host-list"
          onClick={handleHostListClick}
          onDragOverCapture={(e) => {
            const target = (e.target as Element | null)?.closest("[data-host-id], [data-group-path]");
            if (target) e.preventDefault();
            if (!(target instanceof HTMLElement)) return;
            const draggedGroupPath = e.dataTransfer.getData("group-path");
            const isDraggingGroup = hasVaultDragType(e.dataTransfer, "group-path");
            const targetGroupPath = target.getAttribute("data-group-path");
            if (isDraggingGroup && targetGroupPath && draggedGroupPath !== targetGroupPath) {
              const intent = getVaultDropIntent(target, e.clientX, e.clientY, viewMode === "grid");
              if (intent === "inside") {
                clearVaultDropIndicator();
                return;
              }
              markVaultDropIndicator(target, intent, viewMode === "grid" ? "x" : "y");
              return;
            }
            if (viewMode !== "grid") {
              markVaultDropIndicator(target, getVaultDropPosition(target, e.clientX, e.clientY));
              return;
            }

            const draggedHostId = draggingHostIdRef.current || e.dataTransfer.getData("host-id");
            const targetHostId = target.getAttribute("data-host-id");
            if (!draggedHostId || !targetHostId || draggedHostId === targetHostId) return;

            const position = getVaultDropPosition(target, e.clientX, e.clientY, true);
            const previewKey = `${draggedHostId}:${targetHostId}:${position}`;
            if (lastPreviewReorderRef.current === previewKey) return;

            prepareGridLayoutAnimation();
            lastPreviewReorderRef.current = previewKey;
            reorderHost(draggedHostId, targetHostId, position);
          }}
          onDragOver={(e) => {
            const target = (e.target as Element | null)?.closest("[data-host-id], [data-group-path]");
            if (!(target instanceof HTMLElement) || viewMode === "grid") return;
            const draggedGroupPath = e.dataTransfer.getData("group-path");
            const isDraggingGroup = hasVaultDragType(e.dataTransfer, "group-path");
            const targetGroupPath = target.getAttribute("data-group-path");
            if (isDraggingGroup && targetGroupPath && draggedGroupPath !== targetGroupPath) {
              const intent = getVaultDropIntent(target, e.clientX, e.clientY, false);
              if (intent === "inside") {
                clearVaultDropIndicator();
                return;
              }
              markVaultDropIndicator(target, intent);
              return;
            }
            markVaultDropIndicator(target, getVaultDropPosition(target, e.clientX, e.clientY));
          }}
          onDropCapture={(e) => {
            clearVaultDropIndicator();
            const draggedHostId = e.dataTransfer.getData("host-id");
            const draggedGroupPath = e.dataTransfer.getData("group-path");
            const target = (e.target as Element | null)?.closest("[data-host-id], [data-group-path]");
            if (!(target instanceof HTMLElement)) return;
            const targetHostId = target.getAttribute("data-host-id");
            const targetGroupPath = target.getAttribute("data-group-path");
            if (draggedHostId && targetHostId && draggedHostId !== targetHostId) {
              e.preventDefault();
              e.stopPropagation();
              const position = getVaultDropPosition(target, e.clientX, e.clientY, viewMode === "grid");
              const previewKey = `${draggedHostId}:${targetHostId}:${position}`;
              if (viewMode !== "grid" || lastPreviewReorderRef.current !== previewKey) {
                prepareGridLayoutAnimation();
                reorderHost(draggedHostId, targetHostId, position);
              }
              resetHostDragState();
              return;
            }
            if (draggedGroupPath && targetGroupPath && draggedGroupPath !== targetGroupPath) {
              const intent = getVaultDropIntent(target, e.clientX, e.clientY, viewMode === "grid");
              if (intent === "inside") return;
              prepareGridLayoutAnimation();
              const handled = reorderGroup(draggedGroupPath, targetGroupPath, intent);
              if (handled) {
                e.preventDefault();
                e.stopPropagation();
              }
            }
          }}
          onDragEndCapture={() => {
            clearVaultDropIndicator();
            resetHostDragState();
          }}
        >
                {viewMode !== "tree" && (
                  <section className="space-y-2 pt-2">
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
                          handleVaultRootDrop({
                            dataTransfer: e.dataTransfer,
                            preventDefault: () => e.preventDefault(),
                            setDragOverDropTarget,
                            moveGroup,
                            moveHostToGroup,
                            resetHostDragState,
                          });
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
                  </section>
                )}
                  {/* Pinned hosts section - only at root level */}
                  {viewMode !== "tree" && !selectedGroupPath && pinnedHosts.length > 0 && (
                    <section className="space-y-2 mb-4">
                      <h3 className="text-sm font-semibold text-muted-foreground inline-flex items-center gap-1.5">
                        <Pin size={14} className="shrink-0 -translate-y-[1px]" />
                        {t("vault.hosts.pinned")}
                      </h3>
                      <VirtualizedHostCollection<Host>
                        items={pinnedHosts}
                        itemKey={(host) => host.id}
                        scrollRef={hostListScrollRef}
                        viewMode={viewMode}
                        layoutKey={`pinned:${hostCollectionLayoutKey}`}
                        ariaLabel={t("vault.hosts.pinned")}
                        onActiveItemChange={focusHost}
                        activeItemKey={focusedHostId}
                        onBoundaryNavigation={(direction) => navigateHostSection("pinned", direction)}
                        renderItem={(host) => {
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
                                    "vault-drop-indicator-row group cursor-pointer relative",
                                    viewMode === "grid"
                                      ? cn(
                                        "soft-card elevate rounded-xl h-[68px] px-3 py-2 will-change-transform transition-[opacity,box-shadow,border-color,background-color] duration-150",
                                        draggingHostId === host.id && "opacity-45",
                                        hostCardFocusClassName(viewMode, focusedHostId === host.id),
                                      )
                                      : cn(
                                        "h-14 px-2 py-2 rounded-lg transition-colors",
                                        focusedHostId === host.id
                                          ? hostCardFocusClassName("list", true)
                                          : "hover:bg-secondary/60",
                                      ),
                                  )}
                                  data-host-id={host.id}
                                  data-vault-grid-item={`pinned:${host.id}`}
                                  role={isMultiSelectMode ? "checkbox" : "button"}
                                  aria-checked={isMultiSelectMode
                                    ? selectedHostIds.has(host.id)
                                    : undefined}
                                  tabIndex={getHostTabIndex(host.id)}
                                  style={lastPinnedId === host.id ? { animation: "pop-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" } : undefined}
                                  onAnimationEnd={() => { if (lastPinnedId === host.id) setLastPinnedId(null); }}
                                  draggable={!isMultiSelectMode}
                                  onDragStart={(e) => handleHostDragStart(e, host.id)}
                                  onClick={() => {
                                    activateHost(safeHost);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    activateHost(safeHost);
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
                                    <DistroAvatar host={safeHost} fallback={distroBadge.text} size="lg" />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-sm font-semibold truncate leading-5">
                                          {safeHost.label}
                                        </span>
                                        {viewMode !== "grid" && renderHostEditButton(host, true)}
                                        <HostNotesIndicator notes={safeHost.notes} />
                                      </div>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                        {safeHost.username}@{safeHost.hostname}
                                      </div>
                                    </div>
                                    {viewMode === "grid" && renderHostEditButton(host)}
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
                        }}
                      />
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
                                    "vault-drop-indicator-row group cursor-pointer relative",
                                    viewMode === "grid"
                                      ? cn(
                                        "soft-card elevate rounded-xl h-[68px] px-3 py-2 will-change-transform transition-[opacity,box-shadow,border-color,background-color] duration-150",
                                        draggingHostId === host.id && "opacity-45",
                                        hostCardFocusClassName(viewMode, focusedHostId === host.id),
                                      )
                                      : cn(
                                        "h-14 px-2 py-2 rounded-lg transition-colors",
                                        focusedHostId === host.id
                                          ? hostCardFocusClassName("list", true)
                                          : "hover:bg-secondary/60",
                                      ),
                                  )}
                                  data-host-id={host.id}
                                  data-vault-grid-item={`recent:${host.id}`}
                                  role={isMultiSelectMode ? "checkbox" : "button"}
                                  aria-checked={isMultiSelectMode
                                    ? selectedHostIds.has(host.id)
                                    : undefined}
                                  tabIndex={getHostTabIndex(host.id)}
                                  draggable={!isMultiSelectMode}
                                  onDragStart={(e) => handleHostDragStart(e, host.id)}
                                  onClick={() => {
                                    activateHost(safeHost);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      activateHost(safeHost);
                                      return;
                                    }
                                    const index = recentHosts.findIndex((item) => item.id === host.id);
                                    const nextIndex = getNextVirtualHostIndex({
                                      currentIndex: index,
                                      itemCount: recentHosts.length,
                                      columns: getVaultHostColumnCount(
                                        hostListScrollRef.current?.clientWidth ?? 0,
                                        viewMode,
                                      ),
                                      viewMode,
                                      key: event.key,
                                    });
                                    if (nextIndex === null) return;
                                    event.preventDefault();
                                    const nextHost = recentHosts[nextIndex];
                                    if (nextIndex !== index && nextHost) {
                                      focusHostAndElement(nextHost);
                                      return;
                                    }
                                    const direction = event.key === "ArrowUp" || event.key === "ArrowLeft"
                                      ? "previous"
                                      : event.key === "ArrowDown" || event.key === "ArrowRight"
                                        ? "next"
                                        : null;
                                    if (direction) navigateHostSection("recent", direction);
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
                                    <DistroAvatar host={safeHost} fallback={distroBadge.text} size="lg" />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-sm font-semibold truncate leading-5">
                                          {safeHost.label}
                                        </span>
                                        {viewMode !== "grid" && renderHostEditButton(host, true)}
                                        <HostNotesIndicator notes={safeHost.notes} />
                                      </div>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                        {safeHost.username}@{safeHost.hostname}
                                      </div>
                                    </div>
                                    {viewMode === "grid" && renderHostEditButton(host)}
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
                    <VirtualizedHostCollection<GroupNode>
                      items={displayedGroups}
                      itemKey={(node) => node.path}
                      scrollRef={hostListScrollRef}
                      viewMode={viewMode}
                      layoutKey={`groups:${hostCollectionLayoutKey}`}
                      ariaLabel={t("vault.groups.title")}
                      activeItemKey={focusedGroupIsVisible ? focusedGroupPath : null}
                      onActiveItemChange={(node) => {
                        setFocusedGroupPath(node.path);
                        setFocusedHostId(null);
                      }}
                      onBoundaryNavigation={(direction) => navigateHostSection("groups", direction)}
                      onDragOver={(e) => {
                        e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (handleVaultHostDropToGroup({
                          dataTransfer: e.dataTransfer,
                          groupPath: selectedGroupPath,
                          moveHostToGroup,
                          resetHostDragState,
                        })) return;
                        const groupPath = e.dataTransfer.getData("group-path");
                        if (groupPath && selectedGroupPath !== null)
                          moveGroup(groupPath, selectedGroupPath);
                      }}
                      renderItem={(node) => (
                        <ContextMenu key={node.path}>
                          <ContextMenuTrigger asChild>
                            <div
                              className={cn(
                                "vault-drop-indicator-row group cursor-pointer transition-colors duration-150",
                                viewMode === "grid"
                                  ? cn(
                                    "soft-card elevate rounded-xl h-[68px] px-3 py-2 will-change-transform transition-[box-shadow,border-color,background-color] duration-150",
                                    hostCardFocusClassName(
                                      "grid",
                                      focusedGroupPath === node.path || multiSelectedGroupPaths.has(node.path),
                                    ),
                                  )
                                  : cn(
                                    "h-14 px-2 py-2 rounded-lg transition-colors",
                                    focusedGroupPath === node.path || multiSelectedGroupPaths.has(node.path)
                                      ? hostCardFocusClassName("list", true)
                                      : "hover:bg-secondary/60",
                                  ),
                                getDropTargetClasses({ kind: "group", path: node.path }),
                              )}
                              data-group-path={node.path}
                              data-vault-grid-item={`group:${node.path}`}
                              data-vault-focus-target
                              role={isMultiSelectMode ? "checkbox" : "button"}
                              aria-checked={isMultiSelectMode
                                ? multiSelectedGroupPaths.has(node.path)
                                : undefined}
                              tabIndex={getGroupTabIndex(node.path)}
                              draggable={!isMultiSelectMode}
                              onDragStart={(e) =>
                                e.dataTransfer.setData("group-path", node.path)
                              }
                              onDoubleClick={() => {
                                if (!isMultiSelectMode) setSelectedGroupPath(node.path);
                              }}
                              onClick={() => activateGroup(node.path)}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                activateGroup(node.path);
                              }}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (hasVaultDragType(e.dataTransfer, "group-path")) {
                                  const intent = getVaultDropIntent(e.currentTarget, e.clientX, e.clientY, viewMode === "grid");
                                  if (intent !== "inside") {
                                    setDragOverDropTarget((current) =>
                                      current?.kind === "group" && current.path === node.path ? null : current,
                                    );
                                    return;
                                  }
                                }
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
                                if (handleVaultHostDropToGroup({
                                  dataTransfer: e.dataTransfer,
                                  groupPath: node.path,
                                  moveHostToGroup,
                                  resetHostDragState,
                                })) return;
                                const groupPath =
                                  e.dataTransfer.getData("group-path");
                                if (groupPath) {
                                  const intent = getVaultDropIntent(e.currentTarget, e.clientX, e.clientY, viewMode === "grid");
                                  if (intent === "inside") moveGroup(groupPath, node.path);
                                }
                              }}
                            >
                              <div className="flex items-center gap-3 h-full">
                                <VaultEntityIcon
                                  className={vaultPrimaryIconClass}
                                  icon={isMultiSelectMode
                                    ? multiSelectedGroupPaths.has(node.path)
                                      ? <CheckSquare size={20} />
                                      : <Square size={20} />
                                    : <FolderTree size={20} />}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-semibold flex items-center gap-1.5 min-w-0">
                                    <span className="truncate">{node.name}</span>
                                    {!isMultiSelectMode && viewMode !== "grid" && renderGroupEditButton(node.path, true)}
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
                                {!isMultiSelectMode && viewMode === "grid" && renderGroupEditButton(node.path)}
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
                      )}
                    />
                  )}

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
                      hosts={treeViewHosts}
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

                      onNewGroup={startInlineNewGroup}
                      onRenameGroup={startInlineRenameGroup}
                      onEditGroup={(groupPath) => handleEditGroupConfig(groupPath)}
                      commitInlineGroupRename={commitInlineGroupRename}
                      cancelInlineGroupEdit={cancelInlineGroupEdit}
                      onDeleteGroup={startInlineDeleteGroup}
                      moveHostToGroup={moveHostToGroup}
                      moveGroup={moveGroup}
                      managedGroupPaths={managedGroupPaths}
                      onUnmanageGroup={handleUnmanageGroup}
                      isMultiSelectMode={isMultiSelectMode}
                      selectedHostIds={selectedHostIds}
                      selectedGroupPaths={multiSelectedGroupPaths}
                      toggleHostSelection={toggleHostSelection}
                      toggleGroupSelection={toggleGroupSelection}
                      hostClickBehavior={hostClickBehavior}
                      focusedHostId={focusedHostId}
                      onFocusHost={setFocusedHostId}
                      focusedGroupPath={focusedGroupPath}
                      onFocusGroup={setFocusedGroupPath}
	                      getDropTargetClasses={(path) =>
	                        getDropTargetClasses({ kind: "group", path })
	                      }
                      setDragOverDropTarget={setGroupDragOverDropTarget}
                      groupConfigs={groupConfigs}
                      scrollRef={hostListScrollRef}
                      autoExpandGroupsKey={getVaultTreeAutoExpandKey(search, selectedTags)}
                    />
	                  ) : sortMode === "group" && groupedDisplayHosts ? (
	                    <>
	                        <VirtualizedGroupedHostCollection<Host>
	                          groups={groupedDisplayHosts}
	                              itemKey={(host) => host.id}
	                              scrollRef={hostListScrollRef}
	                              viewMode={viewMode}
	                              layoutKey={hostCollectionLayoutKey}
	                              ariaLabel={t("vault.nav.hosts")}
	                              onActiveItemChange={focusHost}
	                              activeItemKey={focusedHostId}
	                              onBoundaryNavigation={(direction) => navigateHostSection("main", direction)}
	                              renderGroupHeader={(group) => (
	                                <div className="flex w-full items-center gap-2 border-b border-border/40 pb-2">
	                                  <FolderTree size={14} className="text-muted-foreground" />
	                                  <span className="text-sm font-medium text-muted-foreground">
	                                    {group.name || t("vault.groups.ungrouped")}
	                                  </span>
	                                  <span className="text-xs text-muted-foreground/60">
	                                    ({group.hosts.length})
	                                  </span>
	                                </div>
	                              )}
	                              renderItem={(host: Host, group) => {
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
                                          "vault-drop-indicator-row group cursor-pointer relative",
                                          viewMode === "grid"
                                            ? cn(
                                              "soft-card elevate rounded-xl h-[68px] px-3 py-2 will-change-transform transition-[opacity,box-shadow,border-color,background-color] duration-150",
                                              draggingHostId === host.id && "opacity-45",
                                              hostCardFocusClassName(viewMode, focusedHostId === host.id),
                                            )
                                            : cn(
                                              "h-14 px-2 py-2 rounded-lg transition-colors",
                                              focusedHostId === host.id
                                                ? hostCardFocusClassName("list", true)
                                                : "hover:bg-secondary/60",
                                            ),
                                        )}
                                        data-host-id={host.id}
                                        data-vault-grid-item={`grouped:${group.name || "__ungrouped__"}:${host.id}`}
                                        role={isMultiSelectMode ? "checkbox" : "button"}
                                        aria-checked={isMultiSelectMode
                                          ? selectedHostIds.has(host.id)
                                          : undefined}
	                                        tabIndex={getHostTabIndex(host.id)}
                                        draggable={!isMultiSelectMode}
                                        onDragStart={(e) => handleHostDragStart(e, host.id)}
                                        onClick={() => {
                                          activateHost(safeHost);
                                        }}
                                        onKeyDown={(event) => {
                                          if (event.key !== "Enter" && event.key !== " ") return;
                                          event.preventDefault();
                                          activateHost(safeHost);
                                        }}
                                      >
                                        {host.pinned && viewMode === "grid" && (
                                          <Star size={10} className="absolute top-1.5 right-1.5 text-amber-400 fill-amber-400" />
                                        )}
                                        <div className="flex items-center gap-3 h-full">
                                          {isMultiSelectMode && (
                                            <div className="shrink-0" aria-hidden="true">
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
                                            size="lg"
                                          />
                                          <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                            <div className="flex items-center gap-1.5">
                                              <span className="text-sm font-semibold truncate leading-5">
                                                {safeHost.label}
                                              </span>
                                              {viewMode !== "grid" && renderHostEditButton(host, true)}
                                              {safeHost.managedSourceId && (
                                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                                  managed
                                                </Badge>
                                              )}
                                              <HostNotesIndicator notes={safeHost.notes} />
                                            </div>
                                            <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                              {safeHost.username}@{safeHost.hostname}
                                            </div>
                                          </div>
                                          {viewMode === "grid" && renderHostEditButton(host)}
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
	                              }}
	                            />
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
	                    </>
                  ) : (
                    <>
                      <VirtualizedHostCollection<Host>
                        items={visibleDisplayedHosts}
                        itemKey={(host) => host.id}
                        scrollRef={hostListScrollRef}
                        viewMode={viewMode}
                        layoutKey={hostCollectionLayoutKey}
                        ariaLabel={t("vault.nav.hosts")}
                        onActiveItemChange={focusHost}
                        activeItemKey={focusedHostId}
                        onBoundaryNavigation={(direction) => navigateHostSection("main", direction)}
                        renderItem={(host: Host) => {
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
                                    "vault-drop-indicator-row group cursor-pointer relative",
                                    viewMode === "grid"
                                      ? cn(
                                        "soft-card elevate rounded-xl h-[68px] px-3 py-2 will-change-transform transition-[opacity,box-shadow,border-color,background-color] duration-150",
                                        draggingHostId === host.id && "opacity-45",
                                        hostCardFocusClassName(viewMode, focusedHostId === host.id),
                                      )
                                      : cn(
                                        "h-14 px-2 py-2 rounded-lg transition-colors",
                                        focusedHostId === host.id
                                          ? hostCardFocusClassName("list", true)
                                          : "hover:bg-secondary/60",
                                      ),
                                  )}
                                  data-host-id={host.id}
                                  data-vault-grid-item={`main:${host.id}`}
                                  role={isMultiSelectMode ? "checkbox" : "button"}
                                  aria-checked={isMultiSelectMode
                                    ? selectedHostIds.has(host.id)
                                    : undefined}
                                  tabIndex={getHostTabIndex(host.id)}
                                  draggable={!isMultiSelectMode}
                                  onDragStart={(e) => handleHostDragStart(e, host.id)}
                                  onClick={() => {
                                    activateHost(safeHost);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    activateHost(safeHost);
                                  }}
                                >
                                  {host.pinned && viewMode === "grid" && (
                                    <Star size={10} className="absolute top-1.5 right-1.5 text-amber-400 fill-amber-400" />
                                  )}
                                  <div className="flex items-center gap-3 h-full">
                                    {isMultiSelectMode && (
                                      <div className="shrink-0" aria-hidden="true">
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
                                      size="lg"
                                    />
                                    <div className="min-w-0 flex flex-col justify-center gap-0.5 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-sm font-semibold truncate leading-5">
                                          {safeHost.label}
                                        </span>
                                        {viewMode !== "grid" && renderHostEditButton(host, true)}
                                        {safeHost.managedSourceId && (
                                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                                            managed
                                          </Badge>
                                        )}
                                        <HostNotesIndicator notes={safeHost.notes} />
                                      </div>
                                      <div className="text-[11px] text-muted-foreground font-mono truncate leading-4">
                                        {safeHost.username}@{safeHost.hostname}
                                      </div>
                                    </div>
                                    {viewMode === "grid" && renderHostEditButton(host)}
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
                        }}
                      />
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
                    </>
                  )}
                </section>
                )}
        </div>;
}
