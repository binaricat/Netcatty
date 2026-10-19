import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SftpFileEntry } from "../../../types";

interface UseSftpPaneVirtualListParams {
  isActive: boolean;
  enabled?: boolean;
  sortedDisplayFiles: SftpFileEntry[];
  layoutKey?: string;
}

interface UseSftpPaneVirtualListResult {
  fileListRef: React.RefObject<HTMLDivElement>;
  rowHeight: number;
  handleFileListScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  shouldVirtualize: boolean;
  totalHeight: number;
  visibleRows: { entry: SftpFileEntry; index: number; top: number }[];
}

export const useSftpPaneVirtualList = ({
  isActive,
  enabled = true,
  sortedDisplayFiles,
  layoutKey,
}: UseSftpPaneVirtualListParams): UseSftpPaneVirtualListResult => {
  const fileListRef = useRef<HTMLDivElement>(null);
  // Bound the first commit too; the mounted rows refine this estimate below.
  const [rowHeight, setRowHeight] = useState(44);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const container = fileListRef.current;
    if (!container || !isActive || !enabled) return;
    const update = () => {
      const height = container.clientHeight;
      setViewportHeight(height);
      // Scroll events are ignored while parked; the browser may still clamp
      // its position when a refreshed directory becomes shorter. Hidden
      // elements report zero geometry, so preserve their last visible offset.
      if (height > 0) setScrollTop(container.scrollTop);
    };
    update();
    const raf = window.requestAnimationFrame(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, [enabled, isActive, layoutKey, sortedDisplayFiles.length]);

  useLayoutEffect(() => {
    const container = fileListRef.current;
    if (!container || !isActive || !enabled || sortedDisplayFiles.length === 0) return;
    const raf = window.requestAnimationFrame(() => {
      const rowElement = container.querySelector(
        '[data-sftp-row="true"]',
      ) as HTMLElement | null;
      if (!rowElement) return;
      const nextHeight = Math.round(rowElement.getBoundingClientRect().height);
      if (nextHeight && Math.abs(nextHeight - rowHeight) > 1) {
        setRowHeight(nextHeight);
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [enabled, isActive, layoutKey, rowHeight, sortedDisplayFiles.length]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  const handleFileListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!isActive || !enabled) return;
      const nextTop = e.currentTarget.scrollTop;
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        setScrollTop(nextTop);
      });
    },
    [enabled, isActive],
  );

  const { shouldVirtualize, totalHeight, visibleRows } = useMemo(() => {
    const overscan = 6;
    // Hidden/unmeasured panes still need a window, rather than all file rows.
    const canVirtualize = enabled && rowHeight > 0;
    const shouldVirtualizeLocal = canVirtualize && sortedDisplayFiles.length > 50;
    const totalHeightLocal = shouldVirtualizeLocal
      ? sortedDisplayFiles.length * rowHeight
      : 0;
    const windowTop = Math.max(0, Math.min(
      scrollTop,
      totalHeightLocal - viewportHeight,
    ));
    const startIndex = shouldVirtualizeLocal
      ? Math.max(0, Math.floor(windowTop / rowHeight) - overscan)
      : 0;
    const endIndex = shouldVirtualizeLocal
      ? Math.min(
        sortedDisplayFiles.length - 1,
        Math.ceil((windowTop + viewportHeight) / rowHeight) + overscan,
      )
      : sortedDisplayFiles.length - 1;
    const visibleRowsLocal = shouldVirtualizeLocal
      ? sortedDisplayFiles
        .slice(startIndex, endIndex + 1)
        .map((entry, idx) => ({
          entry,
          index: startIndex + idx,
          top: (startIndex + idx) * rowHeight,
        }))
      : sortedDisplayFiles.map((entry, index) => ({
        entry,
        index,
        top: 0,
      }));

    return {
      shouldVirtualize: shouldVirtualizeLocal,
      totalHeight: totalHeightLocal,
      visibleRows: visibleRowsLocal,
    };
  }, [enabled, rowHeight, scrollTop, sortedDisplayFiles, viewportHeight]);

  return {
    fileListRef,
    rowHeight,
    handleFileListScroll,
    shouldVirtualize,
    totalHeight,
    visibleRows,
  };
};
