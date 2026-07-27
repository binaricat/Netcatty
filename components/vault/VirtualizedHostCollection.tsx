import { useVirtualizer } from "@tanstack/react-virtual";
import React from "react";
import {
  getVaultHostGridColumnCount,
  VAULT_HOST_GRID_GAP,
} from "./vaultHostGridLayout";

const GRID_CARD_HEIGHT = 68;
const LIST_ROW_HEIGHT = 56;
const INITIAL_VIEWPORT_HEIGHT = 800;
const OVERSCAN_ROWS = 3;

export type VirtualizedHostViewMode = "grid" | "list";

export function getVaultHostColumnCount(
  width: number,
  viewMode: VirtualizedHostViewMode,
): number {
  if (viewMode !== "grid") return 1;
  return getVaultHostGridColumnCount(width);
}

export function getNextVirtualHostIndex({
  currentIndex,
  itemCount,
  columns,
  viewMode,
  key,
}: {
  currentIndex: number;
  itemCount: number;
  columns: number;
  viewMode: VirtualizedHostViewMode;
  key: string;
}): number | null {
  let nextIndex = currentIndex;
  if (key === "Home") nextIndex = 0;
  else if (key === "End") nextIndex = itemCount - 1;
  else if (key === "ArrowLeft" && viewMode === "grid") nextIndex -= 1;
  else if (key === "ArrowRight" && viewMode === "grid") nextIndex += 1;
  else if (key === "ArrowUp") nextIndex -= viewMode === "grid" ? columns : 1;
  else if (key === "ArrowDown") nextIndex += viewMode === "grid" ? columns : 1;
  else return null;
  return Math.max(0, Math.min(itemCount - 1, nextIndex));
}

