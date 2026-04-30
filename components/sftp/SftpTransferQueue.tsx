import { GripHorizontal } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { useStoredNumber } from "../../application/state/useStoredNumber";
import type { useSftpState } from "../../application/state/useSftpState";
import {
  STORAGE_KEY_SFTP_TRANSFER_CHILD_NAME_WIDTH,
  STORAGE_KEY_SFTP_TRANSFER_PANEL_HEIGHT,
} from "../../infrastructure/config/storageKeys";
import type { TransferTask } from "../../types";
import { Button } from "../ui/button";
import { SftpTransferItem } from "./SftpTransferItem";

type SftpState = ReturnType<typeof useSftpState>;

interface SftpTransferQueueProps {
  sftp: SftpState;
  visibleTransfers: SftpState["transfers"];
  allTransfers: SftpState["transfers"];
  canRevealTransferTarget?: (task: TransferTask) => boolean;
  onRevealTransferTarget?: (task: TransferTask) => void | Promise<void>;
}

const MIN_PANEL_HEIGHT = 112;
const MAX_PANEL_HEIGHT = 480;
const HEADER_HEIGHT = 42;
const MIN_CHILD_NAME_WIDTH = 160;
const MAX_CHILD_NAME_WIDTH = 480;
const CHILD_ROW_HEIGHT = 28;
const CHILD_VIRTUALIZE_THRESHOLD = 80;
const CHILD_OVERSCAN = 8;
const childListIdForTask = (taskId: string) => `sftp-transfer-children-${taskId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

interface TransferChildListProps {
  childTasks: TransferTask[];
  childListId: string;
  childNameWidth: number;
  onResizeNameColumn: (event: React.MouseEvent<HTMLDivElement>) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  scrollTop: number;
  viewportHeight: number;
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  onSetNameColumnWidth: (width: number) => void;
}

const TransferChildList: React.FC<TransferChildListProps> = ({
  childTasks,
  childListId,
  childNameWidth,
  onResizeNameColumn,
  scrollContainerRef,
  scrollTop,
  viewportHeight,
  onCancel,
  onRetry,
  onDismiss,
  onSetNameColumnWidth,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [contentTop, setContentTop] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!container || !scrollContainer) return;

    const nextTop =
      container.getBoundingClientRect().top -
      scrollContainer.getBoundingClientRect().top +
      scrollTop;

    if (Math.abs(nextTop - contentTop) > 1) {
      setContentTop(nextTop);
    }
  }, [childTasks.length, contentTop, scrollContainerRef, scrollTop, viewportHeight]);

  const needsVirtualization = childTasks.length > CHILD_VIRTUALIZE_THRESHOLD;
  // Use a fallback viewport height when not yet measured to avoid rendering
  // all children on the first frame. This caps the initial render to ~15 rows
  // instead of potentially thousands.
  const effectiveViewportHeight = viewportHeight > 0 ? viewportHeight : MAX_PANEL_HEIGHT;
  const shouldVirtualize = needsVirtualization;

  const { startIndex, visibleTasks } = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        startIndex: 0,
        visibleTasks: childTasks,
      };
    }

    const relativeTop = Math.max(0, scrollTop - contentTop);
    const relativeBottom = Math.max(0, scrollTop + effectiveViewportHeight - contentTop);
    const start = Math.max(0, Math.floor(relativeTop / CHILD_ROW_HEIGHT) - CHILD_OVERSCAN);
    const end = Math.min(
      childTasks.length - 1,
      Math.ceil(relativeBottom / CHILD_ROW_HEIGHT) + CHILD_OVERSCAN,
    );

    return {
      startIndex: start,
      visibleTasks: childTasks.slice(start, end + 1),
    };
  }, [childTasks, contentTop, effectiveViewportHeight, scrollTop, shouldVirtualize]);

  return (
    <div
      id={childListId}
      ref={containerRef}
      className="border-t border-border/30 bg-background/30"
    >
      <div
        className={shouldVirtualize ? "relative" : undefined}
        style={shouldVirtualize ? { height: childTasks.length * CHILD_ROW_HEIGHT } : undefined}
      >
        {visibleTasks.map((child, visibleIndex) => {
          const index = shouldVirtualize ? startIndex + visibleIndex : visibleIndex;
          return (
            <div
              key={child.id}
              className={shouldVirtualize ? "absolute left-0 right-0" : undefined}
              style={shouldVirtualize ? { top: index * CHILD_ROW_HEIGHT } : undefined}
            >
              <SftpTransferItem
                task={child}
                isChild
                childNameColumnWidth={childNameWidth}
                childNameColumnMinWidth={MIN_CHILD_NAME_WIDTH}
                childNameColumnMaxWidth={MAX_CHILD_NAME_WIDTH}
                onResizeNameColumn={onResizeNameColumn}
                onSetNameColumnWidth={onSetNameColumnWidth}
                resizeHandleTabIndex={visibleIndex === 0 ? 0 : -1}
                onCancel={() => onCancel(child.id)}
                onRetry={() => onRetry(child.id)}
                onDismiss={() => onDismiss(child.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const SftpTransferQueue: React.FC<SftpTransferQueueProps> = ({
  sftp,
  visibleTransfers,
  allTransfers,
  canRevealTransferTarget,
  onRevealTransferTarget,
}) => {
  const { t } = useI18n();
  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});
  const [panelHeight, setPanelHeight, persistPanelHeight] = useStoredNumber(
    STORAGE_KEY_SFTP_TRANSFER_PANEL_HEIGHT,
    220,
    { min: MIN_PANEL_HEIGHT, max: MAX_PANEL_HEIGHT },
  );
  const [childNameWidth, setChildNameWidth, persistChildNameWidth] = useStoredNumber(
    STORAGE_KEY_SFTP_TRANSFER_CHILD_NAME_WIDTH,
    260,
    { min: MIN_CHILD_NAME_WIDTH, max: MAX_CHILD_NAME_WIDTH },
  );
  const panelHeightRef = useRef(panelHeight);
  const childNameWidthRef = useRef(childNameWidth);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const childColumnDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollFrameRef = useRef<number | null>(null);

  panelHeightRef.current = panelHeight;
  childNameWidthRef.current = childNameWidth;

  const childrenByParent = useMemo(() => {
    const map = new Map<string, TransferTask[]>();
    for (const task of allTransfers) {
      if (task.parentTaskId && task.status !== "cancelled") {
        const children = map.get(task.parentTaskId) || [];
        children.push(task);
        map.set(task.parentTaskId, children);
      }
    }
    for (const [parentId, children] of map) {
      map.set(
        parentId,
        [...children].sort((a, b) => b.startTime - a.startTime),
      );
    }
    return map;
  }, [allTransfers]);

  const topLevelTransfers = useMemo(
    () => visibleTransfers.filter((task) => !task.parentTaskId),
    [visibleTransfers],
  );

  const clampPanelHeight = useCallback((height: number) => {
    if (typeof window === "undefined") {
      return Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, height));
    }
    const viewportMax = Math.floor(window.innerHeight * 0.6);
    return Math.max(MIN_PANEL_HEIGHT, Math.min(Math.min(MAX_PANEL_HEIGHT, viewportMax), height));
  }, []);

  useEffect(() => {
    setExpandedParents((prev) => {
        const next: Record<string, boolean> = {};
        let changed = false;

      for (const task of topLevelTransfers) {
        const hasChildren = (childrenByParent.get(task.id)?.length ?? 0) > 0;
        if (!hasChildren) continue;
        next[task.id] = prev[task.id] ?? true;
        if (next[task.id] !== prev[task.id]) {
          changed = true;
        }
      }

      if (!changed && Object.keys(prev).length === Object.keys(next).length) {
        return prev;
      }

      return next;
    });
  }, [childrenByParent, topLevelTransfers]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const updateViewport = () => setViewportHeight(scrollContainer.clientHeight);
    updateViewport();

    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(scrollContainer);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (dragStateRef.current) {
        const deltaY = dragStateRef.current.startY - event.clientY;
        setPanelHeight(clampPanelHeight(dragStateRef.current.startHeight + deltaY));
      }
      if (childColumnDragRef.current) {
        const deltaX = event.clientX - childColumnDragRef.current.startX;
        const nextWidth = Math.max(
          MIN_CHILD_NAME_WIDTH,
          Math.min(MAX_CHILD_NAME_WIDTH, childColumnDragRef.current.startWidth + deltaX),
        );
        setChildNameWidth(nextWidth);
      }
    };

    const handleMouseUp = () => {
      const hadPanelDrag = !!dragStateRef.current;
      const hadChildColumnDrag = !!childColumnDragRef.current;
      dragStateRef.current = null;
      childColumnDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (hadPanelDrag) {
        persistPanelHeight(panelHeightRef.current);
      }
      if (hadChildColumnDrag) {
        persistChildNameWidth(childNameWidthRef.current);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clampPanelHeight, panelHeight, persistChildNameWidth, persistPanelHeight, setChildNameWidth, setPanelHeight]);

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    dragStateRef.current = {
      startY: event.clientY,
      startHeight: panelHeight,
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [panelHeight]);

  const handleChildColumnResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    childColumnDragRef.current = {
      startX: event.clientX,
      startWidth: childNameWidth,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [childNameWidth]);

  const handleChildColumnWidthSet = useCallback((width: number) => {
    const nextWidth = Math.max(MIN_CHILD_NAME_WIDTH, Math.min(MAX_CHILD_NAME_WIDTH, width));
    setChildNameWidth(nextWidth);
    persistChildNameWidth(nextWidth);
  }, [persistChildNameWidth, setChildNameWidth]);

  const toggleExpanded = useCallback((taskId: string) => {
    setExpandedParents((prev) => ({
      ...prev,
      [taskId]: !(prev[taskId] ?? true),
    }));
  }, []);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const nextTop = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(nextTop);
    });
  }, []);

  if (topLevelTransfers.length === 0) {
    return null;
  }

  return (
    <div
      className="border-t border-border/70 bg-secondary/80 supports-[backdrop-filter]:backdrop-blur-sm shrink-0"
      style={{ height: clampPanelHeight(panelHeight) }}
    >
      <div
        className="group flex h-3 cursor-row-resize items-center justify-center border-b border-border/30 text-muted-foreground/70"
        onMouseDown={handleResizeStart}
        title={t("sftp.transfers.dragToResize")}
      >
        <GripHorizontal size={14} className="transition-colors group-hover:text-foreground/80" />
      </div>

      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium">
          {t("sftp.transfers")}
          {sftp.activeTransfersCount > 0 && (
            <span className="ml-2 text-primary">
              ({t("sftp.transfers.active", { count: sftp.activeTransfersCount })})
            </span>
          )}
        </span>

        {sftp.transfers.some(
          (transfer) => transfer.status === "completed" || transfer.status === "cancelled",
        ) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={sftp.clearCompletedTransfers}
          >
            {t("sftp.transfers.clearCompleted")}
          </Button>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        className="overflow-auto"
        style={{ height: `calc(100% - ${HEADER_HEIGHT}px)` }}
        onScroll={handleScroll}
      >
        {topLevelTransfers.map((task) => {
          const childTasks = childrenByParent.get(task.id) ?? [];
          const isExpanded = expandedParents[task.id] ?? true;
          const childListId = childListIdForTask(task.id);

          return (
            <React.Fragment key={task.id}>
              <SftpTransferItem
                task={task}
                canToggleChildren={childTasks.length > 0}
                isExpanded={isExpanded}
                visibleChildCount={childTasks.length}
                childListId={childListId}
                onToggleChildren={() => toggleExpanded(task.id)}
                onCancel={() => {
                  if (task.sourceConnectionId === "external") {
                    sftp.cancelExternalUpload();
                  }
                  sftp.cancelTransfer(task.id);
                }}
                onRetry={() => sftp.retryTransfer(task.id)}
                onDismiss={() => sftp.dismissTransfer(task.id)}
                canRevealTarget={canRevealTransferTarget?.(task) ?? false}
                onRevealTarget={
                  onRevealTransferTarget
                    ? () => {
                        void onRevealTransferTarget(task);
                      }
                    : undefined
                }
              />

              {isExpanded && childTasks.length > 0 && (
                <TransferChildList
                  childTasks={childTasks}
                  childListId={childListId}
                  childNameWidth={childNameWidth}
                  onResizeNameColumn={handleChildColumnResizeStart}
                  onSetNameColumnWidth={handleChildColumnWidthSet}
                  scrollContainerRef={scrollContainerRef}
                  scrollTop={scrollTop}
                  viewportHeight={viewportHeight}
                  onCancel={(taskId) => sftp.cancelTransfer(taskId)}
                  onRetry={(taskId) => sftp.retryTransfer(taskId)}
                  onDismiss={(taskId) => sftp.dismissTransfer(taskId)}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
