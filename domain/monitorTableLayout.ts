export const MONITOR_COLUMNS = [
  { key: "host", width: 220, min: 160 },
  { key: "latency", width: 90, min: 80 },
  { key: "tags", width: 150, min: 90 },
  { key: "notes", width: 180, min: 110 },
  { key: "cpu", width: 120, min: 120 },
  { key: "memory", width: 120, min: 120 },
  { key: "disks", width: 240, min: 220 },
  { key: "network", width: 150, min: 140 },
  { key: "updated", width: 110, min: 95 },
  { key: "status", width: 100, min: 90 },
  { key: "terminal", width: 56, min: 56 },
] as const;
export type MonitorColumn = (typeof MONITOR_COLUMNS)[number]["key"];
export type MonitorColumnWidths = Record<MonitorColumn, number>;
export const MONITOR_CARD_HEIGHT = 368;

export function clampMonitorColumnWidth(
  key: MonitorColumn,
  width: number,
): number {
  const column = MONITOR_COLUMNS.find((column) => column.key === key)!;
  return Number.isFinite(width)
    ? Math.round(
        Math.max(column.min, Math.min(key === "terminal" ? 200 : 640, width)),
      )
    : column.width;
}
export function normalizeMonitorColumnWidths(
  value: unknown,
): MonitorColumnWidths {
  const stored =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    MONITOR_COLUMNS.map((column) => [
      column.key,
      clampMonitorColumnWidth(
        column.key,
        typeof stored[column.key] === "number"
          ? (stored[column.key] as number)
          : column.width,
      ),
    ]),
  ) as MonitorColumnWidths;
}
export function monitorGridColumns(width: number, count: number): number {
  return Math.max(
    1,
    Math.min(count, Math.floor((Math.max(0, width) + 16) / 296)),
  );
}

/** Only optional columns can be hidden, including when restoring old or corrupt settings. */
export function normalizeMonitorHiddenColumns(value: unknown): MonitorColumn[] {
  return MONITOR_COLUMNS.filter(
    ({ key }) =>
      key !== "host" &&
      key !== "terminal" &&
      Array.isArray(value) &&
      value.includes(key),
  ).map(({ key }) => key);
}
