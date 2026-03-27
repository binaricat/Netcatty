import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SftpFileEntry } from "../../../types";

interface UseSftpPaneVirtualListParams {
  isActive: boolean;
  enabled?: boolean;
  sortedDisplayFiles: SftpFileEntry[];
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
}: UseSftpPaneVirtualListParams): UseSftpPaneVirtualListResult => {
  const fileListRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const container = fileListRef.current;
    if (!container || !isActive || !enabled) return;
    const update = () => setViewportHeight(container.clientHeight);
    update();
    const raf = window.requestAnimationFrame(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, [enabled, isActive, sortedDisplayFiles.length]);

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
  }, [enabled, isActive, rowHeight, sortedDisplayFiles.length]);

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
    const canVirtualize = enabled && isActive && viewportHeight > 0 && rowHeight > 0;
    const shouldVirtualizeLocal = canVirtualize && sortedDisplayFiles.length > 50;
    const totalHeightLocal = shouldVirtualizeLocal
      ? sortedDisplayFiles.length * rowHeight
      : 0;
    const startIndex = shouldVirtualizeLocal
      ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
      : 0;
    const endIndex = shouldVirtualizeLocal
      ? Math.min(
        sortedDisplayFiles.length - 1,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
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
  }, [enabled, isActive, rowHeight, scrollTop, sortedDisplayFiles, viewportHeight]);

  return {
    fileListRef,
    rowHeight,
    handleFileListScroll,
    shouldVirtualize,
    totalHeight,
    visibleRows,
  };
};