export function VirtualizedHostCollection<T>({
  items,
  itemKey,
  renderItem,
  scrollRef,
  viewMode,
  layoutKey,
  ariaLabel,
  onActiveItemChange,
}: {
  items: T[];
  itemKey: (item: T) => React.Key;
  renderItem: (item: T) => React.ReactNode;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  viewMode: VirtualizedHostViewMode;
  layoutKey?: React.Key;
  ariaLabel?: string;
  onActiveItemChange?: (item: T) => void;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const pendingFocusKeyRef = React.useRef<string | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(
    viewMode === "grid" ? 1280 : 0,
  );
  const [scrollMargin, setScrollMargin] = React.useState(0);
  const columns = getVaultHostColumnCount(containerWidth, viewMode);
  const rowCount = Math.ceil(items.length / columns);
  const rowHeight = viewMode === "grid" ? GRID_CARD_HEIGHT : LIST_ROW_HEIGHT;
  const rowGap = viewMode === "grid" ? VAULT_HOST_GRID_GAP : 0;
  const itemIndexByKey = React.useMemo(() => new Map(
    items.map((item, index) => [String(itemKey(item)), index]),
  ), [itemKey, items]);

  const getRowKey = React.useCallback((rowIndex: number) => {
    const firstItem = items[rowIndex * columns];
    return firstItem === undefined ? rowIndex : itemKey(firstItem);
  }, [columns, itemKey, items]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    gap: rowGap,
    getItemKey: getRowKey,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    initialRect: typeof window === "undefined"
      ? { width: 1280, height: INITIAL_VIEWPORT_HEIGHT }
      : undefined,
  });

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const scrollElement = scrollRef.current;
    if (!root || !scrollElement) return;

    const measure = () => {
      const nextWidth = root.clientWidth;
      const rootRect = root.getBoundingClientRect();
      const scrollRect = scrollElement.getBoundingClientRect();
      const nextScrollMargin = rootRect.top - scrollRect.top + scrollElement.scrollTop;
      setContainerWidth((current) => current === nextWidth ? current : nextWidth);
      setScrollMargin((current) => current === nextScrollMargin ? current : nextScrollMargin);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [items.length, layoutKey, scrollRef, viewMode]);

  React.useLayoutEffect(() => {
    virtualizer.measure();
  }, [columns, items.length, virtualizer, viewMode]);

  const focusRenderedItem = React.useCallback((key: string) => {
    const root = rootRef.current;
    if (!root) return false;
    const wrapper = [...root.querySelectorAll<HTMLElement>("[data-vault-item-key]")]
      .find((element) => element.dataset.vaultItemKey === key);
    const focusTarget = wrapper?.querySelector<HTMLElement>("[data-host-id]");
    if (!focusTarget) return false;
    focusTarget.focus();
    return true;
  }, []);

  React.useLayoutEffect(() => {
    const key = pendingFocusKeyRef.current;
    if (!key || !focusRenderedItem(key)) return;
    pendingFocusKeyRef.current = null;
  });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const wrapper = target.closest<HTMLElement>("[data-vault-item-key]");
    const currentIndex = wrapper
      ? itemIndexByKey.get(wrapper.dataset.vaultItemKey ?? "")
      : undefined;
    if (currentIndex === undefined) return;
    const nextIndex = getNextVirtualHostIndex({
      currentIndex,
      itemCount: items.length,
      columns,
      viewMode,
      key: event.key,
    });
    if (nextIndex === null) return;
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    const nextItem = items[nextIndex];
    const nextKey = String(itemKey(nextItem));
    pendingFocusKeyRef.current = nextKey;
    onActiveItemChange?.(nextItem);
    virtualizer.scrollToIndex(Math.floor(nextIndex / columns), { align: "auto" });
    queueMicrotask(() => {
      if (focusRenderedItem(nextKey)) pendingFocusKeyRef.current = null;
    });
  };

  return (
    <div
      ref={rootRef}
      className="relative min-w-0"
      style={{ height: virtualizer.getTotalSize() }}
      data-vault-virtual-collection={viewMode}
      role={viewMode === "grid" ? "grid" : "list"}
      aria-rowcount={viewMode === "grid" ? rowCount : undefined}
      aria-colcount={viewMode === "grid" ? columns : undefined}
      aria-label={ariaLabel}
      onKeyDownCapture={handleKeyDown}
      onFocusCapture={(event) => {
        const wrapper = (event.target as HTMLElement).closest<HTMLElement>("[data-vault-item-key]");
        const index = wrapper
          ? itemIndexByKey.get(wrapper.dataset.vaultItemKey ?? "")
          : undefined;
        if (index !== undefined) onActiveItemChange?.(items[index]);
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const rowStart = virtualRow.index * columns;
        const rowItems = items.slice(rowStart, rowStart + columns);
        return (
          <div
            key={virtualRow.key}
            data-vault-virtual-row={virtualRow.index}
            className="absolute left-0 top-0 grid w-full min-w-0"
            style={{
              height: rowHeight,
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              columnGap: viewMode === "grid" ? VAULT_HOST_GRID_GAP : 0,
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
            role={viewMode === "grid" ? "row" : undefined}
            aria-rowindex={viewMode === "grid" ? virtualRow.index + 1 : undefined}
          >
            {rowItems.map((item, columnIndex) => (
              <div
                key={itemKey(item)}
                className="contents"
                data-vault-item-key={String(itemKey(item))}
                role={viewMode === "grid" ? "gridcell" : "listitem"}
                aria-colindex={viewMode === "grid" ? columnIndex + 1 : undefined}
                aria-posinset={viewMode === "list" ? rowStart + columnIndex + 1 : undefined}
                aria-setsize={viewMode === "list" ? items.length : undefined}
              >
                {renderItem(item)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

type VirtualizedHostGroup<T> = {
  name: string;
  hosts: T[];
};

type VirtualizedGroupedRow<T> =
  | { kind: "header"; group: VirtualizedHostGroup<T> }
  | {
    kind: "hosts";
    group: VirtualizedHostGroup<T>;
    hosts: T[];
    hostStartIndex: number;
  };

export function VirtualizedGroupedHostCollection<T>({
  groups,
  itemKey,
  renderGroupHeader,
  renderItem,
  scrollRef,
  viewMode,
  layoutKey,
  ariaLabel,
  onActiveItemChange,
}: {
  groups: Array<VirtualizedHostGroup<T>>;
  itemKey: (item: T) => React.Key;
  renderGroupHeader: (group: VirtualizedHostGroup<T>) => React.ReactNode;
  renderItem: (item: T, group: VirtualizedHostGroup<T>) => React.ReactNode;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  viewMode: VirtualizedHostViewMode;
  layoutKey?: React.Key;
  ariaLabel?: string;
  onActiveItemChange?: (item: T) => void;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const pendingFocusKeyRef = React.useRef<string | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(
    viewMode === "grid" ? 1280 : 0,
  );
  const [scrollMargin, setScrollMargin] = React.useState(0);
  const columns = getVaultHostColumnCount(containerWidth, viewMode);
  const rows = React.useMemo(() => {
    const result: Array<VirtualizedGroupedRow<T>> = [];
    let hostStartIndex = 0;
    for (const group of groups) {
      result.push({ kind: "header", group });
      for (let index = 0; index < group.hosts.length; index += columns) {
        result.push({
          kind: "hosts",
          group,
          hosts: group.hosts.slice(index, index + columns),
          hostStartIndex,
        });
        hostStartIndex += Math.min(columns, group.hosts.length - index);
      }
    }
    return result;
  }, [columns, groups]);
  const totalHostCount = React.useMemo(
    () => groups.reduce((count, group) => count + group.hosts.length, 0),
    [groups],
  );
  const flatItems = React.useMemo(() => groups.flatMap((group) => group.hosts), [groups]);
  const itemIndexByKey = React.useMemo(() => new Map(
    flatItems.map((item, index) => [String(itemKey(item)), index]),
  ), [flatItems, itemKey]);
  const hostRowHeight = viewMode === "grid" ? GRID_CARD_HEIGHT + VAULT_HOST_GRID_GAP : LIST_ROW_HEIGHT;
  const headerRowHeight = viewMode === "grid" ? 56 : 44;

  const getRowKey = React.useCallback((rowIndex: number) => {
    const row = rows[rowIndex];
    if (!row) return rowIndex;
    if (row.kind === "header") return `group:${row.group.name}`;
    return `hosts:${row.group.name}:${String(itemKey(row.hosts[0]))}`;
  }, [itemKey, rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === "header"
      ? headerRowHeight
      : hostRowHeight,
    getItemKey: getRowKey,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    initialRect: typeof window === "undefined"
      ? { width: 1280, height: INITIAL_VIEWPORT_HEIGHT }
      : undefined,
  });

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const scrollElement = scrollRef.current;
    if (!root || !scrollElement) return;

    const measure = () => {
      const nextWidth = root.clientWidth;
      const rootRect = root.getBoundingClientRect();
      const scrollRect = scrollElement.getBoundingClientRect();
      const nextScrollMargin = rootRect.top - scrollRect.top + scrollElement.scrollTop;
      setContainerWidth((current) => current === nextWidth ? current : nextWidth);
      setScrollMargin((current) => current === nextScrollMargin ? current : nextScrollMargin);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [groups.length, layoutKey, scrollRef, viewMode]);

  React.useLayoutEffect(() => {
    virtualizer.measure();
  }, [columns, rows.length, virtualizer, viewMode]);

  const focusRenderedItem = React.useCallback((key: string) => {
    const root = rootRef.current;
    if (!root) return false;
    const wrapper = [...root.querySelectorAll<HTMLElement>("[data-vault-item-key]")]
      .find((element) => element.dataset.vaultItemKey === key);
    const focusTarget = wrapper?.querySelector<HTMLElement>("[data-host-id]");
    if (!focusTarget) return false;
    focusTarget.focus();
    return true;
  }, []);

  React.useLayoutEffect(() => {
    const key = pendingFocusKeyRef.current;
    if (!key || !focusRenderedItem(key)) return;
    pendingFocusKeyRef.current = null;
  });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const wrapper = target.closest<HTMLElement>("[data-vault-item-key]");
    const currentIndex = wrapper
      ? itemIndexByKey.get(wrapper.dataset.vaultItemKey ?? "")
      : undefined;
    if (currentIndex === undefined) return;
    const nextIndex = getNextVirtualHostIndex({
      currentIndex,
      itemCount: flatItems.length,
      columns,
      viewMode,
      key: event.key,
    });
    if (nextIndex === null) return;
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    const nextItem = flatItems[nextIndex];
    const nextKey = String(itemKey(nextItem));
    const rowIndex = rows.findIndex((row) => (
      row.kind === "hosts"
      && nextIndex >= row.hostStartIndex
      && nextIndex < row.hostStartIndex + row.hosts.length
    ));
    pendingFocusKeyRef.current = nextKey;
    onActiveItemChange?.(nextItem);
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
    queueMicrotask(() => {
      if (focusRenderedItem(nextKey)) pendingFocusKeyRef.current = null;
    });
  };

  return (
    <div
      ref={rootRef}
      className="relative min-w-0"
      style={{ height: virtualizer.getTotalSize() }}
      data-vault-virtual-grouped-collection={viewMode}
      role={viewMode === "grid" ? "grid" : "list"}
      aria-rowcount={viewMode === "grid" ? rows.length : undefined}
      aria-colcount={viewMode === "grid" ? columns : undefined}
      aria-label={ariaLabel}
      onKeyDownCapture={handleKeyDown}
      onFocusCapture={(event) => {
        const wrapper = (event.target as HTMLElement).closest<HTMLElement>("[data-vault-item-key]");
        const index = wrapper
          ? itemIndexByKey.get(wrapper.dataset.vaultItemKey ?? "")
          : undefined;
        if (index !== undefined) onActiveItemChange?.(flatItems[index]);
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        return (
          <div
            key={virtualRow.key}
            data-vault-virtual-row={virtualRow.index}
            className="absolute left-0 top-0 w-full min-w-0"
            style={{
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
            role={viewMode === "grid" ? "row" : undefined}
            aria-rowindex={viewMode === "grid" ? virtualRow.index + 1 : undefined}
          >
            {row.kind === "header" ? (
              <div
                className="flex h-full items-end pb-3"
                role={viewMode === "grid" ? "gridcell" : "heading"}
                aria-colspan={viewMode === "grid" ? columns : undefined}
                aria-level={viewMode === "list" ? 4 : undefined}
              >
                {renderGroupHeader(row.group)}
              </div>
            ) : (
              <div
                className="grid w-full min-w-0"
                style={{
                  height: viewMode === "grid" ? GRID_CARD_HEIGHT : LIST_ROW_HEIGHT,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  columnGap: viewMode === "grid" ? VAULT_HOST_GRID_GAP : 0,
                }}
              >
                {row.hosts.map((item, columnIndex) => (
                  <div
                    key={itemKey(item)}
                    className="contents"
                    data-vault-item-key={String(itemKey(item))}
                    role={viewMode === "grid" ? "gridcell" : "listitem"}
                    aria-colindex={viewMode === "grid" ? columnIndex + 1 : undefined}
                    aria-posinset={viewMode === "list" ? row.hostStartIndex + columnIndex + 1 : undefined}
                    aria-setsize={viewMode === "list" ? totalHostCount : undefined}
                  >
                    {renderItem(item, row.group)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
