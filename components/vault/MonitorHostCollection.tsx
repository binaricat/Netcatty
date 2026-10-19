import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  MONITOR_CARD_HEIGHT,
  MONITOR_COLUMNS,
  monitorGridColumns,
  type MonitorColumn,
} from "../../domain/monitorTableLayout";
import { useMonitorTableColumns } from "../../application/state/useMonitorTableColumns";
import { useI18n } from "../../application/i18n/I18nProvider";

import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
} from "../ui/context-menu";

export function MonitorHostCollection<T extends { id: string }>({
  items,
  view,
  layoutKey,
  pinnedId,
  renderCard,
  renderCells,
  rowProps,
  renderMenu,
}: {
  items: T[];
  view: "list" | "charts";
  layoutKey: string;
  pinnedId?: string;
  renderCard: (item: T) => React.ReactNode;
  renderCells: (item: T) => Record<MonitorColumn, React.ReactNode>;
  rowProps: (item: T) => React.HTMLAttributes<HTMLTableRowElement>;
  renderMenu: (item: T) => React.ReactNode;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1248);
  const { widths, resize, startResize, hidden, setVisible } =
    useMonitorTableColumns();
  const visibleColumns = MONITOR_COLUMNS.filter(
    ({ key }) => !hidden.includes(key),
  );
  const columns =
    view === "charts" ? monitorGridColumns(width, items.length) : 1;
  const scrollMargin = view === "charts" ? 16 : 56;
  const pinnedIndex = pinnedId
    ? items.findIndex((item) => item.id === pinnedId)
    : -1;
  const getItemKey = useCallback(
    (index: number) => items[index * columns]?.id ?? index,
    [items, columns],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: Math.ceil(items.length / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (view === "charts" ? MONITOR_CARD_HEIGHT : 76),
    gap: view === "charts" ? 16 : 8,
    overscan: view === "charts" ? 2 : 5,
    getItemKey,
    scrollMargin,
    initialRect: { width: 1280, height: 800 },
    rangeExtractor: useCallback(
      (range) => {
        const visible = defaultRangeExtractor(range);
        const pinned = Math.floor(pinnedIndex / columns);
        return pinnedIndex < 0 || visible.includes(pinned)
          ? visible
          : [...visible, pinned].sort((a, b) => a - b);
      },
      [pinnedIndex, columns],
    ),
  });
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(0, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [columns, view, hidden, virtualizer]);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    virtualizer.scrollToOffset(0);
  }, [layoutKey, virtualizer]);
  const template = visibleColumns
    .map((column) => `${widths[column.key]}px`)
    .join(" ");
  const tableWidth = visibleColumns.reduce(
    (sum, column) => sum + widths[column.key],
    0,
  );
  return (
    <div className="min-h-0 min-w-0 flex-1 px-4">
      <div
        ref={scrollRef}
        className="h-full min-w-0 overflow-auto"
        data-section="vault-monitor-list"
        data-monitor-virtual={view}
      >
        <div className="py-4">
          {view === "charts" ? (
            <div
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((row) => (
                <div
                  key={row.key}
                  data-monitor-virtual-row={row.index}
                  className="absolute left-0 top-0 grid w-full gap-4"
                  style={{
                    height: MONITOR_CARD_HEIGHT,
                    gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`,
                    transform: `translateY(${row.start - scrollMargin}px)`,
                  }}
                >
                  {items
                    .slice(row.index * columns, (row.index + 1) * columns)
                    .map((item) => (
                      <ContextMenu key={item.id}>
                        <ContextMenuTrigger asChild>
                          {renderCard(item)}
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          {renderMenu(item)}
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                </div>
              ))}
            </div>
          ) : (
            <table
              className="block text-xs"
              style={{ width: tableWidth }}
              aria-rowcount={items.length + 1}
            >
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <thead className="sticky top-0 z-20 block bg-background text-muted-foreground">
                    <tr
                      className="grid h-10"
                      style={{ gridTemplateColumns: template }}
                    >
                      {visibleColumns.map((column) => (
                        <th
                          key={column.key}
                          data-monitor-column={column.key}
                          className={`relative flex min-w-0 items-center px-3 text-left text-[11px] font-medium${column.key === "terminal" ? " sticky right-0 z-10 bg-background" : ""}`}
                        >
                          <span
                            className="truncate"
                            title={t(`monitor.${column.key}`)}
                          >
                            {column.key === "terminal" ? (
                              <span className="sr-only">
                                {t("monitor.openTerminal")}
                              </span>
                            ) : (
                              t(`monitor.${column.key}`)
                            )}
                          </span>
                          <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={t("monitor.resizeColumn", {
                              column: t(`monitor.${column.key}`),
                            })}
                            aria-valuenow={widths[column.key]}
                            aria-valuemin={column.min}
                            aria-valuemax={
                              column.key === "terminal" ? 200 : 640
                            }
                            tabIndex={0}
                            className="absolute inset-y-1 right-0 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-1 after:right-0.5 after:w-px hover:after:bg-primary focus-visible:after:bg-primary"
                            onPointerDown={(event) =>
                              startResize(column.key, event)
                            }
                            onDoubleClick={() =>
                              resize(column.key, column.width)
                            }
                            onKeyDown={(event) => {
                              if (
                                event.key === "ArrowLeft" ||
                                event.key === "ArrowRight"
                              ) {
                                event.preventDefault();
                                resize(
                                  column.key,
                                  widths[column.key] +
                                    (event.key === "ArrowRight" ? 1 : -1) *
                                      (event.shiftKey ? 32 : 8),
                                );
                              }
                            }}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                </ContextMenuTrigger>
                <ContextMenuContent data-monitor-column-menu>
                  <ContextMenuLabel>
                    {t("monitor.visibleColumns")}
                  </ContextMenuLabel>
                  {MONITOR_COLUMNS.map(({ key }) => (
                    <ContextMenuCheckboxItem
                      key={key}
                      data-monitor-toggle-column={key}
                      checked={!hidden.includes(key)}
                      disabled={key === "host" || key === "terminal"}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) =>
                        setVisible(key, checked === true)
                      }
                    >
                      {t(`monitor.${key}`)}
                    </ContextMenuCheckboxItem>
                  ))}
                </ContextMenuContent>
              </ContextMenu>
              <tbody
                className="relative block"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((row) => {
                  const cells = renderCells(items[row.index]);
                  return (
                    <ContextMenu key={row.key}>
                      <ContextMenuTrigger asChild>
                        <tr
                          {...rowProps(items[row.index])}
                          ref={virtualizer.measureElement}
                          data-index={row.index}
                          aria-rowindex={row.index + 2}
                          style={{
                            display: "grid",
                            gridTemplateColumns: template,
                            minHeight: 72,
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: tableWidth,
                            transform: `translateY(${row.start - scrollMargin}px)`,
                          }}
                        >
                          {visibleColumns.map(({ key }) => (
                            <React.Fragment key={key}>
                              {cells[key]}
                            </React.Fragment>
                          ))}
                        </tr>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        {renderMenu(items[row.index])}
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
