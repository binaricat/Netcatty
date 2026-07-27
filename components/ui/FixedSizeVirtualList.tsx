import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { cn } from '../../lib/utils';
import { getFixedSizeVirtualWindow } from './virtualListMath';

const DEFAULT_OVERSCAN = 6;

export type FixedSizeVirtualListHandle = {
  scrollToIndex: (index: number, align?: 'auto' | 'center') => void;
};

interface FixedSizeVirtualListProps<T> {
  items: T[];
  itemHeight: number;
  className?: string;
  contentClassName?: string;
  overscan?: number;
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}

function FixedSizeVirtualListInner<T>(
  {
    items,
    itemHeight,
    className,
    contentClassName,
    overscan = DEFAULT_OVERSCAN,
    getItemKey,
    renderItem,
  }: FixedSizeVirtualListProps<T>,
  ref: React.ForwardedRef<FixedSizeVirtualListHandle>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

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

  const {
    startIndex,
    endIndex,
    effectiveScrollTop,
    totalHeight,
  } = getFixedSizeVirtualWindow({
    itemCount: items.length,
    itemHeight,
    scrollTop,
    viewportHeight,
    overscan,
  });

  // Sync the DOM scroll position when content shrinks (filter / data change).
  // Layout already uses effectiveScrollTop so the list never blanks for a frame.
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

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number, align = 'auto') => {
      const container = containerRef.current;
      if (!container || index < 0 || index >= items.length) return;

      const itemTop = index * itemHeight;
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
  }), [itemHeight, items.length]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn('h-full overflow-y-auto overflow-x-hidden', className)}
      onScroll={handleScroll}
    >
      <div
        className={cn('relative w-full', contentClassName)}
        style={{ height: totalHeight || undefined, minHeight: items.length === 0 ? 0 : totalHeight }}
      >
        {items.slice(startIndex, endIndex).map((item, offset) => {
          const index = startIndex + offset;
          return (
            <div
              key={getItemKey(item, index)}
              className="absolute left-0 right-0"
              style={{
                top: index * itemHeight,
                height: itemHeight,
              }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const FixedSizeVirtualList = forwardRef(FixedSizeVirtualListInner) as <T>(
  props: FixedSizeVirtualListProps<T> & { ref?: React.ForwardedRef<FixedSizeVirtualListHandle> },
) => React.ReactElement | null;
