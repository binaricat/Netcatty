/**
 * SFTP Tab Bar Component
 *
 * A tab bar for managing multiple SFTP connections in a single pane.
 * Features:
 * - Tab items with close button
 * - Add button (+) to open HostSelectModal
 * - Scrollable when many tabs are open
 * - Drag-and-drop reordering of tabs
 */

import { HardDrive, Monitor, Plus, X } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { logger } from "../../lib/logger";
import { useRenderTracker } from "../../lib/useRenderTracker";
import { cn } from "../../lib/utils";
import { useActiveTabId } from "./SftpContext";

export interface SftpTab {
  id: string;
  label: string;
  isLocal: boolean;
  hostId: string | null;
}

interface SftpTabBarProps {
  tabs: SftpTab[];
  side: "left" | "right";
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
  onReorderTabs: (
    draggedId: string,
    targetId: string,
    position: "before" | "after",
  ) => void;
  /** Called when a tab is dragged to the other side */
  onMoveTabToOtherSide?: (tabId: string) => void;
}

const SftpTabBarInner: React.FC<SftpTabBarProps> = ({
  tabs,
  side,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onReorderTabs,
  onMoveTabToOtherSide,
}) => {
  // Subscribe to activeTabId from store (isolated subscription)
  const activeTabId = useActiveTabId(side);

  // 渲染追踪 - 追踪所有 props 包括回调函数
  useRenderTracker(`SftpTabBar[${side}]`, {
    side,
    tabsCount: tabs.length,
    activeTabId,
    // 追踪回调函数引用是否变化
    onSelectTab,
    onCloseTab,
    onAddTab,
    onReorderTabs,
    onMoveTabToOtherSide,
  });

  const { t } = useI18n();

  // Refs for scrollable tab container
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Drag state
  const [dropIndicator, setDropIndicator] = useState<{
    tabId: string;
    position: "before" | "after";
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isCrossPaneDragOver, setIsCrossPaneDragOver] = useState(false);
  const draggedTabIdRef = useRef<string | null>(null);

  // Global dragend listener to ensure state is reset even if the dragged element is removed
  useEffect(() => {
    const handleGlobalDragEnd = () => {
      if (draggedTabIdRef.current) {
        draggedTabIdRef.current = null;
        setDropIndicator(null);
        setIsDragging(false);
        setIsCrossPaneDragOver(false);
      }
    };

    document.addEventListener("dragend", handleGlobalDragEnd);
    return () => document.removeEventListener("dragend", handleGlobalDragEnd);
  }, []);

  // Check scroll state
  const updateScrollState = useCallback(() => {
    const container = tabsContainerRef.current;
    if (container) {
      setCanScrollLeft(container.scrollLeft > 0);
      setCanScrollRight(
        container.scrollLeft < container.scrollWidth - container.clientWidth - 1,
      );
    }
  }, []);

  // Update scroll state on mount and resize
  useEffect(() => {
    updateScrollState();
    const container = tabsContainerRef.current;
    if (container) {
      container.addEventListener("scroll", updateScrollState);
      const resizeObserver = new ResizeObserver(updateScrollState);
      resizeObserver.observe(container);
      return () => {
        container.removeEventListener("scroll", updateScrollState);
        resizeObserver.disconnect();
      };
    }
  }, [updateScrollState, tabs]);

  // Scroll to active tab when it changes
  useLayoutEffect(() => {
    if (!activeTabId) return;
    const container = tabsContainerRef.current;
    if (!container) return;

    const activeTabElement = container.querySelector(
      `[data-tab-id="${activeTabId}"]`,
    ) as HTMLElement | null;
    if (activeTabElement) {
      const containerRect = container.getBoundingClientRect();
      const tabRect = activeTabElement.getBoundingClientRect();

      if (tabRect.left < containerRect.left) {
        container.scrollLeft -= containerRect.left - tabRect.left + 8;
      } else if (tabRect.right > containerRect.right) {
        container.scrollLeft += tabRect.right - containerRect.right + 8;
      }
    }
    const timer = setTimeout(updateScrollState, 100);
    return () => clearTimeout(timer);
  }, [activeTabId, updateScrollState]);

  // Drag handlers
  const handleTabDragStart = useCallback(
    (e: React.DragEvent, tabId: string) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("sftp-tab-id", tabId);
      e.dataTransfer.setData("sftp-tab-side", side);
      draggedTabIdRef.current = tabId;
      setTimeout(() => {
        setIsDragging(true);
      }, 0);
    },
    [side],
  );

  const handleTabDragEnd = useCallback(() => {
    draggedTabIdRef.current = null;
    setDropIndicator(null);
    setIsDragging(false);
  }, []);

  const handleTabDragOver = useCallback(
    (e: React.DragEvent, tabId: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (!draggedTabIdRef.current || draggedTabIdRef.current === tabId) {
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      const position: "before" | "after" =
        e.clientX < midpoint ? "before" : "after";

      setDropIndicator({ tabId, position });
    },
    [],
  );

  const handleTabDrop = useCallback(
    (e: React.DragEvent, targetTabId: string) => {
      e.preventDefault();
      const draggedId =
        e.dataTransfer.getData("sftp-tab-id") || draggedTabIdRef.current;

      if (draggedId && draggedId !== targetTabId && dropIndicator) {
        onReorderTabs(draggedId, targetTabId, dropIndicator.position);
      }

      setDropIndicator(null);
      setIsDragging(false);
    },
    [dropIndicator, onReorderTabs],
  );

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      onCloseTab(tabId);
    },
    [onCloseTab],
  );

  // Cross-pane drag handlers
  const handleCrossPaneDragOver = useCallback(
    (e: React.DragEvent) => {
      const draggedFromSide = e.dataTransfer.types.includes("sftp-tab-side");
      if (!draggedFromSide) return;

      // Check if this is from the other side (we can't read the data during dragover due to browser security)
      // We'll set the indicator and validate on drop
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setIsCrossPaneDragOver(true);
    },
    [],
  );

  const handleCrossPaneDragLeave = useCallback(() => {
    setIsCrossPaneDragOver(false);
  }, []);

  const handleCrossPaneDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsCrossPaneDragOver(false);

      const draggedId = e.dataTransfer.getData("sftp-tab-id");
      const draggedFromSide = e.dataTransfer.getData("sftp-tab-side");

      // Only accept drops from the other side
      if (draggedId && draggedFromSide && draggedFromSide !== side && onMoveTabToOtherSide) {
        logger.info("[SftpTabBar] Cross-pane drop", {
          tabId: draggedId,
          fromSide: draggedFromSide,
          toSide: side,
        });
        onMoveTabToOtherSide(draggedId);
      }

      // Always reset drag state on drop
      draggedTabIdRef.current = null;
      setDropIndicator(null);
      setIsDragging(false);
    },
    [side, onMoveTabToOtherSide],
  );

  return (
    <div
      className={cn(
        "flex items-stretch h-8 bg-secondary/30 border-b border-border/40 transition-colors",
        isCrossPaneDragOver && "bg-primary/10 ring-1 ring-inset ring-primary/40",
      )}
      onDragOver={handleCrossPaneDragOver}
      onDragLeave={handleCrossPaneDragLeave}
      onDrop={handleCrossPaneDrop}
    >
      {/* Scrollable tabs container */}
      <div className="relative flex-1 min-w-0 flex">
        {/* Left fade mask */}
        {canScrollLeft && (
          <div
            className="absolute left-0 top-0 bottom-0 w-6 pointer-events-none z-10"
            style={{
              background:
                "linear-gradient(to right, hsl(var(--secondary) / 0.9), transparent)",
            }}
          />
        )}

        <div
          ref={tabsContainerRef}
          className="flex items-stretch overflow-x-auto scrollbar-none max-w-full"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            const isBeingDragged =
              isDragging && draggedTabIdRef.current === tab.id;
            const showDropIndicatorBefore =
              dropIndicator?.tabId === tab.id &&
              dropIndicator.position === "before";
            const showDropIndicatorAfter =
              dropIndicator?.tabId === tab.id &&
              dropIndicator.position === "after";

            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                onClick={() => onSelectTab(tab.id)}
                draggable
                onDragStart={(e) => handleTabDragStart(e, tab.id)}
                onDragEnd={handleTabDragEnd}
                onDragOver={(e) => handleTabDragOver(e, tab.id)}
                onDrop={(e) => handleTabDrop(e, tab.id)}
                className={cn(
                  "relative px-3 min-w-[100px] max-w-[180px] text-xs font-medium cursor-pointer flex items-center justify-between gap-2 flex-shrink-0 border-r border-border/40",
                  "transition-[color,opacity,transform] duration-100 ease-out",
                  isActive
                    ? "text-foreground border-b-2"
                    : "text-muted-foreground hover:text-foreground",
                  isBeingDragged && "opacity-50",
                )}
                style={
                  isActive
                    ? { borderBottomColor: "hsl(var(--accent))" }
                    : undefined
                }
              >
                {/* Drop indicator line - before */}
                {showDropIndicatorBefore && isDragging && (
                  <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary shadow-[0_0_8px_2px] shadow-primary/50 animate-pulse" />
                )}
                {/* Drop indicator line - after */}
                {showDropIndicatorAfter && isDragging && (
                  <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary shadow-[0_0_8px_2px] shadow-primary/50 animate-pulse" />
                )}

                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {tab.isLocal ? (
                    <Monitor
                      size={12}
                      className={cn(
                        "shrink-0",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  ) : (
                    <HardDrive
                      size={12}
                      className={cn(
                        "shrink-0",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  )}
                  <span className="truncate">{tab.label}</span>
                </div>

                <button
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className="p-0.5 hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0"
                  aria-label={t("common.close")}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Right fade mask */}
        {canScrollRight && (
          <div
            className="absolute right-0 top-0 bottom-0 w-6 pointer-events-none z-10"
            style={{
              background:
                "linear-gradient(to left, hsl(var(--secondary) / 0.9), transparent)",
            }}
          />
        )}
      </div>

      {/* Add tab button */}
      <button
        className="px-2 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[linear-gradient(135deg,_hsl(var(--accent)_/_0.18),_hsl(var(--primary)_/_0.18))] transition-all duration-150 border-l border-border/40 cursor-pointer"
        onClick={onAddTab}
        title={t("sftp.tabs.addTab")}
      >
        <Plus size={14} />
      </button>
    </div>
  );
};

// Custom comparison - only re-render when data props change, ignore callback refs
// Note: activeTabId is now subscribed internally, not passed as prop
const sftpTabBarAreEqual = (
  prev: SftpTabBarProps,
  next: SftpTabBarProps,
): boolean => {
  // Compare data props only
  if (prev.side !== next.side) return false;
  if (prev.tabs.length !== next.tabs.length) return false;

  // Deep compare tabs array
  for (let i = 0; i < prev.tabs.length; i++) {
    const prevTab = prev.tabs[i];
    const nextTab = next.tabs[i];
    if (
      prevTab.id !== nextTab.id ||
      prevTab.label !== nextTab.label ||
      prevTab.isLocal !== nextTab.isLocal ||
      prevTab.hostId !== nextTab.hostId
    ) {
      return false;
    }
  }

  // Ignore callback function refs - they may change but behavior is stable
  return true;
};

export const SftpTabBar = memo(SftpTabBarInner, sftpTabBarAreEqual);
SftpTabBar.displayName = "SftpTabBar";

