import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '../../lib/utils';
import { clampScrollTop } from './virtualListMath';

const DEFAULT_OVERSCAN = 6;

export type VariableSizeVirtualListHandle = {
  scrollToIndex: (index: number, align?: 'auto' | 'center') => void;
};

interface VariableSizeVirtualListProps<T> {
  items: T[];
  getItemHeight: (item: T, index: number) => number;
  className?: string;
  contentClassName?: string;
  overscan?: number;
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}

function VariableSizeVirtualListInner<T>(
  {
    items,
    getItemHeight,
    className,
    contentClassName,
    overscan = DEFAULT_OVERSCAN,
    getItemKey,
    renderItem,
  }: VariableSizeVirtualListProps<T>,
  ref: React.ForwardedRef<VariableSizeVirtualListHandle>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const layout = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
      offsets.push(total);
      total += getItemHeight(items[i], i);
    }
    return { offsets, totalHeight: total };
  }, [getItemHeight, items]);

  const effectiveScrollTop = clampScrollTop(
    scrollTop,
    layout.totalHeight,
    viewportHeight,
  );

  // Sync DOM when content shrinks; render path already uses effectiveScrollTop.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (container.scrollTop !== effectiveScrollTop) {
      container.scrollTop = effectiveScrollTop;
    }
    if (scrollTop !== effectiveScrollTop) {
      setScrollTop(effectiveScrollTop);
    }
  }, [effectiveScrollTop, scrollTop]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewportHeight = () => {
      setViewportHeight(container.clientHeight);
    };

    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number, align = 'auto') => {
      const container = containerRef.current;
      if (!container || index < 0 || index >= items.length) return;

      const itemTop = layout.offsets[index] ?? 0;
      const itemHeight = getItemHeight(items[index], index);
      const itemBottom = itemTop + itemHeight;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;

      if (align === 'center') {
        container.scrollTop = Math.max(
          0,
          itemTop - (container.clientHeight - itemHeight) / 2,
        );
      } else if (itemTop < viewTop) {
        container.scrollTop = itemTop;
      } else if (itemBottom > viewBottom) {
        container.scrollTop = itemBottom - container.clientHeight;
      }
      setScrollTop(container.scrollTop);
    },
  }), [getItemHeight, items, layout.offsets]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const { startIndex, endIndex } = useMemo(() => {
    if (items.length === 0) {
      return { startIndex: 0, endIndex: 0 };
    }

    const { offsets } = layout;

    // First visible row: largest index whose top <= effectiveScrollTop.
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((offsets[mid] ?? 0) <= effectiveScrollTop) lo = mid;
      else hi = mid - 1;
    }
    const start = Math.max(0, lo - overscan);

    const viewBottom = effectiveScrollTop + viewportHeight;
    let scan = start;
    while (scan < items.length && (offsets[scan] ?? 0) < viewBottom + overscan * 40) {
      scan += 1;
    }
    const end = Math.min(items.length, scan + overscan);

    return { startIndex: start, endIndex: end };
  }, [effectiveScrollTop, items.length, layout, overscan, viewportHeight]);

  return (
    <div
      ref={containerRef}
      className={cn('h-full overflow-y-auto overflow-x-hidden', className)}
      onScroll={handleScroll}
    >
      <div
        className={cn('relative w-full', contentClassName)}
        style={{
          height: layout.totalHeight || undefined,
          minHeight: items.length === 0 ? 0 : layout.totalHeight,
        }}
      >
        {items.slice(startIndex, endIndex).map((item, offset) => {
          const index = startIndex + offset;
          const top = layout.offsets[index] ?? 0;
          const height = getItemHeight(item, index);
          return (
            <div
              key={getItemKey(item, index)}
              className="absolute left-0 right-0"
              style={{ top, height }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const VariableSizeVirtualList = forwardRef(VariableSizeVirtualListInner) as <T>(
  props: VariableSizeVirtualListProps<T> & { ref?: React.ForwardedRef<VariableSizeVirtualListHandle> },
) => React.ReactElement | null;
